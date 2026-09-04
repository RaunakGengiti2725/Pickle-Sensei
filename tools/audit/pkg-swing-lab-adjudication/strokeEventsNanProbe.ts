/**
 * Adjudicator probe: proposeStrokeEventsV2 is byte-identical in
 * packages/swing-lab/src/strokeEvents.ts and
 * packages/analysis-pipeline/src/sessionEngine.ts (the copy the mobile app
 * uses through SessionEventEngine). Both accept inverted clip bounds and let
 * a single NaN wrist sample disable the amplitude gate.
 *
 *   cd packages/swing-lab && npx tsx ../../tools/audit/pkg-swing-lab-adjudication/strokeEventsNanProbe.ts
 */
import { proposeStrokeEventsV2 as lab } from "../../../packages/swing-lab/src/strokeEvents.js";
import { proposeStrokeEventsV2 as pipe } from "../../../packages/analysis-pipeline/src/sessionEngine.js";

const wrist: Array<{ timestampMs: number; value: number }> = [];
for (let i = 0; i < 60; i++) wrist.push({ timestampMs: i * 33, value: i > 20 && i < 30 ? 2.5 : 0.05 });

for (const [name, fn] of [
  ["swing-lab", lab],
  ["analysis-pipeline", pipe],
] as const) {
  const inverted = fn({ paddleSpeeds: null, wristSpeeds: wrist, clipStartMs: 2000, clipEndMs: 0 });
  const jitter = wrist.map((s, i) => ({ ...s, value: i === 40 ? Number.NaN : 0.05 }));
  const nan = fn({ paddleSpeeds: null, wristSpeeds: jitter, clipStartMs: 0, clipEndMs: 2000 });
  console.log(
    name,
    JSON.stringify({ invertedClipEvents: inverted.events.length, nanJitterEvents: nan.events.length }),
  );
}
