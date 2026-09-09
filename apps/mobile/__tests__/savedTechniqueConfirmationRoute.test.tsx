jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@react-navigation/native-stack', () => ({
  createNativeStackNavigator: () => ({
    Navigator: () => null,
    Screen: () => null,
  }),
}));
jest.mock('@react-navigation/bottom-tabs', () => ({
  createBottomTabNavigator: () => ({
    Navigator: () => null,
    Screen: () => null,
  }),
}));
jest.mock('@react-navigation/native', () => ({
  DefaultTheme: { colors: {} },
  NavigationContainer: () => null,
  createNavigationContainerRef: () => ({
    isReady: () => true,
    navigate: jest.fn(),
  }),
  useNavigation: () => mockNavigation,
  useRoute: () => mockRoute,
  useFocusEffect: (callback: () => void | (() => void)) => {
    jest
      .requireActual<typeof import('react')>('react')
      .useEffect(callback, [callback]);
  },
}));
jest.mock('../src/camera/capture', () => ({
  ...jest.requireActual('../src/camera/capture'),
  captureStrokeVideo: jest.fn(),
  importStrokeVideo: jest.fn(),
  extractImportedPoseSequence: jest.fn(),
  subscribeToCameraEvents: jest.fn(() => () => {}),
  cancelCameraOperation: jest.fn(),
  readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  verifyCapturedClipCurrentBytes: jest.fn(
    async (clip: import('../src/camera/capture').CapturedClip) => ({
      status: 'verified-current-bytes',
      comparedExpectation: clip.nativeMediaIdentity,
    }),
  ),
}));
jest.mock('@pickle/analysis-pipeline', () => ({
  ...jest.requireActual('@pickle/analysis-pipeline'),
  analyzeCapture: jest.fn(
    jest.requireActual('@pickle/analysis-pipeline').analyzeCapture,
  ),
}));
jest.mock('../src/config/runtimeConfig', () => {
  const actual = jest.requireActual('../src/config/runtimeConfig');
  return {
    ...actual,
    getRuntimePublicConfig: () => ({
      ...actual.getRuntimePublicConfig(),
      apiBaseUrl: 'https://api.test/functions/v1/api',
    }),
  };
});
jest.mock('../src/analysis/originalAnalysisOperations', () => ({
  ...jest.requireActual('../src/analysis/originalAnalysisOperations'),
  loadSavedOriginalAnalysis: jest.fn(
    jest.requireActual('../src/analysis/originalAnalysisOperations')
      .loadSavedOriginalAnalysis,
  ),
}));
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  ...jest.requireActual('../src/analysis/runCaptureAnalysis'),
  runCaptureAnalysis: jest.fn(
    jest.requireActual('../src/analysis/runCaptureAnalysis').runCaptureAnalysis,
  ),
  runOriginalCaptureAnalysis: jest.fn(
    jest.requireActual('../src/analysis/runCaptureAnalysis')
      .runOriginalCaptureAnalysis,
  ),
  reconcileOriginalCaptureAnalysis: jest.fn(
    jest.requireActual('../src/analysis/runCaptureAnalysis')
      .reconcileOriginalCaptureAnalysis,
  ),
}));
jest.mock('../src/analysis/savedTechniqueConfirmation', () => ({
  ...jest.requireActual('../src/analysis/savedTechniqueConfirmation'),
  loadSavedTechniqueConfirmation: jest.fn(
    jest.requireActual('../src/analysis/savedTechniqueConfirmation')
      .loadSavedTechniqueConfirmation,
  ),
}));
jest.mock('../src/state/accessStore', () => ({
  useAccessStore: jest.requireActual('zustand').create(() => ({
    status: 'ready',
    canonicalAccess: {
      premium: false,
      entitlements: [],
      freeRatings: {
        limit: 2,
        used: 2,
        reserved: 0,
        remaining: 0,
        availableToReserve: 0,
      },
      canStartRating: false,
      paywallRequired: true,
    },
    initialize: jest.fn(),
    refreshAccess: jest.fn(),
  })),
}));
jest.mock('../src/auth/authStore', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ session: { canonicalAppUserId: OWNER, localOnly: false } }),
}));
jest.mock('../src/training/store', () => {
  const state = {
    savedStatus: 'ready',
    planStatus: 'ready',
    savedDrills: [],
    currentPlan: null,
    drillDetails: {},
    savedError: null,
    mutation: 'idle',
    mutationError: null,
    loadSavedDrills: jest.fn(),
    loadCurrentPlan: jest.fn(),
    setDrillSaved: jest.fn(),
    clearMutationError: jest.fn(),
  };
  return {
    useTrainingStore: (selector: (value: unknown) => unknown) =>
      selector(state),
  };
});
jest.mock('../src/data/syncRuntime', () => ({ triggerOutboxSync: jest.fn() }));
jest.mock('../src/review/appStoreReview', () => ({
  reportScoredAnalysisForReview: jest.fn(),
}));
jest.mock('../src/screens/HomeScreen', () => ({ HomeScreen: () => null }));
jest.mock('../src/screens/ProgressScreen', () => ({
  ProgressScreen: () => null,
}));
jest.mock('../src/screens/SettingsScreen', () => ({
  SettingsScreen: () => null,
}));
jest.mock('../src/screens/DrillLibraryScreen', () => ({
  DrillLibraryScreen: () => null,
}));
jest.mock('../src/screens/ResultScreen', () => ({ ResultScreen: () => null }));
jest.mock('../src/screens/ResultDetailsScreen', () => ({
  ResultDetailsScreen: () => null,
}));
jest.mock('../src/screens/FormReviewScreen', () => ({
  FormReviewScreen: () => null,
}));
jest.mock('../src/screens/StreakCalendarScreen', () => ({
  StreakCalendarScreen: () => null,
}));
jest.mock('../src/screens/PaywallScreen', () => ({
  PaywallScreen: () => null,
}));
jest.mock('../src/screens/SignInScreen', () => ({ SignInScreen: () => null }));
jest.mock('../src/screens/ManageAccountScreen', () => ({
  ManageAccountScreen: () => null,
}));
jest.mock('../src/screens/ConsentSettingsScreen', () => ({
  ConsentSettingsScreen: () => null,
}));
jest.mock('../src/screens/NotificationSettingsScreen', () => ({
  NotificationSettingsScreen: () => null,
}));
jest.mock('../src/navigation/PremiumTabBar', () => ({
  PremiumTabBar: () => null,
}));

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import * as pipeline from '@pickle/analysis-pipeline';
import {
  OriginalAnalysisExecution,
  loadSavedOriginalAnalysis,
} from '../src/analysis/originalAnalysisOperations';
import { fail, failure, type TechniqueIntent } from '@pickle/shared-types';
import { AnalyzeRoute } from '../src/navigation/RootNavigator';
import type { RootStackParams } from '../src/navigation/params';
import { AnalyzeScreen } from '../src/screens/AnalyzeScreen';
import { LibraryScreen } from '../src/screens/LibraryScreen';
import { getDb } from '../src/data/db';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  savePendingCapture,
  setCaptureTargetSeed,
  type CaptureTargetSeed,
} from '../src/data/repository';
import { forDataOwner } from '../src/data/transactions';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import { useAccessStore } from '../src/state/accessStore';
import {
  captureStrokeVideo,
  importStrokeVideo,
  extractImportedPoseSequence,
  verifyCapturedClipCurrentBytes,
  type CapturedClip,
} from '../src/camera/capture';
import {
  runCaptureAnalysis,
  prepareOriginalCaptureAnalysis,
  runOriginalCaptureAnalysis,
  reconcileOriginalCaptureAnalysis,
} from '../src/analysis/runCaptureAnalysis';
import {
  activeReleaseAuthorityResponse,
  isReleasePolicyRequest,
} from '../testSupport/releasePolicyFixture';
import { loadSavedTechniqueConfirmation } from '../src/analysis/savedTechniqueConfirmation';
import { Button, ScreenHeader } from '../src/design/components';
import { TechniqueIntentPicker } from '../src/flow/TechniqueIntentPicker';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
} from '../testSupport/sqlite';
import { reportScoredAnalysisForReview } from '../src/review/appStoreReview';
import {
  armTryAgain,
  peekTryAgainHandoff,
} from '../src/screens/tryAgainHandoff';
import { finalizeAcknowledgement } from '../__harness__/analysisPermitRoute';

const { mkdtempSync } = jest.requireActual<{
  mkdtempSync(prefix: string): string;
}>('node:fs');
const { tmpdir } = jest.requireActual<{ tmpdir(): string }>('node:os');
const { join } = jest.requireActual<{ join(...paths: string[]): string }>(
  'node:path',
);

const OWNER = '22222222-2222-4222-8222-222222222222';
const OTHER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BASE = 'https://api.test/functions/v1/api';
const captureId = (n: number) =>
  `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;
let mockRoute: NativeStackScreenProps<RootStackParams, 'Analyze'>['route'];
const mockNavigation = {
  replace: jest.fn(),
  navigate: jest.fn(),
  goBack: jest.fn(),
  popToTop: jest.fn(),
  isFocused: jest.fn(() => true),
  addListener: jest.fn<() => void, [string, () => void]>(() => () => {}),
};
let mockReadArtifact: (uri: string) => Promise<string>;
let renderer: TestRenderer.ReactTestRenderer | null = null;

function session(apiBaseUrl = BASE) {
  establishApiSession({
    canonicalAppUserId: OWNER,
    apiBaseUrl,
    bearerToken: 'bound-owner-bearer',
    provider: 'apple',
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { resolve, reject, promise };
}

async function fixture(
  count = 1,
  releaseAvailable = true,
  targetSeed: CaptureTargetSeed | null = null,
  databasePath?: string,
) {
  const store = createSqliteTestDb(databasePath);
  (getDb as jest.Mock).mockReturnValue(store.db);
  const { sequence, window } = generateSwingSequence();
  const sidecar = serializePoseSequence(sequence);
  mockReadArtifact = async () => sidecar;
  let reservations = 0;
  const server = { releaseAvailable };
  const http = jest.fn(async (url: string, init?: RequestInit) => {
    if (isReleasePolicyRequest(url)) return activeReleaseAuthorityResponse();
    if (url.endsWith('/v1/analysis-permits')) {
      reservations += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          permit: {
            id: `66666666-6666-4666-8666-${String(reservations).padStart(12, '0')}`,
            accessSource: 'free',
            status: 'reserved',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        }),
      } as Response;
    }
    if (!server.releaseAvailable)
      return {
        ok: false,
        status: 503,
        json: async () => ({
          error: { code: 'unavailable', message: 'Release pending' },
        }),
      } as Response;
    if (
      !url.includes('/finalize') ||
      !(init?.headers as Record<string, string>)?.authorization
    )
      throw new Error('Unexpected request');
    return {
      ok: true,
      status: 200,
      json: async () =>
        finalizeAcknowledgement(url, JSON.parse(String(init?.body))),
    } as Response;
  });
  (globalThis as { fetch?: unknown }).fetch = http;
  for (let i = 1; i <= count; i += 1) {
    const clip: CapturedClip = {
      uri: `file:///captures/${i}.mov`,
      capturedAtIso: '2026-08-27T18:00:00.000Z',
      durationMs: window.endMs,
      fps: sequence.video.fps,
      width: sequence.video.width,
      height: sequence.video.height,
      captureMode: 'imported_video',
      recognition: { status: 'unknown', reason: 'analysis_not_run' },
      ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
      poseSequence: {
        schemaVersion: 1,
        format: 'pickle.pose-sequence.v1',
        uri: `file:///captures/${i}.pose.json`,
        frameCount: sequence.frames.length,
        sha256: sha256Hex(sidecar),
        coordinateSystem: 'normalized_image_top_left',
        poseModelVersion: sequence.producedBy.modelVersion,
      },
    };
    const ownedDb = forDataOwner(store.db, captureDataOwnerContext());
    await savePendingCapture(ownedDb, captureId(i), 'dink', clip, 'dink');
    if (targetSeed)
      await setCaptureTargetSeed(ownedDb, captureId(i), targetSeed);
    const result = await runCaptureAnalysis({
      db: store.db,
      captureId: captureId(i),
      clip,
      declaredStroke: 'dink',
      targetSeed,
      handedness: 'left',
      cameraView: 'rear_oblique',
      focusCheckpoint: 'swing_length',
      apiConfig: { baseUrl: BASE, token: null },
      appVersion: '0.1.0',
    });
    expect(result.kind).toBe('needs_technique_confirmation');
  }
  jest.mocked(runCaptureAnalysis).mockClear();
  jest.mocked(loadSavedTechniqueConfirmation).mockClear();
  http.mockClear();
  return { store, sidecar, http, server };
}

async function originalFixture(
  stage:
    | 'prepared'
    | 'failed'
    | 'pending'
    | 'completed'
    | 'confirmation' = 'prepared',
  databasePath?: string,
) {
  const existing = await fixture(0, stage !== 'pending', null, databasePath);
  const { sequence, window } = generateSwingSequence();
  const artifactRead = jest.fn(async () => existing.sidecar);
  mockReadArtifact = artifactRead;
  const ownerContext = captureDataOwnerContext();
  const clip: CapturedClip = {
    uri: 'file:///captures/original.mov',
    capturedAtIso: '2026-08-27T18:00:00.000Z',
    durationMs: window.endMs,
    fps: sequence.video.fps,
    width: sequence.video.width,
    height: sequence.video.height,
    captureMode: 'imported_video',
    byteSize: 25,
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    nativeMediaIdentity: {
      schemaVersion: 1,
      format: 'pickle.native-media-identity.v1',
      receiptId: '99999999-9999-4999-8999-999999999991',
      operationId: '99999999-9999-4999-8999-999999999992',
      origin: 'import_copy',
      algorithm: 'sha256',
      videoFileName: 'original.mov',
      byteSize: 25,
      sha256: sha256Hex('synthetic test movie bytes'),
    },
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///captures/original.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(existing.sidecar),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  const declaredStroke = stage === 'confirmation' ? null : 'forehand_drive';
  const targetSeed = {
    point: { x: 0.3, y: 0.6 },
    selectedAtIso: '2026-08-27T18:00:03.000Z',
  };
  const db = forDataOwner(existing.store.db, ownerContext);
  await savePendingCapture(
    db,
    captureId(1),
    declaredStroke ?? 'automatic_capture',
    clip,
    declaredStroke,
  );
  await setCaptureTargetSeed(db, captureId(1), targetSeed);
  const request: Parameters<typeof prepareOriginalCaptureAnalysis>[0] = {
    db: existing.store.db,
    ownerContext,
    captureId: captureId(1),
    clip,
    declaredStroke,
    declaredCanonical:
      stage === 'confirmation' ? null : ('FOREHAND_DRIVE' as const),
    targetSeed,
    handedness: 'left' as const,
    cameraView: 'rear_oblique' as const,
    focusCheckpoint: 'contact_point',
    apiConfig: { baseUrl: BASE, token: null },
    appVersion: '0.1.0',
    sessionId: '88888888-8888-4888-8888-888888888888',
    practiceSet: {
      owner: OWNER,
      sessionId: '88888888-8888-4888-8888-888888888888',
      resumed: false,
      shotType: declaredStroke,
      startedAtIso: clip.capturedAtIso,
      nowIso: clip.capturedAtIso,
    },
  };
  const execution = new OriginalAnalysisExecution(ownerContext, BASE);
  try {
    const operation = await prepareOriginalCaptureAnalysis(request, execution);
    if (stage !== 'prepared') {
      if (stage === 'failed' || stage === 'pending') {
        jest
          .mocked(pipeline.analyzeCapture)
          .mockResolvedValueOnce(
            fail(
              failure(
                'permanent',
                'scorer.provider_crash',
                'Synthetic temporary scorer failure',
              ),
            ),
          );
      }
      const outcome = await runOriginalCaptureAnalysis({
        db: existing.store.db,
        execution,
        operationId: operation.operationId,
      });
      expect(outcome.kind).toBe(
        stage === 'completed'
          ? 'scored'
          : stage === 'confirmation'
            ? 'needs_technique_confirmation'
            : 'unavailable',
      );
    }
    jest.mocked(runOriginalCaptureAnalysis).mockClear();
    jest.mocked(reconcileOriginalCaptureAnalysis).mockClear();
    jest.mocked(pipeline.analyzeCapture).mockClear();
    jest.mocked(verifyCapturedClipCurrentBytes).mockClear();
    existing.http.mockClear();
    artifactRead.mockClear();
    return {
      ...existing,
      clip,
      request,
      operation,
      ownerContext,
      artifactRead,
    };
  } finally {
    execution.dispose();
  }
}

async function mount(params: unknown = { captureId: captureId(1) }) {
  mockRoute = {
    key: 'saved-route',
    name: 'Analyze',
    params: params as RootStackParams['Analyze'],
  };
  await act(async () => {
    renderer = TestRenderer.create(
      <AnalyzeRoute
        navigation={
          mockNavigation as unknown as NativeStackScreenProps<
            RootStackParams,
            'Analyze'
          >['navigation']
        }
        route={mockRoute}
      />,
    );
  });
}

async function replaceParams(params: unknown) {
  mockRoute = { ...mockRoute, params: params as RootStackParams['Analyze'] };
  await act(async () => {
    renderer!.update(
      <AnalyzeRoute
        navigation={
          mockNavigation as unknown as NativeStackScreenProps<
            RootStackParams,
            'Analyze'
          >['navigation']
        }
        route={mockRoute}
      />,
    );
  });
}

const intent: TechniqueIntent = {
  version: 'technique-intent-v1',
  source: 'tap',
  canonical: 'BACKHAND_DINK',
  legacySlug: 'dink',
  confidence: 1,
};
const button = (label: string) =>
  renderer!.root
    .findAllByType(Button)
    .find(node => node.props.label === label)!;
const expectNoCapture = () => {
  expect(captureStrokeVideo).not.toHaveBeenCalled();
  expect(importStrokeVideo).not.toHaveBeenCalled();
  expect(extractImportedPoseSequence).not.toHaveBeenCalled();
};

beforeEach(() => {
  setActiveDataOwner(OWNER);
  session();
  jest.clearAllMocks();
  jest
    .mocked(pipeline.analyzeCapture)
    .mockReset()
    .mockImplementation(
      jest.requireActual<typeof pipeline>('@pickle/analysis-pipeline')
        .analyzeCapture,
    );
  jest
    .mocked(loadSavedOriginalAnalysis)
    .mockReset()
    .mockImplementation(
      jest.requireActual('../src/analysis/originalAnalysisOperations')
        .loadSavedOriginalAnalysis,
    );
  mockNavigation.isFocused.mockReturnValue(true);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = null;
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  closeSqliteTestDatabases();
  (globalThis as { fetch?: unknown }).fetch = undefined;
});

describe('cold original analysis recovery', () => {
  const params = () => ({ captureId: captureId(1), mode: 'original' });

  it.each(['prepared', 'failed', 'pending'] as const)(
    'recovers %s from a closed and reopened SQLite file under a fresh owner generation',
    async stage => {
      const directory = mkdtempSync(join(tmpdir(), 'pickle-original-reopen-'));
      const databasePath = join(directory, 'original.sqlite');
      const input = await originalFixture(stage, databasePath);
      const settings = input.store.native
        .prepare('SELECT original_settings FROM analysis_logical_operations')
        .get()!.original_settings;
      input.store.close();
      clearApiSession();
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      setActiveDataOwner(OWNER);
      session();
      const reopened = createSqliteTestDb(databasePath);
      jest.mocked(getDb).mockReturnValue(reopened.db);
      expect(
        reopened.native
          .prepare('SELECT original_settings FROM analysis_logical_operations')
          .get()!.original_settings,
      ).toBe(settings);
      await mount(params());
      expect(
        renderer!.root.findByType(AnalyzeScreen).props.savedOriginalAnalysis
          .reference.ownerContext.generation,
      ).toBeGreaterThan(input.ownerContext.generation);
      expect(button('Check saved analysis')).toBeDefined();
      expect(input.http).not.toHaveBeenCalled();
      expect(input.artifactRead).not.toHaveBeenCalled();
      expect(verifyCapturedClipCurrentBytes).not.toHaveBeenCalled();
      expectNoCapture();
      input.server.releaseAvailable = true;
      await act(async () => button('Check saved analysis').props.onPress());
      expect(button('Retry saved analysis')).toBeDefined();
      expect(runOriginalCaptureAnalysis).not.toHaveBeenCalled();
      await act(async () => button('Retry saved analysis').props.onPress());
      expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
        analysisId: input.operation.analysisId,
      });
      expect(reopened.count('local_shot', OWNER)).toBe(1);
      expect(
        reopened.native
          .prepare('SELECT original_settings FROM analysis_logical_operations')
          .get()!.original_settings,
      ).toBe(settings);
      expectNoCapture();
    },
  );

  it('opens a prepared operation read-only, then separates status check from explicit retry', async () => {
    const input = await originalFixture();
    const before = input.store.calls.length;
    await mount(params());
    expect(button('Check saved analysis')).toBeDefined();
    expect(button('Retry saved analysis')).toBeUndefined();
    expect(renderer!.root.findAllByType(TechniqueIntentPicker)).toHaveLength(0);
    expect(
      input.store.calls
        .slice(before)
        .some(call => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(call.sql)),
    ).toBe(false);
    expect(input.artifactRead).not.toHaveBeenCalled();
    expect(verifyCapturedClipCurrentBytes).not.toHaveBeenCalled();
    expect(pipeline.analyzeCapture).not.toHaveBeenCalled();
    expect(runOriginalCaptureAnalysis).not.toHaveBeenCalled();
    expect(input.http).not.toHaveBeenCalled();
    expectNoCapture();
    expect(useAccessStore.getState().initialize).not.toHaveBeenCalled();
    await act(async () => button('Check saved analysis').props.onPress());
    expect(button('Retry saved analysis')).toBeDefined();
    expect(input.http).not.toHaveBeenCalled();
    expect(runOriginalCaptureAnalysis).not.toHaveBeenCalled();
    await act(async () => button('Retry saved analysis').props.onPress());
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: input.operation.analysisId,
    });
    expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(1);
    expectNoCapture();
  });

  it('reopens a failed operation with fresh UI state and coalesces two explicit retry taps', async () => {
    const input = await originalFixture('failed');
    const old = input.store.native
      .prepare('SELECT operation_id FROM analysis_execution_attempts')
      .get()!;
    await mount(params());
    expect(input.http).not.toHaveBeenCalled();
    expectNoCapture();
    await act(async () => button('Check saved analysis').props.onPress());
    const retry = button('Retry saved analysis').props.onPress;
    await act(async () => {
      retry();
      retry();
    });
    expect(runOriginalCaptureAnalysis).toHaveBeenCalledTimes(1);
    expect(
      jest.mocked(runOriginalCaptureAnalysis).mock.calls[0]?.[0],
    ).toMatchObject({
      operationId: input.operation.operationId,
      predecessorAttemptId: old.operation_id,
    });
    expect(pipeline.analyzeCapture).toHaveBeenCalledTimes(1);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: input.operation.analysisId,
    });
    expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(2);
    expect(input.store.count('local_analysis_record', OWNER)).toBe(1);
    expect(input.store.count('local_shot', OWNER)).toBe(1);
    expect(
      input.store.native.prepare('SELECT session_id FROM local_shot').get(),
    ).toMatchObject({ session_id: input.request.sessionId });
    const storedRecord = input.store.native
      .prepare('SELECT record FROM local_analysis_record')
      .get()!;
    expect(
      JSON.parse(String(storedRecord.record)).inputSelection,
    ).toMatchObject({
      handedness: 'left',
      cameraView: 'rear_oblique',
      focusCheckpoint: 'contact_point',
    });
    expectNoCapture();
  });

  it('checks only the original unresolved hold and never starts its successor automatically', async () => {
    const input = await originalFixture('pending');
    await mount(params());
    expect(input.http).not.toHaveBeenCalled();
    await act(async () => button('Check saved analysis').props.onPress());
    expect(
      input.http.mock.calls.every(([url]) => url.includes('/finalize')),
    ).toBe(true);
    expect(runOriginalCaptureAnalysis).not.toHaveBeenCalled();
    expect(pipeline.analyzeCapture).not.toHaveBeenCalled();
    expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(1);
    input.server.releaseAvailable = true;
    input.http.mockClear();
    await act(async () => button('Check saved analysis').props.onPress());
    expect(button('Retry saved analysis')).toBeDefined();
    expect(runOriginalCaptureAnalysis).not.toHaveBeenCalled();
    expect(input.store.count('analysis_execution_attempts', OWNER)).toBe(1);
    expectNoCapture();
  });

  it('reopens while disconnected without borrowing a current session or creating a new capture', async () => {
    const input = await originalFixture('failed');
    clearApiSession();
    await mount(params());
    expect(button('Check saved analysis')).toBeDefined();
    expect(input.http).not.toHaveBeenCalled();
    await act(async () => button('Check saved analysis').props.onPress());
    expect(runOriginalCaptureAnalysis).not.toHaveBeenCalled();
    expect(input.http).not.toHaveBeenCalled();
    expectNoCapture();
    expect(button('Close')).toBeDefined();
  });

  it.each(['owner_ABA', 'origin_ABA', 'unmount', 'route'] as const)(
    'ignores retained original retry/new-capture/close handlers after %s',
    async change => {
      const input = await originalFixture('failed');
      await mount(params());
      await act(async () => button('Check saved analysis').props.onPress());
      const retry = button('Retry saved analysis').props.onPress;
      const newCapture = button('Import another video').props.onPress;
      const close = button('Close').props.onPress;
      jest.mocked(reconcileOriginalCaptureAnalysis).mockClear();
      if (change === 'unmount') {
        await act(async () => renderer!.unmount());
        renderer = null;
      } else if (change === 'route') {
        await replaceParams({ captureId: captureId(2), mode: 'original' });
      } else {
        await act(async () => {
          if (change === 'owner_ABA') {
            setActiveDataOwner(OTHER);
            setActiveDataOwner(OWNER);
          } else {
            session('https://other.test/functions/v1/api');
            session();
          }
        });
      }
      await act(async () => {
        retry();
        newCapture();
        close();
      });
      expect(runOriginalCaptureAnalysis).not.toHaveBeenCalled();
      expect(reconcileOriginalCaptureAnalysis).not.toHaveBeenCalled();
      expect(mockNavigation.goBack).not.toHaveBeenCalled();
      expect(mockNavigation.replace).not.toHaveBeenCalled();
      expect(input.http).not.toHaveBeenCalled();
      expectNoCapture();
    },
  );

  it('routes an explicit new import through the new-rating gate, without reusing the saved route', async () => {
    const input = await originalFixture('failed');
    await mount(params());
    await act(async () => button('Check saved analysis').props.onPress());
    await act(async () => button('Import another video').props.onPress());
    expect(mockNavigation.replace).toHaveBeenCalledWith('Analyze', {
      source: 'library',
    });
    expect(input.store.count('analysis_logical_operations', OWNER)).toBe(1);
    expect(runOriginalCaptureAnalysis).not.toHaveBeenCalled();
    expectNoCapture();
    expect(input.http).not.toHaveBeenCalled();
  });

  it('delegates an already completed original to verified result reopening', async () => {
    const input = await originalFixture('completed');
    await mount(params());
    expect(renderer!.root.findAllByType(AnalyzeScreen)).toHaveLength(0);
    expect(button('Open saved result')).toBeDefined();
    await act(async () => button('Open saved result').props.onPress());
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: input.operation.analysisId,
    });
    expect(runOriginalCaptureAnalysis).not.toHaveBeenCalled();
    expect(reportScoredAnalysisForReview).not.toHaveBeenCalled();
    expect(input.http).not.toHaveBeenCalled();
    expectNoCapture();
  });

  it('keeps original AUTO confirmation on the dedicated continuation flow', async () => {
    const input = await originalFixture('confirmation');
    await mount(params());
    expect(renderer!.root.findByType(ScreenHeader).props.title).toBe(
      'Confirm technique',
    );
    expect(button('Confirm technique').props.disabled).toBe(true);
    expect(button('Check saved analysis')).toBeUndefined();
    expect(input.http).not.toHaveBeenCalled();
    expectNoCapture();
  });

  it('reopens the latest verified confirmation result after the original capture declaration changed', async () => {
    const input = await originalFixture('confirmation');
    await mount(params());
    await act(async () =>
      renderer!.root.findByType(TechniqueIntentPicker).props.onChange(intent),
    );
    await act(async () => button('Confirm technique').props.onPress());
    const resultId = mockNavigation.replace.mock.calls[0]?.[1]?.analysisId;
    expect(resultId).toBeDefined();
    await act(async () => renderer!.unmount());
    renderer = null;
    jest.mocked(runCaptureAnalysis).mockClear();
    jest.mocked(reportScoredAnalysisForReview).mockClear();
    input.http.mockClear();
    await mount(params());
    expect(button('Open saved result')).toBeDefined();
    await act(async () => button('Open saved result').props.onPress());
    expect(mockNavigation.replace).toHaveBeenLastCalledWith('Result', {
      analysisId: resultId,
    });
    expect(runCaptureAnalysis).not.toHaveBeenCalled();
    expect(runOriginalCaptureAnalysis).not.toHaveBeenCalled();
    expect(reportScoredAnalysisForReview).not.toHaveBeenCalled();
    expect(input.http).not.toHaveBeenCalled();
    expectNoCapture();
  });

  it.each([
    { mode: 'original' },
    { captureId: captureId(1), mode: undefined },
    { captureId: captureId(1), mode: 'other' },
    { captureId: captureId(1), mode: 'original', source: 'library' },
  ])(
    'holds malformed original mode without falling back to capture: %j',
    async value => {
      const input = await originalFixture();
      await mount(value);
      expect(renderer!.root.findAllByType(AnalyzeScreen)).toHaveLength(0);
      expect(loadSavedOriginalAnalysis).not.toHaveBeenCalled();
      expect(input.http).not.toHaveBeenCalled();
      expectNoCapture();
    },
  );

  it('exposes a guarded Library action for a persisted original, not an import action', async () => {
    const input = await originalFixture('failed');
    await act(async () => {
      renderer = TestRenderer.create(<LibraryScreen />);
    });
    const open = renderer!.root
      .findAllByType(Button)
      .find(
        node => node.props.testID === `open-saved-original-${captureId(1)}`,
      )!;
    expect(open).toBeDefined();
    const stale = open.props.onPress;
    await act(async () => stale());
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Analyze', params());
    mockNavigation.navigate.mockClear();
    await act(async () => {
      setActiveDataOwner(OTHER);
      setActiveDataOwner(OWNER);
    });
    await act(async () => stale());
    expect(mockNavigation.navigate).not.toHaveBeenCalled();
    expect(input.http).not.toHaveBeenCalled();
    expectNoCapture();
  });
});

it.each(['ready', 'error'] as const)(
  'opens a saved capture despite %s/exhausted new-rating access, then only explicit confirmation authorizes',
  async status => {
    const { store, http, server } = await fixture(1, false);
    useAccessStore.setState({ status });
    await mount();
    expect(renderer!.root.findByType(ScreenHeader).props.title).toBe(
      'Confirm technique',
    );
    expect(useAccessStore.getState().initialize).not.toHaveBeenCalled();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expectNoCapture();
    expect(http).not.toHaveBeenCalled();
    expect(runCaptureAnalysis).not.toHaveBeenCalled();
    await act(async () =>
      renderer!.root.findByType(TechniqueIntentPicker).props.onChange(intent),
    );
    expect(http).not.toHaveBeenCalled();
    await act(async () => button('Confirm technique').props.onPress());
    expect(renderer!.root.findByType(ScreenHeader).props.title).toBe(
      'Confirm technique',
    );
    expect(JSON.stringify(renderer!.toJSON())).toContain('existing operation');
    expect(store.count('analysis_run_journal', OWNER)).toBe(1);
    expect(http.mock.calls.every(([url]) => url.includes('/finalize'))).toBe(
      true,
    );
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    server.releaseAvailable = true;
    await act(async () => button('Confirm technique').props.onPress());
    expect(store.count('analysis_run_journal', OWNER)).toBe(2);
    expect(store.count('local_shot', OWNER)).toBe(1);
    expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
      analysisId: expect.any(String),
    });
    expect(jest.mocked(runCaptureAnalysis).mock.calls[1]?.[0]).toMatchObject({
      captureId: captureId(1),
      handedness: 'left',
      cameraView: 'rear_oblique',
      focusCheckpoint: 'swing_length',
      signal: expect.any(AbortSignal),
    });
    expect(http.mock.calls.at(-1)?.[1]?.headers).toMatchObject({
      authorization: 'Bearer bound-owner-bearer',
    });
    expectNoCapture();
  },
);

it.each(['unchanged', 'point', 'timestamp', 'corrupt'])(
  'keeps the immutable imported target selection and never rewrites before revalidation: %s',
  async change => {
    const target = {
      point: { x: 0.3, y: 0.6 },
      selectedAtIso: '2026-08-27T18:01:00.000Z',
    };
    const { store, http } = await fixture(1, true, target);
    await mount();
    expect(
      renderer!.root.findByType(AnalyzeScreen).props.savedTechniqueConfirmation
        .targetSeed,
    ).toEqual(target);
    const original = store.native
      .prepare('SELECT record FROM local_analysis_record')
      .get()?.record;
    const changedTarget =
      change === 'corrupt'
        ? ''
        : JSON.stringify({
            point: change === 'point' ? { x: 0.7, y: 0.6 } : target.point,
            selectedAtIso:
              change === 'timestamp'
                ? '2026-08-27T18:02:00.000Z'
                : target.selectedAtIso,
          });
    if (change !== 'unchanged')
      store.native
        .prepare('UPDATE local_capture SET target_seed = ?')
        .run(changedTarget);
    const before = store.calls.length;
    const differentTechnique = {
      ...intent,
      canonical: 'FOREHAND_DRIVE',
      legacySlug: 'forehand_drive',
    };
    await act(async () =>
      renderer!.root
        .findByType(TechniqueIntentPicker)
        .props.onChange(differentTechnique),
    );
    await act(async () => button('Confirm technique').props.onPress());
    expect(
      store.calls
        .slice(before)
        .some(call =>
          /UPDATE local_capture SET (target_seed|declared_stroke)/.test(
            call.sql,
          ),
        ),
    ).toBe(false);
    expect(
      store.native
        .prepare('SELECT target_seed, declared_stroke FROM local_capture')
        .get(),
    ).toMatchObject({ target_seed: changedTarget, declared_stroke: 'dink' });
    expect(
      store.native
        .prepare(
          'SELECT record FROM local_analysis_record ORDER BY created_at, id LIMIT 1',
        )
        .get()?.record,
    ).toBe(original);
    expect(store.count('analysis_run_journal', OWNER)).toBe(
      change === 'unchanged' ? 2 : 1,
    );
    if (change === 'unchanged')
      expect(mockNavigation.replace).toHaveBeenCalledWith('Result', {
        analysisId: expect.any(String),
      });
    else {
      expect(renderer!.root.findByType(ScreenHeader).props.title).toBe(
        'Confirm technique',
      );
      expect(mockNavigation.replace).not.toHaveBeenCalled();
      expect(http).not.toHaveBeenCalled();
    }
    expectNoCapture();
  },
);

it.each(['release_pending', 'terminal'])(
  'does not claim an allowance refund while the original journal is %s',
  async state => {
    const { store, http } = await fixture(1, false);
    if (state === 'terminal')
      store.native
        .prepare(
          "UPDATE analysis_run_journal SET state = 'terminal', terminal_reason = 'permit_already_finalized', last_http_status = 409",
        )
        .run();
    await mount();
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).not.toContain('RATING NOT CONSUMED');
    expect(text).not.toContain('did not use a rating');
    expect(text).not.toContain('Nothing was rated');
    expect(text).toContain('SAVED ANALYSIS HELD');
    expect(runCaptureAnalysis).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
    expectNoCapture();
  },
);

it.each(['selection', 'journal'])(
  'holds legacy missing %s proof read-only while retaining the clip',
  async missing => {
    const { store, http } = await fixture();
    if (missing === 'selection') {
      const row = store.native
        .prepare('SELECT record FROM local_analysis_record')
        .get()!;
      const record = JSON.parse(String(row.record)) as Record<string, unknown>;
      delete record.inputSelection;
      store.native
        .prepare('UPDATE local_analysis_record SET record = ?')
        .run(JSON.stringify(record));
    } else store.native.prepare('DELETE FROM analysis_run_journal').run();
    await mount();
    expect(renderer!.root.findAllByType(AnalyzeScreen)).toHaveLength(0);
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      'no complete immutable confirmation proof',
    );
    expect(renderer!.root.findAllByType(TechniqueIntentPicker)).toHaveLength(0);
    expect(store.count('local_capture', OWNER)).toBe(1);
    expect(runCaptureAnalysis).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
    expectNoCapture();
  },
);

it('mounts the saved Analyze child only after the loader finishes, not by injecting a late prop into ready phase', async () => {
  const { sidecar, http } = await fixture();
  const pending = deferred<string>();
  mockReadArtifact = () => pending.promise;
  await mount();
  expect(renderer!.root.findAllByType(AnalyzeScreen)).toHaveLength(0);
  expect(JSON.stringify(renderer!.toJSON())).toContain('Opening saved capture');
  await act(async () => pending.resolve(sidecar));
  expect(renderer!.root.findAllByType(AnalyzeScreen)).toHaveLength(1);
  expect(renderer!.root.findByType(ScreenHeader).props.title).toBe(
    'Confirm technique',
  );
  expect(http).not.toHaveBeenCalled();
  expectNoCapture();
});

it.each([
  { captureId: undefined },
  { captureId: null },
  { captureId: '' },
  { captureId: 'not-a-uuid' },
  { captureId: captureId(1), source: 'library' },
  { captureId: captureId(1), extra: true },
  { source: 'unknown' },
  { source: null },
  null,
  [],
  'not-params',
])(
  'never falls through malformed saved parameters to camera/import: %j',
  async params => {
    const { http } = await fixture();
    await mount(params);
    expect(renderer!.root.findAllByType(AnalyzeScreen)).toHaveLength(0);
    expect(JSON.stringify(renderer!.toJSON())).toContain('could not be found');
    expect(loadSavedTechniqueConfirmation).not.toHaveBeenCalled();
    expect(runCaptureAnalysis).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
    expectNoCapture();
  },
);

it('drops a stale Try Again handoff without arming the saved capture or launching the importer', async () => {
  const { http } = await fixture();
  armTryAgain({
    source: 'camera',
    declaredStroke: 'serve',
    declaredCanonical: 'SERVE',
    auto: false,
    sessionId: null,
  });
  await mount();
  expect(peekTryAgainHandoff()).toBeNull();
  expect(
    renderer!.root.findByType(TechniqueIntentPicker).props.value,
  ).toBeNull();
  expect(button('Confirm technique').props.disabled).toBe(true);
  expect(runCaptureAnalysis).not.toHaveBeenCalled();
  expectNoCapture();
  expect(http).not.toHaveBeenCalled();
});

it('does not run a retained confirm handler after the selected technique changes', async () => {
  const { http, store } = await fixture();
  await mount();
  await act(async () =>
    renderer!.root.findByType(TechniqueIntentPicker).props.onChange(intent),
  );
  const staleConfirm = button('Confirm technique').props.onPress;
  const different = {
    ...intent,
    canonical: 'FOREHAND_DRIVE',
    legacySlug: 'forehand_drive',
  };
  await act(async () =>
    renderer!.root.findByType(TechniqueIntentPicker).props.onChange(different),
  );
  await act(async () => staleConfirm());
  expect(runCaptureAnalysis).not.toHaveBeenCalled();
  expect(store.count('analysis_run_journal', OWNER)).toBe(1);
  expect(http).not.toHaveBeenCalled();
  await act(async () => button('Confirm technique').props.onPress());
  expect(jest.mocked(runCaptureAnalysis).mock.calls[0]?.[0]).toMatchObject({
    declaredStroke: 'forehand_drive',
    declaredCanonical: 'FOREHAND_DRIVE',
  });
  expect(store.count('analysis_run_journal', OWNER)).toBe(2);
  expectNoCapture();
});

it.each([
  'owner',
  'aba',
  'service',
  'service_aba',
  'close',
  'unmount',
  'capture',
])(
  'keeps a committed score durable while %s invalidates the old route before publication',
  async changed => {
    const captures = changed === 'capture' ? 2 : 1;
    const { store, http } = await fixture(captures);
    await mount();
    await act(async () =>
      renderer!.root.findByType(TechniqueIntentPicker).props.onChange(intent),
    );
    const reached = deferred<void>();
    const resume = deferred<void>();
    jest.mocked(runCaptureAnalysis).mockImplementationOnce(async request => {
      const result = await jest
        .requireActual<typeof import('../src/analysis/runCaptureAnalysis')>(
          '../src/analysis/runCaptureAnalysis',
        )
        .runCaptureAnalysis(request);
      reached.resolve();
      expect(result.kind).toBe('scored');
      await resume.promise;
      return result;
    });
    const staleConfirm = button('Confirm technique').props.onPress;
    await act(async () => {
      staleConfirm();
      await reached.promise;
    });
    const signal = jest.mocked(runCaptureAnalysis).mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);
    await act(async () => {
      if (changed === 'owner' || changed === 'aba') {
        setActiveDataOwner(OTHER);
        if (changed === 'aba') setActiveDataOwner(OWNER);
      } else if (changed === 'service' || changed === 'service_aba') {
        session(`${BASE}/different`);
        if (changed === 'service_aba') session();
      } else if (changed === 'close')
        renderer!.root.findByType(ScreenHeader).props.onClose();
      else if (changed === 'unmount') {
        renderer!.unmount();
        renderer = null;
      }
    });
    if (changed === 'capture') await replaceParams({ captureId: captureId(2) });
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      staleConfirm();
      resume.resolve();
    });
    expect(mockNavigation.replace).not.toHaveBeenCalledWith(
      'Result',
      expect.anything(),
    );
    expect(reportScoredAnalysisForReview).not.toHaveBeenCalled();
    expect(store.count('analysis_run_journal', OWNER)).toBe(captures + 1);
    expect(store.count('local_shot', OWNER)).toBe(1);
    expect(
      store.native
        .prepare("SELECT count(*) AS n FROM outbox WHERE kind = 'shot.sync'")
        .get()?.n,
    ).toBe(1);
    expect(
      store.native
        .prepare(
          'SELECT state FROM analysis_run_journal WHERE result_id IS NOT NULL',
        )
        .get()?.state,
    ).toBe('committed');
    expect(
      http.mock.calls.filter(([url]) => url.endsWith('/v1/analysis-permits')),
    ).toHaveLength(1);
    expect(
      http.mock.calls.filter(([url]) => url.includes('/finalize')),
    ).toHaveLength(0);
    expectNoCapture();
  },
);

it.each(['success', 'failure'])(
  'invalidates deferred old capture %s and its close handler on capture-param replacement',
  async outcome => {
    const { sidecar, http } = await fixture(2);
    const pending = deferred<string>();
    mockReadArtifact = uri =>
      uri.endsWith('/1.pose.json') ? pending.promise : Promise.resolve(sidecar);
    await mount();
    const staleClose = renderer!.root.findByType(ScreenHeader).props.onClose;
    await replaceParams({ captureId: captureId(2) });
    expect(
      renderer!.root.findByType(AnalyzeScreen).props.savedTechniqueConfirmation
        .captureId,
    ).toBe(captureId(2));
    await act(async () => {
      staleClose();
      if (outcome === 'success') pending.resolve(sidecar);
      else pending.reject(new Error('Old artifact read failed'));
    });
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
    expect(
      renderer!.root.findByType(AnalyzeScreen).props.savedTechniqueConfirmation
        .captureId,
    ).toBe(captureId(2));
    expectNoCapture();
    expect(http).not.toHaveBeenCalled();
  },
);

it('discards deferred success after origin replacement and keeps the saved clip read-only', async () => {
  const { sidecar, http } = await fixture();
  const pending = deferred<string>();
  mockReadArtifact = () => pending.promise;
  await mount();
  await act(async () => session(`${BASE}/different`));
  await act(async () => pending.resolve(sidecar));
  expect(renderer!.root.findAllByType(AnalyzeScreen)).toHaveLength(0);
  expect(JSON.stringify(renderer!.toJSON())).toContain(
    'different rating-service',
  );
  expectNoCapture();
  expect(http).not.toHaveBeenCalled();
});

it('invalidates retained loaded handlers on ABA and freshly reopens an old-generation journal for A', async () => {
  const { http } = await fixture();
  await mount();
  const firstOwner =
    renderer!.root.findByType(AnalyzeScreen).props.savedTechniqueConfirmation
      .ownerContext;
  await act(async () =>
    renderer!.root.findByType(TechniqueIntentPicker).props.onChange(intent),
  );
  const staleConfirm = button('Confirm technique').props.onPress;
  const staleClose = renderer!.root.findByType(ScreenHeader).props.onClose;
  await act(async () => {
    setActiveDataOwner(OTHER);
    setActiveDataOwner(OWNER);
  });
  await act(async () => {
    staleConfirm();
    staleClose();
  });
  expect(runCaptureAnalysis).not.toHaveBeenCalled();
  expect(mockNavigation.goBack).not.toHaveBeenCalled();
  expect(
    renderer!.root.findByType(AnalyzeScreen).props.savedTechniqueConfirmation
      .ownerContext.generation,
  ).toBeGreaterThan(firstOwner.generation);
  expect(button('Confirm technique').props.disabled).toBe(true);
  expectNoCapture();
  expect(http).not.toHaveBeenCalled();
});

it('does not publish a closed loader or allow its retained retry to start a new camera', async () => {
  const { sidecar, http } = await fixture();
  const pending = deferred<string>();
  mockReadArtifact = () => pending.promise;
  await mount();
  await act(async () =>
    renderer!.root.findByType(ScreenHeader).props.onClose(),
  );
  await act(async () => pending.resolve(sidecar));
  expect(renderer!.root.findAllByType(AnalyzeScreen)).toHaveLength(0);
  expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
  expectNoCapture();
  expect(http).not.toHaveBeenCalled();
});

it('keeps retained reload and close actions inert after a failed route is replaced', async () => {
  const { http } = await fixture(2);
  jest
    .mocked(loadSavedTechniqueConfirmation)
    .mockRejectedValueOnce(new Error('Database busy'));
  await mount();
  const staleReload = button('Reload saved capture').props.onPress;
  const staleClose = button('Close').props.onPress;
  await replaceParams({ captureId: captureId(2) });
  const calls = jest.mocked(loadSavedTechniqueConfirmation).mock.calls.length;
  await act(async () => {
    staleReload();
    staleClose();
  });
  expect(loadSavedTechniqueConfirmation).toHaveBeenCalledTimes(calls);
  expect(mockNavigation.goBack).not.toHaveBeenCalled();
  expect(
    renderer!.root.findByType(AnalyzeScreen).props.savedTechniqueConfirmation
      .captureId,
  ).toBe(captureId(2));
  expect(http).not.toHaveBeenCalled();
  expectNoCapture();
});

it('invalidates the saved confirmation on blur and reloads with fresh handlers on refocus', async () => {
  const { http } = await fixture();
  await mount();
  await act(async () =>
    renderer!.root.findByType(TechniqueIntentPicker).props.onChange(intent),
  );
  const staleConfirm = button('Confirm technique').props.onPress;
  const staleClose = button('Close').props.onPress;
  const blurs = mockNavigation.addListener.mock.calls
    .filter(([name]) => name === 'blur')
    .map(([, callback]) => callback);
  const focus = mockNavigation.addListener.mock.calls.find(
    ([name]) => name === 'focus',
  )?.[1];
  expect(blurs.length).toBeGreaterThan(0);
  expect(focus).toBeDefined();
  await act(async () => {
    mockNavigation.isFocused.mockReturnValue(false);
    blurs.forEach(callback => callback());
  });
  expect(renderer!.root.findAllByType(AnalyzeScreen)).toHaveLength(0);
  await act(async () => {
    mockNavigation.isFocused.mockReturnValue(true);
    focus!();
  });
  await act(async () => {
    staleConfirm();
    staleClose();
  });
  expect(button('Confirm technique').props.disabled).toBe(true);
  expect(mockNavigation.goBack).not.toHaveBeenCalled();
  expect(runCaptureAnalysis).not.toHaveBeenCalled();
  expect(http).not.toHaveBeenCalled();
  expectNoCapture();
});

it('gives the fourth pending confirmation an owner-guarded library open action, distinct from importing', async () => {
  const { http } = await fixture(4);
  await act(async () => {
    renderer = TestRenderer.create(<LibraryScreen />);
  });
  const open = renderer!.root
    .findAllByType(Button)
    .find(
      node => node.props.testID === `open-saved-confirmation-${captureId(4)}`,
    )!;
  expect(open).toBeDefined();
  const staleOpen = open.props.onPress;
  await act(async () => staleOpen());
  expect(mockNavigation.navigate).toHaveBeenCalledWith('Analyze', {
    captureId: captureId(4),
  });
  mockNavigation.navigate.mockClear();
  await act(async () => {
    setActiveDataOwner(OTHER);
    setActiveDataOwner(OWNER);
  });
  await act(async () => staleOpen());
  expect(mockNavigation.navigate).not.toHaveBeenCalled();
  expectNoCapture();
  expect(http).not.toHaveBeenCalled();
});

it('opens an existing completed continuation without another rating or review request', async () => {
  const { http } = await fixture();
  await mount();
  await act(async () =>
    renderer!.root.findByType(TechniqueIntentPicker).props.onChange(intent),
  );
  await act(async () => button('Confirm technique').props.onPress());
  const id = mockNavigation.replace.mock.calls[0]?.[1]?.analysisId;
  expect(id).toBeDefined();
  await act(async () => renderer!.unmount());
  renderer = null;
  jest.mocked(runCaptureAnalysis).mockClear();
  jest.mocked(reportScoredAnalysisForReview).mockClear();
  http.mockClear();
  await mount();
  expect(renderer!.root.findAllByType(AnalyzeScreen)).toHaveLength(0);
  expect(JSON.stringify(renderer!.toJSON())).toContain('already has a result');
  await act(async () => button('Open saved result').props.onPress());
  expect(mockNavigation.replace).toHaveBeenLastCalledWith('Result', {
    analysisId: id,
  });
  expect(runCaptureAnalysis).not.toHaveBeenCalled();
  expect(reportScoredAnalysisForReview).not.toHaveBeenCalled();
  expectNoCapture();
  expect(http).not.toHaveBeenCalled();
});
