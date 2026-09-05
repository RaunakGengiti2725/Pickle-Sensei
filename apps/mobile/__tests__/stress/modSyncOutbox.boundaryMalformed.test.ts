/**
 * STRESS — mod-sync-outbox / lens `boundary-malformed`
 *
 * Seeded boundary/malformed-input campaign against `drainOutbox`
 * (src/data/sync.ts) on a real in-memory SQLite outbox. Seven families
 * (see __harness__/stress/modSyncOutbox/campaign.ts for the invariant list):
 *
 *   shot-payload        corrupt/truncated/wrong-typed/proto-key/64KB+/NUL/
 *                       traversal/NFC-NFD/future-schema shot rows next to a
 *                       valid control row; poison rows must expire
 *   response-shape      malformed server bodies (null, scalars, string
 *                       acceptedIds, mutated ids, proto keys, 64KB codes)
 *   transport-throw     every rejection class thrown by the transport
 *                       (ApiError 4xx/401/408/429/5xx/odd statuses, non-Error
 *                       values, unstringifiable objects)
 *   session-trial-rows  malformed session.create / finalize / trial / unknown
 *                       kinds; poison rows must expire
 *   mixed-batch         1–70 mixed rows incl. foreign owners, exhausted and
 *                       odd attempts; LIMIT 50 window and isolation
 *   db-fault-rollback   SQLITE_FULL/IOERR/BUSY on BEGIN/INSERT/DELETE/COMMIT
 *                       inside the receipt transaction; atomicity + recovery
 *   concurrent-drains   two interleaved drains on one connection, optional
 *                       owner switch mid-drain; no loss, no open txn
 *
 * Knobs: STRESS_ITER=<n per family> (default 12 → 84 iterations, fast enough
 * for the normal suite; the campaign run uses 500 → 3500), STRESS_SEED=<base>,
 * STRESS_ONLY=<family,…>, STRESS_REPLAY=<family>:<seed> (one iteration),
 * STRESS_OUT=<dir>, STRESS_RUN_ID=<id>. Results (seed → outcome) are written to
 * artifacts/stress/mod-sync-outbox/boundary-malformed/<run>/*.results.json.
 *
 * Requires node:sqlite (Node >= 22.13, or --experimental-sqlite).
 */
import {
  configFromEnv,
  describeBroken,
  FAMILIES,
  runFamily,
  writeArtifacts,
  type IterationResult,
} from '../../__harness__/stress/modSyncOutbox/campaign';

jest.setTimeout(20 * 60 * 1000);

const config = configFromEnv();
const all: IterationResult[] = [];

describe('mod-sync-outbox boundary-malformed campaign', () => {
  afterAll(() => {
    const { table, summary } = writeArtifacts(
      'boundary-malformed',
      all,
      config,
    );
    const held = all.filter(r => r.outcome === 'HELD').length;
    console.log(
      `[stress:mod-sync-outbox] executed=${all.length} held=${held} broken=${all.length - held} seed=${config.baseSeed} iter/family=${config.iterationsPerFamily}\n  table=${table}\n  summary=${summary}`,
    );
  });

  const selected = FAMILIES.filter(
    family =>
      config.families.includes(family) &&
      (!config.replay || config.replay.family === family),
  );
  if (selected.length === 0) {
    throw new Error('STRESS_ONLY / STRESS_REPLAY selected no family');
  }

  for (const family of selected) {
    it(`${family}: every seeded iteration holds the graceful-rejection invariants`, async () => {
      const results = await runFamily(family, config);
      all.push(...results);
      expect(results.length).toBeGreaterThan(0);
      const broken = results.filter(r => r.outcome === 'BROKEN');
      // Each line carries the STRESS_REPLAY=<family>:<seed> that reproduces it.
      if (broken.length > 0) throw new Error(describeBroken(results));
      expect(broken).toHaveLength(0);
    });
  }
});
