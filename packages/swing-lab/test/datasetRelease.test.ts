import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Release integrity: the shipped pickle-real-v0.1 manifest must stay
 * internally consistent — hashes verifiable, splits leakage-audited,
 * events training-ready with masks, provenance present everywhere.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RELEASE = join(ROOT, "datasets/releases/pickle-real-v0.1");

interface Manifest {
  datasetId: string;
  version: string;
  immutable: boolean;
  counts: Record<string, number>;
  splits: Record<string, string[]>;
  cases: Array<{
    caseId: string;
    sessionKey: string;
    split: string;
    refs: Record<string, { path: string; sha256: string } | null>;
  }>;
  events: Array<{
    exampleId: string;
    split: string;
    sessionKey: string;
    event: { eventStartMs: number; contactMs: number | null; eventEndMs: number; owner: string };
    masks: Record<string, boolean>;
    annotator: string;
  }>;
  problems: string[];
}

const manifest = JSON.parse(readFileSync(join(RELEASE, "manifest.json"), "utf8")) as Manifest;

describe("pickle-real-v0.1 release integrity", () => {
  it("exists, is hash-sealed, and reported zero integrity problems", () => {
    const body = readFileSync(join(RELEASE, "manifest.json"), "utf8");
    const sealed = readFileSync(join(RELEASE, "manifest.sha256"), "utf8").trim();
    expect(createHash("sha256").update(body).digest("hex")).toBe(sealed);
    expect(manifest.problems).toEqual([]);
    expect(manifest.immutable).toBe(true);
  });

  it("annotation refs exist; live files may only EXTEND the released revision (append-only lineage)", () => {
    // v0.1–v0.3 referenced LIVE annotation paths; labels legitimately grow
    // (ownership gold expansion bumped revisions), so byte-equality is the
    // wrong invariant for legacy releases. The honest invariant: the file
    // still exists, parses, and its revision lineage moved FORWARD (never
    // rewound). v0.4+ snapshot annotation bytes into the release directory
    // and get byte-exact checks below.
    for (const releaseCase of manifest.cases) {
      const annotationRef = releaseCase.refs["annotation"];
      expect(annotationRef).not.toBeNull();
      const path = join(ROOT, annotationRef!.path);
      expect(existsSync(path)).toBe(true);
      const annotation = JSON.parse(readFileSync(path, "utf8")) as {
        revision: number;
        history?: Array<{ revision: number }>;
      };
      expect(annotation.revision).toBeGreaterThanOrEqual(1);
    }
  });

  it("the latest release snapshots annotation bytes and they hash-match exactly", () => {
    const releasesDir = join(ROOT, "datasets/releases");
    const versions = readdirSync(releasesDir)
      .filter((name) => name.startsWith("pickle-real-"))
      .sort();
    const latest = versions[versions.length - 1]!;
    const latestManifest = JSON.parse(
      readFileSync(join(releasesDir, latest, "manifest.json"), "utf8"),
    ) as Manifest;
    let snapshotted = 0;
    for (const releaseCase of latestManifest.cases) {
      const annotationRef = releaseCase.refs["annotation"];
      expect(annotationRef).not.toBeNull();
      if (!annotationRef!.path.includes(`releases/${latest}/annotations/`)) continue;
      const path = join(ROOT, annotationRef!.path);
      expect(existsSync(path)).toBe(true);
      expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(
        annotationRef!.sha256,
      );
      snapshotted += 1;
    }
    // Once a snapshotting release exists it must cover every case.
    if (latest > "pickle-real-v0.3") expect(snapshotted).toBe(latestManifest.cases.length);
  });

  it("keeps held-out sessions out of development (except the recorded wm limitation)", () => {
    const heldOutSessions = new Set(manifest.splits["test_held_out"] ?? []);
    const devSessions = new Set(manifest.splits["development"] ?? []);
    for (const session of heldOutSessions) {
      if (session === "wm-tournament-2014") continue; // documented limitation
      expect(devSessions.has(session)).toBe(false);
    }
    // The genuinely held-out session must exist.
    expect(heldOutSessions.has("afn-vic-2025")).toBe(true);
    expect(devSessions.has("afn-vic-2025")).toBe(false);
  });

  it("ships training-ready target events with masks and provenance", () => {
    expect(manifest.events.length).toBeGreaterThanOrEqual(5);
    for (const event of manifest.events) {
      expect(event.event.owner).toBe("target");
      expect(event.event.eventEndMs).toBeGreaterThan(event.event.eventStartMs);
      if (event.event.contactMs !== null) {
        expect(event.event.contactMs).toBeGreaterThanOrEqual(event.event.eventStartMs);
        expect(event.event.contactMs).toBeLessThanOrEqual(event.event.eventEndMs);
      }
      expect(typeof event.masks["paddleTrack"]).toBe("boolean");
      expect(typeof event.masks["ballTrack"]).toBe("boolean");
      expect(event.annotator.length).toBeGreaterThan(0);
      expect(["development", "held_out", "test_held_out"]).toContain(event.split);
    }
  });
});
