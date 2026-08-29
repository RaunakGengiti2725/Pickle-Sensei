/**
 * React-Native-safe entry: the pure evaluator + thresholds only. The main
 * index also exports the ffmpeg/ffprobe clip prober (node:child_process),
 * which cannot load in a mobile bundle — apps/mobile aliases
 * `@pickle/capture-envelope` to this file.
 */
export {
  evaluateCaptureEnvelope,
  classifyDimension,
  type CaptureEnvelopeMeasurements,
} from "./envelope.js";
export {
  CAPTURE_ENVELOPE_THRESHOLDS,
  CAPTURE_ENVELOPE_THRESHOLDS_PROVISIONAL,
  CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
  type DimensionThreshold,
  type EnvelopeBand,
} from "./thresholds.js";
