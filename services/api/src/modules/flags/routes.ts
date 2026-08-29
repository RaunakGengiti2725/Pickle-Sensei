import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.js";
import { many } from "../../lib/db.js";
import {
  FLAG_REGISTRY,
  FLAG_REGISTRY_VERSION,
  activeKillSwitches,
  flagStateFingerprint,
} from "./registry.js";

/**
 * Remote feature flags (directive §36). Percentage rollout is a stable hash of
 * (flagKey, userId) — a user's cohort never flaps between requests.
 *
 * Hardening: every registered flag is always present in the response (safe
 * default when the database row is missing), pulled kill switches force their
 * flag to false for every user, and the response carries the registry version
 * plus a flag-state fingerprint so clients can attach the exact flag
 * configuration to their telemetry/provenance.
 */

function rolloutBucket(flagKey: string, userId: string): number {
  const digest = createHash("sha256").update(`${flagKey}:${userId}`).digest();
  return ((digest[0]! << 8) | digest[1]!) % 100;
}

function evaluateFlag(
  flag: { key: string; enabled: boolean; rollout_percent: number },
  userId: string,
): boolean {
  if (!flag.enabled) return false;
  if (flag.rollout_percent >= 100) return true;
  return rolloutBucket(flag.key, userId) < flag.rollout_percent;
}

export function registerFlagRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/v1/flags", { preHandler: app.authenticate }, async (request) => {
    const rows = await many<{ key: string; enabled: boolean; rollout_percent: number }>(
      context.pool!,
      "SELECT key, enabled, rollout_percent FROM feature_flag",
      [],
    );
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const killed = new Set(activeKillSwitches(process.env));

    const evaluated: Record<string, boolean> = {};
    const versions: Record<string, number> = {};
    for (const definition of FLAG_REGISTRY) {
      const row = byKey.get(definition.key) ?? {
        key: definition.key,
        enabled: definition.safeDefaultEnabled,
        rollout_percent: definition.safeDefaultRolloutPercent,
      };
      evaluated[definition.key] = killed.has(definition.key)
        ? false
        : evaluateFlag(row, request.user!.id);
      versions[definition.key] = definition.version;
      byKey.delete(definition.key);
    }
    // Rows without a registry entry (e.g. ad-hoc admin writes) still evaluate,
    // but carry no version — the registry sync test keeps this set empty for
    // seeded flags.
    for (const row of byKey.values()) evaluated[row.key] = evaluateFlag(row, request.user!.id);

    return {
      flags: evaluated,
      flagState: {
        registryVersion: FLAG_REGISTRY_VERSION,
        versions,
        killSwitchesActive: [...killed].sort(),
        fingerprint: flagStateFingerprint(process.env),
      },
    };
  });
}
