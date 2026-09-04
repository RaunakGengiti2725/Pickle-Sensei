import type { NotificationPlanContext } from '../../../src/notifications/plan';
import type {
  PermissionState,
  SchedulerPort,
} from '../../../src/notifications/service';
import type { PlannedNotification } from '../../../src/notifications/types';
import { DEFAULT_NOTIFICATION_PREFS } from '../../../src/notifications/types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';

/**
 * Adversarial variants around XC-P2-NOTIFICATION-STALE-PLAN-RACE. The fake
 * scheduler models what is LIVE on the OS (applyPlan replaces, cancelAll
 * empties, both land when the native call resolves) and every seam that the
 * store awaits — context load, OS cancel, OS apply, kv persist — can be
 * gated by hand so orderings that only happen on a phone are reproducible.
 */

const mockKvTable = new Map<string, string>();
let mockPersistGate: Gate | null = null;

jest.mock('../../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        const pending = mockPersistGate;
        mockPersistGate = null;
        if (pending) await pending.promise;
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

import { useNotificationStore } from '../../../src/notifications/notificationStore';

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open: () => void = () => {};
  const promise = new Promise<void>(resolve => {
    open = resolve;
  });
  return { promise, open };
}

class LiveScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  live: PlannedNotification[] = [];
  ops: string[] = [];
  cancelGate: Gate | null = null;
  applyGate: Gate | null = null;
  failNextApply = false;

  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    return this.permission;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    const pending = this.applyGate;
    this.applyGate = null;
    if (pending) await pending.promise;
    if (this.failNextApply) {
      this.failNextApply = false;
      this.ops.push('applyPlan:threw');
      throw new Error('native scheduler unavailable');
    }
    this.live = [...plan];
    this.ops.push(`applyPlan(${plan.length})`);
  }
  async cancelAllPlanned(): Promise<void> {
    const pending = this.cancelGate;
    this.cancelGate = null;
    if (pending) await pending.promise;
    this.live = [];
    this.ops.push('cancelAllPlanned');
  }
  async openSystemSettings(): Promise<void> {}
}

const planContext: NotificationPlanContext = {
  nowMs: new Date(2026, 7, 25, 10, 0, 0).getTime(),
  streakDays: 2,
  practicedToday: false,
  hasAnyHistory: true,
};

const owner = '66666666-6666-4666-8666-666666666666';
const otherOwner = '77777777-7777-4777-8777-777777777777';

function flush(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}

function gatedContext(g: Gate) {
  return async () => {
    await g.promise;
    return planContext;
  };
}

function opsAfterLast(ops: readonly string[], marker: string): string[] {
  return ops.slice(ops.lastIndexOf(marker) + 1);
}

beforeEach(() => {
  mockKvTable.clear();
  mockPersistGate = null;
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
  setActiveDataOwner(owner);
});

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

async function enabledStore(scheduler: LiveScheduler) {
  const fastDeps = { scheduler, loadContext: async () => planContext };
  await useNotificationStore.getState().hydrate(fastDeps);
  await useNotificationStore.getState().requestPermissionAndEnable(fastDeps);
  expect(useNotificationStore.getState().prefs.enabled).toBe(true);
  expect(scheduler.live.length).toBeGreaterThan(0);
  return fastDeps;
}

describe('stale plan race — orderings the fix must survive', () => {
  it('A1: disable → re-enable → disable while a sync is loading context ends cancelled', async () => {
    const scheduler = new LiveScheduler();
    const fastDeps = await enabledStore(scheduler);
    const g = gate();
    const stale = useNotificationStore
      .getState()
      .syncNow({ scheduler, loadContext: gatedContext(g) });
    await flush();
    const s = useNotificationStore.getState();
    const p1 = s.setPrefs({ enabled: false }, fastDeps);
    const p2 = s.setPrefs({ enabled: true }, fastDeps);
    const p3 = s.setPrefs({ enabled: false }, fastDeps);
    await flush();
    g.open();
    await Promise.all([stale, p1, p2, p3]);
    await flush();
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(scheduler.live).toEqual([]);
    expect(
      opsAfterLast(scheduler.ops, 'cancelAllPlanned').filter(op =>
        op.startsWith('applyPlan'),
      ),
    ).toEqual([]);
  });

  it('A2: a stale sync whose OS apply throws after being superseded never flags scheduleFailed', async () => {
    const scheduler = new LiveScheduler();
    const fastDeps = await enabledStore(scheduler);
    const g = gate();
    scheduler.failNextApply = true;
    const stale = useNotificationStore
      .getState()
      .syncNow({ scheduler, loadContext: gatedContext(g) });
    await flush();
    const disable = useNotificationStore
      .getState()
      .setPrefs({ enabled: false }, fastDeps);
    await flush();
    g.open();
    await Promise.all([stale, disable]);
    await flush();
    expect(useNotificationStore.getState().scheduleFailed).toBe(false);
    expect(scheduler.live).toEqual([]);
    // The throw never happened because the superseded pass never reached the
    // OS; the poisoned flag must not leak into the next real apply either.
    scheduler.failNextApply = false;
    await useNotificationStore.getState().setPrefs({ enabled: true }, fastDeps);
    expect(useNotificationStore.getState().scheduleFailed).toBe(false);
    expect(scheduler.live.length).toBeGreaterThan(0);
  });

  it('A3: owner switch while a sync is loading context never applies the old owner plan', async () => {
    const scheduler = new LiveScheduler();
    const fastDeps = await enabledStore(scheduler);
    const g = gate();
    const stale = useNotificationStore
      .getState()
      .syncNow({ scheduler, loadContext: gatedContext(g) });
    await flush();
    setActiveDataOwner(otherOwner);
    const hydrateOther = useNotificationStore.getState().hydrate({
      ...fastDeps,
      expectedOwnerKey: otherOwner,
    });
    await flush();
    g.open();
    await Promise.all([stale, hydrateOther]);
    await flush();
    // otherOwner has no prefs → disabled → nothing live.
    expect(useNotificationStore.getState().ownerKey).toBe(otherOwner);
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(scheduler.live).toEqual([]);
  });

  it('A4: sign-out then sign-in as the same owner while a sync is in flight converges on kv prefs', async () => {
    const scheduler = new LiveScheduler();
    const fastDeps = await enabledStore(scheduler);
    const g = gate();
    const stale = useNotificationStore
      .getState()
      .syncNow({ scheduler, loadContext: gatedContext(g) });
    await flush();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await useNotificationStore.getState().hydrate({
      ...fastDeps,
      expectedOwnerKey: SIGNED_OUT_DATA_OWNER,
    });
    expect(scheduler.live).toEqual([]);
    setActiveDataOwner(owner);
    const rehydrate = useNotificationStore
      .getState()
      .hydrate({ ...fastDeps, expectedOwnerKey: owner });
    await flush();
    g.open();
    await Promise.all([stale, rehydrate]);
    await flush();
    // Same owner, prefs persisted as enabled → plan must be live exactly once.
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(scheduler.live.length).toBeGreaterThan(0);
    expect(useNotificationStore.getState().scheduleFailed).toBe(false);
  });

  it('A5: permission revoked in system settings during an in-flight sync ends cancelled', async () => {
    const scheduler = new LiveScheduler();
    const fastDeps = await enabledStore(scheduler);
    const g = gate();
    const stale = useNotificationStore
      .getState()
      .syncNow({ scheduler, loadContext: gatedContext(g) });
    await flush();
    scheduler.permission = 'denied';
    // Foreground bootstrap: refreshPermission().then(() => syncNow()).
    const foreground = useNotificationStore
      .getState()
      .refreshPermission(fastDeps)
      .then(() => useNotificationStore.getState().syncNow(fastDeps));
    await flush();
    g.open();
    await Promise.all([stale, foreground]);
    await flush();
    expect(useNotificationStore.getState().permission).toBe('denied');
    expect(scheduler.live).toEqual([]);
    expect(scheduler.ops.at(-1)).toBe('cancelAllPlanned');
  });

  it('A6: a stale sync resolving while the newer pass is inside the OS cancel does not re-apply', async () => {
    const scheduler = new LiveScheduler();
    const fastDeps = await enabledStore(scheduler);
    const g = gate();
    const stale = useNotificationStore
      .getState()
      .syncNow({ scheduler, loadContext: gatedContext(g) });
    await flush();
    const cancelGate = gate();
    scheduler.cancelGate = cancelGate;
    const disable = useNotificationStore
      .getState()
      .setPrefs({ enabled: false }, fastDeps);
    await flush();
    g.open();
    await flush();
    cancelGate.open();
    await Promise.all([stale, disable]);
    await flush();
    expect(scheduler.live).toEqual([]);
    expect(scheduler.ops.at(-1)).toBe('cancelAllPlanned');
  });
});

describe('stale plan race — neighbourhood', () => {
  it('B1: prefs flipped off but persist still pending → the in-flight sync must not apply the stale plan', async () => {
    // setPrefs() flips state.prefs synchronously, awaits the kv write, and
    // only THEN bumps the sync generation. A sync that resolves its facts
    // inside that window still sees itself as current and applies a plan
    // built from prefs the UI already shows as off.
    const scheduler = new LiveScheduler();
    const fastDeps = await enabledStore(scheduler);
    const g = gate();
    const stale = useNotificationStore
      .getState()
      .syncNow({ scheduler, loadContext: gatedContext(g) });
    await flush();
    const persist = gate();
    mockPersistGate = persist;
    const disable = useNotificationStore
      .getState()
      .setPrefs({ enabled: false }, fastDeps);
    await flush();
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    const opsBefore = scheduler.ops.length;
    g.open();
    await stale;
    await flush();
    const opsWhilePrefsOff = scheduler.ops.slice(opsBefore);
    persist.open();
    await disable;
    await flush();
    // Converges eventually…
    expect(scheduler.live).toEqual([]);
    // …but a plan was applied AFTER the player turned reminders off.
    expect(opsWhilePrefsOff.filter(op => op.startsWith('applyPlan'))).toEqual(
      [],
    );
  });

  it('B2: signing out while a sync is inside the OS apply leaves nothing live for the signed-out process', async () => {
    // hydrate() for a signed-out owner cancels DIRECTLY on the scheduler,
    // outside the serialized queue, so it can land before an in-flight
    // applyPlan that then re-arms every reminder for a process with no owner.
    const scheduler = new LiveScheduler();
    const fastDeps = await enabledStore(scheduler);
    const applyGate = gate();
    scheduler.applyGate = applyGate;
    const inFlight = useNotificationStore.getState().syncNow(fastDeps);
    await flush();
    await flush();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const signOut = useNotificationStore.getState().hydrate({
      ...fastDeps,
      expectedOwnerKey: SIGNED_OUT_DATA_OWNER,
    });
    await flush();
    applyGate.open();
    await Promise.all([inFlight, signOut]);
    await flush();
    expect(useNotificationStore.getState().ownerKey).toBe(
      SIGNED_OUT_DATA_OWNER,
    );
    expect(scheduler.live).toEqual([]);
  });

  it('B3: awaiting setPrefs({enabled:false}) resolves only once the OS schedule reflects it', async () => {
    // A superseded generation returns immediately, so the promise setPrefs
    // hands back can settle before ANY pass has cancelled the schedule.
    const scheduler = new LiveScheduler();
    const fastDeps = await enabledStore(scheduler);
    const g = gate();
    const stale = useNotificationStore
      .getState()
      .syncNow({ scheduler, loadContext: gatedContext(g) });
    await flush();
    const disable = useNotificationStore
      .getState()
      .setPrefs({ enabled: false }, fastDeps);
    await flush();
    const foreground = useNotificationStore.getState().syncNow(fastDeps);
    // The OS cancel the newest pass will issue takes one native round-trip.
    const cancelGate = gate();
    scheduler.cancelGate = cancelGate;
    g.open();
    await disable;
    const liveWhenDisableResolved = scheduler.live.length;
    cancelGate.open();
    await Promise.all([stale, foreground]);
    await flush();
    expect(scheduler.live).toEqual([]);
    expect(liveWhenDisableResolved).toBe(0);
  });
});
