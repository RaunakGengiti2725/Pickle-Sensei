import type {
  PermissionState,
  SchedulerPort,
} from '../../../src/notifications/service';
import {
  NOTIFICATION_ID_PREFIX,
  type PlannedNotification,
} from '../../../src/notifications/types';
import {
  InjectedFaultError,
  runFault,
  type FaultJournal,
  type FaultMode,
} from './faults';
import type { SeededRng } from './seededRng';

/**
 * SchedulerPort double with an explicit model of the OS side: the real
 * permission the system holds and the trigger queue it keeps (including
 * reminders owned by other libraries, which must never be touched).
 *
 * Methods are deliberately NOT `async` so a `throw` fault escapes
 * synchronously; the production adapter is `async` and cannot do that, so
 * campaigns that want realism exclude `throw` at this seam.
 *
 * `partial` semantics per op:
 *   requestPermission  the OS granted, the reply was lost → rejects
 *   applyPlan          own reminders cleared, first half re-created → rejects
 *   cancelAllPlanned   half of the own reminders removed → rejects
 *   permissionState / openSystemSettings → plain reject
 */

export type SchedulerOp = keyof SchedulerPort;
export const SCHEDULER_OPS: readonly SchedulerOp[] = [
  'permissionState',
  'requestPermission',
  'applyPlan',
  'cancelAllPlanned',
  'openSystemSettings',
];

export interface SchedulerCall {
  op: SchedulerOp;
  mode: FaultMode;
  outcome: 'ok' | 'failed' | 'pending';
  /** Value a successful permission call handed back. */
  result?: PermissionState;
  /** Plan handed to applyPlan (ids only). */
  planIds?: string[];
  plan?: PlannedNotification[];
  atMs: number;
}

export const FOREIGN_TRIGGER_IDS = [
  'other-lib.reminder',
  'calendar.sync.42',
] as const;

export class FaultScheduler implements SchedulerPort {
  /** What the OS actually holds for the app. */
  osPermission: PermissionState = 'undetermined';
  /** What a system prompt would yield. */
  promptOutcome: PermissionState = 'granted';
  /** Simulated OS trigger store (own `ps.*` ids + foreign ids). */
  readonly osQueue = new Map<string, PlannedNotification | null>();
  readonly calls: SchedulerCall[] = [];
  modeFor: (op: SchedulerOp) => FaultMode = () => 'ok';

  constructor(
    private readonly journal: FaultJournal,
    private readonly rng: SeededRng,
  ) {
    for (const id of FOREIGN_TRIGGER_IDS) this.osQueue.set(id, null);
  }

  private track(
    op: SchedulerOp,
    extra?: Partial<SchedulerCall>,
  ): SchedulerCall {
    const call: SchedulerCall = {
      op,
      mode: this.modeFor(op),
      outcome: 'pending',
      atMs: Date.now(),
      ...extra,
    };
    this.calls.push(call);
    return call;
  }

  private run<T>(
    call: SchedulerCall,
    produce: () => T,
    partial?: () => T,
  ): Promise<T> {
    let promise: Promise<T>;
    try {
      promise = runFault(
        this.journal,
        'scheduler',
        call.op,
        call.mode,
        () => {
          const value = produce();
          call.outcome = 'ok';
          return value;
        },
        {
          slowMs: this.rng.int(500, 5_000),
          partial: partial
            ? (): never => {
                partial();
                call.outcome = 'failed';
                throw new InjectedFaultError('scheduler', call.op, 'partial');
              }
            : undefined,
        },
      );
    } catch (error) {
      call.outcome = 'failed';
      throw error;
    }
    return promise.then(
      value => value,
      (error: unknown) => {
        call.outcome = 'failed';
        throw error;
      },
    );
  }

  ownIds(): string[] {
    return [...this.osQueue.keys()].filter(id =>
      id.startsWith(NOTIFICATION_ID_PREFIX),
    );
  }

  ownPlan(): PlannedNotification[] {
    return this.ownIds()
      .map(id => this.osQueue.get(id))
      .filter((item): item is PlannedNotification => item !== null && !!item);
  }

  foreignIdsIntact(): boolean {
    return FOREIGN_TRIGGER_IDS.every(id => this.osQueue.has(id));
  }

  private clearOwn(fraction = 1): void {
    const own = this.ownIds();
    const count = Math.ceil(own.length * fraction);
    for (const id of own.slice(0, count)) this.osQueue.delete(id);
  }

  permissionState(): Promise<PermissionState> {
    const call = this.track('permissionState');
    return this.run(call, () => (call.result = this.osPermission));
  }

  requestPermission(): Promise<PermissionState> {
    const call = this.track('requestPermission');
    const grant = () => {
      if (this.osPermission === 'undetermined') {
        this.osPermission = this.promptOutcome;
      }
      call.result = this.osPermission;
      return this.osPermission;
    };
    return this.run(call, grant, grant);
  }

  applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    const call = this.track('applyPlan', {
      planIds: plan.map(item => item.id),
      plan: plan.map(item => ({ ...item })),
    });
    return this.run(
      call,
      () => {
        this.clearOwn();
        for (const item of plan) this.osQueue.set(item.id, { ...item });
      },
      () => {
        this.clearOwn();
        const half = plan.slice(0, Math.floor(plan.length / 2));
        for (const item of half) this.osQueue.set(item.id, { ...item });
      },
    );
  }

  cancelAllPlanned(): Promise<void> {
    const call = this.track('cancelAllPlanned');
    return this.run(
      call,
      () => this.clearOwn(),
      () => this.clearOwn(0.5),
    );
  }

  openSystemSettings(): Promise<void> {
    const call = this.track('openSystemSettings');
    return this.run(call, () => {});
  }

  /** Scheduling calls (apply/cancel) issued at or after `sinceIndex`. */
  scheduleCallsSince(sinceIndex: number): SchedulerCall[] {
    return this.calls
      .slice(sinceIndex)
      .filter(
        call => call.op === 'applyPlan' || call.op === 'cancelAllPlanned',
      );
  }
}
