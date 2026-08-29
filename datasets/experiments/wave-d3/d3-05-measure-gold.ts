// D3-05 positive-gold coverage: run segmentPhasesTemporalV2 on the COMMITTED
// wave-a event-bounds gold (datasets/paddle-bench/stroke-gold.json) against
// wrist speeds derived from the committed windowed people.json bundles
// (datasets/paddle-bench/runs-wave-a). Held-out cases (wm-dink-01,
// afn-vic-rally1) are not present in these bundles and are never touched.
// Person selection: the person with the greatest wrist travel inside the gold
// event; speed recipe mirrors analyzeVideo.ts dominantWristSpeeds.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
// Run from packages/swing-lab (its tsx + deps):
//   cd packages/swing-lab && npx tsx ../../datasets/experiments/wave-d3/d3-05-measure-gold.ts
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
  // Greedy nearest-person association per frame is overkill for these single
  // dominant-player windows: associate by person index ordering per frame is
  // unstable, so instead pick, per frame, the person whose torso is closest to
  // the previous chosen torso (seeded by the person closest to frame center).
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
let anchoredSeg = 0;
let anchoredTotal = 0;
let freeSeg = 0;
let freeTotal = 0;
const rows: string[] = [];
for (const label of gold.labels) {
  const runDir = join(RUNS, label.caseId);
  if (!existsSync(join(runDir, "people.json"))) continue; // non-wave-a cases have no committed bundle here
  if (!peopleCache.has(label.caseId)) {
    peopleCache.set(
      label.caseId,
      JSON.parse(readFileSync(join(runDir, "people.json"), "utf8")) as PeopleFile,
    );
  }
  const event = { startMs: label.eventStartMs, endMs: label.eventEndMs };
  const speeds = wristSpeeds(peopleCache.get(label.caseId)!, event);
  for (const mode of ["anchored", "anchor-free"] as const) {
    if (mode === "anchored" && label.contactMs === null) continue;
    const outcome = segmentPhasesTemporalV2({
      event,
      contactMs: mode === "anchored" ? label.contactMs : null,
      paddleSpeeds: null,
      wristSpeeds: speeds,
    });
    if (mode === "anchored") {
      anchoredTotal += 1;
      if (outcome.status === "segmented") anchoredSeg += 1;
    } else {
      freeTotal += 1;
      if (outcome.status === "segmented") freeSeg += 1;
    }
    rows.push(
      `${label.caseId}@${label.eventStartMs} ${mode}: ${outcome.status}${outcome.status === "abstained" ? " " + outcome.reason.split(":")[0] : ""}`,
    );
  }
}
console.log(rows.join("\n"));
console.log(
  JSON.stringify({
    anchored: `${anchoredSeg}/${anchoredTotal}`,
    anchorFree: `${freeSeg}/${freeTotal}`,
  }),
);
