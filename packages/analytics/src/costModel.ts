/**
 * Cost accounting for stroke analysis — a deterministic, assumption-explicit
 * cost model decomposed by infrastructure component.
 *
 * Rules encoded here rather than in review comments:
 * - Every dollar figure is an ESTIMATE derived from an explicit rate card;
 *   each rate carries its provenance ("public_list_price_estimate" or
 *   "assumption") and a source string, so no number can pretend to be a
 *   measured invoice.
 * - Arithmetic is deterministic: costs are computed as integer micro-USD
 *   (rounded half-up per component) so the same inputs always produce the
 *   exact same output, with no clock, randomness, or environment dependence.
 * - Optimization suggestions are drawn from a closed catalog in which every
 *   entry preserves core analysis correctness. Suggestions that would trade
 *   accuracy, recall, gate strictness, or abstention honesty for cost are
 *   structurally unrepresentable (`preservesCoreCorrectness` is `true` by
 *   type) and the catalog is guarded by tests.
 */

export const COST_COMPONENTS = [
  "device_compute",
  "server_cpu",
  "server_gpu",
  "storage",
  "bandwidth",
  "media_processing",
  "coach_review",
] as const;

export type CostComponent = (typeof COST_COMPONENTS)[number];

/** Unit each component's quantity is expressed in. */
export const COST_COMPONENT_UNITS: Readonly<Record<CostComponent, string>> = {
  device_compute: "device-cpu-ms",
  server_cpu: "server-cpu-ms",
  server_gpu: "server-gpu-ms",
  storage: "byte-months",
  bandwidth: "bytes-transferred",
  media_processing: "server-cpu-ms",
  coach_review: "coach-review-minutes",
};

export type RateProvenance = "public_list_price_estimate" | "assumption" | "not_applicable";

export interface ComponentRate {
  /** USD per one unit of the component (see COST_COMPONENT_UNITS). */
  usdPerUnit: number;
  provenance: RateProvenance;
  /** Where the rate came from — a citation, not a justification. */
  source: string;
}

export type RateCard = Readonly<Record<CostComponent, ComponentRate>>;

/**
 * Default rate card. All values are ESTIMATES from public cloud list prices
 * (as commonly published in 2025–2026) or explicit assumptions — none are
 * measured invoices or negotiated prices.
 */
export const DEFAULT_RATE_CARD: RateCard = {
  device_compute: {
    // The user's own phone does the on-device work; the operator pays $0
    // marginal. Battery/energy cost is borne by the user and is tracked as a
    // quantity (device-cpu-ms) so it is visible, not billed.
    usdPerUnit: 0,
    provenance: "not_applicable",
    source: "On-device compute runs on user hardware; zero marginal operator cost.",
  },
  server_cpu: {
    // ~$0.04 per vCPU-hour (typical public-cloud on-demand vCPU list price).
    usdPerUnit: 0.04 / 3_600_000,
    provenance: "public_list_price_estimate",
    source: "≈$0.04/vCPU-hour public cloud on-demand list price, converted to per-ms.",
  },
  server_gpu: {
    // ~$0.53 per GPU-hour (entry inference GPU, e.g. NVIDIA T4 on-demand).
    usdPerUnit: 0.53 / 3_600_000,
    provenance: "public_list_price_estimate",
    source: "≈$0.53/GPU-hour (T4-class inference GPU) public list price, converted to per-ms.",
  },
  storage: {
    // ~$0.023 per GB-month object storage.
    usdPerUnit: 0.023 / 1_073_741_824,
    provenance: "public_list_price_estimate",
    source: "≈$0.023/GB-month object storage list price, converted to per-byte-month.",
  },
  bandwidth: {
    // ~$0.09 per GB egress.
    usdPerUnit: 0.09 / 1_073_741_824,
    provenance: "public_list_price_estimate",
    source: "≈$0.09/GB internet egress list price, converted to per-byte.",
  },
  media_processing: {
    // Media processing (decode / frame extraction / transcode) is server CPU
    // time, priced at the same vCPU rate but tracked separately so its share
    // of cost stays visible.
    usdPerUnit: 0.04 / 3_600_000,
    provenance: "public_list_price_estimate",
    source: "Same ≈$0.04/vCPU-hour rate as server_cpu; separated for attribution.",
  },
  coach_review: {
    // ASSUMPTION: $60/hour blended human-coach cost => $1.00 per minute.
    usdPerUnit: 1.0,
    provenance: "assumption",
    source: "ASSUMPTION: $60/hour blended coach compensation; no real payroll data.",
  },
};

/** Quantities consumed, in each component's unit (COST_COMPONENT_UNITS). */
export type UsageQuantities = Readonly<Record<CostComponent, number>>;

export const ZERO_USAGE: UsageQuantities = {
  device_compute: 0,
  server_cpu: 0,
  server_gpu: 0,
  storage: 0,
  bandwidth: 0,
  media_processing: 0,
  coach_review: 0,
};

export interface ComponentCost {
  component: CostComponent;
  unit: string;
  quantity: number;
  usdPerUnit: number;
  provenance: RateProvenance;
  /** Integer micro-USD (1e-6 USD), rounded half-up. */
  microUsd: number;
}

export interface CostBreakdown {
  components: ComponentCost[];
  /** Sum of integer component costs — exact, no floating-point drift. */
  totalMicroUsd: number;
  /** Human-readable USD string derived from totalMicroUsd. */
  totalUsdFormatted: string;
}

function roundMicroUsd(usd: number): number {
  return Math.round(usd * 1_000_000);
}

export function formatMicroUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(6)}`;
}

/**
 * Deterministic cost calculator: quantities × rate card → integer micro-USD
 * per component, summed exactly. Negative or non-finite quantities are
 * programming errors and throw rather than producing a plausible number.
 */
export function computeCost(usage: UsageQuantities, rateCard: RateCard): CostBreakdown {
  const components: ComponentCost[] = COST_COMPONENTS.map((component) => {
    const quantity = usage[component];
    if (!Number.isFinite(quantity) || quantity < 0) {
      throw new Error(`cost_model.invalid_quantity: ${component}=${String(quantity)}`);
    }
    const rate = rateCard[component];
    return {
      component,
      unit: COST_COMPONENT_UNITS[component],
      quantity,
      usdPerUnit: rate.usdPerUnit,
      provenance: rate.provenance,
      microUsd: roundMicroUsd(quantity * rate.usdPerUnit),
    };
  });
  const totalMicroUsd = components.reduce((sum, c) => sum + c.microUsd, 0);
  return { components, totalMicroUsd, totalUsdFormatted: formatMicroUsd(totalMicroUsd) };
}

/** Element-wise sum of usage quantities. */
export function addUsage(...usages: UsageQuantities[]): UsageQuantities {
  const out: Record<CostComponent, number> = { ...ZERO_USAGE };
  for (const usage of usages) {
    for (const component of COST_COMPONENTS) out[component] += usage[component];
  }
  return out;
}

/** Element-wise scaling of usage quantities (e.g. strokes per session). */
export function scaleUsage(usage: UsageQuantities, factor: number): UsageQuantities {
  if (!Number.isFinite(factor) || factor < 0) {
    throw new Error(`cost_model.invalid_scale_factor: ${String(factor)}`);
  }
  const out: Record<CostComponent, number> = { ...ZERO_USAGE };
  for (const component of COST_COMPONENTS) out[component] = usage[component] * factor;
  return out;
}

/**
 * Optimization suggestions. `preservesCoreCorrectness` is the literal type
 * `true`: a suggestion that trades analysis correctness for cost cannot be
 * expressed in this catalog.
 */
export interface CostOptimizationSuggestion {
  id: string;
  targetComponent: CostComponent;
  suggestion: string;
  preservesCoreCorrectness: true;
  rationale: string;
}

export const COST_OPTIMIZATION_CATALOG: readonly CostOptimizationSuggestion[] = [
  {
    id: "storage-lifecycle-tiering",
    targetComponent: "storage",
    suggestion:
      "Move consented raw clips older than the review window to an infrequent-access storage tier.",
    preservesCoreCorrectness: true,
    rationale: "Storage tier changes retrieval latency and price, not analysis inputs or outputs.",
  },
  {
    id: "bandwidth-upload-original-bitrate",
    targetComponent: "bandwidth",
    suggestion:
      "Skip server re-download of clips already analyzed on-device; transfer only the evidence record unless coach review needs the video.",
    preservesCoreCorrectness: true,
    rationale:
      "Avoids redundant transfer of bytes the pipeline never reads; analysis inputs are unchanged.",
  },
  {
    id: "media-extract-planned-frames-only",
    targetComponent: "media_processing",
    suggestion:
      "Extract only the frames the two-pass schedule actually plans (sparse + dense regions) instead of all frames.",
    preservesCoreCorrectness: true,
    rationale:
      "The analysis already consumes only planned frames; skipping unplanned extraction changes no analyzed pixel.",
  },
  {
    id: "server-cpu-batch-json-artifacts",
    targetComponent: "server_cpu",
    suggestion: "Batch small JSON artifact writes per session instead of per stroke.",
    preservesCoreCorrectness: true,
    rationale: "Artifact contents are identical; only write syscall count changes.",
  },
  {
    id: "gpu-right-size-inference",
    targetComponent: "server_gpu",
    suggestion:
      "Serve any future server-side models on the smallest GPU class that meets the frozen latency gates, verified against the same evaluation suite.",
    preservesCoreCorrectness: true,
    rationale:
      "Hardware class selection is gated on passing the existing frozen quality gates unchanged.",
  },
  {
    id: "coach-review-routing-not-thresholds",
    targetComponent: "coach_review",
    suggestion:
      "Reduce coach minutes per reviewed event with better queue tooling (pre-loaded context, keyboard-driven review) — never by loosening which events require review.",
    preservesCoreCorrectness: true,
    rationale:
      "Review scope and escalation thresholds are correctness policy and are explicitly out of bounds for cost work.",
  },
];

/**
 * Suggestions relevant to a breakdown: components carrying nonzero cost,
 * ordered by descending cost share (largest saving opportunity first).
 */
export function suggestOptimizations(breakdown: CostBreakdown): CostOptimizationSuggestion[] {
  const costByComponent = new Map(breakdown.components.map((c) => [c.component, c.microUsd]));
  return [...COST_OPTIMIZATION_CATALOG]
    .filter((s) => (costByComponent.get(s.targetComponent) ?? 0) > 0)
    .sort(
      (a, b) =>
        (costByComponent.get(b.targetComponent) ?? 0) -
        (costByComponent.get(a.targetComponent) ?? 0),
    );
}
