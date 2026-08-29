/**
 * Device-matrix manifest contract (`pickle.iphone-device-matrix.v1`).
 *
 * The manifest (`tools/iphone-trials/device-matrix.json`) names the physical
 * iPhone tiers the E2E trial program must cover before GATE B evidence is
 * complete. No device in the manifest has been acquired: every entry carries
 * an explicit `acquisition.state`, and nothing downstream may count a tier as
 * covered until at least one DEVICE_MEASUREMENT trial references one of its
 * devices. The manifest is a coverage plan, never evidence.
 */

export const DEVICE_MATRIX_SCHEMA_VERSION = "pickle.iphone-device-matrix.v1" as const;

export const DEVICE_TIERS = ["older", "mid", "recent", "flagship"] as const;
export type DeviceTier = (typeof DEVICE_TIERS)[number];

export type DeviceAcquisitionState = "NOT_ACQUIRED" | "ACQUIRED";

export interface DeviceMatrixEntryV1 {
  /** Stable id trials reference (e.g. "iphone-se-3"). */
  deviceId: string;
  tier: DeviceTier;
  /** Apple model identifier, e.g. "iPhone14,6". */
  modelIdentifier: string;
  marketingName: string;
  /** Minimum iOS major version the trial script supports on this device. */
  minIosMajor: number;
  acquisition: {
    state: DeviceAcquisitionState;
    /** Required while NOT_ACQUIRED: why coverage is missing. */
    blockedReason: string | null;
  };
}

export interface DeviceMatrixV1 {
  schemaVersion: typeof DEVICE_MATRIX_SCHEMA_VERSION;
  /** Minimum number of distinct devices per tier for GATE B coverage. */
  requiredDevicesPerTier: number;
  devices: DeviceMatrixEntryV1[];
  notes: string[];
}

export function validateDeviceMatrix(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null) {
    return ["device matrix: not an object"];
  }
  const matrix = input as Partial<DeviceMatrixV1>;
  if (matrix.schemaVersion !== DEVICE_MATRIX_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion: expected "${DEVICE_MATRIX_SCHEMA_VERSION}", got ${JSON.stringify(matrix.schemaVersion)}`,
    );
  }
  if (
    typeof matrix.requiredDevicesPerTier !== "number" ||
    !Number.isInteger(matrix.requiredDevicesPerTier) ||
    matrix.requiredDevicesPerTier < 1
  ) {
    errors.push("requiredDevicesPerTier: not a positive integer");
  }
  if (!Array.isArray(matrix.notes)) {
    errors.push("notes: not an array");
  }
  if (!Array.isArray(matrix.devices)) {
    errors.push("devices: not an array");
    return errors;
  }
  const seenIds = new Set<string>();
  matrix.devices.forEach((entry, index) => {
    const at = `devices[${index}]`;
    if (typeof entry !== "object" || entry === null) {
      errors.push(`${at}: not an object`);
      return;
    }
    if (typeof entry.deviceId !== "string" || entry.deviceId.length === 0) {
      errors.push(`${at}.deviceId: not a nonempty string`);
    } else if (seenIds.has(entry.deviceId)) {
      errors.push(`${at}.deviceId: duplicate "${entry.deviceId}"`);
    } else {
      seenIds.add(entry.deviceId);
    }
    if (!DEVICE_TIERS.includes(entry.tier)) {
      errors.push(`${at}.tier: not one of ${DEVICE_TIERS.join("|")}`);
    }
    if (typeof entry.modelIdentifier !== "string" || entry.modelIdentifier.length === 0) {
      errors.push(`${at}.modelIdentifier: not a nonempty string`);
    }
    if (typeof entry.marketingName !== "string" || entry.marketingName.length === 0) {
      errors.push(`${at}.marketingName: not a nonempty string`);
    }
    if (
      typeof entry.minIosMajor !== "number" ||
      !Number.isInteger(entry.minIosMajor) ||
      entry.minIosMajor < 1
    ) {
      errors.push(`${at}.minIosMajor: not a positive integer`);
    }
    const acquisition = entry.acquisition;
    if (typeof acquisition !== "object" || acquisition === null) {
      errors.push(`${at}.acquisition: not an object`);
      return;
    }
    if (acquisition.state !== "NOT_ACQUIRED" && acquisition.state !== "ACQUIRED") {
      errors.push(`${at}.acquisition.state: not NOT_ACQUIRED|ACQUIRED`);
    }
    if (acquisition.state === "NOT_ACQUIRED") {
      if (typeof acquisition.blockedReason !== "string" || acquisition.blockedReason.length === 0) {
        errors.push(`${at}.acquisition.blockedReason: required nonempty while NOT_ACQUIRED`);
      }
    } else if (acquisition.blockedReason !== null) {
      errors.push(`${at}.acquisition.blockedReason: must be null when ACQUIRED`);
    }
  });
  for (const tier of DEVICE_TIERS) {
    if (!matrix.devices.some((entry) => entry?.tier === tier)) {
      errors.push(`devices: tier "${tier}" has no entries`);
    }
  }
  return errors;
}
