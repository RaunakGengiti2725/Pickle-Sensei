/**
 * STRESS · scr-resultdetailsscreen · lens randomized-seeded — HARNESS
 *
 * Renders the REAL `ResultDetailsScreen` inside a REAL React Navigation
 * container + native stack (typed with the app's `RootStackParams`), over the
 * REAL local store (production `getDb()` migrations against node:sqlite), the
 * REAL training store / training API / api-session store / try-again handoff.
 * Only native modules (op-sqlite, the PickleVideoCapture bridge, safe-area,
 * SVG, gradient) and `fetch` are replaced — see the test file's `jest.mock`s.
 *
 * Every campaign iteration is `runSequence(seed)`: a seeded world is written
 * to the store, the stack is mounted at Home → Result → ResultDetails, and a
 * seeded sequence of 5–60 legal / near-legal public actions is executed.
 * After EVERY action the model invariants below are checked against the
 * rendered tree and the navigation state. The trace (action + observed
 * digest per step) is returned so the campaign can (a) minimize failures by
 * action-prefix / action-deletion and (b) check determinism by replaying the
 * same seed and comparing traces byte-for-byte.
 */
import React from 'react';
import { Text, View } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import {
  CommonActions,
  NavigationContainer,
  createNavigationContainerRef,
  type NavigationState,
  type PartialState,
} from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import type { RootStackParams } from '../../src/navigation/params';
import { ResultDetailsScreen } from '../../src/screens/ResultDetailsScreen';
import {
  clearTryAgainHandoff,
  peekTryAgainHandoff,
} from '../../src/screens/tryAgainHandoff';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';
import { createTrainingApi } from '../../src/training/api';
import { getDb } from '../../src/data/db';
import { setActiveDataOwner } from '../../src/data/accountScope';
import { OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';
import { fixList } from '../../src/review/formReviewModel';
import type { PoseSequenceSidecarRef } from '../../src/camera/capture';
import {
  Rng,
  generateWorld,
  seedWorld,
  type SeededWorld,
  type World,
} from './resultDetailsScreen.randomizedSeeded.fixtures';

// ─── Fake network (the ONLY thing besides native modules that is mocked) ────

export interface PendingFetch {
  url: string;
  method: string;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

export interface NetworkLog {
  requests: { method: string; url: string }[];
  pending: PendingFetch[];
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function planJson(input: {
  id: string;
  sourceShotId: string;
  shotType: string;
  status: 'active' | 'completed';
  createdAt: string;
  reassessmentShotId: string | null;
  completeItems: boolean;
  rng: Rng;
}): Record<string, unknown> {
  const item = (position: number, kind: 'warmup' | 'targeted') => ({
    id: input.rng.uuid(),
    position,
    kind,
    drill: {
      slug: `${kind}-drill-${position}`,
      title: `${kind === 'warmup' ? 'Shadow swings' : 'Wall drives'} ${position}`,
      description: 'Reviewed drill description.',
      coachName: 'Coach',
      equipment: ['paddle'],
      saved: false,
    },
    cueText: 'Stay low through contact.',
    targetSets: 3,
    targetRepetitionsPerSet: 10,
    targetDurationSeconds: null,
    restSeconds: 30,
    completion: input.completeItems
      ? {
          id: input.rng.uuid(),
          completedAt: input.createdAt,
          actualRepetitions: 10,
          actualDurationSeconds: null,
          qualifiesForStreak: true,
        }
      : null,
  });
  return {
    id: input.id,
    status: input.status,
    algorithmVersion: 'plan-v1',
    sourceShotId: input.sourceShotId,
    shotType: input.shotType,
    priorityCheckpoint: 'contact_position',
    priorityDirection: 'late',
    baselineScore: 6.2,
    baselineCheckpointScore: 48,
    reassessmentShotId: input.reassessmentShotId,
    scoreDelta: input.status === 'completed' ? 0.8 : null,
    createdAt: input.createdAt,
    completedAt: input.status === 'completed' ? input.createdAt : null,
    items: [item(1, 'warmup'), item(2, 'targeted'), item(3, 'targeted')],
  };
}

/** Builds the seeded fetch for one world. Slow responses are parked in
 * `log.pending` until a `resolve_network` action (or teardown) releases them. */
export function installFetch(world: World, log: NetworkLog): void {
  const rng = new Rng(world.seed ^ 0x2545f491);
  const planId = rng.uuid();
  const otherShotId = rng.uuid();
  const fetchImpl = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    log.requests.push({ method, url });
    const path = url.replace(/^https?:\/\/[^/]+\/api/, '').replace(/\?.*$/, '');
    const park = (): Promise<Response> =>
      new Promise<Response>((resolve, reject) => {
        const entry: PendingFetch = { url, method, resolve, reject };
        log.pending.push(entry);
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            const index = log.pending.indexOf(entry);
            if (index >= 0) log.pending.splice(index, 1);
            reject(new Error('aborted'));
          });
        }
      });

    if (method === 'GET' && path === '/v1/training-plans/current') {
      switch (world.training) {
        case 'plan_none':
          return Promise.resolve(jsonResponse(200, { plan: null }));
        case 'plan_for_this_read':
          return Promise.resolve(
            jsonResponse(200, {
              plan: planJson({
                id: planId,
                sourceShotId: world.target.id,
                shotType: world.shotType,
                status: 'active',
                createdAt: '2026-09-01T10:30:00.000Z',
                reassessmentShotId: null,
                completeItems: false,
                rng: new Rng(world.seed),
              }),
            }),
          );
        case 'plan_other_read':
          return Promise.resolve(
            jsonResponse(200, {
              plan: planJson({
                id: planId,
                sourceShotId: otherShotId,
                shotType: world.shotType,
                status: 'active',
                createdAt: '2026-08-20T10:00:00.000Z',
                reassessmentShotId: null,
                completeItems: true,
                rng: new Rng(world.seed),
              }),
            }),
          );
        case 'plan_completed_by_this_read':
          return Promise.resolve(
            jsonResponse(200, {
              plan: planJson({
                id: planId,
                sourceShotId: otherShotId,
                shotType: world.shotType,
                status: 'completed',
                createdAt: '2026-08-20T10:00:00.000Z',
                reassessmentShotId: world.target.id,
                completeItems: true,
                rng: new Rng(world.seed),
              }),
            }),
          );
        case 'server_error':
          return Promise.resolve(
            jsonResponse(500, { error: { code: 'internal', message: 'boom' } }),
          );
        case 'invalid_response':
          return Promise.resolve(jsonResponse(200, { plan: { id: 'nope' } }));
        case 'session_expired':
          return Promise.resolve(
            jsonResponse(401, {
              error: { code: 'unauthorized', message: 'expired' },
            }),
          );
        case 'unconfigured':
          return Promise.reject(new Error('training api must not be reached'));
      }
    }
    if (method === 'GET' && path.startsWith('/v1/catalog/drills/')) {
      return Promise.resolve(
        jsonResponse(404, {
          error: { code: 'not_found', message: 'no drill' },
        }),
      );
    }
    if (method === 'POST' && path === '/v1/training-plans') {
      switch (world.planCreate) {
        case 'accept':
          return Promise.resolve(
            jsonResponse(201, {
              plan: planJson({
                id: rng.uuid(),
                sourceShotId: world.target.id,
                shotType: world.shotType,
                status: 'active',
                createdAt: '2026-09-02T10:00:00.000Z',
                reassessmentShotId: null,
                completeItems: false,
                rng: new Rng(world.seed ^ 7),
              }),
            }),
          );
        case 'reject_422':
          return Promise.resolve(
            jsonResponse(422, {
              error: {
                code: 'plan_unavailable',
                message: 'No reviewed drills.',
              },
            }),
          );
        case 'slow':
          return park();
      }
    }
    if (
      method === 'POST' &&
      /^\/v1\/training-plans\/[^/]+\/reassessment$/.test(path)
    ) {
      return Promise.resolve(
        jsonResponse(200, {
          plan: planJson({
            id: planId,
            sourceShotId: otherShotId,
            shotType: world.shotType,
            status: 'completed',
            createdAt: '2026-08-20T10:00:00.000Z',
            reassessmentShotId: world.target.id,
            completeItems: true,
            rng: new Rng(world.seed ^ 11),
          }),
        }),
      );
    }
    if (method === 'POST' && /^\/v1\/analyses\/[^/]+\/feedback$/.test(path)) {
      switch (world.feedback) {
        case 'accept':
          return Promise.resolve(
            jsonResponse(200, { feedback: { reviewEligible: true } }),
          );
        case 'reject_500':
          return Promise.resolve(
            jsonResponse(500, { error: { code: 'internal', message: 'boom' } }),
          );
        case 'unauthorized':
          return Promise.resolve(
            jsonResponse(401, {
              error: { code: 'unauthorized', message: 'expired' },
            }),
          );
        case 'slow':
          return park();
      }
    }
    // Drill completions, saved-drill toggles and anything else the training
    // surface can reach: the server refuses, the UI must surface it honestly.
    return Promise.resolve(
      jsonResponse(500, { error: { code: 'internal', message: 'refused' } }),
    );
  };
  globalThis.fetch = fetchImpl as typeof fetch;
}

// ─── Typed stand-in neighbours (the unit under test is ResultDetails) ───────

const Stack = createNativeStackNavigator<RootStackParams>();
export const navigationRef = createNavigationContainerRef<RootStackParams>();

function HomeRoute() {
  return (
    <View testID="route-home">
      <Text>Home</Text>
    </View>
  );
}

function ResultRoute(props: NativeStackScreenProps<RootStackParams, 'Result'>) {
  return (
    <View testID="route-result">
      <Text testID="route-result-id">{props.route.params.analysisId}</Text>
    </View>
  );
}

function FormReviewRoute(
  props: NativeStackScreenProps<RootStackParams, 'FormReview'>,
) {
  return (
    <View testID="route-form-review">
      <Text testID="route-form-review-id">{props.route.params.analysisId}</Text>
      <Text testID="route-form-review-phase">
        {props.route.params.phase ?? ''}
      </Text>
    </View>
  );
}

function AnalyzeRoute(
  props: NativeStackScreenProps<RootStackParams, 'Analyze'>,
) {
  return (
    <View testID="route-analyze">
      <Text testID="route-analyze-source">
        {props.route.params?.source ?? ''}
      </Text>
    </View>
  );
}

function Host(props: { initialState: PartialState<NavigationState> }) {
  return (
    <NavigationContainer ref={navigationRef} initialState={props.initialState}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Tabs" component={HomeRoute} />
        <Stack.Screen name="Result" component={ResultRoute} />
        <Stack.Screen name="ResultDetails" component={ResultDetailsScreen} />
        <Stack.Screen name="FormReview" component={FormReviewRoute} />
        <Stack.Screen name="Analyze" component={AnalyzeRoute} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// ─── Tree helpers ───────────────────────────────────────────────────────────

function hostsByTestId(
  renderer: ReactTestRenderer,
  testID: string,
): ReactTestInstance[] {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

function allText(root: ReactTestInstance): string {
  return root
    .findAllByType(Text)
    .map(node => node.props.children as unknown)
    .flat(3)
    .filter(
      (child): child is string | number =>
        typeof child === 'string' || typeof child === 'number',
    )
    .join(' ')
    .replace(/\s+/g, ' ');
}

function pressables(
  root: ReactTestInstance,
  predicate: (props: Record<string, unknown>) => boolean,
): ReactTestInstance[] {
  // Outermost pressable only: PressableScale → Pressable → host chains all
  // carry `onPress`, so a node whose ancestor also has one is the same tap.
  const hasPressAncestor = (node: ReactTestInstance): boolean => {
    let parent = node.parent;
    while (parent && parent !== root) {
      if (typeof parent.props.onPress === 'function') return true;
      parent = parent.parent;
    }
    return false;
  };
  return root.findAll(
    node =>
      typeof node.props.onPress === 'function' &&
      predicate(node.props as Record<string, unknown>) &&
      !hasPressAncestor(node),
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

// ─── Actions ────────────────────────────────────────────────────────────────

export type Action =
  | { kind: 'back' }
  | { kind: 'hardware_back' }
  | { kind: 'chip'; slot: number }
  | { kind: 'form_review' }
  | { kind: 'fix_review'; slot: number }
  | { kind: 'capture_new_read' }
  | { kind: 'training_press'; slot: number }
  | { kind: 'feedback_press'; slot: number }
  | {
      kind: 'set_params';
      target: 'sibling' | 'unknown' | 'target';
      slot: number;
    }
  | {
      kind: 'reopen_details';
      target: 'sibling' | 'unknown' | 'target';
      slot: number;
    }
  | {
      kind: 'open_result_then_details';
      target: 'sibling' | 'target';
      slot: number;
    }
  | { kind: 'resolve_network' }
  | { kind: 'idle' };

const ACTION_KINDS: readonly Action['kind'][] = [
  'back',
  'hardware_back',
  'chip',
  'chip',
  'form_review',
  'fix_review',
  'capture_new_read',
  'training_press',
  'training_press',
  'feedback_press',
  'feedback_press',
  'set_params',
  'reopen_details',
  'open_result_then_details',
  'resolve_network',
  'idle',
];

const LEAVING_KINDS: readonly Action['kind'][] = [
  'back',
  'hardware_back',
  'chip',
  'form_review',
  'fix_review',
  'capture_new_read',
];
const RETURNING_KINDS: readonly Action['kind'][] = [
  'reopen_details',
  'reopen_details',
  'open_result_then_details',
  'hardware_back',
];

/** Seeded action list. The generator tracks (approximately) whether the last
 * action left the details route so sequences spend most steps ON the unit
 * rather than issuing no-ops against a stand-in neighbour; every emitted
 * action is still legal wherever it lands. */
export function generateActions(seed: number, length: number): Action[] {
  const rng = new Rng(seed ^ 0x7f4a7c15);
  const actions: Action[] = [];
  let probablyOff = false;
  for (let i = 0; i < length; i += 1) {
    const kind =
      probablyOff && rng.chance(0.7)
        ? rng.pick(RETURNING_KINDS)
        : rng.pick(ACTION_KINDS);
    if (LEAVING_KINDS.includes(kind)) probablyOff = true;
    if (kind === 'reopen_details' || kind === 'open_result_then_details')
      probablyOff = false;
    const slot = rng.int(0, 5);
    switch (kind) {
      case 'chip':
      case 'fix_review':
      case 'training_press':
      case 'feedback_press':
        actions.push({ kind, slot });
        break;
      case 'set_params':
      case 'reopen_details':
        actions.push({
          kind,
          target: rng.pick([
            'sibling',
            'sibling',
            'target',
            'unknown',
          ] as const),
          slot,
        });
        break;
      case 'open_result_then_details':
        actions.push({
          kind,
          target: rng.pick(['sibling', 'target'] as const),
          slot,
        });
        break;
      default:
        actions.push({ kind });
    }
  }
  return actions;
}

export function describeAction(action: Action): string {
  switch (action.kind) {
    case 'chip':
    case 'fix_review':
    case 'training_press':
    case 'feedback_press':
      return `${action.kind}[${action.slot}]`;
    case 'set_params':
    case 'reopen_details':
    case 'open_result_then_details':
      return `${action.kind}(${action.target}#${action.slot})`;
    default:
      return action.kind;
  }
}

// ─── Model ──────────────────────────────────────────────────────────────────

type FeedbackStep = 'ask' | 'categories' | 'sending' | 'thanks' | 'failed';

interface Model {
  world: World;
  seeded: SeededWorld;
  /** Expected route stack as [name, analysisId?][] mirroring the native stack. */
  stack: { name: keyof RootStackParams; analysisId?: string; phase?: string }[];
  /** The analysis id the mounted details screen shows (top of stack). */
  focusedDetailsId: string | null;
  /** True once the user drove the training surface: exact copy is no longer
   * predicted, only structural invariants apply. */
  trainingDirty: boolean;
  feedback: FeedbackStep;
  handoffArmed: boolean;
  /** Number of details mounts so far (each remount resets component state). */
  detailsMountKey: number;
}

interface FocusedEvidence {
  analysisPresent: boolean;
  recordPresent: boolean;
  scoredReal: boolean;
  /** Whether production `fixList` yields any fault for the focused read. */
  hasFixes: boolean;
  chips: string[];
  sync: 'synced' | 'pending' | 'rejected' | 'exhausted' | 'unknown';
}

function evidenceFor(model: Model, analysisId: string): FocusedEvidence {
  const { world, seeded } = model;
  if (world.owner === 'signed_out') {
    return {
      analysisPresent: false,
      recordPresent: false,
      scoredReal: false,
      hasFixes: false,
      chips: [],
      sync: 'unknown',
    };
  }
  const isTarget = analysisId === world.target.id;
  const sibling = world.siblings.find(s => s.id === analysisId) ?? null;
  const analysisPresent = isTarget ? world.target.present : sibling !== null;
  const recordPresent = isTarget && seeded.targetRecord !== null;
  const recordResult = isTarget && world.target.record === 'with_result';
  const analysisKind = isTarget
    ? world.target.kind
    : sibling
      ? sibling.kind
      : 'low_confidence';
  const analysisVisible = analysisPresent || recordResult;
  const scoredReal = analysisVisible && analysisKind === 'scored';
  const focusedAnalysis = seeded.analyses.get(analysisId) ?? null;
  const hasFixes =
    scoredReal &&
    focusedAnalysis !== null &&
    fixList(focusedAnalysis).length > 0;
  // Chips come from local_shot rows only (not a record-only result) and
  // render only when the session has more than one.
  const chips =
    analysisPresent &&
    seeded.expectedChipIds.includes(analysisId) &&
    seeded.expectedChipIds.length > 1
      ? seeded.expectedChipIds
      : [];
  // The sync receipt is read for `analysis` (local row or record result);
  // without one the hook never leaves `checking`.
  let sync: FocusedEvidence['sync'] = 'unknown';
  if (!analysisVisible) {
    sync = 'unknown';
  } else if (isTarget) {
    sync =
      world.sync === 'synced'
        ? 'synced'
        : world.sync === 'queued'
          ? 'pending'
          : world.sync === 'rejected'
            ? 'rejected'
            : world.sync === 'exhausted'
              ? 'exhausted'
              : 'unknown';
  } else if (sibling && sibling.kind === 'scored') {
    // `saveAnalysis` queued the sibling; nothing ever drained it.
    sync = 'pending';
  }
  return { analysisPresent, recordPresent, scoredReal, hasFixes, chips, sync };
}

// ─── Trace / result types ───────────────────────────────────────────────────

export interface StepTrace {
  step: number;
  action: string;
  /** Observed digest after the step — compared across replays. */
  digest: string;
}

export interface SequenceResult {
  seed: number;
  length: number;
  world: {
    owner: World['owner'];
    present: boolean;
    kind: World['target']['kind'];
    record: World['target']['record'];
    capture: World['target']['capture'];
    sidecar: World['target']['sidecar'];
    siblings: number;
    sync: World['sync'];
    training: World['training'];
    feedback: World['feedback'];
    apiSession: boolean;
  };
  outcome: 'held' | 'failed';
  failure: {
    step: number;
    action: string;
    invariant: string;
    digest: string;
  } | null;
  trace: StepTrace[];
  consoleErrors: string[];
  /** Every `fetch` the screen issued, `METHOD /path`, in order. */
  requests: string[];
}

export class InvariantViolation extends Error {
  constructor(
    readonly invariant: string,
    detail: string,
  ) {
    super(`${invariant}: ${detail}`);
  }
}

// ─── The sequence runner ────────────────────────────────────────────────────

export interface HarnessEnvironment {
  sidecar: { ref: PoseSequenceSidecarRef; mismatchRef: PoseSequenceSidecarRef };
  /** Installs what the native PickleVideoCapture bridge returns for a uri. */
  setSidecarBehaviour: (behaviour: {
    uri: string;
    kind: World['target']['sidecar'];
  }) => void;
}

/** Empties every user table of the real store so a sequence starts from the
 * same schema-only state its replay does (kv keeps the migration version). */
async function wipeStore(db: ReturnType<typeof getDb>): Promise<void> {
  const { rows } = await db.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  for (const row of rows) {
    const name = String(row['name']);
    if (name === 'kv') continue;
    await db.execute(`DELETE FROM ${name}`);
  }
}

function routeStack(): {
  name: string;
  params: Record<string, unknown> | undefined;
}[] {
  const state: NavigationState | undefined = navigationRef.isReady()
    ? navigationRef.getRootState()
    : undefined;
  if (!state) return [];
  return state.routes.map(route => ({
    name: route.name,
    params: route.params as Record<string, unknown> | undefined,
  }));
}

function idFor(
  model: Model,
  target: 'sibling' | 'unknown' | 'target',
  slot: number,
): string {
  if (target === 'unknown') return model.world.unknownId;
  if (target === 'sibling' && model.world.siblings.length > 0) {
    const sibling = model.world.siblings[slot % model.world.siblings.length];
    if (sibling) return sibling.id;
  }
  return model.world.target.id;
}

export async function runSequence(
  seed: number,
  env: HarnessEnvironment,
  options: { actions?: Action[]; length?: number } = {},
): Promise<SequenceResult> {
  const world = generateWorld(seed);
  const lengthRng = new Rng(seed ^ 0x3c6ef372);
  const length =
    options.actions?.length ?? options.length ?? lengthRng.int(5, 60);
  const actions = options.actions ?? generateActions(seed, length);
  const consoleErrors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(
      args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
    );
  };

  // ── world → real store / real stores ─────────────────────────────────────
  setActiveDataOwner(world.ownerKey);
  clearTryAgainHandoff();
  clearApiSession();
  clearTrainingStoreConfiguration();
  const network: NetworkLog = { requests: [], pending: [] };
  installFetch(world, network);
  env.setSidecarBehaviour({
    uri: world.sidecarUri,
    kind: world.target.sidecar,
  });
  const db = getDb();
  await wipeStore(db);
  const seeded = await seedWorld(db, world, env.sidecar);
  const canonicalId = world.owner === 'canonical' ? world.ownerKey : null;
  if (world.apiSession && canonicalId) {
    establishApiSession({
      apiBaseUrl: 'https://stress.invalid/api',
      bearerToken: `bearer-${seed}`,
      canonicalAppUserId: canonicalId,
      provider: 'apple',
    });
  }
  if (world.training !== 'unconfigured' && canonicalId) {
    configureTrainingStore(
      createTrainingApi({
        baseUrl: 'https://stress.invalid/api',
        token: `bearer-${seed}`,
      }),
    );
  }
  const effectiveTraining: World['training'] =
    world.training !== 'unconfigured' && canonicalId
      ? world.training
      : 'unconfigured';

  const model: Model = {
    world,
    seeded,
    stack: [
      { name: 'Tabs' },
      { name: 'Result', analysisId: world.target.id },
      { name: 'ResultDetails', analysisId: world.target.id },
    ],
    focusedDetailsId: world.target.id,
    trainingDirty: false,
    feedback: 'ask',
    handoffArmed: false,
    detailsMountKey: 0,
  };

  const initialState: PartialState<NavigationState> = {
    routes: [
      { name: 'Tabs' },
      { name: 'Result', params: { analysisId: world.target.id } },
      { name: 'ResultDetails', params: { analysisId: world.target.id } },
    ],
  };

  let renderer!: ReactTestRenderer;
  const trace: StepTrace[] = [];
  let failure: SequenceResult['failure'] = null;

  const digest = (): string => {
    const stack = routeStack()
      .map(r => `${r.name}${r.params ? `(${JSON.stringify(r.params)})` : ''}`)
      .join('>');
    const details = hostsByTestId(renderer, 'result-details').length;
    const analyzing = hostsByTestId(renderer, 'stroke-result-analyzing').length;
    const missing = renderer.root
      .findAllByType(Text)
      .some(node => node.props.children === 'Result missing');
    const chips = pressables(
      renderer.root,
      props => props.accessibilityRole === 'tab',
    ).length;
    const feedback = [
      'feedback-ask',
      'feedback-categories',
      'feedback-sending',
      'feedback-thanks',
      'feedback-failed',
    ]
      .filter(id => hostsByTestId(renderer, id).length > 0)
      .join('|');
    const training = useTrainingStore.getState();
    return `${stack} details=${details} analyzing=${analyzing} missing=${missing ? 1 : 0} chips=${chips} fb=${feedback} plan=${training.planStatus}/${training.mutation}/${training.currentPlan?.status ?? '-'} pending=${network.pending.length} handoff=${peekTryAgainHandoff() ? 1 : 0}`;
  };

  const check = (
    invariant: string,
    ok: boolean,
    detail: () => string,
  ): void => {
    if (!ok) throw new InvariantViolation(invariant, detail());
  };

  const checkInvariants = (): void => {
    const stack = routeStack();
    const current = navigationRef.getCurrentRoute();
    check('nav.stack-nonempty', stack.length >= 1, () => 'empty stack');
    check(
      'nav.stack-matches-model',
      stack.length === model.stack.length &&
        stack.every((route, index) => {
          const expected = model.stack[index];
          if (!expected) return false;
          if (route.name !== expected.name) return false;
          if (expected.analysisId !== undefined) {
            return route.params?.['analysisId'] === expected.analysisId;
          }
          return true;
        }),
      () =>
        `observed ${JSON.stringify(stack)} expected ${JSON.stringify(model.stack)}`,
    );
    check(
      'nav.single-details-route',
      stack.filter(r => r.name === 'ResultDetails').length <= 1,
      () => JSON.stringify(stack),
    );
    const detailsHosts = hostsByTestId(renderer, 'result-details');
    const breakdownHosts = hostsByTestId(renderer, 'result-details-breakdown');
    const analyzingHosts = hostsByTestId(renderer, 'stroke-result-analyzing');
    const missingTitle = renderer.root
      .findAllByType(Text)
      .filter(node => node.props.children === 'Result missing').length;
    check(
      'details.no-duplicate-cta-row',
      hostsByTestId(renderer, 'stroke-result-try-again').length === 0 &&
        hostsByTestId(renderer, 'stroke-result-done').length === 0,
      () => 'details route rendered the guide CTA row',
    );
    const top = model.stack[model.stack.length - 1];
    if (
      !top ||
      top.name !== 'ResultDetails' ||
      current?.name !== 'ResultDetails'
    ) {
      // Details is not the focused route. The native stack keeps the screen
      // mounted underneath (e.g. FormReview / Analyze on top) — it must not
      // duplicate itself while hidden.
      check(
        'details.at-most-one-mounted',
        detailsHosts.length <= 1 && breakdownHosts.length <= 1,
        () =>
          `details=${detailsHosts.length} breakdown=${breakdownHosts.length}`,
      );
      return;
    }
    const focusedId = top.analysisId ?? '';
    const evidence = evidenceFor(model, focusedId);
    const expectedState =
      evidence.analysisPresent || evidence.recordPresent
        ? 'breakdown'
        : 'missing';
    check(
      'details.settled-not-loading',
      analyzingHosts.length === 0,
      () => 'still "Opening your result…" after settle',
    );
    check(
      'details.exactly-one-state',
      Number(detailsHosts.length > 0) + Number(missingTitle > 0) === 1,
      () => `details=${detailsHosts.length} missing=${missingTitle}`,
    );
    check(
      'details.state-matches-store',
      (expectedState === 'breakdown') ===
        (detailsHosts.length === 1 && breakdownHosts.length === 1),
      () =>
        `expected ${expectedState} for ${focusedId} (analysis=${evidence.analysisPresent} record=${evidence.recordPresent}); details=${detailsHosts.length} breakdown=${breakdownHosts.length} missing=${missingTitle}`,
    );
    if (expectedState === 'missing') {
      check(
        'details.missing-copy',
        allText(renderer.root).includes(
          'This analysis is no longer on this device.',
        ),
        () => 'missing state without its honest copy',
      );
      return;
    }
    const breakdown = breakdownHosts[0];
    check(
      'details.breakdown-host',
      breakdown !== undefined,
      () => 'no breakdown host',
    );
    if (!breakdown) return;
    const copy = allText(breakdown);
    check(
      'details.header-once',
      renderer.root
        .findAllByType(Text)
        .filter(n => n.props.children === 'Full breakdown').length === 1,
      () => 'header title count != 1',
    );
    // Attempt chips: same-session rows only, capture order, the focused one
    // selected, never a chip for a foreign-session shot.
    const chips = pressables(
      renderer.root,
      props => props.accessibilityRole === 'tab',
    );
    check(
      'chips.same-session-only',
      chips.length === evidence.chips.length,
      () =>
        `observed ${chips.length} chips, expected ${evidence.chips.length} (${evidence.chips.join(',')})`,
    );
    if (chips.length > 0) {
      const selectedIndex = chips.findIndex(chip => {
        const state = chip.props.accessibilityState as
          { selected?: boolean } | undefined;
        return state?.selected === true;
      });
      check(
        'chips.focused-selected',
        selectedIndex === evidence.chips.indexOf(focusedId),
        () =>
          `selected index ${selectedIndex}, expected ${evidence.chips.indexOf(focusedId)}`,
      );
      chips.forEach((chip, index) => {
        check(
          'chips.capture-order-labels',
          chip.props.accessibilityLabel === `Attempt ${index + 1}`,
          () =>
            `chip ${index} labelled ${String(chip.props.accessibilityLabel)}`,
        );
      });
      if (model.world.foreign) {
        check(
          'chips.no-foreign-session',
          chips.length <= model.world.siblings.length + 1,
          () => 'more chips than same-session members',
        );
      }
    }
    // Form review entry exists only for a scored read with replay evidence.
    const reviewCard = hostsByTestId(renderer, 'form-review-card').length;
    const clipVisible =
      focusedId === model.world.target.id &&
      model.world.target.record !== 'absent' &&
      model.world.target.record !== 'corrupt_json' &&
      (model.world.target.capture === 'valid' ||
        model.world.target.capture === 'legacy_payload');
    const sidecarVisible =
      focusedId === model.world.target.id &&
      model.world.target.record !== 'absent' &&
      model.world.target.record !== 'corrupt_json' &&
      model.world.target.capture === 'valid' &&
      model.world.target.sidecar !== 'none';
    const reviewAvailable =
      evidence.scoredReal && (clipVisible || sidecarVisible);
    check(
      'review.entry-gated-on-evidence',
      (reviewCard === 1) === reviewAvailable,
      () =>
        `form-review-card=${reviewCard} expected ${reviewAvailable ? 1 : 0} (scored=${evidence.scoredReal} clip=${clipVisible} sidecar=${sidecarVisible})`,
    );
    const fixLists = hostsByTestId(renderer, 'fix-list').length;
    const fixReviewLinks = pressables(renderer.root, props =>
      /^fix-item-.*-review$/.test(String(props['testID'] ?? '')),
    ).length;
    check(
      'review.fix-links-gated',
      fixLists === (evidence.hasFixes ? 1 : 0) &&
        (reviewAvailable && evidence.hasFixes
          ? fixReviewLinks > 0
          : fixReviewLinks === 0),
      () =>
        `fix-list=${fixLists} review-links=${fixReviewLinks} expected fixes=${evidence.hasFixes} review=${reviewAvailable}`,
    );
    // Training section: exactly one, with the honest state for the store.
    const trainingHosts = hostsByTestId(renderer, 'training-plan-section');
    check(
      'training.section-once',
      trainingHosts.length === 1,
      () => `count ${trainingHosts.length}`,
    );
    const trainingHost = trainingHosts[0];
    const trainingCopy = trainingHost ? allText(trainingHost) : '';
    const stateTitles = [
      'A score is required.',
      'Checking reviewed training…',
      'Training is not connected.',
      'Training could not be verified.',
      'REASSESSMENT VERIFIED',
      'YOUR REVIEWED PLAN',
      'Checking sync evidence…',
      'The server did not accept this read.',
      'Sync this read first.',
      'Turn this read into a plan.',
      'Build from this read instead?',
      'PLAN WORK COMPLETE',
    ];
    const presentTitles = stateTitles.filter(title =>
      trainingCopy.includes(title),
    );
    check(
      'training.exactly-one-state',
      presentTitles.length >= 1,
      () =>
        `training copy shows none of the known states: ${trainingCopy.slice(0, 200)}`,
    );
    const training = useTrainingStore.getState();
    check(
      'training.never-loading-after-settle',
      !trainingCopy.includes('Checking reviewed training…') ||
        network.pending.length > 0,
      () => `planStatus=${training.planStatus}`,
    );
    if (!model.trainingDirty) {
      let expectedTitle: string;
      if (!evidence.scoredReal) expectedTitle = 'A score is required.';
      else if (effectiveTraining === 'unconfigured')
        expectedTitle = 'Training is not connected.';
      else if (
        effectiveTraining === 'server_error' ||
        effectiveTraining === 'invalid_response' ||
        effectiveTraining === 'session_expired'
      )
        expectedTitle = 'Training could not be verified.';
      else if (
        effectiveTraining === 'plan_completed_by_this_read' &&
        focusedId === model.world.target.id
      )
        expectedTitle = 'REASSESSMENT VERIFIED';
      else if (
        effectiveTraining === 'plan_for_this_read' &&
        focusedId === model.world.target.id
      )
        expectedTitle = 'YOUR REVIEWED PLAN';
      else if (
        effectiveTraining === 'plan_other_read' &&
        evidence.sync === 'synced'
      )
        expectedTitle = 'PLAN WORK COMPLETE';
      else if (evidence.sync === 'exhausted')
        expectedTitle = 'The server did not accept this read.';
      else if (evidence.sync !== 'synced')
        expectedTitle = 'Sync this read first.';
      else if (
        effectiveTraining === 'plan_other_read' ||
        effectiveTraining === 'plan_for_this_read'
      )
        expectedTitle = 'Build from this read instead?';
      else expectedTitle = 'Turn this read into a plan.';
      check(
        'training.state-matches-model',
        trainingCopy.includes(expectedTitle),
        () =>
          `expected "${expectedTitle}" (training=${effectiveTraining} sync=${evidence.sync} scored=${evidence.scoredReal}) got: ${presentTitles.join('|') || trainingCopy.slice(0, 160)}`,
      );
      if (
        expectedTitle === 'Sync this read first.' &&
        evidence.sync === 'rejected'
      ) {
        check(
          'training.rejected-count-honest',
          new RegExp(
            `refused this read \\d+ of ${OUTBOX_MAX_ATTEMPTS} times`,
          ).test(trainingCopy),
          () => trainingCopy.slice(0, 300),
        );
      }
    }
    // Feedback prompt: synced + authenticated only; one step at a time.
    const feedbackIds = [
      'feedback-ask',
      'feedback-categories',
      'feedback-sending',
      'feedback-thanks',
      'feedback-failed',
    ];
    const feedbackPresent = feedbackIds.filter(
      id => hostsByTestId(renderer, id).length > 0,
    );
    const feedbackExpected =
      evidence.sync === 'synced' &&
      model.world.apiSession &&
      canonicalId !== null;
    check(
      'feedback.gated-on-synced-session',
      (feedbackPresent.length === 1) === feedbackExpected &&
        feedbackPresent.length <= 1,
      () =>
        `feedback nodes ${feedbackPresent.join('|')} expected ${feedbackExpected ? 'one' : 'none'} (sync=${evidence.sync} session=${model.world.apiSession})`,
    );
    if (feedbackExpected) {
      check(
        'feedback.step-matches-model',
        feedbackPresent[0] === `feedback-${model.feedback}`,
        () =>
          `observed ${feedbackPresent[0]} expected feedback-${model.feedback}`,
      );
    }
    // Copy that must never appear on this surface.
    check(
      'copy.no-forbidden-terms',
      !/\b(Android|Google Play|guest mode|Live Court)\b/i.test(copy),
      () => 'forbidden store-copy term rendered',
    );
  };

  const perform = async (action: Action): Promise<void> => {
    const top = model.stack[model.stack.length - 1];
    const onDetails = top?.name === 'ResultDetails';
    const focusedId = top?.analysisId ?? model.world.target.id;
    const evidence = evidenceFor(model, focusedId);
    const detailsMounted = onDetails;
    const pop = () => {
      if (model.stack.length > 1) model.stack.pop();
    };
    const mountDetails = (analysisId: string) => {
      model.stack.push({ name: 'ResultDetails', analysisId });
      model.feedback = 'ask';
      model.detailsMountKey += 1;
    };
    const leaveStandIns = async () => {
      for (;;) {
        const current = model.stack[model.stack.length - 1];
        if (
          !current ||
          (current.name !== 'FormReview' && current.name !== 'Analyze')
        )
          return;
        if (!navigationRef.canGoBack()) return;
        await act(async () => {
          navigationRef.goBack();
        });
        pop();
        await settle();
      }
    };

    switch (action.kind) {
      case 'idle':
        break;
      case 'resolve_network': {
        const pending = network.pending.splice(0);
        for (const entry of pending) {
          if (/\/feedback$/.test(entry.url)) {
            entry.resolve(
              jsonResponse(200, { feedback: { reviewEligible: false } }),
            );
            if (model.feedback === 'sending') model.feedback = 'thanks';
          } else {
            entry.resolve(
              jsonResponse(500, {
                error: { code: 'internal', message: 'late refusal' },
              }),
            );
          }
        }
        break;
      }
      case 'hardware_back': {
        if (navigationRef.canGoBack()) {
          await act(async () => {
            navigationRef.goBack();
          });
          pop();
        }
        break;
      }
      case 'back': {
        if (!detailsMounted) break;
        const [button] = pressables(
          renderer.root,
          props =>
            props.accessibilityLabel === 'Back' ||
            props.accessibilityLabel === 'Go back',
        );
        const goBackButtons = pressables(renderer.root, () => true).filter(
          node => {
            const label = allText(node);
            return label.trim() === 'Go back';
          },
        );
        const target = button ?? goBackButtons[0];
        if (!target) break;
        await act(async () => {
          (target.props.onPress as () => void)();
        });
        pop();
        break;
      }
      case 'chip': {
        if (!detailsMounted) break;
        const chips = pressables(
          renderer.root,
          props => props.accessibilityRole === 'tab',
        );
        if (chips.length === 0) break;
        const chip = chips[action.slot % chips.length];
        if (!chip) break;
        const chipId = evidence.chips[action.slot % chips.length];
        await act(async () => {
          (chip.props.onPress as () => void)();
        });
        if (chipId !== undefined && chipId !== focusedId) {
          // popTo('Result', { analysisId }) — the guide route underneath is
          // re-pointed; the details route above it is gone.
          const resultIndex = model.stack.findIndex(r => r.name === 'Result');
          if (resultIndex >= 0) {
            model.stack.splice(resultIndex + 1);
            const result = model.stack[resultIndex];
            if (result) result.analysisId = chipId;
          } else {
            // No Result underneath: popTo pops the current route and pushes
            // the destination in its place.
            model.stack.pop();
            model.stack.push({ name: 'Result', analysisId: chipId });
          }
        }
        break;
      }
      case 'form_review': {
        if (!detailsMounted) break;
        const [card] = hostsByTestId(renderer, 'form-review-card');
        if (!card) break;
        const [press] =
          pressables(card, () => true).length > 0
            ? pressables(card, () => true)
            : typeof card.props.onPress === 'function'
              ? [card]
              : [];
        if (!press) break;
        await act(async () => {
          (press.props.onPress as () => void)();
        });
        model.stack.push({ name: 'FormReview', analysisId: focusedId });
        break;
      }
      case 'fix_review': {
        if (!detailsMounted) break;
        const links = pressables(renderer.root, props =>
          /^fix-item-.*-review$/.test(String(props['testID'] ?? '')),
        );
        if (links.length === 0) break;
        const link = links[action.slot % links.length];
        if (!link) break;
        await act(async () => {
          (link.props.onPress as () => void)();
        });
        model.stack.push({
          name: 'FormReview',
          analysisId: focusedId,
          phase: 'set',
        });
        break;
      }
      case 'capture_new_read': {
        if (!detailsMounted) break;
        const [button] = pressables(renderer.root, () => true).filter(
          node => allText(node).trim() === 'Capture a new read',
        );
        if (!button) break;
        await act(async () => {
          (button.props.onPress as () => void)();
        });
        model.handoffArmed = true;
        model.stack.push({ name: 'Analyze' });
        break;
      }
      case 'training_press': {
        if (!detailsMounted) break;
        const [section] = hostsByTestId(renderer, 'training-plan-section');
        if (!section) break;
        const buttons = pressables(section, () => true);
        if (buttons.length === 0) break;
        const button = buttons[action.slot % buttons.length];
        if (!button) break;
        const label = allText(button).trim();
        if (label === 'Capture a new read') {
          await act(async () => {
            (button.props.onPress as () => void)();
          });
          model.handoffArmed = true;
          model.stack.push({ name: 'Analyze' });
          break;
        }
        await act(async () => {
          (button.props.onPress as () => void)();
        });
        model.trainingDirty = true;
        break;
      }
      case 'feedback_press': {
        if (!detailsMounted) break;
        const ids = ['feedback-ask', 'feedback-categories', 'feedback-failed'];
        const [host] = ids.flatMap(id => hostsByTestId(renderer, id));
        if (!host) break;
        const buttons = pressables(host, () => true);
        if (buttons.length === 0) break;
        const button = buttons[action.slot % buttons.length];
        if (!button) break;
        const testID = String(button.props.testID ?? '');
        await act(async () => {
          (button.props.onPress as () => void)();
        });
        if (testID === 'feedback-not-quite') model.feedback = 'categories';
        else if (testID === 'feedback-retry') model.feedback = 'ask';
        else if (
          testID === 'feedback-yes' ||
          testID.startsWith('feedback-category-')
        ) {
          model.feedback =
            model.world.feedback === 'accept'
              ? 'thanks'
              : model.world.feedback === 'slow'
                ? 'sending'
                : 'failed';
        }
        break;
      }
      case 'set_params': {
        if (!detailsMounted) break;
        const route = navigationRef.getCurrentRoute();
        if (!route || route.name !== 'ResultDetails') break;
        const nextId = idFor(model, action.target, action.slot);
        await act(async () => {
          navigationRef.dispatch({
            ...CommonActions.setParams({ analysisId: nextId }),
            source: route.key,
          });
        });
        if (top) top.analysisId = nextId;
        if (nextId !== focusedId) {
          // The sheet is keyed by analysisId: a new id remounts the sheet and
          // its component state (feedback prompt back to "ask").
          model.feedback = 'ask';
        }
        break;
      }
      case 'reopen_details': {
        // The product leaves FormReview / Analyze only by going back; the
        // harness returns to that legal launch point before re-targeting.
        await leaveStandIns();
        const nextId = idFor(model, action.target, action.slot);
        const current = model.stack[model.stack.length - 1];
        await act(async () => {
          navigationRef.navigate('ResultDetails', { analysisId: nextId });
        });
        if (current?.name === 'ResultDetails') {
          // navigate() to the focused route REPLACES its params (v7 stack
          // router); the sheet is keyed by analysisId so a new id remounts.
          if (current.analysisId !== nextId) {
            current.analysisId = nextId;
            model.feedback = 'ask';
          }
        } else {
          mountDetails(nextId);
        }
        break;
      }
      case 'open_result_then_details': {
        await leaveStandIns();
        if (model.stack[model.stack.length - 1]?.name === 'ResultDetails')
          break;
        const nextId = idFor(model, action.target, action.slot);
        await act(async () => {
          navigationRef.navigate('Result', { analysisId: nextId });
        });
        const current = model.stack[model.stack.length - 1];
        if (current?.name === 'Result') {
          current.analysisId = nextId;
        } else {
          model.stack.push({ name: 'Result', analysisId: nextId });
        }
        await settle();
        await act(async () => {
          navigationRef.navigate('ResultDetails', { analysisId: nextId });
        });
        mountDetails(nextId);
        break;
      }
    }
  };

  try {
    await act(async () => {
      renderer = TestRenderer.create(<Host initialState={initialState} />);
    });
    await settle();
    await settle();
    checkInvariants();
    trace.push({ step: 0, action: 'mount', digest: digest() });
    for (let step = 0; step < actions.length; step += 1) {
      const action = actions[step];
      if (!action) break;
      await perform(action);
      await settle();
      await settle();
      if (model.handoffArmed) {
        const handoff = peekTryAgainHandoff();
        check(
          'retry.handoff-armed',
          handoff !== null,
          () => 'no try-again handoff after retry',
        );
        if (handoff) {
          // Mirrors `tryAgainFromResult`: the AUTO/declared provenance lives
          // ONLY in the record's strokeIntent envelope. An absent or
          // unparseable record (and a pre-envelope record) leaves the
          // analyzed shotType as the historical declaration.
          const recordReadable =
            model.world.target.record === 'with_result' ||
            model.world.target.record === 'without_result';
          const intent = recordReadable
            ? model.world.target.intent
            : 'legacy_no_intent';
          const expectDeclared =
            intent === 'auto' ? null : model.world.shotType;
          check(
            'retry.handoff-matches-declaration',
            handoff.source === 'camera' &&
              handoff.declaredStroke === expectDeclared &&
              handoff.auto === (intent === 'auto') &&
              handoff.sessionId === model.world.sessionId,
            () =>
              JSON.stringify({
                handoff,
                intent,
                record: model.world.target.record,
                expectDeclared,
                sessionId: model.world.sessionId,
              }),
          );
          const analyze = hostsByTestId(renderer, 'route-analyze-source');
          check(
            'retry.lands-on-camera-analyze',
            analyze.some(node => node.props.children === 'camera'),
            () => 'Analyze route did not receive { source: "camera" }',
          );
        }
        model.handoffArmed = false;
        clearTryAgainHandoff();
      }
      checkInvariants();
      trace.push({
        step: step + 1,
        action: describeAction(action),
        digest: digest(),
      });
    }
  } catch (error) {
    const step = trace.length;
    const action = actions[step - 1];
    failure = {
      step,
      action: action ? describeAction(action) : 'mount',
      invariant:
        error instanceof InvariantViolation
          ? error.message
          : `exception: ${error instanceof Error ? `${error.name}: ${error.message}\n${(error.stack ?? '').split('\n').slice(1, 8).join('\n')}` : String(error)}`,
      digest: (() => {
        try {
          return digest();
        } catch (digestError) {
          return `digest unavailable: ${String(digestError)}`;
        }
      })(),
    };
  } finally {
    for (const entry of network.pending.splice(0)) {
      entry.resolve(
        jsonResponse(500, { error: { code: 'teardown', message: 'teardown' } }),
      );
    }
    if (renderer) {
      await act(async () => {
        renderer.unmount();
      });
    }
    await settle();
    clearTryAgainHandoff();
    clearApiSession();
    clearTrainingStoreConfiguration();
    console.error = originalError;
    // The RN jest preset installs `performance.now = jest.fn(Date.now)`; every
    // scheduler/animation tick is recorded in `mock.calls`/`mock.results` for
    // the life of the worker (~10k entries per repoint). Drop the recorded
    // calls (implementations are kept) so a 2000-sequence campaign fits in
    // the default heap.
    jest.clearAllMocks();
  }
  const renderErrors = consoleErrors.filter(
    line => !/not wrapped in act|act\(\.\.\.\)/.test(line),
  );
  if (!failure && renderErrors.length > 0) {
    failure = {
      step: trace.length,
      action: 'console.error',
      invariant: `render.no-console-errors: ${renderErrors[0]?.slice(0, 300) ?? ''}`,
      digest: trace[trace.length - 1]?.digest ?? '',
    };
  }
  return {
    seed,
    length: actions.length,
    world: {
      owner: world.owner,
      present: world.target.present,
      kind: world.target.kind,
      record: world.target.record,
      capture: world.target.capture,
      sidecar: world.target.sidecar,
      siblings: world.siblings.length,
      sync: world.sync,
      training: world.training,
      feedback: world.feedback,
      apiSession: world.apiSession,
    },
    outcome: failure ? 'failed' : 'held',
    failure,
    trace,
    consoleErrors: renderErrors,
    requests: network.requests.map(
      r => `${r.method} ${r.url.replace(/^https?:\/\/[^/]+/, '')}`,
    ),
  };
}

// ─── Minimization (delta-debugging over the action list) ────────────────────

export async function minimizeFailure(
  seed: number,
  actions: Action[],
  env: HarnessEnvironment,
  failing: (result: SequenceResult) => boolean,
  budget = 40,
): Promise<{ actions: Action[]; runs: number }> {
  let current = actions;
  let runs = 0;
  // 1. Prefix truncation to the failing step.
  const first = await runSequence(seed, env, { actions: current });
  runs += 1;
  // Failure at trace step k means action k-1 raised it (step 0 = mount): the
  // actions after it cannot matter.
  if (first.failure && first.failure.step < current.length) {
    current = current.slice(0, first.failure.step);
  }
  // 2. Greedy single-action deletion while the failure reproduces.
  let index = 0;
  while (index < current.length && runs < budget) {
    const candidate = [...current.slice(0, index), ...current.slice(index + 1)];
    const result = await runSequence(seed, env, { actions: candidate });
    runs += 1;
    if (failing(result)) {
      current = candidate;
    } else {
      index += 1;
    }
  }
  return { actions: current, runs };
}
