import { readFileSync, writeFileSync } from "node:fs";
import { buildFreshUserReport, ingestTrials, type TrialLabel } from "./freshUserTrials.js";

/**
 * FRESH-USER REPORT CLI — pipeline end of the device telemetry path.
 *
 *   pnpm lab:fresh-user-report <trials.json> <labels.json> <out.json>
 *
 * trials.json: array of evaluation-trial records (the API's evaluation_trial
 * rows exported as JSON, or a device outbox dump). labels.json: array of
 * human TrialLabel entries produced against gold. Output: one honest report
 * — explicit per-event silent-failure counts, independence coverage, outcome
 * mix. Invalid trials are listed as rejected, never repaired.
 */

function main(): void {
  const [trialsPath, labelsPath, outPath] = process.argv.slice(2);
  if (!trialsPath || !labelsPath || !outPath) {
    console.error("usage: fresh-user-report <trials.json> <labels.json> <out.json>");
    process.exitCode = 1;
    return;
  }
  const rawTrials = JSON.parse(readFileSync(trialsPath, "utf8")) as unknown[];
  const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as TrialLabel[];
  const { accepted, rejected } = ingestTrials(rawTrials);
  const report = buildFreshUserReport(accepted, labels);
  writeFileSync(outPath, `${JSON.stringify({ report, rejected }, null, 2)}\n`);
  console.log(
    `trials=${accepted.length} rejected=${rejected.length} labeled=${report.silentFailures.trialsLabeled} ` +
      `events=${JSON.stringify(report.silentFailures.byEvent)}`,
  );
}

main();
