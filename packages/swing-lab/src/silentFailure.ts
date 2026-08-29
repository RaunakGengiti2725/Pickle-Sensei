/**
 * SILENT FAILURE CONTRACT — silent-failure-v1
 *
 * Third north star, printed alongside — never replacing — strict survival and
 * usable-result-v1. Written from the PRODUCT definition BEFORE measuring (not
 * fit to today's cases). Change this contract only by re-versioning
 * (silent-failure-v2, …), never by softening in place.
 *
 * DEFINITION. A SILENT FAILURE is a user-visible CONFIDENT MATERIAL CLAIM that
 * gold says is wrong. The five material claims a Result can present:
 *
 *   TARGET_IDENTITY — the lock the product presented resolved the wrong person
 *                     (strict TARGET criterion: coverage >= 0.5). Presenting a
 *                     lock IS the claim; no lock presented = abstention.
 *   EVENT           — a selected stroke event that fails the strict EVENT
 *                     criterion (>=50% gold-span overlap or gold contact inside
 *                     the selection). No selection = abstention.
 *   STROKE_L1       — a non-null stroke label whose L1 side (FOREHAND/BACKHAND)
 *                     contradicts gold. Null/missing label = abstention (the
 *                     classifier declined — that is honesty, not failure).
 *   CONTACT_MARKER  — a contact estimate that would mislead: estimated with
 *                     |err| > 132ms vs gold (fabricated marker), OR estimated
 *                     with 66 < |err| <= 132ms WITHOUT ball/paddle confirmation
 *                     (the usable-result-v1 uncertainty arm does not hold, so
 *                     the marker is shown without evidentiary support).
 *                     status "abstained" = abstention. Estimated with |err| <=
 *                     66ms is correct; 66–132ms WITH confirmation is shown with
 *                     visible uncertainty (not a silent failure).
 *   PHASE_RENDER    — a rendered phase timeline whose boundary ordering is
 *                     impossible (followThroughEnd <= contact): a physically
 *                     false render. Not segmented = abstention.
 *
 * ABSTENTIONS ARE NOT SILENT FAILURES. An honest "couldn't determine" never
 * counts against this metric — that is the entire point: the metric punishes
 * confident wrongness, not humility.
 *
 * UNVERIFIABLE claims (gold missing for that claim: no gold stroke label, no
 * gold contact timestamp) are counted as neither correct nor silent failure;
 * they are reported so denominators stay honest.
 *
 * TRIAL-LEVEL AGGREGATION.
 *   ANSWERED trial   — at least one of the five claims was ANSWERED (confident,
 *                      gold-verifiable claim presented).
 *   SILENT-FAIL trial — at least one answered claim is wrong per the rules
 *                      above.
 * Reported as SILENT FAILURES / ALL TRIALS (product-wide exposure) and
 * SILENT FAILURES / ANSWERED TRIALS (selective risk among answers).
 */

export const SILENT_FAILURE_CONTRACT = {
  version: "silent-failure-v1",
  definition:
    "a user-visible confident material claim (target identity, event, stroke L1, contact marker, phase render) that gold says is wrong; abstentions are NOT silent failures",
  claims: {
    targetIdentity: "lock presented but strict TARGET criterion fails (coverage < 0.5); no lock = abstention",
    event: "event selected but strict EVENT criterion fails; no selection = abstention",
    strokeL1: "non-null label whose L1 side contradicts gold; null/missing label = abstention",
    contactMarker:
      "estimated with |err| > 132ms vs gold, OR 66 < |err| <= 132ms without ball/paddle confirmation; abstained = abstention",
    phaseRender: "segmented timeline with impossible boundary ordering (followThroughEnd <= contact); not segmented = abstention",
  },
  aggregation:
    "trial is ANSWERED if >=1 claim answered and gold-verifiable; trial is a SILENT FAILURE if >=1 answered claim is wrong; report silent failures over ALL trials and over ANSWERED trials",
} as const;

export const SILENT_FAILURE_CLAIMS = [
  "TARGET_IDENTITY",
  "EVENT",
  "STROKE_L1",
  "CONTACT_MARKER",
  "PHASE_RENDER",
] as const;
export type SilentFailureClaim = (typeof SILENT_FAILURE_CLAIMS)[number];

export type ClaimStatus = "correct" | "silent_failure" | "abstained" | "unverifiable";

export interface ClaimVerdict {
  status: ClaimStatus;
  detail: string;
}

export interface SilentFailureVerdict {
  answered: boolean;
  silentFailure: boolean;
  claims: Record<SilentFailureClaim, ClaimVerdict>;
}

/** The per-case report shape the cascade reads (same artifacts as strict + usable). */
export interface SilentFailureReportView {
  player?: { targetCoverage?: number; policy?: string };
  targetEvent?: { status?: string; event?: { startMs: number; endMs: number } };
  contact?: { status?: string; estimatedContactMs?: number; ballConfirmed?: boolean; paddleConfirmed?: boolean };
  temporalPhasesV2?: { status?: string; boundaries?: { contactMs?: number | null; followThroughEndMs?: number | null } };
  strokePrediction?: { label?: string | null };
}

export interface SilentFailureGold {
  eventStartMs: number;
  eventEndMs: number;
  contactMs: number | null;
  strokeLabel: string | null;
}

const l1Side = (label: string): string =>
  label.includes("BACKHAND") ? "BACKHAND" : label.includes("FOREHAND") ? "FOREHAND" : label;

export function evaluateSilentFailure(report: SilentFailureReportView, gold: SilentFailureGold): SilentFailureVerdict {
  const claims = {} as Record<SilentFailureClaim, ClaimVerdict>;

  const player = report.player;
  if (!player) {
    claims.TARGET_IDENTITY = { status: "abstained", detail: "no lock presented (no player identity in report)" };
  } else {
    const coverage = player.targetCoverage ?? 0;
    claims.TARGET_IDENTITY =
      coverage >= 0.5
        ? { status: "correct", detail: `lock presented, coverage ${coverage.toFixed(2)} >= 0.5` }
        : { status: "silent_failure", detail: `lock presented but coverage ${coverage.toFixed(2)} < 0.5` };
  }

  const selected = report.targetEvent?.event;
  if (report.targetEvent?.status !== "selected" || !selected) {
    claims.EVENT = { status: "abstained", detail: `no event selected (status ${report.targetEvent?.status ?? "missing"})` };
  } else {
    const overlap = Math.max(0, Math.min(selected.endMs, gold.eventEndMs) - Math.max(selected.startMs, gold.eventStartMs));
    const goldSpan = gold.eventEndMs - gold.eventStartMs;
    const contactInside = gold.contactMs !== null && gold.contactMs >= selected.startMs && gold.contactMs <= selected.endMs;
    const pass = overlap / goldSpan >= 0.5 || contactInside;
    claims.EVENT = pass
      ? { status: "correct", detail: `selected event holds (overlap ${((overlap / goldSpan) * 100).toFixed(0)}%${contactInside ? ", contact inside" : ""})` }
      : { status: "silent_failure", detail: `selected wrong event (overlap ${((overlap / goldSpan) * 100).toFixed(0)}%, gold contact outside)` };
  }

  const predicted = report.strokePrediction?.label ?? null;
  if (predicted === null) {
    claims.STROKE_L1 = { status: "abstained", detail: "stroke abstained (null/missing label)" };
  } else if (gold.strokeLabel === null) {
    claims.STROKE_L1 = { status: "unverifiable", detail: `predicted ${predicted} but gold stroke unlabeled` };
  } else {
    const match = l1Side(predicted) === l1Side(gold.strokeLabel);
    claims.STROKE_L1 = match
      ? { status: "correct", detail: `predicted ${predicted}, L1 matches gold ${gold.strokeLabel}` }
      : { status: "silent_failure", detail: `confidently wrong L1: predicted ${predicted} vs gold ${gold.strokeLabel}` };
  }

  const contact = report.contact;
  if (contact?.status !== "estimated") {
    claims.CONTACT_MARKER = { status: "abstained", detail: `contact ${contact?.status ?? "missing"} — no marker claimed` };
  } else if (contact.estimatedContactMs === undefined || gold.contactMs === null) {
    claims.CONTACT_MARKER = {
      status: "unverifiable",
      detail: `marker claimed but ${gold.contactMs === null ? "no gold contact" : "no estimate timestamp"} — err unverifiable`,
    };
  } else {
    const err = Math.abs(contact.estimatedContactMs - gold.contactMs);
    const confirmed = contact.ballConfirmed === true || contact.paddleConfirmed === true;
    if (err <= 66) {
      claims.CONTACT_MARKER = { status: "correct", detail: `marker |err| ${Math.round(err)}ms <= 66ms` };
    } else if (err <= 132 && confirmed) {
      claims.CONTACT_MARKER = {
        status: "correct",
        detail: `marker err ${Math.round(err)}ms in 66–132ms with ball/paddle confirmation (shown with visible uncertainty)`,
      };
    } else {
      claims.CONTACT_MARKER = {
        status: "silent_failure",
        detail:
          err > 132
            ? `fabricated marker: err ${Math.round(err)}ms > 132ms`
            : `marker err ${Math.round(err)}ms in 66–132ms WITHOUT ball/paddle confirmation`,
      };
    }
  }

  const phases = report.temporalPhasesV2;
  if (phases?.status !== "segmented") {
    claims.PHASE_RENDER = { status: "abstained", detail: `phases ${phases?.status ?? "missing"} — no timeline rendered` };
  } else {
    const boundaries = phases.boundaries ?? {};
    const orderingValid =
      boundaries.followThroughEndMs == null || boundaries.contactMs == null || boundaries.followThroughEndMs > boundaries.contactMs;
    claims.PHASE_RENDER = orderingValid
      ? { status: "correct", detail: "timeline rendered, ordering valid" }
      : { status: "silent_failure", detail: "timeline rendered with impossible ordering (followThroughEnd <= contact)" };
  }

  const values = Object.values(claims);
  const answered = values.some((claim) => claim.status === "correct" || claim.status === "silent_failure");
  const silentFailure = values.some((claim) => claim.status === "silent_failure");
  return { answered, silentFailure, claims };
}
