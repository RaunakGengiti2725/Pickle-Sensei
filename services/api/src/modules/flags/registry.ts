import { createHash } from "node:crypto";

/**
 * Versioned feature-flag registry (directive §36 hardening).
 *
 * Every remotely-served flag is declared here with a schema version, a safe
 * default (the value served when the database row is missing or unreadable),
 * an owner, and a mandatory review-by date. Flags past their review-by date
 * fail CI loudly (see test/flagsRegistry.test.ts) — the expiry policy that
 * keeps obsolete flags from accumulating.
 *
 * High-risk features additionally carry a process-environment kill switch
 * (`FLAG_KILL_<KEY>`; any of "1", "true", "on"). A pulled kill switch forces
 * the flag to `false` for every user regardless of database state — it works
 * even when the flags table is unreachable, which is the whole point of a
 * kill switch.
 */

export interface FlagDefinition {
  key: string;
  /** Semantic version of this flag's meaning; bump on any behavior change. */
  version: number;
  description: string;
  owner: string;
  /** ISO date the flag was registered. */
  introducedOn: string;
  /**
   * ISO date by which the flag must be re-reviewed (extended or removed).
   * A registry entry past this date fails CI — the expiry policy.
   */
  reviewBy: string;
  /** Value served when no database row exists for the flag. */
  safeDefaultEnabled: boolean;
  /** Rollout percent served when no database row exists for the flag. */
  safeDefaultRolloutPercent: number;
  /** High-risk features get an environment kill switch. */
  killSwitch: boolean;
}

export const FLAG_REGISTRY_VERSION = 1;

const REVIEW_HORIZON = "2027-02-28";

function flag(
  key: string,
  description: string,
  safeDefaultEnabled: boolean,
  killSwitch: boolean,
): FlagDefinition {
  return {
    key,
    version: 1,
    description,
    owner: "platform",
    introducedOn: "2026-08-29",
    reviewBy: REVIEW_HORIZON,
    safeDefaultEnabled,
    safeDefaultRolloutPercent: safeDefaultEnabled ? 100 : 0,
    killSwitch,
  };
}

/**
 * The declared flag universe. Seed rows (packages/database/src/seed.ts) and
 * admin writes may override enabled/rollout, but a flag that is not declared
 * here has no registry version, no review date, and no kill switch — the
 * registry sync test keeps the seed list and this list identical.
 */
export const FLAG_REGISTRY: readonly FlagDefinition[] = [
  // Product flags (previously seed-only; now versioned with safe defaults).
  flag("live_court", "Live Court mode", true, false),
  flag("ball_tracking", "Ball tracking metrics", false, false),
  flag("cloud_deep_analysis", "Cloud deep analysis", false, false),
  flag("reference_comparison", "Pro reference comparison", false, false),
  flag("social", "Friends and activity", true, false),
  flag("leaderboards", "Friends leaderboards", true, false),
  flag("experimental_camera_setup", "Experimental camera preflight", false, false),
  flag("paywall_v1", "Launch paywall", true, false),
  flag("stroke_return", "Return stroke analysis", false, false),
  flag("stroke_backhand_drive", "Backhand drive analysis", false, false),
  flag("stroke_volley", "Volley analysis", false, false),
  flag("stroke_overhead", "Overhead analysis", false, false),
  // High-risk feature kill switches. Enabled by default (these are shipped
  // core behaviors); a pulled kill switch forces false for every user.
  flag("auto_detect", "New AUTO DETECT stroke resolution", true, true),
  flag("contact_model", "Contact-moment model", true, true),
  flag("scoring_engine", "Stroke scoring", true, true),
  flag("drill_ranker", "Training-plan drill ranker", true, true),
  flag("session_processing", "Server-side session finalize/summary", true, true),
  flag("stroke_detector", "Temporal stroke detector", true, true),
];

const BY_KEY: ReadonlyMap<string, FlagDefinition> = new Map(FLAG_REGISTRY.map((f) => [f.key, f]));

export function flagDefinition(key: string): FlagDefinition | undefined {
  return BY_KEY.get(key);
}

export function killSwitchEnvName(key: string): string {
  return `FLAG_KILL_${key.toUpperCase()}`;
}

const KILL_VALUES = new Set(["1", "true", "on"]);

/** Keys of registered kill-switch flags whose switch is pulled in `env`. */
export function activeKillSwitches(env: NodeJS.ProcessEnv): readonly string[] {
  return FLAG_REGISTRY.filter(
    (f) => f.killSwitch && KILL_VALUES.has((env[killSwitchEnvName(f.key)] ?? "").toLowerCase()),
  ).map((f) => f.key);
}

/** Flags whose review-by date has passed as of `today` (ISO date). */
export function expiredFlags(
  registry: readonly FlagDefinition[],
  today: string,
): readonly FlagDefinition[] {
  return registry.filter((f) => f.reviewBy < today);
}

/** Whether the kill switch for a registered kill-switch flag is pulled. */
export function killSwitchPulled(key: string, env: NodeJS.ProcessEnv): boolean {
  const definition = BY_KEY.get(key);
  if (!definition?.killSwitch) return false;
  return KILL_VALUES.has((env[killSwitchEnvName(key)] ?? "").toLowerCase());
}

/**
 * Deterministic fingerprint of the server's flag configuration surface:
 * registry version, every flag's key/version/safe default, and which kill
 * switches are pulled. Included in telemetry so an incident can be tied to
 * the exact flag configuration that served it. Per-user rollout evaluation
 * is intentionally excluded — this is configuration provenance, not a user
 * identifier.
 */
export function flagStateFingerprint(env: NodeJS.ProcessEnv): string {
  const killed = new Set(activeKillSwitches(env));
  const lines = FLAG_REGISTRY.map(
    (f) =>
      `${f.key}@${f.version}:${f.safeDefaultEnabled ? "on" : "off"}:${killed.has(f.key) ? "killed" : "live"}`,
  ).sort();
  return createHash("sha256")
    .update(`registry-v${FLAG_REGISTRY_VERSION}\n${lines.join("\n")}`)
    .digest("hex")
    .slice(0, 16);
}
