/**
 * xc-matrix-behavioral — sync plane.
 *
 * Real `configureSyncRuntime` / `triggerOutboxSync` / `drainOutbox` against
 * an in-memory LocalDb and a fake server, under Jest fake timers, driven by
 * seeded interleavings of: foreground (background/resume) storms, explicit
 * triggers, overlapping drains, account reconfiguration mid-drain,
 * kill/relaunch between the server write and the local receipt, transient vs
 * permanent server failures, and a shot whose practice-set session never
 * reached the outbox.
 *
 * Invariants asserted:
 *   - a shot id reaches the server at most once per drain and never while a
 *     drain for the same runtime is in flight (no duplicate shots);
 *   - a drain never overlaps another drain of the same runtime;
 *   - no transaction is left open (no orphaned BEGIN) after a fault;
 *   - receipts and deletes are owner-scoped after an account switch;
 *   - exactly one retry timer is armed after any storm (no timer leak);
 *   - permanent failures are bounded by OUTBOX_MAX_ATTEMPTS;
 *   - a shot with no session.create row anywhere is offered at most
 *     OUTBOX_MAX_ATTEMPTS times, then parked (`orphaned`, not deleted) and
 *     delivered as soon as a session.create row for its set is accepted.
 *
 * Replay a failing line: XC_SEED=<seed> npx jest __tests__/xcBehavioral/syncRuntimeMatrix
 */
import { AppState } from 'react-native';
import { getDb } from '../../src/data/db';
import { createTransport, ApiError } from '../../src/data/api';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  SESSION_ORPHANED_VERDICT,
  type SyncTransport,
} from '../../src/data/sync';
import {
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_JITTER_RATIO,
  SYNC_RETRY_MAX_MS,
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  establishApiSession,
  clearApiSession,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  createFakeLocalDb,
  type FakeLocalDb,
} from '../../testing/xcBehavioral/fakeLocalDb';
import {
  randomInt,
  recordScenario,
  scenarioSeeds,
  seededRandom,
} from '../../testing/xcBehavioral/evidence';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../../src/data/api', () => {
  const actual =
    jest.requireActual<typeof import('../../src/data/api')>(
      '../../src/data/api',
    );
  return { ...actual, createTransport: jest.fn() };
});

const SUITE = 'syncRuntimeMatrix';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

function sessionFor(user: string): ApiSession {
  return {
    apiBaseUrl: 'https://api.test',
    bearerToken: `bearer-${user.slice(0, 4)}`,
    canonicalAppUserId: user,
    provider: 'apple',
  };
}

function shotPayload(id: string, sessionId: string | null) {
  return {
    id,
    sessionId,
    shotType: 'drive',
    stroke: 'drive',
    handedness: 'right',
    cameraView: 'side',
    createdAt: '2026-08-30T10:00:00.000Z',
    modelVersion: 'm1',
    pipelineVersion: 'p1',
    versionVector: { model: 'm1', pipeline: 'p1' },
    overallScore: 70,
    checkpoints: [],
    provenance: {
      appVersion: 't',
      modelVersion: 'm1',
      pipelineVersion: 'p1',
      captureMode: 'automatic_pose_trigger',
      captureRecordedAt: '2026-08-30T10:00:00.000Z',
      poseSource: 'apple_vision_body_pose',
    },
    analysisPermitId: `permit-${id}`,
  };
}

interface FakeServer {
  transport: SyncTransport;
  knownSessions: Set<string>;
  /** Every shot id received, in call order (duplicates preserved). */
  received: string[];
  calls: number;
  inFlight: number;
  maxInFlight: number;
  /** When set, syncShots resolves only after `release()` is invoked. */
  holdNext: boolean;
  release: (() => void) | null;
  /** Reject the whole request with this error (once) when set. */
  failNextWith: unknown;
  /** Per-item rejection code applied to shots whose session is unknown. */
  unknownSessionCode: string;
}

function fakeServer(): FakeServer {
  const server: FakeServer = {
    knownSessions: new Set(),
    received: [],
    calls: 0,
    inFlight: 0,
    maxInFlight: 0,
    holdNext: false,
    release: null,
    failNextWith: null,
    unknownSessionCode: SESSION_NOT_FOUND_REJECTION,
    transport: {
      async syncShots(shots) {
        server.calls += 1;
        server.inFlight += 1;
        server.maxInFlight = Math.max(server.maxInFlight, server.inFlight);
        try {
          if (server.holdNext) {
            server.holdNext = false;
            await new Promise<void>(resolve => {
              server.release = resolve;
            });
          }
          if (server.failNextWith) {
            const error = server.failNextWith;
            server.failNextWith = null;
            throw error;
          }
          const acceptedIds: string[] = [];
          const rejected: Array<{ id: string; code: string; message: string }> =
            [];
          for (const shot of shots as Array<{
            id: string;
            sessionId: string | null;
          }>) {
            server.received.push(shot.id);
            if (shot.sessionId && !server.knownSessions.has(shot.sessionId)) {
              rejected.push({
                id: shot.id,
                code: server.unknownSessionCode,
                message: 'unknown session',
              });
            } else {
              acceptedIds.push(shot.id);
            }
          }
          return { acceptedIds, rejected };
        } finally {
          server.inFlight -= 1;
        }
      },
      async createSession(session) {
        server.knownSessions.add(
          String((session as Record<string, unknown>)['id']),
        );
      },
      async finalizeSession() {},
    },
  };
  return server;
}

/** Drains the whole microtask queue (setImmediate is left real). */
async function flushMicrotasks(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

/** Advance fake time in steps so timer-driven drains get their microtasks. */
async function advance(ms: number) {
  jest.advanceTimersByTime(ms);
  await flushMicrotasks();
}

describe('xc-matrix-behavioral: sync runtime under interleaving storms', () => {
  let fake: FakeLocalDb;
  let server: FakeServer;
  let appStateHandlers: Array<(state: string) => void>;
  let listenerRemovals: number;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    fake = createFakeLocalDb();
    server = fakeServer();
    appStateHandlers = [];
    listenerRemovals = 0;
    (getDb as jest.Mock).mockReturnValue(fake.db);
    (createTransport as jest.Mock).mockImplementation(() => server.transport);
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event, handler) => {
        appStateHandlers.push(handler as (state: string) => void);
        return {
          remove: () => {
            listenerRemovals += 1;
          },
        } as ReturnType<typeof AppState.addEventListener>;
      });
    establishApiSession(sessionFor(USER_A));
    setActiveDataOwner(canonicalDataOwner(USER_A));
  });

  afterEach(() => {
    clearSyncRuntime();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function foreground(state: string) {
    for (const handler of appStateHandlers) handler(state);
  }

  /**
   * Drains observed by the DB (the transport is only hit when rows exist).
   * A drain issues several page reads (one per kind, one per 50 rows), so
   * pages cannot be counted as drains; the backlog count that produces
   * `remaining` is issued exactly once, at the end of every drainOutbox.
   */
  function drainCount() {
    return fake.statements.filter(s =>
      s.sql.startsWith('SELECT count(*) AS n FROM outbox'),
    ).length;
  }

  const ownerA = canonicalDataOwner(USER_A);
  const ownerB = canonicalDataOwner(USER_B);

  describe('overlapping triggers during an in-flight drain never re-send a shot', () => {
    for (const seed of scenarioSeeds('sync.overlap')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const shots = randomInt(random, 1, 6);
        const storm = randomInt(random, 2, 40);
        const kinds = Array.from({ length: storm }, () =>
          random() < 0.5 ? 'foreground' : 'trigger',
        );
        await recordScenario(
          SUITE,
          'overlap',
          seed,
          { shots, storm, kinds },
          async () => {
            for (let i = 0; i < shots; i += 1) {
              fake.push('shot.sync', shotPayload(`shot-${i}`, null), ownerA);
            }
            server.holdNext = true;
            configureSyncRuntime(sessionFor(USER_A));
            await flushMicrotasks();
            expect(server.calls).toBe(1);
            // Storm while the first syncShots is still pending.
            for (const kind of kinds) {
              if (kind === 'foreground') foreground('active');
              else triggerOutboxSync();
              if (random() < 0.3) await flushMicrotasks(2);
            }
            expect(server.calls).toBe(1);
            server.release!();
            await flushMicrotasks(20);
            const unique = new Set(server.received);
            expect(server.received).toHaveLength(unique.size);
            expect(unique.size).toBe(shots);
            expect(fake.outbox).toHaveLength(0);
            expect(fake.receipts).toHaveLength(shots);
            expect(server.maxInFlight).toBe(1);
            expect(fake.openTransactions()).toBe(0);
            // Exactly one retry timer armed after the storm.
            expect(jest.getTimerCount()).toBe(1);
            return {
              serverCalls: server.calls,
              received: server.received,
              timers: jest.getTimerCount(),
            };
          },
        );
      });
    }
  });

  describe('background/resume storms with timed gaps deliver each shot once', () => {
    for (const seed of scenarioSeeds('sync.backgroundResume')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const transitions = randomInt(random, 3, 30);
        const plan = Array.from({ length: transitions }, () => ({
          state: (['active', 'background', 'inactive'] as const)[
            randomInt(random, 0, 2)
          ]!,
          gapMs: randomInt(random, 0, 45_000),
          enqueueShot: random() < 0.35,
        }));
        await recordScenario(
          SUITE,
          'backgroundResume',
          seed,
          { transitions, plan },
          async () => {
            configureSyncRuntime(sessionFor(USER_A));
            await flushMicrotasks();
            let enqueued = 0;
            for (const step of plan) {
              if (step.enqueueShot) {
                fake.push(
                  'shot.sync',
                  shotPayload(`shot-${enqueued}`, null),
                  ownerA,
                );
                enqueued += 1;
                triggerOutboxSync();
              }
              foreground(step.state);
              await advance(step.gapMs);
            }
            await advance(SYNC_RETRY_MAX_MS + SYNC_RETRY_BASE_MS);
            const unique = new Set(server.received);
            expect(server.received).toHaveLength(unique.size);
            expect(unique.size).toBe(enqueued);
            expect(fake.outbox).toHaveLength(0);
            expect(server.maxInFlight).toBeLessThanOrEqual(1);
            expect(jest.getTimerCount()).toBe(1);
            return {
              enqueued,
              serverCalls: server.calls,
              received: server.received,
            };
          },
        );
      });
    }
  });

  describe('kill/relaunch between server accept and local receipt', () => {
    for (const seed of scenarioSeeds('sync.killRelaunch')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const shots = randomInt(random, 1, 5);
        const crashIndex = randomInt(random, 0, shots - 1);
        const crashAt = (['sync_receipt', 'COMMIT'] as const)[
          randomInt(random, 0, 1)
        ]!;
        await recordScenario(
          SUITE,
          'killRelaunch',
          seed,
          { shots, crashIndex, crashAt },
          async () => {
            for (let i = 0; i < shots; i += 1) {
              fake.push('shot.sync', shotPayload(`shot-${i}`, null), ownerA);
            }
            // The (crashIndex+1)-th receipt transaction "crashes" (process
            // killed mid-txn) either on the receipt insert or on COMMIT.
            let receiptWrites = 0;
            const original = fake.db.execute.bind(fake.db);
            fake.db.execute = async (sql: string, params: unknown[] = []) => {
              if (sql.includes('INSERT OR REPLACE INTO sync_receipt')) {
                if (
                  receiptWrites === crashIndex &&
                  crashAt === 'sync_receipt'
                ) {
                  fake.failNext('INSERT OR REPLACE INTO sync_receipt');
                }
                if (receiptWrites === crashIndex && crashAt === 'COMMIT') {
                  fake.failNext('COMMIT');
                }
                receiptWrites += 1;
              }
              return original(sql, params);
            };
            configureSyncRuntime(sessionFor(USER_A));
            await flushMicrotasks(30);
            // The killed process left the un-receipted rows behind, nothing
            // half-committed.
            expect(fake.openTransactions()).toBe(0);
            const receiptedBeforeCrash = fake.receipts.length;
            expect(receiptedBeforeCrash).toBe(crashIndex);
            expect(fake.outbox).toHaveLength(shots - crashIndex);
            const serverCallsBeforeRelaunch = server.calls;

            // "Relaunch": a fresh runtime over the same durable state.
            fake.db.execute = original;
            clearSyncRuntime();
            configureSyncRuntime(sessionFor(USER_A));
            await flushMicrotasks(30);
            expect(server.calls).toBe(serverCallsBeforeRelaunch + 1);
            expect(fake.outbox).toHaveLength(0);
            expect(fake.receipts).toHaveLength(shots);
            expect(new Set(fake.receipts.map(r => r.entityId)).size).toBe(
              shots,
            );
            // Idempotent replay: the shots after the crash point were sent
            // to the server twice — never a third time, never locally
            // duplicated.
            const counts = new Map<string, number>();
            for (const id of server.received) {
              counts.set(id, (counts.get(id) ?? 0) + 1);
            }
            for (let i = 0; i < shots; i += 1) {
              expect(counts.get(`shot-${i}`)).toBe(i < crashIndex ? 1 : 2);
            }
            return { received: server.received, receipts: fake.receipts };
          },
        );
      });
    }
  });

  describe('account switch mid-drain: stale drain stays bound to its owner', () => {
    for (const seed of scenarioSeeds('sync.accountSwitch')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const shotsA = randomInt(random, 1, 4);
        const shotsB = randomInt(random, 1, 4);
        const releaseBeforeBConfigured = random() < 0.5;
        await recordScenario(
          SUITE,
          'accountSwitch',
          seed,
          { shotsA, shotsB, releaseBeforeBConfigured },
          async () => {
            for (let i = 0; i < shotsA; i += 1) {
              fake.push('shot.sync', shotPayload(`a-${i}`, null), ownerA);
            }
            for (let i = 0; i < shotsB; i += 1) {
              fake.push('shot.sync', shotPayload(`b-${i}`, null), ownerB);
            }
            server.holdNext = true;
            configureSyncRuntime(sessionFor(USER_A));
            await flushMicrotasks();
            expect(server.calls).toBe(1);
            const releaseA = server.release!;
            // Sign out A, sign in B while A's request is still in flight.
            clearSyncRuntime();
            clearApiSession();
            setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
            if (releaseBeforeBConfigured) {
              releaseA();
              await flushMicrotasks(20);
            }
            establishApiSession(sessionFor(USER_B));
            setActiveDataOwner(ownerB);
            configureSyncRuntime(sessionFor(USER_B));
            await flushMicrotasks(20);
            if (!releaseBeforeBConfigured) {
              releaseA();
              await flushMicrotasks(20);
            }
            // A's receipts are A's, B's are B's; nothing crosses.
            for (const receipt of fake.receipts) {
              if (receipt.entityId.startsWith('a-')) {
                expect(receipt.owner).toBe(ownerA);
              } else {
                expect(receipt.owner).toBe(ownerB);
              }
            }
            expect(
              fake.outbox.filter(r => r.owner_key === ownerB),
            ).toHaveLength(0);
            expect(
              fake.outbox.filter(r => r.owner_key === ownerA),
            ).toHaveLength(0);
            // Only B's runtime may hold a timer; A's stale schedule() is a
            // no-op for its dead generation.
            expect(jest.getTimerCount()).toBe(1);
            expect(listenerRemovals).toBeGreaterThanOrEqual(1);
            // A foreground event reaches both the dead (A) and live (B)
            // listeners; only B's generation drains, exactly once.
            const drainsBefore = drainCount();
            foreground('active');
            await flushMicrotasks(20);
            expect(drainCount()).toBe(drainsBefore + 1);
            expect(
              fake.statements
                .slice(-6)
                .filter(s => s.sql.startsWith('SELECT id, kind, payload'))
                .every(s => s.params[0] === ownerB),
            ).toBe(true);
            expect(server.maxInFlight).toBeLessThanOrEqual(2);
            return { receipts: fake.receipts, calls: server.calls };
          },
        );
      });
    }
  });

  describe('transient failures back off with bounded jitter and never burn attempts', () => {
    for (const seed of scenarioSeeds('sync.transientBackoff')) {
      it(`seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const failures = randomInt(random, 1, 9);
        const failureKind = (
          ['network', 'http500', 'http429', 'http401'] as const
        )[randomInt(random, 0, 3)]!;
        await recordScenario(
          SUITE,
          'transientBackoff',
          seed,
          { failures, failureKind },
          async () => {
            fake.push('shot.sync', shotPayload('shot-0', null), ownerA);
            const makeError = () => {
              switch (failureKind) {
                case 'network':
                  return new TypeError('Network request failed');
                case 'http500':
                  return new ApiError(500, 'server.error', 'boom');
                case 'http429':
                  return new ApiError(429, 'rate.limited', 'slow');
                case 'http401':
                  return new ApiError(401, 'auth.required', 'expired');
              }
            };
            server.failNextWith = makeError();
            configureSyncRuntime(sessionFor(USER_A));
            await flushMicrotasks(20);
            const gaps: number[] = [];
            for (let i = 1; i < failures; i += 1) {
              server.failNextWith = makeError();
              const callsBefore = server.calls;
              const expectedBase = Math.min(
                SYNC_RETRY_BASE_MS * 2 ** Math.min(i, 10),
                SYNC_RETRY_MAX_MS,
              );
              const minDelay = Math.floor(
                expectedBase * (1 - SYNC_RETRY_JITTER_RATIO),
              );
              await advance(minDelay - 1);
              expect(server.calls).toBe(callsBefore);
              await advance(
                Math.ceil(expectedBase * (1 + SYNC_RETRY_JITTER_RATIO)) -
                  minDelay +
                  2,
              );
              expect(server.calls).toBe(callsBefore + 1);
              gaps.push(expectedBase);
            }
            expect(fake.outbox).toHaveLength(1);
            expect(fake.outbox[0]!.attempts).toBe(0);
            // Server recovers: the next timer delivers once and clears.
            await advance(SYNC_RETRY_MAX_MS * 2);
            expect(fake.outbox).toHaveLength(0);
            expect(server.received.filter(id => id === 'shot-0')).toHaveLength(
              1,
            );
            // A clean drain resets the cadence to the base beat (the outbox
            // is now empty, so the drain is visible on the DB, not the
            // transport).
            const drainsAfterRecovery = drainCount();
            await advance(Math.floor(SYNC_RETRY_BASE_MS * 0.8) - 1);
            expect(drainCount()).toBe(drainsAfterRecovery);
            await advance(Math.ceil(SYNC_RETRY_BASE_MS * 0.4) + 2);
            expect(drainCount()).toBe(drainsAfterRecovery + 1);
            return { gaps, calls: server.calls };
          },
        );
      });
    }
  });

  it('permanent per-item rejections are bounded by OUTBOX_MAX_ATTEMPTS and stop being sent', async () => {
    await recordScenario(
      SUITE,
      'permanentBounded',
      0,
      { maxAttempts: OUTBOX_MAX_ATTEMPTS },
      async () => {
        server.unknownSessionCode = 'shot.invalid_payload';
        fake.push('shot.sync', shotPayload('shot-0', 'never-created'), ownerA);
        configureSyncRuntime(sessionFor(USER_A));
        await flushMicrotasks(20);
        for (let i = 0; i < 40; i += 1) {
          await advance(SYNC_RETRY_MAX_MS * 1.3);
        }
        expect(server.received.filter(id => id === 'shot-0')).toHaveLength(
          OUTBOX_MAX_ATTEMPTS,
        );
        expect(fake.outbox[0]!.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
        return { sends: server.received.length };
      },
    );
  });

  it('a shot whose session.create row never exists is offered OUTBOX_MAX_ATTEMPTS times, then parked (orphaned, kept) and delivered as soon as a session.create row for its set lands', async () => {
    await recordScenario(
      SUITE,
      'orphanSessionBounded',
      0,
      { drains: 40, budget: OUTBOX_MAX_ATTEMPTS },
      async () => {
        fake.push('shot.sync', shotPayload('shot-0', 'orphan-session'), ownerA);
        configureSyncRuntime(sessionFor(USER_A));
        await flushMicrotasks(20);
        // The first cadence tick is the one drain that fits inside the
        // budget's last offer; every later tick finds the row parked.
        for (let i = 0; i < 40; i += 1) {
          await advance(SYNC_RETRY_MAX_MS * 1.3);
        }
        const sends = server.received.filter(id => id === 'shot-0').length;
        // Bounded: with no session.create row and no local_session row to
        // re-queue one from, every `shot.session_not_found` counts against
        // the shot's budget; once spent the row is PARKED (orphaned marker,
        // still in the outbox, no receipt) instead of offered on every tick.
        expect(sends).toBe(OUTBOX_MAX_ATTEMPTS);
        expect(fake.outbox).toHaveLength(1);
        expect(fake.outbox[0]!.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
        expect(fake.outbox[0]!.last_error).toMatch(
          new RegExp(`^${SESSION_ORPHANED_VERDICT}:`),
        );
        expect(fake.outbox[0]!.last_error).not.toContain(
          `${SESSION_NOT_FOUND_REJECTION}:`,
        );
        expect(fake.receipts).toHaveLength(0);

        // Not terminal: a session.create row for the set appears (the
        // server upsert is idempotent) → the SAME drain that creates it
        // un-parks the shot, offers it once more and receipts it.
        fake.push(
          'session.create',
          {
            id: 'orphan-session',
            mode: 'practice_set',
            shotType: 'forehand_drive',
            focusCheckpoint: null,
            startedAt: '2026-09-04T12:00:00.000Z',
          },
          ownerA,
        );
        const drainsBeforeRecovery = drainCount();
        await advance(SYNC_RETRY_MAX_MS * 1.3);
        expect(drainCount()).toBe(drainsBeforeRecovery + 1);
        expect(server.knownSessions.has('orphan-session')).toBe(true);
        const sendsAfter = server.received.filter(id => id === 'shot-0').length;
        expect(sendsAfter).toBe(OUTBOX_MAX_ATTEMPTS + 1);
        expect(fake.receipts).toEqual([
          { owner: ownerA, kind: 'shot.sync', entityId: 'shot-0' },
        ]);
        expect(fake.outbox).toHaveLength(0);
        expect(fake.openTransactions()).toBe(0);
        return { sends, sendsAfter, receipts: fake.receipts.length };
      },
    );
  });
});
