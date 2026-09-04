import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAMPAIGNS,
  campaignByName,
  replay,
  runCampaign,
  type CampaignReport,
  type SequenceOutcome,
} from "./randomizedSeeded.harness.js";

/**
 * Seeded randomized long-run stress suite for @pickle/swing-lab.
 *
 *   STRESS_ITER   sequences per campaign (default 12 — a few seconds; the
 *                 recorded campaign used 2000+ per campaign)
 *   STRESS_SEED   override the seed base offset (default 0)
 *   STRESS_OUT    when set, the seed → outcome JSON table is written there
 *   STRESS_ONLY   comma-separated campaign names to run (default: all)
 *   STRESS_STRICT when "1", violations observed under NEAR-LEGAL input
 *                 (NaN/Infinity or out-of-order timestamps injected into the
 *                 stream) also fail the run. By default they are recorded in
 *                 the table as BROKEN_NEAR_LEGAL and reported, but only
 *                 violations under legal (finite, ordered) input fail.
 *   STRESS_REPLAY "<campaign>:<seed>[:i,j,k]" — replay one (minimized) case
 *                 and print its per-action description + violations.
 *
 * Every sequence is replayable from its seed; failures are minimized by the
 * harness and reported with the kept action indices, so a red run prints a
 * copy-pasteable STRESS_REPLAY value.
 *
 * Known legal-input failure at the recorded scale (STRESS_ITER=2000): the
 * session_batching campaign shows SessionEventEngine emitting different
 * events depending on push chunk size (85/2000 seeds, first 200037; minimal
 * repro `STRESS_REPLAY=session_batching:200110:0` — one push of the whole
 * series vs. per-sample pushes of the same series). The default 12-seed run
 * does not reach those seeds.
 */

const iterations = Math.max(1, Number.parseInt(process.env.STRESS_ITER ?? "12", 10) || 12);
const seedOffset = Number.parseInt(process.env.STRESS_SEED ?? "0", 10) || 0;
const strict = process.env.STRESS_STRICT === "1";
const only = process.env.STRESS_ONLY?.split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const selected = CAMPAIGNS.filter((campaign) => !only || only.includes(campaign.name));

function describeFailure(outcome: SequenceOutcome): string {
  const minimized = outcome.minimized;
  const replayKey = minimized
    ? `${outcome.campaign}:${outcome.seed}:${minimized.keptActionIndices.join(",")}`
    : `${outcome.campaign}:${outcome.seed}`;
  const first = minimized?.violation ?? outcome.violations[0]!;
  return (
    `seed ${outcome.seed} (${outcome.outcome}, len ${outcome.length}${minimized ? `, minimized to ${minimized.length}` : ""}) ` +
    `${first.rule} @step ${first.step} [${first.action}]: ${first.detail}\n  STRESS_REPLAY=${replayKey}`
  );
}

describe("swing-lab randomized-seeded stress (replayable, model-checked per action)", () => {
  const reports: CampaignReport[] = [];

  for (const campaign of selected) {
    it(
      `${campaign.name}: ${iterations} seeded sequences hold every invariant and replay deterministically`,
      { timeout: 0 },
      () => {
        const report = runCampaign(campaign, {
          iterations,
          seedBase: campaign.seedBase + seedOffset,
          flakeReruns: 10,
        });
        reports.push(report);
        // Sequence-length contract of the lens: every sequence has 5..60 actions.
        for (const outcome of report.outcomes) {
          expect(outcome.length).toBeGreaterThanOrEqual(5);
          expect(outcome.length).toBeLessThanOrEqual(60);
        }
        const failures = report.outcomes.filter(
          (outcome) =>
            outcome.outcome === "BROKEN" || (strict && outcome.outcome === "BROKEN_NEAR_LEGAL"),
        );
        expect(
          failures.length,
          `${failures.length} BROKEN sequence(s):\n${failures.map(describeFailure).join("\n")}`,
        ).toBe(0);
        expect(report.nonDeterministic).toBe(0);
      },
    );
  }

  it("writes the seed → outcome table when STRESS_OUT is set", () => {
    const out = process.env.STRESS_OUT;
    if (!out) return;
    const path = resolve(out);
    mkdirSync(dirname(path), { recursive: true });
    const table = reports.flatMap((report) =>
      report.outcomes.map((outcome) => ({
        campaign: outcome.campaign,
        seed: outcome.seed,
        length: outcome.length,
        outcome: outcome.outcome,
        deterministic: outcome.deterministic,
        traceHash: outcome.traceHash,
        violations: outcome.violations,
        minimized: outcome.minimized ?? null,
        flakeRate: report.flakeRates[String(outcome.seed)] ?? null,
        replayIdentical: report.replayIdenticalSeeds.includes(outcome.seed),
        metrics: outcome.metrics,
        durationMs: outcome.durationMs,
      })),
    );
    const summary = reports.map((report) => ({
      campaign: report.campaign,
      iterations: report.iterations,
      seedBase: report.seedBase,
      held: report.held,
      broken: report.broken,
      brokenNearLegal: report.brokenNearLegal,
      nonDeterministic: report.nonDeterministic,
      actionsExecuted: report.actionsExecuted,
      metricsTotal: report.metricsTotal,
      flakeRates: report.flakeRates,
    }));
    writeFileSync(
      path,
      JSON.stringify(
        {
          lens: "randomized-seeded",
          unit: "packages/swing-lab",
          generatedAt: new Date().toISOString(),
          iterationsPerCampaign: iterations,
          seedOffset,
          strict,
          sequenceLength: { min: 5, max: 60 },
          totals: {
            sequences: table.length,
            held: summary.reduce((sum, entry) => sum + entry.held, 0),
            broken: summary.reduce((sum, entry) => sum + entry.broken, 0),
            brokenNearLegal: summary.reduce((sum, entry) => sum + entry.brokenNearLegal, 0),
            actionsExecuted: summary.reduce((sum, entry) => sum + entry.actionsExecuted, 0),
          },
          campaigns: summary,
          table,
        },
        null,
        1,
      ),
    );
  });

  it("STRESS_REPLAY replays one recorded (minimized) case", () => {
    const key = process.env.STRESS_REPLAY;
    if (!key) return;
    const [name, seedText, indicesText] = key.split(":");
    const campaign = campaignByName(name ?? "");
    const seed = Number.parseInt(seedText ?? "", 10);
    expect(Number.isFinite(seed)).toBe(true);
    const indices = indicesText
      ? indicesText.split(",").map((index) => Number.parseInt(index, 10))
      : undefined;
    const result = replay(campaign, seed, indices);
    // Printed on purpose: this mode exists to inspect a case, not to gate CI.
    console.log(
      JSON.stringify(
        {
          campaign: name,
          seed,
          actions: result.actions,
          violations: result.violations,
          metrics: result.metrics,
        },
        null,
        2,
      ),
    );
    expect(
      result.violations,
      result.violations.map((v) => `${v.rule}@${v.step}: ${v.detail}`).join("\n"),
    ).toEqual([]);
  });
});
