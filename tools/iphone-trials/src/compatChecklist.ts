/**
 * Runnable compatibility checklist harness (`ios-compat-checklist-report-v1`).
 *
 * Builds on the existing iphone-trials device harness: for every device/OS
 * combination in the compatibility matrix it emits the operator checklist per
 * capability and derives an evidence status from the same
 * `pickle.iphone-trial.v1` files the trial report consumes. Pure function
 * over parsed documents, so the whole path runs on Linux with zero devices.
 *
 * Honesty rules:
 * - Only valid DEVICE_MEASUREMENT trials whose matrixDeviceId AND iOS major
 *   match the combination count as evidence.
 * - A GREEN/RED cell whose evidenceTrialIds do not resolve to such trials is
 *   an integrity failure that fails the report loudly.
 * - With no matching device trials, every cell reports
 *   BLOCKED_EXTERNAL_NO_DEVICE_TRIALS — absence is explained, never zeroed.
 */

import { type DeviceMatrixV1 } from "./deviceMatrix.js";
import {
  COMPAT_CAPABILITIES,
  validateCompatMatrix,
  type CompatCapability,
  type CompatMatrixV1,
  type CompatValidationState,
} from "./compatMatrix.js";
import { validateIphoneTrial, type IphoneTrialV1, type Metric } from "./trialSchema.js";
import { type InvalidTrialFile, type TrialFileInput } from "./generateReport.js";

export const COMPAT_CHECKLIST_REPORT_SCHEMA_VERSION = "ios-compat-checklist-report-v1" as const;

export interface CapabilityChecklistSpec {
  capability: CompatCapability;
  /** Operator steps performed on the physical device during a trial. */
  steps: string[];
  /**
   * Dotted `pickle.iphone-trial.v1` metric paths that must be measured for a
   * trial to count as evidence for this capability. Empty when the capability
   * has no per-trial metric yet and needs a human evidence note instead.
   */
  evidenceMetricPaths: string[];
}

export const CAPABILITY_CHECKLIST: readonly CapabilityChecklistSpec[] = [
  {
    capability: "camera",
    steps: [
      "Start capture and confirm a live preview appears.",
      "Record camera start -> first frame time from the trial log.",
      "Confirm requested resolution/lens/stabilization were honored.",
    ],
    evidenceMetricPaths: ["metrics.cameraStartToFirstFrameMs"],
  },
  {
    capability: "permissions",
    steps: [
      "Fresh-install the build so no permission is pre-granted.",
      "Walk the camera/microphone/photos prompts and record which appeared.",
      "Deny then re-grant one permission and confirm recovery UI works.",
    ],
    evidenceMetricPaths: ["metrics.permissionFlow"],
  },
  {
    capability: "frameTiming",
    steps: [
      "Capture a full session at the requested FPS.",
      "Record mean/min FPS and dropped-frame ratio from the trial log.",
    ],
    evidenceMetricPaths: ["metrics.captureFps"],
  },
  {
    capability: "thermal",
    steps: [
      "Run back-to-back sessions until thermal state leaves nominal.",
      "Record thermal state at start/end and time-to-serious if reached.",
    ],
    evidenceMetricPaths: ["metrics.stability.timeToThermalSeriousMs"],
  },
  {
    capability: "memory",
    steps: [
      "Attach memory instrumentation for the whole trial.",
      "Record peak memory footprint and confirm no jetsam/crash.",
    ],
    evidenceMetricPaths: ["metrics.stability.peakMemoryFootprintBytes"],
  },
  {
    capability: "modelRuntime",
    steps: [
      "Confirm the live model/contract versions in the build match modelVersions.",
      "Record app-internal analysis wall time (request -> result payload).",
    ],
    evidenceMetricPaths: ["metrics.analysisLatency.analysisRequestToResultMs"],
  },
  {
    capability: "envelope",
    steps: [
      "Capture inside and outside the supported envelope (distance/framing/light).",
      "Confirm out-of-envelope input is refused with guidance, not analyzed.",
    ],
    evidenceMetricPaths: ["metrics.autoDetectQuality"],
  },
  {
    capability: "targetLock",
    steps: [
      "Acquire target lock with a second person in frame.",
      "Human-verify lock subject, time-to-lock, persistence, identity switches against the reference recording.",
    ],
    evidenceMetricPaths: [
      "metrics.targetAcquisition.lockOnIntendedSubject",
      "metrics.targetAcquisition.timeToLockMs",
    ],
  },
  {
    capability: "eventTrigger",
    steps: [
      "Perform real strokes; human-mark events on the reference recording.",
      "Record trigger latency, recall, false proposals, boundary overlap.",
    ],
    evidenceMetricPaths: ["metrics.strokeTrigger", "metrics.eventDetection.recalledEventCount"],
  },
  {
    capability: "result",
    steps: [
      "Open the Result surface after analysis completes.",
      "Human-verify it rendered without error and every field traces to real evidence.",
    ],
    evidenceMetricPaths: ["metrics.resultCorrectness", "metrics.resultRenderMs"],
  },
  {
    capability: "tryAgain",
    steps: [
      "Tap Try Again from the Result surface.",
      "Confirm return-to-capture time and that state fully reset.",
    ],
    evidenceMetricPaths: ["metrics.tryAgain"],
  },
  {
    capability: "session",
    steps: [
      "Run a multi-stroke session end-to-end (capture -> results -> history).",
      "Background/foreground the app mid-session and confirm no state loss.",
      "No per-trial metric exists yet: record a human evidence note in the trial notes.",
    ],
    evidenceMetricPaths: [],
  },
  {
    capability: "import",
    steps: [
      "Import a previously recorded video from the photo library.",
      "Confirm the imported clip analyzes and renders a Result.",
      "No per-trial metric exists yet: record a human evidence note in the trial notes.",
    ],
    evidenceMetricPaths: [],
  },
];

export type CapabilityEvidenceStatus =
  | "BLOCKED_EXTERNAL_NO_DEVICE_TRIALS"
  | "DEVICE_TRIALS_PRESENT_METRIC_UNMEASURED"
  | "DEVICE_EVIDENCE_PRESENT"
  | "MANUAL_EVIDENCE_REQUIRED";

export interface CapabilityChecklistResult {
  capability: CompatCapability;
  matrixState: CompatValidationState;
  steps: string[];
  evidenceMetricPaths: string[];
  matchingDeviceTrialIds: string[];
  measuredEvidenceTrialIds: string[];
  evidenceStatus: CapabilityEvidenceStatus;
  /** Required non-null when no device evidence exists. */
  blockedReason: string | null;
}

export interface DeviceOsChecklistResult {
  deviceId: string;
  iosMajor: number;
  matchingDeviceTrialCount: number;
  capabilities: CapabilityChecklistResult[];
}

export interface CompatIntegrityFailure {
  deviceId: string;
  iosMajor: number;
  capability: CompatCapability;
  error: string;
}

export interface CompatChecklistReportV1 {
  schemaVersion: typeof COMPAT_CHECKLIST_REPORT_SCHEMA_VERSION;
  generatedAtIso: string;
  totals: {
    combinations: number;
    deviceMeasurementTrials: number;
    sampleFixtureTrials: number;
    invalidFiles: number;
  };
  invalidFiles: InvalidTrialFile[];
  /** GREEN/RED cells whose claimed evidence does not resolve to real trials. */
  integrityFailures: CompatIntegrityFailure[];
  combinations: DeviceOsChecklistResult[];
  notes: string[];
}

function isMetric(value: unknown): value is Metric<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { measured?: unknown }).measured === "boolean"
  );
}

function metricAtPath(trial: IphoneTrialV1, dottedPath: string): Metric<unknown> | null {
  let node: unknown = trial;
  for (const segment of dottedPath.split(".")) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      return null;
    }
    node = (node as Record<string, unknown>)[segment];
  }
  return isMetric(node) ? node : null;
}

function iosMajorOf(trial: IphoneTrialV1): number {
  const major = Number.parseInt(trial.device.iosVersion.split(".")[0] ?? "", 10);
  return Number.isInteger(major) ? major : -1;
}

export interface GenerateCompatChecklistArgs {
  compatMatrix: unknown;
  deviceMatrix: unknown;
  trialFiles: readonly TrialFileInput[];
  generatedAtIso: string;
}

export function generateCompatChecklist(
  args: GenerateCompatChecklistArgs,
): CompatChecklistReportV1 {
  const matrixErrors = validateCompatMatrix(args.compatMatrix, args.deviceMatrix);
  if (matrixErrors.length > 0) {
    throw new Error(`generateCompatChecklist: invalid compat matrix:\n${matrixErrors.join("\n")}`);
  }
  const compat = args.compatMatrix as CompatMatrixV1;
  const deviceMatrix = args.deviceMatrix as DeviceMatrixV1;
  const knownDeviceIds = new Set(deviceMatrix.devices.map((d) => d.deviceId));

  const invalidFiles: InvalidTrialFile[] = [];
  const deviceTrials: IphoneTrialV1[] = [];
  let sampleFixtureTrials = 0;
  for (const file of args.trialFiles) {
    const errors = validateIphoneTrial(file.data);
    if (errors.length > 0) {
      invalidFiles.push({ fileName: file.fileName, errors });
      continue;
    }
    const trial = file.data as IphoneTrialV1;
    if (!knownDeviceIds.has(trial.device.matrixDeviceId)) {
      invalidFiles.push({
        fileName: file.fileName,
        errors: [
          `device.matrixDeviceId "${trial.device.matrixDeviceId}" not in device-matrix.json — append the device to the manifest first`,
        ],
      });
      continue;
    }
    if (trial.provenance === "SAMPLE_FIXTURE_NOT_A_MEASUREMENT") {
      sampleFixtureTrials += 1;
    } else {
      deviceTrials.push(trial);
    }
  }

  const specByCapability = new Map(CAPABILITY_CHECKLIST.map((spec) => [spec.capability, spec]));
  const integrityFailures: CompatIntegrityFailure[] = [];

  const combinations: DeviceOsChecklistResult[] = compat.entries.map((entry) => {
    const matching = deviceTrials.filter(
      (trial) =>
        trial.device.matrixDeviceId === entry.deviceId && iosMajorOf(trial) === entry.iosMajor,
    );
    const matchingIds = matching.map((trial) => trial.trialId);
    const capabilities: CapabilityChecklistResult[] = COMPAT_CAPABILITIES.map((capability) => {
      const spec = specByCapability.get(capability);
      if (spec === undefined) {
        throw new Error(`generateCompatChecklist: no checklist spec for capability ${capability}`);
      }
      const cell = entry.capabilities[capability];
      if (cell.state !== "YELLOW") {
        for (const trialId of cell.evidenceTrialIds) {
          if (!matchingIds.includes(trialId)) {
            integrityFailures.push({
              deviceId: entry.deviceId,
              iosMajor: entry.iosMajor,
              capability,
              error: `${cell.state} cites trial "${trialId}" which is not a valid DEVICE_MEASUREMENT trial for ${entry.deviceId} on iOS ${entry.iosMajor}`,
            });
          }
        }
      }
      const measuredEvidenceTrialIds = matching
        .filter(
          (trial) =>
            spec.evidenceMetricPaths.length > 0 &&
            spec.evidenceMetricPaths.every((path) => metricAtPath(trial, path)?.measured === true),
        )
        .map((trial) => trial.trialId);
      let evidenceStatus: CapabilityEvidenceStatus;
      let blockedReason: string | null;
      if (matching.length === 0) {
        evidenceStatus = "BLOCKED_EXTERNAL_NO_DEVICE_TRIALS";
        blockedReason = `No DEVICE_MEASUREMENT trial exists for ${entry.deviceId} on iOS ${entry.iosMajor} (physical iPhone BLOCKED_EXTERNAL).`;
      } else if (spec.evidenceMetricPaths.length === 0) {
        evidenceStatus = "MANUAL_EVIDENCE_REQUIRED";
        blockedReason = `Capability "${capability}" has no per-trial metric; a human evidence note on a matching trial is required.`;
      } else if (measuredEvidenceTrialIds.length === 0) {
        evidenceStatus = "DEVICE_TRIALS_PRESENT_METRIC_UNMEASURED";
        blockedReason = `Matching device trials exist but none measured all of: ${spec.evidenceMetricPaths.join(", ")}.`;
      } else {
        evidenceStatus = "DEVICE_EVIDENCE_PRESENT";
        blockedReason = null;
      }
      return {
        capability,
        matrixState: cell.state,
        steps: spec.steps,
        evidenceMetricPaths: spec.evidenceMetricPaths,
        matchingDeviceTrialIds: matchingIds,
        measuredEvidenceTrialIds,
        evidenceStatus,
        blockedReason,
      };
    });
    return {
      deviceId: entry.deviceId,
      iosMajor: entry.iosMajor,
      matchingDeviceTrialCount: matching.length,
      capabilities,
    };
  });

  const notes: string[] = [];
  if (deviceTrials.length === 0) {
    notes.push(
      "No physical-iPhone evidence exists. Every capability cell is YELLOW/BLOCKED_EXTERNAL; nothing in this report may be quoted as a device validation.",
    );
  }
  if (sampleFixtureTrials > 0) {
    notes.push(
      `${sampleFixtureTrials} SAMPLE_FIXTURE_NOT_A_MEASUREMENT file(s) were read to exercise the pipeline and are EXCLUDED from all evidence above.`,
    );
  }
  if (integrityFailures.length > 0) {
    notes.push(
      `${integrityFailures.length} integrity failure(s): GREEN/RED cells citing evidence that does not resolve to real device trials.`,
    );
  }

  return {
    schemaVersion: COMPAT_CHECKLIST_REPORT_SCHEMA_VERSION,
    generatedAtIso: args.generatedAtIso,
    totals: {
      combinations: combinations.length,
      deviceMeasurementTrials: deviceTrials.length,
      sampleFixtureTrials,
      invalidFiles: invalidFiles.length,
    },
    invalidFiles,
    integrityFailures,
    combinations,
    notes,
  };
}
