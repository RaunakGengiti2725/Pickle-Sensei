import type { StabilityRecorder } from '../../../src/analysis/stabilityTelemetry';
import {
  InvariantViolation,
  runSeed,
  summarize,
  writeCampaignArtifact,
  type SequenceRow,
  type Session,
  type SuiteSpec,
} from '../../../stress-harness/mod-app-root/campaign';
import {
  chunk,
  planCampaign,
  type Rng,
} from '../../../stress-harness/mod-app-root/prng';

/**
 * STRESS `mod-app-root` / lens `randomized-seeded` — index.js entry.
 *
 * Each seeded sequence first draws a launch ENVIRONMENT (release vs __DEV__,
 * ErrorUtils present / missing setGlobalHandler / absent, HermesInternal
 * present / non-function / absent, reportError present / absent), loads the
 * REAL `index.js` in an isolated module registry against that environment,
 * then fires 5..60 random events at what it installed: global JS errors with
 * every flavour of throwable (Errors with/without stacks, strings, null,
 * undefined, numbers, symbols, bigints, functions, circular objects, objects
 * whose `name`/`stack`/`message` getters throw, hostile `isFatal` values),
 * `ErrorUtils.reportError`, unhandled and late-handled promise rejections,
 * and a telemetry recorder that starts throwing mid-sequence.
 *
 * After EVERY event a reference model of index.js predicts what must have
 * happened and the real side effects are compared. Invariants (ids appear in
 * failure rows):
 *
 *  noThrow             loading the entry and every installed callback never
 *                      throws, whatever the environment or payload
 *  registrationOrder   registerBackgroundNotificationHandler runs before
 *                      AppRegistry.registerComponent, which is called exactly
 *                      once with app.json's name and returns App
 *  handlerInstalled    with a usable ErrorUtils the installed handler differs
 *                      from React Native's; otherwise RN's is left untouched
 *  forwardsPrevious    every global error reaches the previous handler
 *                      exactly once with the SAME error reference and isFatal
 *                      value — even when telemetry throws
 *  crashRecorded       one crash event per global error, fatal === (isFatal
 *                      === true), fingerprint is 8 hex chars; none once the
 *                      recorder throws
 *  fingerprintOracle   fingerprint == djb2(`${name}|${topFrame ?? message}`)
 *                      (same top frame ⇒ same fingerprint across messages)
 *  noStackLeak         fingerprint never contains the message, a frame or a
 *                      stack fragment
 *  rejectionTracker    Hermes tracker installed only in Release with a
 *                      usable HermesInternal, with allRejections: true
 *  rejectionRouting    onUnhandled hands an Error (the rejection itself when
 *                      it is one, otherwise a wrapper naming the value) to
 *                      ErrorUtils.reportError → previous handler with
 *                      isFatal=false (+ crash event); without reportError it
 *                      logs via console.error instead
 *  lateHandledLogs     onHandled warns once and never throws
 *  determinism         same seed twice → identical action list and trace
 *
 * `STRESS_ITER=2000 npx jest --ci __tests__/stress/mod-app-root/indexGlobal`
 * runs the full campaign; `STRESS_SEED=<seed>` replays one row.
 */

jest.mock('react-native', () => ({
  AppRegistry: { registerComponent: jest.fn() },
}));
jest.mock('../../../App', () => ({
  __esModule: true,
  default: function StubApp() {
    return null;
  },
}));
jest.mock('../../../src/notifications/service', () => ({
  registerBackgroundNotificationHandler: jest.fn(),
}));

import { AppRegistry } from 'react-native';
import App from '../../../App';
import { name as appName } from '../../../app.json';
import { registerBackgroundNotificationHandler } from '../../../src/notifications/service';

type Handler = (error: unknown, isFatal?: unknown) => void;
interface ErrorUtilsShape {
  getGlobalHandler(): Handler;
  setGlobalHandler(handler: Handler): void;
  reportError(error: unknown): void;
}
interface RejectionTrackerOptions {
  allRejections: boolean;
  onUnhandled: (id: number, rejection: unknown) => void;
  onHandled: (id: number) => void;
}
interface HermesShape {
  enablePromiseRejectionTracker?: unknown;
}

const mutableGlobal = globalThis as unknown as {
  __DEV__: boolean;
  ErrorUtils?: Partial<ErrorUtilsShape>;
  HermesInternal?: HermesShape;
};

const ORIGINAL = {
  dev: mutableGlobal.__DEV__,
  errorUtils: mutableGlobal.ErrorUtils,
  hermes: mutableGlobal.HermesInternal,
};

// ─── Environment + action vocabulary ────────────────────────────────────────

type ErrorUtilsMode =
  'full' | 'noReportError' | 'noSetGlobalHandler' | 'absent';
type HermesMode = 'present' | 'nonFunction' | 'absent';

interface Env {
  dev: boolean;
  errorUtils: ErrorUtilsMode;
  hermes: HermesMode;
}

type Payload =
  | { kind: 'errorWithStack'; name: string; message: string; frame: string }
  | { kind: 'errorNoStack'; name: string; message: string }
  | { kind: 'errorEmptyName'; message: string; frame: string }
  | { kind: 'errorNonStringName'; message: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'null' }
  | { kind: 'undefined' }
  | { kind: 'symbol' }
  | { kind: 'bigint' }
  | { kind: 'function' }
  | { kind: 'plainObject'; message: string | null }
  | { kind: 'circular' }
  | { kind: 'throwingGetters'; which: ('name' | 'stack' | 'message')[] }
  | { kind: 'nullPrototype'; message: string };

type FatalFlag = true | false | 'undefined' | 'truthyString' | 'one' | 'null';

type Action =
  | { kind: 'load'; env: Env }
  | { kind: 'globalError'; payload: Payload; fatal: FatalFlag }
  | { kind: 'reportError'; payload: Payload }
  | { kind: 'unhandledRejection'; id: number; payload: Payload }
  | { kind: 'handledLate'; id: number }
  | { kind: 'telemetryThrows'; on: boolean };

const NAMES = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'Custom'];
const MESSAGES = [
  'boom',
  'Cannot read properties of undefined',
  'Network request failed',
  '',
  'unicode ✓ ünïcödé 🥒',
  'a'.repeat(300),
];
const FRAMES = [
  'tap (index.bundle:1:100)',
  'render (index.bundle:1:200)',
  'sync (index.bundle:1:300)',
  'anonymous (native)',
  '<anonymous>',
];

function drawPayload(rng: Rng): Payload {
  return rng.weighted<Payload>(
    [
      {
        kind: 'errorWithStack',
        name: rng.pick(NAMES),
        message: rng.pick(MESSAGES),
        frame: rng.pick(FRAMES),
      },
      {
        kind: 'errorNoStack',
        name: rng.pick(NAMES),
        message: rng.pick(MESSAGES),
      },
      {
        kind: 'errorEmptyName',
        message: rng.pick(MESSAGES),
        frame: rng.pick(FRAMES),
      },
      { kind: 'errorNonStringName', message: rng.pick(MESSAGES) },
      { kind: 'string', value: rng.pick(MESSAGES) },
      { kind: 'number', value: rng.pick([0, -1, 42, Number.NaN, Infinity]) },
      { kind: 'null' },
      { kind: 'undefined' },
      { kind: 'symbol' },
      { kind: 'bigint' },
      { kind: 'function' },
      {
        kind: 'plainObject',
        message: rng.chance(0.5) ? rng.pick(MESSAGES) : null,
      },
      { kind: 'circular' },
      {
        kind: 'throwingGetters',
        which: rng.pick([
          ['stack'],
          ['name'],
          ['message'],
          ['name', 'stack'],
          ['name', 'stack', 'message'],
        ]),
      },
      { kind: 'nullPrototype', message: rng.pick(MESSAGES) },
    ],
    [10, 4, 2, 2, 4, 2, 2, 2, 1, 1, 1, 3, 2, 3, 1],
  );
}

function drawEnv(rng: Rng): Env {
  return {
    dev: rng.chance(0.3),
    errorUtils: rng.weighted<ErrorUtilsMode>(
      ['full', 'noReportError', 'noSetGlobalHandler', 'absent'],
      [7, 2, 1, 1],
    ),
    hermes: rng.weighted<HermesMode>(
      ['present', 'nonFunction', 'absent'],
      [7, 1, 2],
    ),
  };
}

interface Model {
  loaded: Env | null;
  handlerInstalled: boolean;
  trackerInstalled: boolean;
  telemetryThrows: boolean;
  expectedPrevious: { error: unknown; isFatal: unknown }[];
  expectedCrash: { fatal: boolean; fingerprint: string }[];
  expectedConsoleErrors: number;
  expectedWarns: number;
}

function initialModel(): Model {
  return {
    loaded: null,
    handlerInstalled: false,
    trackerInstalled: false,
    telemetryThrows: false,
    expectedPrevious: [],
    expectedCrash: [],
    expectedConsoleErrors: 0,
    expectedWarns: 0,
  };
}

function draw(rng: Rng, m: Model, i: number): Action {
  if (i === 0 || !m.loaded) return { kind: 'load', env: drawEnv(rng) };
  const candidates: Action[] = [];
  const weights: number[] = [];
  const add = (a: Action, w: number) => {
    candidates.push(a);
    weights.push(w);
  };
  const fatal = rng.weighted<FatalFlag>(
    [true, false, 'undefined', 'truthyString', 'one', 'null'],
    [5, 5, 2, 1, 1, 1],
  );
  if (m.loaded.errorUtils !== 'absent') {
    add({ kind: 'globalError', payload: drawPayload(rng), fatal }, 10);
    if (m.loaded.errorUtils === 'full') {
      add({ kind: 'reportError', payload: drawPayload(rng) }, 3);
    }
  }
  if (m.trackerInstalled) {
    add(
      {
        kind: 'unhandledRejection',
        id: rng.int(0, 99),
        payload: drawPayload(rng),
      },
      6,
    );
    add({ kind: 'handledLate', id: rng.int(0, 99) }, 2);
  }
  add({ kind: 'telemetryThrows', on: !m.telemetryThrows }, 1);
  if (candidates.length === 0) {
    // Nothing installed in this environment: the only remaining legal event
    // is a raw error reaching whatever ErrorUtils exists (or nothing).
    add({ kind: 'globalError', payload: drawPayload(rng), fatal }, 1);
  }
  return rng.weighted(candidates, weights);
}

// ─── Oracle (documented fingerprint rule, re-derived independently) ─────────

function djb2(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 33 + text.charCodeAt(i)) % 4294967296;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Fingerprint index.js is documented to produce for a throwable. */
function oracleFingerprint(error: unknown): string {
  const isObject = typeof error === 'object' && error !== null;
  let name = 'Error';
  let stack = '';
  let message: string;
  const record = error as Record<string, unknown>;
  if (isObject) {
    const n = record.name;
    if (typeof n === 'string' && n !== '') name = n;
    const s = record.stack;
    if (typeof s === 'string') stack = s;
    const msg = record.message;
    message = String(msg ?? '');
  } else {
    message = String(error);
  }
  const topFrame = stack
    .split('\n')
    .map(line => line.trim())
    .find(line => line.startsWith('at '));
  return djb2(`${name}|${topFrame ?? message}`);
}

/** Does reading name/stack/message throw? Then index.js cannot record. */
function payloadIsHostile(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  try {
    const record = error as Record<string, unknown>;
    const probe = [record.name, record.stack, record.message];
    return probe.length !== 3;
  } catch {
    return true;
  }
}

// ─── Materialising payloads ─────────────────────────────────────────────────

function materialize(payload: Payload): unknown {
  switch (payload.kind) {
    case 'errorWithStack': {
      const error = new Error(payload.message);
      error.name = payload.name;
      error.stack = `${payload.name}: ${payload.message}\n    at ${payload.frame}\n    at second (index.bundle:1:999)`;
      return error;
    }
    case 'errorNoStack': {
      const error = new Error(payload.message);
      error.name = payload.name;
      error.stack = undefined;
      return error;
    }
    case 'errorEmptyName': {
      const error = new Error(payload.message);
      error.name = '';
      error.stack = `: ${payload.message}\n    at ${payload.frame}`;
      return error;
    }
    case 'errorNonStringName': {
      const error = new Error(payload.message);
      (error as unknown as { name: unknown }).name = 42;
      error.stack = 'no frames here';
      return error;
    }
    case 'string':
      return payload.value;
    case 'number':
      return payload.value;
    case 'null':
      return null;
    case 'undefined':
      return undefined;
    case 'symbol':
      return Symbol('stress');
    case 'bigint':
      return BigInt(7);
    case 'function':
      return function thrower() {};
    case 'plainObject':
      return payload.message === null ? {} : { message: payload.message };
    case 'circular': {
      const node: { self?: unknown; message: string } = { message: 'loop' };
      node.self = node;
      return node;
    }
    case 'throwingGetters': {
      const hostile: Record<string, unknown> = {};
      for (const key of payload.which) {
        Object.defineProperty(hostile, key, {
          get() {
            throw new Error(`no ${key} for you`);
          },
        });
      }
      return hostile;
    }
    case 'nullPrototype': {
      const bare = Object.create(null) as Record<string, unknown>;
      bare.message = payload.message;
      return bare;
    }
  }
}

function fatalValue(flag: FatalFlag): unknown {
  switch (flag) {
    case true:
      return true;
    case false:
      return false;
    case 'undefined':
      return undefined;
    case 'truthyString':
      return 'yes';
    case 'one':
      return 1;
    case 'null':
      return null;
  }
}

// ─── Session ────────────────────────────────────────────────────────────────

interface Observation {
  step: string;
  previousCalls: number;
  crashEvents: number;
  handlerInstalled: boolean;
  trackerInstalled: boolean;
  consoleErrors: number;
  warns: number;
}

function fail(invariant: string, detail: string): never {
  throw new InvariantViolation(invariant, detail);
}

const registerComponent = AppRegistry.registerComponent as jest.Mock;
const registerBackground = registerBackgroundNotificationHandler as jest.Mock;

class EntrySession implements Session<Action, Observation> {
  private previous = jest.fn<void, [unknown, unknown]>();
  private errorUtils: Partial<ErrorUtilsShape> | undefined;
  private hermes: HermesShape | undefined;
  private trackerCalls: RejectionTrackerOptions[] = [];
  private stabilitySlo: StabilityRecorder | null = null;
  private recordSpy: jest.SpyInstance | null = null;
  private readonly consoleError = jest
    .spyOn(console, 'error')
    .mockImplementation(() => {});
  private readonly consoleWarn = jest
    .spyOn(console, 'warn')
    .mockImplementation(() => {});

  constructor(private readonly m: Model) {
    registerComponent.mockClear();
    registerBackground.mockClear();
  }

  private installEnv(env: Env): void {
    mutableGlobal.__DEV__ = env.dev;
    this.previous = jest.fn<void, [unknown, unknown]>();
    let handler: Handler = this.previous;
    const base: ErrorUtilsShape = {
      getGlobalHandler: () => handler,
      setGlobalHandler: next => {
        handler = next;
      },
      reportError: error => handler(error, false),
    };
    switch (env.errorUtils) {
      case 'full':
        this.errorUtils = base;
        break;
      case 'noReportError':
        this.errorUtils = {
          getGlobalHandler: base.getGlobalHandler,
          setGlobalHandler: base.setGlobalHandler,
        };
        break;
      case 'noSetGlobalHandler':
        this.errorUtils = { getGlobalHandler: base.getGlobalHandler };
        break;
      case 'absent':
        this.errorUtils = undefined;
        break;
    }
    this.trackerCalls = [];
    switch (env.hermes) {
      case 'present':
        this.hermes = {
          enablePromiseRejectionTracker: (options: RejectionTrackerOptions) => {
            this.trackerCalls.push(options);
          },
        };
        break;
      case 'nonFunction':
        this.hermes = { enablePromiseRejectionTracker: 'not-a-function' };
        break;
      case 'absent':
        this.hermes = undefined;
        break;
    }
    if (this.errorUtils) mutableGlobal.ErrorUtils = this.errorUtils;
    else delete mutableGlobal.ErrorUtils;
    if (this.hermes) mutableGlobal.HermesInternal = this.hermes;
    else delete mutableGlobal.HermesInternal;
  }

  private installedHandler(): Handler | null {
    const get = this.errorUtils?.getGlobalHandler;
    return get ? get() : null;
  }

  private tracker(): RejectionTrackerOptions | null {
    return this.trackerCalls[this.trackerCalls.length - 1] ?? null;
  }

  private expectCrashFor(error: unknown, isFatal: unknown): void {
    const m = this.m;
    if (m.telemetryThrows || payloadIsHostile(error)) return;
    m.expectedCrash.push({
      fatal: isFatal === true,
      fingerprint: oracleFingerprint(error),
    });
  }

  step(action: Action): Observation {
    const m = this.m;
    switch (action.kind) {
      case 'load': {
        this.installEnv(action.env);
        jest.isolateModules(() => {
          jest.requireActual('../../../index.js');
          this.stabilitySlo = jest.requireActual<
            typeof import('../../../src/analysis/stabilityTelemetry')
          >('../../../src/analysis/stabilityTelemetry').stabilitySlo;
        });
        m.loaded = action.env;
        m.telemetryThrows = false;
        m.expectedPrevious = [];
        m.expectedCrash = [];
        m.expectedConsoleErrors = 0;
        m.expectedWarns = 0;
        m.handlerInstalled =
          action.env.errorUtils === 'full' ||
          action.env.errorUtils === 'noReportError';
        m.trackerInstalled = !action.env.dev && action.env.hermes === 'present';
        this.checkRegistration(action.env);
        break;
      }
      case 'globalError': {
        const error = materialize(action.payload);
        const isFatal = fatalValue(action.fatal);
        const handler = this.installedHandler();
        if (!handler) {
          // No ErrorUtils at all: nothing to fire; index.js must simply have
          // left the environment alone (checked at load).
          break;
        }
        handler(error, isFatal);
        m.expectedPrevious.push({ error, isFatal });
        if (m.handlerInstalled) this.expectCrashFor(error, isFatal);
        break;
      }
      case 'reportError': {
        const report = this.errorUtils?.reportError;
        if (!report) break;
        const error = materialize(action.payload);
        report(error);
        m.expectedPrevious.push({ error, isFatal: false });
        if (m.handlerInstalled) this.expectCrashFor(error, false);
        break;
      }
      case 'unhandledRejection': {
        const tracker = this.tracker();
        if (!tracker) break;
        const rejection = materialize(action.payload);
        tracker.onUnhandled(action.id, rejection);
        if (this.errorUtils?.reportError) {
          const forwarded =
            this.previous.mock.calls[this.previous.mock.calls.length - 1];
          const [error, isFatal] = forwarded ?? [undefined, undefined];
          if (!(error instanceof Error) || isFatal !== false) {
            fail(
              'rejectionRouting',
              `onUnhandled(${action.payload.kind}) forwarded ${String(error)} / isFatal=${String(isFatal)}`,
            );
          }
          if (rejection instanceof Error && error !== rejection) {
            fail(
              'rejectionRouting',
              'Error rejection was wrapped instead of forwarded',
            );
          }
          if (!(rejection instanceof Error)) {
            if (!error.message.startsWith('Unhandled promise rejection:')) {
              fail(
                'rejectionRouting',
                `wrapper message ${JSON.stringify(error.message)}`,
              );
            }
            if (
              action.payload.kind === 'string' &&
              !error.message.includes(action.payload.value)
            ) {
              fail('rejectionRouting', 'wrapper dropped the rejected string');
            }
          }
          m.expectedPrevious.push({ error, isFatal: false });
          if (m.handlerInstalled) this.expectCrashFor(error, false);
        } else {
          m.expectedConsoleErrors += 1;
        }
        break;
      }
      case 'handledLate': {
        const tracker = this.tracker();
        if (!tracker) break;
        tracker.onHandled(action.id);
        m.expectedWarns += 1;
        break;
      }
      case 'telemetryThrows': {
        if (!this.stabilitySlo) break;
        m.telemetryThrows = action.on;
        this.recordSpy?.mockRestore();
        this.recordSpy = null;
        if (action.on) {
          this.recordSpy = jest
            .spyOn(this.stabilitySlo, 'record')
            .mockImplementation(() => {
              throw new Error('telemetry sink offline');
            });
        }
        break;
      }
    }
    const observation = this.observe(action);
    this.check(observation, action);
    return observation;
  }

  private checkRegistration(env: Env): void {
    if (registerBackground.mock.calls.length !== 1) {
      fail(
        'registrationOrder',
        `background handler registered ${registerBackground.mock.calls.length}×`,
      );
    }
    if (registerComponent.mock.calls.length !== 1) {
      fail(
        'registrationOrder',
        `registerComponent called ${registerComponent.mock.calls.length}×`,
      );
    }
    const bgOrder = registerBackground.mock.invocationCallOrder[0] ?? 0;
    const regOrder = registerComponent.mock.invocationCallOrder[0] ?? 0;
    if (!(bgOrder < regOrder)) {
      fail(
        'registrationOrder',
        'registerComponent ran before the background handler',
      );
    }
    const [registeredName, factory] = registerComponent.mock.calls[0] as [
      string,
      () => unknown,
    ];
    if (registeredName !== appName || factory() !== App) {
      fail(
        'registrationOrder',
        `registered ${registeredName} → ${String(factory())}`,
      );
    }
    const installed = this.installedHandler();
    if (env.errorUtils === 'full' || env.errorUtils === 'noReportError') {
      if (installed === this.previous)
        fail('handlerInstalled', 'global handler not replaced');
    } else if (
      env.errorUtils === 'noSetGlobalHandler' &&
      installed !== this.previous
    ) {
      fail('handlerInstalled', 'handler replaced without setGlobalHandler');
    }
    const trackerExpected = !env.dev && env.hermes === 'present';
    if (
      (this.trackerCalls.length === 1) !== trackerExpected ||
      this.trackerCalls.length > 1
    ) {
      fail(
        'rejectionTracker',
        `tracker installed ${this.trackerCalls.length}× for dev=${env.dev} hermes=${env.hermes}`,
      );
    }
    if (trackerExpected && this.trackerCalls[0]?.allRejections !== true) {
      fail('rejectionTracker', 'tracker not configured for all rejections');
    }
  }

  private observe(action: Action): Observation {
    const events = this.stabilitySlo?.events() ?? [];
    return {
      step: action.kind,
      previousCalls: this.previous.mock.calls.length,
      crashEvents: events.filter(e => e.kind === 'crash').length,
      handlerInstalled:
        this.installedHandler() !== this.previous &&
        this.installedHandler() !== null,
      trackerInstalled: this.trackerCalls.length === 1,
      consoleErrors: this.consoleError.mock.calls.length,
      warns: this.consoleWarn.mock.calls.length,
    };
  }

  private check(o: Observation, action: Action): void {
    const m = this.m;
    if (o.previousCalls !== m.expectedPrevious.length) {
      fail(
        'forwardsPrevious',
        `after ${action.kind}: previous handler called ${o.previousCalls}×, expected ${m.expectedPrevious.length}`,
      );
    }
    m.expectedPrevious.forEach((expected, index) => {
      const call = this.previous.mock.calls[index];
      if (
        !call ||
        !Object.is(call[0], expected.error) ||
        !Object.is(call[1], expected.isFatal)
      ) {
        fail(
          'forwardsPrevious',
          `call ${index}: got (${String(call?.[0])}, ${String(call?.[1])}), expected (${String(expected.error)}, ${String(expected.isFatal)})`,
        );
      }
    });
    if (o.handlerInstalled !== m.handlerInstalled) {
      fail(
        'handlerInstalled',
        `installed=${o.handlerInstalled}, model ${m.handlerInstalled}`,
      );
    }
    if (o.trackerInstalled !== m.trackerInstalled) {
      fail(
        'rejectionTracker',
        `tracker=${o.trackerInstalled}, model ${m.trackerInstalled}`,
      );
    }
    const crashes = (this.stabilitySlo?.events() ?? []).filter(
      (e): e is Extract<typeof e, { kind: 'crash' }> => e.kind === 'crash',
    );
    if (crashes.length !== m.expectedCrash.length) {
      fail(
        'crashRecorded',
        `after ${action.kind}: ${crashes.length} crash events, expected ${m.expectedCrash.length}`,
      );
    }
    m.expectedCrash.forEach((expected, index) => {
      const event = crashes[index]!;
      if (event.fatal !== expected.fatal) {
        fail(
          'crashRecorded',
          `event ${index}: fatal=${event.fatal}, expected ${expected.fatal}`,
        );
      }
      if (!/^[0-9a-f]{8}$/.test(event.fingerprint)) {
        fail(
          'crashRecorded',
          `event ${index}: fingerprint ${event.fingerprint}`,
        );
      }
      if (event.fingerprint !== expected.fingerprint) {
        fail(
          'fingerprintOracle',
          `event ${index}: fingerprint ${event.fingerprint} ≠ oracle ${expected.fingerprint}`,
        );
      }
    });
    // Leak check on the last recorded event vs. the payload that produced it.
    if (
      (action.kind === 'globalError' || action.kind === 'reportError') &&
      crashes.length > 0
    ) {
      const fingerprint = crashes[crashes.length - 1]!.fingerprint;
      const fragments: string[] = [];
      const p = action.payload;
      if (
        'message' in p &&
        typeof p.message === 'string' &&
        p.message.length >= 4
      ) {
        fragments.push(p.message.slice(0, 4));
      }
      if ('frame' in p)
        fragments.push(p.frame.slice(0, 4), 'index.bundle', 'at ');
      if ('value' in p && typeof p.value === 'string' && p.value.length >= 4) {
        fragments.push(p.value.slice(0, 4));
      }
      for (const fragment of fragments) {
        if (fragment && fingerprint.includes(fragment)) {
          fail(
            'noStackLeak',
            `fingerprint ${fingerprint} contains ${JSON.stringify(fragment)}`,
          );
        }
      }
    }
    if (o.consoleErrors !== m.expectedConsoleErrors) {
      fail(
        'rejectionRouting',
        `console.error called ${o.consoleErrors}×, expected ${m.expectedConsoleErrors}`,
      );
    }
    if (o.warns !== m.expectedWarns) {
      fail(
        'lateHandledLogs',
        `console.warn called ${o.warns}×, expected ${m.expectedWarns}`,
      );
    }
  }

  close(): void {
    this.recordSpy?.mockRestore();
    this.consoleError.mockRestore();
    this.consoleWarn.mockRestore();
    mutableGlobal.__DEV__ = ORIGINAL.dev;
    if (ORIGINAL.errorUtils) mutableGlobal.ErrorUtils = ORIGINAL.errorUtils;
    else delete mutableGlobal.ErrorUtils;
    if (ORIGINAL.hermes) mutableGlobal.HermesInternal = ORIGINAL.hermes;
    else delete mutableGlobal.HermesInternal;
  }
}

const spec: SuiteSpec<Action, Observation, Model> = {
  name: 'indexGlobalErrors.randomizedSeeded',
  initialModel,
  draw,
  open: model => new EntrySession(model),
  observationKey: o =>
    `${o.step}${o.handlerInstalled ? '' : '/noHandler'}${o.trackerInstalled ? '/tracker' : ''}`,
};

const INVARIANTS = [
  'noThrow',
  'registrationOrder',
  'handlerInstalled',
  'forwardsPrevious',
  'crashRecorded',
  'fingerprintOracle',
  'noStackLeak',
  'rejectionTracker',
  'rejectionRouting',
  'lateHandledLogs',
  'determinism',
] as const;

const plan = planCampaign(40);
const rows: SequenceRow<Action, Observation>[] = [];

afterAll(() => {
  const summary = summarize(spec.name, rows, INVARIANTS, a => a.kind);
  writeCampaignArtifact(summary);
});

describe('index.js entry — seeded randomized global error sequences', () => {
  const chunks = chunk(plan.seeds, 100);
  if (chunks.length === 0) {
    it('runs no sequences when STRESS_ITER=0', () => {
      expect(plan.seeds).toHaveLength(0);
    });
  }
  it.each(chunks.map((seeds, index) => [index, seeds] as const))(
    'chunk %i holds every invariant',
    (_index, seeds) => {
      const failures: string[] = [];
      for (const seed of seeds) {
        const row = runSeed(spec, seed, {
          minLen: plan.minLen,
          maxLen: plan.maxLen,
          determinism: true,
          keepTrace: plan.replayOnly !== null,
        });
        rows.push(row);
        if (row.outcome !== 'HELD') {
          failures.push(
            `seed ${row.seed}: ${row.outcome} ${row.invariant} — ${row.error} (minimized to ${row.minimized?.steps ?? '?'} steps)`,
          );
        }
      }
      expect(failures).toEqual([]);
    },
    240_000,
  );
});
