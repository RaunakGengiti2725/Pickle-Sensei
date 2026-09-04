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
  activeOwner = owner.toLowerCase();
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

/**
 * Per-owner count of bucket purges (account deletion) in this process. Work
 * that captured an owner's generation before going off the connection — the
 * outbox drain while it awaits the server — compares it again before writing
 * anything for that owner: a purge in between means the bucket it was
 * working on no longer exists and nothing may be written back into it.
 */
const purgeGenerations = new Map<string, number>();

export function ownerPurgeGeneration(owner: string): number {
  return purgeGenerations.get(owner) ?? 0;
}

export function notePurgedOwnerData(owner: string): void {
  purgeGenerations.set(owner, ownerPurgeGeneration(owner) + 1);
}

export function profileKeyForOwner(owner: string): string {
  return `profile:${owner}`;
}
