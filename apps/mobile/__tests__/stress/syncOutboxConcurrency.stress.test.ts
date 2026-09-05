/**
 * STRESS — `mod-sync-outbox`, lens `concurrency`.
 *
 * Drives the production `drainOutbox` (src/data/sync.ts) with seeded bursts
 * of concurrent drains, owner flips (sign-out / sign-in mid-request, bearer
 * revocation), concurrent `saveAnalysis` writers, poison rows, duplicate
 * rows, rows at the attempt budget, skewed `created_at`, and a fake server
 * that draws 2xx / partial / 4xx / 5xx / 429 / network / timeout / malformed
 * responses per request — all on a REAL SQLite database (node:sqlite behind
 * the op-sqlite seam, see stress-harness/syncOutbox/sqliteSeam.ts).
 *
 * Every iteration is a pure function of its seed. Replay one:
 *   STRESS_SEED_ONLY=<seed> npx jest --ci __tests__/stress/syncOutboxConcurrency
 * Full campaign (the one reported in the stress report):
 *   STRESS_ITER=600 npx jest --ci __tests__/stress/syncOutboxConcurrency
 *
 * Invariants asserted per seed (see scenario.ts `check(...)` calls):
 *   boundedWallTime, noOpenTransaction(AtEnd), ownerIsolation,
 *   poisonNeverSent, poisonNeverDeleted, poisonBurnsBudget,
 *   exhaustedNeverSent, exhaustedUntouched, deletedShotHasReceipt,
 *   deletedShotServerAccepted, deletedSessionServerAccepted,
 *   deletedTrialServerAccepted, attemptsNeverOvercounted,
 *   transientNeverBurnsBudget, attemptsExactWithoutTxAbort,
 *   survivingShotHasNoReceipt, receiptOnlyForServerAccepted,
 *   noForeignReceipt, noDoubleSpend, writerNoLostUpdate, writerNeverFails,
 *   drainNeverRejects, noPhantomRows, converges,
 *   poisonStaysWithBoundedAttempts, everyDrainedShotHasReceipt,
 *   everyDrainedShotOnServer, integrityOk.
 *
 * The seed → outcome table is written to
 * <repo>/artifacts/stress/sync-outbox-concurrency/ (gitignored).
 */
import {
  campaignSeeds,
  summarize,
  tableRow,
  writeJsonArtifact,
} from '../../stress-harness/syncOutbox/artifacts';
import {
  runScenario,
  type ScenarioResult,
} from '../../stress-harness/syncOutbox/scenario';

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () =>
    jest
      .requireActual<
        typeof import('../../stress-harness/syncOutbox/sqliteSeam')
      >('../../stress-harness/syncOutbox/sqliteSeam')
      .seam.open(),
}));

const SEEDS = campaignSeeds();
const CHUNK = 50;
const chunks: number[][] = [];
for (let i = 0; i < SEEDS.length; i += CHUNK) {
  chunks.push(SEEDS.slice(i, i + CHUNK));
}

const results: ScenarioResult[] = [];
const campaignStarted = Date.now();

describe('outbox drain — seeded concurrency campaign (real SQLite)', () => {
  afterAll(() => {
    const summary = summarize(
      'sync-outbox-concurrency',
      results,
      Date.now() - campaignStarted,
    );
    writeJsonArtifact(
      'sync-outbox-concurrency.rows.json',
      results.map(tableRow),
    );
    writeJsonArtifact('sync-outbox-concurrency.summary.json', summary);
    const failures = results.filter(r => !r.ok);
    if (failures.length > 0) {
      writeJsonArtifact('sync-outbox-concurrency.failures.json', failures);
    }
    const knownDefects = results.filter(r => r.ok && r.knownDefects.length > 0);
    if (knownDefects.length > 0) {
      writeJsonArtifact(
        'sync-outbox-concurrency.known-defects.json',
        knownDefects,
      );
    }
  });

  for (const [index, chunk] of chunks.entries()) {
    it(`seeds ${chunk[0]}..${chunk[chunk.length - 1]} hold every invariant (chunk ${index + 1}/${chunks.length})`, async () => {
      const failed: string[] = [];
      for (const seed of chunk) {
        const result = await runScenario(seed);
        results.push(result);
        if (!result.ok) {
          failed.push(
            `seed ${seed}: ${result.failed.join(', ')} — ${result.detail?.violations.slice(0, 3).join(' | ')}`,
          );
        }
      }
      expect(failed).toEqual([]);
    }, 240_000);
  }
});
