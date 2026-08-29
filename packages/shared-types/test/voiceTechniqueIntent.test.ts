import { describe, expect, it } from "vitest";
import {
  PICKLEBALL_TECHNIQUES,
  projectVoiceResolution,
  resolveVoiceTechniqueIntent,
  SELECTABLE_TECHNIQUES_V1,
  VOICE_INTENT_VERSION,
} from "../src/index.js";

const TAXONOMY_SLUGS = new Set(PICKLEBALL_TECHNIQUES.map((technique) => technique.slug));

describe("resolveVoiceTechniqueIntent (voice-intent-v1, taxonomy-terminated)", () => {
  it("commits a taxonomy leaf only when the phrase singles one out", () => {
    for (const [transcript, slug] of [
      ["crosscourt forehand dink", "dink_crosscourt_forehand"],
      ["backhand overhead", "backhand_overhead"],
      ["forehand drive", "drive_forehand"],
      ["backhand slice return", "return_slice_backhand"],
      ["two handed backhand dink", "dink_two_hand_backhand"],
      ["forehand third shot drop", "third_shot_drop_forehand"],
      ["overhead smash", "overhead_smash"],
      ["tweener", "tweener"],
      ["backhand punch volley", "punch_volley_backhand"],
      ["speed up on my backhand", "speedup_backhand"],
    ] as const) {
      const resolution = resolveVoiceTechniqueIntent(transcript);
      expect(resolution.status, transcript).toBe("leaf");
      if (resolution.status === "leaf") expect(resolution.slug, transcript).toBe(slug);
    }
  });

  it("'forehand' is a SIDE-level intent — never an invented leaf", () => {
    const resolution = resolveVoiceTechniqueIntent("my forehand");
    expect(resolution.status).toBe("side");
    if (resolution.status !== "side") return;
    expect(resolution.side).toBe("forehand");
    expect(resolution.candidates.length).toBeGreaterThan(1);
    for (const slug of resolution.candidates) expect(TAXONOMY_SLUGS.has(slug)).toBe(true);
  });

  it("underspecified family phrases stay family-level with the honest candidate set", () => {
    const resolution = resolveVoiceTechniqueIntent("backhand dink");
    expect(resolution.status).toBe("family");
    if (resolution.status !== "family") return;
    expect(resolution.families).toEqual(["dink"]);
    expect(resolution.side).toBe("backhand");
    expect(resolution.candidates.length).toBeGreaterThan(1);
    for (const slug of resolution.candidates) {
      expect(slug.includes("backhand")).toBe(true);
      expect(TAXONOMY_SLUGS.has(slug)).toBe(true);
    }
  });

  it("auto phrases resolve to auto; unknown phrases carry re-prompt copy", () => {
    expect(resolveVoiceTechniqueIntent("just auto detect it").status).toBe("auto");
    const unknown = resolveVoiceTechniqueIntent("make me a sandwich");
    expect(unknown.status).toBe("unknown");
    if (unknown.status === "unknown") expect(unknown.rePrompt.length).toBeGreaterThan(0);
  });

  it("every candidate of every resolution terminates in the 61-technique taxonomy", () => {
    for (const transcript of [
      "dink",
      "volley",
      "serve",
      "drop",
      "backhand",
      "reset",
      "lob",
      "dink or volley maybe",
    ]) {
      const resolution = resolveVoiceTechniqueIntent(transcript);
      expect(resolution.version).toBe(VOICE_INTENT_VERSION);
      if (resolution.status === "leaf") expect(TAXONOMY_SLUGS.has(resolution.slug)).toBe(true);
      if (resolution.status === "family" || resolution.status === "side") {
        for (const slug of resolution.candidates) expect(TAXONOMY_SLUGS.has(slug)).toBe(true);
      }
    }
  });
});

describe("projectVoiceResolution (taxonomy → capture-selectable registry)", () => {
  it("projects leafs and unambiguous families into the selectable registry", () => {
    const canonicals = new Set(SELECTABLE_TECHNIQUES_V1.map((technique) => technique.canonical));
    for (const [transcript, canonical] of [
      ["forehand drive", "FOREHAND_DRIVE"],
      ["backhand dink", "BACKHAND_DINK"],
      ["serve", "SERVE"],
      ["overhead smash", "OVERHEAD"],
      ["forehand third shot drop", "DROP"],
    ] as const) {
      const projected = projectVoiceResolution(resolveVoiceTechniqueIntent(transcript));
      expect(projected.status, transcript).toBe("resolved");
      if (projected.status === "resolved") {
        expect(projected.technique.canonical, transcript).toBe(canonical);
        expect(canonicals.has(projected.technique.canonical)).toBe(true);
      }
    }
  });

  it("techniques with no selectable analog project to honest unknown — never rounded", () => {
    for (const transcript of ["tweener", "forehand erne", "defensive lob backhand"]) {
      const resolution = resolveVoiceTechniqueIntent(transcript);
      const projected = projectVoiceResolution(resolution);
      expect(projected.status, transcript).toBe("unknown");
    }
  });
});
