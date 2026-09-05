/**
 * STRESS — unit `cmp-rank`, lens `rapid-interaction`: PlayerRankCard + RankIcon.
 *
 * The card owns no press target, so its rapid-interaction surface is the host
 * screen: navigation spam re-renders it with new `facts` identities while the
 * account-rank request is still in flight, the account signs in/out between
 * renders, responses land out of order, fail, or arrive after unmount, and
 * the whole card is torn down and remounted like a tab switch. Every
 * iteration is replayable from its seed (`STRESS_SEED=<n>`), the campaign
 * size is `STRESS_ITER` (small default), and the seed → outcome table can be
 * written to `STRESS_REPORT_DIR`.
 *
 * Invariants asserted after every burst (a model tracks the intended state):
 *   - one request per intent: `fetchPlayerRank` is called exactly once per
 *     `facts` identity while signed in and never while signed out;
 *   - stale responses never win: the rendered tier/rating/division equal
 *     `resolvePlayerRank(currentFacts, lastActiveResponse)`, and the
 *     emblem (`RankIcon`) carries exactly one host label matching that tier;
 *   - no orphan display state: the "Unranked" copy and the ranked layout
 *     are mutually exclusive; exactly one `player-rank-card` host;
 *   - one report per rendered rank: `maybeCelebrate` is called exactly once
 *     for every distinct resolved rank the card rendered, in render order;
 *   - the card never grows a press target (its read-only contract);
 *   - no console.error (act() warnings, late setState), no unhandled
 *     rejections, no timers left behind after unmount.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { PlayerRankSummary } from '@pickle/shared-types';

const SESSION = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'test-bearer',
  canonicalAppUserId: 'aaaaaaaa-0000-4000-8000-000000000001',
  provider: 'apple' as const,
};
let mockSignedIn = false;
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => (mockSignedIn ? SESSION : null),
}));

interface Deferred {
  id: number;
  resolve: (value: ServerPlayerRank | null) => void;
  reject: (error: Error) => void;
  settled: boolean;
}
const mockPendingFetches: Deferred[] = [];
let mockFetchCalls = 0;
jest.mock('../../src/progress/playerRank', () => {
  const actual = jest.requireActual<
    typeof import('../../src/progress/playerRank')
  >('../../src/progress/playerRank');
  return {
    ...actual,
    fetchPlayerRank: () => {
      mockFetchCalls += 1;
      return new Promise<ServerPlayerRank | null>((resolve, reject) => {
        const deferred: Deferred = {
          id: mockFetchCalls,
          settled: false,
          resolve: value => {
            deferred.settled = true;
            resolve(value);
          },
          reject: error => {
            deferred.settled = true;
            reject(error);
          },
        };
        mockPendingFetches.push(deferred);
      });
    },
  };
});

const mockCelebrateCalls: PlayerRankSummary[] = [];
jest.mock('../../src/progress/rankCelebration', () => {
  const state = {
    maybeCelebrate: async (summary: PlayerRankSummary) => {
      mockCelebrateCalls.push(summary);
    },
  };
  return {
    useRankCelebrationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

let mockReducedMotion = false;
jest.mock('../../src/design/components', () => {
  const actual = jest.requireActual('../../src/design/components');
  return { ...actual, useReducedMotion: () => mockReducedMotion };
});

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import { PlayerRankCard } from '../../src/components/PlayerRankCard';
import type { RealAnalysisFact } from '../../src/data/repository';
import {
  resolvePlayerRank,
  type ServerPlayerRank,
} from '../../src/progress/playerRank';

// ─── Seeded PRNG (mulberry32) ───────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function int(rng: () => number, min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

// ─── Campaign knobs ─────────────────────────────────────────────────────────

const STRESS_ITER = Number(process.env['STRESS_ITER'] ?? 40);
const STRESS_SEED = process.env['STRESS_SEED'];
const STRESS_REPORT_DIR = process.env['STRESS_REPORT_DIR'];

// ─── Fixture generators ─────────────────────────────────────────────────────

const SHOT_TYPES = ['dink', 'volley', 'serve', 'forehand_drive', 'return'];
const TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond'] as const;

let factSequence = 0;
function randomFacts(rng: () => number): RealAnalysisFact[] {
  const count = pick(rng, [0, 0, 1, 2, 3, 5, 8, 12]);
  const facts: RealAnalysisFact[] = [];
  for (let i = 0; i < count; i += 1) {
    factSequence += 1;
    const scored = rng() < 0.85;
    facts.push({
      id: `fact-${factSequence}`,
      shotType: pick(rng, SHOT_TYPES),
      capturedAt: new Date(
        Date.UTC(2026, 7, 1 + (factSequence % 27), factSequence % 24),
      ).toISOString(),
      overallScore: scored ? Math.round(rng() * 1000) / 100 : null,
      confidence: scored ? 0.9 : 0.3,
      resultKind: scored ? 'scored' : 'low_confidence',
      scoringModelVersion: 'model-2',
      shotConfigVersion: 'config-1',
      sessionId: null,
      priorityCheckpoint: null,
      checkpointScores: {},
    });
  }
  return facts;
}

function randomServerRank(rng: () => number): ServerPlayerRank {
  const rating = Math.round(rng() * 1000) / 100;
  const techniqueCount = int(rng, 0, 3);
  const shotTypes = [...SHOT_TYPES]
    .sort(() => rng() - 0.5)
    .slice(0, techniqueCount);
  const techniques: ServerPlayerRank['techniques'] = [];
  for (const shotType of shotTypes) {
    techniques.push({
      shotType,
      score: Math.round(rng() * 1000) / 100,
      capturedAt: '2026-08-30T12:00:00Z',
      sampledCount: int(rng, 1, 9),
    });
  }
  return {
    rating,
    tier: pick(rng, TIERS),
    techniqueCount,
    scoredShotCount: rng() < 0.2 ? null : int(rng, 0, 20),
    updatedAt: rng() < 0.2 ? null : '2026-09-01T00:00:00Z',
    techniques,
  };
}

// ─── Renderer helpers ───────────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;

function hosts(renderer: Renderer, testID: string) {
  return renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === testID,
  );
}

function pressTargetIds(renderer: Renderer): string[] {
  const ids = new Set<string>();
  for (const node of renderer.root.findAll(
    n =>
      'onPress' in n.props ||
      'onLongPress' in n.props ||
      'onValueChange' in n.props ||
      'onSubmitEditing' in n.props,
  )) {
    ids.add(String(node.props.testID));
  }
  return [...ids].sort();
}

/** Host-level emblem labels (one per rendered RankIcon). */
function emblemLabels(renderer: Renderer): string[] {
  return renderer.root
    .findAll(
      n =>
        typeof n.type === 'string' &&
        typeof n.props.accessibilityLabel === 'string' &&
        /emblem$/.test(n.props.accessibilityLabel),
    )
    .map(n => n.props.accessibilityLabel as string);
}

function rankRowLabels(renderer: Renderer): string[] {
  return renderer.root
    .findAll(
      n =>
        typeof n.type === 'string' &&
        typeof n.props.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith('Player rank '),
    )
    .map(n => n.props.accessibilityLabel as string);
}

function textContent(renderer: Renderer): string {
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') parts.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return parts.join('');
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ─── Scenario model ─────────────────────────────────────────────────────────

type Op =
  | { kind: 'navigate'; renders: number; sameContent: boolean }
  | { kind: 'rerender-same-facts' }
  | { kind: 'auth'; signedIn: boolean }
  | {
      kind: 'settle-fetch';
      which: 'oldest' | 'newest' | 'random';
      mode: 'ranked' | 'null' | 'reject';
    }
  | { kind: 'settle-all'; mode: 'ranked' | 'reject' }
  | { kind: 'advance'; ms: number }
  | { kind: 'toggle-reduced' }
  | { kind: 'unmount' }
  | { kind: 'remount' };

interface Outcome {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  ops: number;
  renders: number;
  fetches: number;
  authFlips: number;
  remounts: number;
  failures: string[];
  trace: string[];
}

function emblemFor(tier: PlayerRankSummary['tier'] | null): string {
  if (tier === null) return 'Unranked emblem';
  return `${tier[0]!.toUpperCase()}${tier.slice(1)} rank emblem`;
}

async function runScenario(seed: number): Promise<Outcome> {
  const rng = mulberry32(seed);
  const failures: string[] = [];
  const trace: string[] = [];
  const consoleErrors: string[] = [];
  const rejections: string[] = [];

  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(a => String(a)).join(' '));
    });
  const warnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(a => String(a)).join(' '));
    });
  const onRejection = (reason: unknown) => {
    rejections.push(String(reason));
  };
  process.on('unhandledRejection', onRejection);

  mockPendingFetches.length = 0;
  mockFetchCalls = 0;
  mockCelebrateCalls.length = 0;
  mockSignedIn = rng() < 0.7;
  mockReducedMotion = rng() < 0.25;

  let facts = randomFacts(rng);
  let renderer!: Renderer;
  let mounted = false;
  let renders = 0;
  let authFlips = 0;
  let remounts = 0;
  // Model of the card's async state.
  let expectedFetches = 0;
  let activeFetchId: number | null = null;
  let serverRank: ServerPlayerRank | null = null;
  // Every distinct resolved rank the card rendered, in order — exactly what
  // the celebration store must have been told, once each.
  const expectedReports: PlayerRankSummary[] = [];

  /** Mirror of the card's `[props.facts]` effect: one request per facts
   * identity while signed in, a reset to the local rank when signed out.
   * Returns true when the reset changed the account rank (extra render). */
  const onFactsEffect = (): boolean => {
    if (!mockSignedIn) {
      activeFetchId = null;
      const changed = serverRank !== null;
      serverRank = null;
      return changed;
    }
    expectedFetches += 1;
    activeFetchId = expectedFetches;
    return false;
  };

  /** A render with a new facts identity: the render reports the rank from
   * the facts plus whatever account rank is held; the facts effect then
   * either requests a fresh account rank or, signed out, drops the held
   * one (a second render + report when it was non-null). */
  const newFacts = () => {
    onResolvedEffect(true, false);
    if (onFactsEffect()) onResolvedEffect(false, true);
  };

  /** Mirror of the `[resolved]` effect: a report per new resolved value. */
  const onResolvedEffect = (factsChanged: boolean, serverChanged: boolean) => {
    const resolved = resolvePlayerRank(facts, serverRank);
    if (!resolved || (!factsChanged && !serverChanged)) return;
    expectedReports.push(resolved.summary);
  };

  const render = async () => {
    renders += 1;
    await act(async () => {
      if (mounted) renderer.update(<PlayerRankCard facts={facts} />);
      else renderer = TestRenderer.create(<PlayerRankCard facts={facts} />);
    });
    mounted = true;
  };

  const check = (where: string) => {
    if (mockFetchCalls !== expectedFetches) {
      failures.push(
        `${where}: fetchPlayerRank calls=${mockFetchCalls} model=${expectedFetches}`,
      );
    }
    if (mockCelebrateCalls.length !== expectedReports.length) {
      failures.push(
        `${where}: maybeCelebrate calls=${mockCelebrateCalls.length} model=${expectedReports.length}`,
      );
    } else {
      for (let i = 0; i < expectedReports.length; i += 1) {
        const got = mockCelebrateCalls[i]!;
        const want = expectedReports[i]!;
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          failures.push(
            `${where}: maybeCelebrate #${i + 1} reported ${got.tier} ${got.rating}, rendered ${want.tier} ${want.rating}`,
          );
          break;
        }
      }
    }
    if (!mounted) return;
    const cards = hosts(renderer, 'player-rank-card');
    if (cards.length !== 1)
      failures.push(`${where}: ${cards.length} card hosts`);
    const targets = pressTargetIds(renderer);
    if (targets.length !== 0)
      failures.push(`${where}: press targets ${targets.join(',')}`);

    const expected = resolvePlayerRank(facts, serverRank);
    const emblems = emblemLabels(renderer);
    const wantEmblem = emblemFor(expected?.summary.tier ?? null);
    if (emblems.length !== 1 || emblems[0] !== wantEmblem) {
      failures.push(
        `${where}: emblems [${emblems.join(', ')}] expected [${wantEmblem}]`,
      );
    }
    const rows = rankRowLabels(renderer);
    const text = textContent(renderer);
    if (expected) {
      const { summary } = expected;
      const wantPrefix = `Player rank ${summary.tierLabel} ${summary.divisionLabel}. Rating ${summary.rating.toFixed(2)} out of 10`;
      if (rows.length !== 1 || !rows[0]!.startsWith(wantPrefix)) {
        failures.push(
          `${where}: rank rows [${rows.join(' | ')}] expected prefix "${wantPrefix}"`,
        );
      }
      if (text.includes('Unranked'))
        failures.push(`${where}: ranked card still shows Unranked copy`);
      if (!text.includes(summary.rating.toFixed(2))) {
        failures.push(
          `${where}: rating ${summary.rating.toFixed(2)} not rendered`,
        );
      }
      const wantSource =
        expected.source === 'account'
          ? 'Saved to your account.'
          : 'Computed on this device';
      if (!text.includes(wantSource)) {
        failures.push(`${where}: source note for ${expected.source} missing`);
      }
    } else {
      if (rows.length !== 0)
        failures.push(
          `${where}: unranked card has rank rows [${rows.join(' | ')}]`,
        );
      if (!text.includes('Unranked'))
        failures.push(`${where}: unranked card lacks Unranked copy`);
    }
  };

  const ops: Op[] = [];
  const opCount = int(rng, 6, 18);
  for (let i = 0; i < opCount; i += 1) {
    const roll = rng();
    if (roll < 0.3) {
      ops.push({
        kind: 'navigate',
        renders: pick(rng, [1, 1, 2, 3, 5]),
        sameContent: rng() < 0.25,
      });
    } else if (roll < 0.36) ops.push({ kind: 'rerender-same-facts' });
    else if (roll < 0.46) ops.push({ kind: 'auth', signedIn: rng() < 0.6 });
    else if (roll < 0.7) {
      ops.push({
        kind: 'settle-fetch',
        which: pick(rng, ['oldest', 'newest', 'random']),
        mode: pick(rng, ['ranked', 'ranked', 'null', 'reject']),
      });
    } else if (roll < 0.76)
      ops.push({ kind: 'settle-all', mode: rng() < 0.7 ? 'ranked' : 'reject' });
    else if (roll < 0.86)
      ops.push({ kind: 'advance', ms: pick(rng, [0, 16, 60, 300, 1000]) });
    else if (roll < 0.9) ops.push({ kind: 'toggle-reduced' });
    else if (roll < 0.96) ops.push({ kind: 'unmount' });
    else ops.push({ kind: 'remount' });
  }
  ops.push({ kind: 'settle-fetch', which: 'oldest', mode: 'ranked' });
  ops.push({ kind: 'settle-all', mode: 'reject' });
  ops.push({ kind: 'advance', ms: 1000 });

  const settle = async (
    target: Deferred,
    mode: 'ranked' | 'null' | 'reject',
  ) => {
    const value = mode === 'ranked' ? randomServerRank(rng) : null;
    await act(async () => {
      if (mode === 'reject') target.reject(new Error('offline'));
      else target.resolve(value);
    });
    await flush();
    if (mounted && target.id === activeFetchId) {
      const next = mode === 'reject' ? null : value;
      // `setServerRank(null)` over `null` is a no-op render — no new report.
      const changed = next !== serverRank;
      serverRank = next;
      onResolvedEffect(false, changed);
    }
  };

  try {
    await render();
    newFacts();
    check('mount');
    for (const [index, op] of ops.entries()) {
      trace.push(`${index}:${JSON.stringify(op)}`);
      switch (op.kind) {
        case 'navigate': {
          if (!mounted) break;
          // A host screen re-rendering N times in one burst hands the card a
          // fresh facts array each time (query re-runs, focus effects).
          for (let r = 0; r < op.renders; r += 1) {
            facts = op.sameContent ? [...facts] : randomFacts(rng);
            await render();
            newFacts();
          }
          break;
        }
        case 'rerender-same-facts':
          if (!mounted) break;
          await render();
          break;
        case 'auth':
          if (mockSignedIn !== op.signedIn) authFlips += 1;
          mockSignedIn = op.signedIn;
          break;
        case 'settle-fetch': {
          const open = mockPendingFetches.filter(d => !d.settled);
          if (open.length === 0) break;
          const target =
            op.which === 'oldest'
              ? open[0]!
              : op.which === 'newest'
                ? open[open.length - 1]!
                : pick(rng, open);
          await settle(target, op.mode);
          break;
        }
        case 'settle-all': {
          // Every in-flight response lands in the same tick, oldest first.
          const open = mockPendingFetches.filter(d => !d.settled);
          if (open.length === 0) break;
          const values = open.map(() =>
            op.mode === 'ranked' ? randomServerRank(rng) : null,
          );
          await act(async () => {
            open.forEach((target, i) => {
              if (op.mode === 'reject') target.reject(new Error('offline'));
              else target.resolve(values[i]!);
            });
          });
          await flush();
          if (mounted && activeFetchId !== null) {
            const activeIndex = open.findIndex(d => d.id === activeFetchId);
            if (activeIndex >= 0) {
              const next = op.mode === 'reject' ? null : values[activeIndex]!;
              const changed = next !== serverRank;
              serverRank = next;
              onResolvedEffect(false, changed);
            }
          }
          break;
        }
        case 'advance':
          await act(async () => {
            jest.advanceTimersByTime(op.ms);
          });
          break;
        case 'toggle-reduced':
          if (!mounted) break;
          mockReducedMotion = !mockReducedMotion;
          await render();
          break;
        case 'unmount':
          if (!mounted) break;
          await act(async () => {
            renderer.unmount();
          });
          mounted = false;
          activeFetchId = null;
          break;
        case 'remount':
          if (mounted) break;
          remounts += 1;
          serverRank = null;
          await render();
          newFacts();
          break;
      }
      check(`op${index}`);
    }

    if (mounted) {
      await act(async () => {
        renderer.unmount();
      });
      mounted = false;
    }
    await flush();
    jest.runOnlyPendingTimers();
    const leakedTimers = jest.getTimerCount();
    if (leakedTimers !== 0)
      failures.push(`${leakedTimers} timers alive after unmount`);
    check('final');
  } catch (error) {
    failures.push(
      `threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  } finally {
    await flush();
    process.off('unhandledRejection', onRejection);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  }
  for (const message of consoleErrors)
    failures.push(`console: ${message.slice(0, 300)}`);
  for (const message of rejections)
    failures.push(`unhandledRejection: ${message.slice(0, 300)}`);

  return {
    seed,
    outcome: failures.length === 0 ? 'HELD' : 'BROKEN',
    ops: ops.length,
    renders,
    fetches: mockFetchCalls,
    authFlips,
    remounts,
    failures,
    trace,
  };
}

describe('STRESS cmp-rank rapid-interaction — PlayerRankCard + RankIcon', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const seeds = STRESS_SEED
    ? [Number(STRESS_SEED)]
    : Array.from({ length: STRESS_ITER }, (_, i) => 3000 + i);

  it(`holds every invariant across ${seeds.length} seeded navigation bursts`, async () => {
    const results: Outcome[] = [];
    for (const seed of seeds) {
      results.push(await runScenario(seed));
    }
    const broken = results.filter(r => r.outcome === 'BROKEN');
    const totals = results.reduce(
      (acc, r) => ({
        ops: acc.ops + r.ops,
        renders: acc.renders + r.renders,
        fetches: acc.fetches + r.fetches,
        authFlips: acc.authFlips + r.authFlips,
        remounts: acc.remounts + r.remounts,
      }),
      { ops: 0, renders: 0, fetches: 0, authFlips: 0, remounts: 0 },
    );
    const table = {
      unit: 'cmp-rank',
      component: 'PlayerRankCard+RankIcon',
      lens: 'rapid-interaction',
      iterations: results.length,
      totals,
      broken: broken.map(r => r.seed),
      results: results.map(r => ({
        seed: r.seed,
        outcome: r.outcome,
        ops: r.ops,
        renders: r.renders,
        fetches: r.fetches,
        authFlips: r.authFlips,
        remounts: r.remounts,
        failures: r.failures,
        ...(r.outcome === 'BROKEN' || STRESS_SEED ? { trace: r.trace } : {}),
      })),
    };
    if (STRESS_REPORT_DIR) {
      mkdirSync(STRESS_REPORT_DIR, { recursive: true });
      writeFileSync(
        join(STRESS_REPORT_DIR, 'playerRankCard.rapid-interaction.json'),
        JSON.stringify(table, null, 2),
      );
    }
    if (broken.length > 0 || STRESS_SEED) {
      process.stdout.write(
        JSON.stringify(
          { ...table, results: broken.length ? broken : table.results },
          null,
          2,
        ) + '\n',
      );
    }
    expect(broken.map(r => ({ seed: r.seed, failures: r.failures }))).toEqual(
      [],
    );
    expect(results.length).toBe(seeds.length);
  }, 600_000);
});
