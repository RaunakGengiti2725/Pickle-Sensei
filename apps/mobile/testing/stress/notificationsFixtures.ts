import type { LocalDb } from '../../src/data/db';
import type { NotificationPlanContext } from '../../src/notifications/plan';
import { buildNotificationPlan } from '../../src/notifications/plan';
import type {
  PermissionState,
  SchedulerPort,
} from '../../src/notifications/service';
import type {
  NotificationPrefs,
  PlannedNotification,
} from '../../src/notifications/types';
import type { Interleaver } from './interleaver';
import { randomInt } from './stressEvidence';

/**
 * Seams for the notification store, driven by an Interleaver.
 *
 * - `FakeKvDb` is the SQLite kv table. Statements complete in FIFO order
 *   (lane `sqlite`, see interleaver.ts), reading/writing the table at
 *   completion time exactly like the single-thread op-sqlite worker.
 * - `TrayScheduler` is the OS notification tray behind SchedulerPort.
 *   Every native call is one held op in lane `native` (random completion
 *   order — independent UNUserNotificationCenter requests). `applyPlan`
 *   replaces the tray atomically; `cancelAllPlanned` clears it.
 * - `heldLoadContext` models `defaultLoadContext` (consistency snapshot):
 *   a chain of `k` sequential SQLite reads before the facts resolve.
 */

export const SQLITE_LANE = 'sqlite';
export const NATIVE_LANE = 'native';

export interface KvWrite {
  key: string;
  value: string;
  /** Trace length when the statement was issued (who asked, and when). */
  issuedStep: number;
  /** Trace length when the statement executed. */
  step: number;
  ok: boolean;
}

export class FakeKvDb implements LocalDb {
  readonly table = new Map<string, string>();
  readonly writes: KvWrite[] = [];
  /** Return true to make the next completed INSERT throw. */
  failWrite: () => boolean = () => false;

  constructor(private readonly il: Interleaver) {}

  execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    if (sql.startsWith('SELECT value FROM kv')) {
      const key = String(params[0]);
      return this.il.hold(SQLITE_LANE, `select:${key}`, () => {
        const value = this.table.get(key);
        return { rows: value === undefined ? [] : [{ value }] };
      });
    }
    if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
      const key = String(params[0]);
      const value = String(params[1]);
      const issuedStep = this.il.trace.length;
      return this.il.hold(SQLITE_LANE, `insert:${key}`, () => {
        const ok = !this.failWrite();
        this.writes.push({
          key,
          value,
          issuedStep,
          step: this.il.trace.length,
          ok,
        });
        if (!ok) throw new Error('SQLITE_IOERR (injected)');
        this.table.set(key, value);
        return { rows: [] };
      });
    }
    return this.il.hold(SQLITE_LANE, 'select:other', () => ({ rows: [] }));
  }

  close(): void {}
}

export class TrayScheduler implements SchedulerPort {
  permission: PermissionState = 'undetermined';
  requestResult: PermissionState = 'granted';
  readonly tray = new Map<string, PlannedNotification>();
  readonly appliedPlans: PlannedNotification[][] = [];
  cancelAllCalls = 0;
  requestCalls = 0;
  failApply: () => boolean = () => false;
  failCancel: () => boolean = () => false;

  constructor(private readonly il: Interleaver) {}

  permissionState(): Promise<PermissionState> {
    return this.il.hold(NATIVE_LANE, 'permissionState', () => this.permission);
  }

  requestPermission(): Promise<PermissionState> {
    // The system prompt is "spent" when issued, not when it resolves.
    this.requestCalls += 1;
    return this.il.hold(NATIVE_LANE, 'requestPermission', () => {
      this.permission = this.requestResult;
      return this.requestResult;
    });
  }

  applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    const snapshot = [...plan];
    return this.il.hold(NATIVE_LANE, `applyPlan[${plan.length}]`, () => {
      if (this.failApply()) throw new Error('notifee apply failed (injected)');
      this.tray.clear();
      for (const item of snapshot) this.tray.set(item.id, item);
      this.appliedPlans.push(snapshot);
    });
  }

  cancelAllPlanned(): Promise<void> {
    return this.il.hold(NATIVE_LANE, 'cancelAll', () => {
      if (this.failCancel()) {
        throw new Error('notifee cancel failed (injected)');
      }
      this.cancelAllCalls += 1;
      this.tray.clear();
    });
  }

  openSystemSettings(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Held stand-in for `react-native-notify-kit`, faithful to the OS contract the
 * real adapter runs against: pending requests are keyed by id (adding an id
 * that already exists replaces it, as UNUserNotificationCenter does), and
 * every call is an independent native round trip (lane `native`, random
 * completion order). Install with
 *   jest.mock('react-native-notify-kit', () => mockNotifee.module());
 * and attach an Interleaver per iteration via `attach`.
 */
export class HeldNotifee {
  private il: Interleaver | null = null;
  authorizationStatus = 1;
  readonly pending = new Map<string, { trigger: unknown }>();
  createCalls = 0;
  cancelCalls = 0;
  getIdsCalls = 0;
  requestCalls = 0;
  settingsCalls = 0;

  attach(il: Interleaver): void {
    this.il = il;
  }

  reset(): void {
    this.pending.clear();
    this.createCalls = 0;
    this.cancelCalls = 0;
    this.getIdsCalls = 0;
    this.requestCalls = 0;
    this.settingsCalls = 0;
    this.authorizationStatus = 1;
  }

  ownedIds(): string[] {
    return [...this.pending.keys()].filter(id => id.startsWith('ps.')).sort();
  }

  private hold<T>(label: string, produce: () => T): Promise<T> {
    if (!this.il) return Promise.resolve(produce());
    return this.il.hold(NATIVE_LANE, label, produce);
  }

  module(): Record<string, unknown> {
    return {
      __esModule: true,
      default: {
        requestPermission: () => {
          this.requestCalls += 1;
          return this.hold('requestPermission', () => ({
            authorizationStatus: this.authorizationStatus,
          }));
        },
        getNotificationSettings: () => {
          this.settingsCalls += 1;
          return this.hold('getNotificationSettings', () => ({
            authorizationStatus: this.authorizationStatus,
          }));
        },
        createChannel: () => this.hold('createChannel', () => 'reminders'),
        createTriggerNotification: (
          notification: { id?: string },
          trigger: unknown,
        ) => {
          this.createCalls += 1;
          const id = notification.id ?? 'mock-id';
          return this.hold(`create:${id}`, () => {
            this.pending.set(id, { trigger });
            return id;
          });
        },
        getTriggerNotificationIds: () => {
          this.getIdsCalls += 1;
          return this.hold('getTriggerNotificationIds', () => [
            ...this.pending.keys(),
          ]);
        },
        cancelTriggerNotification: (id: string) => {
          this.cancelCalls += 1;
          return this.hold(`cancel:${id}`, () => {
            this.pending.delete(id);
          });
        },
        openNotificationSettings: () => this.hold('openSettings', () => {}),
        getInitialNotification: () => this.hold('getInitial', () => null),
        onForegroundEvent: () => () => {},
        onBackgroundEvent: () => {},
      },
      AndroidImportance: { DEFAULT: 3, HIGH: 4 },
      RepeatFrequency: { NONE: -1, HOURLY: 0, DAILY: 1, WEEKLY: 2 },
      TriggerType: { TIMESTAMP: 0, INTERVAL: 1 },
      EventType: { DISMISSED: 0, PRESS: 1, DELIVERED: 3 },
    };
  }
}

export function heldLoadContext(
  db: FakeKvDb,
  context: () => NotificationPlanContext,
  reads: number,
): () => Promise<NotificationPlanContext> {
  return async () => {
    for (let i = 0; i < reads; i += 1) {
      await db.execute('SELECT consistency snapshot', []);
    }
    return context();
  };
}

export const FIXED_NOW_MS = new Date(2026, 7, 25, 10, 0, 0).getTime();

export function randomContext(random: () => number): NotificationPlanContext {
  const streakDays = randomInt(random, 0, 9);
  return {
    nowMs: FIXED_NOW_MS + randomInt(random, 0, 12) * 60 * 60 * 1000,
    streakDays,
    practicedToday: random() < 0.5,
    hasAnyHistory: streakDays > 0 || random() < 0.5,
    shieldsAvailable: randomInt(random, 0, 2),
    milestoneEve:
      random() < 0.3
        ? { title: `${streakDays + 1}-day streak`, days: 7 }
        : null,
  };
}

export type PrefsPatch = Partial<Omit<NotificationPrefs, 'version'>>;

export function randomPatch(random: () => number): PrefsPatch {
  const patch: PrefsPatch = {};
  if (random() < 0.7) patch.enabled = random() < 0.6;
  if (random() < 0.3) patch.practiceReminder = random() < 0.5;
  if (random() < 0.3)
    patch.practiceReminderMinutes = randomInt(random, 0, 1439);
  if (random() < 0.3) patch.streakDefense = random() < 0.5;
  if (random() < 0.3) patch.weeklyRecap = random() < 0.5;
  if (random() < 0.3) patch.comeback = random() < 0.5;
  if (random() < 0.2) patch.promptDismissed = random() < 0.5;
  if (Object.keys(patch).length === 0) patch.enabled = true;
  return patch;
}

export function foldPatches(
  base: NotificationPrefs,
  patches: readonly PrefsPatch[],
): NotificationPrefs {
  let prefs = base;
  for (const patch of patches) prefs = { ...prefs, ...patch, version: 1 };
  return prefs;
}

export function trayIds(scheduler: TrayScheduler): string[] {
  return [...scheduler.tray.keys()].sort();
}

/** What the OS tray must hold for a settled store: exactly the plan for the
 * current prefs when scheduling is allowed, otherwise nothing. */
export function expectedTray(
  allowed: boolean,
  prefs: NotificationPrefs,
  context: NotificationPlanContext,
): string[] {
  if (!allowed) return [];
  return buildNotificationPlan(prefs, context)
    .map(item => item.id)
    .sort();
}
