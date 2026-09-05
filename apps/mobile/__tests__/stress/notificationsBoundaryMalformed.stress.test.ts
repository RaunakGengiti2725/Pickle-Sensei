/**
 * STRESS — mod-notifications, lens `boundary-malformed`.
 *
 * Seeded campaigns feed malformed / truncated / hostile inputs into every
 * public seam of the notification module and assert the contract at that
 * seam: no throw or rejection escapes a parser, planner, store action or
 * handler; every stored write re-parses to a valid prefs record; the plan
 * only ever names app-owned ids with finite future timestamps; navigation
 * data can only resolve to Home/Performance; foreign trigger ids are never
 * cancelled; `Object.prototype` is never polluted.
 *
 * Replay any row: `STRESS_ONLY=<campaign>:<index> STRESS_SEED=<seed> npx jest
 * --ci __tests__/stress`. Scale with `STRESS_ITER=<n>` (default small so the
 * suite stays fast); the JSON table lands in `artifacts/stress/<campaign>.json`
 * (override with `STRESS_OUT`).
 *
 * Every violation is recorded to the table; the campaign assertion fails on
 * any row that is not covered by a `KNOWN_DEFECTS` signature. Each known
 * defect has its own deterministic `it.failing` pin below so the pin starts
 * failing (→ flip to `it`) the moment the production code is fixed.
 */
import { createElement } from 'react';
import { AppState, Platform } from 'react-native';
import notifee from 'react-native-notify-kit';
import TestRenderer, { act } from 'react-test-renderer';
import type { NotificationPlanContext } from '../../src/notifications/plan';
import { buildNotificationPlan } from '../../src/notifications/plan';
import type {
  PermissionState,
  SchedulerPort,
} from '../../src/notifications/service';
import {
  getScheduler,
  screenTargetFromNotificationData,
} from '../../src/notifications/service';
import type {
  NotificationPrefs,
  PlannedNotification,
} from '../../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_ID_PREFIX,
  PLANNED_NOTIFICATION_IDS,
  notificationPrefsKeyForOwner,
  parseNotificationPrefs,
} from '../../src/notifications/types';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  Rng,
  iterationPlan,
  malformedPrefsJson,
  preview,
  realisticNow,
  rowSeed,
  stressBaseSeed,
  validContext,
  validPrefsJson,
  violationSummary,
  weirdAppState,
  weirdContext,
  weirdNotificationData,
  weirdOwnerKey,
  weirdPrefsPatch,
  weirdString,
  weirdTriggerId,
  writeTable,
  type StressRow,
} from '../../test-support/stress/boundaryMalformed';

// ---------------------------------------------------------------------------
// Faultable in-memory kv (the store's only persistence seam)

type DbFault =
  | 'none'
  | 'read-throws'
  | 'read-undefined-rows'
  | 'read-non-string'
  | 'write-throws'
  | 'write-pending-throws'
  | 'write-prefs-throws';

const mockKv = new Map<string, string>();
const mockDb = {
  fault: 'none' as DbFault,
  writes: [] as [string, string][],
  pendingKey: '',
  prefsPrefix: '',
};

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        if (mockDb.fault === 'read-throws') throw new Error('SQLITE_IOERR');
        if (mockDb.fault === 'read-undefined-rows') return { rows: undefined };
        const value = mockKv.get(String(params[0]));
        if (mockDb.fault === 'read-non-string' && value !== undefined) {
          return { rows: [{ value: { blob: value } }] };
        }
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        const key = String(params[0]);
        if (mockDb.fault === 'write-throws') throw new Error('SQLITE_FULL');
        if (
          mockDb.fault === 'write-pending-throws' &&
          key === mockDb.pendingKey
        ) {
          throw new Error('SQLITE_FULL');
        }
        if (
          mockDb.fault === 'write-prefs-throws' &&
          key.startsWith(mockDb.prefsPrefix)
        ) {
          throw new Error('SQLITE_FULL');
        }
        mockKv.set(key, String(params[1]));
        mockDb.writes.push([key, String(params[1])]);
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

import {
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  useNotificationStore,
} from '../../src/notifications/notificationStore';
import { useNotificationBootstrap } from '../../src/notifications/useNotificationBootstrap';

mockDb.pendingKey = PENDING_NOTIFICATION_ONBOARDING_KV_KEY;
mockDb.prefsPrefix = notificationPrefsKeyForOwner('');
const FOREIGN_OWNER = '99999999-9999-4999-8999-999999999999';

type SchedulerFault =
  | 'none'
  | 'permission-throws'
  | 'permission-garbage'
  | 'cancel-throws'
  | 'apply-throws';

class FaultScheduler implements SchedulerPort {
  permission: PermissionState = 'undetermined';
  fault: SchedulerFault = 'none';
  appliedPlans: PlannedNotification[][] = [];
  cancelAllCalls = 0;
  async permissionState(): Promise<PermissionState> {
    if (this.fault === 'permission-throws') throw new Error('native gone');
    if (this.fault === 'permission-garbage') {
      return 'authorized' as unknown as PermissionState;
    }
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    return this.permission;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    if (this.fault === 'apply-throws') throw new Error('schedule failed');
    this.appliedPlans.push([...plan]);
  }
  async cancelAllPlanned(): Promise<void> {
    if (this.fault === 'cancel-throws') throw new Error('cancel failed');
    this.cancelAllCalls += 1;
  }
  async openSystemSettings(): Promise<void> {}
}

const OWNER = '33333333-3333-4333-8333-333333333333';
const PREF_KEY_SET = [
  'version',
  'enabled',
  'practiceReminder',
  'practiceReminderMinutes',
  'streakDefense',
  'weeklyRecap',
  'comeback',
  'promptDismissed',
].sort();

function resetStore() {
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
}

function prefsShapeViolations(value: unknown, label: string): string[] {
  const out: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`${label}: not a plain object`];
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== PREF_KEY_SET.join(',')) {
    out.push(`${label}: key set ${keys.join(',')}`);
  }
  if (record['version'] !== 1)
    out.push(`${label}: version=${preview(record['version'], 60)}`);
  for (const k of [
    'enabled',
    'practiceReminder',
    'streakDefense',
    'weeklyRecap',
    'comeback',
    'promptDismissed',
  ]) {
    if (typeof record[k] !== 'boolean') {
      out.push(`${label}: ${k} is ${typeof record[k]}`);
    }
  }
  const m = record['practiceReminderMinutes'];
  // -0 is accepted: JSON round-trips it as 0 and every consumer multiplies it.
  if (typeof m !== 'number' || !Number.isInteger(m) || m < 0 || m >= 1440) {
    out.push(`${label}: practiceReminderMinutes=${preview(m, 60)}`);
  }
  if (Object.getPrototypeOf(record) !== Object.prototype) {
    out.push(`${label}: foreign prototype`);
  }
  return out;
}

function isNonCoercible(value: unknown): boolean {
  return (
    typeof value === 'symbol' ||
    typeof value === 'bigint' ||
    (typeof value === 'object' &&
      value !== null &&
      Object.getPrototypeOf(value) === null)
  );
}

function protoPollutionViolations(): string[] {
  const out: string[] = [];
  const proto = Object.prototype as unknown as Record<string, unknown>;
  for (const k of [
    'polluted',
    'enabled',
    'practiceReminderMinutes',
    'screen',
  ]) {
    if (k in {} || proto[k] !== undefined)
      out.push(`Object.prototype.${k} polluted`);
  }
  return out;
}

function planViolations(
  plan: unknown,
  prefs: NotificationPrefs,
  nowMs: number,
  label: string,
  copyCap = 400,
): string[] {
  const out: string[] = [];
  if (!Array.isArray(plan)) return [`${label}: plan not an array`];
  if (plan.length > PLANNED_NOTIFICATION_IDS.length) {
    out.push(
      `${label}: ${plan.length} items > ${PLANNED_NOTIFICATION_IDS.length}`,
    );
  }
  const ids = new Set<string>();
  for (const item of plan as PlannedNotification[]) {
    if (!(PLANNED_NOTIFICATION_IDS as readonly string[]).includes(item.id)) {
      out.push(`${label}: unknown id ${preview(item.id)}`);
    }
    if (!item.id.startsWith(NOTIFICATION_ID_PREFIX)) {
      out.push(`${label}: id outside prefix ${preview(item.id)}`);
    }
    if (ids.has(item.id)) out.push(`${label}: duplicate id ${item.id}`);
    ids.add(item.id);
    if (
      typeof item.timestampMs !== 'number' ||
      !Number.isFinite(item.timestampMs)
    ) {
      out.push(`${label}: ${item.id} timestampMs=${String(item.timestampMs)}`);
    } else if (item.timestampMs < nowMs + 90_000) {
      out.push(
        `${label}: ${item.id} timestampMs ${item.timestampMs} < now+90s (${nowMs + 90_000})`,
      );
    }
    if (
      typeof item.title !== 'string' ||
      item.title.length === 0 ||
      item.title.length > copyCap
    ) {
      out.push(`${label}: ${item.id} title ${preview(item.title, 80)}`);
    }
    if (
      typeof item.body !== 'string' ||
      item.body.length === 0 ||
      item.body.length > copyCap
    ) {
      out.push(`${label}: ${item.id} body ${preview(item.body, 80)}`);
    }
    if (item.screen !== 'Home' && item.screen !== 'Performance') {
      out.push(`${label}: ${item.id} screen ${preview(item.screen)}`);
    }
    if (
      item.repeat !== null &&
      item.repeat !== 'daily' &&
      item.repeat !== 'weekly'
    ) {
      out.push(`${label}: ${item.id} repeat ${preview(item.repeat)}`);
    }
  }
  if (!prefs.enabled && plan.length > 0)
    out.push(`${label}: plan while disabled`);
  if (prefs.enabled) {
    if (!prefs.practiceReminder && ids.has('ps.reminder.practice')) {
      out.push(`${label}: practice scheduled while off`);
    }
    if (!prefs.streakDefense && ids.has('ps.reminder.streak')) {
      out.push(`${label}: streak scheduled while off`);
    }
    if (!prefs.weeklyRecap && ids.has('ps.reminder.weekly')) {
      out.push(`${label}: weekly scheduled while off`);
    }
    if (!prefs.comeback && [...ids].some(id => id.startsWith('ps.comeback.'))) {
      out.push(`${label}: comeback scheduled while off`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Known defects: rows matching one of these are still recorded BROKEN in the
// table, but do not fail the campaign assertion. Each has a pin below.

interface KnownDefect {
  id: string;
  campaign: string;
  matches: (violations: string[]) => boolean;
}

const KNOWN_DEFECTS: readonly KnownDefect[] = [
  {
    id: 'KD1-plan-nonfinite-passthrough',
    campaign: 'plan.malformedContext',
    matches: v => v.some(x => /timestampMs=(NaN|Infinity|-Infinity)/.test(x)),
  },
  {
    id: 'KD2-plan-copy-uncapped-from-context',
    campaign: 'plan.malformedContext',
    matches: v => v.every(x => / (title|body) /.test(x)),
  },
  {
    id: 'KD3-setPrefs-no-runtime-validation',
    campaign: 'store.setPrefs',
    matches: v =>
      v.every(
        x =>
          x.startsWith('memory:') ||
          x.startsWith('applied-plan') ||
          x.startsWith('scheduled-while-disabled'),
      ),
  },
  {
    id: 'KD4-hydrate-pending-clear-failure-drops-prefs',
    campaign: 'store.hydrate',
    matches: v => v.length === 1 && v[0]!.startsWith('memory-vs-stored:'),
  },
  {
    id: 'KD5-adapter-non-numeric-status-fails-open',
    campaign: 'service.adapter',
    matches: v => v.every(x => x.startsWith('non-numeric status')),
  },
];

function classify(
  campaign: string,
  violations: string[],
): { outcome: 'held' | 'broken'; known?: string } {
  if (violations.length === 0) return { outcome: 'held' };
  const kd = KNOWN_DEFECTS.find(
    d => d.campaign === campaign && d.matches(violations),
  );
  return { outcome: 'broken', known: kd?.id };
}

const unknownBroken: StressRow[] = [];
const allRows: StressRow[] = [];

function finish(campaign: string, rows: StressRow[]) {
  allRows.push(...rows);
  const file = writeTable(campaign, rows);
  const unknown = rows.filter(
    r => r.outcome === 'broken' && !r.note?.startsWith('known:'),
  );
  unknownBroken.push(...unknown);
  return { file, unknown };
}

function makeRow(
  campaign: string,
  index: number,
  seed: number,
  category: string,
  payload: unknown,
  violations: string[],
): StressRow {
  const c = classify(campaign, violations);
  return {
    campaign,
    index,
    seed,
    category,
    payload: preview(payload),
    outcome: c.outcome,
    violations,
    ...(c.known ? { note: `known:${c.known}` } : {}),
  };
}

const BASE = stressBaseSeed();
let campaignIndex = 0;

beforeEach(() => {
  mockKv.clear();
  mockDb.fault = 'none';
  mockDb.writes = [];
  resetStore();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Campaign 1: parseNotificationPrefs against malformed stored JSON

describe('stress: parseNotificationPrefs', () => {
  const campaign = 'types.parseNotificationPrefs';
  const ci = campaignIndex++;

  it('never throws, always returns a valid prefs record, never pollutes the prototype', () => {
    const rows: StressRow[] = [];
    for (const i of iterationPlan(campaign)) {
      const seed = rowSeed(BASE, ci, i);
      const rng = new Rng(seed);
      const { category, text } = malformedPrefsJson(rng);
      const violations: string[] = [];
      let result: unknown;
      try {
        result = parseNotificationPrefs(text);
      } catch (e) {
        violations.push(`throw: ${String(e).slice(0, 120)}`);
      }
      if (violations.length === 0) {
        violations.push(...prefsShapeViolations(result, 'result'));
        if (result === DEFAULT_NOTIFICATION_PREFS) {
          violations.push('result aliases DEFAULT_NOTIFICATION_PREFS');
        }
        try {
          const again = parseNotificationPrefs(JSON.stringify(result));
          if (JSON.stringify(again) !== JSON.stringify(result)) {
            violations.push('round-trip not idempotent');
          }
        } catch (e) {
          violations.push(`round-trip throw: ${String(e).slice(0, 80)}`);
        }
      }
      violations.push(...protoPollutionViolations());
      rows.push(makeRow(campaign, i, seed, category, text, violations));
    }
    const { unknown } = finish(campaign, rows);
    expect(violationSummary(unknown)).toBe('');
    expect(unknown).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Campaign 2: buildNotificationPlan over the full VALID input space

describe('stress: buildNotificationPlan (valid space)', () => {
  const campaign = 'plan.validSpace';
  const ci = campaignIndex++;

  it('emits only owned ids, finite timestamps ≥ now+90s, honoring every toggle', () => {
    const rows: StressRow[] = [];
    for (const i of iterationPlan(campaign)) {
      const seed = rowSeed(BASE, ci, i);
      const rng = new Rng(seed);
      const prefs = parseNotificationPrefs(validPrefsJson(rng));
      const context = validContext(rng) as unknown as NotificationPlanContext;
      const violations: string[] = [];
      let plan: unknown;
      try {
        plan = buildNotificationPlan(prefs, context);
      } catch (e) {
        violations.push(`throw: ${String(e).slice(0, 120)}`);
      }
      if (violations.length === 0) {
        violations.push(...planViolations(plan, prefs, context.nowMs, 'plan'));
        const items = plan as PlannedNotification[];
        const practice = items.find(p => p.id === 'ps.reminder.practice');
        if (practice) {
          const d = new Date(practice.timestampMs);
          if (
            d.getHours() * 60 + d.getMinutes() !==
            prefs.practiceReminderMinutes
          ) {
            violations.push(
              `practice wall-clock ${d.getHours()}:${d.getMinutes()} != ${prefs.practiceReminderMinutes}`,
            );
          }
          if (
            practice.timestampMs - context.nowMs >
            24 * 3_600_000 + 3_600_000 + 90_000
          ) {
            violations.push('practice more than a day+DST away');
          }
        }
        const weekly = items.find(p => p.id === 'ps.reminder.weekly');
        if (weekly && new Date(weekly.timestampMs).getDay() !== 0) {
          violations.push('weekly not on Sunday');
        }
        if (prefs.enabled && prefs.comeback) {
          for (const n of [1, 2, 3]) {
            if (!items.some(p => p.id === `ps.comeback.${n}`)) {
              violations.push(`comeback rung ${n} missing`);
            }
          }
        }
        if (
          context.streakDays === 0 &&
          items.some(p => p.id === 'ps.reminder.streak')
        ) {
          violations.push('streak defense with streakDays=0');
        }
      }
      rows.push(
        makeRow(campaign, i, seed, 'valid', { prefs, context }, violations),
      );
    }
    const { unknown } = finish(campaign, rows);
    expect(violationSummary(unknown)).toBe('');
    expect(unknown).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Campaign 3: buildNotificationPlan with malformed prefs/context

describe('stress: buildNotificationPlan (malformed context)', () => {
  const campaign = 'plan.malformedContext';
  const ci = campaignIndex++;

  it('never throws; ids/toggles stay honest (timestamp sanity recorded, KD1/KD2 pinned)', () => {
    const rows: StressRow[] = [];
    for (const i of iterationPlan(campaign)) {
      const seed = rowSeed(BASE, ci, i);
      const rng = new Rng(seed);
      const prefs = parseNotificationPrefs(validPrefsJson(rng));
      const { category, context } = weirdContext(rng);
      const violations: string[] = [];
      let plan: unknown;
      let contractThrow = false;
      try {
        plan = buildNotificationPlan(
          prefs,
          context as unknown as NotificationPlanContext,
        );
      } catch (e) {
        // `nowMs` is declared `number` and the only caller passes Date.now().
        // A Symbol/BigInt/null-prototype value cannot be coerced by
        // `new Date(x)` at all — that TypeError is the language's, and is
        // unreachable from any stored or user input. Every other throw is a break.
        if (isNonCoercible(context['nowMs']) && e instanceof TypeError) {
          contractThrow = true;
        } else {
          violations.push(`throw: ${String(e).slice(0, 120)}`);
        }
      }
      if (violations.length === 0 && !contractThrow) {
        const now =
          typeof context['nowMs'] === 'number'
            ? (context['nowMs'] as number)
            : NaN;
        violations.push(...planViolations(plan, prefs, now, 'plan', 65_536));
      }
      const row = makeRow(
        campaign,
        i,
        seed,
        category,
        { prefs, context },
        violations,
      );
      if (contractThrow) {
        row.note =
          'type-contract violation (non-coercible nowMs) → TypeError (expected)';
      }
      rows.push(row);
    }
    const { unknown } = finish(campaign, rows);
    expect(violationSummary(unknown)).toBe('');
    expect(unknown).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Campaign 4: store.hydrate over malformed stored prefs / pending markers,
// owners, permission states and persistence faults

describe('stress: notificationStore.hydrate', () => {
  const campaign = 'store.hydrate';
  const ci = campaignIndex++;

  it('resolves, keeps prefs well-formed, writes only its own keys, schedules only when enabled+granted', async () => {
    const rows: StressRow[] = [];
    for (const i of iterationPlan(campaign)) {
      const seed = rowSeed(BASE, ci, i);
      const rng = new Rng(seed);
      mockKv.clear();
      mockDb.writes = [];
      resetStore();

      const owner = rng.pick([
        OWNER,
        OWNER,
        GUEST_DATA_OWNER,
        SIGNED_OUT_DATA_OWNER,
      ]);
      setActiveDataOwner(owner);
      const prefsKey = notificationPrefsKeyForOwner(owner);
      const storedKind = rng.int(0, 2);
      const stored =
        storedKind === 0
          ? null
          : storedKind === 1
            ? { category: 'valid', text: validPrefsJson(rng) }
            : malformedPrefsJson(rng);
      if (stored) mockKv.set(prefsKey, stored.text);
      const pendingKind = rng.int(0, 3);
      const pending =
        pendingKind === 0
          ? null
          : pendingKind === 1
            ? JSON.stringify({ version: 1, enabled: rng.bool() })
            : pendingKind === 2
              ? malformedPrefsJson(rng).text
              : rng.pick([
                  '{"version":2,"enabled":true}',
                  '{"version":1,"enabled":"true"}',
                  '{"__proto__":{"enabled":true},"version":1}',
                  '{"version":1,"enabled":true,"enabled":1}',
                  '[{"version":1,"enabled":true}]',
                  '',
                  weirdString(rng),
                ]);
      if (pending !== null)
        mockKv.set(PENDING_NOTIFICATION_ONBOARDING_KV_KEY, pending);
      // A stale foreign key must never be touched.
      mockKv.set(
        notificationPrefsKeyForOwner(FOREIGN_OWNER),
        '{"enabled":true}',
      );
      mockKv.set('profile:x', 'untouched');

      mockDb.fault = rng.pick<DbFault>([
        'none',
        'none',
        'none',
        'read-throws',
        'read-undefined-rows',
        'read-non-string',
        'write-throws',
        'write-pending-throws',
        'write-prefs-throws',
      ]);
      const scheduler = new FaultScheduler();
      scheduler.permission = rng.pick<PermissionState>([
        'granted',
        'denied',
        'undetermined',
      ]);
      scheduler.fault = rng.pick<SchedulerFault>([
        'none',
        'none',
        'permission-throws',
        'permission-garbage',
        'cancel-throws',
        'apply-throws',
      ]);
      const nowMs = realisticNow(rng);
      const context = validContext(rng);
      context['nowMs'] = nowMs;
      const expectedOwnerKey = rng.chance(0.2) ? weirdOwnerKey(rng) : undefined;

      const violations: string[] = [];
      try {
        await useNotificationStore.getState().hydrate({
          scheduler,
          loadContext: async () =>
            context as unknown as NotificationPlanContext,
          ...(expectedOwnerKey !== undefined ? { expectedOwnerKey } : {}),
        });
      } catch (e) {
        violations.push(`rejection: ${String(e).slice(0, 120)}`);
      }
      const state = useNotificationStore.getState();
      violations.push(...prefsShapeViolations(state.prefs, 'memory'));
      violations.push(...protoPollutionViolations());

      const ownerMismatch =
        expectedOwnerKey !== undefined && expectedOwnerKey !== owner;
      if (ownerMismatch) {
        if (state.hydrated)
          violations.push('hydrated for a non-active expectedOwnerKey');
        if (mockDb.writes.length > 0)
          violations.push('wrote for a non-active expectedOwnerKey');
        if (scheduler.appliedPlans.length > 0)
          violations.push('scheduled for a non-active owner');
      } else {
        if (!state.hydrated) violations.push('not hydrated');
        if (state.ownerKey !== owner)
          violations.push(`ownerKey=${String(state.ownerKey)}`);
      }

      for (const [key, value] of mockDb.writes) {
        if (
          key !== prefsKey &&
          key !== PENDING_NOTIFICATION_ONBOARDING_KV_KEY
        ) {
          violations.push(`write to foreign key ${preview(key)}`);
        }
        if (key === prefsKey) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(value);
          } catch {
            violations.push('stored prefs not JSON');
          }
          if (parsed !== undefined)
            violations.push(...prefsShapeViolations(parsed, 'stored'));
        }
        if (key === PENDING_NOTIFICATION_ONBOARDING_KV_KEY && value !== '') {
          violations.push(`pending marker rewritten to ${preview(value)}`);
        }
      }
      if (
        mockKv.get(notificationPrefsKeyForOwner(FOREIGN_OWNER)) !==
          '{"enabled":true}' ||
        mockKv.get('profile:x') !== 'untouched'
      ) {
        violations.push('foreign kv row modified');
      }
      if (owner === SIGNED_OUT_DATA_OWNER && mockDb.writes.length > 0) {
        violations.push('signed-out hydrate wrote to kv');
      }

      const granted = state.permission === 'granted';
      if (scheduler.appliedPlans.length > 0) {
        if (!(state.prefs.enabled === true && granted)) {
          violations.push(
            `applied-plan without enabled+granted (enabled=${String(state.prefs.enabled)}, permission=${state.permission})`,
          );
        }
        for (const plan of scheduler.appliedPlans) {
          violations.push(
            ...planViolations(plan, state.prefs, nowMs, 'applied-plan'),
          );
        }
      }
      if (
        !ownerMismatch &&
        state.hydrated &&
        (!state.prefs.enabled || !granted) &&
        scheduler.fault !== 'cancel-throws' &&
        scheduler.cancelAllCalls === 0
      ) {
        violations.push('disabled/ungranted hydrate did not cancel');
      }
      if (scheduler.fault === 'permission-garbage' && granted) {
        violations.push('garbage permission state treated as granted');
      }
      if (
        (scheduler.fault === 'apply-throws' ||
          scheduler.fault === 'cancel-throws') &&
        !ownerMismatch &&
        owner !== SIGNED_OUT_DATA_OWNER &&
        state.hydrated &&
        !state.scheduleFailed &&
        // apply only runs when enabled+granted; cancel runs otherwise
        ((scheduler.fault === 'apply-throws' &&
          state.prefs.enabled &&
          granted) ||
          (scheduler.fault === 'cancel-throws' &&
            !(state.prefs.enabled && granted)))
      ) {
        violations.push('scheduler failure not surfaced in scheduleFailed');
      }

      // Memory must reflect what is stored when the store was readable and
      // no persistence fault occurred (pending marker may override when raw absent).
      if (
        !ownerMismatch &&
        owner !== SIGNED_OUT_DATA_OWNER &&
        mockDb.fault === 'none' &&
        state.hydrated
      ) {
        const storedNow = mockKv.get(prefsKey);
        const expected = parseNotificationPrefs(storedNow ?? null);
        if (JSON.stringify(expected) !== JSON.stringify(state.prefs)) {
          violations.push(
            `memory-vs-stored: memory=${preview(state.prefs, 120)} stored=${preview(storedNow, 120)}`,
          );
        }
      }
      if (
        !ownerMismatch &&
        owner !== SIGNED_OUT_DATA_OWNER &&
        mockDb.fault === 'write-pending-throws' &&
        stored === null &&
        pendingKind === 1 &&
        state.hydrated
      ) {
        const storedNow = mockKv.get(prefsKey);
        const expected = parseNotificationPrefs(storedNow ?? null);
        if (JSON.stringify(expected) !== JSON.stringify(state.prefs)) {
          violations.push(
            `memory-vs-stored: memory=${preview(state.prefs, 120)} stored=${preview(storedNow, 120)}`,
          );
        }
      }

      rows.push(
        makeRow(
          campaign,
          i,
          seed,
          `owner=${owner === OWNER ? 'uuid' : owner};stored=${stored?.category ?? 'absent'};pending=${pendingKind};db=${mockDb.fault};sched=${scheduler.fault}/${scheduler.permission}${expectedOwnerKey !== undefined ? ';expectedOwnerKey' : ''}`,
          { stored: stored?.text ?? null, pending, expectedOwnerKey },
          violations,
        ),
      );
    }
    const { unknown } = finish(campaign, rows);
    expect(violationSummary(unknown)).toBe('');
    expect(unknown).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Campaign 5: store.setPrefs with malformed patches (programmatic seam)

describe('stress: notificationStore.setPrefs', () => {
  const campaign = 'store.setPrefs';
  const ci = campaignIndex++;

  it('resolves, never pollutes, every persisted write re-parses to valid prefs (KD3 pinned)', async () => {
    const rows: StressRow[] = [];
    for (const i of iterationPlan(campaign)) {
      const seed = rowSeed(BASE, ci, i);
      const rng = new Rng(seed);
      mockKv.clear();
      mockDb.writes = [];
      resetStore();
      const owner = rng.pick([
        OWNER,
        OWNER,
        GUEST_DATA_OWNER,
        SIGNED_OUT_DATA_OWNER,
      ]);
      setActiveDataOwner(owner);
      const scheduler = new FaultScheduler();
      scheduler.permission = rng.pick<PermissionState>(['granted', 'denied']);
      mockDb.fault = rng.pick<DbFault>([
        'none',
        'none',
        'none',
        'write-throws',
      ]);
      const nowMs = realisticNow(rng);
      const context = validContext(rng);
      context['nowMs'] = nowMs;
      const deps = {
        scheduler,
        loadContext: async () => context as unknown as NotificationPlanContext,
      };
      const violations: string[] = [];
      try {
        await useNotificationStore.getState().hydrate(deps);
        if (rng.bool()) {
          await useNotificationStore
            .getState()
            .setPrefs({ enabled: true }, deps);
        }
        scheduler.appliedPlans = [];
        mockDb.writes = [];
      } catch (e) {
        violations.push(`setup rejection: ${String(e).slice(0, 120)}`);
      }
      const patch = weirdPrefsPatch(rng);
      const patchKeys = Object.keys(patch);
      try {
        await useNotificationStore
          .getState()
          .setPrefs(patch as Partial<Omit<NotificationPrefs, 'version'>>, deps);
      } catch (e) {
        violations.push(`rejection: ${String(e).slice(0, 120)}`);
      }
      const state = useNotificationStore.getState();
      violations.push(...protoPollutionViolations());
      if (owner === SIGNED_OUT_DATA_OWNER) {
        if (mockDb.writes.length > 0)
          violations.push('signed-out setPrefs wrote');
        if (scheduler.appliedPlans.length > 0)
          violations.push('signed-out setPrefs scheduled');
      }
      const prefsKey = notificationPrefsKeyForOwner(owner);
      for (const [key, value] of mockDb.writes) {
        if (key !== prefsKey)
          violations.push(`write to foreign key ${preview(key)}`);
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          violations.push('stored prefs not JSON');
        }
        if (parsed !== undefined) {
          const reparsed = parseNotificationPrefs(value);
          violations.push(...prefsShapeViolations(reparsed, 'reparsed'));
          if ((parsed as Record<string, unknown>)['version'] !== 1) {
            violations.push('stored version != 1');
          }
        }
      }
      // Memory-side shape: the store trusts its typed caller, so wrong-typed
      // fields DO land in memory (KD3); recorded, not asserted.
      violations.push(...prefsShapeViolations(state.prefs, 'memory'));
      for (const plan of scheduler.appliedPlans) {
        violations.push(
          ...planViolations(plan, state.prefs, nowMs, 'applied-plan'),
        );
        if (state.permission !== 'granted') {
          violations.push('applied-plan without granted permission');
        }
        if (state.prefs.enabled !== true) {
          violations.push(
            `scheduled-while-disabled enabled=${preview(state.prefs.enabled)}`,
          );
        }
      }
      rows.push(
        makeRow(
          campaign,
          i,
          seed,
          `owner=${owner === OWNER ? 'uuid' : owner};db=${mockDb.fault};perm=${scheduler.permission};keys=${patchKeys.join('|').slice(0, 60)}`,
          patch,
          violations,
        ),
      );
    }
    const { unknown } = finish(campaign, rows);
    expect(violationSummary(unknown)).toBe('');
    expect(unknown).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Campaign 6: screenTargetFromNotificationData (press-routing handler)

describe('stress: screenTargetFromNotificationData', () => {
  const campaign = 'service.screenTarget';
  const ci = campaignIndex++;

  it('never throws and only ever resolves Home/Performance from an own exact string', () => {
    const rows: StressRow[] = [];
    for (const i of iterationPlan(campaign)) {
      const seed = rowSeed(BASE, ci, i);
      const rng = new Rng(seed);
      const { category, data } = weirdNotificationData(rng);
      const violations: string[] = [];
      let result: unknown = 'unset';
      let trapped = false;
      try {
        result = screenTargetFromNotificationData(data);
      } catch (e) {
        // A getter/proxy that throws on read is a hostile caller, not
        // malformed data: the exception is the caller's own. Anything else
        // escaping a plain property read is a break.
        if (/getter trap|proxy trap/.test(String(e))) trapped = true;
        else violations.push(`throw: ${String(e).slice(0, 120)}`);
      }
      if (
        !trapped &&
        result !== null &&
        result !== 'Home' &&
        result !== 'Performance'
      ) {
        violations.push(`result ${preview(result)}`);
      }
      if (result === 'Home' || result === 'Performance') {
        let own: unknown;
        try {
          own =
            data && typeof data === 'object'
              ? (data as Record<string, unknown>)['screen']
              : undefined;
        } catch {
          own = undefined;
        }
        if (own !== result)
          violations.push(`resolved ${result} without exact own screen`);
      }
      const row = makeRow(campaign, i, seed, category, data, violations);
      if (trapped) row.note = 'hostile-caller-trap propagated (expected)';
      rows.push(row);
    }
    const { unknown } = finish(campaign, rows);
    expect(violationSummary(unknown)).toBe('');
    expect(unknown).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Campaign 7: the native adapter (NotifeeScheduler) over the notify-kit mock

const mocked = notifee as unknown as {
  requestPermission: jest.Mock;
  getNotificationSettings: jest.Mock;
  createTriggerNotification: jest.Mock;
  getTriggerNotificationIds: jest.Mock;
  cancelTriggerNotification: jest.Mock;
};

describe('stress: NotifeeScheduler adapter', () => {
  const campaign = 'service.adapter';
  const ci = campaignIndex++;

  afterEach(() => {
    mocked.getNotificationSettings.mockReset();
    mocked.getNotificationSettings.mockImplementation(async () => ({
      authorizationStatus: 1,
    }));
    mocked.getTriggerNotificationIds.mockReset();
    mocked.getTriggerNotificationIds.mockImplementation(async () => []);
    mocked.cancelTriggerNotification.mockClear();
    mocked.createTriggerNotification.mockClear();
  });

  it('maps any settings shape to a typed state and never cancels a foreign id', async () => {
    const scheduler = getScheduler();
    const rows: StressRow[] = [];
    for (const i of iterationPlan(campaign)) {
      const seed = rowSeed(BASE, ci, i);
      const rng = new Rng(seed);
      const violations: string[] = [];

      // (a) permission mapping over malformed settings
      const status = rng.pick<unknown>([
        -1,
        0,
        1,
        2,
        3,
        -2,
        NaN,
        Infinity,
        '1',
        '0',
        null,
        undefined,
        true,
        1.5,
        -0,
        {},
      ]);
      const settingsShape = rng.int(0, 3);
      mocked.getNotificationSettings.mockImplementation(async () => {
        if (settingsShape === 0) return { authorizationStatus: status };
        if (settingsShape === 1) return {};
        if (settingsShape === 2) return null;
        throw new Error('native settings unavailable');
      });
      let permission: unknown = 'unset';
      let permissionThrew = false;
      try {
        permission = await scheduler.permissionState();
      } catch {
        permissionThrew = true;
      }
      if (!permissionThrew) {
        if (
          permission !== 'granted' &&
          permission !== 'denied' &&
          permission !== 'undetermined'
        ) {
          violations.push(`permission ${preview(permission)}`);
        }
        if (settingsShape === 0 && status === 0 && permission !== 'denied') {
          violations.push('DENIED(0) not mapped to denied');
        }
        if (
          settingsShape === 0 &&
          status === -1 &&
          permission !== 'undetermined'
        ) {
          violations.push('NOT_DETERMINED(-1) not mapped to undetermined');
        }
        if (
          settingsShape === 0 &&
          (status === '0' ||
            status === null ||
            status === undefined ||
            Number.isNaN(status)) &&
          permission === 'granted'
        ) {
          // Non-numeric / missing status is not a grant. Recorded as an
          // observation; the store re-checks on every foreground.
          violations.push(
            `non-numeric status ${preview(status)} mapped to granted`,
          );
        }
      } else if (settingsShape !== 3 && settingsShape !== 2) {
        violations.push('permissionState threw for a resolved settings object');
      }
      // shape 2 (a null settings object, outside the library's declared
      // return type) rejects; the store's refreshPermission catches that and
      // records permission 'unknown' (store.hydrate campaign, 'permission-throws').

      // (b) prefix-only cancellation over hostile trigger ids
      const foreign = Array.from({ length: rng.int(0, 5) }, () =>
        weirdTriggerId(rng),
      );
      const owned = Array.from({ length: rng.int(0, 3) }, () =>
        rng.pick(PLANNED_NOTIFICATION_IDS),
      );
      const ids = [...foreign, ...owned];
      mocked.getTriggerNotificationIds.mockImplementation(async () => ids);
      mocked.cancelTriggerNotification.mockClear();
      try {
        await scheduler.cancelAllPlanned();
      } catch (e) {
        violations.push(
          `cancelAllPlanned rejection: ${String(e).slice(0, 120)}`,
        );
      }
      const cancelled = mocked.cancelTriggerNotification.mock.calls.map(c =>
        String(c[0]),
      );
      for (const id of cancelled) {
        if (!id.startsWith(NOTIFICATION_ID_PREFIX)) {
          violations.push(`cancelled foreign id ${preview(id)}`);
        }
      }
      for (const id of ids) {
        if (id.startsWith(NOTIFICATION_ID_PREFIX) && !cancelled.includes(id)) {
          violations.push(`owned id not cancelled ${preview(id)}`);
        }
      }

      // (c) applyPlan pass-through: exactly the plan ids, timestamps forwarded
      const prefs = parseNotificationPrefs(validPrefsJson(rng));
      const context = validContext(rng) as unknown as NotificationPlanContext;
      const plan = buildNotificationPlan(prefs, context);
      mocked.getTriggerNotificationIds.mockImplementation(async () => []);
      mocked.createTriggerNotification.mockClear();
      try {
        await scheduler.applyPlan(plan);
      } catch (e) {
        violations.push(`applyPlan rejection: ${String(e).slice(0, 120)}`);
      }
      const created = mocked.createTriggerNotification.mock.calls as [
        { id?: unknown; data?: unknown },
        { timestamp?: unknown; type?: unknown },
      ][];
      if (created.length !== plan.length) {
        violations.push(
          `created ${created.length} triggers for ${plan.length} items`,
        );
      }
      for (const [n, trigger] of created) {
        if (!String(n.id).startsWith(NOTIFICATION_ID_PREFIX)) {
          violations.push(`created foreign id ${preview(n.id)}`);
        }
        const screen = (n.data as Record<string, unknown> | undefined)?.[
          'screen'
        ];
        if (screen !== 'Home' && screen !== 'Performance') {
          violations.push(`created with screen ${preview(screen)}`);
        }
        if (
          typeof trigger.timestamp !== 'number' ||
          !Number.isFinite(trigger.timestamp) ||
          trigger.timestamp < context.nowMs + 90_000
        ) {
          violations.push(
            `created with timestamp ${preview(trigger.timestamp)}`,
          );
        }
      }

      rows.push(
        makeRow(
          campaign,
          i,
          seed,
          `settings=${settingsShape}:${preview(status)};foreign=${foreign.length};plan=${plan.length}`,
          { status, ids },
          violations,
        ),
      );
    }
    const { unknown } = finish(campaign, rows);
    expect(violationSummary(unknown)).toBe('');
    expect(unknown).toHaveLength(0);
    expect(Platform.OS).toBe('ios');
  });
});

// ---------------------------------------------------------------------------
// Campaign 8: useNotificationBootstrap with malformed owner keys / AppState

describe('stress: useNotificationBootstrap', () => {
  const campaign = 'hook.bootstrap';
  const ci = campaignIndex++;

  function Host({ ownerKey }: { ownerKey: string | null }) {
    useNotificationBootstrap(ownerKey);
    return null;
  }

  it('ignores owner keys that are not the active owner and non-active AppState values', async () => {
    const rows: StressRow[] = [];
    let appStateHandler: ((state: string) => void) | null = null;
    let removed = 0;
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event, handler) => {
        appStateHandler = handler as (state: string) => void;
        return { remove: () => (removed += 1) } as ReturnType<
          typeof AppState.addEventListener
        >;
      });
    mocked.getTriggerNotificationIds.mockImplementation(async () => []);
    mocked.getNotificationSettings.mockImplementation(async () => ({
      authorizationStatus: 1,
    }));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      for (const i of iterationPlan(campaign)) {
        const seed = rowSeed(BASE, ci, i);
        const rng = new Rng(seed);
        mockKv.clear();
        mockDb.writes = [];
        resetStore();
        mocked.getNotificationSettings.mockClear();
        mocked.createTriggerNotification.mockClear();
        mocked.cancelTriggerNotification.mockClear();
        appStateHandler = null;
        const removedBefore = removed;
        unhandled.length = 0;

        const active = rng.pick([
          OWNER,
          GUEST_DATA_OWNER,
          SIGNED_OUT_DATA_OWNER,
        ]);
        setActiveDataOwner(active);
        const hookOwner: string | null = rng.chance(0.1)
          ? null
          : rng.chance(0.15)
            ? active
            : weirdOwnerKey(rng);
        const matches = hookOwner === active;
        const states = Array.from({ length: rng.int(0, 4) }, () =>
          weirdAppState(rng),
        );
        const violations: string[] = [];

        let renderer: TestRenderer.ReactTestRenderer | null = null;
        try {
          await act(async () => {
            renderer = TestRenderer.create(
              createElement(Host, { ownerKey: hookOwner }),
            );
          });
          await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 0));
          });
          for (const s of states) {
            await act(async () => {
              appStateHandler?.(s as string);
              await new Promise(resolve => setTimeout(resolve, 0));
            });
          }
          await act(async () => {
            renderer?.unmount();
          });
        } catch (e) {
          violations.push(`render/act throw: ${String(e).slice(0, 120)}`);
        }
        await new Promise(resolve => setTimeout(resolve, 0));

        const state = useNotificationStore.getState();
        if (unhandled.length > 0) {
          violations.push(`unhandled rejection ${preview(unhandled[0])}`);
        }
        if (appStateHandler === null)
          violations.push('AppState listener not installed');
        if (removed !== removedBefore + 1)
          violations.push(`listener removed ${removed - removedBefore}x`);
        if (!matches) {
          if (state.hydrated)
            violations.push(
              `hydrated for foreign ownerKey ${preview(hookOwner)}`,
            );
          if (mockDb.writes.length > 0)
            violations.push('kv write for foreign ownerKey');
        } else if (!state.hydrated) {
          violations.push('active owner not hydrated');
        }
        if (mocked.createTriggerNotification.mock.calls.length > 0) {
          violations.push('scheduled while never enabled');
        }
        const activeCount = states.filter(s => s === 'active').length;
        const settingsCalls = mocked.getNotificationSettings.mock.calls.length;
        const hydrateChecks =
          matches && active !== SIGNED_OUT_DATA_OWNER ? 1 : 0;
        if (settingsCalls !== activeCount + hydrateChecks) {
          violations.push(
            `permission re-read ${settingsCalls}x for ${activeCount} 'active' events (+${hydrateChecks} hydrate)`,
          );
        }
        violations.push(...prefsShapeViolations(state.prefs, 'memory'));
        violations.push(...protoPollutionViolations());
        rows.push(
          makeRow(
            campaign,
            i,
            seed,
            `active=${active === OWNER ? 'uuid' : active};match=${matches};events=${states.length}`,
            { hookOwner, states },
            violations,
          ),
        );
      }
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    const { unknown } = finish(campaign, rows);
    expect(violationSummary(unknown)).toBe('');
    expect(unknown).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Aggregate table

afterAll(() => {
  const file = writeTable('_all', allRows);
  console.info(
    `[stress:mod-notifications] rows=${allRows.length} broken=${allRows.filter(r => r.outcome === 'broken').length} unknownBroken=${unknownBroken.length} table=${file}`,
  );
});

// ---------------------------------------------------------------------------
// Deterministic pins for the known defects recorded above. Each is
// `it.failing`: it PASSES while the defect exists and FAILS once production
// code fixes it — flip to `it` at that point.

describe('known-defect pins (flip to `it` once fixed)', () => {
  const nowMs = new Date(2026, 7, 25, 10, 0, 0).getTime();
  const enabledPrefs: NotificationPrefs = {
    ...DEFAULT_NOTIFICATION_PREFS,
    enabled: true,
  };

  it.failing(
    'KD1: buildNotificationPlan rejects/clamps a non-finite nowMs instead of emitting NaN timestamps',
    () => {
      const plan = buildNotificationPlan(enabledPrefs, {
        nowMs: NaN,
        streakDays: 0,
        practicedToday: false,
        hasAnyHistory: true,
      });
      expect(plan.every(p => Number.isFinite(p.timestampMs))).toBe(true);
    },
  );

  it.failing(
    'KD1b: buildNotificationPlan tolerates NaN practiceReminderMinutes without a NaN timestamp',
    () => {
      const plan = buildNotificationPlan(
        { ...enabledPrefs, practiceReminderMinutes: NaN },
        { nowMs, streakDays: 0, practicedToday: false, hasAnyHistory: false },
      );
      const practice = plan.find(p => p.id === 'ps.reminder.practice');
      expect(practice && Number.isFinite(practice.timestampMs)).toBe(true);
    },
  );

  it.failing(
    'KD3: setPrefs validates the patch at runtime (NaN minutes never reach the scheduler)',
    async () => {
      setActiveDataOwner(OWNER);
      const scheduler = new FaultScheduler();
      scheduler.permission = 'granted';
      const deps = {
        scheduler,
        loadContext: async (): Promise<NotificationPlanContext> => ({
          nowMs,
          streakDays: 0,
          practicedToday: false,
          hasAnyHistory: false,
        }),
      };
      await useNotificationStore.getState().hydrate(deps);
      await useNotificationStore.getState().setPrefs({ enabled: true }, deps);
      await useNotificationStore
        .getState()
        .setPrefs({ practiceReminderMinutes: NaN }, deps);
      const last = scheduler.appliedPlans.at(-1) ?? [];
      expect(last.every(p => Number.isFinite(p.timestampMs))).toBe(true);
      expect(
        useNotificationStore.getState().prefs.practiceReminderMinutes,
      ).toBe(DEFAULT_NOTIFICATION_PREFS.practiceReminderMinutes);
    },
  );

  it.failing(
    'KD5: NotifeeScheduler.permissionState does not report granted for a settings object without a numeric authorizationStatus',
    async () => {
      mocked.getNotificationSettings.mockImplementation(async () => ({}));
      const state = await getScheduler().permissionState();
      mocked.getNotificationSettings.mockImplementation(async () => ({
        authorizationStatus: 1,
      }));
      expect(state).not.toBe('granted');
    },
  );

  it.failing(
    'KD4: hydrate keeps the persisted onboarding choice when only clearing the pending marker fails',
    async () => {
      setActiveDataOwner(OWNER);
      mockKv.set(
        PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
        JSON.stringify({ version: 1, enabled: true }),
      );
      mockDb.fault = 'write-pending-throws';
      const scheduler = new FaultScheduler();
      scheduler.permission = 'granted';
      await useNotificationStore.getState().hydrate({
        scheduler,
        loadContext: async () => ({
          nowMs,
          streakDays: 0,
          practicedToday: false,
          hasAnyHistory: false,
        }),
      });
      const stored = parseNotificationPrefs(
        mockKv.get(notificationPrefsKeyForOwner(OWNER)) ?? null,
      );
      expect(stored.enabled).toBe(true);
      expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    },
  );
});
