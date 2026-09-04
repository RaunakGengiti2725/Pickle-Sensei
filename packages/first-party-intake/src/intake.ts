import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  evaluateCaptureEnvelope,
  measureClip,
  probeClipStream,
  type CaptureEnvelopeMeasurements,
} from "@pickle/capture-envelope";
import type { ConsentRecord, EnvelopeVerdict } from "@pickle/shared-types";
import { loadCaptureMeta, type CaptureMeta } from "./captureMeta.js";
import {
  checkConsentForSubject,
  loadConsentLedger,
  type ConsentCheckResult,
  type ConsentLedgerVerifyOptions,
} from "./consentRef.js";

/**
 * First-party clip intake (D2-12). Validates one incoming consented clip on
 * CPU and drafts the manifest entry intake can honestly fill. The output is
 * a DRAFT: `pendingBeforeSnapshot` names every collection_manifest
 * requirement that still needs humans (annotation, dual review + coach
 * adjudication, rights verification record, split assignment, eligibility
 * approval). Intake never claims `approved_for_snapshot`.
 */

/** v2: record carries `consentLedger` evidence and ledger verification failures REJECT instead of throwing. */
export const INTAKE_VERSION = "first-party-intake-v2";

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
  /**
   * HMAC key of consent export contract v2. When set, only a correctly signed
   * v2 envelope is trusted: unsigned (v1) envelopes and bare record arrays are
   * a signature downgrade and REJECT the clip. Never written to the record.
   */
  consentSigningKey?: string;
  /**
   * Highest export `maxSeq` this host has already accepted for the subject
   * (read it back from the previous record's `consentLedger.maxSeq`). An
   * export behind it is a stale replay and REJECTS the clip.
   */
  consentMinMaxSeq?: number;
}

/** What the host actually verified about the ledger it consulted. */
export interface ConsentLedgerEvidence {
  /** true only when a signing key was configured AND the v2 signature verified. */
  signatureVerified: boolean;
  /** Highest seq in the trusted export; null for a bare array or an unloadable ledger. */
  maxSeq: number | null;
  /** The watermark the host required, null when none was configured. */
  watermark: number | null;
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
    exportSignatureVerified: boolean;
    ledgerMaxSeq: number | null;
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
  consentLedger: ConsentLedgerEvidence;
  measurements: CaptureEnvelopeMeasurements | null;
  envelope: EnvelopeVerdict | null;
  manifestDraft: ManifestDraft | null;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ledgerVerifyOptions(input: IntakeInput): ConsentLedgerVerifyOptions {
  const options: ConsentLedgerVerifyOptions = {};
  if (input.consentSigningKey !== undefined) {
    if (input.consentSigningKey.length === 0) {
      throw new Error("consentSigningKey must be a non-empty string when provided");
    }
    options.signingKey = input.consentSigningKey;
  }
  if (input.consentMinMaxSeq !== undefined) {
    // A watermark that cannot be compared (NaN, negative, fractional) would
    // silently disable the replay check; refuse the invocation instead.
    if (!Number.isSafeInteger(input.consentMinMaxSeq) || input.consentMinMaxSeq < 0) {
      throw new Error(
        `consentMinMaxSeq must be a non-negative integer, got ${String(input.consentMinMaxSeq)}`,
      );
    }
    options.minMaxSeq = input.consentMinMaxSeq;
  }
  return options;
}

function ledgerMaxSeq(ledger: readonly ConsentRecord[]): number | null {
  let max: number | null = null;
  for (const row of ledger) {
    if (typeof row.seq === "number" && (max === null || row.seq > max)) max = row.seq;
  }
  return max;
}

function consentNotEstablished(subjectPseudonym: string, reason: string): ConsentCheckResult {
  return {
    ok: false,
    subjectPseudonym,
    subjectRecordCount: 0,
    videoAnalysisActive: false,
    modelTrainingActive: false,
    modelTrainingConsentVersion: null,
    errors: [reason],
  };
}

export function intakeClip(input: IntakeInput): IntakeRecord {
  const reasons: string[] = [];

  const meta = loadCaptureMeta(input.captureMetaPath);
  const verify = ledgerVerifyOptions(input);

  // A ledger the host cannot parse or verify is a consent failure, not a
  // crash: the clip is REJECTED and the record carries the reason, so the
  // operator keeps an auditable trail of the refused export.
  let ledger: ConsentRecord[] | null = null;
  let ledgerProblem: string | null = null;
  try {
    ledger = loadConsentLedger(input.consentLedgerPath, verify);
  } catch (error) {
    ledgerProblem = (error as Error).message;
  }
  const consent: ConsentCheckResult =
    ledger !== null
      ? checkConsentForSubject(ledger, input.subjectPseudonym)
      : consentNotEstablished(
          input.subjectPseudonym,
          `consent ledger could not be verified: ${ledgerProblem ?? "unknown error"}`,
        );
  const consentLedger: ConsentLedgerEvidence = {
    signatureVerified: ledger !== null && verify.signingKey !== undefined,
    maxSeq: ledger !== null ? ledgerMaxSeq(ledger) : null,
    watermark: verify.minMaxSeq ?? null,
  };
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
        exportSignatureVerified: consentLedger.signatureVerified,
        ledgerMaxSeq: consentLedger.maxSeq,
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
    consentLedger,
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
