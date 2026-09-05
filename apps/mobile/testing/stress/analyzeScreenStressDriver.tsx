import React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { RootNavigator } from '../../src/navigation/RootNavigator';
import { currentRouteName, liveNavigationRef } from './navigationRefCapture';
import { AnalyzeScreen } from '../../src/screens/AnalyzeScreen';
import { getDb } from '../../src/data/db';
import {
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
  bearerTokenFor,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import { createCanonicalAccessClient } from '../../src/billing/accessApi';
import type {
  BillingStoreClient,
  StoreEntitlementState,
  StorePlans,
} from '../../src/billing/types';
import {
  clearSyncRuntime,
  configureSyncRuntime,
} from '../../src/data/syncRuntime';
import { clearTryAgainHandoff } from '../../src/screens/tryAgainHandoff';
import { usabilityFunnel } from '../../src/analysis/usabilityTelemetry';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import type { CameraEvent } from '../../src/camera/capture';
import { mulberry32, type SeededRng } from './seededRng';
import {
  FakeVideoCaptureBridge,
  installFakeVideoCaptureBridge,
  typedCameraCancel,
} from './fakeVideoCaptureBridge';
import { FakeRatingServer } from './fakeRatingServer';
import {
  GUIDED_CLIP_VARIANTS,
  IMPORTED_CLIP_VARIANTS,
  clipVariantHasPose,
  importedPoseExtractionError,
  importedPoseExtractionReceipt,
  nativeClipPayload,
  type ExtractionFailure,
  type NativeClipVariant,
} from './clipFixtures';
import { countRows, selectRows } from './sqliteMemory';

/**
 * Seeded randomized driver for `AnalyzeScreen` mounted through the PRODUCTION
 * `RootNavigator` (real NavigationContainer, native-stack + tab navigators,
 * `AnalyzeRoute` access gate, zustand stores, sync runtime, SQLite-backed
 * repository). Only the native camera bridge, the SQLite JSI binding, the
 * network (`fetch`) and sibling screens are replaced.
 *
 * A sequence is a list of actions drawn from the screen's PUBLIC surface —
 * things a user, the native camera, the network or the clock can do — and
 * the invariant model (see `checkInvariants`) is evaluated after EVERY
 * action. Everything random flows through one mulberry32 stream seeded per
 * sequence (including `Math.random` and `crypto.getRandomValues`, so
 * production uuids replay too), and the clock is Jest's fake clock, so a
 * seed reproduces its trace exactly.
 */

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type StressAction =
  | { kind: 'home.startCamera' }
  | { kind: 'home.startLibrary' }
  | { kind: 'tap'; label: string }
  | { kind: 'tapTwice'; label: string }
  | { kind: 'tapBlind'; label: string }
  | { kind: 'typeIntent'; text: string; submit: boolean }
  | { kind: 'native.resolve'; variant: NativeClipVariant }
  | { kind: 'native.rejectTyped' }
  | { kind: 'native.rejectText' }
  | { kind: 'native.rejectError' }
  | { kind: 'native.extract.resolve'; preset: 'textbook' | 'cramped' }
  | { kind: 'native.extract.reject'; failure: ExtractionFailure }
  | { kind: 'native.event'; event: 'framing' | 'ready' | 'recording' | 'lost' }
  /** Near-legal: a camera event arriving AFTER the native operation settled. */
  | {
      kind: 'native.lateEvent';
      event: 'framing' | 'ready' | 'recording' | 'lost';
    }
  | {
      kind: 'server.hold';
      target: 'reserve' | 'finalize' | 'sync' | 'access' | 'all';
    }
  | { kind: 'server.release' }
  | { kind: 'server.offline' }
  | { kind: 'server.online' }
  | { kind: 'settle'; ms: number }
  | { kind: 'flush' }
  | { kind: 'nav.back' };

export function describeAction(action: StressAction): string {
  switch (action.kind) {
    case 'tap':
    case 'tapTwice':
    case 'tapBlind':
      return `${action.kind}:${action.label}`;
    case 'typeIntent':
      return `typeIntent:${JSON.stringify(action.text)}${action.submit ? '+submit' : ''}`;
    case 'native.resolve':
      return `native.resolve:${action.variant}`;
    case 'native.extract.resolve':
      return `native.extract.resolve:${action.preset}`;
    case 'native.extract.reject':
      return `native.extract.reject:${action.failure}`;
    case 'native.event':
      return `native.event:${action.event}`;
    case 'native.lateEvent':
      return `native.lateEvent:${action.event}`;
    case 'server.hold':
      return `server.hold:${action.target}`;
    case 'settle':
      return `settle:${action.ms}`;
    default:
      return action.kind;
  }
}

// ---------------------------------------------------------------------------
// Surface (what the rendered tree shows)
// ---------------------------------------------------------------------------

export type Phase =
  | 'ready'
  | 'working'
  | 'saved'
  | 'analyzed'
  | 'error'
  | 'free_limit'
  | 'gate'
  | 'unmounted';

export interface Pressable {
  label: string;
  disabled: boolean;
  press(): void;
  /** `onLayout` of the same node, when it has one (TargetSelector frame). */
  layout?: (width: number, height: number) => void;
}

export interface Surface {
  route: string;
  analyzeMounted: boolean;
  /** Phase of every mounted `AnalyzeScreen`, bottom of the stack first. */
  instances: Phase[];
  /** `AnalyzeRoute` gates currently showing "Checking access…". */
  gates: number;
  /** Phase of the topmost instance (`gate`/`unmounted` when none). */
  phase: Phase;
  /** Enabled, user-reachable pressable labels, sorted. */
  enabled: string[];
  /** Disabled (or reachable-only-in-a-hidden-screen) labels, sorted. */
  disabled: string[];
  /** Labels rendered only inside unfocused screens (never tappable). */
  hidden: string[];
  /** Every rendered string, joined — the determinism digest input. */
  text: string;
  pressables: Map<string, Pressable>;
}

const MASCOT_PHASE: Record<string, Phase> = {
  'analysis-mascot-ready': 'ready',
  'analysis-mascot-working': 'working',
  'analysis-mascot-saved': 'saved',
  'analysis-mascot-outcome': 'analyzed',
  'analysis-mascot-error': 'error',
  'analysis-mascot-free-limit': 'free_limit',
};

function walk(node: ReactTestInstance, visit: (n: ReactTestInstance) => void) {
  visit(node);
  for (const child of node.children) {
    if (typeof child !== 'string') walk(child, visit);
  }
}

/**
 * True for a subtree a user cannot reach: an unfocused native-stack item
 * (`aria-hidden`), a detached/inactive screen (`activityState`/`active` 0)
 * or a tab kept mounted with `display: 'none'` (ResourceSavingView).
 */
function hidesSubtree(node: ReactTestInstance): boolean {
  const props = node.props as {
    'aria-hidden'?: unknown;
    activityState?: unknown;
    active?: unknown;
    style?: unknown;
  };
  if (props['aria-hidden'] === true) return true;
  if (props.activityState === 0 || props.active === 0) return true;
  const style = StyleSheet.flatten(props.style as StyleProp<ViewStyle>);
  return style?.display === 'none';
}

/** `walk` that also reports whether each node sits inside a hidden subtree. */
function walkVisible(
  node: ReactTestInstance,
  visit: (n: ReactTestInstance, hidden: boolean) => void,
  hidden = false,
) {
  const nowHidden = hidden || hidesSubtree(node);
  visit(node, nowHidden);
  for (const child of node.children) {
    if (typeof child !== 'string') walkVisible(child, visit, nowHidden);
  }
}

/** A real press always carries a native event (TargetSelector reads it). */
export function syntheticPressEvent(locationX = 120, locationY = 160) {
  return {
    nativeEvent: {
      locationX,
      locationY,
      pageX: locationX,
      pageY: locationY,
      timestamp: Date.now(),
    },
  };
}

function stringsUnder(
  node: ReactTestInstance,
  out: string[],
  limit: number,
): void {
  for (const child of node.children) {
    if (out.length >= limit) return;
    if (typeof child === 'string') out.push(child);
    else stringsUnder(child, out, limit);
  }
}

/** Phase of ONE mounted `AnalyzeScreen` instance, read from its subtree. */
function instancePhase(instance: ReactTestInstance): Phase {
  let phase: Phase | null = null;
  walk(instance, node => {
    const testID = (node.props as { testID?: unknown }).testID;
    if (typeof testID === 'string' && MASCOT_PHASE[testID])
      phase = MASCOT_PHASE[testID]!;
  });
  // Only the analyzing render (`StrokeResultAnalyzing`) has no mascot.
  return phase ?? 'working';
}

export function readSurface(renderer: ReactTestRenderer): Surface {
  const root = renderer.root;
  const texts: string[] = [];
  const instances: Phase[] = [];
  let gates = 0;
  const pressables = new Map<string, Pressable>();
  const disabledLabels = new Set<string>();

  const hiddenLabels = new Set<string>();
  walkVisible(root, (node, hidden) => {
    if (node.type === AnalyzeScreen) instances.push(instancePhase(node));
    const props = node.props as {
      accessibilityLabel?: unknown;
      onPress?: unknown;
      onLayout?: unknown;
      disabled?: unknown;
      accessibilityState?: { disabled?: unknown };
      children?: unknown;
    };
    for (const child of node.children) {
      if (typeof child === 'string') {
        texts.push(child);
        if (child === 'Checking access…') gates += 1;
      }
    }
    if (typeof props.onPress !== 'function') return;
    const onPress = props.onPress as (event: unknown) => void;
    const disabled =
      props.disabled === true || props.accessibilityState?.disabled === true;
    const labels: string[] = [];
    if (typeof props.accessibilityLabel === 'string')
      labels.push(props.accessibilityLabel);
    const inner: string[] = [];
    stringsUnder(node, inner, 4);
    if (inner.length <= 3) labels.push(...inner);
    let layout: Pressable['layout'];
    const frame = node.children.find(
      c =>
        typeof c !== 'string' &&
        typeof (c.props as { onLayout?: unknown }).onLayout === 'function',
    );
    if (frame && typeof frame !== 'string') {
      const onLayout = (frame.props as { onLayout: (e: unknown) => void })
        .onLayout;
      layout = (width, height) =>
        onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height } } });
    }
    for (const label of labels) {
      if (!label.trim()) continue;
      if (hidden) {
        hiddenLabels.add(label);
        continue;
      }
      const existing = pressables.get(label);
      // Deepest node wins (a design-system Button wraps a Pressable that
      // wraps a host view); disabled anywhere in the chain disables the tap.
      pressables.set(label, {
        label,
        disabled: disabled || existing?.disabled === true,
        press: () => onPress(syntheticPressEvent()),
        ...(layout
          ? { layout }
          : existing?.layout
            ? { layout: existing.layout }
            : {}),
      });
      if (disabled) disabledLabels.add(label);
    }
  });

  const analyzeMounted = instances.length > 0;
  // Tree order follows stack order, so the LAST instance is the topmost.
  const phase: Phase = analyzeMounted
    ? instances[instances.length - 1]!
    : gates > 0
      ? 'gate'
      : 'unmounted';

  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const [label, p] of pressables) {
    (p.disabled ? disabled : enabled).push(label);
  }
  enabled.sort();
  disabled.sort();
  const hidden = [...hiddenLabels].filter(l => !pressables.has(l)).sort();
  return {
    route: currentRouteName(),
    analyzeMounted,
    instances,
    gates,
    phase,
    enabled,
    disabled,
    hidden,
    text: texts.join('\u241f'),
    pressables,
  };
}

// ---------------------------------------------------------------------------
// Trace & invariants
// ---------------------------------------------------------------------------

export interface TraceStep {
  index: number;
  action: string;
  route: string;
  phase: Phase;
  instances: Phase[];
  enabled: string[];
  textDigest: string;
  bridge: {
    pending: number;
    capture: number;
    importVideo: number;
    cancel: number;
  };
  server: {
    reserve: number;
    refused: number;
    finalize: number;
    shotSync: number;
    accepted: number;
    rejected: number;
    accessGet: number;
    held: number;
  };
  db: { captures: number; shots: number; outbox: number };
  violations: string[];
  consoleErrors: string[];
}

export interface SequenceOptions {
  premium: boolean;
  /** Free ratings already consumed on the server before the sequence. */
  preUsed: 0 | 1 | 2;
}

export interface SequenceResult {
  seed: number;
  length: number;
  options: SequenceOptions;
  actions: string[];
  trace: TraceStep[];
  violations: string[];
  crashed: string | null;
  /** Compact fingerprint of the whole trace for determinism checks. */
  fingerprint: string;
  outcomes: {
    scored: number;
    permitsReserved: number;
    resultRoutes: number;
    freeLimitShown: boolean;
    errorsShown: number;
    typedCancels: number;
  };
}

/** `getCurrentRoute()` reports the focused TAB inside `Tabs`, not `Tabs`. */
function isTabRoute(route: string): boolean {
  return (
    route === 'Tabs' ||
    route === 'Home' ||
    route === 'Library' ||
    route === 'Performance' ||
    route === 'Settings'
  );
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const API_BASE_URL = 'https://stress.invalid/functions/v1/api';
const CANONICAL_APP_USER_ID = '22222222-2222-4222-8222-222222222222';

// Saved-phase StrokeDeclaration labels plus ready-phase technique chips.
const STROKE_LABELS = [
  'Serve',
  'Return',
  'Forehand drive',
  'Backhand drive',
  'Third-shot drop',
  'Dink',
  'Volley',
  'Overhead',
  'Forehand Drive',
  'Backhand Drive',
  'Forehand Dink',
  'Backhand Dink',
  'Forehand Volley',
  'Backhand Volley',
  'Third-Shot Drop',
  'Speedup',
  'Reset',
  'Auto detect',
];

const INTENT_TEXTS = [
  'backhand dink',
  'serve',
  'third shot drop',
  'drive',
  'xyzzy',
  '',
  '   ',
  'volley volley volley volley volley volley volley volley volley volley',
];

const ANALYZE_BUTTONS = [
  'Open automatic camera',
  'Get my Technique Score',
  'Analyze with Auto Detect',
  'Try again',
  'Capture another',
  'Import another',
  'See the full read',
  'See my score',
  'Close',
  'Skip — pick automatically',
  'Analyze this player',
  'Tap yourself in the frame',
  'Auto detect',
];

export class AnalyzeScreenStressDriver {
  readonly bridge: FakeVideoCaptureBridge;
  readonly server: FakeRatingServer;
  private renderer: ReactTestRenderer | null = null;
  private rng: SeededRng = mulberry32(1);
  private consoleErrors: string[] = [];
  private restoreConsole: (() => void) | null = null;
  private restoreRandom: (() => void) | null = null;
  private model = freshModel();

  constructor() {
    this.bridge = installFakeVideoCaptureBridge();
    this.server = new FakeRatingServer(API_BASE_URL);
    (globalThis as { fetch: unknown }).fetch = this.server.fetch;
  }

  // ---- lifecycle ---------------------------------------------------------

  private installRandomSources(): void {
    const originalRandom = Math.random;
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'crypto',
    );
    const originalCrypto = (globalThis as { crypto?: Crypto }).crypto;
    Math.random = () => this.rng.next();
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      writable: true,
      value: {
        ...(originalCrypto ? { subtle: originalCrypto.subtle } : {}),
        getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
          if (array instanceof Uint8Array) this.rng.fillBytes(array);
          else if (array) {
            this.rng.fillBytes(
              new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
            );
          }
          return array;
        },
        randomUUID: () => {
          const bytes = new Uint8Array(16);
          this.rng.fillBytes(bytes);
          bytes[6] = (bytes[6]! & 0x0f) | 0x40;
          bytes[8] = (bytes[8]! & 0x3f) | 0x80;
          const hex = Array.from(bytes, b =>
            b.toString(16).padStart(2, '0'),
          ).join('');
          return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        },
      },
    });
    this.restoreRandom = () => {
      Math.random = originalRandom;
      if (cryptoDescriptor)
        Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
      else delete (globalThis as { crypto?: unknown }).crypto;
    };
  }

  private installConsoleCapture(): void {
    const original = console.error;
    console.error = (...args: unknown[]) => {
      const text = args
        .map(a =>
          a instanceof Error
            ? a.message
            : typeof a === 'string'
              ? a
              : JSON.stringify(a),
        )
        .join(' ');
      this.consoleErrors.push(text.slice(0, 400));
    };
    this.restoreConsole = () => {
      console.error = original;
    };
  }

  private fakeStore(): BillingStoreClient {
    const entitlement: StoreEntitlementState = {
      premium: this.server.premium,
      productId: this.server.premium ? 'pickle_sensei_pro_annual' : null,
      expirationDate: null,
    };
    const plans: StorePlans = {
      offeringId: 'stress',
      annual: null,
      monthly: null,
      lifetime: null,
    };
    return {
      configure: async () => {},
      loadPlans: async () => plans,
      purchase: async () => entitlement,
      restore: async () => entitlement,
      readEntitlement: async () => entitlement,
    };
  }

  /** Mount the production navigator for one sequence. */
  async begin(seed: number, options: SequenceOptions): Promise<void> {
    this.rng = mulberry32(seed);
    this.consoleErrors = [];
    this.model = freshModel();
    this.installRandomSources();
    this.installConsoleCapture();

    this.bridge.reset();
    this.server.reset({ premium: options.premium });
    for (let i = 0; i < options.preUsed; i += 1) {
      this.server.permits.set(`pre-${i}`, {
        id: `pre-${i}`,
        accessSource: 'free',
        status: 'consumed',
        outcome: 'scored',
        idempotencyKey: `pre-${i}`,
      });
    }
    this.server.onRequest = record => {
      if (record.method === 'GET' && record.path === '/v1/me/access') {
        this.observeAccessRead();
      }
    };

    // Fresh local store (the op-sqlite double opens a new :memory: db).
    getDb().close();
    clearSyncRuntime();
    clearAccessStoreConfiguration();
    clearApiSession();
    clearTryAgainHandoff();
    usabilityFunnel.reset();
    stabilitySlo.reset();

    const session: ApiSession = {
      apiBaseUrl: API_BASE_URL,
      bearerToken: 'stress-bearer',
      canonicalAppUserId: CANONICAL_APP_USER_ID,
      provider: 'apple',
    };
    setActiveDataOwner(canonicalDataOwner(CANONICAL_APP_USER_ID));
    establishApiSession(session);
    configureAccessStore({
      store: this.fakeStore(),
      backend: createCanonicalAccessClient({
        baseUrl: API_BASE_URL,
        get token() {
          return bearerTokenFor(CANONICAL_APP_USER_ID);
        },
        fetchFn: this.server.fetch,
      }),
    });
    configureSyncRuntime(session);

    await act(async () => {
      this.renderer = TestRenderer.create(<RootNavigator />);
    });
    await this.flush();
    // The route gate initializes access on first Analyze mount; warm it here
    // the way App.tsx's launch sequence does so the gate opens immediately.
    await act(async () => {
      await useAccessStore.getState().initialize();
    });
    await this.flush();
  }

  async end(): Promise<void> {
    try {
      if (this.renderer) {
        const renderer = this.renderer;
        await act(async () => {
          renderer.unmount();
        });
      }
      await this.flush();
    } finally {
      this.renderer = null;
      clearSyncRuntime();
      clearAccessStoreConfiguration();
      clearApiSession();
      clearTryAgainHandoff();
      this.server.onRequest = null;
      this.restoreConsole?.();
      this.restoreConsole = null;
      this.restoreRandom?.();
      this.restoreRandom = null;
      // Every jest.fn() in the RN preset records each call forever; over a
      // long campaign those `mock.calls` arrays pin whole rendered trees.
      jest.clearAllMocks();
    }
  }

  // ---- clock -------------------------------------------------------------

  async flush(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise<void>(resolve => setImmediate(resolve));
      });
    }
  }

  /**
   * Wall-clock that passes between two human actions. Without it the fake
   * clock would let a native picker resolve BEFORE AnalyzeScreen's own 160 ms
   * auto-launch timer — an ordering no device can produce.
   */
  static readonly HUMAN_TICK_MS = 200;

  async humanTick(): Promise<void> {
    await act(async () => {
      jest.advanceTimersByTime(AnalyzeScreenStressDriver.HUMAN_TICK_MS);
    });
    await this.flush();
  }

  async settle(ms: number): Promise<void> {
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
    await this.flush();
  }

  // ---- surface -----------------------------------------------------------

  surface(): Surface {
    if (!this.renderer) throw new Error('driver not begun');
    const surface = readSurface(this.renderer);
    this.lastSurfaceText = surface.text;
    return surface;
  }

  private lastSurfaceText = '';

  /** Rendered strings of the most recent surface read (evidence dumps). */
  lastText(): string {
    return this.lastSurfaceText.split('\u241f').join(' | ');
  }

  /** Full rendered tree (evidence dumps). */
  renderedTree(): string {
    if (!this.renderer) return '';
    return JSON.stringify(this.renderer.toJSON(), null, 1);
  }

  // ---- generation --------------------------------------------------------

  /** Choose the next legal-or-near-legal action from the current surface. */
  nextAction(surface: Surface, rng: SeededRng): StressAction {
    const choices: Array<readonly [StressAction, number]> = [];
    const add = (action: StressAction, weight: number) =>
      choices.push([action, weight]);

    if (isTabRoute(surface.route)) {
      if (surface.enabled.includes('Start Auto Analyze')) {
        add({ kind: 'home.startCamera' }, 12);
        add({ kind: 'home.startLibrary' }, 6);
      } else if (surface.enabled.includes('Tab Home')) {
        add({ kind: 'tap', label: 'Tab Home' }, 12);
      }
    }
    if (surface.route === 'Result') {
      add({ kind: 'tap', label: 'Try again from result' }, 4);
      add({ kind: 'tap', label: 'Close result' }, 6);
    }
    if (surface.route === 'Paywall') {
      add({ kind: 'tap', label: 'Close paywall' }, 8);
    }
    for (const label of surface.enabled) {
      if (
        label === 'Try again from result' ||
        label === 'Close result' ||
        label === 'Close paywall'
      ) {
        continue;
      }
      if (label === 'Start Auto Analyze' || label === 'Import a video')
        continue;
      const weight =
        label === 'Close'
          ? 2
          : label === 'Open automatic camera'
            ? 8
            : label === 'Get my Technique Score' ||
                label === 'Analyze with Auto Detect'
              ? 8
              : label === 'Type or dictate the technique you are working on'
                ? 0
                : 3;
      if (weight > 0) add({ kind: 'tap', label }, weight);
      if (
        label === 'Open automatic camera' ||
        label === 'Get my Technique Score' ||
        label === 'Analyze with Auto Detect' ||
        label === 'Try again' ||
        label === 'Capture another' ||
        label === 'Import another' ||
        label === 'See the full read' ||
        label === 'See my score' ||
        label === 'Close' ||
        label === 'Analyze this player' ||
        label === 'Skip — pick automatically'
      ) {
        add({ kind: 'tapTwice', label }, 3);
      }
    }
    if (surface.analyzeMounted) {
      add({ kind: 'tapBlind', label: rng.pick(ANALYZE_BUTTONS) }, 2);
      add({ kind: 'tapBlind', label: rng.pick(STROKE_LABELS) }, 1);
      if (
        surface.enabled.includes(
          'Type or dictate the technique you are working on',
        )
      ) {
        add(
          {
            kind: 'typeIntent',
            text: rng.pick(INTENT_TEXTS),
            submit: rng.chance(0.5),
          },
          3,
        );
      }
    }
    const cameraOps = this.bridge.pending.filter(
      p => p.kind === 'capture' || p.kind === 'importVideo',
    );
    if (surface.analyzeMounted && cameraOps.length > 0) {
      add(
        {
          kind: 'native.event',
          event: rng.pick(['framing', 'ready', 'recording', 'lost']),
        },
        3,
      );
    } else if (
      surface.analyzeMounted &&
      this.bridge.counters.capture + this.bridge.counters.importVideo > 0
    ) {
      add(
        {
          kind: 'native.lateEvent',
          event: rng.pick(['framing', 'ready', 'lost']),
        },
        1,
      );
    }
    if (cameraOps.length > 0) {
      const importing = cameraOps.some(p => p.kind === 'importVideo');
      const variants: NativeClipVariant[] = importing
        ? [
            ...IMPORTED_CLIP_VARIANTS,
            'invalid_payload',
            ...GUIDED_CLIP_VARIANTS.slice(0, 1),
          ]
        : [...GUIDED_CLIP_VARIANTS, 'invalid_payload', 'imported_plain'];
      add({ kind: 'native.resolve', variant: rng.pick(variants) }, 14);
      add({ kind: 'native.rejectTyped' }, 4);
      add({ kind: 'native.rejectText' }, 2);
      add({ kind: 'native.rejectError' }, 2);
    }
    if (this.bridge.pendingOf('extractImportedPoseSequence').length > 0) {
      add(
        {
          kind: 'native.extract.resolve',
          preset: rng.pick(['textbook', 'cramped']),
        },
        8,
      );
      add(
        {
          kind: 'native.extract.reject',
          failure: rng.pick<ExtractionFailure>([
            'import_no_person',
            'import_too_long',
            'generic',
            'invalid_receipt',
          ]),
        },
        4,
      );
    }
    if (this.server.heldCount > 0) add({ kind: 'server.release' }, 10);
    else
      add(
        {
          kind: 'server.hold',
          target: rng.pick(['reserve', 'finalize', 'sync', 'access', 'all']),
        },
        2,
      );
    if (this.server.offline) add({ kind: 'server.online' }, 6);
    else add({ kind: 'server.offline' }, 1);
    add(
      {
        kind: 'settle',
        ms: rng.pick([0, 50, 160, 200, 1_000, 5_000, 21_000, 61_000]),
      },
      7,
    );
    add({ kind: 'flush' }, 3);
    if (!isTabRoute(surface.route)) add({ kind: 'nav.back' }, 1);
    return rng.weighted(choices);
  }

  // ---- execution ---------------------------------------------------------

  private cameraEvent(
    kind: 'framing' | 'ready' | 'recording' | 'lost',
  ): CameraEvent {
    const base = { emittedAtIso: new Date().toISOString() };
    const readiness = (
      state: 'full_body_required' | 'ready' | 'no_person',
      jointCoverage: number,
      missingJoints: string[],
    ): CameraEvent => ({
      ...base,
      type: 'readiness',
      state,
      poseConfidence: jointCoverage,
      jointCoverage,
      stableForMs: state === 'ready' ? 900 : 0,
      missingJoints,
      source: 'apple_vision_body_pose',
      modelVersion: 'apple-vision-bodypose-1',
    });
    switch (kind) {
      case 'framing':
        return readiness('full_body_required', 0.45, [
          'left_ankle',
          'right_ankle',
        ]);
      case 'ready':
        return readiness('ready', 0.96, []);
      case 'lost':
        return readiness('no_person', 0, []);
      case 'recording':
        return {
          ...base,
          type: 'session',
          state: 'recording_started',
          reason: 'shutter',
        };
    }
  }

  private clipCounter = 0;

  async perform(action: StressAction, surface: Surface): Promise<void> {
    switch (action.kind) {
      case 'home.startCamera':
      case 'home.startLibrary': {
        const label =
          action.kind === 'home.startCamera'
            ? 'Start Auto Analyze'
            : 'Import a video';
        const p = surface.pressables.get(label);
        if (p && !p.disabled) await act(async () => p.press());
        await this.flush();
        return;
      }
      case 'tap':
      case 'tapBlind': {
        const p = surface.pressables.get(action.label);
        if (p && !p.disabled) {
          if (
            action.label === 'See the full read' ||
            action.label === 'See my score'
          ) {
            this.model.explicitResultTap = true;
          }
          if (p.layout) {
            // The frame view only accepts a tap once it has been laid out;
            // re-read the handler so the press sees the post-layout render.
            await act(async () => p.layout!(320, 420));
            const fresh = this.surface().pressables.get(action.label);
            if (fresh && !fresh.disabled) await act(async () => fresh.press());
          } else {
            await act(async () => p.press());
          }
        }
        await this.flush();
        return;
      }
      case 'tapTwice': {
        const p = surface.pressables.get(action.label);
        if (p && !p.disabled) {
          if (
            action.label === 'See the full read' ||
            action.label === 'See my score'
          ) {
            this.model.explicitResultTap = true;
          }
          await act(async () => {
            p.press();
            p.press();
          });
        }
        await this.flush();
        return;
      }
      case 'typeIntent': {
        if (!this.renderer) return;
        const inputs = this.renderer.root.findAll(
          n =>
            n.props.accessibilityLabel ===
              'Type or dictate the technique you are working on' &&
            typeof n.props.onChangeText === 'function',
        );
        const input = inputs[inputs.length - 1];
        if (input) {
          await act(async () => {
            (input.props.onChangeText as (v: string) => void)(action.text);
          });
          if (
            action.submit &&
            typeof input.props.onSubmitEditing === 'function'
          ) {
            await act(async () => {
              (input.props.onSubmitEditing as () => void)();
            });
          }
        }
        await this.flush();
        return;
      }
      case 'native.resolve': {
        const ops = this.bridge.pending.filter(
          p => p.kind === 'capture' || p.kind === 'importVideo',
        );
        const op = ops[0];
        if (!op) return;
        this.clipCounter += 1;
        const clip = nativeClipPayload(
          action.variant,
          `clip-${this.clipCounter}`,
        );
        for (const artifact of clip.artifacts)
          this.bridge.artifacts.set(artifact.uri, artifact.text);
        this.model.clipsDelivered += 1;
        if (clipVariantHasPose(action.variant))
          this.model.poseClipsDelivered += 1;
        this.model.lastClipVariant = action.variant;
        await act(async () => op.resolve(clip.payload));
        await this.flush();
        return;
      }
      case 'native.rejectTyped':
      case 'native.rejectText':
      case 'native.rejectError': {
        const ops = this.bridge.pending.filter(
          p => p.kind === 'capture' || p.kind === 'importVideo',
        );
        const op = ops[0];
        if (!op) return;
        const error =
          action.kind === 'native.rejectTyped'
            ? typedCameraCancel()
            : action.kind === 'native.rejectText'
              ? new Error('Camera capture was canceled.')
              : new Error('The camera hardware is unavailable.');
        if (action.kind === 'native.rejectTyped') this.model.typedCancels += 1;
        this.model.lastCameraRejection = {
          kind: action.kind,
          opKind: op.kind,
          phaseBefore: surface.phase,
        };
        await act(async () => op.reject(error));
        await this.flush();
        return;
      }
      case 'native.extract.resolve':
      case 'native.extract.reject': {
        const op = this.bridge.pendingOf('extractImportedPoseSequence')[0];
        if (!op) return;
        this.clipCounter += 1;
        if (action.kind === 'native.extract.resolve') {
          const receipt = importedPoseExtractionReceipt(
            `extract-${this.clipCounter}`,
            action.preset,
          );
          for (const artifact of receipt.artifacts) {
            this.bridge.artifacts.set(artifact.uri, artifact.text);
          }
          this.model.poseClipsDelivered += 1;
          await act(async () => op.resolve(receipt.payload));
        } else if (action.failure === 'invalid_receipt') {
          await act(async () => op.resolve({ poseSequence: { uri: 42 } }));
        } else {
          const error = importedPoseExtractionError(action.failure);
          await act(async () => op.reject(error));
        }
        await this.flush();
        return;
      }
      case 'native.event':
      case 'native.lateEvent': {
        if (action.kind === 'native.lateEvent') this.model.strayEvents += 1;
        const event = this.cameraEvent(action.event);
        await act(async () => this.bridge.emit(event));
        await this.flush();
        return;
      }
      case 'server.hold': {
        const target = action.target;
        this.server.hold(path =>
          target === 'all'
            ? true
            : target === 'reserve'
              ? path === '/v1/analysis-permits'
              : target === 'finalize'
                ? path.endsWith('/finalize')
                : target === 'sync'
                  ? path === '/v1/shots:sync'
                  : path === '/v1/me/access',
        );
        return;
      }
      case 'server.release': {
        await act(async () => {
          this.server.releaseHeld();
        });
        await this.flush();
        return;
      }
      case 'server.offline':
        this.server.offline = true;
        return;
      case 'server.online':
        this.server.offline = false;
        return;
      case 'settle':
        await this.settle(action.ms);
        return;
      case 'flush':
        await this.flush();
        return;
      case 'nav.back': {
        await act(async () => {
          const ref = liveNavigationRef();
          if (ref?.canGoBack()) ref.goBack();
        });
        await this.flush();
        return;
      }
    }
  }

  // ---- invariants --------------------------------------------------------

  private observeAccessRead(): void {
    // AGENTS.md "Free-rating ledger freshness": AnalyzeScreen re-reads
    // access in its UNMOUNT cleanup, chained onto the analysis run, never
    // while mounted and never while a permit is still in its reserved
    // in-flight state.
    if (!this.model.analyzeEverMounted) return;
    if (this.renderer) {
      const mounted = readSurface(this.renderer);
      // Only the FOCUSED Analyze screen can be torn down by the gate; an
      // instance buried under Result/Tabs is reported separately (I15).
      if (mounted.analyzeMounted && mounted.route === 'Analyze') {
        this.model.asyncViolations.push(
          `I11 access refreshed (GET /v1/me/access) while the focused AnalyzeScreen is mounted (phases ${mounted.instances.join(',')})`,
        );
      }
    }
    for (const permit of this.server.permits.values()) {
      if (permit.status !== 'reserved') continue;
      const persisted = countRows(
        `SELECT COUNT(*) AS n FROM outbox WHERE kind = 'shot.sync' AND payload LIKE ?`,
        [`%"analysisPermitId":"${permit.id}"%`],
      );
      if (persisted === 0) {
        this.model.asyncViolations.push(
          `I11 access refreshed while permit ${permit.id} was reserved and not yet persisted/released`,
        );
      }
    }
  }

  /**
   * I4 wording distinguishes the three ways a working surface can be
   * orphaned: the focused screen itself, an instance buried under another
   * route (cross-instance camera events), or a stray late native event.
   */
  private describeStuckWorking(surface: Surface): string {
    const focused = surface.route === 'Analyze' && surface.phase === 'working';
    const where = focused
      ? 'focused AnalyzeScreen'
      : `AnalyzeScreen buried under ${surface.route} (phases ${surface.instances.join(',')})`;
    const cause =
      this.model.strayEvents > 0 ? ' [after a late native camera event]' : '';
    return `I4 ${where} stuck in working with no pending native op and no held request${cause}`;
  }

  checkInvariants(
    action: StressAction,
    before: Surface,
    after: Surface,
  ): string[] {
    const v: string[] = [];
    const m = this.model;
    if (after.analyzeMounted) m.analyzeEverMounted = true;

    // I15 — the navigator holds at most one AnalyzeScreen (the access gate
    // and the unmount-time access refresh both assume a single instance).
    if (
      after.instances.length > 1 &&
      after.instances.length > before.instances.length
    ) {
      v.push(
        `I15 ${after.instances.length} AnalyzeScreen instances mounted at once (phases ${after.instances.join(',')}) after ${describeAction(action)}`,
      );
    }

    // I1 — duplicate capture-start never runs two native camera operations.
    if (this.bridge.peakConcurrentCameraOps > 1) {
      v.push(
        `I1 ${this.bridge.peakConcurrentCameraOps} native camera operations in flight at once`,
      );
    }

    // I2/I8 — permits: at most one live reservation; never more reservation
    // attempts than pose-bearing clips (a clip without a pose sequence can
    // never reach the permit stage, and a clip is scored at most once).
    const liveReserved = [...this.server.permits.values()].filter(
      p => p.status === 'reserved' && !p.id.startsWith('pre-'),
    ).length;
    if (liveReserved > 1)
      v.push(`I2 ${liveReserved} analysis permits reserved concurrently`);
    const reserveAttempts =
      this.server.counters.reserve + this.server.counters.reserveRefused;
    if (reserveAttempts > m.poseClipsDelivered) {
      v.push(
        `I8 ${reserveAttempts} permit reservations for ${m.poseClipsDelivered} pose-bearing clips`,
      );
    }
    if (this.server.counters.reserve > m.poseClipsDelivered) {
      v.push(
        `I2 ${this.server.counters.reserve} permits minted for ${m.poseClipsDelivered} scorable clips`,
      );
    }

    // I3 — no navigation to Result after abandonment / from outside Analyze.
    if (after.route === 'Result' && before.route !== 'Result') {
      // User-initiated transitions (a tap on the screen, the free-limit
      // dialog's Close/See my score, popping a Paywall that sits on Result,
      // a back gesture) are legal from anywhere. AUTOMATIC routing — driven
      // by the analysis settling — is legal only while Analyze itself is on
      // screen in a phase that can still complete.
      const userInitiated =
        action.kind === 'tap' ||
        action.kind === 'tapTwice' ||
        action.kind === 'tapBlind' ||
        action.kind === 'nav.back';
      const autoFromAnalyze =
        before.route === 'Analyze' &&
        (before.phase === 'working' ||
          before.phase === 'saved' ||
          before.phase === 'gate');
      if (!userInitiated && !autoFromAnalyze) {
        v.push(
          `I3 routed to Result from ${before.route}/${before.phase} via ${describeAction(action)}`,
        );
      }
      const marker = after.text.match(/Result:([^\u241f]+)/);
      const analysisId = marker?.[1] ?? 'unknown';
      m.resultRoutes.set(analysisId, (m.resultRoutes.get(analysisId) ?? 0) + 1);
      if (!userInitiated && (m.resultRoutes.get(analysisId) ?? 0) > 1) {
        v.push(
          `I10 auto-routed to Result for analysis ${analysisId} more than once`,
        );
      }
    }
    m.explicitResultTap = false;

    // I4 — no orphaned working state once every external dependency settled.
    if (
      action.kind === 'settle' &&
      action.ms >= 1_000 &&
      after.instances.includes('working') &&
      this.bridge.pending.length === 0 &&
      this.server.heldCount === 0
    ) {
      v.push(this.describeStuckWorking(after));
    }

    // I5/I6 — camera rejection semantics.
    const rejection = m.lastCameraRejection;
    if (rejection && action.kind.startsWith('native.reject')) {
      if (rejection.kind === 'native.rejectTyped') {
        if (after.phase === 'error') {
          v.push('I5 typed camera.cancelled rendered as a capture error');
        }
        if (
          rejection.opKind === 'capture' &&
          after.analyzeMounted &&
          after.phase !== 'ready'
        ) {
          v.push(
            `I5 typed cancel of guided capture left phase ${after.phase} (expected ready)`,
          );
        }
        if (
          rejection.opKind === 'importVideo' &&
          after.route === 'Analyze' &&
          after.phase !== 'ready'
        ) {
          v.push(
            `I5 typed cancel of library import left Analyze on screen in ${after.phase}`,
          );
        }
      } else if (after.analyzeMounted && after.phase !== 'error') {
        v.push(
          `I6 ${rejection.kind} (${rejection.opKind}) should render the capture error surface, saw ${after.phase}`,
        );
      }
      if (rejection.kind !== 'native.rejectTyped' && after.analyzeMounted) {
        if (!after.enabled.includes('Try again')) {
          v.push(
            'I6 capture error surface has no enabled "Try again" recovery',
          );
        }
      }
      m.lastCameraRejection = null;
    }

    // I7 — imported clips never offer Auto Detect scoring.
    if (
      after.enabled.includes('Analyze with Auto Detect') &&
      (m.lastClipVariant === 'imported_plain' ||
        m.lastClipVariant === 'imported_with_poster')
    ) {
      v.push('I7 "Analyze with Auto Detect" offered for an imported clip');
    }

    // I9 — sync work exists only for scored analyses; nothing else is synced.
    const outboxNonScored = selectRows<{ payload: string }>(
      `SELECT payload FROM outbox WHERE kind = 'shot.sync'`,
    ).filter(row => !row.payload.includes('"resultKind":"scored"')).length;
    if (outboxNonScored > 0)
      v.push(`I9 ${outboxNonScored} non-scored analyses queued for sync`);
    const lowConfidenceSynced = countRows(
      `SELECT COUNT(*) AS n FROM local_shot WHERE result_kind <> 'scored' AND id IN (SELECT id FROM sync_receipt)`,
    );
    if (lowConfidenceSynced > 0)
      v.push(`I9 ${lowConfidenceSynced} unscored shots carry sync receipts`);
    const scoredShots = countRows(
      `SELECT COUNT(*) AS n FROM local_shot WHERE result_kind = 'scored'`,
    );
    if (scoredShots > this.server.counters.reserve) {
      v.push(
        `I8 ${scoredShots} scored shots persisted with only ${this.server.counters.reserve} permits`,
      );
    }
    m.scored = scoredShots;

    // I12 — consumed permits: a permit accepted by shot sync is never
    // finalized as released afterwards (double settle).
    // (Server records the transition; a 409 finalize after consume shows up
    // as a finalize count on a consumed permit.)

    // Free-limit surface only when the reservation was the last free rating.
    if (after.phase === 'free_limit') {
      m.freeLimitShown = true;
      if (this.server.premium)
        v.push('I13 free-limit surface shown to a premium account');
      const snapshot = this.server.snapshot();
      if (
        snapshot.freeRatings.remaining !== 0 &&
        snapshot.freeRatings.availableToReserve !== 0
      ) {
        v.push(
          `I13 free-limit surface shown with ${snapshot.freeRatings.availableToReserve} free rating(s) still reservable`,
        );
      }
    }

    if (after.phase === 'error') m.errorsShown += 1;

    // Asynchronous observations (access reads) collected since last check.
    v.push(...m.asyncViolations);
    m.asyncViolations = [];
    return v;
  }

  // ---- run one sequence ----------------------------------------------------

  async runSequence(
    seed: number,
    length: number,
    options: SequenceOptions,
  ): Promise<SequenceResult> {
    const actions: string[] = [];
    const trace: TraceStep[] = [];
    const violations: string[] = [];
    let crashed: string | null = null;
    await this.begin(seed, options);
    try {
      const actionRng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
      let surface = this.surface();
      for (let index = 0; index < length; index += 1) {
        const action = this.nextAction(surface, actionRng);
        actions.push(describeAction(action));
        const before = surface;
        try {
          await this.perform(action, before);
          await this.humanTick();
        } catch (error) {
          crashed = `${describeAction(action)}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
          break;
        }
        surface = this.surface();
        const stepViolations = this.checkInvariants(action, before, surface);
        const consoleErrors = this.consoleErrors.splice(0);
        violations.push(
          ...stepViolations.map(
            v => `#${index} ${describeAction(action)} → ${v}`,
          ),
        );
        trace.push({
          index,
          action: describeAction(action),
          route: surface.route,
          phase: surface.phase,
          instances: surface.instances,
          enabled: surface.enabled,
          textDigest: fnv1a(surface.text),
          bridge: {
            pending: this.bridge.pending.length,
            capture: this.bridge.counters.capture,
            importVideo: this.bridge.counters.importVideo,
            cancel: this.bridge.counters.cancel,
          },
          server: {
            reserve: this.server.counters.reserve,
            refused: this.server.counters.reserveRefused,
            finalize: this.server.counters.finalize,
            shotSync: this.server.counters.shotSync,
            accepted: this.server.counters.shotsAccepted,
            rejected: this.server.counters.shotsRejected,
            accessGet: this.server.counters.accessGet,
            held: this.server.heldCount,
          },
          db: {
            captures: countRows('SELECT COUNT(*) AS n FROM local_capture'),
            shots: countRows('SELECT COUNT(*) AS n FROM local_shot'),
            outbox: countRows('SELECT COUNT(*) AS n FROM outbox'),
          },
          violations: stepViolations,
          consoleErrors,
        });
      }
      // Drain: let every in-flight operation finish so the unmount check
      // below sees the settled world, then verify unmount does not navigate.
      this.server.releaseHeld();
      this.server.offline = false;
      for (const op of [...this.bridge.pending]) {
        if (op.kind === 'capture' || op.kind === 'importVideo')
          op.reject(typedCameraCancel());
        else op.reject(importedPoseExtractionError('generic'));
      }
      await this.settle(30_000);
      const settled = this.surface();
      if (settled.instances.includes('working')) {
        violations.push(
          `#drain → ${this.describeStuckWorking(settled)} after a 30 s settle`,
        );
      }
      const routeBefore = settled.route;
      const violationsBeforeUnmount = this.model.asyncViolations.length;
      await this.end();
      await this.settle(30_000);
      if (this.model.asyncViolations.length > violationsBeforeUnmount) {
        violations.push(
          ...this.model.asyncViolations
            .slice(violationsBeforeUnmount)
            .map(v => `#unmount → ${v}`),
        );
      }
      void routeBefore;
    } finally {
      if (this.renderer) await this.end();
    }
    if (crashed) violations.push(`#crash → ${crashed}`);
    const fingerprint = fnv1a(
      trace
        .map(
          s =>
            `${s.action}|${s.route}|${s.phase}|${s.enabled.join(',')}|${s.textDigest}|${JSON.stringify(s.bridge)}|${JSON.stringify(s.server)}|${JSON.stringify(s.db)}`,
        )
        .join('\n'),
    );
    return {
      seed,
      length,
      options,
      actions,
      trace,
      violations,
      crashed,
      fingerprint,
      outcomes: {
        scored: this.model.scored,
        permitsReserved: this.server.counters.reserve,
        resultRoutes: [...this.model.resultRoutes.values()].reduce(
          (a, b) => a + b,
          0,
        ),
        freeLimitShown: this.model.freeLimitShown,
        errorsShown: this.model.errorsShown,
        typedCancels: this.model.typedCancels,
      },
    };
  }

  /** Replays a recorded action list (used by minimization). */
  async replayActions(
    seed: number,
    actions: StressAction[],
    options: SequenceOptions,
  ): Promise<SequenceResult> {
    const trace: TraceStep[] = [];
    const violations: string[] = [];
    let crashed: string | null = null;
    await this.begin(seed, options);
    try {
      let surface = this.surface();
      for (let index = 0; index < actions.length; index += 1) {
        const action = actions[index]!;
        const before = surface;
        try {
          await this.perform(action, before);
          await this.humanTick();
        } catch (error) {
          crashed = `${describeAction(action)}: ${error instanceof Error ? error.message : String(error)}`;
          break;
        }
        surface = this.surface();
        const stepViolations = this.checkInvariants(action, before, surface);
        violations.push(
          ...stepViolations.map(
            v => `#${index} ${describeAction(action)} → ${v}`,
          ),
        );
        trace.push({
          index,
          action: describeAction(action),
          route: surface.route,
          phase: surface.phase,
          instances: surface.instances,
          enabled: surface.enabled,
          textDigest: fnv1a(surface.text),
          bridge: {
            pending: this.bridge.pending.length,
            capture: this.bridge.counters.capture,
            importVideo: this.bridge.counters.importVideo,
            cancel: this.bridge.counters.cancel,
          },
          server: {
            reserve: this.server.counters.reserve,
            refused: this.server.counters.reserveRefused,
            finalize: this.server.counters.finalize,
            shotSync: this.server.counters.shotSync,
            accepted: this.server.counters.shotsAccepted,
            rejected: this.server.counters.shotsRejected,
            accessGet: this.server.counters.accessGet,
            held: this.server.heldCount,
          },
          db: {
            captures: countRows('SELECT COUNT(*) AS n FROM local_capture'),
            shots: countRows('SELECT COUNT(*) AS n FROM local_shot'),
            outbox: countRows('SELECT COUNT(*) AS n FROM outbox'),
          },
          violations: stepViolations,
          consoleErrors: this.consoleErrors.splice(0),
        });
      }
    } finally {
      await this.end();
    }
    if (crashed) violations.push(`#crash → ${crashed}`);
    return {
      seed,
      length: actions.length,
      options,
      actions: actions.map(describeAction),
      trace,
      violations,
      crashed,
      fingerprint: fnv1a(
        trace.map(s => `${s.action}|${s.route}|${s.phase}`).join('\n'),
      ),
      outcomes: {
        scored: this.model.scored,
        permitsReserved: this.server.counters.reserve,
        resultRoutes: [...this.model.resultRoutes.values()].reduce(
          (a, b) => a + b,
          0,
        ),
        freeLimitShown: this.model.freeLimitShown,
        errorsShown: this.model.errorsShown,
        typedCancels: this.model.typedCancels,
      },
    };
  }
}

interface Model {
  analyzeEverMounted: boolean;
  explicitResultTap: boolean;
  clipsDelivered: number;
  poseClipsDelivered: number;
  lastClipVariant: NativeClipVariant | null;
  lastCameraRejection: {
    kind: 'native.rejectTyped' | 'native.rejectText' | 'native.rejectError';
    opKind: string;
    phaseBefore: Phase;
  } | null;
  resultRoutes: Map<string, number>;
  asyncViolations: string[];
  scored: number;
  freeLimitShown: boolean;
  errorsShown: number;
  typedCancels: number;
  strayEvents: number;
}

function freshModel(): Model {
  return {
    analyzeEverMounted: false,
    explicitResultTap: false,
    clipsDelivered: 0,
    poseClipsDelivered: 0,
    lastClipVariant: null,
    lastCameraRejection: null,
    resultRoutes: new Map(),
    asyncViolations: [],
    scored: 0,
    freeLimitShown: false,
    errorsShown: 0,
    typedCancels: 0,
    strayEvents: 0,
  };
}

/** Sequence options derived from the seed so the campaign covers premium,
 * fresh-free, one-used and exhausted ledgers without a separate axis. */
export function optionsForSeed(seed: number): SequenceOptions {
  const rng = mulberry32((seed * 2654435761) >>> 0);
  const premium = rng.chance(0.2);
  const preUsed = premium
    ? 0
    : rng.weighted<0 | 1 | 2>([
        [0, 5],
        [1, 3],
        [2, 2],
      ]);
  return { premium, preUsed };
}

export function lengthForSeed(seed: number, min = 5, max = 60): number {
  return mulberry32((seed ^ 0x5bd1e995) >>> 0).int(min, max);
}

/** Actions are replayable from their description (for minimization output). */
export function parseAction(description: string): StressAction {
  const [kind, ...rest] = description.split(':');
  const arg = rest.join(':');
  switch (kind) {
    case 'tap':
    case 'tapTwice':
    case 'tapBlind':
      return { kind, label: arg };
    case 'typeIntent': {
      const submit = arg.endsWith('+submit');
      const text = JSON.parse(
        submit ? arg.slice(0, -'+submit'.length) : arg,
      ) as string;
      return { kind, text, submit };
    }
    case 'native.resolve':
      return { kind, variant: arg as NativeClipVariant };
    case 'native.extract.resolve':
      return { kind, preset: arg as 'textbook' | 'cramped' };
    case 'native.extract.reject':
      return { kind, failure: arg as ExtractionFailure };
    case 'native.event':
    case 'native.lateEvent':
      return { kind, event: arg as 'framing' | 'ready' | 'recording' | 'lost' };
    case 'server.hold':
      return {
        kind,
        target: arg as 'reserve' | 'finalize' | 'sync' | 'access' | 'all',
      };
    case 'settle':
      return { kind, ms: Number(arg) };
    case 'home.startCamera':
    case 'home.startLibrary':
    case 'native.rejectTyped':
    case 'native.rejectText':
    case 'native.rejectError':
    case 'server.release':
    case 'server.offline':
    case 'server.online':
    case 'flush':
    case 'nav.back':
      return { kind };
    default:
      throw new Error(`unknown action ${description}`);
  }
}
