import { generateSwingSequence } from "@pickle/evaluation";
import { toLegacyPoseFrames } from "@pickle/swing-domain";
const { sequence } = generateSwingSequence();
const frames = toLegacyPoseFrames(sequence);
console.log(
  "frames:",
  frames.length,
  "t:",
  frames[0].timestampMs,
  "..",
  frames[frames.length - 1].timestampMs,
);
for (const i of [0, 10, 20, 30, Math.min(frames.length - 1, 45)]) {
  const f = frames[i];
  const vis = f.landmarks.filter((l) => l.visibility >= 0.25);
  const xs = vis.map((l) => l.x),
    ys = vis.map((l) => l.y);
  console.log(
    `t=${f.timestampMs} body x[${Math.min(...xs).toFixed(3)},${Math.max(...xs).toFixed(3)}] y[${Math.min(...ys).toFixed(3)},${Math.max(...ys).toFixed(3)}] marks=${vis.length}`,
  );
}
const wrist = frames[20].landmarks.find((l) => l.name === "right_wrist");
console.log("right_wrist@20:", wrist);
