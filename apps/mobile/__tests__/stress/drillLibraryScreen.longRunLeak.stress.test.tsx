/**
 * LONG-RUN LEAK stress campaign for DrillLibraryScreen.
 *
 * The screen is mounted INSIDE the real navigation runtime
 * (`NavigationContainer` + `createNativeStackNavigator`, the same primitives
 * `RootNavigator` registers it with) with the real api-session store, the
 * real `createTrainingApi` transport, the real SQLite repository (local
 * migrations run against `node:sqlite`) and the real DrillVideoPlayer. Only
 * native modules are replaced: op-sqlite (→ node:sqlite), safe-area-context
 * (the package's own jest mock), react-native-webview, and `fetch` (a seeded
 * in-process fake server).
 *
 * Every iteration is a deterministic scenario derived from
 * `hash(STRESS_SEED, iteration)`: catalog size and content, local scored-shot
 * evidence, response latencies, injected failures (network, 5xx, 401,
 * malformed bodies) and a random interaction script (search typing, family
 * chips, expand/collapse, save/unsave, retry, video player open/close,
 * pull-to-refresh, unmount with requests in flight). After unmount the
 * harness drains everything and asserts the process is back at baseline:
 *
 *   - no pending fake timers (debounce, toast, player watchdog, animations,
 *     fake-server latency);
 *   - api-session store subscriber count back to its pre-mount value;
 *   - no fetch still in flight;
 *   - Node active-resource counts (per type) unchanged from baseline;
 *
 * and every 50 iterations it forces GC and samples the heap. A monotone heap
 * slope above 5 % per 100 iterations (post warm-up) fails the campaign, as
 * does a >3× render-time drift between the first and last hundred.
 *
 * Fast default: STRESS_ITER=40. Campaign:
 *   cd apps/mobile && STRESS_ITER=500 STRESS_SEED=20260905 \
 *     STRESS_OUT=/tmp/drill-leak.json \
 *     node --expose-gc node_modules/.bin/jest --ci --silent --runInBand \
 *     __tests__/stress/drillLibraryScreen.longRunLeak.stress.test.tsx
 * Replay one iteration: STRESS_REPLAY_SEED=<seed> (same command).
 */
import React from 'react';
import { writeFileSync } from 'node:fs';
import { createHook } from 'node:async_hooks';
import { setFlagsFromString as setV8Flags } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { performance } from 'node:perf_hooks';
import { Text, TextInput, RefreshControl } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { DrillLibraryScreen } from '../../src/screens/DrillLibraryScreen';
import {
  clearApiSession,
  establishApiSession,
  useApiSessionStore,
} from '../../src/account/apiSession';
import { setActiveDataOwner } from '../../src/data/accountScope';
import { getDb } from '../../src/data/db';
import type { RootStackParams } from '../../src/navigation/params';

// ─── Native-module doubles (the ONLY mocks in this file) ─────────────────────

jest.mock('react-native-safe-area-context', () => {
  const mock = jest.requireActual<{
    default: Record<string, unknown>;
  }>('react-native-safe-area-context/jest/mock');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { ...mock.default, SafeAreaView: View };
});

jest.mock('react-native-webview', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

interface DatabaseSyncLike {
  prepare(sql: string): {
    all(...params: (string | number | null)[]): Record<string, unknown>[];
    run(...params: (string | number | null)[]): unknown;
  };
  exec(sql: string): void;
  close(): void;
}
const mockSqlite: { db: DatabaseSyncLike | null } = { db: null };

jest.mock('@op-engineering/op-sqlite', () => {
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (location: string) => DatabaseSyncLike;
  };
  return {
    open: () => {
      const db = new DatabaseSync(':memory:');
      mockSqlite.db = db;
      return {
        executeSync: (sql: string) => ({ rows: db.prepare(sql).all() }),
        execute: async (sql: string, params: unknown[] = []) => ({
          rows: db.prepare(sql).all(...(params as (string | number | null)[])),
        }),
        close: () => {
          db.close();
          mockSqlite.db = null;
        },
      };
    },
  };
});

// ─── Campaign knobs ──────────────────────────────────────────────────────────

const ITERATIONS = Math.max(1, Number(process.env.STRESS_ITER ?? 40) || 40);
const CAMPAIGN_SEED = Number(process.env.STRESS_SEED ?? 20260905) || 20260905;
const REPLAY_SEED = process.env.STRESS_REPLAY_SEED
  ? Number(process.env.STRESS_REPLAY_SEED)
  : null;
const OUT_PATH = process.env.STRESS_OUT ?? null;
/** Optional: dump the rendered tree of iteration 1 (after its script) here. */
const TREE_OUT_PATH = process.env.STRESS_TREE_OUT ?? null;
const PROBE_SEED = Number(process.env.STRESS_PROBE_SEED ?? 0x5eed) || 0x5eed;
const HEAP_SAMPLE_EVERY = 50;
const WARMUP_ITERATIONS = 100;
const HEAP_SLOPE_LIMIT_PER_100 = 0.05;
const TIME_DRIFT_LIMIT = 3;

jest.setTimeout(Math.max(30_000, ITERATIONS * 1_500));

// ─── Deterministic RNG (splitmix32) ──────────────────────────────────────────

function mix(a: number, b: number): number {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = (h ^ b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x9e3779b9) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 0x1_0000_0000;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }
}

// ─── Seeded fake server ──────────────────────────────────────────────────────

const FAMILIES = [
  'dink',
  'volley',
  'drive',
  'serve',
  'return',
  'drop_reset',
  'global',
] as const;
const WORDS = [
  'Kitchen',
  'Ladder',
  'Wall',
  'Reset',
  'Target',
  'Tempo',
  'Cross',
  'Court',
  'Soft',
  'Drive',
  'Serve',
  'Return',
  'Drop',
  'Volley',
  'Dink',
  'Footwork',
];
const CHECKPOINT_KEYS = [
  'contact_position',
  'athletic_base',
  'contact_height',
  'paddle_face',
  'follow_through',
];
const SHOT_TYPES = [
  'dink',
  'volley',
  'forehand_drive',
  'serve',
  'return',
  'third_shot_drop',
];

function uuidFrom(rng: Rng): string {
  const hex = () => rng.int(0, 15).toString(16);
  const seg = (n: number) => Array.from({ length: n }, hex).join('');
  return `${seg(8)}-${seg(4)}-4${seg(3)}-${rng.pick(['8', '9', 'a', 'b'])}${seg(
    3,
  )}-${seg(12)}`;
}

interface WireDrill {
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
  saved: boolean;
}

function buildCatalog(rng: Rng, size: number): WireDrill[] {
  const items: WireDrill[] = [];
  for (let i = 0; i < size; i += 1) {
    const words = [rng.pick(WORDS), rng.pick(WORDS), rng.pick(WORDS)];
    const family = rng.pick(FAMILIES);
    items.push({
      id: uuidFrom(rng),
      slug: `drill-${i}-${words.join('-').toLowerCase()}`,
      title: `${words.join(' ')} ${i}`,
      description: `Seeded description ${i} for ${family} work.`,
      coach_name: rng.chance(0.3)
        ? 'Engineering draft — not coach-validated'
        : 'Pickle Sensei Training Library',
      equipment: rng.chance(0.5) ? ['paddle', 'balls'] : [],
      difficulty_min: rng.chance(0.5) ? '2.0' : null,
      difficulty_max: rng.chance(0.5) ? '3.5' : null,
      families: rng.chance(0.9) ? [family] : [],
      validation_state: rng.chance(0.5) ? 'UNVALIDATED' : 'PUBLISHED',
      saved: rng.chance(0.3),
    });
  }
  return items;
}

type Fault =
  | 'none'
  | 'network'
  | 'server_500'
  | 'unauthorized'
  | 'malformed'
  | 'rate_limited';

interface ServerStats {
  requests: number;
  inFlight: number;
  pendingTimers: number;
  faults: Record<Fault, number>;
  /** Requests the harness itself could not serve (bad bearer, unknown route). */
  harnessErrors: string[];
}

class FakeServer {
  readonly stats: ServerStats = {
    requests: 0,
    inFlight: 0,
    pendingTimers: 0,
    faults: {
      none: 0,
      network: 0,
      server_500: 0,
      unauthorized: 0,
      malformed: 0,
      rate_limited: 0,
    },
    harnessErrors: [],
  };
  private readonly catalog: WireDrill[];
  private readonly saved = new Set<string>();
  private readonly rng: Rng;
  private readonly faultRate: number;
  private readonly maxLatency: number;
  private readonly token: string;
  /** One-shot: the next request fails with a deterministic 500. */
  failNext = false;

  constructor(
    rng: Rng,
    catalog: WireDrill[],
    faultRate: number,
    maxLatency: number,
    token: string,
  ) {
    this.rng = rng;
    this.catalog = catalog;
    this.faultRate = faultRate;
    this.maxLatency = maxLatency;
    this.token = token;
    for (const drill of catalog) if (drill.saved) this.saved.add(drill.slug);
  }

  private pickFault(): Fault {
    if (this.failNext) {
      this.failNext = false;
      return 'server_500';
    }
    if (!this.rng.chance(this.faultRate)) return 'none';
    return this.rng.pick([
      'network',
      'server_500',
      'unauthorized',
      'malformed',
      'rate_limited',
    ] as const);
  }

  private delay(): Promise<void> {
    const ms = this.rng.int(0, this.maxLatency);
    this.stats.pendingTimers += 1;
    return new Promise(resolve => {
      setTimeout(() => {
        this.stats.pendingTimers -= 1;
        resolve();
      }, ms);
    });
  }

  private static response(status: number, body: unknown): Response {
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    } as unknown as Response;
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    this.stats.requests += 1;
    this.stats.inFlight += 1;
    try {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers['Authorization'] !== `Bearer ${this.token}`) {
        const message = `unexpected bearer ${String(headers['Authorization'])} for ${method} ${url.pathname}`;
        this.stats.harnessErrors.push(message);
        throw new Error(`harness: ${message}`);
      }
      await this.delay();
      const fault = this.pickFault();
      this.stats.faults[fault] += 1;
      switch (fault) {
        case 'network':
          throw new TypeError('Network request failed');
        case 'server_500':
          return FakeServer.response(500, {
            error: { code: 'internal', message: 'Injected 500.' },
          });
        case 'unauthorized':
          return FakeServer.response(401, { error: { code: 'unauthorized' } });
        case 'malformed':
          return FakeServer.response(200, { nope: true });
        case 'rate_limited':
          return FakeServer.response(429, {
            error: { code: 'rate_limited', message: 'Injected 429.' },
          });
        case 'none':
          break;
      }
      return this.route(method, url);
    } finally {
      this.stats.inFlight -= 1;
    }
  };

  private route(method: string, url: URL): Response {
    const path = url.pathname;
    if (method === 'GET' && path === '/v1/catalog/drills') {
      const q = url.searchParams.get('q')?.toLowerCase() ?? '';
      const family = url.searchParams.get('family');
      const items = this.catalog
        .filter(d => !family || d.families.includes(family))
        .filter(
          d =>
            !q ||
            d.title.toLowerCase().includes(q) ||
            d.description.toLowerCase().includes(q),
        )
        .map(d => ({ ...d, saved: this.saved.has(d.slug) }));
      return FakeServer.response(200, { items });
    }
    const detail = /^\/v1\/catalog\/drills\/([^/]+)$/.exec(path);
    if (method === 'GET' && detail) {
      const slug = decodeURIComponent(detail[1]!);
      const drill = this.catalog.find(d => d.slug === slug);
      if (!drill) {
        this.stats.harnessErrors.push(`unknown drill ${slug}`);
        return FakeServer.response(404, { error: { code: 'nf' } });
      }
      const withMedia = this.rng.chance(0.7);
      const videoId = `v${slug.replace(/[^a-z0-9]/g, '').slice(0, 9)}`;
      return FakeServer.response(200, {
        drill: { ...drill, saved: this.saved.has(slug) },
        mappings: this.rng.chance(0.6)
          ? [
              {
                checkpoint: this.rng.pick(CHECKPOINT_KEYS),
                shot_type: this.rng.pick(SHOT_TYPES),
                plan_role: this.rng.pick(['warmup', 'targeted']),
                fault_directions: ['high'],
                cue_text: 'Contact the ball below your waist.',
                target_sets: 3,
                target_repetitions_per_set: 10,
                target_duration_seconds: null,
                rest_seconds: 30,
              },
            ]
          : [],
        instructionalMedia: withMedia
          ? [
              {
                id: drill.id,
                kind: 'embed',
                provider: 'youtube',
                videoId,
                embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
                sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
                creatorName: 'Seeded Creator',
                licenseName: 'YouTube Terms of Service',
                licenseUrl: 'https://www.youtube.com/t/terms',
                attribution: 'Video by Seeded Creator on YouTube',
              },
            ]
          : [],
      });
    }
    const save = /^\/v1\/me\/saved-drills\/([^/]+)$/.exec(path);
    if (save && method === 'PUT') {
      const slug = decodeURIComponent(save[1]!);
      this.saved.add(slug);
      return FakeServer.response(200, { slug, saved: true });
    }
    if (save && method === 'DELETE') {
      this.saved.delete(decodeURIComponent(save[1]!));
      return FakeServer.response(204, null);
    }
    this.stats.harnessErrors.push(`unrouted ${method} ${path}`);
    throw new Error(`harness: unrouted ${method} ${path}`);
  }
}

// ─── Local evidence (real SQLite rows through the real repository) ───────────

const OWNER = '3f1c2a6e-8d4b-4c9a-9e7f-1a2b3c4d5e6f';

function seedLocalShots(rng: Rng, count: number): void {
  const db = mockSqlite.db;
  if (!db) throw new Error('harness: sqlite not open');
  db.exec('DELETE FROM local_shot');
  if (count === 0) return;
  const insert = db.prepare(
    `INSERT INTO local_shot (owner_key, id, session_id, shot_type, captured_at,
       overall_score, confidence, result_kind, source, favorite, payload)
     VALUES (?, ?, NULL, ?, ?, ?, 0.9, 'scored', 'real', 0, ?)`,
  );
  const shotType = rng.pick(SHOT_TYPES);
  for (let i = 0; i < count; i += 1) {
    const id = uuidFrom(rng);
    const capturedAt = new Date(
      Date.UTC(2026, 7, 1 + i, 10, 0, 0),
    ).toISOString();
    const checkpoints = CHECKPOINT_KEYS.map(key => ({
      key,
      score: rng.chance(0.85) ? rng.int(30, 95) : null,
      applicable: rng.chance(0.9),
    }));
    const payload = JSON.stringify({
      id,
      source: 'real',
      resultKind: 'scored',
      shotType,
      capturedAtIso: capturedAt,
      checkpoints,
    });
    // Corrupt one payload occasionally: the repository must skip it.
    insert.run(
      OWNER,
      id,
      shotType,
      capturedAt,
      rng.int(30, 95),
      rng.chance(0.1) ? '{not json' : payload,
    );
  }
}

// ─── Render plumbing (real navigator, real stack) ────────────────────────────

const Stack = createNativeStackNavigator<RootStackParams>();

function ConnectAccountPlaceholder() {
  return <Text>connect-account-route</Text>;
}

function Harness() {
  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName="DrillLibrary">
        <Stack.Screen name="DrillLibrary" component={DrillLibraryScreen} />
        <Stack.Screen
          name="ConnectAccount"
          component={ConnectAccountPlaceholder}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

type Renderer = TestRenderer.ReactTestRenderer;

type Props = Record<string, unknown>;

function pressables(renderer: Renderer, predicate: (props: Props) => boolean) {
  return renderer.root.findAll(
    n => typeof n.props.onPress === 'function' && predicate(n.props),
  );
}

function press(node: TestRenderer.ReactTestInstance): void {
  (node.props.onPress as () => void)();
}

function labelStartsWith(prefix: string) {
  return (p: Props) =>
    typeof p.accessibilityLabel === 'string' &&
    p.accessibilityLabel.startsWith(prefix);
}

function labelIs(label: string) {
  return (p: Props) => p.accessibilityLabel === label;
}

function testIdStartsWith(prefix: string) {
  return (p: Props) =>
    typeof p.testID === 'string' && p.testID.startsWith(prefix);
}

/** Host tree → indented lines of `type label=… id=…` / text, no props. */
function describeTree(
  node:
    | TestRenderer.ReactTestRendererJSON
    | TestRenderer.ReactTestRendererJSON[]
    | null,
  depth = 0,
  out: string[] = [],
): string[] {
  if (node === null) return out;
  if (Array.isArray(node)) {
    for (const child of node) describeTree(child, depth, out);
    return out;
  }
  const pad = ' '.repeat(depth);
  const tags = [node.type];
  const props = node.props as Props;
  if (typeof props.accessibilityLabel === 'string') {
    tags.push(`label=${JSON.stringify(props.accessibilityLabel)}`);
  }
  if (typeof props.testID === 'string') tags.push(`id=${props.testID}`);
  out.push(pad + tags.join(' '));
  for (const child of node.children ?? []) {
    if (typeof child === 'string') out.push(`${pad} ${JSON.stringify(child)}`);
    else describeTree(child, depth + 1, out);
  }
  return out;
}

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

// ─── Resource bookkeeping ────────────────────────────────────────────────────

let storeSubscribers = 0;
const originalSubscribe = useApiSessionStore.subscribe;
(useApiSessionStore as { subscribe: typeof originalSubscribe }).subscribe =
  listener => {
    storeSubscribers += 1;
    const unsubscribe = originalSubscribe(listener);
    return () => {
      storeSubscribers -= 1;
      unsubscribe();
    };
  };

function activeResources(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const kind of process.getActiveResourcesInfo()) {
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

/**
 * REAL Node timers (the `timers` module bypasses Jest's fake globals) created
 * after this file loaded, keyed by async id with their creation stack. Jest's
 * own runner timers (jest-circus per-test timeout, @jest/reporters status
 * debounce) live outside the fake clock and come and go between samples, so
 * `getActiveResourcesInfo()`'s raw `Timeout` count is recorded for evidence
 * but growth is judged on this attributable set instead: a timer is a
 * finding only when it is NEW since the baseline and was not created by the
 * runner itself.
 */
const RUNNER_TIMER_ORIGIN = /node_modules\/(jest-circus|@jest\/reporters)\//;
const liveNodeTimeouts = new Map<number, string>();
createHook({
  init(asyncId, type) {
    if (type !== 'Timeout') return;
    liveNodeTimeouts.set(
      asyncId,
      (new Error().stack ?? '')
        .split('\n')
        .slice(2, 12)
        .map(line => line.trim())
        .join(' <- '),
    );
  },
  destroy(asyncId) {
    liveNodeTimeouts.delete(asyncId);
  },
}).enable();

function nodeTimeoutsOutsideRunner(): Map<number, string> {
  const out = new Map<number, string>();
  for (const [id, stack] of liveNodeTimeouts) {
    if (!RUNNER_TIMER_ORIGIN.test(stack)) out.set(id, stack);
  }
  return out;
}

/**
 * Wraps the (fake) global timer functions so a timer that survives the
 * post-unmount drain can be attributed to the code that created it.
 */
const liveTimers = new Map<unknown, string>();
type TimerFn = (handler: (...args: unknown[]) => void, ms?: number) => unknown;
let untraceTimers: (() => void) | null = null;
let fakeSetTimeout: unknown = null;

function traceTimers(): void {
  const g = globalThis as unknown as {
    setTimeout: TimerFn;
    setInterval: TimerFn;
    setImmediate: TimerFn;
    requestAnimationFrame: TimerFn;
    clearTimeout: (id: unknown) => void;
    clearInterval: (id: unknown) => void;
    clearImmediate: (id: unknown) => void;
    cancelAnimationFrame: (id: unknown) => void;
  };
  fakeSetTimeout = g.setTimeout;
  const original = {
    setTimeout: g.setTimeout,
    setInterval: g.setInterval,
    setImmediate: g.setImmediate,
    requestAnimationFrame: g.requestAnimationFrame,
    clearTimeout: g.clearTimeout,
    clearInterval: g.clearInterval,
    clearImmediate: g.clearImmediate,
    cancelAnimationFrame: g.cancelAnimationFrame,
  };
  const origin = (kind: string, ms: number | undefined) =>
    `${kind}(${ms ?? 0}) ${(new Error().stack ?? '')
      .split('\n')
      .slice(3, 9)
      .map(line => line.trim())
      .join(' <- ')}`;
  g.setTimeout = (handler, ms) => {
    const id: unknown = original.setTimeout((...args) => {
      liveTimers.delete(id);
      handler(...args);
    }, ms);
    liveTimers.set(id, origin('setTimeout', ms));
    return id;
  };
  g.setInterval = (handler, ms) => {
    const id = original.setInterval(handler, ms);
    liveTimers.set(id, origin('setInterval', ms));
    return id;
  };
  g.setImmediate = handler => {
    const id: unknown = original.setImmediate((...args) => {
      liveTimers.delete(id);
      handler(...args);
    });
    liveTimers.set(id, origin('setImmediate', undefined));
    return id;
  };
  g.requestAnimationFrame = handler => {
    const id: unknown = original.requestAnimationFrame((...args) => {
      liveTimers.delete(id);
      handler(...args);
    });
    liveTimers.set(id, origin('requestAnimationFrame', undefined));
    return id;
  };
  g.clearTimeout = id => {
    liveTimers.delete(id);
    original.clearTimeout(id);
  };
  g.clearInterval = id => {
    liveTimers.delete(id);
    original.clearInterval(id);
  };
  g.clearImmediate = id => {
    liveTimers.delete(id);
    original.clearImmediate(id);
  };
  g.cancelAnimationFrame = id => {
    liveTimers.delete(id);
    original.cancelAnimationFrame(id);
  };
  untraceTimers = () => {
    g.setTimeout = original.setTimeout;
    g.setInterval = original.setInterval;
    g.setImmediate = original.setImmediate;
    g.requestAnimationFrame = original.requestAnimationFrame;
    g.clearTimeout = original.clearTimeout;
    g.clearInterval = original.clearInterval;
    g.clearImmediate = original.clearImmediate;
    g.cancelAnimationFrame = original.cancelAnimationFrame;
    liveTimers.clear();
    untraceTimers = null;
  };
}

function describeClockTimers(): string[] {
  const clock = (
    (fakeSetTimeout ?? globalThis.setTimeout) as {
      clock?: {
        timers?: Record<
          string,
          {
            type: string;
            delay?: number;
            interval?: number;
            func: unknown;
            error?: Error;
          }
        >;
      };
    }
  ).clock;
  if (!clock?.timers) return ['<no sinon clock>'];
  return Object.values(clock.timers).map(
    t =>
      `${t.type}(${t.interval ?? t.delay ?? 0}) ${String(t.func).replace(/\s+/g, ' ').slice(0, 220)} ${t.error?.stack?.split('\n').slice(1, 8).join(' <- ') ?? ''}`,
  );
}

/**
 * Full GC. Prefers `--expose-gc`; when the suite runs under plain `npx jest`
 * the flag is enabled at runtime and `gc` is read from a fresh context so the
 * default-size campaign still measures a collected heap.
 */
let resolvedGc: (() => void) | null = null;
function forceGc(): void {
  if (!resolvedGc) {
    if (typeof globalThis.gc === 'function') {
      resolvedGc = globalThis.gc;
    } else {
      setV8Flags('--expose-gc');
      const fromContext = runInNewContext('gc') as unknown;
      if (typeof fromContext !== 'function') {
        throw new Error(
          'harness could not obtain gc(): run with node --expose-gc node_modules/.bin/jest …',
        );
      }
      resolvedGc = fromContext as () => void;
    }
  }
  resolvedGc();
  resolvedGc();
}

// ─── One iteration ───────────────────────────────────────────────────────────

type Action =
  | 'type'
  | 'clear'
  | 'family'
  | 'expand'
  | 'save'
  | 'retry'
  | 'open_media'
  | 'refresh'
  | 'dismiss_error'
  | 'navigate_connect'
  | 'wait';

const ACTION_DECK: readonly Action[] = [
  'type',
  'type',
  'clear',
  'family',
  'expand',
  'expand',
  'save',
  'save',
  'retry',
  'open_media',
  'refresh',
  'dismiss_error',
  'navigate_connect',
  'wait',
];

interface IterationResult {
  iteration: number;
  seed: number;
  catalogSize: number;
  localShots: number;
  faultRate: number;
  maxLatencyMs: number;
  actions: Action[];
  /** Actions whose target existed in the tree at that moment. */
  applied: Action[];
  /** Drill cards on screen when the script finished (0 = empty/error/busy). */
  drillsRendered: number;
  unmountWhileBusy: boolean;
  requests: number;
  faults: Record<Fault, number>;
  mountMs: number;
  scriptMs: number;
  unmountMs: number;
  totalMs: number;
  timersAfter: number;
  storeSubscribersAfter: number;
  storeSubscribersBaseline: number;
  fetchInFlightAfter: number;
  outcome: 'HELD' | 'BROKEN';
  error: string | null;
}

async function runIteration(
  iteration: number,
  seed: number,
): Promise<IterationResult> {
  const rng = new Rng(seed);
  const catalogSize = rng.chance(0.1) ? 0 : rng.int(3, 90);
  const localShots = rng.chance(0.3) ? 0 : rng.int(1, 8);
  const faultRate = rng.pick([0, 0, 0.05, 0.15, 0.4]);
  const maxLatencyMs = rng.pick([0, 10, 60, 400]);
  const actionCount = rng.int(0, 10);
  const unmountWhileBusy = rng.chance(0.35);
  const token = `tok-${seed.toString(16)}`;

  const catalog = buildCatalog(rng, catalogSize);
  const server = new FakeServer(rng, catalog, faultRate, maxLatencyMs, token);
  globalThis.fetch = server.fetch as typeof fetch;
  seedLocalShots(rng, localShots);
  if (rng.chance(0.08)) {
    clearApiSession();
  } else {
    establishApiSession({
      apiBaseUrl: `https://s${seed}.api.example.test`,
      bearerToken: token,
      canonicalAppUserId: OWNER,
      provider: 'apple',
    });
  }

  const storeSubscribersBaseline = storeSubscribers;
  const actions: Action[] = [];
  const applied: Action[] = [];
  let drillsRendered = 0;
  let renderer: Renderer | null = null;
  let error: string | null = null;
  const t0 = performance.now();
  let tMounted = t0;
  let tScripted = t0;
  let tUnmounted = t0;

  try {
    await act(async () => {
      renderer = TestRenderer.create(<Harness />);
    });
    tMounted = performance.now();
    const root = renderer!;

    if (!unmountWhileBusy) await flush(maxLatencyMs + 10);

    for (let step = 0; step < actionCount; step += 1) {
      const action = rng.pick(ACTION_DECK);
      actions.push(action);
      switch (action) {
        case 'type': {
          const [input] = root.root.findAllByType(TextInput);
          if (!input) break;
          applied.push(action);
          const text = rng.chance(0.2)
            ? rng.pick(['<script>', '%%', '\\u0000', ')(*&^', 'ç'.repeat(40)])
            : rng.pick(WORDS).slice(0, rng.int(1, 5));
          const onChangeText = input.props.onChangeText as (t: string) => void;
          await act(async () => onChangeText(text));
          if (rng.chance(0.5)) await flush(rng.int(0, 249));
          else await flush(260 + rng.int(0, 40));
          break;
        }
        case 'clear': {
          const [clear] = pressables(root, labelIs('Clear search'));
          if (clear) {
            applied.push(action);
            await act(async () => press(clear));
          }
          await flush(rng.int(0, 300));
          break;
        }
        case 'family': {
          const chips = pressables(
            root,
            p =>
              labelStartsWith('Filter ')(p) ||
              labelIs('Show all drill families')(p),
          );
          if (chips.length === 0) break;
          applied.push(action);
          const chip = rng.pick(chips);
          await act(async () => press(chip));
          await flush(rng.int(0, maxLatencyMs + 5));
          break;
        }
        case 'expand': {
          const toggles = pressables(
            root,
            p =>
              labelStartsWith('Show detail for ')(p) ||
              labelStartsWith('Hide detail for ')(p),
          );
          if (toggles.length === 0) break;
          applied.push(action);
          const toggle = rng.pick(toggles);
          await act(async () => press(toggle));
          await flush(rng.int(0, maxLatencyMs + 5));
          break;
        }
        case 'save': {
          const saves = pressables(root, testIdStartsWith('save-toggle-'));
          if (saves.length === 0) break;
          applied.push(action);
          const button = rng.pick(saves);
          const hammer = rng.int(1, 3);
          await act(async () => {
            for (let i = 0; i < hammer; i += 1) press(button);
          });
          await flush(rng.int(0, maxLatencyMs + 5));
          break;
        }
        case 'retry': {
          let retries = pressables(root, labelStartsWith('Retry detail for '));
          if (retries.length === 0) {
            // No failed detail yet: force the detail fetch to fail once so
            // the retry path (error → loading → ready/error) gets exercised.
            const shows = pressables(root, labelStartsWith('Show detail for '));
            if (shows.length === 0) break;
            server.failNext = true;
            await act(async () => press(rng.pick(shows)));
            await flush(maxLatencyMs + 5);
            retries = pressables(root, labelStartsWith('Retry detail for '));
            if (retries.length === 0) break;
          }
          applied.push(action);
          const retry = rng.pick(retries);
          await act(async () => press(retry));
          await flush(rng.int(0, maxLatencyMs + 5));
          break;
        }
        case 'open_media': {
          const media = pressables(root, testIdStartsWith('watch-media-'));
          if (media.length === 0) break;
          applied.push(action);
          const watch = rng.pick(media);
          await act(async () => press(watch));
          await flush(rng.int(0, 9000));
          const [close] = pressables(root, labelIs('Close video player'));
          if (close && rng.chance(0.8)) {
            await act(async () => press(close));
          }
          break;
        }
        case 'refresh': {
          const [control] = root.root.findAllByType(RefreshControl);
          if (!control) break;
          applied.push(action);
          const onRefresh = control.props.onRefresh as () => void;
          await act(async () => onRefresh());
          await flush(rng.int(0, maxLatencyMs + 5));
          break;
        }
        case 'dismiss_error': {
          const [dismiss] = pressables(root, labelIs('Dismiss error'));
          if (dismiss) {
            applied.push(action);
            await act(async () => press(dismiss));
          }
          break;
        }
        case 'navigate_connect': {
          // Only reachable in the signed-out state: pushes the real
          // ConnectAccount route through the real stack, then pops back.
          const [connect] = pressables(root, labelIs('Connect account'));
          if (!connect) break;
          applied.push(action);
          await act(async () => press(connect));
          await flush(rng.int(0, 600));
          const [back] = pressables(root, labelIs('Back'));
          if (back && rng.chance(0.7)) {
            await act(async () => press(back));
            await flush(rng.int(0, 600));
          }
          break;
        }
        case 'wait':
          applied.push(action);
          await flush(rng.int(0, 3000));
          break;
      }
    }
    tScripted = performance.now();

    if (!unmountWhileBusy) await flush(maxLatencyMs + 3000);
    drillsRendered = new Set(
      pressables(
        root,
        p =>
          labelStartsWith('Show detail for ')(p) ||
          labelStartsWith('Hide detail for ')(p),
      ).map(n => String(n.props.accessibilityLabel).replace(/^\w+ /, '')),
    ).size;
    if (TREE_OUT_PATH && iteration === 1) {
      writeFileSync(TREE_OUT_PATH, describeTree(root.toJSON()).join('\n'));
    }
    await act(async () => root.unmount());
    tUnmounted = performance.now();
    renderer = null;

    // Drain everything the iteration could have left behind (fake-server
    // latency, toast, debounce, animations, player watchdog) so any timer
    // that survives is one the screen failed to clear.
    await flush(20_000);
    await act(async () => {});
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    if (renderer) {
      try {
        await act(async () => renderer!.unmount());
      } catch {
        // already torn down
      }
    }
    await flush(20_000);
  }

  // `jest.fn` keeps every call's arguments (`mock.calls`) for the life of
  // the mock. The RN preset's mock components and this file's native-module
  // mocks are all `jest.fn`s, so without this the props of every render of
  // every iteration stay reachable through the mocks — test-runner
  // bookkeeping, not app retention (sampling heap profile: jest-mock
  // `mockConstructor → push`). Clearing call records keeps implementations.
  jest.clearAllMocks();

  const timersAfter = jest.getTimerCount();
  const storeSubscribersAfter = storeSubscribers;
  const fetchInFlightAfter = server.stats.inFlight;
  const problems: string[] = [];
  if (error) problems.push(error);
  if (timersAfter !== 0) {
    problems.push(
      `${timersAfter} timers pending: ${[...liveTimers.values()].join(' || ')} CLOCK: ${describeClockTimers().join(' || ')}`,
    );
  }
  if (storeSubscribersAfter !== storeSubscribersBaseline) {
    problems.push(
      `store subscribers ${storeSubscribersBaseline} → ${storeSubscribersAfter}`,
    );
  }
  if (fetchInFlightAfter !== 0) {
    problems.push(`${fetchInFlightAfter} fetches still in flight`);
  }
  if (server.stats.pendingTimers !== 0) {
    problems.push(`${server.stats.pendingTimers} server timers pending`);
  }
  if (server.stats.harnessErrors.length > 0) {
    problems.push(`harness: ${server.stats.harnessErrors.join('; ')}`);
  }

  return {
    iteration,
    seed,
    catalogSize,
    localShots,
    faultRate,
    maxLatencyMs,
    actions,
    applied,
    drillsRendered,
    unmountWhileBusy,
    requests: server.stats.requests,
    faults: server.stats.faults,
    mountMs: round(tMounted - t0),
    scriptMs: round(tScripted - tMounted),
    unmountMs: round(tUnmounted - tScripted),
    totalMs: round(tUnmounted - t0),
    timersAfter,
    storeSubscribersAfter,
    storeSubscribersBaseline,
    fetchInFlightAfter,
    outcome: problems.length === 0 ? 'HELD' : 'BROKEN',
    error: problems.length === 0 ? null : problems.join('; '),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

interface HeapSample {
  iteration: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
  arrayBuffers: number;
  activeResources: Record<string, number>;
  /** Real Node `Timeout`s alive that were not created by the Jest runner. */
  nodeTimeouts: number;
  timers: number;
  storeSubscribers: number;
}

function sampleHeap(iteration: number): HeapSample {
  forceGc();
  const usage = process.memoryUsage();
  return {
    iteration,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    rss: usage.rss,
    arrayBuffers: usage.arrayBuffers,
    activeResources: activeResources(),
    nodeTimeouts: nodeTimeoutsOutsideRunner().size,
    timers: jest.getTimerCount(),
    storeSubscribers,
  };
}

/** Least-squares slope of heapUsed vs iteration, as a fraction of the first
 * sample's heap per 100 iterations. */
function heapSlopePer100(samples: HeapSample[]): number {
  if (samples.length < 2) return 0;
  const n = samples.length;
  const meanX = samples.reduce((s, p) => s + p.iteration, 0) / n;
  const meanY = samples.reduce((s, p) => s + p.heapUsed, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of samples) {
    num += (p.iteration - meanX) * (p.heapUsed - meanY);
    den += (p.iteration - meanX) ** 2;
  }
  const slopePerIteration = den === 0 ? 0 : num / den;
  return (slopePerIteration * 100) / samples[0]!.heapUsed;
}

function monotoneIncreases(samples: HeapSample[]): number {
  let count = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i]!.heapUsed > samples[i - 1]!.heapUsed) count += 1;
  }
  return count;
}

function resourceDelta(
  baseline: Record<string, number>,
  current: Record<string, number>,
): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const kind of new Set([
    ...Object.keys(baseline),
    ...Object.keys(current),
  ])) {
    const diff = (current[kind] ?? 0) - (baseline[kind] ?? 0);
    if (diff !== 0) delta[kind] = diff;
  }
  return delta;
}

// ─── Campaign ────────────────────────────────────────────────────────────────

describe('DrillLibraryScreen long-run leak campaign (real navigator)', () => {
  beforeAll(() => {
    setActiveDataOwner(OWNER);
    // Open + migrate the real local schema once; every iteration reuses it
    // exactly like the app process does.
    getDb();
  });

  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['performance', 'hrtime', 'queueMicrotask', 'nextTick'],
    });
    traceTimers();
  });

  afterEach(() => {
    untraceTimers?.();
    jest.useRealTimers();
  });

  afterAll(() => {
    clearApiSession();
  });

  test('replaying one seed reproduces the identical interaction script', async () => {
    const seed = REPLAY_SEED ?? mix(CAMPAIGN_SEED, 7);
    const first = await runIteration(0, seed);
    const second = await runIteration(1, seed);
    expect(second.actions).toEqual(first.actions);
    expect(second.catalogSize).toBe(first.catalogSize);
    expect(second.requests).toBe(first.requests);
    expect(second.faults).toEqual(first.faults);
    expect(first.outcome).toBe('HELD');
    expect(second.outcome).toBe('HELD');
  });

  test(`mount/unmount ${ITERATIONS}× returns timers, subscriptions, handles and heap to baseline`, async () => {
    const results: IterationResult[] = [];
    const heap: HeapSample[] = [];
    // One untimed warm-up mount so the baseline handle/heap picture already
    // contains module-level singletons (navigator, store, db); a leak must
    // grow from here, not from the cold process.
    const warmup = await runIteration(0, mix(CAMPAIGN_SEED, 0));
    expect(warmup.outcome).toBe('HELD');
    // Render-time drift is measured on a FIXED probe scenario (same seed, so
    // identical catalog + script) re-run at every heap checkpoint; raw
    // per-iteration times are not comparable because each seed does
    // different work.
    const probes: IterationResult[] = [];
    const probe = async (at: number) => {
      const result = await runIteration(at, PROBE_SEED);
      probes.push(result);
      if (result.outcome === 'BROKEN') results.push(result);
    };
    await probe(0);
    const baseline = sampleHeap(0);
    const baselineNodeTimeoutOrigins = [...nodeTimeoutsOutsideRunner()].map(
      ([id, stack]) => `${id}: ${stack}`,
    );
    const baselineNodeTimeouts = new Set(nodeTimeoutsOutsideRunner().keys());
    heap.push(baseline);

    for (let i = 1; i <= ITERATIONS; i += 1) {
      const seed = REPLAY_SEED ?? mix(CAMPAIGN_SEED, i);
      results.push(await runIteration(i, seed));
      if (i % HEAP_SAMPLE_EVERY === 0 || i === ITERATIONS) {
        await probe(i);
        heap.push(sampleHeap(i));
      }
    }

    const failed = results.filter(r => r.outcome === 'BROKEN');
    const postWarmup = heap.filter(
      s => s.iteration >= WARMUP_ITERATIONS && s.iteration > 0,
    );
    const slopeAll = heapSlopePer100(heap.slice(1));
    const slopePostWarmup =
      postWarmup.length >= 2 ? heapSlopePer100(postWarmup) : null;
    // Drift = median of the last probes vs the first post-warm-up probes
    // (window of 3 when there are enough checkpoints, else 1).
    const window = probes.length >= 6 ? 3 : 1;
    const postWarmupProbes = probes.filter(
      p => p.iteration >= WARMUP_ITERATIONS,
    );
    const firstWindow = (
      postWarmupProbes.length > window ? postWarmupProbes : probes
    ).slice(0, window);
    const lastWindow = probes.slice(-window);
    const timeDrift =
      median(lastWindow.map(r => r.totalMs)) /
      Math.max(0.001, median(firstWindow.map(r => r.totalMs)));
    const finalResources = heap[heap.length - 1]!.activeResources;
    const resources = resourceDelta(baseline.activeResources, finalResources);
    const grownResources = Object.fromEntries(
      Object.entries(resources).filter(
        ([kind, diff]) => kind !== 'Timeout' && diff > 0,
      ),
    );
    const newNodeTimeouts = [...nodeTimeoutsOutsideRunner()]
      .filter(([id]) => !baselineNodeTimeouts.has(id))
      .map(([id, stack]) => `${id}: ${stack}`);

    const report = {
      unit: 'scr-drilllibraryscreen',
      lens: 'long-run-leak',
      campaignSeed: CAMPAIGN_SEED,
      replaySeed: REPLAY_SEED,
      iterations: ITERATIONS,
      executed: results.length + probes.length,
      seededIterations: results.length,
      probeIterations: probes.length,
      held: results.length + probes.length - failed.length,
      broken: failed.length,
      node: process.version,
      heapSlopePer100All: slopeAll,
      heapSlopePer100PostWarmup: slopePostWarmup,
      heapMonotoneIncreases: monotoneIncreases(heap.slice(1)),
      heapSamples: heap,
      activeResourceDelta: resources,
      baselineNodeTimeoutOrigins,
      newNodeTimeouts,
      timing: {
        probeSeed: PROBE_SEED,
        probes: probes.map(p => ({
          atIteration: p.iteration,
          mountMs: p.mountMs,
          scriptMs: p.scriptMs,
          unmountMs: p.unmountMs,
          totalMs: p.totalMs,
          outcome: p.outcome,
        })),
        window,
        firstWindowMedianMs: median(firstWindow.map(r => r.totalMs)),
        lastWindowMedianMs: median(lastWindow.map(r => r.totalMs)),
        drift: timeDrift,
        mountMedianMs: median(results.map(r => r.mountMs)),
        unmountMedianMs: median(results.map(r => r.unmountMs)),
        p95TotalMs: [...results.map(r => r.totalMs)].sort((a, b) => a - b)[
          Math.floor(results.length * 0.95)
        ],
      },
      totalRequests: results.reduce((s, r) => s + r.requests, 0),
      totalActionsApplied: results.reduce((s, r) => s + r.applied.length, 0),
      iterationsWithDrillsRendered: results.filter(r => r.drillsRendered > 0)
        .length,
      failedSeeds: failed.map(r => ({ seed: r.seed, error: r.error })),
      results,
    };
    if (OUT_PATH) writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));

    expect(failed.map(r => `${r.seed}: ${r.error}`)).toEqual([]);
    expect(grownResources).toEqual({});
    expect(newNodeTimeouts).toEqual([]);
    if (slopePostWarmup !== null) {
      expect(slopePostWarmup).toBeLessThanOrEqual(HEAP_SLOPE_LIMIT_PER_100);
    }
    expect(timeDrift).toBeLessThan(TIME_DRIFT_LIMIT);
  });
});
