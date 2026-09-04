import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { orderMigrations } from "../src/migrate.js";
import { SEEDED_FEATURE_FLAGS } from "../src/seed.js";

/**
 * Structural audit probes (auditor #2) for the migration runner's ordering
 * contract and the seed's flag table. Pure unit tests, no database.
 */

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

describe("migration ordering contract", () => {
  const committed = orderMigrations(readdirSync(migrationsDir));

  it("every committed migration file matches the runner's name regex (none silently ignored)", () => {
    const all = readdirSync(migrationsDir).filter((n) => n.endsWith(".sql"));
    expect(committed.sort()).toEqual(all.sort());
  });

  it("OBSERVATION: numeric prefixes are NOT unique — ordering inside a prefix is alphabetical by description", () => {
    const byPrefix = new Map<string, string[]>();
    for (const name of committed) {
      const prefix = name.slice(0, 4);
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
    }
    const duplicates = [...byPrefix.entries()].filter(([, names]) => names.length > 1);
    // Documented here as a fact about 4d812e1a; the assertion pins that the runner
    // sorts by full filename so a new `0019_a…` file would run BEFORE the already
    // committed `0019_analysis_feedback.sql` on a fresh database.
    expect(
      duplicates.map(([prefix, names]) => `${prefix}×${names.length}`),
      JSON.stringify(Object.fromEntries(duplicates)),
    ).toEqual([]);
  });

  it("a later-authored file with a shared prefix and an alphabetically earlier name sorts BEFORE committed siblings", () => {
    const hypothetical = "0019_aaa_added_later.sql";
    const ordered = orderMigrations([...committed, hypothetical]);
    const firstNineteen = ordered.find((n) => n.startsWith("0019_"));
    expect(firstNineteen).toBe(hypothetical);
  });

  it("names with uppercase, dashes or dots are rejected rather than mis-ordered", () => {
    expect(
      orderMigrations([
        "0020_Bad-Name.sql",
        "0020_ok_name.sql",
        "0020.name.sql",
        "0020_ok.sql.bak",
      ]),
    ).toEqual(["0020_ok_name.sql"]);
  });
});

describe("seeded feature flags", () => {
  it("have unique keys, boolean defaults and rollout percent consistent with enabled", () => {
    const keys = SEEDED_FEATURE_FLAGS.map(([key]) => key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const [key, , enabled, rollout] of SEEDED_FEATURE_FLAGS) {
      expect(typeof enabled, key).toBe("boolean");
      expect(rollout, key).toBeGreaterThanOrEqual(0);
      expect(rollout, key).toBeLessThanOrEqual(100);
      // An enabled flag at 0% or a disabled flag at 100% would be a contradictory default.
      expect(
        enabled ? rollout > 0 : rollout === 0,
        `${key}: enabled=${enabled} rollout=${rollout}`,
      ).toBe(true);
    }
  });
});
