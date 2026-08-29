import { describe, expect, it } from "vitest";
import { detectOverlap, type Fingerprint, FINGERPRINT_ALGO } from "../src/engine/fingerprint.js";
import { rightsForLicense, trainingEligible } from "../src/engine/rights.js";
import { deterministicSplit, auditSplits, type SplitsFile } from "../src/engine/splits.js";
import {
  replayAcquisition,
  resampleTo30fps,
  wristElevation,
  captureTorsoMid,
  OCCUPANCY_FRAMES_TO_LOCK,
  SHIPPED_VARIANT,
  LEGACY_VARIANT,
  type ReplayFrame,
} from "../src/engine/taReplay.js";
import { eventId, recordingIdForHash, commonsSourceId } from "../src/engine/corpus.js";

// ── rights ────────────────────────────────────────────────────────────────

describe("rightsForLicense", () => {
  it("public domain grants everything", () => {
    const rights = rightsForLicense(
      "Public domain (U.S. federal government work, PD-USGov; DVIDS)",
      "test",
    );
    expect(rights.train).toBe("yes");
    expect(rights.commercial).toBe("yes");
    expect(trainingEligible(rights)).toBe(true);
  });
  it("CC BY requires attribution but permits training and commercial use", () => {
    const rights = rightsForLicense("CC BY 3.0", "test");
    expect(rights.train).toBe("yes_with_attribution");
    expect(trainingEligible(rights)).toBe(true);
  });
  it("CC BY-SA marks derivatives sharealike", () => {
    expect(rightsForLicense("CC BY-SA 4.0", "test").redistributeDerivatives).toBe("sharealike");
  });
  it("unknown licenses quarantine every modality", () => {
    const rights = rightsForLicense("Standard YouTube License", "test");
    expect(rights.train).toBe("unclear");
    expect(trainingEligible(rights)).toBe(false);
  });
});

// ── stable ids ────────────────────────────────────────────────────────────

describe("stable ids", () => {
  it("recording id is content-derived", () => {
    expect(recordingIdForHash("abcdef0123456789".repeat(4))).toBe("rec-abcdef012345");
  });
  it("commons source id is deterministic across import and acquisition", () => {
    expect(commonsSourceId("File:Pickleball game.webm")).toBe(
      commonsSourceId("Pickleball game.webm"),
    );
  });
  it("event ids are deterministic", () => {
    expect(eventId("rec-abc", 2, 3, 1500.4)).toBe("evt-abc-s2w0-p3-1500");
    expect(eventId("rec-abc", 2, 3, 1500.4, 4)).toBe("evt-abc-s2w4-p3-1500");
  });
});

// ── fingerprint / overlap ────────────────────────────────────────────────

function print(hashes: string[]): Fingerprint {
  return { algo: FINGERPRINT_ALGO, hashes };
}

describe("detectOverlap", () => {
  const base = Array.from({ length: 60 }, (_, index) =>
    ((BigInt(index) * 0x9e3779b97f4a7c15n) % (1n << 64n)).toString(16).padStart(16, "0"),
  );
  it("finds a time-crop at the right offset", () => {
    const clip = base.slice(20, 32);
    const match = detectOverlap(print(base), print(clip));
    expect(match).not.toBeNull();
    expect(match!.offsetSec).toBe(20);
    expect(match!.meanHamming).toBe(0);
  });
  it("rejects unrelated content", () => {
    const other = Array.from({ length: 30 }, (_, index) =>
      ((BigInt(index) * 0xdeadbeefcafe1234n + 0x1234n) % (1n << 64n))
        .toString(16)
        .padStart(16, "0"),
    );
    expect(detectOverlap(print(base), print(other))).toBeNull();
  });
  it("tolerates re-encode noise (a few flipped bits per hash)", () => {
    const noisy = base
      .slice(10, 22)
      .map((hash) => (BigInt(`0x${hash}`) ^ 0b101n).toString(16).padStart(16, "0"));
    const match = detectOverlap(print(base), print(noisy));
    expect(match).not.toBeNull();
    expect(match!.offsetSec).toBe(10);
  });
});

// ── splits ───────────────────────────────────────────────────────────────

describe("splits", () => {
  it("deterministic assignment is stable", () => {
    expect(deterministicSplit("session-a")).toBe(deterministicSplit("session-a"));
  });
  it("lineage crossing sessions is flagged as leakage", () => {
    const splits: SplitsFile = {
      schemaVersion: 1,
      policyVersion: "splits-v1",
      proportions: { dev: 0.5, val: 0.2, locked_test: 0.15, shadow: 0.15 },
      pinned: {},
      assigned: {
        "sess-a": { split: "dev", method: "deterministic", assignedAtIso: "now" },
        "sess-b": { split: "shadow", method: "deterministic", assignedAtIso: "now" },
      },
    };
    const probe = {
      durationMs: 1000,
      fps: 30,
      width: 1,
      height: 1,
      videoCodec: "h264",
      container: "mp4",
      bytes: 1,
    };
    const findings = auditSplits(
      [
        {
          schemaVersion: 1,
          recordingId: "rec-a",
          sourceId: "s",
          path: "a",
          sha256: "a",
          probe,
          sessionKey: "sess-a",
          registeredAtIso: "now",
          derivedFrom: [],
        },
        {
          schemaVersion: 1,
          recordingId: "rec-b",
          sourceId: "s",
          path: "b",
          sha256: "b",
          probe,
          sessionKey: "sess-b",
          registeredAtIso: "now",
          derivedFrom: [
            { parentRecordingId: "rec-a", relation: "time_crop", detail: "", evidence: "declared" },
          ],
        },
      ],
      splits,
    );
    expect(
      findings.some(
        (finding) => finding.severity === "problem" && finding.message.includes("LEAKAGE"),
      ),
    ).toBe(true);
  });
});

// ── gameplay validity (title-card regression class) ──────────────────────

import { classifyTrackLiveness, windowValidity } from "../src/engine/gameplayValidity.js";
import type { PlayerTrack } from "../src/playerTracker.js";

function syntheticTrack(kind: "live" | "rigid_pan" | "frozen"): PlayerTrack {
  const frames = Array.from({ length: 60 }, (_, index) => {
    const t = index * 33;
    // rigid_pan: whole "person" translates (Ken Burns) — zero RELATIVE motion.
    const pan = kind === "rigid_pan" ? index * 0.003 : 0;
    const sway = kind === "live" ? Math.sin(index / 4) * 0.02 : 0;
    const torso = { x: 0.5 + pan, y: 0.5 };
    return {
      timestampMs: t,
      confidence: 0.9,
      joints: [
        { n: "left_wrist", x: torso.x - 0.08 + sway, y: torso.y + 0.1 - sway, v: 0.9 },
        { n: "right_wrist", x: torso.x + 0.08 - sway, y: torso.y + 0.1 + sway, v: 0.9 },
      ],
      torsoMid: torso,
      torsoSpan: 0.12,
    };
  });
  return {
    trackId: 1,
    frames,
    coverage: 1,
    meanTorsoSpan: 0.12,
    lossPeriods: [],
    identityContests: [],
    occlusionResumes: [],
  };
}

describe("gameplay validity (permanent title-card regression class)", () => {
  it("live humans show wrist-relative motion", () => {
    expect(classifyTrackLiveness(syntheticTrack("live"))).toBe("live");
  });
  it("Ken-Burns-panned graphic humans are static (rigid motion, zero relative)", () => {
    expect(classifyTrackLiveness(syntheticTrack("rigid_pan"))).toBe("static_or_graphic");
  });
  it("frozen-frame humans are static", () => {
    expect(classifyTrackLiveness(syntheticTrack("frozen"))).toBe("static_or_graphic");
  });
  it("a window whose only people are graphics is invalid", () => {
    const verdict = windowValidity([syntheticTrack("rigid_pan"), syntheticTrack("frozen")]);
    expect(verdict.valid).toBe(false);
  });
  it("one live human keeps the window valid", () => {
    expect(windowValidity([syntheticTrack("rigid_pan"), syntheticTrack("live")]).valid).toBe(true);
  });
});

// ── target-acquisition replay (port semantics) ───────────────────────────

function person(x: number, y: number, wristAboveShoulder = false) {
  const joints = [
    { n: "left_shoulder", x: x - 0.02, y, v: 0.9 },
    { n: "right_shoulder", x: x + 0.02, y, v: 0.9 },
    { n: "left_hip", x: x - 0.02, y: y + 0.1, v: 0.9 },
    { n: "right_hip", x: x + 0.02, y: y + 0.1, v: 0.9 },
    { n: "left_wrist", x, y: wristAboveShoulder ? y - 0.1 : y + 0.15, v: 0.9 },
    { n: "right_wrist", x: x + 0.03, y: y + 0.15, v: 0.9 },
  ];
  return { joints };
}

function frames(count: number, build: (index: number) => ReplayFrame["people"]): ReplayFrame[] {
  return Array.from({ length: count }, (_, index) => ({ t: index * 33, people: build(index) }));
}

describe("replayAcquisition (live product port)", () => {
  const region = { x: 0.5, y: 0.5 };

  it("locks after 9 consecutive single-occupant frames", () => {
    const result = replayAcquisition(
      frames(15, () => [person(0.5, 0.5)]),
      region,
    );
    expect(result.lock?.source).toBe("start_region_occupancy");
    expect(result.lock?.t).toBe((OCCUPANCY_FRAMES_TO_LOCK - 1) * 33);
  });

  it("an empty region resets the streak", () => {
    const result = replayAcquisition(
      frames(14, (index) => (index === 5 ? [] : [person(0.5, 0.5)])),
      region,
    );
    expect(result.lock).toBeNull(); // 5 + 8 consecutive < 9 after reset
  });

  it("two occupants force ambiguity; wrist raise resolves it (legacy: single frame)", () => {
    const result = replayAcquisition(
      frames(30, (index) => [person(0.46, 0.5), person(0.54, 0.5, index >= 20)]),
      region,
      LEGACY_VARIANT,
    );
    expect(result.ambiguityEntered).toBe(true);
    expect(result.lock?.source).toBe("gesture_confirmed");
    expect(result.lock!.torso.x).toBeGreaterThan(0.5); // the raiser, not the other
  });

  it("LEGACY ambiguity never falls back — the measured dead-end that D-027 fixed", () => {
    const result = replayAcquisition(
      frames(40, (index) =>
        index < 3 ? [person(0.46, 0.5), person(0.54, 0.5)] : [person(0.46, 0.5)],
      ),
      region,
      LEGACY_VARIANT,
    );
    expect(result.lock).toBeNull();
  });

  it("SHIPPED (D-027): ambiguity times out to the occupant closest to the region", () => {
    // Two occupants, nobody gestures; closest to region center is at 0.52.
    const result = replayAcquisition(
      frames(120, () => [person(0.36, 0.5), person(0.52, 0.5)]),
      region,
      SHIPPED_VARIANT,
    );
    expect(result.ambiguityEntered).toBe(true);
    expect(result.lock?.source).toBe("ambiguity_timeout");
    expect(result.lock!.t).toBeGreaterThanOrEqual(3000);
    expect(result.lock!.torso.x).toBeGreaterThan(0.45); // the 0.52 occupant
  });

  it("SHIPPED (D-027): a single-frame wrist flick does NOT lock; a sustained raise does", () => {
    const flick = replayAcquisition(
      frames(40, (index) => [person(0.46, 0.5), person(0.54, 0.5, index === 10)]),
      region,
      SHIPPED_VARIANT,
    );
    expect(flick.lock?.source ?? "none").not.toBe("gesture_confirmed");
    const sustained = replayAcquisition(
      frames(40, (index) => [person(0.46, 0.5), person(0.54, 0.5, index >= 10 && index < 20)]),
      region,
      SHIPPED_VARIANT,
    );
    expect(sustained.lock?.source).toBe("gesture_confirmed");
    expect(sustained.lock!.torso.x).toBeGreaterThan(0.5);
  });

  it("SHIPPED (D-027): hysteresis rejects a challenger legacy would take (margin contract)", () => {
    // Challenger score 0.122 vs incumbent 0.1: legacy switches (0.122 > 0.1);
    // shipped keeps the incumbent (challenger must exceed 0.1/0.7 ≈ 0.143).
    // A DECISIVELY better challenger (>1.43×) still wins — that is the
    // documented margin, not unconditional identity retention.
    const build = (index: number) => {
      const target = person(0.5, 0.5);
      if (index < 12) return [target];
      const challenger = {
        joints: [
          { n: "left_shoulder", x: 0.1, y: 0.2, v: 0.9 },
          { n: "right_shoulder", x: 0.3, y: 0.2, v: 0.9 },
          { n: "left_hip", x: 0.1, y: 0.45, v: 0.9 },
          { n: "right_hip", x: 0.3, y: 0.45, v: 0.9 },
        ],
      };
      return [target, challenger];
    };
    const shipped = replayAcquisition(frames(40, build), region, SHIPPED_VARIANT);
    expect(shipped.lock).not.toBeNull();
    const shippedPicks = shipped.follow.filter((pick) => pick.torso !== null);
    expect(shippedPicks.length).toBeGreaterThan(10);
    expect(shippedPicks.every((pick) => Math.abs(pick.torso!.x - 0.5) < 0.05)).toBe(true);
    const legacy = replayAcquisition(frames(40, build), region, LEGACY_VARIANT);
    const legacyJumps = legacy.follow.filter((pick) => pick.torso !== null && pick.torso.x < 0.35);
    expect(legacyJumps.length).toBeGreaterThan(0);
  });

  it("LEGACY follower jumps to a decisively larger newcomer — the measured risk D-027 fixed", () => {
    const result = replayAcquisition(
      frames(40, (index) => {
        const target = person(0.5, 0.5);
        if (index < 12) return [target];
        // A much larger person appears far away after lock.
        const big = {
          joints: [
            { n: "left_shoulder", x: 0.1, y: 0.2, v: 0.9 },
            { n: "right_shoulder", x: 0.3, y: 0.2, v: 0.9 },
            { n: "left_hip", x: 0.1, y: 0.6, v: 0.9 },
            { n: "right_hip", x: 0.3, y: 0.6, v: 0.9 },
          ],
        };
        return [target, big];
      }),
      region,
      LEGACY_VARIANT,
    );
    expect(result.lock).not.toBeNull();
    const picks = result.follow.filter((pick) => pick.torso !== null);
    expect(picks.length).toBeGreaterThan(10);
    // span 0.4 at distance ~0.3: score 0.4/(1+0.9)=0.21 vs target 0.1/(1+0)=0.1 →
    // the legacy heuristic DOES jump to decisively larger people.
    const jumped = picks.filter((pick) => pick.torso!.x < 0.35).length;
    expect(jumped).toBeGreaterThan(0);
  });

  it("resample keeps ≥30ms spacing", () => {
    const dense = Array.from({ length: 100 }, (_, index) => ({
      t: index * 16.6,
      people: [person(0.5, 0.5)],
    }));
    const sparse = resampleTo30fps(dense);
    for (let index = 1; index < sparse.length; index += 1) {
      expect(sparse[index]!.t - sparse[index - 1]!.t).toBeGreaterThanOrEqual(30);
    }
  });

  it("wristElevation matches the capture-side definition", () => {
    expect(wristElevation(person(0.5, 0.5, true))).toBeGreaterThan(0.03);
    expect(wristElevation(person(0.5, 0.5, false))).toBeLessThan(0);
    expect(captureTorsoMid(person(0.5, 0.5))).not.toBeNull();
  });
});
