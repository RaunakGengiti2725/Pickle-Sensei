/**
 * STRESS — unit `mod-launch-gate`, lens `boundary-malformed`, render level.
 *
 * Drives the REAL App.tsx Gate (real appStore / notificationStore, in-memory
 * kv, the same stand-ins for heavy leaves as
 * `__tests__/wf/flow-launch-onboarding-gate.test.tsx`) through seeded random
 * event sequences, with malformed input injected at the three places a
 * hostile world can reach the launch flow:
 *
 *   1. the kv rows the Gate hydrates from at launch (pre-auth stash, pending
 *      notification choice, the signed-out owner's profile row) are seeded
 *      with truncated JSON / wrong types / future schema versions / prototype
 *      keys / 64 KiB blobs / path-traversal strings;
 *   2. the only free-text input before sign-in (the questionnaire's first
 *      name) receives null bytes, controls, lone surrogates, 64 KiB+ strings,
 *      zero-width-only and whitespace-only text — bypassing the NATIVE
 *      `maxLength={40}` exactly the way a paste/autofill path can;
 *   3. the storage layer refuses a write (fault injection on `setKv`).
 *
 * Invariants checked after EVERY interaction (campaign E):
 *   - exactly one of Welcome / questionnaire / sign-in is on screen and it is
 *     the one the stage model predicts — no silent skip of the questionnaire,
 *     sign-in only through the explicit link or a finished questionnaire;
 *   - the RootErrorBoundary never fires ("Something went wrong");
 *   - step one exposes Back-to-Welcome and no skip/leave affordance;
 *   - Continue on the name step is disabled exactly when the trimmed name is
 *     empty (whitespace-only / zero-width-only names cannot pass);
 *   - the ONLY kv keys ever written are the two stashes, and only by the
 *     notifications step — Welcome / Back / link / malformed typing write
 *     nothing;
 *   - a refused write keeps the player on the notifications step with an
 *     error, never advances the stage.
 *
 * Scale: max(3, STRESS_ITER/100) sequences of 4..24 actions (default 300 → 3;
 * the campaign run uses STRESS_ITER=20000 → 200);
 * STRESS_SEED replays a run, STRESS_ONLY_SEED=<seed> one sequence. Rows go to
 * `<repo>/artifacts/stress/launch-gate/app-gate.rows.json`.
 */
import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PermissionState } from '../../src/notifications/service';
import type { Profile } from '../../src/state/profile';

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Passthrough = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    SafeAreaProvider: Passthrough,
    SafeAreaView: Passthrough,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
});

jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
    G: Mock,
    Ellipse: Mock,
  };
});

const mockKv = new Map<string, string>();
const mockKvLog: Array<{ key: string; bytes: number }> = [];
/** When > 0, the next N kv writes throw (storage fault injection). */
let mockKvFailWrites = 0;
jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        if (mockKvFailWrites > 0) {
          mockKvFailWrites -= 1;
          throw new Error('SQLITE_FULL: database or disk is full');
        }
        const key = String(params[0]);
        const value = String(params[1]);
        mockKv.set(key, value);
        mockKvLog.push({ key, bytes: value.length });
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

interface MockSession {
  provider: 'guest' | 'apple';
  subject: string;
  canonicalAppUserId: string | null;
  localOnly: boolean;
  displayName: string | null;
  email: string | null;
}
interface MockAuthState {
  hydrated: boolean;
  session: MockSession | null;
  hydrate: () => Promise<void>;
  continueAsGuest: () => Promise<void>;
  signInCanonical: (id: string) => Promise<void>;
  signOut: () => Promise<void>;
}
jest.mock('../../src/auth/authStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  const scope = jest.requireActual<
    typeof import('../../src/data/accountScope')
  >('../../src/data/accountScope');
  const useAuthStore = create<MockAuthState>(set => ({
    hydrated: false,
    session: null,
    hydrate: async () => {
      scope.setActiveDataOwner(scope.SIGNED_OUT_DATA_OWNER);
      set({ hydrated: true, session: null });
    },
    continueAsGuest: async () => {
      scope.setActiveDataOwner(scope.GUEST_DATA_OWNER);
      set({
        session: {
          provider: 'guest',
          subject: 'local-only',
          canonicalAppUserId: null,
          localOnly: true,
          displayName: null,
          email: null,
        },
      });
    },
    signInCanonical: async id => {
      scope.setActiveDataOwner(scope.canonicalDataOwner(id));
      set({
        session: {
          provider: 'apple',
          subject: 'apple-subject',
          canonicalAppUserId: id,
          localOnly: false,
          displayName: null,
          email: null,
        },
      });
    },
    signOut: async () => {
      scope.setActiveDataOwner(scope.SIGNED_OUT_DATA_OWNER);
      set({ session: null });
    },
  }));
  return { useAuthStore };
});

jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));
jest.mock('../../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: async () => null,
  saveCanonicalOnboardingProfile: async (_s: unknown, profile: Profile) =>
    profile,
}));

const mockScheduler = {
  permission: 'undetermined' as PermissionState,
  requestCalls: 0,
  cancelAllCalls: 0,
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  },
  async requestPermission(): Promise<PermissionState> {
    this.requestCalls += 1;
    this.permission = 'granted';
    return 'granted';
  },
  async applyPlan(): Promise<void> {},
  async cancelAllPlanned(): Promise<void> {
    this.cancelAllCalls += 1;
  },
  async openSystemSettings(): Promise<void> {},
};
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));

jest.mock('../../src/navigation/RootNavigator', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    RootNavigator: () => React.createElement(Text, null, 'ROOT_NAVIGATOR'),
  };
});
jest.mock('../../src/screens/SignInScreen', () => {
  const React = require('react');
  const { Pressable, Text, View } = require('react-native');
  const { useAuthStore } = jest.requireMock<{
    useAuthStore: {
      getState: () => { continueAsGuest: () => Promise<void> };
    };
  }>('../../src/auth/authStore');
  return {
    SignInScreen: (props: { onBack?: () => void }) =>
      React.createElement(
        View,
        null,
        React.createElement(Text, null, 'SIGN_IN_SCREEN'),
        React.createElement(
          Pressable,
          { accessibilityLabel: 'Back', onPress: props.onBack },
          React.createElement(Text, null, 'Back'),
        ),
        React.createElement(
          Pressable,
          {
            accessibilityLabel: 'Continue as guest',
            onPress: () => void useAuthStore.getState().continueAsGuest(),
          },
          React.createElement(Text, null, 'Continue as guest'),
        ),
      ),
  };
});
jest.mock('../../src/screens/SplashScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) => {
      React.useEffect(() => {
        if (props.ready) props.onFinished();
      }, [props.ready, props.onFinished]);
      return React.createElement(Text, null, 'SPLASH');
    },
  };
});
jest.mock('../../src/components/RankUpCelebration', () => ({
  RankUpCelebration: () => null,
}));
jest.mock('../../src/consistency/StreakCelebration', () => ({
  StreakCelebration: () => null,
}));
jest.mock('../../src/walkthrough/FirstRunWalkthrough', () => ({
  FirstRunWalkthrough: () => null,
}));
jest.mock('../../src/walkthrough/walkthroughStore', () => {
  const state = { maybeShowFirstRun: async () => {} };
  return {
    useWalkthroughStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));

import App from '../../App';
import { useAuthStore } from '../../src/auth/authStore';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  profileKeyForOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';
import {
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  useNotificationStore,
} from '../../src/notifications/notificationStore';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';
import type { PreAuthStage } from '../../src/flow/launchGate';
import {
  fingerprint,
  generatePayload,
  intBetween,
  mulberry32,
  pick,
  type Payload,
  type PayloadCategory,
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
const SEQUENCES = Math.max(3, Math.floor(ITER / 100));
const MASTER_SEED =
  Number.parseInt(nodeProcess.env['STRESS_SEED'] ?? '', 10) || 0x6a7e0001;
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

type Renderer = TestRenderer.ReactTestRenderer;

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string | number => typeof c !== 'object')
    .join('');
}

function isAncestor(
  ancestor: TestRenderer.ReactTestInstance,
  node: TestRenderer.ReactTestInstance,
): boolean {
  let current = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function pressables(renderer: Renderer, label?: string) {
  const matches = renderer.root.findAll(
    node =>
      typeof node.props?.accessibilityLabel === 'string' &&
      (label === undefined || node.props.accessibilityLabel === label) &&
      typeof node.props?.onPress === 'function',
  );
  return matches.filter(
    node => !matches.some(other => other !== node && isAncestor(node, other)),
  );
}

async function settle() {
  await act(async () => {});
  await act(async () => {});
}

async function pressAsync(renderer: Renderer, label: string) {
  const nodes = pressables(renderer, label);
  if (nodes.length !== 1) throw new Error(`${nodes.length} × "${label}"`);
  if (nodes[0]!.props.disabled) throw new Error(`"${label}" is disabled`);
  act(() => {
    nodes[0]!.props.onPress();
  });
  await settle();
}

let mounted: Renderer | null = null;
async function launch(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
  });
  await settle();
  mounted = renderer;
  return renderer;
}
function unmount() {
  const renderer = mounted;
  mounted = null;
  if (renderer) act(() => renderer.unmount());
}

function resetWorld() {
  mockKv.clear();
  mockKvLog.length = 0;
  mockKvFailWrites = 0;
  mockScheduler.permission = 'undetermined';
  mockScheduler.requestCalls = 0;
  mockScheduler.cancelAllCalls = 0;
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({ hydrated: false, session: null });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
  });
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
  });
}

/** What is on screen, derived from the rendered tree — never from state. */
type Screen =
  | 'welcome'
  | 'onboarding'
  | 'signin'
  | 'main'
  | 'account-onboarding'
  | 'profile-error'
  | 'error'
  | 'loading'
  | 'ambiguous';
function screenOf(renderer: Renderer): Screen {
  const text = allText(renderer);
  const seen: Screen[] = [];
  if (text.includes('Something went wrong')) seen.push('error');
  if (text.includes('Your coaching profile couldn’t load')) {
    seen.push('profile-error');
  }
  if (text.includes('See the stroke.')) seen.push('welcome');
  if (text.includes('SIGN_IN_SCREEN')) seen.push('signin');
  if (text.includes('ROOT_NAVIGATOR')) seen.push('main');
  if (
    text.includes('PLAYER SETUP') ||
    text.includes('YOUR STARTING PLAN') ||
    text.includes('Stay match-ready.')
  ) {
    // Pre-auth and in-account questionnaire share the screen; pre-auth is
    // the one with a Back-to-Welcome at step one, in-account has Leave setup.
    seen.push(
      pressables(renderer, 'Leave setup').length > 0
        ? 'account-onboarding'
        : 'onboarding',
    );
  }
  if (seen.length === 0) {
    return text.includes('Getting things ready') || text.includes('SPLASH')
      ? 'loading'
      : 'ambiguous';
  }
  return seen.length === 1 ? seen[0]! : 'ambiguous';
}

const STASH_KEYS = [
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
];

/** Malformed text for a kv row the launch reads. */
function malformedKvRow(rng: () => number): { describe: string; text: string } {
  const category: PayloadCategory = pick(rng, [
    'json',
    'schema',
    'proto',
    'huge',
    'path',
    'numeric',
    'empty',
    'bytes',
  ]);
  const payload = generatePayload(rng, category);
  if (typeof payload.value === 'string') {
    return {
      describe: `${payload.describe}`,
      text: payload.value,
    };
  }
  let text: string;
  try {
    text = JSON.stringify(payload.value) ?? 'undefined';
  } catch {
    text = '{"version":1,"profile":{"skillLevel":';
  }
  // Half the time wrap into the real stash envelope so the hostile value
  // lands INSIDE the profile the parser reads, not just at the top level.
  if (rng() < 0.5) {
    text = JSON.stringify({
      version: pick(rng, [1, 2, 999, -1, '1', null]),
      profile: {
        skillLevel: '3.5',
        handedness: 'right',
        goal: 'drops',
        biggestProblem: 'control',
        focusCheckpoint: pick(rng, ['paddle_set', '../../etc/passwd', '']),
        firstName: payload.jsonSafe ? payload.value : 'x'.repeat(70000),
        __proto__: { polluted: true },
      },
    });
    return { describe: `envelope(${payload.describe})`, text };
  }
  return { describe: payload.describe, text };
}

/** Malformed free text for the first-name field (strings only). */
function malformedName(rng: () => number): Payload {
  const category: PayloadCategory = pick(rng, [
    'bytes',
    'huge',
    'path',
    'unicode',
    'empty',
    'json',
  ]);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const payload = generatePayload(rng, category);
    if (typeof payload.value === 'string') return payload;
  }
  return {
    category: 'empty',
    describe: 'empty:empty-string',
    value: '',
    jsonSafe: true,
  };
}

type Action =
  | 'welcome.start'
  | 'welcome.start.doubleTap'
  | 'welcome.link'
  | 'onboarding.typeName'
  | 'onboarding.continue'
  | 'onboarding.back'
  | 'onboarding.choose'
  | 'onboarding.notNow'
  | 'onboarding.notNow.storageFault'
  | 'onboarding.turnOn'
  | 'signin.back'
  | 'signin.guest';

interface Row {
  seed: number;
  campaign: 'E';
  seededKv: string[];
  actions: string[];
  verdict: 'HELD' | 'BROKEN';
  detail?: string;
  /**
   * Post-sign-in behaviours outside the gate's own contract that the run
   * surfaced (kept out of the verdict, reported separately):
   *   corrupt-owner-row→ErrorState   a non-JSON profile row for the owner
   *                                  blocks the guest behind a retry-only
   *                                  error whose detail is the parser text
   *   legacy-corrupt-row-copied       the 'profile' legacy row was copied
   *                                  into the owner key BEFORE being parsed
   *   non-Profile-object-accepted     a JSON object that is not a Profile
   *                                  became `appStore.profile` and the main
   *                                  app rendered
   *   over-cap-name-stashed           a first name longer than the native
   *                                  maxLength=40 reached the kv stash
   */
  observations: string[];
  kvWrites: number;
  finalScreen: Screen;
  stashedNameCodePoints?: number;
  adoptedProfile?: string;
}

const rows: Row[] = [];
const broken: Row[] = [];

function firstNameOnScreen(renderer: Renderer): string | null {
  const inputs = renderer.root.findAllByType(TextInput);
  if (inputs.length !== 1) return null;
  const value = inputs[0]!.props.value;
  return typeof value === 'string' ? value : null;
}

async function runSequence(seed: number): Promise<Row> {
  const rng = mulberry32(seed);
  resetWorld();

  // 1. Hostile kv rows the launch will hydrate from.
  const seededKv: string[] = [];
  if (rng() < 0.6) {
    const targets = [
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
      profileKeyForOwner(SIGNED_OUT_DATA_OWNER),
      profileKeyForOwner(GUEST_DATA_OWNER),
      'profile',
    ];
    const count = intBetween(rng, 1, 3);
    for (let i = 0; i < count; i += 1) {
      const key = pick(rng, targets);
      const row = malformedKvRow(rng);
      mockKv.set(key, row.text);
      seededKv.push(`${key}=${row.describe}#${fingerprint(row.text)}`);
    }
  }
  const seededKeys = new Set(mockKv.keys());
  mockKvLog.length = 0;

  const actions: string[] = [];
  let detail: string | null = null;
  let stage: PreAuthStage = 'welcome';
  let signedIn = false;
  let typedName: string | null = null;
  let stashedNameCodePoints: number | undefined;
  let adoptedProfile: string | undefined;
  const observations: string[] = [];
  let renderer: Renderer;
  try {
    renderer = await launch();
  } catch (error) {
    return {
      seed,
      campaign: 'E',
      seededKv,
      actions,
      verdict: 'BROKEN',
      detail: `launch threw: ${error instanceof Error ? error.message : String(error)}`,
      observations,
      kvWrites: mockKvLog.length,
      finalScreen: 'error',
    };
  }

  const check = (): string | null => {
    const screen = screenOf(renderer);
    if (screen === 'error') return 'RootErrorBoundary fired';
    if (screen === 'ambiguous') return 'two screens (or none) rendered';
    if (!signedIn) {
      if (screen !== stage) return `model ${stage} but screen ${screen}`;
      if (screen === 'onboarding') {
        const text = allText(renderer);
        if (text.includes('What should we call you?')) {
          if (/skip/i.test(text)) return 'step one offers a skip';
          if (pressables(renderer, 'Leave setup').length > 0) {
            return 'step one offers Leave setup pre-auth';
          }
          const back = pressables(renderer, 'Back');
          if (back.length !== 1) return `${back.length} Back controls`;
          if (
            back[0]!.props.accessibilityHint !== 'Return to the welcome screen'
          ) {
            return 'step-one Back does not return to Welcome';
          }
          const name = firstNameOnScreen(renderer) ?? '';
          const cont = pressables(renderer, 'Continue');
          if (cont.length !== 1) return `${cont.length} Continue controls`;
          const disabled = Boolean(cont[0]!.props.disabled);
          if (disabled !== (name.trim().length === 0)) {
            return `Continue disabled=${disabled} for name.trim().length=${name.trim().length}`;
          }
        }
      }
      // Pre-auth may write ONLY the two stashes, and only from the
      // notifications step.
      const foreign = mockKvLog.filter(w => !STASH_KEYS.includes(w.key));
      if (foreign.length > 0) return `pre-auth wrote ${foreign[0]!.key}`;
    }
    return null;
  };

  detail = check();
  // Roughly a third of the sequences are long enough to finish the
  // questionnaire and exercise the stash / fault-injection / adoption tail.
  const length =
    rng() < 0.35 ? intBetween(rng, 24, 48) : intBetween(rng, 4, 24);
  for (let step = 0; step < length && !detail && !signedIn; step += 1) {
    const text = allText(renderer);
    let candidates: Action[];
    if (stage === 'welcome') {
      candidates = [
        'welcome.start',
        'welcome.start',
        'welcome.start.doubleTap',
        'welcome.link',
      ];
    } else if (stage === 'signin') {
      candidates = ['signin.back', 'signin.back', 'signin.guest'];
    } else if (text.includes('What should we call you?')) {
      const [cont] = pressables(renderer, 'Continue');
      candidates = cont?.props.disabled
        ? [
            'onboarding.typeName',
            'onboarding.typeName',
            'onboarding.typeName',
            'onboarding.continue',
            'onboarding.back',
          ]
        : [
            'onboarding.typeName',
            'onboarding.continue',
            'onboarding.continue',
            'onboarding.back',
          ];
    } else if (text.includes('YOUR STARTING PLAN')) {
      candidates = [
        'onboarding.continue',
        'onboarding.continue',
        'onboarding.back',
      ];
    } else if (text.includes('Stay match-ready.')) {
      candidates = [
        'onboarding.notNow',
        'onboarding.notNow',
        'onboarding.turnOn',
        'onboarding.notNow.storageFault',
        'onboarding.back',
      ];
    } else {
      const [cont] = pressables(renderer, 'Continue');
      candidates = cont?.props.disabled
        ? [
            'onboarding.choose',
            'onboarding.choose',
            'onboarding.choose',
            'onboarding.back',
          ]
        : [
            'onboarding.choose',
            'onboarding.continue',
            'onboarding.continue',
            'onboarding.back',
          ];
    }
    const action = pick(rng, candidates);
    try {
      switch (action) {
        case 'welcome.start':
          await pressAsync(renderer, 'Start your first read');
          stage = 'onboarding';
          actions.push(action);
          break;
        case 'welcome.start.doubleTap': {
          const [node] = pressables(renderer, 'Start your first read');
          act(() => {
            node!.props.onPress();
            node!.props.onPress();
          });
          await settle();
          stage = 'onboarding';
          actions.push(action);
          break;
        }
        case 'welcome.link':
          await pressAsync(renderer, 'I already have an account');
          stage = 'signin';
          actions.push(action);
          break;
        case 'onboarding.typeName': {
          const payload = malformedName(rng);
          typedName = payload.value as string;
          act(() => {
            renderer.root.findByType(TextInput).props.onChangeText(typedName);
          });
          await settle();
          actions.push(`${action}(${payload.describe})`);
          const shown = firstNameOnScreen(renderer);
          if (shown !== typedName) detail = 'name field lost the typed text';
          break;
        }
        case 'onboarding.continue': {
          const [cont] = pressables(renderer, 'Continue');
          if (!cont) throw new Error('no Continue');
          if (cont.props.disabled) {
            actions.push(`${action}(disabled)`);
            break;
          }
          await pressAsync(renderer, 'Continue');
          actions.push(action);
          break;
        }
        case 'onboarding.choose': {
          const radios = pressables(renderer).filter(
            n => n.props.accessibilityRole === 'radio',
          );
          if (radios.length === 0)
            throw new Error('no choices on a choice step');
          const choice = pick(rng, radios);
          await pressAsync(renderer, choice.props.accessibilityLabel);
          actions.push(`${action}(${choice.props.accessibilityLabel})`);
          break;
        }
        case 'onboarding.back': {
          const wasStepOne = text.includes('What should we call you?');
          await pressAsync(renderer, 'Back');
          if (wasStepOne) stage = 'welcome';
          actions.push(`${action}${wasStepOne ? '(step-one)' : ''}`);
          break;
        }
        case 'onboarding.notNow':
          await pressAsync(renderer, 'Not now');
          stage = 'signin';
          actions.push(action);
          break;
        case 'onboarding.turnOn':
          await pressAsync(renderer, 'Turn on reminders');
          stage = 'signin';
          actions.push(action);
          break;
        case 'onboarding.notNow.storageFault': {
          const before = new Map(mockKv);
          mockKvFailWrites = intBetween(rng, 1, 2);
          await pressAsync(renderer, 'Not now');
          mockKvFailWrites = 0;
          actions.push(action);
          const after = screenOf(renderer);
          if (after === 'signin') {
            // Both stash writes had to succeed for the flow to move on.
            const profileRaw = mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY);
            if (!profileRaw)
              detail = 'advanced to sign-in without a stashed profile';
            stage = 'signin';
          } else if (after !== 'onboarding') {
            detail = `storage fault routed to ${after}`;
          } else {
            const errorShown =
              allText(renderer).includes('SQLITE_FULL') ||
              allText(renderer).includes('could not be saved');
            const { onboardingError } = useAppStore.getState();
            const notifPending = mockKv.get(
              PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
            );
            if (
              mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY) !==
                before.get(PENDING_ONBOARDING_PROFILE_KV_KEY) &&
              !onboardingError
            ) {
              detail = 'profile stash changed without an error';
            } else if (
              !errorShown &&
              !onboardingError &&
              notifPending ===
                before.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)
            ) {
              detail =
                'storage fault swallowed silently (no error, no write, no advance)';
            }
          }
          break;
        }
        case 'signin.back':
          await pressAsync(renderer, 'Back');
          stage = 'welcome';
          actions.push(action);
          break;
        case 'signin.guest': {
          await pressAsync(renderer, 'Continue as guest');
          await settle();
          signedIn = true;
          actions.push(action);
          const after = screenOf(renderer);
          const guestKey = profileKeyForOwner(GUEST_DATA_OWNER);
          const guestRowSeeded =
            seededKeys.has(guestKey) || seededKeys.has('profile');
          if (after === 'profile-error' && guestRowSeeded) {
            const shown = allText(renderer);
            const from = shown.indexOf('Your coaching profile couldn’t load');
            observations.push(
              `corrupt-owner-row→ErrorState(${JSON.stringify(shown.slice(from + 35, from + 135))})`,
            );
            if (
              seededKeys.has('profile') &&
              mockKvLog.some(w => w.key === guestKey)
            ) {
              observations.push('legacy-corrupt-row-copied');
            }
          } else if (after !== 'main' && after !== 'account-onboarding') {
            detail = `guest sign-in landed on ${after}`;
          }
          const adopted = mockKv.get(guestKey);
          if (adopted) {
            try {
              const parsed = JSON.parse(adopted) as Record<string, unknown>;
              adoptedProfile = Object.entries(parsed)
                .map(
                  ([k, v]) =>
                    `${k}:${typeof v}${typeof v === 'string' ? `[${Array.from(v).length}]` : ''}`,
                )
                .join(',');
              const storeProfile = useAppStore.getState().profile as Record<
                string,
                unknown
              > | null;
              if (
                after === 'main' &&
                storeProfile &&
                (typeof storeProfile['skillLevel'] !== 'string' ||
                  typeof storeProfile['focusCheckpoint'] !== 'string')
              ) {
                observations.push(
                  `non-Profile-object-accepted(${Object.keys(storeProfile).join(',')})`,
                );
              }
            } catch {
              if (!guestRowSeeded) detail = 'app wrote a non-JSON profile row';
            }
          }
          break;
        }
      }
    } catch (error) {
      detail = `${action} threw: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!detail) detail = check();
    if (!detail && stage === 'signin' && !signedIn) {
      const last = actions[actions.length - 1] ?? '';
      if (
        !last.startsWith('welcome.link') &&
        !last.startsWith('onboarding.notNow') &&
        !last.startsWith('onboarding.turnOn') &&
        !last.startsWith('signin.')
      ) {
        detail = `sign-in reached via ${last}`;
      }
    }
  }

  const stashRaw = mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY);
  if (stashRaw && !seededKeys.has(PENDING_ONBOARDING_PROFILE_KV_KEY)) {
    try {
      const parsed = JSON.parse(stashRaw) as {
        profile?: { firstName?: unknown };
      };
      const name = parsed.profile?.firstName;
      if (typeof name === 'string')
        stashedNameCodePoints = Array.from(name).length;
    } catch {
      detail = detail ?? 'written stash is not JSON';
    }
  } else if (
    stashRaw &&
    mockKvLog.some(w => w.key === PENDING_ONBOARDING_PROFILE_KV_KEY)
  ) {
    try {
      const parsed = JSON.parse(stashRaw) as {
        profile?: { firstName?: unknown };
      };
      const name = parsed.profile?.firstName;
      if (typeof name === 'string')
        stashedNameCodePoints = Array.from(name).length;
    } catch {
      detail = detail ?? 'written stash is not JSON';
    }
  }
  if (!detail && typedName !== null && stashedNameCodePoints !== undefined) {
    // The stash must hold the TRIMMED name, never raw whitespace padding.
    const parsed = JSON.parse(stashRaw!) as { profile: { firstName?: string } };
    const stored = parsed.profile.firstName;
    if (stored !== undefined && stored !== stored.trim()) {
      detail = 'stash keeps untrimmed name';
    }
  }
  if ((stashedNameCodePoints ?? 0) > 40) {
    observations.push(`over-cap-name-stashed(${stashedNameCodePoints})`);
  }
  const finalScreen = screenOf(renderer);
  unmount();
  const row: Row = {
    seed,
    campaign: 'E',
    seededKv,
    actions,
    verdict: detail ? 'BROKEN' : 'HELD',
    ...(detail ? { detail } : {}),
    observations,
    kvWrites: mockKvLog.length,
    finalScreen,
    ...(stashedNameCodePoints !== undefined ? { stashedNameCodePoints } : {}),
    ...(adoptedProfile !== undefined ? { adoptedProfile } : {}),
  };
  return row;
}

describe('STRESS mod-launch-gate / boundary-malformed — App Gate render level', () => {
  afterEach(() => {
    unmount();
  });

  afterAll(() => {
    const dir = artifactDir();
    const rowsFile = path.join(dir, 'app-gate.rows.json');
    const summaryFile = path.join(dir, 'app-gate.summary.json');
    fs.writeFileSync(rowsFile, JSON.stringify(rows, null, 1));
    fs.writeFileSync(
      summaryFile,
      JSON.stringify(
        {
          unit: 'mod-launch-gate',
          lens: 'boundary-malformed',
          level: 'app-gate-render',
          masterSeed: MASTER_SEED,
          sequencesRequested: SEQUENCES,
          sequencesExecuted: rows.length,
          interactionsExecuted: rows.reduce((n, r) => n + r.actions.length, 0),
          seededKvRows: rows.reduce((n, r) => n + r.seededKv.length, 0),
          brokenSeeds: broken.map(r => r.seed),
          overCapNamesStashed: rows.filter(
            r => (r.stashedNameCodePoints ?? 0) > 40,
          ).length,
          observations: rows
            .flatMap(r => r.observations.map(o => ({ seed: r.seed, o })))
            .reduce<Record<string, number[]>>((acc, { seed, o }) => {
              const key = o.replace(/\(.*$/, '');
              (acc[key] ??= []).push(seed);
              return acc;
            }, {}),
          verdict: broken.length === 0 ? 'HELD' : 'BROKEN',
        },
        null,
        1,
      ),
    );
    console.warn(
      `[stress:launch-gate:app-gate] ${rows.length} sequences, ${broken.length} broken → ${summaryFile}`,
    );
  });

  test(`E: ${SEQUENCES} seeded malformed launch sequences hold every gate invariant`, async () => {
    // A sequence is a pure function of its seed, so a replay runs the seed
    // directly whatever STRESS_ITER produced it.
    const seeds =
      ONLY_SEED !== null
        ? [ONLY_SEED]
        : Array.from(
            { length: SEQUENCES },
            (_, i) => (Math.imul(i + 1, 0x9e3779b1) ^ MASTER_SEED) >>> 0,
          );
    for (const seed of seeds) {
      const row = await runSequence(seed);
      rows.push(row);
      if (row.verdict === 'BROKEN') broken.push(row);
    }
    expect(
      broken
        .map(r => ({ seed: r.seed, detail: r.detail, actions: r.actions }))
        .slice(0, 10),
    ).toEqual([]);
  }, 600_000);
});
