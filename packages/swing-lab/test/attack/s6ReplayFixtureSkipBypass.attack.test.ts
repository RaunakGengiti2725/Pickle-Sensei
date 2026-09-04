import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePoseSequence, toLegacyPoseFrames, type PoseSequence } from "@pickle/swing-domain";
import { detectOfflineStrokeWindow } from "@pickle/vision-geometry";
import { REPO_ROOT } from "../../src/engine/corpus.js";
import {
  buildPlayerTracks,
  initializeTargetFromSeed,
  targetPoseSequence,
  type PeopleFile,
} from "../../src/playerTracker.js";
import { proposeStrokeEventsV2 } from "../../src/strokeEvents.js";
import type { SpeedSample } from "../../src/sessionEngine.js";

/**
 * ADVERSARIAL S6 — the session replay suite is green only because its
 * fixtures are absent.
 *
 * test/sessionEngine.test.ts wraps its replay describes in
 * `describe.skipIf(!existsSync(join(runDir, "report.json")))`. The run dirs
 * under datasets/paddle-bench/runs/ are NOT committed, so on every clean
 * checkout the suite reports "4 skipped" and the file is green.
 *
 * Attack: materialize datasets/paddle-bench/runs/afn-sasebo-rally1/ from the
 * committed Linux-bench pose artifacts (tools/latency-bench/artifacts) —
 * people.json / pose.json / extract-meta.json — plus a report.json that is
 * reconstructed by the SAME code path the suite uses, then shift every
 * event bound by exactly 1 ms and run the suite. Three probes:
 *
 *   A. no fixture (baseline)            → suite passes, replay tests skipped
 *   B. exact reconstructed report.json  → suite runs the replay tests (control)
 *   C. bounds shifted by +1 ms          → suite FAILS on the exactness asserts
 *
 * The temporary run dir is removed afterwards; the attack aborts if the
 * directory already exists so a real fixture can never be touched.
 *
 * This file mutates the shared checkout while it runs, and vitest runs test
 * files in parallel — a concurrently-collecting sessionEngine.test.ts would
 * see the temporary fixture. It therefore only runs when explicitly armed:
 *
 *   ATTACK_S6=1 pnpm exec vitest run test/attack/s6ReplayFixtureSkipBypass.attack.test.ts
 */

const RUN_ID = "afn-sasebo-rally1";
const RUN_DIR = join(REPO_ROOT, "datasets/paddle-bench/runs", RUN_ID);
const SOURCE_DIR = join(REPO_ROOT, "tools/latency-bench/artifacts", RUN_ID);
const SUITE = "test/sessionEngine.test.ts";
const PKG = join(REPO_ROOT, "packages/swing-lab");
const SHIFT_MS = 1;

const artifacts = mkdtempSync(join(tmpdir(), "attack-s6-replay-"));

interface Report {
  window: { startMs: number; endMs: number; peakMotionMs: number };
  player: { targetTrackId: number; aliasTrackIds: number[]; targetCoverage: number };
  events: {
    proposals: Array<{
      eventId: string;
      startMs: number;
      endMs: number;
      peakMs: number;
      paddleConfirmed: boolean;
      paddlePeakMs: number | null;
    }>;
  };
}

interface SuiteRun {
  status: number | null;
  passed: number;
  failed: number;
  skipped: number;
  replayLines: string[];
  failureMessages: string[];
  logPath: string;
}

/** Same as sessionEngine.test.ts mirrorDominantWristSpeeds (analyzeVideo L922–957). */
function dominantWristSpeeds(
  sequence: PoseSequence,
  window: { startMs: number; endMs: number },
): SpeedSample[] {
  const travel = { left: 0, right: 0 };
  const last: Record<string, { x: number; y: number } | undefined> = {};
  const perWrist: Record<"left" | "right", SpeedSample[]> = { left: [], right: [] };
  for (const frame of toLegacyPoseFrames(sequence)) {
    for (const sideName of ["left", "right"] as const) {
      const mark = frame.landmarks.find(
        (landmark) => landmark.name === `${sideName}_wrist` && landmark.visibility >= 0.25,
      );
      if (!mark) continue;
      const prior = last[sideName];
      if (prior) {
        const series = perWrist[sideName];
        const dtSec =
          series.length > 0
            ? (frame.timestampMs - series[series.length - 1]!.timestampMs) / 1000
            : 0.04;
        const step = Math.hypot(mark.x - prior.x, mark.y - prior.y);
        if (dtSec > 0 && dtSec <= 0.15) {
          series.push({ timestampMs: frame.timestampMs, value: step / dtSec });
          if (frame.timestampMs >= window.startMs && frame.timestampMs <= window.endMs) {
            travel[sideName] += step;
          }
        }
      }
      last[sideName] = { x: mark.x, y: mark.y };
    }
  }
  return travel.right >= travel.left ? perWrist.right : perWrist.left;
}

/** Rebuild a self-consistent report.json from the Linux-bench pose artifacts
 * using exactly the suite's reconstruction path, so probe B is a fair
 * control and probe C differs from it by the 1 ms shift alone. */
function reconstructReport(): Report {
  const meta = JSON.parse(readFileSync(join(SOURCE_DIR, "extract-meta.json"), "utf8")) as {
    video: { durationMs: number };
  };
  const parsed = parsePoseSequence(readFileSync(join(SOURCE_DIR, "pose.json"), "utf8"), {
    providerId: "pose.apple-vision",
    runtime: "vision_framework",
    executionTarget: "on_device",
    artifactHash: null,
  });
  if (!parsed.ok) throw new Error(`pose.json did not parse: ${JSON.stringify(parsed)}`);
  const peopleFile = JSON.parse(
    readFileSync(join(SOURCE_DIR, "people.json"), "utf8"),
  ) as PeopleFile;
  const tracks = buildPlayerTracks(peopleFile);
  const base = [...tracks].sort((a, b) => b.frames.length - a.frames.length)[0];
  if (!base) throw new Error("people.json has no tracks");
  const early = base.frames[Math.min(3, base.frames.length - 1)]!;
  const seeded = initializeTargetFromSeed(tracks, {
    mode: "user_tapped_person",
    point: { x: early.torsoMid.x, y: early.torsoMid.y },
  });
  if (!seeded.ok) throw new Error(`seed failed: ${JSON.stringify(seeded)}`);
  const sequence = targetPoseSequence(peopleFile, seeded.value.target);
  const window = detectOfflineStrokeWindow(sequence);
  if (!window.ok) throw new Error(`window failed: ${JSON.stringify(window)}`);
  const wristSpeeds = dominantWristSpeeds(sequence, window.value);
  const batch = proposeStrokeEventsV2({
    paddleSpeeds: null,
    wristSpeeds,
    clipStartMs: 0,
    clipEndMs: meta.video.durationMs,
  });
  return {
    window: {
      startMs: window.value.startMs,
      endMs: window.value.endMs,
      peakMotionMs: window.value.peakMotionMs,
    },
    player: {
      targetTrackId: seeded.value.identity.trackId,
      aliasTrackIds: seeded.value.identity.aliasTrackIds,
      targetCoverage: seeded.value.target.coverage,
    },
    events: {
      proposals: batch.events.map((event) => ({
        eventId: event.eventId,
        startMs: event.startMs,
        endMs: event.endMs,
        peakMs: event.peakMs,
        paddleConfirmed: false,
        paddlePeakMs: null,
      })),
    },
  };
}

function runSuite(label: string): SuiteRun {
  const result = spawnSync("pnpm", ["exec", "vitest", "run", SUITE, "--reporter=verbose"], {
    cwd: PKG,
    encoding: "utf8",
    env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = `${result.stdout}\n${result.stderr}`;
  const logPath = join(artifacts, `${label}.log`);
  writeFileSync(logPath, `${text}\nexit=${String(result.status)}\n`);
  const count = (kind: string) => {
    const match = text.match(new RegExp(`Tests\\s+.*?(\\d+) ${kind}`));
    return match ? Number(match[1]) : 0;
  };
  const replayLines = text
    .split("\n")
    .filter((line) => line.includes(`session replay — ${RUN_ID}`))
    .map((line) => line.trim());
  const failureMessages = text
    .split("\n")
    .filter((line) => /AssertionError|expected .* to be/.test(line))
    .map((line) => line.trim());
  return {
    status: result.status,
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
    replayLines,
    failureMessages,
    logPath,
  };
}

function writeFixture(report: Report) {
  mkdirSync(RUN_DIR, { recursive: true });
  for (const file of ["people.json", "pose.json", "extract-meta.json"]) {
    copyFileSync(join(SOURCE_DIR, file), join(RUN_DIR, file));
  }
  writeFileSync(join(RUN_DIR, "report.json"), JSON.stringify(report, null, 2));
}

const removeFixture = () => rmSync(RUN_DIR, { recursive: true, force: true });

const ARMED = process.env["ATTACK_S6"] === "1";

describe.runIf(ARMED)("ADVERSARIAL S6: replay suite with a real fixture present", () => {
  let baseline: SuiteRun;
  let control: SuiteRun;
  let shifted: SuiteRun;
  let exact: Report;

  beforeAll(() => {
    if (existsSync(RUN_DIR)) {
      throw new Error(`${RUN_DIR} already exists — refusing to touch a real fixture`);
    }
    for (const file of ["people.json", "pose.json", "extract-meta.json"]) {
      expect(
        existsSync(join(SOURCE_DIR, file)),
        `${file} committed under tools/latency-bench`,
      ).toBe(true);
    }
    exact = reconstructReport();
    writeFileSync(join(artifacts, "report-exact.json"), JSON.stringify(exact, null, 2));
    try {
      baseline = runSuite("A-no-fixture");
      writeFixture(exact);
      control = runSuite("B-exact-fixture");
      const shiftedReport: Report = {
        ...exact,
        events: {
          proposals: exact.events.proposals.map((event) => ({
            ...event,
            startMs: event.startMs + SHIFT_MS,
            endMs: event.endMs + SHIFT_MS,
          })),
        },
      };
      writeFileSync(join(artifacts, "report-shifted.json"), JSON.stringify(shiftedReport, null, 2));
      writeFixture(shiftedReport);
      shifted = runSuite("C-shifted-1ms");
    } finally {
      removeFixture();
    }
    writeFileSync(
      join(artifacts, "summary.json"),
      JSON.stringify(
        { baseline, control, shifted, exactProposals: exact.events.proposals },
        null,
        2,
      ),
    );
  }, 300_000);

  afterAll(() => {
    removeFixture();
    expect(existsSync(RUN_DIR)).toBe(false);
  });

  it("A. baseline: without the fixture the suite is green and the replay tests are SKIPPED, not run", () => {
    expect(baseline.status, baseline.logPath).toBe(0);
    expect(baseline.skipped).toBeGreaterThanOrEqual(2);
    expect(baseline.failed).toBe(0);
    expect(
      baseline.replayLines.some((line) => /skipped|↓/.test(line)),
      baseline.replayLines.join("\n"),
    ).toBe(true);
  });

  it("B. control: with an exact reconstructed report.json the replay tests actually RUN", () => {
    expect(control.replayLines.length, control.logPath).toBeGreaterThan(0);
    expect(control.skipped).toBeLessThan(baseline.skipped);
    // Whether the Linux-bench reconstruction satisfies the Apple-recorded
    // expectations (batchCount 3, closeReasons) is data, not a pass/fail of
    // this probe — recorded for the report.
    writeFileSync(
      join(artifacts, "B-control-verdict.json"),
      JSON.stringify(
        {
          status: control.status,
          failed: control.failed,
          passed: control.passed,
          replayLines: control.replayLines,
          failureMessages: control.failureMessages,
        },
        null,
        2,
      ),
    );
  });

  it(`C. attack: shifting every proposal bound by ${SHIFT_MS} ms makes the suite FAIL — the skipIf is the only reason it is green`, () => {
    expect(shifted.status, shifted.logPath).not.toBe(0);
    expect(shifted.failed).toBeGreaterThan(0);
    expect(shifted.failed).toBeGreaterThanOrEqual(control.failed);
    // The exactness assertion (batchEvent.startMs toBe reportEvent.startMs)
    // is what trips: expected X to be X+1.
    const trip = shifted.failureMessages
      .map((line) => /expected ([\d.]+) to be ([\d.]+)/.exec(line))
      .find((match) => match !== null);
    expect(trip, shifted.failureMessages.join("\n")).toBeDefined();
    expect(Number(trip![2]) - Number(trip![1])).toBeCloseTo(SHIFT_MS, 6);
    // Cleanest delta: the batch-vs-report exactness test PASSED on the exact
    // fixture and FAILED on the shifted one — nothing but the 1 ms moved.
    const batchTest = "wrist-only batch reproduces the recorded report proposals";
    const verdict = (run: SuiteRun) =>
      run.replayLines.find((line) => line.includes(batchTest) && /^[✓×]/.test(line))?.[0];
    expect(verdict(control), control.replayLines.join("\n")).toBe("✓");
    expect(verdict(shifted), shifted.replayLines.join("\n")).toBe("×");
  });

  it("no fixture artifact is left in the committed dataset tree", () => {
    expect(existsSync(RUN_DIR)).toBe(false);
    const status = spawnSync("git", ["status", "--porcelain", "--", "datasets/paddle-bench/runs"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(status.stdout.trim()).toBe("");
  });
});
