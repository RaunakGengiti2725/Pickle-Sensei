// Adversarial tests for W01-04 (candidate 654695aa). Every test encodes the
// SECURE expectation ("this must not consume a credit" / "this must fail
// closed"); a failing test here is a confirmed break of the candidate, not a
// test to be adjusted.
//   pnpm --filter @pickle/shared-types exec vitest run src/__tests__/attack
import { describe, expect, it } from "vitest";
import fixtureTable from "../../../fixtures/chargeability/joint-chargeability-v1.json" with { type: "json" };
import {
  CHARGEABLE_REASON_CODE,
  JOINT_CHARGEABILITY_CONTRACT_VERSION,
  NON_CHARGEABLE_REASON_CODES,
  decideChargeability,
  isChargeableAnalysis,
  parseChargeabilityFixtureTable,
  type ChargeabilityDecision,
} from "../../chargeability.js";
import { validateAnalysisOutcome } from "../../analysisOutcome.js";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Pair = { outcome: JsonObject; eligibility: JsonObject };

function chargeablePair(): Pair {
  const parsed = parseChargeabilityFixtureTable(fixtureTable);
  if (!parsed.ok) throw new Error(parsed.failure.code);
  const entry = parsed.value.cases.find((c) => c.category === "chargeable");
  if (!entry) throw new Error("fixture table has no chargeable case");
  return JSON.parse(JSON.stringify({ outcome: entry.outcome, eligibility: entry.eligibility }));
}

function rawTable(): JsonObject {
  return JSON.parse(JSON.stringify(fixtureTable));
}

function isObject(value: Json): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPath(root: Json, path: readonly string[]): Json {
  let cursor: Json = root;
  for (const key of path) {
    if (Array.isArray(cursor)) {
      const next = cursor[Number(key)];
      if (next === undefined) throw new Error(`missing index ${key}`);
      cursor = next;
    } else if (isObject(cursor)) {
      const next = cursor[key];
      if (next === undefined) throw new Error(`missing key ${key}`);
      cursor = next;
    } else {
      throw new Error(`cannot descend into ${path.join(".")}`);
    }
  }
  return cursor;
}

function setPath(root: Json, path: readonly string[], value: Json): void {
  const parent = getPath(root, path.slice(0, -1));
  const last = path[path.length - 1];
  if (last === undefined) throw new Error("empty path");
  if (Array.isArray(parent)) parent[Number(last)] = value;
  else if (isObject(parent)) parent[last] = value;
  else throw new Error("parent is not a container");
}

function deletePath(root: Json, path: readonly string[]): void {
  const parent = getPath(root, path.slice(0, -1));
  const last = path[path.length - 1];
  if (last === undefined || !isObject(parent)) throw new Error("bad delete path");
  delete parent[last];
}

function leafPaths(value: Json, prefix: string[] = []): string[][] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => leafPaths(entry, [...prefix, String(index)]));
  }
  if (isObject(value)) {
    return Object.entries(value).flatMap(([key, entry]) => leafPaths(entry, [...prefix, key]));
  }
  return [prefix];
}

const CHARGE: ChargeabilityDecision = {
  contractVersion: JOINT_CHARGEABILITY_CONTRACT_VERSION,
  chargeable: true,
  reasonCode: CHARGEABLE_REASON_CODE,
  creditsConsumed: 1,
};

function expectDenied(decision: ChargeabilityDecision, label: string): void {
  expect(decision.chargeable, label).toBe(false);
  expect(decision.creditsConsumed, label).toBe(0);
  expect(decision.contractVersion, label).toBe(JOINT_CHARGEABILITY_CONTRACT_VERSION);
  expect(NON_CHARGEABLE_REASON_CODES as readonly string[], label).toContain(decision.reasonCode);
}

describe("W01-04 attack: control case", () => {
  it("the fixture's chargeable case charges exactly one credit (precondition for every attack)", () => {
    const { outcome, eligibility } = chargeablePair();
    expect(decideChargeability(outcome, eligibility)).toEqual(CHARGE);
    expect(isChargeableAnalysis(outcome, eligibility)).toBe(true);
  });
});

describe("W01-04 attack A1: replay and duplicate identity", () => {
  it("a replayed decision on an already-consumed credit never charges again", () => {
    const { outcome, eligibility } = chargeablePair();
    expect(decideChargeability(outcome, eligibility)).toEqual(CHARGE);
    setPath(eligibility, ["creditState"], "already_consumed");
    const replay = decideChargeability(outcome, eligibility);
    expectDenied(replay, "consumed replay");
    expect(replay.reasonCode).toBe("credit_already_consumed");
    for (const state of ["consumed", "reserved", "unconsumed ", "UNCONSUMED", "", "none"]) {
      const cloned = JSON.parse(JSON.stringify(eligibility)) as JsonObject;
      setPath(cloned, ["creditState"], state);
      const decision = decideChargeability(outcome, cloned);
      expectDenied(decision, `creditState=${state}`);
      expect(decision.reasonCode).toBe("eligibility_unverified");
    }
  });

  it("a second durable publication of the same outputs (not verified once) never charges", () => {
    const { outcome, eligibility } = chargeablePair();
    for (const state of [
      "both_outputs_durably_published_twice",
      "both_outputs_published",
      "once",
      "",
      "BOTH_OUTPUTS_DURABLY_PUBLISHED_ONCE",
      " both_outputs_durably_published_once",
    ]) {
      const cloned = JSON.parse(JSON.stringify(eligibility)) as JsonObject;
      setPath(cloned, ["publicationState"], state);
      expectDenied(decideChargeability(outcome, cloned), `publicationState=${state}`);
    }
  });

  it("an eligibility record bound to a different identity never charges (every binding field)", () => {
    const base = chargeablePair();
    const bindingKeys = Object.keys(getPath(base.eligibility, ["binding"]) as JsonObject);
    expect(bindingKeys.sort()).toEqual(
      ["analysisId", "captureId", "inputSha256", "operationId", "ownerId", "publicationId"].sort(),
    );
    for (const key of bindingKeys) {
      const { outcome, eligibility } = chargeablePair();
      const original = getPath(eligibility, ["binding", key]);
      if (typeof original !== "string") throw new Error(`binding.${key} is not a string`);
      const mutations = [
        `${original}x`,
        original.slice(0, -1),
        `${original} `,
        original.replace(/1/g, "2").replace(/4/g, "5"),
      ];
      for (const mutated of mutations) {
        expect(mutated).not.toBe(original);
        const cloned = JSON.parse(JSON.stringify(eligibility)) as JsonObject;
        setPath(cloned, ["binding", key], mutated);
        const decision = decideChargeability(outcome, cloned);
        expectDenied(decision, `binding.${key}=${JSON.stringify(mutated)}`);
        expect(["binding_mismatch", "eligibility_unverified"]).toContain(decision.reasonCode);
      }
    }
  });

  it("a mixed-case digest never binds to a lowercase digest (no case-folding replay)", () => {
    const { outcome, eligibility } = chargeablePair();
    const digest = "0123456789abcdef".repeat(4);
    setPath(outcome, ["inputSha256"], digest);
    setPath(eligibility, ["binding", "inputSha256"], digest);
    expect(decideChargeability(outcome, eligibility)).toEqual(CHARGE);
    setPath(eligibility, ["binding", "inputSha256"], digest.toUpperCase());
    expectDenied(decideChargeability(outcome, eligibility), "uppercase digest in binding");
    setPath(eligibility, ["binding", "inputSha256"], digest);
    setPath(outcome, ["inputSha256"], digest.toUpperCase());
    expectDenied(decideChargeability(outcome, eligibility), "uppercase digest in outcome");
  });

  it("the predicate is stateless: the same durable inputs decide identically on restart", () => {
    const first = chargeablePair();
    const rehydrated = JSON.parse(JSON.stringify(first)) as Pair;
    expect(decideChargeability(first.outcome, first.eligibility)).toEqual(
      decideChargeability(rehydrated.outcome, rehydrated.eligibility),
    );
    // Consumption must therefore be recorded by the caller's ledger, never inferred
    // from the predicate having said "yes" before.
    setPath(rehydrated.eligibility, ["creditState"], "already_consumed");
    expect(decideChargeability(rehydrated.outcome, rehydrated.eligibility).chargeable).toBe(false);
  });
});

describe("W01-04 attack A2: free-rating conservation (partial / failed / withheld)", () => {
  it("mechanics-only and benchmark-only outcomes never charge, whatever the eligibility says", () => {
    const { outcome, eligibility } = chargeablePair();
    const mechanicsOnly = JSON.parse(JSON.stringify(outcome)) as JsonObject;
    setPath(mechanicsOnly, ["benchmark"], {
      schemaVersion: "technique-benchmark-v1",
      interpretation: "unofficial_single_swing_form_only",
      scale: "dupr_2_8",
      status: "abstained",
      reasonCode: "insufficient_confidence",
    });
    // Honest partial: status/billing follow the single validated output.
    setPath(mechanicsOnly, ["status"], "partial");
    setPath(mechanicsOnly, ["billingDisposition"], "not_chargeable");
    const parsedPartial = validateAnalysisOutcome(mechanicsOnly);
    if (parsedPartial.ok) {
      const honest = decideChargeability(mechanicsOnly, eligibility);
      expectDenied(honest, "honest mechanics-only partial");
      expect(honest.reasonCode).toBe("outcome_partial");
    } else {
      // A differently shaped abstention still may not charge.
      expectDenied(decideChargeability(mechanicsOnly, eligibility), "mechanics-only (shape)");
    }
    // Dishonest partial: single validated output but claims complete/joint.
    setPath(mechanicsOnly, ["status"], "complete");
    setPath(mechanicsOnly, ["billingDisposition"], "joint_verification_required");
    const dishonest = decideChargeability(mechanicsOnly, eligibility);
    expectDenied(dishonest, "mechanics-only claiming complete");
    expect(dishonest.reasonCode).toBe("outcome_invalid");
  });

  it("a complete outcome whose disposition or status is forged never charges", () => {
    for (const [status, billing] of [
      ["complete", "not_chargeable"],
      ["partial", "joint_verification_required"],
      ["abstained", "joint_verification_required"],
      ["partial", "not_chargeable"],
      ["abstained", "not_chargeable"],
      ["COMPLETE", "joint_verification_required"],
      ["complete", "chargeable"],
    ] as const) {
      const { outcome, eligibility } = chargeablePair();
      setPath(outcome, ["status"], status);
      setPath(outcome, ["billingDisposition"], billing);
      expectDenied(decideChargeability(outcome, eligibility), `${status}/${billing}`);
    }
  });

  it("withheld (not durably published) outputs never charge even with a perfect eligibility", () => {
    const { outcome, eligibility } = chargeablePair();
    setPath(outcome, ["publication"], { status: "not_published" });
    const withheld = decideChargeability(outcome, eligibility);
    expectDenied(withheld, "not_published");
    expect(withheld.reasonCode).toBe("outcome_not_durably_published");
    for (const status of ["published", "durably_published ", "Durably_Published", "pending", ""]) {
      const cloned = chargeablePair();
      setPath(cloned.outcome, ["publication", "status"], status);
      expectDenied(
        decideChargeability(cloned.outcome, cloned.eligibility),
        `publication=${status}`,
      );
    }
  });

  it("fixture-sourced or foreign-sourced outcomes never charge", () => {
    for (const source of ["fixture", "replay", "synthetic", "real ", "REAL", "", "true"]) {
      const { outcome, eligibility } = chargeablePair();
      setPath(outcome, ["source"], source);
      expectDenied(decideChargeability(outcome, eligibility), `source=${source}`);
    }
  });

  it("an ineligible or unverified release never charges", () => {
    for (const release of [
      { status: "ineligible", reasonCode: "withdrawn" },
      { status: "ineligible", reasonCode: "expired" },
      { status: "ineligible", reasonCode: "unreleased" },
      { status: "ineligible", reasonCode: "unsupported" },
      { status: "ineligible", reasonCode: "lineage_mismatch" },
      { status: "ineligible", reasonCode: "unverified" },
      { status: "pending" },
      { status: "eligible" },
      null,
      "eligible",
      true,
    ] as const satisfies readonly Json[]) {
      const { outcome, eligibility } = chargeablePair();
      setPath(eligibility, ["releaseEligibility"], release);
      expectDenied(decideChargeability(outcome, eligibility), JSON.stringify(release));
    }
  });
});

describe("W01-04 attack A3: boundary values on benchmark interval and release parameters", () => {
  function withInterval(lower: number, upper: number): Pair {
    const pair = chargeablePair();
    setPath(pair.outcome, ["benchmark", "interval"], { lower, upper });
    return pair;
  }

  it("non-finite, negative, inverted and out-of-scale intervals never charge", () => {
    const cases: Array<[number, number]> = [
      [Number.NaN, 4],
      [3.5, Number.NaN],
      [Number.NEGATIVE_INFINITY, 4],
      [3.5, Number.POSITIVE_INFINITY],
      [-3.5, 4],
      [4, 3.5],
      [3.5, 3.5],
      [0, 0.5],
      [7.5, 8.5],
      [1.5, 2],
      [3.5, 4.5000001],
      [3.4999999, 4],
      [3.75, 4.25],
      [3.5, 4.000001],
    ];
    for (const [lower, upper] of cases) {
      const { outcome, eligibility } = withInterval(lower, upper);
      expectDenied(decideChargeability(outcome, eligibility), `[${lower}, ${upper}]`);
    }
  });

  it("an interval wider than the released maximum never charges (exact and epsilon edges)", () => {
    const exact = withInterval(3.5, 4.5);
    expect(decideChargeability(exact.outcome, exact.eligibility)).toEqual(CHARGE);
    const over = withInterval(3, 4.5);
    expectDenied(decideChargeability(over.outcome, over.eligibility), "width 1.5 > max 1");
    const tiny = withInterval(3.5, 4.5 + 1e-9);
    expectDenied(decideChargeability(tiny.outcome, tiny.eligibility), "width 1 + 1e-9");
  });

  it("an interval outside every supported interval never charges", () => {
    const { outcome, eligibility } = chargeablePair();
    setPath(
      eligibility,
      ["releaseEligibility", "benchmark", "supportedIntervals"],
      [{ lower: 5, upper: 6 }],
    );
    expectDenied(decideChargeability(outcome, eligibility), "outside supported [5,6]");
    setPath(eligibility, ["releaseEligibility", "benchmark", "supportedIntervals"], []);
    expectDenied(decideChargeability(outcome, eligibility), "no supported intervals");
  });

  it("degenerate release parameters (zero / negative / NaN step or width) never charge", () => {
    for (const [field, value] of [
      ["boundaryStep", 0],
      ["boundaryStep", -0.5],
      ["boundaryStep", Number.NaN],
      ["boundaryStep", Number.POSITIVE_INFINITY],
      ["boundaryStep", 5e-324],
      ["maximumIntervalWidth", 0],
      ["maximumIntervalWidth", -1],
      ["maximumIntervalWidth", Number.NaN],
      ["maximumIntervalWidth", Number.POSITIVE_INFINITY],
    ] as const) {
      const { outcome, eligibility } = chargeablePair();
      setPath(eligibility, ["releaseEligibility", "benchmark", field], value);
      expectDenied(decideChargeability(outcome, eligibility), `${field}=${value}`);
    }
  });

  it("uncertainty declared by the outcome must equal the released uncertainty", () => {
    for (const [field, value] of [
      ["nominalCoverage", 0.9000000000000001],
      ["nominalCoverage", 0.95],
      ["nominalCoverage", 0],
      ["nominalCoverage", 1],
      ["nominalCoverage", Number.NaN],
      ["coverageScope", "conditional"],
      ["coverageScope", "Marginal"],
      ["kind", "heuristic"],
      ["calibrationUnit", "swing"],
    ] as const) {
      const { outcome, eligibility } = chargeablePair();
      setPath(outcome, ["benchmark", "uncertainty", field], value);
      expectDenied(decideChargeability(outcome, eligibility), `uncertainty.${field}=${value}`);
    }
  });

  it("mechanics score outside the 0-10 scale or non-finite never charges", () => {
    for (const score of [-1, 10.5, 11, Number.NaN, Number.POSITIVE_INFINITY, -0.0001]) {
      const { outcome, eligibility } = chargeablePair();
      setPath(outcome, ["mechanics", "score"], score);
      expectDenied(decideChargeability(outcome, eligibility), `score=${score}`);
    }
  });

  it("identifier length boundary: 128 accepted, 129 and empty rejected", () => {
    const at128 = chargeablePair();
    setPath(at128.outcome, ["analysisId"], "a".repeat(128));
    setPath(at128.eligibility, ["binding", "analysisId"], "a".repeat(128));
    expect(decideChargeability(at128.outcome, at128.eligibility)).toEqual(CHARGE);
    for (const id of ["a".repeat(129), "", " ", " a", "a "]) {
      const { outcome, eligibility } = chargeablePair();
      setPath(outcome, ["analysisId"], id);
      setPath(eligibility, ["binding", "analysisId"], id);
      expectDenied(decideChargeability(outcome, eligibility), `analysisId=${JSON.stringify(id)}`);
    }
  });

  it("identifiers containing control characters are not valid durable identities", () => {
    for (const id of ["a\u0000b", "a\nb", "a\tb", "a\u200bb", "a\u2028b"]) {
      const { outcome, eligibility } = chargeablePair();
      for (const key of ["analysisId", "operationId", "ownerId", "captureId"]) {
        setPath(outcome, [key], id);
        setPath(eligibility, ["binding", key], id);
      }
      setPath(outcome, ["publication", "publicationId"], id);
      setPath(eligibility, ["binding", "publicationId"], id);
      expectDenied(decideChargeability(outcome, eligibility), `id=${JSON.stringify(id)}`);
    }
  });
});

describe("W01-04 attack A4: clocks on the durable publication instant", () => {
  it("malformed or non-instant publication timestamps never charge", () => {
    for (const iso of [
      "2026-02-30T00:00:00.000Z",
      "2026-09-08T24:00:00.000Z",
      "2026-09-08T12:00:60.000Z",
      "2026-09-08T12:00:00.000+00:00",
      "2026-09-08T12:00:00.000z",
      "2026-09-08T12:00:00.0000Z",
      "2026-09-08T12:00:00",
      "2026-09-08",
      "1757332800",
      "",
      "now",
      "+275760-09-13T00:00:00.000Z",
    ]) {
      const { outcome, eligibility } = chargeablePair();
      setPath(outcome, ["publication", "publishedAtIso"], iso);
      expectDenied(decideChargeability(outcome, eligibility), `publishedAtIso=${iso}`);
    }
  });

  it("numeric, null and boolean timestamps never charge", () => {
    for (const value of [0, 1757332800000, -1, Number.NaN, null, true] as const) {
      const { outcome, eligibility } = chargeablePair();
      setPath(outcome, ["publication", "publishedAtIso"], value);
      expectDenied(decideChargeability(outcome, eligibility), `publishedAtIso=${String(value)}`);
    }
  });

  it("documents that the contract itself is clock-free: far-future/past instants are the caller's duty", () => {
    // Not a break of the predicate (it has no `now`), pinned so a later change
    // that starts trusting publishedAtIso is visible.
    for (const iso of ["9999-12-31T23:59:59.999Z", "0001-01-01T00:00:00.000Z"]) {
      const { outcome, eligibility } = chargeablePair();
      setPath(outcome, ["publication", "publishedAtIso"], iso);
      const decision = decideChargeability(outcome, eligibility);
      expect(decision.creditsConsumed).toBeLessThanOrEqual(1);
      expect(decision.contractVersion).toBe(JOINT_CHARGEABILITY_CONTRACT_VERSION);
    }
  });
});

describe("W01-04 attack A5: corrupt and partial persisted state", () => {
  it("removing any single field from the outcome or eligibility fails closed", () => {
    const base = chargeablePair();
    for (const root of ["outcome", "eligibility"] as const) {
      const allPaths = leafPaths(base[root]);
      const containerPaths = new Set<string>();
      for (const path of allPaths) {
        for (let depth = 1; depth <= path.length; depth += 1) {
          containerPaths.add(JSON.stringify(path.slice(0, depth)));
        }
      }
      for (const serialized of containerPaths) {
        const path = JSON.parse(serialized) as string[];
        const parent = getPath(base[root], path.slice(0, -1));
        if (Array.isArray(parent)) continue;
        const pair = chargeablePair();
        deletePath(pair[root], path);
        expectDenied(
          decideChargeability(pair.outcome, pair.eligibility),
          `${root} without ${path.join(".")}`,
        );
      }
    }
  });

  it("replacing any single field with null, an array, an object or a wrong primitive fails closed", () => {
    const base = chargeablePair();
    for (const root of ["outcome", "eligibility"] as const) {
      for (const path of leafPaths(base[root])) {
        const original = getPath(base[root], path);
        const replacements: Json[] = [null, [], {}, [original]];
        if (typeof original === "string") replacements.push(1, true, { value: original });
        if (typeof original === "number") replacements.push(String(original), true);
        if (typeof original === "boolean") replacements.push("true", 1);
        for (const replacement of replacements) {
          const pair = chargeablePair();
          setPath(pair[root], path, replacement);
          expectDenied(
            decideChargeability(pair.outcome, pair.eligibility),
            `${root}.${path.join(".")} := ${JSON.stringify(replacement)}`,
          );
        }
      }
    }
  });

  it("every single-leaf mutation either keeps a still-consistent chargeable record or is denied", () => {
    // Fields whose value may legitimately differ while the record stays chargeable:
    // the validated score itself, epsilon-tolerant interval endpoints, and release
    // parameters that only widen what the authority allows.
    const tolerated = new Set([
      "outcome.mechanics.score",
      "outcome.benchmark.interval.lower",
      "outcome.benchmark.interval.upper",
      "eligibility.releaseEligibility.benchmark.maximumIntervalWidth",
      "eligibility.releaseEligibility.benchmark.boundaryStep",
      "eligibility.releaseEligibility.benchmark.supportedIntervals.0.lower",
      "eligibility.releaseEligibility.benchmark.supportedIntervals.0.upper",
    ]);
    const base = chargeablePair();
    for (const root of ["outcome", "eligibility"] as const) {
      for (const path of leafPaths(base[root])) {
        const label = `${root}.${path.join(".")}`;
        const original = getPath(base[root], path);
        const mutations: Json[] = [];
        if (typeof original === "string") mutations.push(`${original}x`, original.slice(0, -1));
        if (typeof original === "number") {
          mutations.push(original + 1, -original - 1, original * (1 + Number.EPSILON));
        }
        if (typeof original === "boolean") mutations.push(!original);
        for (const mutated of mutations) {
          const pair = chargeablePair();
          setPath(pair[root], path, mutated);
          const decision = decideChargeability(pair.outcome, pair.eligibility);
          if (tolerated.has(label)) continue;
          expectDenied(decision, `${label} := ${JSON.stringify(mutated)}`);
        }
      }
    }
  });

  it("truncated / doubled / re-nested persisted payloads fail closed without throwing", () => {
    const { outcome, eligibility } = chargeablePair();
    const text = JSON.stringify(outcome);
    const truncated = text.slice(0, Math.floor(text.length / 2));
    expect(() => JSON.parse(truncated)).toThrow();
    const hostile: unknown[] = [
      undefined,
      null,
      0,
      1,
      "",
      "{}",
      text,
      true,
      [],
      [outcome],
      { outcome },
      { ...outcome, outcome },
      new Map(),
      new Date(0),
      Symbol("outcome"),
      () => outcome,
      10n,
      Object.create(null),
    ];
    for (const raw of hostile) {
      expect(() => decideChargeability(raw, eligibility)).not.toThrow();
      expectDenied(decideChargeability(raw, eligibility), `outcome=${String(typeof raw)}`);
      expect(() => decideChargeability(outcome, raw)).not.toThrow();
      expectDenied(decideChargeability(outcome, raw), `eligibility=${String(typeof raw)}`);
      expect(isChargeableAnalysis(raw, raw)).toBe(false);
    }
  });

  it("prototype-inherited fields never satisfy an own-field contract", () => {
    const { outcome, eligibility } = chargeablePair();
    const inheritedOutcome = Object.create(outcome) as object;
    expectDenied(decideChargeability(inheritedOutcome, eligibility), "outcome via prototype");
    const inheritedEligibility = Object.create(eligibility) as object;
    expectDenied(decideChargeability(outcome, inheritedEligibility), "eligibility via prototype");

    const shadowed = Object.create(outcome) as Record<string, unknown>;
    shadowed.status = "complete";
    expectDenied(decideChargeability(shadowed, eligibility), "own status over inherited body");
  });

  it("__proto__ keys smuggled through JSON.parse never charge", () => {
    const { outcome, eligibility } = chargeablePair();
    const withProto = JSON.parse(
      `${JSON.stringify(outcome).slice(0, -1)},"__proto__":{"status":"partial"}}`,
    ) as object;
    expectDenied(decideChargeability(withProto, eligibility), "__proto__ own key in outcome");
    const eligibilityWithProto = JSON.parse(
      `${JSON.stringify(eligibility).slice(0, -1)},"__proto__":{}}`,
    ) as object;
    expectDenied(
      decideChargeability(outcome, eligibilityWithProto),
      "__proto__ own key in eligibility",
    );
  });

  it("extra keys anywhere (including empty-string and 'constructor') never charge", () => {
    const base = chargeablePair();
    for (const root of ["outcome", "eligibility"] as const) {
      const containers = new Set<string>([JSON.stringify([])]);
      for (const path of leafPaths(base[root])) {
        for (let depth = 1; depth < path.length; depth += 1) {
          containers.add(JSON.stringify(path.slice(0, depth)));
        }
      }
      for (const serialized of containers) {
        const path = JSON.parse(serialized) as string[];
        if (!isObject(getPath(base[root], path))) continue;
        for (const key of ["extra", "", "constructor", "toString"]) {
          const pair = chargeablePair();
          setPath(pair[root], [...path, key], "x");
          expectDenied(
            decideChargeability(pair.outcome, pair.eligibility),
            `${root}.${[...path, key].join(".")} added`,
          );
        }
      }
    }
  });

  it("a live object whose status flips between validation and decision never charges", () => {
    // The validator returns the raw reference; the decision then re-reads it.
    const { outcome, eligibility } = chargeablePair();
    let reads = 0;
    const honest = outcome.status;
    Object.defineProperty(outcome, "status", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return reads <= 2 ? honest : "partial";
      },
    });
    const decision = decideChargeability(outcome, eligibility);
    expect(reads).toBeGreaterThan(2);
    expectDenied(decision, "status getter flips to partial after validation");
  });

  it("a Proxy that lies about own keys never charges", () => {
    const { outcome, eligibility } = chargeablePair();
    const partialTarget = { ...outcome, status: "partial", billingDisposition: "not_chargeable" };
    let getCount = 0;
    const liar = new Proxy(partialTarget, {
      get(target, property, receiver) {
        getCount += 1;
        if (property === "status") return getCount < 6 ? "complete" : "partial";
        if (property === "billingDisposition") {
          return getCount < 6 ? "joint_verification_required" : "not_chargeable";
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expectDenied(decideChargeability(liar, eligibility), "proxy flipping status");
  });
});

describe("W01-04 attack A6: lineage and release drift", () => {
  const lineageKeys = [
    "pipeline",
    "definition",
    "model",
    "preprocessing",
    "calibration",
    "policy",
    "dataset",
    "validationReport",
    "supportedDomain",
  ] as const;

  it("any single artefact drifting between outcome and release never charges", () => {
    for (const plane of ["mechanics", "benchmark"] as const) {
      for (const key of lineageKeys) {
        for (const field of ["version", "sha256"] as const) {
          const { outcome, eligibility } = chargeablePair();
          const path = [plane, "lineage", key, field];
          const original = getPath(outcome, path);
          if (typeof original !== "string") throw new Error(`${path.join(".")} not string`);
          setPath(outcome, path, field === "sha256" ? "9".repeat(64) : `${original}-drift`);
          expectDenied(decideChargeability(outcome, eligibility), `${path.join(".")} drifted`);
        }
      }
    }
  });

  it("mechanics and benchmark lineages that disagree on pipeline or policy never charge", () => {
    for (const key of ["pipeline", "policy"] as const) {
      for (const field of ["version", "sha256"] as const) {
        const { outcome, eligibility } = chargeablePair();
        const value = field === "sha256" ? "8".repeat(64) : "other";
        setPath(outcome, ["benchmark", "lineage", key, field], value);
        setPath(eligibility, ["releaseEligibility", "benchmark", "lineage", key, field], value);
        const decision = decideChargeability(outcome, eligibility);
        expectDenied(decision, `benchmark ${key}.${field} diverges from mechanics`);
        expect(decision.reasonCode).toBe("lineage_mismatch");
      }
    }
  });

  it("release lineage drifting from the outcome (authority side) never charges", () => {
    for (const plane of ["mechanics", "benchmark"] as const) {
      for (const key of lineageKeys) {
        const { outcome, eligibility } = chargeablePair();
        setPath(
          eligibility,
          ["releaseEligibility", plane, "lineage", key, "sha256"],
          "7".repeat(64),
        );
        expectDenied(decideChargeability(outcome, eligibility), `release.${plane}.${key} drifted`);
      }
    }
  });

  it("swapping mechanics and benchmark lineage blocks never charges", () => {
    const { outcome, eligibility } = chargeablePair();
    const mechanics = getPath(outcome, ["mechanics", "lineage"]);
    const benchmark = getPath(outcome, ["benchmark", "lineage"]);
    setPath(outcome, ["mechanics", "lineage"], benchmark);
    setPath(outcome, ["benchmark", "lineage"], mechanics);
    expectDenied(decideChargeability(outcome, eligibility), "lineages swapped");
  });

  it("eligibility envelope drift (schema / verification source) never charges", () => {
    for (const [field, value] of [
      ["schemaVersion", "analysis-eligibility-input-v2"],
      ["schemaVersion", "analysis-eligibility-input-v0"],
      ["verificationSource", "client"],
      ["verificationSource", "independent_release_authority"],
      ["verificationSource", ""],
    ] as const) {
      const { outcome, eligibility } = chargeablePair();
      setPath(eligibility, [field], value);
      const decision = decideChargeability(outcome, eligibility);
      expectDenied(decision, `eligibility.${field}=${value}`);
      expect(decision.reasonCode).toBe("eligibility_unverified");
    }
    const { outcome, eligibility } = chargeablePair();
    setPath(outcome, ["schemaVersion"], "analysis-outcome-v2");
    expect(decideChargeability(outcome, eligibility).reasonCode).toBe("outcome_invalid");
  });
});

describe("W01-04 attack A7: fixture table drift", () => {
  function casesOf(table: JsonObject): JsonObject[] {
    const cases = table.cases;
    if (!Array.isArray(cases)) throw new Error("cases missing");
    return cases.filter(isObject);
  }

  it("flipping any non-chargeable case to chargeable is rejected", () => {
    const table = rawTable();
    const list = casesOf(table);
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index];
      if (!entry || entry.category === "chargeable") continue;
      const tampered = rawTable();
      const target = casesOf(tampered)[index];
      if (!target) throw new Error("index drift");
      target.expected = {
        chargeable: true,
        reasonCode: CHARGEABLE_REASON_CODE,
        creditsConsumed: 1,
      };
      expect(parseChargeabilityFixtureTable(tampered).ok, String(entry.id)).toBe(false);
    }
  });

  it("a chargeable verdict with 0 or 2 credits, or a denial with 1 credit, is rejected", () => {
    for (const expected of [
      { chargeable: true, reasonCode: CHARGEABLE_REASON_CODE, creditsConsumed: 0 },
      { chargeable: true, reasonCode: CHARGEABLE_REASON_CODE, creditsConsumed: 2 },
      { chargeable: true, reasonCode: CHARGEABLE_REASON_CODE, creditsConsumed: -1 },
      { chargeable: true, reasonCode: CHARGEABLE_REASON_CODE, creditsConsumed: Number.NaN },
      { chargeable: true, reasonCode: "outcome_partial", creditsConsumed: 1 },
      { chargeable: false, reasonCode: "outcome_partial", creditsConsumed: 1 },
      { chargeable: false, reasonCode: CHARGEABLE_REASON_CODE, creditsConsumed: 0 },
      { chargeable: false, reasonCode: "unknown_reason", creditsConsumed: 0 },
      { chargeable: "false", reasonCode: "outcome_partial", creditsConsumed: 0 },
    ] as const satisfies readonly Json[]) {
      const tampered = rawTable();
      const list = casesOf(tampered);
      const partial = list.find((entry) => entry.category === "partial");
      const chargeable = list.find((entry) => entry.category === "chargeable");
      if (!partial || !chargeable) throw new Error("fixture categories missing");
      const target = expected.chargeable === true ? chargeable : partial;
      target.expected = expected;
      expect(parseChargeabilityFixtureTable(tampered).ok, JSON.stringify(expected)).toBe(false);
    }
  });

  it("recategorising the chargeable case as replayed (or a replayed case as chargeable) is rejected", () => {
    const asReplayed = rawTable();
    const chargeable = casesOf(asReplayed).find((entry) => entry.category === "chargeable");
    if (!chargeable) throw new Error("no chargeable case");
    chargeable.category = "replayed";
    expect(parseChargeabilityFixtureTable(asReplayed).ok).toBe(false);

    const asChargeable = rawTable();
    const replayed = casesOf(asChargeable).find((entry) => entry.category === "replayed");
    if (!replayed) throw new Error("no replayed case");
    replayed.category = "chargeable";
    expect(parseChargeabilityFixtureTable(asChargeable).ok).toBe(false);
  });

  it("duplicate ids, unknown categories, version drift and extra table keys are rejected", () => {
    const duplicate = rawTable();
    const dupList = casesOf(duplicate);
    const first = dupList[0];
    if (!first) throw new Error("empty table");
    (duplicate.cases as Json[]).push(JSON.parse(JSON.stringify(first)));
    expect(parseChargeabilityFixtureTable(duplicate).ok).toBe(false);

    const category = rawTable();
    const c0 = casesOf(category)[0];
    if (!c0) throw new Error("empty table");
    c0.category = "Chargeable";
    expect(parseChargeabilityFixtureTable(category).ok).toBe(false);

    for (const [field, value] of [
      ["schemaVersion", "joint-chargeability-fixtures-v2"],
      ["contractVersion", "joint-chargeability-v2"],
      ["contractVersion", "joint-chargeability-v1 "],
      ["cases", []],
      ["cases", {}],
      ["description", null],
    ] as const satisfies ReadonlyArray<readonly [string, Json]>) {
      const drift = rawTable();
      drift[field] = value;
      expect(parseChargeabilityFixtureTable(drift).ok, `${field}`).toBe(false);
    }

    const extra = rawTable();
    extra.generatedBy = "tool";
    expect(parseChargeabilityFixtureTable(extra).ok).toBe(false);
  });

  it("a parsed table cannot be edited to smuggle a chargeable verdict past the parser", () => {
    const parsed = parseChargeabilityFixtureTable(fixtureTable);
    if (!parsed.ok) throw new Error(parsed.failure.code);
    for (const entry of parsed.value.cases) {
      const decision = decideChargeability(entry.outcome, entry.eligibility);
      expect(decision.chargeable, entry.id).toBe(entry.category === "chargeable");
      expect(decision.creditsConsumed, entry.id).toBe(entry.category === "chargeable" ? 1 : 0);
    }
  });

  it("the declared verdict of every fixture case is what the contract actually decides (no stale table)", () => {
    const parsed = parseChargeabilityFixtureTable(fixtureTable);
    if (!parsed.ok) throw new Error(parsed.failure.code);
    for (const entry of parsed.value.cases) {
      expect(decideChargeability(entry.outcome, entry.eligibility).reasonCode, entry.id).toBe(
        entry.expected.reasonCode,
      );
    }
  });
});
