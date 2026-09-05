/**
 * Seeded randomized long-run driver for `LibraryScreen`.
 *
 * The screen is mounted exactly the way the app mounts it — inside a REAL
 * `NavigationContainer` → native stack → bottom-tab navigator (so
 * `useNavigation`, `useFocusEffect` focus/blur and route params are the real
 * thing), with the REAL zustand training store fed by the REAL
 * `createTrainingApi` parser, the REAL auth store, the REAL `getDb()` +
 * repository over an in-memory SQLite, and the REAL `BrandNoticeHost`. Only
 * native modules (op-sqlite, safe-area, Linking) and `fetch` are faked.
 *
 * Every sequence is replayable from its 32-bit seed: the generator draws the
 * world (owner, session, seeded rows, fake server) and then 5–60 actions from
 * the screen's public surface — taps on everything it renders, tab-bar
 * switches, stack push/pop, late/failed repository reads, late/failed API
 * responses, DB and server mutations, auth flips, store (un)configuration —
 * and model-checks the invariants below after EVERY step.
 *
 * Invariants (ids appear verbatim in violations / the JSON table):
 *   G1  no console.error / console.warn / thrown render error during a step
 *   G2  tab selection ('Reads' | 'Saved drills') survives blur/refocus and
 *       store/DB churn; exactly one segment is selected
 *   G3  same seed → identical trace (checked by the determinism test)
 *   R1  reads tab is exactly one of loading | error | list
 *   R2  latest-wins: the rendered reads equal the repository snapshot of the
 *       newest load issued in the current focus epoch once it settled; a
 *       superseded or blurred load (settled ok OR failed) changes nothing;
 *       a failed newest load renders the error card (never an empty library)
 *   R3  pending clips: rows = first min(3, n) captures newest-first with the
 *       exact pendingCaptureTitle/pendingEvidenceCopy copy; note + pill iff n>0
 *   R4  header reads "<n> analyzed read(s) · <m> pending clip(s)" iff n+m>0
 *   R5  scored rows show overallScore.toFixed(1); low_confidence rows show
 *       NOT READ; no text anywhere reads NaN / undefined / null / [object
 *   R6  rows are the owner-scoped, source='real' shots newest-first (rendered rows = prefix of that order, ≥ the FlatList initial window of 10)
 *   R7  pressing row i pushes Result{analysisId: row.id}; the empty-state CTA
 *       pushes Analyze; Library blurs (a later settle must not repaint)
 *   R8  Retry: error card gone, loading shown, exactly one new load issued
 *   R9  every load is exactly one local_shot read + one local_capture read,
 *       issued together; loads are issued only on focus or Retry
 *   S1  saved cards = savedDrills whose detail loaded, in store order;
 *       "<n> saved" count; held notice iff some detail is missing
 *   S2  saved-tab body follows savedStatus: loading/idle → spinner copy,
 *       unconfigured → "needs a synced account" (+ Connect account iff the
 *       session is local-only), error → "Training is offline.",
 *       ready+0 → "No saved drills yet.", ready+all-held → "couldn't be
 *       verified", else cards
 *   S3  mutation-error banner iff store.mutationError; DISMISS clears it
 *   S4  every card's busy flag == (store.mutation !== 'idle'); tapping a busy
 *       Remove button issues no request
 *   S5  Explore → DrillLibrary; Connect account → ConnectAccount; plan card →
 *       Result{analysisId: plan.sourceShotId}; Remove → DELETE
 *       /v1/me/saved-drills/<slug>
 *   S6  Watch form opens the canonical URL (sourceUrl for embeds, playbackUrl
 *       for hosted) via Linking; when canOpenURL is false the brand notice
 *       "Video unavailable" is presented and can be dismissed
 *   S7  store latest-wins at quiescence: with no request in flight, the store
 *       reflects the newest saved-drills list request of the current
 *       configuration (ready+its items, or error+[] when it failed)
 *
 * Observations (counted, never failing — documented product behaviour):
 *   O1  while `shots === null` the reads branch renders only the LoadingState,
 *       so the page header and the Reads/Saved segmented control are absent
 *       (the Saved tab cannot be reached until the SQLite reads settle)
 */
import React from 'react';
import { Linking, Text } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import {
  createNavigationContainerRef,
  NavigationContainer,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useAuthStore } from '../../src/auth/authStore';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { getDb } from '../../src/data/db';
import type { PendingCapture } from '../../src/data/repository';
import { BrandDialog, PressableScale } from '../../src/design/components';
import { BrandNoticeHost } from '../../src/design/BrandNotice';
import type {
  MainTabParams,
  RootStackParams,
} from '../../src/navigation/params';
import {
  LibraryScreen,
  MUTATION_ERROR_DISMISS_HINT,
  PENDING_SECTION_NOTE,
  PENDING_SECTION_PILL,
  READS_LOAD_ERROR_TITLE,
  pendingCaptureTitle,
  pendingEvidenceCopy,
} from '../../src/screens/LibraryScreen';
import { createTrainingApi } from '../../src/training/api';
import { SavedDrillCard } from '../../src/training/components';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';
import {
  dbGate,
  fetchGate,
  type DbReadEntry,
  type FakeDrill,
  type FakeMedia,
  type FetchOutcome,
} from './gates';
import { hash32, makePrng, type Prng } from './prng';

/* ------------------------------------------------------------------ */
/* World                                                               */
/* ------------------------------------------------------------------ */

const OTHER_OWNER = '0f1e2d3c-4b5a-4697-8877-665544332211';
const SIGNED_IN_OWNER = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const STROKES = [
  'forehand_drive',
  'backhand_drive',
  'dink',
  'third_shot_drop',
  'serve',
  'overhead',
] as const;
const EVIDENCE: PendingCapture['evidenceStatus'][] = [
  'valid',
  'legacy',
  'corrupt',
  'metadata_mismatch',
];

interface ShotOracle {
  id: string;
  owner: string;
  shotType: string;
  capturedAt: string;
  overallScore: number | null;
  confidence: number;
  resultKind: 'scored' | 'low_confidence';
  source: 'real' | 'fixture';
}

interface CaptureOracle {
  id: string;
  owner: string;
  shotType: string;
  declaredStroke: string | null;
  capturedAt: string;
  durationMs: number;
  status: 'awaiting_model' | 'analyzed';
  evidenceStatus: PendingCapture['evidenceStatus'];
  payload: string | null;
  fps: number;
  width: number;
  height: number;
  uri: string;
}

interface World {
  owner: string;
  localOnly: boolean;
  configured: boolean;
  shots: ShotOracle[];
  captures: CaptureOracle[];
  nextShot: number;
  nextCapture: number;
  nextDrill: number;
  linkingCanOpen: boolean;
}

function isoAt(rng: Prng): string {
  // Unique, strictly ordered timestamps: SQLite orders captured_at as TEXT.
  const base = Date.UTC(2026, 7, 1, 0, 0, 0);
  const t = base + rng.int(0, 60 * 24 * 3600) * 1000;
  return new Date(t).toISOString();
}

function uuidFrom(rng: Prng, tag: string, n: number): string {
  const h = hash32(`${tag}:${rng.seed}:${n}`).toString(16).padStart(8, '0');
  const h2 = hash32(`${n}:${rng.seed}:${tag}`).toString(16).padStart(8, '0');
  return `${h}-${h2.slice(0, 4)}-4${h2.slice(4, 7)}-8${h.slice(0, 3)}-${h2}${h.slice(0, 4)}`;
}

function makeShot(rng: Prng, world: World, owner: string): ShotOracle {
  const n = world.nextShot++;
  const low = rng.chance(0.3);
  const malformedDate = rng.chance(0.03);
  const scoredWithoutNumber = !low && rng.chance(0.05);
  return {
    id: uuidFrom(rng, 'shot', n),
    owner,
    shotType: rng.pick(STROKES),
    capturedAt: malformedDate ? `not-a-date-${n}` : isoAt(rng),
    overallScore:
      low || scoredWithoutNumber ? null : Math.round(rng.next() * 1000) / 100,
    confidence: low ? rng.int(0, 40) / 100 : rng.int(60, 100) / 100,
    resultKind: low ? 'low_confidence' : 'scored',
    source: rng.chance(0.08) ? 'fixture' : 'real',
  };
}

function insertShot(shot: ShotOracle): void {
  dbGate.run(
    `INSERT OR REPLACE INTO local_shot
     (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, '{}')`,
    [
      shot.owner,
      shot.id,
      shot.shotType,
      shot.capturedAt,
      shot.overallScore,
      shot.confidence,
      shot.resultKind,
      shot.source,
    ],
  );
}

function makeCapture(rng: Prng, world: World, owner: string): CaptureOracle {
  const n = world.nextCapture++;
  const evidence = rng.pick(EVIDENCE);
  const declared = rng.chance(0.5) ? rng.pick(STROKES) : null;
  const shotType = rng.chance(0.5) ? 'unrecognized' : rng.pick(STROKES);
  const capturedAt = isoAt(rng);
  const durationMs = rng.int(900, 12000);
  const fps = rng.pick([29.97, 30, 59.94, 60]);
  // The imported-video clip shape `assertCapturedClip` accepts; the repository
  // derives evidenceStatus by comparing it with the row's columns.
  const clip = {
    uri: `file:///captures/${rng.seed.toString(16)}-${n}.mov`,
    capturedAtIso: capturedAt,
    durationMs,
    fps,
    width: 720,
    height: 1280,
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
  };
  let payload: string | null;
  switch (evidence) {
    case 'legacy':
      payload = null;
      break;
    case 'corrupt':
      payload = rng.chance(0.5)
        ? '{not json'
        : JSON.stringify({ uri: clip.uri });
      break;
    case 'metadata_mismatch':
      payload = JSON.stringify({ ...clip, durationMs: durationMs + 5000 });
      break;
    case 'valid':
      payload = JSON.stringify(clip);
      break;
  }
  return {
    id: `cap-${rng.seed.toString(16)}-${n}`,
    owner,
    shotType,
    declaredStroke: declared,
    capturedAt,
    durationMs,
    status: 'awaiting_model',
    evidenceStatus: evidence,
    payload,
    fps,
    width: 720,
    height: 1280,
    uri: clip.uri,
  };
}

function insertCapture(capture: CaptureOracle): void {
  dbGate.run(
    `INSERT OR REPLACE INTO local_capture
     (owner_key, id, uri, shot_type, declared_stroke, captured_at, duration_ms, fps, width, height, status, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      capture.owner,
      capture.id,
      capture.uri,
      capture.shotType,
      capture.declaredStroke,
      capture.capturedAt,
      capture.durationMs,
      capture.fps,
      capture.width,
      capture.height,
      capture.status,
      capture.payload,
    ],
  );
}

function makeMedia(rng: Prng, n: number): FakeMedia {
  const id = uuidFrom(rng, 'media', n);
  if (rng.chance(0.5)) {
    const videoId = `vid${n}x`;
    return {
      id,
      kind: 'embed',
      provider: 'youtube',
      videoId,
      embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
      sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
      creatorName: 'Third Shot Sports',
      licenseName: 'YouTube Terms of Service',
      licenseUrl: 'https://www.youtube.com/t/terms',
      attribution: 'Third Shot Sports on YouTube',
    };
  }
  const expired = rng.chance(0.2);
  return {
    id,
    kind: 'hosted',
    playbackUrl: `https://cdn.stress.test/${n}.m3u8`,
    expiresAt: expired
      ? '2000-01-01T00:00:00.000Z'
      : '2099-01-01T00:00:00.000Z',
    sourceUrl: `https://source.stress.test/${n}`,
    creatorName: 'Pickle Sensei Training Library',
    licenseName: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'Pickle Sensei Training Library, CC BY 4.0',
  };
}

function makeDrill(rng: Prng, world: World): FakeDrill {
  const n = world.nextDrill++;
  const held = rng.chance(0.25);
  const mediaCount = rng.int(0, 2);
  const media: FakeMedia[] = [];
  for (let i = 0; i < mediaCount; i += 1)
    media.push(makeMedia(rng, n * 10 + i));
  return {
    id: uuidFrom(rng, 'drill', n),
    slug: `drill-${n}`,
    title: `Drill ${n}`,
    description: `Stress drill number ${n}.`,
    coach_name: 'Pickle Sensei Training Library',
    equipment: ['paddle'],
    difficulty_min: null,
    difficulty_max: null,
    saved_at: isoAt(rng),
    detail: held
      ? null
      : {
          mappings: rng.chance(0.5)
            ? [
                {
                  checkpoint: 'contact_point',
                  shot_type: 'dink',
                  plan_role: 'targeted',
                  fault_directions: ['late'],
                  cue_text: 'Meet the ball out front.',
                  target_sets: 3,
                  target_repetitions_per_set: 10,
                  target_duration_seconds: null,
                  rest_seconds: 30,
                },
              ]
            : [],
          instructionalMedia: media,
        },
  };
}

/* ------------------------------------------------------------------ */
/* Navigator (the app's shape: stack → tabs → LibraryScreen)          */
/* ------------------------------------------------------------------ */

const Stack = createNativeStackNavigator<RootStackParams>();
const Tabs = createBottomTabNavigator<MainTabParams>();

function StubRoute() {
  return <Text>stub route</Text>;
}

function makeTabs(initialRouteName: keyof MainTabParams) {
  return function MainTabs() {
    return (
      <Tabs.Navigator
        initialRouteName={initialRouteName}
        screenOptions={{ headerShown: false }}
      >
        <Tabs.Screen name="Home" component={StubRoute} />
        <Tabs.Screen name="Library" component={LibraryScreen} />
      </Tabs.Navigator>
    );
  };
}

/* ------------------------------------------------------------------ */
/* View reader                                                         */
/* ------------------------------------------------------------------ */

function flattenText(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(flattenText).join('');
}

function texts(root: ReactTestInstance): string[] {
  return root.findAllByType(Text).map(flattenText);
}

interface ReadRow {
  label: string;
  node: ReactTestInstance;
  disabled: boolean;
  texts: string[];
}

interface PendingRow {
  title: string;
  meta: string;
  date: string;
}

interface ReadsView {
  kind: 'hidden' | 'loading' | 'error' | 'list' | 'mixed';
  rows: ReadRow[];
  pending: PendingRow[];
  header: string | null;
  note: boolean;
  pill: boolean;
  emptyCta: ReactTestInstance | null;
  retry: ReactTestInstance | null;
}

interface SavedView {
  present: boolean;
  status:
    | 'loading'
    | 'unconfigured'
    | 'error'
    | 'empty'
    | 'all-held'
    | 'cards'
    | 'unknown';
  cards: { slug: string; busy: boolean; node: ReactTestInstance }[];
  countLabel: string | null;
  heldNotice: boolean;
  connect: ReactTestInstance | null;
  tryAgain: ReactTestInstance | null;
  explore: ReactTestInstance | null;
  plan: ReactTestInstance | null;
  mutationError: ReactTestInstance | null;
  unsave: ReactTestInstance[];
  watch: ReactTestInstance[];
}

interface Snapshot {
  mounted: boolean;
  tab: 'reads' | 'saved' | 'none' | 'many';
  tabs: ReactTestInstance[];
  reads: ReadsView;
  saved: SavedView;
  route: string;
  stackDepth: number;
  focused: boolean;
  notice: { visible: boolean; title: string };
  noticeDismiss: ReactTestInstance | null;
  allTexts: string[];
  tabBar: { home: ReactTestInstance | null; library: ReactTestInstance | null };
}

/**
 * RN's Pressable and the navigator's tab items render several nested layers
 * that all echo the same props; keep only the outermost match of each so one
 * on-screen control counts once.
 */
function outermost(nodes: ReactTestInstance[]): ReactTestInstance[] {
  const set = new Set(nodes);
  return nodes.filter(node => {
    for (let p = node.parent; p; p = p.parent) if (set.has(p)) return false;
    return true;
  });
}

function pressablesByLabel(
  root: ReactTestInstance,
  match: (label: string) => boolean,
): ReactTestInstance[] {
  return root
    .findAllByType(PressableScale)
    .filter(
      n =>
        typeof n.props.accessibilityLabel === 'string' &&
        match(n.props.accessibilityLabel),
    );
}

function readSnapshot(
  renderer: ReactTestRenderer,
  navRef: ReturnType<typeof createNavigationContainerRef<RootStackParams>>,
): Snapshot {
  const root = renderer.root;
  const library = root.findAllByType(LibraryScreen)[0] ?? null;
  const route = navRef.isReady() ? navRef.getCurrentRoute() : undefined;
  const rootState = navRef.isReady() ? navRef.getRootState() : undefined;
  const routeLabel = route
    ? `${route.name}${route.params ? JSON.stringify(route.params) : ''}`
    : 'none';
  // The default tab bar wraps each item in several pressable layers that all
  // carry the same aria-label; the outermost one with onPress is the tap.
  const tabBarButton = (prefix: string): ReactTestInstance | null =>
    outermost(
      root.findAll(
        n =>
          typeof n.props['aria-label'] === 'string' &&
          String(n.props['aria-label']).startsWith(prefix) &&
          typeof n.props.onPress === 'function',
      ),
    )[0] ?? null;
  const tabBar = {
    home: tabBarButton('Home,'),
    library: tabBarButton('Library,'),
  };
  const dialogs = root.findAllByType(BrandDialog);
  const noticeDialog = dialogs.find(d => d.props.testID === 'brand-notice');
  const notice = {
    visible: Boolean(noticeDialog?.props.visible),
    title: String(noticeDialog?.props.title ?? ''),
  };
  let noticeDismiss: ReactTestInstance | null = null;
  if (notice.visible && noticeDialog) {
    noticeDismiss =
      pressablesByLabel(noticeDialog, l => l === 'Got it')[0] ?? null;
  }

  const empty: Snapshot = {
    mounted: library !== null,
    tab: 'none',
    tabs: [],
    reads: {
      kind: 'hidden',
      rows: [],
      pending: [],
      header: null,
      note: false,
      pill: false,
      emptyCta: null,
      retry: null,
    },
    saved: {
      present: false,
      status: 'unknown',
      cards: [],
      countLabel: null,
      heldNotice: false,
      connect: null,
      tryAgain: null,
      explore: null,
      plan: null,
      mutationError: null,
      unsave: [],
      watch: [],
    },
    route: routeLabel,
    stackDepth: rootState?.routes.length ?? 0,
    focused: route?.name === 'Library',
    notice,
    noticeDismiss,
    allTexts: texts(root),
    tabBar,
  };
  if (!library) return empty;

  const segments = outermost(
    library.findAll(
      n =>
        n.props.accessibilityRole === 'tab' &&
        typeof n.props.onPress === 'function',
    ),
  );
  const selected = segments.filter(n => n.props.accessibilityState?.selected);
  let tab: Snapshot['tab'] = 'none';
  if (selected.length === 1) {
    tab = flattenText(selected[0]!) === 'Reads' ? 'reads' : 'saved';
  } else if (selected.length > 1) {
    tab = 'many';
  }

  const libraryTexts = texts(library);
  const hasError = libraryTexts.includes(READS_LOAD_ERROR_TITLE);
  const hasLoading = libraryTexts.includes('Opening your library…');
  const rows: ReadRow[] = pressablesByLabel(
    library,
    l => l.startsWith('Open ') && l.endsWith(' result'),
  ).map(node => ({
    label: String(node.props.accessibilityLabel),
    node,
    disabled: Boolean(node.props.disabled),
    texts: texts(node),
  }));
  const emptyCta =
    pressablesByLabel(library, l => l === 'Analyze your first stroke')[0] ??
    null;
  const header = libraryTexts.find(t => / analyzed read/.test(t)) ?? null;
  const pending: PendingRow[] = [];
  for (const textNode of library.findAllByType(Text)) {
    const value = flattenText(textNode);
    if (!/^\d+s clip · /.test(value)) continue;
    const parent = textNode.parent;
    if (!parent) continue;
    const siblings = parent.children.filter(
      (c): c is ReactTestInstance => typeof c !== 'string' && c.type === Text,
    );
    pending.push({
      title: flattenText(siblings[0]!),
      meta: flattenText(siblings[1]!),
      date: value,
    });
  }
  // While `shots === null` the reads branch renders only the LoadingState:
  // the page header and the Reads/Saved segmented control are not mounted at
  // all, so no segment can be selected even though the screen's tab is
  // 'reads'. The snapshot reports that literally (tab 'none' + loading) and
  // the invariant layer treats it as the reads tab (see G2 / O1).
  const readsPresent =
    tab === 'reads' || (tab === 'none' && segments.length === 0 && hasLoading);
  const states = [hasLoading, hasError, rows.length > 0 || emptyCta !== null];
  const stateCount = states.filter(Boolean).length;
  let kind: ReadsView['kind'] = 'hidden';
  if (readsPresent) {
    if (stateCount > 1) kind = 'mixed';
    else if (hasLoading) kind = 'loading';
    else if (hasError) kind = 'error';
    else kind = 'list';
  }
  const tryAgain =
    pressablesByLabel(library, l => l === 'Try again')[0] ?? null;

  const cards = library.findAllByType(SavedDrillCard).map(node => ({
    slug: String((node.props.drill as { slug: string }).slug),
    busy: Boolean(node.props.busy),
    node,
  }));
  let savedStatus: SavedView['status'] = 'unknown';
  if (libraryTexts.includes('Loading saved drills…')) savedStatus = 'loading';
  else if (libraryTexts.includes('Saved training needs a synced account.'))
    savedStatus = 'unconfigured';
  else if (libraryTexts.includes('Training is offline.')) savedStatus = 'error';
  else if (libraryTexts.includes('No saved drills yet.')) savedStatus = 'empty';
  else if (
    libraryTexts.includes('Saved entries couldn’t be verified right now.')
  )
    savedStatus = 'all-held';
  else if (cards.length > 0) savedStatus = 'cards';
  const mutationError =
    outermost(
      library.findAll(
        n =>
          n.props.accessibilityHint === MUTATION_ERROR_DISMISS_HINT &&
          typeof n.props.onPress === 'function',
      ),
    )[0] ?? null;

  return {
    ...empty,
    tab,
    tabs: segments,
    reads: {
      kind,
      rows,
      pending,
      header,
      note: libraryTexts.includes(PENDING_SECTION_NOTE),
      pill: libraryTexts.includes(PENDING_SECTION_PILL),
      emptyCta,
      retry: tab === 'reads' ? tryAgain : null,
    },
    saved: {
      present: tab === 'saved',
      status: savedStatus,
      cards,
      countLabel: libraryTexts.find(t => /^\d+ saved$/.test(t)) ?? null,
      heldNotice: libraryTexts.some(t => /additional saved/.test(t)),
      connect:
        pressablesByLabel(library, l => l === 'Connect account')[0] ?? null,
      tryAgain: tab === 'saved' ? tryAgain : null,
      explore:
        pressablesByLabel(library, l => l === 'Explore the Drill Library')[0] ??
        null,
      plan:
        pressablesByLabel(
          library,
          l => l === 'Open your current personalized plan',
        )[0] ?? null,
      mutationError,
      unsave: pressablesByLabel(library, l => l.startsWith('Remove ')),
      watch: pressablesByLabel(library, l =>
        l.startsWith('Watch reviewed instruction for '),
      ),
    },
    allTexts: texts(root),
  };
}

/* ------------------------------------------------------------------ */
/* Reads model (mirrors the documented request-id contract)           */
/* ------------------------------------------------------------------ */

interface ReadLoad {
  id: number;
  shotEntry: DbReadEntry;
  captureEntry: DbReadEntry;
  expectedShots: ShotOracle[];
  expectedCaptures: CaptureOracle[];
  superseded: boolean;
  blurred: boolean;
  outcome: 'pending' | 'ok' | 'fail';
}

type ExpectedReads =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'list'; shots: ShotOracle[]; captures: CaptureOracle[] };

function oracleShots(world: World): ShotOracle[] {
  return world.shots
    .filter(s => s.owner === world.owner && s.source === 'real')
    .sort((a, b) =>
      a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0,
    )
    .slice(0, 100);
}

function oracleCaptures(world: World): CaptureOracle[] {
  return world.captures
    .filter(c => c.owner === world.owner && c.status === 'awaiting_model')
    .sort((a, b) =>
      a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0,
    )
    .slice(0, 100);
}

function captureForCopy(c: CaptureOracle): PendingCapture {
  let clip: PendingCapture['clip'] = null;
  if (c.evidenceStatus === 'valid' && c.payload) {
    clip = JSON.parse(c.payload) as PendingCapture['clip'];
  }
  return {
    id: c.id,
    shotType: c.shotType,
    declaredStroke: c.declaredStroke as PendingCapture['declaredStroke'],
    uri: c.uri,
    capturedAtIso: c.capturedAt,
    durationMs: c.durationMs,
    fps: c.fps,
    width: c.width,
    height: c.height,
    clip,
    evidenceStatus: c.evidenceStatus,
  };
}

/* ------------------------------------------------------------------ */
/* Sequence runner                                                     */
/* ------------------------------------------------------------------ */

export interface Violation {
  step: number;
  invariant: string;
  detail: string;
}

export interface StepRecord {
  step: number;
  action: string;
  view: string;
  violations: string[];
}

export interface SequenceResult {
  seed: number;
  length: number;
  world: {
    owner: 'guest' | 'signed-in';
    localOnly: boolean;
    configured: boolean;
    initialTab: string;
    seededShots: number;
    seededCaptures: number;
    seededDrills: number;
  };
  outcome: 'HELD' | 'BROKEN' | 'ERROR';
  violations: Violation[];
  error: string | null;
  traceHash: string;
  steps: StepRecord[];
  durationMs: number;
  loadsIssued: number;
  fetchesIssued: number;
  /** Non-failing observations counted per step (documented product behaviour). */
  observations: { segmentsHiddenWhileLoading: number };
}

/** FlatList's default `initialNumToRender`; the test renderer never lays out. */
const FLATLIST_INITIAL_WINDOW = 10;

export interface RunOptions {
  /** Force the sequence length (default: seeded 5–60). */
  length?: number;
  /** Keep every step's view string in the result (default true). */
  keepSteps?: boolean;
  /** Stop the sequence after this many actions (used by minimization). */
  prefix?: number;
}

function summarizeView(
  snap: Snapshot,
  store = useTrainingStore.getState(),
): string {
  const reads =
    snap.reads.kind === 'list'
      ? `list[${snap.reads.rows
          .map(r => `${r.label.slice(5, -7)}:${r.texts[r.texts.length - 1]}`)
          .join(',')}|pend=${snap.reads.pending.map(p => p.title).join(',')}]`
      : snap.reads.kind;
  const saved = snap.saved.present
    ? `${snap.saved.status}[${snap.saved.cards.map(c => `${c.slug}${c.busy ? '!' : ''}`).join(',')}]${snap.saved.heldNotice ? '+held' : ''}${snap.saved.mutationError ? '+err' : ''}`
    : 'hidden';
  return [
    `route=${snap.route}`,
    `depth=${snap.stackDepth}`,
    `tab=${snap.tab}`,
    `reads=${reads}`,
    `saved=${saved}`,
    `store=${store.savedStatus}/${store.planStatus}/${store.mutation}/${store.savedDrills.map(d => d.slug).join('+')}`,
    `notice=${snap.notice.visible ? snap.notice.title : '-'}`,
    `db=${dbGate.pending.length}`,
    `fetch=${fetchGate.pending.length}`,
  ].join(' ');
}

export async function runSequence(
  seed: number,
  options: RunOptions = {},
): Promise<SequenceResult> {
  const started = Date.now();
  const rng = makePrng(seed);
  const length = options.length ?? rng.int(5, 60);
  const keepSteps = options.keepSteps ?? true;
  const violations: Violation[] = [];
  const steps: StepRecord[] = [];
  const consoleBuffer: string[] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => {
    consoleBuffer.push(`error: ${args.map(String).join(' ').slice(0, 300)}`);
  };
  console.warn = (...args: unknown[]) => {
    consoleBuffer.push(`warn: ${args.map(String).join(' ').slice(0, 300)}`);
  };
  const canOpenSpy = jest
    .spyOn(Linking, 'canOpenURL')
    .mockImplementation(async () => world.linkingCanOpen);
  const openedUrls: string[] = [];
  const openSpy = jest
    .spyOn(Linking, 'openURL')
    .mockImplementation(async url => {
      openedUrls.push(url);
    });

  /* ---- world ---- */
  const signedIn = rng.chance(0.6);
  const world: World = {
    owner: signedIn ? SIGNED_IN_OWNER : GUEST_DATA_OWNER,
    localOnly: !signedIn,
    configured: signedIn ? rng.chance(0.9) : rng.chance(0.3),
    shots: [],
    captures: [],
    nextShot: 1,
    nextCapture: 1,
    nextDrill: 1,
    linkingCanOpen: rng.chance(0.8),
  };
  dbGate.resetSequence();
  fetchGate.resetSequence();
  // Fresh in-memory database for this sequence (getDb caches its handle).
  getDb().close();
  setActiveDataOwner(world.owner);
  getDb();
  useAuthStore.setState({
    hydrated: true,
    session: {
      provider: signedIn ? 'apple' : 'apple',
      subject: 'stress-subject',
      canonicalAppUserId: signedIn ? SIGNED_IN_OWNER : null,
      localOnly: world.localOnly,
      displayName: null,
      email: null,
    },
    busy: false,
    error: null,
  });
  const configure = () => {
    fetchGate.configVersion += 1;
    configureTrainingStore(
      createTrainingApi({
        baseUrl: 'https://training.stress.test/',
        token: 'stress-bearer',
        fetchFn: fetchGate.fetchFn,
      }),
    );
  };
  const unconfigure = () => {
    fetchGate.configVersion += 1;
    clearTrainingStoreConfiguration();
  };
  const initiallyConfigured = world.configured;
  if (world.configured) configure();
  else unconfigure();

  const seededShots = rng.int(0, 8);
  for (let i = 0; i < seededShots; i += 1) {
    const shot = makeShot(
      rng,
      world,
      rng.chance(0.15) ? OTHER_OWNER : world.owner,
    );
    world.shots.push(shot);
    insertShot(shot);
  }
  const seededCaptures = rng.int(0, 6);
  for (let i = 0; i < seededCaptures; i += 1) {
    const capture = makeCapture(
      rng,
      world,
      rng.chance(0.15) ? OTHER_OWNER : world.owner,
    );
    if (rng.chance(0.15)) capture.status = 'analyzed';
    world.captures.push(capture);
    insertCapture(capture);
  }
  const seededDrills = rng.int(0, 4);
  for (let i = 0; i < seededDrills; i += 1) {
    fetchGate.server.saved.push(makeDrill(rng, world));
  }
  if (rng.chance(0.3)) {
    fetchGate.server.plan = {
      id: uuidFrom(rng, 'plan', 1),
      sourceShotId: uuidFrom(rng, 'plan-shot', 1),
      shotType: rng.pick(STROKES),
      priorityCheckpoint: 'contact_point',
      priorityDirection: 'late',
      items: [],
    };
  }
  const initialTab: keyof MainTabParams = rng.chance(0.7) ? 'Library' : 'Home';

  /* ---- mount ---- */
  const navRef = createNavigationContainerRef<RootStackParams>();
  const MainTabs = makeTabs(initialTab);
  let renderer!: ReactTestRenderer;
  let fatal: string | null = null;
  const flush = async () => {
    await act(async () => {});
    await act(async () => {});
  };
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <NavigationContainer ref={navRef}>
          <Stack.Navigator>
            <Stack.Screen name="Tabs" component={MainTabs} />
            <Stack.Screen name="Result" component={StubRoute} />
            <Stack.Screen name="Analyze" component={StubRoute} />
            <Stack.Screen name="DrillLibrary" component={StubRoute} />
            <Stack.Screen name="ConnectAccount" component={StubRoute} />
          </Stack.Navigator>
          <BrandNoticeHost />
        </NavigationContainer>,
      );
    });
    await flush();
  } catch (error) {
    fatal = `mount: ${String(error)}`;
  }

  /* ---- model state ---- */
  const loads: ReadLoad[] = [];
  let expected: ExpectedReads = { kind: 'loading' };
  let seenDbEntries = 0;
  let wasFocused = false;
  let lastTab: 'reads' | 'saved' | null = null;
  let expectLoadThisStep = false;
  let retryThisStep = false;
  let expectedRoute: string | null = null;
  let expectedDelete: string | null = null;
  let expectedOpenUrl: string | null = null;
  let expectedNotice = false;
  let noticeDismissedThisStep = false;
  let dismissedMutationError = false;
  let pressedBusyUnsave = false;
  let fetchesBeforeStep = 0;

  const observations = { segmentsHiddenWhileLoading: 0 };
  const record = (step: number, invariant: string, detail: string) => {
    violations.push({ step, invariant, detail });
  };

  const absorbNewLoads = (step: number, snap: Snapshot) => {
    const fresh = dbGate.issued.slice(seenDbEntries);
    seenDbEntries = dbGate.issued.length;
    if (fresh.length === 0) return;
    if (fresh.length % 2 !== 0) {
      record(
        step,
        'R9',
        `odd number of repository reads issued: ${fresh.map(e => e.table).join(',')}`,
      );
    }
    for (let i = 0; i + 1 < fresh.length; i += 2) {
      const a = fresh[i]!;
      const b = fresh[i + 1]!;
      if (a.table !== 'local_shot' || b.table !== 'local_capture') {
        record(step, 'R9', `load pair out of order: ${a.table},${b.table}`);
      }
      for (const prior of loads) prior.superseded = true;
      loads.push({
        id: loads.length + 1,
        shotEntry: a,
        captureEntry: b,
        expectedShots: oracleShots(world),
        expectedCaptures: oracleCaptures(world),
        superseded: false,
        blurred: false,
        outcome: 'pending',
      });
    }
    const pairs = fresh.length / 2;
    if (!expectLoadThisStep) {
      record(
        step,
        'R9',
        `${pairs} load(s) issued by an action that is neither focus nor Retry (focused=${snap.focused})`,
      );
    } else if (pairs !== 1) {
      record(step, 'R9', `${pairs} loads issued for one focus/Retry`);
    }
  };

  const settleLoad = (entry: DbReadEntry, outcome: 'ok' | 'fail') => {
    dbGate.settle(entry, outcome);
    const load = loads.find(
      l => l.shotEntry === entry || l.captureEntry === entry,
    );
    if (!load || load.outcome !== 'pending') return;
    if (outcome === 'fail') load.outcome = 'fail';
    else if (
      load.shotEntry.settled === 'ok' &&
      load.captureEntry.settled === 'ok'
    ) {
      load.outcome = 'ok';
    }
    if (load.outcome === 'pending') return;
    if (load.superseded || load.blurred) return;
    expected =
      load.outcome === 'ok'
        ? {
            kind: 'list',
            shots: load.expectedShots,
            captures: load.expectedCaptures,
          }
        : { kind: 'error' };
  };

  const checkInvariants = (step: number, snap: Snapshot, action: string) => {
    const store = useTrainingStore.getState();
    if (consoleBuffer.length > 0) {
      record(step, 'G1', consoleBuffer.join(' || '));
      consoleBuffer.length = 0;
    }
    for (const t of snap.allTexts) {
      if (/\bNaN\b|undefined|\bnull\b|\[object /.test(t)) {
        record(step, 'R5', `suspicious text rendered: ${JSON.stringify(t)}`);
      }
    }
    if (!snap.mounted) return;
    const loadingHidesSegments =
      snap.tab === 'none' && snap.reads.kind === 'loading';
    if (loadingHidesSegments) observations.segmentsHiddenWhileLoading += 1;
    const effectiveTab: Snapshot['tab'] = loadingHidesSegments
      ? 'reads'
      : snap.tab;
    if (effectiveTab === 'none' || effectiveTab === 'many') {
      record(
        step,
        'G2',
        `segment selection is ${snap.tab} (reads=${snap.reads.kind})`,
      );
    } else {
      if (
        lastTab !== null &&
        effectiveTab !== lastTab &&
        !action.startsWith('tab:')
      ) {
        record(
          step,
          'G2',
          `tab flipped ${lastTab}→${effectiveTab} without a tab press`,
        );
      }
      lastTab = effectiveTab;
    }

    /* reads */
    if (effectiveTab === 'reads') {
      if (snap.reads.kind === 'mixed')
        record(step, 'R1', 'loading/error/list rendered together');
      if (expected.kind !== snap.reads.kind && snap.reads.kind !== 'mixed') {
        record(
          step,
          'R2',
          `expected ${expected.kind} but rendered ${snap.reads.kind}`,
        );
      } else if (expected.kind === 'list' && snap.reads.kind === 'list') {
        const wantIds = expected.shots.map(s => s.id);
        const gotLabels = snap.reads.rows.map(r => r.label);
        const wantLabels = expected.shots.map(
          s => `Open ${s.shotType.replace(/_/g, ' ')} result`,
        );
        // Without layout events VirtualizedList mounts only its first
        // window (FlatList default initialNumToRender = 10), so the rendered
        // rows must be a prefix of the expected order covering that window.
        const window = Math.min(wantLabels.length, FLATLIST_INITIAL_WINDOW);
        const prefixOk =
          gotLabels.length >= window &&
          gotLabels.length <= wantLabels.length &&
          gotLabels.every((l, i) => l === wantLabels[i]);
        if (!prefixOk) {
          record(
            step,
            'R6',
            `rows ${JSON.stringify(gotLabels)} ≠ expected ${JSON.stringify(wantLabels)} (ids ${wantIds.join(',')})`,
          );
        }
        snap.reads.rows.forEach((row, i) => {
          const shot = expected.kind === 'list' ? expected.shots[i] : undefined;
          if (!shot) return;
          const last = row.texts[row.texts.length - 1] ?? '';
          if (shot.resultKind === 'low_confidence') {
            if (!row.texts.includes('NOT READ'))
              record(
                step,
                'R5',
                `low_confidence row ${shot.id} lacks NOT READ`,
              );
          } else {
            const want =
              shot.overallScore === null ? '' : shot.overallScore.toFixed(1);
            if (last !== want)
              record(
                step,
                'R5',
                `row ${shot.id} score text ${JSON.stringify(last)} ≠ ${JSON.stringify(want)}`,
              );
          }
        });
        const wantPending = expected.captures.slice(0, 3);
        if (snap.reads.pending.length !== wantPending.length) {
          record(
            step,
            'R3',
            `${snap.reads.pending.length} pending rows ≠ ${wantPending.length}`,
          );
        } else {
          wantPending.forEach((c, i) => {
            const got = snap.reads.pending[i]!;
            const pc = captureForCopy(c);
            if (
              got.title !== pendingCaptureTitle(pc) ||
              got.meta !== pendingEvidenceCopy(pc)
            ) {
              record(
                step,
                'R3',
                `pending row ${i}: ${JSON.stringify([got.title, got.meta])} ≠ ${JSON.stringify([pendingCaptureTitle(pc), pendingEvidenceCopy(pc)])}`,
              );
            }
          });
        }
        const n = expected.shots.length;
        const m = expected.captures.length;
        const wantHeader =
          n + m > 0
            ? `${n} analyzed ${n === 1 ? 'read' : 'reads'} · ${m} pending ${m === 1 ? 'clip' : 'clips'}`
            : null;
        if (snap.reads.header !== wantHeader)
          record(
            step,
            'R4',
            `header ${JSON.stringify(snap.reads.header)} ≠ ${JSON.stringify(wantHeader)}`,
          );
        const wantNote = m > 0;
        if (snap.reads.note !== wantNote || snap.reads.pill !== wantNote) {
          record(
            step,
            'R3',
            `note=${snap.reads.note} pill=${snap.reads.pill} for ${m} captures`,
          );
        }
        if (n === 0 && snap.reads.emptyCta === null)
          record(step, 'R2', 'empty list without the Analyze CTA');
        if (n > 0 && snap.reads.emptyCta !== null)
          record(step, 'R2', 'Analyze CTA shown beside rows');
      }
      if (retryThisStep) {
        if (snap.reads.kind !== 'loading')
          record(step, 'R8', `after Retry rendered ${snap.reads.kind}`);
      }
    }

    /* saved */
    if (snap.tab === 'saved') {
      const verified = store.savedDrills.filter(
        d => store.drillDetails[d.slug] !== undefined,
      );
      const held = store.savedDrills.length - verified.length;
      let wantStatus: SavedView['status'];
      if (store.savedStatus === 'loading' || store.savedStatus === 'idle')
        wantStatus = 'loading';
      else if (store.savedStatus === 'unconfigured')
        wantStatus = 'unconfigured';
      else if (store.savedStatus === 'error') wantStatus = 'error';
      else if (store.savedDrills.length === 0) wantStatus = 'empty';
      else if (verified.length === 0) wantStatus = 'all-held';
      else wantStatus = 'cards';
      if (snap.saved.status !== wantStatus) {
        record(
          step,
          'S2',
          `saved body ${snap.saved.status} ≠ ${wantStatus} (store ${store.savedStatus}, ${store.savedDrills.length} saved, ${verified.length} verified)`,
        );
      }
      if (wantStatus === 'unconfigured') {
        const wantConnect = world.localOnly;
        if ((snap.saved.connect !== null) !== wantConnect)
          record(
            step,
            'S2',
            `Connect account shown=${snap.saved.connect !== null} localOnly=${wantConnect}`,
          );
      }
      if (wantStatus === 'cards') {
        const got = snap.saved.cards.map(c => c.slug).join(',');
        const want = verified.map(d => d.slug).join(',');
        if (got !== want) record(step, 'S1', `cards ${got} ≠ ${want}`);
        if (snap.saved.countLabel !== `${verified.length} saved`)
          record(step, 'S1', `count label ${snap.saved.countLabel}`);
        if (snap.saved.heldNotice !== held > 0)
          record(
            step,
            'S1',
            `held notice=${snap.saved.heldNotice} held=${held}`,
          );
      } else if (snap.saved.cards.length > 0) {
        record(
          step,
          'S1',
          `${snap.saved.cards.length} cards rendered in ${snap.saved.status} body`,
        );
      }
      const busy = store.mutation !== 'idle';
      for (const card of snap.saved.cards) {
        if (card.busy !== busy)
          record(
            step,
            'S4',
            `card ${card.slug} busy=${card.busy} store.mutation=${store.mutation}`,
          );
      }
      if (
        (snap.saved.mutationError !== null) !==
        (store.mutationError !== null)
      ) {
        record(
          step,
          'S3',
          `banner=${snap.saved.mutationError !== null} store.mutationError=${JSON.stringify(store.mutationError)}`,
        );
      }
      if (dismissedMutationError && store.mutationError !== null)
        record(step, 'S3', 'DISMISS did not clear mutationError');
      const wantPlan =
        store.planStatus === 'ready' && store.currentPlan !== null;
      if ((snap.saved.plan !== null) !== wantPlan)
        record(
          step,
          'S2',
          `plan card=${snap.saved.plan !== null} planStatus=${store.planStatus}`,
        );
    }

    /* navigation effects */
    if (expectedRoute !== null && snap.route !== expectedRoute) {
      record(step, 'R7', `route ${snap.route} ≠ ${expectedRoute}`);
    }
    if (expectedDelete !== null) {
      const issued = fetchGate.issued.slice(fetchesBeforeStep);
      const hit = issued.find(
        e =>
          e.method === 'DELETE' &&
          e.path ===
            `/v1/me/saved-drills/${encodeURIComponent(expectedDelete!)}`,
      );
      if (!hit)
        record(
          step,
          'S5',
          `no DELETE for ${expectedDelete}; issued ${issued.map(e => `${e.method} ${e.path}`).join(',')}`,
        );
    }
    if (pressedBusyUnsave) {
      const issued = fetchGate.issued.slice(fetchesBeforeStep);
      if (issued.some(e => e.method === 'DELETE'))
        record(step, 'S4', 'busy Remove issued a DELETE');
    }
    if (expectedOpenUrl !== null) {
      if (world.linkingCanOpen) {
        if (openedUrls[openedUrls.length - 1] !== expectedOpenUrl)
          record(
            step,
            'S6',
            `openURL ${openedUrls[openedUrls.length - 1]} ≠ ${expectedOpenUrl}`,
          );
        if (snap.notice.visible)
          record(step, 'S6', 'notice shown although the URL opened');
      } else if (
        !snap.notice.visible ||
        snap.notice.title !== 'Video unavailable'
      ) {
        record(
          step,
          'S6',
          `notice=${JSON.stringify(snap.notice)} after unopenable URL`,
        );
      }
    }
    if (noticeDismissedThisStep && snap.notice.visible)
      record(step, 'S6', 'brand notice still visible after Got it');
    if (
      !expectedNotice &&
      !expectedOpenUrl &&
      snap.notice.visible &&
      !noticeVisibleBefore
    ) {
      record(step, 'S6', `unexpected brand notice ${snap.notice.title}`);
    }

    /* store latest-wins at quiescence */
    if (fetchGate.pending.length === 0 && world.configured) {
      const lists = fetchGate.issued.filter(
        e =>
          e.configVersion === fetchGate.configVersion &&
          e.method === 'GET' &&
          e.path === '/v1/me/saved-drills',
      );
      const last = lists[lists.length - 1];
      if (last) {
        if (last.settled === 'ok') {
          const got = store.savedDrills.map(d => d.slug).join(',');
          const want = (last.listedSlugs ?? []).join(',');
          if (store.savedStatus !== 'ready' || got !== want) {
            record(
              step,
              'S7',
              `quiescent store savedStatus=${store.savedStatus} drills=[${got}] but newest list (#${last.id}) answered [${want}]`,
            );
          }
        } else if (last.settled !== 'pending') {
          if (store.savedStatus !== 'error' || store.savedDrills.length !== 0) {
            record(
              step,
              'S7',
              `quiescent store savedStatus=${store.savedStatus} drills=[${store.savedDrills.map(d => d.slug).join(',')}] but newest list (#${last.id}) failed with ${last.settled}`,
            );
          }
        }
      }
    }
  };

  let noticeVisibleBefore = false;

  const press = (node: ReactTestInstance | null): boolean => {
    if (!node) return false;
    if (node.props.disabled) return false;
    const onPress = node.props.onPress as (() => void) | undefined;
    if (typeof onPress !== 'function') return false;
    onPress();
    return true;
  };

  /* ---- actions ---- */
  type ActionKind =
    | 'tab:reads'
    | 'tab:saved'
    | 'press:read'
    | 'press:emptyCta'
    | 'press:retry'
    | 'press:savedTryAgain'
    | 'press:explore'
    | 'press:connect'
    | 'press:plan'
    | 'press:unsave'
    | 'press:watch'
    | 'press:dismissError'
    | 'press:noticeDismiss'
    | 'nav:back'
    | 'nav:tabHome'
    | 'nav:tabLibrary'
    | 'db:settle'
    | 'db:settleAll'
    | 'fetch:settle'
    | 'fetch:settleAll'
    | 'db:insertShot'
    | 'db:insertCapture'
    | 'db:analyzeCapture'
    | 'server:addSaved'
    | 'server:removeSaved'
    | 'server:dropDetail'
    | 'server:togglePlan'
    | 'auth:flipLocalOnly'
    | 'store:toggleConfig'
    | 'linking:flip'
    | 'flush';

  // Weights favour actions that are currently enabled on screen (so the
  // interesting transitions get exercised) while keeping a small weight on
  // near-legal / no-op presses of absent controls.
  const chooseAction = (snap: Snapshot): ActionKind => {
    const on = (present: boolean, hi: number, lo = 1) => (present ? hi : lo);
    const table: [ActionKind, number][] = [
      ['tab:reads', on(snap.tabs.length > 0, 6, 2)],
      ['tab:saved', on(snap.tabs.length > 0, 7, 2)],
      ['press:read', on(snap.reads.rows.length > 0, 10)],
      ['press:emptyCta', on(snap.reads.emptyCta !== null, 5)],
      ['press:retry', on(snap.reads.retry !== null, 8)],
      ['press:savedTryAgain', on(snap.saved.tryAgain !== null, 6)],
      ['press:explore', on(snap.saved.explore !== null, 4)],
      ['press:connect', on(snap.saved.connect !== null, 4)],
      ['press:plan', on(snap.saved.plan !== null, 4)],
      ['press:unsave', on(snap.saved.unsave.length > 0, 12)],
      ['press:watch', on(snap.saved.watch.length > 0, 8)],
      ['press:dismissError', on(snap.saved.mutationError !== null, 8)],
      ['press:noticeDismiss', on(snap.noticeDismiss !== null, 8)],
      ['nav:back', snap.stackDepth > 1 ? 10 : 1],
      ['nav:tabHome', 3],
      ['nav:tabLibrary', 4],
      ['db:settle', dbGate.pending.length > 0 ? 12 : 1],
      ['db:settleAll', dbGate.pending.length > 0 ? 6 : 1],
      ['fetch:settle', fetchGate.pending.length > 0 ? 12 : 1],
      ['fetch:settleAll', fetchGate.pending.length > 0 ? 6 : 1],
      ['db:insertShot', 4],
      ['db:insertCapture', 3],
      ['db:analyzeCapture', 1],
      ['server:addSaved', 3],
      ['server:removeSaved', 2],
      ['server:dropDetail', 1],
      ['server:togglePlan', 1],
      ['auth:flipLocalOnly', 1],
      ['store:toggleConfig', 1],
      ['linking:flip', 1],
      ['flush', 3],
    ];
    return rng.weighted(table);
  };

  const perform = async (kind: ActionKind, snap: Snapshot): Promise<string> => {
    switch (kind) {
      case 'tab:reads':
      case 'tab:saved': {
        const want = kind === 'tab:reads' ? 'Reads' : 'Saved drills';
        const seg = snap.tabs.find(t => flattenText(t) === want) ?? null;
        if (press(seg)) return kind;
        return snap.reads.kind === 'loading'
          ? `${kind}(hidden-by-loading)`
          : `${kind}(absent)`;
      }
      case 'press:read': {
        if (snap.reads.rows.length === 0) return 'press:read(none)';
        const i = rng.int(0, snap.reads.rows.length - 1);
        const row = snap.reads.rows[i]!;
        const shot = expected.kind === 'list' ? expected.shots[i] : undefined;
        if (press(row.node)) {
          expectLoadThisStep = false;
          if (shot)
            expectedRoute = `Result${JSON.stringify({ analysisId: shot.id })}`;
          return `press:read[${i}]`;
        }
        return `press:read[${i}](disabled)`;
      }
      case 'press:emptyCta':
        if (press(snap.reads.emptyCta)) {
          expectedRoute = 'Analyze';
          return kind;
        }
        return `${kind}(absent)`;
      case 'press:retry':
        if (press(snap.reads.retry)) {
          retryThisStep = true;
          expectLoadThisStep = true;
          expected = { kind: 'loading' };
          return kind;
        }
        return `${kind}(absent)`;
      case 'press:savedTryAgain':
        return press(snap.saved.tryAgain) ? kind : `${kind}(absent)`;
      case 'press:explore':
        if (press(snap.saved.explore)) {
          expectedRoute = 'DrillLibrary';
          return kind;
        }
        return `${kind}(absent)`;
      case 'press:connect':
        if (press(snap.saved.connect)) {
          expectedRoute = 'ConnectAccount';
          return kind;
        }
        return `${kind}(absent)`;
      case 'press:plan': {
        const plan = useTrainingStore.getState().currentPlan;
        if (press(snap.saved.plan)) {
          if (plan)
            expectedRoute = `Result${JSON.stringify({ analysisId: plan.sourceShotId })}`;
          return kind;
        }
        return `${kind}(absent)`;
      }
      case 'press:unsave': {
        if (snap.saved.unsave.length === 0) return `${kind}(none)`;
        const i = rng.int(0, snap.saved.unsave.length - 1);
        const node = snap.saved.unsave[i]!;
        const slug = snap.saved.cards[i]?.slug ?? null;
        if (node.props.disabled) {
          // A busy card's button is disabled; a real tap does nothing.
          pressedBusyUnsave = true;
          return `press:unsave[${i}](busy)`;
        }
        press(node);
        expectedDelete = slug;
        return `press:unsave[${i}:${slug}]`;
      }
      case 'press:watch': {
        if (snap.saved.watch.length === 0) return `${kind}(none)`;
        const i = rng.int(0, snap.saved.watch.length - 1);
        const node = snap.saved.watch[i]!;
        const card = snap.saved.cards.find(c =>
          c.node.findAllByType(PressableScale).includes(node),
        );
        const detail = card
          ? useTrainingStore.getState().drillDetails[card.slug]
          : undefined;
        const media = detail?.instructionalMedia.find(m =>
          m.kind === 'hosted'
            ? new Date(m.expiresAt).getTime() > Date.now()
            : true,
        );
        if (press(node)) {
          if (media)
            expectedOpenUrl =
              media.kind === 'hosted' ? media.playbackUrl : media.sourceUrl;
          expectedNotice = !world.linkingCanOpen;
          return `press:watch[${i}]`;
        }
        return `press:watch[${i}](disabled)`;
      }
      case 'press:dismissError':
        if (press(snap.saved.mutationError)) {
          dismissedMutationError = true;
          return kind;
        }
        return `${kind}(absent)`;
      case 'press:noticeDismiss':
        if (press(snap.noticeDismiss)) {
          noticeDismissedThisStep = true;
          return kind;
        }
        return `${kind}(absent)`;
      case 'nav:back':
        if (snap.stackDepth > 1 && navRef.isReady() && navRef.canGoBack()) {
          navRef.goBack();
          expectLoadThisStep = true;
          return kind;
        }
        return `${kind}(root)`;
      case 'nav:tabHome':
        if (press(snap.tabBar.home)) return kind;
        return `${kind}(absent)`;
      case 'nav:tabLibrary':
        if (press(snap.tabBar.library)) {
          if (!snap.focused && snap.stackDepth === 1) expectLoadThisStep = true;
          return kind;
        }
        return `${kind}(absent)`;
      case 'db:settle': {
        if (dbGate.pending.length === 0) return `${kind}(none)`;
        const which = rng.pick(['oldest', 'newest', 'random'] as const);
        const entry =
          which === 'oldest'
            ? dbGate.pending[0]!
            : which === 'newest'
              ? dbGate.pending[dbGate.pending.length - 1]!
              : rng.pick(dbGate.pending);
        const outcome = rng.chance(0.75) ? 'ok' : 'fail';
        settleLoad(entry, outcome);
        return `db:settle[${which}#${entry.id}:${entry.table}:${outcome}]`;
      }
      case 'db:settleAll': {
        if (dbGate.pending.length === 0) return `${kind}(none)`;
        const ids: string[] = [];
        while (dbGate.pending.length > 0) {
          const entry = dbGate.pending[0]!;
          const outcome = rng.chance(0.9) ? 'ok' : 'fail';
          ids.push(`${entry.id}:${outcome}`);
          settleLoad(entry, outcome);
        }
        return `db:settleAll[${ids.join(',')}]`;
      }
      case 'fetch:settle': {
        if (fetchGate.pending.length === 0) return `${kind}(none)`;
        const which = rng.pick(['oldest', 'newest', 'random'] as const);
        const entry =
          which === 'oldest'
            ? fetchGate.pending[0]!
            : which === 'newest'
              ? fetchGate.pending[fetchGate.pending.length - 1]!
              : rng.pick(fetchGate.pending);
        const outcome = rng.weighted<FetchOutcome>([
          ['ok', 14],
          ['500', 2],
          ['404', 1],
          ['401', 1],
          ['network', 2],
          ['garbage', 1],
        ]);
        fetchGate.settle(entry, outcome);
        return `fetch:settle[${which}#${entry.id}:${entry.method} ${entry.path}:${outcome}]`;
      }
      case 'fetch:settleAll': {
        if (fetchGate.pending.length === 0) return `${kind}(none)`;
        const ids: string[] = [];
        // Settle in issue order, then flush and repeat: a settled list
        // request fans out into detail requests that must settle too.
        for (
          let round = 0;
          round < 6 && fetchGate.pending.length > 0;
          round += 1
        ) {
          while (fetchGate.pending.length > 0) {
            const entry = fetchGate.pending[0]!;
            const outcome: FetchOutcome = rng.chance(0.92) ? 'ok' : '500';
            ids.push(`${entry.id}:${outcome}`);
            fetchGate.settle(entry, outcome);
          }
          await flush();
        }
        return `fetch:settleAll[${ids.join(',')}]`;
      }
      case 'db:insertShot': {
        const shot = makeShot(
          rng,
          world,
          rng.chance(0.15) ? OTHER_OWNER : world.owner,
        );
        world.shots.push(shot);
        insertShot(shot);
        return `db:insertShot[${shot.resultKind}${shot.owner === world.owner ? '' : ':other'}${shot.source === 'real' ? '' : ':fixture'}]`;
      }
      case 'db:insertCapture': {
        const capture = makeCapture(
          rng,
          world,
          rng.chance(0.15) ? OTHER_OWNER : world.owner,
        );
        world.captures.push(capture);
        insertCapture(capture);
        return `db:insertCapture[${capture.evidenceStatus}${capture.owner === world.owner ? '' : ':other'}]`;
      }
      case 'db:analyzeCapture': {
        const open = world.captures.filter(c => c.status === 'awaiting_model');
        if (open.length === 0) return `${kind}(none)`;
        const capture = rng.pick(open);
        capture.status = 'analyzed';
        dbGate.run(
          `UPDATE local_capture SET status = 'analyzed' WHERE owner_key = ? AND id = ?`,
          [capture.owner, capture.id],
        );
        return `db:analyzeCapture[${capture.id}]`;
      }
      case 'server:addSaved': {
        const drill = makeDrill(rng, world);
        fetchGate.server.saved.push(drill);
        return `server:addSaved[${drill.slug}${drill.detail ? '' : ':held'}]`;
      }
      case 'server:removeSaved': {
        if (fetchGate.server.saved.length === 0) return `${kind}(none)`;
        const drill = rng.pick(fetchGate.server.saved);
        fetchGate.server.saved = fetchGate.server.saved.filter(
          d => d !== drill,
        );
        return `server:removeSaved[${drill.slug}]`;
      }
      case 'server:dropDetail': {
        const withDetail = fetchGate.server.saved.filter(d => d.detail);
        if (withDetail.length === 0) return `${kind}(none)`;
        const drill = rng.pick(withDetail);
        drill.detail = null;
        return `server:dropDetail[${drill.slug}]`;
      }
      case 'server:togglePlan':
        fetchGate.server.plan = fetchGate.server.plan
          ? null
          : {
              id: uuidFrom(rng, 'plan', 2),
              sourceShotId: uuidFrom(rng, 'plan-shot', 2),
              shotType: rng.pick(STROKES),
              priorityCheckpoint: 'contact_point',
              priorityDirection: 'late',
              items: [],
            };
        return `server:togglePlan[${fetchGate.server.plan ? 'on' : 'off'}]`;
      case 'auth:flipLocalOnly': {
        world.localOnly = !world.localOnly;
        const session = useAuthStore.getState().session;
        useAuthStore.setState({
          session: session ? { ...session, localOnly: world.localOnly } : null,
        });
        return `auth:flipLocalOnly[${world.localOnly}]`;
      }
      case 'store:toggleConfig':
        world.configured = !world.configured;
        if (world.configured) configure();
        else unconfigure();
        return `store:toggleConfig[${world.configured ? 'configured' : 'unconfigured'}]`;
      case 'linking:flip':
        world.linkingCanOpen = !world.linkingCanOpen;
        return `linking:flip[${world.linkingCanOpen}]`;
      case 'flush':
        return kind;
    }
  };

  /* ---- main loop ---- */
  let step = 0;
  const initialSnap = fatal ? null : readSnapshot(renderer, navRef);
  if (initialSnap) {
    wasFocused = initialSnap.focused;
    expectLoadThisStep = initialSnap.focused;
    absorbNewLoads(0, initialSnap);
    checkInvariants(0, initialSnap, 'mount');
    steps.push({
      step: 0,
      action: `mount[tab=${initialTab},owner=${signedIn ? 'signed-in' : 'guest'},cfg=${world.configured}]`,
      view: summarizeView(initialSnap),
      violations: violations
        .filter(v => v.step === 0)
        .map(v => `${v.invariant}: ${v.detail}`),
    });
    noticeVisibleBefore = initialSnap.notice.visible;
  }
  const limit =
    options.prefix !== undefined ? Math.min(options.prefix, length) : length;
  if (!fatal) {
    for (step = 1; step <= limit; step += 1) {
      const before = readSnapshot(renderer, navRef);
      const kind = chooseAction(before);
      expectLoadThisStep = false;
      retryThisStep = false;
      expectedRoute = null;
      expectedDelete = null;
      expectedOpenUrl = null;
      expectedNotice = false;
      noticeDismissedThisStep = false;
      dismissedMutationError = false;
      pressedBusyUnsave = false;
      fetchesBeforeStep = fetchGate.issued.length;
      noticeVisibleBefore = before.notice.visible;
      let label = kind as string;
      try {
        await act(async () => {
          label = await perform(kind, before);
        });
        await flush();
      } catch (error) {
        fatal = `step ${step} ${label}: ${String(error)}`;
        steps.push({
          step,
          action: label,
          view: 'THROWN',
          violations: [fatal],
        });
        break;
      }
      const after = readSnapshot(renderer, navRef);
      // Blur → the screen's focus cleanup bumps the request id: every load
      // still in flight is dropped whichever way it settles.
      if (wasFocused && !after.focused) {
        for (const load of loads)
          if (load.outcome === 'pending') load.blurred = true;
      }
      if (!wasFocused && after.focused) expectLoadThisStep = true;
      wasFocused = after.focused;
      absorbNewLoads(step, after);
      checkInvariants(step, after, label);
      const stepViolations = violations
        .filter(v => v.step === step)
        .map(v => `${v.invariant}: ${v.detail}`);
      steps.push({
        step,
        action: label,
        view: summarizeView(after),
        violations: stepViolations,
      });
    }
  }

  /* ---- teardown: unmount, then late settles must be inert ---- */
  if (!fatal) {
    try {
      await act(async () => {
        renderer.unmount();
      });
      await flush();
      const lateDb = [...dbGate.pending];
      for (const entry of lateDb)
        dbGate.settle(entry, rng.chance(0.5) ? 'ok' : 'fail');
      const lateFetch = [...fetchGate.pending];
      for (const entry of lateFetch)
        fetchGate.settle(entry, rng.chance(0.5) ? 'ok' : 'network');
      await flush();
      if (consoleBuffer.length > 0) {
        record(step, 'G1', `after unmount: ${consoleBuffer.join(' || ')}`);
        consoleBuffer.length = 0;
      }
    } catch (error) {
      fatal = `teardown: ${String(error)}`;
    }
  } else {
    try {
      await act(async () => {
        renderer?.unmount();
      });
    } catch {
      // The sequence already failed; keep the original error.
    }
  }
  console.error = originalError;
  console.warn = originalWarn;
  canOpenSpy.mockRestore();
  openSpy.mockRestore();
  unconfigure();
  // The RN preset's native-module mocks are jest.fn()s that record every
  // call (Animated configs etc.) for the life of the test file; drop them so
  // a long campaign does not grow the heap by a few MB per sequence.
  jest.clearAllMocks();

  const trace = steps.map(s => `${s.action} => ${s.view}`).join('\n');
  return {
    seed,
    length: limit,
    world: {
      owner: signedIn ? 'signed-in' : 'guest',
      localOnly: !signedIn,
      configured: initiallyConfigured,
      initialTab,
      seededShots,
      seededCaptures,
      seededDrills,
    },
    outcome: fatal ? 'ERROR' : violations.length > 0 ? 'BROKEN' : 'HELD',
    violations,
    error: fatal,
    traceHash: hash32(trace).toString(16).padStart(8, '0'),
    steps: keepSteps ? steps : [],
    durationMs: Date.now() - started,
    loadsIssued: loads.length,
    fetchesIssued: fetchGate.issued.length,
    observations,
  };
}

/**
 * Shrinks a failing seed to the shortest action prefix that still violates
 * the same invariant. Sequences are prefix-stable (the generator only reads
 * the seed and the observable state), so a prefix is a faithful minimization.
 */
export async function minimize(
  seed: number,
  invariant: string,
): Promise<{ prefix: number; result: SequenceResult }> {
  const full = await runSequence(seed);
  const failsAt = (r: SequenceResult) =>
    r.violations.some(v => v.invariant === invariant);
  if (!failsAt(full)) return { prefix: full.length, result: full };
  let lo = 0;
  let hi = full.length;
  let best = full;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const attempt = await runSequence(seed, { prefix: mid });
    if (failsAt(attempt)) {
      best = attempt;
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return { prefix: best.length, result: best };
}

export { fetchGate, dbGate };
