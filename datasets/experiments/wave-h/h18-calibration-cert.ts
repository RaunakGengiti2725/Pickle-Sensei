// H18 — GATE 6 (calibration / silent failure) CERTIFICATION on the release
// candidate (devin/1787988068-wave-c-integration @ 104ea0f).
//
// Produces, from committed replayable non-holdout labeled data only:
//   1. CERTIFICATION NUMBERS — strict full-cascade survival, usable-result
//      rate, silent-failure rate (with denominators), coverage, abstention —
//      from the committed canonical cascade runs (development split only,
//      grouped by source session) via the unmodified silent-failure-v1.1
//      retro instrument.
//   2. RISK-COVERAGE VIEWS — refreshed at RC head: the W14 + D2-04
//      calibration/AURC views (e07/f17 instruments, unmodified) and the g20
//      selective-risk sweeps (contact / stroke / ownership), consumed from
//      the wave-g g20 artifacts and re-executed here to confirm they
//      reproduce at this head.
//   3. CONFIDENCE-ROUTING VERIFICATION — the designed HIGH (confirmed or
//      conf >= 0.6 -> marker) / MEDIUM (marker with widening uncertainty
//      halo) / LOW (abstain -> no marker, no invented label) routing is
//      replayed against real committed contact-gold replays and the stroke
//      bench, through the ACTUAL mobile Result-surface selector
//      (apps/mobile/src/components/strokeResultModel.ts — pure module).
//
// MEASUREMENT ONLY — no production threshold is changed. Held-out cases
// (wm-dink-01, afn-vic-rally1) are never read: the retro instrument filters
// split === "development" before parsing, the replay harnesses exclude them
// by construction, and the ownership loader is called with
// includeHeldOut=false.
//
//   cd packages/swing-lab && pnpm exec tsx ../../datasets/experiments/wave-h/h18-calibration-cert.ts

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  areaUnderRiskCoverage,
  calibrationReport,
  coverageRiskCurve,
} from "../../../packages/swing-lab/src/calibration.js";
import {
  loadD204OwnershipAuditDatasets,
  loadW14Datasets,
} from "../../../packages/swing-lab/src/coverageRisk.js";
import { evaluateCommittedRuns } from "../../../packages/swing-lab/src/silentFailureRetro.js";
import {
  SILENT_FAILURE_CLAIMS,
  SILENT_FAILURE_CONTRACT_V1_1,
} from "../../../packages/swing-lab/src/silentFailure.js";
import {
  runStrokeHeuristicBench,
  type BenchRow,
} from "../../../packages/swing-lab/src/strokeHeuristicBench.js";
import { replayAll } from "../../../packages/vision-geometry/eval/contactGoldReplay.js";
import type { ContactEstimate } from "../../../packages/vision-geometry/src/offlineStroke.js";
import {
  CONTACT_MARKER_MIN_UNCONFIRMED_CONFIDENCE,
  contactHaloHalfWidthMs,
  contactMarkerPresentation,
} from "../../../apps/mobile/src/components/strokeResultModel.js";
import {
  contactUnits,
  ownershipUnits,
  strokeUnits,
  sweepCurve,
  zeroRiskOperatingPoint,
} from "../wave-g/g20-selective-risk.js";

const ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");
const OUT_DIR = join(ROOT, "datasets/experiments/wave-h");
const CASCADE_DIR = join(ROOT, "datasets/cascade");

/** Source session per development case (grouping unit — never frames). */
const DEV_CASE_SESSION: Record<string, string> = {
  "wm-volley-02": "wm-tournament-2014",
  "afn-sasebo-rally1": "afn-sasebo-2025-06",
  "afn-sasebo-rally2": "afn-sasebo-2025-06",
};

// ── 1a. strict survival + usable rate from committed cascade runs ──────────
// Development rows only; held-out rows are counted, never parsed.

interface CascadeRowLite {
  caseId: string;
  split: string;
  stages: Record<string, { pass: boolean }>;
  usable?: { usable: boolean };
}

interface RunCert {
  file: string;
  generatedAtIso: string;
  devTrials: number;
  heldOutRowsExcluded: number;
  strictSurvivors: number;
  usableResults: number;
  perCase: Array<{ caseId: string; session: string; strict: boolean; usable: boolean }>;
}

function certifyCommittedRuns(): RunCert[] {
  const certs: RunCert[] = [];
  for (const file of readdirSync(CASCADE_DIR).sort()) {
    if (!/^cascade-\d+\.json$/.test(file)) continue;
    const run = JSON.parse(readFileSync(join(CASCADE_DIR, file), "utf8")) as {
      generatedAtIso: string;
      rows?: CascadeRowLite[];
    };
    const rows = run.rows ?? [];
    if (rows.length === 0) continue;
    const dev = rows.filter((row) => row.split === "development");
    const perCase = dev.map((row) => {
      const session = DEV_CASE_SESSION[row.caseId];
      if (!session) throw new Error(`unmapped development case: ${row.caseId}`);
      return {
        caseId: row.caseId,
        session,
        strict: Object.values(row.stages).every((stage) => stage.pass),
        usable: row.usable?.usable === true,
      };
    });
    certs.push({
      file,
      generatedAtIso: run.generatedAtIso,
      devTrials: dev.length,
      heldOutRowsExcluded: rows.length - dev.length,
      strictSurvivors: perCase.filter((entry) => entry.strict).length,
      usableResults: perCase.filter((entry) => entry.usable).length,
      perCase,
    });
  }
  return certs;
}

// ── 3. confidence-routing verification on real replays ─────────────────────

interface RoutingViolation {
  unit: string;
  expected: string;
  got: string;
}

function verifyContactRouting(): {
  nUnits: number;
  bands: Record<string, number>;
  perSession: Record<string, Record<string, number>>;
  haloBoundsHold: boolean;
  haloMonotone: boolean;
  violations: RoutingViolation[];
  disclosures: string[];
} {
  const rows = replayAll();
  const violations: RoutingViolation[] = [];
  const bands: Record<string, number> = {
    LOW_abstained_no_marker: 0,
    LOW_unconfirmed_low_conf_no_marker: 0,
    HIGH_confirmed_marker: 0,
    HIGH_unconfirmed_high_conf_marker: 0,
  };
  const perSession: Record<string, Record<string, number>> = {};
  const haloSamples: Array<{ confidence: number; halo: number }> = [];
  for (const row of rows) {
    const unit = `${row.event.bundle} @${row.event.contactMs} (${row.event.owner})`;
    const estimate: ContactEstimate =
      row.status === "estimated"
        ? {
            status: "estimated",
            estimatedContactMs: row.estimatedContactMs!,
            confidence: row.confidence!,
            ballConfirmed: row.ballConfirmed === true,
            paddleConfirmed: false, // no committed paddle track on Linux (paddleSpeeds null by construction)
            limitingFactors: row.limitingFactors,
            supportingEvidence: [],
          }
        : { status: "abstained", reason: row.reason ?? "unknown" };
    const presentation = contactMarkerPresentation(estimate);
    let band: string;
    let expectedKind: "marker" | "not_established";
    if (estimate.status === "abstained") {
      band = "LOW_abstained_no_marker";
      expectedKind = "not_established";
    } else if (
      estimate.ballConfirmed ||
      estimate.confidence >= CONTACT_MARKER_MIN_UNCONFIRMED_CONFIDENCE
    ) {
      band = estimate.ballConfirmed ? "HIGH_confirmed_marker" : "HIGH_unconfirmed_high_conf_marker";
      expectedKind = "marker";
    } else {
      band = "LOW_unconfirmed_low_conf_no_marker";
      expectedKind = "not_established";
    }
    bands[band] = (bands[band] ?? 0) + 1;
    const session = row.event.session;
    perSession[session] = perSession[session] ?? {};
    perSession[session][band] = (perSession[session][band] ?? 0) + 1;
    if (presentation.kind !== expectedKind) {
      violations.push({ unit, expected: expectedKind, got: presentation.kind });
    }
    if (presentation.kind === "marker") {
      if (estimate.status !== "estimated") throw new Error("marker from abstention");
      if (presentation.haloHalfWidthMs !== contactHaloHalfWidthMs(estimate.confidence)) {
        violations.push({
          unit,
          expected: `halo ${contactHaloHalfWidthMs(estimate.confidence)}`,
          got: `halo ${presentation.haloHalfWidthMs}`,
        });
      }
      if (/\d\.\d/.test(presentation.caption)) {
        violations.push({
          unit,
          expected: "no raw decimals in caption",
          got: presentation.caption,
        });
      }
      haloSamples.push({ confidence: estimate.confidence, halo: presentation.haloHalfWidthMs });
    }
  }
  const haloBoundsHold = haloSamples.every((sample) => sample.halo >= 33 && sample.halo <= 165);
  const sorted = [...haloSamples].sort((a, b) => a.confidence - b.confidence);
  const haloMonotone = sorted.every(
    (sample, index) => index === 0 || sample.halo <= sorted[index - 1]!.halo,
  );
  return {
    nUnits: rows.length,
    bands,
    perSession,
    haloBoundsHold,
    haloMonotone,
    violations,
    disclosures: [
      "routing exercised through the ACTUAL mobile selector contactMarkerPresentation (apps/mobile/src/components/strokeResultModel.ts, pure module) on all replayable committed contact-gold events (target + other owned; e02 harness, ORACLE ball)",
      "paddleConfirmed is false by construction on this box (no committed paddle track; the replay passes paddleSpeeds null) — the paddle-confirmed routing arm is NOT exercisable on Linux and remains Mac-gated",
      "estimatedContactMs and confidence are the real emitted estimator values from the replay, not synthetic",
    ],
  };
}

function verifyStrokeRouting(): {
  nUnits: number;
  bands: Record<string, number>;
  perGroup: Record<string, Record<string, number>>;
  violations: RoutingViolation[];
  disclosures: string[];
} {
  const report = runStrokeHeuristicBench();
  const bands: Record<string, number> = { LOW_abstained_no_label: 0, ANSWERED_label_shown: 0 };
  const perGroup: Record<string, Record<string, number>> = {};
  const violations: RoutingViolation[] = [];
  for (const row of report.rows as BenchRow[]) {
    const answered = row.predictedLabel !== "UNKNOWN" && row.predictedLabel !== "—";
    const band = answered ? "ANSWERED_label_shown" : "LOW_abstained_no_label";
    bands[band] = (bands[band] ?? 0) + 1;
    perGroup[row.group] = perGroup[row.group] ?? {};
    perGroup[row.group][band] = (perGroup[row.group][band] ?? 0) + 1;
    if (answered && row.confidence === null) {
      violations.push({
        unit: `${row.caseId} @${row.eventStartMs}`,
        expected: "committed label carries a confidence",
        got: "confidence null",
      });
    }
  }
  return {
    nUnits: (report.rows as BenchRow[]).length,
    bands,
    perGroup,
    violations,
    disclosures: [
      "stroke routing is binary by design: UNKNOWN/null routes to the explicit 'Stroke not identified' surface (strokeResultModel abstained header) and never invents a label; committed labels are shown — there is no downstream confidence gate in production (g20 finding, unchanged here)",
      "bench = e03 committed-data stroke bench (wave-a pose windows, paddle null everywhere); held-out cases excluded by construction",
    ],
  };
}

// ── main ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith("h18-calibration-cert.ts");
if (isMain) {
  // 1. certification numbers from committed canonical runs
  const retroRuns = evaluateCommittedRuns();
  const certs = certifyCommittedRuns();
  const certByFile = new Map(certs.map((cert) => [cert.file, cert]));
  const runs = retroRuns.map((run) => {
    const cert = certByFile.get(run.file);
    if (!cert) throw new Error(`no cert rows for ${run.file}`);
    const perClaim = Object.fromEntries(
      SILENT_FAILURE_CLAIMS.map((claim) => [
        claim,
        {
          answeredCorrect: run.perClaim[claim].correct,
          silentFailures: run.perClaim[claim].silent_failure,
          abstained: run.perClaim[claim].abstained,
          unverifiableRetro: run.perClaim[claim].unverifiable_retro,
        },
      ]),
    );
    return {
      file: run.file,
      generatedAtIso: run.generatedAtIso,
      devTrials: run.developmentTrials,
      heldOutRowsExcluded: run.heldOutRowsExcluded,
      answeredTrials: run.answeredTrials,
      silentFailureTrials: run.silentFailureTrials,
      strictSurvivors: cert.strictSurvivors,
      usableResults: cert.usableResults,
      perCase: cert.perCase,
      perClaim,
    };
  });
  const latest = runs[runs.length - 1]!;

  // 2. risk-coverage views refreshed at head
  const calibrationDatasets = [...loadW14Datasets(), ...loadD204OwnershipAuditDatasets()].map(
    (dataset) => ({
      name: dataset.name,
      provenance: dataset.provenance,
      n: dataset.samples.length,
      nCorrect: dataset.samples.filter((sample) => sample.correct).length,
      ece10: calibrationReport(dataset.samples, { nBins: 10 }).ece,
      aurc: areaUnderRiskCoverage(dataset.samples),
      coverageRiskCurve: coverageRiskCurve(dataset.samples),
    }),
  );

  const g20Committed = JSON.parse(
    readFileSync(join(ROOT, "datasets/experiments/wave-g/g20-selective-risk-curves.json"), "utf8"),
  ) as {
    stages: Array<{
      stage: string;
      currentPoint: { answered: number; wrongAnswered: number; nUnits: number };
    }>;
  };

  const contact = contactUnits();
  const stroke = strokeUnits();
  const ownership = ownershipUnits();
  const selectiveRisk = [
    { stage: "contact", ...contact, curve: sweepCurve(contact.units) },
    { stage: "stroke", ...stroke, curve: sweepCurve(stroke.units) },
    { stage: "ownership", ...ownership, curve: sweepCurve(ownership.units) },
  ].map((entry) => {
    const currentPoint = entry.curve[entry.curve.length - 1] ?? null;
    const committed = g20Committed.stages.find((stage) => stage.stage === entry.stage);
    return {
      ...entry,
      currentPoint,
      zeroObservedRiskPoint: zeroRiskOperatingPoint(entry.curve),
      reproducesG20Artifact:
        committed !== undefined &&
        currentPoint !== null &&
        committed.currentPoint.answered === currentPoint.answered &&
        committed.currentPoint.wrongAnswered === currentPoint.wrongAnswered &&
        committed.currentPoint.nUnits === currentPoint.nUnits,
    };
  });

  // 3. routing verification
  const contactRouting = verifyContactRouting();
  const strokeRouting = verifyStrokeRouting();

  const frozenGatePath = join(OUT_DIR, "h18-frozen-release-gate-g6-v1.json");
  const frozenGateSha256 = createHash("sha256").update(readFileSync(frozenGatePath)).digest("hex");

  const report = {
    workstream: "h18-calibration-cert",
    generatedAtIso: new Date().toISOString(),
    contract: SILENT_FAILURE_CONTRACT_V1_1,
    condition: {
      platform:
        "linux-cpu — committed artifacts + committed-data replays only; canonical fresh cascade on this box is honest 0/0 (run dirs Mac-gated)",
      heldOut:
        "wm-dink-01 and afn-vic-rally1 never parsed: retro filters split=development, replay harnesses exclude by construction, ownership loader includeHeldOut=false",
      grouping: "source session / bundle (per-unit session recorded); never frames-as-trials",
      productionThresholdsChanged: false,
    },
    certification: {
      denominatorNote:
        "trials = gold development cases in committed canonical cascade runs (n=3 dev cases across 2 source sessions); unit counts for stage-level views are stated per view — never blended",
      runs,
      latestCommittedRun: {
        file: latest.file,
        strictSurvival: `${latest.strictSurvivors}/${latest.devTrials} dev trials`,
        usableResultRate: `${latest.usableResults}/${latest.devTrials} dev trials`,
        silentFailureAllTrials: `${latest.silentFailureTrials}/${latest.devTrials}`,
        silentFailureAnsweredTrials: `${latest.silentFailureTrials}/${latest.answeredTrials}`,
        coverageAnswered: `${latest.answeredTrials}/${latest.devTrials}`,
        perCase: latest.perCase,
        perClaim: latest.perClaim,
      },
    },
    riskCoverageViews: {
      calibration: calibrationDatasets,
      selectiveRisk,
    },
    confidenceRouting: { contact: contactRouting, stroke: strokeRouting },
    frozenReleaseGate: {
      path: "datasets/experiments/wave-h/h18-frozen-release-gate-g6-v1.json",
      sha256: frozenGateSha256,
    },
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, "h18-cert-report.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log("═".repeat(78));
  console.log("H18 GATE-6 CERTIFICATION — committed canonical runs (development split)");
  console.log("  run file                          strict  usable  silent/answered  coverage");
  for (const run of runs) {
    console.log(
      `  ${run.file.padEnd(34)} ${run.strictSurvivors}/${run.devTrials}     ${run.usableResults}/${run.devTrials}     ${run.silentFailureTrials}/${run.answeredTrials}              ${run.answeredTrials}/${run.devTrials}`,
    );
  }
  console.log("═".repeat(78));
  console.log("SELECTIVE RISK at RC head (g20 harnesses re-executed)");
  for (const stage of selectiveRisk) {
    const point = stage.currentPoint!;
    console.log(
      `  ${stage.stage.padEnd(10)} n=${point.nUnits} answered=${point.answered} wrong=${point.wrongAnswered} coverage=${point.coverage} reproducesG20=${stage.reproducesG20Artifact}`,
    );
  }
  console.log("═".repeat(78));
  console.log("CONFIDENCE ROUTING (real replays through the mobile selector)");
  console.log(`  contact bands: ${JSON.stringify(contactRouting.bands)}`);
  console.log(
    `  halo bounds hold=${contactRouting.haloBoundsHold} monotone=${contactRouting.haloMonotone} violations=${contactRouting.violations.length}`,
  );
  console.log(
    `  stroke bands: ${JSON.stringify(strokeRouting.bands)} violations=${strokeRouting.violations.length}`,
  );
  if (contactRouting.violations.length > 0 || strokeRouting.violations.length > 0) {
    console.log("  VIOLATIONS:");
    for (const violation of [...contactRouting.violations, ...strokeRouting.violations]) {
      console.log(`    ${violation.unit}: expected ${violation.expected}, got ${violation.got}`);
    }
  }
  console.log(`  frozen gate sha256: ${frozenGateSha256}`);
  console.log(`written: ${outPath.replace(`${ROOT}/`, "")}`);
}
