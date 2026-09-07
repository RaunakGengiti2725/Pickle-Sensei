import * as Keychain from 'react-native-keychain';
import {
  createDeletionOperationFoundation,
  type DeletionFoundationDependencies,
  type DeletionOperationResult,
} from '../src/account/deletionOperation';
import type {
  DeletionCleanupWork,
  DeletionMaintenanceRequest,
  DeletionSecretRecord,
} from '../src/account/deletionOperationContracts';
import { createSqliteTestDb } from './sqlite';

export const DELETION_OWNER_A = '11111111-1111-4111-8111-111111111111';
export const DELETION_OWNER_B = '22222222-2222-4222-8222-222222222222';
export const DELETION_ORIGIN = 'https://api.example.test/functions/v1/api';
export const DELETION_NOW = 1_783_382_400_000;
export const DELETION_CAPABILITY = 'A'.repeat(43);
export const DELETION_SESSION = 'test.session.bearer';

export function deletionId(value: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(value).padStart(12, '0')}`;
}

export function deletionRequestPayload(operation = 10) {
  return {
    challenge: deletionId(operation + 1),
    expiresAt: new Date(DELETION_NOW + 900_000).toISOString(),
    operationId: deletionId(operation),
    statusCapability: DELETION_CAPABILITY,
    statusExpiresAt: new Date(DELETION_NOW + 86_400_000).toISOString(),
  };
}

export function deletionCompletionPayload(operation = 10) {
  return {
    deleted: true as const,
    operationId: deletionId(operation),
    completionReceipt: {
      completedAt: new Date(DELETION_NOW + 10_000).toISOString(),
    },
    appleAuthorizationRevocation: 'manual_action_required' as const,
  };
}

export function deletionStatusPayload(state = 'completed') {
  const completion = deletionCompletionPayload();
  return {
    state,
    completionReceipt:
      state === 'completed' ? completion.completionReceipt : null,
    appleAuthorizationRevocation:
      state === 'completed' ? completion.appleAuthorizationRevocation : null,
  };
}

export function deletionResponse(
  payload: unknown,
  status = 200,
  path = 'delete-request',
  options: {
    headers?: Record<string, string>;
    url?: string;
    redirected?: boolean;
  } = {},
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    url: options.url ?? `${DELETION_ORIGIN}/v1/me/${path}`,
    redirected: options.redirected ?? false,
    headers: {
      get: (name: string) => options.headers?.[name.toLowerCase()] ?? null,
    },
    text: async () => JSON.stringify(payload),
  } as Response;
}

export function deferredDeletion<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export const deletionKeychainStore = (
  Keychain as unknown as {
    __keychainStore: Map<string, { username: string; password: string }>;
  }
).__keychainStore;

export function deletionSecretRecord(): DeletionSecretRecord {
  return {
    version: 1,
    jobId: deletionId(1),
    ownerId: DELETION_OWNER_A,
    apiOrigin: DELETION_ORIGIN,
    ...deletionRequestPayload(),
    receipt: null,
  };
}

export function availableDeletion(result: DeletionOperationResult) {
  expect(result.kind).toBe('available');
  if (result.kind !== 'available')
    throw new Error('Expected an available deletion journal.');
  return result;
}

export function deletionFixture() {
  const database = createSqliteTestDb();
  const clock = { now: DELETION_NOW };
  const lifecycle = {
    owner: { ownerKey: DELETION_OWNER_A, generation: 1 },
    origin: { apiOrigin: DELETION_ORIGIN as string | null, generation: 1 },
    bearer: DELETION_SESSION as string | null,
  };
  const runtime = {
    ownerSnapshot: () => ({ ...lifecycle.owner }),
    originSnapshot: () => ({ ...lifecycle.origin }),
    bearerFor: jest.fn((owner: { ownerKey: string; generation: number }) =>
      owner.ownerKey === lifecycle.owner.ownerKey &&
      owner.generation === lifecycle.owner.generation
        ? lifecycle.bearer
        : null,
    ),
  };
  const keychain = {
    ACCESSIBLE: Keychain.ACCESSIBLE,
    setGenericPassword: jest.fn(Keychain.setGenericPassword),
    getGenericPassword: jest.fn(Keychain.getGenericPassword),
  };
  const http = {
    fetchNoRedirect: jest.fn<Promise<Response>, [string, RequestInit]>(
      async (_url, _init) => deletionResponse(deletionRequestPayload()),
    ),
  };
  const release = jest.fn(async () => {});
  const maintenance = {
    acquire: jest.fn(async (request: DeletionMaintenanceRequest) => ({
      binding: request.binding,
      isCurrent: () => true,
      release,
    })),
  };
  const cleanup = jest.fn<
    Promise<'checkpointed' | 'pending'>,
    [DeletionCleanupWork]
  >(async () => 'pending');
  let nextId = 1;
  const dependencies: DeletionFoundationDependencies = {
    db: database.db,
    keychain,
    runtime,
    http,
    newJobId: () => deletionId(nextId++),
    now: () => clock.now,
    maintenance,
    cleanup,
  };
  const create = (overrides: Partial<DeletionFoundationDependencies> = {}) =>
    createDeletionOperationFoundation({ ...dependencies, ...overrides });
  return {
    database,
    clock,
    lifecycle,
    runtime,
    keychain,
    http,
    maintenance,
    release,
    cleanup,
    create,
    foundation: create(),
  };
}
