/**
 * Structural audit (pass 1) — engine/splits.ts contract probes.
 *
 * The module header states: "pins can tighten (dev→) but never loosen
 * (→shadow)" and that lineage-aware leakage is audited. These probes check
 * whether those contracts are enforced by the code. A FAILING case is the
 * evidence for a finding; production code is not modified.
 *
 * Plane: Linux bench.
 */
import { describe, expect, it } from "vitest";
import type { RecordingRecord } from "../src/engine/corpus.js";
import { assignSplit, auditSplits, type SplitsFile } from "../src/engine/splits.js";

function splitsFile(pinned: SplitsFile["pinned"] = {}): SplitsFile {
  return {
    schemaVersion: 1,
    policyVersion: "splits-v1",
    proportions: { dev: 0.5, val: 0.2, locked_test: 0.15, shadow: 0.15 },
    pinned,
    assigned: {},
  };
}

function recording(
  recordingId: string,
  sessionKey: string,
  derivedFrom: RecordingRecord["derivedFrom"] = [],
): RecordingRecord {
  return {
    schemaVersion: 1,
    recordingId,
    sourceId: "src-a",
    path: `datasets/x/${recordingId}.mp4`,
    sha256: "0".repeat(64),
    probe: {
      durationMs: 1000,
      fps: 30,
      width: 1920,
      height: 1080,
      videoCodec: "h264",
      container: "mov,mp4",
      bytes: 1,
    },
    sessionKey,
    registeredAtIso: "2026-01-01T00:00:00.000Z",
    derivedFrom,
  };
}

describe("audit: pins never loosen a session into shadow", () => {
  it("a pinned (i.e. previously inspected) session cannot be assigned to shadow", () => {
    const splits = splitsFile({
      "inspected-session": { split: "shadow", reason: "inspected in run 12" },
    });
    let result: string | null = null;
    let threw = false;
    try {
      result = assignSplit(splits, "inspected-session");
    } catch {
      threw = true;
    }
    // Contract: pins may tighten (→dev) but never loosen (→shadow). Either the
    // pin must be rejected, or the assignment must not land in shadow.
    expect({ threw, result }).not.toEqual({ threw: false, result: "shadow" });
  });
});

describe("audit: lineage audit does not silently ignore dangling parents", () => {
  it("a derived recording whose parent is unknown yields a leakage finding", () => {
    const splits = splitsFile();
    splits.assigned["s1"] = {
      split: "dev",
      method: "deterministic",
      assignedAtIso: "2026-01-01T00:00:00.000Z",
    };
    const derived = recording("rec-child", "s1", [
      {
        parentRecordingId: "rec-missing",
        relation: "time_crop",
        detail: "0-1s",
        evidence: "declared",
      },
    ]);
    const findings = auditSplits([derived], splits);
    expect(findings.length).toBeGreaterThan(0);
  });
});

describe("audit: controls that hold", () => {
  it("derived recording in a different session than its parent is flagged", () => {
    const splits = splitsFile();
    for (const s of ["s1", "s2"]) {
      splits.assigned[s] = {
        split: "dev",
        method: "deterministic",
        assignedAtIso: "2026-01-01T00:00:00.000Z",
      };
    }
    const parent = recording("rec-parent", "s1");
    const child = recording("rec-child", "s2", [
      {
        parentRecordingId: "rec-parent",
        relation: "time_crop",
        detail: "0-1s",
        evidence: "declared",
      },
    ]);
    const findings = auditSplits([parent, child], splits);
    expect(findings.some((f) => f.severity === "problem" && /LEAKAGE/.test(f.message))).toBe(true);
  });

  it("assignments are sticky: an existing assignment is never re-derived", () => {
    const splits = splitsFile();
    const first = assignSplit(splits, "sess-x");
    splits.pinned["sess-x"] = { split: first === "dev" ? "val" : "dev", reason: "late pin" };
    expect(assignSplit(splits, "sess-x")).toBe(first);
  });
});
