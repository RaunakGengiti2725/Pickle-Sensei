/**
 * INT-offline-lease adversary — CLIENT half of the offline allocation story
 * at integration HEAD 30a4065. The Postgres suite
 * (supabase/functions/api/__wf__/xc_pg_offline_lease_adversary.test.ts) shows
 * what the server does to a scored result whose reservation aged past the
 * 24 h accounting window; this suite asks what the DEVICE does with the
 * server's answer and with an account switch while that answer is in flight.
 *
 *   OL-MB-1  late sync refused with `access.paywall_required` (server-side
 *            reclaim of a disconnected device's allocation): the executed
 *            rating must never be deleted, must never gain a receipt, and
 *            must end in a durable, VISIBLE needs-attention state — not a
 *            silent drop and not an infinite retry.
 *   OL-MB-2  account switch while the sync request is in flight: the answer
 *            for owner A's rating arrives after owner B became active. The
 *            receipt/delete must not land in either bucket; A's row stays
 *            durable and is re-sent when A returns (server idempotent).
 *   OL-MB-3  the SAME transient answer repeated well past the permanent
 *            budget never exhausts the row (a disconnected device is never
 *            auto-reclaimed by its own retry counter).
 */
import {
  DataOwnerChangedError,
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { ApiError } from '../../src/data/api';
import { deriveUploadQueueStatus } from '../../src/data/offlineCapabilities';
import {
  drainOutbox,
  OUTBOX_MAX_ATTEMPTS,
  type SyncTransport,
} from '../../src/data/sync';
import { createFakeOutboxDb } from '../../__harness__/serverResponseMatrix/outboxFakeDb';

const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SHOT_A = '11111111-1111-4111-8111-111111111111';
const SHOT_B = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const PERMIT_ID = '44444444-4444-4444-8444-444444444444';

const scoredShot = (id: string) => ({
  id,
  analysisPermitId: PERMIT_ID,
  sessionId: SESSION_ID,
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-09-01T18:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
  phases: [],
  measurements: [],
  checkpoints: [],
  overallScore: 7.4,
  analysisConfidence: 0.9,
  resultKind: 'scored',
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'test-native-1',
    poseModelVersion: 'test-pose-1',
    paddleModelVersion: 'test-paddle-1',
    strokeDetectorVersion: 'test-stroke-1',
    phaseModelVersion: 'test-phase-1',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
});

const unusedTransport: Pick<
  SyncTransport,
  'createSession' | 'finalizeSession'
> = {
  createSession: async () => {
    throw new Error('adv: no session rows in this fixture');
  },
  finalizeSession: async () => {
    throw new Error('adv: no session rows in this fixture');
  },
};

afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('INT-offline-lease client (HEAD 30a4065)', () => {
  test('OL-MB-1 a server that reclaims a disconnected allocation (`access.paywall_required` on late sync) leaves the executed rating durable, receipt-free and visibly needing attention', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    const fake = createFakeOutboxDb();
    fake.push('shot.sync', scoredShot(SHOT_A), GUEST_DATA_OWNER);
    const sent: unknown[][] = [];
    const transport: SyncTransport = {
      ...unusedTransport,
      syncShots: async shots => {
        sent.push(shots);
        return {
          acceptedIds: [],
          rejected: [
            {
              id: SHOT_A,
              code: 'access.paywall_required',
              message: 'Free ratings used. Upgrade to continue.',
            },
          ],
        };
      },
    };

    const trace: Array<{
      drain: number;
      attempts: number;
      sentThisDrain: number;
    }> = [];
    for (let drain = 1; drain <= OUTBOX_MAX_ATTEMPTS + 3; drain++) {
      const before = sent.length;
      await drainOutbox(fake.db, transport);
      trace.push({
        drain,
        attempts: fake.outbox[0]?.attempts ?? -1,
        sentThisDrain: sent.length - before,
      });
    }

    // The rating is never deleted and never receives a receipt.
    expect(fake.outbox).toHaveLength(1);
    expect(fake.receipts).toEqual([]);
    const row = fake.outbox[0];
    if (!row) throw new Error('adv: the executed rating row was deleted');
    expect(row.owner_key).toBe(GUEST_DATA_OWNER);
    expect(JSON.parse(row.payload)).toMatchObject({
      id: SHOT_A,
      resultKind: 'scored',
      analysisPermitId: PERMIT_ID,
    });
    // The budget is spent exactly once per refusal and then the row leaves the
    // drain (no unbounded re-sends, no silent disappearance).
    expect(row.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(sent).toHaveLength(OUTBOX_MAX_ATTEMPTS);
    expect(
      trace.slice(OUTBOX_MAX_ATTEMPTS).every(t => t.sentThisDrain === 0),
    ).toBe(true);
    expect(row.last_error).toContain('access.paywall_required');
    // The derived queue status the UI reads from durable rows says so.
    expect(
      deriveUploadQueueStatus(
        fake.outbox.map(r => ({
          kind: r.kind,
          attempts: r.attempts,
          lastError: r.last_error,
        })),
      ),
    ).toEqual({ state: 'needs_attention', pending: 0, exhausted: 1 });
  });

  test('OL-MB-2 an account switch while the sync answer is in flight lands the receipt in neither bucket; A keeps its row and re-sends the same id when A returns', async () => {
    setActiveDataOwner(OWNER_A);
    const fake = createFakeOutboxDb();
    fake.push('shot.sync', scoredShot(SHOT_A), OWNER_A);
    fake.push('shot.sync', scoredShot(SHOT_B), OWNER_B);
    const sent: Array<{ owner: string; ids: unknown[] }> = [];
    let switchDuringFlight = true;
    const transport: SyncTransport = {
      ...unusedTransport,
      syncShots: async shots => {
        const ids = shots.map(s => (s as { id: unknown }).id);
        sent.push({ owner: 'request', ids });
        if (switchDuringFlight) {
          switchDuringFlight = false;
          // The user signs into B while A's request is on the wire.
          setActiveDataOwner(OWNER_B);
        }
        return { acceptedIds: ids.map(String), rejected: [] };
      },
    };

    let thrown: unknown = null;
    try {
      await drainOutbox(fake.db, transport);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DataOwnerChangedError);
    expect(sent).toEqual([{ owner: 'request', ids: [SHOT_A] }]);
    // Nothing was written into either owner's bucket on the stale answer.
    expect(fake.receipts).toEqual([]);
    expect(
      fake.outbox.map(r => [r.owner_key, JSON.parse(r.payload).id, r.attempts]),
    ).toEqual([
      [OWNER_A, SHOT_A, 0],
      [OWNER_B, SHOT_B, 0],
    ]);

    // B's drain touches only B's row.
    await drainOutbox(fake.db, transport);
    expect(fake.receipts).toEqual([
      { owner: OWNER_B, kind: 'shot.sync', entityId: SHOT_B },
    ]);
    expect(fake.outbox.map(r => r.owner_key)).toEqual([OWNER_A]);

    // A returns: the same id is re-sent (the server's idempotent sync
    // answers "accepted" again) and only then does A's receipt exist.
    setActiveDataOwner(OWNER_A);
    await drainOutbox(fake.db, transport);
    expect(sent.map(s => s.ids)).toEqual([[SHOT_A], [SHOT_B], [SHOT_A]]);
    expect(fake.receipts).toEqual([
      { owner: OWNER_B, kind: 'shot.sync', entityId: SHOT_B },
      { owner: OWNER_A, kind: 'shot.sync', entityId: SHOT_A },
    ]);
    expect(fake.outbox).toEqual([]);
  });

  test('OL-MB-3 slow / unreachable server for 5x the permanent budget never exhausts a durable rating; the first real answer syncs it', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    const fake = createFakeOutboxDb();
    fake.push('shot.sync', scoredShot(SHOT_A), GUEST_DATA_OWNER);
    const outages: unknown[] = [
      new ApiError(408, 'network.timeout', 'timeout'),
      new ApiError(503, 'server.unavailable', 'unavailable'),
      new ApiError(429, 'rate_limited', 'rate limited'),
      new ApiError(401, 'auth.session_expired', 'session expired'),
      new TypeError('Network request failed'),
    ];
    let calls = 0;
    const transport: SyncTransport = {
      ...unusedTransport,
      syncShots: async () => {
        calls++;
        if (calls <= OUTBOX_MAX_ATTEMPTS * 5) {
          throw outages[calls % outages.length];
        }
        return { acceptedIds: [SHOT_A], rejected: [] };
      },
    };
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS * 5; i++) {
      const result = await drainOutbox(fake.db, transport);
      expect(result).toEqual({ synced: 0, failed: 1, remaining: 1 });
      expect(fake.outbox[0]?.attempts).toBe(0);
    }
    expect(fake.receipts).toEqual([]);
    const result = await drainOutbox(fake.db, transport);
    expect(result).toEqual({ synced: 1, failed: 0, remaining: 0 });
    expect(fake.receipts).toEqual([
      { owner: GUEST_DATA_OWNER, kind: 'shot.sync', entityId: SHOT_A },
    ]);
  });
});
