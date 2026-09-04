/**
 * ATTACK S4 / S5 / S8 (+ purge race) — syncRuntime under interleavings.
 *
 * The REAL runtime (configureSyncRuntime / triggerOutboxSync /
 * clearSyncRuntime) drives the REAL drainOutbox over the REAL production
 * schema on node:sqlite through a controllable global fetch; only the clock
 * (jest fake timers) and Math.random (seeded) are substituted.
 *
 *  S4  a row inserted while a drain is in flight is not sent by
 *      triggerOutboxSync(); it waits for the running drain's `finally`
 *      schedule (30 s, or the full back-off when failures preceded it).
 *  S5  20 consecutive 5xx drains without any AppState 'active' event: the
 *      delay clamps at 300 s ±20 % and never overflows.
 *  S8  A's drain is pending when the runtime is cleared and reconfigured for
 *      B; A's late acceptance lands under owner A and B's drain is unaffected.
 *  S10 A's drain is pending when A is purged (account deletion path); A's
 *      late acceptance re-creates an A-owned sync_receipt after the purge.
 */
import type { ApiSession } from '../../../src/account/apiSession';
import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
} from '../../../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { getDb } from '../../../src/data/db';
import { purgeOwnerData, saveAnalysis } from '../../../src/data/repository';
import {
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_JITTER_RATIO,
  SYNC_RETRY_MAX_MS,
  clearSyncRuntime,
  configureSyncRuntime,
  nextSyncRetryDelayMs,
  triggerOutboxSync,
} from '../../../src/data/syncRuntime';
import {
  OWNER_A,
  OWNER_B,
  realAnalysis,
} from '../../../testing/attack/mobileDataSyncFixtures';
import {
  countRows,
  installControlledFetch,
  jsonResponse,
  outboxRows,
  receiptRows,
  seededRandom,
  settle,
  uuidAt,
  type RecordedFetch,
} from '../../../testing/attack/mobileDataSync4Harness';
import { createOpSqliteModuleMock } from '../../../testing/attack/nodeSqliteOpAdapter';

const mockOpSqlite = createOpSqliteModuleMock();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockOpSqlite.open(options),
}));

const SEED = 0x5c5e_2026;

const sessionA: ApiSession = {
  canonicalAppUserId: OWNER_A,
  apiBaseUrl: 'https://api.test',
  bearerToken: 'access-token-A',
  provider: 'apple',
};
const sessionB: ApiSession = {
  canonicalAppUserId: OWNER_B,
  apiBaseUrl: 'https://api.test',
  bearerToken: 'access-token-B',
  provider: 'google',
};
const ownerA = canonicalDataOwner(OWNER_A);
const ownerB = canonicalDataOwner(OWNER_B);

function acceptAll(call: RecordedFetch) {
  const shots = (call.body as { shots: Array<{ id: string }> }).shots;
  return jsonResponse(200, {
    acceptedIds: shots.map(s => s.id),
    rejected: [],
  });
}

function shotIdsOf(call: RecordedFetch): string[] {
  return (call.body as { shots: Array<{ id: string }> }).shots.map(s => s.id);
}

describe('ATTACK S4/S5/S8 — syncRuntime interleavings [real sqlite + fake clock]', () => {
  let fetchLog: ReturnType<typeof installControlledFetch>;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    clearSyncRuntime();
    setApiUnauthorizedListener(null);
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    fetchLog?.uninstall();
    getDb().close();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('S4 — row inserted while a drain is in flight', () => {
    it('triggerOutboxSync() is a no-op during the drain; the new row waits for the finally-timer (30 s at zero failures)', async () => {
      fetchLog = installControlledFetch(); // manual responses
      establishApiSession(sessionA);
      setActiveDataOwner(ownerA);
      const db = getDb();
      const shot1 = uuidAt(0x54, 1);
      const shot2 = uuidAt(0x54, 2);
      await saveAnalysis(db, { ...realAnalysis, id: shot1 }, uuidAt(0x9e, 1));

      configureSyncRuntime(sessionA);
      await settle();
      expect(fetchLog.calls).toHaveLength(1);
      expect(shotIdsOf(fetchLog.calls[0]!)).toEqual([shot1]);

      // In flight: a second rating lands and the capture flow calls the
      // trigger exactly as AnalyzeScreen does.
      await saveAnalysis(db, { ...realAnalysis, id: shot2 }, uuidAt(0x9e, 2));
      triggerOutboxSync();
      triggerOutboxSync();
      triggerOutboxSync();
      await settle();
      expect(fetchLog.calls).toHaveLength(1);

      // The running drain completes.
      fetchLog.calls[0]!.respond.resolve(acceptAll(fetchLog.calls[0]!));
      await settle();
      expect(await receiptRows(db)).toEqual([
        { owner_key: ownerA, entity_id: shot1 },
      ]);
      expect((await outboxRows(db)).map(r => r.entity)).toEqual([shot2]);
      // Nothing re-drains on completion even though a trigger was requested
      // while it ran (lost wake-up).
      expect(fetchLog.calls).toHaveLength(1);

      jest.advanceTimersByTime(SYNC_RETRY_BASE_MS - 1);
      await settle();
      expect(fetchLog.calls).toHaveLength(1);
      jest.advanceTimersByTime(1);
      await settle();
      expect(fetchLog.calls).toHaveLength(2);
      expect(shotIdsOf(fetchLog.calls[1]!)).toEqual([shot2]);
      expect(fetchLog.calls[1]!.atMs - fetchLog.calls[0]!.atMs).toBe(
        SYNC_RETRY_BASE_MS,
      );
    });

    it('after 10 prior 5xx failures (300 s cadence) a SUCCESSFUL held drain resets the counter: the in-flight-inserted rating waits 30 s, not 300 s', async () => {
      let mode: 'fail' | 'hold' | 'accept' = 'fail';
      fetchLog = installControlledFetch({
        autoRespond: call => {
          if (mode === 'fail') return jsonResponse(503, { error: null });
          if (mode === 'accept') return acceptAll(call);
          return null;
        },
      });
      establishApiSession(sessionA);
      setActiveDataOwner(ownerA);
      const db = getDb();
      const shot1 = uuidAt(0x55, 1);
      await saveAnalysis(db, { ...realAnalysis, id: shot1 }, uuidAt(0x9e, 1));

      configureSyncRuntime(sessionA);
      await settle();
      // 10 failing drains → consecutiveFailures = 10 → 300 s cadence.
      for (let i = 0; i < 10; i++) {
        jest.advanceTimersToNextTimer();
        await settle();
      }
      expect(fetchLog.calls).toHaveLength(11);

      // The 12th drain is held in flight; a rating lands meanwhile.
      mode = 'hold';
      jest.advanceTimersToNextTimer();
      await settle();
      expect(fetchLog.calls).toHaveLength(12);
      const shot2 = uuidAt(0x55, 2);
      await saveAnalysis(db, { ...realAnalysis, id: shot2 }, uuidAt(0x9e, 2));
      triggerOutboxSync();
      await settle();
      expect(fetchLog.calls).toHaveLength(12);

      mode = 'accept';
      const held = fetchLog.calls[11]!;
      held.respond.resolve(acceptAll(held));
      await settle();
      // Drain 12 succeeded → consecutiveFailures reset to 0 → 30 s, not
      // 300 s: the healthy schedule applies from here.
      const before = fetchLog.calls.length;
      jest.advanceTimersByTime(SYNC_RETRY_BASE_MS - 1);
      await settle();
      expect(fetchLog.calls).toHaveLength(before);
      jest.advanceTimersByTime(1);
      await settle();
      expect(fetchLog.calls).toHaveLength(before + 1);
      expect(shotIdsOf(fetchLog.calls[before]!)).toEqual([shot2]);
    });
  });

  describe('S5 — 20 consecutive 5xx drains, AppState silent', () => {
    it(`seeded (${SEED}) jitter: every delay is within its band, clamps at 300 s ±20 %, and attempts never burn`, async () => {
      const prng = seededRandom(SEED);
      (Math.random as jest.Mock).mockImplementation(prng);
      fetchLog = installControlledFetch({
        autoRespond: () =>
          jsonResponse(503, {
            error: { code: 'internal', message: 'try again' },
          }),
      });
      establishApiSession(sessionA);
      setActiveDataOwner(ownerA);
      const db = getDb();
      await saveAnalysis(db, realAnalysis, uuidAt(0x9e, 1));

      configureSyncRuntime(sessionA);
      await settle();
      expect(fetchLog.calls).toHaveLength(1);

      const delays: number[] = [];
      for (let i = 0; i < 20; i++) {
        expect(jest.getTimerCount()).toBe(1); // exactly one scheduled drain
        jest.advanceTimersToNextTimer();
        await settle();
        expect(fetchLog.calls).toHaveLength(i + 2);
        delays.push(fetchLog.calls[i + 1]!.atMs - fetchLog.calls[i]!.atMs);
      }

      // Recompute the exact schedule from the same seed: schedule() consumes
      // one random per drain, failures 1..20.
      const replay = seededRandom(SEED);
      const expected = Array.from({ length: 20 }, (_, i) =>
        nextSyncRetryDelayMs(i + 1, replay),
      );
      expect(delays).toEqual(expected);

      for (const [i, d] of delays.entries()) {
        const failures = i + 1;
        const base = Math.min(
          SYNC_RETRY_BASE_MS * 2 ** Math.min(failures, 10),
          SYNC_RETRY_MAX_MS,
        );
        expect(Number.isSafeInteger(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(
          Math.round(base * (1 - SYNC_RETRY_JITTER_RATIO)),
        );
        expect(d).toBeLessThanOrEqual(
          Math.round(base * (1 + SYNC_RETRY_JITTER_RATIO)),
        );
      }
      // From the 4th failure on the base is the 300 s ceiling.
      for (const d of delays.slice(3)) {
        expect(d).toBeGreaterThanOrEqual(240_000);
        expect(d).toBeLessThanOrEqual(360_000);
      }
      // No overflow past the exponent clamp: failures 11..20 use 2**10 caps.
      expect(Math.max(...delays)).toBeLessThanOrEqual(360_000);

      // Whole-request 5xx is transient: attempts stay 0 after 21 failures.
      const rows = await outboxRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.attempts).toBe(0);
      expect(rows[0]!.last_error).toContain('try again');
    });

    it('nextSyncRetryDelayMs never overflows for absurd failure counts and stays finite for every integer input', () => {
      const fixed = () => 1; // +20 % jitter, worst case
      for (const n of [10, 11, 64, 1024, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
        expect(nextSyncRetryDelayMs(n, fixed)).toBe(360_000);
      }
      expect(nextSyncRetryDelayMs(Number.POSITIVE_INFINITY, fixed)).toBe(
        360_000,
      );
      expect(nextSyncRetryDelayMs(-5, fixed)).toBe(36_000);
      // Documented sharp edge: a NaN failure count yields a NaN delay. The
      // runtime only ever passes integers, so this is unreachable today.
      expect(Number.isNaN(nextSyncRetryDelayMs(Number.NaN, fixed))).toBe(true);
    });
  });

  describe("S8 — generation swap while A's syncShots is pending", () => {
    it("A's late acceptance is receipted under owner A; B's drain runs concurrently and is untouched", async () => {
      fetchLog = installControlledFetch();
      establishApiSession(sessionA);
      setActiveDataOwner(ownerA);
      const db = getDb();
      const shotA = uuidAt(0x58, 0xa);
      await saveAnalysis(db, { ...realAnalysis, id: shotA }, uuidAt(0x9e, 0xa));
      configureSyncRuntime(sessionA);
      await settle();
      expect(fetchLog.calls).toHaveLength(1);
      expect(fetchLog.calls[0]!.authorization).toBe('Bearer access-token-A');

      // Sign-out / sign-in as B while A's request is in flight.
      clearSyncRuntime();
      clearApiSession();
      establishApiSession(sessionB);
      setActiveDataOwner(ownerB);
      const shotB = uuidAt(0x58, 0xb);
      await saveAnalysis(db, { ...realAnalysis, id: shotB }, uuidAt(0x9e, 0xb));
      configureSyncRuntime(sessionB);
      await settle();
      // B's generation is not blocked by A's still-running drain.
      expect(fetchLog.calls).toHaveLength(2);
      expect(fetchLog.calls[1]!.authorization).toBe('Bearer access-token-B');
      expect(shotIdsOf(fetchLog.calls[1]!)).toEqual([shotB]);

      // A's response lands late, after B is current.
      fetchLog.calls[0]!.respond.resolve(acceptAll(fetchLog.calls[0]!));
      await settle();
      expect(await receiptRows(db)).toEqual([
        { owner_key: ownerA, entity_id: shotA },
      ]);
      expect(await countRows(db, 'outbox', ownerA)).toBe(0);
      expect(await countRows(db, 'outbox', ownerB)).toBe(1);
      // A's stale finally must not clear or replace B's timer state: B's
      // request is still pending, so there is no drain timer at all yet
      // (only api.ts's 20 s request timeout for B).
      expect(fetchLog.calls).toHaveLength(2);

      fetchLog.calls[1]!.respond.resolve(acceptAll(fetchLog.calls[1]!));
      await settle();
      expect(await receiptRows(db)).toEqual([
        { owner_key: ownerA, entity_id: shotA },
        { owner_key: ownerB, entity_id: shotB },
      ]);
      expect(await countRows(db, 'outbox')).toBe(0);
      // Exactly one live schedule — B's. A's stale generation scheduled nothing.
      expect(jest.getTimerCount()).toBe(1);
      const shotB2 = uuidAt(0x58, 0xc);
      await saveAnalysis(
        db,
        { ...realAnalysis, id: shotB2 },
        uuidAt(0x9e, 0xc),
      );
      jest.advanceTimersByTime(SYNC_RETRY_BASE_MS);
      await settle();
      expect(fetchLog.calls).toHaveLength(3);
      expect(fetchLog.calls[2]!.authorization).toBe('Bearer access-token-B');
      expect(shotIdsOf(fetchLog.calls[2]!)).toEqual([shotB2]);
    });

    it("A's late REJECTION (5xx) after the swap does not bump B's failure counter: B keeps the 30 s cadence", async () => {
      fetchLog = installControlledFetch();
      establishApiSession(sessionA);
      setActiveDataOwner(ownerA);
      const db = getDb();
      await saveAnalysis(
        db,
        { ...realAnalysis, id: uuidAt(0x58, 1) },
        uuidAt(0x9e, 1),
      );
      configureSyncRuntime(sessionA);
      await settle();

      clearSyncRuntime();
      clearApiSession();
      establishApiSession(sessionB);
      setActiveDataOwner(ownerB);
      configureSyncRuntime(sessionB); // empty outbox for B → no request
      await settle();
      expect(fetchLog.calls).toHaveLength(1);

      fetchLog.calls[0]!.respond.resolve(jsonResponse(503, null));
      await settle();
      const rows = await outboxRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.owner_key).toBe(ownerA);
      expect(rows[0]!.attempts).toBe(0);

      await saveAnalysis(
        db,
        { ...realAnalysis, id: uuidAt(0x58, 2) },
        uuidAt(0x9e, 2),
      );
      jest.advanceTimersByTime(SYNC_RETRY_BASE_MS);
      await settle();
      expect(fetchLog.calls).toHaveLength(2);
      expect(fetchLog.calls[1]!.authorization).toBe('Bearer access-token-B');
    });
  });

  describe("S10 — purge while A's drain is pending (account-deletion ordering)", () => {
    it('the late acceptance re-inserts an A-owned sync_receipt after purgeOwnerData(A) completed', async () => {
      fetchLog = installControlledFetch();
      establishApiSession(sessionA);
      setActiveDataOwner(ownerA);
      const db = getDb();
      const shotA = uuidAt(0x5a, 1);
      await saveAnalysis(db, { ...realAnalysis, id: shotA }, uuidAt(0x9e, 1));
      configureSyncRuntime(sessionA);
      await settle();
      expect(fetchLog.calls).toHaveLength(1);

      // Deletion flow: stop the runtime, drop the session, purge the owner.
      clearSyncRuntime();
      clearApiSession();
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      await purgeOwnerData(db, ownerA);
      expect(await countRows(db, 'outbox', ownerA)).toBe(0);
      expect(await countRows(db, 'local_shot', ownerA)).toBe(0);
      expect(await countRows(db, 'sync_receipt', ownerA)).toBe(0);

      fetchLog.calls[0]!.respond.resolve(acceptAll(fetchLog.calls[0]!));
      await settle();

      // Observed residue after a "complete" purge.
      const residue = await receiptRows(db);
      expect(residue).toEqual([{ owner_key: ownerA, entity_id: shotA }]);
      expect(await countRows(db, 'outbox', ownerA)).toBe(0);
    });
  });
});
