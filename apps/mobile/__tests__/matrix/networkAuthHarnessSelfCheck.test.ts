/**
 * Self-check for the NETWORK × AUTH matrix harness: proves the two properties
 * the matrix's evidence rests on.
 *
 *  1. Replayability — the same (network, auth, seed) produces byte-identical
 *     scenario, request accounting and drain records on every run, and
 *     neighbouring seeds / cells do not collide.
 *  2. Sensitivity — a deliberately broken sync layer (a row removed from the
 *     outbox without the server having accepted it) is caught by the
 *     invariants with the seed and cell attached, so a green matrix means
 *     the invariants were exercised, not that they are vacuous.
 *
 * The mutation is applied through jest.mock on the sync module in THIS file
 * only; production code is untouched.
 */
import type { LocalDb } from '../../src/data/db';
import type { drainOutbox as DrainOutbox } from '../../src/data/sync';
import {
  buildScenario,
  combinationSeed,
  runCombination,
} from '../../test-support/matrix/networkAuthHarness';

const mockState = { dropOneRowAfterDrain: false };

jest.mock('../../src/data/sync', () => {
  const actual = jest.requireActual<typeof import('../../src/data/sync')>(
    '../../src/data/sync',
  );
  const { getActiveDataOwner } = jest.requireActual<
    typeof import('../../src/data/accountScope')
  >('../../src/data/accountScope');
  const drainOutbox: typeof DrainOutbox = async (db: LocalDb, transport) => {
    const result = await actual.drainOutbox(db, transport);
    if (mockState.dropOneRowAfterDrain) {
      const owner = getActiveDataOwner();
      const pending = await db.execute(
        'SELECT id, kind, payload FROM outbox WHERE owner_key = ? AND attempts < ? ORDER BY id LIMIT 50',
        [owner, actual.OUTBOX_MAX_ATTEMPTS],
      );
      const first = pending.rows[0] as { id: number } | undefined;
      if (first) {
        await db.execute('DELETE FROM outbox WHERE owner_key = ? AND id = ?', [
          owner,
          first.id,
        ]);
        mockState.dropOneRowAfterDrain = false;
      }
    }
    return result;
  };
  return { ...actual, drainOutbox };
});

describe('NETWORK × AUTH harness self-check', () => {
  it('replays a combination byte-for-byte and keeps cells and seeds apart', async () => {
    const a = await runCombination('slow', 'refreshing', 7);
    const b = await runCombination('slow', 'refreshing', 7);
    expect(a.ok).toBe(true);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));

    const seeds = new Set<number>();
    for (const network of ['normal', 'slow', 'timeout'] as const) {
      for (const auth of ['valid', 'expired', 'refreshing'] as const) {
        for (let seed = 0; seed < 200; seed++) {
          seeds.add(combinationSeed(network, auth, seed));
        }
      }
    }
    expect(seeds.size).toBe(9 * 200);
    expect(buildScenario('slow', 'refreshing', 7)).not.toEqual(
      buildScenario('slow', 'refreshing', 8),
    );
    expect(buildScenario('slow', 'refreshing', 7)).not.toEqual(
      buildScenario('timeout', 'refreshing', 7),
    );
  });

  it('flags a silently dropped outbox row with its seed and cell', async () => {
    // timeout×valid seed 1 has a phase-1 drain whose rows all time out, so a
    // row is still pending when the mutation runs and the server has not
    // accepted it.
    mockState.dropOneRowAfterDrain = true;
    const result = await runCombination('timeout', 'valid', 1);
    mockState.dropOneRowAfterDrain = false;
    expect(result.ok).toBe(false);
    expect(result.failures.map(f => f.invariant)).toContain('I2.no-loss');
    expect(result.replay).toBe(
      'MATRIX_ONLY=timeout:valid:1 npx jest --ci __tests__/matrix/networkAuthMatrix.test.ts',
    );
    expect(result.seed).toBe(1);
    expect(result.network).toBe('timeout');
    expect(result.auth).toBe('valid');
  });
});
