import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  REPO_ROOT,
  collectModelVersions,
  contactReplayMetrics,
} from "../src/regression/benches.js";
import { main, parseArgs, resolveUserPath } from "../src/regression/cli.js";
import {
  assertValidRunId,
  collectDatasetReleases,
  collectProvenance,
  datasetsInputTreeSha,
  describeTreeDirt,
  dirtyTreeCaveats,
  executeBench,
  isTreeDirty,
  runRegression,
  timestampRunId,
  untrackedDatasetInputs,
} from "../src/regression/run.js";
import { validateRegressionSummary } from "../src/index.js";

const scratch = mkdtempSync(join(tmpdir(), "pickle-regression-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("provenance", () => {
  it("discovers every committed dataset release manifest with a content hash", () => {
    const releases = collectDatasetReleases();
    expect(releases.length).toBeGreaterThan(0);
    for (const release of releases) {
      expect(release.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(release.releaseId.length).toBeGreaterThan(0);
      expect(
        existsSync(join(REPO_ROOT, "datasets/releases", release.releaseDir, "manifest.json")),
      ).toBe(true);
    }
    expect(releases.map((release) => release.releaseDir)).toEqual(
      [...releases.map((release) => release.releaseDir)].sort(),
    );
  });

  it("returns an empty list when the releases directory does not exist", () => {
    expect(collectDatasetReleases(join(scratch, "nowhere"))).toEqual([]);
  });

  it("dataset identity tracks bench inputs and ignores committed reports", () => {
    const repo = join(scratch, "identity-repo");
    const git = (...args: string[]): string =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      }).trim();
    mkdirSync(join(repo, "datasets/gold"), { recursive: true });
    mkdirSync(join(repo, "datasets/reports/regression"), { recursive: true });
    writeFileSync(join(repo, "datasets/gold/a.json"), "1");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "inputs");
    const before = datasetsInputTreeSha(repo);
    expect(before).toMatch(/^[0-9a-f]{40}$/);

    writeFileSync(join(repo, "datasets/reports/regression/baseline.json"), "{}");
    git("add", "-A");
    git("commit", "-q", "-m", "report");
    expect(datasetsInputTreeSha(repo)).toBe(before);

    writeFileSync(join(repo, "datasets/gold/a.json"), "2");
    git("add", "-A");
    git("commit", "-q", "-m", "input change");
    expect(datasetsInputTreeSha(repo)).not.toBe(before);

    // Untracked files: a report never dirties the tree, an input always does.
    expect(isTreeDirty(repo)).toBe(false);
    writeFileSync(join(repo, "datasets/reports/regression/2026.json"), "{}");
    expect(untrackedDatasetInputs(repo)).toEqual([]);
    expect(isTreeDirty(repo)).toBe(false);
    writeFileSync(join(repo, "datasets/gold/extra.json"), "3");
    expect(untrackedDatasetInputs(repo)).toEqual(["datasets/gold/extra.json"]);
    expect(isTreeDirty(repo)).toBe(true);
    expect(datasetsInputTreeSha(repo)).toBe(datasetsInputTreeSha(repo));

    // The caveat names the kind of dirt that is actually present.
    const untrackedOnly = describeTreeDirt(repo);
    expect(untrackedOnly).toEqual({
      trackedChanges: [],
      untrackedDatasetInputs: ["datasets/gold/extra.json"],
    });
    const untrackedCaveats = dirtyTreeCaveats(untrackedOnly);
    expect(untrackedCaveats).toHaveLength(1);
    expect(untrackedCaveats[0]).toContain("untracked dataset inputs (1: datasets/gold/extra.json)");
    expect(untrackedCaveats[0]).not.toContain("uncommitted tracked changes");

    writeFileSync(join(repo, "datasets/gold/a.json"), "4");
    const both = describeTreeDirt(repo);
    expect(both.trackedChanges).toEqual(["datasets/gold/a.json"]);
    const bothCaveats = dirtyTreeCaveats(both);
    expect(bothCaveats).toHaveLength(2);
    expect(bothCaveats[0]).toContain("uncommitted tracked changes (1: datasets/gold/a.json)");
    expect(bothCaveats[1]).toContain("untracked dataset inputs (1: datasets/gold/extra.json)");
    expect(dirtyTreeCaveats({ trackedChanges: [], untrackedDatasetInputs: [] })).toEqual([]);
  });

  it("accepts only single-component run ids", () => {
    expect(assertValidRunId(timestampRunId(new Date(0)))).toBe("1970-01-01T00-00-00.000Z");
    expect(assertValidRunId("test-run_2")).toBe("test-run_2");
    for (const bad of ["", "../x", "a/b", "a\\b", ".hidden", "-dash", "x".repeat(129), "a b"]) {
      expect(() => assertValidRunId(bad)).toThrow(/invalid run id/);
    }
  });

  it("reads git identity and every registered model/provider version", () => {
    const provenance = collectProvenance();
    expect(provenance.gitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(provenance.datasetsTreeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(provenance.datasetsTreeSha).toBe(datasetsInputTreeSha());
    expect(provenance.evidenceClass).toBe("linux_replay_proxy");
    expect(typeof provenance.gitDirty).toBe("boolean");
    const versions = collectModelVersions();
    expect(versions).toEqual(provenance.modelVersions);
    for (const [key, value] of Object.entries(versions)) {
      expect(key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
      expect(value.length).toBeGreaterThan(0);
    }
    expect(Object.keys(versions)).toContain("contactEstimator");
    expect(Object.keys(versions)).toContain("strokeHeuristic");
  });

  it("produces filesystem-safe UTC run ids", () => {
    expect(timestampRunId(new Date("2026-09-04T02:03:04.567Z"))).toBe("2026-09-04T02-03-04.567Z");
  });
});

describe("executeBench", () => {
  const definition = {
    id: "fake_bench",
    title: "fake",
    command: "noop",
    cwd: "/tmp",
    inputs: ["none"],
    caveats: [],
  };

  it("records ok in-process results with a null exit code and a wall clock", async () => {
    const record = await executeBench(
      {
        ...definition,
        kind: "in_process",
        run: () => ({ metrics: { a: 1, b: null }, labels: { v: "x" } }),
      },
      () => null,
    );
    expect(record.status).toBe("ok");
    expect(record.exitCode).toBeNull();
    expect(record.metrics).toEqual({ a: 1, b: null });
    expect(record.wallClockMs).toBeGreaterThanOrEqual(0);
    expect(record.error).toBeNull();
  });

  it("turns a throwing bench into a failed record carrying the subprocess exit code", async () => {
    const record = await executeBench(
      {
        ...definition,
        kind: "subprocess",
        run: () => {
          throw new Error("tsx script.ts exited 1");
        },
      },
      () => 1,
    );
    expect(record.status).toBe("failed");
    expect(record.exitCode).toBe(1);
    expect(record.metrics).toEqual({});
    expect(record.error).toContain("exited 1");
  });

  it("uses -1 when a subprocess bench failed before spawning anything", async () => {
    const record = await executeBench(
      {
        ...definition,
        kind: "subprocess",
        run: () => {
          throw new Error("missing input");
        },
      },
      () => null,
    );
    expect(record.exitCode).toBe(-1);
  });
});

describe("contactReplayMetrics", () => {
  it("keeps abstentions as abstentions and nulls the percentiles when nothing was estimated", () => {
    const row = (
      owner: "target" | "other",
      status: "estimated" | "abstained",
      errorMs: number | null,
    ) =>
      ({
        event: { owner },
        status,
        estimatedContactMs: errorMs === null ? null : 1000 + errorMs,
        confidence: errorMs === null ? null : 0.9,
        errorMs,
        reason: errorMs === null ? "no_ball" : null,
        limitingFactors: [],
        ballConfirmed: null,
        supportingEvidence: [],
      }) as unknown as Parameters<typeof contactReplayMetrics>[0][number];
    const metrics = contactReplayMetrics([
      row("target", "abstained", null),
      row("other", "estimated", 10),
    ]);
    expect(metrics.rows_replayed).toBe(2);
    expect(metrics.target_events).toBe(1);
    expect(metrics.estimated).toBe(0);
    expect(metrics.abstained).toBe(1);
    expect(metrics.coverage).toBe(0);
    expect(metrics.abstention_rate).toBe(1);
    expect(metrics.wrong_marker_rate_of_estimated).toBeNull();
    expect(metrics.median_error_ms).toBeNull();
    expect(metrics.p90_error_ms).toBeNull();

    const scored = contactReplayMetrics([
      row("target", "estimated", 20),
      row("target", "estimated", 100),
      row("target", "estimated", 200),
      row("target", "abstained", null),
    ]);
    expect(scored.estimated).toBe(3);
    expect(scored.strict_hits).toBe(1);
    expect(scored.acceptable_hits).toBe(2);
    expect(scored.wrong_markers).toBe(1);
    expect(scored.high_confidence_violations).toBe(1);
    expect(scored.coverage).toBe(0.75);
  });
});

describe("parseArgs", () => {
  it("separates positionals from flags and treats --json as boolean", () => {
    const parsed = parseArgs(["compare", "a.json", "b.json", "--tolerances", "t.json", "--json"]);
    expect(parsed.positional).toEqual(["compare", "a.json", "b.json"]);
    expect(parsed.flags.get("tolerances")).toBe("t.json");
    expect(parsed.flags.get("json")).toBe(true);
  });

  it("rejects a value flag without a value", () => {
    expect(() => parseArgs(["run", "--only"])).toThrow("--only requires a value");
    expect(() => parseArgs(["run", "--only", "--json"])).toThrow("--only requires a value");
  });
});

describe("resolveUserPath", () => {
  it("resolves relative paths against pnpm's INIT_CWD, else cwd, and keeps absolute paths", () => {
    expect(resolveUserPath("datasets/x.json", { INIT_CWD: "/repo" })).toBe("/repo/datasets/x.json");
    expect(resolveUserPath("x.json", {})).toBe(join(process.cwd(), "x.json"));
    expect(resolveUserPath("/abs/x.json", { INIT_CWD: "/repo" })).toBe("/abs/x.json");
  });
});

describe("runRegression (real in-process bench, isolated out dir)", () => {
  const outDir = join(scratch, "reports");

  it("writes exactly one validated summary and refuses to overwrite it", async () => {
    const result = await runRegression({
      outDir,
      only: ["contact_replay"],
      runId: "test-run",
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(readdirSync(outDir)).toEqual(["test-run.json"]);
    const onDisk: unknown = JSON.parse(readFileSync(result.outPath, "utf8"));
    const validated = validateRegressionSummary(onDisk);
    expect(validated.ok).toBe(true);
    expect(result.summary.benches.map((bench) => bench.id)).toEqual(["contact_replay"]);
    expect(result.summary.benches[0]?.kind).toBe("in_process");
    expect(result.summary.benches[0]?.exitCode).toBeNull();
    expect(result.summary.benches[0]?.cwd).toBe("packages/vision-geometry");
    expect(result.summary.caveats.some((line) => line.startsWith("Partial run"))).toBe(true);
    expect(result.summary.totalWallClockMs).toBeGreaterThanOrEqual(
      result.summary.benches[0]!.wallClockMs,
    );
    await expect(
      runRegression({ outDir, only: ["contact_replay"], runId: "test-run", log: () => {} }),
    ).rejects.toThrow(/refusing to overwrite/);
  });

  it("rejects unknown bench ids before running anything", async () => {
    await expect(
      runRegression({ outDir, only: ["not_a_bench"], runId: "never", log: () => {} }),
    ).rejects.toThrow(/unknown bench id "not_a_bench"/);
    expect(existsSync(join(outDir, "never.json"))).toBe(false);
  });

  it("rejects a run id that would escape the out dir before running anything", async () => {
    await expect(
      runRegression({ outDir, only: ["contact_replay"], runId: "../escape", log: () => {} }),
    ).rejects.toThrow(/invalid run id/);
    expect(existsSync(join(scratch, "escape.json"))).toBe(false);
  });

  it("compares two summaries of the same run as clean via the CLI", async () => {
    const second = await runRegression({
      outDir,
      only: ["contact_replay"],
      runId: "test-run-2",
      log: () => {},
    });
    const write = process.stdout.write.bind(process.stdout);
    const lines: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(main(["compare", join(outDir, "test-run.json"), second.outPath])).toBe(0);
      expect(main(["compare", join(outDir, "test-run.json"), second.outPath, "--json"])).toBe(0);
      expect(main(["compare", join(outDir, "test-run.json")])).toBe(2);
      expect(main(["compare", join(outDir, "test-run.json"), join(outDir, "missing.json")])).toBe(
        2,
      );
      expect(main(["bogus"])).toBe(2);
    } finally {
      process.stdout.write = write;
    }
    expect(lines[0]).toContain("RESULT: NO REGRESSIONS BEYOND DECLARED TOLERANCES (exit 0)");
    const json = JSON.parse(lines[1]!) as { exitCode: number; comparable: boolean };
    expect(json).toMatchObject({ exitCode: 0, comparable: true });
  });
});
