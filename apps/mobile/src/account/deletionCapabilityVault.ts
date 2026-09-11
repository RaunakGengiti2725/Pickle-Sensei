import type * as Keychain from 'react-native-keychain';
import { isVerifiedDeletionReceipt } from './deletionOperationTransport';
import {
  DELETION_FOUNDATION_LIMITS,
  DeletionFoundationError,
  deletionRecord,
  deletionUuid,
  parseDeletionReceipt,
  parseDeletionSecret,
  sameDeletionBinding,
  sameDeletionReceipt,
  validDeletionBinding,
  type DeletionBinding,
  type DeletionReceipt,
  type DeletionSecretRecord,
} from './deletionOperationContracts';

export type DeletionKeychain = Pick<
  typeof Keychain,
  'ACCESSIBLE' | 'getGenericPassword' | 'setGenericPassword'
>;

export type DeletionVaultRead =
  | { readonly kind: 'available'; readonly record: DeletionSecretRecord }
  | {
      readonly kind:
        'empty' | 'unavailable' | 'invalid' | 'unsupported' | 'conflict';
    };

export type DeletionVaultWrite =
  | { readonly kind: 'saved' }
  | {
      readonly kind: 'refused';
      readonly reason:
        'unavailable' | 'invalid' | 'unsupported' | 'conflict' | 'empty';
    }
  | {
      readonly kind: 'ambiguous';
      readonly acknowledgement: 'accepted' | 'false' | 'threw';
      readonly verification:
        | 'matched'
        | 'empty'
        | 'unavailable'
        | 'invalid'
        | 'unsupported'
        | 'conflict';
    };

const ACCOUNT = 'deletion-operation-v1';
const queues = new Map<string, Promise<void>>();

export function deletionCapabilityService(jobId: string): string {
  if (!deletionUuid(jobId))
    throw new DeletionFoundationError('invalid_binding');
  return `com.picklesensei.account-deletion.v1.${jobId}`;
}

function serialized<T>(
  service: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(service) ?? Promise.resolve();
  const next = previous.then(operation);
  const settled = next.then(
    () => {},
    () => {},
  );
  queues.set(service, settled);
  void settled.then(() => {
    if (queues.get(service) === settled) queues.delete(service);
  });
  return next;
}

function validBinding(binding: DeletionBinding): boolean {
  try {
    return validDeletionBinding(binding);
  } catch {
    return false;
  }
}

function sameSecret(a: DeletionSecretRecord, b: DeletionSecretRecord): boolean {
  return (
    sameDeletionBinding(a, b) &&
    a.challenge === b.challenge &&
    a.statusCapability === b.statusCapability &&
    a.expiresAt === b.expiresAt &&
    a.statusExpiresAt === b.statusExpiresAt &&
    sameDeletionReceipt(a.receipt, b.receipt)
  );
}

export function createDeletionCapabilityVault(keychain: DeletionKeychain) {
  async function readRaw(binding: DeletionBinding): Promise<DeletionVaultRead> {
    const service = deletionCapabilityService(binding.jobId);
    try {
      const stored = await keychain.getGenericPassword({
        service,
        cloudSync: false,
      });
      if (stored === false) return { kind: 'empty' };
      if (
        !stored ||
        stored.service !== service ||
        stored.username !== ACCOUNT ||
        typeof stored.password !== 'string' ||
        stored.password.length > DELETION_FOUNDATION_LIMITS.secretBytes
      )
        return { kind: 'invalid' };
      let value: unknown;
      try {
        value = JSON.parse(stored.password);
      } catch {
        return { kind: 'invalid' };
      }
      if (
        deletionRecord(value) &&
        typeof value.version === 'number' &&
        value.version !== 1
      )
        return { kind: 'unsupported' };
      const record = parseDeletionSecret(value);
      if (!record) return { kind: 'invalid' };
      return sameDeletionBinding(record, binding)
        ? { kind: 'available', record }
        : { kind: 'conflict' };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  async function writeAndVerify(
    record: DeletionSecretRecord,
  ): Promise<DeletionVaultWrite> {
    let acknowledgement: 'accepted' | 'false' | 'threw';
    const service = deletionCapabilityService(record.jobId);
    try {
      const accessible =
        keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY;
      if (!accessible) return { kind: 'refused', reason: 'unavailable' };
      const result = await keychain.setGenericPassword(
        ACCOUNT,
        JSON.stringify(record),
        { service, accessible, cloudSync: false },
      );
      acknowledgement =
        result !== false && result?.service === service ? 'accepted' : 'false';
    } catch {
      acknowledgement = 'threw';
    }
    const read = await readRaw(record);
    const verification =
      read.kind === 'available'
        ? sameSecret(read.record, record)
          ? 'matched'
          : 'conflict'
        : read.kind;
    return acknowledgement === 'accepted' && verification === 'matched'
      ? { kind: 'saved' }
      : { kind: 'ambiguous', acknowledgement, verification };
  }

  return Object.freeze({
    async read(binding: DeletionBinding): Promise<DeletionVaultRead> {
      if (!validBinding(binding)) return { kind: 'invalid' };
      const snapshot = Object.freeze({
        jobId: binding.jobId,
        ownerId: binding.ownerId,
        apiOrigin: binding.apiOrigin,
        operationId: binding.operationId,
      });
      return serialized(deletionCapabilityService(snapshot.jobId), () =>
        readRaw(snapshot),
      );
    },
    async store(value: DeletionSecretRecord): Promise<DeletionVaultWrite> {
      const record = parseDeletionSecret(value);
      if (!record || record.receipt !== null)
        return { kind: 'refused', reason: 'invalid' };
      return serialized(deletionCapabilityService(record.jobId), async () => {
        const previous = await readRaw(record);
        if (previous.kind === 'available') {
          return sameSecret(previous.record, record)
            ? { kind: 'saved' }
            : { kind: 'refused', reason: 'conflict' };
        }
        if (previous.kind !== 'empty')
          return { kind: 'refused', reason: previous.kind };
        return writeAndVerify(record);
      });
    },
    async sealReceipt(
      binding: DeletionBinding,
      value: DeletionReceipt,
    ): Promise<DeletionVaultWrite> {
      const receipt = parseDeletionReceipt(value);
      if (
        !validBinding(binding) ||
        !receipt ||
        !isVerifiedDeletionReceipt(value, binding)
      )
        return { kind: 'refused', reason: 'invalid' };
      const snapshot = Object.freeze({
        jobId: binding.jobId,
        ownerId: binding.ownerId,
        apiOrigin: binding.apiOrigin,
        operationId: binding.operationId,
      });
      return serialized(deletionCapabilityService(snapshot.jobId), async () => {
        const previous = await readRaw(snapshot);
        if (previous.kind !== 'available')
          return { kind: 'refused', reason: previous.kind };
        if (previous.record.receipt !== null) {
          return sameDeletionReceipt(previous.record.receipt, receipt)
            ? { kind: 'saved' }
            : { kind: 'refused', reason: 'conflict' };
        }
        return writeAndVerify(Object.freeze({ ...previous.record, receipt }));
      });
    },
  });
}
