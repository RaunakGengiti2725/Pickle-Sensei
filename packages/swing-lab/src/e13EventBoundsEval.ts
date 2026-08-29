import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import { dominantWristSpeeds } from "./engine/minerCore.js";
import { buildPlayerTracks, targetPoseSequence, type PeopleFile } from "./playerTracker.js";
import { proposeStrokeEventsV2, type StrokeEventProposalV2 } from "./strokeEvents.js";
import { attributeReplayFailure, overlapOfGold, signalStatsFor } from "./eventFailureOracle.js";
import type { StrokeEventLabel } from "./annotationSchema.js";

/**
 * E13 — EVENT-BOUNDS EVAL against the D2-07 gold (wave-e, read-only).
 *
 *   pnpm --filter @pickle/swing-lab exec tsx src/e13EventBoundsEval.ts
 *
 * Replays the production event proposer (stroke-event-2: body proposes,
 * paddle confirms — no paddle series is committed for these runDirs, so
 * confirmation is structurally absent and recorded) over the three committed
 * windowed runDirs that back the D2-07 event-bounds gold
 * (devin-visual-v4-waveD2-events.json sidecars: 12 records = 7 stroke events
 * + 5 explicit non-events) and scores:
 *
 *   RECALL          — gold events matched by a proposal (overlap > 30% of the
 *                     gold span; PROPOSED_OK requires overlap ≥ 50% or gold
 *                     contact inside the proposal ±60ms — same pass criterion
 *                     as the D06 oracle). Matching is one-to-one greedy by
 *                     overlap fraction so one wide proposal cannot claim
 *                     several rapid volleys silently; reuse is disclosed.
 *   BOUNDS ERROR    — |proposal − gold| start/end ms on matched events.
 *   CONTACT-INSIDE  — gold contactMs within the matched proposal ±60ms.
 *   FALSE POSITIVES — proposals not matched to any gold event that overlap
 *                     an explicit non-event record (> 30% of the record span),
 *                     plus total unmatched proposals.
 *
 * Every miss/mis-bound gets a forensic attribution via the D06 oracle's
 * recorded-signal classes. Target-owner and other-owner gold are scored
 * separately: the proposer runs on the AUTO-TARGET wrist series only, so
 * other-owner strokes measure contamination, not recall. This tool changes
 * NO pipeline behavior and writes only wave-e experiment artifacts.
 */

const PB = join(REPO_ROOT, "datasets/paddle-bench");

export interface D207Record {
  recordId: string;
  isEvent: boolean;
  classification: string;
  actor: string;
  owner?: "target" | "other";
  startMs: number;
  endMs: number;
  contactInsideBounds: boolean;
  contactMs: number | null;
  note?: string;
}

export interface D207Sidecar {
  captureBundle: string;
  annotatorId: string;
  recordingId: string;
  role: string;
  windowMs: { from: number; to: number };
  records: D207Record[];
}

export const D207_BUNDLES = [
  "wavea-marne-serve",
  "wavea-wgm-wheelchair",
  "wavea-sasebo-volleys",
] as const;

const asLabel = (record: D207Record): StrokeEventLabel => ({
  eventStartMs: record.startMs,
  eventEndMs: record.endMs,
  contactMs: record.contactMs,
  owner: record.owner ?? "other",
});

export interface EventRow {
  recordId: string;
  bundle: string;
  owner: "target" | "other";
  classification: string;
  goldSpanMs: [number, number];
  goldContactMs: number | null;
  outcome: "PROPOSED_OK" | "MIS_BOUNDED" | "MISSED";
  matchedProposal: {
    eventId: string;
    startMs: number;
    endMs: number;
    peakMs: number;
    overlapOfGold: number;
    reused: boolean;
  } | null;
  startErrMs: number | null;
  endErrMs: number | null;
  contactInside: boolean | null;
  forensics: { attribution: string; evidence: string } | null;
}

export interface NonEventRow {
  recordId: string;
  bundle: string;
  classification: string;
  spanMs: [number, number];
  falsePositive: boolean;
  overlappingUnmatchedProposals: Array<{
    eventId: string;
    startMs: number;
    endMs: number;
    overlapOfRecord: number;
  }>;
}

export function runE13EventBoundsEval(): {
  perBundle: Array<{
    bundle: string;
    proposals: StrokeEventProposalV2[];
    proposalSource: string;
    wristSamples: number;
  }>;
  eventRows: EventRow[];
  nonEventRows: NonEventRow[];
} {
  const perBundle: Array<{
    bundle: string;
    proposals: StrokeEventProposalV2[];
    proposalSource: string;
    wristSamples: number;
  }> = [];
  const eventRows: EventRow[] = [];
  const nonEventRows: NonEventRow[] = [];

  for (const bundle of D207_BUNDLES) {
    const sidecar = JSON.parse(
      readFileSync(
        join(PB, "bundles", bundle, "annotation", "devin-visual-v4-waveD2-events.json"),
        "utf8",
      ),
    ) as D207Sidecar;
    const people = JSON.parse(
      readFileSync(join(PB, "runs-wave-a", bundle, "people.json"), "utf8"),
    ) as PeopleFile;
    const tracks = buildPlayerTracks(people);
    const target = [...tracks].sort(
      (a, b) => b.coverage * b.meanTorsoSpan - a.coverage * a.meanTorsoSpan,
    )[0]!;
    const speeds = dominantWristSpeeds(targetPoseSequence(people, target).frames);
    const { events: proposals, source } = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: speeds,
      clipStartMs: sidecar.windowMs.from,
      clipEndMs: sidecar.windowMs.to,
    });
    perBundle.push({ bundle, proposals, proposalSource: source, wristSamples: speeds.length });

    const goldEvents = sidecar.records.filter((record) => record.isEvent);
    const nonEvents = sidecar.records.filter((record) => !record.isEvent);

    // One-to-one greedy assignment by overlap fraction (descending).
    const candidates: Array<{
      record: D207Record;
      proposal: StrokeEventProposalV2;
      fraction: number;
    }> = [];
    for (const record of goldEvents) {
      for (const proposal of proposals) {
        const fraction = overlapOfGold(proposal, asLabel(record));
        if (fraction > 0.3) candidates.push({ record, proposal, fraction });
      }
    }
    // Target-owner gold outranks other-owner in assignment: proposals come
    // from the AUTO-TARGET wrist series, so a proposal that covers both a
    // target stroke and an opponent stroke belongs to the target's movement.
    const ownerRank = (record: D207Record) => (record.owner === "target" ? 0 : 1);
    candidates.sort((a, b) => ownerRank(a.record) - ownerRank(b.record) || b.fraction - a.fraction);
    const assignedRecord = new Map<
      string,
      { proposal: StrokeEventProposalV2; fraction: number; reused: boolean }
    >();
    const usedProposals = new Set<string>();
    for (const candidate of candidates) {
      if (assignedRecord.has(candidate.record.recordId)) continue;
      if (usedProposals.has(candidate.proposal.eventId)) continue;
      assignedRecord.set(candidate.record.recordId, {
        proposal: candidate.proposal,
        fraction: candidate.fraction,
        reused: false,
      });
      usedProposals.add(candidate.proposal.eventId);
    }
    // Disclosure pass: gold left unmatched that IS covered by an already-used
    // proposal — the proposer fused rapid consecutive strokes into one span.
    for (const candidate of candidates) {
      if (assignedRecord.has(candidate.record.recordId)) continue;
      assignedRecord.set(candidate.record.recordId, {
        proposal: candidate.proposal,
        fraction: candidate.fraction,
        reused: true,
      });
    }

    const seriesBounds = {
      firstMs: speeds[0]?.timestampMs ?? sidecar.windowMs.from,
      lastMs: speeds[speeds.length - 1]?.timestampMs ?? sidecar.windowMs.from,
    };

    for (const record of goldEvents) {
      const label = asLabel(record);
      const assignment = assignedRecord.get(record.recordId) ?? null;
      const matchedForScore = assignment && !assignment.reused ? assignment : null;
      const contactInside =
        matchedForScore !== null && record.contactMs !== null
          ? record.contactMs >= matchedForScore.proposal.startMs - 60 &&
            record.contactMs <= matchedForScore.proposal.endMs + 60
          : null;
      let outcome: EventRow["outcome"];
      if (matchedForScore === null) outcome = "MISSED";
      else if (matchedForScore.fraction >= 0.5 || contactInside === true) outcome = "PROPOSED_OK";
      else outcome = "MIS_BOUNDED";

      let forensics: EventRow["forensics"] = null;
      if (outcome !== "PROPOSED_OK") {
        const stats = signalStatsFor(speeds, label);
        const base = attributeReplayFailure(
          stats,
          outcome === "MISSED" ? "MISSED" : "MIS_BOUNDED",
          matchedForScore
            ? { startMs: matchedForScore.proposal.startMs, endMs: matchedForScore.proposal.endMs }
            : null,
          label,
          seriesBounds,
          bundle,
        );
        const reuseNote =
          assignment?.reused === true
            ? ` REUSE: proposal ${assignment.proposal.eventId} (${Math.round(assignment.proposal.startMs)}–${Math.round(assignment.proposal.endMs)}ms, overlap ${assignment.fraction.toFixed(2)}) covers this gold span but was already assigned to another gold event — the proposer emitted one span for several rapid consecutive strokes.`
            : "";
        const ownerNote =
          label.owner === "other"
            ? " OWNER=other: the replayed series is the AUTO-TARGET's wrist, so this attribution describes target-signal overlap with the opponent's stroke span, not opponent-motion detection — an other-owner miss is the expected proposer behavior, recorded as contamination context."
            : "";
        forensics = {
          attribution: base.attribution,
          evidence: base.evidence + reuseNote + ownerNote,
        };
      }
      eventRows.push({
        recordId: record.recordId,
        bundle,
        owner: label.owner,
        classification: record.classification,
        goldSpanMs: [record.startMs, record.endMs],
        goldContactMs: record.contactMs,
        outcome,
        matchedProposal: assignment
          ? {
              eventId: assignment.proposal.eventId,
              startMs: Math.round(assignment.proposal.startMs),
              endMs: Math.round(assignment.proposal.endMs),
              peakMs: Math.round(assignment.proposal.peakMs),
              overlapOfGold: Number(assignment.fraction.toFixed(2)),
              reused: assignment.reused,
            }
          : null,
        startErrMs: matchedForScore
          ? Math.round(Math.abs(matchedForScore.proposal.startMs - record.startMs))
          : null,
        endErrMs: matchedForScore
          ? Math.round(Math.abs(matchedForScore.proposal.endMs - record.endMs))
          : null,
        contactInside,
        forensics,
      });
    }

    for (const record of nonEvents) {
      const span = record.endMs - record.startMs;
      const overlapping = proposals
        .filter((proposal) => !usedProposals.has(proposal.eventId))
        .map((proposal) => ({
          proposal,
          overlapOfRecord:
            (Math.min(proposal.endMs, record.endMs) - Math.max(proposal.startMs, record.startMs)) /
            span,
        }))
        .filter((candidate) => candidate.overlapOfRecord > 0.3);
      nonEventRows.push({
        recordId: record.recordId,
        bundle,
        classification: record.classification,
        spanMs: [record.startMs, record.endMs],
        falsePositive: overlapping.length > 0,
        overlappingUnmatchedProposals: overlapping.map((candidate) => ({
          eventId: candidate.proposal.eventId,
          startMs: Math.round(candidate.proposal.startMs),
          endMs: Math.round(candidate.proposal.endMs),
          overlapOfRecord: Number(candidate.overlapOfRecord.toFixed(2)),
        })),
      });
    }
  }
  return { perBundle, eventRows, nonEventRows };
}

const median = (values: number[]): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
};

const isMain = process.argv[1]?.endsWith("e13EventBoundsEval.ts");
if (isMain) {
  const { perBundle, eventRows, nonEventRows } = runE13EventBoundsEval();
  const targetRows = eventRows.filter((row) => row.owner === "target");
  const otherRows = eventRows.filter((row) => row.owner === "other");
  const summarize = (rows: EventRow[]) => ({
    n: rows.length,
    proposedOk: rows.filter((row) => row.outcome === "PROPOSED_OK").length,
    misBounded: rows.filter((row) => row.outcome === "MIS_BOUNDED").length,
    missed: rows.filter((row) => row.outcome === "MISSED").length,
    medianStartErrMs: median(
      rows.flatMap((row) => (row.startErrMs !== null ? [row.startErrMs] : [])),
    ),
    medianEndErrMs: median(rows.flatMap((row) => (row.endErrMs !== null ? [row.endErrMs] : []))),
    contactInside: `${rows.filter((row) => row.contactInside === true).length}/${rows.filter((row) => row.contactInside !== null).length}`,
  });
  const totalProposals = perBundle.reduce((total, entry) => total + entry.proposals.length, 0);
  const matchedProposalCount = new Set(
    eventRows
      .filter((row) => row.matchedProposal !== null && !row.matchedProposal.reused)
      .map((row) => `${row.bundle}:${row.matchedProposal!.eventId}`),
  ).size;
  const report = {
    evalVersion: "e13-event-bounds-eval-1",
    generatedAtIso: new Date().toISOString(),
    gold: "D2-07 devin-visual-v4-waveD2-events.json sidecars (3 bundles, 12 records: 7 events / 5 non-events)",
    proposer:
      "proposeStrokeEventsV2 on runs-wave-a windowed auto-target wrist series (paddle series not committed → confirmation structurally absent)",
    passCriterion:
      "overlap ≥ 0.5 of gold span OR gold contact inside proposal ±60ms (D06 oracle criterion); one-to-one greedy matching, reuse disclosed",
    summary: {
      target: summarize(targetRows),
      other: summarize(otherRows),
      falsePositives: {
        nonEvents: nonEventRows.length,
        falsePositiveNonEvents: nonEventRows.filter((row) => row.falsePositive).length,
        unmatchedProposals: totalProposals - matchedProposalCount,
        totalProposals,
      },
    },
    perBundle: perBundle.map((entry) => ({
      bundle: entry.bundle,
      proposalSource: entry.proposalSource,
      wristSamples: entry.wristSamples,
      proposals: entry.proposals.map((proposal) => ({
        eventId: proposal.eventId,
        startMs: Math.round(proposal.startMs),
        peakMs: Math.round(proposal.peakMs),
        endMs: Math.round(proposal.endMs),
        peakSpeed: Number(proposal.peakSpeed.toFixed(2)),
        prominence: Number(proposal.prominence.toFixed(2)),
      })),
    })),
    eventRows,
    nonEventRows,
  };
  const outDir = join(REPO_ROOT, "datasets/experiments/wave-e");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "e13-event-bounds-eval-report.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.summary, null, 2));
  for (const row of eventRows) {
    console.log(
      `${row.recordId} [${row.owner}] ${row.outcome}` +
        (row.matchedProposal
          ? ` proposal ${row.matchedProposal.startMs}–${row.matchedProposal.endMs} overlap ${row.matchedProposal.overlapOfGold}${row.matchedProposal.reused ? " (reused)" : ""}`
          : "") +
        (row.forensics ? ` · ${row.forensics.attribution}: ${row.forensics.evidence}` : ""),
    );
  }
  for (const row of nonEventRows) {
    console.log(
      `${row.recordId} [non-event] ${row.falsePositive ? "FALSE_POSITIVE" : "clean"}` +
        (row.overlappingUnmatchedProposals.length > 0
          ? ` ${JSON.stringify(row.overlappingUnmatchedProposals)}`
          : ""),
    );
  }
  console.log(`written: ${outPath.replace(`${REPO_ROOT}/`, "")}`);
}
