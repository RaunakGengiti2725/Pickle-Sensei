import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import { dominantWristSpeeds } from "./engine/minerCore.js";
import { buildPlayerTracks, targetPoseSequence, type PeopleFile } from "./playerTracker.js";
import { proposeStrokeEventsV2, type StrokeEventProposalV2 } from "./strokeEvents.js";
import type { StrokeEventLabel, SwingAnnotation } from "./annotationSchema.js";

/**
 * EVENT RECALL BENCH (wave-e e01) — proposal recall, bounds quality and
 * false-proposal pressure on the Linux-replayable DEV gold.
 *
 *   pnpm --filter @pickle/swing-lab exec tsx src/eventRecallBench.ts
 *
 * Replays every DEV case with a committed wrist signal (windowed wave-a
 * people.json runDirs plus the W6 replay-validated rally1 fixture) through
 * proposeStrokeEventsV2 and scores, per gold TARGET event:
 *
 *   PROPOSED_OK  — a proposal overlaps ≥50% of gold, or the gold contact
 *                  lies inside a proposal (±60ms) — the cascade criterion,
 *                  mirrored from the D06 oracle.
 *   MIS_BOUNDED  — best overlap ∈ (0.3, threshold): the movement was found
 *                  but bounded wrong.
 *   MISSED       — no proposal overlaps >0.3 of gold.
 *
 * False-proposal pressure is measured two ways, both disclosed:
 *   falseInNonEvent    — proposal overlapping no gold label (>0.3 of gold,
 *                        any owner) whose peak lies inside an explicitly
 *                        labeled non-event span (waveD2 sidecars, isEvent:false)
 *   unmatchedProposals — proposals overlapping no gold label of ANY owner
 *                        and not counted above; windows are not exhaustively
 *                        labeled, so this is an upper bound, not a verdict.
 *
 * Held-out cases (role held_out / test_held_out) are excluded entirely.
 * This bench writes an experiment artifact and changes no pipeline behavior.
 */

const PB = join(REPO_ROOT, "datasets/paddle-bench");
const RALLY1_FIXTURE = "apps/mobile/__tests__/fixtures/sessionReplay.afn-sasebo-rally1.json";

interface Speed {
  timestampMs: number;
  value: number;
}

interface BenchCase {
  id: string;
  labels: string;
  runDir: string;
  role?: string;
}

function overlapOfGold(
  proposal: { startMs: number; endMs: number },
  label: { eventStartMs: number; eventEndMs: number },
): number {
  const overlap =
    Math.min(proposal.endMs, label.eventEndMs) - Math.max(proposal.startMs, label.eventStartMs);
  return overlap / (label.eventEndMs - label.eventStartMs);
}

function wristSeriesFor(benchCase: BenchCase): { speeds: Speed[]; source: string } | null {
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
      source: `${benchCase.runDir}/people.json`,
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
      source: RALLY1_FIXTURE,
    };
  }
  return null;
}

/** Explicit non-event spans from the waveD2 event sidecars (append-only gold). */
function nonEventSpansFor(caseId: string): Array<{ startMs: number; endMs: number }> {
  const sidecar = resolve(PB, `bundles/${caseId}/annotation/devin-visual-v4-waveD2-events.json`);
  if (!existsSync(sidecar)) return [];
  const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as {
    records?: Array<{ isEvent: boolean; startMs: number; endMs: number }>;
  };
  return (parsed.records ?? [])
    .filter((record) => !record.isEvent)
    .map((record) => ({ startMs: record.startMs, endMs: record.endMs }));
}

const isMain = process.argv[1]?.endsWith("eventRecallBench.ts");
if (isMain) {
  const cases: BenchCase[] = [];
  const bench = JSON.parse(readFileSync(join(PB, "paddle-bench.json"), "utf8")) as {
    cases: BenchCase[];
  };
  cases.push(...bench.cases);
  const waveAPath = join(PB, "event-bounds-wave-a.json");
  if (existsSync(waveAPath)) {
    cases.push(...(JSON.parse(readFileSync(waveAPath, "utf8")) as { cases: BenchCase[] }).cases);
  }
  const heldOutExcluded: string[] = [];
  const notReplayable: string[] = [];

  const eventRows: Array<{
    eventKey: string;
    goldSpanMs: [number, number];
    goldContactMs: number | null;
    outcome: "PROPOSED_OK" | "MIS_BOUNDED" | "MISSED";
    bestOverlap: number | null;
    contactInside: boolean | null;
    matchedProposal: { startMs: number; endMs: number; lowAmplitude: boolean } | null;
  }> = [];
  const caseRows: Array<{
    caseId: string;
    signalSource: string;
    proposals: number;
    lowAmplitudeProposals: number;
    falseInNonEvent: number;
    unmatchedProposals: number;
    proposalSpans: Array<{ startMs: number; endMs: number; peakMs: number; peakSpeed: number }>;
  }> = [];

  for (const benchCase of cases) {
    if (benchCase.role === "held_out" || benchCase.role === "test_held_out") {
      heldOutExcluded.push(benchCase.id);
      continue;
    }
    const annotation = JSON.parse(
      readFileSync(resolve(PB, benchCase.labels), "utf8"),
    ) as SwingAnnotation & { eventLabels?: StrokeEventLabel[] };
    const allLabels = annotation.eventLabels ?? [];
    const series = wristSeriesFor(benchCase);
    if (!series) {
      if (allLabels.length > 0) notReplayable.push(benchCase.id);
      continue;
    }
    const clipStart = series.speeds[0]?.timestampMs ?? 0;
    const clipEnd = series.speeds[series.speeds.length - 1]?.timestampMs ?? 1;
    const { events } = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: series.speeds,
      clipStartMs: clipStart,
      clipEndMs: clipEnd,
    });

    const targetGold = allLabels
      .map((label, index) => ({ label, eventKey: `${benchCase.id}#${index + 1}` }))
      .filter((entry) => entry.label.owner === "target");
    for (const entry of targetGold) {
      const overlapping = events
        .map((proposal) => ({ proposal, fraction: overlapOfGold(proposal, entry.label) }))
        .filter((candidate) => candidate.fraction > 0.3)
        .sort((a, b) => b.fraction - a.fraction);
      const best = overlapping[0] ?? null;
      const contactInside =
        best !== null && entry.label.contactMs !== null
          ? entry.label.contactMs >= best.proposal.startMs - 60 &&
            entry.label.contactMs <= best.proposal.endMs + 60
          : null;
      const pass = best !== null && (best.fraction >= 0.5 || contactInside === true);
      eventRows.push({
        eventKey: entry.eventKey,
        goldSpanMs: [entry.label.eventStartMs, entry.label.eventEndMs],
        goldContactMs: entry.label.contactMs,
        outcome: pass ? "PROPOSED_OK" : best !== null ? "MIS_BOUNDED" : "MISSED",
        bestOverlap: best ? Number(best.fraction.toFixed(2)) : null,
        contactInside,
        matchedProposal: best
          ? {
              startMs: Math.round(best.proposal.startMs),
              endMs: Math.round(best.proposal.endMs),
              lowAmplitude:
                (best.proposal as StrokeEventProposalV2 & { lowAmplitude?: true }).lowAmplitude ===
                true,
            }
          : null,
      });
    }

    const nonEventSpans = nonEventSpansFor(benchCase.id);
    let falseInNonEvent = 0;
    let unmatched = 0;
    for (const proposal of events) {
      const touchesGold = allLabels.some((label) => overlapOfGold(proposal, label) > 0.3);
      if (touchesGold) continue;
      const peakInNonEvent = nonEventSpans.some(
        (span) => proposal.peakMs >= span.startMs && proposal.peakMs <= span.endMs,
      );
      if (peakInNonEvent) falseInNonEvent += 1;
      else unmatched += 1;
    }
    caseRows.push({
      caseId: benchCase.id,
      signalSource: series.source,
      proposals: events.length,
      lowAmplitudeProposals: events.filter(
        (event) => (event as StrokeEventProposalV2 & { lowAmplitude?: true }).lowAmplitude === true,
      ).length,
      falseInNonEvent,
      unmatchedProposals: unmatched,
      proposalSpans: events.map((event) => ({
        startMs: Math.round(event.startMs),
        endMs: Math.round(event.endMs),
        peakMs: Math.round(event.peakMs),
        peakSpeed: Number(event.peakSpeed.toFixed(3)),
      })),
    });
  }

  const ok = eventRows.filter((row) => row.outcome === "PROPOSED_OK");
  const contactRows = ok.filter((row) => row.contactInside !== null);
  const summary = {
    goldTargetEvents: eventRows.length,
    proposedOk: ok.length,
    misBounded: eventRows.filter((row) => row.outcome === "MIS_BOUNDED").length,
    missed: eventRows.filter((row) => row.outcome === "MISSED").length,
    recall: Number((ok.length / Math.max(1, eventRows.length)).toFixed(3)),
    meanBestOverlapOfProposedOk: Number(
      (
        ok.reduce((total, row) => total + (row.bestOverlap ?? 0), 0) / Math.max(1, ok.length)
      ).toFixed(3),
    ),
    contactInsideRate: Number(
      (
        contactRows.filter((row) => row.contactInside === true).length /
        Math.max(1, contactRows.length)
      ).toFixed(3),
    ),
    contactInsideDenominator: contactRows.length,
    totalProposals: caseRows.reduce((total, row) => total + row.proposals, 0),
    lowAmplitudeProposals: caseRows.reduce((total, row) => total + row.lowAmplitudeProposals, 0),
    falseInNonEvent: caseRows.reduce((total, row) => total + row.falseInNonEvent, 0),
    nonEventSpans: cases.reduce((total, c) => total + nonEventSpansFor(c.id).length, 0),
    unmatchedProposals: caseRows.reduce((total, row) => total + row.unmatchedProposals, 0),
  };

  const report = {
    benchVersion: "event-recall-1 (wave-e e01)",
    generatedAtIso: new Date().toISOString(),
    scope: {
      criterion:
        "PROPOSED_OK = best proposal overlap ≥0.5 of gold OR gold contact inside proposal ±60ms (D06 oracle / cascade criterion)",
      heldOutExcluded,
      notReplayable,
      unmatchedCaveat:
        "windows are not exhaustively labeled; unmatchedProposals is an upper bound on false proposals, not a verdict",
    },
    summary,
    eventRows,
    caseRows,
  };
  const outDir = join(REPO_ROOT, "datasets/experiments/wave-e");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `event-recall-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log("═".repeat(74));
  console.log(`EVENT RECALL BENCH — n=${summary.goldTargetEvents} DEV gold target events`);
  console.log(JSON.stringify(summary, null, 2));
  for (const row of eventRows) {
    console.log(
      `  ${row.eventKey.padEnd(24)} gold ${row.goldSpanMs[0]}–${row.goldSpanMs[1]} → ${row.outcome}` +
        (row.bestOverlap !== null ? ` (overlap ${row.bestOverlap})` : "") +
        (row.matchedProposal?.lowAmplitude ? " [low-amplitude]" : ""),
    );
  }
  console.log(`written: ${outPath.replace(`${REPO_ROOT}/`, "")}`);
}
