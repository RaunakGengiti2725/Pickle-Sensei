/**
 * Local structured data is partitioned by an explicit owner. Synced owners are
 * canonical backend UUIDs; unsigned device use lives in a separate guest
 * bucket. A signed-out process has no readable/writable product bucket.
 */

export const GUEST_DATA_OWNER = 'device-guest';
export const SIGNED_OUT_DATA_OWNER = 'signed-out';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let activeOwner = SIGNED_OUT_DATA_OWNER;
let ownerGeneration = 0;
let ownerSnapshot: DataOwnerContext = Object.freeze({
  ownerKey: activeOwner,
  generation: ownerGeneration,
});
const ownerListeners = new Set<() => void>();

export interface DataOwnerContext {
  readonly ownerKey: string;
  readonly generation: number;
}

export class DataOwnerChangedError extends Error {
  constructor() {
    super('The account changed before this operation could finish.');
    this.name = 'DataOwnerChangedError';
  }
}

export function canonicalDataOwner(canonicalAppUserId: string): string {
  const normalized = canonicalAppUserId.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error('Local account scope requires a canonical backend UUID.');
  }
  return normalized;
}

export function setActiveDataOwner(owner: string): void {
  if (
    owner !== GUEST_DATA_OWNER &&
    owner !== SIGNED_OUT_DATA_OWNER &&
    !UUID_PATTERN.test(owner)
  ) {
    throw new Error('Invalid local data owner.');
  }
  const normalized = owner.toLowerCase();
  if (normalized === activeOwner) return;
  ownerGeneration += 1;
  activeOwner = normalized;
  ownerSnapshot = Object.freeze({
    ownerKey: activeOwner,
    generation: ownerGeneration,
  });
  ownerListeners.forEach(listener => listener());
}

export function getDataOwnerSnapshot(): DataOwnerContext {
  return ownerSnapshot;
}

export function subscribeToDataOwner(listener: () => void): () => void {
  ownerListeners.add(listener);
  return () => {
    ownerListeners.delete(listener);
  };
}

export function getActiveDataOwner(): string {
  return activeOwner;
}

export function requireWritableDataOwner(): string {
  if (activeOwner === SIGNED_OUT_DATA_OWNER) {
    throw new Error('Sign in or continue locally before saving product data.');
  }
  return activeOwner;
}

export function captureDataOwnerContext(): DataOwnerContext {
  return Object.freeze({
    ownerKey: requireWritableDataOwner(),
    generation: ownerGeneration,
  });
}

export function isDataOwnerContextCurrent(context: DataOwnerContext): boolean {
  return (
    context.ownerKey !== SIGNED_OUT_DATA_OWNER &&
    context.ownerKey === activeOwner &&
    context.generation === ownerGeneration
  );
}

export function assertDataOwnerContext(context: DataOwnerContext): void {
  if (!isDataOwnerContextCurrent(context)) throw new DataOwnerChangedError();
}

export function profileKeyForOwner(owner: string): string {
  return `profile:${owner}`;
}
