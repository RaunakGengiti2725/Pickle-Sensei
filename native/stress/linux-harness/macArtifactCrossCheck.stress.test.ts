import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parsePoseSequence } from "@pickle/swing-domain";
import { REPO_ROOT, ResultTable } from "./support.js";

/**
 * Cross-checks a downloaded Mac workflow artifact bundle (Apple truth) with
 * the Linux canonical parser and the swing-lab output contract. Skips —
 * recorded as SKIPPED, never as a pass — when no bundle is present.
 *
 *   gh run download <run-id> -R RaunakGengiti2725/Pickle-Sensei -D artifacts/mac-run-<run-id>
 *   MAC_ARTIFACTS_DIR=artifacts/mac-run-<run-id>/mac-full-verify-<n> pnpm ... vitest run --dir native/stress/linux-harness
 */

const DEFAULT_BUNDLE = "artifacts/mac-run-33909637479/mac-full-verify-7";
const bundle = join(REPO_ROOT, process.env.MAC_ARTIFACTS_DIR ?? DEFAULT_BUNDLE);
const present = existsSync(join(bundle, "swing-lab-extract", "pose.json"));

const PRODUCER = {
  providerId: "pose.apple-vision",
  runtime: "vision_framework" as const,
  executionTarget: "on_device" as const,
  artifactHash: null,
};

const table = new ResultTable("mac-artifact-cross-check");

afterAll(() => {
  if (!present) table.record("bundle", bundle, "SKIPPED", "no Mac artifact bundle on disk");
  const path = table.flush();
  expect(table.brokenCount, `BROKEN rows in ${path}`).toBe(0);
});

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(bundle, relativePath), "utf8"));
}

interface ExtractMeta {
  framesSeen: number;
  framesWithPose: number;
  poseMisses: number;
  poseModelVersion: string;
  trajectoryCount: number;
  video: { durationMs: number; w: number; h: number; nominalFps: number };
  wallTimeMs: number;
}

describe.skipIf(!present)(`Mac artifact bundle ${DEFAULT_BUNDLE}`, () => {
  it("pose.json written by the Apple swing-lab binary parses with the canonical Linux parser", () => {
    const meta = readJson("swing-lab-extract/extract-meta.json") as ExtractMeta;
    const parsed = parsePoseSequence(
      readFileSync(join(bundle, "swing-lab-extract", "pose.json"), "utf8"),
      PRODUCER,
    );
    const detail = parsed.ok
      ? `frames=${parsed.value.frames.length} fps=${parsed.value.video.fps} model=${parsed.value.producedBy.modelVersion}`
      : `rejected=${parsed.failure.code}`;
    table.record("pose_json_parses", "apple", parsed.ok ? "HELD" : "BROKEN", detail);
    expect(parsed.ok, detail).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frames.length).toBe(meta.framesWithPose);
    expect(meta.framesWithPose + meta.poseMisses).toBe(meta.framesSeen);
    expect(parsed.value.producedBy.modelVersion).toBe(meta.poseModelVersion);
    expect(parsed.value.video.width).toBe(meta.video.w);
    expect(parsed.value.video.height).toBe(meta.video.h);
    expect(parsed.value.video.fps).toBeGreaterThan(0);
    const last = parsed.value.frames[parsed.value.frames.length - 1];
    expect(last?.timestampMs ?? 0).toBeLessThanOrEqual(meta.video.durationMs);
    for (const [index, frame] of parsed.value.frames.entries()) {
      expect(frame.frameIndex).toBe(index);
      expect(frame.landmarks.length).toBeGreaterThan(0);
    }
  });

  it("people.json (multi-person) timestamps are strictly increasing and bounded by the clip", () => {
    const meta = readJson("swing-lab-extract/extract-meta.json") as ExtractMeta;
    const people = readJson("swing-lab-extract/people.json") as {
      frames: { t: number; p: { c: number; l: unknown[] }[] }[];
    };
    let previous = -Infinity;
    let maxPeople = 0;
    let framesWithTwoOrMore = 0;
    for (const frame of people.frames) {
      expect(frame.t).toBeGreaterThan(previous);
      previous = frame.t;
      expect(frame.p.length).toBeGreaterThan(0);
      maxPeople = Math.max(maxPeople, frame.p.length);
      if (frame.p.length >= 2) framesWithTwoOrMore += 1;
      for (const person of frame.p) {
        expect(Number.isFinite(person.c)).toBe(true);
        expect(person.l.length).toBeGreaterThan(0);
      }
    }
    expect(previous).toBeLessThanOrEqual(meta.video.durationMs);
    expect(people.frames.length).toBeGreaterThanOrEqual(meta.framesWithPose);
    table.record(
      "people_json_monotonic",
      "apple",
      "HELD",
      `frames=${people.frames.length} maxPeople=${maxPeople} framesWith2+=${framesWithTwoOrMore}`,
    );
  });

  it("scenes.json segments tile the clip contiguously from 0 to durationMs", () => {
    const meta = readJson("swing-lab-extract/extract-meta.json") as ExtractMeta;
    const scenes = readJson("swing-lab-extract/scenes.json") as {
      cuts: number[];
      segments: { startMs: number; endMs: number }[];
      scores: { t: number; d: number }[];
    };
    expect(scenes.segments.length).toBe(scenes.cuts.length + 1);
    expect(scenes.segments[0]?.startMs).toBe(0);
    expect(scenes.segments[scenes.segments.length - 1]?.endMs).toBe(meta.video.durationMs);
    for (let index = 1; index < scenes.segments.length; index += 1) {
      expect(scenes.segments[index]?.startMs).toBe(scenes.segments[index - 1]?.endMs);
    }
    for (const score of scenes.scores) expect(Number.isFinite(score.d) && score.d >= 0).toBe(true);
    expect(scenes.scores.length).toBe(meta.framesSeen - 1);
    table.record(
      "scenes_json_tiling",
      "apple",
      "HELD",
      `cuts=${scenes.cuts.length} segments=${scenes.segments.length} scores=${scenes.scores.length}`,
    );
  });

  it("ball.json trajectory count matches extract-meta and every point is finite", () => {
    const meta = readJson("swing-lab-extract/extract-meta.json") as ExtractMeta;
    const ball = readJson("swing-lab-extract/ball.json") as {
      trajectories: {
        startMs?: number;
        endMs: number;
        confidence: number;
        points: { t: number; x: number; y: number }[];
      }[];
    };
    expect(ball.trajectories.length).toBe(meta.trajectoryCount);
    let points = 0;
    for (const trajectory of ball.trajectories) {
      expect(Number.isFinite(trajectory.confidence)).toBe(true);
      for (const point of trajectory.points) {
        points += 1;
        expect(
          Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.t),
        ).toBe(true);
      }
    }
    table.record(
      "ball_json_finite",
      "apple",
      "HELD",
      `trajectories=${ball.trajectories.length} points=${points}`,
    );
  });

  it("xcresult summary, launch summary and extract summary agree with the JSON artifacts", () => {
    const xcresult = readFileSync(join(bundle, "swift-native-xcresult-summary.txt"), "utf8");
    const launch = readFileSync(join(bundle, "launch", "launch-summary.txt"), "utf8");
    const extractSummary = readFileSync(join(bundle, "swing-lab-extract-summary.txt"), "utf8");
    const meta = readJson("swing-lab-extract/extract-meta.json") as ExtractMeta;
    const planes = [
      ...xcresult.matchAll(
        /`([\w-]+)\.xcresult`: \*\*(\w+)\*\* — total (\d+), passed (\d+), failed (\d+), skipped (\d+)/g,
      ),
    ];
    expect(planes.length).toBe(2);
    for (const [, name, verdict, total, passed, failed, skipped] of planes) {
      expect(verdict, name).toBe("Passed");
      expect(Number(failed), name).toBe(0);
      expect(Number(skipped), name).toBe(0);
      expect(Number(passed), name).toBe(Number(total));
      expect(Number(total), name).toBeGreaterThan(0);
    }
    expect(launch).toMatch(/^alive_after_25s=1$/m);
    expect(launch).toMatch(/^crash_reports=0$/m);
    expect(launch).toMatch(/^fatal_log_lines=0$/m);
    expect(launch).toMatch(/^bundle_id=com\.picklesensei$/m);
    expect(extractSummary).toContain(`${meta.framesWithPose}/${meta.framesSeen} frames with pose`);
    expect(extractSummary).toContain(`${meta.trajectoryCount} ball trajectories`);
    expect(extractSummary).toContain(`frames=${meta.framesWithPose}`);
    table.record(
      "summaries_consistent",
      "apple",
      "HELD",
      planes.map(([, name, , total, passed]) => `${name}=${passed}/${total}`).join(" "),
    );
  });
});
