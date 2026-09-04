/**
 * Seeded NETWORK × AUTH scenario matrix, cell 1:
 *   {normal, slow, timeout} × {valid, expired, refreshing}
 * against api.ts + sync.ts + sessionKeeper.ts over a mocked, abort-aware
 * transport. See test-support/matrix/networkAuthHarness.ts for the model and the invariants.
 *
 * Scale:   MATRIX_SEEDS=<n>   seeds per cell (default 20 → 180 combinations)
 * Replay:  MATRIX_ONLY=<network>:<auth>:<seed>
 * Output:  MATRIX_OUT=<dir>   raw JSON results (default artifacts/matrix)
 *
 * Every failing combination is reported with its seed, its cell, the
 * generated scenario and the exact replay command.
 */
import {
  AUTH_CELLS,
  NETWORK_CELLS,
  runCombination,
  type AuthCell,
  type CombinationResult,
  type NetworkCell,
} from '../../test-support/matrix/networkAuthHarness';

// Node built-ins for the raw artifacts. The mobile tsconfig excludes node
// typings (see be-mobile-sync-outbox.test.ts), so the shims stay local.
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number; rss: number; external: number };
};
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const SEEDS_PER_CELL = Number(process.env.MATRIX_SEEDS ?? 20);
const ONLY = process.env.MATRIX_ONLY ?? null;
const OUT_DIR =
  process.env.MATRIX_OUT ?? join(__dirname, '..', '..', 'artifacts', 'matrix');

interface Combination {
  network: NetworkCell;
  auth: AuthCell;
  seed: number;
}

function combinations(): Combination[] {
  if (ONLY) {
    const [network, auth, seed] = ONLY.split(':');
    if (
      !NETWORK_CELLS.includes(network as NetworkCell) ||
      !AUTH_CELLS.includes(auth as AuthCell) ||
      !Number.isInteger(Number(seed))
    ) {
      throw new Error(
        `MATRIX_ONLY must be <network>:<auth>:<seed>, got ${ONLY}`,
      );
    }
    return [
      {
        network: network as NetworkCell,
        auth: auth as AuthCell,
        seed: Number(seed),
      },
    ];
  }
  const list: Combination[] = [];
  for (const network of NETWORK_CELLS) {
    for (const auth of AUTH_CELLS) {
      for (let seed = 1; seed <= SEEDS_PER_CELL; seed++) {
        list.push({ network, auth, seed });
      }
    }
  }
  return list;
}

const results: CombinationResult[] = [];
const heap: Array<{ index: number; heapUsedMb: number; rssMb: number }> = [];
const wallStart = Date.now();

afterAll(() => {
  const failed = results.filter(r => !r.ok);
  const byCell: Record<string, { executed: number; failed: number }> = {};
  const byInvariant: Record<string, number> = {};
  for (const r of results) {
    const key = `${r.network}×${r.auth}`;
    byCell[key] ??= { executed: 0, failed: 0 };
    byCell[key].executed += 1;
    if (!r.ok) byCell[key].failed += 1;
    for (const f of r.failures)
      byInvariant[f.invariant] = (byInvariant[f.invariant] ?? 0) + 1;
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    seedsPerCell: SEEDS_PER_CELL,
    only: ONLY,
    executed: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    wallMs: Date.now() - wallStart,
    byCell,
    byInvariant,
    aggregate: {
      requests: results.reduce((n, r) => n + r.stats.requests, 0),
      apiRequests: results.reduce((n, r) => n + r.stats.apiRequests, 0),
      refreshRequests: results.reduce((n, r) => n + r.stats.refreshRequests, 0),
      aborted: results.reduce((n, r) => n + r.stats.aborted, 0),
      lostRequests: results.reduce((n, r) => n + r.stats.lostRequests, 0),
      lostResponses: results.reduce((n, r) => n + r.stats.lostResponses, 0),
      unauthorized: results.reduce((n, r) => n + r.stats.unauthorized, 0),
      rotations: results.reduce((n, r) => n + r.stats.rotations, 0),
      refreshReuseServed: results.reduce(
        (n, r) => n + r.stats.refreshReuseServed,
        0,
      ),
      refreshRefusals: results.reduce((n, r) => n + r.stats.refreshRefusals, 0),
      maxRefreshInflight: Math.max(
        0,
        ...results.map(r => r.stats.maxRefreshInflight),
      ),
      revoked: results.reduce((n, r) => n + r.stats.revoked, 0),
      receipts: results.reduce((n, r) => n + r.stats.receipts, 0),
      rows: results.reduce((n, r) => n + r.scenario.rowCount, 0),
    },
    heap: {
      samples: heap.length,
      maxHeapUsedMb: Math.max(0, ...heap.map(h => h.heapUsedMb)),
      maxRssMb: Math.max(0, ...heap.map(h => h.rssMb)),
      first: heap[0] ?? null,
      last: heap[heap.length - 1] ?? null,
    },
    failures: failed.map(r => ({
      network: r.network,
      auth: r.auth,
      seed: r.seed,
      combinationSeed: r.combinationSeed,
      replay: r.replay,
      failures: r.failures,
      scenario: r.scenario,
    })),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const suffix = ONLY ? `-${ONLY.replace(/:/g, '_')}` : '';
  writeFileSync(
    join(OUT_DIR, `network-auth-summary${suffix}.json`),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, `network-auth-results${suffix}.json`),
    JSON.stringify(results, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, `network-auth-heap${suffix}.json`),
    JSON.stringify(heap, null, 2),
  );
});

describe('NETWORK × AUTH matrix (cell 1)', () => {
  const combos = combinations();

  it.each(combos.map(c => [c.network, c.auth, c.seed] as const))(
    '%s × %s seed=%i',
    async (network, auth, seed) => {
      const result = await runCombination(network, auth, seed);
      results.push(result);
      const mem = process.memoryUsage();
      heap.push({
        index: results.length,
        heapUsedMb: Math.round((mem.heapUsed / 1_048_576) * 10) / 10,
        rssMb: Math.round((mem.rss / 1_048_576) * 10) / 10,
      });
      if (!result.ok) {
        throw new Error(
          [
            `MATRIX FAILURE network=${network} auth=${auth} seed=${seed} (combinationSeed=${result.combinationSeed})`,
            `replay: ${result.replay}`,
            ...result.failures.map(f => `  [${f.invariant}] ${f.detail}`),
            `scenario: ${JSON.stringify(result.scenario)}`,
          ].join('\n'),
        );
      }
    },
  );

  it('executed the required scale', () => {
    const expected = ONLY
      ? 1
      : NETWORK_CELLS.length * AUTH_CELLS.length * SEEDS_PER_CELL;
    expect(results.length).toBe(expected);
    if (!ONLY) expect(results.length).toBeGreaterThanOrEqual(150);
  });
});
