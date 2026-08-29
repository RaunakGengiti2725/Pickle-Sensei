import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CORPUS_DIR, corpusPaths, loadRecordings, loadSources, saveRecordings } from "./corpus.js";
import { assignSplit, loadSplits, saveSplits } from "./splits.js";

/**
 * SESSION GROUPING — the split unit must match physical reality.
 *
 *   pnpm lab:corpus-sessions
 *
 * A "session" is one venue+occasion. Two videographers filming the same
 * tournament produce different files, different DVIDS ids — and the same
 * players, court, lighting. Splitting them apart would leak.
 *
 * Grouping evidence, strongest first:
 *   1. datasets/corpus/session-groups.json — explicit, human-reviewed, with
 *      reasons (versioned in git; the escape hatch automation can't beat)
 *   2. acquisition metadata — DVIDS location+date now feed sessionKey at
 *      acquisition time (see acquire.ts)
 *   3. pixel-level phash overlap — handled separately by factory dedup
 *
 * Idempotent; orphaned session assignments are pruned; pinned splits win.
 */

interface GroupsFile {
  schemaVersion: 1;
  groups: Array<{ session: string; members: string[]; reason: string }>;
}

const isMain = process.argv[1]?.endsWith("sessionGroup.ts");
if (isMain) {
  const paths = corpusPaths();
  const groupsPath = join(CORPUS_DIR, "session-groups.json");
  if (!existsSync(groupsPath)) {
    console.log("no session-groups.json — nothing to apply");
    process.exit(0);
  }
  const groups = (JSON.parse(readFileSync(groupsPath, "utf8")) as GroupsFile).groups;
  const sources = loadSources();
  const recordings = loadRecordings();
  const splits = loadSplits(paths.splits);
  const sourceIds = new Set(sources.map((source) => source.sourceId));
  let changed = 0;

  for (const group of groups) {
    for (const member of group.members) {
      if (!sourceIds.has(member)) {
        console.log(`  ⚠ ${group.session}: member ${member} not in corpus (skipped)`);
        continue;
      }
      for (const recording of recordings.filter((entry) => entry.sourceId === member)) {
        if (recording.sessionKey !== group.session) {
          console.log(`  ${recording.recordingId}: session ${recording.sessionKey} → ${group.session}`);
          recording.sessionKey = group.session;
          changed += 1;
        }
      }
    }
    assignSplit(splits, group.session);
  }

  // Prune assignments for sessions that no longer own any recording.
  const liveSessions = new Set(recordings.map((recording) => recording.sessionKey));
  for (const session of Object.keys(splits.assigned)) {
    if (!liveSessions.has(session)) {
      delete splits.assigned[session];
      console.log(`  pruned orphaned session assignment: ${session}`);
    }
  }

  saveRecordings(recordings);
  saveSplits(paths.splits, splits);
  console.log(`session grouping applied: ${changed} recordings moved · ${groups.length} groups`);
}
