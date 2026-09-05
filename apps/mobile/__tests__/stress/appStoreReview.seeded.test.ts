import { NativeModules } from 'react-native';
import {
  Rng,
  drawLength,
  invariant,
  runCampaign,
  type SequenceRun,
  type StepTrace,
} from '../../test-support/stress/reviewSeeded';

/**
 * SEEDED RANDOMIZED LONG-RUN — review/appStoreReview.
 *
 * One sequence = a seeded device (durable kv record, StoreKit module present
 * or not, prompt result, kv health) plus 5..60 actions the app can perform:
 * scored analyses (single and concurrent bursts), the Settings rate row with
 * every dependency outcome, explicit review completion, kv corruption,
 * fresh installs, and platform/module changes. After every step the durable
 * record is re-parsed by an INDEPENDENT reference parser and compared with
 * the module's, and the prompt/open call counts and their ordering are
 * checked against the documented policy: ask on every scored analysis until
 * reviewed, persist before prompting, serialize prompts, never throw.
 *
 * Replay any seed: STRESS_SEED=<seed> STRESS_ITER=1 npx jest --ci <this file>.
 */

jest.setTimeout(20 * 60 * 1000);

const mockKvTable = new Map<string, string>();
let mockKvBroken = false;
/** Ordered log of durable writes and prompt asks (serialization evidence). */
const eventLog: string[] = [];

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (mockKvBroken) throw new Error('kv unavailable');
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvTable.set(String(params[0]), String(params[1]));
        eventLog.push(`save:${String(params[1])}`);
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

import {
  REVIEW_PROMPT_KV_KEY,
  markStoreReviewCompleted,
  parseReviewPromptState,
  rateAppFromSettings,
  reportScoredAnalysisForReview,
  requestNativeReviewPrompt,
  shouldRequestReview,
} from '../../src/review/appStoreReview';

type PromptMode = 'true' | 'false' | 'throws' | 'truthy' | 'falsy';
let promptMode: PromptMode = 'true';
let promptCalls = 0;

function installNative(): void {
  (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview = {
    requestReview: async () => {
      promptCalls += 1;
      eventLog.push('prompt');
      switch (promptMode) {
        case 'true':
          return true;
        case 'false':
          return false;
        case 'truthy':
          return 1 as unknown as boolean;
        case 'falsy':
          return '' as unknown as boolean;
        default:
          throw new Error('SKStoreReviewController unavailable');
      }
    },
  };
}

function removeNative(mode: 'delete' | 'no-method'): void {
  const modules = NativeModules as { PickleStoreReview?: unknown };
  if (mode === 'delete') delete modules.PickleStoreReview;
  else modules.PickleStoreReview = { version: 1 };
}

function nativeInstalled(): boolean {
  const native = (
    NativeModules as { PickleStoreReview?: { requestReview?: unknown } }
  ).PickleStoreReview;
  return typeof native?.requestReview === 'function';
}

afterAll(() => {
  delete (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview;
});

// ─── Independent reference parser (the documented durable-record rules) ─────

interface RefState {
  scored: number;
  prompted: number;
  lastPrompted: boolean;
  reviewed: boolean;
}

function refParse(raw: string | null): RefState {
  const empty: RefState = {
    scored: 0,
    prompted: 0,
    lastPrompted: false,
    reviewed: false,
  };
  if (raw === null || raw === '') return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return empty;
  const record = parsed as Record<string, unknown>;
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : 0;
  const present = (value: unknown) =>
    typeof value === 'string' && value.length > 0;
  return {
    scored: count(record.scoredAnalyses),
    prompted: count(record.promptedCount),
    lastPrompted: present(record.lastPromptedAtIso),
    reviewed: present(record.reviewedAtIso),
  };
}

function currentRaw(): string | null {
  return mockKvTable.get(REVIEW_PROMPT_KV_KEY) ?? null;
}

function checkParse(step: number): RefState {
  const raw = currentRaw();
  const module = parseReviewPromptState(raw);
  const ref = refParse(raw);
  invariant(
    module.version === 1 &&
      module.scoredAnalyses === ref.scored &&
      module.promptedCount === ref.prompted &&
      (module.lastPromptedAtIso !== null) === ref.lastPrompted &&
      (module.reviewedAtIso !== null) === ref.reviewed,
    'parse-matches-reference',
    step,
    () =>
      `parse(${JSON.stringify(raw)}) = ${JSON.stringify(module)} ≠ ${JSON.stringify(ref)}`,
  );
  invariant(
    Number.isInteger(module.scoredAnalyses) &&
      module.scoredAnalyses >= 0 &&
      Number.isInteger(module.promptedCount) &&
      module.promptedCount >= 0,
    'counts-nonnegative-integers',
    step,
    () => `counts ${module.scoredAnalyses}/${module.promptedCount}`,
  );
  invariant(
    shouldRequestReview(module) === !ref.reviewed,
    'ask-until-reviewed',
    step,
    () =>
      `shouldRequestReview=${shouldRequestReview(module)} with reviewed=${ref.reviewed}`,
  );
  return ref;
}

const GARBAGE = [
  'not-json',
  '[]',
  '[1,2]',
  'null',
  '"string"',
  '42',
  '{}',
  '{"version":9}',
  '{"scoredAnalyses":-3,"promptedCount":2.7,"reviewedAtIso":""}',
  '{"scoredAnalyses":"5","promptedCount":null,"reviewedAtIso":5}',
  '{"scoredAnalyses":1e308,"promptedCount":3,"lastPromptedAtIso":"x"}',
  '{"scoredAnalyses":NaN}',
  '{"reviewedAtIso":"2026-08-30T01:00:00.000Z"}',
  '{"reviewedAtIso":" "}',
  '{"scoredAnalyses":2,"promptedCount":9,"lastPromptedAtIso":"","reviewedAtIso":null}',
];

// ─── One sequence ───────────────────────────────────────────────────────────

type Action =
  | 'report'
  | 'reportBurst'
  | 'markCompleted'
  | 'rateSettings'
  | 'promptDirect'
  | 'toggleKv'
  | 'toggleNative'
  | 'promptMode'
  | 'corruptKv'
  | 'freshInstall'
  | 'signOut';

const ACTIONS: ReadonlyArray<[Action, number]> = [
  ['report', 26],
  ['reportBurst', 10],
  ['markCompleted', 6],
  ['rateSettings', 14],
  ['promptDirect', 6],
  ['toggleKv', 6],
  ['toggleNative', 6],
  ['promptMode', 6],
  ['corruptKv', 8],
  ['freshInstall', 4],
  ['signOut', 8],
];

function drawAction(rng: Rng): Action {
  const total = ACTIONS.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng.float(0, total);
  for (const [action, weight] of ACTIONS) {
    roll -= weight;
    if (roll < 0) return action;
  }
  return 'report';
}

async function never<T>(
  label: string,
  step: number,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(
      `[never-rejects] step ${step}: ${label} rejected: ${String(error)}`,
    );
  }
}

async function runSequence(
  seed: number,
  stepLimit?: number,
): Promise<SequenceRun> {
  const rng = new Rng(seed);
  const length = drawLength(rng);
  const steps = Math.min(length, stepLimit ?? length);

  // Seeded device.
  mockKvTable.clear();
  eventLog.length = 0;
  promptCalls = 0;
  mockKvBroken = rng.chance(0.1);
  promptMode = rng.pick(['true', 'false', 'throws', 'truthy', 'falsy']);
  if (rng.chance(0.85)) installNative();
  else removeNative(rng.pick(['delete', 'no-method']));
  if (rng.chance(0.4)) {
    mockKvTable.set(
      REVIEW_PROMPT_KV_KEY,
      rng.chance(0.6)
        ? JSON.stringify({
            version: 1,
            scoredAnalyses: rng.int(0, 12),
            promptedCount: rng.int(0, 12),
            lastPromptedAtIso: rng.chance(0.5)
              ? '2026-08-30T00:00:00.000Z'
              : null,
            reviewedAtIso: rng.chance(0.3) ? '2026-08-30T01:00:00.000Z' : null,
          })
        : rng.pick(GARBAGE),
    );
  }

  const trace: StepTrace[] = [];
  const tallies: Record<string, number> = {};
  const tally = (key: string, by = 1) => {
    tallies[key] = (tallies[key] ?? 0) + by;
  };

  /** Expected effect of one scored report given the device right now. */
  const expectReport = (
    before: RefState,
  ): { prompts: number; after: RefState } => {
    if (!nativeInstalled() || mockKvBroken || before.reviewed)
      return { prompts: 0, after: before };
    return {
      prompts: 1,
      after: {
        ...before,
        scored: before.scored + 1,
        prompted: before.prompted + 1,
        lastPrompted: true,
      },
    };
  };

  let state = checkParse(0);

  for (let step = 1; step <= steps; step += 1) {
    const action = drawAction(rng);
    const entry: StepTrace = { step, action };
    const promptsBefore = promptCalls;
    switch (action) {
      case 'report': {
        const expected = expectReport(state);
        await never('reportScoredAnalysisForReview', step, () =>
          reportScoredAnalysisForReview({ delayMs: rng.pick([0, 0, 1]) }),
        );
        invariant(
          promptCalls - promptsBefore === expected.prompts,
          'prompt-per-scored-analysis',
          step,
          () =>
            `${promptCalls - promptsBefore} prompts (expected ${expected.prompts}; native=${nativeInstalled()} kvBroken=${mockKvBroken} reviewed=${state.reviewed})`,
        );
        const after = checkParse(step);
        invariant(
          JSON.stringify(after) === JSON.stringify(expected.after),
          'record-advances-only-when-asked',
          step,
          () =>
            `record ${JSON.stringify(after)} ≠ ${JSON.stringify(expected.after)}`,
        );
        if (expected.prompts === 1) {
          const saveIndex = eventLog.lastIndexOf('prompt') - 1;
          invariant(
            saveIndex >= 0 && (eventLog[saveIndex] ?? '').startsWith('save:'),
            'persist-before-prompt',
            step,
            () => `event tail ${eventLog.slice(-3).join(' | ')}`,
          );
        }
        tally(expected.prompts === 1 ? 'asks' : 'silentReports');
        entry.prompts = promptCalls - promptsBefore;
        break;
      }
      case 'reportBurst': {
        const count = rng.int(2, 6);
        let expected = state;
        let prompts = 0;
        for (let index = 0; index < count; index += 1) {
          const next = expectReport(expected);
          prompts += next.prompts;
          expected = next.after;
        }
        const logStart = eventLog.length;
        await never('concurrent reportScoredAnalysisForReview', step, () =>
          Promise.all(
            Array.from({ length: count }, () =>
              reportScoredAnalysisForReview({ delayMs: rng.pick([0, 1, 2]) }),
            ),
          ),
        );
        invariant(
          promptCalls - promptsBefore === prompts,
          'prompt-per-scored-analysis',
          step,
          () =>
            `burst of ${count}: ${promptCalls - promptsBefore} prompts (expected ${prompts})`,
        );
        const after = checkParse(step);
        invariant(
          JSON.stringify(after) === JSON.stringify(expected),
          'record-advances-only-when-asked',
          step,
          () =>
            `burst record ${JSON.stringify(after)} ≠ ${JSON.stringify(expected)}`,
        );
        // Serialized: every prompt is immediately preceded by its own save.
        const events = eventLog
          .slice(logStart)
          .map(event => (event.startsWith('save:') ? 'S' : 'P'))
          .join('');
        invariant(
          events === 'SP'.repeat(prompts),
          'prompts-serialized',
          step,
          () =>
            `burst event order ${events} (expected ${'SP'.repeat(prompts)})`,
        );
        tally('burstReports', count);
        entry.count = count;
        entry.prompts = prompts;
        break;
      }
      case 'markCompleted': {
        const rawBefore = currentRaw();
        await never('markStoreReviewCompleted', step, () =>
          markStoreReviewCompleted(),
        );
        const after = checkParse(step);
        const expected: RefState = mockKvBroken
          ? state
          : { ...state, reviewed: true };
        invariant(
          JSON.stringify(after) === JSON.stringify(expected),
          'completion-durable',
          step,
          () =>
            `after markStoreReviewCompleted ${JSON.stringify(after)} ≠ ${JSON.stringify(expected)}`,
        );
        invariant(
          promptCalls === promptsBefore,
          'completion-never-prompts',
          step,
          () => 'markStoreReviewCompleted asked StoreKit',
        );
        if (state.reviewed || mockKvBroken) {
          invariant(
            currentRaw() === rawBefore,
            'completion-idempotent',
            step,
            () =>
              `already-reviewed/broken record rewritten: ${rawBefore} → ${currentRaw()}`,
          );
        }
        tally(mockKvBroken ? 'completionsSkipped' : 'completions');
        break;
      }
      case 'rateSettings': {
        const url = rng.pick([
          null,
          '',
          'https://apps.apple.com/app/id6806918402?action=write-review',
          'itms-apps://x',
        ]);
        const openFails = rng.chance(0.35);
        let opens = 0;
        const rawBefore = currentRaw();
        const outcome = await never('rateAppFromSettings', step, () =>
          rateAppFromSettings({
            writeReviewUrl: url,
            openUrl: async target => {
              opens += 1;
              invariant(
                target === url,
                'opens-configured-url',
                step,
                () => `opened ${target}`,
              );
              if (openFails) throw new Error('LSApplicationQueriesSchemes');
              return true;
            },
          }),
        );
        const storePage = Boolean(url) && !openFails;
        const nativeOk =
          nativeInstalled() &&
          (promptMode === 'true' || promptMode === 'truthy');
        const expectedOutcome = storePage
          ? 'store_page'
          : nativeOk
            ? 'native_prompt'
            : 'unavailable';
        invariant(
          outcome === expectedOutcome,
          'settings-rate-fallback',
          step,
          () =>
            `rateAppFromSettings → ${outcome} (expected ${expectedOutcome}; url=${JSON.stringify(url)} openFails=${openFails} native=${nativeInstalled()} mode=${promptMode})`,
        );
        invariant(
          opens === (url ? 1 : 0),
          'opens-store-once',
          step,
          () => `${opens} openUrl calls for url ${JSON.stringify(url)}`,
        );
        invariant(
          promptCalls - promptsBefore ===
            (storePage ? 0 : nativeInstalled() ? 1 : 0),
          'settings-native-fallback-count',
          step,
          () => `${promptCalls - promptsBefore} prompts for outcome ${outcome}`,
        );
        const after = checkParse(step);
        const expectedState: RefState =
          storePage && !mockKvBroken ? { ...state, reviewed: true } : state;
        invariant(
          JSON.stringify(after) === JSON.stringify(expectedState),
          'store-page-marks-reviewed',
          step,
          () =>
            `after ${outcome}: ${JSON.stringify(after)} ≠ ${JSON.stringify(expectedState)} (kvBroken=${mockKvBroken})`,
        );
        if (!storePage) {
          invariant(
            currentRaw() === rawBefore,
            'native-prompt-never-marks-reviewed',
            step,
            () =>
              `native fallback changed the record: ${rawBefore} → ${currentRaw()}`,
          );
        }
        tally(`settings:${outcome}`);
        entry.outcome = outcome;
        break;
      }
      case 'promptDirect': {
        const rawBefore = currentRaw();
        const handed = await never('requestNativeReviewPrompt', step, () =>
          requestNativeReviewPrompt(),
        );
        const expected =
          nativeInstalled() &&
          (promptMode === 'true' || promptMode === 'truthy');
        invariant(
          handed === expected,
          'prompt-result-boolean',
          step,
          () =>
            `requestNativeReviewPrompt → ${String(handed)} (native=${nativeInstalled()} mode=${promptMode})`,
        );
        invariant(
          currentRaw() === rawBefore,
          'direct-prompt-stateless',
          step,
          () => 'requestNativeReviewPrompt touched the record',
        );
        entry.handed = handed;
        break;
      }
      case 'toggleKv':
        mockKvBroken = !mockKvBroken;
        entry.kvBroken = mockKvBroken;
        break;
      case 'toggleNative':
        if (nativeInstalled()) removeNative(rng.pick(['delete', 'no-method']));
        else installNative();
        entry.native = nativeInstalled();
        break;
      case 'promptMode':
        promptMode = rng.pick(['true', 'false', 'throws', 'truthy', 'falsy']);
        entry.mode = promptMode;
        break;
      case 'corruptKv': {
        const garbage = rng.pick(GARBAGE);
        mockKvTable.set(REVIEW_PROMPT_KV_KEY, garbage);
        entry.garbage = garbage;
        break;
      }
      case 'freshInstall':
        mockKvTable.clear();
        break;
      case 'signOut': {
        // Account sign-out / deletion clears account-scoped data only; the
        // review record is device-level and must be untouched by anything the
        // module exposes. Simulate by clearing every OTHER kv key.
        for (const key of [...mockKvTable.keys()]) {
          if (key !== REVIEW_PROMPT_KV_KEY) mockKvTable.delete(key);
        }
        mockKvTable.set(`account.${rng.int(0, 9)}`, 'x');
        const before = JSON.stringify(state);
        const after = checkParse(step);
        invariant(
          JSON.stringify(after) === before,
          'device-level-record',
          step,
          () => 'sign-out changed the review record',
        );
        break;
      }
      default:
        break;
    }
    state = checkParse(step);
    entry.state = state;
    entry.promptCalls = promptCalls;
    trace.push(entry);
  }
  tallies.steps = trace.length;
  return { trace, length, tallies };
}

describe('seeded randomized long-run: App Store review prompting policy', () => {
  it('asks on every scored analysis until reviewed, persists first, never throws, deterministically', async () => {
    const result = await runCampaign({
      name: 'appStoreReview.seeded',
      run: runSequence,
    });
    expect(result.executed).toBe(result.requested);
    expect(result.lengthMin).toBeGreaterThanOrEqual(5);
    expect(result.lengthMax).toBeLessThanOrEqual(60);
    expect(result.determinismMismatches).toBe(0);
    expect(result.failures).toEqual([]);
  });
});
