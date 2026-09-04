/**
 * xc-screen-ux-a11y-i18n-4 — destructive-action random walk.
 *
 * Seeded fuzzing of the two destructive flows the audit covers:
 *
 *   ManageAccountScreen → Delete account (exit survey → review → armed → delete)
 *   SettingsScreen     → Sign out sheet
 *
 * Every walk activates a random sequence of host-level pressables through the
 * accessibility-activate path (`onClick`, what VoiceOver double-tap dispatches),
 * randomly types into the survey comment field, fires the hardware-back /
 * `onRequestClose` path, and advances fake time by random amounts — while the
 * network stubs succeed, hang, or fail with every AccountDeletionError shape
 * the client distinguishes. After every step the safety invariants are checked:
 *
 *   D1  confirmAccountDeletion is only ever called by activating the ENABLED
 *       control labelled exactly "Permanently delete" while the dialog is in
 *       the armed state with the countdown at zero — never from the row, the
 *       survey, the review page, a disabled countdown button, the scrim or
 *       hardware back.
 *   D2  requestAccountDeletion is only ever called from "Continue to delete".
 *   D3  completeAccountDeletion (the local purge) happens only after a
 *       confirm that resolved; a failed confirm never purges and leaves honest
 *       "Nothing was deleted" copy + a retry control.
 *   D4  While a request/confirm is in flight, the scrim is disabled and
 *       hardware back is rejected (`onRequestClose` undefined).
 *   D5  Whenever the dialog is open there is a node flagged
 *       accessibilityViewIsModal, and every host pressable exposes a label.
 *   S1  signOut is only ever called by the "Sign out" control INSIDE the open
 *       confirmation sheet — the Settings row with the same label never signs
 *       out directly, and neither do "Keep me signed in", the scrim or back.
 *
 * A violation prints the seed and the full action trace; replay with
 * `XC_SEED_ONLY=<seed> npx jest destructiveRandomWalk`. Every walk's trace
 * lands in artifacts/xc-screen-ux-a11y-i18n-4/destructive-random-walk.json.
 */
import React from 'react';
import { Linking, Modal, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  mkdirSync: (dir: string, opts: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

jest.mock('../../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => insets,
    initialWindowMetrics: null,
  };
});

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
  useFocusEffect: () => undefined,
}));

jest.mock('../../../src/review/appStoreReview', () => ({
  rateAppFromSettings: () => Promise.resolve(),
}));

jest.mock('../../../src/walkthrough/walkthroughStore', () => ({
  useWalkthroughStore: { getState: () => ({ replay: jest.fn() }) },
}));

jest.mock('../../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: null,
    googleWebClientId: null,
    appVersion: '1.0.0 (1)',
    legalPrivacyUrl: 'https://api.example.test/privacy',
    legalTermsUrl: 'https://api.example.test/terms',
  }),
}));

const mockRequestAccountDeletion = jest.fn<
  Promise<{ challenge: string; expiresAt: string }>,
  unknown[]
>();
const mockConfirmAccountDeletion = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../../../src/account/deletion', () => {
  const actual = jest.requireActual<
    typeof import('../../../src/account/deletion')
  >('../../../src/account/deletion');
  return {
    ...actual,
    requestAccountDeletion: (...args: unknown[]) =>
      mockRequestAccountDeletion(...args),
    confirmAccountDeletion: (...args: unknown[]) =>
      mockConfirmAccountDeletion(...args),
  };
});

import { ManageAccountScreen } from '../../../src/screens/ManageAccountScreen';
import { SettingsScreen } from '../../../src/screens/SettingsScreen';
import { useAuthStore, type AuthSession } from '../../../src/auth/authStore';
import { useAppStore } from '../../../src/state/appStore';
import { useConsentStore } from '../../../src/state/consentStore';
import { useNotificationStore } from '../../../src/notifications/notificationStore';
import { DEFAULT_NOTIFICATION_PREFS } from '../../../src/notifications/types';
import { useConsistencyStore } from '../../../src/consistency/store';
import { useAccessStore } from '../../../src/state/accessStore';
import { AccountDeletionError } from '../../../src/account/deletion';

const ARTIFACT_DIR =
  process.env.XC_ARTIFACT_DIR ??
  path.resolve(__dirname, '../../../../../artifacts/xc-screen-ux-a11y-i18n-4');
const DELETE_WALKS = Number(process.env.XC_DELETE_WALKS ?? 240);
const SIGNOUT_WALKS = Number(process.env.XC_SIGNOUT_WALKS ?? 120);
const SEED_ONLY = process.env.XC_SEED_ONLY
  ? Number(process.env.XC_SEED_ONLY)
  : null;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: '22222222-2222-4222-8222-222222222222',
  canonicalAppUserId: '22222222-2222-4222-8222-222222222222',
  localOnly: false,
  displayName: 'Sam Rivera',
  email: 'sam@example.com',
};

type Host = TestRenderer.ReactTestInstance;

function hostPressables(renderer: TestRenderer.ReactTestRenderer): Host[] {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' && typeof node.props.onClick === 'function',
  );
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(Infinity)
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function modalVisible(renderer: TestRenderer.ReactTestRenderer): boolean {
  return renderer.root.findAllByType(Modal).some(m => m.props.visible === true);
}

function modalNode(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType(Modal).find(m => m.props.visible === true);
}

function hasModalFlag(renderer: TestRenderer.ReactTestRenderer): boolean {
  return (
    renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityViewIsModal === true,
    ).length > 0
  );
}

function nameOf(node: Host): string {
  if (typeof node.props.accessibilityLabel === 'string') {
    return node.props.accessibilityLabel;
  }
  return node
    .findAllByType(Text)
    .map(n => n.props.children)
    .flat(Infinity)
    .filter((c): c is string => typeof c === 'string')
    .join(' ')
    .trim();
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const FORWARD_LABELS = new Set([
  'Next',
  'Skip the survey',
  'Continue',
  'Skip this question',
  'Continue to delete',
]);

const ADVERSARIAL_TEXT = [
  '',
  '   ',
  'a'.repeat(600),
  '🙂🙃😉'.repeat(80),
  '\u202eDELETE NOW\u202c',
  'Line one\nLine two\r\nLine three',
  '<script>alert(1)</script>',
  'مرحبا بالعالم',
  '\u0000\u0001\u0002',
];

interface Step {
  step: number;
  action: string;
  target: string | null;
  disabled: boolean | null;
  modalBefore: boolean;
  requestCalls: number;
  confirmCalls: number;
  purgeCalls: number;
}

interface WalkRecord {
  flow: 'delete' | 'signout';
  seed: number;
  scenario: Record<string, string>;
  steps: Step[];
  outcome: string;
  violations: string[];
}

const walks: WalkRecord[] = [];

beforeAll(() => {
  // The RN jest preset's Linking.openURL returns undefined; the screens chain
  // `.catch` on it. Alternate success/failure so the failure notice path runs.
  let calls = 0;
  jest.spyOn(Linking, 'openURL').mockImplementation(() => {
    calls += 1;
    return calls % 3 === 0
      ? Promise.reject(new Error('no handler'))
      : Promise.resolve();
  });
});

afterAll(() => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    walks: walks.length,
    steps: walks.reduce((n, w) => n + w.steps.length, 0),
    violations: walks.filter(w => w.violations.length > 0).map(w => w.seed),
    outcomes: walks.reduce<Record<string, number>>((acc, w) => {
      acc[`${w.flow}:${w.outcome}`] = (acc[`${w.flow}:${w.outcome}`] ?? 0) + 1;
      return acc;
    }, {}),
    rows: walks,
  };
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'destructive-random-walk.json'),
    JSON.stringify(summary, null, 2),
  );
});

// ---------------------------------------------------------------------------
// Delete account
// ---------------------------------------------------------------------------

type NetBehaviour =
  | 'resolve'
  | 'hang'
  | 'reject-generic'
  | 'reject-retryable'
  | 'reject-final'
  | 'reject-session';

const NET: NetBehaviour[] = [
  'resolve',
  'resolve',
  'resolve',
  'hang',
  'reject-generic',
  'reject-retryable',
  'reject-final',
  'reject-session',
];

function behave<T>(kind: NetBehaviour, value: T): Promise<T> {
  switch (kind) {
    case 'resolve':
      return Promise.resolve(value);
    case 'hang':
      return new Promise<T>(() => undefined);
    case 'reject-generic':
      return Promise.reject(new Error('503'));
    case 'reject-retryable':
      return Promise.reject(
        new AccountDeletionError(
          'deletion.unavailable',
          'Account deletion is temporarily unavailable. Nothing was deleted.',
          true,
        ),
      );
    case 'reject-final':
      return Promise.reject(
        new AccountDeletionError(
          'deletion.rejected',
          'The deletion could not be confirmed. Nothing was deleted.',
          false,
        ),
      );
    case 'reject-session':
      return Promise.reject(
        new AccountDeletionError(
          'deletion.session_expired',
          'Your session has expired. Sign in again to delete your account.',
          false,
        ),
      );
  }
}

async function deleteWalk(seed: number): Promise<WalkRecord> {
  const rnd = mulberry32(seed);
  const requestKind = NET[Math.floor(rnd() * NET.length)]!;
  const confirmKind = NET[Math.floor(rnd() * NET.length)]!;
  const maxSteps = 16 + Math.floor(rnd() * 32);
  // Per-walk bias towards the "forward" controls so a meaningful share of
  // walks actually reaches the armed confirm; the rest is uniform chaos.
  const forwardBias = 0.25 + rnd() * 0.6;
  const violations: string[] = [];
  const steps: Step[] = [];
  const purge = jest.fn(() => Promise.resolve());

  mockRequestAccountDeletion.mockReset();
  mockConfirmAccountDeletion.mockReset();
  mockRequestAccountDeletion.mockImplementation(() =>
    behave(requestKind, {
      challenge: `c-${seed}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
    }),
  );
  mockConfirmAccountDeletion.mockImplementation(() =>
    behave(confirmKind, { appleAuthorizationRevocation: 'revoked' }),
  );

  jest.useFakeTimers();
  act(() => {
    useAuthStore.setState({
      hydrated: true,
      session: syncedSession,
      busy: false,
      error: null,
      completeAccountDeletion: purge,
    });
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<ManageAccountScreen />);
  });

  const violate = (what: string, stepIndex: number) =>
    violations.push(`step ${stepIndex}: ${what}`);

  try {
    // Step 0 always opens the dialog so walks spend their budget inside it.
    const opener = hostPressables(renderer).find(
      n => n.props.accessibilityLabel === 'Delete account',
    );
    if (!opener) throw new Error('Delete account link missing');
    await act(async () => {
      opener.props.onClick();
    });
    await settle();

    for (let i = 1; i <= maxSteps; i += 1) {
      if (!modalVisible(renderer)) {
        // Closed: reopen (mirrors a user going back in) half the time, else end.
        if (rnd() < 0.5) break;
        const again = hostPressables(renderer).find(
          n => n.props.accessibilityLabel === 'Delete account',
        );
        if (!again) break;
        await act(async () => {
          again.props.onClick();
        });
        await settle();
        steps.push({
          step: i,
          action: 'reopen',
          target: 'Delete account',
          disabled: false,
          modalBefore: false,
          requestCalls: mockRequestAccountDeletion.mock.calls.length,
          confirmCalls: mockConfirmAccountDeletion.mock.calls.length,
          purgeCalls: purge.mock.calls.length,
        });
        continue;
      }

      const requestBefore = mockRequestAccountDeletion.mock.calls.length;
      const confirmBefore = mockConfirmAccountDeletion.mock.calls.length;
      const purgeBefore = purge.mock.calls.length;
      const textBefore = allText(renderer);
      const modalBefore = modalVisible(renderer);
      const modal = modalNode(renderer);
      const pressables = hostPressables(renderer);
      // Busy = a request/confirm is in flight: the dialog disables its scrim
      // and the footer shows the in-progress label.
      const busyBefore = pressables.some(
        n =>
          (n.props.accessibilityLabel === 'Requesting…' ||
            n.props.accessibilityLabel === 'Deleting…') &&
          n.props.accessibilityState?.disabled === true,
      );
      const scrimDisabled = pressables.some(
        n =>
          n.props.accessibilityLabel === 'Cancel account deletion' &&
          n.props.accessibilityState?.disabled === true,
      );
      if (busyBefore !== scrimDisabled) {
        violate(
          `busy footer (${busyBefore}) and scrim disabled (${scrimDisabled}) disagree`,
          i,
        );
      }

      // D5: modal semantics + labelled pressables at every open state.
      if (!hasModalFlag(renderer)) {
        violate('dialog open without accessibilityViewIsModal', i);
      }
      for (const node of hostPressables(renderer)) {
        if (nameOf(node).length === 0) {
          violate(
            `unlabelled pressable ${JSON.stringify(node.props.testID ?? null)}`,
            i,
          );
        }
      }

      const armedCountdown = pressables.some(n =>
        String(n.props.accessibilityLabel ?? '').startsWith(
          'Permanently delete (',
        ),
      );
      const forward = pressables.filter(n => {
        const label = String(n.props.accessibilityLabel ?? '');
        return (
          FORWARD_LABELS.has(label) || label.startsWith('Permanently delete')
        );
      });
      const roll = rnd();
      let action: string;
      let target: string | null = null;
      let disabled: boolean | null = null;

      if (rnd() < forwardBias && (armedCountdown || forward.length > 0)) {
        if (armedCountdown && rnd() < 0.6) {
          const ms = 1000 + Math.floor(rnd() * 5500);
          action = `advance ${ms}ms`;
          await act(async () => {
            jest.advanceTimersByTime(ms);
          });
        } else {
          const node = forward[Math.floor(rnd() * forward.length)]!;
          target = nameOf(node);
          disabled = node.props.accessibilityState?.disabled === true;
          action = 'press';
          await act(async () => {
            node.props.onClick();
          });
        }
      } else if (roll < 0.12) {
        // Advance the countdown / pending timers.
        const ms = Math.floor(rnd() * 6500);
        action = `advance ${ms}ms`;
        await act(async () => {
          jest.advanceTimersByTime(ms);
        });
      } else if (roll < 0.2) {
        action = 'hardware-back';
        const onRequestClose = modal?.props.onRequestClose;
        // D4: busy dialogs reject hardware back entirely.
        if (busyBefore && typeof onRequestClose === 'function') {
          violate('onRequestClose available while busy', i);
        }
        if (!busyBefore && typeof onRequestClose !== 'function') {
          violate('onRequestClose missing while idle', i);
        }
        if (typeof onRequestClose === 'function') {
          await act(async () => {
            onRequestClose();
          });
        }
      } else if (roll < 0.3) {
        const inputs = renderer.root.findAllByType(TextInput);
        if (inputs.length > 0) {
          const input = inputs[Math.floor(rnd() * inputs.length)]!;
          const text =
            ADVERSARIAL_TEXT[Math.floor(rnd() * ADVERSARIAL_TEXT.length)]!;
          action = `type ${JSON.stringify(text.slice(0, 24))}${text.length > 24 ? '…' : ''}`;
          await act(async () => {
            input.props.onChangeText?.(text);
          });
        } else {
          action = 'type (no input)';
        }
      } else {
        const node = pressables[Math.floor(rnd() * pressables.length)]!;
        target = nameOf(node);
        disabled = node.props.accessibilityState?.disabled === true;
        action = 'press';
        await act(async () => {
          node.props.onClick();
        });
      }
      await settle();

      const requestAfter = mockRequestAccountDeletion.mock.calls.length;
      const confirmAfter = mockConfirmAccountDeletion.mock.calls.length;
      const purgeAfter = purge.mock.calls.length;
      const textAfter = allText(renderer);

      // D2
      if (requestAfter > requestBefore) {
        if (action !== 'press' || target !== 'Continue to delete' || disabled) {
          violate(
            `requestAccountDeletion fired by ${action} ${JSON.stringify(target)} disabled=${disabled}`,
            i,
          );
        }
        if (requestAfter - requestBefore !== 1) {
          violate(
            `requestAccountDeletion fired ${requestAfter - requestBefore}× in one step`,
            i,
          );
        }
      }
      // D1
      if (confirmAfter > confirmBefore) {
        if (action !== 'press' || target !== 'Permanently delete' || disabled) {
          violate(
            `confirmAccountDeletion fired by ${action} ${JSON.stringify(target)} disabled=${disabled}`,
            i,
          );
        }
        if (requestBefore < 1) {
          violate('confirmAccountDeletion before any request', i);
        }
        if (!textBefore.includes('Delete your account?')) {
          violate('confirm fired outside the review/armed page', i);
        }
        if (busyBefore) violate('confirm fired while busy', i);
        if (confirmAfter - confirmBefore !== 1) {
          violate(
            `confirmAccountDeletion fired ${confirmAfter - confirmBefore}× in one step`,
            i,
          );
        }
        const [, challenge] =
          mockConfirmAccountDeletion.mock.calls[confirmAfter - 1]!;
        if (challenge !== `c-${seed}`) {
          violate(`confirm used challenge ${String(challenge)}`, i);
        }
      }
      // D3
      if (purgeAfter > purgeBefore) {
        if (confirmKind !== 'resolve') {
          violate(`local purge ran although confirm ${confirmKind}`, i);
        }
        if (confirmAfter < 1) violate('purge without confirm', i);
      }
      if (confirmAfter > confirmBefore && confirmKind.startsWith('reject')) {
        if (
          !textAfter.includes('Nothing was deleted') &&
          !textAfter.includes('Sign in again')
        ) {
          violate(
            `failed confirm without honest copy: ${textAfter.slice(0, 200)}`,
            i,
          );
        }
        if (purgeAfter !== purgeBefore)
          violate('purge after failed confirm', i);
      }
      // A disabled control must be inert.
      if (action === 'press' && disabled) {
        if (requestAfter !== requestBefore || confirmAfter !== confirmBefore) {
          violate(
            `disabled control ${JSON.stringify(target)} triggered a network call`,
            i,
          );
        }
      }

      steps.push({
        step: i,
        action,
        target,
        disabled,
        modalBefore,
        requestCalls: requestAfter,
        confirmCalls: confirmAfter,
        purgeCalls: purgeAfter,
      });
      if (purgeAfter > 0) break;
    }
  } finally {
    act(() => renderer.unmount());
    jest.useRealTimers();
  }

  const outcome =
    purge.mock.calls.length > 0
      ? 'deleted'
      : mockConfirmAccountDeletion.mock.calls.length > 0
        ? 'confirm-attempted'
        : mockRequestAccountDeletion.mock.calls.length > 0
          ? 'requested'
          : 'never-requested';
  return {
    flow: 'delete',
    seed,
    scenario: {
      request: requestKind,
      confirm: confirmKind,
      maxSteps: String(maxSteps),
    },
    steps,
    outcome,
    violations,
  };
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

async function signOutWalk(seed: number): Promise<WalkRecord> {
  const rnd = mulberry32(seed);
  const maxSteps = 6 + Math.floor(rnd() * 14);
  // authStore.signOut swallows every persistence/provider failure internally
  // (it clears the session first, then best-effort cleanup), so the only
  // shapes the screen can observe are "resolved" and "still pending".
  const signOutKind: 'resolve' | 'hang' = rnd() < 0.7 ? 'resolve' : 'hang';
  const signOut = jest.fn(() =>
    signOutKind === 'resolve'
      ? Promise.resolve()
      : new Promise<void>(() => undefined),
  );
  const violations: string[] = [];
  const steps: Step[] = [];

  act(() => {
    useAuthStore.setState({
      hydrated: true,
      session: {
        ...syncedSession,
        provider: 'google',
        displayName: 'Alex Chen',
      },
      busy: false,
      error: null,
      signOut,
    });
    useAppStore.setState({
      hydrated: true,
      profile: {
        firstName: 'Alex',
        gender: 'female',
        skillLevel: 'intermediate',
        handedness: 'right',
        focusCheckpoint: 'contact_point',
      } as never,
    });
    useConsentStore.setState({
      availability: 'ready',
      modelTrainingActive: false,
      busy: false,
      error: null,
      hydrate: jest.fn(() => Promise.resolve()),
    });
    useNotificationStore.setState({
      prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
      permission: 'granted',
    });
    useConsistencyStore.setState({ snapshot: null });
    useAccessStore.setState({ canonicalAccess: null });
  });

  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<SettingsScreen />);
  });
  const violate = (what: string, stepIndex: number) =>
    violations.push(`step ${stepIndex}: ${what}`);

  try {
    for (let i = 1; i <= maxSteps; i += 1) {
      const before = signOut.mock.calls.length;
      const modalBefore = modalVisible(renderer);
      const modal = modalNode(renderer);
      const pressables = hostPressables(renderer);

      if (modalBefore && !hasModalFlag(renderer)) {
        violate('sign-out sheet open without accessibilityViewIsModal', i);
      }
      for (const node of pressables) {
        if (nameOf(node).length === 0) {
          violate(
            `unlabelled pressable ${JSON.stringify(node.props.testID ?? null)}`,
            i,
          );
        }
      }

      // Bias towards the sign-out surface so walks actually reach the sheet.
      const signOutRow = pressables.filter(n => nameOf(n) === 'Sign out');
      const roll = rnd();
      let action: string;
      let target: string | null = null;
      let disabled: boolean | null = null;
      let insideSheet = false;

      if (roll < 0.15 && modalBefore) {
        action = 'hardware-back';
        if (typeof modal?.props.onRequestClose === 'function') {
          await act(async () => {
            modal.props.onRequestClose();
          });
        }
      } else {
        const pool =
          roll < 0.6 && signOutRow.length > 0 ? signOutRow : pressables;
        const node = pool[Math.floor(rnd() * pool.length)]!;
        target = nameOf(node);
        disabled = node.props.accessibilityState?.disabled === true;
        action = 'press';
        // The row and the sheet's confirm button share the label "Sign out";
        // only a node rendered inside the visible Modal is the confirm.
        insideSheet =
          modalBefore &&
          modal !== undefined &&
          modal.findAll(n => n === node).length > 0;
        await act(async () => {
          node.props.onClick();
        });
      }
      await settle();
      const after = signOut.mock.calls.length;

      // S1
      if (after > before) {
        if (!modalBefore)
          violate(
            `signOut fired with the sheet closed via ${action} ${JSON.stringify(target)}`,
            i,
          );
        if (
          action !== 'press' ||
          target !== 'Sign out' ||
          !insideSheet ||
          disabled
        ) {
          violate(
            `signOut fired by ${action} ${JSON.stringify(target)} insideSheet=${insideSheet} disabled=${disabled}`,
            i,
          );
        }
        if (after - before !== 1)
          violate(`signOut fired ${after - before}×`, i);
      }
      if (action === 'press' && disabled && after !== before) {
        violate(`disabled ${JSON.stringify(target)} signed out`, i);
      }

      steps.push({
        step: i,
        action,
        target,
        disabled,
        modalBefore,
        requestCalls: 0,
        confirmCalls: after,
        purgeCalls: 0,
      });
    }
  } finally {
    act(() => renderer.unmount());
  }

  return {
    flow: 'signout',
    seed,
    scenario: { signOut: signOutKind, maxSteps: String(maxSteps) },
    steps,
    outcome: signOut.mock.calls.length > 0 ? 'signed-out' : 'stayed-signed-in',
    violations,
  };
}

// ---------------------------------------------------------------------------

function fail(record: WalkRecord) {
  throw new Error(
    `${record.violations.join('\n')}\nseed=${record.seed} replay: XC_SEED_ONLY=${record.seed} npx jest __tests__/xc/screen-ux-a11y-i18n-4/destructiveRandomWalk.test.tsx\nscenario=${JSON.stringify(record.scenario)}\ntrace=${JSON.stringify(record.steps)}`,
  );
}

describe('Delete account — seeded random walk', () => {
  const seeds =
    SEED_ONLY !== null
      ? SEED_ONLY >= 5000
        ? [SEED_ONLY]
        : []
      : Array.from({ length: DELETE_WALKS }, (_, i) => 5000 + i);

  it.each(seeds)(
    'seed %i: deletion only through the armed confirm',
    async seed => {
      const record = await deleteWalk(seed);
      walks.push(record);
      if (record.violations.length > 0) fail(record);
    },
  );

  it('covers every request/confirm outcome across the walk set', () => {
    if (SEED_ONLY !== null) return;
    const outcomes = new Set(
      walks.filter(w => w.flow === 'delete').map(w => w.outcome),
    );
    expect(outcomes.has('deleted')).toBe(true);
    expect(outcomes.has('confirm-attempted')).toBe(true);
    expect(outcomes.has('requested')).toBe(true);
    expect(outcomes.has('never-requested')).toBe(true);
    const failedConfirms = walks.filter(
      w =>
        w.flow === 'delete' &&
        w.scenario.confirm?.startsWith('reject') &&
        w.outcome === 'confirm-attempted',
    );
    expect(failedConfirms.length).toBeGreaterThan(0);
  });
});

describe('Sign out — seeded random walk', () => {
  const seeds =
    SEED_ONLY !== null
      ? SEED_ONLY < 5000
        ? [SEED_ONLY]
        : []
      : Array.from({ length: SIGNOUT_WALKS }, (_, i) => 2000 + i);

  it.each(seeds)(
    'seed %i: sign-out only through the sheet confirm',
    async seed => {
      const record = await signOutWalk(seed);
      walks.push(record);
      if (record.violations.length > 0) fail(record);
    },
  );

  it('reaches both sign-out outcomes across the walk set', () => {
    if (SEED_ONLY !== null) return;
    const outcomes = new Set(
      walks.filter(w => w.flow === 'signout').map(w => w.outcome),
    );
    expect(outcomes.has('signed-out')).toBe(true);
    expect(outcomes.has('stayed-signed-in')).toBe(true);
  });
});
