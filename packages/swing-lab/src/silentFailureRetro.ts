import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import { SILENT_FAILURE_CONTRACT_V1_1, SILENT_FAILURE_CLAIMS } from "./silentFailure.js";
import type { SilentFailureClaim } from "./silentFailure.js";

/**
 * RETROSPECTIVE silent-failure-v1.1 evaluation over the COMMITTED cascade run
 * artifacts (datasets/cascade/cascade-*.json, produced on the macOS box).
 *
 *   pnpm lab:silent-retro
 *
 * WHY: fresh cascade runs (and therefore fresh silent-failure counters) are
 * Mac-gated — pose extraction needs Apple Vision and no canonical run dirs are
 * committed, so `pnpm lab:cascade` on Linux prints honest 0/0. The committed
 * cascade JSONs, however, contain per-case per-stage verdicts with the frozen
 * detail formats, which carry enough signal to re-derive the v1.1 claim
 * verdicts for DEVELOPMENT cases without touching any run directory.
 *
 * SCOPE + LIMITS (stated, never silently relaxed):
 *   - HELD-OUT split rows (wm-dink-01, afn-vic-rally1) are EXCLUDED and only
 *     counted; their stage details are never parsed or reported here.
 *   - The rows do not record ballConfirmed/paddleConfirmed, so a contact
 *     estimate with 66 < |err| <= 132ms cannot be adjudicated between
 *     "confirmed marker with visible uncertainty" (correct) and silent
 *     failure; such claims are UNVERIFIABLE_RETRO with disclosure. This is a
 *     limitation of the retrospective view, not a change to v1.1.
 *   - Detail strings are parsed with strict patterns; anything unrecognized
 *     throws rather than guessing.
 */

const CASCADE_DIR = join(REPO_ROOT, "datasets/cascade");
const EXPERIMENTS = join(REPO_ROOT, "datasets/experiments");

type RetroStatus =
  "correct" | "silent_failure" | "abstained" | "unverifiable_retro" | "not_recorded";

interface RetroClaim {
  status: RetroStatus;
  detail: string;
}

interface CascadeRow {
  caseId: string;
  split: string;
  stages: Record<string, { pass: boolean; detail: string }>;
}

interface CascadeRun {
  generatedAtIso: string;
  rows?: CascadeRow[];
}

export function retroClaims(row: CascadeRow): Record<SilentFailureClaim, RetroClaim> {
  const claims = {} as Record<SilentFailureClaim, RetroClaim>;

  const target = row.stages.TARGET;
  if (!target) throw new Error(`${row.caseId}: missing TARGET stage`);
  if (target.detail.startsWith("no player identity")) {
    claims.TARGET_IDENTITY = { status: "abstained", detail: target.detail };
  } else if (/^policy .+ · coverage /.test(target.detail)) {
    claims.TARGET_IDENTITY = {
      status: target.pass ? "correct" : "silent_failure",
      detail: target.detail,
    };
  } else {
    throw new Error(`${row.caseId}: unrecognized TARGET detail: ${target.detail}`);
  }

  const event = row.stages.EVENT;
  if (!event) throw new Error(`${row.caseId}: missing EVENT stage`);
  if (event.detail.startsWith("targetEvent status")) {
    claims.EVENT = { status: "abstained", detail: event.detail };
  } else if (event.detail.startsWith("selected ")) {
    claims.EVENT = { status: event.pass ? "correct" : "silent_failure", detail: event.detail };
  } else {
    throw new Error(`${row.caseId}: unrecognized EVENT detail: ${event.detail}`);
  }

  const contact = row.stages.CONTACT;
  if (!contact) throw new Error(`${row.caseId}: missing CONTACT stage`);
  const errMatch = contact.detail.match(/^error (\d+)ms /);
  if (contact.detail.startsWith("status ")) {
    claims.CONTACT_MARKER = { status: "abstained", detail: contact.detail };
  } else if (errMatch) {
    const err = Number(errMatch[1]);
    if (err <= 66) {
      claims.CONTACT_MARKER = { status: "correct", detail: contact.detail };
    } else if (err <= 132) {
      claims.CONTACT_MARKER = {
        status: "unverifiable_retro",
        detail: `${contact.detail} — 66 < err <= 132ms needs ball/paddle confirmation, not recorded in cascade rows`,
      };
    } else {
      claims.CONTACT_MARKER = { status: "silent_failure", detail: contact.detail };
    }
  } else {
    throw new Error(`${row.caseId}: unrecognized CONTACT detail: ${contact.detail}`);
  }

  const phase = row.stages.PHASE;
  if (!phase) throw new Error(`${row.caseId}: missing PHASE stage`);
  if (phase.detail.startsWith("status ")) {
    claims.PHASE_RENDER = { status: "abstained", detail: phase.detail };
  } else if (phase.detail.includes("ordering")) {
    claims.PHASE_RENDER = {
      status: phase.pass ? "correct" : "silent_failure",
      detail: phase.detail,
    };
  } else {
    throw new Error(`${row.caseId}: unrecognized PHASE detail: ${phase.detail}`);
  }

  const stroke = row.stages.STROKE;
  if (!stroke) throw new Error(`${row.caseId}: missing STROKE stage`);
  if (stroke.detail.startsWith("predicted none")) {
    claims.STROKE_L1 = { status: "abstained", detail: stroke.detail };
  } else if (stroke.detail.startsWith("predicted ")) {
    claims.STROKE_L1 = {
      status: stroke.pass ? "correct" : "silent_failure",
      detail: stroke.detail,
    };
  } else {
    throw new Error(`${row.caseId}: unrecognized STROKE detail: ${stroke.detail}`);
  }

  return claims;
}

export interface RetroTrialVerdict {
  caseId: string;
  answered: boolean;
  silentFailure: boolean;
  claims: Record<SilentFailureClaim, RetroClaim>;
}

export function retroTrial(row: CascadeRow): RetroTrialVerdict {
  const claims = retroClaims(row);
  const values = Object.values(claims);
  return {
    caseId: row.caseId,
    answered: values.some(
      (claim) => claim.status === "correct" || claim.status === "silent_failure",
    ),
    silentFailure: values.some((claim) => claim.status === "silent_failure"),
    claims,
  };
}

export interface RetroRunSummary {
  file: string;
  generatedAtIso: string;
  developmentTrials: number;
  heldOutRowsExcluded: number;
  answeredTrials: number;
  silentFailureTrials: number;
  perClaim: Record<SilentFailureClaim, Record<RetroStatus, number>>;
  trials: RetroTrialVerdict[];
}

export function evaluateCommittedRuns(cascadeDir = CASCADE_DIR): RetroRunSummary[] {
  const summaries: RetroRunSummary[] = [];
  for (const file of readdirSync(cascadeDir).sort()) {
    if (!/^cascade-\d+\.json$/.test(file)) continue;
    const run = JSON.parse(readFileSync(join(cascadeDir, file), "utf8")) as CascadeRun;
    const rows = run.rows ?? [];
    if (rows.length === 0) continue;
    const dev = rows.filter((row) => row.split === "development");
    const trials = dev.map(retroTrial);
    const perClaim = {} as RetroRunSummary["perClaim"];
    for (const claim of SILENT_FAILURE_CLAIMS) {
      perClaim[claim] = {
        correct: 0,
        silent_failure: 0,
        abstained: 0,
        unverifiable_retro: 0,
        not_recorded: 0,
      };
      for (const trial of trials) perClaim[claim][trial.claims[claim].status] += 1;
    }
    summaries.push({
      file,
      generatedAtIso: run.generatedAtIso,
      developmentTrials: dev.length,
      heldOutRowsExcluded: rows.length - dev.length,
      answeredTrials: trials.filter((trial) => trial.answered).length,
      silentFailureTrials: trials.filter((trial) => trial.silentFailure).length,
      perClaim,
      trials,
    });
  }
  return summaries;
}

const isMain = process.argv[1]?.endsWith("silentFailureRetro.ts");
if (isMain) {
  const runs = evaluateCommittedRuns();
  const report = {
    generatedAtIso: new Date().toISOString(),
    contract: SILENT_FAILURE_CONTRACT_V1_1,
    provenance:
      "retrospective evaluation over committed datasets/cascade/cascade-*.json rows (macOS-produced); development split only; held-out rows excluded and never parsed; contact 66<err<=132ms is unverifiable_retro (rows lack ball/paddle confirmation); n=3 development cases — counts, not stable rates",
    runs: runs.map((run) => ({
      ...run,
      trials: run.trials,
    })),
  };
  const outDir = join(EXPERIMENTS, "wave-e");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "e07-silent-failure-retro.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log("═".repeat(74));
  console.log("RETRO silent-failure-v1.1 over committed cascade runs (development split only)");
  console.log("  run file                          silentFail/answered  perClaim silent failures");
  for (const run of runs) {
    const claimFails = SILENT_FAILURE_CLAIMS.filter(
      (claim) => run.perClaim[claim].silent_failure > 0,
    )
      .map((claim) => `${claim}:${run.perClaim[claim].silent_failure}`)
      .join(" ");
    console.log(
      `  ${run.file.padEnd(34)} ${run.silentFailureTrials}/${run.answeredTrials} of ${run.developmentTrials} dev  ${claimFails || "-"}`,
    );
  }
  console.log(`written: ${outPath.replace(`${REPO_ROOT}/`, "")}`);
}
