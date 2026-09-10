/**
 * W04-04 — queue liveness for the device drain of `POST /v1/offline/receipts`.
 *
 * The route refuses a request body over its byte cap wholesale (413), and the
 * wallet presents EVERY unsettled receipt of a drain through one
 * `submitReceipts` call. A week offline on a Pro lease queues more than the
 * cap; if the client sent that as a single POST every drain would be refused
 * identically and nothing would ever settle. The client must therefore cut a
 * presentation into requests the route accepts while keeping the contract the
 * wallet relies on: one verdict per submitted receipt, in submitted order, or
 * a single failure for the whole presentation (the journal stays in flight and
 * the SAME receipt ids are re-presented — the route replays durable verdicts).
 */
import { ApiError, createOfflineGrantClient } from '../src/data/api';
import type { OfflineReceiptSubmission } from '../src/data/api';

const OWNER = '11111111-1111-4111-8111-111111111111';
const ISSUER = 'https://api.example.test/functions/v1/api';
const RECEIPTS_URL = `${ISSUER}/v1/offline/receipts`;
/** The route's request-body cap (index.ts OFFLINE_RECEIPT_BATCH_BODY_BYTES). */
const ROUTE_BODY_CAP_BYTES = 2_000_000;

function uuidFrom(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
}

function receipt(n: number, ticket: boolean): OfflineReceiptSubmission {
  return {
    receiptId: uuidFrom('aaaaaaaa', n),
    ownerId: OWNER,
    installationKeyId: 'ios-install-key-1',
    grantId: uuidFrom('bbbbbbbb', Math.ceil(n / 50)),
    grantJwsSha256: 'c'.repeat(64),
    lifecycleSequence: n,
    ticket: ticket
      ? {
          allocationId: uuidFrom('dddddddd', Math.ceil(n / 50)),
          generation: 1,
          ticketId: uuidFrom('eeeeeeee', n),
        }
      : null,
    operationId: uuidFrom('ffffffff', n),
    resultId: uuidFrom('99999999', n),
    fullOutputSha256: 'f'.repeat(64),
    billingDisposition: 'joint_verification_required',
    queuedAt: new Date(1_800_000_000_000 + n * 1000).toISOString(),
  };
}

/** Enough receipts that their single-POST body would cross the route cap. */
function oversizedQueue(): OfflineReceiptSubmission[] {
  const receipts: OfflineReceiptSubmission[] = [];
  let bytes = Buffer.byteLength(JSON.stringify({ receipts: [] }));
  for (let n = 1; bytes <= ROUTE_BODY_CAP_BYTES * 1.2; n += 1) {
    const next = receipt(n, n % 3 !== 0);
    receipts.push(next);
    bytes += Buffer.byteLength(JSON.stringify(next)) + 1;
  }
  return receipts;
}

interface Posted {
  readonly bytes: number;
  readonly receiptIds: readonly string[];
}

/** Stand-in for the route: enforces the body cap exactly like the Edge
 * (413 before any receipt is looked at), otherwise answers every presented
 * receipt `result_recorded`. `answer` lets a scenario fail one request. */
function routeStandIn(
  posts: Posted[],
  answer: (index: number) => Response | null = () => null,
) {
  return jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      expect(String(input)).toBe(RECEIPTS_URL);
      expect(init?.method).toBe('POST');
      const raw = String(init?.body);
      const bytes = Buffer.byteLength(raw);
      const body = JSON.parse(raw) as {
        receipts: readonly OfflineReceiptSubmission[];
      };
      const receiptIds = body.receipts.map(entry => entry.receiptId);
      posts.push({ bytes, receiptIds });
      if (bytes > ROUTE_BODY_CAP_BYTES) {
        return new Response(
          JSON.stringify({ error: { message: 'Request body is too large.' } }),
          { status: 413, headers: { 'content-type': 'application/json' } },
        );
      }
      const scripted = answer(posts.length - 1);
      if (scripted !== null) return scripted;
      return new Response(
        JSON.stringify({
          receipts: receiptIds.map(receiptId => ({
            receiptId,
            status: 'result_recorded',
          })),
          rejected: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
}

describe('W04-04 mobile drain of an oversized receipt queue', () => {
  const client = createOfflineGrantClient({
    baseUrl: ISSUER,
    token: 'access-token',
  });

  it('a queue whose single body would exceed the route cap is presented in requests the route accepts — every receipt named once, verdicts in submitted order', async () => {
    const queue = oversizedQueue();
    expect(
      Buffer.byteLength(JSON.stringify({ receipts: queue })),
    ).toBeGreaterThan(ROUTE_BODY_CAP_BYTES);
    const posts: Posted[] = [];
    const fetchSpy = routeStandIn(posts);
    try {
      const verdicts = await client.submitReceipts(queue);
      expect(verdicts).toEqual(
        queue.map(entry => ({
          receiptId: entry.receiptId,
          verdict: 'accepted',
          code: 'result_recorded',
        })),
      );
      expect(posts.length).toBeGreaterThan(1);
      for (const post of posts) {
        expect(post.bytes).toBeLessThanOrEqual(ROUTE_BODY_CAP_BYTES);
        expect(post.receiptIds.length).toBeGreaterThan(0);
      }
      expect(posts.flatMap(post => post.receiptIds)).toEqual(
        queue.map(entry => entry.receiptId),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('a small queue is still one request — the drain is not cut below what the route accepts', async () => {
    const queue = Array.from({ length: 40 }, (_, i) => receipt(i + 1, true));
    const posts: Posted[] = [];
    const fetchSpy = routeStandIn(posts);
    try {
      const verdicts = await client.submitReceipts(queue);
      expect(verdicts.map(v => v.receiptId)).toEqual(
        queue.map(entry => entry.receiptId),
      );
      expect(posts.map(post => post.receiptIds.length)).toEqual([40]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('a request the route cannot answer fails the whole presentation — no partial verdict list, the same ids are re-presented next drain', async () => {
    const queue = oversizedQueue();
    const posts: Posted[] = [];
    const fetchSpy = routeStandIn(posts, index =>
      index === 1
        ? new Response(
            JSON.stringify({ error: { message: 'Service unavailable.' } }),
            { status: 503, headers: { 'content-type': 'application/json' } },
          )
        : null,
    );
    try {
      const error = await client.submitReceipts(queue).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(503);
      expect(posts.length).toBe(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('a duplicate receipt id is refused before anything is sent, however large the queue', async () => {
    const queue = oversizedQueue();
    const posts: Posted[] = [];
    const fetchSpy = routeStandIn(posts);
    try {
      const error = await client
        .submitReceipts([...queue, queue[0]!])
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('offline.receipt_duplicate');
      expect(posts).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
