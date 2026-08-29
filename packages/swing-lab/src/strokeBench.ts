import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * REAL stroke-recognition + phase-boundary benchmark.
 *
 * Stroke: hierarchical evaluation — L1 (category), L2 (side), L3 (full
 * label) are scored separately; a depth-2 prediction is NOT wrong at L1/L2
 * merely for abstaining at L3 (abstentions are counted as abstentions).
 * Phase: |predicted − labeled| per boundary, contact reported separately,
 * with a paddle-speed-only alternative (baseline B) computed for comparison.
 *
 * Sample sizes print first. Classes absent from the benchmark are listed so
 * "accuracy" cannot silently mean "two classes existed".
 */

interface BenchCase {
  id: string;
  labels: string;
  runDir: string;
  sourceKey?: string;
}

interface EventLabel {
  eventStartMs: number;
  contactMs: number | null;
  eventEndMs: number;
  owner: "target" | "other";
}

interface EventRow {
  caseId: string;
  label: EventLabel;
  matched: boolean;
  startErrMs: number | null;
  endErrMs: number | null;
  contactInside: boolean | null;
}

const L1_OF: Record<string, string> = {
  FOREHAND_DRIVE: "SWING", BACKHAND_DRIVE: "SWING",
  FOREHAND_DINK: "SWING", BACKHAND_DINK: "SWING",
  FOREHAND_VOLLEY: "SWING", BACKHAND_VOLLEY: "SWING",
  DROP: "SWING", RESET: "SWING", SPEEDUP: "SWING", RETURN: "SWING",
  SERVE: "SERVE", OVERHEAD: "OVERHEAD", UNKNOWN: "UNKNOWN",
};
const SIDE_OF = (label: string): string =>
  label.startsWith("FOREHAND") ? "FOREHAND" : label.startsWith("BACKHAND") ? "BACKHAND" : "NONE";

const isMain = process.argv[1]?.endsWith("strokeBench.ts");
if (isMain) {
  const manifestPath = resolve(
    process.argv[2] ??
      join(dirname(fileURLToPath(import.meta.url)), "../../../datasets/ball-bench/ball-bench.json"),
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    provenance: string;
    cases: BenchCase[];
  };
  const baseDir = dirname(manifestPath);

  interface Row {
    caseId: string;
    annotated: string;
    predictedLabel: string;
    predictedLeaf: string | null;
    depth: number;
    confidence: number;
    l1: "correct" | "wrong";
    l2: "correct" | "wrong" | "abstained" | "n/a";
    l3: "correct" | "wrong" | "abstained";
  }
  const rows: Row[] = [];
  const eventRows: EventRow[] = [];
  const matchedProposalIds = new Set<string>();
  let totalProposals = 0;
  let falseProposals = 0;
  interface PhaseRow {
    caseId: string;
    boundary: string;
    labelMs: number;
    wristMs: number | null; // baseline A: current geometric segmenter
    paddleMs: number | null; // baseline B: paddle-speed-only
    temporalMs: number | null; // baseline C: phase.paddle-temporal.v1
    temporalV2Ms: number | null; // baseline D: phase.paddle-temporal.v2 (event-local)
  }
  const phaseRows: PhaseRow[] = [];

  for (const benchCase of manifest.cases) {
    const labelsPath = resolve(baseDir, benchCase.labels);
    const reportPath = resolve(baseDir, benchCase.runDir, "report.json");
    const analysisPath = resolve(baseDir, benchCase.runDir, "analysis.json");
    const debugPath = resolve(baseDir, benchCase.runDir, "debug.json");
    if (!existsSync(labelsPath) || !existsSync(reportPath)) continue;
    const annotation = JSON.parse(readFileSync(labelsPath, "utf8")) as {
      annotatedStrokeV3?: string;
      phases?: Record<string, number | null>;
      eventLabels?: EventLabel[];
    };
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      strokePrediction?: {
        label: string;
        leaf: string | null;
        taxonomyDepth: number;
        confidence: number;
      } | null;
      events?: {
        proposals?: Array<{ eventId: string; startMs: number; endMs: number; peakMs: number }>;
      } | null;
      targetEvent?: { status: string; event?: { eventId: string } } | null;
      temporalPhasesV2?: {
        status: string;
        boundaries?: {
          preparationStartMs: number | null;
          accelerationStartMs: number;
          contactMs: number;
          followThroughEndMs: number;
          recoveryEndMs: number | null;
        };
      } | null;
      temporalPhases?: {
        status: string;
        boundaries?: {
          preparationStartMs: number | null;
          accelerationStartMs: number;
          contactMs: number;
          followThroughEndMs: number;
          recoveryEndMs: number | null;
        };
      } | null;
    };
    const temporal =
      report.temporalPhases?.status === "segmented" ? report.temporalPhases.boundaries! : null;
    const temporalV2 =
      report.temporalPhasesV2?.status === "segmented" ? report.temporalPhasesV2.boundaries! : null;

    // ── Event rows ─────────────────────────────────────────────────────
    for (const label of annotation.eventLabels ?? []) {
      const proposalsList = report.events?.proposals ?? [];
      const overlapping = proposalsList.filter(
        (proposal) =>
          Math.min(proposal.endMs, label.eventEndMs) -
            Math.max(proposal.startMs, label.eventStartMs) >
          0.3 * (label.eventEndMs - label.eventStartMs),
      );
      const best = overlapping.sort(
        (a, b) =>
          Math.abs(a.peakMs - (label.contactMs ?? (label.eventStartMs + label.eventEndMs) / 2)) -
          Math.abs(b.peakMs - (label.contactMs ?? (label.eventStartMs + label.eventEndMs) / 2)),
      )[0];
      eventRows.push({
        caseId: benchCase.id,
        label,
        matched: !!best,
        startErrMs: best ? Math.abs(best.startMs - label.eventStartMs) : null,
        endErrMs: best ? Math.abs(best.endMs - label.eventEndMs) : null,
        contactInside:
          best && label.contactMs !== null
            ? label.contactMs >= best.startMs - 60 && label.contactMs <= best.endMs + 60
            : null,
      });
      if (best) matchedProposalIds.add(`${benchCase.id}:${best.eventId}`);
    }
    for (const proposal of report.events?.proposals ?? []) {
      totalProposals += 1;
      if (!matchedProposalIds.has(`${benchCase.id}:${proposal.eventId}`)) falseProposals += 1;
    }

    // ── Stroke rows ────────────────────────────────────────────────────
    if (annotation.annotatedStrokeV3 && report.strokePrediction) {
      const truth = annotation.annotatedStrokeV3;
      const prediction = report.strokePrediction;
      const l1 = L1_OF[prediction.leaf ?? prediction.label] ?? (prediction.label === "FOREHAND" || prediction.label === "BACKHAND" ? "SWING" : prediction.label);
      const truthL1 = L1_OF[truth] ?? "UNKNOWN";
      const predictedSide =
        prediction.taxonomyDepth >= 2 ? SIDE_OF(prediction.leaf ?? prediction.label) : null;
      const truthSide = SIDE_OF(truth);
      rows.push({
        caseId: benchCase.id,
        annotated: truth,
        predictedLabel: prediction.label,
        predictedLeaf: prediction.leaf,
        depth: prediction.taxonomyDepth,
        confidence: prediction.confidence,
        l1: l1 === truthL1 ? "correct" : "wrong",
        l2:
          truthSide === "NONE"
            ? "n/a"
            : predictedSide === null
              ? "abstained"
              : predictedSide === truthSide
                ? "correct"
                : "wrong",
        l3:
          prediction.taxonomyDepth < 3 || prediction.leaf === null
            ? "abstained"
            : prediction.leaf === truth
              ? "correct"
              : "wrong",
      });
    }

    // ── Phase rows ─────────────────────────────────────────────────────
    const labeledPhases = annotation.phases ?? {};
    const geometric: Record<string, { startMs: number; endMs: number; representativeMs: number }> = {};
    if (existsSync(analysisPath)) {
      const analysis = JSON.parse(readFileSync(analysisPath, "utf8")) as {
        result?: { phases?: Array<{ key: string; startMs: number; endMs: number; representativeMs: number }> };
      };
      for (const span of analysis.result?.phases ?? []) geometric[span.key] = span;
    }
    let paddleBoundaries: { accelStartMs: number; contactMs: number; followEndMs: number } | null = null;
    if (existsSync(debugPath)) {
      const debug = JSON.parse(readFileSync(debugPath, "utf8")) as {
        paddle: { observations: Array<{ t: number; x: number; y: number; w: number; h: number }> } | null;
      };
      const observations = debug.paddle?.observations ?? [];
      if (observations.length >= 6) {
        const speeds: Array<{ t: number; v: number }> = [];
        for (let index = 1; index < observations.length; index += 1) {
          const dt = (observations[index]!.t - observations[index - 1]!.t) / 1000;
          if (dt <= 0 || dt > 0.15) continue;
          const previous = observations[index - 1]!;
          const current = observations[index]!;
          speeds.push({
            t: current.t,
            v: Math.hypot(
              current.x + current.w / 2 - (previous.x + previous.w / 2),
              current.y + current.h / 2 - (previous.y + previous.h / 2),
            ) / dt,
          });
        }
        if (speeds.length >= 5) {
          const peak = speeds.reduce((best, sample) => (sample.v > best.v ? sample : best));
          const threshold = peak.v * 0.25;
          let accel = peak.t;
          for (let index = speeds.findIndex((sample) => sample.t === peak.t); index > 0; index -= 1) {
            if (speeds[index]!.v < threshold) break;
            accel = speeds[index]!.t;
          }
          let follow = peak.t;
          for (let index = speeds.findIndex((sample) => sample.t === peak.t); index < speeds.length; index += 1) {
            if (speeds[index]!.v < threshold) break;
            follow = speeds[index]!.t;
          }
          paddleBoundaries = { accelStartMs: accel, contactMs: peak.t, followEndMs: follow };
        }
      }
    }
    const boundaryMap: Array<[string, number | null, number | null, number | null, number | null]> = [
      ["preparationStart", geometric["prepare"]?.startMs ?? null, null, temporal?.preparationStartMs ?? null, temporalV2?.preparationStartMs ?? null],
      ["accelerationStart", geometric["accelerate"]?.startMs ?? null, paddleBoundaries?.accelStartMs ?? null, temporal?.accelerationStartMs ?? null, temporalV2?.accelerationStartMs ?? null],
      ["contact", geometric["contact"]?.representativeMs ?? null, paddleBoundaries?.contactMs ?? null, temporal?.contactMs ?? null, temporalV2?.contactMs ?? null],
      ["followThroughEnd", geometric["follow_through"]?.endMs ?? null, paddleBoundaries?.followEndMs ?? null, temporal?.followThroughEndMs ?? null, temporalV2?.followThroughEndMs ?? null],
      ["recoveryEnd", null, null, temporal?.recoveryEndMs ?? null, temporalV2?.recoveryEndMs ?? null],
    ];
    for (const [boundary, wristMs, paddleMs, temporalMs, temporalV2Ms] of boundaryMap) {
      const labelKey = `${boundary}Ms`;
      const labelValue = labeledPhases[labelKey];
      if (typeof labelValue !== "number") continue;
      phaseRows.push({ caseId: benchCase.id, boundary, labelMs: labelValue, wristMs, paddleMs, temporalMs, temporalV2Ms });
    }
  }

  // ── Print event benchmark ────────────────────────────────────────────
  console.log("═".repeat(66));
  console.log("REAL STROKE-EVENT BENCHMARK (stroke-event-1)");
  const targetEventRows = eventRows.filter((row) => row.label.owner === "target");
  const otherEventRows = eventRows.filter((row) => row.label.owner === "other");
  console.log(
    `labeled events: ${eventRows.length} (target ${targetEventRows.length}, other-player ${otherEventRows.length}) · proposals: ${totalProposals}`,
  );
  const recallOf = (rowsIn: EventRow[]) =>
    rowsIn.length > 0
      ? `${rowsIn.filter((row) => row.matched).length}/${rowsIn.length}`
      : "n/a";
  console.log(
    `event recall: target ${recallOf(targetEventRows)} · other-swing detected (contamination signal): ${recallOf(otherEventRows)}`,
  );
  const startErrors = eventRows
    .filter((row) => row.startErrMs !== null)
    .map((row) => row.startErrMs!) 
    .sort((a, b) => a - b);
  const endErrors = eventRows
    .filter((row) => row.endErrMs !== null)
    .map((row) => row.endErrMs!)
    .sort((a, b) => a - b);
  console.log(
    `boundary error: start median ${startErrors[Math.floor(startErrors.length / 2)] ?? "n/a"}ms (${startErrors.length}) · ` +
      `end median ${endErrors[Math.floor(endErrors.length / 2)] ?? "n/a"}ms (${endErrors.length})`,
  );
  console.log(
    `contact-inside-matched-event: ${eventRows.filter((row) => row.contactInside === true).length}/${eventRows.filter((row) => row.contactInside !== null).length} · ` +
      `false/unmatched proposals: ${falseProposals}/${totalProposals}`,
  );

  // ── Print stroke benchmark ───────────────────────────────────────────
  console.log("═".repeat(66));
  console.log(`REAL STROKE BENCHMARK [provenance: ${manifest.provenance}] — heuristic baseline`);
  console.log(`labeled strokes: ${rows.length}`);
  const classes = new Set(rows.map((row) => row.annotated));
  console.log(`classes present: ${[...classes].join(", ") || "none"}`);
  console.log(
    "CLASS LIMITATION: metrics below cover ONLY these classes; absent classes are untested.",
  );
  console.log("═".repeat(66));
  for (const row of rows) {
    console.log(
      `${row.caseId}: annotated ${row.annotated} · predicted ${row.predictedLabel}` +
        `${row.predictedLeaf && row.predictedLeaf !== row.predictedLabel ? ` (${row.predictedLeaf})` : ""} ` +
        `depth ${row.depth}/3 conf ${row.confidence.toFixed(2)} · L1 ${row.l1} · L2 ${row.l2} · L3 ${row.l3}`,
    );
  }
  const score = (level: "l1" | "l2" | "l3") => {
    const applicable = rows.filter((row) => row[level] !== "n/a");
    const correct = applicable.filter((row) => row[level] === "correct").length;
    const abstained = applicable.filter((row) => row[level] === "abstained").length;
    return `${correct}/${applicable.length} correct, ${abstained} abstained`;
  };
  console.log("─".repeat(66));
  console.log(`L1 category: ${score("l1")} · L2 side: ${score("l2")} · L3 full: ${score("l3")}`);

  // ── Print phase benchmark ────────────────────────────────────────────
  console.log("═".repeat(66));
  console.log("REAL PHASE-BOUNDARY BENCHMARK — baselines: A wrist-geometry, B paddle-speed");
  console.log(`labeled boundaries: ${phaseRows.length} (uncertainty ±2 frames typical; see annotations)`);
  console.log("═".repeat(66));
  const byBoundary = new Map<string, PhaseRow[]>();
  for (const row of phaseRows) {
    byBoundary.set(row.boundary, [...(byBoundary.get(row.boundary) ?? []), row]);
  }
  for (const [boundary, boundaryRows] of byBoundary) {
    const errorsA = boundaryRows
      .filter((row) => row.wristMs !== null)
      .map((row) => Math.abs(row.wristMs! - row.labelMs));
    const errorsB = boundaryRows
      .filter((row) => row.paddleMs !== null)
      .map((row) => Math.abs(row.paddleMs! - row.labelMs));
    const errorsC = boundaryRows
      .filter((row) => row.temporalMs !== null)
      .map((row) => Math.abs(row.temporalMs! - row.labelMs));
    const errorsD = boundaryRows
      .filter((row) => row.temporalV2Ms !== null)
      .map((row) => Math.abs(row.temporalV2Ms! - row.labelMs));
    const median = (values: number[]) =>
      values.length > 0 ? values.sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;
    console.log(
      `${boundary}: n=${boundaryRows.length} · A(wrist-geometry) median |err| ${median(errorsA) ?? "n/a"}ms (${errorsA.length}) · ` +
        `B(paddle-speed) ${median(errorsB) ?? "n/a"}ms (${errorsB.length}) · ` +
        `C(v1) ${median(errorsC) ?? "n/a"}ms (${errorsC.length}) · ` +
        `D(v2 event-local) ${median(errorsD) ?? "n/a"}ms (${errorsD.length})`,
    );
  }
  console.log(
    "NOTE: contact row here is the SEGMENTER's contact boundary; the multimodal contact estimator is benchmarked separately in ball-bench.",
  );
}
