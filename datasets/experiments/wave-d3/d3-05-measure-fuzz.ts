/* eslint-disable no-console */
// Coverage measurement for D3-05: segmentation counts over the SAME fuzz
// corpus used by test/propertyInvariants.test.ts (300 seeds).
// Run from packages/swing-lab (its tsx + deps):
//   cd packages/swing-lab && npx tsx ../../datasets/experiments/wave-d3/d3-05-measure-fuzz.ts
import { segmentPhasesTemporalV2 } from "../../../packages/swing-lab/src/phaseTemporal.js";

const rng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
};

// Mirror of randomSeries in propertyInvariants.test.ts
function randomSeries(rand: () => number, clipEndMs: number) {
  const stepMs = 20 + Math.floor(rand() * 30);
  const series: Array<{ timestampMs: number; value: number }> = [];
  let value = rand() * 0.4;
  for (let t = 0; t <= clipEndMs; t += stepMs) {
    value = Math.max(0, value + (rand() - 0.5) * 0.4);
    if (rand() < 0.05) value += rand() * 4;
    series.push({ timestampMs: t, value });
  }
  return series;
}

let segmented = 0;
let anchorFree = 0;
let anchored = 0;
for (let seed = 1; seed <= 300; seed += 1) {
  const rand = rng(seed * 40503 + 7);
  const clipEndMs = 1500 + Math.floor(rand() * 6000);
  const startMs = Math.floor(rand() * 1000);
  const endMs = startMs + 300 + Math.floor(rand() * 2000);
  const contactMs =
    rand() < 0.4
      ? null
      : startMs + Math.floor(rand() * (endMs - startMs) * 1.4 - (endMs - startMs) * 0.2);
  const peakMs = rand() < 0.5 ? undefined : startMs + Math.floor(rand() * (endMs - startMs));
  const outcome = segmentPhasesTemporalV2({
    event: peakMs === undefined ? { startMs, endMs } : { startMs, endMs, peakMs },
    contactMs,
    paddleSpeeds: rand() < 0.3 ? null : randomSeries(rand, clipEndMs),
    wristSpeeds: rand() < 0.3 ? null : randomSeries(rand, clipEndMs),
  });
  if (outcome.status !== "segmented") continue;
  segmented += 1;
  if (outcome.boundaries.anchorBasis === "event_peak") anchorFree += 1;
  else anchored += 1;
}
console.log(JSON.stringify({ segmented, anchored, anchorFree }));
