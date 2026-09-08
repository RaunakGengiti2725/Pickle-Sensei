/**
 * INT-networking-recovery adversarial probe — hostile response bodies on the
 * offline→online path.
 *
 * The moment an iPhone comes back online it frequently is NOT talking to the
 * API yet: hotel / airport captive portals answer `200 text/html` to every
 * URL, gateways answer `502 text/html`, and the edge itself answers `413` to
 * an oversized batch. This probe drives the REAL outbox drain
 * (`drainOutbox` → `createTransport` → `fetch`) against those bodies and
 * checks that durable local work is neither dropped nor falsely receipted:
 *
 *   - a 200 whose body is NOT the API's JSON must never be mistaken for a
 *     server acknowledgement (shots: control; session create/finalize: the
 *     client treats any 2xx as delivered — only a TLS-terminating middlebox or
 *     the gateway itself can produce this for an HTTPS origin, and a lost
 *     session.create is later reconstructed from the shot's local metadata,
 *     so the report grades this as minor);
 *   - a non-JSON 5xx stays transient (no attempt burned, no parser error as the
 *     stored reason);
 *   - offline → online drains the queue once connectivity returns;
 *   - a whole-request 413 caused by ONE oversized (corrupt) persisted row must
 *     not dead-letter the healthy rows queued beside it. The edge caps a
 *     legitimate shot (≤64 checkpoints, ≤64-char keys), so only a corrupted
 *     row can push a 50-row batch past MAX_JSON_BODY_BYTES (5 000 000).
 *
 * Runs on Linux/Jest with the in-memory LocalDb; no device, no production.
 */
import { getDb } from '../../src/data/db';
import { createTransport } from '../../src/data/api';
import { OUTBOX_MAX_ATTEMPTS, drainOutbox } from '../../src/data/sync';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  createFakeLocalDb,
  type FakeLocalDb,
} from '../../testing/xcBehavioral/fakeLocalDb';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

const USER_A = '11111111-1111-4111-8111-111111111111';
const ownerA = canonicalDataOwner(USER_A);
const API = 'https://api.test';

function shotPayload(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    sessionId: null,
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
    ...extra,
  };
}

const CAPTIVE_PORTAL_HTML =
  '<!DOCTYPE html><html><head><title>Wi-Fi Login</title></head><body><form action="/login">Accept terms</form></body></html>';

function html(status: number, body = CAPTIVE_PORTAL_HTML): Response {
  return new Response(body, {
    status,
    statusText: status === 200 ? 'OK' : 'Bad Gateway',
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Hit {
  path: string;
  body: string | null;
}

describe('ADV networking-recovery: hostile bodies on the offline→online path', () => {
  const originalFetch = globalThis.fetch;
  let fake: FakeLocalDb;
  let hits: Hit[];
  let respond: (hit: Hit) => Response | Promise<Response>;

  beforeEach(() => {
    fake = createFakeLocalDb();
    hits = [];
    (getDb as jest.Mock).mockReturnValue(fake.db);
    globalThis.fetch = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const hit: Hit = {
          path: new URL(String(input)).pathname,
          body: typeof init?.body === 'string' ? init.body : null,
        };
        hits.push(hit);
        return respond(hit);
      },
    ) as unknown as typeof fetch;
    setActiveDataOwner(ownerA);
  });

  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const transport = () => createTransport({ baseUrl: API, token: 'bearer-a' });

  it('captive portal 200 text/html on /v1/shots:sync → no receipt, row durable, no attempt burned (control)', async () => {
    respond = () => html(200);
    fake.push('shot.sync', shotPayload('shot-1'), ownerA);
    const result = await drainOutbox(fake.db, transport());
    expect(hits.map(h => h.path)).toEqual(['/v1/shots:sync']);
    expect(result.synced).toBe(0);
    expect(fake.receipts).toHaveLength(0);
    expect(fake.outbox).toHaveLength(1);
    expect(fake.outbox[0]!.attempts).toBe(0);
  });

  it('non-API 200 text/html on POST /v1/sessions → the session.create row is NOT treated as delivered', async () => {
    respond = () => html(200);
    fake.push(
      'session.create',
      { id: 'sess-1', mode: 'practice', startedAt: '2026-08-30T10:00:00.000Z' },
      ownerA,
    );
    const result = await drainOutbox(fake.db, transport());
    expect(hits.map(h => h.path)).toEqual(['/v1/sessions']);
    expect(result.synced).toBe(0);
    expect(fake.outbox.map(row => row.kind)).toEqual(['session.create']);
  });

  it('non-API 200 text/html on POST /v1/sessions/:id/finalize → the finalize row is NOT treated as delivered', async () => {
    respond = () => html(200);
    fake.push('session.finalize', { id: 'sess-1' }, ownerA);
    const result = await drainOutbox(fake.db, transport());
    expect(hits.map(h => h.path)).toEqual(['/v1/sessions/sess-1/finalize']);
    expect(result.synced).toBe(0);
    expect(fake.outbox.map(row => row.kind)).toEqual(['session.finalize']);
  });

  it('gateway 502 text/html → transient: no attempt burned, stored reason is not a JSON parser error', async () => {
    respond = () => html(502, '<html><body>502 Bad Gateway</body></html>');
    fake.push('shot.sync', shotPayload('shot-1'), ownerA);
    fake.push('session.create', { id: 'sess-2', mode: 'practice' }, ownerA);
    await drainOutbox(fake.db, transport());
    expect(fake.outbox).toHaveLength(2);
    for (const row of fake.outbox) {
      expect(row.attempts).toBe(0);
      expect(row.repair_reason).toBeNull();
      expect(String(row.last_error)).not.toMatch(
        /SyntaxError|Unexpected token/,
      );
    }
  });

  it('offline → online: rows failed with a network error keep their budget and drain fully once fetch works again', async () => {
    respond = () => Promise.reject(new TypeError('Network request failed'));
    fake.push('shot.sync', shotPayload('shot-1'), ownerA);
    fake.push('shot.sync', shotPayload('shot-2'), ownerA);
    for (let i = 0; i < 3; i += 1) await drainOutbox(fake.db, transport());
    expect(fake.outbox).toHaveLength(2);
    expect(fake.outbox.every(row => row.attempts === 0)).toBe(true);
    respond = hit => {
      const sent = JSON.parse(hit.body ?? '{}') as {
        shots: Array<{ id: string }>;
      };
      return json(200, {
        acceptedIds: sent.shots.map(s => s.id),
        rejected: [],
      });
    };
    const online = await drainOutbox(fake.db, transport());
    expect(online.synced).toBe(2);
    expect(fake.outbox).toHaveLength(0);
    expect(fake.receipts.map(r => r.entityId).sort()).toEqual([
      'shot-1',
      'shot-2',
    ]);
  });

  it(`one oversized row that makes the whole batch a 413 must not dead-letter the healthy rows beside it after ${OUTBOX_MAX_ATTEMPTS} drains`, async () => {
    const LIMIT = 5_000_000;
    let oversizedRequests = 0;
    respond = hit => {
      if ((hit.body?.length ?? 0) > LIMIT) {
        oversizedRequests += 1;
        return json(413, { error: { message: 'Request body is too large.' } });
      }
      return json(200, {
        acceptedIds: (
          JSON.parse(hit.body ?? '{}') as { shots: Array<{ id: string }> }
        ).shots.map(s => s.id),
        rejected: [],
      });
    };
    fake.push('shot.sync', shotPayload('shot-good-1'), ownerA);
    fake.push(
      'shot.sync',
      shotPayload('shot-huge', {
        // Corrupted persisted row: the projection forwards `key` verbatim.
        checkpoints: Array.from({ length: 2_000 }, (_, i) => ({
          key: `cp-${i}-${'x'.repeat(3_000)}`,
          score: 50,
        })),
      }),
      ownerA,
    );
    fake.push('shot.sync', shotPayload('shot-good-2'), ownerA);
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
      await drainOutbox(fake.db, transport());
    }
    expect(oversizedRequests).toBe(OUTBOX_MAX_ATTEMPTS);
    const healthy = fake.outbox.filter(
      row => !row.payload.includes('shot-huge'),
    );
    const receipted = fake.receipts.map(r => r.entityId);
    // Exact state after the budget is spent, for the report.
    const observed = {
      receipted: receipted.sort(),
      healthyAttempts: healthy.map(row => row.attempts),
      oversizedAttempts: fake.outbox
        .filter(row => row.payload.includes('shot-huge'))
        .map(row => row.attempts),
    };
    // Healthy rows either synced or are still eligible for a future drain —
    // never dead-lettered (attempts == OUTBOX_MAX_ATTEMPTS, no receipt).
    expect(observed).toEqual({
      receipted: ['shot-good-1', 'shot-good-2'],
      healthyAttempts: [],
      oversizedAttempts: [OUTBOX_MAX_ATTEMPTS],
    });
  });
});
