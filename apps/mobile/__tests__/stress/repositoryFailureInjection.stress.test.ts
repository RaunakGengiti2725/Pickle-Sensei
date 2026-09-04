/**
 * STRESS · mod-repository · lens `failure-injection`
 *
 * Injects driver faults (throw / reject / reject-after-apply / slow / never /
 * owner-swap / delete-during / close-during) into every statement position of
 * every `src/data/repository.ts` operation, against REAL SQLite behind the
 * production `getDb()` (see stress-harness/repository/README in campaign.ts).
 *
 *   single-factor catalog   every op × every fault kind × every statement
 *                           index (deterministic; ≥ 60 injected faults)
 *   seeded campaign         STRESS_ITER random (op, world, fault) tuples
 *                           (default 200; every row replayable by seed)
 *   timers                  slow (resolves on time) and never (60 s of fake
 *                           time) faults
 *
 * Replay:  STRESS_ONLY_SEED=<seed> npx jest --ci --silent repositoryFailureInjection
 * Scale:   STRESS_ITER=5000 npx jest --ci --silent repositoryFailureInjection
 * Rows:    artifacts/stress-mod-repository/*.rows.json  (STRESS_ARTIFACT_DIR)
 */
import { opSqliteShim as mockOpSqlite } from '../../stress-harness/repository/realSqlite';
import { getDb } from '../../src/data/db';
import { describeUnderSqlite } from '../../stress-harness/repository/reexec';
import {
  campaignConfig,
  partitionFailures,
  seedsFor,
  writeCampaign,
  type KnownBroken,
} from '../../stress-harness/repository/artifacts';
import {
  OPERATIONS,
  runClean,
  runIteration,
  seededFault,
  type FaultSpec,
  type Harness,
} from '../../stress-harness/repository/campaign';
import {
  FAULT_KINDS,
  type FaultKind,
} from '../../stress-harness/repository/faultyDb';
import { PAYLOAD_CORRUPTIONS } from '../../stress-harness/repository/fixtures';
import type { MatrixRow } from '../../xc-harness/lifecycle-persistence/artifacts';

declare const __filename: string;

/** Ids carried INSIDE the planted wrong-shape payloads (never a real row id). */
const CORRUPT_PAYLOAD_IDS = new Set<unknown>(
  Object.values(PAYLOAD_CORRUPTIONS).flatMap(raw => {
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' && 'id' in parsed
        ? [(parsed as { id: unknown }).id]
        : [];
    } catch {
      return [];
    }
  }),
);

jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockOpSqlite.open(options.name),
}));

const SCALE = { maxShots: 24 };
const harness: Harness = { getDb };

/** Documented findings (see the session report). Rows matching these are
 * recorded BROKEN in the artifact but do not fail the campaign; each is
 * pinned separately with `it.failing` in the finding suites. */
const KNOWN_BROKEN: KnownBroken[] = [
  {
    // F-1: reads under a planted corrupt outbox row — json_extract raises
    // for EVERY shot id of that owner (getShotOutboxStatus).
    id: 'F1-getShotOutboxStatus-json_extract',
    matches: row =>
      (row.inputs as { operation: string }).operation ===
        'getShotOutboxStatus' &&
      /malformed JSON/.test(
        String((row.observed as { error: unknown }).error ?? ''),
      ),
  },
  {
    // F-2: a second writer whose statements land inside another operation's
    // open transaction (single shared connection): the DELETE runs between
    // the shot INSERT and the outbox INSERT and commits with them, leaving
    // an outbox row for a shot that no longer exists.
    id: 'F2-interleaved-writer-inside-transaction',
    matches: row =>
      row.failed.every(name => name === 'noTornWrite') &&
      (row.inputs as { fault: { kind: string } }).fault.kind ===
        'delete-during' &&
      (row.observed as { torn: string[] }).torn.every(t =>
        /has no local_shot|has no local_session/.test(t),
      ),
  },
  {
    // F-3: payload shape is not validated after JSON.parse — a valid-JSON
    // payload of the wrong shape becomes a fact with undefined fields (and an
    // undefined id, which the ownerScoped check then flags as foreign).
    id: 'F3-payload-shape-unchecked',
    matches: row =>
      row.failed.every(
        name => name === 'noFabrication' || name === 'ownerScoped',
      ) &&
      ((row.observed as { foreignIds?: unknown[] }).foreignIds ?? []).every(
        id => id == null || CORRUPT_PAYLOAD_IDS.has(id),
      ) &&
      (
        row.inputs as { world: { corruptions: string[] } }
      ).world.corruptions.some(c =>
        /shape-drift|json-number|json-true|json-string|json-array|empty-object|nested-garbage/.test(
          c,
        ),
      ),
  },
];

function catalogSeed(
  opIndex: number,
  kind: FaultKind,
  at: number,
  rollback: boolean,
): number {
  return (
    0x7000_0000 +
    opIndex * 4096 +
    FAULT_KINDS.indexOf(kind) * 256 +
    at * 2 +
    (rollback ? 1 : 0)
  );
}

describeUnderSqlite(
  __filename,
  'repository failure injection (real SQLite)',
  () => {
    const allRows: MatrixRow[] = [];

    afterAll(() => {
      writeCampaign('failure-injection', allRows, {
        operations: OPERATIONS.map(op => op.name),
        faultKinds: FAULT_KINDS,
        knownBroken: KNOWN_BROKEN.map(k => k.id),
      });
    });

    it(
      'single-factor catalog: every operation × fault kind × statement index (≥60 injected faults)',
      async () => {
        const rows: MatrixRow[] = [];
        let injected = 0;
        const kinds = FAULT_KINDS.filter(k => k !== 'slow' && k !== 'never');
        for (const [opIndex, op] of OPERATIONS.entries()) {
          const probe = await runClean(
            harness,
            catalogSeed(opIndex, 'reject', 0, false),
            op,
            SCALE,
          );
          const positions = probe.clean.statements;
          for (const kind of kinds) {
            for (let at = 0; at <= positions; at++) {
              const variants =
                op.transactional &&
                at < positions &&
                (kind === 'reject' || kind === 'throw-sync')
                  ? [false, true]
                  : [false];
              for (const rollback of variants) {
                const seed = catalogSeed(opIndex, kind, at, rollback);
                const spec: FaultSpec = {
                  kind,
                  atStatement: at,
                  code: 'SQLITE_IOERR',
                  delayMs: 0,
                  rollbackAlsoFails: rollback,
                  swapTo: kind === 'owner-swap' ? 'signed-out' : undefined,
                };
                const row = await runIteration(harness, seed, {
                  scale: SCALE,
                  operation: op,
                  faultFor: () => spec,
                });
                if ((row.observed as { fired: boolean }).fired) injected += 1;
                rows.push(row);
              }
            }
          }
        }
        allRows.push(...rows);
        const { unexpected, knownById } = partitionFailures(rows, KNOWN_BROKEN);
        const digest = {
          rows: rows.length,
          injected,
          knownById,
          unexpected: unexpected.map(r => ({
            seed: r.seed,
            scenario: r.scenario,
            failed: r.failed,
            observed: r.observed,
          })),
        };
        expect(injected).toBeGreaterThanOrEqual(60);
        expect(digest).toEqual({ ...digest, unexpected: [] });
      },
      10 * 60_000,
    );

    it(
      'seeded campaign: random (operation, world, fault) tuples — every row replayable by seed',
      async () => {
        const config = campaignConfig(200);
        const rows: MatrixRow[] = [];
        for (const seed of seedsFor(config)) {
          rows.push(
            await runIteration(harness, seed, {
              scale: SCALE,
              faultFor: (rng, clean) => seededFault(rng, clean.statements),
            }),
          );
        }
        allRows.push(...rows);
        const { unexpected, knownById } = partitionFailures(rows, KNOWN_BROKEN);
        const digest = {
          rows: rows.length,
          knownById,
          unexpected: unexpected.map(r => ({
            seed: r.seed,
            scenario: r.scenario,
            failed: r.failed,
            observed: r.observed,
          })),
        };
        expect(rows.length).toBe(
          config.onlySeed === null ? config.iterations : 1,
        );
        expect(digest).toEqual({ ...digest, unexpected: [] });
      },
      20 * 60_000,
    );

    describe('timer faults (fake timers)', () => {
      beforeEach(() => {
        jest.useFakeTimers({
          doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
        });
      });
      afterEach(() => {
        jest.useRealTimers();
      });
      const timed: Harness = {
        getDb,
        advance: ms => jest.advanceTimersByTimeAsync(ms),
      };

      it(
        'slow statements (5 s … 59 s) resolve with the clean result and state',
        async () => {
          const rows: MatrixRow[] = [];
          for (const [opIndex, op] of OPERATIONS.entries()) {
            if (op.kind === 'validation') continue;
            for (const delayMs of [5_000, 59_000]) {
              const seed = catalogSeed(
                opIndex,
                'slow',
                delayMs === 5_000 ? 0 : 1,
                false,
              );
              rows.push(
                await runIteration(timed, seed, {
                  scale: SCALE,
                  operation: op,
                  faultFor: (rng, clean) => ({
                    kind: 'slow',
                    atStatement: Math.floor(
                      rng() * Math.max(1, clean.statements),
                    ),
                    code: 'SQLITE_BUSY',
                    delayMs,
                    rollbackAlsoFails: false,
                  }),
                }),
              );
            }
          }
          allRows.push(...rows);
          const { unexpected } = partitionFailures(rows, KNOWN_BROKEN);
          expect(
            unexpected.map(r => ({
              seed: r.seed,
              scenario: r.scenario,
              failed: r.failed,
            })),
          ).toEqual([]);
        },
        5 * 60_000,
      );

      it(
        'never-settling statements: 60 s of fake time, state stays pre, other owner untouched (hang recorded)',
        async () => {
          const rows: MatrixRow[] = [];
          for (const [opIndex, op] of OPERATIONS.entries()) {
            if (op.kind === 'validation') continue;
            const seed = catalogSeed(opIndex, 'never', 0, false);
            rows.push(
              await runIteration(timed, seed, {
                scale: SCALE,
                operation: op,
                faultFor: () => ({
                  kind: 'never',
                  atStatement: 0,
                  code: 'SQLITE_BUSY',
                  delayMs: 0,
                  rollbackAlsoFails: false,
                }),
              }),
            );
          }
          allRows.push(...rows);
          const hung = rows.filter(
            r => (r.observed as { hungAfter60s: boolean }).hungAfter60s,
          );
          // Observation for the report: the repository has no time bound of its
          // own, so a driver that never answers leaves every caller pending.
          expect(hung.length).toBe(rows.length);
          const { unexpected } = partitionFailures(rows, KNOWN_BROKEN);
          expect(
            unexpected.map(r => ({
              seed: r.seed,
              scenario: r.scenario,
              failed: r.failed,
            })),
          ).toEqual([]);
        },
        5 * 60_000,
      );
    });
  },
);
