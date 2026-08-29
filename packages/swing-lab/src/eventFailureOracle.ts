import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import { dominantWristSpeeds } from "./engine/minerCore.js";
import { buildPlayerTracks, targetPoseSequence, type PeopleFile } from "./playerTracker.js";
import {
  proposeStrokeEventsV2,
  selectTargetEventV2,
  type StrokeEventProposalV2,
} from "./strokeEvents.js";
import type { StrokeEventLabel, SwingAnnotation } from "./annotationSchema.js";

/**
 * EVENT-FAILURE ORACLE (wave-d D06) — perception-vs-logic attribution.
 *
 *   pnpm --filter @pickle/swing-lab exec tsx src/eventFailureOracle.ts
 *
 * For every gold TARGET event that the event stage misses or mis-bounds,
 * attribute the failure to one class, using RECORDED signals only:
 *
 *   POSE_SIGNAL_ABSENT      — auto-target wrist series has <3 samples inside
 *                             the gold span (pose/identity coverage failure).
 *   SAMPLING                — samples exist but the series has a gap >200ms
 *                             inside the gold span or covers <50% of it.
 *   WRIST_SIGNAL_QUALITY    — the in-span smoothed wrist peak is below the
 *                             proposal gates (max(0.5, 30% of global peak)):
 *                             the signal never rises to "swing" for this event.
 *   EVENT_LOGIC             — the wrist signal supports the event (distinct
 *                             in-span peak above gates) yet the proposal set
 *                             misses or mis-bounds it: the proposal/merge/
 *                             boundary logic is the proven cause.
 *   CONTACT_ANCHOR_ABSENT   — a proposal covering gold exists, but SELECTION
 *                             failed because the contact estimator abstained
 *                             (recorded) and prominence could not disambiguate
 *                             — perception coverage, not event logic.
 *   UNATTRIBUTABLE_HERE     — no committed signal artifact covers this case
 *                             on Linux; the named Mac artifact would decide.
 *
 * Signals used (all committed): datasets/paddle-bench/runs-wave-a/<case>/people.json
 * (windowed pose views), apps/mobile/__tests__/fixtures/
 * sessionReplay.afn-sasebo-rally1.json (W6 replay-validated target wrist
 * series), datasets/cascade/cascade-1787971753680.json (recorded Mac
 * selections for the n=5 bundle cases), datasets/experiments/wave-a/
 * E-replay-validation.json (recorded batch proposals for both dev rallies).
 * Paddle-speed series are NOT committed for any of these cases, so
 * paddle-confirmation is structurally unavailable in every Linux replay —
 * recorded per row, never guessed. This tool writes NO labels and changes
 * NO pipeline behavior.
 */

const PB = join(REPO_ROOT, "datasets/paddle-bench");
const CASCADE_ARTIFACT = "datasets/cascade/cascade-1787971753680.json";
const RALLY1_FIXTURE = "apps/mobile/__tests__/fixtures/sessionReplay.afn-sasebo-rally1.json";

type AttributionClass =
  | "POSE_SIGNAL_ABSENT"
  | "SAMPLING"
  | "WRIST_SIGNAL_QUALITY"
  | "EVENT_LOGIC"
  | "CONTACT_ANCHOR_ABSENT"
  | "UNATTRIBUTABLE_HERE";

interface Speed {
  timestampMs: number;
  value: number;
}

interface GoldEvent {
  caseId: string;
  eventKey: string;
  split: string;
  label: StrokeEventLabel;
}

interface OracleRow {
  eventKey: string;
  split: string;
  goldSpanMs: [number, number];
  goldContactMs: number | null;
  signalSource: string;
  outcome: "PROPOSED_OK" | "MISSED" | "MIS_BOUNDED" | "SELECTION_FAILED" | "NOT_REPLAYABLE";
  attribution: AttributionClass | null;
  evidence: string;
  signalStats: {
    samplesInside: number;
    spanCoverage: number | null;
    maxGapMs: number | null;
    smoothedPeakInside: number | null;
    proposalGate: number | null;
  } | null;
  matchedProposal: { startMs: number; endMs: number; overlapOfGold: number } | null;
}

function smooth(series: readonly Speed[]): Speed[] {
  const sorted = [...series].sort((a, b) => a.timestampMs - b.timestampMs);
  return sorted.map((sample, index) => {
    const window = sorted.slice(Math.max(0, index - 1), index + 2);
    return {
      timestampMs: sample.timestampMs,
      value: window.reduce((total, entry) => total + entry.value, 0) / window.length,
    };
  });
}

export function overlapOfGold(
  proposal: { startMs: number; endMs: number },
  label: StrokeEventLabel,
): number {
  const overlap =
    Math.min(proposal.endMs, label.eventEndMs) - Math.max(proposal.startMs, label.eventStartMs);
  return overlap / (label.eventEndMs - label.eventStartMs);
}

/** Recorded-signal stats inside the gold span, mirroring proposal gates. */
export function signalStatsFor(speeds: readonly Speed[], label: StrokeEventLabel) {
  const smoothed = smooth(speeds);
  const inside = smoothed.filter(
    (sample) => sample.timestampMs >= label.eventStartMs && sample.timestampMs <= label.eventEndMs,
  );
  const span = label.eventEndMs - label.eventStartMs;
  let maxGap: number | null = null;
  if (inside.length >= 2) {
    maxGap = 0;
    for (let index = 1; index < inside.length; index += 1) {
      maxGap = Math.max(maxGap, inside[index]!.timestampMs - inside[index - 1]!.timestampMs);
    }
  }
  const coverage =
    inside.length >= 2
      ? (inside[inside.length - 1]!.timestampMs - inside[0]!.timestampMs) / span
      : inside.length > 0
        ? 0
        : null;
  const globalPeak = smoothed.reduce((best, sample) => Math.max(best, sample.value), 0);
  const gate = Math.max(0.5, 0.3 * globalPeak);
  const peakInside = inside.reduce((best, sample) => Math.max(best, sample.value), 0);
  return {
    samplesInside: inside.length,
    spanCoverage: coverage !== null ? Number(coverage.toFixed(2)) : null,
    maxGapMs: maxGap !== null ? Math.round(maxGap) : null,
    smoothedPeakInside: inside.length > 0 ? Number(peakInside.toFixed(3)) : null,
    proposalGate: Number(gate.toFixed(3)),
  };
}

export function attributeReplayFailure(
  stats: ReturnType<typeof signalStatsFor>,
  outcome: "MISSED" | "MIS_BOUNDED",
  matched: { startMs: number; endMs: number } | null,
  label: StrokeEventLabel,
  seriesBounds: { firstMs: number; lastMs: number },
  caseId: string,
): { attribution: AttributionClass; evidence: string } {
  if (seriesBounds.firstMs > label.eventStartMs || seriesBounds.lastMs < label.eventEndMs) {
    return {
      attribution: "UNATTRIBUTABLE_HERE",
      evidence: `the committed windowed wrist series (${Math.round(seriesBounds.firstMs)}–${Math.round(seriesBounds.lastMs)}ms) does not fully cover the gold span ${label.eventStartMs}–${label.eventEndMs}ms — whether the pipeline would propose on the full signal is undecidable from this window; deciding artifact: datasets/paddle-bench/runs/${caseId}/people.json (Mac, full-clip pose extraction)`,
    };
  }
  if (stats.samplesInside < 3) {
    return {
      attribution: "POSE_SIGNAL_ABSENT",
      evidence: `only ${stats.samplesInside} target wrist samples inside gold span (<3): pose/identity coverage failure, not logic`,
    };
  }
  if (
    (stats.maxGapMs !== null && stats.maxGapMs > 200) ||
    (stats.spanCoverage !== null && stats.spanCoverage < 0.5)
  ) {
    return {
      attribution: "SAMPLING",
      evidence: `wrist series inside gold span is sparse (maxGap ${stats.maxGapMs}ms, span coverage ${stats.spanCoverage}): sampling failure precedes any logic decision`,
    };
  }
  if (stats.smoothedPeakInside !== null && stats.smoothedPeakInside < stats.proposalGate) {
    return {
      attribution: "WRIST_SIGNAL_QUALITY",
      evidence: `in-span smoothed wrist peak ${stats.smoothedPeakInside} is below the proposal gate ${stats.proposalGate} (max(0.5, 30% of global peak)): the recorded signal never reads as a swing here`,
    };
  }
  const boundNote = matched
    ? `matched proposal ${Math.round(matched.startMs)}–${Math.round(matched.endMs)} vs gold ${label.eventStartMs}–${label.eventEndMs}`
    : "no proposal overlaps gold despite an above-gate in-span peak";
  return {
    attribution: "EVENT_LOGIC",
    evidence: `${boundNote}; wrist signal supports the event (peak ${stats.smoothedPeakInside} ≥ gate ${stats.proposalGate}, coverage ${stats.spanCoverage}, maxGap ${stats.maxGapMs}ms) — the proposal/merge/boundary logic is the cause`,
  };
}

const isMain = process.argv[1]?.endsWith("eventFailureOracle.ts");
if (isMain) {
  // ── Gold events (34 committed labels; target-owner only for the oracle:
  //    the pipeline proposes TARGET events; other-owner labels measure
  //    contamination, not event recall) ─────────────────────────────────
  const cases: Array<{ id: string; labels: string; runDir: string; role?: string }> = [];
  const bench = JSON.parse(readFileSync(join(PB, "paddle-bench.json"), "utf8")) as {
    cases: Array<{ id: string; labels: string; runDir: string; role?: string }>;
  };
  cases.push(...bench.cases);
  const waveAPath = join(PB, "event-bounds-wave-a.json");
  if (existsSync(waveAPath)) {
    cases.push(...(JSON.parse(readFileSync(waveAPath, "utf8")) as { cases: typeof cases }).cases);
  }
  const gold: GoldEvent[] = [];
  let otherOwnerCount = 0;
  for (const benchCase of cases) {
    const annotation = JSON.parse(
      readFileSync(resolve(PB, benchCase.labels), "utf8"),
    ) as SwingAnnotation & {
      eventLabels?: StrokeEventLabel[];
    };
    (annotation.eventLabels ?? []).forEach((label, index) => {
      if (label.owner !== "target") {
        otherOwnerCount += 1;
        return;
      }
      gold.push({
        caseId: benchCase.id,
        eventKey: `${benchCase.id}#${index + 1}`,
        split: benchCase.role ?? "unassigned",
        label,
      });
    });
  }

  // ── Recorded signal sources ──────────────────────────────────────────
  const wristSeriesFor = (benchCase: {
    id: string;
    runDir: string;
  }): { speeds: Speed[]; source: string } | null => {
    const peoplePath = resolve(PB, benchCase.runDir, "people.json");
    if (existsSync(peoplePath)) {
      const people = JSON.parse(readFileSync(peoplePath, "utf8")) as PeopleFile;
      const tracks = buildPlayerTracks(people);
      if (tracks.length === 0) return null;
      const target = [...tracks].sort(
        (a, b) => b.coverage * b.meanTorsoSpan - a.coverage * a.meanTorsoSpan,
      )[0]!;
      return {
        speeds: dominantWristSpeeds(targetPoseSequence(people, target).frames),
        source: `${benchCase.runDir}/people.json (auto-target wrist series, replayed)`,
      };
    }
    if (benchCase.id === "afn-sasebo-rally1") {
      const fixture = JSON.parse(readFileSync(join(REPO_ROOT, RALLY1_FIXTURE), "utf8")) as {
        wristSamples: Array<{ tMs: number; v: number }>;
      };
      return {
        speeds: fixture.wristSamples.map((sample) => ({
          timestampMs: sample.tMs,
          value: sample.v,
        })),
        source: `${RALLY1_FIXTURE} (W6 replay-validated tap-seeded target wrist series)`,
      };
    }
    return null;
  };

  // Recorded Mac cascade selections for the 5 bundle cases (evidence for
  // cases with no Linux-replayable signal).
  const cascade = JSON.parse(readFileSync(join(REPO_ROOT, CASCADE_ARTIFACT), "utf8")) as {
    rows: Array<{ caseId: string; stages: { EVENT: { pass: boolean; detail: string } } }>;
  };
  const cascadeEventOf = (caseId: string) =>
    cascade.rows.find((row) => row.caseId === caseId)?.stages.EVENT ?? null;

  // Recorded Mac batch proposals (wave-a workstream E replay validation)
  // — usable as proposal evidence for cases with no Linux-replayable series.
  const EREPLAY_ARTIFACT = "datasets/experiments/wave-a/E-replay-validation.json";
  const eReplay = JSON.parse(readFileSync(join(REPO_ROOT, EREPLAY_ARTIFACT), "utf8")) as {
    runs: Array<{
      runId: string;
      batchVsEmitted: Array<{ batch: { startMs: number; endMs: number } }>;
    }>;
  };
  const recordedProposalsOf = (caseId: string) =>
    eReplay.runs.find((run) => run.runId === caseId)?.batchVsEmitted.map((pair) => pair.batch) ??
    null;

  const rows: OracleRow[] = [];
  const proposalsByCase = new Map<string, StrokeEventProposalV2[]>();
  for (const benchCase of cases) {
    const series = wristSeriesFor(benchCase);
    if (!series) continue;
    const clipStart = series.speeds[0]?.timestampMs ?? 0;
    const clipEnd = series.speeds[series.speeds.length - 1]?.timestampMs ?? 1;
    const { events } = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: series.speeds,
      clipStartMs: clipStart,
      clipEndMs: clipEnd,
    });
    proposalsByCase.set(benchCase.id, events);
  }

  for (const entry of gold) {
    const benchCase = cases.find((candidate) => candidate.id === entry.caseId)!;
    const series = wristSeriesFor(benchCase);
    const proposals = proposalsByCase.get(entry.caseId) ?? null;
    if (!series || !proposals) {
      const recordedBatch = recordedProposalsOf(entry.caseId);
      if (recordedBatch) {
        const bestRecorded = recordedBatch
          .map((proposal) => ({ proposal, fraction: overlapOfGold(proposal, entry.label) }))
          .filter((candidate) => candidate.fraction > 0.3)
          .sort((a, b) => b.fraction - a.fraction)[0];
        if (bestRecorded && bestRecorded.fraction >= 0.5) {
          rows.push({
            eventKey: entry.eventKey,
            split: entry.split,
            goldSpanMs: [entry.label.eventStartMs, entry.label.eventEndMs],
            goldContactMs: entry.label.contactMs,
            signalSource: `${EREPLAY_ARTIFACT} (recorded Mac batch proposals)`,
            outcome: "PROPOSED_OK",
            attribution: null,
            evidence: `recorded batch proposal ${Math.round(bestRecorded.proposal.startMs)}–${Math.round(bestRecorded.proposal.endMs)} covers gold ${entry.label.eventStartMs}–${entry.label.eventEndMs} (overlap ${bestRecorded.fraction.toFixed(2)})`,
            signalStats: null,
            matchedProposal: {
              startMs: Math.round(bestRecorded.proposal.startMs),
              endMs: Math.round(bestRecorded.proposal.endMs),
              overlapOfGold: Number(bestRecorded.fraction.toFixed(2)),
            },
          });
          continue;
        }
      }
      const recorded = cascadeEventOf(entry.caseId);
      const isPrimary =
        recorded !== null &&
        // cascade evaluated the bundle's PRIMARY gold event (the one holding
        // phases.contactMs); only that event may cite the recorded verdict.
        entry.eventKey.endsWith("#1");
      rows.push({
        eventKey: entry.eventKey,
        split: entry.split,
        goldSpanMs: [entry.label.eventStartMs, entry.label.eventEndMs],
        goldContactMs: entry.label.contactMs,
        signalSource: isPrimary ? `${CASCADE_ARTIFACT} (recorded Mac selection)` : "none committed",
        outcome: isPrimary ? (recorded!.pass ? "PROPOSED_OK" : "MIS_BOUNDED") : "NOT_REPLAYABLE",
        attribution: isPrimary && recorded!.pass ? null : "UNATTRIBUTABLE_HERE",
        evidence: isPrimary
          ? `recorded Mac cascade: ${recorded!.detail}. Wrist/paddle series for this case are not committed — deciding artifact: datasets/paddle-bench/runs/${entry.caseId}/{people.json,report.json} (Mac, pnpm lab:regen)`
          : `no committed wrist/pose artifact covers this case on Linux — deciding artifact: datasets/paddle-bench/runs/${entry.caseId}/people.json (Mac pose extraction)`,
        signalStats: null,
        matchedProposal: null,
      });
      continue;
    }

    const stats = signalStatsFor(series.speeds, entry.label);
    const overlapping = proposals
      .map((proposal) => ({ proposal, fraction: overlapOfGold(proposal, entry.label) }))
      .filter((candidate) => candidate.fraction > 0.3)
      .sort((a, b) => b.fraction - a.fraction);
    const best = overlapping[0] ?? null;
    const contactInside =
      best !== null &&
      entry.label.contactMs !== null &&
      entry.label.contactMs >= best.proposal.startMs - 60 &&
      entry.label.contactMs <= best.proposal.endMs + 60;
    const cascadePass = best !== null && (best.fraction >= 0.5 || contactInside);

    let outcome: OracleRow["outcome"];
    if (best === null) outcome = "MISSED";
    else if (!cascadePass) outcome = "MIS_BOUNDED";
    else outcome = "PROPOSED_OK";

    // Selection-level check for the case's primary event: with the recorded
    // contact abstention (rally1), does selection fail even though a
    // proposal covers gold?
    let selectionNote = "";
    if (
      outcome === "PROPOSED_OK" &&
      entry.caseId === "afn-sasebo-rally1" &&
      entry.eventKey === "afn-sasebo-rally1#1"
    ) {
      const selection = selectTargetEventV2(proposals, null);
      if (selection.status !== "selected") {
        outcome = "SELECTION_FAILED";
        selectionNote = `selectTargetEventV2(contact=null) → ${selection.status}: ${"reason" in selection ? selection.reason : ""}`;
      }
    }

    const matched = best
      ? {
          startMs: Math.round(best.proposal.startMs),
          endMs: Math.round(best.proposal.endMs),
          overlapOfGold: Number(best.fraction.toFixed(2)),
        }
      : null;

    let attribution: AttributionClass | null = null;
    let evidence = "";
    if (outcome === "PROPOSED_OK") {
      evidence = matched
        ? `proposal ${matched.startMs}–${matched.endMs} covers gold (overlap ${matched.overlapOfGold}${contactInside ? ", contact inside" : ""})`
        : "";
    } else if (outcome === "SELECTION_FAILED") {
      attribution = "CONTACT_ANCHOR_ABSENT";
      evidence = `${selectionNote}; a proposal covering gold exists (${matched!.startMs}–${matched!.endMs}, overlap ${matched!.overlapOfGold}) but contact abstained (recorded: ${CASCADE_ARTIFACT} CONTACT "status abstained"; HANDOFF_V3 §2: gold 2900 has zero tracked support in any modality) — perception coverage, not event logic`;
    } else {
      const first = series.speeds[0]!.timestampMs;
      const last = series.speeds[series.speeds.length - 1]!.timestampMs;
      const verdict = attributeReplayFailure(
        stats,
        outcome,
        matched,
        entry.label,
        { firstMs: first, lastMs: last },
        entry.caseId,
      );
      attribution = verdict.attribution;
      evidence = verdict.evidence;
    }

    rows.push({
      eventKey: entry.eventKey,
      split: entry.split,
      goldSpanMs: [entry.label.eventStartMs, entry.label.eventEndMs],
      goldContactMs: entry.label.contactMs,
      signalSource: series.source,
      outcome,
      attribution,
      evidence,
      signalStats: stats,
      matchedProposal: matched,
    });
  }

  const failed = rows.filter(
    (row) => row.outcome !== "PROPOSED_OK" && row.outcome !== "NOT_REPLAYABLE",
  );
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.attribution) counts[row.attribution] = (counts[row.attribution] ?? 0) + 1;
  }
  const notReplayable = rows.filter((row) => row.outcome === "NOT_REPLAYABLE").length;

  const report = {
    oracleVersion: "event-failure-oracle-1 (wave-d D06)",
    generatedAtIso: new Date().toISOString(),
    scope: {
      goldTargetEvents: gold.length,
      otherOwnerEventsExcluded: otherOwnerCount,
      exclusionReason:
        "the pipeline proposes TARGET events from the target wrist series; other-owner labels measure contamination, not target-event recall",
      paddleSeriesNote:
        "no paddle-speed series is committed for any oracle case — paddle confirmation is structurally unavailable in every Linux replay (recorded, not a defect of the cases)",
      heldOutDiscipline:
        "wm-dink-01 and afn-vic-rally1 rows cite only previously recorded Mac artifacts; no replay or iteration was run against held-out material",
    },
    countsPerAttribution: counts,
    failedEvents: failed.length,
    notReplayableRows: notReplayable,
    rows,
  };
  const outDir = join(REPO_ROOT, "datasets/experiments/wave-d");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "d06-attribution.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log("═".repeat(78));
  console.log(
    `EVENT-FAILURE ORACLE — ${gold.length} gold target events (${otherOwnerCount} other-owner excluded)`,
  );
  for (const row of rows) {
    console.log(
      `  ${row.eventKey.padEnd(24)} [${row.split}] gold ${row.goldSpanMs[0]}–${row.goldSpanMs[1]} → ${row.outcome}` +
        (row.attribution ? ` · ${row.attribution}` : "") +
        (row.matchedProposal
          ? ` · proposal ${row.matchedProposal.startMs}–${row.matchedProposal.endMs} (${row.matchedProposal.overlapOfGold})`
          : ""),
    );
    if (row.attribution) console.log(`      ${row.evidence}`);
  }
  console.log("─".repeat(78));
  console.log(`attribution counts: ${JSON.stringify(counts)}`);
  console.log(`written: ${outPath.replace(`${REPO_ROOT}/`, "")}`);
}
