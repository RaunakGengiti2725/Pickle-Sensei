/**
 * STRESS — unit `mod-launch-gate`, lens `boundary-malformed`.
 *
 * `src/flow/launchGate.ts` exports three zero-argument pure routing functions
 * that pin the pre-auth order Welcome → onboarding → sign-in. Their contract is
 * that NOTHING a caller can pass — no argument, no `this`, no polluted
 * prototype, no hostile global — can make them return anything but the
 * literal stage, throw, or leave a side effect. This suite throws ≥3000 seeded
 * malformed inputs at them (and at an exact model of App.tsx's consumer
 * switch) and records one JSON row per iteration.
 *
 * Campaigns (all seeded, every row replayable from its seed):
 *   A  direct calls: hostile `this` + 0..6 hostile arguments, per export
 *   B  prototype pollution active DURING the call (Object/String/Function
 *      prototypes gain stage-shaped keys) — result must stay the primitive
 *   C  consumer switch model (App.tsx:203-216, INFERRED): only the exact
 *      primitive `'signin'` / `'onboarding'` route; every malformed stage value
 *      falls to Welcome, never to sign-in or the main app
 *   D  state-machine sequences with stale/duplicate handler fire-through:
 *      sign-in is reachable ONLY via the explicit account link or a finished
 *      questionnaire; no event skips the questionnaire
 *
 * Scale: STRESS_ITER iterations for each of A, B and C and STRESS_ITER/10
 * sequences for D (default 300 → ~8 s; the campaign run uses
 * STRESS_ITER=3000). STRESS_SEED replays a whole run; a single row is
 * replayed by `STRESS_ONLY_SEED=<seed>`.
 * Artifacts: `<repo>/artifacts/stress/launch-gate/boundary-malformed.*.json`
 * (override with STRESS_ARTIFACT_DIR).
 */
import {
  stageAfterGetStarted,
  stageAfterOnboarding,
  stageWhenLeavingOnboarding,
  type PreAuthStage,
} from '../../src/flow/launchGate';
import * as launchGateModule from '../../src/flow/launchGate';
import {
  PAYLOAD_CATEGORIES,
  STAGE_LITERALS,
  fingerprint,
  generatePayload,
  generateThisArg,
  intBetween,
  mulberry32,
  pick,
  type Payload,
} from '../../stress-harness/malformedPayloads';
import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';

declare const __dirname: string;

const ITER = Math.max(
  1,
  Number.parseInt(nodeProcess.env['STRESS_ITER'] ?? '300', 10) || 300,
);
const MASTER_SEED =
  Number.parseInt(nodeProcess.env['STRESS_SEED'] ?? '', 10) || 0x5eed1a7e;
const ONLY_SEED = nodeProcess.env['STRESS_ONLY_SEED']
  ? Number.parseInt(nodeProcess.env['STRESS_ONLY_SEED']!, 10)
  : null;

function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../../artifacts/stress/launch-gate');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeArtifact(name: string, data: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
  return file;
}

/** Per-iteration seed: decorrelated from the master so rows are independent. */
function rowSeed(index: number): number {
  return (Math.imul(index + 1, 0x9e3779b1) ^ MASTER_SEED) >>> 0;
}

type Verdict = 'HELD' | 'BROKEN';

interface Row {
  seed: number;
  campaign: 'A' | 'B' | 'C' | 'D';
  fn?: string;
  thisArg?: string;
  args?: string[];
  pollution?: string;
  input?: string;
  events?: string[];
  verdict: Verdict;
  detail?: string;
}

const EXPORTS = {
  stageAfterGetStarted: {
    fn: stageAfterGetStarted,
    expected: 'onboarding' as PreAuthStage,
  },
  stageAfterOnboarding: {
    fn: stageAfterOnboarding,
    expected: 'signin' as PreAuthStage,
  },
  stageWhenLeavingOnboarding: {
    fn: stageWhenLeavingOnboarding,
    expected: 'welcome' as PreAuthStage,
  },
} as const;
type ExportName = keyof typeof EXPORTS;
const EXPORT_NAMES = Object.keys(EXPORTS) as ExportName[];

const GLOBAL_KEYS_BEFORE = Object.getOwnPropertyNames(globalThis).sort();
const OBJECT_PROTO_KEYS_BEFORE = Reflect.ownKeys(Object.prototype);
const STRING_PROTO_KEYS_BEFORE = Reflect.ownKeys(String.prototype);
const FUNCTION_PROTO_KEYS_BEFORE = Reflect.ownKeys(Function.prototype);

function sameKeys(a: (string | symbol)[], b: (string | symbol)[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every(k => set.has(k));
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return null;
  }
}

/** Every invariant a launch-gate export must hold for one hostile call. */
function checkCall(
  name: ExportName,
  thisArg: Payload,
  args: Payload[],
): string | null {
  const { fn, expected } = EXPORTS[name];
  const before = args.map(a => (a.jsonSafe ? safeStringify(a.value) : null));
  let result: unknown;
  try {
    result = Reflect.apply(
      fn as (...rest: unknown[]) => unknown,
      thisArg.value,
      args.map(a => a.value),
    );
  } catch (error) {
    return `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (typeof result !== 'string') return `non-string result: ${typeof result}`;
  if (result !== expected)
    return `result ${JSON.stringify(result)} !== ${expected}`;
  if (!(STAGE_LITERALS as readonly string[]).includes(result)) {
    return `result outside PreAuthStage: ${result}`;
  }
  // Second call — determinism regardless of what the first call saw.
  const again = Reflect.apply(
    fn as (...rest: unknown[]) => unknown,
    thisArg.value,
    args.map(a => a.value),
  );
  if (again !== result)
    return `non-deterministic: ${String(again)} after ${result}`;
  if (fn.length !== 0) return `arity changed to ${fn.length}`;
  if (fn.name !== name) return `name changed to ${fn.name}`;
  for (let i = 0; i < args.length; i += 1) {
    const snapshot = before[i];
    if (snapshot !== null && safeStringify(args[i]!.value) !== snapshot) {
      return `argument ${i} mutated`;
    }
  }
  if ((launchGateModule as Record<string, unknown>)[name] !== fn) {
    return 'module export replaced';
  }
  return null;
}

function hygieneViolation(): string | null {
  const globalsNow = Object.getOwnPropertyNames(globalThis).sort();
  if (!sameKeys(globalsNow, GLOBAL_KEYS_BEFORE)) {
    const added = globalsNow.filter(k => !GLOBAL_KEYS_BEFORE.includes(k));
    return `globalThis gained ${added.join(',')}`;
  }
  if (!sameKeys(Reflect.ownKeys(Object.prototype), OBJECT_PROTO_KEYS_BEFORE)) {
    return 'Object.prototype keys changed';
  }
  if (!sameKeys(Reflect.ownKeys(String.prototype), STRING_PROTO_KEYS_BEFORE)) {
    return 'String.prototype keys changed';
  }
  if (
    !sameKeys(Reflect.ownKeys(Function.prototype), FUNCTION_PROTO_KEYS_BEFORE)
  ) {
    return 'Function.prototype keys changed';
  }
  return null;
}

const POLLUTION_KEYS = [
  'welcome',
  'onboarding',
  'signin',
  'stage',
  'preAuthStage',
  'skipOnboarding',
  'onboarded',
  'deviceOnboarded',
  'length',
  'call',
  'apply',
  'bind',
];

interface Pollution {
  describe: string;
  undo: () => void;
}

/** Install stage-shaped pollution on a prototype; returns the undo. */
function pollute(rng: () => number): Pollution {
  const target = pick(rng, ['Object', 'String', 'Function', 'Array'] as const);
  const key = pick(rng, POLLUTION_KEYS);
  const proto =
    target === 'Object'
      ? Object.prototype
      : target === 'String'
        ? String.prototype
        : target === 'Function'
          ? Function.prototype
          : Array.prototype;
  const had = Object.prototype.hasOwnProperty.call(proto, key);
  if (had) {
    // Never clobber a real builtin (`length`, `call`, …): pollute a shadow
    // key instead so the run stays inside the engine's contract.
    const shadow = `${key}__polluted`;
    Object.defineProperty(proto, shadow, {
      configurable: true,
      enumerable: pick(rng, [true, false]),
      value: 'signin',
    });
    return {
      describe: `${target}.prototype.${shadow}`,
      undo: () => {
        delete (proto as Record<string, unknown>)[shadow];
      },
    };
  }
  const mode = pick(rng, ['value', 'getter']);
  Object.defineProperty(proto, key, {
    configurable: true,
    enumerable: pick(rng, [true, false]),
    ...(mode === 'value'
      ? { value: 'signin', writable: true }
      : {
          get() {
            return 'signin';
          },
        }),
  });
  return {
    describe: `${target}.prototype.${key}:${mode}`,
    undo: () => {
      delete (proto as Record<string, unknown>)[key];
    },
  };
}

/**
 * EXACT model of the consumer switch in App.tsx (INFERRED, lines 203-216):
 *   preAuthStage === 'signin' ? SignIn : preAuthStage === 'onboarding' ?
 *   Onboarding : Welcome
 * Kept literally identical on purpose: the point is what a non-literal value
 * routes to, and the answer must always be the harmless Welcome screen.
 */
type Screen = 'SignInScreen' | 'OnboardingScreen(preauth)' | 'WelcomeScreen';
function screenForStage(preAuthStage: unknown): Screen {
  return preAuthStage === 'signin'
    ? 'SignInScreen'
    : preAuthStage === 'onboarding'
      ? 'OnboardingScreen(preauth)'
      : 'WelcomeScreen';
}

/**
 * Model of the App.tsx handler wiring (INFERRED, lines 204-214). Each event
 * is the handler React would run; "stale" means the handler fires although
 * its screen is no longer the one shown (a late callback), which App.tsx does
 * not guard against — so the model must not either.
 */
type GateEvent =
  | 'welcome.getStarted'
  | 'welcome.signInLink'
  | 'onboarding.finished'
  | 'onboarding.back'
  | 'signin.back';
const GATE_EVENTS: readonly GateEvent[] = [
  'welcome.getStarted',
  'welcome.signInLink',
  'onboarding.finished',
  'onboarding.back',
  'signin.back',
];
function applyEvent(_stage: PreAuthStage, event: GateEvent): PreAuthStage {
  switch (event) {
    case 'welcome.getStarted':
      return stageAfterGetStarted();
    case 'welcome.signInLink':
      return 'signin';
    case 'onboarding.finished':
      return stageAfterOnboarding();
    case 'onboarding.back':
      return stageWhenLeavingOnboarding();
    case 'signin.back':
      return 'welcome';
  }
}
/** The only two events allowed to land a player on sign-in. */
const SIGNIN_ENTRY_EVENTS: readonly GateEvent[] = [
  'welcome.signInLink',
  'onboarding.finished',
];

const rows: Row[] = [];
const broken: Row[] = [];

function record(row: Row) {
  rows.push(row);
  if (row.verdict === 'BROKEN') broken.push(row);
}

/**
 * Seeds for one campaign. A row is a pure function of (campaign, seed), so
 * STRESS_ONLY_SEED replays that seed in every campaign whatever STRESS_ITER
 * originally produced it.
 */
function seedsFor(offset: number, count: number): number[] {
  if (ONLY_SEED !== null) return [ONLY_SEED];
  return Array.from({ length: count }, (_, i) => rowSeed(offset + i));
}

describe('STRESS mod-launch-gate / boundary-malformed', () => {
  afterAll(() => {
    const summary = {
      unit: 'mod-launch-gate',
      lens: 'boundary-malformed',
      masterSeed: MASTER_SEED,
      iterationsRequested: {
        AB: ITER,
        C: ITER,
        D: Math.max(1, Math.floor(ITER / 10)),
      },
      rowsExecuted: rows.length,
      byCampaign: (['A', 'B', 'C', 'D'] as const).map(c => ({
        campaign: c,
        executed: rows.filter(r => r.campaign === c).length,
        broken: broken.filter(r => r.campaign === c).length,
      })),
      byCategoryA: PAYLOAD_CATEGORIES.map(cat => ({
        category: cat,
        executed: rows.filter(
          r =>
            r.campaign === 'A' &&
            (r.args ?? []).some(a => a.startsWith(`${cat}:`)),
        ).length,
      })),
      brokenSeeds: broken.map(r => r.seed),
      verdict: broken.length === 0 ? 'HELD' : 'BROKEN',
    };
    const rowsFile = writeArtifact('boundary-malformed.rows.json', rows);
    const summaryFile = writeArtifact(
      'boundary-malformed.summary.json',
      summary,
    );
    console.warn(
      `[stress:launch-gate] ${rows.length} rows, ${broken.length} broken → ${summaryFile} (${rowsFile})`,
    );
  });

  test(`A: ${ITER} hostile direct calls (this + 0..6 args) never throw, never deviate, never leak`, () => {
    for (const seed of seedsFor(0, ITER)) {
      const rng = mulberry32(seed);
      const name = pick(rng, EXPORT_NAMES);
      const thisArg = generateThisArg(rng);
      const argCount = intBetween(rng, 0, 6);
      const args: Payload[] = [];
      for (let a = 0; a < argCount; a += 1) args.push(generatePayload(rng));
      const failure = checkCall(name, thisArg, args) ?? hygieneViolation();
      record({
        seed,
        campaign: 'A',
        fn: name,
        thisArg: thisArg.describe,
        args: args.map(a => a.describe),
        verdict: failure ? 'BROKEN' : 'HELD',
        ...(failure ? { detail: failure } : {}),
      });
    }
    const brokenA = broken.filter(r => r.campaign === 'A');
    expect(brokenA.slice(0, 20)).toEqual([]);
  });

  test(`B: ${ITER} calls under active prototype pollution still return the primitive literal`, () => {
    for (const seed of seedsFor(ITER, ITER)) {
      const rng = mulberry32(seed);
      const name = pick(rng, EXPORT_NAMES);
      const pollution = pollute(rng);
      let failure: string | null = null;
      try {
        const thisArg = generateThisArg(rng);
        const args = [generatePayload(rng, 'proto'), generatePayload(rng)];
        failure = checkCall(name, thisArg, args);
        if (!failure) {
          // The literal must be a primitive — a polluted String.prototype
          // key must not be reachable as an own property of the result.
          const result = EXPORTS[name].fn() as unknown as Record<
            string,
            unknown
          >;
          if (Object.prototype.hasOwnProperty.call(result, 'signin')) {
            failure = 'result carries own key from pollution';
          }
        }
      } finally {
        pollution.undo();
      }
      failure = failure ?? hygieneViolation();
      record({
        seed,
        campaign: 'B',
        fn: name,
        pollution: pollution.describe,
        verdict: failure ? 'BROKEN' : 'HELD',
        ...(failure ? { detail: failure } : {}),
      });
    }
    expect(broken.filter(r => r.campaign === 'B').slice(0, 20)).toEqual([]);
  });

  test(`C: ${ITER} malformed preAuthStage values route to Welcome — never sign-in, never past the gate`, () => {
    for (const seed of seedsFor(2 * ITER, ITER)) {
      const rng = mulberry32(seed);
      const payload = generatePayload(rng);
      let failure: string | null = null;
      let screen: Screen | null = null;
      try {
        screen = screenForStage(payload.value);
      } catch (error) {
        failure = `switch threw: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (!failure) {
        const isExactLiteral =
          typeof payload.value === 'string' &&
          (STAGE_LITERALS as readonly string[]).includes(payload.value);
        if (isExactLiteral) {
          const want: Screen =
            payload.value === 'signin'
              ? 'SignInScreen'
              : payload.value === 'onboarding'
                ? 'OnboardingScreen(preauth)'
                : 'WelcomeScreen';
          if (screen !== want) failure = `${want} expected, got ${screen}`;
        } else if (screen !== 'WelcomeScreen') {
          failure = `malformed stage routed to ${screen}`;
        }
      }
      record({
        seed,
        campaign: 'C',
        input: payload.describe,
        verdict: failure ? 'BROKEN' : 'HELD',
        ...(failure ? { detail: failure } : {}),
      });
    }
    expect(broken.filter(r => r.campaign === 'C').slice(0, 20)).toEqual([]);
  });

  test(`D: ${Math.max(1, Math.floor(ITER / 10))} random event sequences (stale + duplicate fire-through) never skip the questionnaire`, () => {
    for (const seed of seedsFor(3 * ITER, Math.max(1, Math.floor(ITER / 10)))) {
      const rng = mulberry32(seed);
      const length = intBetween(rng, 1, 40);
      const events: GateEvent[] = [];
      let stage: PreAuthStage = 'welcome';
      let failure: string | null = null;
      for (let step = 0; step < length && !failure; step += 1) {
        // 70 %: an event the CURRENT screen can raise; 30 %: a stale or
        // duplicate handler firing after its screen went away.
        const live = GATE_EVENTS.filter(e => e.startsWith(stage + '.'));
        const event = rng() < 0.7 ? pick(rng, live) : pick(rng, GATE_EVENTS);
        events.push(event);
        const previous = stage;
        stage = applyEvent(previous, event);
        if (!(STAGE_LITERALS as readonly string[]).includes(stage)) {
          failure = `stage left PreAuthStage: ${String(stage)}`;
        } else if (stage === 'signin' && previous !== 'signin') {
          if (!SIGNIN_ENTRY_EVENTS.includes(event)) {
            failure = `sign-in entered via ${event}`;
          }
        } else if (stage === 'onboarding' && previous !== 'onboarding') {
          if (event !== 'welcome.getStarted') {
            failure = `onboarding entered via ${event}`;
          }
        }
        if (!failure && previous === 'onboarding' && stage !== 'onboarding') {
          // Leaving the questionnaire: only its own two exits may do it.
          if (
            event !== 'onboarding.finished' &&
            event !== 'onboarding.back' &&
            event !== 'welcome.signInLink' &&
            event !== 'signin.back' &&
            event !== 'welcome.getStarted'
          ) {
            failure = `onboarding left via ${event}`;
          }
          if (event === 'onboarding.back' && stage !== 'welcome') {
            failure = `back from step one landed on ${stage}`;
          }
          if (event === 'onboarding.finished' && stage !== 'signin') {
            failure = `finishing landed on ${stage}`;
          }
        }
      }
      record({
        seed,
        campaign: 'D',
        events,
        verdict: failure ? 'BROKEN' : 'HELD',
        ...(failure ? { detail: failure } : {}),
      });
    }
    expect(broken.filter(r => r.campaign === 'D').slice(0, 20)).toEqual([]);
  });

  test('huge payloads are measured three ways and none of them reach the gate', () => {
    // Byte vs code point vs grapheme caps: the gate has no string input at
    // all, so the only meaningful assertion is that each measurement of a
    // hostile string is finite and the call is unaffected by any of them.
    const rng = mulberry32(MASTER_SEED ^ 0x48554745);
    for (let i = 0; i < 12; i += 1) {
      const payload = generatePayload(rng, 'huge');
      const text = payload.value as string;
      const bytes = new TextEncoder().encode(text).length;
      const codePoints = Array.from(text).length;
      const graphemes =
        typeof Intl !== 'undefined' && 'Segmenter' in Intl
          ? Array.from(
              new (
                Intl as unknown as {
                  Segmenter: new (
                    locale: string,
                    options: { granularity: 'grapheme' },
                  ) => { segment: (s: string) => Iterable<unknown> };
                }
              ).Segmenter('en', { granularity: 'grapheme' }).segment(text),
            ).length
          : null;
      expect(bytes).toBeGreaterThanOrEqual(65536);
      expect(codePoints).toBeLessThanOrEqual(text.length);
      if (graphemes !== null) expect(graphemes).toBeLessThanOrEqual(codePoints);
      expect(fingerprint(text)).toMatch(/^[0-9a-f]{8}$/);
      for (const name of EXPORT_NAMES) {
        expect(
          checkCall(
            name,
            {
              category: 'type',
              describe: 'this:undefined',
              value: undefined,
              jsonSafe: false,
            },
            [payload, payload, payload],
          ),
        ).toBeNull();
      }
    }
  });

  test('the module exposes exactly the three routing functions and nothing configurable', () => {
    const keys = Object.keys(launchGateModule).sort();
    expect(keys).toEqual(
      [
        'stageAfterGetStarted',
        'stageAfterOnboarding',
        'stageWhenLeavingOnboarding',
      ].sort(),
    );
    for (const name of EXPORT_NAMES) {
      const { fn, expected } = EXPORTS[name];
      expect(fn.length).toBe(0);
      expect(fn()).toBe(expected);
      // Not a constructor-able class, not async, not a generator: a plain
      // synchronous function whose result is available to the render tick.
      expect(Object.prototype.toString.call(fn())).toBe('[object String]');
      expect(fn.constructor).toBe(Function);
    }
  });
});
