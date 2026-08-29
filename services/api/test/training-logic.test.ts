import { describe, expect, it } from "vitest";
import {
  computePracticeStreak,
  externalEmbedUrl,
  meetsCompletionTarget,
  selectPlanPrescriptions,
  validateExternalVideoSource,
  type PrescriptionCandidate,
} from "../src/modules/training/logic.js";

describe("practice streaks", () => {
  it("deduplicates real evidence and keeps yesterday's streak current", () => {
    expect(
      computePracticeStreak(
        ["2026-08-20", "2026-08-21", "2026-08-21", "2026-08-22", "2026-08-24"],
        "2026-08-25",
      ),
    ).toEqual({
      currentDays: 1,
      longestDays: 3,
      practicedToday: false,
      lastPracticeDate: "2026-08-24",
    });
  });

  it("returns zero current days after a missed full day but retains longest", () => {
    expect(computePracticeStreak(["2026-08-20", "2026-08-21", "2026-08-22"], "2026-08-25")).toEqual(
      {
        currentDays: 0,
        longestDays: 3,
        practicedToday: false,
        lastPracticeDate: "2026-08-22",
      },
    );
  });

  it("ignores future and malformed evidence dates", () => {
    expect(computePracticeStreak(["bad", "2026-08-28", "2026-08-27"], "2026-08-27")).toEqual({
      currentDays: 1,
      longestDays: 1,
      practicedToday: true,
      lastPracticeDate: "2026-08-27",
    });
  });
});

function candidate(
  slug: string,
  planRole: "warmup" | "targeted",
  priority: number,
  faultDirections: string[] = [],
  difficultyMin: string | null = null,
  difficultyMax: string | null = null,
): PrescriptionCandidate {
  return {
    drillId: `${slug}-id`,
    slug,
    planRole,
    faultDirections,
    priority,
    difficultyMin,
    difficultyMax,
  };
}

describe("deterministic plan selection", () => {
  it("prefers direction-specific, skill-compatible prescriptions with a stable slug tie-break", () => {
    const result = selectPlanPrescriptions(
      [
        candidate("warm-generic", "warmup", 10),
        candidate("warm-late", "warmup", 2, ["late"]),
        candidate("target-z", "targeted", 8, ["late"]),
        candidate("target-a", "targeted", 8, ["late"]),
        candidate("target-high", "targeted", 10, ["high"]),
        candidate("target-too-advanced", "targeted", 20, [], "4.5", null),
      ],
      "late",
      "3.5",
    );
    expect(result?.map((item) => item.slug)).toEqual(["warm-late", "target-a", "target-z"]);
  });

  it("abstains when the reviewed catalog cannot provide the complete plan shape", () => {
    expect(
      selectPlanPrescriptions(
        [candidate("warm", "warmup", 1), candidate("one-target", "targeted", 1)],
        "late",
        "3.5",
      ),
    ).toBeNull();
  });
});

describe("completion qualification", () => {
  it("requires the full coach-authored repetition or duration target", () => {
    expect(
      meetsCompletionTarget(
        { targetSets: 3, targetRepetitionsPerSet: 10, targetDurationSeconds: null },
        30,
        null,
      ),
    ).toBe(true);
    expect(
      meetsCompletionTarget(
        { targetSets: 3, targetRepetitionsPerSet: 10, targetDurationSeconds: null },
        29,
        999,
      ),
    ).toBe(false);
    expect(
      meetsCompletionTarget(
        { targetSets: 2, targetRepetitionsPerSet: null, targetDurationSeconds: 90 },
        null,
        180,
      ),
    ).toBe(true);
  });
});

describe("reviewed external playback safety", () => {
  it("accepts only matching HTTPS provider hosts and safe embed ids", () => {
    expect(
      validateExternalVideoSource("youtube", "https://www.youtube.com/watch?v=abc123DEF"),
    ).toBe(true);
    expect(validateExternalVideoSource("youtube", "https://vimeo.com/123456")).toBe(false);
    expect(validateExternalVideoSource("vimeo", "http://vimeo.com/123456")).toBe(false);
    expect(externalEmbedUrl("youtube", "abc123_DEF")).toBe(
      "https://www.youtube-nocookie.com/embed/abc123_DEF",
    );
    expect(externalEmbedUrl("vimeo", "not-a-number")).toBeNull();
  });
});
