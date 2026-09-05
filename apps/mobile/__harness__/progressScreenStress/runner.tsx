import React from 'react';
import { Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  NavigationContainer,
  createNavigationContainerRef,
  type NavigationState,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { ProgressScreen } from '../../src/screens/ProgressScreen';
import { StreakCalendarScreen } from '../../src/screens/StreakCalendarScreen';
import { PremiumTabBar } from '../../src/navigation/PremiumTabBar';
import type {
  MainTabParams,
  RootStackParams,
} from '../../src/navigation/params';
import { getDb } from '../../src/data/db';
import {
  markCaptureAnalyzed,
  saveAnalysis,
  saveLocalOnlyAnalysis,
  savePendingCapture,
} from '../../src/data/repository';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  useApiSessionStore,
  type ApiSession,
} from '../../src/account/apiSession';
import { useConsistencyStore } from '../../src/consistency/store';
import { assertCapturedClip } from '../../src/camera/capture';

import { dbMockState, openFreshDatabase, requireRawDb } from './dbMock';
import {
  analysisFor,
  guidedClip,
  importedClip,
  type CaptureSpec,
  type ScoredFactSpec,
} from './fixtures';
import type { Action, ApiMode, Scenario } from './generator';
import {
  deviceTimeZone,
  expectedPractice,
  expectedTechnique,
  latestPracticeSetIds,
  type RangeKey,
} from './model';

/**
 * Drives the REAL ProgressScreen mounted as the `Performance` tab of a real
 * bottom-tab navigator (with the production PremiumTabBar) inside a real
 * native-stack root that also hosts the real StreakCalendar screen and a
 * Result route that records its params — the same shape as RootNavigator.
 * Only native modules (SQLite, safe-area, gradient, reanimated) and `fetch`
 * are replaced, so navigation, zustand stores, hooks and repository code run
 * for real.
 *
 * Invariants checked after EVERY action (see model.ts for the data rules):
 *  I1  No render error, no unhandled rejection, no console.error.
 *  I2  While the Performance tab is focused the screen is in exactly one of
 *      {loading, error, content}; loading never persists once storage and
 *      network have settled.
 *  I3  Exactly one section tab and exactly one range tab carry
 *      accessibilityState.selected, and they are the ones the user last
 *      chose — selection survives blur/focus, navigation and error/retry.
 *  I4  Technique key statistics equal the oracle for the facts the screen
 *      loaded at its most recent focus (T1–T5, S1).
 *  I5  Practice key statistics equal the oracle for the captures the screen
 *      loaded at its most recent focus (P1–P4, S1); technique and practice
 *      never bleed into each other (P2).
 *  I6  A storage fault during a load yields the error state (never fabricated
 *      empty numbers); a retry after the fault clears yields content again.
 *  I7  Opening the consistency card lands on StreakCalendar; opening an
 *      attempt lands on Result with an analysisId that belongs to the latest
 *      practice set; back returns to the Performance tab.
 *  I8  Canonical-progress outcomes (signed out / ok / 500 / malformed /
 *      network failure) never change the local statistics and never produce
 *      the error state.
 *  I9  The observation trace is a pure function of the seed (checked by the
 *      determinism test in the suite).
 *
 * KNOWN_DEFECTS lists invariant ids whose violation is an already-reported
 * product defect (pinned by a `test.failing` repro in the suite). Hits are
 * recorded per seed as `known_defect` — never silently passed — but do not
 * stop the run, so every other invariant is still checked for that seed.
 */

/** F1: ProgressScreen claims "First measured period on this device."
 * whenever the immediately preceding window holds zero verified captures,
 * even when older verified captures exist on the device (ProgressScreen.tsx
 * `previousCaptureCount === 0` branch). */
export const KNOWN_DEFECTS: ReadonlySet<string> = new Set(['I5-first-period']);

export const SECTION_LABELS = {
  technique: 'technique progress',
  practice: 'practice progress',
} as const;
export const RANGE_LABELS: Record<RangeKey, string> = {
  '7d': '7 days range',
  '28d': '4 weeks range',
  '90d': '90 days range',
};
const LOADING_LABEL = 'Loading measured progress…';
const ERROR_TITLE = 'Progress couldn’t load';
const FIRST_PERIOD_COPY = 'First measured period on this device.';

const Stack = createNativeStackNavigator<RootStackParams>();
const Tabs = createBottomTabNavigator<MainTabParams>();

function Placeholder(props: { name: string }) {
  return (
    <View>
      <Text>{`stress-placeholder:${props.name}`}</Text>
    </View>
  );
}
const HomeStub = () => <Placeholder name="Home" />;
const LibraryStub = () => <Placeholder name="Library" />;
const AddStub = () => <Placeholder name="Add" />;
const SettingsStub = () => <Placeholder name="Settings" />;

function MainTabs() {
  return (
    <Tabs.Navigator
      tabBar={props => <PremiumTabBar {...props} />}
      screenOptions={{ headerShown: false, tabBarHideOnKeyboard: true }}
    >
      <Tabs.Screen name="Home" component={HomeStub} />
      <Tabs.Screen name="Library" component={LibraryStub} />
      <Tabs.Screen name="Add" component={AddStub} />
      <Tabs.Screen name="Performance" component={ProgressScreen} />
      <Tabs.Screen name="Settings" component={SettingsStub} />
    </Tabs.Navigator>
  );
}

export interface ResultVisit {
  analysisId: string;
}

function makeResultRecorder(sink: ResultVisit[]) {
  return function ResultRecorder({
    route,
  }: NativeStackScreenProps<RootStackParams, 'Result'>) {
    sink.push({ analysisId: route.params.analysisId });
    return <Placeholder name={`Result:${route.params.analysisId}`} />;
  };
}

export interface StepRecord {
  step: number;
  action: string;
  /** What the harness actually did (a near-legal action may be a no-op). */
  effect: string;
  /** Digest of every observable the invariants read. */
  observed: string;
}

export interface FailureRecord {
  step: number;
  action: string;
  invariant: string;
  message: string;
}

export interface ScenarioOutcome {
  seed: number;
  length: number;
  status: 'held' | 'known_defect' | 'broken';
  steps: StepRecord[];
  failure: FailureRecord | null;
  /** First hit per KNOWN_DEFECTS invariant id. */
  knownDefectHits: FailureRecord[];
  /** Counts that show the campaign really exercised the surface. */
  counters: {
    loads: number;
    navigations: number;
    errorStates: number;
    contentChecks: number;
    dbQueries: number;
    fetches: number;
  };
}

export interface RunOptions {
  /** Stop at the first invariant failure (campaign) or run every action
   * (trace comparison for the determinism check). */
  stopOnFailure: boolean;
}

class InvariantViolation extends Error {
  constructor(
    readonly invariant: string,
    message: string,
  ) {
    super(message);
    this.name = 'InvariantViolation';
  }
}

interface ModelState {
  section: 'technique' | 'practice';
  range: RangeKey;
  /** Records in the database (what the next focus will load). */
  dbFacts: ScoredFactSpec[];
  dbCaptures: CaptureSpec[];
  /** Records the screen loaded at its most recent successful focus. */
  shownFacts: ScoredFactSpec[];
  shownCaptures: CaptureSpec[];
  /** Whether the most recent load ended in the error state. */
  showingError: boolean;
  api: ApiMode;
  dbFault: boolean;
}

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

function allWithProp(
  renderer: Renderer,
  predicate: (props: Record<string, unknown>) => boolean,
): Instance[] {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && predicate(node.props),
  );
}

function pressablesByLabel(renderer: Renderer, label: string): Instance[] {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
}

function byTestId(renderer: Renderer, testID: string): Instance | null {
  const [node] = allWithProp(renderer, props => props.testID === testID);
  return node ?? null;
}

/** Outermost pressable element per testID (Pressable does not forward
 * `onPress` to its host view, so pressing goes through the composite). */
function pressablesByTestId(
  renderer: Renderer,
  matches: (testID: string) => boolean,
): Instance[] {
  const seen = new Set<string>();
  return renderer.root
    .findAll(
      node =>
        typeof node.props.testID === 'string' &&
        matches(node.props.testID) &&
        typeof node.props.onPress === 'function',
    )
    .filter(node => {
      const id = String(node.props.testID);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

function textContent(renderer: Renderer): string[] {
  const texts: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || node === undefined || typeof node === 'boolean')
      return;
    if (typeof node === 'string' || typeof node === 'number') {
      texts.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const tree = node as { children?: unknown[] };
    if (tree.children) tree.children.forEach(walk);
  };
  walk(renderer.toJSON());
  return texts;
}

function routeSummary(state: NavigationState | undefined): string {
  if (!state) return 'unmounted';
  const route = state.routes[state.index];
  if (!route) return 'empty';
  const nested = route.state as NavigationState | undefined;
  return nested ? `${route.name}>${routeSummary(nested)}` : route.name;
}

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

interface HarnessContext {
  renderer: Renderer;
  navRef: ReturnType<typeof createNavigationContainerRef<RootStackParams>>;
  resultVisits: ResultVisit[];
  fetchState: { pending: number; calls: number };
  consoleErrors: string[];
}

function focusedOnPerformance(ctx: HarnessContext): boolean {
  return routeSummary(ctx.navRef.getRootState()) === 'Tabs>Performance';
}

type ViewKind = 'loading' | 'error' | 'content' | 'none';

function viewKind(ctx: HarnessContext): ViewKind {
  const loading = allWithProp(
    ctx.renderer,
    props =>
      typeof props.accessibilityLabel === 'string' &&
      props.accessibilityLabel.startsWith(LOADING_LABEL),
  ).length;
  const error = textContent(ctx.renderer).includes(ERROR_TITLE) ? 1 : 0;
  const content = pressablesByLabel(
    ctx.renderer,
    SECTION_LABELS.technique,
  ).length;
  const kinds = [
    loading && 'loading',
    error && 'error',
    content && 'content',
  ].filter(Boolean) as ViewKind[];
  if (kinds.length > 1) {
    throw new InvariantViolation(
      'I2',
      `ProgressScreen shows ${kinds.join('+')} at the same time`,
    );
  }
  return kinds[0] ?? 'none';
}

async function settle(ctx: HarnessContext): Promise<void> {
  let previous = '';
  let stable = 0;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    await tick();
    const busy = dbMockState.pending > 0 || ctx.fetchState.pending > 0;
    const digest = JSON.stringify(ctx.renderer.toJSON());
    if (!busy && digest === previous) {
      stable += 1;
      if (stable >= 2) return;
    } else {
      stable = 0;
    }
    previous = digest;
  }
  throw new InvariantViolation(
    'I2',
    `render did not settle after 80 ticks (dbPending=${dbMockState.pending}, fetchPending=${ctx.fetchState.pending})`,
  );
}

const API_BASE = 'https://stress.invalid';

function sessionFor(mode: ApiMode): ApiSession | null {
  if (mode === 'signed_out') return null;
  return {
    apiBaseUrl: API_BASE,
    bearerToken: 'stress-bearer',
    canonicalAppUserId: '11111111-2222-4333-8444-555555555555',
    provider: 'apple',
  };
}

function okProgressBody(): string {
  return JSON.stringify({
    series: [
      {
        day: '2026-08-30',
        shot_type: 'forehand_drive',
        scoring_model_version: 'scoring-1',
        shot_count: 3,
        avg_score: 68,
        best_score: 74,
      },
    ],
    improving: [{ checkpoint: 'contact_position', delta: 0.4 }],
    needsAttention: [{ checkpoint: 'balance', avg: 5.1 }],
    streak: {
      currentDays: 2,
      longestDays: 5,
      practicedToday: false,
      lastPracticeDate: '2026-08-30',
    },
  });
}

function okRankBody(): string {
  return JSON.stringify({
    tier: 'bronze',
    points: 120,
    nextTier: 'silver',
    pointsToNextTier: 80,
    asOf: '2026-09-04T00:00:00.000Z',
  });
}

function installFetch(ctx: HarnessContext, modeRef: { mode: ApiMode }): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    ctx.fetchState.calls += 1;
    ctx.fetchState.pending += 1;
    try {
      await Promise.resolve();
      const mode = modeRef.mode;
      if (mode === 'network_fail') {
        throw new TypeError('Network request failed');
      }
      if (mode === 'http_500') {
        return new Response('{"error":"internal"}', {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (mode === 'malformed') {
        return new Response('{"series":"nope"', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const body = url.endsWith('/v1/progress')
        ? okProgressBody()
        : url.endsWith('/v1/rank')
          ? okRankBody()
          : '{}';
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } finally {
      ctx.fetchState.pending -= 1;
    }
  }) as typeof fetch;
}

/** The injected fault models ProgressScreen's READ failing; the harness's
 * own fixture writes stand for other flows and always reach storage. */
async function withStorageAvailable<T>(work: () => Promise<T>): Promise<T> {
  const fault = dbMockState.fault;
  dbMockState.fault = false;
  try {
    return await work();
  } finally {
    dbMockState.fault = fault;
  }
}

async function writeFact(fact: ScoredFactSpec): Promise<void> {
  const analysis = analysisFor(fact);
  await withStorageAvailable(async () => {
    if (fact.overallScore === null) {
      await saveLocalOnlyAnalysis(getDb(), analysis);
    } else {
      await saveAnalysis(getDb(), analysis, `permit-${fact.id}`);
    }
  });
}

async function writeCapture(capture: CaptureSpec): Promise<void> {
  await withStorageAvailable(() => writeCaptureRow(capture));
}

async function writeCaptureRow(capture: CaptureSpec): Promise<void> {
  const db = getDb();
  switch (capture.kind) {
    case 'guided': {
      const clip = assertCapturedClip(
        guidedClip(capture),
        'automatic_pose_trigger',
      );
      await savePendingCapture(db, capture.id, capture.shotType, clip);
      await markCaptureAnalyzed(db, capture.id);
      return;
    }
    case 'imported_measured':
    case 'imported_unmeasured': {
      const clip = assertCapturedClip(
        importedClip(capture, capture.kind === 'imported_measured'),
        'imported_video',
      );
      await savePendingCapture(
        db,
        capture.id,
        'unrecognized',
        clip,
        capture.shotType,
      );
      return;
    }
    case 'metadata_mismatch': {
      const clip = guidedClip(capture);
      await savePendingCapture(db, capture.id, capture.shotType, clip);
      // An older build rewrote the row's columns without touching the
      // payload: the two now disagree and the row must not count.
      requireRawDb()
        .prepare(
          `UPDATE local_capture SET duration_ms = duration_ms + 500 WHERE id = ?`,
        )
        .run(capture.id);
      return;
    }
    case 'corrupt_payload':
    case 'legacy_no_payload': {
      const clip = guidedClip(capture);
      requireRawDb()
        .prepare(
          `INSERT INTO local_capture
             (owner_key, id, uri, shot_type, captured_at, duration_ms, fps, width, height, status, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'analyzed', ?)`,
        )
        .run(
          GUEST_DATA_OWNER,
          capture.id,
          clip.uri,
          capture.shotType,
          capture.capturedAtIso,
          clip.durationMs,
          clip.fps,
          clip.width,
          clip.height,
          capture.kind === 'corrupt_payload'
            ? '{"captureMode":"automatic_pose_trigger",'
            : null,
        );
      return;
    }
    default: {
      const exhaustive: never = capture.kind;
      throw new Error(`unknown capture kind ${String(exhaustive)}`);
    }
  }
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'section':
      return `section:${action.section}`;
    case 'range':
      return `range:${action.range}`;
    case 'double_press':
      return `double_press:${action.target}`;
    case 'switch_tab':
      return `switch_tab:${action.tab}`;
    case 'add_fact':
      return `add_fact:${action.fact.id}:${action.fact.shotType}:${action.fact.overallScore ?? 'abstain'}:${action.fact.capturedAtIso}:${action.fact.versions.scoringModelVersion}:${action.fact.sessionId ?? '-'}`;
    case 'add_capture':
      return `add_capture:${action.capture.id}:${action.capture.kind}:${action.capture.capturedAtIso}`;
    case 'api':
      return `api:${action.mode}`;
    case 'db_fault':
      return `db_fault:${action.on ? 'on' : 'off'}`;
    default:
      return action.kind;
  }
}

function statLabel(ctx: HarnessContext, testID: string): string {
  const node = byTestId(ctx.renderer, testID);
  if (!node) {
    throw new InvariantViolation('I4', `missing stat row ${testID}`);
  }
  const label = node.props.accessibilityLabel;
  if (typeof label !== 'string') {
    throw new InvariantViolation('I4', `stat row ${testID} has no label`);
  }
  return label.replace(/, trending (up|down)$/, '');
}

function expectLabel(
  invariant: string,
  ctx: HarnessContext,
  testID: string,
  title: string,
  value: string,
  prior: string | null,
): void {
  const actual = statLabel(ctx, testID);
  const wanted =
    prior === null
      ? `${title}: ${value}`
      : `${title}: ${value}. Prior period ${prior}`;
  if (actual !== wanted) {
    throw new InvariantViolation(
      invariant,
      `${testID}: rendered "${actual}" but oracle says "${wanted}"`,
    );
  }
}

function selectedTabLabels(
  ctx: HarnessContext,
  labels: readonly string[],
): string[] {
  const selected: string[] = [];
  for (const label of labels) {
    // Host nodes only: the ones assistive tech actually sees.
    const nodes = allWithProp(
      ctx.renderer,
      props =>
        props.accessibilityLabel === label && props.accessibilityRole === 'tab',
    );
    if (nodes.length !== 1) {
      throw new InvariantViolation(
        'I3',
        `expected exactly one tab labelled "${label}", found ${nodes.length}`,
      );
    }
    const state = nodes[0]!.props.accessibilityState as
      { selected?: boolean } | undefined;
    if (state?.selected === true) selected.push(label);
  }
  return selected;
}

function observe(ctx: HarnessContext, model: ModelState): string {
  const route = routeSummary(ctx.navRef.getRootState());
  const view = focusedOnPerformance(ctx) ? viewKind(ctx) : 'blurred';
  const parts: string[] = [`route=${route}`, `view=${view}`];
  if (view === 'content') {
    const labels = [
      ...Object.values(SECTION_LABELS),
      ...Object.values(RANGE_LABELS),
    ];
    parts.push(`selected=${selectedTabLabels(ctx, labels).join('|')}`);
    for (const testID of [
      'technique-stat-reps',
      'technique-stat-avg',
      'technique-stat-best',
      'technique-stat-days',
      'practice-stat-captures',
      'practice-stat-active-days',
      'practice-stat-pose-tracked',
    ]) {
      const node = byTestId(ctx.renderer, testID);
      if (node)
        parts.push(`${testID}=${String(node.props.accessibilityLabel)}`);
    }
    const attempts = allWithProp(
      ctx.renderer,
      props =>
        typeof props.testID === 'string' &&
        props.testID.startsWith('practice-set-attempt-'),
    ).map(node =>
      String(node.props.testID).slice('practice-set-attempt-'.length),
    );
    parts.push(`attempts=${attempts.sort().join('|')}`);
    parts.push(
      `firstPeriodCopy=${textContent(ctx.renderer).includes(FIRST_PERIOD_COPY)}`,
    );
  }
  parts.push(
    `results=${ctx.resultVisits.map(visit => visit.analysisId).join('|')}`,
  );
  parts.push(
    `model=${model.section}/${model.range}/${model.showingError ? 'error' : 'ok'}`,
  );
  return parts.join(' ');
}

function checkInvariants(
  ctx: HarnessContext,
  model: ModelState,
  nowMs: number,
  timeZone: string,
  counters: ScenarioOutcome['counters'],
): void {
  if (ctx.consoleErrors.length > 0) {
    throw new InvariantViolation(
      'I1',
      `console.error: ${ctx.consoleErrors[0]}`,
    );
  }
  if (!focusedOnPerformance(ctx)) return;
  const view = viewKind(ctx);
  if (view === 'loading' || view === 'none') {
    throw new InvariantViolation('I2', `screen settled in "${view}" state`);
  }
  if (model.showingError) {
    if (view !== 'error') {
      throw new InvariantViolation(
        'I6',
        `storage fault during load but screen shows ${view}`,
      );
    }
    counters.errorStates += 1;
    return;
  }
  if (view !== 'content') {
    throw new InvariantViolation(
      'I6',
      `expected content, screen shows ${view}`,
    );
  }
  counters.contentChecks += 1;

  const sections = selectedTabLabels(ctx, Object.values(SECTION_LABELS));
  if (sections.length !== 1 || sections[0] !== SECTION_LABELS[model.section]) {
    throw new InvariantViolation(
      'I3',
      `selected sections [${sections.join(',')}] but model expects ${SECTION_LABELS[model.section]}`,
    );
  }
  const ranges = selectedTabLabels(ctx, Object.values(RANGE_LABELS));
  if (ranges.length !== 1 || ranges[0] !== RANGE_LABELS[model.range]) {
    throw new InvariantViolation(
      'I3',
      `selected ranges [${ranges.join(',')}] but model expects ${RANGE_LABELS[model.range]}`,
    );
  }

  if (model.section === 'technique') {
    const expected = expectedTechnique(
      model.shownFacts,
      model.range,
      nowMs,
      timeZone,
    );
    expectLabel(
      'I4',
      ctx,
      'technique-stat-reps',
      'SCORED REPS',
      expected.reps,
      expected.priorReps,
    );
    expectLabel(
      'I4',
      ctx,
      'technique-stat-days',
      'SCORED DAYS',
      expected.days,
      expected.priorDays,
    );
    expectLabel(
      'I4',
      ctx,
      'technique-stat-avg',
      'AVG SCORE',
      expected.avg,
      expected.priorAvg,
    );
    expectLabel(
      'I4',
      ctx,
      'technique-stat-best',
      'BEST SCORE',
      expected.best,
      expected.priorBest,
    );
    if (byTestId(ctx.renderer, 'practice-stat-captures')) {
      throw new InvariantViolation(
        'I5',
        'practice rows rendered inside technique section',
      );
    }
    const offered = allWithProp(
      ctx.renderer,
      props =>
        typeof props.testID === 'string' &&
        props.testID.startsWith('practice-set-attempt-'),
    )
      .map(node =>
        String(node.props.testID).slice('practice-set-attempt-'.length),
      )
      .sort();
    const allowed = latestPracticeSetIds(model.shownFacts, nowMs);
    if (offered.join('|') !== allowed.join('|')) {
      throw new InvariantViolation(
        'I7',
        `practice set offers [${offered.join(',')}] but oracle allows [${allowed.join(',')}]`,
      );
    }
  } else {
    const expected = expectedPractice(
      model.shownCaptures,
      model.range,
      nowMs,
      timeZone,
    );
    expectLabel(
      'I5',
      ctx,
      'practice-stat-captures',
      'CAPTURES',
      expected.captures,
      expected.priorCaptures,
    );
    expectLabel(
      'I5',
      ctx,
      'practice-stat-active-days',
      'ACTIVE DAYS',
      expected.activeDays,
      expected.priorActiveDays,
    );
    if (byTestId(ctx.renderer, 'technique-stat-reps')) {
      throw new InvariantViolation(
        'I5',
        'technique rows rendered inside practice section',
      );
    }
    const claimsFirstPeriod = textContent(ctx.renderer).includes(
      FIRST_PERIOD_COPY,
    );
    if (claimsFirstPeriod && expected.hasOlderHistory) {
      throw new InvariantViolation(
        'I5-first-period',
        `"${FIRST_PERIOD_COPY}" shown although verified captures predate the ${model.range} window`,
      );
    }
  }
}

async function press(node: Instance): Promise<void> {
  await act(async () => {
    node.props.onPress();
  });
}

/** Marks the model as having (re)loaded from storage at this focus. */
function noteLoad(
  model: ModelState,
  counters: ScenarioOutcome['counters'],
): void {
  counters.loads += 1;
  if (model.dbFault) {
    model.showingError = true;
    return;
  }
  model.showingError = false;
  model.shownFacts = [...model.dbFacts];
  model.shownCaptures = [...model.dbCaptures];
}

async function applyAction(
  ctx: HarnessContext,
  model: ModelState,
  action: Action,
  modeRef: { mode: ApiMode },
  counters: ScenarioOutcome['counters'],
): Promise<string> {
  const focused = focusedOnPerformance(ctx);
  const view = focused ? viewKind(ctx) : 'blurred';
  switch (action.kind) {
    case 'section':
    case 'range': {
      if (view !== 'content') return `noop (view=${view})`;
      const label =
        action.kind === 'section'
          ? SECTION_LABELS[action.section]
          : RANGE_LABELS[action.range];
      const [node] = pressablesByLabel(ctx.renderer, label);
      if (!node) throw new InvariantViolation('I3', `no tab labelled ${label}`);
      await press(node);
      if (action.kind === 'section') model.section = action.section;
      else model.range = action.range;
      return `pressed ${label}`;
    }
    case 'double_press': {
      if (view !== 'content') return `noop (view=${view})`;
      const label =
        action.target === 'section'
          ? SECTION_LABELS[model.section]
          : RANGE_LABELS[model.range];
      const [node] = pressablesByLabel(ctx.renderer, label);
      if (!node) throw new InvariantViolation('I3', `no tab labelled ${label}`);
      await act(async () => {
        node.props.onPress();
        node.props.onPress();
      });
      return `double-pressed ${label}`;
    }
    case 'open_streak': {
      if (view !== 'content') return `noop (view=${view})`;
      const [node] = pressablesByTestId(
        ctx.renderer,
        testID => testID === 'consistency-card',
      );
      if (!node) return 'noop (no consistency card)';
      await press(node);
      counters.navigations += 1;
      const route = routeSummary(ctx.navRef.getRootState());
      if (route !== 'StreakCalendar') {
        throw new InvariantViolation('I7', `consistency card led to ${route}`);
      }
      return 'opened StreakCalendar';
    }
    case 'open_attempt': {
      if (view !== 'content') return `noop (view=${view})`;
      const attempts = pressablesByTestId(ctx.renderer, testID =>
        testID.startsWith('practice-set-attempt-'),
      );
      if (attempts.length === 0) return 'noop (no attempts offered)';
      const node = attempts[attempts.length - 1]!;
      const id = String(node.props.testID).slice(
        'practice-set-attempt-'.length,
      );
      const before = ctx.resultVisits.length;
      await press(node);
      counters.navigations += 1;
      const route = routeSummary(ctx.navRef.getRootState());
      const visit = ctx.resultVisits[before];
      if (route !== 'Result' || !visit || visit.analysisId !== id) {
        throw new InvariantViolation(
          'I7',
          `attempt ${id} led to ${route} with params ${JSON.stringify(visit ?? null)}`,
        );
      }
      return `opened Result:${id}`;
    }
    case 'back': {
      // iPhone has no hardware back: only a pushed detail route can pop.
      if (routeSummary(ctx.navRef.getRootState()).startsWith('Tabs')) {
        return 'noop (no detail route on top)';
      }
      await act(async () => {
        ctx.navRef.goBack();
      });
      counters.navigations += 1;
      const route = routeSummary(ctx.navRef.getRootState());
      if (route !== 'Tabs>Performance') {
        throw new InvariantViolation('I7', `back from detail led to ${route}`);
      }
      noteLoad(model, counters);
      return 'went back to Performance';
    }
    case 'switch_tab': {
      if (
        routeSummary(ctx.navRef.getRootState()).startsWith('Tabs>') === false
      ) {
        return 'noop (detail route on top)';
      }
      const label = action.tab;
      const [node] = pressablesByLabel(ctx.renderer, label).filter(
        candidate => candidate.props.accessibilityRole === 'tab',
      );
      if (!node) throw new InvariantViolation('I7', `no bottom tab ${label}`);
      const wasFocused = focused;
      await press(node);
      counters.navigations += 1;
      const route = routeSummary(ctx.navRef.getRootState());
      const wanted = label === 'Home' ? 'Tabs>Home' : 'Tabs>Performance';
      if (route !== wanted) {
        throw new InvariantViolation('I7', `tab ${label} led to ${route}`);
      }
      if (label === 'Progress' && !wasFocused) noteLoad(model, counters);
      return `switched to ${label}`;
    }
    case 'add_fact': {
      await act(async () => {
        await writeFact(action.fact);
      });
      model.dbFacts.push(action.fact);
      return `wrote fact ${action.fact.id}`;
    }
    case 'add_capture': {
      await act(async () => {
        await writeCapture(action.capture);
      });
      model.dbCaptures.push(action.capture);
      return `wrote capture ${action.capture.id} (${action.capture.kind})`;
    }
    case 'api': {
      modeRef.mode = action.mode;
      model.api = action.mode;
      await act(async () => {
        useApiSessionStore.setState({ session: sessionFor(action.mode) });
      });
      return `api ${action.mode}`;
    }
    case 'db_fault': {
      dbMockState.fault = action.on;
      model.dbFault = action.on;
      return `db fault ${action.on ? 'on' : 'off'}`;
    }
    case 'retry': {
      if (view !== 'error') return `noop (view=${view})`;
      const [node] = pressablesByLabel(ctx.renderer, 'Try again');
      if (!node) throw new InvariantViolation('I6', 'error state has no retry');
      await press(node);
      noteLoad(model, counters);
      return 'pressed retry';
    }
    case 'flush':
      return 'flushed';
    default: {
      const exhaustive: never = action;
      throw new Error(`unknown action ${JSON.stringify(exhaustive)}`);
    }
  }
}

export async function runScenario(
  scenario: Scenario,
  nowMs: number,
  options: RunOptions,
): Promise<ScenarioOutcome> {
  const timeZone = deviceTimeZone();
  const counters: ScenarioOutcome['counters'] = {
    loads: 0,
    navigations: 0,
    errorStates: 0,
    contentChecks: 0,
    dbQueries: 0,
    fetches: 0,
  };
  const steps: StepRecord[] = [];
  let failure: FailureRecord | null = null;
  const knownDefectHits: FailureRecord[] = [];

  // Fresh device state: new database, guest owner, stores reset.
  openFreshDatabase();
  // Drops the module-level handle so the next getDb() migrates the new file.
  getDb().close();
  setActiveDataOwner(GUEST_DATA_OWNER);
  useConsistencyStore.setState({
    ...useConsistencyStore.getInitialState(),
  });
  const modeRef = { mode: scenario.initialApi };
  useApiSessionStore.setState({ session: sessionFor(scenario.initialApi) });

  const model: ModelState = {
    section: 'technique',
    range: '28d',
    dbFacts: [],
    dbCaptures: [],
    shownFacts: [],
    shownCaptures: [],
    showingError: false,
    api: scenario.initialApi,
    dbFault: false,
  };
  for (const fact of scenario.initialFacts) {
    await writeFact(fact);
    model.dbFacts.push(fact);
  }
  for (const capture of scenario.initialCaptures) {
    await writeCapture(capture);
    model.dbCaptures.push(capture);
  }

  const resultVisits: ResultVisit[] = [];
  const ResultRecorder = makeResultRecorder(resultVisits);
  const navRef = createNavigationContainerRef<RootStackParams>();
  const consoleErrors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  };
  const ctx: HarnessContext = {
    renderer: null as unknown as Renderer,
    navRef,
    resultVisits,
    fetchState: { pending: 0, calls: 0 },
    consoleErrors,
  };
  installFetch(ctx, modeRef);

  const record = (step: number, action: string, effect: string) => {
    steps.push({ step, action, effect, observed: observe(ctx, model) });
  };
  const fail = (step: number, action: string, error: unknown) => {
    const violation =
      error instanceof InvariantViolation
        ? error
        : new InvariantViolation(
            'I1',
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error),
          );
    const recordOf: FailureRecord = {
      step,
      action,
      invariant: violation.invariant,
      message: violation.message,
    };
    if (KNOWN_DEFECTS.has(violation.invariant)) {
      if (!knownDefectHits.some(hit => hit.invariant === violation.invariant)) {
        knownDefectHits.push(recordOf);
      }
      return;
    }
    if (!failure) failure = recordOf;
  };

  try {
    await act(async () => {
      ctx.renderer = TestRenderer.create(
        <NavigationContainer
          ref={navRef}
          initialState={{
            routes: [
              {
                name: 'Tabs',
                state: {
                  index: 3,
                  routes: [
                    { name: 'Home' },
                    { name: 'Library' },
                    { name: 'Add' },
                    { name: 'Performance' },
                    { name: 'Settings' },
                  ],
                },
              },
            ],
          }}
        >
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen name="Tabs" component={MainTabs} />
            <Stack.Screen
              name="StreakCalendar"
              component={StreakCalendarScreen}
            />
            <Stack.Screen name="Result" component={ResultRecorder} />
          </Stack.Navigator>
        </NavigationContainer>,
      );
    });
    noteLoad(model, counters);
    try {
      await settle(ctx);
      checkInvariants(ctx, model, nowMs, timeZone, counters);
    } catch (error) {
      fail(0, 'mount', error);
    }
    record(0, 'mount', 'mounted Performance tab');

    for (let index = 0; index < scenario.actions.length; index += 1) {
      if (failure && options.stopOnFailure) break;
      const action = scenario.actions[index]!;
      const name = describeAction(action);
      let effect = '';
      try {
        effect = await applyAction(ctx, model, action, modeRef, counters);
        await settle(ctx);
        checkInvariants(ctx, model, nowMs, timeZone, counters);
      } catch (error) {
        fail(index + 1, name, error);
        effect = effect || 'threw';
      }
      record(index + 1, name, effect);
    }
  } finally {
    console.error = originalError;
    if (ctx.renderer) {
      await act(async () => {
        ctx.renderer.unmount();
      });
    }
    counters.dbQueries = dbMockState.queries;
    counters.fetches = ctx.fetchState.calls;
    // The RN jest preset's `performance.now` is a jest.fn whose recorded
    // calls (thousands per step from React's scheduler) are never freed;
    // clearing keeps every mock implementation but drops the call history.
    jest.clearAllMocks();
  }

  return {
    seed: scenario.seed,
    length: scenario.actions.length,
    status: failure
      ? 'broken'
      : knownDefectHits.length > 0
        ? 'known_defect'
        : 'held',
    steps,
    failure,
    knownDefectHits,
    counters,
  };
}
