/**
 * xc-journey-settings-account-deletion — FULL-TREE UI execution harness.
 *
 * Renders the REAL App.tsx (Gate, RootErrorBoundary, BrandNoticeHost,
 * QueryClientProvider) with the REAL authStore / appStore / notificationStore
 * / consentStore / repository (node:sqlite behind the op-sqlite mock) and the
 * REAL SettingsScreen + ManageAccountScreen + DeleteAccountDialog. Only the
 * native leaves are doubled: the network (FakeEdge), the OS notification
 * scheduler, the Keychain (jest mock), the Apple native module, the splash
 * video, the animation-only overlays, and the react-navigation native stack
 * (two-route stand-in so no react-native-screens is needed).
 *
 * Every scenario drives the tree the way a thumb does — accessibility labels
 * and rendered Button labels — and writes a JSON record (request log,
 * rendered copy, local survival matrix, heap) to XC_ARTIFACT_DIR (see helpers/artifactDir.ts).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('@op-engineering/op-sqlite', () => {
  const { sqliteHandle } = require('./helpers/sqliteSingleton');
  const { opSqliteFromHandle } = require('./helpers/nodeSqlite');
  return opSqliteFromHandle(sqliteHandle);
});

jest.mock('../../src/notifications/service', () => {
  const { scheduler } = require('./helpers/schedulerSingleton');
  return {
    getScheduler: () => scheduler,
    subscribeToNotificationPresses: () => () => {},
    registerBackgroundNotificationHandler: () => {},
    screenTargetFromNotificationData: () => null,
  };
});

const mockGoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn().mockResolvedValue(true),
  signIn: jest.fn(),
  signInSilently: jest.fn(),
  signOut: jest.fn().mockResolvedValue(undefined),
  revokeAccess: jest.fn().mockResolvedValue(undefined),
};
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: mockGoogleSignin,
}));

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
  }),
}));

jest.mock('../../src/account/deviceContext', () => ({
  getAccountBootstrapEnvironment: () => ({
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    device: {
      platform: 'ios',
      osVersion: '18.5',
      appVersion: '1.0',
      model: 'iOS phone',
    },
  }),
}));

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

jest.mock('react-native-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
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

// Two-route stand-in for the native stack: the REAL Settings and
// ManageAccount screens are rendered; `navigate`/`goBack` are the mini nav.
jest.mock('@react-navigation/native', () => {
  const React = require('react');
  const { useMiniNav } = require('./helpers/miniNav');
  return {
    __esModule: true,
    useNavigation: () => ({
      navigate: (route: 'Settings' | 'ManageAccount') =>
        useMiniNav.getState().navigate(route),
      goBack: () => useMiniNav.getState().goBack(),
    }),
    useFocusEffect: (callback: () => void | (() => void)) => {
      React.useEffect(() => callback(), [callback]);
    },
  };
});
jest.mock('../../src/navigation/RootNavigator', () => {
  const React = require('react');
  const { View } = require('react-native');
  const { useMiniNav } = require('./helpers/miniNav');
  const { SettingsScreen } = require('../../src/screens/SettingsScreen');
  const {
    ManageAccountScreen,
  } = require('../../src/screens/ManageAccountScreen');
  return {
    RootNavigator: () => {
      const route = useMiniNav((s: { route: string }) => s.route);
      // The real native stack is torn down with the Gate on sign-out and
      // remounts at its initial route; mirror that.
      React.useEffect(() => () => useMiniNav.getState().reset(), []);
      return React.createElement(
        View,
        { testID: `route-${route}` },
        route === 'ManageAccount'
          ? React.createElement(ManageAccountScreen)
          : React.createElement(SettingsScreen),
      );
    },
  };
});

// Out-of-journey leaves: splash video, animation-only overlays.
jest.mock('../../src/screens/SplashScreen', () => {
  const React = require('react');
  return {
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) => {
      React.useEffect(() => {
        if (props.ready) props.onFinished();
      }, [props.ready, props.onFinished]);
      return null;
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

import App from '../../App';
import { Button, PressableScale } from '../../src/design/components';
import { useAuthStore } from '../../src/auth/authStore';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
} from '../../src/data/accountScope';
import { getDb } from '../../src/data/db';
import { OWNER_SCOPED_KV_NAMESPACES } from '../../src/data/repository';
import { useAppStore } from '../../src/state/appStore';
import { useConsentStore } from '../../src/state/consentStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import type { Profile } from '../../src/state/profile';
import {
  OWNER_SCOPED_TABLES,
  classifySurvival,
  seedOwner,
} from './helpers/localSeed';
import { useMiniNav } from './helpers/miniNav';
import {
  LEGAL_SEMANTICS,
  FORBIDDEN_COPY_TERMS,
  checkCopyAgainstLegal,
} from './helpers/legalSemantics';
import {
  advanceClock,
  currentEdge,
  heapNumbers,
  installGlobalFetch,
  installNativeAuth,
  keychainSnapshot,
  processSnapshot,
  relaunchProcess,
  resetWorld,
  scheduler,
  sqliteHandle,
} from './helpers/world';
import { XC_ARTIFACT_DIR } from './helpers/artifactDir';

const ARTIFACT_DIR = XC_ARTIFACT_DIR;
const records: Record<string, unknown>[] = [];
function record(name: string, data: Record<string, unknown>): void {
  records.push({ scenario: name, ...data, heap: heapNumbers() });
}
function writeArtifact(name: string, data: Record<string, unknown>): void {
  writeFileSync(join(ARTIFACT_DIR, name), JSON.stringify(data, null, 2));
}
afterAll(() => {
  writeFileSync(
    join(ARTIFACT_DIR, 'ui.scenarios.json'),
    JSON.stringify(records, null, 2),
  );
});

installGlobalFetch();

const PROFILE: Profile = {
  firstName: 'Pat',
  skillLevel: 'intermediate',
  handedness: 'right',
  goal: 'consistency',
  biggestProblem: 'popping up dinks',
  focusCheckpoint: 'contact_position',
};

type Renderer = TestRenderer.ReactTestRenderer;

/** Drain microtasks + one macrotask turn (setImmediate is never faked). */
async function settle(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
    });
  }
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ')
    .replace(/\s+/g, ' ');
}

function pressables(renderer: Renderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
}

async function press(renderer: Renderer, label: string): Promise<void> {
  const matches = pressables(renderer, label);
  if (matches.length === 0) {
    throw new Error(
      `no pressable "${label}" in tree; copy: ${allText(renderer).slice(0, 600)}`,
    );
  }
  await act(async () => {
    matches[0]!.props.onPress();
  });
  await settle();
}

function sheetButton(renderer: Renderer, label: string) {
  const matches = renderer.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(label));
  if (matches.length === 0) {
    throw new Error(
      `no Button "${label}" in tree; copy: ${allText(renderer).slice(0, 600)}`,
    );
  }
  return matches[0]!;
}

async function pressButton(renderer: Renderer, label: string): Promise<void> {
  const button = sheetButton(renderer, label);
  expect(button.props.disabled).not.toBe(true);
  await act(async () => {
    button.props.onPress();
  });
  await settle();
}

function radios(renderer: Renderer) {
  return renderer.root
    .findAllByType(PressableScale)
    .filter(node => node.props.accessibilityRole === 'radio');
}

let live: Renderer | null = null;

async function launchApp(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
  });
  live = renderer;
  await settle(8);
  return renderer;
}

async function unmount(renderer: Renderer): Promise<void> {
  await act(async () => {
    renderer.unmount();
  });
  if (live === renderer) live = null;
}

/** Welcome → "I already have an account" → Continue with Apple →
 * in-account onboarding (profile saved through the real appStore) → main
 * app (RootNavigator stand-in on Settings). */
async function signInThroughUi(
  renderer: Renderer,
  subject: string,
): Promise<{ canonicalId: string; owner: string }> {
  expect(
    pressables(renderer, 'I already have an account').length,
  ).toBeGreaterThan(0);
  await press(renderer, 'I already have an account');
  installNativeAuth(subject);
  await press(renderer, 'Continue with Apple');
  await settle(8);
  const session = useAuthStore.getState().session;
  if (!session?.canonicalAppUserId) {
    throw new Error(
      `UI sign-in failed: ${JSON.stringify(useAuthStore.getState().error)}`,
    );
  }
  // No profile yet → the Gate shows the in-account OnboardingScreen; the
  // questionnaire itself is out of this journey's scope, so the profile is
  // saved through the same store action its final step calls.
  await act(async () => {
    await useAppStore.getState().completeOnboarding(PROFILE);
  });
  await settle(8);
  expect(
    renderer.root.findAllByProps({ testID: 'route-Settings' }).length,
  ).toBeGreaterThan(0);
  return {
    canonicalId: session.canonicalAppUserId,
    owner: canonicalDataOwner(session.canonicalAppUserId),
  };
}

async function populateThroughStores(owner: string, tag: string) {
  await act(async () => {
    await useNotificationStore.getState().requestPermissionAndEnable();
    await useNotificationStore.getState().setPrefs({
      practiceReminderMinutes: 20 * 60,
    });
    await useConsentStore.getState().setModelTrainingConsent(true);
  });
  const seeded = await seedOwner(getDb(), owner, tag);
  await settle();
  return seeded;
}

async function openManageAccount(renderer: Renderer): Promise<void> {
  await press(renderer, 'Manage account, Details');
  expect(useMiniNav.getState().route).toBe('ManageAccount');
  expect(allText(renderer)).toContain('Account details');
}

/** Step 1 through the real dialog under fake timers; returns the rendered
 * review copy captured BEFORE the request is sent. */
async function continueToDelete(renderer: Renderer): Promise<string> {
  const reviewCopy = allText(renderer);
  expect(reviewCopy).toContain('Delete your account?');
  await pressButton(renderer, 'Continue to delete');
  return reviewCopy;
}

/** Runs the 5s arm hold-off under fake timers and returns the final button. */
async function armAndConfirm(renderer: Renderer): Promise<void> {
  let confirm = sheetButton(renderer, 'Permanently delete');
  expect(confirm.props.label).toBe('Permanently delete (5)');
  expect(confirm.props.disabled).toBe(true);
  await act(async () => {
    jest.advanceTimersByTime(5_000);
  });
  advanceClock(5_000);
  confirm = sheetButton(renderer, 'Permanently delete');
  expect(confirm.props.label).toBe('Permanently delete');
  expect(confirm.props.disabled).toBe(false);
  await act(async () => {
    confirm.props.onPress();
  });
  await settle(10);
}

function useFakeTimersForCountdown(): void {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask'],
  });
}

function survivalMatrix(owner: string) {
  const survival = classifySurvival(sqliteHandle, owner, []);
  const byTable: Record<string, number> = {};
  for (const row of survival.deletedOwnerRows) {
    byTable[row.table] = (byTable[row.table] ?? 0) + 1;
  }
  return { byTable, total: survival.deletedOwnerRows.length, survival };
}

function requestLog() {
  return currentEdge()
    .log.filter(e => e.path.startsWith('/v1/me/delete'))
    .map(e => ({
      seq: e.seq,
      method: e.method,
      path: e.path,
      status: e.status,
      effectApplied: e.effectApplied,
      body: e.body,
    }));
}

describe('journey (full tree): Settings → Manage account → delete → wipe → relaunch', () => {
  afterEach(async () => {
    jest.useRealTimers();
    if (live) await unmount(live);
    useMiniNav.getState().reset();
  });

  test('U1 completed survey: review copy matches legal §7/§8, request carries the survey, wipe + signed-out relaunch', async () => {
    const { edge } = resetWorld({ seed: 'U1' });
    let renderer = await launchApp();
    expect(allText(renderer)).toContain('Pickle Sensei');
    const { canonicalId, owner } = await signInThroughUi(renderer, 'apple-U1');
    const seeded = await populateThroughStores(owner, 'U1');
    edge.seedScoredShots(canonicalId, 2);
    for (const table of OWNER_SCOPED_TABLES) {
      expect(seeded.tables[table]).toBeGreaterThan(0);
    }
    expect(scheduler.pending.length).toBeGreaterThan(0);

    // Settings root renders the Account section for a synced session.
    const settingsCopy = allText(renderer);
    expect(settingsCopy).toContain('Manage account');
    await openManageAccount(renderer);
    const manageCopy = allText(renderer);
    expect(manageCopy).toContain('Apple');
    expect(manageCopy).not.toContain('Delete your account?');

    await press(renderer, 'Delete account');
    const q1Copy = allText(renderer);
    expect(q1Copy).toContain("What's making you leave?");
    expect(q1Copy).toContain('QUESTION 1 OF 2');
    expect(sheetButton(renderer, 'Next').props.disabled).toBe(true);
    await press(renderer, 'Privacy or data concerns');
    await pressButton(renderer, 'Next');
    const q2Copy = allText(renderer);
    expect(q2Copy).toContain('What would have kept you?');
    await press(renderer, "Nothing — I just don't need it anymore");
    await act(async () => {
      renderer.root
        .findByType(TextInput)
        .props.onChangeText('  Please erase everything.  ');
    });
    await pressButton(renderer, 'Continue');

    // The confirmation page — assert its copy against legal.ts §7/§8.
    useFakeTimersForCountdown();
    const reviewCopy = await continueToDelete(renderer);
    // The optional-survey clause (§8) is shown on the survey pages, the
    // retention/permanence/subscription clauses on the review page.
    const journeyCopy = `${manageCopy} ${q1Copy} ${q2Copy} ${reviewCopy}`;
    const legalCheck = checkCopyAgainstLegal(journeyCopy);
    expect(legalCheck.legalMissing).toEqual([]);
    expect(legalCheck.failed).toEqual([]);
    const reviewOnly = checkCopyAgainstLegal(reviewCopy);
    expect(reviewOnly.failed).toEqual(['survey-optional']);
    for (const term of FORBIDDEN_COPY_TERMS) {
      expect(`${manageCopy} ${q1Copy} ${q2Copy} ${reviewCopy}`).not.toMatch(
        term,
      );
    }
    expect(edge.deletionRequests.size).toBe(1);
    expect(requestLog()).toEqual([
      expect.objectContaining({
        path: '/v1/me/delete-request',
        status: 200,
        body: {
          survey: {
            reason: 'privacy',
            wanted: 'nothing',
            details: 'Please erase everything.',
            platform: 'ios',
            appVersion: '1.0',
          },
        },
      }),
    ]);
    // Nothing destroyed by step 1.
    expect(edge.users.has(canonicalId)).toBe(true);

    await armAndConfirm(renderer);
    jest.useRealTimers();
    await settle(10);

    // Server: account gone, ledger + anonymized survey kept.
    const server = edge.snapshot();
    expect(server.users).toEqual([]);
    expect(server.feedback).toEqual([
      expect.objectContaining({
        userId: null,
        reason: 'privacy',
        wanted: 'nothing',
      }),
    ]);
    expect(server.ledger).toEqual([
      expect.objectContaining({ scoredCount: 2 }),
    ]);

    // Gate: signed-out → Welcome, no notice (clean local purge).
    const afterCopy = allText(renderer);
    expect(useAuthStore.getState().session).toBeNull();
    // Same process: the Gate's launch stage is still 'sign-in' (the user came
    // in through "I already have an account"), so the signed-out tree is the
    // SignIn screen, not Welcome. Relaunch (below) lands on Welcome.
    expect(pressables(renderer, 'Continue with Apple').length).toBeGreaterThan(
      0,
    );
    expect(afterCopy).not.toContain('Manage account');
    expect(afterCopy).not.toContain('Delete your account?');
    expect(afterCopy).not.toContain('LOCAL CLEANUP NEEDED');
    expect(afterCopy).not.toContain('ONE APPLE STEP');
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'complete',
    });
    const matrix = survivalMatrix(owner);
    expect(matrix.total).toBe(0);
    expect(matrix.survival.sentinelHits).toEqual([]);
    expect(keychainSnapshot()).toEqual([]);
    expect(scheduler.pending).toEqual([]);
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);

    // OBSERVED (finding candidate): the consent store is hydrated only by
    // SettingsScreen / ConsentSettingsScreen mount effects, not by the Gate.
    // Once Settings unmounts on deletion nothing resets it, so the deleted
    // account's server consent stays in process memory. No screen reads it
    // while signed out; the only exposure is the first frame after a NEW
    // account's Settings mounts (before its hydrate effect runs).
    const consentAfterDeletion = {
      availability: useConsentStore.getState().availability,
      modelTrainingActive: useConsentStore.getState().modelTrainingActive,
    };
    expect(consentAfterDeletion).toEqual({
      availability: 'ready',
      modelTrainingActive: true,
    });
    // Second account in the SAME process: capture the first-frame Settings
    // consent row value, then the settled one.
    installNativeAuth('apple-U1b');
    await press(renderer, 'Continue with Apple');
    await settle(8);
    const secondSession = useAuthStore.getState().session;
    expect(secondSession?.canonicalAppUserId).not.toBe(canonicalId);
    let firstFrameConsentRow: string | null = null;
    const unsubscribe = useConsentStore.subscribe(() => {
      if (firstFrameConsentRow === null) {
        firstFrameConsentRow =
          allText(renderer).match(/Training: (contributing|off)|Manage/)?.[0] ??
          null;
      }
    });
    await act(async () => {
      await useAppStore.getState().completeOnboarding(PROFILE);
    });
    await settle(8);
    unsubscribe();
    const settledConsent = {
      availability: useConsentStore.getState().availability,
      modelTrainingActive: useConsentStore.getState().modelTrainingActive,
    };
    expect(settledConsent).toEqual({
      availability: 'ready',
      modelTrainingActive: false,
    });
    writeFileSync(
      join(ARTIFACT_DIR, 'finding.consent-store-not-reset-on-deletion.json'),
      JSON.stringify(
        {
          seed: 'U1',
          deletedCanonicalId: canonicalId,
          consentAfterDeletion,
          secondAccount: secondSession?.canonicalAppUserId,
          firstFrameConsentRow,
          settledConsent,
        },
        null,
        2,
      ),
    );
    await act(async () => {
      await useAuthStore.getState().signOut();
    });
    await settle(8);
    expect(useConsentStore.getState().availability).toBe('ready');

    // Relaunch the process on the same device.
    await unmount(renderer);
    const logBefore = edge.log.length;
    relaunchProcess();
    renderer = await launchApp();
    await settle(8);
    const relaunchSnapshot = processSnapshot();
    expect(relaunchSnapshot.auth.session).toBeNull();
    expect(relaunchSnapshot.auth.error).toBeNull();
    expect(
      pressables(renderer, 'I already have an account').length,
    ).toBeGreaterThan(0);
    expect(edge.log.slice(logBefore)).toEqual([]);
    const relaunchMatrix = survivalMatrix(owner);
    expect(relaunchMatrix.total).toBe(0);
    record('U1', {
      seed: 'U1',
      canonicalId,
      requestLog: requestLog(),
      legalCheck,
      reviewCopy,
      localSurvivalAfterDeletion: matrix.byTable,
      localSurvivalAfterRelaunch: relaunchMatrix.byTable,
      ownerScopedTables: OWNER_SCOPED_TABLES,
      ownerScopedKvNamespaces: OWNER_SCOPED_KV_NAMESPACES,
      relaunch: relaunchSnapshot,
    });
    await unmount(renderer);
  });

  test('U2 skipped survey: no body on the request, no feedback row, same wipe', async () => {
    const { edge } = resetWorld({ seed: 'U2' });
    const renderer = await launchApp();
    const { canonicalId, owner } = await signInThroughUi(renderer, 'apple-U2');
    await populateThroughStores(owner, 'U2');
    await openManageAccount(renderer);
    await press(renderer, 'Delete account');
    await press(renderer, 'Skip the survey');
    useFakeTimersForCountdown();
    await continueToDelete(renderer);
    const log = requestLog();
    expect(log).toEqual([
      expect.objectContaining({ path: '/v1/me/delete-request', status: 200 }),
    ]);
    expect(log[0]!.body).toBeNull();
    await armAndConfirm(renderer);
    jest.useRealTimers();
    await settle(10);
    expect(edge.snapshot().users).toEqual([]);
    expect(edge.snapshot().feedback).toEqual([]);
    expect(useAuthStore.getState().session).toBeNull();
    expect(survivalMatrix(owner).total).toBe(0);
    record('U2', {
      seed: 'U2',
      canonicalId,
      requestLog: requestLog(),
      feedback: edge.snapshot().feedback,
    });
    await unmount(renderer);
  });

  test('U3 question-two skip keeps question one; Back keeps the selection', async () => {
    const { edge } = resetWorld({ seed: 'U3' });
    const renderer = await launchApp();
    const { canonicalId, owner } = await signInThroughUi(renderer, 'apple-U3');
    await populateThroughStores(owner, 'U3');
    await openManageAccount(renderer);
    await press(renderer, 'Delete account');
    await press(renderer, "It's too expensive");
    await pressButton(renderer, 'Next');
    await press(renderer, 'Back to the previous question');
    const expensive = radios(renderer).find(
      node => node.props.accessibilityLabel === "It's too expensive",
    );
    expect(expensive?.props.accessibilityState).toEqual({ selected: true });
    await pressButton(renderer, 'Next');
    await press(renderer, 'Skip this question');
    useFakeTimersForCountdown();
    await continueToDelete(renderer);
    expect(requestLog()[0]!.body).toEqual({
      survey: {
        reason: 'too_expensive',
        wanted: null,
        details: null,
        platform: 'ios',
        appVersion: '1.0',
      },
    });
    await armAndConfirm(renderer);
    jest.useRealTimers();
    await settle(10);
    expect(edge.snapshot().feedback).toEqual([
      expect.objectContaining({
        userId: null,
        reason: 'too_expensive',
        wanted: null,
      }),
    ]);
    expect(survivalMatrix(owner).total).toBe(0);
    record('U3', { seed: 'U3', canonicalId, requestLog: requestLog() });
    await unmount(renderer);
  });

  test('U4 cancel paths keep the account: Keep my account, Close, Back to Settings', async () => {
    const { edge } = resetWorld({ seed: 'U4' });
    const renderer = await launchApp();
    const { canonicalId, owner } = await signInThroughUi(renderer, 'apple-U4');
    const seeded = await populateThroughStores(owner, 'U4');
    await openManageAccount(renderer);

    await press(renderer, 'Delete account');
    await press(renderer, 'Skip the survey');
    await pressButton(renderer, 'Keep my account');
    expect(allText(renderer)).not.toContain('Delete your account?');

    await press(renderer, 'Delete account');
    await press(renderer, 'Skip the survey');
    // Step 1 minted a challenge; closing afterwards must still delete nothing.
    useFakeTimersForCountdown();
    await continueToDelete(renderer);
    expect(edge.deletionRequests.size).toBe(1);
    await press(renderer, 'Close account deletion confirmation');
    jest.useRealTimers();
    await settle(4);
    expect(allText(renderer)).not.toContain('Delete your account?');

    await press(renderer, 'Back');
    expect(useMiniNav.getState().route).toBe('Settings');

    expect(edge.users.has(canonicalId)).toBe(true);
    expect(edge.deletedUserIds).toEqual([]);
    expect(
      requestLog().filter(e => e.path === '/v1/me/delete-confirm'),
    ).toEqual([]);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    const matrix = survivalMatrix(owner);
    for (const table of OWNER_SCOPED_TABLES) {
      expect(matrix.byTable[table]).toBe(seeded.tables[table]);
    }
    expect(keychainSnapshot()).toHaveLength(1);
    record('U4', {
      seed: 'U4',
      canonicalId,
      requestLog: requestLog(),
      localRowsByTable: matrix.byTable,
    });
    await unmount(renderer);
  });

  test('U5 request 503 then 429 (production body shapes): server copy is shown verbatim, account intact, retry succeeds', async () => {
    const { edge } = resetWorld({ seed: 'U5' });
    const renderer = await launchApp();
    const { canonicalId, owner } = await signInThroughUi(renderer, 'apple-U5');
    await populateThroughStores(owner, 'U5');
    await openManageAccount(renderer);
    await press(renderer, 'Delete account');
    await press(renderer, 'Skip the survey');

    // index.ts serviceUnavailable("Account deletion", …) body — no code,
    // generic message. The client (deletion.ts) prefers the server message.
    const SERVICE_UNAVAILABLE =
      'Account deletion is temporarily unavailable. Please try again.';
    const RATE_LIMITED =
      'Too many requests. Please slow down and try again shortly.';
    edge.injectFault('/v1/me/delete-request', {
      kind: 'status',
      status: 503,
      message: SERVICE_UNAVAILABLE,
    });
    useFakeTimersForCountdown();
    await continueToDelete(renderer);
    let copy = allText(renderer);
    expect(copy).toContain(SERVICE_UNAVAILABLE);
    expect(copy).not.toContain('Permanently delete');
    expect(sheetButton(renderer, 'Continue to delete').props.disabled).toBe(
      false,
    );
    expect(edge.users.has(canonicalId)).toBe(true);
    expect(survivalMatrix(owner).total).toBeGreaterThan(0);

    edge.injectFault('/v1/me/delete-request', {
      kind: 'status',
      status: 429,
      code: 'rate_limited',
      message: RATE_LIMITED,
    });
    await pressButton(renderer, 'Continue to delete');
    copy = allText(renderer);
    expect(copy).toContain(RATE_LIMITED);
    expect(edge.users.has(canonicalId)).toBe(true);

    // Pure network failure (fetch rejects): client-owned copy.
    edge.injectFault('/v1/me/delete-request', { kind: 'network_error' });
    await pressButton(renderer, 'Continue to delete');
    copy = allText(renderer);
    expect(copy).toContain(
      'Account deletion is temporarily offline. Nothing was deleted — please try again.',
    );
    expect(edge.users.has(canonicalId)).toBe(true);

    // Invalid JSON success body: client-owned copy, nothing deleted.
    edge.injectFault('/v1/me/delete-request', { kind: 'invalid_json' });
    await pressButton(renderer, 'Continue to delete');
    copy = allText(renderer);
    expect(copy).toContain('The server returned an invalid deletion response.');
    expect(edge.users.has(canonicalId)).toBe(true);

    await pressButton(renderer, 'Continue to delete');
    await armAndConfirm(renderer);
    jest.useRealTimers();
    await settle(10);
    expect(edge.snapshot().users).toEqual([]);
    expect(survivalMatrix(owner).total).toBe(0);
    record('U5', {
      seed: 'U5',
      canonicalId,
      faults: [
        '503 serviceUnavailable',
        '429 rate_limited',
        'network_error',
        'invalid_json',
        'ok',
      ],
      requestLog: requestLog(),
    });
    await unmount(renderer);
  });

  test('U6 lost confirm response (server deleted): UI keeps the user signed in with all local data; relaunch drops silently but never purges', async () => {
    const { edge } = resetWorld({ seed: 'U6' });
    let renderer = await launchApp();
    const { canonicalId, owner } = await signInThroughUi(renderer, 'apple-U6');
    const seeded = await populateThroughStores(owner, 'U6');
    await openManageAccount(renderer);
    await press(renderer, 'Delete account');
    await press(renderer, 'Skip the survey');
    useFakeTimersForCountdown();
    await continueToDelete(renderer);

    edge.injectFault('/v1/me/delete-confirm', { kind: 'lost_response' });
    await armAndConfirm(renderer);
    jest.useRealTimers();
    await settle(6);

    // Server side effect applied, client told "nothing was deleted".
    expect(edge.deletedUserIds).toEqual([canonicalId]);
    const firstErrorCopy = allText(renderer);
    expect(firstErrorCopy).toContain('Nothing was deleted');
    expect(firstErrorCopy).toContain('Delete your account?');
    // Retry on the same (now dead) challenge → 401 → "sign in again".
    await pressButton(renderer, 'Permanently delete');
    const secondErrorCopy = allText(renderer);
    expect(secondErrorCopy).toContain('Your sign-in has expired');
    // Still "signed in" locally; nothing purged.
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    const immediate = survivalMatrix(owner);
    let seededTotal = 0;
    for (const table of OWNER_SCOPED_TABLES) {
      expect(immediate.byTable[table]).toBe(seeded.tables[table]);
      seededTotal += seeded.tables[table] ?? 0;
    }
    expect(immediate.byTable['kv']).toBe(OWNER_SCOPED_KV_NAMESPACES.length);
    expect(keychainSnapshot()).toHaveLength(1);
    expect(scheduler.pending.length).toBeGreaterThan(0);

    // Relaunch: refresh is refused → silent drop; local data still there.
    await unmount(renderer);
    relaunchProcess();
    renderer = await launchApp();
    await settle(10);
    const relaunch = processSnapshot();
    expect(relaunch.auth.session).toBeNull();
    expect(relaunch.auth.error).toBeNull();
    expect(
      pressables(renderer, 'I already have an account').length,
    ).toBeGreaterThan(0);
    const afterRelaunch = survivalMatrix(owner);
    expect(afterRelaunch.total).toBe(
      seededTotal + OWNER_SCOPED_KV_NAMESPACES.length,
    );
    expect(keychainSnapshot()).toEqual([]);
    const finding = {
      finding: 'lost-confirm-response-ui',
      seed: 'U6',
      canonicalId,
      owner,
      serverDeletedUserIds: edge.deletedUserIds,
      requestLog: requestLog(),
      firstErrorCopy:
        firstErrorCopy.match(
          /Account deletion is temporarily offline[^.]*\.[^.]*\./,
        )?.[0] ?? null,
      secondErrorCopy:
        secondErrorCopy.match(/Your sign-in has expired[^.]*\.[^.]*\./)?.[0] ??
        null,
      localRowsImmediately: immediate.byTable,
      localRowsAfterRelaunch: afterRelaunch.byTable,
      relaunch,
    };
    writeFileSync(
      join(ARTIFACT_DIR, 'finding.lost-confirm-response.ui.json'),
      JSON.stringify(finding, null, 2),
    );
    record('U6', finding);
    await unmount(renderer);
  });

  test('U7 local purge fails 3x: BrandNotice "LOCAL CLEANUP NEEDED" over the signed-out Gate', async () => {
    const { edge } = resetWorld({ seed: 'U7' });
    const renderer = await launchApp();
    const { canonicalId, owner } = await signInThroughUi(renderer, 'apple-U7');
    await populateThroughStores(owner, 'U7');
    await openManageAccount(renderer);
    await press(renderer, 'Delete account');
    await press(renderer, 'Skip the survey');
    useFakeTimersForCountdown();
    await continueToDelete(renderer);
    sqliteHandle.failOn = /DELETE FROM local_shot/i;
    await armAndConfirm(renderer);
    jest.useRealTimers();
    await settle(10);
    sqliteHandle.failOn = null;

    expect(edge.snapshot().users).toEqual([]);
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'failed',
    });
    const copy = allText(renderer);
    expect(copy).toContain('LOCAL CLEANUP NEEDED');
    expect(copy).toContain('delete the app to clear it');
    expect(keychainSnapshot()).toEqual([]);
    const matrix = survivalMatrix(owner);
    expect(matrix.total).toBeGreaterThan(0);
    record('U7', {
      seed: 'U7',
      canonicalId,
      failOn: 'DELETE FROM local_shot',
      survivingRowsByTable: matrix.byTable,
      noticeShown: copy.includes('LOCAL CLEANUP NEEDED'),
    });
    await unmount(renderer);
  });

  test('U8 legacy Apple account: "ONE APPLE STEP" notice tells the user the manual revocation step', async () => {
    const { edge } = resetWorld({
      seed: 'U8',
      appleRevocation: 'manual_action_required',
    });
    const renderer = await launchApp();
    const { canonicalId, owner } = await signInThroughUi(renderer, 'apple-U8');
    await populateThroughStores(owner, 'U8');
    await openManageAccount(renderer);
    await press(renderer, 'Delete account');
    await press(renderer, 'Skip the survey');
    useFakeTimersForCountdown();
    await continueToDelete(renderer);
    await armAndConfirm(renderer);
    jest.useRealTimers();
    await settle(10);
    expect(edge.snapshot().users).toEqual([]);
    const copy = allText(renderer);
    expect(copy).toContain('ONE APPLE STEP');
    expect(copy).toContain('Stop Using Apple ID');
    expect(survivalMatrix(owner).total).toBe(0);
    record('U8', {
      seed: 'U8',
      canonicalId,
      noticeShown: copy.includes('ONE APPLE STEP'),
      requestLog: requestLog(),
    });
    await unmount(renderer);
  });

  async function completeSurvey(renderer: Renderer, details: string) {
    await press(renderer, 'Delete account');
    await press(renderer, 'Privacy or data concerns');
    await pressButton(renderer, 'Next');
    await press(renderer, "Nothing — I just don't need it anymore");
    await act(async () => {
      renderer.root.findByType(TextInput).props.onChangeText(details);
    });
    await pressButton(renderer, 'Continue');
  }

  test('U10 challenge expires while armed (>15 min): 403 sends the user back to review; re-requesting stores the exit survey a second time', async () => {
    const { edge } = resetWorld({ seed: 'U10' });
    const renderer = await launchApp();
    const { canonicalId, owner } = await signInThroughUi(renderer, 'apple-U10');
    await populateThroughStores(owner, 'U10');
    await openManageAccount(renderer);
    await completeSurvey(renderer, 'U10 survey text');

    useFakeTimersForCountdown();
    await continueToDelete(renderer);
    expect(edge.feedback.filter(f => f.userId === canonicalId)).toHaveLength(1);
    const firstChallenge = edge.deletionRequests.get(canonicalId)?.challenge;
    expect(firstChallenge).toBeDefined();

    // The armed button has no client-side expiry: leave the sheet open past
    // the server's 15-minute challenge TTL, then tap.
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    advanceClock(16 * 60_000);
    const confirm = sheetButton(renderer, 'Permanently delete');
    expect(confirm.props.disabled).toBe(false);
    await act(async () => {
      confirm.props.onPress();
    });
    await settle(10);
    let copy = allText(renderer);
    expect(copy).toContain(
      'The deletion request expired. Start again from Settings.',
    );
    // Non-retryable (403) → back to the review page with the survey kept.
    expect(sheetButton(renderer, 'Continue to delete').props.disabled).toBe(
      false,
    );
    expect(edge.users.has(canonicalId)).toBe(true);
    expect(edge.deletedUserIds).toEqual([]);

    // "Start again": the user taps Continue to delete on the same sheet. The
    // survey state is still in the dialog, so delete-request re-sends it and
    // the server inserts a second account_deletion_feedback row (no
    // uniqueness on user_id — 20260902000000_account_deletion_feedback.sql).
    await pressButton(renderer, 'Continue to delete');
    const secondChallenge = edge.deletionRequests.get(canonicalId)?.challenge;
    expect(secondChallenge).not.toBe(firstChallenge);
    const surveyRows = edge.feedback.filter(f => f.userId === canonicalId);
    expect(surveyRows).toHaveLength(2);
    expect(surveyRows.map(r => r.details)).toEqual([
      'U10 survey text',
      'U10 survey text',
    ]);

    await armAndConfirm(renderer);
    jest.useRealTimers();
    await settle(10);
    const server = edge.snapshot();
    expect(server.users).toEqual([]);
    // Both rows survive de-identified: one person, two survey entries.
    expect(
      server.feedback.filter(f => f.details === 'U10 survey text'),
    ).toHaveLength(2);
    expect(server.feedback.every(f => f.userId === null)).toBe(true);
    expect(survivalMatrix(owner).total).toBe(0);
    copy = allText(renderer);
    expect(copy).not.toContain('Delete your account?');
    const log = requestLog();
    expect(log.map(e => [e.path, e.status])).toEqual([
      ['/v1/me/delete-request', 200],
      ['/v1/me/delete-confirm', 403],
      ['/v1/me/delete-request', 200],
      ['/v1/me/delete-confirm', 200],
    ]);
    record('U10', {
      seed: 'U10',
      canonicalId,
      firstChallenge,
      secondChallenge,
      clockAdvancedMs: 16 * 60_000,
      surveyRowsAfterDeletion: server.feedback,
      requestLog: log,
      heap: heapNumbers(),
    });
    writeArtifact('finding.exit-survey-duplicated-on-restart.json', {
      seed: 'U10',
      canonicalId,
      observed:
        'delete-request inserts account_deletion_feedback on every call; after a 403 challenge_expired the dialog keeps the survey and re-sends it, so one person yields two survey rows',
      surveyRowsAfterDeletion: server.feedback,
      requestLog: log,
    });
    await unmount(renderer);
  });

  test('U11 survey then "Keep my account": the exit survey is already stored server-side and still carries the live user_id', async () => {
    const { edge } = resetWorld({ seed: 'U11' });
    const renderer = await launchApp();
    const { canonicalId, owner } = await signInThroughUi(renderer, 'apple-U11');
    const seeded = await populateThroughStores(owner, 'U11');
    await openManageAccount(renderer);
    await completeSurvey(renderer, 'U11 changed my mind');
    useFakeTimersForCountdown();
    await continueToDelete(renderer);
    await press(renderer, 'Close account deletion confirmation');
    jest.useRealTimers();
    await settle(4);
    expect(allText(renderer)).not.toContain('Delete your account?');

    // Account fully intact locally and on the server…
    expect(edge.users.has(canonicalId)).toBe(true);
    expect(edge.deletedUserIds).toEqual([]);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
      canonicalId,
    );
    const matrix = survivalMatrix(owner);
    for (const table of OWNER_SCOPED_TABLES) {
      expect(matrix.byTable[table]).toBe(seeded.tables[table]);
    }
    // …but the exit survey was committed at step 1, attributed to the
    // still-existing account (user_id set, not anonymized).
    const surveyRows = edge.feedback.filter(f => f.userId === canonicalId);
    expect(surveyRows).toEqual([
      expect.objectContaining({
        userId: canonicalId,
        reason: 'privacy',
        wanted: 'nothing',
        details: 'U11 changed my mind',
      }),
    ]);
    record('U11', {
      seed: 'U11',
      canonicalId,
      requestLog: requestLog(),
      surveyRows,
      localRowsByTable: matrix.byTable,
    });
    await unmount(renderer);
  });

  test('U9 legal semantics table is itself complete (every §7/§8 clause has a UI probe)', () => {
    expect(LEGAL_SEMANTICS.map(c => c.id)).toEqual([
      ...new Set(LEGAL_SEMANTICS.map(c => c.id)),
    ]);
    expect(LEGAL_SEMANTICS.length).toBeGreaterThanOrEqual(7);
  });
});
