/**
 * First-class UI states (directive §10). Screens model these explicitly;
 * they are not ad-hoc booleans.
 */

export const SCREEN_STATES = [
  "INITIAL",
  "LOADING",
  "SUCCESS",
  "EMPTY",
  "ERROR",
  "RETRY",
  "OFFLINE",
  "UNAUTHORIZED",
  "AUTH_EXPIRED",
  "PERMISSION_DENIED",
  "PAYWALLED",
  "UNSUPPORTED_DEVICE",
  "MODEL_UNAVAILABLE",
  "LOW_CONFIDENCE",
  "CORRUPT_DATA",
] as const;
export type ScreenState = (typeof SCREEN_STATES)[number];

export const CAMERA_SETUP_STATES = [
  "READY",
  "NO_PLAYER",
  "BODY_CROPPED",
  "PLAYER_TOO_SMALL",
  "PLAYER_TOO_LARGE",
  "PADDLE_NOT_VISIBLE",
  "MULTIPLE_PEOPLE",
  "BAD_CAMERA_ANGLE",
  "LOW_LIGHT",
  "CAMERA_MOVED",
  "THERMAL_LIMIT",
  "BATTERY_LOW",
  "CAMERA_INTERRUPTED",
] as const;
export type CameraSetupState = (typeof CAMERA_SETUP_STATES)[number];

/** Live Court device capability tiers (spec pp. 36–37). */
export const DEVICE_TIERS = ["A", "B", "C"] as const;
export type DeviceTier = (typeof DEVICE_TIERS)[number];
