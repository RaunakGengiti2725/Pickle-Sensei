/**
 * W04-04 adversarial tests — the device drain of `POST /v1/offline/receipts`
 * at its network-failure and answer-shape boundaries.
 *
 * Every scenario attacks the contract the wallet relies on: one verdict per
 * submitted receipt, in submitted order, or ONE failure for the whole
 * presentation (the journal stays in flight, the same ids are re-presented).
 * No partial verdict list may ever be returned, and no answer the device did
 * not ask for may be applied.
 */
import {
  ApiError,
  OFFLINE_RECEIPT_REQUEST_BUDGET_BYTES,
  createOfflineGrantClient,
} from '../src/data/api';
import type { OfflineReceiptSubmission } from '../src/data/api';

const OWNER = '11111111-1111-4111-8111-111111111111';
const ISSUER = 'https://api.example.test/functions/v1/api';
const ROUTE_BODY_CAP_BYTES = 2_000_000;

function uuidFrom(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(4, '0')}-4000-8000-${String(n).padStart(12, '0')}`;
}

function receipt(
  n: number,
  installationKeyId = 'ios-install-key-1',
): OfflineReceiptSubmission {
  return {
    receiptId: uuidFrom('aaaaaaaa', n),
    ownerId: OWNER,
    installationKeyId,
    grantId: uuidFrom('bbbbbbbb', 1),
    grantJwsSha256: 'c'.repeat(64),
    lifecycleSequence: n,
    ticket: {
      allocationId: uuidFrom('dddddddd', 1),
      generation: 1,
      ticketId: uuidFrom('eeeeeeee', n),
    },
    operationId: uuidFrom('ffffffff', n),
    resultId: uuidFrom('99999999', n),
    fullOutputSha256: 'f'.repeat(64),
    billingDisposition: 'joint_verification_required',
    queuedAt: new Date(1_800_000_000_000 + n * 1000).toISOString(),
  };
}

/** A queue that the client must cut into at least three requests. */
function threeChunkQueue(): OfflineReceiptSubmission[] {
  const receipts: OfflineReceiptSubmission[] = [];
  let bytes = 0;
  for (let n = 1; bytes <= OFFLINE_RECEIPT_REQUEST_BUDGET_BYTES * 2.2; n += 1) {
    const next = receipt(n);
    receipts.push(next);
    bytes += Buffer.byteLength(JSON.stringify(next)) + 1;
  }
  return receipts;
}

interface Posted {
  readonly bytes: number;
  readonly receiptIds: readonly string[];
}

type Answer = (index: number, receiptIds: readonly string[]) => Response;

const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });

const settledAll = (receiptIds: readonly string[]) =>
  ok({
    receipts: receiptIds.map(receiptId => ({
      receiptId,
      status: 'result_recorded',
    })),
    rejected: [],
  });

function routeStandIn(posts: Posted[], answer: Answer) {
  return jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (_input, init) => {
      const raw = String(init?.body);
      const body = JSON.parse(raw) as {
        receipts: readonly OfflineReceiptSubmission[];
      };
      const receiptIds = body.receipts.map(entry => entry.receiptId);
      posts.push({ bytes: Buffer.byteLength(raw), receiptIds });
      return answer(posts.length - 1, receiptIds);
    });
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const thrown = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(ApiError);
  return thrown as ApiError;
}

describe('W04-04 attack: the receipt drain at its network-failure boundaries', () => {
  const client = createOfflineGrantClient({
    baseUrl: ISSUER,
    token: 'access-token',
  });

  it('attack K1: 429 + Retry-After on the SECOND request fails the whole presentation with the 429 — nothing after it is sent, no verdict from the first request leaks', async () => {
    const queue = threeChunkQueue();
    const posts: Posted[] = [];
    const spy = routeStandIn(posts, (index, ids) =>
      index === 1
        ? new Response(
            JSON.stringify({
              error: { code: 'rate_limited', message: 'Too many requests.' },
            }),
            {
              status: 429,
              headers: {
                'content-type': 'application/json',
                'retry-after': '30',
              },
            },
          )
        : settledAll(ids),
    );
    try {
      const error = await failure(client.submitReceipts(queue));
      expect(error.status).toBe(429);
      expect(error.code).toBe('rate_limited');
      expect(posts.length).toBe(2);
      expect(
        posts[0]!.receiptIds.length + posts[1]!.receiptIds.length,
      ).toBeLessThan(queue.length);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    [
      'redirect (302 to another host)',
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://elsewhere.example/receipts' },
        }),
      'network.redirected',
    ],
    [
      '500 without a coded body',
      () =>
        new Response('<html>Internal Server Error</html>', {
          status: 500,
          headers: { 'content-type': 'text/html' },
        }),
      'unknown',
    ],
    [
      '200 with an HTML body',
      () =>
        new Response('<html>ok</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      'network.invalid_response',
    ],
    ['200 with a JSON array', () => ok([]), 'network.invalid_response'],
  ])(
    'attack K2: a first request answered by %s fails the presentation and sends nothing further',
    async (_label, respond, code) => {
      const queue = threeChunkQueue();
      const posts: Posted[] = [];
      const spy = routeStandIn(posts, (index, ids) =>
        index === 0 ? respond() : settledAll(ids),
      );
      try {
        const error = await failure(client.submitReceipts(queue));
        expect(error.code).toBe(code);
        expect(posts.length).toBe(1);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('attack K3: a 200 whose verdicts name a receipt from ANOTHER chunk (the route answered the wrong request) is refused — no verdict is applied to an id that was not in that request', async () => {
    const queue = threeChunkQueue();
    const posts: Posted[] = [];
    const spy = routeStandIn(posts, (index, ids) => {
      if (index !== 1) return settledAll(ids);
      // Answer the second chunk with the FIRST chunk's ids (same count).
      return settledAll(posts[0]!.receiptIds.slice(0, ids.length));
    });
    try {
      const error = await failure(client.submitReceipts(queue));
      expect(error.code).toBe('network.invalid_response');
      expect(posts.length).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    [
      'one verdict missing',
      (ids: readonly string[]) =>
        ok({
          receipts: ids.slice(1).map(receiptId => ({
            receiptId,
            status: 'result_recorded',
          })),
          rejected: [],
        }),
    ],
    [
      'one extra verdict for an id never sent',
      (ids: readonly string[]) =>
        ok({
          receipts: [...ids, uuidFrom('deadbeef', 1)].map(receiptId => ({
            receiptId,
            status: 'result_recorded',
          })),
          rejected: [],
        }),
    ],
    [
      'the same id both settled and rejected',
      (ids: readonly string[]) =>
        ok({
          receipts: ids.map(receiptId => ({
            receiptId,
            status: 'result_recorded',
          })),
          rejected: [
            { receiptId: ids[0], code: 'offline.invalid_input', message: 'x' },
          ],
        }),
    ],
    [
      'an unknown status word',
      (ids: readonly string[]) =>
        ok({
          receipts: ids.map(receiptId => ({ receiptId, status: 'refunded' })),
          rejected: [],
        }),
    ],
    [
      'rejected entries without a code',
      (ids: readonly string[]) =>
        ok({
          receipts: [],
          rejected: ids.map(receiptId => ({ receiptId, message: 'nope' })),
        }),
    ],
  ])(
    'attack K4: an answer with %s is refused as unreadable (nothing applied, whole presentation retried)',
    async (_label, respond) => {
      const queue = [receipt(1), receipt(2), receipt(3)];
      const posts: Posted[] = [];
      const spy = routeStandIn(posts, (_index, ids) => respond(ids));
      try {
        const error = await failure(client.submitReceipts(queue));
        expect(error.code).toBe('network.invalid_response');
        expect(posts.length).toBe(1);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('attack K5: a single receipt larger than the request budget travels ALONE (never dropped, never an endless loop) and the small neighbours keep their order', async () => {
    const huge = receipt(
      2,
      'k'.repeat(OFFLINE_RECEIPT_REQUEST_BUDGET_BYTES + 10),
    );
    const queue = [receipt(1), huge, receipt(3)];
    const posts: Posted[] = [];
    const spy = routeStandIn(posts, (_index, ids) => settledAll(ids));
    try {
      const verdicts = await client.submitReceipts(queue);
      expect(verdicts.map(v => v.receiptId)).toEqual(
        queue.map(entry => entry.receiptId),
      );
      expect(posts.map(post => post.receiptIds)).toEqual([
        [queue[0]!.receiptId],
        [huge.receiptId],
        [queue[2]!.receiptId],
      ]);
      expect(posts[1]!.bytes).toBeGreaterThan(
        OFFLINE_RECEIPT_REQUEST_BUDGET_BYTES,
      );
      expect(posts[1]!.bytes).toBeLessThan(ROUTE_BODY_CAP_BYTES);
    } finally {
      spy.mockRestore();
    }
  });

  it('attack K6: every chunk stays under the budget even when receipts are multi-byte heavy and each one sits just under the boundary', async () => {
    // Each receipt ≈ 1/3 of the budget in UTF-8 bytes (4-byte code points).
    const third =
      Math.floor(OFFLINE_RECEIPT_REQUEST_BUDGET_BYTES / 3 / 4) - 200;
    const queue = Array.from({ length: 7 }, (_, i) =>
      receipt(i + 1, '🔑'.repeat(third)),
    );
    const posts: Posted[] = [];
    const spy = routeStandIn(posts, (_index, ids) => settledAll(ids));
    try {
      const verdicts = await client.submitReceipts(queue);
      expect(verdicts.map(v => v.receiptId)).toEqual(
        queue.map(entry => entry.receiptId),
      );
      for (const post of posts) {
        expect(post.bytes).toBeLessThanOrEqual(
          OFFLINE_RECEIPT_REQUEST_BUDGET_BYTES,
        );
      }
      expect(posts.flatMap(post => post.receiptIds)).toEqual(
        queue.map(entry => entry.receiptId),
      );
      expect(posts.length).toBeGreaterThan(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('attack K7: a signed-out client never sends a receipt', async () => {
    const signedOut = createOfflineGrantClient({ baseUrl: ISSUER, token: '' });
    const posts: Posted[] = [];
    const spy = routeStandIn(posts, (_index, ids) => settledAll(ids));
    try {
      const error = await failure(signedOut.submitReceipts([receipt(1)]));
      expect(error.code).toBe('auth.required');
      expect(posts).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
