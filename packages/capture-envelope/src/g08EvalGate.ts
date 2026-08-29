import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { evaluateCaptureEnvelope } from "./envelope.js";
import { measureClip } from "./clipProbe.js";
import { CAPTURE_ENVELOPE_THRESHOLDS_VERSION } from "./thresholds.js";
import {
  computeG08Metrics,
  computeG08MetricsByFamily,
  evidenceSufficient,
  G08_FROZEN_GATE_DOC_SHA256,
  G08_GATE_VERSION,
  sha256OfFile,
  type G08EvalRow,
} from "./g08Gate.js";
import {
  G08_BYPASS_FAMILIES,
  G08_LABEL_SCHEMA_VERSION,
  validateG08LabelFile,
} from "./g08LabelSchema.js";

/**
 * g08-f22-evidence end-to-end gate evaluation.
 *
 * Loads the HUMAN label file, validates it against the schema (rejecting
 * machine labels), joins every effective label with the envelope verdict the
 * CURRENT checker produces on that clip window, computes the frozen metrics
 * (always with counts; null rates on zero denominators), and writes the gate
 * report. Runs to completion on the empty label file, reporting every family
 * NOT DECIDABLE — proving the human label file is the only missing input.
 *
 * Usage: pnpm --filter @pickle/capture-envelope gate:g08
 * Output: datasets/experiments/wave-g/g08-gate-report.json
 */

const repoRoot = resolve(import.meta.dirname, "../../..");
const waveGDir = join(repoRoot, "datasets", "experiments", "wave-g");
const labelPath = join(waveGDir, "g08-labels.json");
const gateDocPath = join(waveGDir, "g08-frozen-gate.md");

const gateDocSha = sha256OfFile(gateDocPath);
if (gateDocSha !== G08_FROZEN_GATE_DOC_SHA256) {
  throw new Error(
    `FROZEN GATE VIOLATION: g08-frozen-gate.md sha256 ${gateDocSha} does not match the pinned freeze-time hash ${G08_FROZEN_GATE_DOC_SHA256}. The gate document was edited after freeze.`,
  );
}

const parsed: unknown = JSON.parse(readFileSync(labelPath, "utf8"));
const validation = validateG08LabelFile(parsed);
if (!validation.valid) {
  for (const error of validation.errors) process.stderr.write(`label file invalid: ${error}\n`);
  throw new Error(
    `g08-labels.json failed schema validation with ${validation.errors.length} error(s)`,
  );
}

const rows: G08EvalRow[] = validation.effective.map((label) => {
  const verdict = evaluateCaptureEnvelope(measureClip(join(repoRoot, label.clip), label.windowMs));
  return {
    labelId: label.labelId,
    family: label.family,
    sessionKey: label.sessionKey,
    capture: label.capture,
    downstream: label.downstream,
    envelopeOverall: verdict.overall,
  };
});

const overall = computeG08Metrics(rows);
const byFamily = computeG08MetricsByFamily(rows);

const families = G08_BYPASS_FAMILIES.map((family) => {
  const metrics = byFamily[family];
  const evidence = evidenceSufficient(metrics);
  return {
    family,
    metrics,
    evidenceSufficient: evidence.sufficient,
    decidable: evidence.sufficient,
    blockers: evidence.sufficient ? [] : evidence.reasons,
  };
});

const undecidable = families.filter((f) => !f.decidable).map((f) => f.family);

const report = {
  gateVersion: G08_GATE_VERSION,
  frozenGateDocSha256: gateDocSha,
  labelSchemaVersion: G08_LABEL_SCHEMA_VERSION,
  thresholdsVersion: CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
  generatedBy: "packages/capture-envelope/src/g08EvalGate.ts",
  generatedAtIso: new Date().toISOString(),
  labelFile: "datasets/experiments/wave-g/g08-labels.json",
  totalLabelRecords: (parsed as { labels: unknown[] }).labels.length,
  effectiveLabels: validation.effective.length,
  supersededLabels: (parsed as { labels: unknown[] }).labels.length - validation.effective.length,
  overallMetrics: overall,
  families,
  status:
    undecidable.length === 0
      ? "ALL_FAMILIES_DECIDABLE"
      : `BLOCKED_EXTERNAL: ${undecidable.length}/${G08_BYPASS_FAMILIES.length} families NOT DECIDABLE — human labels are the only missing input (${undecidable.join(", ")})`,
};

writeFileSync(join(waveGDir, "g08-gate-report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stderr.write(
  `g08 gate: ${validation.effective.length} effective labels, ${families.filter((f) => f.decidable).length}/${G08_BYPASS_FAMILIES.length} families decidable\n`,
);
process.stderr.write(`${report.status}\n`);
