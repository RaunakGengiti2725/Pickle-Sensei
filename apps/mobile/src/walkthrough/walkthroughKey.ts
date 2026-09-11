/**
 * The first-run walkthrough's durable "seen" record is owner-scoped
 * (`walkthrough.complete:<owner>`), so every account gets its own tour and
 * account deletion purges it with the rest of the owner's kv
 * (repository.ts OWNER_SCOPED_KV_NAMESPACES). Kept apart from the store so
 * pure callers and tests can build the key without loading the native
 * database module.
 */
export const WALKTHROUGH_KV_NAMESPACE = 'walkthrough.complete';
export const WALKTHROUGH_SEEN_VALUE = JSON.stringify({ version: 1 });

export function walkthroughKeyForOwner(owner: string): string {
  return `${WALKTHROUGH_KV_NAMESPACE}:${owner}`;
}
