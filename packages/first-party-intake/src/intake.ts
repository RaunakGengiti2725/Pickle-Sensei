import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  evaluateCaptureEnvelope,
  measureClip,
  probeClipStream,
  type CaptureEnvelopeMeasurements,
} from "@pickle/capture-envelope";
import type { EnvelopeVerdict } from "@pickle/shared-types";
import { loadCaptureMeta, type CaptureMeta } from "./captureMeta.js";
import {
  checkConsentForSubject,
  loadConsentLedger,
  type ConsentCheckResult,
} from "./consentRef.js";

/**
 * First-party clip intake (D2-12). Validates one incoming consented clip on
 * CPU and drafts the manifest entry intake can honestly fill. The output is
 * a DRAFT: `pendingBeforeSnapshot` names every collection_manifest
 * requirement that still needs humans (annotation, dual review + coach
 * adjudication, rights verification record, split assignment, eligibility
 * approval). Intake never claims `approved_for_snapshot`.
 */

export const INTAKE_VERSION = "first-party-intake-v1";

export type IntakeStatus = "ACCEPTED" | "ACCEPTED_DEGRADED" | "REJECTED";

/** Manifest requirements intake cannot satisfy; listed on every draft. */
export const PENDING_BEFORE_SNAPSHOT = [
  "annotation (versioned taxonomy labels: stroke start/contact/end, phases)",
  "review (two independent trained annotators + coach adjudication)",
  "rights (verified rights record: holder, grant, bystander clearance)",
  "quality (pose-gated flags; pose extraction is not available at intake)",
  "split (athlete-grouped partition assignment + leakage audit)",
  "eligibility (approved_for_snapshot decision)",
  "envelope pose dimensions (player_pixel_height, player_visibility)",
] as const;

export interface IntakeInput {
  clipPath: string;
  consentLedgerPath: string;
  subjectPseudonym: string;
  captureMetaPath: string;
  operatorId: string;
}

export interface ManifestDraft {
  clipId: string;
  athleteId: string;
  athleteGroupId: string;
  sessionId: string;
  rawAsset: {
    assetId: string;
    sha256: string;
    recordedAt: string;
    durationMs: number;
    frameCount: number | null;
    frameRateFps: number;
    widthPx: number;
    heightPx: number;
  };
  capture: CaptureMeta["capture"] & { sourceKind: "consented_first_party_capture" };
  consentReference: {
    ledgerSha256: string;
    subjectPseudonym: string;
    modelTrainingConsentVersion: string | null;
  };
  pendingBeforeSnapshot: readonly string[];
}

export interface IntakeRecord {
  intakeVersion: typeof INTAKE_VERSION;
  intakeAtIso: string;
  operatorId: string;
  status: IntakeStatus;
  reasons: string[];
  consent: ConsentCheckResult;
  measurements: CaptureEnvelopeMeasurements | null;
  envelope: EnvelopeVerdict | null;
  manifestDraft: ManifestDraft | null;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function intakeClip(input: IntakeInput): IntakeRecord {
  const reasons: string[] = [];

  const meta = loadCaptureMeta(input.captureMetaPath);
  const ledger = loadConsentLedger(input.consentLedgerPath);
  const consent = checkConsentForSubject(ledger, input.subjectPseudonym);
  reasons.push(...consent.errors);

  let measurements: CaptureEnvelopeMeasurements | null = null;
  let envelope: EnvelopeVerdict | null = null;
  try {
    measurements = measureClip(input.clipPath);
    envelope = evaluateCaptureEnvelope(measurements);
  } catch (error) {
    reasons.push(`envelope measurement failed: ${(error as Error).message}`);
  }
  if (envelope?.overall === "UNSUPPORTED") {
    const failing = envelope.dimensions
      .filter((d) => d.status === "UNSUPPORTED")
      .map((d) => `${d.dimension}=${d.measured ?? "null"} (${d.thresholdId})`);
    reasons.push(`capture envelope UNSUPPORTED: ${failing.join(", ")}`);
  }

  let status: IntakeStatus;
  if (!consent.ok || envelope === null || envelope.overall === "UNSUPPORTED") {
    status = "REJECTED";
  } else {
    status = envelope.overall === "DEGRADED" ? "ACCEPTED_DEGRADED" : "ACCEPTED";
  }
  const accepted = status !== "REJECTED";

  let manifestDraft: ManifestDraft | null = null;
  if (accepted) {
    const stream = probeClipStream(input.clipPath);
    manifestDraft = {
      clipId: meta.clipId,
      athleteId: meta.athleteId,
      athleteGroupId: meta.athleteGroupId,
      sessionId: meta.sessionId,
      rawAsset: {
        assetId: `${meta.clipId}.raw`,
        sha256: sha256File(input.clipPath),
        recordedAt: meta.recordedAt,
        durationMs: stream.durationMs,
        frameCount: countFrames(input.clipPath),
        frameRateFps: stream.avgFrameRateFps,
        widthPx: stream.width,
        heightPx: stream.height,
      },
      capture: { sourceKind: "consented_first_party_capture", ...meta.capture },
      consentReference: {
        ledgerSha256: sha256File(input.consentLedgerPath),
        subjectPseudonym: input.subjectPseudonym,
        modelTrainingConsentVersion: consent.modelTrainingConsentVersion,
      },
      pendingBeforeSnapshot: PENDING_BEFORE_SNAPSHOT,
    };
  }

  return {
    intakeVersion: INTAKE_VERSION,
    intakeAtIso: new Date().toISOString(),
    operatorId: input.operatorId,
    status,
    reasons,
    consent,
    measurements,
    envelope,
    manifestDraft,
  };
}

/** Exact packet count of the video stream; null when ffprobe cannot count. */
export function countFrames(clipPath: string): number | null {
  const res = spawnSync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-count_packets",
    "-show_entries",
    "stream=nb_read_packets",
    "-of",
    "csv=p=0",
    clipPath,
  ]);
  if (res.status !== 0) return null;
  const count = Number(res.stdout.toString().trim());
  return Number.isFinite(count) && count > 0 ? count : null;
}
