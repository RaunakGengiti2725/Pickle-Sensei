import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../context.js";
import { many } from "../../lib/db.js";

/**
 * Remote feature flags (directive §36). Percentage rollout is a stable hash of
 * (flagKey, userId) — a user's cohort never flaps between requests.
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
    const flags = await many<{ key: string; enabled: boolean; rollout_percent: number }>(
      context.pool!,
      "SELECT key, enabled, rollout_percent FROM feature_flag",
      [],
    );
    const evaluated: Record<string, boolean> = {};
    for (const flag of flags) evaluated[flag.key] = evaluateFlag(flag, request.user!.id);
    return { flags: evaluated };
  });
}
