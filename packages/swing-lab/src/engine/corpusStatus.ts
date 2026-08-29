import { existsSync, readFileSync } from "node:fs";
import { corpusPaths, auditCorpus, loadRecordings, loadSources, readAllEvents } from "./corpus.js";
import { trainingEligible } from "./rights.js";
import { loadSplits } from "./splits.js";

/**
 * pnpm lab:corpus-status — one honest page: what the corpus actually holds.
 * Counts are computed from the registries, never hand-maintained.
 */

const paths = corpusPaths();
const sources = loadSources();
const recordings = loadRecordings();
const splits = loadSplits(paths.splits);
const events = readAllEvents();

const line = (label: string, value: string | number) =>
  console.log(`${String(label).padEnd(40)} ${value}`);
console.log("═".repeat(72));
console.log("CORPUS STATUS (computed live)");
console.log("═".repeat(72));

const byOrigin = new Map<string, number>();
for (const source of sources) byOrigin.set(source.origin, (byOrigin.get(source.origin) ?? 0) + 1);
line(
  "sources",
  `${sources.length} (${[...byOrigin.entries()].map(([origin, count]) => `${origin} ${count}`).join(" · ")})`,
);
line(
  "training-eligible sources",
  sources.filter((source) => trainingEligible(source.rights)).length,
);
line(
  "rights-unclear sources (quarantined)",
  sources.filter((source) => !trainingEligible(source.rights)).length,
);

const roots = recordings.filter((recording) => recording.derivedFrom.length === 0);
const totalSec = roots.reduce((total, recording) => total + recording.probe.durationMs / 1000, 0);
line(
  "recordings",
  `${recordings.length} (${roots.length} roots + ${recordings.length - roots.length} derived)`,
);
line("root footage", `${(totalSec / 60).toFixed(1)} min`);
line("sessions", new Set(recordings.map((recording) => recording.sessionKey)).size);

const splitCounts = new Map<string, { sessions: Set<string>; seconds: number }>();
for (const recording of roots) {
  const split = splits.assigned[recording.sessionKey]?.split ?? "UNASSIGNED";
  const bucket = splitCounts.get(split) ?? { sessions: new Set(), seconds: 0 };
  bucket.sessions.add(recording.sessionKey);
  bucket.seconds += recording.probe.durationMs / 1000;
  splitCounts.set(split, bucket);
}
console.log("─".repeat(72));
console.log("SPLIT LADDER (session-level, lineage-aware):");
for (const split of ["dev", "val", "locked_test", "shadow", "UNASSIGNED"]) {
  const bucket = splitCounts.get(split);
  if (bucket)
    line(
      `  ${split}`,
      `${bucket.sessions.size} sessions · ${(bucket.seconds / 60).toFixed(1)} min root footage`,
    );
}

console.log("─".repeat(72));
console.log("TIER-C CANDIDATE EVENTS (mined, NOT labels):");
line("  total candidates", events.length);
const bySplit = new Map<string, number>();
for (const event of events) bySplit.set(event.split, (bySplit.get(event.split) ?? 0) + 1);
for (const [split, count] of [...bySplit.entries()].sort()) line(`  ${split}`, count);
const multiPerson = events.filter((event) => event.peopleInScene >= 2).length;
line("  multi-person scenes (TA-bench pool)", multiPerson);
line(
  "  high-uncertainty (≥0.8, annotate first)",
  events.filter((event) => event.uncertainty >= 0.8).length,
);

if (existsSync(paths.factoryState)) {
  const state = JSON.parse(readFileSync(paths.factoryState, "utf8")) as {
    recordings: Record<string, Record<string, { status: string }>>;
  };
  const failed: string[] = [];
  for (const [recordingId, stages] of Object.entries(state.recordings)) {
    for (const [stage, status] of Object.entries(stages)) {
      if (status.status === "failed") failed.push(`${recordingId}:${stage}`);
    }
  }
  console.log("─".repeat(72));
  line("factory failed stages", failed.length === 0 ? "none" : failed.join(", "));
}

const problems = auditCorpus();
console.log("─".repeat(72));
if (problems.length === 0) console.log("integrity: OK (ids, hashes, lineage, licenses, files)");
else {
  console.log("INTEGRITY PROBLEMS:");
  for (const problem of problems) console.log(`  ✗ ${problem}`);
  process.exitCode = 1;
}
