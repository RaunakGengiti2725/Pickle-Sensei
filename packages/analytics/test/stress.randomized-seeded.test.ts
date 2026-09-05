import { describe, expect, it } from "vitest";
import {
  campaignOptionsFromEnv,
  describeBreaks,
  heldInvariants,
  persistReport,
  runCampaign,
  type CampaignReport,
} from "./stress/campaign.js";
import { COST_INVARIANTS, costFamily } from "./stress/costFamily.js";
import { DRIFT_INVARIANTS, driftFamily } from "./stress/driftFamily.js";
import { REDACTION_INVARIANTS, redactionFamily } from "./stress/redactionFamily.js";

/**
 * Seeded randomized long-run campaign over the @pickle/analytics public API.
 *
 * Every sequence (length 5–60) is generated from a recorded seed, replayed
 * twice (trace equality = determinism), model-checked after every op, and
 * every failing seed is ddmin-minimized. STRESS_ITER controls the count
 * (default 40 per family so the suite stays fast; the campaign run for the
 * stress report used STRESS_ITER=2000 with STRESS_OUT set to persist the
 * seed → outcome JSON tables).
 *
 * Invariants live next to the families (REDACTION_INVARIANTS, DRIFT_INVARIANTS,
 * COST_INVARIANTS). Four are KNOWN GAPS in the code at the time the harness was
 * written (each is pinned as an `it.fails` in stress.known-gaps.test.ts). They
 * are still exercised and reported by the campaign, but only asserted when
 * STRESS_STRICT=1, so the default suite stays green without hiding them:
 *
 *  R-GUARD-PROBE           guard-intent probes: `data:`/`blob:` URIs (the
 *                          URI_SCHEME regex needs `:/` after the scheme, which
 *                          those forms never have), base64url payloads, paths
 *                          after `,:[;` and unlisted roots, identifier-key
 *                          synonyms (fileUrl, phoneNumber, ...)
 *  R-SINK-NO-SILENT-LOSS   BufferedAnalytics.flush() re-buffers only the last
 *                          maxBuffer events of a failed batch; older ones are
 *                          dropped with no counter
 *  D-PSI-FINITE            computePsi() reads bins with `reference[bin] ?? 0` on
 *                          a plain object, so a label that exists on only one
 *                          side and names an Object.prototype member
 *                          ("toString", "constructor", ...) yields NaN; a NaN
 *                          psi is classified "stable" and suppresses the alert
 *  C-FINITE                computeCost() rejects non-finite quantities but can
 *                          still return Infinity for finite ones (~1e302+)
 */

const KNOWN_GAPS = new Set<string>(
  process.env["STRESS_STRICT"] === "1"
    ? []
    : ["R-GUARD-PROBE", "R-SINK-NO-SILENT-LOSS", "D-PSI-FINITE", "C-FINITE"],
);

const options = campaignOptionsFromEnv();

function assertHardInvariants(report: CampaignReport, invariants: readonly string[]): void {
  if (process.env["STRESS_OUT"]) {
    // Campaign summary for the persisted evidence run (not printed in the default suite).
    console.info(
      `[stress ${report.family}] sequences=${report.sequences} ops=${report.totalOps} held=${report.held} broken=${report.broken} ` +
        `nondeterministic=${report.nondeterministic} failures=${JSON.stringify(report.failuresByInvariant)} coverage=${JSON.stringify(report.coverage)}`,
    );
  }
  const hard = invariants.filter((inv) => !KNOWN_GAPS.has(inv));
  const broken = hard.filter((inv) => inv in report.failuresByInvariant);
  expect(broken.map((inv) => describeBreaks(report, inv))).toEqual([]);
  expect(report.nondeterministic, "same seed twice must yield an identical trace").toBe(0);
  expect(heldInvariants(report, hard)).toEqual(hard);
}

describe(`stress randomized-seeded (STRESS_ITER=${options.count}, STRESS_SEED=${options.baseSeed})`, () => {
  it("redaction guard + BufferedAnalytics hold their documented invariants for every seed", async () => {
    const report = await runCampaign(redactionFamily, options);
    persistReport(report);
    expect(report.sequences).toBe(options.count);
    assertHardInvariants(report, REDACTION_INVARIANTS);
  }, 600_000);

  it("DriftMonitor / computePsi hold their documented invariants for every seed", async () => {
    const report = await runCampaign(driftFamily, options);
    persistReport(report);
    expect(report.sequences).toBe(options.count);
    assertHardInvariants(report, DRIFT_INVARIANTS);
  }, 600_000);

  it("cost model holds its documented invariants for every seed", async () => {
    const report = await runCampaign(costFamily, options);
    persistReport(report);
    expect(report.sequences).toBe(options.count);
    assertHardInvariants(report, COST_INVARIANTS);
  }, 600_000);
});
