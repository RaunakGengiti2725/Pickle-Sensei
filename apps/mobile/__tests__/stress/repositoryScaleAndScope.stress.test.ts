/**
 * STRESS · mod-repository · lens `failure-injection` — scale & account scope
 *
 * Real SQLite behind the production `getDb()`, 10 000+ rows per owner:
 *   · logical duplicates (same shot id re-saved), deletes racing reads,
 *   · owner isolation (canonical A / canonical B / guest / signed-out),
 *   · planted malformed persisted rows, and
 *   · two repository operations interleaving on the ONE shared connection.
 *
 * Every campaign row is replayable: STRESS_ONLY_SEED=<seed>, STRESS_ITER=<n>.
 * Rows: artifacts/stress-mod-repository/scale-scope.rows.json
 */
import { opSqliteShim as mockOpSqlite } from '../../stress-harness/repository/realSqlite';
import { getDb } from '../../src/data/db';
import * as repo from '../../src/data/repository';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { describeUnderSqlite } from '../../stress-harness/repository/reexec';
import {
  campaignConfig,
  partitionFailures,
  seedsFor,
  writeCampaign,
  writeStressJson,
} from '../../stress-harness/repository/artifacts';
import {
  FaultyLocalDb,
  type Fault,
} from '../../stress-harness/repository/faultyDb';
import {
  OWNER_A,
  OWNER_B,
  OWNER_GUEST,
  int,
  makeAnalysis,
  makeClip,
  makePermitId,
  makeSession,
  plantCorruptOutbox,
  plantCorruptShot,
  seedShots,
  uuid,
  type SeededShot,
} from '../../stress-harness/repository/fixtures';
import {
  OWNER_TABLES,
  countRows,
  inAutocommit,
  openMigratedDb,
  snapshotOwner,
  sameSnapshot,
  tornWrites,
  type RealDbHandle,
} from '../../stress-harness/repository/realSqlite';
import type { MatrixRow } from '../../xc-harness/lifecycle-persistence/artifacts';
import { makePrng, pick } from '../../xc-harness/lifecycle-persistence/seeds';

declare const __filename: string;

jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockOpSqlite.open(options.name),
}));

const ROWS_A = 10_000;
const ROWS_B = 2_000;
const ROWS_GUEST = 500;
const DUPLICATE_EVERY = 7;

interface BigWorld {
  handle: RealDbHandle;
  shotsA: SeededShot[];
  shotsB: SeededShot[];
  shotsGuest: SeededShot[];
  idsA: Set<string>;
  idsB: Set<string>;
  idsGuest: Set<string>;
  seedMs: number;
}

function distinctIds(shots: SeededShot[]): Set<string> {
  return new Set(shots.map(s => s.analysis.id));
}

function buildBigWorld(seed: number): BigWorld {
  const rng = makePrng(seed);
  const handle = openMigratedDb(getDb);
  const started = Date.now();
  const shotsA = seedShots(handle.raw, OWNER_A, ROWS_A, rng, {
    duplicateEvery: DUPLICATE_EVERY,
  });
  const shotsB = seedShots(handle.raw, OWNER_B, ROWS_B, rng);
  const shotsGuest = seedShots(handle.raw, OWNER_GUEST, ROWS_GUEST, rng, {
    duplicateEvery: 11,
  });
  return {
    handle,
    shotsA,
    shotsB,
    shotsGuest,
    idsA: distinctIds(shotsA),
    idsB: distinctIds(shotsB),
    idsGuest: distinctIds(shotsGuest),
    seedMs: Date.now() - started,
  };
}

function isSortedDesc(values: string[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if ((values[i - 1] as string) < (values[i] as string)) return false;
  }
  return true;
}

function row(
  scenario: string,
  seed: number,
  inputs: Record<string, unknown>,
  invariants: Record<string, boolean>,
  observed: Record<string, unknown>,
): MatrixRow {
  const failed = Object.entries(invariants)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return {
    suite: 'scale-scope',
    scenario,
    seed,
    inputs,
    invariants,
    observed,
    failed,
    ok: failed.length === 0,
    durationMs: 0,
  };
}

describeUnderSqlite(
  __filename,
  'repository scale & account scope (real SQLite, 10k rows)',
  () => {
    const allRows: MatrixRow[] = [];
    const timings: Record<string, number> = {};

    afterAll(() => {
      writeCampaign('scale-scope', allRows, {
        rowsPerOwner: { A: ROWS_A, B: ROWS_B, guest: ROWS_GUEST },
        duplicateEvery: DUPLICATE_EVERY,
      });
      writeStressJson('scale-scope.timings.json', timings);
    });

    afterEach(() => {
      setActiveDataOwner(OWNER_A);
    });

    it(
      '10k rows: every read is owner-scoped, duplicate-free, ordered, and honest at scale',
      async () => {
        const seed = 0x10_000;
        const world = buildBigWorld(seed);
        timings['seed10k+2k+500ms'] = world.seedMs;
        const { db, raw } = world.handle;
        const invariants: Record<string, boolean> = {};
        const observed: Record<string, unknown> = {};
        try {
          // Duplicates collapsed by the (owner_key, id) primary key.
          const persistedA = countRows(raw, 'local_shot', OWNER_A);
          invariants['duplicatesCollapsed'] =
            persistedA === world.idsA.size &&
            world.shotsA.length === ROWS_A &&
            persistedA < ROWS_A;
          observed['persistedA'] = persistedA;
          observed['logicalDuplicatesA'] = ROWS_A - persistedA;

          setActiveDataOwner(OWNER_A);
          let t = Date.now();
          const all = await repo.listShots(db, 100_000);
          timings['listShots(A,100k)ms'] = Date.now() - t;
          invariants['listShotsCount'] = all.length === persistedA;
          invariants['listShotsOwnerScoped'] = all.every(s =>
            world.idsA.has(s.id),
          );
          invariants['listShotsNoDupIds'] =
            new Set(all.map(s => s.id)).size === all.length;
          invariants['listShotsOrdered'] = isSortedDesc(
            all.map(s => s.capturedAt),
          );
          invariants['listShotsLimitHonored'] =
            (await repo.listShots(db, 50)).length === 50;

          t = Date.now();
          const activity = await repo.listActivityShots(db);
          timings['listActivityShots(A)ms'] = Date.now() - t;
          invariants['activityCount'] = activity.length === persistedA;
          invariants['activityOwnerScoped'] = activity.every(s =>
            world.idsA.has(s.id),
          );

          t = Date.now();
          const facts = await repo.listRealAnalysisFacts(db, null);
          timings['listRealAnalysisFacts(A,null)ms'] = Date.now() - t;
          invariants['factsCount'] = facts.length === persistedA;
          invariants['factsOwnerScoped'] = facts.every(f =>
            world.idsA.has(f.id),
          );
          invariants['factsFinite'] = facts.every(
            f =>
              Number.isFinite(f.confidence) &&
              (f.overallScore === null || Number.isFinite(f.overallScore)) &&
              Object.values(f.checkpointScores).every(Number.isFinite),
          );
          invariants['factsNoScoreOnAbstention'] = facts.every(
            f => f.resultKind !== 'low_confidence' || f.overallScore === null,
          );

          t = Date.now();
          const checkpoints = await repo.listScoredCheckpointFacts(db, 100_000);
          timings['listScoredCheckpointFacts(A,null)ms'] = Date.now() - t;
          const scoredA = raw
            .prepare(
              `SELECT count(*) AS n FROM local_shot WHERE owner_key = ? AND source = 'real' AND result_kind = 'scored'`,
            )
            .get(OWNER_A) as { n: number | bigint };
          invariants['checkpointFactsCount'] =
            checkpoints.length === Number(scoredA.n);
          invariants['checkpointFactsOwnerScoped'] = checkpoints.every(f =>
            world.idsA.has(f.id),
          );

          const recent = await repo.recentScores(db, null, 30);
          invariants['recentScoresBounded'] =
            recent.length <= 30 && recent.every(Number.isFinite);

          // Other owners see only their own rows.
          setActiveDataOwner(OWNER_B);
          const b = await repo.listShots(db, 100_000);
          invariants['ownerBIsolated'] =
            b.length === world.idsB.size && b.every(s => world.idsB.has(s.id));
          setActiveDataOwner(OWNER_GUEST);
          const g = await repo.listShots(db, 100_000);
          invariants['guestIsolated'] =
            g.length === world.idsGuest.size &&
            g.every(s => world.idsGuest.has(s.id));
          setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
          const so = await repo.listShots(db, 100_000);
          const soFacts = await repo.listRealAnalysisFacts(db, null);
          invariants['signedOutReadsEmpty'] =
            so.length === 0 && soFacts.length === 0;
          invariants['autocommit'] = inAutocommit(raw);
          invariants['noTornWrite'] = tornWrites(raw).length === 0;
        } finally {
          world.handle.close();
        }
        const r = row(
          '10k-rows reads',
          seed,
          { ROWS_A, ROWS_B, ROWS_GUEST },
          invariants,
          { ...observed, timings },
        );
        allRows.push(r);
        expect(r.failed).toEqual([]);
      },
      5 * 60_000,
    );

    it(
      '10k rows: purgeOwnerData is all-or-nothing and leaves the other owners byte-identical',
      async () => {
        const seed = 0x10_001;
        const world = buildBigWorld(seed);
        const { db, raw } = world.handle;
        const invariants: Record<string, boolean> = {};
        const observed: Record<string, unknown> = {};
        try {
          setActiveDataOwner(OWNER_A);
          const rng = makePrng(seed);
          for (let i = 0; i < 3; i++) {
            await repo.savePendingCapture(db, uuid(rng), 'dink', makeClip(rng));
          }
          await repo.saveSession(db, makeSession(rng, 'practice_set'));
          await repo.saveAnalysis(db, makeAnalysis(rng), makePermitId(rng));
          await repo.setKv(db, `profile:${OWNER_A}`, '{"name":"A"}');
          const beforeB = snapshotOwner(raw, OWNER_B);
          const beforeGuest = snapshotOwner(raw, OWNER_GUEST);

          // Failure mid-purge (the outbox DELETE rejects) — nothing may be lost.
          const proxy = new FaultyLocalDb(db, raw, {
            setOwner: setActiveDataOwner,
          });
          proxy.arm({
            kind: 'reject',
            match: /^\s*DELETE FROM outbox/i,
            atMatch: 0,
            code: 'SQLITE_IOERR',
            delayMs: 0,
          });
          const beforeA = snapshotOwner(raw, OWNER_A);
          let error: unknown = null;
          try {
            await repo.purgeOwnerData(proxy, OWNER_A);
          } catch (e) {
            error = e;
          }
          invariants['failedPurgeSurfacesError'] = error !== null;
          invariants['failedPurgeLeavesEverything'] = sameSnapshot(
            snapshotOwner(raw, OWNER_A),
            beforeA,
          );
          invariants['failedPurgeAutocommit'] = inAutocommit(raw);
          observed['failedPurgeError'] = String(error);

          const t = Date.now();
          await repo.purgeOwnerData(db, OWNER_A);
          timings['purgeOwnerData(A,10k)ms'] = Date.now() - t;
          const remaining: Record<string, number> = {};
          for (const table of OWNER_TABLES)
            remaining[table] = countRows(raw, table, OWNER_A);
          const kvLeft = raw
            .prepare(`SELECT count(*) AS n FROM kv WHERE key LIKE ?`)
            .get(`%${OWNER_A}%`) as { n: number | bigint };
          invariants['purgeRemovesEveryOwnerRow'] =
            Object.values(remaining).every(n => n === 0) &&
            Number(kvLeft.n) === 0;
          invariants['purgeKeepsOwnerB'] = sameSnapshot(
            snapshotOwner(raw, OWNER_B),
            beforeB,
          );
          invariants['purgeKeepsGuest'] = sameSnapshot(
            snapshotOwner(raw, OWNER_GUEST),
            beforeGuest,
          );
          invariants['purgeAutocommit'] = inAutocommit(raw);
          invariants['noTornWrite'] = tornWrites(raw).length === 0;
          observed['remaining'] = remaining;
          setActiveDataOwner(OWNER_A);
          invariants['readsEmptyAfterPurge'] =
            (await repo.listShots(db, 10)).length === 0;
        } finally {
          world.handle.close();
        }
        const r = row(
          '10k-rows purge',
          seed,
          { ROWS_A, ROWS_B, ROWS_GUEST },
          invariants,
          observed,
        );
        allRows.push(r);
        expect(r.failed).toEqual([]);
      },
      5 * 60_000,
    );

    it('signed-out: every write is refused before the first SQL statement; guest rows never cross into an account', async () => {
      const seed = 0x10_002;
      const rng = makePrng(seed);
      const handle = openMigratedDb(getDb);
      const { db, raw } = handle;
      const rows: MatrixRow[] = [];
      try {
        setActiveDataOwner(OWNER_GUEST);
        const guestAnalysis = makeAnalysis(rng);
        await repo.saveAnalysis(db, guestAnalysis, makePermitId(rng));
        await repo.savePendingCapture(db, uuid(rng), 'dink', makeClip(rng));
        const guestBefore = snapshotOwner(raw, OWNER_GUEST);

        setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
        const proxy = new FaultyLocalDb(db, raw, {
          setOwner: setActiveDataOwner,
        });
        const writes: Array<[string, () => Promise<unknown>]> = [
          [
            'saveAnalysis',
            () =>
              repo.saveAnalysis(proxy, makeAnalysis(rng), makePermitId(rng)),
          ],
          [
            'saveLocalOnlyAnalysis',
            () =>
              repo.saveLocalOnlyAnalysis(
                proxy,
                makeAnalysis(rng, { resultKind: 'low_confidence' }),
              ),
          ],
          [
            'savePendingCapture',
            () =>
              repo.savePendingCapture(proxy, uuid(rng), 'dink', makeClip(rng)),
          ],
          ['saveSession', () => repo.saveSession(proxy, makeSession(rng))],
          ['finishSession', () => repo.finishSession(proxy, uuid(rng), {})],
          [
            'saveAnalysisRecord',
            () =>
              repo.saveAnalysisRecord(proxy, {
                schemaVersion: 1,
                id: uuid(rng),
                captureId: uuid(rng),
                createdAtIso: '2026-01-01T00:00:00.000Z',
                engineVersion: 'engine-1',
                result: null,
              } as unknown as Parameters<typeof repo.saveAnalysisRecord>[1]),
          ],
          [
            'setDeclaredStroke',
            () => repo.setDeclaredStroke(proxy, uuid(rng), 'dink'),
          ],
          [
            'setCaptureTargetSeed',
            () =>
              repo.setCaptureTargetSeed(proxy, uuid(rng), {
                point: { x: 0.5, y: 0.5 },
                selectedAtIso: '2026-01-01T00:00:00.000Z',
              }),
          ],
          [
            'updateCaptureClipPayload',
            () =>
              repo.updateCaptureClipPayload(proxy, uuid(rng), makeClip(rng)),
          ],
          [
            'markCaptureAnalyzed',
            () => repo.markCaptureAnalyzed(proxy, uuid(rng)),
          ],
        ];
        for (const [name, run] of writes) {
          const before = proxy.statements.length;
          let error: unknown = null;
          let resolved = false;
          try {
            await run();
            resolved = true;
          } catch (e) {
            error = e;
          }
          const statements = proxy.statements.length - before;
          const invariants = {
            refused: !resolved && error !== null,
            noStatementIssued: statements === 0,
            stillSignedOut: getActiveDataOwner() === SIGNED_OUT_DATA_OWNER,
          };
          rows.push(
            row(
              `signed-out write refused: ${name}`,
              seed,
              { operation: name },
              invariants,
              {
                error: String(error),
                statements,
              },
            ),
          );
        }
        // Signed-out reads: empty, never guest data.
        const so = await repo.listShots(db, 100);
        const soCaptures = await repo.listPendingCaptures(db);
        rows.push(
          row(
            'signed-out reads see nothing',
            seed,
            {},
            {
              shotsEmpty: so.length === 0,
              capturesEmpty: soCaptures.length === 0,
            },
            { shots: so.length, captures: soCaptures.length },
          ),
        );
        // Guest → account transition: guest rows stay guest rows.
        setActiveDataOwner(OWNER_A);
        const a = await repo.listShots(db, 100);
        const aFacts = await repo.listRealAnalysisFacts(db, null);
        const aCaptures = await repo.listPendingCaptures(db);
        rows.push(
          row(
            'guest rows invisible to canonical account',
            seed,
            {},
            {
              shotsEmpty: a.length === 0,
              factsEmpty: aFacts.length === 0,
              capturesEmpty: aCaptures.length === 0,
              guestUntouched: sameSnapshot(
                snapshotOwner(raw, OWNER_GUEST),
                guestBefore,
              ),
              guestStillReadable: await (async () => {
                setActiveDataOwner(OWNER_GUEST);
                const g = await repo.getAnalysis(db, guestAnalysis.id);
                return g !== null && g.id === guestAnalysis.id;
              })(),
            },
            {},
          ),
        );
        setActiveDataOwner(OWNER_A);
        const analysisA = makeAnalysis(rng);
        await repo.saveAnalysis(db, analysisA, makePermitId(rng));
        setActiveDataOwner(OWNER_GUEST);
        rows.push(
          row(
            'account rows invisible to guest',
            seed,
            {},
            {
              accountShotHidden:
                (await repo.getAnalysis(db, analysisA.id)) === null,
              guestListOnlyGuest: (await repo.listShots(db, 100)).every(
                s => s.id === guestAnalysis.id,
              ),
            },
            {},
          ),
        );
      } finally {
        handle.close();
      }
      allRows.push(...rows);
      expect(
        rows
          .filter(r => !r.ok)
          .map(r => ({
            scenario: r.scenario,
            failed: r.failed,
            observed: r.observed,
          })),
      ).toEqual([]);
    }, 60_000);

    it(
      'deletes racing reads at 10k rows: results are a subset of the owner rows that existed, never fabricated or foreign (seeded)',
      async () => {
        const config = campaignConfig(40);
        const world = buildBigWorld(0x10_003);
        const { db, raw } = world.handle;
        const rows: MatrixRow[] = [];
        try {
          const reads: Array<
            [string, (d: FaultyLocalDb) => Promise<string[]>]
          > = [
            [
              'listShots',
              async d => (await repo.listShots(d, 100_000)).map(s => s.id),
            ],
            [
              'listActivityShots',
              async d => (await repo.listActivityShots(d)).map(s => s.id),
            ],
            [
              'listRealAnalysisFacts',
              async d =>
                (await repo.listRealAnalysisFacts(d, null)).map(f => f.id),
            ],
            [
              'listScoredCheckpointFacts',
              async d =>
                (await repo.listScoredCheckpointFacts(d, 100_000)).map(
                  f => f.id,
                ),
            ],
            [
              'recentScores',
              async d => (await repo.recentScores(d, 'dink', 30)).map(String),
            ],
          ];
          for (const seed of seedsFor(config)) {
            const rng = makePrng(seed);
            const [name, read] = pick(rng, reads);
            const victimOwner = pick(rng, [
              OWNER_A,
              OWNER_A,
              OWNER_B,
              OWNER_GUEST,
            ]);
            const mode = pick(rng, [
              'delete-half',
              'delete-all',
              'delete-one',
              'purge-other',
            ] as const);
            const victimIds = [
              ...(victimOwner === OWNER_A
                ? world.idsA
                : victimOwner === OWNER_B
                  ? world.idsB
                  : world.idsGuest),
            ];
            const deleteSql: string[] =
              mode === 'delete-all'
                ? [`DELETE FROM local_shot WHERE owner_key = '${victimOwner}'`]
                : mode === 'delete-half'
                  ? [
                      `DELETE FROM local_shot WHERE owner_key = '${victimOwner}' AND (rowid % 2) = ${int(rng, 0, 1)}`,
                    ]
                  : mode === 'delete-one'
                    ? [
                        `DELETE FROM local_shot WHERE owner_key = '${victimOwner}' AND id = '${pick(rng, victimIds)}'`,
                      ]
                    : [
                        `DELETE FROM local_shot WHERE owner_key = '${OWNER_B}'`,
                        `DELETE FROM sync_receipt WHERE owner_key = '${OWNER_B}'`,
                      ];
            const beforeA = new Set(
              (
                raw
                  .prepare(`SELECT id FROM local_shot WHERE owner_key = ?`)
                  .all(OWNER_A) as { id: string }[]
              ).map(r => r.id),
            );
            setActiveDataOwner(OWNER_A);
            const proxy = new FaultyLocalDb(db, raw, {
              setOwner: setActiveDataOwner,
            });
            const fault: Fault = {
              kind: 'delete-during',
              match: null,
              atMatch: 0,
              code: 'SQLITE_IOERR',
              delayMs: 0,
              deleteSql,
            };
            proxy.arm(fault);
            let ids: string[] = [];
            let error: unknown = null;
            try {
              ids = await read(proxy);
            } catch (e) {
              error = e;
            }
            const afterA = new Set(
              (
                raw
                  .prepare(`SELECT id FROM local_shot WHERE owner_key = ?`)
                  .all(OWNER_A) as { id: string }[]
              ).map(r => r.id),
            );
            const isScores = name === 'recentScores';
            const invariants = {
              settledOk: error === null,
              fired: proxy.fired !== null,
              subsetOfPre: isScores || ids.every(id => beforeA.has(id)),
              ownerScoped: isScores || ids.every(id => world.idsA.has(id)),
              noFabrication: isScores
                ? ids.every(v => Number.isFinite(Number(v)))
                : ids.every(id => id.length > 0 && id !== 'undefined'),
              consistentSnapshot:
                isScores ||
                ids.every(id => afterA.has(id)) ||
                ids.length === beforeA.size,
              otherOwnersUntouchedUnlessVictim:
                victimOwner !== OWNER_A || mode === 'purge-other'
                  ? true
                  : countRows(raw, 'local_shot', OWNER_B) === world.idsB.size,
              autocommit: inAutocommit(raw),
            };
            rows.push(
              row(
                `${name} × ${mode}(${victimOwner === OWNER_A ? 'A' : victimOwner === OWNER_B ? 'B' : 'guest'})`,
                seed,
                { read: name, mode, victimOwner, deleteSql },
                invariants,
                {
                  returned: ids.length,
                  beforeA: beforeA.size,
                  afterA: afterA.size,
                  error: error === null ? null : String(error),
                },
              ),
            );
            // Restore the victim rows so every seed starts from the same world.
            {
              raw.exec('BEGIN');
              const insert = raw.prepare(
                `INSERT OR IGNORE INTO local_shot
                 (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              );
              const receipt = raw.prepare(
                `INSERT OR IGNORE INTO sync_receipt (owner_key, kind, entity_id) VALUES (?, 'shot.sync', ?)`,
              );
              for (const shot of [
                ...world.shotsA,
                ...world.shotsB,
                ...world.shotsGuest,
              ]) {
                const a = shot.analysis;
                insert.run(
                  shot.owner,
                  a.id,
                  a.sessionId ?? null,
                  a.shotType,
                  a.capturedAtIso,
                  a.overallScore,
                  a.analysisConfidence,
                  a.resultKind,
                  'real',
                  JSON.stringify(a),
                );
                receipt.run(shot.owner, a.id);
              }
              raw.exec('COMMIT');
            }
          }
        } finally {
          world.handle.close();
        }
        allRows.push(...rows);
        const { unexpected } = partitionFailures(rows, []);
        expect(rows.length).toBe(
          config.onlySeed === null ? config.iterations : 1,
        );
        expect(
          unexpected.map(r => ({
            seed: r.seed,
            scenario: r.scenario,
            failed: r.failed,
            observed: r.observed,
          })),
        ).toEqual([]);
      },
      10 * 60_000,
    );

    describe('findings pinned (it.failing = the defect is reproducible at this commit)', () => {
      it.failing(
        'F-1 getShotOutboxStatus: ONE malformed outbox payload for the owner breaks the status read for EVERY shot (json_extract raises)',
        async () => {
          const seed = 0xf1;
          const rng = makePrng(seed);
          const handle = openMigratedDb(getDb);
          try {
            setActiveDataOwner(OWNER_A);
            const healthy = makeAnalysis(rng);
            await repo.saveAnalysis(handle.db, healthy, makePermitId(rng));
            const queued = await repo.getShotOutboxStatus(
              handle.db,
              healthy.id,
            );
            expect(queued.state).toBe('queued');
            const rowId = plantCorruptOutbox(
              handle.raw,
              OWNER_A,
              'truncated-json',
            );
            let error: unknown = null;
            let status: repo.ShotOutboxStatus | null = null;
            try {
              status = await repo.getShotOutboxStatus(handle.db, healthy.id);
            } catch (e) {
              error = e;
            }
            const r = row(
              'F-1 corrupt outbox row poisons getShotOutboxStatus',
              seed,
              { corruptOutboxRowId: rowId, corruption: 'truncated-json' },
              {
                statusOfHealthyShotStillReadable:
                  error === null && status?.state === 'queued',
              },
              { error: String(error), status },
            );
            allRows.push(r);
            expect(r.failed).toEqual([]);
          } finally {
            handle.close();
          }
        },
      );

      it.failing(
        "F-2a shared connection: a single-statement write that lands inside another operation's transaction is rolled back with it, yet its promise resolved (fake success → silent data loss)",
        async () => {
          const seed = 0xf2a;
          const rng = makePrng(seed);
          const handle = openMigratedDb(getDb);
          try {
            setActiveDataOwner(OWNER_A);
            const proxy = new FaultyLocalDb(handle.db, handle.raw, {
              setOwner: setActiveDataOwner,
            });
            proxy.arm({
              kind: 'reject',
              match: /^\s*COMMIT/i,
              atMatch: 0,
              code: 'SQLITE_FULL',
              delayMs: 0,
            });
            const analysis = makeAnalysis(rng);
            const captureId = uuid(rng);
            const saveShot = repo.saveAnalysis(
              proxy,
              analysis,
              makePermitId(rng),
            );
            const saveCapture = repo.savePendingCapture(
              proxy,
              captureId,
              'dink',
              makeClip(rng),
            );
            const [shotOutcome, captureOutcome] = await Promise.allSettled([
              saveShot,
              saveCapture,
            ]);
            const capturePersisted =
              (await repo.getPendingCapture(handle.db, captureId)) !== null;
            const r = row(
              'F-2a interleaved single-statement write lost by neighbour ROLLBACK',
              seed,
              {
                statements: proxy.statements.map(
                  s =>
                    `${s.sql.trim().slice(0, 28)}${s.fault ? '!' + s.fault : ''}`,
                ),
              },
              {
                shotSaveRejected: shotOutcome.status === 'rejected',
                captureSaveResolved: captureOutcome.status === 'fulfilled',
                capturePersistedIfResolved:
                  captureOutcome.status !== 'fulfilled' || capturePersisted,
                autocommit: inAutocommit(handle.raw),
              },
              {
                capturePersisted,
                shotOutcome: shotOutcome.status,
                captureOutcome: captureOutcome.status,
              },
            );
            allRows.push(r);
            expect(r.failed).toEqual([]);
          } finally {
            handle.close();
          }
        },
      );

      it('HELD (not a finding): purgeOwnerData started while saveAnalysis is mid-transaction fails loudly at BEGIN IMMEDIATE; the save commits intact, nothing torn', async () => {
        const seed = 0xf2b;
        const rng = makePrng(seed);
        const handle = openMigratedDb(getDb);
        try {
          setActiveDataOwner(OWNER_A);
          await repo.savePendingCapture(
            handle.db,
            uuid(rng),
            'dink',
            makeClip(rng),
          );
          const analysis = makeAnalysis(rng);
          const save = repo.saveAnalysis(
            handle.db,
            analysis,
            makePermitId(rng),
          );
          const purge = repo.purgeOwnerData(handle.db, OWNER_A);
          const [saveOutcome, purgeOutcome] = await Promise.allSettled([
            save,
            purge,
          ]);
          const shotPersisted = countRows(handle.raw, 'local_shot', OWNER_A);
          const outboxPersisted = countRows(handle.raw, 'outbox', OWNER_A);
          const torn = tornWrites(handle.raw);
          const r = row(
            'HELD purge racing saveAnalysis on the shared connection',
            seed,
            {},
            {
              saveOutcomeMatchesState:
                (saveOutcome.status === 'fulfilled') ===
                (shotPersisted === 1 && outboxPersisted === 1),
              purgeOutcomeMatchesState:
                purgeOutcome.status !== 'fulfilled' ||
                countRows(handle.raw, 'local_capture', OWNER_A) === 0,
              noTornWrite: torn.length === 0,
              autocommit: inAutocommit(handle.raw),
            },
            {
              saveOutcome: saveOutcome.status,
              saveError:
                saveOutcome.status === 'rejected'
                  ? String(saveOutcome.reason)
                  : null,
              purgeOutcome: purgeOutcome.status,
              purgeError:
                purgeOutcome.status === 'rejected'
                  ? String(purgeOutcome.reason)
                  : null,
              shotPersisted,
              outboxPersisted,
              capturesLeft: countRows(handle.raw, 'local_capture', OWNER_A),
              torn,
            },
          );
          allRows.push(r);
          expect(r.failed).toEqual([]);
        } finally {
          handle.close();
        }
      });

      it.failing(
        'F-3 payload shape is not validated after JSON.parse: a well-formed JSON payload of the wrong shape becomes an analysis fact with undefined fields',
        async () => {
          const seed = 0xf3;
          const handle = openMigratedDb(getDb);
          try {
            setActiveDataOwner(OWNER_A);
            plantCorruptShot(
              handle.raw,
              OWNER_A,
              'shape-drift-shot',
              'shape-drift-real-empty',
              'scored',
            );
            plantCorruptShot(
              handle.raw,
              OWNER_A,
              'no-checkpoints-shot',
              'shape-drift-scored-no-checkpoints',
              'scored',
            );
            const facts = await repo.listRealAnalysisFacts(handle.db, null);
            const bad = facts.filter(
              f => typeof f.id !== 'string' || typeof f.shotType !== 'string',
            );
            const r = row(
              'F-3 wrong-shape payload becomes a fact',
              seed,
              {
                corruptions: [
                  'shape-drift-real-empty',
                  'shape-drift-scored-no-checkpoints',
                ],
              },
              {
                noFactWithoutIdentity: bad.length === 0,
              },
              {
                facts: facts.length,
                bad: bad.map(f => ({
                  id: f.id,
                  shotType: f.shotType,
                  overallScore: f.overallScore,
                })),
              },
            );
            allRows.push(r);
            expect(r.failed).toEqual([]);
          } finally {
            handle.close();
          }
        },
      );
    });
  },
);
