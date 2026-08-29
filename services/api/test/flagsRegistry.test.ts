import { describe, expect, it } from "vitest";
import { SEEDED_FEATURE_FLAGS } from "@pickle/database";
import {
  FLAG_REGISTRY,
  FLAG_REGISTRY_VERSION,
  activeKillSwitches,
  expiredFlags,
  flagDefinition,
  flagStateFingerprint,
  killSwitchEnvName,
  killSwitchPulled,
} from "../src/modules/flags/registry.js";

/**
 * Flag-registry hardening suite (no database required): versioned
 * definitions, safe defaults, kill switches, and the obsolete-flag expiry
 * policy. The expiry test is deliberately time-dependent — a flag left past
 * its review-by date MUST fail CI loudly until it is re-reviewed or removed.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const HIGH_RISK_KEYS = [
  "auto_detect",
  "contact_model",
  "scoring_engine",
  "drill_ranker",
  "session_processing",
  "stroke_detector",
] as const;

describe("flag registry definitions", () => {
  it("has a positive registry version and unique flag keys", () => {
    expect(FLAG_REGISTRY_VERSION).toBeGreaterThanOrEqual(1);
    const keys = FLAG_REGISTRY.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every flag is versioned with owner, dates, and a coherent safe default", () => {
    for (const flag of FLAG_REGISTRY) {
      expect(flag.version, flag.key).toBeGreaterThanOrEqual(1);
      expect(flag.owner, flag.key).not.toBe("");
      expect(flag.introducedOn, flag.key).toMatch(ISO_DATE);
      expect(flag.reviewBy, flag.key).toMatch(ISO_DATE);
      expect(Date.parse(flag.reviewBy), flag.key).toBeGreaterThan(Date.parse(flag.introducedOn));
      expect(flag.safeDefaultRolloutPercent, flag.key).toBe(flag.safeDefaultEnabled ? 100 : 0);
    }
  });

  it("every high-risk feature has a kill-switch flag", () => {
    for (const key of HIGH_RISK_KEYS) {
      const definition = flagDefinition(key);
      expect(definition, `missing kill-switch flag: ${key}`).toBeDefined();
      expect(definition!.killSwitch, key).toBe(true);
    }
  });

  it("stays in sync with the database seed list (keys and defaults)", () => {
    const seedKeys = SEEDED_FEATURE_FLAGS.map(([key]) => key).sort();
    const registryKeys = FLAG_REGISTRY.map((f) => f.key).sort();
    expect(registryKeys).toEqual(seedKeys);
    for (const [key, , enabled, rollout] of SEEDED_FEATURE_FLAGS) {
      const definition = flagDefinition(key)!;
      expect(definition.safeDefaultEnabled, key).toBe(enabled);
      expect(definition.safeDefaultRolloutPercent, key).toBe(rollout);
    }
  });
});

describe("obsolete-flag expiry policy", () => {
  it("no flag is past its review-by date — an expired flag fails CI until re-reviewed", () => {
    const today = new Date().toISOString().slice(0, 10);
    const expired = expiredFlags(FLAG_REGISTRY, today);
    expect(
      expired.map((f) => f.key),
      `EXPIRED FEATURE FLAGS: ${expired
        .map((f) => `${f.key} (review was due ${f.reviewBy}, owner ${f.owner})`)
        .join("; ")} — extend reviewBy after re-review or delete the flag`,
    ).toEqual([]);
  });

  it("detects a flag past its review-by date (policy mechanism sanity)", () => {
    const stale = { ...FLAG_REGISTRY[0]!, key: "stale_flag", reviewBy: "2026-01-01" };
    expect(expiredFlags([stale], "2026-08-29").map((f) => f.key)).toEqual(["stale_flag"]);
    expect(expiredFlags([stale], "2025-12-31")).toEqual([]);
  });
});

describe("kill switches", () => {
  it("are off by default and pulled by FLAG_KILL_<KEY> env values 1/true/on", () => {
    expect(activeKillSwitches({})).toEqual([]);
    expect(killSwitchEnvName("auto_detect")).toBe("FLAG_KILL_AUTO_DETECT");
    for (const value of ["1", "true", "on", "TRUE"]) {
      expect(killSwitchPulled("auto_detect", { FLAG_KILL_AUTO_DETECT: value })).toBe(true);
    }
    expect(killSwitchPulled("auto_detect", { FLAG_KILL_AUTO_DETECT: "0" })).toBe(false);
    expect(killSwitchPulled("auto_detect", { FLAG_KILL_AUTO_DETECT: "" })).toBe(false);
  });

  it("only registered kill-switch flags respond to the env variable", () => {
    expect(killSwitchPulled("live_court", { FLAG_KILL_LIVE_COURT: "1" })).toBe(false);
    expect(killSwitchPulled("nonexistent", { FLAG_KILL_NONEXISTENT: "1" })).toBe(false);
    expect(
      activeKillSwitches({ FLAG_KILL_LIVE_COURT: "1", FLAG_KILL_SCORING_ENGINE: "1" }),
    ).toEqual(["scoring_engine"]);
  });
});

describe("flag-state fingerprint", () => {
  it("is deterministic and changes when a kill switch is pulled", () => {
    const base = flagStateFingerprint({});
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(flagStateFingerprint({})).toBe(base);
    expect(flagStateFingerprint({ FLAG_KILL_AUTO_DETECT: "1" })).not.toBe(base);
    // Unrelated environment variables do not change the fingerprint.
    expect(flagStateFingerprint({ PATH: "/usr/bin", FLAG_KILL_LIVE_COURT: "1" })).toBe(base);
  });
});
