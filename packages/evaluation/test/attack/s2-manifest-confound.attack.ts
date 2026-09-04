/**
 * ATTACK S2 — in a throwaway git repo fixture, change
 * `datasets/releases/<x>/manifest.json` and confirm `bench:compare` reports
 * `CONFOUND provenance.datasetReleases` WITHOUT failing (exit 0).
 *
 * Two variants:
 *   (a) committed manifest edit  → manifestSha256 AND datasetsTreeSha change
 *   (b) uncommitted manifest edit → manifestSha256 changes, datasetsTreeSha
 *       (computed from HEAD) does NOT, gitDirty flips to true
 * plus the sharper question the scenario implies: can a release edit that
 * keeps the manifest byte-identical but swaps a referenced artifact slip past
 * the release confound? (It is caught by datasetsTreeSha instead.)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectDatasetReleases, datasetsInputTreeSha } from "../../src/regression/run.js";
import { summary } from "../regressionFixtures.js";
import { git, makeTempDir, runCli, writeEvidence } from "./attackUtil.js";

const RELEASE_DIR = "pickle-sensei-datasets-v9";

function commitAll(root: string, message: string): string {
  git(["add", "-A"], root);
  git(
    [
      "-c",
      "user.name=attack",
      "-c",
      "user.email=attack@example.invalid",
      "commit",
      "-q",
      "-m",
      message,
    ],
    root,
  );
  return git(["rev-parse", "HEAD"], root);
}

function writeManifest(root: string, extra: Record<string, unknown>): void {
  const manifest = {
    schemaVersion: 1,
    releaseId: "pickle-sensei-datasets@v9",
    datasetId: "pickle-sensei-datasets",
    version: "v9",
    createdAtIso: "2026-09-04T00:00:00.000Z",
    immutable: true,
    components: [{ componentId: "gold", path: "datasets/gold" }],
    ...extra,
  };
  const dir = join(root, "datasets/releases", RELEASE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

interface Snapshot {
  gitSha: string;
  treeSha: string;
  releases: ReturnType<typeof collectDatasetReleases>;
  dirty: boolean;
}

function snapshot(root: string): Snapshot {
  return {
    gitSha: git(["rev-parse", "HEAD"], root),
    treeSha: datasetsInputTreeSha(root),
    releases: collectDatasetReleases(root),
    dirty: git(["status", "--porcelain"], root).length > 0,
  };
}

function summaryFor(snap: Snapshot, runId: string) {
  return summary({
    runId,
    provenance: {
      ...summary().provenance,
      gitSha: snap.gitSha,
      gitDirty: snap.dirty,
      datasetsTreeSha: snap.treeSha,
      datasetReleases: snap.releases,
    },
  });
}

function compare(dir: string, label: string, a: Snapshot, b: Snapshot) {
  const basePath = join(dir, `${label}-baseline.json`);
  const candPath = join(dir, `${label}-candidate.json`);
  writeFileSync(basePath, JSON.stringify(summaryFor(a, "baseline")));
  writeFileSync(candPath, JSON.stringify(summaryFor(b, "candidate")));
  const human = runCli(["compare", basePath, candPath]);
  const json = runCli(["compare", basePath, candPath, "--json"]);
  const report = JSON.parse(json.stdout) as {
    exitCode: number;
    comparable: boolean;
    warnings: string[];
    identityDifferences: Array<{ field: string; severity: string }>;
  };
  return { human, json, report };
}

describe("S2: datasets/releases/<x>/manifest.json change → CONFOUND provenance.datasetReleases", () => {
  let root = "";
  let scratch = "";
  let before: Snapshot;

  beforeAll(() => {
    root = makeTempDir("attack-s2-repo");
    scratch = makeTempDir("attack-s2-out");
    git(["init", "-q", "-b", "main"], root);
    mkdirSync(join(root, "datasets/gold"), { recursive: true });
    mkdirSync(join(root, "datasets/reports/regression"), { recursive: true });
    writeFileSync(join(root, "datasets/gold/events.json"), '{"events":[{"t":1}]}\n');
    writeFileSync(join(root, "datasets/reports/regression/baseline.json"), "{}\n");
    writeManifest(root, {});
    commitAll(root, "fixture: initial datasets + release manifest");
    before = snapshot(root);
  });

  afterAll(() => {
    // Leave the fixture repo on disk for inspection; it lives under tmpdir.
    writeEvidence("s2-manifest-confound-paths", { fixtureRepo: root, scratch });
  });

  it("(a) committed manifest edit: manifestSha256 changes and compare exits 0 with the confound", () => {
    writeManifest(root, { createdAtIso: "2026-09-04T00:00:01.000Z" });
    commitAll(root, "edit manifest (committed)");
    const after = snapshot(root);
    expect(after.releases[0]!.manifestSha256).not.toBe(before.releases[0]!.manifestSha256);
    expect(after.treeSha).not.toBe(before.treeSha);

    const { human, json, report } = compare(scratch, "committed", before, after);
    expect(json.exitCode).toBe(0);
    expect(human.exitCode).toBe(0);
    expect(report.comparable).toBe(true);
    expect(report.warnings.some((w) => w.startsWith("CONFOUND provenance.datasetReleases"))).toBe(
      true,
    );
    expect(report.warnings.some((w) => w.startsWith("CONFOUND provenance.datasetsTreeSha"))).toBe(
      true,
    );
    expect(human.stdout).toContain("CONFOUND provenance.datasetReleases");
    writeEvidence("s2a-committed-manifest-edit", {
      scenario: "S2a",
      classification: "HELD",
      before: { manifestSha256: before.releases[0]!.manifestSha256, treeSha: before.treeSha },
      after: { manifestSha256: after.releases[0]!.manifestSha256, treeSha: after.treeSha },
      exitCode: json.exitCode,
      warnings: report.warnings,
      humanReport: human.stdout,
    });
  });

  it("(b) uncommitted manifest edit: only the release confound + gitDirty fire; treeSha (HEAD) is unchanged", () => {
    const committed = snapshot(root);
    writeManifest(root, { createdAtIso: "2026-09-04T00:00:02.000Z", note: "uncommitted" });
    const dirty = snapshot(root);
    expect(dirty.dirty).toBe(true);
    expect(dirty.treeSha).toBe(committed.treeSha);
    expect(dirty.releases[0]!.manifestSha256).not.toBe(committed.releases[0]!.manifestSha256);

    const { json, report } = compare(scratch, "uncommitted", committed, dirty);
    expect(json.exitCode).toBe(0);
    const fields = report.identityDifferences.map((d) => d.field);
    expect(fields).toContain("provenance.datasetReleases");
    expect(fields).toContain("provenance.gitDirty");
    expect(fields).not.toContain("provenance.datasetsTreeSha");
    writeEvidence("s2b-uncommitted-manifest-edit", {
      scenario: "S2b",
      classification: "HELD",
      exitCode: json.exitCode,
      identityDifferences: report.identityDifferences,
      warnings: report.warnings,
    });
    git(["checkout", "--", "datasets/releases"], root);
  });

  it("(c) byte-identical manifest but swapped gold artifact: release confound silent, treeSha confound catches it", () => {
    const pre = snapshot(root);
    writeFileSync(join(root, "datasets/gold/events.json"), '{"events":[{"t":2}]}\n');
    commitAll(root, "swap gold artifact, manifest untouched");
    const post = snapshot(root);
    expect(post.releases[0]!.manifestSha256).toBe(pre.releases[0]!.manifestSha256);
    expect(post.treeSha).not.toBe(pre.treeSha);

    const { json, report } = compare(scratch, "artifact-swap", pre, post);
    expect(json.exitCode).toBe(0);
    const fields = report.identityDifferences.map((d) => d.field);
    expect(fields).not.toContain("provenance.datasetReleases");
    expect(fields).toContain("provenance.datasetsTreeSha");
    writeEvidence("s2c-artifact-swap-manifest-identical", {
      scenario: "S2c",
      classification: "HELD (datasetsTreeSha covers what the manifest hash cannot)",
      exitCode: json.exitCode,
      identityDifferences: report.identityDifferences,
    });
  });

  it("(d) release directory renamed with identical manifest bytes is still a release confound (releaseDir is part of the key)", () => {
    const pre = snapshot(root);
    git(["mv", `datasets/releases/${RELEASE_DIR}`, "datasets/releases/renamed-release"], root);
    commitAll(root, "rename release dir");
    const post = snapshot(root);
    expect(post.releases[0]!.manifestSha256).toBe(pre.releases[0]!.manifestSha256);
    expect(post.releases[0]!.releaseDir).toBe("renamed-release");
    const { json, report } = compare(scratch, "dir-rename", pre, post);
    expect(json.exitCode).toBe(0);
    expect(report.identityDifferences.map((d) => d.field)).toContain("provenance.datasetReleases");
  });
});
