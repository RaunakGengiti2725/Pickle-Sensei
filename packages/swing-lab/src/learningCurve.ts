import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CORPUS_DIR, REPO_ROOT } from "./engine/corpus.js";

/**
 * LEARNING CURVES — scale by evidence, not by magic thresholds.
 *
 *   pnpm lab:learning-curve
 *
 * For each measurable task, bootstrap-subsample the labeled cases at
 * n = 1..N and pool the per-case confusion counts (micro-average), so every
 * release answers: is the metric still moving with more data, has it
 * plateaued, and how unstable is it at the current corpus size?
 *
 * With today's tiny n the honest output is WIDE intervals — the harness
 * exists so that claim is measured, and so future releases inherit curves
 * automatically instead of one-number theater. Dev/val cases only; the
 * locked/held-out cases never enter tuning artifacts like this one.
 */

interface CaseCounts {
  caseId: string;
  hits: number;
  misses: number;
  wrongLocation: number;
  falsePositives: number;
}

interface CurvePoint {
  n: number;
  resamples: number;
  precision: { mean: number | null; p5: number | null; p95: number | null };
  recall: { mean: number | null; p5: number | null; p95: number | null };
}

const HELD_OUT_CASES = new Set(["wm-dink-01", "afn-vic-rally1"]);

function latestResult(dir: string): { path: string; results: CaseCounts[] } | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const last = files[files.length - 1];
  if (!last) return null;
  const parsed = JSON.parse(readFileSync(join(dir, last), "utf8")) as { results: CaseCounts[] };
  return { path: join(dir, last), results: parsed.results.filter((entry) => !HELD_OUT_CASES.has(entry.caseId)) };
}

function pooled(cases: CaseCounts[]): { precision: number | null; recall: number | null } {
  const tp = cases.reduce((total, entry) => total + entry.hits, 0);
  const fn = cases.reduce((total, entry) => total + entry.misses + entry.wrongLocation, 0);
  const fp = cases.reduce((total, entry) => total + entry.falsePositives + entry.wrongLocation, 0);
  return {
    precision: tp + fp > 0 ? tp / (tp + fp) : null,
    recall: tp + fn > 0 ? tp / (tp + fn) : null,
  };
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/** Deterministic PRNG so curve artifacts are reproducible run-to-run. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function curve(cases: CaseCounts[], resamples = 1000): CurvePoint[] {
  const random = mulberry32(20260828);
  const points: CurvePoint[] = [];
  for (let n = 1; n <= cases.length; n += 1) {
    const precisions: number[] = [];
    const recalls: number[] = [];
    const draws = n === cases.length ? 1 : resamples;
    for (let draw = 0; draw < draws; draw += 1) {
      const shuffled = [...cases].sort(() => random() - 0.5).slice(0, n);
      const { precision, recall } = pooled(shuffled);
      if (precision !== null) precisions.push(precision);
      if (recall !== null) recalls.push(recall);
    }
    precisions.sort((a, b) => a - b);
    recalls.sort((a, b) => a - b);
    const mean = (values: number[]) =>
      values.length ? Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(3)) : null;
    points.push({
      n,
      resamples: draws,
      precision: { mean: mean(precisions), p5: round(quantile(precisions, 0.05)), p95: round(quantile(precisions, 0.95)) },
      recall: { mean: mean(recalls), p5: round(quantile(recalls, 0.05)), p95: round(quantile(recalls, 0.95)) },
    });
  }
  return points;
}

const round = (value: number | null) => (value === null ? null : Number(value.toFixed(3)));

function verdict(points: CurvePoint[]): string {
  const last = points[points.length - 1];
  if (!last || points.length < 3) return "n too small for any trend statement";
  // The full-n point is a single draw (degenerate interval); instability must
  // be judged from the widest RESAMPLED point (n-1), which shows how much the
  // metric moves when one case is swapped out.
  const resampled = points[points.length - 2]!;
  const spread = (resampled.recall.p95 ?? 1) - (resampled.recall.p5 ?? 0);
  const delta = Math.abs((last.recall.mean ?? 0) - (resampled.recall.mean ?? 0));
  if (spread > 0.2) {
    return `UNSTABLE at n=${last.n}: leave-one-out recall interval spans ${spread.toFixed(2)} — more labeled cases needed before any reliability claim`;
  }
  if (delta > 0.05) return `still improving at n=${last.n} (Δrecall ${delta.toFixed(3)} on last added case) — more data has high value`;
  return `flattening at n=${last.n} (Δrecall ${delta.toFixed(3)}) — inspect slices before adding bulk data`;
}

const isMain = process.argv[1]?.endsWith("learningCurve.ts");
if (isMain) {
  const tasks = [
    { task: "paddle-detection (dev cases, micro-avg)", dir: join(REPO_ROOT, "datasets/paddle-bench/results") },
    { task: "ball-detection (dev cases, micro-avg)", dir: join(REPO_ROOT, "datasets/ball-bench/results") },
  ];
  const report: Array<{ task: string; source: string; cases: number; points: CurvePoint[]; verdict: string }> = [];
  for (const { task, dir } of tasks) {
    const latest = latestResult(dir);
    if (!latest || latest.results.length === 0) {
      console.log(`${task}: no bench results found`);
      continue;
    }
    const points = curve(latest.results);
    report.push({
      task,
      source: latest.path.replace(`${REPO_ROOT}/`, ""),
      cases: latest.results.length,
      points,
      verdict: verdict(points),
    });
  }
  writeFileSync(
    join(CORPUS_DIR, "learning-curves.json"),
    JSON.stringify({ generatedAtIso: new Date().toISOString(), note: "dev cases only; held-out excluded", tasks: report }, null, 2),
  );
  console.log("═".repeat(72));
  console.log("LEARNING CURVES (bootstrap-subsampled labeled cases, micro-averaged)");
  for (const entry of report) {
    console.log(`\n${entry.task} — ${entry.cases} cases (${entry.source})`);
    console.log("  n  recall mean [p5,p95]      precision mean [p5,p95]");
    for (const point of entry.points) {
      console.log(
        `  ${String(point.n).padEnd(2)} ${String(point.recall.mean ?? "—").padEnd(6)} [${point.recall.p5 ?? "—"},${point.recall.p95 ?? "—"}]`.padEnd(34) +
          ` ${String(point.precision.mean ?? "—").padEnd(6)} [${point.precision.p5 ?? "—"},${point.precision.p95 ?? "—"}]`,
      );
    }
    console.log(`  → ${entry.verdict}`);
  }
  console.log(`\nwritten: datasets/corpus/learning-curves.json`);
}
