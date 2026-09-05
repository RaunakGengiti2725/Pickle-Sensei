import React from 'react';
import { Linking, RefreshControl, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { writeFileSync } from 'fs';

/**
 * SEEDED RANDOMIZED LONG-RUN stress for the REAL DrillLibraryScreen.
 *
 * What is real here: the screen, `@react-navigation/native` +
 * `@react-navigation/native-stack` (a NavigationContainer with a stub Library
 * route underneath so `goBack` genuinely unmounts the screen), the zustand
 * api-session store, `createTrainingApi` (real request/parsing/TrainingError
 * code), `getDb()` + `listScoredCheckpointFacts` + `computeLibraryFocus`.
 * Only native modules (safe-area, WebView, op-sqlite, Linking.openURL) and
 * `fetch` are replaced. `fetch` is a deterministic in-memory catalog server
 * whose responses are computed when the request ARRIVES (so a list snapshot
 * can legitimately go stale) and DELIVERED only when the action stream says
 * so, in any order, with fault injection (network, 500, 401, 429, malformed).
 *
 * Every sequence is replayable from its seed: `seed → environment` (catalog,
 * detail payloads, local scored facts) and `seed → action stream` are two
 * independent splitmix32 streams; each abstract action carries raw randoms
 * that are resolved against the live UI (e.g. "save card r%n") so any
 * subsequence of a stream is itself replayable — that is what ddmin
 * minimisation relies on.
 *
 * Invariants (model-checked after EVERY action; the model is the fake
 * server + the harness's own bookkeeping):
 *   one-state          exactly one of loading / unconfigured / error / list
 *   no-loading-relapse once the list rendered, the full-screen loading /
 *                      error states never come back (only inline errors)
 *   single-expanded    at most one card is expanded
 *   unique-cards       no duplicated card slug in the render
 *   pending-disabled   a card whose save/unsave is in flight is disabled, and
 *                      a disabled save toggle always has a request in flight
 *   single-flight      the server never sees two concurrent save/unsave
 *                      requests for one slug
 *   detail-once        detail GETs per slug per mount ≤ 1 + failed detail
 *                      responses for that slug (only retry may refetch)
 *   known-toast        the toast is one of the two save confirmations and
 *                      only appears after a successful mutation
 *   honest-error       an inline error is shown only when something actually
 *                      failed in this mount
 *   canonical-links    every Linking.openURL is the canonical YouTube search
 *                      URL for the pressed topic (never a bare /embed/ URL)
 *   copy               no prohibited/unsupported copy, no "undefined"/"NaN"/
 *                      "[object Object]", no internal draft byline
 *   expired-hidden     expired hosted media never renders; media rows equal
 *                      the still-valid media of the ready detail
 *   filtered-count     "<n> of <m> drills" agrees with the rendered cards
 *   player             the in-app player is open ⇔ a media row was tapped
 *                      and not yet closed
 *   unmounted-silence  after goBack no request is issued and settling
 *                      in-flight ones is inert
 *   console-clean      no console.error / console.warn during a sequence
 *   stale-error        SOFT (recorded per seed in the JSON table, does not
 *                      fail the run — it is not a documented contract): at
 *                      quiescence an inline error banner is still shown even
 *                      though a later catalog load succeeded after the
 *                      failure that raised it
 *   quiescent-oracle   with nothing in flight and timers drained, and the
 *                      latest list request having succeeded: rendered slugs
 *                      == server filter(query, family), saved flags ==
 *                      server saved set, selected chip == family, input ==
 *                      query
 *   determinism        the same seed twice yields byte-identical traces
 *
 * Env flags:
 *   STRESS_ITER       number of seeds (default 40 so the suite stays fast)
 *   STRESS_SEED_START first seed (default 1)
 *   STRESS_OUT        path for the seed → outcome JSON table
 *   STRESS_TRACES     "1" to include every per-step trace in that table
 *                     (BROKEN rows always carry their trace)
 *   STRESS_MIN_RUNS   ddmin candidate budget per failing seed (default 120)
 */

jest.mock('react-native-safe-area-context', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  const passthrough = (props: { children?: React.ReactNode }) =>
    ReactActual.createElement(RNView, null, props.children);
  return {
    SafeAreaProvider: passthrough,
    SafeAreaView: passthrough,
    SafeAreaInsetsContext: ReactActual.createContext({
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
    }),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
});

jest.mock('react-native-webview', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

const mockDbBridge: {
  execute:
    ((sql: string) => Promise<{ rows: Record<string, unknown>[] }>) | null;
} = { execute: null };

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => ({
    executeSync: () => ({ rows: [] }),
    execute: (sql: string) => {
      if (!mockDbBridge.execute) throw new Error('db bridge not installed');
      return mockDbBridge.execute(sql);
    },
    close: () => {},
  }),
}));

import { DrillLibraryScreen } from '../../src/screens/DrillLibraryScreen';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';

// ---------------------------------------------------------------------------
// Seeded RNG (splitmix32) — two independent streams per seed.
// ---------------------------------------------------------------------------

interface Rng {
  next(): number;
  int(n: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
}

function splitmix32(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
  return {
    next,
    int: n => (n <= 0 ? 0 : next() % n),
    pick: items => {
      if (items.length === 0) throw new Error('pick from empty');
      return items[next() % items.length] as (typeof items)[number];
    },
    chance: p => next() / 0x1_0000_0000 < p,
  };
}

function uuidFrom(rng: Rng): string {
  const hex = (n: number) =>
    Array.from({ length: n }, () => rng.int(16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

// ---------------------------------------------------------------------------
// Environment (seed-derived catalog + local scored facts).
// ---------------------------------------------------------------------------

const FAMILIES = [
  'dink',
  'volley',
  'drive',
  'serve',
  'return',
  'drop_reset',
  'global',
] as const;

const CHIP_LABELS = [
  'Show all drill families',
  ...FAMILIES.map(f => `Filter ${f.replace(/_/g, ' ')} drills`),
];

const TITLE_WORDS = [
  'Dink',
  'Volley',
  'Drive',
  'Serve',
  'Return',
  'Drop',
  'Reset',
  'Kitchen',
  'Wall',
  'Ladder',
  'Crosscourt',
  'Speed-up',
  'Third shot',
  'Erne',
  'ATP',
  'Split step',
  'Footwork',
  'Paddle path',
  '(regex) [hostile] .* +?',
  'Ünïcödé dïnk',
  '<b>not html</b>',
];
const EQUIPMENT = ['paddle', 'balls', 'cones', 'wall', 'partner', 'ladder'];
const DIFFICULTIES = ['2.5', '3.0', '3.5', '4.0', '4.5', null];
const SHOT_TYPES = [
  'dink',
  'volley',
  'forehand_drive',
  'backhand_drive',
  'serve',
  'return',
  'third_shot_drop',
  'overhead',
];
const CHECKPOINTS = [
  'ready_position',
  'athletic_base',
  'preparation',
  'paddle_set',
  'swing_length',
  'sequencing',
  'paddle_path',
  'contact_position',
  'face_wrist_stability',
  'follow_through',
  'recovery',
];

interface ServerDrill {
  id: string;
  slug: string;
  title: string;
  description: string;
  coach_name: string;
  equipment: string[];
  difficulty_min: string | null;
  difficulty_max: string | null;
  families: string[];
  validation_state: string;
}

interface ServerMedia {
  kind: 'embed' | 'hosted';
  payload: Record<string, unknown>;
  /** hosted only — the harness-side truth used by the expired-hidden check */
  expired: boolean;
}

interface ServerDetail {
  malformed: 'none' | 'bad-embed-url' | 'missing-mappings' | 'not-object';
  mappings: Record<string, unknown>[];
  media: ServerMedia[];
}

interface Environment {
  drills: ServerDrill[];
  initiallySaved: string[];
  details: Map<string, ServerDetail>;
  /** rows returned for the local_shot query, or 'throw' */
  dbRows: Record<string, unknown>[] | 'throw';
  queryPool: string[];
  /** fault mode the server starts in (so the very first catalog load can fail) */
  initialFault: FaultMode;
}

const FIXED_NOW = Date.parse('2026-09-05T12:00:00.000Z');

function buildEnvironment(seed: number): Environment {
  const rng = splitmix32((seed ^ 0x9e3779b9) >>> 0);
  const roll = rng.next() % 100;
  const count = roll < 10 ? 0 : roll < 15 ? 60 : 1 + rng.int(24);
  const drills: ServerDrill[] = [];
  const details = new Map<string, ServerDetail>();
  const initiallySaved: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const slug = `drill-${i}`;
    const title = `${rng.pick(TITLE_WORDS)} ${rng.pick(TITLE_WORDS)} ${i}`;
    const families = [rng.pick(FAMILIES) as string];
    if (rng.chance(0.3)) families.push(rng.pick(FAMILIES));
    const difficulty_min = rng.pick(DIFFICULTIES);
    const difficulty_max = rng.chance(0.5)
      ? difficulty_min
      : rng.pick(DIFFICULTIES);
    drills.push({
      id: uuidFrom(rng),
      slug,
      title,
      description: `${rng.pick(TITLE_WORDS)} reps at the ${rng.pick(EQUIPMENT)} · ${i}`,
      coach_name: rng.chance(0.1)
        ? 'Engineering draft (seed)'
        : `Coach ${rng.pick(TITLE_WORDS)}`,
      equipment: EQUIPMENT.filter(() => rng.chance(0.3)),
      difficulty_min,
      difficulty_max,
      families: [...new Set(families)],
      validation_state: 'UNVALIDATED',
    });
    if (rng.chance(0.3)) initiallySaved.push(slug);

    const mediaCount = rng.int(4);
    const media: ServerMedia[] = [];
    for (let m = 0; m < mediaCount; m += 1) {
      const id = uuidFrom(rng);
      const common = {
        id,
        sourceUrl: `https://www.youtube.com/watch?v=vid${i}_${m}`,
        creatorName: `Creator ${m}`,
        licenseName: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        attribution: `Video ${m} by Creator ${m}, CC BY 4.0`,
      };
      if (rng.chance(0.35)) {
        const expired = rng.chance(0.4);
        media.push({
          kind: 'hosted',
          expired,
          payload: {
            ...common,
            kind: 'hosted',
            playbackUrl: `https://cdn.example.test/${id}.mp4`,
            expiresAt: new Date(
              FIXED_NOW + (expired ? -1 : 1) * 3_600_000,
            ).toISOString(),
          },
        });
      } else if (rng.chance(0.3)) {
        const videoId = `${i}vim${m}`;
        media.push({
          kind: 'embed',
          expired: false,
          payload: {
            ...common,
            sourceUrl: `https://vimeo.com/${videoId}`,
            kind: 'embed',
            provider: 'vimeo',
            videoId,
            embedUrl: `https://player.vimeo.com/video/${videoId}`,
          },
        });
      } else {
        const videoId = `vid${i}_${m}`;
        media.push({
          kind: 'embed',
          expired: false,
          payload: {
            ...common,
            kind: 'embed',
            provider: 'youtube',
            videoId,
            embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
          },
        });
      }
    }
    const mappingCount = rng.int(3);
    const mappings: Record<string, unknown>[] = [];
    for (let k = 0; k < mappingCount; k += 1) {
      mappings.push({
        checkpoint: rng.pick(CHECKPOINTS),
        shot_type: rng.pick(SHOT_TYPES),
        plan_role: rng.chance(0.5) ? 'warmup' : 'targeted',
        fault_directions: rng.chance(0.5) ? ['late'] : [],
        cue_text: `Cue ${k}: ${rng.pick(TITLE_WORDS)}`,
        target_sets: 1 + rng.int(4),
        target_repetitions_per_set: rng.chance(0.5) ? 5 + rng.int(10) : null,
        target_duration_seconds: rng.chance(0.3) ? 30 : null,
        rest_seconds: rng.chance(0.5) ? 20 : null,
      });
    }
    const malformedRoll = rng.next() % 100;
    details.set(slug, {
      malformed:
        malformedRoll < 5
          ? 'bad-embed-url'
          : malformedRoll < 8
            ? 'missing-mappings'
            : malformedRoll < 10
              ? 'not-object'
              : 'none',
      mappings,
      media,
    });
  }

  let dbRows: Environment['dbRows'];
  const dbRoll = rng.next() % 100;
  if (dbRoll < 10) {
    dbRows = 'throw';
  } else if (dbRoll < 45) {
    dbRows = [];
  } else {
    const shotType = rng.pick(SHOT_TYPES);
    const facts = 2 + rng.int(6);
    dbRows = Array.from({ length: facts }, (_, n) => ({
      payload: JSON.stringify({
        id: `shot-${n}`,
        source: 'real',
        resultKind: 'scored',
        shotType,
        capturedAtIso: new Date(FIXED_NOW - (n + 1) * 86_400_000).toISOString(),
        checkpoints: CHECKPOINTS.map(key => ({
          key,
          score: rng.chance(0.8) ? rng.int(101) : null,
          applicable: rng.chance(0.85),
        })),
      }),
    }));
    if (rng.chance(0.3)) dbRows.push({ payload: '{not json' });
  }

  const queryPool = [
    '',
    ' ',
    'dink',
    'DINK',
    'volley',
    'wall',
    'paddle',
    'zzz-no-match',
    '(regex)',
    '[hostile]',
    '.*',
    'Ünïcödé',
    '<b>',
    ...drills.slice(0, 3).map(d => d.title.slice(0, 5)),
  ];

  const initialFault: FaultMode = rng.chance(0.25)
    ? rng.pick(FAULT_MODES)
    : 'ok';

  return { drills, initiallySaved, details, dbRows, queryPool, initialFault };
}

// ---------------------------------------------------------------------------
// Fake server: request-time semantics, action-controlled delivery.
// ---------------------------------------------------------------------------

type FaultMode =
  'ok' | 'network' | 'http500' | 'http401' | 'http429' | 'malformed';
const FAULT_MODES: readonly FaultMode[] = [
  'ok',
  'ok',
  'ok',
  'ok',
  'ok',
  'ok',
  'network',
  'http500',
  'http401',
  'http429',
  'malformed',
];

type RequestKind = 'list' | 'save' | 'unsave' | 'detail' | 'db';

interface Pending {
  id: number;
  kind: RequestKind;
  slug: string | null;
  /** list requests: the (q, family) they were issued for */
  q: string;
  family: string | null;
  fault: FaultMode;
  mount: number;
  deliver: () => void;
}

interface DeliveredRecord {
  id: number;
  kind: RequestKind;
  slug: string | null;
  ok: boolean;
  mount: number;
}

function matchesQuery(drill: ServerDrill, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [drill.title, drill.description, ...drill.equipment]
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

class FakeServer {
  readonly saved: Set<string>;
  readonly pending: Pending[] = [];
  readonly delivered: DeliveredRecord[] = [];
  readonly issued: {
    id: number;
    kind: RequestKind;
    slug: string | null;
    mount: number;
  }[] = [];
  fault: FaultMode;
  mount = 0;
  private nextId = 1;

  constructor(private readonly env: Environment) {
    this.saved = new Set(env.initiallySaved);
    this.fault = env.initialFault;
  }

  expectedList(q: string, family: string | null): ServerDrill[] {
    return this.env.drills.filter(
      d =>
        (family === null || d.families.includes(family)) && matchesQuery(d, q),
    );
  }

  listBody(q: string, family: string | null): unknown {
    return {
      items: this.expectedList(q, family).map(d => ({
        ...d,
        saved: this.saved.has(d.slug),
      })),
    };
  }

  detailBody(slug: string): unknown {
    const drill = this.env.drills.find(d => d.slug === slug);
    const detail = this.env.details.get(slug);
    if (!drill || !detail)
      return { error: { code: 'not_found', message: 'nope' } };
    if (detail.malformed === 'not-object') return [];
    const media = detail.media.map(m => ({ ...m.payload }));
    if (detail.malformed === 'bad-embed-url') {
      const embed = media.find(m => m['kind'] === 'embed');
      if (embed) embed['embedUrl'] = 'https://www.youtube.com/embed/wrong';
    }
    return {
      drill: { ...drill, saved: this.saved.has(slug) },
      mappings:
        detail.malformed === 'missing-mappings' ? undefined : detail.mappings,
      instructionalMedia: media,
    };
  }

  /** Pending requests of `kind` for `slug` issued by `mount` (an unmounted
   *  screen's still-open save cannot disable a card on the next mount). */
  inFlight(kind: RequestKind, slug: string, mount: number): number {
    return this.pending.filter(
      p => p.kind === kind && p.slug === slug && p.mount === mount,
    ).length;
  }

  /** The `fetch` replacement. */
  fetch = (input: string, init?: { method?: string }): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const url = new URL(input);
    const path = url.pathname;
    const fault = this.fault;
    let kind: RequestKind;
    let slug: string | null = null;
    let q = '';
    let family: string | null = null;
    let okBody: unknown = null;
    let okStatus = 200;
    if (method === 'GET' && path === '/v1/catalog/drills') {
      kind = 'list';
      q = url.searchParams.get('q') ?? '';
      family = url.searchParams.get('family');
      okBody = this.listBody(q, family);
    } else if (method === 'GET' && path.startsWith('/v1/catalog/drills/')) {
      kind = 'detail';
      slug = decodeURIComponent(path.slice('/v1/catalog/drills/'.length));
      okBody = this.detailBody(slug);
    } else if (method === 'PUT' && path.startsWith('/v1/me/saved-drills/')) {
      kind = 'save';
      slug = decodeURIComponent(path.slice('/v1/me/saved-drills/'.length));
      if (fault === 'ok') this.saved.add(slug);
      okBody = { slug, saved: true };
    } else if (method === 'DELETE' && path.startsWith('/v1/me/saved-drills/')) {
      kind = 'unsave';
      slug = decodeURIComponent(path.slice('/v1/me/saved-drills/'.length));
      if (fault === 'ok') this.saved.delete(slug);
      okStatus = 204;
    } else {
      throw new Error(`unexpected request ${method} ${input}`);
    }
    return this.enqueue(kind, slug, q, family, fault, (resolve, reject) => {
      switch (fault) {
        case 'network':
          reject(new TypeError('Network request failed'));
          return;
        case 'http500':
          resolve(
            new Response(
              JSON.stringify({
                error: { code: 'internal', message: 'Server hiccup 500.' },
              }),
              { status: 500 },
            ),
          );
          return;
        case 'http401':
          resolve(
            new Response(JSON.stringify({ error: { code: 'unauthorized' } }), {
              status: 401,
            }),
          );
          return;
        case 'http429':
          resolve(
            new Response(
              JSON.stringify({
                error: { code: 'rate_limited', message: 'Slow down 429.' },
              }),
              { status: 429 },
            ),
          );
          return;
        case 'malformed':
          resolve(
            new Response('{"items": [{"nope": true}], "drill": 1', {
              status: 200,
            }),
          );
          return;
        default:
          resolve(
            okStatus === 204
              ? new Response(null, { status: 204 })
              : new Response(JSON.stringify(okBody), { status: 200 }),
          );
      }
    });
  };

  /** op-sqlite `execute` replacement for the local_shot facts query. */
  dbExecute = (): Promise<{ rows: Record<string, unknown>[] }> =>
    this.enqueue('db', null, '', null, 'ok', (resolve, reject) => {
      if (this.env.dbRows === 'throw') reject(new Error('sqlite busy'));
      else resolve({ rows: this.env.dbRows });
    });

  private enqueue<T>(
    kind: RequestKind,
    slug: string | null,
    q: string,
    family: string | null,
    fault: FaultMode,
    settle: (
      resolve: (value: T) => void,
      reject: (error: unknown) => void,
    ) => void,
  ): Promise<T> {
    const id = this.nextId++;
    this.issued.push({ id, kind, slug, mount: this.mount });
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        id,
        kind,
        slug,
        q,
        family,
        fault,
        mount: this.mount,
        deliver: () => {
          this.delivered.push({
            id,
            kind,
            slug,
            ok: fault === 'ok',
            mount: this.mount,
          });
          settle(resolve, reject);
        },
      });
    });
  }

  deliverAt(index: number): Pending | null {
    const [p] = this.pending.splice(index, 1);
    if (!p) return null;
    p.deliver();
    return p;
  }
}

// ---------------------------------------------------------------------------
// Abstract actions (raw randoms resolved against the live UI at execution).
// ---------------------------------------------------------------------------

type ActionKind =
  | 'type'
  | 'typeChar'
  | 'clearSearch'
  | 'family'
  | 'save'
  | 'hammerSave'
  | 'expand'
  | 'retryDetail'
  | 'openMedia'
  | 'closePlayer'
  | 'browse'
  | 'linking'
  | 'refresh'
  | 'retryLoad'
  | 'dismissError'
  | 'tick'
  | 'settleOne'
  | 'settleOldest'
  | 'settleAll'
  | 'fault'
  | 'back'
  | 'reopen'
  | 'session'
  | 'quiesce';

interface Action {
  kind: ActionKind;
  r: [number, number, number];
}

const ACTION_WEIGHTS: readonly [ActionKind, number][] = [
  ['type', 6],
  ['typeChar', 4],
  ['clearSearch', 2],
  ['family', 5],
  ['save', 9],
  ['hammerSave', 2],
  ['expand', 8],
  ['retryDetail', 3],
  ['openMedia', 5],
  ['closePlayer', 3],
  ['browse', 3],
  ['linking', 1],
  ['refresh', 3],
  ['retryLoad', 3],
  ['dismissError', 2],
  ['tick', 8],
  ['settleOne', 9],
  ['settleOldest', 6],
  ['settleAll', 5],
  ['fault', 3],
  ['back', 1],
  ['reopen', 2],
  ['session', 1],
  ['quiesce', 3],
];
const WEIGHT_TOTAL = ACTION_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);

function pickActionKind(rng: Rng): ActionKind {
  let roll = rng.int(WEIGHT_TOTAL);
  for (const [kind, weight] of ACTION_WEIGHTS) {
    if (roll < weight) return kind;
    roll -= weight;
  }
  return 'tick';
}

function generateActions(seed: number): Action[] {
  const rng = splitmix32(seed);
  const length = 5 + rng.int(56); // 5..60 inclusive
  return Array.from({ length }, () => ({
    kind: pickActionKind(rng),
    r: [rng.next(), rng.next(), rng.next()],
  }));
}

const TICKS = [16, 100, 249, 250, 260, 1000, 2500, 3000];

// ---------------------------------------------------------------------------
// Observation of the rendered tree.
// ---------------------------------------------------------------------------

interface CardObs {
  slug: string;
  title: string;
  saved: boolean;
  disabled: boolean;
  expanded: boolean;
  detail: 'none' | 'loading' | 'error' | 'ready';
  mediaRows: number;
  hasRetry: boolean;
}

interface Obs {
  mounted: boolean;
  state: 'loading' | 'unconfigured' | 'error' | 'list' | 'none';
  cards: CardObs[];
  selectedChip: string | null;
  searchValue: string;
  toast: string | null;
  inlineError: string | null;
  playerOpen: boolean;
  resultCount: string | null;
  texts: string[];
}

type Renderer = TestRenderer.ReactTestRenderer;

type Instance = TestRenderer.ReactTestInstance;

/** react-test-renderer unwraps React.memo, so match Pressable by displayName. */
function isPressable(n: Instance): boolean {
  if (typeof n.type === 'string') return false;
  const type = n.type as { displayName?: string; name?: string };
  return (type.displayName ?? type.name) === 'Pressable';
}

function allTexts(root: Instance): string[] {
  const out: string[] = [];
  for (const node of root.findAllByType(Text)) {
    const children = Array.isArray(node.props.children)
      ? node.props.children
      : [node.props.children];
    const s = children
      .filter(
        (c: unknown): c is string | number =>
          typeof c === 'string' || typeof c === 'number',
      )
      .map(String)
      .join('');
    if (s.length > 0) out.push(s);
  }
  return out;
}

function findByTestId(renderer: Renderer, testID: string) {
  return renderer.root.findAll(
    n => n.props.testID === testID && typeof n.type !== 'string',
  );
}

function findPressableByLabel(renderer: Renderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  return node ?? null;
}

function findPressablesByLabelPrefix(renderer: Renderer, prefix: string) {
  return renderer.root.findAll(
    n =>
      typeof n.props.accessibilityLabel === 'string' &&
      n.props.accessibilityLabel.startsWith(prefix) &&
      typeof n.props.onPress === 'function' &&
      isPressable(n),
  );
}

function observe(renderer: Renderer): Obs {
  const texts = allTexts(renderer.root);
  const searchInputs = findByTestId(renderer, 'drill-search-input');
  const mounted = searchInputs.length > 0;
  const loading = texts.some(t => t === 'Loading the drill catalog…');
  const unconfigured =
    findByTestId(renderer, 'drill-library-unconfigured').length > 0;
  const errorState = texts.some(t => t === 'The drill catalog could not load.');
  const list = renderer.root.findAllByType(RefreshControl).length > 0;
  const flags = [loading, unconfigured, errorState, list].filter(
    Boolean,
  ).length;
  const state: Obs['state'] = !mounted
    ? 'none'
    : flags !== 1
      ? 'none'
      : loading
        ? 'loading'
        : unconfigured
          ? 'unconfigured'
          : errorState
            ? 'error'
            : 'list';

  const cards: CardObs[] = [];
  const seenCardNodes = new Set<string>();
  for (const card of renderer.root.findAll(
    n =>
      typeof n.props.testID === 'string' &&
      n.props.testID.startsWith('drill-card-') &&
      typeof n.type === 'string',
  )) {
    const slug = (card.props.testID as string).slice('drill-card-'.length);
    // The RN jest View mock renders a nested host View with the same testID;
    // only the outermost host node per rendered card is a distinct card.
    if (
      card.parent &&
      typeof card.parent.type === 'string' &&
      card.parent.props.testID === card.props.testID
    ) {
      continue;
    }
    void seenCardNodes;
    const toggle = card.findAll(
      n => n.props.testID === `save-toggle-${slug}` && isPressable(n),
    )[0];
    const expandNode = card.findAll(
      n =>
        isPressable(n) &&
        typeof n.props.accessibilityLabel === 'string' &&
        /^(Show|Hide) detail for /.test(n.props.accessibilityLabel),
    )[0];
    const cardTexts = allTexts(card);
    const detail: CardObs['detail'] = cardTexts.some(
      t => t === 'Loading drill detail…',
    )
      ? 'loading'
      : cardTexts.some(t => t.startsWith('Drill detail could not be loaded'))
        ? 'error'
        : cardTexts.some(t => t === 'More drills on YouTube')
          ? 'ready'
          : 'none';
    cards.push({
      slug,
      title: String(cardTexts[0] ?? ''),
      saved: toggle?.props.accessibilityState?.selected === true,
      disabled: toggle?.props.disabled === true,
      expanded: expandNode?.props.accessibilityState?.expanded === true,
      detail,
      mediaRows: card.findAll(
        n =>
          typeof n.props.testID === 'string' &&
          n.props.testID.startsWith(`watch-media-${slug}-`) &&
          isPressable(n),
      ).length,
      hasRetry:
        card.findAll(
          n =>
            n.props.accessibilityLabel ===
              `Retry detail for ${cardTexts[0] ?? ''}` && isPressable(n),
        ).length > 0,
    });
  }

  let selectedChip: string | null = null;
  for (const label of CHIP_LABELS) {
    const chip = findPressableByLabel(renderer, label);
    if (chip?.props.accessibilityState?.selected === true) {
      selectedChip = selectedChip === null ? label : `${selectedChip}+${label}`;
    }
  }

  const toastNode = renderer.root.findAll(
    n =>
      n.props.accessibilityLiveRegion === 'polite' &&
      n.props.pointerEvents === 'none',
  )[0];
  const toast = toastNode ? (allTexts(toastNode)[0] ?? null) : null;
  const inlineNode = findByTestId(renderer, 'drill-library-inline-error')[0];
  const inlineError = inlineNode ? (allTexts(inlineNode)[0] ?? null) : null;
  const playerOpen = findByTestId(renderer, 'drill-video-player').length > 0;
  const resultCount = texts.find(t => /^\d+ of \d+ drills?$/.test(t)) ?? null;

  return {
    mounted,
    state,
    cards,
    selectedChip,
    searchValue: mounted ? String(searchInputs[0]?.props.value ?? '') : '',
    toast,
    inlineError,
    playerOpen,
    resultCount,
    texts,
  };
}

function digest(obs: Obs, server: FakeServer): string {
  return [
    obs.state,
    `q=${JSON.stringify(obs.searchValue)}`,
    `chip=${obs.selectedChip ?? '-'}`,
    `cards=${obs.cards
      .map(
        c =>
          `${c.slug}${c.saved ? '*' : ''}${c.disabled ? '!' : ''}${c.expanded ? `^${c.detail}/${c.mediaRows}` : ''}`,
      )
      .join(',')}`,
    `toast=${obs.toast ?? '-'}`,
    `err=${obs.inlineError ?? '-'}`,
    `player=${obs.playerOpen ? 1 : 0}`,
    `pending=${server.pending.map(p => `${p.id}${p.kind[0]}`).join(',')}`,
    `saved=${[...server.saved].sort().join(',')}`,
  ].join('|');
}

// ---------------------------------------------------------------------------
// Invariants.
// ---------------------------------------------------------------------------

class InvariantViolation extends Error {
  constructor(
    readonly invariant: string,
    detail: string,
  ) {
    super(`${invariant}: ${detail}`);
  }
}

const PROHIBITED_COPY =
  /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|engineering draft|\bundefined\b|\bNaN\b|\[object Object\]|\d+\s?% accur|best in class|world.?class/i;
const KNOWN_TOASTS = new Set([
  'Saved to your library · Library → Saved drills',
  'Removed from saved drills',
]);

interface MountModel {
  mount: number;
  everListed: boolean;
  failures: number;
  everUnconfigured: boolean;
  linkingRejected: boolean;
  /** position in the delivered log when Linking last rejected (-1 = never) */
  linkingRejectedPos: number;
  successfulMutations: number;
  linkingCalls: string[];
  browsedTopics: string[];
  mediaOpens: number;
  playerCloses: number;
}

interface Model {
  server: FakeServer;
  env: Environment;
  sessionConfigured: boolean;
  current: MountModel;
  consoleNoise: string[];
  fetchCallsAfterUnmount: number;
  query: string;
  family: string | null;
  /** soft (non-failing) observations, one line each */
  soft: string[];
}

function checkInvariants(obs: Obs, model: Model): void {
  const { server, current } = model;
  if (model.consoleNoise.length > 0) {
    throw new InvariantViolation(
      'console-clean',
      model.consoleNoise.join(' || ').slice(0, 600),
    );
  }
  if (!obs.mounted) {
    if (model.fetchCallsAfterUnmount > 0) {
      throw new InvariantViolation(
        'unmounted-silence',
        `${model.fetchCallsAfterUnmount} request(s) issued after goBack`,
      );
    }
    return;
  }
  if (obs.state === 'none') {
    throw new InvariantViolation(
      'one-state',
      `states not mutually exclusive / none rendered: ${obs.texts.slice(0, 12).join(' | ')}`,
    );
  }
  if (current.everListed && obs.state !== 'list') {
    throw new InvariantViolation(
      'no-loading-relapse',
      `state ${obs.state} after the list had rendered`,
    );
  }
  const expandedCount = obs.cards.filter(c => c.expanded).length;
  if (expandedCount > 1) {
    throw new InvariantViolation(
      'single-expanded',
      `${expandedCount} cards expanded`,
    );
  }
  const slugs = obs.cards.map(c => c.slug);
  if (new Set(slugs).size !== slugs.length) {
    throw new InvariantViolation('unique-cards', slugs.join(','));
  }
  for (const card of obs.cards) {
    const inFlight =
      server.inFlight('save', card.slug, current.mount) +
      server.inFlight('unsave', card.slug, current.mount);
    if (inFlight > 1) {
      throw new InvariantViolation(
        'single-flight',
        `${inFlight} save mutations in flight for ${card.slug}`,
      );
    }
    if (card.disabled !== (inFlight === 1)) {
      throw new InvariantViolation(
        'pending-disabled',
        `${card.slug} disabled=${card.disabled} inFlight=${inFlight}`,
      );
    }
    if (!card.expanded && card.detail !== 'none') {
      throw new InvariantViolation(
        'single-expanded',
        `${card.slug} shows detail while collapsed`,
      );
    }
    if (card.expanded && card.detail === 'ready') {
      const detail = model.env.details.get(card.slug);
      const expectedRows = detail
        ? detail.media.filter(m => !m.expired).length
        : 0;
      if (card.mediaRows !== expectedRows) {
        throw new InvariantViolation(
          'expired-hidden',
          `${card.slug} renders ${card.mediaRows} media rows, expected ${expectedRows}`,
        );
      }
    }
    if (card.detail === 'error' && !card.hasRetry) {
      throw new InvariantViolation(
        'detail-retry',
        `${card.slug} detail error without retry`,
      );
    }
  }
  // detail-once: GETs per slug in this mount ≤ 1 + failed detail deliveries.
  const detailIssued = new Map<string, number>();
  for (const r of server.issued) {
    if (r.kind === 'detail' && r.mount === current.mount && r.slug) {
      detailIssued.set(r.slug, (detailIssued.get(r.slug) ?? 0) + 1);
    }
  }
  for (const [slug, n] of detailIssued) {
    const failed = server.delivered.filter(
      d =>
        d.kind === 'detail' &&
        d.slug === slug &&
        d.mount === current.mount &&
        !d.ok,
    ).length;
    const malformed = server.delivered.filter(
      d =>
        d.kind === 'detail' &&
        d.slug === slug &&
        d.mount === current.mount &&
        d.ok &&
        model.env.details.get(slug)?.malformed !== 'none',
    ).length;
    if (n > 1 + failed + malformed) {
      throw new InvariantViolation(
        'detail-once',
        `${slug} fetched ${n}× with ${failed + malformed} failure(s)`,
      );
    }
  }
  if (obs.toast !== null) {
    if (!KNOWN_TOASTS.has(obs.toast)) {
      throw new InvariantViolation('known-toast', JSON.stringify(obs.toast));
    }
    if (current.successfulMutations === 0) {
      throw new InvariantViolation(
        'known-toast',
        'toast without a successful mutation this mount',
      );
    }
  }
  if (
    obs.inlineError !== null &&
    current.failures === 0 &&
    !current.linkingRejected &&
    !current.everUnconfigured
  ) {
    throw new InvariantViolation(
      'honest-error',
      `inline error ${JSON.stringify(obs.inlineError)} with no failure`,
    );
  }
  for (const url of current.linkingCalls) {
    if (
      !url.startsWith('https://www.youtube.com/results?search_query=') ||
      url.includes('/embed/')
    ) {
      throw new InvariantViolation('canonical-links', url);
    }
  }
  const expectedLinks = current.browsedTopics.map(
    topic =>
      'https://www.youtube.com/results?search_query=' +
      encodeURIComponent(`${topic} pickleball drill`),
  );
  if (JSON.stringify(expectedLinks) !== JSON.stringify(current.linkingCalls)) {
    throw new InvariantViolation(
      'canonical-links',
      `opened ${JSON.stringify(current.linkingCalls)} expected ${JSON.stringify(expectedLinks)}`,
    );
  }
  for (const text of obs.texts) {
    if (PROHIBITED_COPY.test(text)) {
      throw new InvariantViolation('copy', JSON.stringify(text));
    }
  }
  if (obs.resultCount !== null) {
    const shown = Number(obs.resultCount.split(' ')[0]);
    if (shown !== obs.cards.length) {
      throw new InvariantViolation(
        'filtered-count',
        `${obs.resultCount} but ${obs.cards.length} cards`,
      );
    }
  }
  if (obs.playerOpen !== current.mediaOpens > current.playerCloses) {
    throw new InvariantViolation(
      'player',
      `open=${obs.playerOpen} opens=${current.mediaOpens} closes=${current.playerCloses}`,
    );
  }
}

/** Only valid with nothing in flight and all timers drained. */
function checkQuiescentOracle(obs: Obs, model: Model): void {
  if (!obs.mounted) return;
  if (obs.state === 'loading') {
    throw new InvariantViolation(
      'quiescent-oracle',
      'still loading with nothing in flight',
    );
  }
  if (obs.searchValue !== model.query) {
    throw new InvariantViolation(
      'quiescent-oracle',
      `input ${JSON.stringify(obs.searchValue)} != model ${JSON.stringify(model.query)}`,
    );
  }
  const expectedChip =
    model.family === null
      ? CHIP_LABELS[0]
      : `Filter ${model.family.replace(/_/g, ' ')} drills`;
  if (obs.selectedChip !== expectedChip) {
    throw new InvariantViolation(
      'quiescent-oracle',
      `chip ${obs.selectedChip} != ${expectedChip}`,
    );
  }
  const { server, current } = model;
  if (obs.inlineError !== null && !current.everUnconfigured) {
    const mountDelivered = server.delivered.filter(
      d => d.mount === current.mount,
    );
    let lastFailurePos = current.linkingRejectedPos;
    let lastOkListPos = -1;
    mountDelivered.forEach((d, pos) => {
      if (
        !d.ok &&
        (d.kind === 'list' || d.kind === 'save' || d.kind === 'unsave')
      )
        lastFailurePos = pos;
      if (d.ok && d.kind === 'list') lastOkListPos = pos;
    });
    if (lastOkListPos > lastFailurePos) {
      model.soft.push(
        `stale-error: inline error ${JSON.stringify(obs.inlineError)} still shown after a later successful catalog load (failure@${lastFailurePos}, ok list@${lastOkListPos})`,
      );
    }
  }
  const lists = server.delivered.filter(
    d => d.kind === 'list' && d.mount === current.mount,
  );
  const latestIssued = [...server.issued]
    .filter(r => r.kind === 'list' && r.mount === current.mount)
    .pop();
  const latest = latestIssued
    ? lists.find(d => d.id === latestIssued.id)
    : undefined;
  if (!model.sessionConfigured) {
    if (obs.state === 'list' && !current.everListed) {
      throw new InvariantViolation(
        'quiescent-oracle',
        'list without a session and without data',
      );
    }
    return;
  }
  if (!latest || !latest.ok) {
    if (obs.state === 'list' && !current.everListed) {
      throw new InvariantViolation(
        'quiescent-oracle',
        'list rendered although no list request ever succeeded',
      );
    }
    return;
  }
  if (obs.state !== 'list') {
    throw new InvariantViolation(
      'quiescent-oracle',
      `latest list succeeded but state is ${obs.state}`,
    );
  }
  const expected = server.expectedList(model.query, model.family);
  const expectedSlugs = expected.map(d => d.slug).sort();
  const shownSlugs = obs.cards.map(c => c.slug).sort();
  if (JSON.stringify(expectedSlugs) !== JSON.stringify(shownSlugs)) {
    throw new InvariantViolation(
      'quiescent-oracle',
      `slugs ${JSON.stringify(shownSlugs)} != server ${JSON.stringify(expectedSlugs)} for q=${JSON.stringify(model.query)} family=${model.family}`,
    );
  }
  for (const card of obs.cards) {
    if (card.saved !== server.saved.has(card.slug)) {
      throw new InvariantViolation(
        'quiescent-oracle',
        `${card.slug} rendered saved=${card.saved} but server saved=${server.saved.has(card.slug)}`,
      );
    }
  }
  const filtered = model.query.trim().length > 0 || model.family !== null;
  if (
    model.env.drills.length === 0 &&
    !filtered &&
    !obs.texts.includes('No drills published yet')
  ) {
    throw new InvariantViolation(
      'quiescent-oracle',
      'empty catalog without the empty state',
    );
  }
  if (
    expected.length === 0 &&
    filtered &&
    !obs.texts.includes('No drills match')
  ) {
    throw new InvariantViolation(
      'quiescent-oracle',
      'no matches without the no-match state',
    );
  }
}

// ---------------------------------------------------------------------------
// Sequence executor.
// ---------------------------------------------------------------------------

const navigationRef = createNavigationContainerRef<Record<string, undefined>>();
const Stack = createNativeStackNavigator<Record<string, undefined>>();

function LibraryStub() {
  return <Text>Library stub</Text>;
}
function ConnectAccountStub() {
  return <Text>Connect account stub</Text>;
}

function Harness() {
  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator initialRouteName="Library">
        <Stack.Screen name="Library" component={LibraryStub} />
        <Stack.Screen name="DrillLibrary" component={DrillLibraryScreen} />
        <Stack.Screen name="ConnectAccount" component={ConnectAccountStub} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const SESSION = {
  apiBaseUrl: 'https://api.stress.test',
  bearerToken: 'stress-bearer-1',
  canonicalAppUserId: '11111111-1111-4111-a111-111111111111',
  provider: 'apple' as const,
};

interface StepRecord {
  i: number;
  action: string;
  digest: string;
}

interface SequenceResult {
  seed: number;
  length: number;
  outcome: 'HELD' | 'BROKEN';
  steps: number;
  invariant?: string;
  detail?: string;
  failedAt?: number;
  failedAction?: string;
  trace: StepRecord[];
  actionCounts: Record<string, number>;
  /** actions that actually did something (target existed / request pending) */
  effectiveCounts: Record<string, number>;
  invariantChecks: number;
  soft: string[];
}

async function settle() {
  await act(async () => {});
}

async function press(node: TestRenderer.ReactTestInstance | null | undefined) {
  if (!node || node.props.disabled === true) return false;
  await act(async () => {
    node.props.onPress();
  });
  return true;
}

async function runSequence(
  seed: number,
  actions: Action[],
): Promise<SequenceResult> {
  const env = buildEnvironment(seed);
  const server = new FakeServer(env);
  const model: Model = {
    server,
    env,
    sessionConfigured: true,
    current: freshMount(1, true),
    consoleNoise: [],
    fetchCallsAfterUnmount: 0,
    query: '',
    family: null,
    soft: [],
  };
  const actionCounts: Record<string, number> = {};
  const effectiveCounts: Record<string, number> = {};
  const trace: StepRecord[] = [];
  let invariantChecks = 0;
  let mounted = false;
  let linkingRejects = false;

  const originalFetch = global.fetch;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => {
    model.consoleNoise.push(`error: ${args.map(String).join(' ')}`);
  };
  console.warn = (...args: unknown[]) => {
    model.consoleNoise.push(`warn: ${args.map(String).join(' ')}`);
  };
  global.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (!mounted) model.fetchCallsAfterUnmount += 1;
    return server.fetch(String(input), init as { method?: string });
  }) as typeof fetch;
  mockDbBridge.execute = server.dbExecute;
  const linkingSpy = jest
    .spyOn(Linking, 'openURL')
    .mockImplementation((url: string) => {
      model.current.linkingCalls.push(url);
      if (linkingRejects) {
        model.current.linkingRejected = true;
        model.current.linkingRejectedPos = server.delivered.length - 1;
        return Promise.reject(new Error('no handler'));
      }
      return Promise.resolve();
    });

  jest.useFakeTimers();
  jest.setSystemTime(FIXED_NOW);
  establishApiSession(SESSION);
  // Mirrors authStore.installApiSession → handleApiUnauthorized: a 401 for
  // the live bearer is the app's one implicit sign-out (the ApiSession store
  // is cleared; the screen must fall back to its unconfigured state).
  setApiUnauthorizedListener(() => clearApiSession());
  server.mount = 1;

  let renderer!: Renderer;
  let result: SequenceResult | null = null;
  try {
    await act(async () => {
      renderer = TestRenderer.create(<Harness />);
    });
    mounted = true;
    await act(async () => {
      navigationRef.navigate('DrillLibrary');
    });
    await settle();

    const record = (i: number, label: string) => {
      const obs = observe(renderer);
      trace.push({ i, action: label, digest: digest(obs, server) });
      return obs;
    };
    const check = (obs: Obs) => {
      invariantChecks += 1;
      if (getApiSession() === null && model.sessionConfigured) {
        model.sessionConfigured = false;
        model.current.everUnconfigured = true;
      }
      syncMountModel(model);
      checkInvariants(obs, model);
    };

    check(record(-1, 'mount'));

    const quiesce = async () => {
      for (let round = 0; round < 12; round += 1) {
        await act(async () => {
          jest.advanceTimersByTime(300);
        });
        await settle();
        while (server.pending.length > 0) {
          await act(async () => {
            server.deliverAt(0);
          });
          await settle();
        }
        await settle();
        if (server.pending.length === 0 && jest.getTimerCount() === 0) break;
        if (server.pending.length === 0) {
          // Only the toast / debounce timers may remain; drain them once more.
          await act(async () => {
            jest.advanceTimersByTime(3000);
          });
          await settle();
          if (server.pending.length === 0) break;
        }
      }
    };

    for (let i = 0; i < actions.length; i += 1) {
      const action = actions[i]!;
      actionCounts[action.kind] = (actionCounts[action.kind] ?? 0) + 1;
      const [r0, r1] = action.r;
      const before = observe(renderer);
      let label: string = action.kind;
      let acted = false;
      const cards = before.cards;
      const pickCard = () => cards[r0 % cards.length];

      switch (action.kind) {
        case 'type': {
          if (!before.mounted) break;
          const value = env.queryPool[r0 % env.queryPool.length] ?? '';
          label = `type(${JSON.stringify(value)})`;
          const input = findByTestId(renderer, 'drill-search-input')[0];
          if (!input) break;
          await act(async () => {
            input.props.onChangeText(value);
          });
          model.query = value;
          acted = true;
          break;
        }
        case 'typeChar': {
          if (!before.mounted) break;
          const next =
            r1 % 3 === 0 && model.query.length > 0
              ? model.query.slice(0, -1)
              : model.query + String.fromCharCode(97 + (r0 % 26));
          label = `typeChar(${JSON.stringify(next)})`;
          const input = findByTestId(renderer, 'drill-search-input')[0];
          if (!input) break;
          await act(async () => {
            input.props.onChangeText(next);
          });
          model.query = next;
          acted = true;
          break;
        }
        case 'clearSearch': {
          acted = await press(findPressableByLabel(renderer, 'Clear search'));
          if (acted) model.query = '';
          break;
        }
        case 'family': {
          const idx = r0 % CHIP_LABELS.length;
          label = `family(${idx})`;
          acted = await press(
            findPressableByLabel(renderer, CHIP_LABELS[idx]!),
          );
          if (acted) model.family = idx === 0 ? null : FAMILIES[idx - 1]!;
          break;
        }
        case 'save': {
          if (cards.length === 0) break;
          const card = pickCard()!;
          label = `save(${card.slug})`;
          const toggle = findByTestId(
            renderer,
            `save-toggle-${card.slug}`,
          ).find(n => isPressable(n));
          acted = await press(toggle);
          break;
        }
        case 'hammerSave': {
          if (cards.length === 0) break;
          const card = pickCard()!;
          const times = 2 + (r1 % 4);
          label = `hammerSave(${card.slug}×${times})`;
          const toggle = findByTestId(
            renderer,
            `save-toggle-${card.slug}`,
          ).find(n => isPressable(n));
          if (toggle && toggle.props.disabled !== true) {
            await act(async () => {
              for (let k = 0; k < times; k += 1) toggle.props.onPress();
            });
            acted = true;
          }
          break;
        }
        case 'expand': {
          if (cards.length === 0) break;
          const card = pickCard()!;
          label = `expand(${card.slug})`;
          const node = findPressablesByLabelPrefix(
            renderer,
            `${card.expanded ? 'Hide' : 'Show'} detail for ${card.title}`,
          )[0];
          acted = await press(node);
          break;
        }
        case 'retryDetail': {
          const nodes = findPressablesByLabelPrefix(
            renderer,
            'Retry detail for ',
          );
          if (nodes.length === 0) break;
          acted = await press(nodes[r0 % nodes.length]);
          break;
        }
        case 'openMedia': {
          const nodes = renderer.root.findAll(
            n =>
              typeof n.props.testID === 'string' &&
              n.props.testID.startsWith('watch-media-') &&
              isPressable(n),
          );
          if (nodes.length === 0 || before.playerOpen) break;
          const node = nodes[r0 % nodes.length]!;
          label = `openMedia(${node.props.testID})`;
          acted = await press(node);
          if (acted) model.current.mediaOpens += 1;
          break;
        }
        case 'closePlayer': {
          if (!before.playerOpen) break;
          const node = findPressableByLabel(
            renderer,
            r1 % 2 === 0 ? 'Close video player' : 'Dismiss video',
          );
          acted = await press(node);
          if (acted) model.current.playerCloses += 1;
          break;
        }
        case 'browse': {
          const nodes = renderer.root.findAll(
            n =>
              isPressable(n) &&
              ((typeof n.props.testID === 'string' &&
                n.props.testID.startsWith('browse-videos-')) ||
                n.props.testID === 'search-youtube'),
          );
          if (nodes.length === 0) break;
          const node = nodes[r0 % nodes.length]!;
          const testID = node.props.testID as string;
          // The all-of-YouTube row searches the query it *labels* (the debounced
          // one that produced the current results), not the live input text.
          const topic =
            testID === 'search-youtube'
              ? (/^Search YouTube: "(.*)" pickleball drills$/s.exec(
                  String(node.props.accessibilityLabel),
                )?.[1] ?? '')
              : (cards.find(
                  c => c.slug === testID.slice('browse-videos-'.length),
                )?.title ?? '');
          label = `browse(${testID})`;
          acted = await press(node);
          if (acted) model.current.browsedTopics.push(topic);
          break;
        }
        case 'linking': {
          linkingRejects = r0 % 2 === 0;
          label = `linking(${linkingRejects ? 'reject' : 'resolve'})`;
          acted = true;
          break;
        }
        case 'refresh': {
          const control = renderer.root.findAllByType(RefreshControl)[0];
          if (!control) break;
          await act(async () => {
            control.props.onRefresh();
          });
          acted = true;
          break;
        }
        case 'retryLoad': {
          acted = await press(findPressableByLabel(renderer, 'Try again'));
          break;
        }
        case 'dismissError': {
          acted = await press(findPressableByLabel(renderer, 'Dismiss error'));
          break;
        }
        case 'tick': {
          const ms = TICKS[r0 % TICKS.length]!;
          label = `tick(${ms})`;
          await act(async () => {
            jest.advanceTimersByTime(ms);
          });
          acted = true;
          break;
        }
        case 'settleOne': {
          if (server.pending.length === 0) break;
          const idx = r0 % server.pending.length;
          const p = server.pending[idx]!;
          label = `settleOne(#${p.id} ${p.kind} ${p.fault})`;
          await act(async () => {
            server.deliverAt(idx);
          });
          acted = true;
          break;
        }
        case 'settleOldest': {
          if (server.pending.length === 0) break;
          const p = server.pending[0]!;
          label = `settleOldest(#${p.id} ${p.kind} ${p.fault})`;
          await act(async () => {
            server.deliverAt(0);
          });
          acted = true;
          break;
        }
        case 'settleAll': {
          if (server.pending.length === 0) break;
          const order = r1 % 2 === 0 ? 'fifo' : 'lifo';
          label = `settleAll(${order}:${server.pending.map(p => `#${p.id}${p.kind[0]}${p.fault === 'ok' ? '' : '×'}`).join(',')})`;
          while (server.pending.length > 0) {
            await act(async () => {
              server.deliverAt(
                order === 'fifo' ? 0 : server.pending.length - 1,
              );
            });
          }
          acted = true;
          break;
        }
        case 'fault': {
          server.fault = FAULT_MODES[r0 % FAULT_MODES.length]!;
          label = `fault(${server.fault})`;
          acted = true;
          break;
        }
        case 'back': {
          if (!before.mounted) break;
          acted = await press(findPressableByLabel(renderer, 'Back'));
          await settle();
          mounted = observe(renderer).mounted;
          break;
        }
        case 'reopen': {
          if (before.mounted) break;
          server.mount += 1;
          model.current = freshMount(server.mount, model.sessionConfigured);
          model.query = '';
          model.family = null;
          mounted = true;
          await act(async () => {
            navigationRef.navigate('DrillLibrary');
          });
          acted = true;
          break;
        }
        case 'session': {
          const mode = r0 % 3;
          if (mode === 0) {
            label = 'session(clear)';
            await act(async () => {
              clearApiSession();
            });
            model.sessionConfigured = false;
            model.current.everUnconfigured = true;
          } else {
            const token =
              mode === 1 ? SESSION.bearerToken : `stress-bearer-${r1 % 1000}`;
            label = `session(${mode === 1 ? 'restore' : 'rotate'})`;
            await act(async () => {
              establishApiSession({ ...SESSION, bearerToken: token });
            });
            model.sessionConfigured = true;
          }
          acted = true;
          break;
        }
        case 'quiesce': {
          await quiesce();
          acted = true;
          break;
        }
        default: {
          const never: never = action.kind;
          throw new Error(`unknown action ${String(never)}`);
        }
      }
      if (acted)
        effectiveCounts[action.kind] = (effectiveCounts[action.kind] ?? 0) + 1;
      await settle();
      const obs = record(i, acted ? label : `${label}~noop`);
      if (obs.state === 'list') model.current.everListed = true;
      check(obs);
      if (action.kind === 'quiesce') checkQuiescentOracle(obs, model);
    }

    await quiesce();
    const finalObs = record(actions.length, 'final-quiesce');
    if (finalObs.state === 'list') model.current.everListed = true;
    check(finalObs);
    checkQuiescentOracle(finalObs, model);

    result = {
      seed,
      length: actions.length,
      outcome: 'HELD',
      steps: trace.length,
      trace,
      actionCounts,
      effectiveCounts,
      invariantChecks,
      soft: model.soft,
    };
  } catch (error) {
    const last = trace[trace.length - 1];
    result = {
      seed,
      length: actions.length,
      outcome: 'BROKEN',
      steps: trace.length,
      invariant:
        error instanceof InvariantViolation ? error.invariant : 'exception',
      detail:
        error instanceof Error ? error.message.slice(0, 800) : String(error),
      failedAt: last?.i,
      failedAction: last?.action,
      trace,
      actionCounts,
      effectiveCounts,
      invariantChecks,
      soft: model.soft,
    };
  } finally {
    try {
      if (renderer) {
        await act(async () => {
          renderer.unmount();
        });
      }
    } catch {
      // unmount failures are reported through the sequence result already
    }
    linkingSpy.mockRestore();
    global.fetch = originalFetch;
    console.error = originalError;
    console.warn = originalWarn;
    mockDbBridge.execute = null;
    setApiUnauthorizedListener(null);
    clearApiSession();
    jest.clearAllTimers();
    jest.useRealTimers();
    // RN's preset mocks (Linking/AppState/Dimensions listeners) are jest.fn()s
    // whose recorded call args would otherwise pin every mounted tree.
    jest.clearAllMocks();
  }
  return result;

  function freshMount(mount: number, configured: boolean): MountModel {
    return {
      mount,
      everListed: false,
      failures: 0,
      everUnconfigured: !configured,
      linkingRejected: false,
      linkingRejectedPos: -1,
      successfulMutations: 0,
      linkingCalls: [],
      browsedTopics: [],
      mediaOpens: 0,
      playerCloses: 0,
    };
  }
}

// The server bookkeeping that the invariants read (failures per mount,
// successful mutations) is derived from delivered requests.
function syncMountModel(model: Model): void {
  const { server, current } = model;
  current.failures = server.delivered.filter(
    d => d.mount === current.mount && !d.ok,
  ).length;
  current.failures += server.delivered.filter(
    d =>
      d.mount === current.mount &&
      d.ok &&
      ((d.kind === 'detail' &&
        model.env.details.get(d.slug ?? '')?.malformed !== 'none') ||
        (d.kind === 'db' && model.env.dbRows === 'throw')),
  ).length;
  current.successfulMutations = server.delivered.filter(
    d =>
      d.mount === current.mount &&
      d.ok &&
      (d.kind === 'save' || d.kind === 'unsave'),
  ).length;
}

// ---------------------------------------------------------------------------
// ddmin minimisation of a failing action list (same seed → same environment).
// ---------------------------------------------------------------------------

const MIN_RUNS = Math.max(1, Number(process.env['STRESS_MIN_RUNS'] ?? 120));

interface Minimised {
  actions: Action[];
  runs: number;
  complete: boolean;
}

/**
 * ddmin over the action list. Bounded by STRESS_MIN_RUNS candidate runs so a
 * cluster of same-cause failures cannot stall the campaign; `complete` says
 * whether the 1-minimal fixpoint was reached within the budget.
 */
async function minimise(
  seed: number,
  actions: Action[],
  invariant: string,
): Promise<Minimised> {
  let current = actions;
  let granularity = 2;
  let runs = 0;
  const fails = async (candidate: Action[]) => {
    runs += 1;
    const r = await runSequence(seed, candidate);
    return r.outcome === 'BROKEN' && r.invariant === invariant;
  };
  while (current.length >= 2 && runs < MIN_RUNS) {
    const chunk = Math.ceil(current.length / granularity);
    let reduced = false;
    for (
      let start = 0;
      start < current.length && runs < MIN_RUNS;
      start += chunk
    ) {
      const candidate = [
        ...current.slice(0, start),
        ...current.slice(start + chunk),
      ];
      if (candidate.length === 0) continue;
      if (await fails(candidate)) {
        current = candidate;
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= current.length)
        return { actions: current, runs, complete: true };
      granularity = Math.min(current.length, granularity * 2);
    }
  }
  return { actions: current, runs, complete: current.length < 2 };
}

// ---------------------------------------------------------------------------
// Campaign.
// ---------------------------------------------------------------------------

const ITERATIONS = Math.max(1, Number(process.env['STRESS_ITER'] ?? 40));
const SEED_START = Number(process.env['STRESS_SEED_START'] ?? 1);
const OUT_PATH = process.env['STRESS_OUT'];
const KEEP_TRACES = process.env['STRESS_TRACES'] === '1';
const CHUNK = 25;

interface TableRow {
  seed: number;
  length: number;
  outcome: 'HELD' | 'BROKEN';
  steps: number;
  invariantChecks: number;
  invariant?: string;
  detail?: string;
  failedAt?: number;
  failedAction?: string;
  minimized?: string[];
  minimizedLength?: number;
  minimizationRuns?: number;
  minimizationComplete?: boolean;
  /** reruns of the full sequence that reproduced the failure / reruns made */
  reruns?: { failed: number; total: number };
  deterministic?: boolean;
  /** soft observations (never fail the run) */
  soft?: string[];
  trace?: StepRecord[];
}

const table: TableRow[] = [];
const actionTotals: Record<string, number> = {};
const effectiveTotals: Record<string, number> = {};
const determinismFailures: string[] = [];
/** heapUsed (MB) after each chunk — a growing series flags a leak across sequences */
const heapMbByChunk: number[] = [];

const seeds = Array.from({ length: ITERATIONS }, (_, i) => SEED_START + i);
const chunks: number[][] = [];
for (let i = 0; i < seeds.length; i += CHUNK)
  chunks.push(seeds.slice(i, i + CHUNK));

describe('DrillLibraryScreen — seeded randomized long-run (real navigator + stores)', () => {
  test.each(chunks.map(c => [c[0]!, c[c.length - 1]!, c] as const))(
    'seeds %i..%i hold every invariant after every action',
    async (_first, _last, chunkSeeds) => {
      const broken: TableRow[] = [];
      for (const seed of chunkSeeds) {
        const actions = generateActions(seed);
        const result = await runSequence(seed, actions);
        for (const [k, v] of Object.entries(result.actionCounts)) {
          actionTotals[k] = (actionTotals[k] ?? 0) + v;
        }
        for (const [k, v] of Object.entries(result.effectiveCounts)) {
          effectiveTotals[k] = (effectiveTotals[k] ?? 0) + v;
        }
        const row: TableRow = {
          seed,
          length: actions.length,
          outcome: result.outcome,
          steps: result.steps,
          invariantChecks: result.invariantChecks,
        };
        if (result.soft.length > 0) row.soft = result.soft;
        if (
          KEEP_TRACES ||
          result.outcome === 'BROKEN' ||
          result.soft.length > 0
        )
          row.trace = result.trace;
        if (result.outcome === 'BROKEN') {
          row.invariant = result.invariant;
          row.detail = result.detail;
          row.failedAt = result.failedAt;
          row.failedAction = result.failedAction;
          // Two confirmation reruns; any disagreement marks the seed flaky and
          // the rate is measured over 10 reruns.
          const outcomes: boolean[] = [];
          for (let k = 0; k < 2; k += 1) {
            outcomes.push(
              (await runSequence(seed, actions)).outcome === 'BROKEN',
            );
          }
          if (outcomes.some(o => !o)) {
            while (outcomes.length < 10) {
              outcomes.push(
                (await runSequence(seed, actions)).outcome === 'BROKEN',
              );
            }
          }
          row.reruns = {
            failed: outcomes.filter(Boolean).length,
            total: outcomes.length,
          };
          const minimized = await minimise(
            seed,
            actions,
            result.invariant ?? 'exception',
          );
          const replay = await runSequence(seed, minimized.actions);
          row.minimized = replay.trace.map(s => s.action);
          row.minimizedLength = minimized.actions.length;
          row.minimizationRuns = minimized.runs;
          row.minimizationComplete = minimized.complete;
          row.detail = replay.detail ?? row.detail;
          broken.push(row);
        }
        table.push(row);
      }
      if (typeof global.gc === 'function') global.gc();
      heapMbByChunk.push(
        Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
      );
      expect(
        broken.map(b => `seed ${b.seed} [${b.invariant}] ${b.detail}`),
      ).toEqual([]);
    },
    600_000,
  );

  test('determinism: the same seed twice yields identical traces', async () => {
    const sample = seeds
      .filter((_, i) => i % Math.max(1, Math.floor(seeds.length / 10)) === 0)
      .slice(0, 10);
    for (const seed of sample) {
      const actions = generateActions(seed);
      const a = await runSequence(seed, actions);
      const b = await runSequence(seed, actions);
      const ta = JSON.stringify(a.trace);
      const tb = JSON.stringify(b.trace);
      const row = table.find(r => r.seed === seed);
      if (row) row.deterministic = ta === tb;
      if (ta !== tb) determinismFailures.push(`seed ${seed}`);
    }
    expect(determinismFailures).toEqual([]);
  }, 600_000);

  test('sequence lengths span 5..60 and every action kind is exercised', () => {
    const lengths = seeds.map(s => generateActions(s).length);
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(5);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(60);
    if (ITERATIONS >= 40) {
      for (const [kind] of ACTION_WEIGHTS)
        expect(actionTotals[kind] ?? 0).toBeGreaterThan(0);
    }
  });

  afterAll(() => {
    if (!OUT_PATH) return;
    const summary = {
      unit: 'scr-drilllibraryscreen',
      lens: 'randomized-seeded',
      seedStart: SEED_START,
      iterations: ITERATIONS,
      executed: table.length,
      held: table.filter(r => r.outcome === 'HELD').length,
      broken: table.filter(r => r.outcome === 'BROKEN').length,
      totalSteps: table.reduce((s, r) => s + r.steps, 0),
      totalInvariantChecks: table.reduce((s, r) => s + r.invariantChecks, 0),
      actionTotals,
      effectiveTotals,
      brokenByInvariant: table
        .filter(r => r.outcome === 'BROKEN')
        .reduce<Record<string, number[]>>((acc, r) => {
          const key = r.invariant ?? 'exception';
          (acc[key] ??= []).push(r.seed);
          return acc;
        }, {}),
      determinismFailures,
      heapMbByChunk,
      softByInvariant: table.reduce<Record<string, number[]>>((acc, r) => {
        for (const line of r.soft ?? []) {
          const key = line.slice(0, line.indexOf(':'));
          const list = (acc[key] ??= []);
          if (!list.includes(r.seed)) list.push(r.seed);
        }
        return acc;
      }, {}),
      rows: table,
    };
    writeFileSync(OUT_PATH, JSON.stringify(summary, null, 2));
  });
});
