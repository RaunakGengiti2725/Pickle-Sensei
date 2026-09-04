/**
 * ATTACK S4 — launch two `bench:regression --out-dir <tmp> --run-id a|b
 * --only event_recall,completion_bench` CONCURRENTLY.
 *
 * Both subprocess benches write `<name>-<Date.now()>.json` into a SHARED,
 * committed directory under `datasets/` and the runner identifies "its" file
 * by diffing a readdir snapshot taken before the subprocess ran
 * (`runCapturingNewFile` in benches.ts). Two runners therefore each see two
 * new files, throw `expected exactly one new file ... found 2`, and — because
 * the unlink only happens on the success path — leave BOTH files behind as
 * untracked dataset inputs, which flips `gitDirty` for every later run.
 *
 * Part 1 reproduces the race with two real CLI processes (retrying a few
 * times because it is timing dependent; it reproduced on the first attempt
 * on this box). Part 2 makes the failure mode deterministic by injecting one
 * "foreign" file into the output directory through a wrapped runSubprocess
 * before the real bench script runs. Part 3 probes the neighbouring
 * check-then-write race on the summary path (`refusing to overwrite`).
 *
 * Every file this attack leaves under `datasets/` is removed again.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { benchDefinitions } from "../../src/regression/benches.js";
import type { SubprocessSpec } from "../../src/regression/benches.js";
import { executeBench, isTreeDirty, runSubprocess } from "../../src/regression/run.js";
import {
  REPO_ROOT,
  collect,
  makeTempDir,
  removeNewEntries,
  runCli,
  snapshotDir,
  spawnCli,
  untrackedDatasetPaths,
  writeEvidence,
} from "./attackUtil.js";

const WAVE_E = join(REPO_ROOT, "datasets/experiments/wave-e");
const COMPLETION = join(REPO_ROOT, "datasets/completion-bench");
const ONLY = "event_recall,completion_bench";
const NEEDLE = /expected exactly one new file in (\S+), found (\d+): (.*)$/m;

interface Leftovers {
  waveE: string[];
  completion: string[];
}

function cleanup(beforeWaveE: Set<string>, beforeCompletion: Set<string>): Leftovers {
  return {
    waveE: removeNewEntries(WAVE_E, beforeWaveE),
    completion: removeNewEntries(COMPLETION, beforeCompletion),
  };
}

describe("S4: two concurrent partial runs racing on shared bench output dirs", () => {
  let beforeWaveE: Set<string>;
  let beforeCompletion: Set<string>;
  let untrackedBefore: string[];

  beforeAll(() => {
    beforeWaveE = snapshotDir(WAVE_E);
    beforeCompletion = snapshotDir(COMPLETION);
    untrackedBefore = untrackedDatasetPaths();
  });

  afterAll(() => {
    cleanup(beforeWaveE, beforeCompletion);
    expect(untrackedDatasetPaths()).toEqual(untrackedBefore);
  });

  it("both runners fail with 'expected exactly one new file ... found 2' and leave untracked files behind", async () => {
    const attempts: unknown[] = [];
    let reproduced = false;
    for (let attempt = 1; attempt <= 5 && !reproduced; attempt += 1) {
      const outDir = makeTempDir(`attack-s4-${attempt}`);
      const [a, b] = await Promise.all([
        collect(spawnCli(["run", "--out-dir", outDir, "--run-id", "a", "--only", ONLY])),
        collect(spawnCli(["run", "--out-dir", outDir, "--run-id", "b", "--only", ONLY])),
      ]);
      const summaryA = JSON.parse(readFileSync(join(outDir, "a.json"), "utf8")) as {
        benches: Array<{ id: string; status: string; error: string | null }>;
      };
      const summaryB = JSON.parse(readFileSync(join(outDir, "b.json"), "utf8")) as {
        benches: Array<{ id: string; status: string; error: string | null }>;
      };
      const untrackedNow = untrackedDatasetPaths().filter((p) => !untrackedBefore.includes(p));
      const dirtyWhileLeftBehind = untrackedNow.length > 0 ? isTreeDirty() : null;
      const leftovers = cleanup(beforeWaveE, beforeCompletion);
      const errorsA = summaryA.benches.map((bench) => bench.error);
      const errorsB = summaryB.benches.map((bench) => bench.error);
      const bothFailedFoundTwo =
        a.exitCode === 1 &&
        b.exitCode === 1 &&
        errorsA.every((e) => e !== null && NEEDLE.test(e) && /found 2/.test(e)) &&
        errorsB.every((e) => e !== null && NEEDLE.test(e) && /found 2/.test(e));
      attempts.push({
        attempt,
        outDir,
        exitCodes: { a: a.exitCode, b: b.exitCode },
        stdoutA: a.stdout,
        stdoutB: b.stdout,
        benchErrorsA: errorsA,
        benchErrorsB: errorsB,
        untrackedLeftBehind: untrackedNow,
        gitDirtyWhileLeftBehind: dirtyWhileLeftBehind,
        removedByAttack: leftovers,
      });
      if (
        bothFailedFoundTwo &&
        leftovers.waveE.length === 2 &&
        leftovers.completion.length === 2 &&
        untrackedNow.length === 4 &&
        dirtyWhileLeftBehind === true
      ) {
        reproduced = true;
      }
    }
    const evidencePath = writeEvidence("s4-concurrent-runs", {
      scenario: "S4",
      classification: reproduced ? "BROKEN (reproduced)" : "NOT REPRODUCED in 5 attempts",
      attempts,
    });
    expect(reproduced, `see ${evidencePath}`).toBe(true);
  });

  it("deterministic: one foreign file in the output dir makes the bench fail AND leaves the bench's own output behind", () => {
    const scratch = makeTempDir("attack-s4-scratch");
    let injected: string | null = null;
    const injecting = (spec: SubprocessSpec) => {
      if (spec.script === "src/eventRecallBench.ts") {
        injected = join(WAVE_E, `event-recall-${Date.now() - 1}.json`);
        writeFileSync(injected, "{}\n");
      }
      return runSubprocess(spec);
    };
    const definition = benchDefinitions(injecting, scratch).find((d) => d.id === "event_recall");
    if (!definition) throw new Error("event_recall bench definition not found");
    const record = executeBench(definition, () => 0);
    const created = readdirSync(WAVE_E).filter((name) => !beforeWaveE.has(name));
    const leftovers = cleanup(beforeWaveE, beforeCompletion);
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(NEEDLE);
    expect(record.error).toContain("found 2");
    // The bench's OWN output (a real, valid report) was not consumed and not removed.
    expect(created).toHaveLength(2);
    expect(leftovers.waveE).toHaveLength(2);
    writeEvidence("s4-deterministic-foreign-file", {
      scenario: "S4 (deterministic)",
      classification: "BROKEN",
      injected,
      created,
      record: { status: record.status, exitCode: record.exitCode, error: record.error },
    });
  });

  it("two concurrent runs with the SAME run-id both pass the 'refusing to overwrite' check and silently overwrite one summary", async () => {
    const outDir = makeTempDir("attack-s4-same-id");
    const [a, b] = await Promise.all([
      collect(
        spawnCli(["run", "--out-dir", outDir, "--run-id", "same", "--only", "contact_replay"]),
      ),
      collect(
        spawnCli(["run", "--out-dir", outDir, "--run-id", "same", "--only", "contact_replay"]),
      ),
    ]);
    const files = readdirSync(outDir);
    expect(files).toEqual(["same.json"]);
    const refused = [a, b].filter((r) => /refusing to overwrite existing summary/.test(r.stderr));
    writeEvidence("s4-same-run-id-toctou", {
      scenario: "S4c (same run-id TOCTOU)",
      classification:
        refused.length === 0
          ? "BROKEN (both runs exit 0, one summary silently overwritten)"
          : "HELD (second run refused)",
      exitCodes: { a: a.exitCode, b: b.exitCode },
      stderrA: a.stderr,
      stderrB: b.stderr,
      files,
    });
    // Documenting behaviour rather than asserting the outcome of a race: both
    // outcomes are recorded in evidence. What must hold: exactly one file.
    expect(existsSync(join(outDir, "same.json"))).toBe(true);
  });

  it("a normal sequential partial run of the same two benches succeeds and leaves nothing behind (control)", () => {
    const outDir = makeTempDir("attack-s4-control");
    const result = runCli(["run", "--out-dir", outDir, "--run-id", "control", "--only", ONLY]);
    const leftovers = cleanup(beforeWaveE, beforeCompletion);
    expect(result.exitCode).toBe(0);
    expect(leftovers).toEqual({ waveE: [], completion: [] });
  });
});
