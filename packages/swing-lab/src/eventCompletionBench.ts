import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import { dominantWristSpeeds } from "./engine/minerCore.js";
import { buildPlayerTracks, targetPoseSequence, type PeopleFile } from "./playerTracker.js";
import type { StrokeEventLabel, SwingAnnotation } from "./annotationSchema.js";

/**
 * EVENT COMPLETION BENCH — FIXED 1.5s post-roll vs ADAPTIVE settle detection.
 *
 *   pnpm lab:completion-bench [-- out.json]
 *
 * Without `out.json` the report lands in datasets/completion-bench/ as
 * completion-<ts>.json; with it, the report is written to that path only
 * (the regression runner passes a scratch path).
 *
 * The live capture finalizes a stroke clip a FIXED 1.5s after the motion
 * trigger. That is a guess, not movement understanding. This bench replays
 * both policies against the gold event + phase labels:
 *
 *   trigger  = target wrist-speed peak inside the labeled event
 *   FIXED    = trigger + 1500ms
 *   ADAPTIVE = complete when wrist speed stays under
 *              max(0.15, 25% of peak) for 400ms continuously
 *              (min +300ms, hard max +2500ms safety)
 *
 * Truth per event: labeled eventEnd (minimum useful clip), phase
 * followThroughEnd and recoveryEnd (full movement). Replays EVERY labeled
 * target event per case (a rally case can hold several), and also loads the
 * wave-a event-bounds cases (event-bounds-wave-a.json: windowed corpus
 * runDirs + devin-visual-v2-wave-a labels) when present. Bundle-level phase
 * labels describe ONE primary stroke, so recovery/follow-through truth is
 * only attached to the event that contains phases.contactMs; other events
 * keep eventEnd truth alone. Reported per event, no reliability claims.
 */

const PB = join(REPO_ROOT, "datasets/paddle-bench");

interface PolicyOutcome {
  endMs: number;
  endVsEventEndMs: number;
  endVsRecoveryEndMs: number | null;
  contactRetained: boolean;
  followThroughRetained: boolean | null;
  recoveryRetained: boolean | null;
  postTriggerMs: number;
}

function evaluatePolicy(
  endMs: number,
  trigger: number,
  event: StrokeEventLabel,
  phases: SwingAnnotation["phases"] & { recoveryEndMs?: number | null },
): PolicyOutcome {
  const recovery = phases.recoveryEndMs ?? null;
  return {
    endMs: Math.round(endMs),
    endVsEventEndMs: Math.round(endMs - event.eventEndMs),
    endVsRecoveryEndMs: recovery !== null ? Math.round(endMs - recovery) : null,
    contactRetained: event.contactMs === null || endMs >= event.contactMs,
    followThroughRetained:
      phases.followThroughEndMs !== null ? endMs >= phases.followThroughEndMs : null,
    recoveryRetained: recovery !== null ? endMs >= recovery : null,
    postTriggerMs: Math.round(endMs - trigger),
  };
}

const isMain = process.argv[1]?.endsWith("eventCompletionBench.ts");
if (isMain) {
  const bench = (
    JSON.parse(readFileSync(join(PB, "paddle-bench.json"), "utf8")) as {
      cases: Array<{ id: string; labels: string; runDir: string; role?: string }>;
    }
  ).cases.slice();
  // WAVE-A event-bounds gold: windowed corpus runDirs + wave-a labels.
  const waveAPath = join(PB, "event-bounds-wave-a.json");
  if (existsSync(waveAPath)) {
    bench.push(
      ...(
        JSON.parse(readFileSync(waveAPath, "utf8")) as {
          cases: Array<{ id: string; labels: string; runDir: string; role?: string }>;
        }
      ).cases,
    );
  }
  const rows: Array<{
    caseId: string;
    split: string;
    trigger: number;
    peakSpeed: number;
    fixed: PolicyOutcome;
    adaptive: PolicyOutcome & { settled: boolean };
    identityNote: string | null;
  }> = [];

  const NULL_PHASES = {
    preparationStartMs: null,
    accelerationStartMs: null,
    contactMs: null,
    followThroughEndMs: null,
    recoveryEndMs: null,
  };

  for (const benchCase of bench) {
    const annotation = JSON.parse(
      readFileSync(resolve(PB, benchCase.labels), "utf8"),
    ) as SwingAnnotation & {
      eventLabels?: StrokeEventLabel[];
    };
    const targetEvents = (annotation.eventLabels ?? []).filter((entry) => entry.owner === "target");
    if (targetEvents.length === 0) continue;
    const peoplePath = resolve(PB, benchCase.runDir, "people.json");
    if (!existsSync(peoplePath)) continue;
    const people = JSON.parse(readFileSync(peoplePath, "utf8")) as PeopleFile;
    const tracks = buildPlayerTracks(people);
    if (tracks.length === 0) continue;
    // Auto target policy (coverage × size), as the pipeline does pre-seed.
    const target = [...tracks].sort(
      (a, b) => b.coverage * b.meanTorsoSpan - a.coverage * a.meanTorsoSpan,
    )[0]!;
    const speeds = dominantWristSpeeds(targetPoseSequence(people, target).frames);

    for (const [eventIndex, event] of targetEvents.entries()) {
      const rowId = targetEvents.length > 1 ? `${benchCase.id}#${eventIndex + 1}` : benchCase.id;
      // Bundle phases describe ONE primary stroke; attach recovery/follow
      // truth only to the event that contains phases.contactMs.
      const phasesContact =
        (annotation.phases as { contactMs?: number | null } | undefined)?.contactMs ?? null;
      const eventPhases =
        phasesContact !== null &&
        phasesContact >= event.eventStartMs &&
        phasesContact <= event.eventEndMs
          ? (annotation.phases as never)
          : (NULL_PHASES as never);
      const inEvent = speeds.filter(
        (sample) =>
          sample.timestampMs >= event.eventStartMs && sample.timestampMs <= event.eventEndMs,
      );
      let identityNote: string | null = null;
      const pool = inEvent;
      if (inEvent.length < 3) {
        identityNote =
          "auto target has <3 wrist samples inside the labeled event (identity/visibility failure)";
        if (pool.length === 0) {
          rows.push({
            caseId: rowId,
            split: benchCase.role ?? "unassigned",
            trigger: -1,
            peakSpeed: 0,
            fixed: evaluatePolicy(Number.NaN, 0, event, eventPhases),
            adaptive: { ...evaluatePolicy(Number.NaN, 0, event, eventPhases), settled: false },
            identityNote:
              "NO wrist samples inside event for auto target — event unusable for completion replay (recorded, not skipped silently)",
          });
          continue;
        }
      }
      const peak = pool.reduce((best, sample) => (sample.value > best.value ? sample : best));
      const trigger = peak.timestampMs;
      const fixedEnd = trigger + 1500;

      // ADAPTIVE completion on post-trigger wrist speeds. Two honest end
      // conditions (whichever comes first), then a hard safety max:
      //  a) SETTLE — the athlete finished and came to rest (Stroke mode)
      //  b) NEXT-STROKE VALLEY — continuous play: speed dips below 60% of
      //     peak then rises again ≥1.5× the valley → the event ended at the
      //     valley (Session mode boundary; prevents swallowing stroke #2)
      const settleThreshold = Math.max(0.15, 0.25 * peak.value);
      const after = speeds.filter((sample) => sample.timestampMs >= trigger);
      let adaptiveEnd = trigger + 2500; // hard safety max
      let settled = false;
      let quietSince: number | null = null;
      let valley: { timestampMs: number; value: number } | null = null;
      for (const sample of after) {
        if (sample.timestampMs < trigger + 300) continue; // min follow-through
        if (sample.value < settleThreshold) {
          quietSince ??= sample.timestampMs;
          if (sample.timestampMs - quietSince >= 400) {
            adaptiveEnd = sample.timestampMs;
            settled = true;
            break;
          }
        } else {
          quietSince = null;
        }
        if (sample.value < 0.6 * peak.value && (valley === null || sample.value < valley.value)) {
          valley = sample;
        }
        if (
          valley &&
          sample.value >= Math.max(settleThreshold * 2, 1.5 * valley.value) &&
          sample.timestampMs > valley.timestampMs + 80
        ) {
          adaptiveEnd = valley.timestampMs; // next stroke beginning → end at the valley
          settled = true;
          break;
        }
        if (sample.timestampMs > trigger + 2500) break;
      }
      // Honest disclosure: if the wrist series ends before the adaptive
      // policy could possibly resolve (no settle and data ran out before
      // trigger+2500), the row is a window/data artifact, not movement truth.
      const lastSampleMs = after.length > 0 ? after[after.length - 1]!.timestampMs : trigger;
      if (!settled && lastSampleMs < trigger + 2500) {
        identityNote = [
          identityNote,
          `post-trigger wrist data ends at ${Math.round(lastSampleMs)}ms (< trigger+2500) — adaptive outcome truncated by window end`,
        ]
          .filter(Boolean)
          .join(" · ");
      }
      rows.push({
        caseId: rowId,
        split: benchCase.role ?? "unassigned",
        trigger,
        peakSpeed: Number(peak.value.toFixed(2)),
        fixed: evaluatePolicy(fixedEnd, trigger, event, eventPhases),
        adaptive: { ...evaluatePolicy(adaptiveEnd, trigger, event, eventPhases), settled },
        identityNote,
      });
    }
  }

  const usable = rows.filter((row) => row.trigger >= 0);
  const summarize = (key: "fixed" | "adaptive") => {
    const outcomes = usable.map((row) => row[key]);
    const absEnd = outcomes
      .map((outcome) => Math.abs(outcome.endVsEventEndMs))
      .sort((a, b) => a - b);
    const absRecovery = outcomes
      .filter((outcome) => outcome.endVsRecoveryEndMs !== null)
      .map((outcome) => Math.abs(outcome.endVsRecoveryEndMs!))
      .sort((a, b) => a - b);
    return {
      medianAbsEndErrorMs: absEnd[Math.floor(absEnd.length / 2)] ?? null,
      medianAbsRecoveryErrorMs: absRecovery[Math.floor(absRecovery.length / 2)] ?? null,
      earlyStops: outcomes.filter((outcome) => outcome.endVsEventEndMs < 0).length,
      contactLost: outcomes.filter((outcome) => !outcome.contactRetained).length,
      followThroughLost: outcomes.filter((outcome) => outcome.followThroughRetained === false)
        .length,
      recoveryLost: outcomes.filter((outcome) => outcome.recoveryRetained === false).length,
      meanTrailingExcessMs: Math.round(
        outcomes.reduce(
          (total, outcome) =>
            total + Math.max(0, outcome.endVsRecoveryEndMs ?? outcome.endVsEventEndMs),
          0,
        ) / Math.max(1, outcomes.length),
      ),
      meanPostTriggerMs: Math.round(
        outcomes.reduce((total, outcome) => total + outcome.postTriggerMs, 0) /
          Math.max(1, outcomes.length),
      ),
    };
  };

  const report = {
    benchVersion: "event-completion-2",
    benchVersionNote:
      "replays ALL labeled target events per case (was: first only) and merges event-bounds-wave-a.json cases (windowed DEV corpus runDirs, devin-visual-v2-wave-a labels); recovery/follow-through truth only attaches to the event containing the bundle's phases.contactMs",
    generatedAtIso: new Date().toISOString(),
    policies: {
      FIXED_POSTROLL: "trigger + 1500ms (current shipped behavior)",
      ADAPTIVE_COMPLETION:
        "settle: wrist speed < max(0.15, 25% peak) for 400ms; min +300ms; hard max +2500ms",
    },
    n: usable.length,
    caveat: `n=${usable.length} gold target events (${rows.length} labeled incl. unusable); per-event table is the honest unit; no reliability claim`,
    summary: { FIXED: summarize("fixed"), ADAPTIVE: summarize("adaptive") },
    rows,
  };
  const outPath = process.argv[2]
    ? resolve(process.argv[2])
    : join(REPO_ROOT, "datasets/completion-bench", `completion-${Date.now()}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log("═".repeat(74));
  console.log(`EVENT COMPLETION: FIXED 1.5s vs ADAPTIVE settle (n=${usable.length} gold events)`);
  console.log(JSON.stringify(report.summary, null, 2));
  console.log("per event (endVsEventEnd / endVsRecoveryEnd ms · +late −early):");
  for (const row of rows) {
    console.log(
      `  ${row.caseId.padEnd(20)} [${row.split}] trigger ${row.trigger}ms · ` +
        `FIXED ${row.fixed.endVsEventEndMs}/${row.fixed.endVsRecoveryEndMs} · ` +
        `ADAPTIVE ${row.adaptive.endVsEventEndMs}/${row.adaptive.endVsRecoveryEndMs}${row.adaptive.settled ? "" : " (never settled → safety max)"}` +
        (row.identityNote ? ` · ⚠ ${row.identityNote}` : ""),
    );
  }
  console.log(`written: ${outPath.replace(`${REPO_ROOT}/`, "")}`);
}
