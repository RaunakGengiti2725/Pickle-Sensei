/**
 * STRESS · unit cmp-rank · lens rapid-interaction · RankUpCelebration
 *
 * Seeded interaction-burst campaign over the rank ceremony overlay driven by
 * the REAL `useRankCelebrationStore` (serialized evaluation queue, durable
 * kv record, walkthrough yield) with the kv layer replaced by an in-memory
 * store whose reads/writes settle only when the scenario says so. Every
 * iteration is replayable: `STRESS_SEED=<n> npx jest --ci <this file>`.
 * `STRESS_ITER` (default 40) sizes the campaign; `STRESS_REPORT_DIR` writes
 * the seed → outcome table as JSON.
 *
 * Bursts: double/triple Continue, double/triple backdrop, hardware back
 * spam, Continue + backdrop + back in one JS turn, dismiss while a rank
 * report is still evaluating (kv read/write in flight), two surfaces
 * (Home banner + Progress card) reporting the same rank in the same tick,
 * reports while a ceremony is showing, walkthrough shown/hidden around a
 * promotion, owner switch mid-evaluation, count-up frames interleaved with
 * dismissals, unmount with work in flight.
 *
 * Invariants (per op):
 *   - the Modal is visible ⇔ store.current ≠ null, exactly one stage host
 *     while showing and none otherwise (no duplicate / orphan modal);
 *   - current never jumps from one ceremony straight to another (no
 *     stacking);
 *   - exactly one ceremony per upward tier transition when nothing is
 *     showing, none otherwise — checked at every kv settlement against the
 *     store's own pure decision `evaluateRankTransition`;
 *   - while showing: exactly three press targets (Continue ×2 labels,
 *     backdrop), every handler IS the store's dismiss; none otherwise;
 *   - one screen-reader announcement per stage mount;
 *   - one count-up frame chain at most, cancelled by dismiss/unmount,
 *     finishing on the exact final rating;
 *   - emblems: two RankIcons for a promotion, one for a placement;
 *   - no console.error/warn (act() warnings, key collisions), no unhandled
 *     rejections, nothing left on the timer queue after unmount.
 */
import React from 'react';
import { AccessibilityInfo } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  PLAYER_RANK_TIERS,
  type PlayerRankSummary,
  type PlayerRankTierKey,
} from '@pickle/shared-types';

jest.mock('../../src/data/db', () => ({
  getDb: () => ({ kind: 'stress-fake-db' }),
}));

interface KvOp {
  id: number;
  op: 'get' | 'set';
  key: string;
  value?: string;
  settled: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}
const mockKv = new Map<string, string>();
const mockKvOps: KvOp[] = [];
let mockKvCounter = 0;
jest.mock('../../src/data/repository', () => ({
  getKv: (_db: unknown, key: string) =>
    new Promise<string | null>((resolve, reject) => {
      mockKvCounter += 1;
      const op: KvOp = {
        id: mockKvCounter,
        op: 'get',
        key,
        settled: false,
        resolve: () => {
          op.settled = true;
          resolve(mockKv.get(key) ?? null);
        },
        reject: error => {
          op.settled = true;
          reject(error);
        },
      };
      mockKvOps.push(op);
    }),
  setKv: (_db: unknown, key: string, value: string) =>
    new Promise<void>((resolve, reject) => {
      mockKvCounter += 1;
      const op: KvOp = {
        id: mockKvCounter,
        op: 'set',
        key,
        value,
        settled: false,
        resolve: () => {
          op.settled = true;
          mockKv.set(key, value);
          resolve();
        },
        reject: error => {
          op.settled = true;
          reject(error);
        },
      };
      mockKvOps.push(op);
    }),
}));

let mockReducedMotion = false;
jest.mock('../../src/design/components', () => ({
  ...jest.requireActual('../../src/design/components'),
  useReducedMotion: () => mockReducedMotion,
}));

import { RankUpCelebration } from '../../src/components/RankUpCelebration';
import {
  evaluateRankTransition,
  rankCelebrationKeyForOwner,
  useRankCelebrationStore,
  type RankCelebration,
} from '../../src/progress/rankCelebration';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';

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
const COUNT_UP_DELAY = 780;
const COUNT_UP_DURATION = 720;

const OWNERS = [
  'aaaaaaaa-0000-4000-8000-000000000001',
  'bbbbbbbb-0000-4000-8000-000000000002',
] as const;

// ─── Fixtures ───────────────────────────────────────────────────────────────

function randomSummary(rng: () => number): PlayerRankSummary {
  const tierIndex = int(rng, 0, PLAYER_RANK_TIERS.length - 1);
  const tier = PLAYER_RANK_TIERS[tierIndex]!;
  const next = PLAYER_RANK_TIERS[tierIndex + 1];
  const ceiling = next?.minRating ?? 10;
  const rating =
    Math.round((tier.minRating + rng() * (ceiling - tier.minRating)) * 100) /
    100;
  const techniqueCount = int(rng, 1, 4);
  return {
    rating,
    tier: tier.key,
    tierLabel: tier.label,
    division: pick(rng, [1, 2, 3] as const),
    divisionLabel: pick(rng, ['I', 'II', 'III'] as const),
    techniqueCount,
    scoredAnalysisCount: int(rng, techniqueCount, 20),
    techniques: [],
    nextTier: next
      ? {
          key: next.key,
          label: next.label,
          minRating: next.minRating,
          pointsNeeded: Math.round((next.minRating - rating) * 100) / 100,
        }
      : null,
  };
}

// ─── Renderer helpers ───────────────────────────────────────────────────────

type Renderer = TestRenderer.ReactTestRenderer;

function hosts(renderer: Renderer, testID: string) {
  return renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === testID,
  );
}

function pressTargets(renderer: Renderer) {
  return renderer.root.findAll(
    n =>
      typeof n.props.onPress === 'function' ||
      typeof n.props.onValueChange === 'function' ||
      typeof n.props.onLongPress === 'function' ||
      typeof n.props.onSubmitEditing === 'function',
  );
}

function innermost(
  renderer: Renderer,
  match: (n: TestRenderer.ReactTestInstance) => boolean,
) {
  const nodes = renderer.root.findAll(
    n => typeof n.props.onPress === 'function' && match(n),
  );
  return nodes[nodes.length - 1];
}

/** Host-level modal views (one per mounted `Modal`). */
function modalHosts(renderer: Renderer) {
  return renderer.root.findAll(
    n =>
      typeof n.type === 'string' &&
      typeof n.props.onRequestClose === 'function',
  );
}

/** Outermost composite `Modal` — carries the props the component set. */
function modal(renderer: Renderer) {
  return renderer.root.findAll(
    n => typeof n.props.onRequestClose === 'function',
  )[0];
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

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function sameCelebration(a: RankCelebration | null, b: RankCelebration | null) {
  if (a === null || b === null) return a === b;
  return (
    a.fromTier === b.fromTier &&
    a.toTier === b.toTier &&
    a.fromRating === b.fromRating &&
    a.summary === b.summary
  );
}

// ─── Scenario model ─────────────────────────────────────────────────────────

type Op =
  | { kind: 'report'; surfaces: 1 | 2; sameSummary: boolean }
  | { kind: 'settle-kv'; mode: 'ok' | 'reject' }
  | { kind: 'tap-continue'; taps: number }
  | { kind: 'tap-backdrop'; taps: number }
  | { kind: 'back'; taps: number }
  | { kind: 'simultaneous' }
  | { kind: 'frame'; dt: number }
  | { kind: 'walkthrough'; visible: boolean }
  | { kind: 'owner'; index: number }
  | { kind: 'toggle-reduced' }
  | { kind: 'unmount' }
  | { kind: 'remount' };

interface Outcome {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  ops: number;
  reports: number;
  ceremonies: number;
  dismissTaps: number;
  sameTickBursts: number;
  failures: string[];
  trace: string[];
}

/** A rank report waiting in (or running through) the store's serialized
 * evaluation queue. `owner` is fixed when its run starts, not when it was
 * reported — exactly like `maybeCelebrate` reads `getActiveDataOwner()`. */
interface QueuedReport {
  summary: PlayerRankSummary;
  owner: string | null;
  stored: string | null;
  phase: 'get' | 'set';
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

  // requestAnimationFrame is driven by hand (same convention as the
  // RankUpCelebration button ledger) so the count-up is deterministic.
  const frames = new Map<number, (timestamp: number) => void>();
  let nextFrameId = 1;
  const rafSpy = jest
    .spyOn(globalThis, 'requestAnimationFrame')
    .mockImplementation(callback => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
  const cafSpy = jest
    .spyOn(globalThis, 'cancelAnimationFrame')
    .mockImplementation(id => {
      if (typeof id === 'number') frames.delete(id);
    });
  const announce = AccessibilityInfo.announceForAccessibility as jest.Mock;
  announce.mockClear();

  mockKv.clear();
  mockKvOps.length = 0;
  mockKvCounter = 0;
  mockReducedMotion = rng() < 0.25;
  useRankCelebrationStore.setState({ current: null, pending: null });
  useWalkthroughStore.setState({ visible: false, queued: false });
  let ownerIndex = rng() < 0.85 ? int(rng, 0, OWNERS.length - 1) : -1;
  setActiveDataOwner(
    ownerIndex < 0 ? SIGNED_OUT_DATA_OWNER : OWNERS[ownerIndex]!,
  );

  // Occasionally start with a durable record already present so the very
  // first report can be a promotion, a demotion or a no-op.
  if (rng() < 0.5) {
    for (const owner of OWNERS) {
      if (rng() < 0.7) {
        const seeded = randomSummary(rng);
        mockKv.set(
          rankCelebrationKeyForOwner(owner),
          JSON.stringify({
            version: 1,
            tier: seeded.tier,
            rating: seeded.rating,
          }),
        );
      }
    }
  }

  const queue: QueuedReport[] = [];
  let mounted = false;
  let renderer!: Renderer;
  let lastCurrent: RankCelebration | null = null;
  let ceremonies = 0;
  let expectedAnnouncements = 0;
  let dismissTaps = 0;
  let sameTickBursts = 0;
  let reports = 0;
  // Count-up model for the showing stage.
  let countStartedAt: number | null = null;
  let countDone = false;
  let frameClock = 0;

  const store = () => useRankCelebrationStore.getState();
  const currentOwner = () =>
    ownerIndex < 0 ? SIGNED_OUT_DATA_OWNER : OWNERS[ownerIndex]!;
  /** Advance the model queue to the first report that actually reaches kv:
   * a run that starts signed-out returns at once and the next run begins. */
  const startNext = () => {
    while (queue[0] && queue[0].owner === null) {
      const owner = currentOwner();
      if (owner === SIGNED_OUT_DATA_OWNER) queue.shift();
      else queue[0].owner = owner;
    }
  };

  const mount = async () => {
    await act(async () => {
      renderer = TestRenderer.create(<RankUpCelebration />);
    });
    mounted = true;
    if (store().current) {
      expectedAnnouncements += 1;
      countStartedAt = null;
      countDone = mockReducedMotion;
    }
  };
  await mount();

  /** Store transitions that happened since the last check, seen from the
   * outside: null → ceremony (opened), ceremony → null (closed). */
  const observeStore = (where: string) => {
    const current = store().current;
    if (current !== lastCurrent) {
      if (current && lastCurrent) {
        failures.push(
          `${where}: ceremony replaced without dismissal ${lastCurrent.toTier}→${current.toTier}`,
        );
      }
      if (current) {
        ceremonies += 1;
        if (mounted) {
          expectedAnnouncements += 1;
        }
        countStartedAt = null;
        countDone = mockReducedMotion;
        const fromIndex = current.fromTier
          ? PLAYER_RANK_TIERS.findIndex(t => t.key === current.fromTier)
          : -1;
        const toIndex = PLAYER_RANK_TIERS.findIndex(
          t => t.key === current.toTier,
        );
        if (toIndex <= fromIndex || current.toTier !== current.summary.tier) {
          failures.push(
            `${where}: non-upward ceremony ${String(current.fromTier)}→${current.toTier}`,
          );
        }
      }
      lastCurrent = current;
    }
  };

  const check = (where: string) => {
    observeStore(where);
    const current = store().current;
    if (!mounted) {
      if (frames.size !== 0)
        failures.push(
          `${where}: ${frames.size} frames pending while unmounted`,
        );
      return;
    }
    // The RN jest Modal mock renders its host only while visible, so the
    // host count doubles as the duplicate-modal check.
    const modalCount = modalHosts(renderer).length;
    const wantHosts = current ? 1 : 0;
    if (modalCount !== wantHosts) {
      failures.push(
        `${where}: ${modalCount} modal hosts, expected ${wantHosts}`,
      );
    }
    const modalNode = modal(renderer);
    if (!modalNode) failures.push(`${where}: no Modal`);
    if (modalNode && modalNode.props.visible !== (current !== null)) {
      failures.push(
        `${where}: modal visible=${String(modalNode.props.visible)} current=${current !== null}`,
      );
    }
    if (modalNode && modalNode.props.onRequestClose !== store().dismiss) {
      failures.push(`${where}: onRequestClose is not the store dismiss`);
    }
    const stages = hosts(renderer, 'rank-up-celebration');
    if (stages.length !== (current ? 1 : 0)) {
      failures.push(
        `${where}: ${stages.length} stage hosts, current=${current !== null}`,
      );
    }
    const targets = pressTargets(renderer);
    const labels = [
      ...new Set(
        targets.map(n => n.props.accessibilityLabel ?? n.props.testID),
      ),
    ].sort();
    const expectedLabels = current
      ? ['Continue', 'Dismiss rank celebration', 'rank-up-continue']
      : [];
    if (labels.join('|') !== expectedLabels.join('|')) {
      failures.push(
        `${where}: press targets [${labels.join(', ')}] expected [${expectedLabels.join(', ')}]`,
      );
    }
    for (const node of targets) {
      if (node.props.onPress !== store().dismiss) {
        failures.push(
          `${where}: press target ${String(node.props.accessibilityLabel ?? node.props.testID)} is not the store dismiss`,
        );
      }
      if (node.props.disabled) failures.push(`${where}: disabled press target`);
    }
    if (announce.mock.calls.length !== expectedAnnouncements) {
      failures.push(
        `${where}: announcements=${announce.mock.calls.length} expected=${expectedAnnouncements}`,
      );
    }
    if (current) {
      const emblems = emblemLabels(renderer);
      if (emblems.length !== (current.fromTier ? 2 : 1)) {
        failures.push(
          `${where}: emblems [${emblems.join(', ')}] for ${String(current.fromTier)}→${current.toTier}`,
        );
      }
      if (frames.size > 1)
        failures.push(`${where}: ${frames.size} concurrent count-up frames`);
      const json = JSON.stringify(renderer.toJSON());
      if (countDone) {
        if (!json.includes(`"${current.summary.rating.toFixed(2)}"`)) {
          failures.push(
            `${where}: count-up finished but ${current.summary.rating.toFixed(2)} not rendered`,
          );
        }
        if (frames.size !== 0)
          failures.push(
            `${where}: count-up done but ${frames.size} frame(s) pending`,
          );
      } else if (frames.size !== 1) {
        failures.push(
          `${where}: count-up running but ${frames.size} frame(s) pending`,
        );
      }
    } else if (frames.size !== 0) {
      failures.push(
        `${where}: ${frames.size} frame(s) pending with no ceremony`,
      );
    }
  };

  const pressAll = async (
    nodes: Array<TestRenderer.ReactTestInstance | undefined>,
    back: boolean,
  ) => {
    const modalNode = modal(renderer);
    await act(async () => {
      for (const node of nodes) {
        if (node) {
          dismissTaps += 1;
          node.props.onPress();
        }
      }
      if (back && modalNode) {
        dismissTaps += 1;
        modalNode.props.onRequestClose();
      }
    });
    if (store().current !== null)
      failures.push('dismiss burst left a ceremony showing');
  };

  const ops: Op[] = [];
  const opCount = int(rng, 8, 20);
  for (let i = 0; i < opCount; i += 1) {
    const roll = rng();
    if (roll < 0.2) {
      ops.push({
        kind: 'report',
        surfaces: rng() < 0.4 ? 2 : 1,
        sameSummary: rng() < 0.7,
      });
    } else if (roll < 0.42)
      ops.push({ kind: 'settle-kv', mode: rng() < 0.85 ? 'ok' : 'reject' });
    else if (roll < 0.52)
      ops.push({ kind: 'tap-continue', taps: pick(rng, [1, 2, 3]) });
    else if (roll < 0.6)
      ops.push({ kind: 'tap-backdrop', taps: pick(rng, [1, 2, 3]) });
    else if (roll < 0.66)
      ops.push({ kind: 'back', taps: pick(rng, [1, 2, 3]) });
    else if (roll < 0.72) ops.push({ kind: 'simultaneous' });
    else if (roll < 0.84)
      ops.push({
        kind: 'frame',
        dt: pick(rng, [0, 16, 200, 779, 780, 781, 1500, 1501, 3000]),
      });
    else if (roll < 0.88)
      ops.push({ kind: 'walkthrough', visible: rng() < 0.5 });
    else if (roll < 0.92)
      ops.push({ kind: 'owner', index: int(rng, -1, OWNERS.length - 1) });
    else if (roll < 0.95) ops.push({ kind: 'toggle-reduced' });
    else if (roll < 0.98) ops.push({ kind: 'unmount' });
    else ops.push({ kind: 'remount' });
  }
  ops.push({ kind: 'walkthrough', visible: false });
  ops.push({ kind: 'frame', dt: 3000 });

  const parseRecord = (raw: string | null) =>
    raw
      ? (JSON.parse(raw) as {
          version: 1;
          tier: PlayerRankTierKey;
          rating: number;
        })
      : null;

  /** Settle the single kv operation in flight (the store serializes them)
   * and check the store moved exactly as `maybeCelebrate` promises. Returns
   * false when nothing was in flight. */
  const settleKv = async (
    mode: 'ok' | 'reject',
    where: string,
  ): Promise<boolean> => {
    const pending = mockKvOps.filter(o => !o.settled);
    if (pending.length > 1) {
      failures.push(
        `${where}: ${pending.length} kv ops in flight (queue not serialized)`,
      );
    }
    const target = pending[0];
    if (!target) return false;
    const head = queue[0];
    if (!head || head.owner === null) {
      failures.push(
        `${where}: kv ${target.op} in flight with no report running`,
      );
      target.resolve();
      await flush();
      return true;
    }
    if (
      target.key !== rankCelebrationKeyForOwner(head.owner) ||
      target.op !== head.phase
    ) {
      failures.push(
        `${where}: kv ${target.op} ${target.key} but model expects ${head.phase} for ${head.owner}`,
      );
    }
    const before = { current: store().current, pending: store().pending };
    const walkthroughVisible = useWalkthroughStore.getState().visible;
    if (target.op === 'get') head.stored = mockKv.get(target.key) ?? null;
    const ownerNow = currentOwner();
    await act(async () => {
      if (mode === 'reject') target.reject(new Error('sqlite busy'));
      else target.resolve();
    });
    await flush();

    // Mirror of maybeCelebrate's decision for this report.
    let decided: 'none' | RankCelebration | null = 'none';
    const finish = (outcome: RankCelebration | null) => {
      queue.shift();
      startNext();
      return outcome;
    };
    if (mode === 'reject') {
      decided = finish(null);
    } else if (target.op === 'get') {
      const storedRecord = parseRecord(head.stored);
      const changed =
        !storedRecord ||
        storedRecord.tier !== head.summary.tier ||
        storedRecord.rating !== head.summary.rating;
      if (!changed) {
        decided = finish(evaluateRankTransition(storedRecord, head.summary));
      } else if (ownerNow !== head.owner) {
        decided = finish(null);
      } else {
        head.phase = 'set';
        const next = mockKvOps.filter(o => !o.settled)[0];
        if (!next || next.op !== 'set') {
          failures.push(
            `${where}: expected a kv set after a changed record, got ${next?.op ?? 'nothing'}`,
          );
        }
      }
    } else {
      decided = finish(
        evaluateRankTransition(parseRecord(head.stored), head.summary),
      );
    }
    if (decided !== 'none') {
      const expected: RankCelebration | null = decided;
      const shouldRaise =
        expected !== null && !before.current && !before.pending;
      const after = { current: store().current, pending: store().pending };
      if (shouldRaise && expected) {
        const slot = walkthroughVisible ? after.pending : after.current;
        if (!sameCelebration(slot, expected)) {
          failures.push(
            `${where}: upward ${String(expected.fromTier)}→${expected.toTier} did not raise (walkthrough=${walkthroughVisible}) current=${after.current?.toTier ?? 'null'} pending=${after.pending?.toTier ?? 'null'}`,
          );
        }
      } else if (
        after.current !== before.current ||
        after.pending !== before.pending
      ) {
        failures.push(
          `${where}: report changed the store without an upward transition (decided=${expected ? expected.toTier : 'null'}, before current=${before.current?.toTier ?? 'null'})`,
        );
      }
    }
    trace.push(
      `  ${where} kv ${target.op} ${mode} → current=${store().current?.toTier ?? 'null'} pending=${store().pending?.toTier ?? 'null'}`,
    );
    return true;
  };

  try {
    check('mount');
    for (const [index, op] of ops.entries()) {
      trace.push(`${index}:${JSON.stringify(op)}`);
      switch (op.kind) {
        case 'report': {
          const first = randomSummary(rng);
          const summaries =
            op.surfaces === 2
              ? [first, op.sameSummary ? first : randomSummary(rng)]
              : [first];
          if (op.surfaces === 2) sameTickBursts += 1;
          await act(async () => {
            for (const summary of summaries) {
              reports += 1;
              void store().maybeCelebrate(summary);
              queue.push({ summary, owner: null, stored: null, phase: 'get' });
            }
          });
          await flush();
          startNext();
          break;
        }
        case 'settle-kv':
          await settleKv(op.mode, `op${index}`);
          break;
        case 'tap-continue': {
          if (!mounted || !store().current) break;
          for (let t = 0; t < op.taps; t += 1) {
            await pressAll(
              [innermost(renderer, n => n.props.testID === 'rank-up-continue')],
              false,
            );
          }
          break;
        }
        case 'tap-backdrop': {
          if (!mounted || !store().current) break;
          for (let t = 0; t < op.taps; t += 1) {
            await pressAll(
              [
                innermost(
                  renderer,
                  n =>
                    n.props.accessibilityLabel === 'Dismiss rank celebration',
                ),
              ],
              false,
            );
          }
          break;
        }
        case 'back': {
          if (!mounted) break;
          for (let t = 0; t < op.taps; t += 1) await pressAll([], true);
          break;
        }
        case 'simultaneous': {
          if (!mounted || !store().current) break;
          sameTickBursts += 1;
          await pressAll(
            [
              innermost(renderer, n => n.props.testID === 'rank-up-continue'),
              innermost(
                renderer,
                n => n.props.accessibilityLabel === 'Dismiss rank celebration',
              ),
            ],
            true,
          );
          break;
        }
        case 'frame': {
          frameClock += op.dt;
          const pending = [...frames.entries()];
          frames.clear();
          const current = store().current;
          await act(async () => {
            for (const [, callback] of pending) callback(frameClock);
            jest.advanceTimersByTime(op.dt);
          });
          if (pending.length > 0 && current && mounted && !mockReducedMotion) {
            if (countStartedAt === null) countStartedAt = frameClock;
            if (
              frameClock - countStartedAt - COUNT_UP_DELAY >=
              COUNT_UP_DURATION
            )
              countDone = true;
          }
          break;
        }
        case 'walkthrough': {
          const before = { current: store().current, pending: store().pending };
          await act(async () => {
            useWalkthroughStore.setState({ visible: op.visible });
          });
          await flush();
          if (!op.visible && before.pending && !before.current) {
            if (
              store().current !== before.pending ||
              store().pending !== null
            ) {
              failures.push(
                `op${index}: pending ceremony not raised when walkthrough hid`,
              );
            }
          } else if (
            store().current !== before.current ||
            store().pending !== before.pending
          ) {
            failures.push(
              `op${index}: walkthrough toggle moved the store unexpectedly`,
            );
          }
          break;
        }
        case 'owner':
          ownerIndex = op.index;
          setActiveDataOwner(currentOwner());
          break;
        case 'toggle-reduced':
          if (!mounted) break;
          mockReducedMotion = !mockReducedMotion;
          await act(async () => {
            renderer.update(<RankUpCelebration />);
          });
          if (store().current) {
            // Reduced motion snaps the count-up to its final value; turning
            // it back off restarts the chain from the first frame.
            countDone = mockReducedMotion;
            countStartedAt = null;
          }
          break;
        case 'unmount':
          if (!mounted) break;
          await act(async () => {
            renderer.unmount();
          });
          mounted = false;
          break;
        case 'remount':
          if (mounted) break;
          announce.mockClear();
          expectedAnnouncements = 0;
          await mount();
          break;
      }
      check(`op${index}`);
    }

    // Drain: everything still evaluating must land cleanly, showing or
    // not. Two kv ops per report is the ceiling; more means a loop.
    let drained = 0;
    while (await settleKv('ok', `drain${drained}`)) {
      drained += 1;
      check(`drain${drained}`);
      if (drained > reports * 2 + 2) {
        failures.push(`kv still busy after ${drained} settlements`);
        break;
      }
    }
    await act(async () => {
      useWalkthroughStore.setState({ visible: false });
    });
    await flush();
    check('drained');
    if (queue.length !== 0) {
      failures.push(
        `${queue.length} report(s) never reached kv (queue stalled)`,
      );
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
    if (frames.size !== 0)
      failures.push(`${frames.size} frame(s) alive after unmount`);
  } catch (error) {
    failures.push(
      `threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  } finally {
    await flush();
    process.off('unhandledRejection', onRejection);
    rafSpy.mockRestore();
    cafSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    useRankCelebrationStore.setState({ current: null, pending: null });
    useWalkthroughStore.setState({ visible: false, queued: false });
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  }
  for (const message of consoleErrors)
    failures.push(`console: ${message.slice(0, 300)}`);
  for (const message of rejections)
    failures.push(`unhandledRejection: ${message.slice(0, 300)}`);

  return {
    seed,
    outcome: failures.length === 0 ? 'HELD' : 'BROKEN',
    ops: ops.length,
    reports,
    ceremonies,
    dismissTaps,
    sameTickBursts,
    failures,
    trace,
  };
}

describe('STRESS cmp-rank rapid-interaction — RankUpCelebration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const seeds = STRESS_SEED
    ? [Number(STRESS_SEED)]
    : Array.from({ length: STRESS_ITER }, (_, i) => 2000 + i);

  it(`holds every invariant across ${seeds.length} seeded interaction bursts`, async () => {
    const results: Outcome[] = [];
    for (const seed of seeds) {
      results.push(await runScenario(seed));
    }
    const broken = results.filter(r => r.outcome === 'BROKEN');
    const totals = results.reduce(
      (acc, r) => ({
        ops: acc.ops + r.ops,
        reports: acc.reports + r.reports,
        ceremonies: acc.ceremonies + r.ceremonies,
        dismissTaps: acc.dismissTaps + r.dismissTaps,
        sameTickBursts: acc.sameTickBursts + r.sameTickBursts,
      }),
      { ops: 0, reports: 0, ceremonies: 0, dismissTaps: 0, sameTickBursts: 0 },
    );
    const table = {
      unit: 'cmp-rank',
      component: 'RankUpCelebration',
      lens: 'rapid-interaction',
      iterations: results.length,
      totals,
      broken: broken.map(r => r.seed),
      results: results.map(r => ({
        seed: r.seed,
        outcome: r.outcome,
        ops: r.ops,
        reports: r.reports,
        ceremonies: r.ceremonies,
        dismissTaps: r.dismissTaps,
        sameTickBursts: r.sameTickBursts,
        failures: r.failures,
        ...(r.outcome === 'BROKEN' || STRESS_SEED ? { trace: r.trace } : {}),
      })),
    };
    if (STRESS_REPORT_DIR) {
      mkdirSync(STRESS_REPORT_DIR, { recursive: true });
      writeFileSync(
        join(STRESS_REPORT_DIR, 'rankUpCelebration.rapid-interaction.json'),
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
