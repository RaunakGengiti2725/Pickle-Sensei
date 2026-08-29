// E04 forensic dump: for every anchor-free ABSTAINED committed-gold case,
// print the raw evidence the gates judged (sample counts, in-event peak,
// local median, margin maximum and its location, rival peaks, inter-sample
// gaps) so each abstention gets a concrete forensic reason instead of just a
// gate name. Read-only over committed wave-a bundles; held-out cases are not
// present in these bundles.
// Run: cd packages/swing-lab && npx tsx ../../datasets/experiments/wave-e/e04-forensics.ts
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
  const inEventSorted = inEvent.map((s) => s.value).sort((a, b) => a - b);
  const inEventMedian = inEventSorted.length
    ? inEventSorted[Math.floor(inEventSorted.length / 2)]!
    : 0;
  const padMaxSample = padded.length ? padded.reduce((b, s) => (s.value > b.value ? s : b)) : null;
  const marginSamples = padded.filter(
    (s) => s.timestampMs < event.startMs || s.timestampMs > event.endMs,
  );
  const rivals = peak
    ? padded.filter(
        (s) => Math.abs(s.timestampMs - peak.timestampMs) > 180 && s.value >= 0.9 * peak.value,
      )
    : [];
  // valley between the in-event peak and the padded-series max, if the max is
  // in the margin: minimum value strictly between the two timestamps
  let valleyToMarginMax: number | null = null;
  if (peak && padMaxSample && padMaxSample.timestampMs !== peak.timestampMs) {
    const lo = Math.min(peak.timestampMs, padMaxSample.timestampMs);
    const hi = Math.max(peak.timestampMs, padMaxSample.timestampMs);
    const between = padded.filter((s) => s.timestampMs > lo && s.timestampMs < hi);
    valleyToMarginMax = between.length
      ? between.reduce((m, s) => Math.min(m, s.value), Infinity)
      : null;
  }
  console.log(
    JSON.stringify(
      {
        case: `${label.caseId}@${label.eventStartMs}`,
        eventLenMs: event.endMs - event.startMs,
        reason: outcome.reason,
        paddedSamples: padded.length,
        inEventSamples: inEvent.length,
        inEventPeak: peak ? { t: peak.timestampMs, v: +peak.value.toFixed(3) } : null,
        paddedMedian: +median.toFixed(3),
        inEventMedian: +inEventMedian.toFixed(3),
        padMax: padMaxSample
          ? {
              t: padMaxSample.timestampMs,
              v: +padMaxSample.value.toFixed(3),
              inMargin:
                padMaxSample.timestampMs < event.startMs || padMaxSample.timestampMs > event.endMs,
            }
          : null,
        marginSampleCount: marginSamples.length,
        rivalCount: rivals.length,
        rivals: rivals.slice(0, 4).map((r) => ({ t: r.timestampMs, v: +r.value.toFixed(3) })),
        valleyToMarginMax: valleyToMarginMax !== null ? +valleyToMarginMax.toFixed(3) : null,
        maxGapMs: padded.length
          ? Math.max(0, ...padded.slice(1).map((s, i) => s.timestampMs - padded[i]!.timestampMs))
          : null,
      },
      null,
      0,
    ),
  );
}
