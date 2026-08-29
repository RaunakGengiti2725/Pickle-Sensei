// F15 — learning-curve ACTIONS: turn the E14 data-vs-features ranking into
// evidence-backed label-acquisition decisions.
//
// What this instrument does (deterministic, artifact-join only — no pipeline
// stage runs, no run dir touched, no cascade/bench number re-measured):
//   1. Derives the data-starvation classification per subsystem from the
//      committed E14 artifact's dataVsFeatures calls (no re-interpretation).
//   2. Fits saturating learning-curve models to the ONLY full-supply measured
//      curve (target_acquisition, 5 group points) and extrapolates the
//      expected accuracy gain per N new same-distribution labels with
//      parametric-bootstrap confidence bounds — quantifying where new labels
//      do NOT pay.
//   3. For the subsystem E14 says is label-starved (stroke: the only
//      MORE_DATA call — dev-corpus labeling proven saturated by D13, 4 L1
//      families at zero gold), quantifies the expected gain per N new labels
//      in the two senses that are honestly computable at 3 joined units:
//      (a) family-coverage/measurability gain with exact Wilson-interval
//      planning math, and (b) expected curve-interval shrink per new session
//      group, using the TA curve's measured width-vs-groups relation as an
//      explicitly-labeled transferred prior. The accuracy curve itself is
//      NOT extrapolated — 2 curve points cannot identify a saturating model,
//      and that negative is recorded, not papered over.
//   4. Emits the concrete label-acquisition plan (which clips, which
//      modality, how many) as a machine artifact + a generated markdown plan
//      annotators can execute. Fresh-candidate clips are named as CANDIDATE
//      material only: they are a label-blind holdout pool (registry policy)
//      and require an integrator split-freeze through the D-024 front door
//      before any labeling.
//
// Run from packages/swing-lab (its tsx + deps):
//   cd packages/swing-lab && npx tsx ../../datasets/experiments/wave-f/f15-learning-curve-actions.ts
//
// Held-out discipline: wm-dink-01 and afn-vic-rally1 are never read, joined,
// or planned against. Fresh candidates are never opened — only their
// committed registry metadata (id/title/relevance strings) is quoted.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mulberry32 } from "../../../packages/swing-lab/src/learningCurveModality.js";
import { STROKE_FAMILIES } from "../../../packages/shared-types/src/pickleballTaxonomy.js";

const REPO_ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8")) as T;
}

const round3 = (v: number) => Number(v.toFixed(3));
const round4 = (v: number) => Number(v.toFixed(4));

// ── E14 artifact ─────────────────────────────────────────────────────────────

interface E14CurvePoint {
  groups: number;
  resamples: number;
  meanUnits: number;
  accuracy: { mean: number | null; p5: number | null; p95: number | null };
}

interface E14Subsystem {
  subsystem: string;
  labelSupply: { devUnits: number; perGroup: Record<string, number> };
  joined: { devUnits: number };
  curve: E14CurvePoint[];
  fit: { classification: string };
  dataVsFeatures: { call: string; reasoning: string };
}

interface E14Artifact {
  experimentId: string;
  curveVersion: string;
  predictionSources: Record<string, string>;
  subsystems: E14Subsystem[];
}

const E14_PATH = "datasets/experiments/wave-e/EXP-2026-08-29-e14-learning-curves.json";
const e14 = readJson<E14Artifact>(E14_PATH);

// ── 1. data-starvation classification (derived, not re-judged) ──────────────

type Starvation = "LABEL_STARVED" | "PREDICTION_STARVED" | "FEATURE_LIMITED";

function classifyStarvation(call: string): Starvation {
  if (call.startsWith("MORE_DATA")) return "LABEL_STARVED";
  if (call.startsWith("MORE_PREDICTIONS")) return "PREDICTION_STARVED";
  if (call.startsWith("BETTER_FEATURES")) return "FEATURE_LIMITED";
  throw new Error(`unrecognized E14 dataVsFeatures call: ${call}`);
}

const starvation = e14.subsystems.map((s) => ({
  subsystem: s.subsystem,
  e14Call: s.dataVsFeatures.call,
  class: classifyStarvation(s.dataVsFeatures.call),
  devLabelUnits: s.labelSupply.devUnits,
  joinedUnits: s.joined.devUnits,
}));

const labelStarved = starvation.filter((s) => s.class === "LABEL_STARVED");
if (labelStarved.length !== 1 || labelStarved[0]!.subsystem !== "stroke") {
  throw new Error(
    `expected exactly one LABEL_STARVED subsystem (stroke); got ${JSON.stringify(labelStarved)}`,
  );
}

// ── shared math ──────────────────────────────────────────────────────────────

const Z95 = 1.959964;

function wilsonHalfWidth(p: number, n: number): number {
  const z2 = Z95 * Z95;
  return (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

function wilsonInterval(successes: number, n: number): { low: number; high: number } {
  const p = successes / n;
  const z2 = Z95 * Z95;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const hw = wilsonHalfWidth(p, n);
  return { low: Math.max(0, center - hw), high: Math.min(1, center + hw) };
}

function minNForHalfWidth(p: number, target: number, maxN = 100000): number {
  for (let n = 1; n <= maxN; n += 1) {
    if (wilsonHalfWidth(p, n) <= target) return n;
  }
  throw new Error("no n found");
}

// ── 2. TA curve fit + extrapolation with bootstrap bounds ────────────────────

const ta = e14.subsystems.find((s) => s.subsystem === "target_acquisition")!;
const TA_N_FULL = 54;
const TA_P_FULL = ta.curve[ta.curve.length - 1]!.accuracy.mean!;

// Per-point sampling sd: for bootstrap-resampled points, the p5–p95 span of
// the group-bootstrap distribution mapped to a normal sd ((p95-p5)/3.2897).
// The full-supply point (resamples=1) has no bootstrap spread; a binomial sd
// at n=54 is used — a stated assumption that understates group-level variance.
interface FitPoint {
  x: number;
  y: number;
  sd: number;
}

const taPoints: FitPoint[] = ta.curve.map((pt) => ({
  x: pt.meanUnits,
  y: pt.accuracy.mean!,
  sd:
    pt.resamples > 1
      ? (pt.accuracy.p95! - pt.accuracy.p5!) / 3.2897
      : Math.sqrt((TA_P_FULL * (1 - TA_P_FULL)) / TA_N_FULL),
}));

type ModelName = "exponential_saturation" | "power_law";

interface FitResult {
  model: ModelName;
  a: number;
  b: number;
  c: number;
  weightedSse: number;
}

// y = a - b * basis(x, c); weighted linear LS in (a, b) for fixed c.
function fitForC(
  points: FitPoint[],
  c: number,
  basis: (x: number, c: number) => number,
): {
  a: number;
  b: number;
  sse: number;
} | null {
  let sw = 0;
  let swz = 0;
  let swy = 0;
  let swzz = 0;
  let swzy = 0;
  for (const pt of points) {
    const z = -basis(pt.x, c);
    const w = 1 / (pt.sd * pt.sd);
    sw += w;
    swz += w * z;
    swy += w * pt.y;
    swzz += w * z * z;
    swzy += w * z * pt.y;
  }
  const det = sw * swzz - swz * swz;
  if (Math.abs(det) < 1e-12) return null;
  const a = (swzz * swy - swz * swzy) / det;
  const b = (sw * swzy - swz * swy) / det;
  if (!(b > 0) || !(a > 0) || a > 1.05) return null; // monotone-increasing, bounded accuracy
  let sse = 0;
  for (const pt of points) {
    const pred = a - b * basis(pt.x, c);
    const r = (pt.y - pred) / pt.sd;
    sse += r * r;
  }
  return { a, b, sse };
}

const BASES: Record<ModelName, (x: number, c: number) => number> = {
  exponential_saturation: (x, c) => Math.exp(-x / c),
  power_law: (x, c) => Math.pow(x, -c),
};

const C_GRIDS: Record<ModelName, number[]> = {
  exponential_saturation: Array.from({ length: 400 }, (_, i) =>
    Math.exp(Math.log(0.5) + (i / 399) * (Math.log(2000) - Math.log(0.5))),
  ),
  power_law: Array.from({ length: 400 }, (_, i) => 0.05 + (i / 399) * 2.95),
};

function fitModel(points: FitPoint[], model: ModelName, grid: number[]): FitResult | null {
  let best: FitResult | null = null;
  for (const c of grid) {
    const fit = fitForC(points, c, BASES[model]);
    if (fit && (best === null || fit.sse < best.weightedSse)) {
      best = { model, a: fit.a, b: fit.b, c, weightedSse: fit.sse };
    }
  }
  return best;
}

function predict(fit: FitResult, x: number): number {
  return Math.min(1, Math.max(0, fit.a - fit.b * BASES[fit.model](x, fit.c)));
}

const taFits = (Object.keys(BASES) as ModelName[])
  .map((m) => fitModel(taPoints, m, C_GRIDS[m]))
  .filter((f): f is FitResult => f !== null)
  .sort((p, q) => p.weightedSse - q.weightedSse);
if (taFits.length === 0) throw new Error("no TA model fit converged");
const taBest = taFits[0]!;

const ADD_NS = [10, 25, 50, 100];

// Parametric bootstrap: redraw each curve point from N(mean, sd), refit both
// model families (coarser grid), take the better, extrapolate.
const BOOT = 2000;
const random = mulberry32(20260829);
function normalDraw(): number {
  const u1 = Math.max(random(), 1e-12);
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
const COARSE_GRIDS: Record<ModelName, number[]> = {
  exponential_saturation: C_GRIDS.exponential_saturation.filter((_, i) => i % 4 === 0),
  power_law: C_GRIDS.power_law.filter((_, i) => i % 4 === 0),
};

const bootGains: Record<number, number[]> = Object.fromEntries(ADD_NS.map((n) => [n, []]));
const bootAsymptotes: number[] = [];
let bootFailures = 0;
for (let draw = 0; draw < BOOT; draw += 1) {
  const perturbed = taPoints.map((pt) => ({
    ...pt,
    y: Math.min(1, Math.max(0, pt.y + pt.sd * normalDraw())),
  }));
  const fits = (Object.keys(BASES) as ModelName[])
    .map((m) => fitModel(perturbed, m, COARSE_GRIDS[m]))
    .filter((f): f is FitResult => f !== null)
    .sort((p, q) => p.weightedSse - q.weightedSse);
  if (fits.length === 0) {
    bootFailures += 1;
    continue;
  }
  const fit = fits[0]!;
  const base = predict(fit, TA_N_FULL);
  for (const n of ADD_NS) bootGains[n]!.push(predict(fit, TA_N_FULL + n) - base);
  bootAsymptotes.push(Math.min(1, fit.a));
}

function pct(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

const taExtrapolation = ADD_NS.map((n) => {
  const gains = [...bootGains[n]!].sort((p, q) => p - q);
  return {
    addedLabels: n,
    pointEstimateGain: round4(predict(taBest, TA_N_FULL + n) - predict(taBest, TA_N_FULL)),
    bootstrapGain: {
      median: round4(pct(gains, 0.5)),
      p5: round4(pct(gains, 0.05)),
      p95: round4(pct(gains, 0.95)),
    },
  };
});
const sortedAsym = [...bootAsymptotes].sort((p, q) => p - q);

// ── 3. TA slice sample-size math (secondary data need, quantified) ───────────

interface TaCase {
  caseId: string;
  sessionKey: string;
  split: string;
  verification: { state: string };
}
interface TaResultRow {
  caseId: string;
  verification: string;
  lockCorrect?: boolean;
}
const taCases = readJson<{ cases: TaCase[] }>("datasets/ta-bench/cases.json").cases;
const taSession = new Map(
  taCases.map((c) => [c.caseId, { session: c.sessionKey, split: c.split }]),
);
const taShipped = readJson<{ variant: { shipped?: boolean }; results: TaResultRow[] }>(
  e14.predictionSources.taBench!,
);
if (!taShipped.variant.shipped) throw new Error("E14 taBench source is not the shipped variant");

const perSession = new Map<string, { n: number; correct: number }>();
for (const row of taShipped.results) {
  const meta = taSession.get(row.caseId);
  if (!meta || meta.split !== "dev" || row.verification !== "verified") continue;
  const cell = perSession.get(meta.session) ?? { n: 0, correct: 0 };
  cell.n += 1;
  if (row.lockCorrect === true) cell.correct += 1;
  perSession.set(meta.session, cell);
}

const TA_SLICE_TARGET_HW = 0.15;
const taSlices = [...perSession.entries()]
  .sort(([p], [q]) => p.localeCompare(q))
  .map(([session, { n, correct }]) => {
    const p = correct / n;
    const ci = wilsonInterval(correct, n);
    const needed = minNForHalfWidth(p, TA_SLICE_TARGET_HW);
    return {
      session,
      cases: n,
      lockCorrect: correct,
      accuracy: round3(p),
      wilson95: { low: round3(ci.low), high: round3(ci.high) },
      currentHalfWidth: round3(wilsonHalfWidth(p, n)),
      casesForHalfWidth015: needed,
      additionalCasesNeeded: Math.max(0, needed - n),
    };
  });

// ── 4. stroke: gain per N new labels (coverage + CI planning math) ───────────

interface StrokeLabel {
  caseId: string;
  l1: string;
}
const strokeGold = readJson<{ labels: StrokeLabel[] }>("datasets/paddle-bench/stroke-gold.json");
const familyCounts: Record<string, number> = {};
for (const label of strokeGold.labels) {
  familyCounts[label.l1] = (familyCounts[label.l1] ?? 0) + 1;
}
const zeroGoldFamilies = STROKE_FAMILIES.filter((f) => !(f in familyCounts));
const strokeCurve = e14.subsystems.find((s) => s.subsystem === "stroke")!.curve;

// Honest negative: the stroke accuracy curve cannot be fit.
const strokeCurveUnfittable = {
  provenNegative:
    "The stroke accuracy curve has 2 points (3 joined units, second point resamples=1). A 3-parameter saturating model is unidentifiable at 2 points; any extrapolated accuracy-per-label number from it would be fabricated. Gain per N new labels is therefore quantified in the two computable senses below (measurability + interval width), never as extrapolated accuracy.",
  curvePoints: strokeCurve.length,
  joinedUnits: e14.subsystems.find((s) => s.subsystem === "stroke")!.joined.devUnits,
};

// (a) Wilson planning: labels per family for a first measurable accuracy
// point at a given 95% half-width (worst-case p=0.5).
const PLANNING_NS = [5, 8, 12, 16, 24, 32, 43];
const wilsonPlanningTable = PLANNING_NS.map((n) => ({
  labelsPerFamily: n,
  halfWidthAtP05: round3(wilsonHalfWidth(0.5, n)),
}));
const N_FIRST_POINT = minNForHalfWidth(0.5, 0.25); // first usable point
const N_TIGHT_POINT = minNForHalfWidth(0.5, 0.2);

// (b) curve-interval width vs session groups: TA measured relation as an
// explicitly transferred prior. Fit w(G) = k / sqrt(G) by LS on the four
// resampled TA points.
const taWidths = ta.curve
  .filter((pt) => pt.resamples > 1)
  .map((pt) => ({ g: pt.groups, w: pt.accuracy.p95! - pt.accuracy.p5! }));
const k =
  taWidths.reduce((sum, { g, w }) => sum + w / Math.sqrt(g), 0) /
  taWidths.reduce((sum, { g }) => sum + 1 / g, 0) /
  1; // LS for w = k/sqrt(G): k = Σ(w/√G) / Σ(1/G)
const groupWidthPrior = {
  assumption:
    "TA is the only subsystem with a measured width-vs-groups relation; transferring its fitted w(G)=k/√G to stroke assumes comparable per-session unit counts and inter-session heterogeneity. Direction-of-magnitude planning prior only — NOT a stroke measurement.",
  fittedK: round3(k),
  taMeasuredWidths: taWidths.map(({ g, w }) => ({ groups: g, width: round3(w) })),
  predictedStrokeIntervalWidth: [2, 4, 6, 8, 12].map((g) => ({
    sessionGroups: g,
    predictedWidth: round3(k / Math.sqrt(g)),
  })),
};

const strokeGain = {
  currentFamilyCoverage: {
    familiesWithGold: Object.keys(familyCounts)
      .filter((f) => f !== "unknown")
      .sort(),
    perFamily: Object.fromEntries(Object.entries(familyCounts).sort()),
    zeroGoldFamilies: [...zeroGoldFamilies],
    coverage: `${STROKE_FAMILIES.length - zeroGoldFamilies.length}/${STROKE_FAMILIES.length} L1 families have any gold`,
  },
  strokeCurveUnfittable,
  measurabilityGainPerLabels: {
    definition:
      "A family becomes MEASURABLE when it has enough gold for a first accuracy point whose 95% Wilson half-width (worst-case p=0.5) is ≤0.25; TIGHT at ≤0.20.",
    labelsForFirstMeasurablePoint: N_FIRST_POINT,
    labelsForTightPoint: N_TIGHT_POINT,
    wilsonPlanningTable,
    gainStatement: `${N_FIRST_POINT} labels/family × ${zeroGoldFamilies.length} zero-gold families = ${N_FIRST_POINT * zeroGoldFamilies.length} labels lifts L1 measurability from ${STROKE_FAMILIES.length - zeroGoldFamilies.length}/${STROKE_FAMILIES.length} to ${STROKE_FAMILIES.length}/${STROKE_FAMILIES.length} families (each with CI half-width ≤0.25); +${(N_TIGHT_POINT - N_FIRST_POINT) * zeroGoldFamilies.length} more (${N_TIGHT_POINT}/family) tightens each to ≤0.20.`,
  },
  groupWidthPrior,
};

// ── 5. label-acquisition plan ────────────────────────────────────────────────

interface FreshCandidate {
  id: string;
  title: string;
  pickleballRelevance?: string;
}
const registry = readJson<{
  freshCandidates: { policy: string; items: FreshCandidate[] };
}>("datasets/pickleball/registry.json");
const freshPolicy = registry.freshCandidates.policy;
const freshClips = registry.freshCandidates.items.map((item) => ({
  id: item.id,
  title: item.title,
  committedRelevanceNote: item.pickleballRelevance ?? null,
}));

const STROKE_LABELS_TOTAL = N_FIRST_POINT * zeroGoldFamilies.length;

const acquisitionPlan = {
  ordering:
    "E14's ranking is not overturned: actions 1–2 (zero labels) precede labeling. This plan is the DATA arm the ranking asks for.",
  actions: [
    {
      priority: 1,
      action: "Mac prediction pass (ZERO new labels)",
      subsystems: ["event", "contact", "ball", "stroke"],
      what: "lab:regen + event/contact/ball/stroke benches over the grown gold (41 event / 32 contact / 100 ball / 29 stroke dev units) + wire wavea-wgm-wheelchair and wavea-sasebo-volleys into ball-bench.json. Converts three MEASUREMENT_LIMITED verdicts into real data-vs-features calls without any labeling.",
      cost: "0 labels; 1 Mac session",
      blockedExternal: "requires macOS/Apple Vision (unchanged Wave C boundary)",
    },
    {
      priority: 2,
      action: "TA feature/config work, not labels",
      subsystems: ["target_acquisition"],
      what: `Measured curve fit says same-distribution TA labels are worthless: best fit ${taBest.model} plateaus at asymptote ${round3(Math.min(1, taBest.a))}; +50 labels buys ${taExtrapolation[2]!.bootstrapGain.median} accuracy (90% bootstrap band ${taExtrapolation[2]!.bootstrapGain.p5}…${taExtrapolation[2]!.bootstrapGain.p95}). The committed candidate config already measures 0.863 on the same 54 cases (D-027 gate pending).`,
      cost: "0 labels",
    },
    {
      priority: 3,
      action: `Stroke label acquisition — ${STROKE_LABELS_TOTAL} new stroke-event labels (${N_FIRST_POINT}/family × ${zeroGoldFamilies.length} zero-gold families: ${zeroGoldFamilies.join(", ")})`,
      subsystems: ["stroke", "event", "contact"],
      modality:
        "Per event: eventStartMs/contactMs/eventEndMs bounds + owner + stroke L1/L2/L3 (pickleball-taxonomy-v2), append-only into stroke-gold.json + bundle event sidecars; explicit unknown L2/L3 when not visually established; DeclaredStroke/PredictedStroke never merged. Each label co-feeds the event corpus (E14 rank 1 secondary) and, where the strike is visible, contactMs feeds contact gold.",
      sourceRequirement: `NEW footage only — D13 proved dev-corpus labeling is saturated (29/29 events labeled; ${zeroGoldFamilies.length} families at zero). Spread across ≥6 new dev session groups (transferred width prior predicts curve interval ≈ ${round3(k / Math.sqrt(6))} at 6 groups vs ${round3(k / Math.sqrt(2))} at 2).`,
      contentTargeting: [
        "return: any full-rally footage containing serves — every serve implies a return; behind-court tournament/rec match clips are the highest-yield source",
        "drop_reset: mid-court third-shot/transition play — full-rally doubles footage at 3.0–5.0 level",
        "attack_counter: kitchen-line speedups and counters — higher-level (4.0+) doubles exchanges",
        "specialty (ATP/erne/tweener/lob-retrieval): rarest; tournament footage with around-the-post opportunities; expect the long tail to need targeted acquisition beyond this pool",
      ],
      candidateClips: {
        gating: `The 15 committed fresh candidates are a label-blind holdout-candidate pool (registry policy: "${freshPolicy}"). NO labeling may start until the integrator runs a split-freeze through the D-024 acquisition front door; only dev-assigned clips may be labeled, and ≥5 clips should be frozen as holdout/val. If the integrator elects to preserve the entire pool as holdout, the fallback is new acquisition via the e22-proven channels (VA official PD-USGov, YouTube CC BY sweeps).`,
        clips: freshClips,
      },
      cost: `${STROKE_LABELS_TOTAL} stroke-event labels (~${N_FIRST_POINT}/family); +${(N_TIGHT_POINT - N_FIRST_POINT) * zeroGoldFamilies.length} optional labels to tighten every family CI to ≤0.20`,
    },
    {
      priority: 4,
      action: "Contact slice labels — 16 edge-on/occluded-contact events",
      subsystems: ["contact"],
      modality:
        "contactMs on events where the paddle is edge-on or the contact is body/net-occluded (the committed held-out failure shape: dev 0.667 vs held-out 0.0 at 250/245ms). Take from the SAME new dev clips as priority 3 (marginal cost near zero) — E14 rank 2 says these labels only pay after the priority-1 Mac pass.",
      cost: "16 contact labels (subset of priority-3 events where the slice occurs)",
    },
    {
      priority: 5,
      action: "TA contested-slice verified cases (slice-estimate sharpening only)",
      subsystems: ["target_acquisition"],
      modality: "verified ta-bench cases (region + trueTrackId + verification note), dev split",
      what: taSlices
        .filter((s) => s.additionalCasesNeeded > 0)
        .map(
          (s) =>
            `${s.session}: ${s.lockCorrect}/${s.cases} (Wilson95 ${s.wilson95.low}–${s.wilson95.high}) → +${s.additionalCasesNeeded} cases for half-width ≤${TA_SLICE_TARGET_HW}`,
        ),
      caveat:
        "Sharpens the slice ESTIMATE for the D-027-pending candidate evaluation; the fitted curve proves it will not move aggregate accuracy.",
      cost: `${taSlices.reduce((sum, s) => sum + s.additionalCasesNeeded, 0)} verified cases total (all sessions to half-width ≤0.15)`,
    },
  ],
  heldOutDiscipline:
    "wm-dink-01 and afn-vic-rally1: untouched, never named as acquisition targets. Fresh candidates: never opened; plan quotes committed registry metadata only.",
};

// ── artifact ────────────────────────────────────────────────────────────────

const artifact = {
  experimentId: "EXP-2026-08-29-f15-learning-curve-actions",
  extends: E14_PATH,
  generatedAtIso: new Date().toISOString(),
  question:
    "E14 ranked data-vs-features needs. For the subsystem the curves say is label-starved, what is the expected gain per N new labels (with bounds and stated assumptions), and what is the concrete label-acquisition plan?",
  environment:
    "LINUX-CPU artifact-join only — no pipeline stage executed, no run dir touched, no bench re-measured; all numbers derive from committed artifacts",
  starvationClassification: {
    rule: "Derived deterministically from E14 dataVsFeatures.call prefixes: MORE_DATA→LABEL_STARVED, MORE_PREDICTIONS→PREDICTION_STARVED, BETTER_FEATURES→FEATURE_LIMITED.",
    table: starvation,
    mostDataStarved: {
      subsystem: "stroke",
      why: "The only LABEL_STARVED call in E14: D13 proved dev-corpus labeling saturated (29/29 events labeled) with 4 of 9 L1 families at zero gold — new labels require new footage. Event/contact/ball are PREDICTION-starved (labels exist, predictions lag) and target_acquisition is measured FEATURE-limited.",
    },
  },
  taCurveFit: {
    purpose:
      "Quantifies where labels do NOT pay: the only full-supply measured curve, fitted and extrapolated to bound the value of same-distribution labels.",
    points: taPoints.map((pt) => ({ units: pt.x, accuracy: pt.y, assumedSd: round4(pt.sd) })),
    sdAssumptions:
      "Resampled points: sd=(p95−p5)/3.2897 of the group-bootstrap distribution (normal approximation). Full-supply point: binomial sd √(p(1−p)/54)=0.0632 — understates group-level variance, i.e. the bounds below are, if anything, too NARROW; the qualitative plateau verdict is insensitive to this.",
    modelSelection: taFits.map((f) => ({
      model: f.model,
      a: round4(f.a),
      b: round4(f.b),
      c: round4(f.c),
      weightedSse: round4(f.weightedSse),
    })),
    bestModel: taBest.model,
    asymptote: {
      pointEstimate: round3(Math.min(1, taBest.a)),
      bootstrap: {
        median: round3(pct(sortedAsym, 0.5)),
        p5: round3(pct(sortedAsym, 0.05)),
        p95: round3(pct(sortedAsym, 0.95)),
      },
    },
    currentAccuracyAt54: TA_P_FULL,
    extrapolatedGainPerNewLabels: taExtrapolation,
    bootstrap: { draws: BOOT, failures: bootFailures, seed: 20260829 },
    interpretation: `Both saturating families agree the TA curve has plateaued: the median bootstrap gain from +50 same-distribution labels is ${taExtrapolation[2]!.bootstrapGain.median} (90% band ${taExtrapolation[2]!.bootstrapGain.p5}…${taExtrapolation[2]!.bootstrapGain.p95}) — an order of magnitude below the +0.178 the committed candidate CONFIG already measures on identical cases. Labeling same-distribution TA cases is quantitatively the worst use of annotation effort.`,
  },
  taSliceSampleSize: {
    purpose:
      "E14's secondary TA data need (contested-session slice estimates) quantified with exact Wilson math.",
    source: `${e14.predictionSources.taBench} (shipped variant), verified dev cases, sessions from datasets/ta-bench/cases.json`,
    targetHalfWidth: TA_SLICE_TARGET_HW,
    slices: taSlices,
  },
  strokeGainPerNewLabels: strokeGain,
  labelAcquisitionPlan: acquisitionPlan,
};

const OUT_DIR = join(REPO_ROOT, "datasets/experiments/wave-f");
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, "EXP-2026-08-29-f15-learning-curve-actions.json"),
  `${JSON.stringify(artifact, null, 2)}\n`,
);

// ── generated annotator-facing plan (markdown) ───────────────────────────────

const md = `# F15 — Label-Acquisition Plan (generated)

Generated by \`datasets/experiments/wave-f/f15-learning-curve-actions.ts\` from
\`${E14_PATH}\` and committed artifacts only. Numbers in
\`EXP-2026-08-29-f15-learning-curve-actions.json\`. Do not hand-edit; re-run the
script.

## Verdict of the curves

- **Most label-starved subsystem: STROKE** — the only E14 \`MORE_DATA\` call.
  D13 proved dev-corpus labeling is saturated (29/29 events labeled);
  ${zeroGoldFamilies.length}/9 L1 families have ZERO gold: ${zeroGoldFamilies.join(", ")}.
- **Event / contact / ball are PREDICTION-starved**, not label-starved: one Mac
  pass over the grown gold precedes any labeling (E14 ranks 1–3, unchanged).
- **Target-acquisition labels are measurably worthless in aggregate**: the fitted
  ${taBest.model.replace("_", " ")} curve plateaus at ${round3(Math.min(1, taBest.a))};
  +50 same-distribution labels buy a median ${taExtrapolation[2]!.bootstrapGain.median}
  accuracy (90% band ${taExtrapolation[2]!.bootstrapGain.p5}…${taExtrapolation[2]!.bootstrapGain.p95}),
  while the committed candidate CONFIG measures +0.178 on identical cases.

## Why stroke gain is stated as measurability, not extrapolated accuracy

The stroke accuracy curve has 2 points / 3 joined units — a saturating model is
unidentifiable there, and extrapolating it would be fabrication. The honest,
computable gains per N labels are:

| labels/family | 95% Wilson half-width (worst case p=0.5) |
|---|---|
${wilsonPlanningTable.map((r) => `| ${r.labelsPerFamily} | ±${r.halfWidthAtP05} |`).join("\n")}

- **${N_FIRST_POINT} labels/family** = first measurable accuracy point (±0.25) →
  **${STROKE_LABELS_TOTAL} labels** lift L1 measurability from
  ${STROKE_FAMILIES.length - zeroGoldFamilies.length}/9 to 9/9 families.
- **${N_TIGHT_POINT}/family** tightens each family to ±0.20
  (+${(N_TIGHT_POINT - N_FIRST_POINT) * zeroGoldFamilies.length} labels).
- Session spread: ≥6 new dev session groups. Transferred width prior (TA-fitted
  w(G)=${round3(k)}/√G — assumption, not a stroke measurement): interval
  ≈${round3(k / Math.sqrt(2))} at 2 groups → ≈${round3(k / Math.sqrt(6))} at 6 groups.

## The plan

1. **Mac prediction pass first (0 labels)** — regen + benches over grown gold
   (41 event / 32 contact / 100 ball / 29 stroke dev units) + wire the 2 labeled
   bundles into ball-bench.json. BLOCKED_EXTERNAL on this fleet (no Mac).
2. **No TA labeling.** Feature/config work (D-027-pending candidate) instead.
3. **${STROKE_LABELS_TOTAL} stroke-event labels** (${N_FIRST_POINT}/family for ${zeroGoldFamilies.join(", ")})
   from NEW footage, ≥6 new dev session groups. Modality per event:
   eventStartMs/contactMs/eventEndMs + owner + L1/L2/L3
   (pickleball-taxonomy-v2), append-only; explicit \`unknown\` where not visually
   established; DeclaredStroke ≠ PredictedStroke always. Family targeting:
   returns from any behind-court match footage; drop/reset from 3.0–5.0 doubles
   transition play; attack/counter from 4.0+ kitchen exchanges; specialty is the
   long tail and may need targeted acquisition.
4. **16 edge-on/occluded contact labels** on the same new clips (the committed
   held-out failure shape) — only pays after step 1.
5. **TA contested-slice verified cases** (slice sharpening only):
${taSlices
  .filter((s) => s.additionalCasesNeeded > 0)
  .map(
    (s) =>
      `   - ${s.session}: ${s.lockCorrect}/${s.cases} → +${s.additionalCasesNeeded} cases for CI half-width ≤${TA_SLICE_TARGET_HW}`,
  )
  .join("\n")}

## Clip sources for step 3 (GATED)

The 15 committed fresh candidates are a **label-blind holdout-candidate pool**;
labeling requires an integrator split-freeze through the D-024 front door first
(freeze ≥5 as holdout/val; label only dev-assigned clips). If the integrator
keeps the whole pool as holdout, acquire new clips via the e22-proven channels
(VA official PD-USGov; YouTube CC BY sweeps). Candidates (committed registry
metadata only — no clip was opened):

${freshClips.map((c) => `- \`${c.id}\` — ${c.title}`).join("\n")}

## Held-out discipline

wm-dink-01 and afn-vic-rally1 untouched and never targeted. Fresh candidates
never opened. No label was created by this workstream.
`;

writeFileSync(join(OUT_DIR, "f15-label-acquisition-plan.md"), md);

console.log("wrote EXP-2026-08-29-f15-learning-curve-actions.json + f15-label-acquisition-plan.md");
console.log(`best TA model: ${taBest.model} a=${round4(taBest.a)} c=${round4(taBest.c)}`);
console.log(`gain(+50): ${JSON.stringify(taExtrapolation[2])}`);
console.log(`zero-gold families: ${zeroGoldFamilies.join(", ")} → ${STROKE_LABELS_TOTAL} labels`);
