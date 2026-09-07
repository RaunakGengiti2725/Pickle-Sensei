import {
  DELETION_CAPABILITY,
  DELETION_NOW,
  DELETION_ORIGIN,
  DELETION_OWNER_A,
  DELETION_OWNER_B,
  availableDeletion,
  deferredDeletion,
  deletionCompletionPayload,
  deletionFixture,
  deletionId,
  deletionKeychainStore,
  deletionRequestPayload,
  deletionResponse,
  deletionStatusPayload,
} from '../testSupport/deletionOperationFixture';
import { deletionCapabilityService } from '../src/account/deletionCapabilityVault';
import { closeSqliteTestDatabases } from '../testSupport/sqlite';

beforeEach(() => deletionKeychainStore.clear());
afterEach(() => closeSqliteTestDatabases());

async function completedDeletion(f: ReturnType<typeof deletionFixture>) {
  const created = availableDeletion(await f.foundation.request());
  f.clock.now += 3000;
  f.http.fetchNoRedirect.mockResolvedValue(
    deletionResponse(deletionCompletionPayload(), 200, 'delete-confirm'),
  );
  const completed = availableDeletion(
    await f.foundation.confirm(created.handle),
  );
  expect(completed.entry.phase).toBe('receipt_verified');
  return completed;
}

test('journals request intent before HTTP and lost request reply stays nonauthorizing after restart', async () => {
  const f = deletionFixture();
  f.http.fetchNoRedirect.mockImplementation(async () => {
    const row = f.database.native
      .prepare('SELECT document FROM device_account_deletion_journal')
      .get();
    expect(JSON.parse(String(row?.document)).phase).toBe('request_pending');
    throw new Error(DELETION_CAPABILITY);
  });
  const lost = availableDeletion(await f.foundation.request());
  expect(lost.entry.phase).toBe('request_unknown');
  expect(lost.entry.operationId).toBeNull();
  expect(JSON.stringify(lost)).not.toContain(DELETION_CAPABILITY);
  const restarted = f.create();
  const reopened = availableDeletion(await restarted.open(lost.entry.jobId));
  expect(await restarted.confirm(reopened.handle)).toMatchObject({
    kind: 'held',
    reason: 'request_unknown',
  });
  expect(await restarted.poll(reopened.handle)).toMatchObject({
    kind: 'held',
    reason: 'request_unknown',
  });
  expect(await restarted.continueCleanup(reopened.handle)).toMatchObject({
    kind: 'held',
    reason: 'receipt_required',
  });
  expect(f.http.fetchNoRedirect).toHaveBeenCalledTimes(1);
  f.http.fetchNoRedirect.mockResolvedValue(
    deletionResponse(deletionRequestPayload()),
  );
  const retried = availableDeletion(
    await restarted.retryRequest(reopened.handle),
  );
  expect(retried.entry.jobId).toBe(lost.entry.jobId);
  expect(retried.entry.phase).toBe('ready');
  expect(await restarted.retryRequest(reopened.handle)).toMatchObject({
    kind: 'held',
    reason: 'stale_handler',
  });
});

test.each(['before', 'after'] as const)(
  'ambiguous request-intent commit (%s) never sends HTTP and never invents an operation',
  async when => {
    const f = deletionFixture();
    f.database.failCommitOnce(
      when,
      'INSERT INTO device_account_deletion_journal',
    );
    const result = await f.foundation.request();
    expect(result).toMatchObject({
      kind: 'held',
      reason: 'journal_unavailable',
    });
    expect(f.http.fetchNoRedirect).not.toHaveBeenCalled();
    expect(f.keychain.setGenericPassword).not.toHaveBeenCalled();
    const recovered = await f.create().open(deletionId(1));
    if (when === 'before') expect(recovered.kind).toBe('missing');
    else
      expect(availableDeletion(recovered).entry.phase).toBe('request_pending');
  },
);

test('crash after metadata, before Keychain write holds the job instead of recovering secrets from SQLite', async () => {
  const f = deletionFixture();
  f.keychain.setGenericPassword.mockResolvedValueOnce(false);
  expect(await f.foundation.request()).toMatchObject({
    kind: 'held',
    reason: 'capability_write_ambiguous',
    jobId: deletionId(1),
  });
  expect(await f.create().open(deletionId(1))).toMatchObject({
    kind: 'held',
    reason: 'capability_missing',
  });
  expect(JSON.stringify(f.database.calls)).not.toContain(DELETION_CAPABILITY);
  expect(f.cleanup).not.toHaveBeenCalled();
});

test('crash/ambiguous Keychain acknowledgement resumes only after a fresh matching secure read', async () => {
  const f = deletionFixture();
  const normal = f.keychain.setGenericPassword.getMockImplementation()!;
  f.keychain.setGenericPassword.mockImplementationOnce(async (...args) => {
    await normal(...args);
    throw new Error(DELETION_CAPABILITY);
  });
  expect(await f.foundation.request()).toMatchObject({
    kind: 'held',
    reason: 'capability_write_ambiguous',
  });
  expect(f.http.fetchNoRedirect).toHaveBeenCalledTimes(1);
  const resumed = availableDeletion(await f.create().open(deletionId(1)));
  expect(resumed.entry.phase).toBe('ready');
  expect(f.keychain.setGenericPassword).toHaveBeenCalledTimes(1);
});

test.each(['before', 'after'] as const)(
  'restart resolves a %s ready-marker commit only by matching both stores',
  async when => {
    const f = deletionFixture();
    f.database.failCommitOnce(when, "phase = 'ready'");
    expect(await f.foundation.request()).toMatchObject({
      kind: 'held',
      reason: 'journal_unavailable',
    });
    const resumed = availableDeletion(await f.create().open(deletionId(1)));
    expect(resumed.entry.phase).toBe('ready');
    expect(f.http.fetchNoRedirect).toHaveBeenCalledTimes(1);
  },
);

test('persisted confirmation intent precedes HTTP; lost confirm is recovered with status after Auth disappears', async () => {
  const f = deletionFixture();
  const created = availableDeletion(await f.foundation.request());
  f.clock.now += 3000;
  f.http.fetchNoRedirect.mockImplementationOnce(async (_url, init) => {
    const row = f.database.native
      .prepare('SELECT document FROM device_account_deletion_journal')
      .get();
    expect(JSON.parse(String(row?.document)).phase).toBe('confirm_pending');
    expect(JSON.stringify(init)).not.toContain(DELETION_CAPABILITY);
    throw new Error('lost confirmation reply');
  });
  const lost = availableDeletion(await f.foundation.confirm(created.handle));
  expect(lost.entry.phase).toBe('confirm_pending');
  expect(lost.entry.receipt).toBeNull();
  expect(f.cleanup).not.toHaveBeenCalled();
  f.lifecycle.owner = { ownerKey: 'signed-out', generation: 2 };
  f.lifecycle.bearer = null;
  const restarted = f.create();
  const reopened = availableDeletion(await restarted.open(lost.entry.jobId));
  expect(await restarted.confirm(reopened.handle)).toMatchObject({
    kind: 'held',
  });
  f.clock.now += 60_000;
  f.http.fetchNoRedirect.mockResolvedValue(
    deletionResponse(deletionStatusPayload(), 200, 'delete-status'),
  );
  const recovered = availableDeletion(await restarted.poll(reopened.handle));
  expect(recovered.entry.phase).toBe('receipt_verified');
  expect(recovered.entry.receipt?.appleAuthorizationRevocation).toBe(
    'manual_action_required',
  );
  expect(f.http.fetchNoRedirect.mock.calls[2]![1].headers).toEqual(
    expect.objectContaining({ Authorization: `Bearer ${DELETION_CAPABILITY}` }),
  );
  expect(f.cleanup).not.toHaveBeenCalled();
});

test.each(['before', 'after'] as const)(
  'ambiguous %s confirm-intent commit stops before irreversible HTTP',
  async when => {
    const f = deletionFixture();
    const ready = availableDeletion(await f.foundation.request());
    f.clock.now += 3000;
    f.database.failCommitOnce(when, "phase = 'confirm_pending'");
    expect(await f.foundation.confirm(ready.handle)).toMatchObject({
      kind: 'held',
      reason: 'journal_unavailable',
    });
    expect(f.http.fetchNoRedirect).toHaveBeenCalledTimes(1);
    expect(f.cleanup).not.toHaveBeenCalled();
  },
);

test('review minimum, confirmation expiry and status expiry are separate nonauthorizing states', async () => {
  const f = deletionFixture();
  const ready = availableDeletion(await f.foundation.request());
  expect(await f.foundation.confirm(ready.handle)).toMatchObject({
    kind: 'held',
    reason: 'review_required',
  });
  f.clock.now += 900_001;
  expect(await f.foundation.confirm(ready.handle)).toMatchObject({
    kind: 'held',
    reason: 'confirmation_expired',
  });
  f.http.fetchNoRedirect.mockResolvedValue(
    deletionResponse(deletionStatusPayload('expired'), 200, 'delete-status'),
  );
  const expired = availableDeletion(await f.foundation.poll(ready.handle));
  expect(expired.entry.serverState).toBe('expired');
  expect(await f.foundation.continueCleanup(expired.handle)).toMatchObject({
    kind: 'held',
    reason: 'receipt_required',
  });
  f.clock.now = DELETION_NOW + 86_400_001;
  expect(await f.foundation.poll(expired.handle)).toMatchObject({
    kind: 'held',
    reason: 'status_expired',
  });
  expect(f.http.fetchNoRedirect).toHaveBeenCalledTimes(2);
  expect(
    deletionKeychainStore.has(deletionCapabilityService(ready.entry.jobId)),
  ).toBe(true);
});

test.each(['pending', 'in_progress', 'blocked', 'superseded', 'expired'])(
  'status %s cannot authorize cleanup',
  async state => {
    const f = deletionFixture();
    const ready = availableDeletion(await f.foundation.request());
    f.http.fetchNoRedirect.mockResolvedValue(
      deletionResponse(deletionStatusPayload(state), 200, 'delete-status'),
    );
    const status = availableDeletion(await f.foundation.poll(ready.handle));
    expect(status.entry.serverState).toBe(state);
    expect(status.entry.receipt).toBeNull();
    expect(await f.foundation.continueCleanup(status.handle)).toMatchObject({
      kind: 'held',
      reason: 'receipt_required',
    });
    expect(f.cleanup).not.toHaveBeenCalled();
  },
);

test.each([401, 404, 503])(
  'status HTTP %s remains unknown, preserving the journal and secure capability',
  async status => {
    const f = deletionFixture();
    const ready = availableDeletion(await f.foundation.request());
    f.http.fetchNoRedirect.mockResolvedValue(
      deletionResponse(deletionStatusPayload(), status, 'delete-status'),
    );
    const unknown = availableDeletion(await f.foundation.poll(ready.handle));
    expect(unknown.entry.serverState).toBe('unknown');
    expect(unknown.entry.receipt).toBeNull();
    expect((await f.create().open(ready.entry.jobId)).kind).toBe('available');
    expect(f.cleanup).not.toHaveBeenCalled();
  },
);

test('persists Retry-After across restart rather than looping status or restarting the server worker', async () => {
  const f = deletionFixture();
  const ready = availableDeletion(await f.foundation.request());
  f.http.fetchNoRedirect.mockResolvedValue(
    deletionResponse({}, 429, 'delete-status', {
      headers: { 'retry-after': '60' },
    }),
  );
  const limited = availableDeletion(await f.foundation.poll(ready.handle));
  const restarted = f.create();
  const reopened = availableDeletion(await restarted.open(limited.entry.jobId));
  expect(await restarted.poll(reopened.handle)).toMatchObject({
    kind: 'held',
    reason: 'retry_later',
  });
  f.clock.now += 60_000;
  f.http.fetchNoRedirect.mockResolvedValue(
    deletionResponse(
      deletionStatusPayload('in_progress'),
      200,
      'delete-status',
    ),
  );
  expect(
    availableDeletion(await restarted.poll(reopened.handle)).entry.serverState,
  ).toBe('in_progress');
  expect(f.http.fetchNoRedirect).toHaveBeenCalledTimes(3);
});

test.each(['before', 'after'] as const)(
  'a %s receipt-sealed marker commit is recovered without rerunning confirmation',
  async when => {
    const f = deletionFixture();
    const ready = availableDeletion(await f.foundation.request());
    f.clock.now += 3000;
    f.http.fetchNoRedirect.mockResolvedValue(
      deletionResponse(deletionCompletionPayload(), 200, 'delete-confirm'),
    );
    f.database.failCommitOnce(when, "phase = 'receipt_verified'");
    expect(await f.foundation.confirm(ready.handle)).toMatchObject({
      kind: 'held',
      reason: 'journal_unavailable',
    });
    expect(f.cleanup).not.toHaveBeenCalled();
    const recovered = availableDeletion(
      await f.create().open(ready.entry.jobId),
    );
    expect(recovered.entry.phase).toBe('receipt_verified');
    expect(f.http.fetchNoRedirect).toHaveBeenCalledTimes(2);
  },
);

test('SQLite-only receipt intent cannot authorize cleanup when the secure receipt write failed', async () => {
  const f = deletionFixture();
  const ready = availableDeletion(await f.foundation.request());
  f.clock.now += 3000;
  f.keychain.setGenericPassword.mockResolvedValueOnce(false);
  f.http.fetchNoRedirect.mockResolvedValue(
    deletionResponse(deletionCompletionPayload(), 200, 'delete-confirm'),
  );
  expect(await f.foundation.confirm(ready.handle)).toMatchObject({
    kind: 'held',
    reason: 'capability_write_ambiguous',
  });
  const restarted = f.create();
  const reopened = availableDeletion(await restarted.open(ready.entry.jobId));
  expect(reopened.entry.phase).toBe('receipt_pending');
  expect(await restarted.continueCleanup(reopened.handle)).toMatchObject({
    kind: 'held',
    reason: 'receipt_required',
  });
  f.http.fetchNoRedirect.mockResolvedValue(
    deletionResponse(deletionStatusPayload(), 200, 'delete-status'),
  );
  const sealed = availableDeletion(await restarted.poll(reopened.handle));
  expect(sealed.entry.phase).toBe('receipt_verified');
});

test('repeated exact receipts are idempotent and conflicting receipts never reset cleanup progress', async () => {
  const f = deletionFixture();
  const completed = await completedDeletion(f);
  f.cleanup.mockResolvedValue('checkpointed');
  const media = availableDeletion(
    await f.foundation.continueCleanup(completed.handle),
  );
  expect(media.entry.cleanup.completed).toEqual(['owned_media']);
  f.http.fetchNoRedirect.mockResolvedValue(
    deletionResponse(deletionStatusPayload(), 200, 'delete-status'),
  );
  const repeated = availableDeletion(await f.foundation.poll(media.handle));
  expect(repeated.entry).toEqual(media.entry);
  const conflict = deletionStatusPayload();
  conflict.completionReceipt = {
    completedAt: new Date(DELETION_NOW + 20_000).toISOString(),
  };
  f.http.fetchNoRedirect.mockResolvedValue(
    deletionResponse(conflict, 200, 'delete-status'),
  );
  expect(await f.foundation.poll(repeated.handle)).toMatchObject({
    kind: 'held',
    reason: 'receipt_conflict',
  });
  expect(
    availableDeletion(await f.create().open(media.entry.jobId)).entry.cleanup
      .completed,
  ).toEqual(['owned_media']);
  expect(f.cleanup).toHaveBeenCalledTimes(1);
});

test('absent cleanup or maintenance boundary stays pending even after an exact completed receipt', async () => {
  const f = deletionFixture();
  const completed = await completedDeletion(f);
  for (const overrides of [
    { maintenance: undefined },
    { cleanup: undefined },
  ]) {
    const isolated = f.create(overrides);
    const handle = availableDeletion(
      await isolated.open(completed.entry.jobId),
    ).handle;
    expect(await isolated.continueCleanup(handle)).toMatchObject({
      kind: 'held',
      reason: 'maintenance_required',
    });
  }
  expect(f.cleanup).not.toHaveBeenCalled();
});

test('late completion for A while B is active only journals A; cleanup needs explicit owner-isolated maintenance', async () => {
  const f = deletionFixture();
  const created = availableDeletion(
    await f.foundation.request({
      references: ['dGVzdA=='],
      legacyMedia: 'unverified',
    }),
  );
  f.clock.now += 3000;
  const reply = deferredDeletion<Response>();
  const sent = deferredDeletion<void>();
  f.http.fetchNoRedirect.mockImplementationOnce(async () => {
    sent.resolve();
    return reply.promise;
  });
  const pending = f.foundation.confirm(created.handle);
  await sent.promise;
  f.lifecycle.owner = { ownerKey: DELETION_OWNER_B, generation: 2 };
  f.lifecycle.bearer = 'B.live.session';
  deletionKeychainStore.set('com.picklesensei.auth.session', {
    username: 'session',
    password: 'B refresh token',
  });
  f.database.native
    .prepare('INSERT INTO kv(key,value) VALUES (?,?)')
    .run(`profile:${DELETION_OWNER_B}`, 'B profile');
  reply.resolve(
    deletionResponse(deletionCompletionPayload(), 200, 'delete-confirm'),
  );
  expect(await pending).toMatchObject({
    kind: 'held',
    reason: 'stale_handler',
  });
  expect(f.cleanup).not.toHaveBeenCalled();
  const recovered = availableDeletion(
    await f.create().open(created.entry.jobId),
  );
  const maintenanceFoundation = f.create();
  const current = availableDeletion(
    await maintenanceFoundation.open(recovered.entry.jobId),
  );
  const cleanup = availableDeletion(
    await maintenanceFoundation.continueCleanup(current.handle),
  );
  expect(cleanup.entry.phase).toBe('cleanup_pending');
  expect(f.maintenance.acquire).toHaveBeenCalledWith(
    expect.objectContaining({
      binding: expect.objectContaining({
        ownerId: DELETION_OWNER_A,
        apiOrigin: DELETION_ORIGIN,
        operationId: deletionId(10),
      }),
      activeOwner: { ownerKey: DELETION_OWNER_B, generation: 2 },
      mutationScope: 'original-owner-only',
      globalSessionMutation: 'forbidden',
      globalProfileMutation: 'forbidden',
    }),
  );
  expect(f.cleanup).toHaveBeenCalledWith(
    expect.objectContaining({
      binding: expect.objectContaining({ ownerId: DELETION_OWNER_A }),
      ownership: { references: ['dGVzdA=='], legacyMedia: 'unverified' },
      nativeOwnershipVerified: false,
      globalSessionMutation: 'forbidden',
      globalProfileMutation: 'forbidden',
    }),
  );
  expect(
    deletionKeychainStore.get('com.picklesensei.auth.session')?.password,
  ).toBe('B refresh token');
  expect(
    f.database.native
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(`profile:${DELETION_OWNER_B}`)?.value,
  ).toBe('B profile');
  expect(f.lifecycle.owner.ownerKey).toBe(DELETION_OWNER_B);
});

test.each(['owner', 'origin', 'dispose'] as const)(
  'stale %s handlers cannot confirm or finish a cleanup checkpoint',
  async change => {
    const f = deletionFixture();
    const completed = await completedDeletion(f);
    const finishing = deferredDeletion<'checkpointed' | 'pending'>();
    const started = deferredDeletion<void>();
    f.cleanup.mockImplementationOnce(async () => {
      started.resolve();
      return finishing.promise;
    });
    const pending = f.foundation.continueCleanup(completed.handle);
    await started.promise;
    const work = f.cleanup.mock.calls[0]![0];
    expect(work.isCurrent()).toBe(true);
    if (change === 'owner') f.lifecycle.owner.generation += 2;
    else if (change === 'origin') f.lifecycle.origin.generation += 2;
    else f.foundation.dispose();
    expect(work.isCurrent()).toBe(false);
    finishing.resolve('checkpointed');
    expect(await pending).toMatchObject({
      kind: 'held',
      reason: 'stale_handler',
    });
    const reopened = availableDeletion(
      await f.create().open(completed.entry.jobId),
    );
    expect(reopened.entry.cleanup.completed).toEqual([]);
    expect(reopened.entry.cleanup.pending).toBe('owned_media');
    expect(f.release).toHaveBeenCalledTimes(1);
  },
);

test('wrong-owner or unavailable maintenance lease never calls continuation', async () => {
  const f = deletionFixture();
  const completed = await completedDeletion(f);
  f.maintenance.acquire.mockImplementationOnce(async request => ({
    binding: { ...request.binding, ownerId: DELETION_OWNER_B },
    isCurrent: () => true,
    release: f.release,
  }));
  expect(await f.foundation.continueCleanup(completed.handle)).toMatchObject({
    kind: 'held',
    reason: 'maintenance_required',
  });
  f.maintenance.acquire.mockRejectedValueOnce(new Error(DELETION_CAPABILITY));
  expect(await f.foundation.continueCleanup(completed.handle)).toMatchObject({
    kind: 'held',
    reason: 'maintenance_required',
  });
  expect(f.cleanup).not.toHaveBeenCalled();
});

test('checkpoints are durable, ordered and at-least-once idempotent across a lost callback acknowledgement', async () => {
  const f = deletionFixture();
  const completed = await completedDeletion(f);
  const applied = new Set<string>();
  f.cleanup.mockImplementationOnce(async work => {
    const row = f.database.native
      .prepare(
        'SELECT document FROM device_account_deletion_journal WHERE job_id = ?',
      )
      .get(work.binding.jobId);
    expect(JSON.parse(String(row?.document)).cleanup.pending).toBe(
      'owned_media',
    );
    applied.add(work.idempotencyKey);
    throw new Error(DELETION_CAPABILITY);
  });
  expect(await f.foundation.continueCleanup(completed.handle)).toMatchObject({
    kind: 'held',
    reason: 'cleanup_unknown',
  });
  const restarted = f.create();
  const reopened = availableDeletion(
    await restarted.open(completed.entry.jobId),
  );
  f.cleanup.mockImplementation(async work => {
    applied.add(work.idempotencyKey);
    return 'checkpointed';
  });
  const media = availableDeletion(
    await restarted.continueCleanup(reopened.handle),
  );
  expect(applied.size).toBe(1);
  expect(media.entry.cleanup.completed).toEqual(['owned_media']);
  expect(f.cleanup.mock.calls[0]![0].idempotencyKey).toBe(
    f.cleanup.mock.calls[1]![0].idempotencyKey,
  );
  const local = availableDeletion(
    await restarted.continueCleanup(media.handle),
  );
  expect(local.entry.phase).toBe('cleanup_complete');
  expect(local.entry.cleanup.completed).toEqual([
    'owned_media',
    'owner_local_data',
  ]);
  expect(local.entry.ownership.legacyMedia).toBe('unverified');
  expect(
    availableDeletion(await restarted.continueCleanup(local.handle)).entry,
  ).toEqual(local.entry);
  expect(f.cleanup).toHaveBeenCalledTimes(3);
});

test.each(['before', 'after'] as const)(
  'a %s completed-checkpoint commit never gets claimed as async cross-store atomicity',
  async when => {
    const f = deletionFixture();
    const completed = await completedDeletion(f);
    f.cleanup.mockImplementationOnce(async () => {
      f.database.failCommitOnce(when, 'UPDATE device_account_deletion_journal');
      return 'checkpointed';
    });
    expect(await f.foundation.continueCleanup(completed.handle)).toMatchObject({
      kind: 'held',
      reason: 'journal_unavailable',
    });
    const recovered = availableDeletion(
      await f.create().open(completed.entry.jobId),
    );
    expect(recovered.entry.cleanup.completed).toEqual(
      when === 'before' ? [] : ['owned_media'],
    );
    expect(recovered.entry.cleanup.pending).toBe(
      when === 'before' ? 'owned_media' : null,
    );
  },
);

test('stale/forged/replaced handles and concurrent same-operation actions cannot double-confirm', async () => {
  const f = deletionFixture();
  const ready = availableDeletion(await f.foundation.request());
  f.clock.now += 3000;
  expect(await f.foundation.confirm({ ...ready.handle })).toMatchObject({
    kind: 'held',
    reason: 'stale_handler',
  });
  const other = f.create();
  expect(await other.confirm(ready.handle)).toMatchObject({
    kind: 'held',
    reason: 'stale_handler',
  });
  const second = availableDeletion(await other.open(ready.entry.jobId));
  f.http.fetchNoRedirect.mockResolvedValue(
    deletionResponse(deletionCompletionPayload(), 200, 'delete-confirm'),
  );
  const results = await Promise.all([
    f.foundation.confirm(ready.handle),
    other.confirm(second.handle),
  ]);
  expect(results.filter(result => result.kind === 'available')).toHaveLength(1);
  expect(results.filter(result => result.kind === 'held')).toHaveLength(1);
  expect(f.http.fetchNoRedirect).toHaveBeenCalledTimes(2);
  expect(await f.foundation.confirm(ready.handle)).toMatchObject({
    kind: 'held',
    reason: 'stale_handler',
  });
});

test('operation replay across owners fails closed while A records and B session remain intact', async () => {
  const f = deletionFixture();
  const first = availableDeletion(await f.foundation.request());
  f.lifecycle.owner = { ownerKey: DELETION_OWNER_B, generation: 2 };
  expect(await f.foundation.request()).toMatchObject({ kind: 'held' });
  const recovered = availableDeletion(await f.create().open(first.entry.jobId));
  expect(recovered.entry.ownerId).toBe(DELETION_OWNER_A);
  expect(
    deletionKeychainStore.has(deletionCapabilityService(deletionId(2))),
  ).toBe(false);
});

test('a completed sealed receipt remains usable for explicit maintenance after status capability expiry', async () => {
  const f = deletionFixture();
  const completed = await completedDeletion(f);
  f.clock.now = DELETION_NOW + 86_400_001;
  const restarted = f.create();
  const recovered = availableDeletion(
    await restarted.open(completed.entry.jobId),
  );
  expect(
    availableDeletion(await restarted.continueCleanup(recovered.handle)).entry
      .phase,
  ).toBe('cleanup_pending');
  expect(f.http.fetchNoRedirect).toHaveBeenCalledTimes(2);
});

test('device discovery remains bounded, holds old unknown jobs, and does not silently reap them by draft policy', async () => {
  const f = deletionFixture();
  f.http.fetchNoRedirect.mockRejectedValue(new Error('offline'));
  for (let i = 0; i < 32; i++)
    expect(availableDeletion(await f.foundation.request()).entry.phase).toBe(
      'request_unknown',
    );
  f.clock.now += 8 * 86_400_000;
  expect(await f.foundation.request()).toMatchObject({
    kind: 'held',
    reason: 'journal_capacity',
  });
  const listed = await f.create().list();
  expect(listed.kind).toBe('entries');
  if (listed.kind !== 'entries')
    throw new Error('Expected device journal discovery.');
  expect(listed.entries).toHaveLength(32);
  expect(f.http.fetchNoRedirect).toHaveBeenCalledTimes(32);
  expect(f.keychain.setGenericPassword).not.toHaveBeenCalled();
});

test('A origin journal is never relabeled or sent to a different trusted current origin', async () => {
  const f = deletionFixture();
  const created = availableDeletion(await f.foundation.request());
  f.lifecycle.origin = {
    apiOrigin: 'https://other.example.test',
    generation: 2,
  };
  expect(await f.foundation.poll(created.handle)).toMatchObject({
    kind: 'held',
    reason: 'stale_handler',
  });
  expect(await f.create().open(created.entry.jobId)).toMatchObject({
    kind: 'held',
    reason: 'origin_unavailable',
  });
  f.lifecycle.origin = { apiOrigin: DELETION_ORIGIN, generation: 3 };
  expect(await f.foundation.confirm(created.handle)).toMatchObject({
    kind: 'held',
    reason: 'stale_handler',
  });
  expect(
    availableDeletion(await f.create().open(created.entry.jobId)).entry
      .apiOrigin,
  ).toBe(DELETION_ORIGIN);
  expect(f.http.fetchNoRedirect).toHaveBeenCalledTimes(1);
});

test('unavailable secure receipt reads hold cleanup; they never clear a current global session', async () => {
  const f = deletionFixture();
  const completed = await completedDeletion(f);
  deletionKeychainStore.set('com.picklesensei.auth.session', {
    username: 'session',
    password: 'B current refresh',
  });
  f.keychain.getGenericPassword.mockRejectedValue(
    new Error(DELETION_CAPABILITY),
  );
  expect(await f.foundation.continueCleanup(completed.handle)).toMatchObject({
    kind: 'held',
    reason: 'capability_unavailable',
  });
  expect(await f.create().open(completed.entry.jobId)).toMatchObject({
    kind: 'held',
    reason: 'capability_unavailable',
  });
  expect(
    deletionKeychainStore.get('com.picklesensei.auth.session')?.password,
  ).toBe('B current refresh');
  expect(f.cleanup).not.toHaveBeenCalled();
});

test('SQLite-only forged completed state cannot unlock maintenance or the continuation', async () => {
  const f = deletionFixture();
  const ready = availableDeletion(await f.foundation.request());
  const forged = {
    ...ready.entry,
    phase: 'receipt_verified',
    serverState: 'completed',
    receipt: {
      ...deletionCompletionPayload().completionReceipt,
      appleAuthorizationRevocation: 'manual_action_required',
    },
  };
  f.database.native
    .prepare(
      'UPDATE device_account_deletion_journal SET phase = ?, document = ? WHERE job_id = ?',
    )
    .run('receipt_verified', JSON.stringify(forged), ready.entry.jobId);
  expect(await f.create().open(ready.entry.jobId)).toMatchObject({
    kind: 'held',
    reason: 'capability_conflict',
  });
  expect(f.maintenance.acquire).not.toHaveBeenCalled();
  expect(f.cleanup).not.toHaveBeenCalled();
});
