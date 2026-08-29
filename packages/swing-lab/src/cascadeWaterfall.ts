import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import type { StrokeEventLabel, SwingAnnotation } from "./annotationSchema.js";
import { SILENT_FAILURE_CONTRACT, SILENT_FAILURE_CLAIMS, evaluateSilentFailure } from "./silentFailure.js";
import type { SilentFailureVerdict } from "./silentFailure.js";

/**
 * END-TO-END CASCADE WATERFALL — where does the PRODUCT lose each stroke?
 *
 *   pnpm lab:cascade
 *
 * Subsystem benches measure stages in isolation; the user experiences the
 * CASCADE: video → target → event → paddle → ball → contact → phase →
 * stroke. For every gold target event this reads the shipped per-case
 * report artifacts and answers each stage PASS/FAIL with the reason, both
 * unconditionally and conditionally (a stage only counts if everything
 * before it held — the product view).
 *
 * Stage criteria (explicit, versioned here):
 *   TARGET  — identity resolved with the product path (tap/seed) and
 *             coverage ≥ 0.5, no unresolved alias explosion
 *   EVENT   — selected target event overlaps the gold event ≥ 50% of the
 *             gold span, or gold contact lies inside the selected event
 *   PADDLE  — paddle.status = tracked with windowCoverage ≥ 0.3
 *   BALL    — ballStage.status = tracked
 *   CONTACT — contact.status = estimated AND |est − gold contact| ≤ 66ms
 *             (2 frames @30fps, the bench convention)
 *   PHASE   — temporalPhasesV2.status = segmented AND boundary ordering
 *             valid around contact
 *   STROKE  — L1 side (FOREHAND/BACKHAND) matches the gold stroke label
 *             (L2+ reported, not gated: taxonomy depth is heuristic today)
 *
 * SECOND NORTH-STAR (printed alongside — never replacing — strict survival):
 *   USABLE RESULT RATE under the versioned evidence contract
 *   USABLE_RESULT_CONTRACT (usable-result-v1) declared below. It answers a
 *   differently-shaped question: did the product have enough TRUSTWORTHY
 *   evidence to return a meaningful, honest Result? The contract was written
 *   from the product definition BEFORE measuring; it hides no failure.
 */

const PB = join(REPO_ROOT, "datasets/paddle-bench");

interface Report {
  player?: { policy?: string; targetCoverage?: number; selectionConfidence?: number };
  targetEvent?: { status?: string; event?: { startMs: number; endMs: number } };
  paddle?: { status?: string; windowCoverage?: number };
  ballStage?: { status?: string };
  contact?: { status?: string; estimatedContactMs?: number; ballConfirmed?: boolean; paddleConfirmed?: boolean };
  temporalPhasesV2?: { status?: string; boundaries?: { contactMs?: number | null; followThroughEndMs?: number | null } };
  strokePrediction?: { label?: string | null };
}

interface StageOutcome {
  pass: boolean;
  detail: string;
}

const STAGES = ["TARGET", "EVENT", "PADDLE", "BALL", "CONTACT", "PHASE", "STROKE"] as const;
type StageName = (typeof STAGES)[number];

/**
 * USABLE RESULT CONTRACT — usable-result-v1
 *
 * Written from the PRODUCT definition BEFORE measuring (not fit to today's
 * cases). A gold event yields a USABLE RESULT iff ALL of:
 *
 *  1. TARGET pass — same criterion as strict (coverage ≥ 0.5). A wrong or
 *     unlocked target is never usable.
 *  2. EVENT pass — same criterion as strict (≥50% overlap of the gold span,
 *     or gold contact inside the selected event). A wrong event is never
 *     usable.
 *  3. STROKE evidence is honest — EITHER the L1-side prediction matches gold
 *     (strict criterion) OR the prediction is an explicit abstention/unknown
 *     (an honest "couldn't classify" with correct target+event may still be
 *     usable if replay evidence below holds). A WRONG confident prediction is
 *     NOT usable.
 *  4. REPLAY EVIDENCE — at least one trustworthy per-stroke artifact the
 *     Result can show:
 *       (a) CONTACT estimated with |err| ≤ 66ms vs gold, OR
 *       (b) CONTACT estimated with 66 < err ≤ 132ms (within 4 frames @30fps)
 *           AND ballConfirmed or paddleConfirmed (marker shown with visible
 *           uncertainty), OR
 *       (c) contact abstained BUT temporalPhasesV2 segmented with valid
 *           boundary ordering (timeline shown without a contact marker).
 *  5. NO fabricated evidence — if contact.status === "estimated" and the
 *     error vs gold is > 132ms the case is NOT usable: a misleading marker
 *     is worse than none.
 *
 * v1 interpretation notes (flagged for adjudication, see U-summary):
 *   - A missing strokePrediction block or a null label is treated as an
 *     explicit abstention (the classifier declined to answer); it is not a
 *     wrong confident prediction.
 *   - contact "estimated" whose error is unverifiable (no gold contact or no
 *     estimate timestamp) satisfies neither (a)/(b) nor the abstention arm of
 *     (c); the fabrication veto (5) is not provable and is not applied.
 */
const USABLE_RESULT_CONTRACT = {
  version: "usable-result-v1",
  clauses: {
    target: "TARGET pass (strict criterion: coverage >= 0.5) — wrong/unlocked target is never usable",
    event: "EVENT pass (strict criterion: >=50% gold-span overlap or gold contact inside selection) — wrong event is never usable",
    strokeHonesty:
      "L1-side prediction matches gold (strict criterion) OR explicit abstention/unknown; a wrong confident prediction is never usable",
    replayEvidence:
      "(a) contact estimated |err| <= 66ms; OR (b) contact estimated 66 < err <= 132ms AND ballConfirmed or paddleConfirmed; OR (c) contact abstained BUT phases v2 segmented with valid ordering",
    noFabricatedEvidence:
      "contact estimated with error vs gold > 132ms is never usable — a misleading marker is worse than none",
  },
} as const;

interface UsableVerdict {
  usable: boolean;
  replayClause: "a" | "b" | "c" | null;
  reasons: string[];
}

function evaluateUsableResult(
  stages: Record<StageName, StageOutcome>,
  report: Report,
  goldContactMs: number | null,
): UsableVerdict {
  const contactEstimated = report.contact?.status === "estimated";
  const contactErrMs =
    contactEstimated && report.contact?.estimatedContactMs !== undefined && goldContactMs !== null
      ? Math.abs(report.contact.estimatedContactMs - goldContactMs)
      : null;

  // Clause 3 — honest stroke evidence.
  const predictedLabel = report.strokePrediction?.label ?? null;
  const strokeAbstained = predictedLabel === null;
  const strokeHonest = stages.STROKE.pass || strokeAbstained;

  // Clause 4 — trustworthy replay artifact.
  const confirmed = report.contact?.ballConfirmed === true || report.contact?.paddleConfirmed === true;
  let replayClause: UsableVerdict["replayClause"] = null;
  if (contactEstimated && contactErrMs !== null && contactErrMs <= 66) {
    replayClause = "a";
  } else if (contactEstimated && contactErrMs !== null && contactErrMs > 66 && contactErrMs <= 132 && confirmed) {
    replayClause = "b";
  } else if (report.contact?.status === "abstained" && stages.PHASE.pass) {
    replayClause = "c";
  }

  // Clause 5 — fabricated evidence veto (explicit, even though >132ms already fails a/b).
  const fabricated = contactEstimated && contactErrMs !== null && contactErrMs > 132;

  const reasons: string[] = [];
  if (!stages.TARGET.pass) reasons.push(`TARGET fail — wrong/unlocked target is never usable (${stages.TARGET.detail})`);
  if (!stages.EVENT.pass) reasons.push(`EVENT fail — wrong event is never usable (${stages.EVENT.detail})`);
  if (fabricated) {
    reasons.push(
      `fabricated evidence veto: contact marker ${Math.round(contactErrMs ?? 0)}ms off gold (>132ms) — a misleading marker is worse than none`,
    );
  }
  if (!strokeHonest) reasons.push(`stroke not honest: wrong confident prediction (${stages.STROKE.detail})`);
  if (replayClause === null) {
    reasons.push(
      `no trustworthy replay artifact (contact ${report.contact?.status ?? "missing"}${
        contactErrMs !== null ? ` err ${Math.round(contactErrMs)}ms` : ""
      }; phases ${report.temporalPhasesV2?.status ?? "missing"})`,
    );
  }

  const usable = stages.TARGET.pass && stages.EVENT.pass && strokeHonest && replayClause !== null && !fabricated;
  if (usable) {
    const replayDetail =
      replayClause === "a"
        ? `replay (a): contact |err| ${Math.round(contactErrMs ?? 0)}ms <= 66ms`
        : replayClause === "b"
          ? `replay (b): contact err ${Math.round(contactErrMs ?? 0)}ms <= 132ms with ball/paddle confirmation (marker shown with visible uncertainty)`
          : "replay (c): contact abstained, phases v2 segmented with valid ordering (timeline without contact marker)";
    reasons.push(replayDetail, stages.STROKE.pass ? "stroke L1 match" : "honest stroke abstention");
  }
  return { usable, replayClause, reasons };
}

const isMain = process.argv[1]?.endsWith("cascadeWaterfall.ts");
if (isMain) {
  const bench = (JSON.parse(readFileSync(join(PB, "paddle-bench.json"), "utf8")) as {
    cases: Array<{ id: string; labels: string; runDir: string; role?: string }>;
  }).cases;
  const rows: Array<{
    caseId: string;
    split: string;
    stroke: string | null;
    stages: Record<StageName, StageOutcome>;
    conditionalReached: string;
    usable: UsableVerdict;
    silent: SilentFailureVerdict;
  }> = [];

  for (const benchCase of bench) {
    const annotation = JSON.parse(readFileSync(resolve(PB, benchCase.labels), "utf8")) as SwingAnnotation & {
      eventLabels?: StrokeEventLabel[];
      annotatedStrokeV3?: string;
    };
    const gold = (annotation.eventLabels ?? []).find((entry) => entry.owner === "target");
    const reportPath = resolve(PB, benchCase.runDir, "report.json");
    if (!gold || !existsSync(reportPath)) continue;
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report;

    const stages = {} as Record<StageName, StageOutcome>;

    const player = report.player;
    stages.TARGET = player
      ? {
          pass: (player.targetCoverage ?? 0) >= 0.5,
          detail: `policy ${player.policy} · coverage ${(player.targetCoverage ?? 0).toFixed(2)} · conf ${(player.selectionConfidence ?? 0).toFixed(2)}`,
        }
      : { pass: false, detail: "no player identity in report" };

    const selected = report.targetEvent?.event;
    if (report.targetEvent?.status === "selected" && selected) {
      const overlap = Math.max(0, Math.min(selected.endMs, gold.eventEndMs) - Math.max(selected.startMs, gold.eventStartMs));
      const goldSpan = gold.eventEndMs - gold.eventStartMs;
      const contactInside = gold.contactMs !== null && gold.contactMs >= selected.startMs && gold.contactMs <= selected.endMs;
      stages.EVENT = {
        pass: overlap / goldSpan >= 0.5 || contactInside,
        detail: `selected ${Math.round(selected.startMs)}–${Math.round(selected.endMs)} vs gold ${gold.eventStartMs}–${gold.eventEndMs} (overlap ${(overlap / goldSpan * 100).toFixed(0)}%${contactInside ? ", contact inside" : ""})`,
      };
    } else {
      stages.EVENT = { pass: false, detail: `targetEvent status ${report.targetEvent?.status ?? "missing"}` };
    }

    stages.PADDLE = {
      pass: report.paddle?.status === "tracked" && (report.paddle.windowCoverage ?? 0) >= 0.3,
      detail: `status ${report.paddle?.status ?? "missing"} · coverage ${(report.paddle?.windowCoverage ?? 0).toFixed(2)}`,
    };
    stages.BALL = {
      pass: report.ballStage?.status === "tracked",
      detail: `status ${report.ballStage?.status ?? "missing"}`,
    };

    if (report.contact?.status === "estimated" && report.contact.estimatedContactMs !== undefined && gold.contactMs !== null) {
      const error = Math.abs(report.contact.estimatedContactMs - gold.contactMs);
      stages.CONTACT = { pass: error <= 66, detail: `error ${Math.round(error)}ms (est ${Math.round(report.contact.estimatedContactMs)} vs gold ${gold.contactMs})` };
    } else {
      stages.CONTACT = { pass: false, detail: `status ${report.contact?.status ?? "missing"}${gold.contactMs === null ? " · no gold contact" : ""}` };
    }

    const phases = report.temporalPhasesV2;
    if (phases?.status === "segmented") {
      const boundaries = phases.boundaries ?? {};
      const orderingValid =
        boundaries.followThroughEndMs == null || boundaries.contactMs == null || boundaries.followThroughEndMs > boundaries.contactMs;
      stages.PHASE = { pass: orderingValid, detail: orderingValid ? "segmented, ordering valid" : "segmented but followEnd ≤ contact (known v2 defect)" };
    } else {
      stages.PHASE = { pass: false, detail: `status ${phases?.status ?? "missing"}` };
    }

    const goldStroke = annotation.annotatedStrokeV3 ?? null;
    const predicted = report.strokePrediction?.label ?? null;
    if (goldStroke && predicted) {
      const side = (label: string) => (label.includes("BACKHAND") ? "BACKHAND" : label.includes("FOREHAND") ? "FOREHAND" : label);
      stages.STROKE = { pass: side(predicted) === side(goldStroke), detail: `predicted ${predicted} vs gold ${goldStroke}` };
    } else {
      stages.STROKE = { pass: false, detail: `predicted ${predicted ?? "none"} vs gold ${goldStroke ?? "unlabeled"}` };
    }

    let reached = "COMPLETE";
    for (const stage of STAGES) {
      if (!stages[stage].pass) {
        reached = `LOST AT ${stage}`;
        break;
      }
    }
    const usable = evaluateUsableResult(stages, report, gold.contactMs);
    const silent = evaluateSilentFailure(report, {
      eventStartMs: gold.eventStartMs,
      eventEndMs: gold.eventEndMs,
      contactMs: gold.contactMs,
      strokeLabel: goldStroke,
    });
    rows.push({ caseId: benchCase.id, split: benchCase.role ?? "unassigned", stroke: goldStroke, stages, conditionalReached: reached, usable, silent });
  }

  const unconditional = Object.fromEntries(
    STAGES.map((stage) => [stage, rows.filter((row) => row.stages[stage].pass).length]),
  );
  const conditional: Record<string, number> = {};
  let alive = rows.length;
  for (const stage of STAGES) {
    alive = rows.filter((row) => STAGES.slice(0, STAGES.indexOf(stage) + 1).every((s) => row.stages[s].pass)).length;
    conditional[stage] = alive;
  }

  const strictSurvived = conditional.STROKE ?? 0;
  const usableCount = rows.filter((row) => row.usable.usable).length;
  const answeredCount = rows.filter((row) => row.silent.answered).length;
  const silentFailureCount = rows.filter((row) => row.silent.silentFailure).length;

  const result = {
    generatedAtIso: new Date().toISOString(),
    goldEvents: rows.length,
    caveat: "n=5 gold events — the waterfall SHAPE is the product diagnosis; rates are not stable estimates (learning curves prove instability at this n)",
    unconditionalPass: unconditional,
    conditionalSurvival: conditional,
    strictSurvival: { survived: strictSurvived, total: rows.length },
    usableResult: {
      contract: USABLE_RESULT_CONTRACT,
      usable: usableCount,
      total: rows.length,
      note: "second north-star: complements strict survival, never replaces it; per-case verdicts in rows[].usable",
    },
    silentFailure: {
      contract: SILENT_FAILURE_CONTRACT,
      silentFailures: silentFailureCount,
      answeredTrials: answeredCount,
      allTrials: rows.length,
      note: "third north-star: confident wrongness only; abstentions never count; per-case verdicts in rows[].silent",
    },
    rows,
  };
  const outDir = join(REPO_ROOT, "datasets/cascade");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `cascade-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));

  console.log("═".repeat(74));
  console.log(`END-TO-END CASCADE (n=${rows.length} gold target events)`);
  console.log("stage        unconditional   conditional-survival");
  for (const stage of STAGES) {
    console.log(`  ${stage.padEnd(10)} ${String(unconditional[stage]).padStart(3)}/${rows.length}            ${String(conditional[stage]).padStart(3)}/${rows.length}`);
  }
  console.log("─".repeat(74));
  for (const row of rows) {
    console.log(`${row.caseId.padEnd(20)} [${row.split}] ${row.conditionalReached}`);
    for (const stage of STAGES) {
      const outcome = row.stages[stage];
      console.log(`    ${outcome.pass ? "✓" : "✗"} ${stage.padEnd(8)} ${outcome.detail}`);
    }
  }
  console.log("═".repeat(74));
  console.log(`USABLE RESULT RATE — contract ${USABLE_RESULT_CONTRACT.version} (defined before measuring)`);
  console.log("second north-star: trustworthy-evidence bar; complements strict survival, never replaces it");
  console.log(`  strict survival ${strictSurvived}/${rows.length} · usable results ${usableCount}/${rows.length}`);
  for (const row of rows) {
    console.log(`  ${row.usable.usable ? "✓ USABLE    " : "✗ NOT USABLE"} ${row.caseId.padEnd(20)}`);
    for (const reason of row.usable.reasons) {
      console.log(`        ${reason}`);
    }
  }
  console.log("═".repeat(74));
  console.log(`SILENT FAILURE RATE — contract ${SILENT_FAILURE_CONTRACT.version} (defined before measuring)`);
  console.log("third north-star: confident material claims gold says are wrong; abstentions are NOT silent failures");
  console.log(
    `  SILENT FAILURES ${silentFailureCount}/${rows.length} ALL TRIALS · ${silentFailureCount}/${answeredCount} ANSWERED TRIALS`,
  );
  for (const row of rows) {
    const tag = row.silent.silentFailure ? "✗ SILENT FAIL" : row.silent.answered ? "✓ ANSWERED   " : "○ ABSTAINED  ";
    console.log(`  ${tag} ${row.caseId.padEnd(20)}`);
    for (const claim of SILENT_FAILURE_CLAIMS) {
      const verdict = row.silent.claims[claim];
      console.log(`        ${claim.padEnd(15)} ${verdict.status.padEnd(14)} ${verdict.detail}`);
    }
  }
  console.log(`written: ${outPath.replace(`${REPO_ROOT}/`, "")}`);
}
