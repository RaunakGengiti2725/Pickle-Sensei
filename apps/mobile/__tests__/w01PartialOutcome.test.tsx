/**
 * W01-05 — a mechanics-only PARTIAL outcome never spends a free rating and
 * Result renders the honest benchmark-unavailable state.
 *
 * The release authority refuses admission with the typed, settled 409
 * `access.release_not_authorized` ("no rating was counted"). The run must
 * still deliver the mechanics evidence as an explicit non-chargeable partial:
 * no permit, no `local_shot` product row, no outbox sync, no release call,
 * the local free-rating view untouched, and a Result page that states the
 * technique benchmark is unavailable without any invented score, confidence
 * or benchmark range.
 *
 * Real pipeline + real migrated SQLite; only the sidecar read and HTTP are
 * simulated (same seams as attack4RunCaptureAnalysisPermits.test.ts).
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { CanonicalAccessState } from '../src/billing/types';
import type { CapturedClip } from '../src/camera/capture';
import type { LocalDb } from '../src/data/db';
import {
  createCaptureAnalysisDb,
  captureDbState,
  signInCaptureOwner,
  closeCaptureHarness,
  seedCaptureRequest,
} from '../testSupport/captureAnalysisHarness';

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};
jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

let mockCurrentDb: () => LocalDb = () => {
  throw new Error('db mock not configured');
};
jest.mock('../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

const mockLoadSequence = jest.fn();
jest.mock('../src/review/poseSidecar', () => ({
  loadReviewPoseSequence: (...args: unknown[]) => mockLoadSequence(...args),
}));
const mockTriggerOutboxSync = jest.fn();
jest.mock('../src/data/syncRuntime', () => ({
  triggerOutboxSync: () => mockTriggerOutboxSync(),
}));
const mockListCatalogDrills = jest.fn();
jest.mock('../src/training/api', () => ({
  createTrainingApi: () => ({ listCatalogDrills: mockListCatalogDrills }),
}));
const mockConsistencyState = {
  refresh: jest.fn(async () => {}),
  daySecured: null as unknown,
  consumeDaySecured: jest.fn(() => null),
};
jest.mock('../src/consistency/store', () => ({
  useConsistencyStore: (
    selector: (state: typeof mockConsistencyState) => unknown,
  ) => selector(mockConsistencyState),
}));
const mockNavigation = {
  goBack: jest.fn(),
  replace: jest.fn(),
  popToTop: jest.fn(),
  navigate: jest.fn(),
};
let mockRouteParams: Record<string, unknown> = {};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: mockRouteParams }),
}));
jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: (props: { children?: React.ReactNode; testID?: string }) =>
      ReactModule.createElement(View, { testID: props.testID }, props.children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});
jest.mock('react-native-svg', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Defs: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    RadialGradient: Mock,
    LinearGradient: Mock,
    Rect: Mock,
    Stop: Mock,
  };
});

import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';
import { useAccessStore } from '../src/state/accessStore';
import { ResultScreen } from '../src/screens/ResultScreen';
import { TECHNIQUE_BENCHMARK_UNAVAILABLE } from '../src/progress/techniqueBenchmarkDisplay';

const owner = '55555555-5555-4555-8555-555555555555';
const RELEASE_NOT_AUTHORIZED_CODE = 'access.release_not_authorized';

const freeAccess: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 1,
    reserved: 0,
    remaining: 1,
    availableToReserve: 1,
  },
  canStartRating: true,
  paywallRequired: false,
};

interface RecordedCall {
  sql: string;
  params: unknown[];
}

function jsonResponse(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    json: async () => body,
  } as unknown as Response;
}

/** Release authority refuses admission: a settled verdict, not an outage. */
function releaseNotAuthorizedServer() {
  const urls: string[] = [];
  const fetchMock = jest.fn(async (url: string) => {
    urls.push(url);
    if (url.endsWith('/v1/analysis-permits')) {
      return jsonResponse(
        {
          error: {
            code: RELEASE_NOT_AUTHORIZED_CODE,
            message:
              'Validated ratings are not available right now. No rating was counted.',
          },
          release: { status: 'ineligible', reasonCode: 'unreleased' },
        },
        409,
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, urls };
}

function swingClipWithSidecar(): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence({});
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///captures/w01.mov',
    durationMs: window.endMs,
    fps: sequence.video.fps,
    width: sequence.video.width,
    height: sequence.video.height,
    capturedAtIso: '2026-09-08T12:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: sequence.producedBy.modelVersion,
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: sequence.frames.length,
      poseFrameCount: sequence.frames.length,
      poseMissingFrameCount: 0,
      trackedDurationMs: window.endMs - window.startMs,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: sequence.frames.length,
      jointMotion: [
        {
          joint: 'right_wrist',
          sampleCount: 4,
          meanNormalizedPerSecond: 0.6,
          peakNormalizedPerSecond: 1.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 400,
    postRollMs: 300,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///captures/w01.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecarJson };
}

function request(db: LocalDb, clip: CapturedClip, label: string) {
  return {
    db,
    ...seedCaptureRequest(db, clip, label),
    clip,
    declaredStroke: 'forehand_drive' as const,
    declaredCanonical: 'FOREHAND_DRIVE' as const,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-w01' },
    appVersion: '0.1.0',
  };
}

function setFetch(fetchMock: unknown) {
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
}

const localShotInserts = (calls: RecordedCall[]) =>
  calls.filter(call => call.sql.includes('INSERT OR REPLACE INTO local_shot'));
const outboxInserts = (calls: RecordedCall[]) =>
  calls.filter(call => call.sql.includes('INSERT INTO outbox'));

const mounted: ReactTestRenderer[] = [];

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderResult(analysisId: string) {
  mockRouteParams = { analysisId };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ResultScreen />);
  });
  await settle();
  mounted.push(renderer);
  return renderer;
}

function allText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .join(' ')
    .replace(/\s+/g, ' ');
}

function hostByTestId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

async function runPartial(label: string) {
  const { db, calls } = createCaptureAnalysisDb();
  mockCurrentDb = () => db;
  const { clip, sidecarJson } = swingClipWithSidecar();
  mockReadArtifact = async () => sidecarJson;
  const server = releaseNotAuthorizedServer();
  setFetch(server.fetchMock);
  const req = request(db, clip, label);
  const outcome = await runCaptureAnalysis(req);
  return { db, calls, server, outcome, req };
}

beforeEach(() => {
  signInCaptureOwner(owner);
  useAccessStore.setState({ canonicalAccess: freeAccess, status: 'ready' });
});
afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  useAccessStore.getState().reset();
  closeCaptureHarness();
  setFetch(undefined);
});

describe('W01-05 — mechanics-only partial outcome', () => {
  it('settles as an explicit non-chargeable partial: no permit, no product row, no outbox, no release call', async () => {
    const { db, calls, server, outcome } = await runPartial('w01-settle');

    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;
    expect(outcome.record.result).toBeNull();
    expect(outcome.record.partialOutcome).toEqual(
      expect.objectContaining({
        status: 'partial',
        billingDisposition: 'not_chargeable',
        withheld: 'technique_benchmark',
        reasonCode: RELEASE_NOT_AUTHORIZED_CODE,
      }),
    );

    // The chargeable route was never entered.
    expect(localShotInserts(calls)).toHaveLength(0);
    expect(outboxInserts(calls)).toHaveLength(0);
    expect(server.urls.filter(url => url.includes('/finalize'))).toHaveLength(
      0,
    );
    expect(
      server.urls.filter(url => url.endsWith('/v1/analysis-permits')),
    ).toHaveLength(1);

    const state = captureDbState(db);
    expect(state.shots).toBe(0);
    expect(state.outbox).toBe(0);
    expect(state.records).toBe(1);
    expect(state.journal).toHaveLength(1);
    const journal = state.journal[0] as Record<string, unknown>;
    expect(journal.permit_id).toBeNull();
    expect(journal.result_id).toBeNull();
    expect(journal.state).toBe('terminal');
    expect(journal.last_http_status).toBe(409);
    expect(
      state.captures.map(row => (row as { status: string }).status),
    ).toEqual(['analyzed']);
  });

  it('leaves the local free-rating view exactly as it was', async () => {
    const before = JSON.parse(
      JSON.stringify(useAccessStore.getState().canonicalAccess),
    );
    const { outcome } = await runPartial('w01-free-view');
    expect(outcome.kind).toBe('partial');
    expect(useAccessStore.getState().canonicalAccess).toEqual(before);
    expect(useAccessStore.getState().canonicalAccess?.freeRatings).toEqual({
      limit: 2,
      used: 1,
      reserved: 0,
      remaining: 1,
      availableToReserve: 1,
    });
    if (outcome.kind === 'partial') {
      expect('freeLimitReached' in outcome).toBe(false);
    }
  });

  it('replaying the same operation returns the saved partial without a second reservation', async () => {
    const { server, outcome, req } = await runPartial('w01-replay');
    expect(outcome.kind).toBe('partial');
    const replay = await runCaptureAnalysis(req);
    expect(replay.kind).toBe('partial');
    if (replay.kind !== 'partial' || outcome.kind !== 'partial') return;
    expect(replay.replayed).toBe(true);
    expect(replay.analysisId).toBe(outcome.analysisId);
    expect(replay.record.partialOutcome).toEqual(outcome.record.partialOutcome);
    expect(
      server.urls.filter(url => url.endsWith('/v1/analysis-permits')),
    ).toHaveLength(1);
  });

  it('Result renders the explicit benchmark-unavailable state with no score, confidence or range', async () => {
    const { outcome } = await runPartial('w01-result');
    expect(outcome.kind).toBe('partial');
    if (outcome.kind !== 'partial') return;

    const renderer = await renderResult(outcome.analysisId);
    const status = hostByTestId(renderer, 'result-benchmark-status');
    expect(status).toHaveLength(1);
    expect(status[0]!.props.children).toBe(TECHNIQUE_BENCHMARK_UNAVAILABLE);
    expect(hostByTestId(renderer, 'result-guide-step-abstained')).toHaveLength(
      1,
    );
    expect(hostByTestId(renderer, 'result-guide-step-score')).toHaveLength(0);
    expect(hostByTestId(renderer, 'result-partial-benchmark')).toHaveLength(1);

    const copy = allText(renderer);
    expect(copy).toContain('BENCHMARK UNAVAILABLE');
    expect(copy).toContain('RATING NOT CONSUMED');
    expect(copy).toContain(TECHNIQUE_BENCHMARK_UNAVAILABLE);
    expect(copy).toContain(
      'Validated ratings are not available right now. No rating was counted.',
    );
    expect(copy).not.toContain('out of 10');
    expect(copy).not.toContain('TECHNIQUE SCORE');
    expect(copy).not.toMatch(/\d(\.\d)?\s*[–-]\s*\d(\.\d)?/);
    expect(copy).not.toMatch(/\d+\s*%/);
    expect(copy).not.toMatch(/DUPR|≈/);
    expect(mockListCatalogDrills).not.toHaveBeenCalled();
    expect(mockTriggerOutboxSync).not.toHaveBeenCalled();
  });
});
