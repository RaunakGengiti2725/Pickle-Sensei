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
export {
  measureClip,
  probeClipStream,
  extractSampledGrayFrames,
  meanLuma,
  laplacianVariance,
  meanAbsDiff,
  SAMPLE_FPS,
  SAMPLE_WIDTH,
  type ClipStreamInfo,
  type SampledGrayFrames,
  type MeasureWindow,
} from "./clipProbe.js";
export {
  G08_LABEL_SCHEMA_VERSION,
  G08_BYPASS_FAMILIES,
  G08_CAPTURE_LABELS,
  G08_DOWNSTREAM_OUTCOMES,
  validateG08LabelFile,
  type G08BypassFamily,
  type G08CaptureLabel,
  type G08DownstreamOutcome,
  type G08LabelRecord,
  type G08LabelFile,
  type G08ValidationResult,
} from "./g08LabelSchema.js";
export {
  G08_GATE_VERSION,
  G08_FROZEN_GATE_DOC_SHA256,
  G08_MINIMUM_EVIDENCE,
  G08_PROMOTION_CRITERIA,
  computeG08Metrics,
  computeG08MetricsByFamily,
  evidenceSufficient,
  evaluateG08Promotion,
  sha256OfFile,
  type G08EvalRow,
  type G08GateMetrics,
  type G08RateWithCounts,
  type G08PromotionVerdict,
} from "./g08Gate.js";
export {
  G08_SIGNALS_VERSION,
  computeBypassSignals,
  type G08BypassSignals,
} from "./g08EvidenceSignals.js";
