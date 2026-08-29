import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { RecordingRecord, SplitName } from "./corpus.js";

/**
 * FOUR-LAYER EVALUATION LADDER with deterministic, lineage-aware assignment.
 *
 *   dev         — inspected freely; debugging and iteration
 *   val         — model/threshold decisions
 *   locked_test — evaluated rarely, never tuned against
 *   shadow      — untouched; replenished by new sessions automatically
 *
 * Assignment is a pure function of sessionKey (salted SHA-256 → bucket), so
 * newly acquired sessions land in a split before anyone has seen a frame —
 * shadow stays sacred because nobody chooses what goes into it. Sessions
 * that were already inspected in past runs are PINNED with the reason
 * recorded; pins can tighten (dev→) but never loosen (→shadow).
 *
 * Split lives at SESSION level (the strongest grouping we can verify today);
 * every recording of a session inherits it, and lineage forces derived
 * recordings into the parent's session — a subclip can never drift into a
 * different split than its source material.
 */

export const SPLIT_POLICY_VERSION = "splits-v1" as const;
const HASH_SALT = "pickle-sensei-splits-v1";

/** dev 50% · val 20% · locked_test 15% · shadow 15% */
const BUCKETS: Array<{ split: SplitName; upto: number }> = [
  { split: "dev", upto: 50 },
  { split: "val", upto: 70 },
  { split: "locked_test", upto: 85 },
  { split: "shadow", upto: 100 },
];

export interface SplitsFile {
  schemaVersion: 1;
  policyVersion: typeof SPLIT_POLICY_VERSION;
  proportions: Record<SplitName, number>;
  pinned: Record<string, { split: SplitName; reason: string }>;
  assigned: Record<
    string,
    { split: SplitName; method: "pinned" | "deterministic"; assignedAtIso: string }
  >;
}

export function deterministicSplit(sessionKey: string): SplitName {
  const digest = createHash("sha256").update(`${HASH_SALT}:${sessionKey}`).digest();
  const bucket = ((digest[0]! << 8) | digest[1]!) % 100;
  return BUCKETS.find((entry) => bucket < entry.upto)!.split;
}

export function loadSplits(path: string): SplitsFile {
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as SplitsFile;
  return {
    schemaVersion: 1,
    policyVersion: SPLIT_POLICY_VERSION,
    proportions: { dev: 0.5, val: 0.2, locked_test: 0.15, shadow: 0.15 },
    pinned: {},
    assigned: {},
  };
}

export function saveSplits(path: string, splits: SplitsFile): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const sorted: SplitsFile = {
    ...splits,
    pinned: Object.fromEntries(
      Object.entries(splits.pinned).sort(([a], [b]) => a.localeCompare(b)),
    ),
    assigned: Object.fromEntries(
      Object.entries(splits.assigned).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  writeFileSync(tmp, JSON.stringify(sorted, null, 2));
  renameSync(tmp, path);
}

/** Assign (or return existing) split for a session. Assignments are sticky. */
export function assignSplit(splits: SplitsFile, sessionKey: string): SplitName {
  const existing = splits.assigned[sessionKey];
  if (existing) return existing.split;
  const pinned = splits.pinned[sessionKey];
  const split = pinned?.split ?? deterministicSplit(sessionKey);
  splits.assigned[sessionKey] = {
    split,
    method: pinned ? "pinned" : "deterministic",
    assignedAtIso: new Date().toISOString(),
  };
  return split;
}

export interface LeakageFinding {
  severity: "problem" | "warning";
  message: string;
}

/**
 * Lineage-aware leakage audit:
 *  - a session must resolve to exactly one split;
 *  - a derived recording must share its parent's session (else two splits
 *    could hold near-identical pixels);
 *  - detected-but-undeclared overlap is reported by the dedup stage and
 *    passed in here as pre-computed findings.
 */
export function auditSplits(
  recordings: RecordingRecord[],
  splits: SplitsFile,
  extraFindings: LeakageFinding[] = [],
): LeakageFinding[] {
  const findings: LeakageFinding[] = [...extraFindings];
  const byId = new Map(recordings.map((recording) => [recording.recordingId, recording]));
  for (const recording of recordings) {
    if (!splits.assigned[recording.sessionKey]) {
      findings.push({
        severity: "problem",
        message: `${recording.recordingId}: session ${recording.sessionKey} has no split assignment`,
      });
    }
    for (const lineage of recording.derivedFrom) {
      const parent = byId.get(lineage.parentRecordingId);
      if (parent && parent.sessionKey !== recording.sessionKey) {
        findings.push({
          severity: "problem",
          message: `LEAKAGE RISK: ${recording.recordingId} (session ${recording.sessionKey}) derives from ${parent.recordingId} (session ${parent.sessionKey}) — derived material must inherit the parent session`,
        });
      }
    }
  }
  return findings;
}
