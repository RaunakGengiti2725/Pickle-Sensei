import type { Profile } from '../../../src/state/profile';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';

/**
 * ADVERSARIAL PASS 3 / tester #4 — `mobile-launch-onboarding`, scenarios
 * S1, S2, S3, S4, S6 against 4d812e1a.
 *
 * The real appStore + notificationStore run over an in-memory kv table; the
 * canonical `/v1/me` endpoint is a mocked `globalThis.fetch` so the REAL
 * `src/account/onboarding.ts` request/parse path is exercised (not a module
 * mock). Every `it` is written to PASS when the launch contract HOLDS; a
 * failing assertion is a reproduced break and is reported as a finding
 * (see the BROKEN markers in the test names).
 */

const mockKvTable = new Map<string, string>();

jest.mock('../../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

let mockApiSession: {
  apiBaseUrl: string;
  bearerToken: string;
  canonicalAppUserId: string;
  provider: 'apple';
} | null = null;

jest.mock('../../../src/account/apiSession', () => ({
  getApiSession: () => mockApiSession,
}));

import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../../src/state/appStore';
import {
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  useNotificationStore,
} from '../../../src/notifications/notificationStore';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
} from '../../../src/notifications/types';
import type {
  PermissionState,
  SchedulerPort,
} from '../../../src/notifications/service';
import type { PlannedNotification } from '../../../src/notifications/types';
import type { NotificationPlanContext } from '../../../src/notifications/plan';

const OWNER_A = '33333333-3333-4333-8333-333333333333';
const OWNER_B = '44444444-4444-4444-8444-444444444444';

const stashedAnswers: Profile = {
  firstName: 'Dana',
  gender: 'female',
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'drops',
  biggestProblem: 'control',
  focusCheckpoint: 'paddle_set',
};

/** A healthy `/v1/me` body for a completed server profile. */
function serverMeBody(firstName: string) {
  return {
    onboardingState: 'complete',
    profile: {
      skill_level: '4.0',
      handedness: 'left',
      primary_goal: 'serves',
      biggest_problem: 'power',
      focus_checkpoint: 'paddle_set',
      first_name: firstName,
      gender: 'male',
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sessionFor(owner: string) {
  return {
    apiBaseUrl: 'https://api.test',
    bearerToken: `bearer-${owner}`,
    canonicalAppUserId: owner,
    provider: 'apple' as const,
  };
}

function profileKeyFor(owner: string): string {
  return `profile:${owner}`;
}

function stash(profile: Profile = stashedAnswers) {
  mockKvTable.set(
    PENDING_ONBOARDING_PROFILE_KV_KEY,
    JSON.stringify({ version: 1, profile }),
  );
}

class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  appliedPlans: PlannedNotification[][] = [];
  cancelAllCalls = 0;
  requestCalls = 0;
  permissionStateCalls = 0;

  async permissionState(): Promise<PermissionState> {
    this.permissionStateCalls += 1;
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    this.requestCalls += 1;
    return this.permission;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.appliedPlans.push([...plan]);
  }
  async cancelAllPlanned(): Promise<void> {
    this.cancelAllCalls += 1;
  }
  async openSystemSettings(): Promise<void> {}
}

const planContext: NotificationPlanContext = {
  nowMs: new Date(2026, 8, 4, 10, 0, 0).getTime(),
  streakDays: 2,
  practicedToday: false,
  hasAnyHistory: true,
};

function notifDeps(scheduler: FakeScheduler) {
  return { scheduler, loadContext: async () => planContext };
}

const realFetch = globalThis.fetch;
let fetchMock: jest.Mock<Promise<Response>, [RequestInfo | URL, RequestInit?]>;

/** Spin the event loop until the mocked fetch has seen `count` calls. */
async function waitForFetchCalls(count: number): Promise<void> {
  for (let i = 0; i < 200 && fetchMock.mock.calls.length < count; i += 1) {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  }
  expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(count);
}

function savedBody() {
  return { recommendedCheckpoint: 'paddle_set' };
}

beforeEach(() => {
  mockKvTable.clear();
  mockApiSession = null;
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
    lastShotType: 'forehand_drive',
  });
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
  });
});

afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  globalThis.fetch = realFetch;
});

describe('S1 — malformed pending notification choice beside a valid profile stash', () => {
  it('ignores {"version":2,"enabled":"yes"} and still adopts the profile stash for a fresh guest', async () => {
    mockKvTable.set(
      PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
      JSON.stringify({ version: 2, enabled: 'yes' }),
    );
    stash();
    setActiveDataOwner(GUEST_DATA_OWNER);
    const scheduler = new FakeScheduler();

    await Promise.all([
      useAppStore.getState().hydrate(),
      useNotificationStore.getState().hydrate(notifDeps(scheduler)),
    ]);

    const app = useAppStore.getState();
    expect(app.hydrated).toBe(true);
    expect(app.ownerKey).toBe(GUEST_DATA_OWNER);
    expect(app.profile).toEqual(stashedAnswers);
    expect(
      JSON.parse(mockKvTable.get(profileKeyFor(GUEST_DATA_OWNER))!),
    ).toEqual(stashedAnswers);
    expect(mockKvTable.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');

    const notif = useNotificationStore.getState();
    expect(notif.hydrated).toBe(true);
    expect(notif.ownerKey).toBe(GUEST_DATA_OWNER);
    // Malformed choice is NOT honoured: defaults stay (reminders OFF, prompt
    // not dismissed) and no OS prompt was raised.
    expect(notif.prefs.enabled).toBe(false);
    expect(notif.prefs.promptDismissed).toBe(false);
    expect(scheduler.requestCalls).toBe(0);
    expect(scheduler.appliedPlans).toEqual([]);
    expect(
      mockKvTable.has(notificationPrefsKeyForOwner(GUEST_DATA_OWNER)),
    ).toBe(false);
  });

  it.each([
    ['{not json', '{not json'],
    ['array', '[1]'],
    ['string', '"enable"'],
    ['null', 'null'],
    ['version 1 but enabled is a string', '{"version":1,"enabled":"true"}'],
    ['version as string', '{"version":"1","enabled":true}'],
  ])(
    'ignores a %s pending notification choice without touching prefs (%s)',
    async (_label, raw) => {
      mockKvTable.set(PENDING_NOTIFICATION_ONBOARDING_KV_KEY, raw);
      setActiveDataOwner(GUEST_DATA_OWNER);
      const scheduler = new FakeScheduler();
      await useNotificationStore.getState().hydrate(notifDeps(scheduler));
      const notif = useNotificationStore.getState();
      expect(notif.hydrated).toBe(true);
      expect(notif.prefs).toEqual(DEFAULT_NOTIFICATION_PREFS);
      expect(scheduler.requestCalls).toBe(0);
      expect(scheduler.appliedPlans).toEqual([]);
    },
  );
});

describe('S2 — corrupt owner profile kv beside a healthy GET /v1/me', () => {
  it('CONTRACT (fails on 4d812e1a): recovers to the server profile instead of surfacing a JSON error on every retry', async () => {
    mockKvTable.set(profileKeyFor(OWNER_A), '{not json');
    mockApiSession = sessionFor(OWNER_A);
    fetchMock.mockImplementation(async () => jsonResponse(serverMeBody('Sky')));
    setActiveDataOwner(OWNER_A);

    await useAppStore.getState().hydrate();
    const first = useAppStore.getState();
    // Gate contract: !profile && hydrateError → ErrorState with onRetry →
    // hydrate(). Retry must converge on the server profile, not loop.
    await useAppStore.getState().hydrate();
    const second = useAppStore.getState();

    expect(fetchMock).toHaveBeenCalled();
    expect(first.hydrateError).toBeNull();
    expect(second.hydrateError).toBeNull();
    expect(second.profile).toMatchObject({
      firstName: 'Sky',
      skillLevel: '4.0',
      handedness: 'left',
      goal: 'serves',
    });
  });

  it('PROBE a (documents observed behaviour): corrupt kv shadows /v1/me and the raw SyntaxError text becomes the user-facing detail', async () => {
    mockKvTable.set(profileKeyFor(OWNER_A), '{not json');
    mockApiSession = sessionFor(OWNER_A);
    fetchMock.mockImplementation(async () => jsonResponse(serverMeBody('Sky')));
    setActiveDataOwner(OWNER_A);

    const errors: Array<string | null> = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await useAppStore.getState().hydrate();
      errors.push(useAppStore.getState().hydrateError);
    }
    // Recorded for the report, not a pass/fail gate:

    console.log(
      JSON.stringify({
        probe: 'S2/PROBE-a',
        fetchCalls: fetchMock.mock.calls.length,
        hydrateErrors: errors,
        profile: useAppStore.getState().profile,
        kvStillCorrupt: mockKvTable.get(profileKeyFor(OWNER_A)),
      }),
    );
    expect(errors).toHaveLength(3);
  });
});

describe('S3 — non-Profile JSON in profile:device-guest', () => {
  it.each([
    ['{}'],
    ['[]'],
    ['"str"'],
    ['null'],
    ['0'],
    ['true'],
    ['{"skillLevel":"3.0"}'],
  ])(
    'CONTRACT (fails on 4d812e1a): %s hydrates to profile:null (never a truthy non-Profile)',
    async raw => {
      mockKvTable.set(profileKeyFor(GUEST_DATA_OWNER), raw);
      setActiveDataOwner(GUEST_DATA_OWNER);
      await useAppStore.getState().hydrate();
      const state = useAppStore.getState();
      expect(state.hydrated).toBe(true);
      expect(state.ownerKey).toBe(GUEST_DATA_OWNER);
      expect(state.profile).toBeNull();
    },
  );

  it('PROBE b (documents observed behaviour): what each corrupt value hydrates to', async () => {
    const table: Record<string, unknown> = {};
    for (const raw of ['{}', '[]', '"str"', 'null', '0', 'true']) {
      mockKvTable.clear();
      mockKvTable.set(profileKeyFor(GUEST_DATA_OWNER), raw);
      setActiveDataOwner(GUEST_DATA_OWNER);
      await useAppStore.getState().hydrate();
      const { profile, hydrateError } = useAppStore.getState();
      table[raw] = {
        truthy: Boolean(profile),
        profile,
        hydrateError,
      };
    }

    console.log(JSON.stringify({ probe: 'S3/PROBE-b', table }));
    expect(Object.keys(table)).toHaveLength(6);
  });

  it('a corrupt {} in a canonical owner bucket also shadows a healthy /v1/me (fetch never happens)', async () => {
    mockKvTable.set(profileKeyFor(OWNER_A), '{}');
    mockApiSession = sessionFor(OWNER_A);
    fetchMock.mockImplementation(async () => jsonResponse(serverMeBody('Sky')));
    setActiveDataOwner(OWNER_A);
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();

    console.log(
      JSON.stringify({
        probe: 'S3/canonical-{}',
        fetchCalls: fetchMock.mock.calls.length,
        profile: state.profile,
      }),
    );
    // HOLD expectation: the server profile is authoritative when the local
    // bucket holds no usable Profile.
    expect(state.profile).toMatchObject({ firstName: 'Sky' });
  });
});

describe('S4 — pending notification choice vs existing owner prefs', () => {
  it('existing prefs (enabled:false) win over pending enabled:true; pending is cleared; requestPermission never called', async () => {
    mockKvTable.set(
      PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
      JSON.stringify({ version: 1, enabled: true }),
    );
    mockKvTable.set(
      notificationPrefsKeyForOwner(OWNER_A),
      JSON.stringify({
        ...DEFAULT_NOTIFICATION_PREFS,
        enabled: false,
        promptDismissed: true,
      }),
    );
    setActiveDataOwner(OWNER_A);
    const scheduler = new FakeScheduler();
    scheduler.permission = 'granted';

    await useNotificationStore.getState().hydrate(notifDeps(scheduler));

    const notif = useNotificationStore.getState();
    expect(notif.hydrated).toBe(true);
    expect(notif.ownerKey).toBe(OWNER_A);
    expect(notif.prefs.enabled).toBe(false);
    expect(notif.prefs.promptDismissed).toBe(true);
    expect(mockKvTable.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)).toBe('');
    expect(
      JSON.parse(mockKvTable.get(notificationPrefsKeyForOwner(OWNER_A))!)
        .enabled,
    ).toBe(false);
    expect(scheduler.requestCalls).toBe(0);
    expect(scheduler.appliedPlans).toEqual([]);
    expect(scheduler.cancelAllCalls).toBeGreaterThan(0);
  });

  it('rapid repeat: hydrating 5x in parallel for the same owner never requests permission nor flips prefs', async () => {
    mockKvTable.set(
      PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
      JSON.stringify({ version: 1, enabled: true }),
    );
    mockKvTable.set(
      notificationPrefsKeyForOwner(OWNER_A),
      JSON.stringify({ ...DEFAULT_NOTIFICATION_PREFS, enabled: false }),
    );
    setActiveDataOwner(OWNER_A);
    const scheduler = new FakeScheduler();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        useNotificationStore.getState().hydrate(notifDeps(scheduler)),
      ),
    );
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(scheduler.requestCalls).toBe(0);
    expect(scheduler.appliedPlans).toEqual([]);
    expect(mockKvTable.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)).toBe('');
  });
});

describe('S6 — slow canonical fetch, sign-out mid-flight, sign in as a different UUID', () => {
  it("the first owner's server profile never lands in the second owner's kv key or in store state", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>(resolve => {
      releaseA = resolve;
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init) => {
      const auth = new Headers(init?.headers).get('Authorization');
      if (auth === `Bearer bearer-${OWNER_A}`) {
        await gateA;
        return jsonResponse(serverMeBody('OwnerA'));
      }
      if (auth === `Bearer bearer-${OWNER_B}`) {
        return jsonResponse(serverMeBody('OwnerB'));
      }
      throw new Error(`unexpected request ${String(input)}`);
    });

    // Sign in as A; hydrate hangs on the slow /v1/me.
    mockApiSession = sessionFor(OWNER_A);
    setActiveDataOwner(OWNER_A);
    const hydrateA = useAppStore.getState().hydrate();
    await waitForFetchCalls(1);
    expect(useAppStore.getState().ownerKey).toBe(OWNER_A);
    expect(useAppStore.getState().hydrated).toBe(false);

    // signOut() mid-flight: owner becomes signed-out, app store re-hydrates.
    mockApiSession = null;
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().ownerKey).toBe(SIGNED_OUT_DATA_OWNER);

    // Sign in as B; B's fetch is fast.
    mockApiSession = sessionFor(OWNER_B);
    setActiveDataOwner(OWNER_B);
    await useAppStore.getState().hydrate();
    const afterB = useAppStore.getState();
    expect(afterB.ownerKey).toBe(OWNER_B);
    expect(afterB.profile).toMatchObject({ firstName: 'OwnerB' });

    // Now A's slow fetch lands.
    releaseA();
    await hydrateA;
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));

    const final = useAppStore.getState();
    expect(final.ownerKey).toBe(OWNER_B);
    expect(final.profile).toMatchObject({ firstName: 'OwnerB' });
    expect(JSON.parse(mockKvTable.get(profileKeyFor(OWNER_B))!)).toMatchObject({
      firstName: 'OwnerB',
    });
    // A's profile may only ever be written under A's own key.
    const aRaw = mockKvTable.get(profileKeyFor(OWNER_A));
    if (aRaw) expect(JSON.parse(aRaw)).toMatchObject({ firstName: 'OwnerA' });
    for (const [key, value] of mockKvTable) {
      if (value.includes('OwnerA')) expect(key).toBe(profileKeyFor(OWNER_A));
    }
  });

  it('slow fetch resolving null for A after B completed onboarding does not wipe B (owner guard)', async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>(resolve => {
      releaseA = resolve;
    });
    fetchMock.mockImplementation(async (_input, init) => {
      const auth = new Headers(init?.headers).get('Authorization');
      if (auth === `Bearer bearer-${OWNER_A}`) {
        await gateA;
        return jsonResponse({ onboardingState: 'pending', profile: null });
      }
      return jsonResponse({ onboardingState: 'pending', profile: null });
    });
    mockApiSession = sessionFor(OWNER_A);
    setActiveDataOwner(OWNER_A);
    const hydrateA = useAppStore.getState().hydrate();
    await waitForFetchCalls(1);

    mockApiSession = null;
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await useAppStore.getState().hydrate();

    mockApiSession = sessionFor(OWNER_B);
    setActiveDataOwner(OWNER_B);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toBeNull();
    // B finishes the in-account questionnaire (server save mocked OK).
    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method === 'PUT') return jsonResponse(savedBody());
      return jsonResponse({ onboardingState: 'pending', profile: null });
    });
    await useAppStore.getState().completeOnboarding(stashedAnswers);
    expect(useAppStore.getState().onboardingError).toBeNull();
    expect(useAppStore.getState().profile).toMatchObject({
      firstName: 'Dana',
    });

    releaseA();
    await hydrateA;
    const final = useAppStore.getState();
    expect(final.ownerKey).toBe(OWNER_B);
    expect(final.profile).toMatchObject({ firstName: 'Dana' });
    expect(final.hydrated).toBe(true);
  });

  it('SAME-owner stale hydrate: a slow null fetch for A landing after A completed onboarding must not clear the profile', async () => {
    let releaseSlow!: () => void;
    const gateSlow = new Promise<void>(resolve => {
      releaseSlow = resolve;
    });
    let gets = 0;
    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method === 'PUT') return jsonResponse(savedBody());
      gets += 1;
      if (gets === 1) await gateSlow;
      return jsonResponse({ onboardingState: 'pending', profile: null });
    });
    mockApiSession = sessionFor(OWNER_A);
    setActiveDataOwner(OWNER_A);
    const hydrateSlow = useAppStore.getState().hydrate();
    await waitForFetchCalls(1);

    // Sign out → sign back in as the SAME account (fast, no profile yet) →
    // finish the in-account questionnaire.
    mockApiSession = null;
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await useAppStore.getState().hydrate();
    mockApiSession = sessionFor(OWNER_A);
    setActiveDataOwner(OWNER_A);
    await useAppStore.getState().hydrate();
    expect(useAppStore.getState().profile).toBeNull();
    await useAppStore.getState().completeOnboarding(stashedAnswers);
    expect(useAppStore.getState().onboardingError).toBeNull();
    expect(useAppStore.getState().profile).toMatchObject({
      firstName: 'Dana',
    });
    expect(JSON.parse(mockKvTable.get(profileKeyFor(OWNER_A))!)).toMatchObject({
      firstName: 'Dana',
    });

    // The stale hydrate's fetch finally resolves with "no profile".
    releaseSlow();
    await hydrateSlow;
    const final = useAppStore.getState();

    console.log(
      JSON.stringify({
        probe: 'S6/same-owner-stale',
        profileAfterStale: final.profile,
        kv: mockKvTable.get(profileKeyFor(OWNER_A)),
      }),
    );
    expect(final.profile).toMatchObject({ firstName: 'Dana' });
  });
});
