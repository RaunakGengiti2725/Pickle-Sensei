// E14 — refreshed learning curves over ALL gold added since D4-02:
//   D04 contact (waveD contact sidecars), D13 stroke (stroke-gold.json growth),
//   D2-06 ball (waveD2 ball sidecars), D2-07 event (waveD2 events sidecars),
//   D2-11 TA (waveD2 ta sidecars + ta-bench cases.json).
//
// Extends the D4-02 instrument (packages/swing-lab/src/learningCurveModality.ts)
// without modifying it: same group-aware (sessionKey) bootstrap, same
// no-fabricated-points rule (an accuracy point exists only where a committed
// label joins a committed prediction artifact), same held-out discipline
// (wm-dink-01, afn-vic-rally1 never enter curves; their committed rows are
// quoted read-only). New here: BALL and TARGET-ACQUISITION curves from the
// committed ball-bench / ta-bench result artifacts, and a cross-subsystem
// ranking of "more data" vs "better features" need.
//
// Run from packages/swing-lab (its tsx + deps):
//   cd packages/swing-lab && npx tsx ../../datasets/experiments/wave-e/e14-learning-curves.ts
//
// LINUX-CPU artifact-join only: no pipeline stage executed, no run dir
// touched, no cascade/bench number re-measured on this box.

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HELD_OUT_CASES,
  type JoinedUnit,
  type CurvePoint,
  groupAwareCurve,
  diagnose,
  dedupeContacts,
  loadSessionMap,
  loadLatestCascade,
  loadStrokeGold,
} from "../../../packages/swing-lab/src/learningCurveModality.js";

const REPO_ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// ── label loaders over the grown gold ───────────────────────────────────────

interface EventLabel {
  eventStartMs: number;
  contactMs: number | null;
  eventEndMs: number;
}

interface EventRecord {
  recordId: string;
  isEvent: boolean;
  startMs: number;
  endMs: number;
  contactMs: number | null;
}

interface BallFrame {
  tMs: number;
  visibility: string;
  occlusionState?: string;
}

interface BundleAnnotation {
  annotatorId: string;
  sessionKey?: string;
  eventLabels?: EventLabel[];
  records?: EventRecord[];
  ballFrames?: BallFrame[];
  strokeLabels?: unknown[];
}

interface BundleFile {
  caseId: string;
  file: string;
  annotation: BundleAnnotation;
}

function loadAllBundleAnnotations(repoRoot: string): BundleFile[] {
  const bundlesDir = join(repoRoot, "datasets/paddle-bench/bundles");
  const out: BundleFile[] = [];
  for (const caseId of readdirSync(bundlesDir).sort()) {
    const annotationDir = join(bundlesDir, caseId, "annotation");
    if (!existsSync(annotationDir)) continue;
    for (const file of readdirSync(annotationDir).sort()) {
      if (!file.endsWith(".json")) continue;
      out.push({ caseId, file, annotation: readJson<BundleAnnotation>(join(annotationDir, file)) });
    }
  }
  return out;
}

/** D4-02's 34-label event gold annotators plus the D2-07 events sidecars. */
const EVENT_GOLD_ANNOTATORS = new Set(["devin-visual-v2-wave-a", "devin-visual-v1"]);
const EVENT_RECORD_FILE = "devin-visual-v4-waveD2-events.json";

// ── committed bench-result loaders (ball, TA) ───────────────────────────────

interface BallBenchCase {
  id: string;
  sessionKey?: string;
  role?: string;
}

interface BallResultRow {
  caseId: string;
  labeledFrames: number;
  visibleFrames: number;
  hits: number;
  misses: number;
  wrongLocation: number;
  falsePositives: number;
}

function loadLatestBallResult(repoRoot: string): { path: string; rows: BallResultRow[] } | null {
  const dir = join(repoRoot, "datasets/ball-bench/results");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => name.startsWith("ball-bench-") && name.endsWith(".json"))
    .sort();
  const last = files[files.length - 1];
  if (!last) return null;
  const parsed = readJson<{ results: BallResultRow[] }>(join(dir, last));
  return { path: join(dir, last), rows: parsed.results };
}

interface TaCase {
  caseId: string;
  sessionKey: string;
  split: string;
  verification: { state: string };
}

interface TaResultRow {
  caseId: string;
  verification: string;
  outcome: string;
  lockCorrect?: boolean;
}

interface TaResultFile {
  variant?: { name?: string; shipped?: boolean };
  results: TaResultRow[];
}

/** Latest committed SHIPPED-variant ta-bench result — the current system's behavior, not a candidate. */
function loadLatestShippedTaResult(repoRoot: string): { path: string; rows: TaResultRow[] } | null {
  const dir = join(repoRoot, "datasets/ta-bench/results");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => name.startsWith("ta-bench-") && name.endsWith(".json"))
    .sort();
  for (let index = files.length - 1; index >= 0; index -= 1) {
    const path = join(dir, files[index]!);
    const parsed = readJson<TaResultFile>(path);
    if (parsed.variant?.shipped) return { path, rows: parsed.results };
  }
  return null;
}

// ── report shape ────────────────────────────────────────────────────────────

interface SubsystemReport {
  subsystem: string;
  labelSupply: {
    devUnits: number;
    heldOutUnits: number;
    devGroups: string[];
    perGroup: Record<string, number>;
    definition: string;
    growthSinceD402: string;
  };
  joined: {
    devUnits: number;
    devGroups: string[];
    predictionSource: string;
  };
  curve: CurvePoint[];
  curveStops: string | null;
  domainShift: {
    devAccuracy: number | null;
    heldOutAccuracy: number | null;
    evidence: string[];
  } | null;
  fit: { classification: string; reasoning: string };
  dataVsFeatures: { call: string; reasoning: string };
}

const round3 = (value: number | null) => (value === null ? null : Number(value.toFixed(3)));

function supplyOf(
  units: Array<{ caseId: string }>,
  sessionOf: Map<string, string>,
  definition: string,
  growthSinceD402: string,
): SubsystemReport["labelSupply"] {
  const dev = units.filter((unit) => !HELD_OUT_CASES.has(unit.caseId));
  const perGroup: Record<string, number> = {};
  for (const unit of dev) {
    const group = sessionOf.get(unit.caseId) ?? `UNMAPPED:${unit.caseId}`;
    perGroup[group] = (perGroup[group] ?? 0) + 1;
  }
  return {
    devUnits: dev.length,
    heldOutUnits: units.length - dev.length,
    devGroups: Object.keys(perGroup).sort(),
    perGroup,
    definition,
    growthSinceD402,
  };
}

function assemble(
  subsystem: string,
  labelSupply: SubsystemReport["labelSupply"],
  devUnits: JoinedUnit[],
  heldOut: Array<{ correct: boolean; detail: string; caseId: string }>,
  predictionSource: string,
  dataVsFeatures: SubsystemReport["dataVsFeatures"],
): SubsystemReport {
  const curve = groupAwareCurve(devUnits);
  const groups = new Set(devUnits.map((unit) => unit.group)).size;
  const curveStops =
    devUnits.length === 0
      ? "no committed per-unit predictions exist for this subsystem's labels — accuracy curve has zero points (label counts only)"
      : groups < 3 || devUnits.length < 6
        ? `curve stops at ${groups} session group(s) / ${devUnits.length} joined dev units — committed predictions do not cover the remaining ${labelSupply.devUnits - devUnits.length} dev labels`
        : null;
  const devAccuracy = devUnits.length
    ? devUnits.filter((unit) => unit.correct).length / devUnits.length
    : null;
  const heldOutAccuracy = heldOut.length
    ? heldOut.filter((unit) => unit.correct).length / heldOut.length
    : null;
  return {
    subsystem,
    labelSupply,
    joined: {
      devUnits: devUnits.length,
      devGroups: [...new Set(devUnits.map((unit) => unit.group))].sort(),
      predictionSource,
    },
    curve,
    curveStops,
    domainShift:
      heldOut.length > 0
        ? {
            devAccuracy: round3(devAccuracy),
            heldOutAccuracy: round3(heldOutAccuracy),
            evidence: heldOut.map(
              (unit) => `${unit.caseId}: ${unit.correct ? "pass" : "FAIL"} — ${unit.detail}`,
            ),
          }
        : null,
    fit: diagnose({
      modality: "event", // diagnose() only uses this for nothing beyond typing; verdict text is generic
      devLabelUnits: labelSupply.devUnits,
      joined: devUnits,
      curve,
      heldOut,
    }),
    dataVsFeatures,
  };
}

// ── build ───────────────────────────────────────────────────────────────────

function build(): void {
  const sessionOf = loadSessionMap(REPO_ROOT);
  const bundles = loadAllBundleAnnotations(REPO_ROOT);
  const cascade = loadLatestCascade(REPO_ROOT);
  const cascadeRows = cascade?.rows ?? [];
  const cascadeSource = cascade ? cascade.path.replace(`${REPO_ROOT}/`, "") : "MISSING";
  const subsystems: SubsystemReport[] = [];

  const cascadeJoin = (stage: string) => {
    const dev: JoinedUnit[] = [];
    const heldOut: Array<{ correct: boolean; detail: string; caseId: string }> = [];
    for (const row of cascadeRows) {
      const stageResult = row.stages[stage];
      if (!stageResult) continue;
      if (HELD_OUT_CASES.has(row.caseId)) {
        heldOut.push({ correct: stageResult.pass, detail: stageResult.detail, caseId: row.caseId });
        continue;
      }
      dev.push({
        unitId: `${row.caseId}:${stage}`,
        caseId: row.caseId,
        group: sessionOf.get(row.caseId) ?? `UNMAPPED:${row.caseId}`,
        correct: stageResult.pass,
      });
    }
    return { dev, heldOut };
  };

  // CONTACT — every committed contact observation (eventLabels contactMs across
  // all annotators, now including devin-visual-v3-waveD-contact.json, plus the
  // D2-07 event records with a contactMs), deduped at 60ms into unique strikes.
  const contactRecords: Array<{ caseId: string; contactMs: number }> = [];
  for (const bundle of bundles) {
    for (const label of bundle.annotation.eventLabels ?? []) {
      if (label.contactMs !== null && label.contactMs !== undefined)
        contactRecords.push({ caseId: bundle.caseId, contactMs: label.contactMs });
    }
    if (bundle.file === EVENT_RECORD_FILE) {
      for (const record of bundle.annotation.records ?? []) {
        if (record.contactMs !== null && record.contactMs !== undefined)
          contactRecords.push({ caseId: bundle.caseId, contactMs: record.contactMs });
      }
    }
  }
  const uniqueContacts = dedupeContacts(contactRecords);
  {
    const { dev, heldOut } = cascadeJoin("CONTACT");
    subsystems.push(
      assemble(
        "contact",
        supplyOf(
          uniqueContacts,
          sessionOf,
          `unique labeled contact events (${contactRecords.length} committed records deduped at 60ms → ${uniqueContacts.length})`,
          "D4-02 measured 28 dev unique contacts; D04 + D2-07 grew the committed record pool (D04 waveD contact sidecars, D2-07 event records with contactMs)",
        ),
        dev,
        heldOut,
        `${cascadeSource} rows[].stages.CONTACT`,
        {
          call: "MORE_PREDICTIONS_FIRST (then more data on held-out-shaped slices)",
          reasoning:
            "Joined coverage is still the n=5 cascade gold; dev 2/3 vs held-out 0/2 (250/245ms misses) is a domain-shift signature on committed rows. The un-run measurement (Mac bench over the grown contact set) decides data- vs feature-limited; the held-out failure shape (edge-on/occluded contact) argues the next labels should target those slices, not more of the same.",
        },
      ),
    );
  }

  // EVENT — D4-02's 34-label gold + the 12 D2-07 records (7 events, 5 explicit non-events).
  const eventUnits: Array<{ caseId: string }> = [];
  let d207Events = 0;
  let d207NonEvents = 0;
  for (const bundle of bundles) {
    if (EVENT_GOLD_ANNOTATORS.has(bundle.annotation.annotatorId ?? "")) {
      for (const _label of bundle.annotation.eventLabels ?? [])
        eventUnits.push({ caseId: bundle.caseId });
    }
    if (bundle.file === EVENT_RECORD_FILE) {
      for (const record of bundle.annotation.records ?? []) {
        eventUnits.push({ caseId: bundle.caseId });
        if (record.isEvent) d207Events += 1;
        else d207NonEvents += 1;
      }
    }
  }
  {
    const { dev, heldOut } = cascadeJoin("EVENT");
    subsystems.push(
      assemble(
        "event",
        supplyOf(
          eventUnits,
          sessionOf,
          `event gold records (34-label D4-02 gold + ${d207Events + d207NonEvents} D2-07 records: ${d207Events} events, ${d207NonEvents} explicit non-events)`,
          "34 → 46 records (D2-07 added 12 on 3 previously under-labeled bundles, incl. first explicit non-events)",
        ),
        dev,
        heldOut,
        `${cascadeSource} rows[].stages.EVENT`,
        {
          call: "MORE_PREDICTIONS_FIRST — label supply is NOT the bottleneck",
          reasoning:
            "41 dev event records exist; 3 have joined predictions. HANDOFF ranks EVENT bottleneck #1 and D2-07 added the first explicit non-events (false-positive probes) — a Mac regen/bench pass over this corpus is worth more than any further labeling.",
        },
      ),
    );
  }

  // STROKE — stroke-gold.json (22 → 29 labels after D13).
  const strokeLabels = loadStrokeGold(REPO_ROOT);
  {
    const { dev, heldOut } = cascadeJoin("STROKE");
    subsystems.push(
      assemble(
        "stroke",
        supplyOf(
          strokeLabels,
          sessionOf,
          "stroke-gold.json labels (pickleball-taxonomy-v2)",
          "22 → 29 labels (D13 added 7; every committed non-held-out dev bundle event now has a stroke label — 29/29 saturated; return/drop_reset/attack_counter/specialty families remain at ZERO gold, closable only with new footage)",
        ),
        dev,
        heldOut,
        `${cascadeSource} rows[].stages.STROKE`,
        {
          call: "MORE_DATA (new footage) — dev-corpus labeling is saturated",
          reasoning:
            "D13 proved the dev corpus is exhausted (29/29 events labeled, 4 L1 families at zero). More labeling passes cannot help; only new footage grows this gold. The held-out confidently-wrong BACKHAND row is the failure more family coverage should fix.",
        },
      ),
    );
  }

  // BALL — every committed ballFrames label vs the latest committed ball-bench result.
  const ballLabelUnits: Array<{ caseId: string }> = [];
  for (const bundle of bundles) {
    for (const _frame of bundle.annotation.ballFrames ?? [])
      ballLabelUnits.push({ caseId: bundle.caseId });
  }
  const ballResult = loadLatestBallResult(REPO_ROOT);
  const ballManifest = readJson<{ cases: BallBenchCase[] }>(
    join(REPO_ROOT, "datasets/ball-bench/ball-bench.json"),
  );
  const ballSession = new Map<string, string>();
  for (const entry of ballManifest.cases) {
    if (entry.sessionKey) ballSession.set(entry.id, entry.sessionKey);
  }
  {
    const dev: JoinedUnit[] = [];
    const heldOut: Array<{ correct: boolean; detail: string; caseId: string }> = [];
    for (const row of ballResult?.rows ?? []) {
      if (row.visibleFrames === 0) continue;
      const group =
        ballSession.get(row.caseId) ?? sessionOf.get(row.caseId) ?? `UNMAPPED:${row.caseId}`;
      // per-frame outcome units reconstructed from committed per-case counts:
      // hits are correct; misses + wrongLocation are incorrect (denominator = visibleFrames).
      const outcomes: boolean[] = [
        ...Array<boolean>(row.hits).fill(true),
        ...Array<boolean>(row.misses + row.wrongLocation).fill(false),
      ];
      outcomes.forEach((correct, index) => {
        if (HELD_OUT_CASES.has(row.caseId)) {
          heldOut.push({
            correct,
            detail: `frame ${index + 1}/${row.visibleFrames} (${row.hits} hits, ${row.misses} misses, ${row.wrongLocation} wrongLocation)`,
            caseId: row.caseId,
          });
          return;
        }
        dev.push({
          unitId: `${row.caseId}:ball:${index}`,
          caseId: row.caseId,
          group,
          correct,
        });
      });
    }
    subsystems.push(
      assemble(
        "ball",
        supplyOf(
          ballLabelUnits,
          sessionOf,
          "committed ballFrames labels across all bundle annotation sidecars (incl. D2-06 waveD2 hard-slice labels and C04 occlusion-state labels)",
          "D2-06 added 43 labels on 4 bundles targeting hard slices (net crossings, paddle occlusion, multi-ball, fast blur, occlusion cycles); 2 of those 4 bundles are not even in ball-bench.json yet",
        ),
        dev,
        heldOut,
        ballResult
          ? `${ballResult.path.replace(`${REPO_ROOT}/`, "")} per-case hit/miss/wrongLocation counts (Mac run, predates D2-06 labels)`
          : "MISSING datasets/ball-bench/results",
        {
          call: "MORE_PREDICTIONS_FIRST — bench manifest and results lag the labels",
          reasoning:
            "100 dev ball labels exist but the latest committed bench result predates D2-06 and covers only the 3 original dev cases (12 visible-frame outcomes over 2 sessions). Wiring wavea-wgm-wheelchair + wavea-sasebo-volleys into ball-bench.json and one Mac bench run converts a 2-session curve into a 4-session one for free. The rally1 0/4 all-miss row suggests feature work (reacquisition) but at n too small to call.",
        },
      ),
    );
  }

  // TARGET ACQUISITION — verified ta-bench cases vs the latest committed SHIPPED result.
  const taCases = readJson<{ cases: TaCase[] }>(join(REPO_ROOT, "datasets/ta-bench/cases.json"));
  const taCaseById = new Map(taCases.cases.map((entry) => [entry.caseId, entry]));
  const taVerifiedDev = taCases.cases.filter(
    (entry) => entry.split === "dev" && entry.verification.state === "verified",
  );
  const taVerifiedHeldOut = taCases.cases.filter(
    (entry) => entry.split !== "dev" && entry.verification.state === "verified",
  );
  // D2-11 sidecar torso-box records are a different unit (per-frame boxes, not
  // lock outcomes); counted in the supply note, never mixed into the curve.
  let d211Records = 0;
  for (const bundle of bundles) {
    if (bundle.file === "devin-visual-v4-waveD2-ta.json")
      d211Records += (bundle.annotation.records ?? []).length;
  }
  const taResult = loadLatestShippedTaResult(REPO_ROOT);
  {
    const dev: JoinedUnit[] = [];
    const heldOut: Array<{ correct: boolean; detail: string; caseId: string }> = [];
    for (const row of taResult?.rows ?? []) {
      const meta = taCaseById.get(row.caseId);
      if (!meta || meta.verification.state !== "verified") continue;
      const correct = row.outcome === "locked" && row.lockCorrect === true;
      if (meta.split !== "dev") {
        heldOut.push({
          correct,
          detail: `${row.outcome}${row.lockCorrect ? "" : " wrong-target"}`,
          caseId: row.caseId,
        });
        continue;
      }
      dev.push({
        unitId: `${row.caseId}:ta`,
        caseId: row.caseId,
        group: meta.sessionKey,
        correct,
      });
    }
    const perGroup: Record<string, number> = {};
    for (const entry of taVerifiedDev)
      perGroup[entry.sessionKey] = (perGroup[entry.sessionKey] ?? 0) + 1;
    subsystems.push(
      assemble(
        "target_acquisition",
        {
          devUnits: taVerifiedDev.length,
          heldOutUnits: taVerifiedHeldOut.length,
          devGroups: Object.keys(perGroup).sort(),
          perGroup,
          definition: `verified ta-bench cases (dev split); plus ${d211Records} D2-11 per-frame torso-box records in waveD2-ta sidecars (different unit — supply-only, never joined to lock outcomes)`,
          growthSinceD402:
            "TA had NO curve in D4-02. Verified dev cases now 54 across 5 sessions (K wave 36→59 + D2-04/D2-11 passes); D2-11 added 12 per-frame contested/uncontested torso records on 3 bundles",
        },
        dev,
        heldOut,
        taResult
          ? `${taResult.path.replace(`${REPO_ROOT}/`, "")} (SHIPPED variant) per-case outcome+lockCorrect`
          : "MISSING shipped ta-bench result",
        {
          call: "BETTER_FEATURES — first subsystem with a full-supply measured curve, and it is slice-shaped, not n-shaped",
          reasoning:
            "All 54 verified dev cases have joined shipped predictions (the only subsystem at 100% join coverage). Shipped lock-correct is 37/54 = 0.685 with extreme session spread (warriorgames 14/15 = .93 vs sigonella 1/4 = .25, sasebo 3/7 = .43): the error mass is concentrated in contested/ambiguous sessions, and the committed candidate bench (acquire-v4-strict-gesture, same 54 cases) already measures .863 — feature/config work moves this metric 3x more than any plausible labeling effort. More verified cases in sigonella/sasebo-shaped scenes would still sharpen the slice estimate (n=4 and 7).",
        },
      ),
    );
  }

  // ── cross-subsystem ranking ───────────────────────────────────────────────
  const ranking = [
    {
      rank: 1,
      subsystem: "event",
      needs: "PREDICTIONS (Mac regen/bench over the 41-dev-record corpus), then features",
      why: "Bottleneck #1 per HANDOFF; 41 dev records incl. first explicit non-events vs 3 joined predictions — the largest supply-to-measurement gap of any subsystem, and the gate for everything downstream of it.",
    },
    {
      rank: 2,
      subsystem: "contact",
      needs: "PREDICTIONS first; then held-out-shaped DATA (edge-on/occluded contact slices)",
      why: "Grown contact gold is unmeasured; committed rows already show a dev→held-out shift (0.667 vs 0.0), so after the Mac pass the next labels must be slice-targeted, not bulk.",
    },
    {
      rank: 3,
      subsystem: "ball",
      needs:
        "PREDICTIONS + bench-manifest wiring (2 labeled bundles missing from ball-bench.json), then features (reacquisition)",
      why: "100 dev labels vs 12 joined frame outcomes; one manifest edit + one Mac run doubles curve sessions. rally1 0/4 all-miss hints at a reacquisition feature gap but n is too small to call.",
    },
    {
      rank: 4,
      subsystem: "target_acquisition",
      needs:
        "FEATURES/config (candidate already measured at .863 vs shipped .685); secondary: verified cases in low-n contested sessions",
      why: "Only subsystem with a full-supply curve. The curve says the problem is slice-shaped (session spread .25–.93), and a committed candidate config already recovers most of the gap — that is a features verdict, not a data verdict.",
    },
    {
      rank: 5,
      subsystem: "stroke",
      needs:
        "DATA (new footage for the 4 empty L1 families) — labeling of existing footage is saturated",
      why: "D13 saturated the dev corpus (29/29). No labeling pass can grow this gold; only new footage (or the Mac bench pass over the 29) moves it. Ranked last for THIS wave because its next step is externally gated (footage supply).",
    },
  ];

  const artifact = {
    experimentId: "EXP-2026-08-29-e14-learning-curves",
    curveVersion: "modality-learning-curve-v2-e14",
    extends: "datasets/experiments/wave-d4/EXP-2026-08-29-d4-02-modality-learning-curves.json",
    generatedAtIso: new Date().toISOString(),
    question:
      "With ALL gold added since D4-02 (D04 contact, D13 stroke, D2-06 ball, D2-07 event, D2-11 TA): per subsystem, is accuracy under- or over-fit (data-limited vs feature-limited vs domain-shifted), and which subsystem most needs more data vs better features?",
    method:
      "Joins committed labels to committed prediction artifacts only (latest lab:cascade rows for contact/event/stroke; latest committed ball-bench result; latest committed SHIPPED-variant ta-bench result). Group-aware bootstrap resamples SESSIONS (sessionKey), never frames. Curves stop where committed predictions run out; nothing is fabricated. Held-out cases (wm-dink-01, afn-vic-rally1) excluded from all curves; their committed rows quoted read-only.",
    environment:
      "LINUX-CPU artifact-join only — no pipeline stage was run; no cascade/bench number was re-measured on this box",
    predictionSources: {
      cascade: cascadeSource,
      ballBench: ballResult ? ballResult.path.replace(`${REPO_ROOT}/`, "") : null,
      taBench: taResult ? taResult.path.replace(`${REPO_ROOT}/`, "") : null,
    },
    subsystems,
    ranking,
  };

  const outDir = join(REPO_ROOT, "datasets/experiments/wave-e");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "EXP-2026-08-29-e14-learning-curves.json");
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

  console.log("═".repeat(72));
  console.log("E14 REFRESHED LEARNING CURVES (group-aware by sessionKey)");
  for (const entry of subsystems) {
    console.log(
      `\n${entry.subsystem.toUpperCase()} — labels: ${entry.labelSupply.devUnits} dev + ${entry.labelSupply.heldOutUnits} held-out across ${entry.labelSupply.devGroups.length} dev session(s); joined: ${entry.joined.devUnits}`,
    );
    for (const point of entry.curve) {
      console.log(
        `  k=${point.groups} sessions (${point.resamples} draws, ~${point.meanUnits} units): accuracy ${point.accuracy.mean ?? "—"} [${point.accuracy.p5 ?? "—"},${point.accuracy.p95 ?? "—"}]`,
      );
    }
    if (entry.curveStops) console.log(`  CURVE STOPS: ${entry.curveStops}`);
    if (entry.domainShift)
      console.log(
        `  domain shift: dev ${entry.domainShift.devAccuracy} vs held-out ${entry.domainShift.heldOutAccuracy}`,
      );
    console.log(`  fit → ${entry.fit.classification}: ${entry.fit.reasoning}`);
    console.log(`  need → ${entry.dataVsFeatures.call}`);
  }
  console.log("\nRANKING (drives next wave):");
  for (const row of ranking) console.log(`  ${row.rank}. ${row.subsystem} — ${row.needs}`);
  console.log(`\nwritten: ${outPath.replace(`${REPO_ROOT}/`, "")}`);
}

build();
