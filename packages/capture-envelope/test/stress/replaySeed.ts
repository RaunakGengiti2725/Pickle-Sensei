import {
  checkEnvelopeInvariants,
  checkG08Invariants,
  checkLabelFileInvariants,
  checkPixelInvariants,
  generateMeasurements,
} from "./campaigns.js";
import { canonicalJson } from "./leakHarness.js";

/**
 * Replay one per-iteration seed from a campaign report N times and print the
 * failure rate (flakiness check). From packages/capture-envelope:
 *
 *   node --import tsx test/stress/replaySeed.ts \
 *     --campaign envelope-pathological --seed 1567936077 --times 10
 *
 * Exit 0 when every replay is HELD, 1 when every replay is BROKEN
 * (deterministic failure), 2 when the outcome varies (flaky).
 */

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ?? fallback;
}

const campaign = arg("campaign", "envelope-finite");
const seed = Number(arg("seed", "0"));
const times = Number(arg("times", "10"));

const replay = (): { violations: string[]; scenario: string } => {
  switch (campaign) {
    case "envelope-finite": {
      const m = generateMeasurements(seed, "finite");
      return { violations: checkEnvelopeInvariants(m), scenario: canonicalJson(m) };
    }
    case "envelope-pathological": {
      const m = generateMeasurements(seed, "pathological");
      return { violations: checkEnvelopeInvariants(m), scenario: canonicalJson(m) };
    }
    case "pixel":
      return checkPixelInvariants(seed);
    case "g08":
      return checkG08Invariants(seed);
    case "label-file":
      return checkLabelFileInvariants(seed);
    default:
      throw new Error(
        `unknown campaign ${campaign} (clip-prober seeds replay via runLongRunLeak.ts --campaigns clip)`,
      );
  }
};

let broken = 0;
const distinct = new Set<string>();
for (let i = 0; i < times; i += 1) {
  const result = replay();
  distinct.add(canonicalJson(result));
  if (result.violations.length > 0) broken += 1;
}
const first = replay();
console.log(
  JSON.stringify(
    {
      campaign,
      seed,
      times,
      brokenRuns: broken,
      brokenRate: times > 0 ? broken / times : null,
      distinctOutcomes: distinct.size,
      scenario: first.scenario,
      violations: first.violations,
    },
    null,
    2,
  ),
);
process.exitCode = broken === 0 ? 0 : broken === times ? 1 : 2;
