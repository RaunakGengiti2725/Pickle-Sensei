import { describe, expect, it } from "vitest";
import {
  resolveTechniqueIntent,
  SELECTABLE_TECHNIQUES_V1,
  SHARED_SIDE_PROFILES_V1,
  TECHNIQUE_ANALYSIS_PROFILES_V1,
} from "../src/techniqueIntent.js";

describe("resolveTechniqueIntent (deterministic, registry-terminated)", () => {
  it("resolves side + action", () => {
    const result = resolveTechniqueIntent("Analyze my forehand drive.");
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.technique.canonical).toBe("FOREHAND_DRIVE");
  });

  it("resolves spoken variants and synonyms", () => {
    for (const [text, canonical] of [
      ["i want to work on my backhand dink", "BACKHAND_DINK"],
      ["check my serve", "SERVE"],
      ["smash", "OVERHEAD"],
      ["third shot drop", "DROP"],
      ["3rd-shot drop", "DROP"],
      ["speed up", "SPEEDUP"],
      ["help with returns", "RETURN"],
    ] as const) {
      const result = resolveTechniqueIntent(text);
      expect(result.status, text).toBe("resolved");
      if (result.status === "resolved") expect(result.technique.canonical, text).toBe(canonical);
    }
  });

  it("bare side is genuinely ambiguous — narrowed options, never a silent guess", () => {
    const result = resolveTechniqueIntent("help with my forehand");
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    const options = result.options.map((option) => option.canonical);
    expect(options).toContain("FOREHAND_DRIVE");
    expect(options).toContain("FOREHAND_DINK");
    expect(options).toContain("FOREHAND_VOLLEY");
    expect(options.every((option) => option.startsWith("FOREHAND"))).toBe(true);
  });

  it("bare two-side action asks for the side", () => {
    const result = resolveTechniqueIntent("my dink");
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.options.map((option) => option.canonical).sort()).toEqual([
      "BACKHAND_DINK",
      "FOREHAND_DINK",
    ]);
  });

  it("auto-detect phrases resolve to auto", () => {
    expect(resolveTechniqueIntent("just auto detect it").status).toBe("auto");
    expect(resolveTechniqueIntent("not sure").status).toBe("auto");
  });

  it("garbage cannot invent a technique route", () => {
    expect(resolveTechniqueIntent("make me a sandwich").status).toBe("unknown");
    expect(resolveTechniqueIntent("").status).toBe("unknown");
  });

  it("every resolvable output terminates in the versioned registry", () => {
    const canonicals = new Set(SELECTABLE_TECHNIQUES_V1.map((technique) => technique.canonical));
    for (const text of [
      "forehand drive",
      "backhand volley",
      "serve",
      "overhead",
      "reset",
      "speedup",
      "return",
      "third shot drop",
    ]) {
      const result = resolveTechniqueIntent(text);
      if (result.status === "resolved")
        expect(canonicals.has(result.technique.canonical)).toBe(true);
      if (result.status === "ambiguous") {
        for (const option of result.options) expect(canonicals.has(option.canonical)).toBe(true);
      }
    }
  });
});

describe("technique analysis profiles", () => {
  it("every selectable technique has a profile and every profile is honest", () => {
    for (const technique of SELECTABLE_TECHNIQUES_V1) {
      const profile = TECHNIQUE_ANALYSIS_PROFILES_V1[technique.canonical];
      expect(profile).toBeDefined();
      expect(profile!.techniqueEvaluator).toBe("BLOCKED_ON_VALIDATION");
      expect(profile!.drillMappingVersion).toBe("none");
      expect(profile!.abstentionPolicy).toBe("abstain-over-invent");
    }
  });
});

describe("shared side profiles (AUTO depth-2 resolution registry)", () => {
  it("exists for exactly FOREHAND and BACKHAND with deterministic ids", () => {
    expect(Object.keys(SHARED_SIDE_PROFILES_V1).sort()).toEqual(["BACKHAND", "FOREHAND"]);
    expect(SHARED_SIDE_PROFILES_V1.FOREHAND.id).toBe("SHARED_FOREHAND_SWING");
    expect(SHARED_SIDE_PROFILES_V1.BACKHAND.id).toBe("SHARED_BACKHAND_SWING");
    expect(SHARED_SIDE_PROFILES_V1.FOREHAND.taxonomyDepth).toBe(2);
  });

  it("covers only registry canonicals of its own side — never a route outside the registry", () => {
    const canonicals = new Set(SELECTABLE_TECHNIQUES_V1.map((technique) => technique.canonical));
    for (const side of ["FOREHAND", "BACKHAND"] as const) {
      const profile = SHARED_SIDE_PROFILES_V1[side];
      expect(profile.covers.length).toBeGreaterThan(0);
      for (const covered of profile.covers) {
        expect(canonicals.has(covered)).toBe(true);
        expect(covered.startsWith(`${side}_`)).toBe(true);
      }
    }
  });

  it("is as honest as the leaf profiles: blocked evaluator, abstain-over-invent", () => {
    for (const profile of Object.values(SHARED_SIDE_PROFILES_V1)) {
      expect(profile.techniqueEvaluator).toBe("BLOCKED_ON_VALIDATION");
      expect(profile.drillMappingVersion).toBe("none");
      expect(profile.abstentionPolicy).toBe("abstain-over-invent");
      // A shared profile must never masquerade as a leaf technique.
      expect(TECHNIQUE_ANALYSIS_PROFILES_V1[profile.id]).toBeUndefined();
    }
  });
});
