import { createDeletionOperationTransport } from '../src/account/deletionOperationTransport';
import {
  DELETION_CAPABILITY,
  DELETION_ORIGIN,
  DELETION_OWNER_B,
  DELETION_SESSION,
  deferredDeletion,
  deletionCompletionPayload,
  deletionFixture,
  deletionId,
  deletionKeychainStore,
  deletionRequestPayload,
  deletionResponse,
  deletionSecretRecord,
  deletionStatusPayload,
} from '../testSupport/deletionOperationFixture';
import { closeSqliteTestDatabases } from '../testSupport/sqlite';

beforeEach(() => deletionKeychainStore.clear());
afterEach(() => {
  jest.useRealTimers();
  closeSqliteTestDatabases();
});

function transportFixture(timeoutMs = 15_000) {
  const fixture = deletionFixture();
  const transport = createDeletionOperationTransport({
    runtime: fixture.runtime,
    http: fixture.http,
    now: () => fixture.clock.now,
    timeoutMs,
  });
  const context = transport.captureOwner();
  if (!context) throw new Error('Expected a trusted owner context.');
  return { ...fixture, transport, context };
}

test('uses current request/confirm contracts and never takes origin from a bearer or request body', async () => {
  const f = transportFixture();
  expect(await f.transport.request(f.context)).toEqual({
    kind: 'requested',
    request: deletionRequestPayload(),
  });
  expect(f.http.fetchNoRedirect).toHaveBeenLastCalledWith(
    `${DELETION_ORIGIN}/v1/me/delete-request`,
    expect.objectContaining({
      method: 'POST',
      body: '{}',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: expect.objectContaining({
        Authorization: `Bearer ${DELETION_SESSION}`,
      }),
    }),
  );
  f.http.fetchNoRedirect.mockResolvedValue(
    deletionResponse(deletionCompletionPayload(), 200, 'delete-confirm'),
  );
  expect(
    await f.transport.confirm(f.context, deletionSecretRecord()),
  ).toMatchObject({
    kind: 'completed',
    receipt: {
      completedAt: deletionCompletionPayload().completionReceipt.completedAt,
      appleAuthorizationRevocation: 'manual_action_required',
    },
  });
  const [url, init] = f.http.fetchNoRedirect.mock.calls[1]!;
  expect(url).toBe(`${DELETION_ORIGIN}/v1/me/delete-confirm`);
  expect(JSON.parse(init.body as string)).toEqual({
    challenge: deletionId(11),
    operationId: deletionId(10),
  });
  expect(JSON.stringify(init)).not.toContain(DELETION_CAPABILITY);
});

test('status is read-only capability POST after Auth is gone, with no refresh or owner in its body', async () => {
  const f = transportFixture();
  f.lifecycle.bearer = null;
  f.lifecycle.owner = { ownerKey: 'signed-out', generation: 2 };
  const context = f.transport.captureRecovery(deletionSecretRecord());
  expect(context).not.toBeNull();
  f.http.fetchNoRedirect.mockResolvedValue(
    deletionResponse(deletionStatusPayload(), 200, 'delete-status'),
  );
  expect(
    await f.transport.status(context!, deletionSecretRecord()),
  ).toMatchObject({ kind: 'status', status: { state: 'completed' } });
  expect(f.runtime.bearerFor).not.toHaveBeenCalled();
  const [url, init] = f.http.fetchNoRedirect.mock.calls[0]!;
  expect(url).toBe(`${DELETION_ORIGIN}/v1/me/delete-status`);
  expect(url).not.toContain(DELETION_CAPABILITY);
  expect(init.headers).toEqual(
    expect.objectContaining({ Authorization: `Bearer ${DELETION_CAPABILITY}` }),
  );
  expect(JSON.parse(init.body as string)).toEqual({
    operationId: deletionId(10),
  });
});

test.each([
  'http://api.example.test',
  'https://user:pass@api.example.test',
  'https://api.example.test/?secret=x',
  'https://api.example.test#fragment',
  'https://api.example.test/unknown',
  'https://api.example.test/functions/v1/api/../api',
  'https://api.example.test/%61pi',
  ' https://api.example.test',
  'https://api.example.test\\api',
  'https://API.example.test',
  'https://api.example.test.',
])(
  'rejects ambiguous or noncanonical trusted origin %s before any HTTP',
  async apiOrigin => {
    const f = transportFixture();
    f.lifecycle.origin = { apiOrigin, generation: 2 };
    expect(f.transport.captureOwner()).toBeNull();
    expect(await f.transport.request(f.context)).toMatchObject({
      kind: 'stale',
    });
    expect(f.http.fetchNoRedirect).not.toHaveBeenCalled();
  },
);

test.each(['owner', 'origin'])(
  'fences %s ABA and forged contexts without token-derived rebinding',
  async change => {
    const f = transportFixture();
    if (change === 'owner') f.lifecycle.owner.generation += 2;
    else f.lifecycle.origin.generation += 2;
    expect(await f.transport.request(f.context)).toEqual({ kind: 'stale' });
    expect(await f.transport.request({ ...f.context })).toEqual({
      kind: 'stale',
    });
    expect(f.http.fetchNoRedirect).not.toHaveBeenCalled();
  },
);

test('never reuses A challenge with B live auth or routes a persisted capability to a new origin', async () => {
  const f = transportFixture();
  f.lifecycle.owner = { ownerKey: DELETION_OWNER_B, generation: 2 };
  const recovery = f.transport.captureRecovery(deletionSecretRecord())!;
  expect(await f.transport.confirm(recovery, deletionSecretRecord())).toEqual({
    kind: 'session_required',
  });
  f.lifecycle.origin = {
    apiOrigin: 'https://other.example.test',
    generation: 2,
  };
  expect(f.transport.captureRecovery(deletionSecretRecord())).toBeNull();
  expect(f.http.fetchNoRedirect).not.toHaveBeenCalled();
});

test.each([
  '',
  'A'.repeat(42),
  'A'.repeat(44),
  `${'A'.repeat(42)}B`,
  `${'A'.repeat(42)}=`,
  ` ${DELETION_CAPABILITY}`,
  `${DELETION_CAPABILITY}\n`,
  `${'A'.repeat(42)}/`,
])(
  'rejects noncanonical status capabilities without sending them: %#',
  async statusCapability => {
    const f = transportFixture();
    const bad = { ...deletionSecretRecord(), statusCapability };
    expect(await f.transport.status(f.context, bad)).toEqual({
      kind: 'invalid_binding',
    });
    expect(f.http.fetchNoRedirect).not.toHaveBeenCalled();
  },
);

test('does not allow status capability syntax in the ordinary session channel', async () => {
  const f = transportFixture();
  f.lifecycle.bearer = DELETION_CAPABILITY;
  expect(await f.transport.request(f.context)).toEqual({
    kind: 'session_required',
  });
  expect(f.http.fetchNoRedirect).not.toHaveBeenCalled();
});

test.each([
  {},
  { challenge: deletionId(11), expiresAt: deletionRequestPayload().expiresAt },
  { ...deletionRequestPayload(), ownerId: DELETION_OWNER_B },
  { ...deletionRequestPayload(), statusCapability: `${'A'.repeat(42)}B` },
  { ...deletionRequestPayload(), challenge: 'legacy-nonce' },
  { ...deletionRequestPayload(), operationId: deletionId(10).toUpperCase() },
  { ...deletionRequestPayload(), expiresAt: '2026-02-30T00:00:00Z' },
  {
    ...deletionRequestPayload(),
    statusExpiresAt: deletionRequestPayload().expiresAt,
  },
])(
  'does not invent missing/legacy request metadata or accept malformed request payload %#',
  async payload => {
    const f = transportFixture();
    f.http.fetchNoRedirect.mockResolvedValue(deletionResponse(payload));
    expect(await f.transport.request(f.context)).toEqual({
      kind: 'invalid_response',
    });
  },
);

test.each([
  { deleted: true },
  { ...deletionCompletionPayload(), operationId: deletionId(99) },
  { ...deletionCompletionPayload(), completionReceipt: null },
  {
    ...deletionCompletionPayload(),
    completionReceipt: { completedAt: 'yesterday' },
  },
  {
    ...deletionCompletionPayload(),
    completionReceipt: {
      ...deletionCompletionPayload().completionReceipt,
      ownerId: DELETION_OWNER_B,
    },
  },
  { ...deletionCompletionPayload(), appleAuthorizationRevocation: undefined },
  {
    ...deletionCompletionPayload(),
    appleAuthorizationRevocation: 'assumed_revoked',
  },
  { ...deletionCompletionPayload(), state: 'completed' },
])(
  'requires the exact bound completed confirm receipt, without compatibility guesses %#',
  async payload => {
    const f = transportFixture();
    f.http.fetchNoRedirect.mockResolvedValue(
      deletionResponse(payload, 200, 'delete-confirm'),
    );
    expect(
      await f.transport.confirm(f.context, deletionSecretRecord()),
    ).toEqual({ kind: 'invalid_response' });
  },
);

test.each([
  'pending',
  'in_progress',
  'completed',
  'superseded',
  'expired',
  'blocked',
])('parses status %s without using it as confirm authority', async state => {
  const f = transportFixture();
  f.http.fetchNoRedirect.mockResolvedValue(
    deletionResponse(deletionStatusPayload(state), 200, 'delete-status'),
  );
  expect(await f.transport.status(f.context, deletionSecretRecord())).toEqual({
    kind: 'status',
    status: deletionStatusPayload(state),
  });
});

test.each([
  { ...deletionStatusPayload(), operationId: deletionId(10) },
  { ...deletionStatusPayload(), deleted: true },
  {
    ...deletionStatusPayload('pending'),
    completionReceipt: deletionCompletionPayload().completionReceipt,
  },
  {
    ...deletionStatusPayload('pending'),
    appleAuthorizationRevocation: 'revoked',
  },
  { ...deletionStatusPayload(), state: 'deleted' },
  {
    ...deletionStatusPayload(),
    completionReceipt: { completedAt: '2026-02-30T00:00:00Z' },
  },
  { ...deletionStatusPayload(), appleAuthorizationRevocation: null },
])(
  'rejects malformed or internally inconsistent status payload %#',
  async payload => {
    const f = transportFixture();
    f.http.fetchNoRedirect.mockResolvedValue(
      deletionResponse(payload, 200, 'delete-status'),
    );
    expect(await f.transport.status(f.context, deletionSecretRecord())).toEqual(
      { kind: 'invalid_response' },
    );
  },
);

test.each([401, 403, 404, 408, 409, 500, 503])(
  'HTTP %s, FK and missing-user error bodies never certify deletion',
  async status => {
    const f = transportFixture();
    f.http.fetchNoRedirect.mockResolvedValue(
      deletionResponse(
        {
          ...deletionCompletionPayload(),
          error: { code: '23503', message: DELETION_CAPABILITY },
        },
        status,
        'delete-confirm',
      ),
    );
    const result = await f.transport.confirm(f.context, deletionSecretRecord());
    expect(result.kind).not.toBe('completed');
    expect(JSON.stringify(result)).not.toContain(DELETION_CAPABILITY);
    f.http.fetchNoRedirect.mockResolvedValue(
      deletionResponse(
        { state: 'completed', error: { code: 'user_not_found' } },
        status,
        'delete-status',
      ),
    );
    expect(
      (await f.transport.status(f.context, deletionSecretRecord())).kind,
    ).not.toBe('status');
  },
);

test('handles in-progress and rate limiting with bounded Retry-After and no automatic worker resumption', async () => {
  const f = transportFixture();
  f.http.fetchNoRedirect.mockResolvedValue(
    deletionResponse(
      { operationId: deletionId(10), state: 'in_progress' },
      202,
      'delete-confirm',
      { headers: { 'retry-after': '3' } },
    ),
  );
  expect(await f.transport.confirm(f.context, deletionSecretRecord())).toEqual({
    kind: 'in_progress',
    retryAfterMs: 3000,
  });
  f.http.fetchNoRedirect.mockResolvedValue(
    deletionResponse({}, 429, 'delete-status', {
      headers: { 'retry-after': '60' },
    }),
  );
  expect(await f.transport.status(f.context, deletionSecretRecord())).toEqual({
    kind: 'rate_limited',
    retryAfterMs: 60_000,
  });
  expect(f.http.fetchNoRedirect).toHaveBeenCalledTimes(2);
});

test.each([
  { redirected: true },
  { url: 'https://untrusted.example.test/v1/me/delete-status' },
  { url: `${DELETION_ORIGIN}/v1/me/delete-status?capability=x` },
  { headers: { 'content-length': '1000000' } },
])(
  'refuses redirect/URL mismatch and declared oversized body %#',
  async options => {
    const f = transportFixture();
    const response = deletionResponse(
      deletionStatusPayload(),
      200,
      'delete-status',
      options,
    );
    response.text = jest.fn(response.text);
    f.http.fetchNoRedirect.mockResolvedValue(response);
    expect(await f.transport.status(f.context, deletionSecretRecord())).toEqual(
      { kind: 'invalid_response' },
    );
    expect(response.text).not.toHaveBeenCalled();
  },
);

test('bounds the actual response independently of Content-Length and redacts thrown errors', async () => {
  const f = transportFixture();
  const response = deletionResponse({}, 200, 'delete-status', {
    headers: { 'content-length': '1' },
  });
  response.text = async () =>
    `${' '.repeat(16_385)}${JSON.stringify(deletionStatusPayload())}`;
  f.http.fetchNoRedirect.mockResolvedValue(response);
  expect(await f.transport.status(f.context, deletionSecretRecord())).toEqual({
    kind: 'invalid_response',
  });
  f.http.fetchNoRedirect.mockRejectedValue(
    Object.assign(new Error(DELETION_CAPABILITY), {
      request: { Authorization: DELETION_CAPABILITY },
    }),
  );
  expect(await f.transport.status(f.context, deletionSecretRecord())).toEqual({
    kind: 'unknown',
  });
});

test('deadline covers stalled body and late completion cannot escape after timeout', async () => {
  jest.useFakeTimers();
  const f = transportFixture(100);
  const body = deferredDeletion<string>();
  const response = deletionResponse({}, 200, 'delete-confirm');
  response.text = () => body.promise;
  f.http.fetchNoRedirect.mockResolvedValue(response);
  const request = f.transport.confirm(f.context, deletionSecretRecord());
  await jest.advanceTimersByTimeAsync(100);
  expect(await request).toEqual({ kind: 'unknown' });
  expect(f.http.fetchNoRedirect.mock.calls[0]![1].signal?.aborted).toBe(true);
  body.resolve(JSON.stringify(deletionCompletionPayload()));
  await Promise.resolve();
  expect(jest.getTimerCount()).toBe(0);
});
