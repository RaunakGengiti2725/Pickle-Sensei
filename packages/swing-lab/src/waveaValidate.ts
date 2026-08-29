import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import { validateAnnotation } from "./annotationSchema.js";

/** One-shot schema validation of the wave-a-touched annotation files. */
const files = [
  "afn-sasebo-rally1/annotation/devin-visual-v1.json",
  "afn-sasebo-rally2/annotation/devin-visual-v1.json",
  "wm-volley-02/annotation/devin-visual-v1.json",
  "wavea-marne-serve/annotation/devin-visual-v2-wave-a.json",
  "wavea-faead-feed/annotation/devin-visual-v2-wave-a.json",
  "wavea-faead-rally/annotation/devin-visual-v2-wave-a.json",
  "wavea-944403-dink/annotation/devin-visual-v2-wave-a.json",
  "wavea-944403-smash/annotation/devin-visual-v2-wave-a.json",
  "wavea-wgm-wheelchair/annotation/devin-visual-v2-wave-a.json",
  "wavea-sasebo-volleys/annotation/devin-visual-v2-wave-a.json",
];
let bad = 0;
for (const file of files) {
  const problems = validateAnnotation(
    JSON.parse(readFileSync(join(REPO_ROOT, "datasets/paddle-bench/bundles", file), "utf8")),
  );
  if (problems.length > 0) {
    bad += 1;
    console.log("FAIL", file, problems);
  } else {
    console.log("ok  ", file);
  }
}
process.exit(bad > 0 ? 1 : 0);
