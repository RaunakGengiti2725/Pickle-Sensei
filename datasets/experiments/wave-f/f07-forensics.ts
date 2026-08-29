// F07 forensic dump — deepens the E04 forensics for the 6 committed-gold
// anchor-free abstentions that remained after v2.3. For each abstained case,
// beyond the E04 fields, this prints:
//   - the padded-series maximum's distance from the nearest event boundary
//     (is the "outside" apex within label-quantization tolerance?)
//   - the motion-connection valley between the in-event peak and the padded
//     max, compared against the boundary-walking accel floor (same burst?)
//   - for every rival (>= 0.9x apex, > 180ms away), its valley to the apex
//     and whether it sits in-event or in the margin
//   - what the gates would judge if the padded max were adopted as apex
//     (prominence ratio, contenders above it, rivals against it)
// Read-only over committed wave-a bundles; held-out cases have no bundles
// under datasets/paddle-bench/runs-wave-a and are never touched.
// Run: cd packages/swing-lab && npx tsx ../../datasets/experiments/wave-f/f07-forensics.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { segmentPhasesTemporalV2 } from "../../../packages/swing-lab/src/phaseTemporal.js";

const ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");
const RUNS = join(ROOT, "datasets/paddle-bench/runs-wave-a");

interface Landmark {
  n: string;
  v: number;
  x: number;
  y: number;
}
interface PeopleFile {
  frames: Array<{ t: number; p: Array<{ c: number; l: Landmark[] }> }>;
}

function wristSpeeds(
  people: PeopleFile,
  event: { startMs: number; endMs: number },
): Array<{ timestampMs: number; value: number }> {
  let prevTorso: { x: number; y: number } | null = null;
  const chosen: Array<{ t: number; l: Landmark[] }> = [];
  for (const frame of people.frames) {
    if (frame.p.length === 0) continue;
    const torso = (l: Landmark[]) => {
      const ls = l.find((m) => m.n === "left_shoulder");
      const rs = l.find((m) => m.n === "right_shoulder");
      if (!ls || !rs) return null;
      return { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
    };
    let best: { l: Landmark[]; d: number } | null = null;
    for (const person of frame.p) {
      const t = torso(person.l);
      if (!t) continue;
      const ref = prevTorso ?? { x: 0.5, y: 0.5 };
      const d = Math.hypot(t.x - ref.x, t.y - ref.y);
      if (!best || d < best.d) best = { l: person.l, d };
    }
    if (!best) continue;
    const t = torso(best.l);
    if (t) prevTorso = t;
    chosen.push({ t: frame.t, l: best.l });
  }
  const travel = { left: 0, right: 0 };
  const last: Record<string, { x: number; y: number; t: number } | undefined> = {};
  const perWrist: Record<"left" | "right", Array<{ timestampMs: number; value: number }>> = {
    left: [],
    right: [],
  };
  for (const frame of chosen) {
    for (const side of ["left", "right"] as const) {
      const mark = frame.l.find((m) => m.n === `${side}_wrist` && m.v >= 0.25);
      if (!mark) continue;
      const prior = last[side];
      if (prior) {
        const dtSec = (frame.t - prior.t) / 1000;
        const step = Math.hypot(mark.x - prior.x, mark.y - prior.y);
        if (dtSec > 0 && dtSec <= 0.15) {
          perWrist[side].push({ timestampMs: frame.t, value: step / dtSec });
          if (frame.t >= event.startMs && frame.t <= event.endMs) travel[side] += step;
        }
      }
      last[side] = { x: mark.x, y: mark.y, t: frame.t };
    }
  }
  return travel.right >= travel.left ? perWrist.right : perWrist.left;
}

const gold = JSON.parse(
  readFileSync(join(ROOT, "datasets/paddle-bench/stroke-gold.json"), "utf8"),
) as {
  labels: Array<{
    caseId: string;
    eventStartMs: number;
    eventEndMs: number;
    contactMs: number | null;
  }>;
};

const valleyBetween = (
  series: Array<{ timestampMs: number; value: number }>,
  aMs: number,
  bMs: number,
): number | null => {
  const lo = Math.min(aMs, bMs);
  const hi = Math.max(aMs, bMs);
  const between = series.filter((s) => s.timestampMs > lo && s.timestampMs < hi);
  return between.length ? between.reduce((m, s) => Math.min(m, s.value), Infinity) : null;
};

const peopleCache = new Map<string, PeopleFile>();
for (const label of gold.labels) {
  const runDir = join(RUNS, label.caseId);
  if (!existsSync(join(runDir, "people.json"))) continue;
  if (!peopleCache.has(label.caseId)) {
    peopleCache.set(
      label.caseId,
      JSON.parse(readFileSync(join(runDir, "people.json"), "utf8")) as PeopleFile,
    );
  }
  const event = { startMs: label.eventStartMs, endMs: label.eventEndMs };
  const speeds = wristSpeeds(peopleCache.get(label.caseId)!, event);
  const outcome = segmentPhasesTemporalV2({
    event,
    contactMs: null,
    paddleSpeeds: null,
    wristSpeeds: speeds,
  });
  if (outcome.status === "segmented") continue;

  const pad = 300;
  const padded = speeds
    .filter(
      (s) =>
        Number.isFinite(s.timestampMs) &&
        Number.isFinite(s.value) &&
        s.timestampMs >= event.startMs - pad &&
        s.timestampMs <= event.endMs + pad,
    )
    .sort((a, b) => a.timestampMs - b.timestampMs);
  const inEvent = padded.filter(
    (s) => s.timestampMs >= event.startMs && s.timestampMs <= event.endMs,
  );
  const peak = inEvent.length ? inEvent.reduce((b, s) => (s.value > b.value ? s : b)) : null;
  const sorted = padded.map((s) => s.value).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
  const padMax = padded.length ? padded.reduce((b, s) => (s.value > b.value ? s : b)) : null;
  const boundaryDistance = (tMs: number): number =>
    tMs < event.startMs ? event.startMs - tMs : tMs > event.endMs ? tMs - event.endMs : 0;

  const anchoredOutcome =
    label.contactMs !== null
      ? segmentPhasesTemporalV2({
          event,
          contactMs: label.contactMs,
          paddleSpeeds: null,
          wristSpeeds: speeds,
        })
      : null;

  const rivalsOfPeak = peak
    ? padded
        .filter(
          (s) => Math.abs(s.timestampMs - peak.timestampMs) > 180 && s.value >= 0.9 * peak.value,
        )
        .map((r) => ({
          t: r.timestampMs,
          v: +r.value.toFixed(3),
          inMargin: r.timestampMs < event.startMs || r.timestampMs > event.endMs,
          boundaryDistMs: boundaryDistance(r.timestampMs),
          valleyToApex: (() => {
            const v = valleyBetween(padded, r.timestampMs, peak.timestampMs);
            return v !== null ? +v.toFixed(3) : null;
          })(),
          restSeparated: (() => {
            const v = valleyBetween(padded, r.timestampMs, peak.timestampMs);
            return v !== null && v < 0.25 * Math.min(peak.value, r.value);
          })(),
        }))
    : [];

  // What would the gates say if the padded max were adopted as the apex?
  let adoptedView: unknown = null;
  if (peak && padMax && padMax.timestampMs !== peak.timestampMs && padMax.value > peak.value) {
    const valley = valleyBetween(padded, peak.timestampMs, padMax.timestampMs);
    const motionConnected = valley !== null && valley >= 0.25 * Math.min(peak.value, padMax.value);
    const contendersAboveAdopted = padded.filter((s) => s.value > padMax.value).length;
    const rivalsOfAdopted = padded.filter(
      (s) => Math.abs(s.timestampMs - padMax.timestampMs) > 180 && s.value >= 0.9 * padMax.value,
    ).length;
    adoptedView = {
      adoptedApex: { t: padMax.timestampMs, v: +padMax.value.toFixed(3) },
      boundaryDistMs: boundaryDistance(padMax.timestampMs),
      valleyToInEventPeak: valley !== null ? +valley.toFixed(3) : null,
      motionConnectedToInEventPeak: motionConnected,
      prominenceRatioVsPaddedMedian: median > 0 ? +(padMax.value / median).toFixed(2) : null,
      contendersAboveAdopted,
      rivalsOfAdopted,
    };
  }

  console.log(
    JSON.stringify(
      {
        case: `${label.caseId}@${label.eventStartMs}`,
        eventLenMs: event.endMs - event.startMs,
        reason: outcome.reason,
        anchoredStatus: anchoredOutcome
          ? anchoredOutcome.status === "segmented"
            ? "segmented"
            : anchoredOutcome.reason
          : "no gold contact",
        inEventPeak: peak ? { t: peak.timestampMs, v: +peak.value.toFixed(3) } : null,
        paddedMedian: +median.toFixed(3),
        padMax: padMax
          ? {
              t: padMax.timestampMs,
              v: +padMax.value.toFixed(3),
              inMargin: padMax.timestampMs < event.startMs || padMax.timestampMs > event.endMs,
              boundaryDistMs: boundaryDistance(padMax.timestampMs),
            }
          : null,
        rivalsOfInEventPeak: rivalsOfPeak,
        adoptedApexView: adoptedView,
        sampleIntervalMs:
          padded.length > 1
            ? +(
                (padded[padded.length - 1]!.timestampMs - padded[0]!.timestampMs) /
                (padded.length - 1)
              ).toFixed(1)
            : null,
      },
      null,
      0,
    ),
  );
}
