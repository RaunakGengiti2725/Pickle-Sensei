import {
  InjectedFaultError,
  runFault,
  type FaultJournal,
  type FaultMode,
} from './faults';
import type { SeededRng } from './seededRng';

/**
 * Fault-injecting stand-in for the `react-native-notify-kit` native module
 * (the Notifee fork), used to drive the production `NotifeeScheduler`
 * adapter in service.ts. Models the OS trigger store (with reminders owned
 * by other libraries) and the OS authorization status.
 *
 * The module object handed to `jest.mock` must be stable because service.ts
 * caches its `require`; each iteration swaps the `impl` behind it.
 */

export type NativeOp =
  | 'getNotificationSettings'
  | 'requestPermission'
  | 'getTriggerNotificationIds'
  | 'cancelTriggerNotification'
  | 'createTriggerNotification'
  | 'openNotificationSettings'
  | 'getInitialNotification'
  | 'onForegroundEvent';

export const NATIVE_OPS: readonly NativeOp[] = [
  'getNotificationSettings',
  'requestPermission',
  'getTriggerNotificationIds',
  'cancelTriggerNotification',
  'createTriggerNotification',
  'openNotificationSettings',
  'getInitialNotification',
  'onForegroundEvent',
];

/** Notifee AuthorizationStatus: NOT_DETERMINED -1, DENIED 0, AUTHORIZED 1,
 *  PROVISIONAL 2, EPHEMERAL 3. Anything else is outside the contract. */
export const VALID_STATUSES = [-1, 0, 1, 2, 3] as const;
export const MALFORMED_SETTINGS: ReadonlyArray<() => unknown> = [
  () => ({}),
  () => ({ authorizationStatus: undefined }),
  () => ({ authorizationStatus: null }),
  () => ({ authorizationStatus: Number.NaN }),
  () => ({ authorizationStatus: 'granted' }),
  () => ({ authorizationStatus: '1' }),
  () => ({ authorizationStatus: 7 }),
  () => ({ authorizationStatus: -2 }),
  () => ({ authorizationStatus: 1.5 }),
  () => null,
  () => undefined,
  () => 1,
];

export interface StoredTrigger {
  notification: { id?: unknown; data?: unknown };
  trigger: { type?: unknown; timestamp?: unknown; repeatFrequency?: unknown };
}

export interface NativeCall {
  op: NativeOp;
  mode: FaultMode;
  outcome: 'ok' | 'failed' | 'pending';
  id?: string;
  atMs: number;
}

export const FOREIGN_NATIVE_IDS = ['other.lib.daily', 'calendar-99'] as const;

type ForegroundListener = (event: unknown) => void;

export class FaultNotifee {
  /** OS authorization status (raw notifee number or malformed value). */
  status: unknown = -1;
  /** What answering the prompt yields. */
  promptStatus: unknown = 1;
  readonly triggers = new Map<string, StoredTrigger>();
  readonly calls: NativeCall[] = [];
  /** Ids the adapter asked the OS to cancel. */
  readonly cancelled: string[] = [];
  initialNotification: unknown = null;
  foregroundListeners: ForegroundListener[] = [];
  /** Exceptions a foreground listener let escape into the emitter. */
  readonly listenerErrors: Array<{ event: unknown; error: unknown }> = [];
  modeFor: (op: NativeOp) => FaultMode = () => 'ok';

  constructor(
    private readonly journal: FaultJournal,
    private readonly rng: SeededRng,
  ) {
    for (const id of FOREIGN_NATIVE_IDS) {
      this.triggers.set(id, {
        notification: { id, data: { screen: 'Elsewhere' } },
        trigger: { type: 0, timestamp: Date.now() + 3_600_000 },
      });
    }
  }

  ownIds(): string[] {
    return [...this.triggers.keys()].filter(id => id.startsWith('ps.'));
  }

  foreignIntact(): boolean {
    return FOREIGN_NATIVE_IDS.every(id => this.triggers.has(id));
  }

  private track(op: NativeOp, id?: string): NativeCall {
    const call: NativeCall = {
      op,
      mode: this.modeFor(op),
      outcome: 'pending',
      atMs: Date.now(),
      ...(id === undefined ? {} : { id }),
    };
    this.calls.push(call);
    return call;
  }

  private run<T>(
    call: NativeCall,
    produce: () => T,
    hooks: { malformed?: () => T; partial?: () => T } = {},
  ): Promise<T> {
    let promise: Promise<T>;
    try {
      promise = runFault(
        this.journal,
        'notifee',
        call.op,
        call.mode,
        () => {
          const value = produce();
          call.outcome = 'ok';
          return value;
        },
        {
          slowMs: this.rng.int(500, 5_000),
          malformed: hooks.malformed
            ? () => {
                const value = hooks.malformed!();
                call.outcome = 'ok';
                return value;
              }
            : undefined,
          partial: hooks.partial
            ? (): never => {
                hooks.partial!();
                call.outcome = 'failed';
                throw new InjectedFaultError('notifee', call.op, 'partial');
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

  /** The object `require('react-native-notify-kit').default` resolves to. */
  readonly api = {
    getNotificationSettings: (): Promise<unknown> => {
      const call = this.track('getNotificationSettings');
      return this.run(call, () => ({ authorizationStatus: this.status }), {
        malformed: () => this.rng.pick(MALFORMED_SETTINGS)(),
      });
    },
    requestPermission: (): Promise<unknown> => {
      const call = this.track('requestPermission');
      const answer = () => {
        if (this.status === -1) this.status = this.promptStatus;
        return { authorizationStatus: this.status };
      };
      return this.run(call, answer, {
        malformed: () => this.rng.pick(MALFORMED_SETTINGS)(),
        // The OS recorded the answer, the bridge lost the reply.
        partial: answer,
      });
    },
    createChannel: async (): Promise<string> => 'reminders',
    createTriggerNotification: (
      notification: { id?: unknown; data?: unknown },
      trigger: StoredTrigger['trigger'],
    ): Promise<unknown> => {
      const id =
        typeof notification.id === 'string' ? notification.id : 'mock-id';
      const call = this.track('createTriggerNotification', id);
      return this.run(call, () => {
        this.triggers.set(id, { notification, trigger });
        return id;
      });
    },
    getTriggerNotificationIds: (): Promise<unknown> => {
      const call = this.track('getTriggerNotificationIds');
      const ids = () => [...this.triggers.keys()];
      return this.run(call, ids, {
        malformed: () =>
          this.rng.pick<() => unknown>([
            () => null,
            () => undefined,
            () => 'ps.reminder.practice',
            () => [...ids(), 42, undefined],
            () => [...ids(), null],
            () => ({ ids: ids() }),
          ])(),
        // Half the id list — the OS answered with a truncated page.
        partial: () => ids().slice(0, Math.ceil(ids().length / 2)),
      });
    },
    cancelTriggerNotification: (id: unknown): Promise<void> => {
      const call = this.track(
        'cancelTriggerNotification',
        typeof id === 'string' ? id : String(id),
      );
      if (typeof id === 'string') this.cancelled.push(id);
      return this.run(call, () => {
        if (typeof id === 'string') this.triggers.delete(id);
      });
    },
    openNotificationSettings: (): Promise<void> => {
      const call = this.track('openNotificationSettings');
      return this.run(call, () => {});
    },
    getInitialNotification: (): Promise<unknown> => {
      const call = this.track('getInitialNotification');
      return this.run(call, () => this.initialNotification, {
        malformed: () =>
          this.rng.pick<() => unknown>([
            () => ({}),
            () => ({ notification: null }),
            () => ({ notification: { data: null } }),
            () => ({ notification: { data: { screen: 'Settings' } } }),
            () => ({ notification: { data: { screen: 42 } } }),
            () => ({ notification: { data: 'Home' } }),
            () => ({ notification: { data: { screen: ['Home'] } } }),
            () => 'Home',
          ])(),
      });
    },
    onForegroundEvent: (listener: ForegroundListener): (() => void) => {
      const call = this.track('onForegroundEvent');
      // Subscription registration is synchronous in notifee; only `throw`
      // and `ok` are meaningful here.
      if (call.mode === 'throw') {
        call.outcome = 'failed';
        this.journal.record({
          dependency: 'notifee',
          op: call.op,
          mode: 'throw',
          atMs: Date.now(),
        });
        throw new InjectedFaultError('notifee', call.op, 'throw');
      }
      this.journal.record({
        dependency: 'notifee',
        op: call.op,
        mode: 'ok',
        atMs: Date.now(),
      });
      call.outcome = 'ok';
      this.foregroundListeners.push(listener);
      return () => {
        this.foregroundListeners = this.foregroundListeners.filter(
          candidate => candidate !== listener,
        );
      };
    },
    onBackgroundEvent: (): void => {},
  };

  /** Delivers a foreground event to every live listener. In the app the
   *  emitter has no try/catch around the listener: a throw here is an
   *  uncaught exception, so it is recorded instead of propagated. */
  emitForeground(event: unknown): void {
    for (const listener of [...this.foregroundListeners]) {
      try {
        listener(event);
      } catch (error) {
        this.listenerErrors.push({ event, error });
      }
    }
  }
}

export const NOTIFEE_CONSTANTS = {
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
  RepeatFrequency: { NONE: -1, HOURLY: 0, DAILY: 1, WEEKLY: 2 },
  TriggerType: { TIMESTAMP: 0, INTERVAL: 1 },
  EventType: { DISMISSED: 0, PRESS: 1, DELIVERED: 3 },
} as const;
