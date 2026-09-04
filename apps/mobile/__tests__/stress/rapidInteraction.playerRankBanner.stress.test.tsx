/**
 * STRESS — unit `cmp-rank`, lens `rapid-interaction`: PlayerRankBanner.
 *
 * A seeded generator scripts bursts of hostile interaction against the Home
 * rank banner: double/triple taps on the fold toggle, taps landing inside the
 * 180 ms fold-away transition, the toggle and the streak block pressed in the
 * same tick, `shots` identity churn while the account-rank request is still
 * in flight, late/failed/stale responses, reduced-motion flips, and unmount
 * with responses landing afterwards. Every iteration is replayable from its
 * seed (`STRESS_SEED=<n>`), the campaign size is `STRESS_ITER` (small default
 * so the suite stays fast), and the seed → outcome table can be written to
 * `STRESS_REPORT_DIR`.
 *
 * Invariants asserted after every burst (a model tracks the intended state):
 *   - one press = one state flip: `accessibilityState.expanded` equals the
 *     parity of toggle taps; the streak callback fires exactly once per tap;
 *   - no orphan transition state: the fold-out host is mounted iff the
 *     banner is expanded or the 180 ms fold-away is still running, and its
 *     `pointerEvents` gate matches `expanded`;
 *   - one request per intent: `fetchPlayerRank` is called exactly once per
 *     `shots` identity while signed in, never when signed out;
 *   - stale responses never win: the rendered rank equals
 *     `resolvePlayerRank(currentShots, lastActiveResponse)`;
 *   - every `maybeCelebrate` report is a rank the banner actually rendered;
 *   - exactly one toggle, one streak press target, at most one fold-out host;
 *   - no console.error (act() warnings, late setState), no unhandled
 *     rejections, no timers left behind after unmount.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { PlayerRankSummary } from '@pickle/shared-types';

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

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

import { PlayerRankBanner } from '../../src/components/PlayerRankBanner';
import {
  resolvePlayerRank,
  type PlayerRankFactLike,
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
const FOLD_AWAY_MS = 180;

// ─── Fixture generators ─────────────────────────────────────────────────────

const SHOT_TYPES = ['dink', 'volley', 'serve', 'forehand_drive', 'return'];
const TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond'] as const;

let factSequence = 0;
function randomShots(rng: () => number): PlayerRankFactLike[] {
  const count = pick(rng, [0, 0, 1, 2, 3, 5, 8, 12]);
  const shots: PlayerRankFactLike[] = [];
  for (let i = 0; i < count; i += 1) {
    factSequence += 1;
    const scored = rng() < 0.85;
    shots.push({
      id: `shot-${factSequence}`,
      shotType: pick(rng, SHOT_TYPES),
      capturedAt: new Date(
        Date.UTC(2026, 7, 1 + (factSequence % 27), factSequence % 24),
      ).toISOString(),
      overallScore: scored ? Math.round(rng() * 1000) / 100 : null,
      resultKind: scored ? 'scored' : 'low_confidence',
    });
  }
  return shots;
}

function randomServerRank(rng: () => number): ServerPlayerRank {
  const rating = Math.round(rng() * 1000) / 100;
  // One entry per technique, like the server aggregates.
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

/** Distinct press targets (by testID) — anything carrying a press handler. */
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

/** Composite Pressable instance carrying the given testID. */
function pressable(renderer: Renderer, testID: string) {
  const nodes = renderer.root.findAll(
    n =>
      n.props.testID === testID &&
      'onPress' in n.props &&
      typeof n.type !== 'string',
  );
  const outermost = nodes[0];
  if (!outermost) throw new Error(`no press target ${testID}`);
  return outermost;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ─── Scenario model ─────────────────────────────────────────────────────────

interface BannerProps {
  shots: PlayerRankFactLike[];
  streakDays: number;
  streakAtRisk: boolean;
  withStreakHandler: boolean;
}

type Op =
  | { kind: 'tap-toggle'; taps: number }
  | { kind: 'tap-toggle-same-tick'; taps: number }
  | { kind: 'tap-streak'; taps: number }
  | { kind: 'simultaneous' }
  | { kind: 'advance'; ms: number }
  | { kind: 'change-shots'; sameContent: boolean }
  | { kind: 'change-streak' }
  | {
      kind: 'settle-fetch';
      which: 'oldest' | 'newest' | 'random';
      mode: 'ranked' | 'null' | 'reject';
    }
  | { kind: 'toggle-reduced' }
  | { kind: 'unmount' };

interface Outcome {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  ops: number;
  signedIn: boolean;
  fetches: number;
  toggles: number;
  streakTaps: number;
  sameTickBursts: number;
  failures: string[];
  trace: string[];
}

class Model {
  expanded = false;
  foldOutMounted = false;
  closeAt: number | null = null;
  streakCalls = 0;
  expectedFetches = 0;
  activeFetchId: number | null = null;
  serverRank: ServerPlayerRank | null = null;
  mounted = true;
  toggles = 0;
  streakTaps = 0;
  sameTickBursts = 0;

  toggle(reduced: boolean, now: number) {
    this.toggles += 1;
    this.expanded = !this.expanded;
    if (this.expanded) {
      this.foldOutMounted = true;
      this.closeAt = null;
    } else if (reduced) {
      this.foldOutMounted = false;
      this.closeAt = null;
    } else {
      this.closeAt = now;
    }
  }

  advance(now: number) {
    if (this.closeAt !== null && now - this.closeAt >= FOLD_AWAY_MS) {
      this.foldOutMounted = false;
      this.closeAt = null;
    }
  }

  newShots(signedIn: boolean) {
    if (!signedIn) {
      this.activeFetchId = null;
      this.serverRank = null;
      return;
    }
    this.expectedFetches += 1;
    this.activeFetchId = this.expectedFetches;
  }

  settle(id: number, value: ServerPlayerRank | null, rejected: boolean) {
    if (!this.mounted || id !== this.activeFetchId) return;
    this.serverRank = rejected ? null : value;
  }
}

function summaryLabel(summary: PlayerRankSummary | null): string {
  return summary
    ? `Player rank ${summary.tierLabel} ${summary.divisionLabel}, rating ${summary.rating.toFixed(2)} out of 10.`
    : 'Player rank: unranked.';
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
  const model = new Model();

  let props: BannerProps = {
    shots: randomShots(rng),
    streakDays: pick(rng, [0, 1, 3, 7, 30]),
    streakAtRisk: rng() < 0.3,
    withStreakHandler: rng() < 0.85,
  };
  const onPressStreak = jest.fn<void, []>();

  const element = (p: BannerProps) => (
    <PlayerRankBanner
      shots={p.shots}
      streakDays={p.streakDays}
      streakAtRisk={p.streakAtRisk}
      onPressStreak={p.withStreakHandler ? onPressStreak : undefined}
    />
  );

  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(element(props));
  });
  model.newShots(mockSignedIn);
  const renderedSummaries = new Set<string>();

  const check = (where: string) => {
    if (!model.mounted) return;
    const toggle = pressable(renderer, 'player-rank-banner-toggle');
    const expanded = toggle.props.accessibilityState?.expanded;
    if (expanded !== model.expanded) {
      failures.push(
        `${where}: expanded=${String(expanded)} model=${model.expanded}`,
      );
    }
    const foldOuts = hosts(renderer, 'player-rank-banner-fold-out');
    if (foldOuts.length > 1)
      failures.push(`${where}: ${foldOuts.length} fold-out hosts`);
    if (foldOuts.length !== (model.foldOutMounted ? 1 : 0)) {
      failures.push(
        `${where}: fold-out mounted=${foldOuts.length} model=${model.foldOutMounted ? 1 : 0}`,
      );
    }
    for (const foldOut of foldOuts) {
      const gate = foldOut.props.pointerEvents;
      if (gate !== (model.expanded ? 'auto' : 'none')) {
        failures.push(
          `${where}: fold-out pointerEvents=${String(gate)} expanded=${model.expanded}`,
        );
      }
    }
    const targets = pressTargetIds(renderer);
    if (
      targets.join(',') !==
      'player-rank-banner-streak,player-rank-banner-toggle'
    ) {
      failures.push(`${where}: press targets ${targets.join(',')}`);
    }
    if (mockFetchCalls !== model.expectedFetches) {
      failures.push(
        `${where}: fetchPlayerRank calls=${mockFetchCalls} model=${model.expectedFetches}`,
      );
    }
    if (onPressStreak.mock.calls.length !== model.streakCalls) {
      failures.push(
        `${where}: onPressStreak calls=${onPressStreak.mock.calls.length} model=${model.streakCalls}`,
      );
    }
    const expectedResolved = resolvePlayerRank(props.shots, model.serverRank);
    const expectedLabel = summaryLabel(expectedResolved?.summary ?? null);
    const label: string = toggle.props.accessibilityLabel;
    if (!label.startsWith(expectedLabel)) {
      failures.push(
        `${where}: label "${label}" expected prefix "${expectedLabel}"`,
      );
    }
    if (expectedResolved)
      renderedSummaries.add(JSON.stringify(expectedResolved.summary));
  };

  const tapToggle = async () => {
    const node = pressable(renderer, 'player-rank-banner-toggle');
    await act(async () => {
      node.props.onPress();
    });
    model.toggle(mockReducedMotion, jest.now());
  };

  const ops: Op[] = [];
  const opCount = int(rng, 6, 18);
  for (let i = 0; i < opCount; i += 1) {
    const roll = rng();
    if (roll < 0.22)
      ops.push({ kind: 'tap-toggle', taps: pick(rng, [1, 2, 2, 3]) });
    else if (roll < 0.28)
      ops.push({ kind: 'tap-toggle-same-tick', taps: pick(rng, [2, 3]) });
    else if (roll < 0.4)
      ops.push({ kind: 'tap-streak', taps: pick(rng, [1, 2, 3]) });
    else if (roll < 0.46) ops.push({ kind: 'simultaneous' });
    else if (roll < 0.62)
      ops.push({
        kind: 'advance',
        ms: pick(rng, [1, 50, 100, 179, 180, 181, 400]),
      });
    else if (roll < 0.74)
      ops.push({ kind: 'change-shots', sameContent: rng() < 0.3 });
    else if (roll < 0.78) ops.push({ kind: 'change-streak' });
    else if (roll < 0.92) {
      ops.push({
        kind: 'settle-fetch',
        which: pick(rng, ['oldest', 'newest', 'random']),
        mode: pick(rng, ['ranked', 'ranked', 'null', 'reject']),
      });
    } else if (roll < 0.96) ops.push({ kind: 'toggle-reduced' });
    else ops.push({ kind: 'unmount' });
  }
  // Late responses after unmount are part of the lens: always try to settle
  // anything still in flight at the very end.
  ops.push({ kind: 'settle-fetch', which: 'oldest', mode: 'ranked' });
  ops.push({ kind: 'settle-fetch', which: 'newest', mode: 'reject' });
  ops.push({ kind: 'advance', ms: 1000 });

  try {
    check('mount');
    for (const [index, op] of ops.entries()) {
      trace.push(`${index}:${JSON.stringify(op)}`);
      switch (op.kind) {
        case 'tap-toggle':
          if (!model.mounted) break;
          for (let t = 0; t < op.taps; t += 1) await tapToggle();
          break;
        case 'tap-toggle-same-tick': {
          if (!model.mounted) break;
          // Two release events cannot share one JS turn on-device, so the
          // model re-syncs from the rendered state after the burst; the
          // structural invariants (fold-out ↔ expanded) must still hold.
          model.sameTickBursts += 1;
          const node = pressable(renderer, 'player-rank-banner-toggle');
          await act(async () => {
            for (let t = 0; t < op.taps; t += 1) node.props.onPress();
          });
          const observed = pressable(renderer, 'player-rank-banner-toggle')
            .props.accessibilityState?.expanded as boolean;
          if (observed !== model.expanded) {
            model.toggle(mockReducedMotion, jest.now());
          } else if (op.taps % 2 === 0) {
            // Even taps that end where they started still armed a
            // fold-away when the last press closed the banner.
            if (!observed && !mockReducedMotion) {
              model.foldOutMounted = true;
              model.closeAt = jest.now();
            }
          }
          trace.push(`  same-tick x${op.taps} → expanded=${observed}`);
          break;
        }
        case 'tap-streak': {
          if (!model.mounted) break;
          const node = pressable(renderer, 'player-rank-banner-streak');
          for (let t = 0; t < op.taps; t += 1) {
            model.streakTaps += 1;
            if (
              typeof node.props.onPress === 'function' &&
              !node.props.disabled
            ) {
              await act(async () => {
                node.props.onPress();
              });
              model.streakCalls += 1;
            }
          }
          break;
        }
        case 'simultaneous': {
          if (!model.mounted) break;
          const toggle = pressable(renderer, 'player-rank-banner-toggle');
          const streak = pressable(renderer, 'player-rank-banner-streak');
          const streakLive =
            typeof streak.props.onPress === 'function' &&
            !streak.props.disabled;
          await act(async () => {
            toggle.props.onPress();
            if (streakLive) streak.props.onPress();
          });
          model.toggle(mockReducedMotion, jest.now());
          model.streakTaps += 1;
          if (streakLive) model.streakCalls += 1;
          break;
        }
        case 'advance':
          await act(async () => {
            jest.advanceTimersByTime(op.ms);
          });
          model.advance(jest.now());
          break;
        case 'change-shots': {
          if (!model.mounted) break;
          props = {
            ...props,
            shots: op.sameContent ? [...props.shots] : randomShots(rng),
          };
          await act(async () => {
            renderer.update(element(props));
          });
          model.newShots(mockSignedIn);
          break;
        }
        case 'change-streak': {
          if (!model.mounted) break;
          props = {
            ...props,
            streakDays: pick(rng, [0, 1, 3, 7, 30]),
            streakAtRisk: rng() < 0.3,
            withStreakHandler: rng() < 0.85,
          };
          await act(async () => {
            renderer.update(element(props));
          });
          break;
        }
        case 'settle-fetch': {
          const open = mockPendingFetches.filter(d => !d.settled);
          if (open.length === 0) break;
          const target =
            op.which === 'oldest'
              ? open[0]!
              : op.which === 'newest'
                ? open[open.length - 1]!
                : pick(rng, open);
          const value = op.mode === 'ranked' ? randomServerRank(rng) : null;
          await act(async () => {
            if (op.mode === 'reject') target.reject(new Error('offline'));
            else target.resolve(value);
          });
          await flush();
          model.settle(target.id, value, op.mode === 'reject');
          break;
        }
        case 'toggle-reduced':
          if (!model.mounted) break;
          mockReducedMotion = !mockReducedMotion;
          await act(async () => {
            renderer.update(element(props));
          });
          break;
        case 'unmount':
          if (!model.mounted) break;
          await act(async () => {
            renderer.unmount();
          });
          model.mounted = false;
          break;
      }
      check(`op${index}`);
    }

    if (model.mounted) {
      await act(async () => {
        renderer.unmount();
      });
      model.mounted = false;
    }
    // Whatever is still scheduled (React's own work, a leaked fold-away
    // timer) must run without touching the unmounted banner and leave
    // nothing behind — a self-rescheduling timer would survive this.
    await flush();
    jest.runOnlyPendingTimers();
    const leakedTimers = jest.getTimerCount();
    if (leakedTimers !== 0)
      failures.push(`${leakedTimers} timers alive after unmount`);

    for (const summary of mockCelebrateCalls) {
      if (!renderedSummaries.has(JSON.stringify(summary))) {
        failures.push(
          `maybeCelebrate reported a rank never rendered: ${summary.tier} ${summary.rating}`,
        );
      }
    }
    const last = mockCelebrateCalls[mockCelebrateCalls.length - 1];
    if (last) {
      const finalResolved = resolvePlayerRank(props.shots, model.serverRank);
      if (
        finalResolved &&
        JSON.stringify(finalResolved.summary) !== JSON.stringify(last)
      ) {
        failures.push(
          `last maybeCelebrate=${last.tier} ${last.rating}, final rendered=${finalResolved.summary.tier} ${finalResolved.summary.rating}`,
        );
      }
    }
  } catch (error) {
    failures.push(
      `threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  } finally {
    // Let any stray late microtasks land before we stop listening.
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
    signedIn: mockSignedIn,
    fetches: mockFetchCalls,
    toggles: model.toggles,
    streakTaps: model.streakTaps,
    sameTickBursts: model.sameTickBursts,
    failures,
    trace,
  };
}

describe('STRESS cmp-rank rapid-interaction — PlayerRankBanner', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const seeds = STRESS_SEED
    ? [Number(STRESS_SEED)]
    : Array.from({ length: STRESS_ITER }, (_, i) => 1000 + i);

  it(`holds every invariant across ${seeds.length} seeded interaction bursts`, async () => {
    const results: Outcome[] = [];
    for (const seed of seeds) {
      results.push(await runScenario(seed));
    }
    const broken = results.filter(r => r.outcome === 'BROKEN');
    const totals = results.reduce(
      (acc, r) => ({
        ops: acc.ops + r.ops,
        fetches: acc.fetches + r.fetches,
        toggles: acc.toggles + r.toggles,
        streakTaps: acc.streakTaps + r.streakTaps,
        sameTickBursts: acc.sameTickBursts + r.sameTickBursts,
      }),
      { ops: 0, fetches: 0, toggles: 0, streakTaps: 0, sameTickBursts: 0 },
    );
    const table = {
      unit: 'cmp-rank',
      component: 'PlayerRankBanner',
      lens: 'rapid-interaction',
      iterations: results.length,
      totals,
      broken: broken.map(r => r.seed),
      results: results.map(r => ({
        seed: r.seed,
        outcome: r.outcome,
        ops: r.ops,
        signedIn: r.signedIn,
        fetches: r.fetches,
        toggles: r.toggles,
        streakTaps: r.streakTaps,
        sameTickBursts: r.sameTickBursts,
        failures: r.failures,
        ...(r.outcome === 'BROKEN' || STRESS_SEED ? { trace: r.trace } : {}),
      })),
    };
    if (STRESS_REPORT_DIR) {
      mkdirSync(STRESS_REPORT_DIR, { recursive: true });
      writeFileSync(
        join(STRESS_REPORT_DIR, 'playerRankBanner.rapid-interaction.json'),
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
