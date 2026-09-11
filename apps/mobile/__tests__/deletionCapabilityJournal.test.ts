import {
  createDeletionCapabilityVault,
  deletionCapabilityService,
} from '../src/account/deletionCapabilityVault';
import { createDeletionOperationJournal } from '../src/account/deletionOperationJournal';
import { createDeletionOperationTransport } from '../src/account/deletionOperationTransport';
import { purgeOwnerData } from '../src/data/repository';
import { forDataOwner } from '../src/data/transactions';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
} from '../src/data/accountScope';
import {
  DELETION_CAPABILITY,
  DELETION_ORIGIN,
  DELETION_OWNER_A,
  DELETION_OWNER_B,
  availableDeletion,
  deletionCompletionPayload,
  deletionFixture,
  deletionResponse,
  deletionId,
  deletionKeychainStore,
  deletionSecretRecord,
} from '../testSupport/deletionOperationFixture';
import { closeSqliteTestDatabases } from '../testSupport/sqlite';

beforeEach(() => deletionKeychainStore.clear());
afterEach(() => closeSqliteTestDatabases());

test('capability and confirmation challenge live only in the dedicated device-only per-job Keychain item', async () => {
  const f = deletionFixture();
  const result = availableDeletion(await f.foundation.request());
  expect(result.entry.phase).toBe('ready');
  const service = deletionCapabilityService(result.entry.jobId);
  const [username, password, options] =
    f.keychain.setGenericPassword.mock.calls[0]!;
  expect(username).toBe('deletion-operation-v1');
  expect(options).toEqual({
    service,
    accessible: f.keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    cloudSync: false,
  });
  expect(service).not.toBe('com.picklesensei.auth.session');
  expect(JSON.parse(password)).toMatchObject(deletionSecretRecord());
  const nonsecret = JSON.stringify([
    result,
    f.database.calls,
    f.database.native
      .prepare('SELECT * FROM device_account_deletion_journal')
      .all(),
    f.database.native.prepare('SELECT * FROM kv').all(),
  ]);
  expect(nonsecret).not.toContain(DELETION_CAPABILITY);
  expect(nonsecret).not.toContain(deletionSecretRecord().challenge);
  expect(
    f.keychain.getGenericPassword.mock.calls.every(
      ([options]) => options?.cloudSync === false,
    ),
  ).toBe(true);
});

test('device journal and per-operation secrets survive session removal and actual owner-local SQLite purge', async () => {
  const f = deletionFixture();
  const created = availableDeletion(await f.foundation.request());
  f.database.native
    .prepare('INSERT INTO kv(key,value) VALUES (?,?)')
    .run(`profile:${DELETION_OWNER_A}`, 'A profile');
  f.database.native
    .prepare('INSERT INTO kv(key,value) VALUES (?,?)')
    .run(`profile:${DELETION_OWNER_B}`, 'B profile');
  deletionKeychainStore.set('com.picklesensei.auth.session', {
    username: 'session',
    password: 'B-current-session',
  });
  await purgeOwnerData(f.database.db, DELETION_OWNER_A);
  f.lifecycle.owner = { ownerKey: 'signed-out', generation: 2 };
  f.lifecycle.bearer = null;
  deletionKeychainStore.delete('com.picklesensei.auth.session');
  const recovered = availableDeletion(
    await f.create().open(created.entry.jobId),
  );
  expect(recovered.entry).toEqual(created.entry);
  expect(
    f.database.native
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(`profile:${DELETION_OWNER_B}`)?.value,
  ).toBe('B profile');
  expect(
    deletionKeychainStore.has(deletionCapabilityService(created.entry.jobId)),
  ).toBe(true);
});

test.each(['false', 'throw'] as const)(
  'does not call a Keychain write %s durable, even when its write reached storage',
  async acknowledgement => {
    const f = deletionFixture();
    const vault = createDeletionCapabilityVault(f.keychain);
    const normalSet = f.keychain.setGenericPassword.getMockImplementation()!;
    f.keychain.setGenericPassword.mockImplementationOnce(async (...args) => {
      await normalSet(...args);
      if (acknowledgement === 'throw') throw new Error(DELETION_CAPABILITY);
      return false;
    });
    expect(await vault.store(deletionSecretRecord())).toEqual({
      kind: 'ambiguous',
      acknowledgement: acknowledgement === 'throw' ? 'threw' : 'false',
      verification: 'matched',
    });
    expect(await vault.read(deletionSecretRecord())).toMatchObject({
      kind: 'available',
      record: deletionSecretRecord(),
    });
  },
);

test.each(['false', 'throw'] as const)(
  'distinguishes nonpersisted Keychain write %s from acknowledgement loss',
  async failure => {
    const f = deletionFixture();
    const vault = createDeletionCapabilityVault(f.keychain);
    if (failure === 'false')
      f.keychain.setGenericPassword.mockResolvedValueOnce(false);
    else
      f.keychain.setGenericPassword.mockRejectedValueOnce(
        new Error(DELETION_CAPABILITY),
      );
    expect(await vault.store(deletionSecretRecord())).toEqual({
      kind: 'ambiguous',
      acknowledgement: failure === 'false' ? 'false' : 'threw',
      verification: 'empty',
    });
    expect(await vault.read(deletionSecretRecord())).toEqual({ kind: 'empty' });
  },
);

test('read unavailable is not empty and never authorizes overwriting or erasing a secure item', async () => {
  const f = deletionFixture();
  const vault = createDeletionCapabilityVault(f.keychain);
  f.keychain.getGenericPassword.mockRejectedValue(
    new Error(DELETION_CAPABILITY),
  );
  expect(await vault.read(deletionSecretRecord())).toEqual({
    kind: 'unavailable',
  });
  expect(await vault.store(deletionSecretRecord())).toEqual({
    kind: 'refused',
    reason: 'unavailable',
  });
  expect(f.keychain.setGenericPassword).not.toHaveBeenCalled();
});

test('acknowledged write with unavailable readback remains ambiguous', async () => {
  const f = deletionFixture();
  const vault = createDeletionCapabilityVault(f.keychain);
  const read = f.keychain.getGenericPassword.getMockImplementation()!;
  f.keychain.getGenericPassword
    .mockImplementationOnce(read)
    .mockRejectedValueOnce(new Error('Keychain unavailable'));
  expect(await vault.store(deletionSecretRecord())).toEqual({
    kind: 'ambiguous',
    acknowledgement: 'accepted',
    verification: 'unavailable',
  });
});

test.each([
  { statusCapability: `${'A'.repeat(42)}B` },
  { statusCapability: `${DELETION_CAPABILITY}\n` },
  { statusCapability: `${DELETION_CAPABILITY}=` },
  { challenge: 'legacy-challenge' },
  { version: 2 },
  { ownerId: 'device-guest' },
  { apiOrigin: `${DELETION_ORIGIN}?token=${DELETION_CAPABILITY}` },
  { refreshToken: 'must-not-copy-session' },
  { statusCapability: 'A'.repeat(9000) },
])(
  'refuses unknown schema, malformed secrets and legacy guesses before writes %#',
  async patch => {
    const f = deletionFixture();
    const vault = createDeletionCapabilityVault(f.keychain);
    expect(
      await vault.store({ ...deletionSecretRecord(), ...patch } as never),
    ).toEqual({ kind: 'refused', reason: 'invalid' });
    expect(f.keychain.setGenericPassword).not.toHaveBeenCalled();
  },
);

test.each([
  ['invalid', '{'],
  ['invalid', JSON.stringify({ ...deletionSecretRecord(), extra: true })],
  ['invalid', ' '.repeat(8193)],
  ['unsupported', JSON.stringify({ ...deletionSecretRecord(), version: 2 })],
] as const)(
  'preserves a %s secure record instead of treating it as absent',
  async (kind, password) => {
    const f = deletionFixture();
    const vault = createDeletionCapabilityVault(f.keychain);
    const service = deletionCapabilityService(deletionSecretRecord().jobId);
    deletionKeychainStore.set(service, {
      username: 'deletion-operation-v1',
      password,
    });
    expect(await vault.read(deletionSecretRecord())).toEqual({ kind });
    expect((await vault.store(deletionSecretRecord())).kind).toBe('refused');
    expect(deletionKeychainStore.get(service)?.password).toBe(password);
  },
);

test.each([
  { ownerId: DELETION_OWNER_B },
  { apiOrigin: 'https://other.example.test' },
  { operationId: deletionId(99) },
])('secure read rejects owner/origin/operation replay %#', async patch => {
  const f = deletionFixture();
  const vault = createDeletionCapabilityVault(f.keychain);
  expect(await vault.store(deletionSecretRecord())).toEqual({ kind: 'saved' });
  expect(await vault.read({ ...deletionSecretRecord(), ...patch })).toEqual({
    kind: 'conflict',
  });
  expect(
    (await vault.store({ ...deletionSecretRecord(), ...patch })).kind,
  ).toBe('refused');
  expect(f.keychain.setGenericPassword).toHaveBeenCalledTimes(1);
});

test('never lets concurrent vault instances overwrite an immutable job binding', async () => {
  const f = deletionFixture();
  const first = createDeletionCapabilityVault(f.keychain);
  const second = createDeletionCapabilityVault(f.keychain);
  const results = await Promise.all([
    first.store(deletionSecretRecord()),
    second.store({ ...deletionSecretRecord(), ownerId: DELETION_OWNER_B }),
  ]);
  expect(results).toEqual([
    { kind: 'saved' },
    { kind: 'refused', reason: 'conflict' },
  ]);
  expect(f.keychain.setGenericPassword).toHaveBeenCalledTimes(1);
});

test('refuses an owner-scoped database rather than bypassing the active-owner guard', async () => {
  const f = deletionFixture();
  setActiveDataOwner(DELETION_OWNER_A);
  const scoped = forDataOwner(f.database.db, captureDataOwnerContext());
  await expect(
    createDeletionOperationJournal(scoped).initialize(),
  ).rejects.toMatchObject({ code: 'raw_transactional_db_required' });
  expect(f.database.calls).toHaveLength(0);
});

test.each([
  { version: 2 },
  { ownerId: DELETION_OWNER_B },
  { operationId: deletionId(99) },
  { statusCapability: DELETION_CAPABILITY },
  { phase: 'deleted' },
  {
    receipt: {
      completedAt: '2026-02-30T00:00:00Z',
      appleAuthorizationRevocation: 'revoked',
    },
  },
  { cleanup: { completed: ['owner_local_data'], pending: null } },
])(
  'strict durable journal rejects tampered/unknown schema and does not clean up %#',
  async patch => {
    const f = deletionFixture();
    const created = availableDeletion(await f.foundation.request());
    const document = JSON.stringify({ ...created.entry, ...patch });
    f.database.native
      .prepare(
        'UPDATE device_account_deletion_journal SET document = ? WHERE job_id = ?',
      )
      .run(document, created.entry.jobId);
    const result = await f.create().open(created.entry.jobId);
    expect(result.kind).toBe('held');
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(
      f.database.native
        .prepare(
          'SELECT document FROM device_account_deletion_journal WHERE job_id = ?',
        )
        .get(created.entry.jobId)?.document,
    ).toBe(document);
  },
);

test('unknown table shape is unavailable, not a guessed legacy migration', async () => {
  const f = deletionFixture();
  f.database.native.exec(
    'CREATE TABLE device_account_deletion_journal (job_id TEXT PRIMARY KEY, value TEXT)',
  );
  expect(await f.foundation.request()).toMatchObject({
    kind: 'held',
    reason: 'journal_schema_invalid',
  });
  expect(f.http.fetchNoRedirect).not.toHaveBeenCalled();
  expect(f.keychain.setGenericPassword).not.toHaveBeenCalled();
});

test('SQLite enforces document bounds and JS refuses URI/owner provenance claims', async () => {
  const f = deletionFixture();
  const created = availableDeletion(await f.foundation.request());
  expect(() =>
    f.database.native
      .prepare('UPDATE device_account_deletion_journal SET document = ?')
      .run(JSON.stringify({ padding: 'x'.repeat(400_000) })),
  ).toThrow();
  for (const draft of [
    {
      references: ['file:///private/other-owner/movie.mov'],
      legacyMedia: 'unverified',
    },
    { references: [], legacyMedia: 'verified', ownerId: DELETION_OWNER_A },
    { references: Array(17).fill('dGVzdA=='), legacyMedia: 'unverified' },
    { references: ['A'.repeat(21852)], legacyMedia: 'unverified' },
    { references: [DELETION_CAPABILITY], legacyMedia: 'unverified' },
  ]) {
    expect(await f.foundation.request(draft as never)).toMatchObject({
      kind: 'held',
      reason: 'invalid_ownership_draft',
    });
  }
  expect((await f.create().open(created.entry.jobId)).kind).toBe('available');
  expect(f.http.fetchNoRedirect).toHaveBeenCalledTimes(1);
});

test('plain completion JSON is not secure sealing authority, even if its fields look valid', async () => {
  const f = deletionFixture();
  const vault = createDeletionCapabilityVault(f.keychain);
  await vault.store(deletionSecretRecord());
  const raw = {
    ...deletionCompletionPayload().completionReceipt,
    appleAuthorizationRevocation: 'manual_action_required' as const,
  };
  expect(await vault.sealReceipt(deletionSecretRecord(), raw)).toEqual({
    kind: 'refused',
    reason: 'invalid',
  });
  expect(f.keychain.setGenericPassword).toHaveBeenCalledTimes(1);
});

test('a validated completion can seal only its exact job/owner/origin/operation, and copying it loses authority', async () => {
  const f = deletionFixture();
  const vault = createDeletionCapabilityVault(f.keychain);
  const transport = createDeletionOperationTransport({
    runtime: f.runtime,
    http: f.http,
  });
  const context = transport.captureOwner()!;
  await vault.store(deletionSecretRecord());
  const other = {
    ...deletionSecretRecord(),
    jobId: deletionId(2),
    operationId: deletionId(20),
  };
  await vault.store(other);
  f.http.fetchNoRedirect.mockResolvedValue(
    deletionResponse(deletionCompletionPayload(), 200, 'delete-confirm'),
  );
  const result = await transport.confirm(context, deletionSecretRecord());
  if (result.kind !== 'completed')
    throw new Error('Expected transport completion evidence.');
  expect(await vault.sealReceipt(other, result.receipt)).toEqual({
    kind: 'refused',
    reason: 'invalid',
  });
  expect(
    await vault.sealReceipt(deletionSecretRecord(), { ...result.receipt }),
  ).toEqual({ kind: 'refused', reason: 'invalid' });
  expect(
    await vault.sealReceipt(deletionSecretRecord(), result.receipt),
  ).toEqual({ kind: 'saved' });
  expect(f.keychain.setGenericPassword).toHaveBeenCalledTimes(3);
});
