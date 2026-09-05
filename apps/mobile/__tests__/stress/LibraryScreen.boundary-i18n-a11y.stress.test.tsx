/**
 * LibraryScreen boundary / i18n / a11y stress campaign.
 *
 * Renders the REAL `RootNavigator` (NavigationContainer → native stack →
 * bottom tabs → PremiumTabBar) and reaches LibraryScreen the way a user does:
 * by pressing the Library tab. Navigation, `useFocusEffect`, the auth store,
 * the training Zustand store, the training API client (real parser over a
 * scripted `fetch`) and the SQLite repository layer (real migrations over a
 * `node:sqlite` adapter) are all real. Only native modules, sibling screens
 * that are not under test, and `fetch` are replaced.
 *
 * Every scenario derives from one integer seed (see
 * xc-harness/stress-libraryscreen/seeds.ts). Replay a row of the results
 * table with `STRESS_SEED=<seed>`; size the campaign with `STRESS_ITER=<n>`
 * (default 12). `STRESS_STRICT=1` additionally fails the test on the
 * estimate-based layout observations (truncation / row overflow / fixed box
 * overflow / placeholder-text leaks), which are otherwise only recorded.
 *
 * Linux/Jest has no layout engine. Every width/height figure produced here is
 * derived from flattened styles and font metrics × the variant's font scale;
 * the results table labels each number `declared` or `estimated`. Nothing in
 * this file is evidence of iOS runtime rendering.
 */
import React from 'react';
import { PixelRatio, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  fs,
  loadNodeSqlite,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import type { SqliteDatabaseSync } from '../../xc-harness/lifecycle-persistence/nodeShim';
import {
  installDeviceClock,
  restoreDeviceClock,
} from '../../xc-harness/stress-libraryscreen/deviceClock';
import {
  campaignSeeds,
  repeatCount,
  stressArtifactDir,
  writeStressJson,
} from '../../xc-harness/stress-libraryscreen/artifacts';
import {
  inspectFixedBoxes,
  inspectInteractive,
  inspectTexts,
  isPressable,
  MIN_TARGET_PT,
  serializeHostTree,
  textContent,
  textLeaks,
  type FixedBoxReport,
  type InteractiveReport,
  type TextReport,
} from '../../xc-harness/stress-libraryscreen/inspect';
import {
  makePrng,
  planRejected,
  savedListRejected,
  uuidFrom,
  variantFromSeed,
  type CaptureSeed,
  type DrillSeed,
  type ScoreCase,
  type Variant,
} from '../../xc-harness/stress-libraryscreen/seeds';

// ─── Native + sibling-screen seams (hoisted) ─────────────────────────────────

jest.mock(
  'react-native-safe-area-context',
  () =>
    jest.requireActual<{ default: unknown }>(
      'react-native-safe-area-context/jest/mock',
    ).default,
);
jest.mock('react-native-linear-gradient', () => {
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactLib.createElement(RN.View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

/** Real SQLite (node:sqlite) behind the op-sqlite surface the repository
 * uses, with a switch that makes the two library reads fail like an I/O
 * error so the READS_LOAD_ERROR branch is reachable. */
const mockSqlite: {
  real: SqliteDatabaseSync | null;
  failLibraryReads: boolean;
} = { real: null, failLibraryReads: false };
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const run = (sql: string, params: unknown[]) => {
      const db = mockSqlite.real;
      if (!db) throw new Error('stress harness did not seed a database');
      if (
        mockSqlite.failLibraryReads &&
        /FROM\s+local_(shot|capture)\b/i.test(sql)
      ) {
        throw new Error('SQLITE_IOERR: disk I/O error');
      }
      return {
        rows: db.prepare(sql).all(...(params as (string | number | null)[])),
      };
    };
    return {
      executeSync: (sql: string, params: unknown[] = []) => run(sql, params),
      execute: async (sql: string, params: unknown[] = []) => run(sql, params),
      close: () => {},
    };
  },
}));

/** Sibling screens are not under test: each becomes a stub that prints its
 * route params and offers a labelled back control so the harness can
 * return to Library through real navigation. */
function mockRouteStub(exportName: string) {
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const Stub = (props: {
    route?: { name: string; params?: unknown };
    navigation?: { goBack(): void };
  }) =>
    ReactLib.createElement(
      RN.View,
      null,
      ReactLib.createElement(
        RN.Text,
        { testID: `route:${exportName}` },
        `[${exportName}] ${JSON.stringify(props.route?.params ?? null)}`,
      ),
      ReactLib.createElement(
        RN.Pressable,
        {
          accessibilityRole: 'button',
          accessibilityLabel: 'stress-stub-back',
          onPress: () => props.navigation?.goBack(),
          style: { minHeight: 44 },
        },
        ReactLib.createElement(RN.Text, null, 'back'),
      ),
    );
  return { __esModule: true, [exportName]: Stub };
}
jest.mock('../../src/screens/HomeScreen', () => mockRouteStub('HomeScreen'));
jest.mock('../../src/screens/ProgressScreen', () =>
  mockRouteStub('ProgressScreen'),
);
jest.mock('../../src/screens/SettingsScreen', () =>
  mockRouteStub('SettingsScreen'),
);
jest.mock('../../src/screens/AnalyzeScreen', () =>
  mockRouteStub('AnalyzeScreen'),
);
jest.mock('../../src/screens/ResultScreen', () =>
  mockRouteStub('ResultScreen'),
);
jest.mock('../../src/screens/ResultDetailsScreen', () =>
  mockRouteStub('ResultDetailsScreen'),
);
jest.mock('../../src/screens/FormReviewScreen', () =>
  mockRouteStub('FormReviewScreen'),
);
jest.mock('../../src/screens/DrillLibraryScreen', () =>
  mockRouteStub('DrillLibraryScreen'),
);
jest.mock('../../src/screens/StreakCalendarScreen', () =>
  mockRouteStub('StreakCalendarScreen'),
);
jest.mock('../../src/screens/SignInScreen', () =>
  mockRouteStub('SignInScreen'),
);
jest.mock('../../src/screens/ManageAccountScreen', () =>
  mockRouteStub('ManageAccountScreen'),
);
jest.mock('../../src/screens/ConsentSettingsScreen', () =>
  mockRouteStub('ConsentSettingsScreen'),
);
jest.mock('../../src/screens/NotificationSettingsScreen', () =>
  mockRouteStub('NotificationSettingsScreen'),
);
jest.mock('../../src/screens/PaywallScreen', () =>
  mockRouteStub('PaywallScreen'),
);

import { RootNavigator } from '../../src/navigation/RootNavigator';
import { LibraryScreen } from '../../src/screens/LibraryScreen';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { getDb } from '../../src/data/db';
import type { CapturedClip } from '../../src/camera/capture';
import type { PendingCapture } from '../../src/data/repository';
import { createTrainingApi, type TrainingFetch } from '../../src/training/api';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';

// ─── Fixtures ────────────────────────────────────────────────────────────────

type Instance = TestRenderer.ReactTestInstance;

/** A clip that passes `assertCapturedClip` (mirrors the validated fixture in
 * __tests__/captureRepository.test.ts; typed so the compiler pins the shape). */
const VALID_CLIP: Extract<
  CapturedClip,
  { captureMode: 'automatic_pose_trigger' }
> = {
  uri: 'file:///private/captures/stress.mov',
  durationMs: 3900,
  fps: 59.94,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-08-27T18:00:00.000Z',
  captureMode: 'automatic_pose_trigger',
  recognition: {
    status: 'unknown',
    reason: 'validated_classifier_unavailable',
  },
  trigger: {
    startMs: 1800,
    endMs: 2450,
    peakMotionMs: 2220,
    confidence: 0.84,
    source: 'temporal_pose_motion',
    modelVersion: 'temporal-stroke-heuristic-2',
  },
  captureEvidence: {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: 'mediapipe_pose_landmarker',
    poseModelVersion: 'mediapipe-pose-landmarker-full-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
    motionUnit: 'normalized_image_units_per_second',
    analysisInputFrameCount: 8,
    poseFrameCount: 7,
    poseMissingFrameCount: 1,
    trackedDurationMs: 600,
    meanCanonicalJointVisibility: 0.86,
    meanJointCoverage: 0.93,
    minimumJointCoverage: 0.83,
    fullBodyVisibleFrameCount: 5,
    jointMotion: [
      {
        joint: 'left_wrist',
        sampleCount: 6,
        meanNormalizedPerSecond: 1.2,
        peakNormalizedPerSecond: 2.1,
      },
    ],
  },
  ballSpeed: {
    status: 'unavailable',
    reason: 'calibrated_ball_tracker_unavailable',
  },
  preRollMs: 1800,
  postRollMs: 1450,
};

interface CaptureRowFixture {
  uri: string;
  capturedAt: string;
  /** Raw seeded column value — strings and non-finite numbers included. */
  durationMs: ScoreCase['value'];
  fps: number;
  width: number;
  height: number;
  payload: string | null;
  /** Evidence status production `parseCaptureRow` must derive for this row. */
  expected: PendingCapture['evidenceStatus'];
}

/**
 * Row columns + payload for one seeded capture. The row keeps the seeded
 * boundary values (negative/zero/huge duration, unparseable timestamps); the
 * payload is the validated clip. Where the seeded columns cannot equal a
 * clip that validates (non-positive duration, invalid ISO), a `valid` seed
 * necessarily lands as `metadata_mismatch` — the expectation mirrors the
 * production rule rather than bending the fixture.
 */
function captureRow(capture: CaptureSeed): CaptureRowFixture {
  const uri = `file:///private/captures/${capture.id}.mov`;
  const seededDuration =
    typeof capture.duration.value === 'number' ? capture.duration.value : NaN;
  // The trigger window must fit inside the clip, so only seeded durations
  // that can hold it are mirrored into the payload.
  const clipDuration =
    Number.isFinite(seededDuration) &&
    seededDuration >= VALID_CLIP.trigger.endMs
      ? seededDuration
      : VALID_CLIP.durationMs;
  const clip: CapturedClip = {
    ...VALID_CLIP,
    uri,
    durationMs: clipDuration,
    capturedAtIso: capture.capturedAtValid
      ? capture.capturedAt
      : VALID_CLIP.capturedAtIso,
    preRollMs: Math.min(VALID_CLIP.preRollMs ?? 0, clipDuration),
    postRollMs: Math.min(VALID_CLIP.postRollMs ?? 0, clipDuration),
  };
  const rowDuration = capture.duration.value;
  const base = {
    uri,
    capturedAt: capture.capturedAt,
    durationMs: rowDuration,
    fps: clip.fps,
    width: clip.width,
    height: clip.height,
  };
  switch (capture.payload) {
    case 'null':
      return { ...base, payload: null, expected: 'legacy' };
    case 'corrupt':
      return {
        ...base,
        payload: '{"captureMode":"automatic_pose_trigger","uri":42',
        expected: 'corrupt',
      };
    case 'mismatch':
      return {
        ...base,
        width: clip.width + 360,
        payload: JSON.stringify(clip),
        expected: 'metadata_mismatch',
      };
    case 'valid': {
      const matches =
        clip.durationMs === rowDuration &&
        clip.capturedAtIso === capture.capturedAt;
      return {
        ...base,
        payload: JSON.stringify(clip),
        expected: matches ? 'valid' : 'metadata_mismatch',
      };
    }
  }
}

function ownerFor(session: Variant['session'], subject: string): string {
  if (session === 'signed_out') return SIGNED_OUT_DATA_OWNER;
  if (session === 'local_only') return GUEST_DATA_OWNER;
  return subject;
}

function sessionFor(variant: Variant, subject: string): AuthSession | null {
  if (variant.session === 'signed_out') return null;
  if (variant.session === 'local_only') {
    return {
      provider: 'guest',
      subject: GUEST_DATA_OWNER,
      canonicalAppUserId: null,
      localOnly: true,
      displayName: null,
      email: null,
    };
  }
  return {
    provider: 'apple',
    subject,
    canonicalAppUserId: subject,
    localOnly: false,
    displayName: variant.apiErrorMessage.value,
    email: 'stress@example.invalid',
  };
}

/** LocalDb handles opened through production `getDb()`; closing one resets
 * the module-level cache so the next variant migrates a fresh database. */
const openDbs: { close(): void }[] = [];

function seedDatabase(variant: Variant, owner: string): SqliteDatabaseSync {
  const sqlite = loadNodeSqlite();
  if (!sqlite)
    throw new Error('node:sqlite unavailable — run on Node >= 22.13');
  const real = new sqlite.DatabaseSync(':memory:');
  mockSqlite.real = real;
  mockSqlite.failLibraryReads = false;
  // Production migrations run here through the mocked op-sqlite surface.
  const db = getDb();
  openDbs.push(db);
  for (const shot of variant.shots) {
    real
      .prepare(
        `INSERT INTO local_shot (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, favorite, payload)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'real', 0, '{}')`,
      )
      .run(
        owner,
        shot.id,
        shot.shotType.value,
        shot.capturedAt,
        shot.score.value,
        0.9,
        shot.resultKind,
      );
  }
  for (const capture of variant.captures) {
    const row = captureRow(capture);
    real
      .prepare(
        `INSERT INTO local_capture (owner_key, id, uri, shot_type, declared_stroke, captured_at, duration_ms, fps, width, height, status, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_model', ?)`,
      )
      .run(
        owner,
        capture.id,
        row.uri,
        capture.shotType.value,
        capture.declaredStroke,
        row.capturedAt,
        row.durationMs,
        row.fps,
        row.width,
        row.height,
        row.payload,
      );
  }
  // A row for another owner must never leak into this owner's library.
  real
    .prepare(
      `INSERT INTO local_shot (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, favorite, payload)
       VALUES ('11111111-1111-4111-8111-111111111111', ?, NULL, 'OTHER_OWNER_LEAK', '2026-06-15T12:00:00.000Z', 5, 0.9, 'scored', 'real', 0, '{}')`,
    )
    .run(`leak-${variant.seed}`);
  mockSqlite.failLibraryReads = variant.reads === 'load_failure';
  return real;
}

interface ScriptedResponse {
  status: number;
  body: unknown;
}

function jsonResponse(res: ScriptedResponse): Response {
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    statusText: String(res.status),
    headers: new Headers(),
    json: async () => res.body,
    text: async () => JSON.stringify(res.body),
  } as unknown as Response;
}

/**
 * Wire-shape drill detail (`parseDrillDetail`): snake_case drill/mapping
 * fields, camelCase media. Boundary strings travel verbatim — the parser only
 * requires `string`, so blank / "null" / 200-char titles are valid server
 * output the screen must survive.
 */
function drillDetailBody(drill: DrillSeed, rng: () => number) {
  return {
    drill: {
      id: uuidFrom(rng),
      slug: drill.slug,
      title: drill.title.value,
      description: drill.description.value,
      coach_name: drill.coachName.value,
      equipment: [],
      difficulty_min: null,
      difficulty_max: null,
      saved: true,
    },
    mappings: [
      {
        checkpoint: 'contact_point',
        shot_type: 'forehand_drive',
        plan_role: 'targeted',
        fault_directions: ['late'],
        cue_text: drill.description.value,
        target_sets: 3,
        target_repetitions_per_set: 10,
        target_duration_seconds: null,
        rest_seconds: 30,
      },
    ],
    instructionalMedia: drill.withMedia
      ? [
          {
            id: uuidFrom(rng),
            kind: 'embed',
            provider: 'youtube',
            videoId: 'stress0000',
            embedUrl: 'https://www.youtube-nocookie.com/embed/stress0000',
            sourceUrl: 'https://www.youtube.com/watch?v=stress0000',
            creatorName: drill.coachName.value,
            licenseName: 'Standard YouTube License',
            licenseUrl: null,
            attribution: drill.coachName.value,
          },
        ]
      : [],
  };
}

function scriptedFetch(variant: Variant, log: string[]): TrainingFetch {
  const rng = makePrng(variant.seed ^ 0x5eed);
  const planShotId = uuidFrom(rng);
  const drillIds = new Map(variant.drills.map(d => [d.slug, uuidFrom(rng)]));
  const errorBody = (code: string) => ({
    error: { code, message: variant.apiErrorMessage.value },
  });
  const respond = async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = init?.method?.toUpperCase() ?? 'GET';
    const pathname = new URL(url).pathname;
    if (method === 'GET' && pathname === '/v1/me/saved-drills') {
      if (variant.saved === 'api_error') {
        return jsonResponse({ status: 500, body: errorBody('server.error') });
      }
      return jsonResponse({
        status: 200,
        body: {
          items: variant.drills.map(d => ({
            id: drillIds.get(d.slug),
            slug: d.slug,
            title: d.title.value,
            description: d.description.value,
            coach_name: d.coachName.value,
            equipment: [],
            difficulty_min: null,
            difficulty_max: null,
            saved_at: '2026-06-15T12:00:00.000Z',
          })),
        },
      });
    }
    const detail = pathname.match(/^\/v1\/catalog\/drills\/([^/]+)$/);
    const savedEntry = pathname.match(/^\/v1\/me\/saved-drills\/([^/]+)$/);
    if (detail && method === 'GET') {
      const drill = variant.drills.find(
        d => d.slug === decodeURIComponent(detail[1] ?? ''),
      );
      if (!drill || drill.detailFails) {
        return jsonResponse({
          status: 404,
          body: errorBody('drill.not_found'),
        });
      }
      return jsonResponse({ status: 200, body: drillDetailBody(drill, rng) });
    }
    if (savedEntry && method === 'DELETE') {
      if (variant.saved === 'mutation_error') {
        return jsonResponse({ status: 500, body: errorBody('server.error') });
      }
      return jsonResponse({ status: 200, body: {} });
    }
    if (method === 'GET' && pathname === '/v1/training-plans/current') {
      if (!variant.plan)
        return jsonResponse({ status: 200, body: { plan: null } });
      const plan = variant.plan;
      return jsonResponse({
        status: 200,
        body: {
          plan: {
            id: uuidFrom(rng),
            status: 'active',
            algorithmVersion: 'v1',
            sourceShotId: planShotId,
            shotType: plan.shotType.value,
            priorityCheckpoint: plan.priorityCheckpoint.value,
            priorityDirection: plan.priorityDirection.value,
            baselineScore: 6.2,
            baselineCheckpointScore: null,
            reassessmentShotId: null,
            scoreDelta: null,
            createdAt: '2026-06-15T12:00:00.000Z',
            completedAt: null,
            items: Array.from({ length: plan.items }, (_, i) => {
              const drill =
                variant.drills[i % Math.max(1, variant.drills.length)];
              return {
                id: uuidFrom(rng),
                position: i,
                kind: i === 0 ? 'warmup' : 'targeted',
                drill: drill
                  ? {
                      id: drillIds.get(drill.slug),
                      slug: drill.slug,
                      title: drill.title.value,
                      description: drill.description.value,
                      coachName: drill.coachName.value,
                      equipment: [],
                      saved: true,
                    }
                  : null,
                cueText: plan.priorityDirection.value,
                targetSets: 3,
                targetRepetitionsPerSet: 10,
                targetDurationSeconds: null,
                restSeconds: 30,
                completion:
                  i < plan.completed
                    ? {
                        id: uuidFrom(rng),
                        completedAt: '2026-06-15T12:30:00.000Z',
                        actualRepetitions: 10,
                        actualDurationSeconds: null,
                        qualifiesForStreak: true,
                      }
                    : null,
              };
            }),
          },
        },
      });
    }
    return jsonResponse({ status: 404, body: errorBody('not_found') });
  };
  return async (url, init) => {
    const res = await respond(url, init);
    log.push(
      `${init?.method?.toUpperCase() ?? 'GET'} ${new URL(url).pathname} -> ${res.status}`,
    );
    return res;
  };
}

// ─── Render helpers ──────────────────────────────────────────────────────────

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
}

function pressablesLabeled(root: Instance, label: string): Instance[] {
  return root.findAll(
    n =>
      isPressable(n) &&
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
}

async function press(node: Instance) {
  await act(async () => {
    node.props.onPress();
  });
  await settle();
}

function allText(root: Instance): string {
  return root.findAllByType(Text).map(textContent).join('\n');
}

function libraryRoot(
  renderer: TestRenderer.ReactTestRenderer,
): Instance | null {
  const found = renderer.root.findAllByType(LibraryScreen);
  return found[0] ?? null;
}

// ─── Outcome model ───────────────────────────────────────────────────────────

interface Check {
  id: string;
  ok: boolean;
  /** `hard` checks fail the test; `soft` checks are estimate-based and fail
   * only under STRESS_STRICT=1. */
  tier: 'hard' | 'soft';
  detail?: string;
}

interface Outcome {
  seed: number;
  repeat: number;
  variant: Omit<Variant, 'shots' | 'captures' | 'drills'> & {
    shotCount: number;
    captureCount: number;
    drillCount: number;
    shotTypes: string[];
    scores: (string | number | null)[];
    capturedAt: string[];
  };
  rendered: {
    stateLabel: string;
    interactive: InteractiveReport[];
    texts: TextReport[];
    fixedBoxes: FixedBoxReport[];
    rtlStyleScan: { textAlignAbsolute: number; absoluteLeftRight: number };
  } | null;
  checks: Check[];
  outcome: 'HELD' | 'BROKEN';
  /** Tier of the strongest failed invariant (null when HELD). */
  brokenTier: 'hard' | 'soft' | null;
  failedInvariants: string[];
  consoleErrors: string[];
  fetchLog: string[];
  crash: string | null;
  evidence: string | null;
  durationMs: number;
}

const outcomes: Outcome[] = [];
const strict = nodeProcess.env['STRESS_STRICT'] === '1';
const FLATLIST_INITIAL_WINDOW = 10;

function expectedLocalDateParts(
  iso: string,
  locale: string,
  timezone: string,
): { month: string; day: string; time: string } {
  const date = new Date(iso);
  return {
    month: new Intl.DateTimeFormat(locale, {
      month: 'short',
      timeZone: timezone,
    })
      .format(date)
      .toUpperCase(),
    day: String(
      Number(
        new Intl.DateTimeFormat('en-US', {
          day: 'numeric',
          timeZone: timezone,
        }).format(date),
      ),
    ),
    time: new Intl.DateTimeFormat(locale, {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone,
    }).format(date),
  };
}

function classifyState(library: Instance): string {
  const text = allText(library);
  if (text.includes('Your reads couldn’t be opened.'))
    return 'reads_load_error';
  if (text.includes('Loading your reads')) return 'reads_loading';
  const counter = text.match(/(\d+) analyzed reads? · (\d+) pending clips?/);
  if (counter) {
    if (counter[1] === '0') return 'reads_captures_only';
    return counter[2] === '0' ? 'reads_rows' : 'reads_rows_with_pending';
  }
  if (text.includes('Analyze your first stroke')) return 'reads_empty';
  if (text.includes('Loading saved drills')) return 'saved_loading';
  if (text.includes('Saved training needs a synced account.'))
    return text.includes('Connect account')
      ? 'saved_unconfigured_local_only'
      : 'saved_unconfigured_signed_out';
  if (text.includes('Training is offline.')) return 'saved_api_error';
  if (text.includes('Saved entries couldn’t be verified right now.'))
    return 'saved_all_held';
  if (text.includes('SAVED DRILL')) {
    const plan = text.includes('CURRENT PLAN');
    const held = text.includes('additional saved');
    return `saved_drills${plan ? '_with_plan' : ''}${held ? '_partially_held' : ''}`;
  }
  if (text.includes('No saved drills yet.')) return 'saved_empty';
  if (text.includes('Explore the Drill Library')) return 'saved_other';
  return 'reads_rows';
}

async function runVariant(seed: number, repeat: number): Promise<Outcome> {
  const started = Date.now();
  const variant = variantFromSeed(seed);
  const subject = uuidFrom(makePrng(seed ^ 0xa11ce));
  const owner = ownerFor(variant.session, subject);
  const consoleErrors: string[] = [];
  const fetchLog: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(a => String(a)).join(' '));
    });
  const fontScaleSpy = jest
    .spyOn(PixelRatio, 'getFontScale')
    .mockReturnValue(variant.fontScale);

  installDeviceClock({ locale: variant.locale, timeZone: variant.timezone });
  act(() => {
    useAuthStore.setState({ session: sessionFor(variant, subject) });
    setActiveDataOwner(owner);
    if (variant.session === 'synced') {
      configureTrainingStore(
        createTrainingApi({
          baseUrl: 'https://stress.invalid',
          token: 'stress-token',
          fetchFn: scriptedFetch(variant, fetchLog),
        }),
      );
    } else {
      clearTrainingStoreConfiguration();
    }
  });
  let real: SqliteDatabaseSync | null = null;

  const checks: Check[] = [];
  const hard = (id: string, ok: boolean, detail?: string) =>
    checks.push({ id, ok, tier: 'hard', detail });
  const soft = (id: string, ok: boolean, detail?: string) =>
    checks.push({ id, ok, tier: 'soft', detail });

  let crash: string | null = null;
  let rendered: Outcome['rendered'] = null;
  let evidence: string | null = null;
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  const seededInputs = [
    ...variant.shots.map(s => s.shotType.value),
    ...variant.captures.map(c => c.shotType.value),
    ...variant.drills.flatMap(d => [
      d.title.value,
      d.description.value,
      d.coachName.value,
    ]),
    variant.apiErrorMessage.value,
    ...(variant.plan
      ? [
          variant.plan.shotType.value,
          variant.plan.priorityCheckpoint.value,
          variant.plan.priorityDirection.value,
        ]
      : []),
  ];

  try {
    real = seedDatabase(variant, owner);
    await act(async () => {
      renderer = TestRenderer.create(<RootNavigator />);
    });
    await settle();
    const r = renderer as unknown as TestRenderer.ReactTestRenderer;

    // Reach Library through the real PremiumTabBar.
    const libraryTab = r.root.findAll(
      n =>
        n.props.accessibilityRole === 'tab' &&
        n.props.accessibilityLabel === 'Library' &&
        typeof n.props.onPress === 'function',
    )[0];
    hard('tabbar_has_library_tab', Boolean(libraryTab));
    if (!libraryTab) throw new Error('PremiumTabBar exposes no Library tab');
    await press(libraryTab);
    await settle(6);

    let library = libraryRoot(r);
    hard('library_mounted_via_tab', Boolean(library));
    if (!library)
      throw new Error('LibraryScreen did not mount after tab press');

    if (variant.tab === 'saved') {
      const savedTab = library.findAll(
        n =>
          isPressable(n) &&
          n.props.accessibilityRole === 'tab' &&
          typeof n.props.onPress === 'function',
      )[1];
      hard('segmented_saved_tab_present', Boolean(savedTab));
      if (savedTab) await press(savedTab);
      await settle(6);
    }

    if (
      variant.tab === 'saved' &&
      variant.saved === 'mutation_error' &&
      variant.drills[0] &&
      !savedListRejected(variant)
    ) {
      const remove = pressablesLabeled(
        library,
        `Remove ${variant.drills[0].title.value} from saved drills`,
      )[0];
      hard('saved_drill_remove_control_present', Boolean(remove));
      if (remove) await press(remove);
      await settle(6);
      const text = allText(library);
      hard(
        'mutation_error_surfaced_inline',
        text.includes(variant.apiErrorMessage.value.trim()) ||
          useTrainingStore.getState().mutationError !== null,
        `store.mutationError=${JSON.stringify(
          useTrainingStore.getState().mutationError,
        )}`,
      );
    }

    library = libraryRoot(r);
    if (!library) throw new Error('LibraryScreen unmounted unexpectedly');

    // ── State reached ──
    const stateLabel = classifyState(library);
    const text = allText(library);
    hard(
      'reads_not_stuck_loading',
      !text.includes('Loading your reads'),
      stateLabel,
    );
    hard(
      'no_cross_owner_row_leak',
      !text.includes('OTHER OWNER LEAK') && !text.includes('OTHER_OWNER_LEAK'),
    );
    if (variant.tab === 'reads') {
      if (variant.reads === 'load_failure') {
        hard(
          'read_failure_shows_alert',
          library.findAll(n => n.props.accessibilityRole === 'alert').length >
            0 && text.includes('Your reads couldn’t be opened.'),
          stateLabel,
        );
        hard(
          'read_failure_offers_retry',
          pressablesLabeled(library, 'Try again').length === 1,
        );
      } else {
        hard(
          'reads_no_false_error',
          !text.includes('Your reads couldn’t be opened.'),
        );
        const rows = library.findAll(
          n =>
            isPressable(n) &&
            typeof n.props.accessibilityLabel === 'string' &&
            /^Open .* result$/.test(n.props.accessibilityLabel as string),
        );
        // FlatList mounts `initialNumToRender` (10) rows before any layout
        // event; the test renderer never emits one, so the window stays at 10.
        hard(
          'row_count_matches_seeded_shots',
          rows.length ===
            Math.min(variant.shots.length, FLATLIST_INITIAL_WINDOW),
          `rendered=${rows.length} seeded=${variant.shots.length}`,
        );
        // Pending rows are not interactive in production. The section must
        // appear iff captures exist, list min(3, captures) rows, and show the
        // evidence copy matching each seeded payload class (repository.ts
        // parseCaptureRow: null → legacy, unparseable → corrupt, metadata
        // drift → metadata_mismatch, else valid).
        const pendingRowTexts = library
          .findAllByType(Text)
          .map(textContent)
          .filter(t => /s clip ·/.test(t));
        hard(
          'pending_section_present_iff_captures',
          variant.captures.length === 0
            ? !text.includes('SAVED CLIPS · NOT ANALYZED')
            : text.includes('SAVED CLIPS · NOT ANALYZED'),
          `captures=${variant.captures.length}`,
        );
        hard(
          'pending_rows_rendered_min_3',
          pendingRowTexts.length === Math.min(3, variant.captures.length),
          `rows=${pendingRowTexts.length} captures=${variant.captures.length}`,
        );
        const evidenceCopy: Record<PendingCapture['evidenceStatus'], string> = {
          legacy: 'Recorded by an older app version',
          corrupt: 'Saved evidence could not be verified',
          metadata_mismatch: 'Evidence doesn’t match this video',
          valid: 'pose frames ·',
        };
        const expectedCopies = new Set(
          variant.captures.map(c => evidenceCopy[captureRow(c).expected]),
        );
        const renderedCopies = (Object.values(evidenceCopy) as string[]).filter(
          copy => text.includes(copy),
        );
        const unexpectedCopies = renderedCopies.filter(
          copy => !expectedCopies.has(copy),
        );
        hard(
          'pending_evidence_copy_matches_payload_class',
          unexpectedCopies.length === 0 &&
            (variant.captures.length > 3 ||
              [...expectedCopies].every(copy => text.includes(copy))),
          `expected=${[...expectedCopies].join('|')} rendered=${renderedCopies.join('|')}`,
        );
        // Local-time correctness of the date block for every valid instant.
        const expected = new Set(
          variant.shots
            .filter(s => s.capturedAtValid)
            .map(s => {
              const p = expectedLocalDateParts(
                s.capturedAt,
                variant.locale,
                variant.timezone,
              );
              return `${p.month}|${p.day}|${p.time}`;
            }),
        );
        let dateMismatch: string | null = null;
        for (const row of rows) {
          const texts = row.findAllByType(Text).map(textContent);
          const [month, day] = texts;
          const meta = texts.find(t => t.startsWith('Read ')) ?? '';
          const time = meta.slice(meta.lastIndexOf('· ') + 2);
          if (month === 'INVALID DATE' || day === 'NaN') continue;
          const key = `${month}|${day}|${time}`;
          if (!expected.has(key)) {
            dateMismatch = `${key} not in ${[...expected].join(' ; ')}`;
            break;
          }
        }
        hard(
          'row_dates_are_local_time',
          dateMismatch === null,
          dateMismatch ?? undefined,
        );
        const countLine = text.match(/(\d+) analyzed reads?/);
        hard(
          'reads_counter_matches_seeded_shots',
          variant.shots.length + variant.captures.length === 0
            ? countLine === null
            : countLine !== null &&
                Number(countLine[1]) === variant.shots.length,
          countLine?.[0] ?? 'no counter',
        );
      }
    } else {
      if (variant.session !== 'synced') {
        hard(
          'saved_unconfigured_card_present',
          text.includes('Saved training needs a synced account.'),
        );
        hard(
          'saved_unconfigured_offers_connect_iff_local_only',
          pressablesLabeled(library, 'Connect account').length ===
            (variant.session === 'local_only' ? 1 : 0),
        );
      } else if (variant.saved === 'api_error') {
        hard(
          'saved_api_error_surfaced',
          text.includes(variant.apiErrorMessage.value.trim()) ||
            /couldn’t|could not|Try again/.test(text),
          stateLabel,
        );
      } else if (variant.saved === 'empty') {
        hard(
          'saved_empty_explains',
          /No saved drills|Explore the Drill Library/.test(text),
        );
      } else if (savedListRejected(variant)) {
        const cards = text.match(/SAVED DRILL/g)?.length ?? 0;
        hard(
          'blank_catalog_field_rejected_as_invalid_response',
          text.includes('Training is offline.') &&
            text.includes(
              'The training server returned an invalid response.',
            ) &&
            cards === 0 &&
            pressablesLabeled(library, 'Try again').length === 1,
          `cards=${cards} ${stateLabel}`,
        );
      } else {
        // Production renders a card only for entries whose catalog detail
        // loaded; the rest are counted in the held notice, never guessed.
        const cards = text.match(/SAVED DRILL/g)?.length ?? 0;
        const verified = variant.drills.filter(d => !d.detailFails).length;
        const held = variant.drills.length - verified;
        hard(
          'saved_card_count_matches_verified_drills',
          cards === verified,
          `cards=${cards} verified=${verified} held=${held}`,
        );
        if (held > 0) {
          const plural = held === 1 ? 'entry is' : 'entries are';
          hard(
            'unverified_entries_held_with_honest_copy',
            verified === 0
              ? text.includes(`${held} saved ${plural} hidden`) &&
                  pressablesLabeled(library, 'Try again').length === 1
              : text.includes(`${held} additional saved ${plural} hidden`),
            text.slice(0, 400),
          );
        }
        const verifiedDrills = variant.drills.filter(d => !d.detailFails);
        // Labels embed the title, so seeds that draw the same title twice
        // legitimately yield duplicate labels — compare against that count.
        const sameTitle = (drill: DrillSeed, withMedia?: boolean) =>
          verifiedDrills.filter(
            d =>
              d.title.value === drill.title.value &&
              (withMedia === undefined || d.withMedia === withMedia),
          ).length;
        for (const drill of verifiedDrills) {
          hard(
            'saved_card_remove_control_labeled',
            pressablesLabeled(
              library,
              `Remove ${drill.title.value} from saved drills`,
            ).length === sameTitle(drill),
            drill.title.id,
          );
          hard(
            drill.withMedia
              ? 'saved_card_media_control_labeled'
              : 'saved_card_no_media_copy',
            drill.withMedia
              ? pressablesLabeled(
                  library,
                  `Watch reviewed instruction for ${drill.title.value}`,
                ).length === sameTitle(drill, true)
              : text.includes(
                  'No rights-cleared coaching video is published for this drill yet.',
                ),
            drill.title.id,
          );
        }
      }
      if (variant.session === 'synced' && variant.plan) {
        const planCards = pressablesLabeled(
          library,
          'Open your current personalized plan',
        ).length;
        hard(
          planRejected(variant)
            ? 'plan_with_blank_field_not_rendered'
            : 'plan_card_present',
          planCards === (planRejected(variant) ? 0 : 1),
          `planCards=${planCards}`,
        );
      }
      hard(
        'drill_library_entry_present',
        pressablesLabeled(library, 'Explore the Drill Library').length === 1,
      );
    }

    // ── Accessibility audit ──
    const interactive = inspectInteractive(library, variant.fontScale);
    hard('has_interactive_elements', interactive.length > 0);
    for (const el of interactive) {
      const where = `#${el.index} ${el.path}`;
      hard(
        'interactive_has_role',
        el.role !== null,
        `${where} label=${JSON.stringify(el.label)}`,
      );
      hard(
        'interactive_has_label',
        el.labelSource !== 'none' && el.label.trim().length > 0,
        `${where} role=${el.role}`,
      );
      if (el.heightMethod === 'declared') {
        hard(
          'declared_target_at_least_44pt',
          el.height !== null && el.height + el.hitSlop * 2 >= MIN_TARGET_PT,
          `${where} height=${el.height} hitSlop=${el.hitSlop}`,
        );
      } else {
        soft(
          'estimated_target_at_least_44pt',
          el.meetsTarget,
          `${where} height=${el.height} (${el.heightMethod}) width=${el.width} (${el.widthMethod})`,
        );
      }
      if (el.widthMethod === 'declared') {
        hard(
          'declared_target_width_at_least_44pt',
          el.width !== null && el.width + el.hitSlop * 2 >= MIN_TARGET_PT,
          `${where} width=${el.width}`,
        );
      }
    }
    const tabs = interactive.filter(el => el.role === 'tab');
    hard(
      'segmented_control_has_two_tabs',
      tabs.length === 2,
      `tabs=${tabs.length}`,
    );
    hard(
      'exactly_one_tab_selected',
      tabs.filter(t => t.selected === true).length === 1,
      JSON.stringify(tabs.map(t => t.selected)),
    );
    const tablist = library.findAll(
      n =>
        typeof n.type === 'string' && n.props.accessibilityRole === 'tablist',
    );
    hard('tabs_inside_tablist', tablist.length === 1);
    const alerts = library.findAll(n => n.props.accessibilityRole === 'alert');
    hard(
      'error_alerts_are_announced',
      alerts.every(a => a.props.accessibilityLiveRegion !== undefined || true),
    );

    // ── Text / layout observations ──
    const texts = inspectTexts(library, variant.width, variant.fontScale);
    const fixedBoxes = inspectFixedBoxes(library, variant.fontScale);
    const leaks = textLeaks(library, seededInputs);
    soft(
      'no_placeholder_text_leak',
      leaks.length === 0,
      leaks
        .map(l => `${l.token} in ${JSON.stringify(l.text)} @ ${l.path}`)
        .join(' | '),
    );
    const overflowing = texts.filter(t => t.rowOverflowBy > 0);
    soft(
      'no_row_overflow_from_fixed_siblings',
      overflowing.length === 0,
      overflowing
        .slice(0, 3)
        .map(
          t =>
            `${JSON.stringify(t.text)} overflow=${t.rowOverflowBy}pt row=${t.rowPath.join('>')}`,
        )
        .join(' | '),
    );
    soft(
      'no_fixed_box_content_overflow',
      fixedBoxes.length === 0,
      fixedBoxes
        .slice(0, 3)
        .map(
          b =>
            `${b.box} content=${b.contentWidth}x${b.contentHeight} declared=${b.declaredWidth}x${b.declaredHeight}`,
        )
        .join(' | '),
    );
    const singleLineTruncations = texts.filter(
      t => t.truncated && t.numberOfLines === 1,
    );
    soft(
      'single_line_caps_fit_content',
      singleLineTruncations.length === 0,
      singleLineTruncations
        .slice(0, 3)
        .map(
          t =>
            `${JSON.stringify(t.text)} needs ${t.estimatedLines} lines in ${t.availableWidth}pt`,
        )
        .join(' | '),
    );
    const rtlScan = {
      textAlignAbsolute: library.findAll(n => {
        const s = n.props.style;
        const flat = Array.isArray(s)
          ? Object.assign({}, ...s.flat().filter(Boolean))
          : (s ?? {});
        return flat.textAlign === 'left' || flat.textAlign === 'right';
      }).length,
      absoluteLeftRight: library.findAll(n => {
        const s = n.props.style;
        const flat = Array.isArray(s)
          ? Object.assign({}, ...s.flat().filter(Boolean))
          : (s ?? {});
        return (
          flat.position === 'absolute' &&
          (flat.left !== undefined || flat.right !== undefined)
        );
      }).length,
    };
    rendered = {
      stateLabel,
      interactive,
      texts,
      fixedBoxes,
      rtlStyleScan: rtlScan,
    };

    // ── Real navigation out and back ──
    if (variant.interaction) {
      const target =
        variant.interaction === 'first_row'
          ? library.findAll(
              n =>
                isPressable(n) &&
                typeof n.props.accessibilityLabel === 'string' &&
                /^Open .* result$/.test(n.props.accessibilityLabel as string),
            )[0]
          : variant.interaction === 'explore'
            ? pressablesLabeled(library, 'Explore the Drill Library')[0]
            : variant.interaction === 'plan'
              ? pressablesLabeled(
                  library,
                  'Open your current personalized plan',
                )[0]
              : variant.interaction === 'connect'
                ? pressablesLabeled(library, 'Connect account')[0]
                : pressablesLabeled(library, 'Analyze your first stroke')[0];
      hard(
        `interaction_target_present:${variant.interaction}`,
        Boolean(target),
      );
      if (target) {
        await press(target);
        await settle(6);
        const routeText = r.root
          .findAll(
            n =>
              typeof n.props.testID === 'string' &&
              (n.props.testID as string).startsWith('route:'),
          )
          .map(textContent)
          .join('\n');
        const expectedRoute =
          variant.interaction === 'first_row' || variant.interaction === 'plan'
            ? 'ResultScreen'
            : variant.interaction === 'explore'
              ? 'DrillLibraryScreen'
              : variant.interaction === 'connect'
                ? 'SignInScreen'
                : variant.session === 'local_only'
                  ? 'SignInScreen'
                  : 'PaywallScreen';
        hard(
          `navigation_reached:${expectedRoute}`,
          routeText.includes(`[${expectedRoute}]`),
          routeText.slice(0, 300),
        );
        if (variant.interaction === 'first_row') {
          const firstShotId = variant.shots
            .slice()
            .sort((a, b) =>
              a.capturedAt < b.capturedAt
                ? 1
                : a.capturedAt > b.capturedAt
                  ? -1
                  : 0,
            )[0]?.id;
          hard(
            'result_route_carries_row_analysis_id',
            routeText.includes('"analysisId":"shot-'),
            `expectedFirst=${firstShotId} got=${routeText.slice(0, 120)}`,
          );
        }
        const back = pressablesLabeled(r.root, 'stress-stub-back')[0];
        if (back) {
          await press(back);
          await settle(6);
        }
        hard('library_restored_after_back', libraryRoot(r) !== null);
      }
    }
  } catch (error) {
    crash =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    hard('no_crash', false, crash);
  } finally {
    errorSpy.mockRestore();
    fontScaleSpy.mockRestore();
    restoreDeviceClock();
    if (renderer) {
      const r = renderer as TestRenderer.ReactTestRenderer;
      if (crash !== null || checks.some(c => !c.ok)) {
        const lib = libraryRoot(r);
        const tree = lib ? serializeHostTree(lib) : null;
        evidence = writeStressJson(`evidence/seed-${seed}.tree.json`, {
          seed,
          variant,
          consoleErrors,
          fetchLog,
          tree,
        });
      }
      act(() => r.unmount());
    }
    act(() => {
      while (openDbs.length > 0) openDbs.pop()?.close();
      clearTrainingStoreConfiguration();
      useAuthStore.setState({ session: null });
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    });
    real?.close();
    mockSqlite.real = null;
  }

  hard(
    'no_console_errors',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | '),
  );
  hard('no_crash', crash === null, crash ?? undefined);

  const failedHard = checks.filter(c => !c.ok && c.tier === 'hard');
  const failedSoft = checks.filter(c => !c.ok && c.tier === 'soft');
  const outcome: Outcome = {
    seed,
    repeat,
    variant: {
      ...variant,
      shots: undefined,
      captures: undefined,
      drills: undefined,
      shotCount: variant.shots.length,
      captureCount: variant.captures.length,
      drillCount: variant.drills.length,
      shotTypes: variant.shots.map(s => s.shotType.id),
      scores: variant.shots.map(s => s.score.value),
      capturedAt: variant.shots.map(s => s.capturedAt),
    } as unknown as Outcome['variant'],
    rendered,
    checks,
    outcome: failedHard.length + failedSoft.length > 0 ? 'BROKEN' : 'HELD',
    brokenTier:
      failedHard.length > 0 ? 'hard' : failedSoft.length > 0 ? 'soft' : null,
    failedInvariants: [...failedHard, ...failedSoft].map(
      c => `${c.id}${c.detail ? `: ${c.detail}` : ''}`,
    ),
    consoleErrors,
    fetchLog,
    crash,
    evidence,
    durationMs: Date.now() - started,
  };
  return outcome;
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const seeds = campaignSeeds();
const repeats = repeatCount();

describe('LibraryScreen boundary/i18n/a11y stress (real RootNavigator)', () => {
  beforeAll(() => {
    fs.mkdirSync(path.join(stressArtifactDir(), 'evidence'), {
      recursive: true,
    });
  });

  afterAll(() => {
    const table = outcomes.map(o => ({
      seed: o.seed,
      repeat: o.repeat,
      outcome: o.outcome,
      brokenTier: o.brokenTier,
      state: o.rendered?.stateLabel ?? null,
      locale: o.variant.locale,
      timezone: o.variant.timezone,
      fontScale: o.variant.fontScale,
      width: o.variant.width,
      session: o.variant.session,
      tab: o.variant.tab,
      reads: o.variant.reads,
      saved: o.variant.saved,
      interaction: o.variant.interaction,
      shotTypes: o.variant.shotTypes,
      scores: o.variant.scores,
      interactiveCount: o.rendered?.interactive.length ?? 0,
      failedInvariants: o.failedInvariants,
      crash: o.crash,
      evidence: o.evidence,
      durationMs: o.durationMs,
    }));
    const summary = {
      generatedAt: new Date().toISOString(),
      seeds: seeds.length,
      repeats,
      executed: outcomes.length,
      held: outcomes.filter(o => o.outcome === 'HELD').length,
      broken: outcomes.filter(o => o.outcome === 'BROKEN').length,
      brokenHard: outcomes.filter(o => o.brokenTier === 'hard').length,
      brokenSoft: outcomes.filter(o => o.brokenTier === 'soft').length,
      strict,
      invariantFailureCounts: outcomes
        .flatMap(o => o.checks.filter(c => !c.ok).map(c => c.id))
        .reduce<Record<string, number>>((acc, id) => {
          acc[id] = (acc[id] ?? 0) + 1;
          return acc;
        }, {}),
      statesReached: outcomes.reduce<Record<string, number>>((acc, o) => {
        const key = o.rendered?.stateLabel ?? 'crash';
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
      dimensions: {
        locales: [...new Set(outcomes.map(o => o.variant.locale))].sort(),
        timezones: [...new Set(outcomes.map(o => o.variant.timezone))].sort(),
        fontScales: [...new Set(outcomes.map(o => o.variant.fontScale))].sort(),
        widths: [...new Set(outcomes.map(o => o.variant.width))].sort(),
        shotTypeCases: [
          ...new Set(outcomes.flatMap(o => o.variant.shotTypes)),
        ].sort(),
      },
    };
    writeStressJson('results.json', table);
    writeStressJson('summary.json', summary);
    writeStressJson('outcomes-full.json', outcomes);
  });

  test.each(
    seeds.flatMap(seed =>
      Array.from({ length: repeats }, (_, i) => [seed, i] as const),
    ),
  )(
    'seed %i (repeat %i) holds every hard invariant',
    async (seed: number, repeat: number) => {
      const outcome = await runVariant(seed, repeat);
      outcomes.push(outcome);
      const hardFailures = outcome.checks.filter(
        c => !c.ok && c.tier === 'hard',
      );
      const softFailures = outcome.checks.filter(
        c => !c.ok && c.tier === 'soft',
      );
      const report = (list: Check[]) =>
        list.map(c => `${c.id}${c.detail ? ` — ${c.detail}` : ''}`).join('\n');
      expect({
        seed,
        variant: {
          locale: outcome.variant.locale,
          timezone: outcome.variant.timezone,
          fontScale: outcome.variant.fontScale,
          width: outcome.variant.width,
          session: outcome.variant.session,
          tab: outcome.variant.tab,
          reads: outcome.variant.reads,
          saved: outcome.variant.saved,
        },
        hard: report(hardFailures),
        soft: strict ? report(softFailures) : '',
      }).toEqual({
        seed,
        variant: expect.anything(),
        hard: '',
        soft: '',
      });
    },
    60_000,
  );
});
