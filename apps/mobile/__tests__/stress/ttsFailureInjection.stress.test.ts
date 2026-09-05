/**
 * STRESS / mod-tts / lens `failure-injection` — `src/audio/tts.ts`.
 *
 * The unit has exactly ONE dependency: the native bridge object
 * `NativeModules.PickleAudioCoach` (AVSpeechSynthesizer on iOS, see
 * ios/LocalPods/PickleNative/Sources/PickleAudioCoachBridge.m — it exports
 * `speak:rate:` and `stop`, both void). The REAL module is loaded in an
 * isolated registry against an injected fault on that dependency:
 *
 *  - module shape faults: absent, null, empty object, one method missing,
 *    method present but not a function (truthy and falsy), frozen object,
 *    prototype methods, Proxy whose `get` throws, accessor that throws at
 *    import, module registered late / removed late / replaced late;
 *  - `speak` behaviour faults: throws (Error / string / null / undefined /
 *    object / on the n-th call / alternating), returns a rejected, pending
 *    or resolved promise (a malformed async shape — RCT void methods return
 *    undefined), busy-loops (slow sync), re-enters `tts.stop()` /
 *    `tts.speak()`, deletes itself, returns false;
 *  - `stop` behaviour faults: throws, throws on the n-th call, re-enters
 *    `tts.speak()`, deletes itself;
 *  - caller-input faults: empty / whitespace / 10 k / 1 M chars, emoji, RTL,
 *    control characters, lone surrogates, newline storms, SSML-looking text,
 *    and malformed non-string arguments a JS caller could pass;
 *  - timing faults: rapid synchronous bursts, speak/stop interleavings, stop
 *    storms, microtask-interleaved bursts, fake clock advanced 60 s.
 *
 * Contract under test (from the module's doc comment "Explicit
 * availability: when the native module is missing the caller knows — cues
 * are shown on screen but not spoken. Never a silent fake."):
 *  C1 `available()` never throws and is truthful: true iff the captured
 *     module exposes a callable `speak`.
 *  C2 When `available()` is false, `speak()` and `stop()` are harmless
 *     no-ops — never throw, never reach a native function.
 *  C3 When `available()` is true, every `speak(text)` forwards exactly one
 *     native call `(text, 0.5)` in order; every `stop()` forwards exactly
 *     one native `stop` when the module has one.
 *  C4 A native throw propagates to the caller as the SAME value (never
 *     swallowed = never a silent failure, never wrapped) and leaves no
 *     poisoned state: the next call forwards normally.
 *  C5 The bridge owns no timers and no promises: after any sequence,
 *     advancing fake timers 60 s finds nothing pending, and a promise a
 *     malformed native returned is not dropped unhandled.
 *  D  Determinism: replaying a seed yields a byte-identical trace.
 *
 * Every violation is recorded as a CODE. Codes that reproduce a documented
 * defect of the current implementation are KNOWN (listed in KNOWN_CODES with
 * the file:line they point at); the suite fails on any UNKNOWN code and, with
 * STRESS_RED=1, also on the known ones (the strict-contract run).
 *
 * Knobs (env): STRESS_ITER (random sequences, default 200), STRESS_SEED_BASE
 * (default 20260905), STRESS_SEED (replay ONE seed), STRESS_OUT (write the
 * seed → outcome JSON table there), STRESS_RED=1 (assert the contract
 * strictly). Campaign:
 *   STRESS_ITER=5000 STRESS_OUT=/tmp/tts-fi.json \
 *     npx jest --ci __tests__/stress/ttsFailureInjection.stress.test.ts
 *
 * Whether AVSpeechSynthesizer itself can fail on-device is Apple-runtime
 * truth and is NOT claimed here; the native side is only modelled.
 */
import {
  NO_READ_VARIANTS,
  PRAISE_VARIANTS,
  sessionStartLine,
} from '@pickle/audio-coach-core';
import { LiveSessionCoach } from '../../src/flow/liveSessionCoach';

// Node built-ins for the raw artifact. The mobile tsconfig has no node
// typings (types: ["jest"]), so the shims stay local like the matrix suites.
declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { dirname } = require('path') as { dirname: (path: string) => string };

type TtsModule = typeof import('../../src/audio/tts');
type Tts = TtsModule['tts'];
type Registry = Record<string, unknown>;

const SUITE_PATH = '__tests__/stress/ttsFailureInjection.stress.test.ts';
const ITER = Math.max(1, Number(process.env.STRESS_ITER ?? 200));
const SEED_BASE = Number(process.env.STRESS_SEED_BASE ?? 20260905);
const REPLAY_SEED =
  process.env.STRESS_SEED !== undefined
    ? Number(process.env.STRESS_SEED)
    : null;
const OUT = process.env.STRESS_OUT ?? null;
const RED = process.env.STRESS_RED === '1';

// ───────────────────────────── seeded RNG ─────────────────────────────

/** mulberry32 — the generator the repo's other stress suites use. */
class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  between(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
}

/** FNV-1a over a string — trace fingerprint for the determinism check. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ───────────────────────── violation codes ─────────────────────────

type Code =
  | 'AVAILABLE_THREW'
  | 'AVAILABLE_UNTRUTHFUL'
  | 'UNAVAILABLE_SPEAK_THREW'
  | 'UNAVAILABLE_SPEAK_REACHED_NATIVE'
  | 'STOP_THREW_NO_METHOD'
  | 'FORWARD_MISMATCH'
  | 'RATE_MISMATCH'
  | 'THROW_SWALLOWED'
  | 'THROW_WRAPPED'
  | 'SPEAK_THREW_UNEXPECTED'
  | 'STOP_THREW_UNEXPECTED'
  | 'POISONED_AFTER_THROW'
  | 'TIMER_LEAK'
  | 'REJECTION_DROPPED'
  | 'REENTRANCY_UNBOUNDED'
  | 'IMPORT_THREW';

/**
 * Codes that reproduce a defect of the CURRENT implementation. Each names
 * the line it points at; the default run reports them as BROKEN(known)
 * without failing, STRESS_RED=1 fails on them.
 */
const KNOWN_CODES: Record<string, { file: string; why: string }> = {
  UNAVAILABLE_SPEAK_THREW: {
    file: 'apps/mobile/src/audio/tts.ts:22',
    why: '`native?.speak(text, 0.5)` guards the module, not the method: a module object without a callable `speak` throws TypeError although available() is false',
  },
  STOP_THREW_NO_METHOD: {
    file: 'apps/mobile/src/audio/tts.ts:25',
    why: '`native?.stop()` throws TypeError when the module object exists without `stop` (speak-only shape)',
  },
  AVAILABLE_UNTRUTHFUL: {
    file: 'apps/mobile/src/audio/tts.ts:19',
    why: '`Boolean(native?.speak)` reports available for a truthy non-function `speak` — the next speak() throws TypeError (fake availability)',
  },
  REJECTION_DROPPED: {
    file: 'apps/mobile/src/audio/tts.ts:22',
    why: 'a promise returned by a malformed native speak is dropped without a handler (unhandled rejection). RCT void methods return undefined, so not producible via the shipping bridge',
  },
  IMPORT_THREW: {
    file: 'apps/mobile/src/audio/tts.ts:14',
    why: 'the registry is read once at import with no guard: an accessor that throws makes `import tts` throw. RN NativeModules yields undefined/null for a missing module, so not producible via the shipping registry',
  },
};

// ───────────────────────── native fake ─────────────────────────

type SpeakMode =
  | 'ok'
  | 'throwError'
  | 'throwString'
  | 'throwNull'
  | 'throwUndefined'
  | 'throwObject'
  | 'throwNth'
  | 'throwAlternate'
  | 'rejectedPromise'
  | 'pendingPromise'
  | 'resolvedPromise'
  | 'slowSync'
  | 'reentrantStop'
  | 'reentrantSpeak'
  | 'selfDestruct'
  | 'returnFalse';

type StopMode =
  | 'ok'
  | 'throwError'
  | 'throwString'
  | 'throwNth'
  | 'reentrantSpeak'
  | 'selfDestruct';

const SPEAK_MODES: readonly SpeakMode[] = [
  'ok',
  'throwError',
  'throwString',
  'throwNull',
  'throwUndefined',
  'throwObject',
  'throwNth',
  'throwAlternate',
  'rejectedPromise',
  'pendingPromise',
  'resolvedPromise',
  'slowSync',
  'reentrantStop',
  'reentrantSpeak',
  'selfDestruct',
  'returnFalse',
];

const STOP_MODES: readonly StopMode[] = [
  'ok',
  'throwError',
  'throwString',
  'throwNth',
  'reentrantSpeak',
  'selfDestruct',
];

interface NativeCall {
  m: 'speak' | 'stop';
  text?: unknown;
  rate?: unknown;
  depth: number;
}

/** A promise whose `then` reports whether ANY consumer attached a handler. */
interface TrackedPromise {
  promise: Promise<unknown>;
  handled: () => boolean;
}

function trackedRejection(reason: unknown): TrackedPromise {
  const promise = Promise.reject(reason);
  let handledByCaller = false;
  let mine = false;
  const originalThen = promise.then.bind(promise);
  Object.defineProperty(promise, 'then', {
    configurable: true,
    value: (
      onFulfilled?: ((value: unknown) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null,
    ) => {
      if (!mine) handledByCaller = true;
      return originalThen(onFulfilled ?? undefined, onRejected ?? undefined);
    },
  });
  // Our own settle handler (keeps the process alive) is invisible to the
  // "did the caller handle it" question.
  mine = true;
  promise.then(undefined, () => undefined);
  mine = false;
  return { promise, handled: () => handledByCaller };
}

interface FakeNative {
  module: Registry;
  calls: NativeCall[];
  /** The value the fake threw on the most recent call, if it threw. */
  lastThrown: { value: unknown } | null;
  rejections: TrackedPromise[];
  reentryDepth: number;
  maxReentryDepth: number;
  setTts(tts: Tts): void;
}

const REENTRY_CAP = 6;
/** Keeps the slowSync spin from being optimised away. */
let slowSink = 0;

function makeFakeNative(
  rng: Rng,
  speakMode: SpeakMode,
  stopMode: StopMode,
  options: { withSpeak: boolean; withStop: boolean },
): FakeNative {
  const calls: NativeCall[] = [];
  let tts: Tts | null = null;
  const fake: FakeNative = {
    module: {},
    calls,
    lastThrown: null,
    rejections: [],
    reentryDepth: 0,
    maxReentryDepth: 0,
    setTts(next) {
      tts = next;
    },
  };
  const throwNth = rng.between(1, 4);
  let speakCount = 0;
  let stopCount = 0;

  const raise = (value: unknown): never => {
    fake.lastThrown = { value };
    throw value;
  };

  const speak = function speak(text: unknown, rate: unknown): unknown {
    fake.lastThrown = null;
    speakCount += 1;
    calls.push({ m: 'speak', text, rate, depth: fake.reentryDepth });
    switch (speakMode) {
      case 'ok':
        return undefined;
      case 'throwError':
        return raise(
          new Error(`AVSpeechSynthesizer unavailable (${speakCount})`),
        );
      case 'throwString':
        return raise('native speak failed');
      case 'throwNull':
        return raise(null);
      case 'throwUndefined':
        return raise(undefined);
      case 'throwObject':
        return raise({ code: 'E_AUDIO_SESSION', domain: 'AVFoundation' });
      case 'throwNth':
        return speakCount === throwNth
          ? raise(new Error('nth speak failed'))
          : undefined;
      case 'throwAlternate':
        return speakCount % 2 === 0
          ? raise(new Error('alternate speak failed'))
          : undefined;
      case 'rejectedPromise': {
        const tracked = trackedRejection(new Error('native speak rejected'));
        fake.rejections.push(tracked);
        return tracked.promise;
      }
      case 'pendingPromise':
        return new Promise(() => undefined);
      case 'resolvedPromise':
        return Promise.resolve();
      case 'slowSync': {
        // A synchronous native call that stalls the JS thread (bounded spin,
        // independent of the fake clock).
        let spin = 0;
        for (let i = 0; i < 20_000; i += 1) spin = (spin + i) | 0;
        slowSink = spin;
        return undefined;
      }
      case 'reentrantStop':
        if (fake.reentryDepth < REENTRY_CAP && tts) {
          fake.reentryDepth += 1;
          fake.maxReentryDepth = Math.max(
            fake.maxReentryDepth,
            fake.reentryDepth,
          );
          try {
            tts.stop();
          } finally {
            fake.reentryDepth -= 1;
          }
        }
        return undefined;
      case 'reentrantSpeak':
        if (fake.reentryDepth < REENTRY_CAP && tts) {
          fake.reentryDepth += 1;
          fake.maxReentryDepth = Math.max(
            fake.maxReentryDepth,
            fake.reentryDepth,
          );
          try {
            tts.speak(`reentry ${fake.reentryDepth}`);
          } finally {
            fake.reentryDepth -= 1;
          }
        }
        return undefined;
      case 'selfDestruct':
        delete fake.module['speak'];
        return undefined;
      case 'returnFalse':
        return false;
    }
  };

  const stop = function stop(): unknown {
    fake.lastThrown = null;
    stopCount += 1;
    calls.push({ m: 'stop', depth: fake.reentryDepth });
    switch (stopMode) {
      case 'ok':
        return undefined;
      case 'throwError':
        return raise(new Error('native stop failed'));
      case 'throwString':
        return raise('stop failed');
      case 'throwNth':
        return stopCount === throwNth
          ? raise(new Error('nth stop failed'))
          : undefined;
      case 'reentrantSpeak':
        if (fake.reentryDepth < REENTRY_CAP && tts) {
          fake.reentryDepth += 1;
          fake.maxReentryDepth = Math.max(
            fake.maxReentryDepth,
            fake.reentryDepth,
          );
          try {
            tts.speak('reentry from stop');
          } finally {
            fake.reentryDepth -= 1;
          }
        }
        return undefined;
      case 'selfDestruct':
        delete fake.module['stop'];
        return undefined;
    }
  };

  if (options.withSpeak) fake.module['speak'] = speak;
  if (options.withStop) fake.module['stop'] = stop;
  return fake;
}

// ───────────────────────── module shapes ─────────────────────────

type Shape =
  | 'absent'
  | 'null'
  | 'full'
  | 'speakOnly'
  | 'stopOnly'
  | 'emptyObject'
  | 'speakString'
  | 'speakObject'
  | 'speakZero'
  | 'speakNull'
  | 'frozen'
  | 'prototypeMethods'
  | 'proxyGetThrowsSpeak'
  | 'proxyGetThrowsStop'
  | 'getterThrowsAtImport'
  | 'getterThrowsSecondAccess'
  | 'lateRegistration'
  | 'lateRemoval'
  | 'lateReplace';

const SHAPES: readonly Shape[] = [
  'absent',
  'null',
  'full',
  'speakOnly',
  'stopOnly',
  'emptyObject',
  'speakString',
  'speakObject',
  'speakZero',
  'speakNull',
  'frozen',
  'prototypeMethods',
  'proxyGetThrowsSpeak',
  'proxyGetThrowsStop',
  'getterThrowsAtImport',
  'getterThrowsSecondAccess',
  'lateRegistration',
  'lateRemoval',
  'lateReplace',
];

/** Shapes the shipping iOS bridge can present (both methods always
 * exported — PickleAudioCoachBridge.m) or the RN registry can yield (module
 * missing / null). */
const PRODUCIBLE_SHAPES: ReadonlySet<Shape> = new Set<Shape>([
  'absent',
  'null',
  'full',
  'frozen',
  'prototypeMethods',
  'lateRegistration',
]);
/** Behaviours a real RCT void export can show: success or a synchronous
 * throw (argument validation on the bridge). It cannot return a value or a
 * promise, cannot call back into JS synchronously, cannot delete itself. */
const PRODUCIBLE_SPEAK_MODES: ReadonlySet<SpeakMode> = new Set<SpeakMode>([
  'ok',
  'throwError',
  'throwString',
  'throwNull',
  'throwUndefined',
  'throwObject',
  'throwNth',
  'throwAlternate',
  'slowSync',
]);
const PRODUCIBLE_STOP_MODES: ReadonlySet<StopMode> = new Set<StopMode>([
  'ok',
  'throwError',
  'throwString',
  'throwNth',
]);

function isProducible(scenario: Scenario): boolean {
  return (
    PRODUCIBLE_SHAPES.has(scenario.shape) &&
    PRODUCIBLE_SPEAK_MODES.has(scenario.speakMode) &&
    PRODUCIBLE_STOP_MODES.has(scenario.stopMode)
  );
}

interface Loaded {
  tts: Tts;
  registry: Registry;
  /** What tts.ts captured at import (the fake's module, or undefined/null). */
  captured: () => unknown;
  importError: unknown | null;
}

function loadTts(shape: Shape, fake: FakeNative): Loaded {
  let loaded: TtsModule | null = null;
  let registry: Registry = {};
  let importError: unknown = null;
  let capturedValue: unknown = undefined;
  let secondAccessArmed = false;

  jest.isolateModules(() => {
    const rn =
      jest.requireActual<typeof import('react-native')>('react-native');
    registry = rn.NativeModules as unknown as Registry;
    delete registry['PickleAudioCoach'];
    switch (shape) {
      case 'absent':
      case 'lateRegistration':
        capturedValue = undefined;
        break;
      case 'null':
        registry['PickleAudioCoach'] = null;
        capturedValue = null;
        break;
      case 'full':
      case 'speakOnly':
      case 'stopOnly':
      case 'emptyObject':
      case 'lateRemoval':
      case 'lateReplace':
        registry['PickleAudioCoach'] = fake.module;
        capturedValue = fake.module;
        break;
      case 'speakString':
        fake.module['speak'] = 'speak';
        registry['PickleAudioCoach'] = fake.module;
        capturedValue = fake.module;
        break;
      case 'speakObject':
        fake.module['speak'] = { native: true };
        registry['PickleAudioCoach'] = fake.module;
        capturedValue = fake.module;
        break;
      case 'speakZero':
        fake.module['speak'] = 0;
        registry['PickleAudioCoach'] = fake.module;
        capturedValue = fake.module;
        break;
      case 'speakNull':
        fake.module['speak'] = null;
        registry['PickleAudioCoach'] = fake.module;
        capturedValue = fake.module;
        break;
      case 'frozen': {
        const frozen = Object.freeze({ ...fake.module });
        registry['PickleAudioCoach'] = frozen;
        capturedValue = frozen;
        break;
      }
      case 'prototypeMethods': {
        const proto = { ...fake.module };
        const instance = Object.create(proto) as Registry;
        registry['PickleAudioCoach'] = instance;
        capturedValue = instance;
        break;
      }
      case 'proxyGetThrowsSpeak':
      case 'proxyGetThrowsStop': {
        const bad = shape === 'proxyGetThrowsSpeak' ? 'speak' : 'stop';
        const proxy = new Proxy(fake.module, {
          get(target, prop, receiver) {
            if (prop === bad)
              throw new Error(`bridge property ${bad} unreadable`);
            return Reflect.get(target, prop, receiver);
          },
        });
        registry['PickleAudioCoach'] = proxy;
        capturedValue = proxy;
        break;
      }
      case 'getterThrowsAtImport':
        Object.defineProperty(registry, 'PickleAudioCoach', {
          configurable: true,
          enumerable: true,
          get() {
            throw new Error('native module registry threw');
          },
        });
        capturedValue = undefined;
        break;
      case 'getterThrowsSecondAccess': {
        let reads = 0;
        Object.defineProperty(registry, 'PickleAudioCoach', {
          configurable: true,
          enumerable: true,
          get() {
            reads += 1;
            if (reads >= 2 && secondAccessArmed) {
              throw new Error('registry threw on re-read');
            }
            return fake.module;
          },
        });
        capturedValue = fake.module;
        break;
      }
    }
    try {
      loaded = jest.requireActual<TtsModule>('../../src/audio/tts');
    } catch (error) {
      importError = error;
    }
    secondAccessArmed = true;
  });

  // Never leave an accessor behind on the shared registry object.
  if (
    shape === 'getterThrowsAtImport' ||
    shape === 'getterThrowsSecondAccess'
  ) {
    delete registry['PickleAudioCoach'];
  }

  if (importError !== null || loaded === null) {
    const inert: Tts = {
      available: () => false,
      speak: () => undefined,
      stop: () => undefined,
    };
    return { tts: inert, registry, captured: () => undefined, importError };
  }
  const ns: TtsModule = loaded;
  return {
    tts: ns.tts,
    registry,
    captured: () => capturedValue,
    importError: null,
  };
}

function shapeMethods(shape: Shape): { withSpeak: boolean; withStop: boolean } {
  switch (shape) {
    case 'speakOnly':
      return { withSpeak: true, withStop: false };
    case 'stopOnly':
      return { withSpeak: false, withStop: true };
    case 'emptyObject':
    case 'speakString':
    case 'speakObject':
    case 'speakZero':
    case 'speakNull':
      return { withSpeak: false, withStop: true };
    default:
      return { withSpeak: true, withStop: true };
  }
}

// ───────────────────────── caller inputs ─────────────────────────

type TextClass =
  | 'cue'
  | 'empty'
  | 'whitespace'
  | 'long10k'
  | 'long1m'
  | 'emoji'
  | 'rtl'
  | 'control'
  | 'loneSurrogate'
  | 'newlines'
  | 'ssmlLike'
  | 'numericString'
  | 'undefinedArg'
  | 'nullArg'
  | 'numberArg'
  | 'objectArg';

const TEXT_CLASSES: readonly TextClass[] = [
  'cue',
  'empty',
  'whitespace',
  'long10k',
  'long1m',
  'emoji',
  'rtl',
  'control',
  'loneSurrogate',
  'newlines',
  'ssmlLike',
  'numericString',
  'undefinedArg',
  'nullArg',
  'numberArg',
  'objectArg',
];

const CUES: readonly string[] = [
  ...PRAISE_VARIANTS,
  ...NO_READ_VARIANTS,
  sessionStartLine(),
  'Paddle up.',
  'Bend your knees, stay low.',
];

function textFor(rng: Rng, klass: TextClass): unknown {
  switch (klass) {
    case 'cue':
      return rng.pick(CUES);
    case 'empty':
      return '';
    case 'whitespace':
      return ' \t\n  ';
    case 'long10k':
      return 'Paddle up. '.repeat(1000);
    case 'long1m':
      return 'x'.repeat(1_000_000);
    case 'emoji':
      return '🏓 Great dink! 👍🏽 Keep it low 🎾';
    case 'rtl':
      return 'مضرب لأعلى \u202Eabc\u202C reversed';
    case 'control':
      return 'Paddle\u0000up\u0007\u001b[31m';
    case 'loneSurrogate':
      return 'Nice \uD83D shot';
    case 'newlines':
      return '\n'.repeat(500) + 'Reset.' + '\r\n'.repeat(50);
    case 'ssmlLike':
      return '<speak><break time="60s"/>Paddle up</speak>';
    case 'numericString':
      return '1e308';
    case 'undefinedArg':
      return undefined;
    case 'nullArg':
      return null;
    case 'numberArg':
      return 42;
    case 'objectArg':
      return { text: 'Paddle up' };
  }
}

// ───────────────────────── scenario runner ─────────────────────────

type Op =
  | { k: 'speak'; text: TextClass }
  | { k: 'stop' }
  | { k: 'available' }
  | { k: 'burst'; n: number; text: TextClass; interleaveStop: boolean }
  | { k: 'microtaskBurst'; n: number }
  | { k: 'advance60s' }
  | { k: 'lateMutate' }
  | { k: 'stopStorm'; n: number };

const OP_KINDS = [
  'speak',
  'stop',
  'available',
  'burst',
  'microtaskBurst',
  'advance60s',
  'lateMutate',
  'stopStorm',
] as const;

interface Scenario {
  seed: number;
  shape: Shape;
  speakMode: SpeakMode;
  stopMode: StopMode;
  ops: Op[];
}

interface Row {
  seed: number;
  shape: Shape;
  speakMode: SpeakMode;
  stopMode: StopMode;
  producible: boolean;
  ops: number;
  nativeCalls: number;
  outcome: 'HELD' | 'BROKEN_KNOWN' | 'BROKEN_UNKNOWN';
  codes: Code[];
  detail: string[];
  traceHash: string;
  replay: string;
}

function genScenario(seed: number, forced?: Partial<Scenario>): Scenario {
  const rng = new Rng(seed);
  const shape = forced?.shape ?? rng.pick(SHAPES);
  const speakMode = forced?.speakMode ?? rng.pick(SPEAK_MODES);
  const stopMode = forced?.stopMode ?? rng.pick(STOP_MODES);
  const ops: Op[] = [];
  const count = rng.between(1, 40);
  for (let i = 0; i < count; i += 1) {
    const kind = rng.pick(OP_KINDS);
    const text = rng.chance(0.03)
      ? 'long1m'
      : rng.pick(TEXT_CLASSES.filter(t => t !== 'long1m'));
    switch (kind) {
      case 'speak':
        ops.push({ k: 'speak', text });
        break;
      case 'stop':
        ops.push({ k: 'stop' });
        break;
      case 'available':
        ops.push({ k: 'available' });
        break;
      case 'burst':
        ops.push({
          k: 'burst',
          n: rng.between(2, 200),
          text: text === 'long1m' ? 'cue' : text,
          interleaveStop: rng.chance(0.5),
        });
        break;
      case 'microtaskBurst':
        ops.push({ k: 'microtaskBurst', n: rng.between(2, 30) });
        break;
      case 'advance60s':
        ops.push({ k: 'advance60s' });
        break;
      case 'lateMutate':
        ops.push({ k: 'lateMutate' });
        break;
      case 'stopStorm':
        ops.push({ k: 'stopStorm', n: rng.between(2, 300) });
        break;
    }
  }
  // Every sequence ends with the recovery probes.
  ops.push(
    { k: 'advance60s' },
    { k: 'available' },
    { k: 'speak', text: 'cue' },
    { k: 'stop' },
  );
  return { seed, shape, speakMode, stopMode, ops: forced?.ops ?? ops };
}

function describeThrown(value: unknown): string {
  if (value instanceof Error) return `${value.name}:${value.message}`;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return `${typeof value}:${String(value)}`;
}

function describeText(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 40 ? `str(${value.length})` : JSON.stringify(value);
  }
  return describeThrown(value);
}

async function runScenario(scenario: Scenario): Promise<Row> {
  const rng = new Rng(scenario.seed ^ 0x9e3779b9);
  const methods = shapeMethods(scenario.shape);
  const fake = makeFakeNative(
    rng,
    scenario.speakMode,
    scenario.stopMode,
    methods,
  );
  const loaded = loadTts(scenario.shape, fake);
  fake.setTts(loaded.tts);
  const { tts } = loaded;

  const codes = new Set<Code>();
  const detail: string[] = [];
  const trace: string[] = [];
  const flag = (code: Code, why: string): void => {
    codes.add(code);
    if (detail.length < 12) detail.push(`${code}: ${why}`);
  };

  if (loaded.importError !== null) {
    flag('IMPORT_THREW', describeThrown(loaded.importError));
  }

  const capturedSpeakCallable = (): boolean => {
    const captured = loaded.captured() as Registry | null | undefined;
    if (captured === null || captured === undefined) return false;
    try {
      return typeof captured['speak'] === 'function';
    } catch {
      return false;
    }
  };
  const capturedStopCallable = (): boolean => {
    const captured = loaded.captured() as Registry | null | undefined;
    if (captured === null || captured === undefined) return false;
    try {
      return typeof captured['stop'] === 'function';
    } catch {
      return false;
    }
  };
  const moduleObjectPresent = (): boolean => {
    const captured = loaded.captured();
    return captured !== null && captured !== undefined;
  };

  const doAvailable = (): void => {
    let value: boolean | null = null;
    try {
      value = tts.available();
    } catch (error) {
      trace.push('available:threw');
      // A module whose `speak` property itself throws on read can only
      // propagate; every other shape must answer.
      if (scenario.shape !== 'proxyGetThrowsSpeak') {
        flag('AVAILABLE_THREW', describeThrown(error));
      }
      return;
    }
    trace.push(`available:${value}`);
    if (value !== capturedSpeakCallable()) {
      flag(
        'AVAILABLE_UNTRUTHFUL',
        `available()=${value} but captured.speak callable=${capturedSpeakCallable()}`,
      );
    }
  };

  const doSpeak = (klass: TextClass, viaBurst: boolean): void => {
    const text = textFor(rng, klass);
    const before = fake.calls.length;
    const callable = capturedSpeakCallable();
    const proxyThrowsOnRead = scenario.shape === 'proxyGetThrowsSpeak';
    let thrown: { value: unknown } | null = null;
    try {
      tts.speak(text as string);
    } catch (error) {
      thrown = { value: error };
    }
    const added = fake.calls.slice(before);
    const own = added.filter(c => c.depth === 0);
    trace.push(`speak(${klass}):${thrown ? 'threw' : 'ok'}:${added.length}`);

    if (proxyThrowsOnRead) {
      // Reading `speak` itself throws: propagation is the only honest outcome.
      if (!thrown)
        flag('THROW_SWALLOWED', 'proxy get(speak) threw but speak() returned');
      return;
    }
    if (!callable) {
      if (thrown) {
        flag(
          'UNAVAILABLE_SPEAK_THREW',
          `shape=${scenario.shape} available()=false yet speak(${describeText(text)}) threw ${describeThrown(thrown.value)}`,
        );
      }
      if (added.length > 0) {
        flag(
          'UNAVAILABLE_SPEAK_REACHED_NATIVE',
          `${added.length} native call(s)`,
        );
      }
      return;
    }
    // Callable path. `lastThrown` is set by whichever fake method threw
    // during this call (speak itself, or a stop the fake re-entered).
    if (fake.lastThrown && added.length > 0) {
      if (!thrown) {
        flag(
          'THROW_SWALLOWED',
          `native threw ${describeThrown(fake.lastThrown.value)}`,
        );
      } else if (thrown.value !== fake.lastThrown.value) {
        flag(
          'THROW_WRAPPED',
          `native threw ${describeThrown(fake.lastThrown.value)}, caller saw ${describeThrown(thrown.value)}`,
        );
      }
    } else if (thrown) {
      if (
        scenario.speakMode === 'reentrantStop' &&
        moduleObjectPresent() &&
        !capturedStopCallable()
      ) {
        // The fake re-entered tts.stop() on a module whose stop is gone.
        flag(
          'STOP_THREW_NO_METHOD',
          `via re-entered stop: ${describeThrown(thrown.value)}`,
        );
      } else {
        flag('SPEAK_THREW_UNEXPECTED', describeThrown(thrown.value));
      }
    }
    if (own.length !== 1 || own[0]?.m !== 'speak') {
      flag('FORWARD_MISMATCH', `expected 1 own speak, saw ${own.length}`);
    } else {
      const call = own[0];
      if (call.text !== text) {
        flag(
          'FORWARD_MISMATCH',
          `text ${describeText(text)} → ${describeText(call.text)}`,
        );
      }
      if (call.rate !== 0.5) flag('RATE_MISMATCH', `rate ${String(call.rate)}`);
    }
    if (fake.maxReentryDepth >= REENTRY_CAP && !viaBurst) {
      // The fake capped the recursion; tts added no guard of its own. Only
      // reported when the reentry came from a single call, as a trace fact.
      trace.push(`reentry:${fake.maxReentryDepth}`);
    }
  };

  const doStop = (): void => {
    const before = fake.calls.length;
    const callable = capturedStopCallable();
    let thrown: { value: unknown } | null = null;
    try {
      tts.stop();
    } catch (error) {
      thrown = { value: error };
    }
    const added = fake.calls.slice(before);
    const own = added.filter(c => c.depth === 0);
    trace.push(`stop:${thrown ? 'threw' : 'ok'}:${added.length}`);

    if (scenario.shape === 'proxyGetThrowsStop') {
      if (!thrown)
        flag('THROW_SWALLOWED', 'proxy get(stop) threw but stop() returned');
      return;
    }
    if (!callable) {
      if (thrown) {
        if (moduleObjectPresent()) {
          flag(
            'STOP_THREW_NO_METHOD',
            `shape=${scenario.shape} stop() threw ${describeThrown(thrown.value)}`,
          );
        } else {
          flag('STOP_THREW_UNEXPECTED', describeThrown(thrown.value));
        }
      }
      return;
    }
    if (fake.lastThrown && added.length > 0) {
      if (!thrown) {
        flag(
          'THROW_SWALLOWED',
          `native stop threw ${describeThrown(fake.lastThrown.value)}`,
        );
      } else if (thrown.value !== fake.lastThrown.value) {
        flag('THROW_WRAPPED', 'stop throw value changed');
      }
    } else if (thrown) {
      if (
        scenario.stopMode === 'reentrantSpeak' &&
        moduleObjectPresent() &&
        !capturedSpeakCallable()
      ) {
        flag(
          'UNAVAILABLE_SPEAK_THREW',
          `via re-entered speak: ${describeThrown(thrown.value)}`,
        );
      } else {
        flag('STOP_THREW_UNEXPECTED', describeThrown(thrown.value));
      }
    }
    if (own.length !== 1 || own[0]?.m !== 'stop') {
      flag('FORWARD_MISMATCH', `expected 1 own stop, saw ${own.length}`);
    }
  };

  const doLateMutate = (): void => {
    const registry = loaded.registry;
    switch (scenario.shape) {
      case 'lateRegistration':
        registry['PickleAudioCoach'] = fake.module;
        trace.push('late:register');
        break;
      case 'lateRemoval':
        delete fake.module['speak'];
        delete fake.module['stop'];
        trace.push('late:remove');
        break;
      case 'lateReplace':
        registry['PickleAudioCoach'] = {
          speak: () => undefined,
          stop: () => undefined,
        };
        trace.push('late:replace');
        break;
      default:
        trace.push('late:noop');
    }
  };

  /** After a throw, the very next call must still forward (no poison). */
  const probeRecovery = (afterThrow: boolean): void => {
    if (!afterThrow || !capturedSpeakCallable()) return;
    if (
      scenario.speakMode !== 'throwNth' &&
      scenario.speakMode !== 'throwAlternate'
    )
      return;
    const before = fake.calls.length;
    try {
      tts.speak('recovery probe');
    } catch {
      // a second throw from a mode that throws again is the fake's choice
    }
    if (fake.calls.length === before) {
      flag('POISONED_AFTER_THROW', 'no native call after a previous throw');
    }
    trace.push('probe');
  };

  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  try {
    for (const op of scenario.ops) {
      switch (op.k) {
        case 'speak': {
          const beforeThrow = fake.lastThrown;
          doSpeak(op.text, false);
          probeRecovery(beforeThrow === null && fake.lastThrown !== null);
          break;
        }
        case 'stop':
          doStop();
          break;
        case 'available':
          doAvailable();
          break;
        case 'burst':
          for (let i = 0; i < op.n; i += 1) {
            doSpeak(op.text, true);
            if (op.interleaveStop && i % 3 === 2) doStop();
          }
          break;
        case 'microtaskBurst':
          for (let i = 0; i < op.n; i += 1) {
            doSpeak('cue', true);
            await Promise.resolve();
          }
          break;
        case 'advance60s': {
          jest.advanceTimersByTime(60_000);
          const pending = jest.getTimerCount();
          trace.push(`advance:${pending}`);
          if (pending !== 0)
            flag('TIMER_LEAK', `${pending} timer(s) pending after 60s`);
          break;
        }
        case 'lateMutate':
          doLateMutate();
          break;
        case 'stopStorm':
          for (let i = 0; i < op.n; i += 1) doStop();
          break;
      }
    }
    // Let dropped promises settle so their handlers (if any) are observable.
    await Promise.resolve();
    await Promise.resolve();
    for (const tracked of fake.rejections) {
      if (!tracked.handled()) {
        flag(
          'REJECTION_DROPPED',
          'native returned a rejected promise; tts attached no handler',
        );
        break;
      }
    }
    if (fake.maxReentryDepth >= REENTRY_CAP) {
      // The bridge is a pass-through: a re-entrant native recurses until the
      // FAKE's cap. Recorded as a trace fact, not a defect of tts (a native
      // module cannot call back into JS synchronously on the RN bridge).
      trace.push(`reentryCap:${fake.maxReentryDepth}`);
    }
  } finally {
    jest.useRealTimers();
  }

  const codeList = [...codes].sort();
  const unknown = codeList.filter(code => !(code in KNOWN_CODES));
  const outcome: Row['outcome'] =
    codeList.length === 0
      ? 'HELD'
      : unknown.length === 0
        ? 'BROKEN_KNOWN'
        : 'BROKEN_UNKNOWN';
  return {
    seed: scenario.seed,
    shape: scenario.shape,
    speakMode: scenario.speakMode,
    stopMode: scenario.stopMode,
    producible: isProducible(scenario),
    ops: scenario.ops.length,
    nativeCalls: fake.calls.length,
    outcome,
    codes: codeList,
    detail,
    traceHash: fnv1a(trace.join('|')),
    replay: `cd apps/mobile && STRESS_SEED=${scenario.seed} npx jest --ci ${SUITE_PATH}`,
  };
}

// ───────────────────────── fault catalogue ─────────────────────────

interface Fault {
  id: string;
  dependency:
    | 'native-module-shape'
    | 'native-speak'
    | 'native-stop'
    | 'caller-input'
    | 'timing';
  scenario: Partial<Scenario>;
}

const CATALOGUE: Fault[] = [];
for (const shape of SHAPES) {
  CATALOGUE.push({
    id: `shape:${shape}`,
    dependency: 'native-module-shape',
    scenario: {
      shape,
      speakMode: 'ok',
      stopMode: 'ok',
      ops: [
        { k: 'available' },
        { k: 'speak', text: 'cue' },
        { k: 'stop' },
        { k: 'lateMutate' },
        { k: 'available' },
        { k: 'speak', text: 'cue' },
        { k: 'stop' },
        { k: 'advance60s' },
      ],
    },
  });
}
for (const speakMode of SPEAK_MODES) {
  if (speakMode === 'ok') continue;
  CATALOGUE.push({
    id: `speak:${speakMode}`,
    dependency: 'native-speak',
    scenario: {
      shape: 'full',
      speakMode,
      stopMode: 'ok',
      ops: [
        { k: 'available' },
        { k: 'speak', text: 'cue' },
        { k: 'speak', text: 'cue' },
        { k: 'speak', text: 'cue' },
        { k: 'stop' },
        { k: 'speak', text: 'cue' },
        { k: 'microtaskBurst', n: 3 },
        { k: 'advance60s' },
        { k: 'available' },
      ],
    },
  });
}
for (const stopMode of STOP_MODES) {
  if (stopMode === 'ok') continue;
  CATALOGUE.push({
    id: `stop:${stopMode}`,
    dependency: 'native-stop',
    scenario: {
      shape: 'full',
      speakMode: 'ok',
      stopMode,
      ops: [
        { k: 'speak', text: 'cue' },
        { k: 'stop' },
        { k: 'stop' },
        { k: 'stop' },
        { k: 'speak', text: 'cue' },
        { k: 'stop' },
        { k: 'advance60s' },
        { k: 'available' },
      ],
    },
  });
}
for (const text of TEXT_CLASSES) {
  CATALOGUE.push({
    id: `input:${text}`,
    dependency: 'caller-input',
    scenario: {
      shape: 'full',
      speakMode: 'ok',
      stopMode: 'ok',
      ops: [
        { k: 'speak', text },
        { k: 'speak', text },
        { k: 'stop' },
        { k: 'speak', text },
        { k: 'advance60s' },
        { k: 'available' },
      ],
    },
  });
}
const TIMING: Array<{ id: string; ops: Op[] }> = [
  {
    id: 'timing:burst200',
    ops: [{ k: 'burst', n: 200, text: 'cue', interleaveStop: false }],
  },
  {
    id: 'timing:burst200-interleaved-stop',
    ops: [{ k: 'burst', n: 200, text: 'cue', interleaveStop: true }],
  },
  {
    id: 'timing:burst50-long10k',
    ops: [{ k: 'burst', n: 50, text: 'long10k', interleaveStop: false }],
  },
  { id: 'timing:stopStorm300', ops: [{ k: 'stopStorm', n: 300 }] },
  { id: 'timing:microtaskBurst30', ops: [{ k: 'microtaskBurst', n: 30 }] },
  {
    id: 'timing:speak-advance60s-speak',
    ops: [
      { k: 'speak', text: 'cue' },
      { k: 'advance60s' },
      { k: 'speak', text: 'cue' },
      { k: 'advance60s' },
    ],
  },
  {
    id: 'timing:stop-before-any-speak',
    ops: [{ k: 'stop' }, { k: 'stop' }, { k: 'speak', text: 'cue' }],
  },
];
for (const t of TIMING) {
  CATALOGUE.push({
    id: t.id,
    dependency: 'timing',
    scenario: {
      shape: 'full',
      speakMode: 'ok',
      stopMode: 'ok',
      ops: [...t.ops, { k: 'advance60s' }, { k: 'available' }],
    },
  });
}
// Compound faults: unavailable engine × hostile caller, throwing engine ×
// rapid cues, intermittent engine × interleavings.
const COMPOUND: Array<{ id: string; scenario: Partial<Scenario> }> = [
  {
    id: 'compound:absent×burst',
    scenario: {
      shape: 'absent',
      ops: [
        { k: 'burst', n: 100, text: 'cue', interleaveStop: true },
        { k: 'advance60s' },
      ],
    },
  },
  {
    id: 'compound:throwError×burst',
    scenario: {
      shape: 'full',
      speakMode: 'throwError',
      stopMode: 'throwError',
      ops: [
        { k: 'burst', n: 100, text: 'cue', interleaveStop: true },
        { k: 'advance60s' },
      ],
    },
  },
  {
    id: 'compound:throwAlternate×microtasks',
    scenario: {
      shape: 'full',
      speakMode: 'throwAlternate',
      stopMode: 'throwNth',
      ops: [
        { k: 'microtaskBurst', n: 20 },
        { k: 'stopStorm', n: 5 },
        { k: 'advance60s' },
      ],
    },
  },
  {
    id: 'compound:rejectedPromise×burst',
    scenario: {
      shape: 'full',
      speakMode: 'rejectedPromise',
      ops: [
        { k: 'burst', n: 20, text: 'cue', interleaveStop: false },
        { k: 'advance60s' },
      ],
    },
  },
  {
    id: 'compound:lateRemoval×burst',
    scenario: {
      shape: 'lateRemoval',
      ops: [
        { k: 'burst', n: 10, text: 'cue', interleaveStop: true },
        { k: 'lateMutate' },
        { k: 'available' },
        { k: 'burst', n: 10, text: 'cue', interleaveStop: true },
      ],
    },
  },
  {
    id: 'compound:lateRegistration×burst',
    scenario: {
      shape: 'lateRegistration',
      ops: [
        { k: 'burst', n: 10, text: 'cue', interleaveStop: true },
        { k: 'lateMutate' },
        { k: 'available' },
        { k: 'burst', n: 10, text: 'cue', interleaveStop: true },
      ],
    },
  },
];
for (const c of COMPOUND) {
  CATALOGUE.push({
    id: c.id,
    dependency: 'native-module-shape',
    scenario: { speakMode: 'ok', stopMode: 'ok', ...c.scenario },
  });
}

// ───────────────────────── results table ─────────────────────────

const rows: Row[] = [];
const catalogueRows: Array<
  Row & { fault: string; dependency: Fault['dependency'] }
> = [];

function summarize(): Record<string, unknown> {
  const byCode: Record<string, number> = {};
  const all = [...catalogueRows, ...rows];
  for (const row of all)
    for (const code of row.codes) byCode[code] = (byCode[code] ?? 0) + 1;
  const count = (outcome: Row['outcome']): number =>
    all.filter(r => r.outcome === outcome).length;
  return {
    scenariosExecuted: all.length,
    nativeCallsObserved: all.reduce((sum, r) => sum + r.nativeCalls, 0),
    held: count('HELD'),
    brokenKnown: count('BROKEN_KNOWN'),
    brokenUnknown: count('BROKEN_UNKNOWN'),
    byCode,
    brokenProducibleShapes: all.filter(
      r => r.outcome !== 'HELD' && r.producible,
    ).length,
    slowSpinSink: slowSink,
  };
}

afterAll(() => {
  if (OUT === null) return;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        suite: SUITE_PATH,
        unit: 'apps/mobile/src/audio/tts.ts',
        lens: 'failure-injection',
        knobs: {
          STRESS_ITER: ITER,
          STRESS_SEED_BASE: SEED_BASE,
          STRESS_SEED: REPLAY_SEED,
          STRESS_RED: RED,
        },
        faultCatalogue: CATALOGUE.map(f => f.id),
        knownCodes: KNOWN_CODES,
        summary: summarize(),
        catalogue: catalogueRows,
        random: rows,
      },
      null,
      2,
    ),
  );
});

// ───────────────────────── tests ─────────────────────────

describe('mod-tts failure injection — fault catalogue (every injected fault once)', () => {
  it('catalogue holds ≥ 60 distinct injected faults', () => {
    expect(CATALOGUE.length).toBeGreaterThanOrEqual(60);
    expect(new Set(CATALOGUE.map(f => f.id)).size).toBe(CATALOGUE.length);
  });

  for (const [index, fault] of CATALOGUE.entries()) {
    it(`${fault.id}`, async () => {
      const seed = SEED_BASE * 1000 + index;
      const row = await runScenario(genScenario(seed, fault.scenario));
      catalogueRows.push({
        ...row,
        fault: fault.id,
        dependency: fault.dependency,
      });
      const unknown = row.codes.filter(code => !(code in KNOWN_CODES));
      expect({ fault: fault.id, unknown, detail: row.detail }).toEqual({
        fault: fault.id,
        unknown: [],
        detail: row.detail,
      });
      if (RED) {
        expect({
          fault: fault.id,
          codes: row.codes,
          detail: row.detail,
        }).toEqual({
          fault: fault.id,
          codes: [],
          detail: row.detail,
        });
      }
    });
  }
});

describe('mod-tts failure injection — seeded random campaign', () => {
  it(`runs ${REPLAY_SEED === null ? ITER : 1} replayable sequence(s) with no unknown violation`, async () => {
    const seeds =
      REPLAY_SEED !== null
        ? [REPLAY_SEED]
        : Array.from({ length: ITER }, (_, i) => SEED_BASE + i);
    for (const seed of seeds) {
      const row = await runScenario(genScenario(seed));
      rows.push(row);
    }
    const unknown = rows.filter(r => r.outcome === 'BROKEN_UNKNOWN');
    expect(
      unknown.map(r => ({
        seed: r.seed,
        codes: r.codes,
        detail: r.detail,
        replay: r.replay,
      })),
    ).toEqual([]);
    if (RED) {
      const broken = rows.filter(r => r.outcome !== 'HELD');
      expect(
        broken.map(r => ({ seed: r.seed, codes: r.codes, replay: r.replay })),
      ).toEqual([]);
    }
  });

  it('every known-broken row needs a fault the shipping bridge cannot produce', () => {
    // The iOS bridge always exports both void methods, RN yields
    // undefined/null for an unregistered module, and a native method cannot
    // return a promise or re-enter JS synchronously. A break under only
    // producible faults would be a NEW, higher-severity finding.
    const producibleBroken = [...catalogueRows, ...rows].filter(
      r => r.outcome !== 'HELD' && r.producible,
    );
    expect(
      producibleBroken.map(r => ({
        seed: r.seed,
        shape: r.shape,
        codes: r.codes,
        detail: r.detail,
      })),
    ).toEqual([]);
  });

  it('replaying a seed reproduces the identical trace and verdict (D)', async () => {
    const sample = rows.filter((_, i) => i % 10 === 0).slice(0, 40);
    expect(sample.length).toBeGreaterThan(0);
    for (const row of sample) {
      const again = await runScenario(genScenario(row.seed));
      expect({
        seed: row.seed,
        hash: again.traceHash,
        codes: again.codes,
      }).toEqual({
        seed: row.seed,
        hash: row.traceHash,
        codes: row.codes,
      });
    }
  });
});

describe('mod-tts failure injection — what a caller inherits (dormant LiveSessionCoach over the tts port)', () => {
  // Live Court is removed from the launch (AGENTS.md) and nothing imports
  // tts.ts today; these pin the behaviour a future caller would inherit.

  it('unavailable engine: cues are still produced for the caption path with spoken=false, nothing thrown', () => {
    const fake = makeFakeNative(new Rng(1), 'ok', 'ok', {
      withSpeak: true,
      withStop: true,
    });
    const { tts } = loadTts('absent', fake);
    const seen: boolean[] = [];
    const coach = new LiveSessionCoach({
      voice: tts,
      onCue: cue => seen.push(cue.spoken),
    });
    expect(coach.voiceAvailable()).toBe(false);
    expect(() => coach.sessionStarted('live')).not.toThrow();
    expect(() => coach.setMuted(true)).not.toThrow();
    expect(() => coach.dispose()).not.toThrow();
    expect(seen).toEqual([false]);
    expect(fake.calls).toEqual([]);
  });

  it('throwing engine: the throw reaches the caller unwrapped (no silent failure) and the bridge is not poisoned', () => {
    const fake = makeFakeNative(new Rng(2), 'throwNth', 'ok', {
      withSpeak: true,
      withStop: true,
    });
    const { tts } = loadTts('full', fake);
    fake.setTts(tts);
    const coach = new LiveSessionCoach({ voice: tts });
    let threw: unknown = null;
    // throwNth with seed 2 resolves to a small n; drive until the throw shows.
    for (let i = 0; i < 6 && threw === null; i += 1) {
      try {
        coach.sessionStarted('live');
      } catch (error) {
        threw = error;
      }
    }
    expect(threw).not.toBeNull();
    expect(fake.lastThrown?.value).toBe(threw);
    const before = fake.calls.length;
    expect(() => tts.speak('after throw')).not.toThrow();
    expect(fake.calls.length).toBe(before + 1);
  });

  it('module object without speak: available()=false yet speak() throws TypeError (KNOWN, not producible by the shipping bridge)', () => {
    const fake = makeFakeNative(new Rng(3), 'ok', 'ok', {
      withSpeak: false,
      withStop: true,
    });
    const { tts } = loadTts('stopOnly', fake);
    expect(tts.available()).toBe(false);
    let outcome = 'ok';
    try {
      tts.speak('Paddle up');
    } catch (error) {
      outcome =
        error instanceof TypeError ? 'TypeError' : describeThrown(error);
    }
    if (RED) {
      expect(outcome).toBe('ok');
    } else {
      expect(['ok', 'TypeError']).toContain(outcome);
    }
  });
});
