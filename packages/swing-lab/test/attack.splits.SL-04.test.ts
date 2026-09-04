/**
 * Adversarial probes for the SL-04 fix (engine/splits.ts on
 * devin/fix-pkg-swing-lab-SL-04-v1 @ f6fd7cb1).
 *
 * Each describe block states whether it is expected to PASS on the candidate
 * (a control that the fix must hold) or whether a failure is the evidence for
 * a finding. Nothing in src/ is modified. Plane: Linux bench.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RecordingRecord } from "../src/engine/corpus.js";
import {
  assignSplit,
  auditSplits,
  deterministicSplit,
  loadSplits,
  type SplitsFile,
} from "../src/engine/splits.js";

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
    sourceId: "src",
    path: `datasets/x/${recordingId}.mp4`,
    sha256: recordingId,
    probe: {
      durationMs: 1000,
      fps: 30,
      width: 1,
      height: 1,
      videoCodec: "h264",
      container: "mp4",
      bytes: 1,
    },
    sessionKey,
    registeredAtIso: "2026-01-01T00:00:00.000Z",
    derivedFrom,
  };
}

function lineage(parentRecordingId: string): RecordingRecord["derivedFrom"][number] {
  return { parentRecordingId, relation: "time_crop", detail: "", evidence: "declared" };
}

function sessionKeyIn(split: string): string {
  for (let index = 0; index < 5000; index += 1) {
    const key = `atk-${index}`;
    if (deterministicSplit(key) === split) return key;
  }
  throw new Error(`no session key hashes into ${split}`);
}

function withTempSplits<T>(contents: unknown, run: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "attack-splits-"));
  try {
    const path = join(dir, "splits.json");
    writeFileSync(path, JSON.stringify(contents));
    return run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── controls: variants of the original SL-04 repro the fix must hold ──────

describe("SL-04 controls (expected to PASS on the candidate)", () => {
  it("rejects a shadow pin even when the deterministic bucket is ALSO shadow", () => {
    const key = sessionKeyIn("shadow");
    const splits = splitsFile({ [key]: { split: "shadow", reason: "seen" } });
    expect(() => assignSplit(splits, key)).toThrow(/shadow/);
    expect(splits.assigned[key]).toBeUndefined();
  });

  it("rejects a shadow pin for every deterministic bucket (dev/val/locked_test)", () => {
    for (const bucket of ["dev", "val", "locked_test"]) {
      const key = sessionKeyIn(bucket);
      const splits = splitsFile({ [key]: { split: "shadow", reason: "seen" } });
      expect(() => assignSplit(splits, key)).toThrow(/shadow/);
    }
  });

  it("a shadow pin added AFTER a sticky assignment does not move the session, and the audit flags the pin", () => {
    const splits = splitsFile();
    const first = assignSplit(splits, "late-pin");
    splits.pinned["late-pin"] = { split: "shadow", reason: "late" };
    expect(assignSplit(splits, "late-pin")).toBe(first);
    const findings = auditSplits([recording("r", "late-pin")], splits);
    expect(
      findings.some((f) => f.severity === "problem" && /late-pin.*shadow/.test(f.message)),
    ).toBe(true);
  });

  it("loadSplits rejects a shadow pin regardless of key order or unicode session keys", () => {
    const pins: SplitsFile["pinned"] = {
      "zzz-last": { split: "dev", reason: "ok" },
      "séance-🏓-2026": { split: "shadow", reason: "seen" },
      "aaa-first": { split: "val", reason: "ok" },
    };
    withTempSplits(splitsFile(pins), (path) => {
      expect(() => loadSplits(path)).toThrow(/séance-🏓-2026.*shadow/);
    });
  });

  it("dangling parent ids of every shape are findings: empty, case-variant, whitespace, self-typo", () => {
    const splits = splitsFile();
    splits.assigned["s1"] = { split: "dev", method: "deterministic", assignedAtIso: "x" };
    const parent = recording("rec-parent", "s1");
    const variants = ["", "REC-PARENT", " rec-parent", "rec-parent\n", "rec-parent2"];
    for (const parentId of variants) {
      const child = recording("rec-child", "s1", [lineage(parentId)]);
      const findings = auditSplits([parent, child], splits);
      expect(findings.filter((f) => f.severity === "problem")).toHaveLength(1);
    }
  });

  it("one finding per dangling lineage entry, and a resolvable sibling entry still gets its own leakage check", () => {
    const splits = splitsFile();
    splits.assigned["s1"] = { split: "dev", method: "deterministic", assignedAtIso: "x" };
    splits.assigned["s2"] = { split: "shadow", method: "deterministic", assignedAtIso: "x" };
    const other = recording("rec-other", "s2");
    const child = recording("rec-child", "s1", [
      lineage("missing-1"),
      lineage("rec-other"),
      lineage("missing-2"),
    ]);
    const findings = auditSplits([other, child], splits);
    expect(findings.filter((f) => /not a registered recording/.test(f.message))).toHaveLength(2);
    expect(findings.filter((f) => /LEAKAGE RISK/.test(f.message))).toHaveLength(1);
  });

  it("assignSplit on a shadow pin leaves the file object byte-identical (no partial mutation)", () => {
    const key = sessionKeyIn("dev");
    const splits = splitsFile({ [key]: { split: "shadow", reason: "seen" } });
    const before = JSON.stringify(splits);
    expect(() => assignSplit(splits, key)).toThrow();
    expect(JSON.stringify(splits)).toBe(before);
  });
});

// ── attack: the new guard only matches the exact literal "shadow" ─────────

describe("ATTACK: pin validation is a strict string compare on unvalidated JSON", () => {
  it("loadSplits/assignSplit accept a pin whose split is not a SplitName (case variant 'Shadow') and assign it", () => {
    const key = sessionKeyIn("dev");
    const file = splitsFile({ [key]: { split: "Shadow" as never, reason: "hand-edited" } });
    withTempSplits(file, (path) => {
      // Expected: a pin that is not one of dev/val/locked_test/shadow is rejected
      // at load (the fix already walks every pin here). Observed on f6fd7cb1: loads.
      expect(() => loadSplits(path)).toThrow();
    });
  });

  it("assignSplit records method:'pinned' with a non-existent bucket instead of rejecting it", () => {
    const key = sessionKeyIn("dev");
    const splits = splitsFile({ [key]: { split: "SHADOW" as never, reason: "hand-edited" } });
    let assigned: string | undefined;
    let threw = false;
    try {
      assigned = assignSplit(splits, key);
    } catch {
      threw = true;
    }
    // Expected: throw, or clamp to a real bucket. Observed: returns "SHADOW" and
    // persists { split: "SHADOW", method: "pinned" } — a bucket no consumer
    // mines (factory.ts minable.includes) and no audit reports.
    expect(threw || ["dev", "val", "locked_test"].includes(assigned ?? "")).toBe(true);
    expect(auditSplits([recording("r", key)], splits).length).toBeGreaterThan(0);
  });
});

// ── attack: loadSplits now dereferences `pinned` unconditionally ───────────

describe("ATTACK: loadSplits on a splits file without a pinned map", () => {
  it("fails with a schema error (or tolerates the file as 4d812e1a did), not a TypeError", () => {
    const { pinned: _dropped, ...withoutPinned } = splitsFile();
    void _dropped;
    withTempSplits(withoutPinned, (path) => {
      // 4d812e1a: returns the file (read-only callers such as corpusStatus,
      // failureMine, targetAcquisitionBench only touch `assigned`).
      // f6fd7cb1: TypeError "Cannot convert undefined or null to object".
      let error: unknown;
      try {
        loadSplits(path);
      } catch (caught) {
        error = caught;
      }
      expect(error).not.toBeInstanceOf(TypeError);
    });
  });
});

// ── pre-existing (fails on 4d812e1a as well; documented, not a regression) ─

describe("PRE-EXISTING: session keys that collide with Object.prototype", () => {
  it("assignSplit returns a SplitName and records an assignment for sessionKey 'constructor'", () => {
    const splits = splitsFile();
    const split = assignSplit(splits, "constructor");
    expect(["dev", "val", "locked_test", "shadow"]).toContain(split);
    expect(Object.hasOwn(splits.assigned, "constructor")).toBe(true);
    const findings = auditSplits([recording("r", "constructor")], { ...splits, assigned: {} });
    expect(findings.some((f) => /no split assignment/.test(f.message))).toBe(true);
  });
});
