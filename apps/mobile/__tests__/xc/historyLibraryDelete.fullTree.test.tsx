/**
 * XC journey-history-library-delete — FULL-TREE renders over a REAL SQLite
 * database.
 *
 * Every scenario mounts the real screen (`LibraryScreen`, `ResultScreen`,
 * `ResultDetailsScreen`, `FormReviewScreen`) with `react-test-renderer` and
 * lets it read through the PRODUCTION `getDb()` → `repository.ts` →
 * `strokeResultData.ts` stack into a real SQLite file (Node's built-in
 * `node:sqlite`, see `test/xcHistoryLibraryDelete/realSqlite.ts`). Nothing in
 * the data layer is stubbed — only the native/network edges are: navigation,
 * safe-area, SVG, the pose-sidecar FILE read, the auth/training/consistency
 * stores and the network-backed feedback prompt.
 *
 * Journey: Library load → empty state → rows → reopen a result → the only
 * deletion path the product has (`purgeOwnerData`) → stale entry after the
 * server refused the shot → missing result → missing media.
 *
 * Run: npx jest __tests__/xc/historyLibraryDelete.fullTree.test.tsx  (Node >= 22.5)
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';

jest.mock('@op-engineering/op-sqlite', () => {
  const support = jest.requireActual(
    '../../test/xcHistoryLibraryDelete/realSqlite',
  ) as typeof import('../../test/xcHistoryLibraryDelete/realSqlite');
  return {
    open: (options: { name: string }) => support.openRealSqlite(options),
  };
});

jest.mock('react-native-safe-area-context', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: RN.View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

jest.mock('react-native-svg', () => {
  const ReactModule = require('react') as typeof import('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
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

const mockNavigation = {
  navigate: jest.fn(),
  goBack: jest.fn(),
  replace: jest.fn(),
  popTo: jest.fn(),
  popToTop: jest.fn(),
};
let mockRouteParams: Record<string, unknown> = {};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: mockRouteParams }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = require('react') as typeof import('react');
    ReactModule.useEffect(() => callback(), [callback]);
  },
}));

jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: (
    selector: (state: { session: { localOnly: boolean } | null }) => unknown,
  ) => selector({ session: { localOnly: false } }),
}));

const mockTrainingState = {
  savedStatus: 'ready',
  savedDrills: [] as unknown[],
  savedError: null,
  planStatus: 'ready',
  currentPlan: null,
  planError: null,
  mutation: 'idle',
  mutationError: null,
  drillDetails: {},
  loadSavedDrills: jest.fn(async () => true),
  loadCurrentPlan: jest.fn(async () => true),
  setDrillSaved: jest.fn(async () => {}),
  createPlan: jest.fn(async () => {}),
  reassessCurrentPlan: jest.fn(async () => {}),
  completePlanItem: jest.fn(async () => {}),
  clearMutationError: jest.fn(),
};
jest.mock('../../src/training/store', () => ({
  useTrainingStore: (selector: (s: typeof mockTrainingState) => unknown) =>
    selector(mockTrainingState),
}));

jest.mock('../../src/consistency/store', () => {
  const state = {
    refresh: jest.fn(async () => {}),
    daySecured: null,
    consumeDaySecured: jest.fn(() => null),
  };
  return {
    useConsistencyStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../../src/consistency/DaySecuredBanner', () => ({
  DaySecuredBanner: () => null,
}));
jest.mock('../../src/components/AnalysisFeedbackPrompt', () => ({
  AnalysisFeedbackPrompt: () => null,
}));
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
  reportApiUnauthorized: () => {},
}));

/** The pose sidecar is a FILE on the device; its read is the one media edge
 * this suite drives (present / missing) — everything else is the real DB. */
const mockLoadSequence = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../../src/review/poseSidecar', () => ({
  loadReviewPoseSequence: (...args: unknown[]) => mockLoadSequence(...args),
}));

import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { getDb } from '../../src/data/db';
import {
  markCaptureAnalyzed,
  purgeOwnerData,
  saveAnalysis,
  saveAnalysisRecord,
  savePendingCapture,
} from '../../src/data/repository';
import { OUTBOX_MAX_ATTEMPTS, drainOutbox } from '../../src/data/sync';
import type { SyncTransport } from '../../src/data/sync';
import { ClipPlayer } from '../../src/components/ClipPlayer';
import { PressableScale } from '../../src/design/components';
import { LibraryScreen } from '../../src/screens/LibraryScreen';
import { ResultScreen } from '../../src/screens/ResultScreen';
import { ResultDetailsScreen } from '../../src/screens/ResultDetailsScreen';
import { FormReviewScreen } from '../../src/screens/FormReviewScreen';
import type {
  ReviewPoseFrame,
  ReviewPoseSequence,
} from '../../src/review/formReviewModel';
import {
  auditGhosts,
  currentDriver,
  heapUsedMb,
  mulberry32,
  seededUuid,
  snapshotOwner,
  sqliteEngine,
  writeArtifact,
} from '../../test/xcHistoryLibraryDelete/realSqlite';
import {
  OWNER_A,
  OWNER_B,
  analysisRecord,
  capturedClip,
  randomShotAnalysis,
  shotAnalysis,
} from '../../test/xcHistoryLibraryDelete/fixtures';

const PERMIT = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// ─── Fixtures: a fully scored analysis so the score / replay pages render ───

function phase(key: PhaseKey, startMs: number, endMs: number): PhaseSpan {
  return {
    key,
    startMs,
    representativeMs: startMs + (endMs - startMs) / 2,
    endMs,
    confidence: 0.8,
  };
}

function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
  };
}

function richScoredAnalysis(id: string): ShotAnalysis {
  return shotAnalysis({
    id,
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
    phases: [
      phase('ready', 0, 900),
      phase('prepare', 900, 1500),
      phase('accelerate', 1500, 1900),
      phase('contact', 1880, 1920),
      phase('follow_through', 1920, 2400),
      phase('recover', 2400, 3200),
    ],
    checkpoints: [
      checkpoint('ready_position', 85, 'green', 'none'),
      checkpoint('athletic_base', 72, 'yellow', 'narrow'),
      checkpoint('preparation', 88, 'green', 'none'),
      checkpoint('paddle_set', 90, 'green', 'none'),
      checkpoint('swing_length', null, 'unscored', 'none'),
      checkpoint('sequencing', 82, 'green', 'none'),
      checkpoint('paddle_path', 61, 'red', 'low'),
      checkpoint('contact_position', 48, 'red', 'late'),
      checkpoint('follow_through', 80, 'green', 'short'),
      checkpoint('recovery', 92, 'green', 'none'),
    ],
    overallScore: 7.1,
    analysisConfidence: 0.84,
    priorityFix: {
      checkpoint: 'contact_position',
      reasonKey: 'lowest_score',
      severity: 0.52,
      confidence: 0.8,
    },
  });
}

const SIDECAR = {
  schemaVersion: 1 as const,
  format: 'pickle.pose-sequence.v1' as const,
  uri: 'file:///captures/clip.pose.json',
  frameCount: 81,
  sha256: 'ab'.repeat(32),
  coordinateSystem: 'normalized_image_top_left' as const,
  poseModelVersion: 'apple-vision-bodypose-1',
};

function fullBodySequence(): ReviewPoseSequence {
  const frames: ReviewPoseFrame[] = [];
  for (let t = 0; t <= 3200; t += 40) {
    const sweep = t / 3200;
    const joints: Record<string, { x: number; y: number }> = {
      head: { x: 0.5, y: 0.18 },
      left_shoulder: { x: 0.45, y: 0.3 },
      right_shoulder: { x: 0.55, y: 0.3 },
      left_elbow: { x: 0.4, y: 0.42 },
      right_elbow: { x: 0.62, y: 0.42 },
      left_wrist: { x: 0.38, y: 0.52 },
      right_wrist: { x: 0.3 + 0.4 * sweep, y: 0.5 },
      left_hip: { x: 0.46, y: 0.55 },
      right_hip: { x: 0.54, y: 0.55 },
      left_knee: { x: 0.46, y: 0.72 },
      right_knee: { x: 0.54, y: 0.72 },
      left_ankle: { x: 0.45, y: 0.9 },
      right_ankle: { x: 0.55, y: 0.9 },
    };
    frames.push({
      timestampMs: t,
      confidence: 0.9,
      landmarks: Object.entries(joints).map(([name, point]) => ({
        name,
        x: point.x,
        y: point.y,
        visibility: 0.95,
      })),
    });
  }
  return { frames, video: { width: 1080, height: 1920, fps: 30 } };
}

/** Writes the same durable trio `runCaptureAnalysis.ts` writes for a scored
 * run: pending capture (with clip payload + sidecar ref) → immutable record
 * → analyzed → local_shot + outbox row. */
async function seedScoredRun(
  analysis: ShotAnalysis,
  options: { sidecar: boolean; permit?: string } = { sidecar: true },
): Promise<{ captureId: string }> {
  const db = getDb();
  const captureId = seededUuid(
    mulberry32(
      [...analysis.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7),
    ),
  );
  const base = capturedClip({
    uri: `file:///captures/${captureId}.mov`,
    capturedAtIso: analysis.capturedAtIso,
    durationMs: 3400,
    width: 1080,
    height: 1920,
  });
  const clip = options.sidecar ? { ...base, poseSequence: SIDECAR } : base;
  await savePendingCapture(db, captureId, analysis.shotType, clip);
  await saveAnalysisRecord(
    db,
    analysisRecord(analysis.id, captureId, analysis),
  );
  await markCaptureAnalyzed(db, captureId);
  await saveAnalysis(db, analysis, options.permit ?? PERMIT);
  return { captureId };
}

function transport(
  mode: { accept: true } | { rejectCode: string },
): SyncTransport & { batches: unknown[][] } {
  const batches: unknown[][] = [];
  return {
    batches,
    async syncShots(shots) {
      batches.push(shots);
      const ids = shots.map(shot => String((shot as { id: string }).id));
      return 'accept' in mode
        ? { acceptedIds: ids, rejected: [] }
        : {
            acceptedIds: [],
            rejected: ids.map(id => ({
              id,
              code: mode.rejectCode,
              message: 'server refused',
            })),
          };
    },
    async createSession() {},
    async finalizeSession() {},
  };
}

// ─── Harness ────────────────────────────────────────────────────────────────

declare const process: { version: string };
declare const __filename: string;

const mounted: ReactTestRenderer[] = [];
const report: Record<string, unknown> = {
  file: __filename,
  node: process.version,
  startedAt: new Date().toISOString(),
  heapStartMb: heapUsedMb(),
  scenarios: {} as Record<string, unknown>,
};
const scenarios = report['scenarios'] as Record<string, unknown>;

async function settle(turns = 6) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
  }
}

async function mount(element: React.ReactElement, turns = 6) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  await settle(turns);
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

/** Every composite node the user can press, with its label/testID. */
function pressableLedger(renderer: ReactTestRenderer) {
  return renderer.root
    .findAll(
      n => typeof n.type !== 'string' && typeof n.props.onPress === 'function',
    )
    .map(n => ({
      label: String(
        n.props.accessibilityLabel ?? n.props.label ?? n.props.testID ?? '',
      ),
      role: String(n.props.accessibilityRole ?? ''),
    }));
}

function findPressable(renderer: ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      (n.props.accessibilityLabel === label || n.props.testID === label) &&
      typeof n.props.onPress === 'function',
  );
  return node ?? null;
}

async function press(renderer: ReactTestRenderer, label: string) {
  const node = findPressable(renderer, label);
  if (!node) throw new Error(`No pressable labeled ${label}`);
  await act(async () => {
    node.props.onPress();
  });
  await settle();
}

const DELETE_WORDS = /\b(delete|remove|trash|erase|clear)\b/i;

async function unmountAll() {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
}

beforeEach(() => {
  mockNavigation.navigate.mockClear();
  mockNavigation.goBack.mockClear();
  mockLoadSequence.mockReset();
  mockLoadSequence.mockResolvedValue(fullBodySequence());
  mockRouteParams = {};
  setActiveDataOwner(OWNER_A);
});

afterEach(async () => {
  await unmountAll();
  try {
    getDb().close();
  } catch {
    // Already closed by the scenario.
  }
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterAll(() => {
  report['finishedAt'] = new Date().toISOString();
  report['heapEndMb'] = heapUsedMb();
  report['sqliteEngine'] = sqliteEngine();
  report['artifact'] = writeArtifact('full-tree-render.json', report);
});

// ─── Scenarios ──────────────────────────────────────────────────────────────

describe('XC journey-history-library-delete · full-tree over real SQLite', () => {
  it('R1 Library: loading state → empty state on a fresh owner; the empty CTA opens Analyze; there is NO delete affordance anywhere on the screen', async () => {
    getDb();
    // Synchronous act: effects run, but the SQLite promise has not settled.
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<LibraryScreen />);
    });
    mounted.push(renderer);
    const loadingText = allText(renderer);
    expect(loadingText).toContain('Opening your library…');
    await settle();

    const text = allText(renderer);
    expect(text).toContain('Your measured reads, in one place.');
    expect(text).not.toContain('analyzed read');
    const ledger = pressableLedger(renderer);
    expect(ledger.filter(p => DELETE_WORDS.test(p.label))).toEqual([]);
    await press(renderer, 'Analyze your first stroke');
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Analyze');
    scenarios['R1_library_loading_then_empty'] = {
      loadingText,
      emptyText: text,
      pressables: ledger,
      sql: currentDriver().calls.map(c => c.sql),
    };
  });

  it('R2 Library: N seeded reads render in capture-time order, the row opens Result {analysisId}, and reopening that id mounts the real SCORE page from SQLite', async () => {
    const rand = mulberry32(2);
    const db = getDb();
    const saved: ShotAnalysis[] = [];
    for (let i = 0; i < 7; i += 1) {
      const analysis = randomShotAnalysis(rand, i);
      await saveAnalysis(db, analysis, PERMIT);
      saved.push(analysis);
    }
    // Owner B's reads must never leak into A's Library.
    setActiveDataOwner(OWNER_B);
    await saveAnalysis(db, randomShotAnalysis(rand, 99), PERMIT);
    setActiveDataOwner(OWNER_A);

    const renderer = await mount(<LibraryScreen />);
    const text = allText(renderer);
    expect(text).toContain('7 analyzed reads');
    const rows = renderer.root.findAll(
      n =>
        n.type === PressableScale &&
        typeof n.props.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith('Open ') &&
        n.props.accessibilityLabel.endsWith(' result') &&
        typeof n.props.onPress === 'function',
    );
    expect(rows).toHaveLength(7);
    expect(
      pressableLedger(renderer).filter(p => DELETE_WORDS.test(p.label)),
    ).toEqual([]);

    const newest = [...saved].sort((a, b) =>
      b.capturedAtIso.localeCompare(a.capturedAtIso),
    )[0]!;
    await act(async () => {
      rows[0]!.props.onPress();
    });
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Result', {
      analysisId: newest.id,
    });

    // Reopen: the Result route reads the SAME database.
    const rich = richScoredAnalysis(seededUuid(rand));
    await seedScoredRun(rich);
    mockRouteParams = { analysisId: rich.id };
    const result = await mount(<ResultScreen />);
    const resultText = allText(result);
    expect(resultText).toContain('TECHNIQUE SCORE · FOREHAND DRIVE');
    expect(resultText).not.toContain('Result missing');
    expect(
      result.root.findAll(
        n => n.props.accessibilityLabel === 'Technique score 7.1 out of 10',
      ).length,
    ).toBeGreaterThan(0);
    scenarios['R2_library_rows_and_reopen'] = {
      libraryText: text,
      rowLabels: rows.map(r => r.props.accessibilityLabel),
      navigatedTo: mockNavigation.navigate.mock.calls,
      resultText,
      snapshot: snapshotOwner(currentDriver(), OWNER_A),
    };
  });

  it('R3 Library: when the local_shot read FAILS the screen renders the EMPTY state (no error surface) — a read failure is indistinguishable from "no reads"', async () => {
    const rand = mulberry32(3);
    const db = getDb();
    for (let i = 0; i < 3; i += 1) {
      await saveAnalysis(db, randomShotAnalysis(rand, i), PERMIT);
    }
    const driver = currentDriver();
    driver.failNext({
      match: 'FROM local_shot',
      message: 'SQLITE_IOERR: disk I/O error',
    });
    const renderer = await mount(<LibraryScreen />);
    const text = allText(renderer);
    expect(driver.count('local_shot', 'owner_key = ?', [OWNER_A])).toBe(3);
    expect(text).toContain('Your measured reads, in one place.');
    expect(text).not.toMatch(/could not|unavailable|try again|error/i);
    scenarios['R3_library_db_read_failure'] = {
      persistedShots: 3,
      renderedText: text,
      failedStatement: driver.calls.find(c => c.outcome === 'injected_failure'),
    };
  });

  it('R4 Missing result: an analysisId with no local_shot AND no record renders "Result missing" on Result and Result Details and "Review unavailable" on Form Review', async () => {
    getDb();
    mockRouteParams = { analysisId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
    const result = await mount(<ResultScreen />);
    expect(allText(result)).toContain('Result missing');
    const details = await mount(<ResultDetailsScreen />);
    expect(allText(details)).toContain('Result missing');
    const review = await mount(<FormReviewScreen />);
    expect(allText(review)).toContain('Review unavailable');
    scenarios['R4_missing_result'] = {
      resultText: allText(result),
      detailsText: allText(details),
      reviewText: allText(review),
    };
  });

  it('R5 Delete (local + synced): purgeOwnerData is the only deletion path; after it the Library is empty, a previously open Result is "Result missing", and SQLite/outbox/receipt/record hold zero ghost rows; owner B is untouched', async () => {
    const rand = mulberry32(5);
    const db = getDb();
    const driver = currentDriver();
    // Two synced, two still queued, one local-only record → the full mix.
    const synced = [randomShotAnalysis(rand, 0), randomShotAnalysis(rand, 1)];
    for (const a of synced) await saveAnalysis(db, a, PERMIT);
    expect(await drainOutbox(db, transport({ accept: true }))).toEqual({
      synced: 2,
      failed: 0,
      remaining: 0,
    });
    const queued = [randomShotAnalysis(rand, 2), randomShotAnalysis(rand, 3)];
    for (const a of queued) await saveAnalysis(db, a, PERMIT);
    const rich = richScoredAnalysis(seededUuid(rand));
    await seedScoredRun(rich);
    setActiveDataOwner(OWNER_B);
    await saveAnalysis(db, randomShotAnalysis(rand, 50), PERMIT);
    setActiveDataOwner(OWNER_A);

    const before = snapshotOwner(driver, OWNER_A);
    expect(before.counts.local_shot).toBe(5);
    expect(before.counts.outbox).toBe(3);
    expect(before.counts.sync_receipt).toBe(2);
    const libraryBefore = await mount(<LibraryScreen />);
    expect(allText(libraryBefore)).toContain('5 analyzed reads');
    mockRouteParams = { analysisId: rich.id };
    const resultBefore = await mount(<ResultScreen />);
    expect(allText(resultBefore)).toContain('TECHNIQUE SCORE');
    await unmountAll();

    await purgeOwnerData(db, OWNER_A);

    const after = snapshotOwner(driver, OWNER_A);
    const audit = auditGhosts(driver);
    const libraryAfter = await mount(<LibraryScreen />);
    const resultAfter = await mount(<ResultScreen />);
    const detailsAfter = await mount(<ResultDetailsScreen />);
    scenarios['R5_purge_is_the_delete'] = {
      before,
      after,
      audit,
      ownerB: snapshotOwner(driver, OWNER_B),
      libraryAfterText: allText(libraryAfter),
      resultAfterText: allText(resultAfter),
    };
    expect(after.counts).toEqual({
      local_shot: 0,
      local_session: 0,
      local_capture: 0,
      outbox: 0,
      sync_receipt: 0,
      local_analysis_record: 0,
    });
    expect(after.kvKeys).toEqual([]);
    expect(audit.total).toBe(0);
    expect(snapshotOwner(driver, OWNER_B).counts.local_shot).toBe(1);
    expect(snapshotOwner(driver, OWNER_B).counts.outbox).toBe(1);
    expect(allText(libraryAfter)).toContain(
      'Your measured reads, in one place.',
    );
    expect(allText(resultAfter)).toContain('Result missing');
    expect(allText(detailsAfter)).toContain('Result missing');
  });

  it('R6 Stale entry after server mismatch: a shot the server refused OUTBOX_MAX_ATTEMPTS times stays in the Library as an ordinary row (no sync marker) while Result Details states the refusal', async () => {
    const rand = mulberry32(6);
    const db = getDb();
    const stale = {
      ...randomShotAnalysis(rand, 0),
      resultKind: 'scored' as const,
      overallScore: 6.2,
    };
    await saveAnalysis(db, stale, PERMIT);
    const refusing = transport({ rejectCode: 'shot.id_conflict' });
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
      await drainOutbox(db, refusing);
    }
    const driver = currentDriver();
    const outboxRow = driver.dump('outbox')[0];
    expect(outboxRow?.['attempts']).toBe(OUTBOX_MAX_ATTEMPTS);
    // A ninth drain does not touch it (no attempt burned, no transport
    // call) but the row still counts as `remaining`: durable stale state.
    const batchesBefore = refusing.batches.length;
    expect(await drainOutbox(db, refusing)).toEqual({
      synced: 0,
      failed: 0,
      remaining: 1,
    });
    expect(refusing.batches.length).toBe(batchesBefore);
    expect(driver.dump('outbox')[0]?.['attempts']).toBe(OUTBOX_MAX_ATTEMPTS);

    const library = await mount(<LibraryScreen />);
    const libraryText = allText(library);
    expect(libraryText).toContain('1 analyzed read');
    expect(libraryText).not.toMatch(/refused|rejected|not accepted|sync/i);
    mockRouteParams = { analysisId: stale.id };
    const details = await mount(<ResultDetailsScreen />);
    const detailsText = allText(details);
    expect(detailsText).toContain('The server did not accept this read.');
    expect(detailsText).toContain(
      `Sync was refused ${OUTBOX_MAX_ATTEMPTS} times`,
    );
    expect(detailsText).toContain('shot.id_conflict');
    expect(detailsText).not.toContain('still in the secure outbox');
    scenarios['R6_stale_entry_after_server_mismatch'] = {
      outboxRow,
      libraryText,
      detailsText,
      snapshot: snapshotOwner(driver, OWNER_A),
    };
  });

  it('R7 Missing media on the Result replay page: sidecar file unreadable → video-only caption; the native player then reporting the clip file gone → "No clip file or recorded pose" caption; with the pose present → "clip file is gone … measured pose is shown"', async () => {
    const rand = mulberry32(7);
    const rich = richScoredAnalysis(seededUuid(rand));
    await seedScoredRun(rich);
    mockRouteParams = { analysisId: rich.id };

    // (a) sidecar FILE missing / hash mismatch → loader rejects → null pose.
    mockLoadSequence.mockRejectedValue(new Error('ENOENT: sidecar missing'));
    const noPose = await mount(<ResultScreen />);
    await press(noPose, 'result-guide-next');
    let text = allText(noPose);
    expect(text).toContain(
      'No verified pose sequence is stored for this clip, so the replay shows the video without an exoskeleton.',
    );
    const [player] = noPose.root.findAllByType(ClipPlayer);
    expect(player).toBeDefined();
    // (b) …and the stored clip cannot be opened either.
    await act(async () => {
      player!.props.onError?.(
        'The requested URL was not found on this server.',
      );
    });
    await settle();
    text = allText(noPose);
    expect(text).toContain(
      'No clip file or recorded pose is stored for this stroke on this device. The checkpoints below are still the ones the engine scored.',
    );
    expect(noPose.root.findAllByType(ClipPlayer)).toHaveLength(0);
    const noPoseText = text;
    await unmountAll();

    // (c) pose sidecar verified, clip file gone → the pose alone is shown.
    mockLoadSequence.mockResolvedValue(fullBodySequence());
    const poseOnly = await mount(<ResultScreen />);
    await press(poseOnly, 'result-guide-next');
    expect(allText(poseOnly)).not.toMatch(/clip file is gone|No clip file/);
    const [player2] = poseOnly.root.findAllByType(ClipPlayer);
    await act(async () => {
      player2!.props.onError?.('unreadable');
    });
    await settle();
    const poseOnlyText = allText(poseOnly);
    expect(poseOnlyText).toContain(
      'The clip file is gone from this device; the measured pose is shown instead.',
    );
    scenarios['R7_missing_media_result_replay'] = {
      noPoseText,
      poseOnlyText,
      evidenceSql: currentDriver()
        .calls.filter(c => /local_capture|local_analysis_record/.test(c.sql))
        .map(c => c.sql),
    };
  });

  it('R8 Missing media on Form Review: same captions through the dedicated FormReview route; a capture row without a sidecar ref never even asks for the file', async () => {
    const rand = mulberry32(8);
    const withSidecar = richScoredAnalysis(seededUuid(rand));
    await seedScoredRun(withSidecar);
    const withoutSidecar = richScoredAnalysis(seededUuid(rand));
    await seedScoredRun(withoutSidecar, { sidecar: false });

    mockLoadSequence.mockRejectedValue(new Error('sha256 mismatch'));
    mockRouteParams = { analysisId: withSidecar.id };
    const review = await mount(<FormReviewScreen />);
    expect(mockLoadSequence).toHaveBeenCalledWith(SIDECAR);
    expect(allText(review)).toContain(
      'No verified pose sequence is stored for this clip',
    );
    const [player] = review.root.findAllByType(ClipPlayer);
    await act(async () => {
      player!.props.onError?.('unreadable');
    });
    await settle();
    const afterError = allText(review);
    expect(afterError).toContain(
      'No clip file or recorded pose is stored for this stroke on this device.',
    );
    await unmountAll();

    mockLoadSequence.mockClear();
    mockRouteParams = { analysisId: withoutSidecar.id };
    const legacy = await mount(<FormReviewScreen />);
    expect(mockLoadSequence).not.toHaveBeenCalled();
    expect(allText(legacy)).toContain(
      'No verified pose sequence is stored for this clip',
    );
    scenarios['R8_missing_media_form_review'] = {
      afterError,
      legacyText: allText(legacy),
    };
  });

  it('R9 Library after the DB is closed and reopened mid-session shows the same rows (no in-memory ghost list): reads come from SQLite every focus', async () => {
    const rand = mulberry32(9);
    const db = getDb();
    for (let i = 0; i < 4; i += 1) {
      await saveAnalysis(db, randomShotAnalysis(rand, i), PERMIT);
    }
    const first = await mount(<LibraryScreen />);
    const firstText = allText(first);
    expect(firstText).toContain('4 analyzed reads');
    await unmountAll();
    // Delete two through the only path the product has, then re-focus.
    await purgeOwnerData(db, OWNER_A);
    for (let i = 0; i < 2; i += 1) {
      await saveAnalysis(db, randomShotAnalysis(rand, 10 + i), PERMIT);
    }
    const second = await mount(<LibraryScreen />);
    expect(allText(second)).toContain('2 analyzed reads');
    expect(auditGhosts(currentDriver()).total).toBe(0);
    scenarios['R9_refocus_reads_sqlite'] = {
      firstText,
      secondText: allText(second),
      audit: auditGhosts(currentDriver()),
    };
  });
});
