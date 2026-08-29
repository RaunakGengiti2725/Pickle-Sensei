/**
 * iOS compatibility matrix contract (`pickle.ios-compat-matrix.v1`).
 *
 * The matrix (`tools/iphone-trials/ios-compat-matrix.json`) records, per
 * supported device + iOS-major combination, a validation state for every
 * user-facing capability. Honesty rules (enforced by
 * `validateCompatMatrix`):
 * - A capability may be GREEN or RED ONLY with real device evidence: a
 *   nonempty list of DEVICE_MEASUREMENT trial ids plus a validation
 *   timestamp and note. No device evidence exists in this program, so every
 *   committed cell is YELLOW.
 * - Any newly admitted device/OS combination enters ALL-YELLOW
 *   (`admitDeviceOs`) and stays YELLOW until validated with device evidence.
 * - YELLOW cells must carry a nonempty reason (usually BLOCKED_EXTERNAL).
 * - Device ids must reference `device-matrix.json`; the matrix is a
 *   validation ledger, never evidence by itself.
 */

import { validateDeviceMatrix, type DeviceMatrixV1 } from "./deviceMatrix.js";

export const COMPAT_MATRIX_SCHEMA_VERSION = "pickle.ios-compat-matrix.v1" as const;

/** User-facing capabilities each device/OS combination must validate. */
export const COMPAT_CAPABILITIES = [
  "camera",
  "permissions",
  "frameTiming",
  "thermal",
  "memory",
  "modelRuntime",
  "envelope",
  "targetLock",
  "eventTrigger",
  "result",
  "tryAgain",
  "session",
  "import",
] as const;
export type CompatCapability = (typeof COMPAT_CAPABILITIES)[number];

/**
 * YELLOW = admitted but not validated with device evidence (the mandatory
 * entry state for every new device/OS); GREEN = validated working with
 * device evidence; RED = validated broken with device evidence.
 */
export const COMPAT_STATES = ["GREEN", "YELLOW", "RED"] as const;
export type CompatValidationState = (typeof COMPAT_STATES)[number];

export type CompatCapabilityCell =
  | {
      state: "YELLOW";
      /** Why validation is missing (e.g. BLOCKED_EXTERNAL: no device). */
      reason: string;
    }
  | {
      state: "GREEN" | "RED";
      /** DEVICE_MEASUREMENT trial ids backing the verdict. */
      evidenceTrialIds: string[];
      validatedAtIso: string;
      /** What was observed on the device (human-written). */
      evidenceNote: string;
    };

export interface CompatMatrixEntryV1 {
  /** Must match a deviceId in device-matrix.json. */
  deviceId: string;
  iosMajor: number;
  admittedAtIso: string;
  capabilities: Record<CompatCapability, CompatCapabilityCell>;
}

export interface CompatMatrixV1 {
  schemaVersion: typeof COMPAT_MATRIX_SCHEMA_VERSION;
  entries: CompatMatrixEntryV1[];
  notes: string[];
}

export const NEW_DEVICE_OS_YELLOW_REASON =
  "New device/OS combination admitted without device validation — enters YELLOW until validated with real device evidence (BLOCKED_EXTERNAL: no physical iPhone exists in this program).";

/**
 * The rule: a new device/OS combination enters the matrix ALL-YELLOW. There
 * is no code path that admits a combination at GREEN or RED.
 */
export function admitDeviceOs(args: {
  deviceId: string;
  iosMajor: number;
  admittedAtIso: string;
  reason?: string;
}): CompatMatrixEntryV1 {
  const reason = args.reason ?? NEW_DEVICE_OS_YELLOW_REASON;
  const capabilities = {} as Record<CompatCapability, CompatCapabilityCell>;
  for (const capability of COMPAT_CAPABILITIES) {
    capabilities[capability] = { state: "YELLOW", reason };
  }
  return {
    deviceId: args.deviceId,
    iosMajor: args.iosMajor,
    admittedAtIso: args.admittedAtIso,
    capabilities,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function validateCell(errors: string[], at: string, cell: unknown): void {
  if (typeof cell !== "object" || cell === null) {
    errors.push(`${at}: not an object`);
    return;
  }
  const c = cell as Partial<CompatCapabilityCell> & Record<string, unknown>;
  if (c.state === "YELLOW") {
    if (!isNonEmptyString(c.reason)) {
      errors.push(`${at}.reason: required nonempty while YELLOW`);
    }
    for (const forbidden of ["evidenceTrialIds", "validatedAtIso", "evidenceNote"]) {
      if (forbidden in c) {
        errors.push(`${at}.${forbidden}: must be absent while YELLOW`);
      }
    }
  } else if (c.state === "GREEN" || c.state === "RED") {
    if (
      !Array.isArray(c.evidenceTrialIds) ||
      c.evidenceTrialIds.length === 0 ||
      !c.evidenceTrialIds.every(isNonEmptyString)
    ) {
      errors.push(
        `${at}.evidenceTrialIds: ${c.state} requires a nonempty array of DEVICE_MEASUREMENT trial ids`,
      );
    }
    if (!isIsoTimestamp(c.validatedAtIso)) {
      errors.push(`${at}.validatedAtIso: ${c.state} requires a parseable ISO timestamp`);
    }
    if (!isNonEmptyString(c.evidenceNote)) {
      errors.push(`${at}.evidenceNote: ${c.state} requires a nonempty evidence note`);
    }
    if ("reason" in c) {
      errors.push(`${at}.reason: must be absent when ${c.state}`);
    }
  } else {
    errors.push(`${at}.state: not GREEN|YELLOW|RED`);
  }
}

export function validateCompatMatrix(input: unknown, deviceMatrix: unknown): string[] {
  const errors: string[] = [];
  const deviceMatrixErrors = validateDeviceMatrix(deviceMatrix);
  if (deviceMatrixErrors.length > 0) {
    return deviceMatrixErrors.map((e) => `device matrix: ${e}`);
  }
  const knownDeviceIds = new Set((deviceMatrix as DeviceMatrixV1).devices.map((d) => d.deviceId));

  if (typeof input !== "object" || input === null) {
    return ["compat matrix: not an object"];
  }
  const matrix = input as Partial<CompatMatrixV1>;
  if (matrix.schemaVersion !== COMPAT_MATRIX_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion: expected "${COMPAT_MATRIX_SCHEMA_VERSION}", got ${JSON.stringify(matrix.schemaVersion)}`,
    );
  }
  if (!Array.isArray(matrix.notes)) {
    errors.push("notes: not an array");
  }
  if (!Array.isArray(matrix.entries)) {
    errors.push("entries: not an array");
    return errors;
  }
  const seenCombos = new Set<string>();
  matrix.entries.forEach((entry, index) => {
    const at = `entries[${index}]`;
    if (typeof entry !== "object" || entry === null) {
      errors.push(`${at}: not an object`);
      return;
    }
    if (!isNonEmptyString(entry.deviceId)) {
      errors.push(`${at}.deviceId: not a nonempty string`);
    } else if (!knownDeviceIds.has(entry.deviceId)) {
      errors.push(
        `${at}.deviceId: "${entry.deviceId}" not in device-matrix.json — append the device to the manifest first`,
      );
    }
    if (
      typeof entry.iosMajor !== "number" ||
      !Number.isInteger(entry.iosMajor) ||
      entry.iosMajor < 1
    ) {
      errors.push(`${at}.iosMajor: not a positive integer`);
    }
    if (isNonEmptyString(entry.deviceId) && typeof entry.iosMajor === "number") {
      const combo = `${entry.deviceId}@ios${entry.iosMajor}`;
      if (seenCombos.has(combo)) {
        errors.push(`${at}: duplicate device/OS combination "${combo}"`);
      } else {
        seenCombos.add(combo);
      }
    }
    if (!isIsoTimestamp(entry.admittedAtIso)) {
      errors.push(`${at}.admittedAtIso: not a parseable ISO timestamp`);
    }
    const capabilities = entry.capabilities;
    if (typeof capabilities !== "object" || capabilities === null) {
      errors.push(`${at}.capabilities: not an object`);
      return;
    }
    for (const capability of COMPAT_CAPABILITIES) {
      if (!(capability in capabilities)) {
        errors.push(`${at}.capabilities.${capability}: missing — every capability must be tracked`);
        continue;
      }
      validateCell(errors, `${at}.capabilities.${capability}`, capabilities[capability]);
    }
    for (const key of Object.keys(capabilities)) {
      if (!COMPAT_CAPABILITIES.includes(key as CompatCapability)) {
        errors.push(`${at}.capabilities.${key}: unknown capability`);
      }
    }
  });
  return errors;
}
