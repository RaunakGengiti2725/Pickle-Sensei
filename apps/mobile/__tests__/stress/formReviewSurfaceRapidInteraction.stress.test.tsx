/**
 * STRESS · rapid-interaction · FixList + FormReviewCard + RecommendedDrills
 * (+ FormReviewOverlay through the review modal).
 *
 * The five review surfaces are mounted inside a host that models the Result
 * screen: a navigation spy, a review modal opened by the card and by a fix
 * row, and a save toggle whose mutation is serialized exactly like the
 * training store (`if (mutation !== 'idle') return false`). A seeded
 * generator then hammers them — double/triple/5× taps on the card, on fix
 * rows, on "Open drill library", on Retry and on the save toggles; taps in
 * a single frame; back during an in-flight catalog fetch or save; spam
 * navigation; the analysis object re-rendered or swapped mid-flight;
 * out-of-order and post-unmount resolutions — and checks after EVERY action:
 *
 *   · one side effect per intent: k taps on a fix row = k navigations, each
 *     carrying that row's phase; a same-frame burst on the save toggle
 *     yields exactly ONE accepted mutation (the host serializes it) and the
 *     toggle is disabled while it is in flight
 *   · one request per intent: the catalog is fetched once per analysis id +
 *     family, once more per Retry, never once per re-render, and a stale
 *     resolution never lands
 *   · no duplicate modal: however fast the card and fix rows are tapped,
 *     at most one review modal is rendered, and it carries the last phase
 *   · no orphan loading state: a settled fetch always leaves ready/error,
 *     and a fetch that settles after unmount updates nothing
 *   · no console.error / console.warn (act() warnings, state-after-unmount)
 *     and no unhandled promise rejections
 *
 * Replay one seed:  STRESS_SEED=<n> npx jest --ci stress/formReviewSurface
 * Longer campaign:  STRESS_ITER=300 npx jest --ci stress/formReviewSurface
 * Re-run a seed:    STRESS_SEED=<n> STRESS_REPEAT=10 npx jest --ci stress/formReviewSurface
 * Results:          $STRESS_OUT (default <repo>/artifacts/stress/) as JSON,
 *                   one row per seed → outcome.
 */
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

const mockGetApiSession = jest.fn();
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
}

const mockCatalogCalls: {
  family: string;
  deferred: Deferred<CatalogDrill[]>;
}[] = [];
const mockDeferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const deferred: Deferred<T> = {
    promise,
    settled: false,
    resolve: value => {
      deferred.settled = true;
      resolve(value);
    },
    reject: reason => {
      deferred.settled = true;
      reject(reason);
    },
  };
  return deferred;
};
jest.mock('../../src/training/api', () => ({
  createTrainingApi: () => ({
    listCatalogDrills: ({ family }: { family: string }) => {
      const deferred = mockDeferred<CatalogDrill[]>();
      mockCatalogCalls.push({ family, deferred });
      return deferred.promise;
    },
  }),
}));

import fs from 'fs';
import path from 'path';
import React, { useCallback, useState } from 'react';
import { Modal, Text, View } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import type { CatalogDrill } from '../../src/training/api';
import { TrainingError } from '../../src/training/types';
import { FixList } from '../../src/review/FixList';
import { FormReviewCard } from '../../src/review/FormReviewCard';
import { FormReviewOverlay } from '../../src/review/FormReviewOverlay';
import {
  RECOMMENDED_DRILLS_EMPTY_COPY,
  RECOMMENDED_DRILLS_ERROR_COPY,
  RECOMMENDED_DRILLS_LOADING_COPY,
  RecommendedDrills,
} from '../../src/review/RecommendedDrills';
import {
  drillFocusFromAnalysis,
  pickRecommendedDrills,
} from '../../src/review/recommendedDrillsModel';
import {
  buildFormReviewScript,
  fixList,
} from '../../src/review/formReviewModel';

// ─── Campaign knobs ─────────────────────────────────────────────────────────

const ITERATIONS = Math.max(1, Number(process.env.STRESS_ITER ?? 40) || 40);
const ONLY_SEED =
  process.env.STRESS_SEED !== undefined
    ? Number(process.env.STRESS_SEED)
    : null;
const REPEAT = Math.max(1, Number(process.env.STRESS_REPEAT ?? 1) || 1);
const SEED_BASE = 0x5eed_1001;
const OUT_DIR =
  process.env.STRESS_OUT ??
  path.resolve(__dirname, '..', '..', '..', '..', 'artifacts', 'stress');

const catalogCalls = mockCatalogCalls;
const makeDeferred = mockDeferred;

/** Enough microtask turns for the component's `await` chain to settle. */
async function flushMicrotasks() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

// ─── Seeded RNG (mulberry32) ────────────────────────────────────────────────

function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    chance: (p: number) => next() < p,
    pick: <T,>(items: readonly T[]): T => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('pick from empty list');
      return item;
    },
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
  overrides: Partial<CheckpointScore> = {},
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
    ...overrides,
  };
}

function analysisFixture(
  id: string,
  overrides: Partial<ShotAnalysis> = {},
): ShotAnalysis {
  return {
    id,
    sessionId: 'set-1',
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
    phases: [],
    measurements: [],
    checkpoints: [
      checkpoint('ready_position', 85, 'green', 'none'),
      checkpoint('athletic_base', 72, 'yellow', 'narrow'),
      checkpoint('paddle_path', 61, 'red', 'low'),
      checkpoint('contact_position', 48, 'red', 'late'),
      checkpoint('follow_through', 80, 'green', 'short'),
      checkpoint('recovery', 92, 'green', 'none'),
    ],
    overallScore: 6.8,
    analysisConfidence: 0.84,
    resultKind: 'scored',
    guidance: null,
    priorityFix: {
      checkpoint: 'contact_position',
      reasonKey: 'lowest_score',
      severity: 0.52,
      confidence: 0.8,
    },
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-geometry-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
    ...overrides,
  };
}

function drill(slug: string, families: string[]): CatalogDrill {
  return {
    id: `id-${slug}`,
    slug,
    title: slug
      .split('-')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' '),
    description: `Description for ${slug}.`,
    coachName: 'Pickle Sensei Training Library',
    equipment: ['paddle', 'balls'],
    difficultyMin: null,
    difficultyMax: null,
    families,
    validationState: 'UNVALIDATED',
    saved: false,
  };
}

const CATALOG: CatalogDrill[] = [
  drill('shadow-swing-ladder', ['global']),
  drill('drive-and-recover', ['drive']),
  drill('dink-target-ladder', ['dink']),
  drill('crosscourt-drive-rally', ['drive', 'volley']),
  drill('footwork-split-step', ['global']),
];

const SESSION = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'access-token',
  canonicalAppUserId: '00000000-0000-4000-8000-000000000001',
  provider: 'apple' as const,
};

const OVERLAY_RECT = { x: 0, y: 0, width: 360, height: 420 };
const OVERLAY_FRAME = {
  timestampMs: 1900,
  confidence: 0.9,
  landmarks: [
    ['head', 0.5, 0.18],
    ['left_shoulder', 0.45, 0.3],
    ['right_shoulder', 0.55, 0.3],
    ['left_elbow', 0.4, 0.42],
    ['right_elbow', 0.62, 0.42],
    ['left_wrist', 0.38, 0.52],
    ['right_wrist', 0.66, 0.5],
    ['left_hip', 0.46, 0.55],
    ['right_hip', 0.54, 0.55],
    ['left_knee', 0.46, 0.72],
    ['right_knee', 0.54, 0.72],
    ['left_ankle', 0.45, 0.9],
    ['right_ankle', 0.55, 0.9],
  ].map(([name, x, y]) => ({
    name: name as string,
    x: x as number,
    y: y as number,
    visibility: 0.95,
  })),
};

// ─── Host: the Result surface, with the store's serialization ───────────────

interface HostEvents {
  navigations: { to: 'FormReview' | 'DrillLibrary'; phase?: PhaseKey }[];
  saveIntents: { slug: string; saved: boolean; accepted: boolean }[];
}

interface SaveMutation {
  slug: string;
  saved: boolean;
  deferred: Deferred<boolean>;
}

interface HostHandle {
  events: HostEvents;
  saves: SaveMutation[];
  closeModal: () => void;
}

function ResultSurface(props: {
  analysis: ShotAnalysis;
  handle: HostHandle;
  withSaveToggle: boolean;
}) {
  const { analysis, handle } = props;
  const script = React.useMemo(
    () => buildFormReviewScript(analysis, { frames: [] }),
    [analysis],
  );
  const [modalPhase, setModalPhase] = useState<PhaseKey | 'card' | null>(null);
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);
  const [savedSlugs, setSavedSlugs] = useState<Record<string, boolean>>({});
  // The training store's guard is a synchronous store read, not React
  // state — inside one frame the `pendingSlug` prop is still stale, so this
  // is what has to refuse the 2nd and 3rd tap of a burst.
  const inFlight = React.useRef<string | null>(null);

  handle.closeModal = useCallback(() => setModalPhase(null), []);

  const openReview = (phase?: PhaseKey) => {
    handle.events.navigations.push(
      phase !== undefined ? { to: 'FormReview', phase } : { to: 'FormReview' },
    );
    setModalPhase(phase ?? 'card');
  };

  // Exactly the training store's guard: one mutation at a time, the rest
  // are refused without touching the ledger.
  const toggleSaved = (target: CatalogDrill, saved: boolean) => {
    if (inFlight.current !== null) {
      handle.events.saveIntents.push({
        slug: target.slug,
        saved,
        accepted: false,
      });
      return;
    }
    handle.events.saveIntents.push({
      slug: target.slug,
      saved,
      accepted: true,
    });
    const deferred = makeDeferred<boolean>();
    handle.saves.push({ slug: target.slug, saved, deferred });
    inFlight.current = target.slug;
    setPendingSlug(target.slug);
    void deferred.promise
      .then(ok => {
        inFlight.current = null;
        setPendingSlug(null);
        if (ok)
          setSavedSlugs(current => ({ ...current, [target.slug]: saved }));
      })
      .catch(() => {
        inFlight.current = null;
        setPendingSlug(null);
      });
  };

  return (
    <View testID="result-surface">
      <FormReviewCard
        posterUri="file:///captures/clip.poster.jpg"
        stopCount={script.stops.length}
        fixCount={fixList(analysis).length}
        onPress={() => openReview()}
      />
      <FixList
        analysis={analysis}
        onOpenInReview={phase => openReview(phase)}
      />
      <RecommendedDrills
        analysis={analysis}
        onOpenLibrary={() => {
          handle.events.navigations.push({ to: 'DrillLibrary' });
        }}
        {...(props.withSaveToggle
          ? {
              onToggleSaved: toggleSaved,
              isSaved: (target: CatalogDrill) =>
                savedSlugs[target.slug] ?? target.saved,
              pendingSlug,
            }
          : {})}
      />
      <Modal visible={modalPhase !== null} onRequestClose={handle.closeModal}>
        <View testID="review-modal">
          <Text testID="review-modal-phase">{String(modalPhase)}</Text>
          <FormReviewOverlay
            rect={OVERLAY_RECT}
            frame={OVERLAY_FRAME}
            heat={script.jointHeat}
            script={script}
            activeStop={script.stops[0] ?? null}
            showArrow
          />
        </View>
      </Modal>
    </View>
  );
}

// ─── Scenario vocabulary ────────────────────────────────────────────────────

type Action =
  | { kind: 'tapCard'; count: number; sameFrame: boolean }
  | { kind: 'tapFix'; index: number; count: number; sameFrame: boolean }
  | { kind: 'tapLibrary'; count: number; sameFrame: boolean }
  | { kind: 'tapRetry'; count: number; sameFrame: boolean }
  | { kind: 'tapSave'; index: number; count: number; sameFrame: boolean }
  | { kind: 'settleCatalog'; which: 'first' | 'last'; outcome: 'ok' | 'error' }
  | {
      kind: 'settleSave';
      which: 'first' | 'last';
      outcome: 'ok' | 'fail' | 'error';
    }
  | { kind: 'back' }
  | { kind: 'rerender' }
  | { kind: 'swapAnalysis' }
  | { kind: 'flush' };

interface Scenario {
  seed: number;
  session: boolean;
  withSaveToggle: boolean;
  actions: Action[];
}

function generate(seed: number): Scenario {
  const rng = makeRng(seed);
  const session = rng.chance(0.85);
  const withSaveToggle = rng.chance(0.8);
  const length = 8 + rng.int(10);
  const counts = [1, 2, 2, 3, 3, 5] as const;
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) {
    const roll = rng.next();
    const count = rng.pick(counts);
    const sameFrame = rng.chance(0.45);
    if (roll < 0.14) {
      actions.push({ kind: 'tapCard', count, sameFrame });
    } else if (roll < 0.3) {
      actions.push({ kind: 'tapFix', index: rng.int(3), count, sameFrame });
    } else if (roll < 0.38) {
      actions.push({ kind: 'tapLibrary', count, sameFrame });
    } else if (roll < 0.46) {
      actions.push({ kind: 'tapRetry', count, sameFrame });
    } else if (roll < 0.62) {
      actions.push({ kind: 'tapSave', index: rng.int(3), count, sameFrame });
    } else if (roll < 0.74) {
      actions.push({
        kind: 'settleCatalog',
        which: rng.chance(0.7) ? 'last' : 'first',
        outcome: rng.chance(0.75) ? 'ok' : 'error',
      });
    } else if (roll < 0.84) {
      actions.push({
        kind: 'settleSave',
        which: rng.chance(0.7) ? 'last' : 'first',
        outcome: rng.pick(['ok', 'fail', 'error'] as const),
      });
    } else if (roll < 0.9) {
      actions.push({ kind: 'back' });
    } else if (roll < 0.95) {
      actions.push({ kind: 'rerender' });
    } else if (roll < 0.98) {
      actions.push({ kind: 'swapAnalysis' });
    } else {
      actions.push({ kind: 'flush' });
    }
  }
  return { seed, session, withSaveToggle, actions };
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'tapCard':
    case 'tapLibrary':
    case 'tapRetry':
      return `${action.kind}×${action.count}${action.sameFrame ? ' same-frame' : ''}`;
    case 'tapFix':
    case 'tapSave':
      return `${action.kind}[${action.index}]×${action.count}${
        action.sameFrame ? ' same-frame' : ''
      }`;
    case 'settleCatalog':
      return `settleCatalog ${action.which} ${action.outcome}`;
    case 'settleSave':
      return `settleSave ${action.which} ${action.outcome}`;
    default:
      return action.kind;
  }
}

// ─── Rendered-state readers ─────────────────────────────────────────────────

function hosts(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

function pressableNodes(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node =>
      node.props.testID === testID &&
      typeof node.props.onPress === 'function' &&
      typeof node.props.onPressIn === 'function',
  );
}

function textOf(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .join(' ');
}

/** Every fix row that offers "see it in your form review", in rendered order. */
function fixRowIds(analysis: ShotAnalysis): string[] {
  return fixList(analysis).map(item => `fix-item-${item.key}-review`);
}

interface Observed {
  modals: number;
  modalPhase: string | null;
  drillsCards: number;
  loading: boolean;
  error: boolean;
  empty: boolean;
  drillRows: number;
  savePending: string[];
  saveLabels: string[];
  retryButtons: number;
  libraryButtons: number;
  cards: number;
}

function observe(renderer: ReactTestRenderer, slugs: string[]): Observed {
  const body = textOf(renderer);
  const modals = renderer.root
    .findAllByType(Modal)
    .filter(node => node.props.visible === true).length;
  const phaseNode = hosts(renderer, 'review-modal-phase');
  const savePending: string[] = [];
  const saveLabels: string[] = [];
  for (const slug of slugs) {
    for (const node of pressableNodes(
      renderer,
      `recommended-drill-${slug}-save`,
    )) {
      if (node.props.disabled === true) savePending.push(slug);
      saveLabels.push(
        `${slug}:${node.props.accessibilityState?.selected === true}`,
      );
    }
  }
  return {
    modals,
    modalPhase:
      phaseNode.length > 0 ? String(phaseNode[0]!.props.children) : null,
    drillsCards: hosts(renderer, 'recommended-drills').length,
    loading: body.includes(RECOMMENDED_DRILLS_LOADING_COPY),
    error:
      body.includes(RECOMMENDED_DRILLS_ERROR_COPY) ||
      body.includes('catalog is down'),
    empty: body.includes(RECOMMENDED_DRILLS_EMPTY_COPY),
    drillRows: slugs.filter(
      slug => hosts(renderer, `recommended-drill-${slug}`).length > 0,
    ).length,
    savePending,
    saveLabels,
    retryButtons: hosts(renderer, 'recommended-drills-retry').length,
    libraryButtons: hosts(renderer, 'recommended-drills-open-library').length,
    cards: hosts(renderer, 'form-review-card').length,
  };
}

// ─── Oracle ─────────────────────────────────────────────────────────────────

interface Oracle {
  /** 'idle' before the first fetch resolves for the current analysis. */
  drills: 'no_session' | 'loading' | 'ready' | 'error';
  readyDrills: string[];
  modalPhase: string | null;
  requests: number;
  pendingSlug: string | null;
  savedSlugs: Record<string, boolean>;
  navigations: number;
  acceptedSaves: number;
}

// ─── Harness bookkeeping ────────────────────────────────────────────────────

const consoleNoise: string[] = [];
const rejections: string[] = [];
let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
const onRejection = (reason: unknown) => {
  rejections.push(String(reason));
};

interface Row {
  seed: number;
  session: boolean;
  withSaveToggle: boolean;
  actions: number;
  actionsRun: number;
  taps: number;
  requests: number;
  navigations: number;
  saveIntents: number;
  acceptedSaves: number;
  outcome: 'HELD' | 'BROKEN';
  failedAt: string | null;
  detail: string | null;
}

const rows: Row[] = [];
const mounted: ReactTestRenderer[] = [];

async function tapAll(
  renderer: ReactTestRenderer,
  testID: string,
  count: number,
  sameFrame: boolean,
): Promise<number> {
  let fired = 0;
  const press = () => {
    const nodes = pressableNodes(renderer, testID);
    if (nodes.length === 0) return;
    if (nodes.length > 1) {
      throw new Error(`${nodes.length} pressables share ${testID}`);
    }
    const node = nodes[0]!;
    if (node.props.disabled === true) return;
    node.props.onPressIn({ nativeEvent: {} });
    node.props.onPress();
    node.props.onPressOut({ nativeEvent: {} });
    fired += 1;
  };
  if (sameFrame) {
    await act(async () => {
      for (let k = 0; k < count; k += 1) press();
    });
  } else {
    for (let k = 0; k < count; k += 1) {
      await act(async () => {
        press();
      });
    }
  }
  return fired;
}

function assertConsistent(
  observed: Observed,
  oracle: Oracle,
  where: string,
  withSaveToggle: boolean,
  slugs: readonly string[],
) {
  const problems: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };
  check(observed.cards === 1, `${observed.cards} review cards`);
  check(observed.modals <= 1, `${observed.modals} review modals visible`);
  check(
    observed.modals === (oracle.modalPhase !== null ? 1 : 0),
    `modal visibility ${observed.modals} ≠ oracle ${oracle.modalPhase !== null}`,
  );
  if (oracle.modalPhase !== null) {
    check(
      observed.modalPhase === oracle.modalPhase,
      `modal phase ${observed.modalPhase} ≠ oracle ${oracle.modalPhase}`,
    );
  }
  check(observed.drillsCards === 1, `${observed.drillsCards} drills cards`);
  check(
    observed.loading === (oracle.drills === 'loading'),
    `loading ${observed.loading} ≠ oracle ${oracle.drills}`,
  );
  check(
    observed.error === (oracle.drills === 'error'),
    `error ${observed.error} ≠ oracle ${oracle.drills}`,
  );
  check(observed.retryButtons <= 1, `${observed.retryButtons} retry buttons`);
  check(
    observed.retryButtons === (oracle.drills === 'error' ? 1 : 0),
    `retry button ${observed.retryButtons} in state ${oracle.drills}`,
  );
  // The quiet no-session card and the loading card carry no actions.
  const libraryExpected =
    oracle.drills === 'ready' || oracle.drills === 'error' ? 1 : 0;
  check(
    observed.libraryButtons === libraryExpected,
    `${observed.libraryButtons} library buttons in state ${oracle.drills}`,
  );
  if (oracle.drills === 'ready') {
    check(
      observed.drillRows === oracle.readyDrills.length,
      `${observed.drillRows} drill rows ≠ oracle ${oracle.readyDrills.length}`,
    );
    check(
      observed.empty === (oracle.readyDrills.length === 0),
      `empty copy ${observed.empty} with ${oracle.readyDrills.length} drills`,
    );
    if (withSaveToggle) {
      const pending = oracle.pendingSlug;
      check(
        observed.savePending.join(',') ===
          (pending !== null && oracle.readyDrills.includes(pending)
            ? pending
            : ''),
        `save toggles disabled [${observed.savePending.join(',')}] ≠ oracle ${pending}`,
      );
      // `observe` walks the catalog order, the oracle the matched order.
      const expected = slugs
        .filter(slug => oracle.readyDrills.includes(slug))
        .map(slug => `${slug}:${oracle.savedSlugs[slug] === true}`)
        .join('|');
      check(
        observed.saveLabels.join('|') === expected,
        `saved states [${observed.saveLabels.join('|')}] ≠ oracle [${expected}]`,
      );
    }
  } else {
    check(
      observed.drillRows === 0,
      `${observed.drillRows} drill rows in ${oracle.drills}`,
    );
  }
  check(
    consoleNoise.length === 0,
    `console noise: ${consoleNoise.join(' | ')}`,
  );
  check(
    rejections.length === 0,
    `unhandled rejections: ${rejections.join(' | ')}`,
  );
  if (problems.length > 0) throw new Error(`${where}: ${problems.join('; ')}`);
}

async function runScenario(scenario: Scenario): Promise<Row> {
  const handle: HostHandle = {
    events: { navigations: [], saveIntents: [] },
    saves: [],
    closeModal: () => undefined,
  };
  mockGetApiSession.mockReturnValue(scenario.session ? SESSION : null);
  catalogCalls.length = 0;

  let analysis = analysisFixture('analysis-stress-1');
  const focus = drillFocusFromAnalysis(analysis);
  if (!focus) throw new Error('fixture must carry a scored fault');
  const matched = pickRecommendedDrills(CATALOG, focus, 3).map(
    item => item.slug,
  );
  const slugs = CATALOG.map(item => item.slug);

  const oracle: Oracle = {
    drills: scenario.session ? 'loading' : 'no_session',
    readyDrills: [],
    modalPhase: null,
    requests: 0,
    pendingSlug: null,
    savedSlugs: {},
    navigations: 0,
    acceptedSaves: 0,
  };

  const element = (identity: number) => (
    <ResultSurface
      key="surface"
      analysis={identity === 0 ? analysis : { ...analysis }}
      handle={handle}
      withSaveToggle={scenario.withSaveToggle}
    />
  );

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element(0));
  });
  mounted.push(renderer);
  if (scenario.session) oracle.requests += 1;

  const row: Row = {
    seed: scenario.seed,
    session: scenario.session,
    withSaveToggle: scenario.withSaveToggle,
    actions: scenario.actions.length,
    actionsRun: 0,
    taps: 0,
    requests: 0,
    navigations: 0,
    saveIntents: 0,
    acceptedSaves: 0,
    outcome: 'HELD',
    failedAt: null,
    detail: null,
  };

  const checkRequests = (where: string) => {
    if (catalogCalls.length !== oracle.requests) {
      throw new Error(
        `${where}: ${catalogCalls.length} catalog requests ≠ oracle ${oracle.requests}`,
      );
    }
  };

  const pendingCatalog = () =>
    catalogCalls.filter(call => !call.deferred.settled);
  const pendingSaves = () =>
    handle.saves.filter(save => !save.deferred.settled);
  const latestCatalog = () => catalogCalls[catalogCalls.length - 1];

  try {
    assertConsistent(
      observe(renderer, slugs),
      oracle,
      'after mount',
      scenario.withSaveToggle,
      slugs,
    );
    checkRequests('after mount');

    for (const action of scenario.actions) {
      const label = `#${row.actionsRun + 1} ${describeAction(action)}`;
      switch (action.kind) {
        case 'tapCard': {
          const fired = await tapAll(
            renderer,
            'form-review-card',
            action.count,
            action.sameFrame,
          );
          row.taps += fired;
          oracle.navigations += fired;
          if (fired > 0) oracle.modalPhase = 'card';
          break;
        }
        case 'tapFix': {
          const ids = fixRowIds(analysis);
          const id = ids[action.index % Math.max(1, ids.length)];
          if (!id) break;
          const fired = await tapAll(
            renderer,
            id,
            action.count,
            action.sameFrame,
          );
          row.taps += fired;
          oracle.navigations += fired;
          if (fired > 0) {
            const item = fixList(analysis)[action.index % ids.length]!;
            oracle.modalPhase = item.phase;
          }
          break;
        }
        case 'tapLibrary': {
          const fired = await tapAll(
            renderer,
            'recommended-drills-open-library',
            action.count,
            action.sameFrame,
          );
          row.taps += fired;
          oracle.navigations += fired;
          break;
        }
        case 'tapRetry': {
          const fired = await tapAll(
            renderer,
            'recommended-drills-retry',
            action.count,
            action.sameFrame,
          );
          row.taps += fired;
          if (fired > 0) {
            // Retry bumps `attempt`; same-frame taps all read the same
            // state, so one frame = one refetch however many taps land.
            oracle.requests += action.sameFrame ? 1 : fired;
            oracle.drills = 'loading';
          }
          break;
        }
        case 'tapSave': {
          if (!scenario.withSaveToggle || oracle.drills !== 'ready') break;
          const slug =
            oracle.readyDrills[
              action.index % Math.max(1, oracle.readyDrills.length)
            ];
          if (!slug) break;
          const before = handle.events.saveIntents.length;
          const fired = await tapAll(
            renderer,
            `recommended-drill-${slug}-save`,
            action.count,
            action.sameFrame,
          );
          row.taps += fired;
          const intents = handle.events.saveIntents.slice(before);
          const accepted = intents.filter(intent => intent.accepted);
          if (accepted.length > 1) {
            throw new Error(
              `${label}: ${accepted.length} mutations accepted for one burst`,
            );
          }
          if (oracle.pendingSlug === null && fired > 0) {
            if (accepted.length !== 1) {
              throw new Error(
                `${label}: ${accepted.length} mutations accepted, expected 1`,
              );
            }
            oracle.pendingSlug = slug;
            oracle.acceptedSaves += 1;
          } else if (accepted.length !== 0) {
            throw new Error(
              `${label}: a mutation was accepted while ${oracle.pendingSlug} is in flight`,
            );
          }
          break;
        }
        case 'settleCatalog': {
          const pending = pendingCatalog();
          if (pending.length === 0) break;
          const call =
            action.which === 'first'
              ? pending[0]!
              : pending[pending.length - 1]!;
          const isLatest = call === latestCatalog();
          await act(async () => {
            if (action.outcome === 'ok') call.deferred.resolve(CATALOG);
            else
              call.deferred.reject(
                new TrainingError(
                  'unavailable',
                  'the catalog is down',
                  true,
                  503,
                ),
              );
            await flushMicrotasks();
          });
          if (isLatest) {
            if (action.outcome === 'ok') {
              oracle.drills = 'ready';
              oracle.readyDrills = matched;
            } else {
              oracle.drills = 'error';
              oracle.readyDrills = [];
            }
          }
          break;
        }
        case 'settleSave': {
          const pending = pendingSaves();
          if (pending.length === 0) break;
          const save =
            action.which === 'first'
              ? pending[0]!
              : pending[pending.length - 1]!;
          await act(async () => {
            if (action.outcome === 'ok') save.deferred.resolve(true);
            else if (action.outcome === 'fail') save.deferred.resolve(false);
            else
              save.deferred.reject(
                new TrainingError('unavailable', 'save refused', true, 503),
              );
            await flushMicrotasks();
          });
          if (oracle.pendingSlug === save.slug) oracle.pendingSlug = null;
          if (action.outcome === 'ok')
            oracle.savedSlugs[save.slug] = save.saved;
          break;
        }
        case 'back': {
          await act(async () => {
            handle.closeModal();
          });
          oracle.modalPhase = null;
          break;
        }
        case 'rerender': {
          // A NEW analysis object with the SAME id must not refetch.
          await act(async () => {
            renderer.update(element(1));
          });
          break;
        }
        case 'swapAnalysis': {
          analysis = analysisFixture(`analysis-stress-${row.actionsRun + 2}`);
          await act(async () => {
            renderer.update(element(0));
          });
          if (scenario.session) {
            oracle.requests += 1;
            oracle.drills = 'loading';
            oracle.readyDrills = [];
          }
          break;
        }
        case 'flush': {
          await act(async () => {
            await flushMicrotasks();
          });
          break;
        }
      }
      row.actionsRun += 1;
      assertConsistent(
        observe(renderer, slugs),
        oracle,
        label,
        scenario.withSaveToggle,
        slugs,
      );
      checkRequests(label);
      if (oracle.drills === 'loading' && pendingCatalog().length === 0) {
        throw new Error(
          `${label}: orphan loading state with no request in flight`,
        );
      }
    }

    // Unmount with everything still in flight, then settle it: a resolution
    // that lands on an unmounted tree must update nothing and warn nothing.
    await act(async () => {
      renderer.unmount();
    });
    mounted.splice(mounted.indexOf(renderer), 1);
    await act(async () => {
      for (const call of pendingCatalog()) call.deferred.resolve(CATALOG);
      for (const save of pendingSaves()) save.deferred.resolve(true);
      await flushMicrotasks();
    });
    if (consoleNoise.length > 0) {
      throw new Error(
        `console noise after unmount: ${consoleNoise.join(' | ')}`,
      );
    }
    if (rejections.length > 0) {
      throw new Error(
        `unhandled rejections after unmount: ${rejections.join(' | ')}`,
      );
    }
  } catch (error) {
    row.outcome = 'BROKEN';
    row.failedAt = `action ${row.actionsRun}/${row.actions}`;
    row.detail = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    row.requests = catalogCalls.length;
    row.navigations = handle.events.navigations.length;
    row.saveIntents = handle.events.saveIntents.length;
    row.acceptedSaves = handle.events.saveIntents.filter(
      intent => intent.accepted,
    ).length;
    rows.push(row);
  }
  return row;
}

// ─── Suite ──────────────────────────────────────────────────────────────────

const seeds: number[] =
  ONLY_SEED !== null
    ? Array.from({ length: REPEAT }, () => ONLY_SEED)
    : Array.from({ length: ITERATIONS }, (_, i) => SEED_BASE + i);

beforeAll(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation((...args) => {
    consoleNoise.push(args.map(String).join(' '));
  });
  warnSpy = jest.spyOn(console, 'warn').mockImplementation((...args) => {
    consoleNoise.push(args.map(String).join(' '));
  });
  process.on('unhandledRejection', onRejection);
});

afterAll(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  process.off('unhandledRejection', onRejection);
  const held = rows.filter(row => row.outcome === 'HELD').length;
  const report = {
    suite: 'cmp-form-review-ui/rapid-interaction/resultSurface',
    generatedAt: new Date().toISOString(),
    iterations: rows.length,
    actionsRun: rows.reduce((sum, row) => sum + row.actionsRun, 0),
    taps: rows.reduce((sum, row) => sum + row.taps, 0),
    requests: rows.reduce((sum, row) => sum + row.requests, 0),
    navigations: rows.reduce((sum, row) => sum + row.navigations, 0),
    saveIntents: rows.reduce((sum, row) => sum + row.saveIntents, 0),
    acceptedSaves: rows.reduce((sum, row) => sum + row.acceptedSaves, 0),
    held,
    broken: rows.length - held,
    rows,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'resultSurface.rapid-interaction.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
});

beforeEach(() => {
  mockGetApiSession.mockReset();
  catalogCalls.length = 0;
  consoleNoise.length = 0;
  rejections.length = 0;
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
});

describe('the review surface under rapid, concurrent interaction', () => {
  it.each(seeds.map((seed, i) => [seed, i]))(
    'seed %i holds every invariant (run %i)',
    async (seed: number) => {
      const scenario = generate(seed);
      const row = await runScenario(scenario);
      expect(row.outcome).toBe('HELD');
      expect(row.actionsRun).toBe(scenario.actions.length);
    },
  );

  it('the generator is deterministic per seed', () => {
    expect(generate(SEED_BASE)).toEqual(generate(SEED_BASE));
    expect(JSON.stringify(generate(SEED_BASE))).not.toBe(
      JSON.stringify(generate(SEED_BASE + 1)),
    );
  });
});
