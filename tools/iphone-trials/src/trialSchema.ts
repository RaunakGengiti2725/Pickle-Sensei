/**
 * Per-trial contract for physical-iPhone E2E trials
 * (`pickle.iphone-trial.v1`).
 *
 * One trial = one scripted real-user pass on a physical iPhone: launch the
 * app, grant permissions, start the camera, acquire the target, perform real
 * strokes, let the pipeline analyze, interact with the Result, and Try Again.
 *
 * Honesty rules (enforced by `validateIphoneTrial`):
 * - `provenance` is required. Only `DEVICE_MEASUREMENT` trials may enter
 *   measured statistics; `SAMPLE_FIXTURE_NOT_A_MEASUREMENT` exists so the
 *   report pipeline can be exercised on Linux without a device and is never
 *   aggregated as evidence.
 * - Every metric is either measured (with a value) or explicitly unmeasured
 *   with a nonempty reason. Silent absence and fabricated zeros are schema
 *   violations.
 * - The primary latency metric (TRUE-MOVEMENT-COMPLETION -> RESULT-INTERACTIVE)
 *   requires a marker source: the movement-completion instant comes from a
 *   human frame-marking a reference recording, never from the app's own
 *   completion detector (which is part of the system under test).
 */

import { DEVICE_TIERS, type DeviceTier } from "./deviceMatrix.js";

export const IPHONE_TRIAL_SCHEMA_VERSION = "pickle.iphone-trial.v1" as const;

export type TrialProvenance = "DEVICE_MEASUREMENT" | "SAMPLE_FIXTURE_NOT_A_MEASUREMENT";

/** A metric value or an explicit, explained absence. */
export type Metric<T> =
  { measured: true; value: T } | { measured: false; unmeasuredReason: string };

export type ThermalState = "nominal" | "fair" | "serious" | "critical";
export type BatteryState = "unplugged" | "charging" | "full" | "unknown";
export type RunKind = "cold" | "warm";
export type HumanVerdict = "CORRECT" | "PARTIAL" | "WRONG";

export interface TrialDeviceContextV1 {
  /** Must match a deviceId in device-matrix.json. */
  matrixDeviceId: string;
  tier: DeviceTier;
  modelIdentifier: string;
  iosVersion: string;
  iosBuild: string;
}

export interface TrialAppContextV1 {
  appVersion: string;
  appBuild: string;
  gitCommit: string;
  /** Release vs Debug — Debug throttles differently and is disclosed. */
  buildConfiguration: "Release" | "Debug";
}

export interface TrialDeviceStateV1 {
  thermalStateStart: ThermalState;
  thermalStateEnd: ThermalState;
  batteryStartPct: number;
  batteryEndPct: number;
  batteryState: BatteryState;
  lowPowerModeEnabled: boolean;
  storageFreeBytes: number;
}

export interface TrialCameraSettingsV1 {
  resolution: string;
  requestedFps: number;
  lens: string;
  stabilizationEnabled: boolean;
  torchEnabled: boolean;
}

/**
 * Live contract/model versions running in the trial build (e.g.
 * "stroke-heuristic-lite": "stroke-heuristic-6"). Keys are subsystem names,
 * values are the exact version strings from the code.
 */
export type TrialModelVersionsV1 = Record<string, string>;

export interface TargetAcquisitionMetricsV1 {
  lockAchieved: boolean;
  /** Human-verified against the reference recording, not app-reported. */
  lockOnIntendedSubject: Metric<boolean>;
  timeToLockMs: Metric<number>;
  /** Fraction of post-lock frames (0..1) the lock persisted, human-verified. */
  lockPersistenceRatio: Metric<number>;
  identitySwitchCount: Metric<number>;
}

export interface EventDetectionMetricsV1 {
  /** Ground truth from the human-marked reference recording. */
  humanMarkedEventCount: Metric<number>;
  appProposedEventCount: Metric<number>;
  recalledEventCount: Metric<number>;
  falseProposalCount: Metric<number>;
  /** Mean temporal overlap ratio (0..1) of recalled events vs human bounds. */
  meanBoundaryOverlapRatio: Metric<number>;
}

export interface ContactTimingMetricsV1 {
  /** From human frame-marking of the reference recording. */
  humanMarkedContactMs: Metric<number>;
  appContactMs: Metric<number>;
  absErrorMs: Metric<number>;
  appAbstained: boolean;
}

export interface StrokeClassificationMetricsV1 {
  appLabel: Metric<string>;
  appConfidence: Metric<number>;
  /** Factual stroke identity (forehand/backhand/etc), human-verified from the reference recording. NOT a technique-quality judgment. */
  humanVerifiedLabel: Metric<string>;
  labelCorrect: Metric<boolean>;
  appAbstained: boolean;
}

export interface AdaptiveCompletionMetricsV1 {
  strategy: "fixed" | "adaptive";
  captureCompletionMs: Metric<number>;
  /** Human-verified: did completion cut off real movement? */
  prematureCutoff: Metric<boolean>;
}

export interface ClipCorrectnessMetricsV1 {
  clipsExpected: Metric<number>;
  clipsProduced: Metric<number>;
  /** Human-verified: clip bounds contain the marked event. */
  boundsVerdict: Metric<HumanVerdict>;
}

/**
 * The primary GATE B latency observation. `trueMovementCompletionAtMs` is the
 * instant the user's real movement finished, frame-marked by a human on the
 * synchronized reference recording; `resultInteractiveAtMs` is the instant the
 * Result surface accepted user input. Both on the same trial clock.
 */
export interface PrimaryLatencyObservationV1 {
  runKind: RunKind;
  trueMovementCompletionAtMs: number;
  resultInteractiveAtMs: number;
  latencyMs: number;
  markerSource: "HUMAN_FRAME_MARKED_REFERENCE_RECORDING";
}

export interface AnalysisLatencyMetricsV1 {
  primary: Metric<PrimaryLatencyObservationV1>;
  /** App-internal analysis wall time (request -> result payload), secondary. */
  analysisRequestToResultMs: Metric<number>;
}

export interface StabilityMetricsV1 {
  crashed: boolean;
  crashReportRef: string | null;
  peakMemoryFootprintBytes: Metric<number>;
  timeToThermalSeriousMs: Metric<number>;
  batteryDrainPct: Metric<number>;
}

export interface IphoneTrialMetricsV1 {
  appLaunchToInteractiveMs: Metric<number>;
  permissionFlow: Metric<{
    promptsShown: string[];
    allGranted: boolean;
    flowMs: number;
  }>;
  cameraStartToFirstFrameMs: Metric<number>;
  captureFps: Metric<{
    meanFps: number;
    minFps: number;
    droppedFrameRatio: number;
  }>;
  targetAcquisition: TargetAcquisitionMetricsV1;
  strokeTrigger: Metric<{
    triggered: boolean;
    triggerLatencyMs: number | null;
    falseTriggerCount: number;
  }>;
  eventDetection: EventDetectionMetricsV1;
  paddleTrackingVerdict: Metric<HumanVerdict>;
  ballTrackingVerdict: Metric<HumanVerdict>;
  contactTiming: ContactTimingMetricsV1;
  phaseValidity: Metric<{
    orderingValid: boolean;
    humanVerdict: HumanVerdict;
  }>;
  strokeClassification: StrokeClassificationMetricsV1;
  autoDetectQuality: Metric<{
    falseStarts: number;
    missedStrokes: number;
    humanVerdict: HumanVerdict;
  }>;
  adaptiveCompletion: AdaptiveCompletionMetricsV1;
  clipCorrectness: ClipCorrectnessMetricsV1;
  analysisLatency: AnalysisLatencyMetricsV1;
  resultCorrectness: Metric<{
    renderedWithoutError: boolean;
    /** Every rendered field traces to real evidence (f26 audit rules). */
    evidenceProvenanceHonest: boolean;
    humanVerdict: HumanVerdict;
  }>;
  resultRenderMs: Metric<number>;
  tryAgain: Metric<{
    attempted: boolean;
    returnedToCaptureMs: number | null;
    stateResetCorrect: boolean;
  }>;
  stability: StabilityMetricsV1;
}

export interface IphoneTrialV1 {
  schemaVersion: typeof IPHONE_TRIAL_SCHEMA_VERSION;
  trialId: string;
  capturedAtIso: string;
  provenance: TrialProvenance;
  operator: string;
  device: TrialDeviceContextV1;
  app: TrialAppContextV1;
  deviceState: TrialDeviceStateV1;
  cameraSettings: TrialCameraSettingsV1;
  modelVersions: TrialModelVersionsV1;
  /** Path/URI of the synchronized reference recording used for human marking. */
  referenceRecordingRef: Metric<string>;
  metrics: IphoneTrialMetricsV1;
  notes: string[];
}

const HUMAN_VERDICTS: ReadonlySet<string> = new Set(["CORRECT", "PARTIAL", "WRONG"]);
const THERMAL_STATES: ReadonlySet<string> = new Set(["nominal", "fair", "serious", "critical"]);
const BATTERY_STATES: ReadonlySet<string> = new Set(["unplugged", "charging", "full", "unknown"]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

type MetricCheck = (value: unknown, at: string, errors: string[]) => void;

function validateMetric(
  errors: string[],
  at: string,
  metric: unknown,
  checkValue: MetricCheck,
): void {
  if (typeof metric !== "object" || metric === null) {
    errors.push(`${at}: not an object`);
    return;
  }
  const m = metric as { measured?: unknown } & Record<string, unknown>;
  if (m.measured === true) {
    if (!("value" in m)) {
      errors.push(`${at}.value: missing on a measured metric`);
      return;
    }
    if ("unmeasuredReason" in m) {
      errors.push(`${at}.unmeasuredReason: must be absent when measured`);
    }
    checkValue(m.value, `${at}.value`, errors);
  } else if (m.measured === false) {
    if (!isNonEmptyString(m.unmeasuredReason)) {
      errors.push(`${at}.unmeasuredReason: required nonempty when unmeasured`);
    }
    if ("value" in m) {
      errors.push(`${at}.value: must be absent when unmeasured`);
    }
  } else {
    errors.push(`${at}.measured: not a boolean`);
  }
}

const numberCheck: MetricCheck = (value, at, errors) => {
  if (!isFiniteNumber(value)) errors.push(`${at}: not a finite number`);
};
const nonNegativeCheck: MetricCheck = (value, at, errors) => {
  if (!isFiniteNumber(value) || value < 0) {
    errors.push(`${at}: not a finite non-negative number`);
  }
};
const ratioCheck: MetricCheck = (value, at, errors) => {
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    errors.push(`${at}: not in [0, 1]`);
  }
};
const booleanCheck: MetricCheck = (value, at, errors) => {
  if (typeof value !== "boolean") errors.push(`${at}: not a boolean`);
};
const stringCheck: MetricCheck = (value, at, errors) => {
  if (!isNonEmptyString(value)) errors.push(`${at}: not a nonempty string`);
};
const verdictCheck: MetricCheck = (value, at, errors) => {
  if (typeof value !== "string" || !HUMAN_VERDICTS.has(value)) {
    errors.push(`${at}: not CORRECT|PARTIAL|WRONG`);
  }
};

const primaryLatencyCheck: MetricCheck = (value, at, errors) => {
  if (typeof value !== "object" || value === null) {
    errors.push(`${at}: not an object`);
    return;
  }
  const obs = value as Partial<PrimaryLatencyObservationV1>;
  if (obs.runKind !== "cold" && obs.runKind !== "warm") {
    errors.push(`${at}.runKind: not cold|warm`);
  }
  if (obs.markerSource !== "HUMAN_FRAME_MARKED_REFERENCE_RECORDING") {
    errors.push(
      `${at}.markerSource: must be HUMAN_FRAME_MARKED_REFERENCE_RECORDING (the app's own completion detector is under test and may not mark its own ground truth)`,
    );
  }
  if (!isFiniteNumber(obs.trueMovementCompletionAtMs) || obs.trueMovementCompletionAtMs < 0) {
    errors.push(`${at}.trueMovementCompletionAtMs: not finite non-negative`);
  }
  if (!isFiniteNumber(obs.resultInteractiveAtMs) || obs.resultInteractiveAtMs < 0) {
    errors.push(`${at}.resultInteractiveAtMs: not finite non-negative`);
  }
  if (!isFiniteNumber(obs.latencyMs)) {
    errors.push(`${at}.latencyMs: not a finite number`);
  } else if (
    isFiniteNumber(obs.trueMovementCompletionAtMs) &&
    isFiniteNumber(obs.resultInteractiveAtMs)
  ) {
    const derived = obs.resultInteractiveAtMs - obs.trueMovementCompletionAtMs;
    if (Math.abs(derived - obs.latencyMs) > 1e-6) {
      errors.push(
        `${at}.latencyMs: ${obs.latencyMs} != resultInteractiveAtMs - trueMovementCompletionAtMs (${derived})`,
      );
    }
    if (derived < 0) {
      errors.push(`${at}: resultInteractiveAtMs precedes movement completion`);
    }
  }
};

export function validateIphoneTrial(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null) {
    return ["trial: not an object"];
  }
  const trial = input as Partial<IphoneTrialV1>;
  if (trial.schemaVersion !== IPHONE_TRIAL_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion: expected "${IPHONE_TRIAL_SCHEMA_VERSION}", got ${JSON.stringify(trial.schemaVersion)}`,
    );
  }
  if (!isNonEmptyString(trial.trialId)) {
    errors.push("trialId: not a nonempty string");
  }
  if (!isNonEmptyString(trial.capturedAtIso) || Number.isNaN(Date.parse(trial.capturedAtIso))) {
    errors.push("capturedAtIso: not a parseable ISO timestamp");
  }
  if (
    trial.provenance !== "DEVICE_MEASUREMENT" &&
    trial.provenance !== "SAMPLE_FIXTURE_NOT_A_MEASUREMENT"
  ) {
    errors.push("provenance: not DEVICE_MEASUREMENT|SAMPLE_FIXTURE_NOT_A_MEASUREMENT");
  }
  if (!isNonEmptyString(trial.operator)) {
    errors.push("operator: not a nonempty string");
  }
  if (!Array.isArray(trial.notes)) {
    errors.push("notes: not an array");
  }

  const device = trial.device;
  if (typeof device !== "object" || device === null) {
    errors.push("device: not an object");
  } else {
    if (!isNonEmptyString(device.matrixDeviceId)) {
      errors.push("device.matrixDeviceId: not a nonempty string");
    }
    if (!DEVICE_TIERS.includes(device.tier as DeviceTier)) {
      errors.push(`device.tier: not one of ${DEVICE_TIERS.join("|")}`);
    }
    if (!isNonEmptyString(device.modelIdentifier)) {
      errors.push("device.modelIdentifier: not a nonempty string");
    }
    if (!isNonEmptyString(device.iosVersion)) {
      errors.push("device.iosVersion: not a nonempty string");
    }
    if (!isNonEmptyString(device.iosBuild)) {
      errors.push("device.iosBuild: not a nonempty string");
    }
  }

  const app = trial.app;
  if (typeof app !== "object" || app === null) {
    errors.push("app: not an object");
  } else {
    if (!isNonEmptyString(app.appVersion)) {
      errors.push("app.appVersion: not a nonempty string");
    }
    if (!isNonEmptyString(app.appBuild)) {
      errors.push("app.appBuild: not a nonempty string");
    }
    if (!isNonEmptyString(app.gitCommit)) {
      errors.push("app.gitCommit: not a nonempty string");
    }
    if (app.buildConfiguration !== "Release" && app.buildConfiguration !== "Debug") {
      errors.push("app.buildConfiguration: not Release|Debug");
    }
  }

  const state = trial.deviceState;
  if (typeof state !== "object" || state === null) {
    errors.push("deviceState: not an object");
  } else {
    for (const key of ["thermalStateStart", "thermalStateEnd"] as const) {
      if (typeof state[key] !== "string" || !THERMAL_STATES.has(state[key] as string)) {
        errors.push(`deviceState.${key}: not nominal|fair|serious|critical`);
      }
    }
    for (const key of ["batteryStartPct", "batteryEndPct"] as const) {
      const v = state[key];
      if (!isFiniteNumber(v) || v < 0 || v > 100) {
        errors.push(`deviceState.${key}: not in [0, 100]`);
      }
    }
    if (typeof state.batteryState !== "string" || !BATTERY_STATES.has(state.batteryState)) {
      errors.push("deviceState.batteryState: not unplugged|charging|full|unknown");
    }
    if (typeof state.lowPowerModeEnabled !== "boolean") {
      errors.push("deviceState.lowPowerModeEnabled: not a boolean");
    }
    if (!isFiniteNumber(state.storageFreeBytes) || state.storageFreeBytes < 0) {
      errors.push("deviceState.storageFreeBytes: not finite non-negative");
    }
  }

  const camera = trial.cameraSettings;
  if (typeof camera !== "object" || camera === null) {
    errors.push("cameraSettings: not an object");
  } else {
    if (!isNonEmptyString(camera.resolution)) {
      errors.push("cameraSettings.resolution: not a nonempty string");
    }
    if (!isFiniteNumber(camera.requestedFps) || camera.requestedFps <= 0) {
      errors.push("cameraSettings.requestedFps: not a positive number");
    }
    if (!isNonEmptyString(camera.lens)) {
      errors.push("cameraSettings.lens: not a nonempty string");
    }
    if (typeof camera.stabilizationEnabled !== "boolean") {
      errors.push("cameraSettings.stabilizationEnabled: not a boolean");
    }
    if (typeof camera.torchEnabled !== "boolean") {
      errors.push("cameraSettings.torchEnabled: not a boolean");
    }
  }

  const versions = trial.modelVersions;
  if (typeof versions !== "object" || versions === null) {
    errors.push("modelVersions: not an object");
  } else {
    const entries = Object.entries(versions);
    if (entries.length === 0) {
      errors.push("modelVersions: empty — record the live contract versions in the trial build");
    }
    for (const [key, value] of entries) {
      if (!isNonEmptyString(value)) {
        errors.push(`modelVersions["${key}"]: not a nonempty string`);
      }
    }
  }

  validateMetric(errors, "referenceRecordingRef", trial.referenceRecordingRef, stringCheck);

  const metrics = trial.metrics;
  if (typeof metrics !== "object" || metrics === null) {
    errors.push("metrics: not an object");
    return errors;
  }

  validateMetric(
    errors,
    "metrics.appLaunchToInteractiveMs",
    metrics.appLaunchToInteractiveMs,
    nonNegativeCheck,
  );
  validateMetric(errors, "metrics.permissionFlow", metrics.permissionFlow, (value, at, errs) => {
    if (typeof value !== "object" || value === null) {
      errs.push(`${at}: not an object`);
      return;
    }
    const v = value as {
      promptsShown?: unknown;
      allGranted?: unknown;
      flowMs?: unknown;
    };
    if (!Array.isArray(v.promptsShown) || !v.promptsShown.every(isNonEmptyString)) {
      errs.push(`${at}.promptsShown: not an array of nonempty strings`);
    }
    if (typeof v.allGranted !== "boolean") {
      errs.push(`${at}.allGranted: not a boolean`);
    }
    if (!isFiniteNumber(v.flowMs) || v.flowMs < 0) {
      errs.push(`${at}.flowMs: not finite non-negative`);
    }
  });
  validateMetric(
    errors,
    "metrics.cameraStartToFirstFrameMs",
    metrics.cameraStartToFirstFrameMs,
    nonNegativeCheck,
  );
  validateMetric(errors, "metrics.captureFps", metrics.captureFps, (value, at, errs) => {
    if (typeof value !== "object" || value === null) {
      errs.push(`${at}: not an object`);
      return;
    }
    const v = value as {
      meanFps?: unknown;
      minFps?: unknown;
      droppedFrameRatio?: unknown;
    };
    if (!isFiniteNumber(v.meanFps) || v.meanFps < 0) {
      errs.push(`${at}.meanFps: not finite non-negative`);
    }
    if (!isFiniteNumber(v.minFps) || v.minFps < 0) {
      errs.push(`${at}.minFps: not finite non-negative`);
    }
    if (
      !isFiniteNumber(v.droppedFrameRatio) ||
      v.droppedFrameRatio < 0 ||
      v.droppedFrameRatio > 1
    ) {
      errs.push(`${at}.droppedFrameRatio: not in [0, 1]`);
    }
  });

  const ta = metrics.targetAcquisition;
  if (typeof ta !== "object" || ta === null) {
    errors.push("metrics.targetAcquisition: not an object");
  } else {
    if (typeof ta.lockAchieved !== "boolean") {
      errors.push("metrics.targetAcquisition.lockAchieved: not a boolean");
    }
    validateMetric(
      errors,
      "metrics.targetAcquisition.lockOnIntendedSubject",
      ta.lockOnIntendedSubject,
      booleanCheck,
    );
    validateMetric(
      errors,
      "metrics.targetAcquisition.timeToLockMs",
      ta.timeToLockMs,
      nonNegativeCheck,
    );
    validateMetric(
      errors,
      "metrics.targetAcquisition.lockPersistenceRatio",
      ta.lockPersistenceRatio,
      ratioCheck,
    );
    validateMetric(
      errors,
      "metrics.targetAcquisition.identitySwitchCount",
      ta.identitySwitchCount,
      nonNegativeCheck,
    );
  }

  validateMetric(errors, "metrics.strokeTrigger", metrics.strokeTrigger, (value, at, errs) => {
    if (typeof value !== "object" || value === null) {
      errs.push(`${at}: not an object`);
      return;
    }
    const v = value as {
      triggered?: unknown;
      triggerLatencyMs?: unknown;
      falseTriggerCount?: unknown;
    };
    if (typeof v.triggered !== "boolean") {
      errs.push(`${at}.triggered: not a boolean`);
    }
    if (
      v.triggerLatencyMs !== null &&
      (!isFiniteNumber(v.triggerLatencyMs) || v.triggerLatencyMs < 0)
    ) {
      errs.push(`${at}.triggerLatencyMs: not null or finite non-negative`);
    }
    if (!isFiniteNumber(v.falseTriggerCount) || v.falseTriggerCount < 0) {
      errs.push(`${at}.falseTriggerCount: not finite non-negative`);
    }
  });

  const ev = metrics.eventDetection;
  if (typeof ev !== "object" || ev === null) {
    errors.push("metrics.eventDetection: not an object");
  } else {
    validateMetric(
      errors,
      "metrics.eventDetection.humanMarkedEventCount",
      ev.humanMarkedEventCount,
      nonNegativeCheck,
    );
    validateMetric(
      errors,
      "metrics.eventDetection.appProposedEventCount",
      ev.appProposedEventCount,
      nonNegativeCheck,
    );
    validateMetric(
      errors,
      "metrics.eventDetection.recalledEventCount",
      ev.recalledEventCount,
      nonNegativeCheck,
    );
    validateMetric(
      errors,
      "metrics.eventDetection.falseProposalCount",
      ev.falseProposalCount,
      nonNegativeCheck,
    );
    validateMetric(
      errors,
      "metrics.eventDetection.meanBoundaryOverlapRatio",
      ev.meanBoundaryOverlapRatio,
      ratioCheck,
    );
  }

  validateMetric(
    errors,
    "metrics.paddleTrackingVerdict",
    metrics.paddleTrackingVerdict,
    verdictCheck,
  );
  validateMetric(errors, "metrics.ballTrackingVerdict", metrics.ballTrackingVerdict, verdictCheck);

  const contact = metrics.contactTiming;
  if (typeof contact !== "object" || contact === null) {
    errors.push("metrics.contactTiming: not an object");
  } else {
    validateMetric(
      errors,
      "metrics.contactTiming.humanMarkedContactMs",
      contact.humanMarkedContactMs,
      nonNegativeCheck,
    );
    validateMetric(
      errors,
      "metrics.contactTiming.appContactMs",
      contact.appContactMs,
      nonNegativeCheck,
    );
    validateMetric(
      errors,
      "metrics.contactTiming.absErrorMs",
      contact.absErrorMs,
      nonNegativeCheck,
    );
    if (typeof contact.appAbstained !== "boolean") {
      errors.push("metrics.contactTiming.appAbstained: not a boolean");
    }
  }

  validateMetric(errors, "metrics.phaseValidity", metrics.phaseValidity, (value, at, errs) => {
    if (typeof value !== "object" || value === null) {
      errs.push(`${at}: not an object`);
      return;
    }
    const v = value as { orderingValid?: unknown; humanVerdict?: unknown };
    if (typeof v.orderingValid !== "boolean") {
      errs.push(`${at}.orderingValid: not a boolean`);
    }
    verdictCheck(v.humanVerdict, `${at}.humanVerdict`, errs);
  });

  const stroke = metrics.strokeClassification;
  if (typeof stroke !== "object" || stroke === null) {
    errors.push("metrics.strokeClassification: not an object");
  } else {
    validateMetric(errors, "metrics.strokeClassification.appLabel", stroke.appLabel, stringCheck);
    validateMetric(
      errors,
      "metrics.strokeClassification.appConfidence",
      stroke.appConfidence,
      ratioCheck,
    );
    validateMetric(
      errors,
      "metrics.strokeClassification.humanVerifiedLabel",
      stroke.humanVerifiedLabel,
      stringCheck,
    );
    validateMetric(
      errors,
      "metrics.strokeClassification.labelCorrect",
      stroke.labelCorrect,
      booleanCheck,
    );
    if (typeof stroke.appAbstained !== "boolean") {
      errors.push("metrics.strokeClassification.appAbstained: not a boolean");
    }
  }

  validateMetric(
    errors,
    "metrics.autoDetectQuality",
    metrics.autoDetectQuality,
    (value, at, errs) => {
      if (typeof value !== "object" || value === null) {
        errs.push(`${at}: not an object`);
        return;
      }
      const v = value as {
        falseStarts?: unknown;
        missedStrokes?: unknown;
        humanVerdict?: unknown;
      };
      if (!isFiniteNumber(v.falseStarts) || v.falseStarts < 0) {
        errs.push(`${at}.falseStarts: not finite non-negative`);
      }
      if (!isFiniteNumber(v.missedStrokes) || v.missedStrokes < 0) {
        errs.push(`${at}.missedStrokes: not finite non-negative`);
      }
      verdictCheck(v.humanVerdict, `${at}.humanVerdict`, errs);
    },
  );

  const adaptive = metrics.adaptiveCompletion;
  if (typeof adaptive !== "object" || adaptive === null) {
    errors.push("metrics.adaptiveCompletion: not an object");
  } else {
    if (adaptive.strategy !== "fixed" && adaptive.strategy !== "adaptive") {
      errors.push("metrics.adaptiveCompletion.strategy: not fixed|adaptive");
    }
    validateMetric(
      errors,
      "metrics.adaptiveCompletion.captureCompletionMs",
      adaptive.captureCompletionMs,
      nonNegativeCheck,
    );
    validateMetric(
      errors,
      "metrics.adaptiveCompletion.prematureCutoff",
      adaptive.prematureCutoff,
      booleanCheck,
    );
  }

  const clips = metrics.clipCorrectness;
  if (typeof clips !== "object" || clips === null) {
    errors.push("metrics.clipCorrectness: not an object");
  } else {
    validateMetric(
      errors,
      "metrics.clipCorrectness.clipsExpected",
      clips.clipsExpected,
      nonNegativeCheck,
    );
    validateMetric(
      errors,
      "metrics.clipCorrectness.clipsProduced",
      clips.clipsProduced,
      nonNegativeCheck,
    );
    validateMetric(
      errors,
      "metrics.clipCorrectness.boundsVerdict",
      clips.boundsVerdict,
      verdictCheck,
    );
  }

  const latency = metrics.analysisLatency;
  if (typeof latency !== "object" || latency === null) {
    errors.push("metrics.analysisLatency: not an object");
  } else {
    validateMetric(errors, "metrics.analysisLatency.primary", latency.primary, primaryLatencyCheck);
    validateMetric(
      errors,
      "metrics.analysisLatency.analysisRequestToResultMs",
      latency.analysisRequestToResultMs,
      nonNegativeCheck,
    );
  }

  validateMetric(
    errors,
    "metrics.resultCorrectness",
    metrics.resultCorrectness,
    (value, at, errs) => {
      if (typeof value !== "object" || value === null) {
        errs.push(`${at}: not an object`);
        return;
      }
      const v = value as {
        renderedWithoutError?: unknown;
        evidenceProvenanceHonest?: unknown;
        humanVerdict?: unknown;
      };
      if (typeof v.renderedWithoutError !== "boolean") {
        errs.push(`${at}.renderedWithoutError: not a boolean`);
      }
      if (typeof v.evidenceProvenanceHonest !== "boolean") {
        errs.push(`${at}.evidenceProvenanceHonest: not a boolean`);
      }
      verdictCheck(v.humanVerdict, `${at}.humanVerdict`, errs);
    },
  );
  validateMetric(errors, "metrics.resultRenderMs", metrics.resultRenderMs, nonNegativeCheck);
  validateMetric(errors, "metrics.tryAgain", metrics.tryAgain, (value, at, errs) => {
    if (typeof value !== "object" || value === null) {
      errs.push(`${at}: not an object`);
      return;
    }
    const v = value as {
      attempted?: unknown;
      returnedToCaptureMs?: unknown;
      stateResetCorrect?: unknown;
    };
    if (typeof v.attempted !== "boolean") {
      errs.push(`${at}.attempted: not a boolean`);
    }
    if (
      v.returnedToCaptureMs !== null &&
      (!isFiniteNumber(v.returnedToCaptureMs) || v.returnedToCaptureMs < 0)
    ) {
      errs.push(`${at}.returnedToCaptureMs: not null or finite non-negative`);
    }
    if (typeof v.stateResetCorrect !== "boolean") {
      errs.push(`${at}.stateResetCorrect: not a boolean`);
    }
  });

  const stability = metrics.stability;
  if (typeof stability !== "object" || stability === null) {
    errors.push("metrics.stability: not an object");
  } else {
    if (typeof stability.crashed !== "boolean") {
      errors.push("metrics.stability.crashed: not a boolean");
    }
    if (stability.crashReportRef !== null && !isNonEmptyString(stability.crashReportRef)) {
      errors.push("metrics.stability.crashReportRef: not null or nonempty string");
    }
    if (stability.crashed === true && stability.crashReportRef === null) {
      errors.push("metrics.stability.crashReportRef: required when crashed is true");
    }
    validateMetric(
      errors,
      "metrics.stability.peakMemoryFootprintBytes",
      stability.peakMemoryFootprintBytes,
      nonNegativeCheck,
    );
    validateMetric(
      errors,
      "metrics.stability.timeToThermalSeriousMs",
      stability.timeToThermalSeriousMs,
      nonNegativeCheck,
    );
    validateMetric(
      errors,
      "metrics.stability.batteryDrainPct",
      stability.batteryDrainPct,
      numberCheck,
    );
  }

  return errors;
}
