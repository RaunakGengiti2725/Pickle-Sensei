import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_LENGTH,
  MIN_LENGTH,
  generateSequence,
  runCampaign,
  runSequence,
  type CampaignReport,
} from "./stress/campaign.js";
import { stableJson } from "./stress/prng.js";

/**
 * Seeded randomized long-run over the capture-envelope public API
 * (evaluateCaptureEnvelope, classifyDimension, pixel statistics, G08 label
 * validator + evidence gate). Pure Node — no ffmpeg, no fixtures on disk.
 *
 * Default is a small smoke campaign so the suite stays fast; the full run is
 *
 *   STRESS_ITER=2000 STRESS_OUT=/tmp/ce-stress \
 *     pnpm --filter @pickle/capture-envelope exec vitest run test/stressRandomizedSeeded.test.ts
 *
 * Every sequence is replayable from its seed: runSequence(generateSequence(seed)).
 * The report (seed → outcome table, per-code violation index, minimised repros)
 * is written to STRESS_OUT/report.json.
 *
 * Contract pins (legal tier — inputs inside the declared TypeScript types):
 *   no legal-tier violation, every seed deterministic. Near-legal findings
 *   (values a JS caller can still pass) are recorded in the report and pinned
 *   below as the CURRENT behaviour so a silent change is visible.
 */
const ITER = Number(process.env.STRESS_ITER ?? "200");
const SEED_FROM = Number(process.env.STRESS_SEED_FROM ?? "1");
const OUT_DIR = resolve(
  process.env.STRESS_OUT ??
    resolve(__dirname, "../../../artifacts/stress/capture-envelope-randomized-seeded"),
);

let reportPromise: Promise<CampaignReport> | null = null;
const report = (): Promise<CampaignReport> => {
  reportPromise ??= Promise.resolve().then(() => {
    const value = runCampaign(SEED_FROM, ITER);
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(resolve(OUT_DIR, "report.json"), JSON.stringify(value, null, 2));
    writeFileSync(
      resolve(OUT_DIR, "summary.json"),
      JSON.stringify({ ...value, table: undefined }, null, 2),
    );
    writeFileSync(
      resolve(OUT_DIR, "seed-table.json"),
      JSON.stringify(
        value.table.map((row) => ({
          seed: row.seed,
          length: row.length,
          outcome: row.outcome,
          deterministic: row.deterministic,
          traceHash: row.traceHash,
          legalViolations: row.legalViolations,
          nearLegalViolations: row.nearLegalViolations,
          codes: row.codes,
        })),
        null,
        2,
      ),
    );
    return value;
  });
  return reportPromise;
};

describe("capture-envelope randomized-seeded long-run", () => {
  it("runs every seed with a 5–60 step sequence and writes the replayable seed table", async () => {
    const value = await report();
    expect(value.sequences).toBe(ITER);
    expect(value.scenariosExecuted).toBeGreaterThanOrEqual(ITER * MIN_LENGTH);
    expect(value.lengthRange.min).toBeGreaterThanOrEqual(MIN_LENGTH);
    expect(value.lengthRange.max).toBeLessThanOrEqual(MAX_LENGTH);
    for (const row of value.table) {
      expect(row.seed).toBeGreaterThanOrEqual(SEED_FROM);
      expect(row.length).toBeGreaterThanOrEqual(MIN_LENGTH);
      expect(row.length).toBeLessThanOrEqual(MAX_LENGTH);
    }
  }, 600_000);

  it("is deterministic: the same seed twice yields an identical action list and trace", async () => {
    const value = await report();
    expect(value.nonDeterministic).toEqual([]);
    const first = runSequence(generateSequence(SEED_FROM + 7));
    const second = runSequence(generateSequence(SEED_FROM + 7));
    expect(stableJson(generateSequence(SEED_FROM + 7))).toBe(
      stableJson(generateSequence(SEED_FROM + 7)),
    );
    expect(second.traceHash).toBe(first.traceHash);
    expect(second.violations).toEqual(first.violations);
  }, 600_000);

  it("holds every legal-tier invariant on every step of every sequence", async () => {
    const value = await report();
    const legal = Object.entries(value.violationsByCode).filter(([, v]) => v.tier === "legal");
    expect(legal, JSON.stringify(legal.slice(0, 5), null, 2)).toEqual([]);
    expect(value.table.every((row) => row.legalViolations === 0)).toBe(true);
  }, 600_000);

  it.skipIf(ITER < 50)(
    "exercises every action kind and both tiers at the default scale",
    async () => {
      const value = await report();
      for (const count of Object.values(value.actionCounts)) expect(count).toBeGreaterThan(0);
      expect(value.tierCounts.legal).toBeGreaterThan(0);
      expect(value.tierCounts.near_legal).toBeGreaterThan(0);
    },
    600_000,
  );

  it("records a minimised replay for every violation code it saw", async () => {
    const value = await report();
    for (const entry of value.minimised) {
      const replay = runSequence(entry.actions);
      expect(replay.violations.some((v) => v.code === entry.code)).toBe(true);
      expect(entry.minimisedLength).toBeLessThanOrEqual(entry.originalLength);
    }
  }, 600_000);

  it("pins the current near-legal behaviour (documented in the report, not a pass)", async () => {
    const value = await report();
    const codes = Object.entries(value.violationsByCode)
      .filter(([, v]) => v.tier === "near_legal")
      .map(([code]) => code)
      .sort();
    // Any code outside this list is NEW near-legal behaviour and must be triaged.
    const known = [
      // non-number measurement (undefined / string / boolean) is classified instead of NOT_MEASURED
      "env.status_mismatch",
      "env.measured_not_null",
      "env.measured_mismatch",
      "env.not_measured_mismatch",
      "env.coverage_mismatch",
      "env.overall_mismatch",
      "classify.oracle",
      // ±Infinity measurement leaks into `measured`
      "env.nonfinite_output",
      // meanAbsDiff on frames of different length returns NaN
      "pixel.meanAbsDiff_nonfinite",
      // validator accepts a self-/cyclic supersedes chain as valid
      "g08.supersedes_cycle_accepted",
    ];
    for (const code of codes) expect(known, `unexpected near-legal code ${code}`).toContain(code);
  }, 600_000);
});
