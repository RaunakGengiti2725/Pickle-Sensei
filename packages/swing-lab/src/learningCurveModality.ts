import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";

/**
 * MODALITY LEARNING CURVES — label-count vs accuracy per modality
 * (ownership, contact, event, stroke), GROUP-AWARE by sessionKey.
 *
 *   pnpm lab:learning-curve-modality
 *
 * Extends the W13 learning-curve instrument (learningCurve.ts, per-case
 * bootstrap over paddle/ball bench results) to the four label modalities
 * that had NO curve coverage, with two hard rules:
 *
 *  1. GROUP-AWARE SPLITS: resampling units are SESSIONS (sessionKey — the
 *     corpus split unit), never random frames/labels. Labels from one
 *     session never straddle a resample boundary.
 *  2. NO FABRICATED POINTS: an accuracy point exists only where a committed
 *     label can be joined to a committed prediction artifact (latest
 *     lab:cascade artifact in datasets/cascade/). Where prediction coverage
 *     runs out, the curve STOPS and says so — label counts alone are
 *     reported separately and never presented as accuracy.
 *
 * Held-out cases (wm-dink-01, afn-vic-rally1) never enter curves; their
 * committed cascade rows are quoted read-only as domain-shift evidence.
 */

export const HELD_OUT_CASES = new Set(["wm-dink-01", "afn-vic-rally1"]);

export type Modality = "ownership" | "contact" | "event" | "stroke";

export interface JoinedUnit {
  unitId: string;
  caseId: string;
  group: string; // sessionKey
  correct: boolean;
}

export interface CurvePoint {
  groups: number;
  resamples: number;
  meanUnits: number;
  accuracy: { mean: number | null; p5: number | null; p95: number | null };
}

export interface ModalityReport {
  modality: Modality;
  labelSupply: {
    devUnits: number;
    heldOutUnits: number;
    devGroups: string[];
    perGroup: Record<string, number>;
    definition: string;
  };
  joined: {
    devUnits: number;
    devGroups: string[];
    predictionSource: string;
    perUnit: Array<{ unitId: string; group: string; correct: boolean; detail: string }>;
  };
  curve: CurvePoint[];
  curveStops: string | null;
  snapshots: Array<{
    labelCount: number;
    accuracy: number;
    counts: string;
    source: string;
    caveat: string;
  }>;
  domainShift: {
    devAccuracy: number | null;
    heldOutAccuracy: number | null;
    evidence: string[];
  } | null;
  verdict: { classification: string; reasoning: string };
}

/** Deterministic PRNG (same generator the W13 curve uses) so artifacts are reproducible. */
export function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round3 = (value: number | null) => (value === null ? null : Number(value.toFixed(3)));

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/**
 * Group-aware bootstrap curve: at k = 1..G, draw k SESSIONS (without
 * replacement) and pool the accuracy of every joined unit inside them.
 * A session's units always move together — never random frames.
 */
export function groupAwareCurve(
  units: JoinedUnit[],
  resamples = 1000,
  seed = 20260829,
): CurvePoint[] {
  const groups = [...new Set(units.map((unit) => unit.group))].sort();
  const random = mulberry32(seed);
  const points: CurvePoint[] = [];
  for (let k = 1; k <= groups.length; k += 1) {
    const draws = k === groups.length ? 1 : resamples;
    const accuracies: number[] = [];
    let unitTotal = 0;
    for (let draw = 0; draw < draws; draw += 1) {
      const shuffled = [...groups].sort(() => random() - 0.5).slice(0, k);
      const chosen = new Set(shuffled);
      const pool = units.filter((unit) => chosen.has(unit.group));
      unitTotal += pool.length;
      if (pool.length > 0)
        accuracies.push(pool.filter((unit) => unit.correct).length / pool.length);
    }
    accuracies.sort((a, b) => a - b);
    const mean = accuracies.length
      ? accuracies.reduce((total, value) => total + value, 0) / accuracies.length
      : null;
    points.push({
      groups: k,
      resamples: draws,
      meanUnits: Number((unitTotal / draws).toFixed(1)),
      accuracy: {
        mean: round3(mean),
        p5: round3(quantile(accuracies, 0.05)),
        p95: round3(quantile(accuracies, 0.95)),
      },
    });
  }
  return points;
}

export interface DiagnosisInput {
  modality: Modality;
  devLabelUnits: number;
  joined: JoinedUnit[];
  curve: CurvePoint[];
  heldOut: Array<{ correct: boolean }>;
}

/**
 * Deterministic verdict. MEASUREMENT_LIMITED is the honest floor: with the
 * canonical run dirs absent on Linux, committed predictions cover only the
 * n=5 cascade gold events, so most curves stop long before the label supply
 * does — that is itself the diagnosis, and it is stated rather than papered
 * over with resampled noise.
 */
export function diagnose(input: DiagnosisInput): { classification: string; reasoning: string } {
  const groups = new Set(input.joined.map((unit) => unit.group)).size;
  const devAccuracy = input.joined.length
    ? input.joined.filter((unit) => unit.correct).length / input.joined.length
    : null;
  const heldOutAccuracy = input.heldOut.length
    ? input.heldOut.filter((unit) => unit.correct).length / input.heldOut.length
    : null;
  const shift =
    devAccuracy !== null &&
    heldOutAccuracy !== null &&
    input.heldOut.length >= 2 &&
    devAccuracy - heldOutAccuracy >= 0.25;
  if (input.joined.length < 6 || groups < 3) {
    const shiftNote = shift
      ? ` Committed held-out rows additionally show a domain-shift signature (dev ${round3(devAccuracy)} vs held-out ${round3(heldOutAccuracy)}) — observation from committed artifacts only, never tuned against.`
      : "";
    return {
      classification: "MEASUREMENT_LIMITED",
      reasoning:
        `Curve stops at ${groups} session group(s) / ${input.joined.length} joined units while the dev label supply is ${input.devLabelUnits} units: ` +
        `committed prediction artifacts do not cover the newer labels, so data-limited vs model-limited cannot be separated at this n. ` +
        `The binding constraint is PREDICTION coverage (Mac regen over the grown label set), not label supply.` +
        shiftNote,
    };
  }
  const resampled = input.curve[input.curve.length - 2]!;
  const last = input.curve[input.curve.length - 1]!;
  const spread = (resampled.accuracy.p95 ?? 1) - (resampled.accuracy.p5 ?? 0);
  const delta = Math.abs((last.accuracy.mean ?? 0) - (resampled.accuracy.mean ?? 0));
  if (shift) {
    return {
      classification: "DOMAIN_SHIFT",
      reasoning: `Dev accuracy ${round3(devAccuracy)} vs held-out ${round3(heldOutAccuracy)} (gap ≥ 0.25, n_heldout=${input.heldOut.length}); dev curve alone would understate the problem.`,
    };
  }
  if (spread > 0.2 || delta > 0.05) {
    return {
      classification: "DATA_LIMITED",
      reasoning: `Leave-one-group-out accuracy interval spans ${spread.toFixed(2)} (Δ ${delta.toFixed(3)} on the last added group) — the metric is still moving with data; more labeled sessions have high value.`,
    };
  }
  if ((last.accuracy.mean ?? 0) < 0.8) {
    return {
      classification: "MODEL_LIMITED",
      reasoning: `Accuracy plateaued at ${last.accuracy.mean} with a tight group interval (${spread.toFixed(2)}) — adding same-distribution labels is unlikely to move it; inspect failure slices.`,
    };
  }
  return {
    classification: "FLATTENING_HIGH",
    reasoning: `Accuracy ${last.accuracy.mean} with tight interval (${spread.toFixed(2)}) — stable at current n; grow held-out-shaped coverage before claiming reliability.`,
  };
}

/** Merge contact records of one case into unique contact events (records within 60ms are the same strike). */
export function dedupeContacts(
  records: Array<{ caseId: string; contactMs: number }>,
): Array<{ caseId: string; contactMs: number }> {
  const byCase = new Map<string, number[]>();
  for (const record of records) {
    const list = byCase.get(record.caseId) ?? [];
    list.push(record.contactMs);
    byCase.set(record.caseId, list);
  }
  const unique: Array<{ caseId: string; contactMs: number }> = [];
  for (const [caseId, values] of [...byCase.entries()].sort()) {
    values.sort((a, b) => a - b);
    let clusterStart: number | null = null;
    let previous: number | null = null;
    for (const value of values) {
      if (previous === null || value - previous > 60) {
        if (clusterStart !== null) unique.push({ caseId, contactMs: clusterStart });
        clusterStart = value;
      }
      previous = value;
    }
    if (clusterStart !== null) unique.push({ caseId, contactMs: clusterStart });
  }
  return unique;
}

// ── committed-artifact loaders ─────────────────────────────────────────────

interface ManifestCase {
  id: string;
  sessionKey?: string;
  sourceKey?: string;
  role?: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function loadSessionMap(repoRoot: string): Map<string, string> {
  const map = new Map<string, string>();
  const manifests = [
    join(repoRoot, "datasets/paddle-bench/paddle-bench.json"),
    join(repoRoot, "datasets/paddle-bench/event-bounds-wave-a.json"),
  ];
  for (const manifest of manifests) {
    const parsed = readJson<{ cases: ManifestCase[] }>(manifest);
    for (const entry of parsed.cases) {
      if (entry.sessionKey) map.set(entry.id, entry.sessionKey);
    }
  }
  return map;
}

interface CascadeRow {
  caseId: string;
  split: string;
  stages: Record<string, { pass: boolean; detail: string }>;
}

export function loadLatestCascade(repoRoot: string): { path: string; rows: CascadeRow[] } | null {
  const dir = join(repoRoot, "datasets/cascade");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => name.startsWith("cascade-") && name.endsWith(".json"))
    .sort();
  const last = files[files.length - 1];
  if (!last) return null;
  const parsed = readJson<{ rows: CascadeRow[] }>(join(dir, last));
  return { path: join(dir, last), rows: parsed.rows };
}

interface EventLabel {
  eventStartMs: number;
  contactMs: number | null;
  eventEndMs: number;
  owner?: string;
}

interface BundleAnnotation {
  annotatorId: string;
  eventLabels?: EventLabel[];
}

/** The 34-label event gold = wave-a event-bounds labels + the original v1 bundle labels (waveC files are contact RE-observations of existing events, not new events). */
const EVENT_GOLD_ANNOTATORS = new Set(["devin-visual-v2-wave-a", "devin-visual-v1"]);

export function loadBundleEventLabels(
  repoRoot: string,
): Array<{ caseId: string; annotatorId: string; label: EventLabel }> {
  const bundlesDir = join(repoRoot, "datasets/paddle-bench/bundles");
  const out: Array<{ caseId: string; annotatorId: string; label: EventLabel }> = [];
  for (const caseId of readdirSync(bundlesDir).sort()) {
    const annotationDir = join(bundlesDir, caseId, "annotation");
    if (!existsSync(annotationDir)) continue;
    for (const file of readdirSync(annotationDir).sort()) {
      if (!file.endsWith(".json")) continue;
      const parsed = readJson<BundleAnnotation>(join(annotationDir, file));
      for (const label of parsed.eventLabels ?? []) {
        out.push({ caseId, annotatorId: parsed.annotatorId, label });
      }
    }
  }
  return out;
}

export function loadOwnershipRows(
  repoRoot: string,
): Array<{ caseId: string; tMs: number; owners: Record<string, string> }> {
  return readJson<Array<{ caseId: string; tMs: number; owners: Record<string, string> }>>(
    join(repoRoot, "datasets/paddle-bench/ownership-review/ownership-review.json"),
  );
}

export function loadStrokeGold(repoRoot: string): Array<{ caseId: string }> {
  return readJson<{ labels: Array<{ caseId: string }> }>(
    join(repoRoot, "datasets/paddle-bench/stroke-gold.json"),
  ).labels;
}

interface LSummary {
  baseline: { labels: { wrongPlayerCheckPairs: number }; wrongPlayer: string };
  measured: { labels: { wrongPlayerCheckPairs: number }; wrongPlayer: string };
}

/** Ownership label-count-vs-accuracy snapshots quoted from the committed L-summary (never recomputed here). */
export function ownershipSnapshots(repoRoot: string): ModalityReport["snapshots"] {
  const path = join(repoRoot, "datasets/experiments/wave-a/L-summary.json");
  const summary = readJson<LSummary>(path);
  const parse = (text: string) => {
    const match = /(\d+)\/(\d+)/.exec(text);
    if (!match) return null;
    return { wrong: Number(match[1]), total: Number(match[2]) };
  };
  const source = "datasets/experiments/wave-a/L-summary.json";
  const snapshots: ModalityReport["snapshots"] = [];
  const baseline = parse(summary.baseline.wrongPlayer);
  if (baseline)
    snapshots.push({
      labelCount: summary.baseline.labels.wrongPlayerCheckPairs,
      accuracy: Number((1 - baseline.wrong / baseline.total).toFixed(3)),
      counts: `${baseline.total - baseline.wrong}/${baseline.total} dual pairs on the correct player`,
      source: `${source} .baseline.wrongPlayer`,
      caveat: "single measurement, mixed dev+held-out pairs as originally reported",
    });
  const measured = parse(summary.measured.wrongPlayer);
  if (measured)
    snapshots.push({
      labelCount: summary.measured.labels.wrongPlayerCheckPairs,
      accuracy: Number((1 - measured.wrong / measured.total).toFixed(3)),
      counts: `${measured.total - measured.wrong}/${measured.total} dual pairs on the correct player`,
      source: `${source} .measured.wrongPlayer`,
      caveat:
        "all 4 wrong-player pairs are ONE held-out episode (wm-dink-01 @1680-2160, edge-on dink) per the quoted artifact — the dev slice of this measurement has 0 wrong-player pairs",
    });
  return snapshots;
}

// ── report assembly ────────────────────────────────────────────────────────

function labelSupply(
  units: Array<{ caseId: string }>,
  sessionOf: Map<string, string>,
  definition: string,
): ModalityReport["labelSupply"] {
  const dev = units.filter((unit) => !HELD_OUT_CASES.has(unit.caseId));
  const heldOut = units.length - dev.length;
  const perGroup: Record<string, number> = {};
  for (const unit of dev) {
    const group = sessionOf.get(unit.caseId) ?? `UNMAPPED:${unit.caseId}`;
    perGroup[group] = (perGroup[group] ?? 0) + 1;
  }
  return {
    devUnits: dev.length,
    heldOutUnits: heldOut,
    devGroups: Object.keys(perGroup).sort(),
    perGroup,
    definition,
  };
}

function cascadeJoin(
  rows: CascadeRow[],
  stage: string,
  sessionOf: Map<string, string>,
): {
  dev: JoinedUnit[];
  heldOut: Array<{ correct: boolean; detail: string; caseId: string }>;
  perUnit: ModalityReport["joined"]["perUnit"];
} {
  const dev: JoinedUnit[] = [];
  const heldOut: Array<{ correct: boolean; detail: string; caseId: string }> = [];
  const perUnit: ModalityReport["joined"]["perUnit"] = [];
  for (const row of rows) {
    const stageResult = row.stages[stage];
    if (!stageResult) continue;
    if (HELD_OUT_CASES.has(row.caseId)) {
      heldOut.push({ correct: stageResult.pass, detail: stageResult.detail, caseId: row.caseId });
      continue;
    }
    const group = sessionOf.get(row.caseId) ?? `UNMAPPED:${row.caseId}`;
    dev.push({
      unitId: `${row.caseId}:${stage}`,
      caseId: row.caseId,
      group,
      correct: stageResult.pass,
    });
    perUnit.push({
      unitId: `${row.caseId}:${stage}`,
      group,
      correct: stageResult.pass,
      detail: stageResult.detail,
    });
  }
  return { dev, heldOut, perUnit };
}

export function buildReport(repoRoot: string): {
  curveVersion: string;
  modalities: ModalityReport[];
  cascadeSource: string | null;
} {
  const sessionOf = loadSessionMap(repoRoot);
  const cascade = loadLatestCascade(repoRoot);
  const cascadeRows = cascade?.rows ?? [];
  const cascadeSource = cascade ? cascade.path.replace(`${repoRoot}/`, "") : null;
  const modalities: ModalityReport[] = [];

  const make = (
    modality: Modality,
    supply: ModalityReport["labelSupply"],
    stage: string | null,
    snapshots: ModalityReport["snapshots"],
  ): ModalityReport => {
    const join = stage
      ? cascadeJoin(cascadeRows, stage, sessionOf)
      : {
          dev: [] as JoinedUnit[],
          heldOut: [] as Array<{ correct: boolean; detail: string; caseId: string }>,
          perUnit: [] as ModalityReport["joined"]["perUnit"],
        };
    const curve = groupAwareCurve(join.dev);
    const groups = new Set(join.dev.map((unit) => unit.group)).size;
    const curveStops =
      join.dev.length === 0
        ? "no committed per-unit predictions exist for this modality's labels — accuracy curve has zero points (label counts and quoted snapshots only)"
        : groups < 3 || join.dev.length < 6
          ? `curve stops at ${groups} session group(s) / ${join.dev.length} joined dev units — committed predictions (latest lab:cascade artifact, n=5 gold events) do not cover the remaining ${supply.devUnits - join.dev.length} dev labels`
          : null;
    const devAccuracy = join.dev.length
      ? join.dev.filter((unit) => unit.correct).length / join.dev.length
      : null;
    const heldOutAccuracy = join.heldOut.length
      ? join.heldOut.filter((unit) => unit.correct).length / join.heldOut.length
      : null;
    return {
      modality,
      labelSupply: supply,
      joined: {
        devUnits: join.dev.length,
        devGroups: [...new Set(join.dev.map((unit) => unit.group))].sort(),
        predictionSource: stage
          ? `${cascadeSource ?? "MISSING datasets/cascade"} rows[].stages.${stage}`
          : "none committed",
        perUnit: join.perUnit,
      },
      curve,
      curveStops,
      snapshots,
      domainShift:
        join.heldOut.length > 0
          ? {
              devAccuracy: round3(devAccuracy),
              heldOutAccuracy: round3(heldOutAccuracy),
              evidence: join.heldOut.map(
                (unit) => `${unit.caseId}: ${unit.correct ? "pass" : "FAIL"} — ${unit.detail}`,
              ),
            }
          : null,
      verdict: diagnose({
        modality,
        devLabelUnits: supply.devUnits,
        joined: join.dev,
        curve,
        heldOut: join.heldOut,
      }),
    };
  };

  // OWNERSHIP — per-frame sidecar verdicts are the label unit.
  const ownershipRows = loadOwnershipRows(repoRoot).filter((row) =>
    Object.values(row.owners).some((owner) => owner === "target" || owner === "other"),
  );
  modalities.push(
    make(
      "ownership",
      labelSupply(
        ownershipRows,
        sessionOf,
        "ownership-review.json sidecar frames with ≥1 target/other box verdict",
      ),
      null,
      ownershipSnapshots(repoRoot),
    ),
  );

  // CONTACT — unique labeled contact events (records within 60ms of the same case are one strike).
  const contactRecords = loadBundleEventLabels(repoRoot)
    .filter((entry) => entry.label.contactMs !== null && entry.label.contactMs !== undefined)
    .map((entry) => ({ caseId: entry.caseId, contactMs: entry.label.contactMs as number }));
  const uniqueContacts = dedupeContacts(contactRecords);
  modalities.push(
    make(
      "contact",
      labelSupply(
        uniqueContacts,
        sessionOf,
        `unique labeled contact events across committed bundle annotations (${contactRecords.length} records deduped at 60ms → ${uniqueContacts.length} events)`,
      ),
      "CONTACT",
      [],
    ),
  );

  // EVENT — the 34-label gold (wave-a event-bounds + original v1 bundle labels).
  const eventLabels = loadBundleEventLabels(repoRoot).filter((entry) =>
    EVENT_GOLD_ANNOTATORS.has(entry.annotatorId),
  );
  modalities.push(
    make(
      "event",
      labelSupply(
        eventLabels,
        sessionOf,
        "eventLabels entries by devin-visual-v2-wave-a + devin-visual-v1 (the 34-label event gold)",
      ),
      "EVENT",
      [],
    ),
  );

  // STROKE — stroke-gold.json taxonomy labels.
  const strokeLabels = loadStrokeGold(repoRoot);
  modalities.push(
    make(
      "stroke",
      labelSupply(strokeLabels, sessionOf, "stroke-gold.json labels (pickleball-taxonomy-v2)"),
      "STROKE",
      [],
    ),
  );

  return { curveVersion: "modality-learning-curve-v1", modalities, cascadeSource };
}

const isMain = process.argv[1]?.endsWith("learningCurveModality.ts");
if (isMain) {
  const report = buildReport(REPO_ROOT);
  const outDir = join(REPO_ROOT, "datasets/experiments/wave-d4");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "EXP-2026-08-29-d4-02-modality-learning-curves.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        experimentId: "EXP-2026-08-29-d4-02-modality-learning-curves",
        curveVersion: report.curveVersion,
        generatedAtIso: new Date().toISOString(),
        question:
          "Per modality (ownership, contact, event, stroke): is the current accuracy data-limited, model-limited, or domain-shifted — measured as label-count-vs-accuracy curves with group-aware (sessionKey) splits?",
        method:
          "pnpm lab:learning-curve-modality — joins committed labels to committed prediction artifacts (latest lab:cascade rows; ownership wrong-player snapshots quoted from L-summary). Group-aware bootstrap resamples SESSIONS, never frames. Curves stop where committed predictions run out; nothing is fabricated. Held-out cases excluded from all curves; their committed rows quoted read-only as domain-shift evidence.",
        environment:
          "LINUX-CPU artifact-join only — no pipeline was run; no cascade numbers were re-measured on this box",
        cascadeSource: report.cascadeSource,
        modalities: report.modalities,
      },
      null,
      2,
    ),
  );
  console.log("═".repeat(72));
  console.log(
    "MODALITY LEARNING CURVES (group-aware by sessionKey; curves stop where committed predictions run out)",
  );
  for (const entry of report.modalities) {
    console.log(
      `\n${entry.modality.toUpperCase()} — labels: ${entry.labelSupply.devUnits} dev + ${entry.labelSupply.heldOutUnits} held-out across ${entry.labelSupply.devGroups.length} dev session(s); joined predictions: ${entry.joined.devUnits}`,
    );
    for (const point of entry.curve) {
      console.log(
        `  k=${point.groups} sessions (${point.resamples} draws, ~${point.meanUnits} units): accuracy ${point.accuracy.mean ?? "—"} [${point.accuracy.p5 ?? "—"},${point.accuracy.p95 ?? "—"}]`,
      );
    }
    if (entry.curveStops) console.log(`  CURVE STOPS: ${entry.curveStops}`);
    for (const snapshot of entry.snapshots) {
      console.log(
        `  snapshot: n=${snapshot.labelCount} → accuracy ${snapshot.accuracy} (${snapshot.counts}) [${snapshot.source}]`,
      );
    }
    console.log(`  → ${entry.verdict.classification}: ${entry.verdict.reasoning}`);
  }
  console.log(`\nwritten: ${outPath.replace(`${REPO_ROOT}/`, "")}`);
}
