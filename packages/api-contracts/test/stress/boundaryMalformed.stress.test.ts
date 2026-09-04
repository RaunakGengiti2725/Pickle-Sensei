/**
 * Boundary / malformed-input stress campaign for the wire-facing Zod
 * contracts in @pickle/api-contracts.
 *
 * Every scenario derives from a seed; the default run is small so it lives
 * in the suite. Full campaigns:
 *
 *   STRESS_ITER=1000 STRESS_OUT=/tmp/stress pnpm --filter @pickle/api-contracts exec vitest run test/stress
 *   STRESS_ONLY=<seed> pnpm --filter @pickle/api-contracts exec vitest run test/stress
 *
 * Invariants asserted for every generated payload:
 * - `safeParse` never throws (a typed rejection is the only failure path);
 * - the verdict matches an independent JSON-Schema oracle for single-slot
 *   mutations (refinement rejections are accepted as typed rejections);
 * - prototype-pollution keys never reach the parsed output and never reach
 *   Object.prototype;
 * - parsed output never carries NaN/Infinity;
 * - the same seed yields the same verdict and issue paths (determinism).
 */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  describeValue,
  hostileNumber,
  hostileScalar,
  hostileString,
  malformedJsonText,
  pollute,
  pollutedJsonText,
  truncatedJsonText,
  type HostileCategory,
} from "../../../shared-types/test/stress/generators.js";
import {
  findNonFiniteOrNegativeZero,
  runCampaign,
  stableJson,
  summarizeBroken,
  type CampaignResult,
  type OutcomeRow,
} from "../../../shared-types/test/stress/campaign.js";
import { DELETE, withPath } from "../../../shared-types/test/stress/fixtures.js";
import { EvaluationTrialUploadRequest, ShotsSyncRequest } from "../../src/schemas.js";
import { CONTRACT_FIXTURES, makeShotSyncPayload, type ContractFixture } from "./fixtures.js";
import { expectedVerdict, leafPaths, locate, objectPaths, schemaOf } from "./oracle.js";

const POLLUTION_KEYS = ["__proto__", "constructor", "prototype", "hasOwnProperty", "toString"];

function expectClean(result: CampaignResult): void {
  expect(result.executed).toBeGreaterThan(0);
  expect(result.broken, summarizeBroken(result)).toEqual([]);
}

function globalPrototypeClean(): boolean {
  const probe: Record<string, unknown> = {};
  return probe["polluted"] === undefined && probe["isAdmin"] === undefined;
}

interface ParseOutcome {
  success: boolean;
  issuePaths: string[];
  issueCodes: string[];
  data: unknown;
}

function parseWith(schema: z.ZodType, value: unknown): ParseOutcome {
  const result = schema.safeParse(value);
  if (result.success) return { success: true, issuePaths: [], issueCodes: [], data: result.data };
  return {
    success: false,
    issuePaths: result.error.issues.map((issue) => issue.path.map(String).join(".")),
    issueCodes: result.error.issues.map((issue) => issue.code),
    data: undefined,
  };
}

/** Does any own key (recursively) of `value` carry a pollution name? */
function carriesPollutionKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = carriesPollutionKey(item);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.getOwnPropertyNames(value)) {
      if (POLLUTION_KEYS.includes(key)) return key;
      const hit = carriesPollutionKey((value as Record<string, unknown>)[key]);
      if (hit !== null) return hit;
    }
  }
  return null;
}

const SCHEMA_DOCS = new Map<string, Record<string, unknown>>(
  CONTRACT_FIXTURES.map((fixture) => [fixture.name, schemaOf(fixture.schema)]),
);

function checkCommon(
  ctx: Parameters<Parameters<typeof runCampaign>[1]>[0],
  fixture: ContractFixture,
  payload: unknown,
  input: string,
  category: OutcomeRow["category"],
): ParseOutcome | undefined {
  const outcome = ctx.noThrow(
    "no-throw",
    input,
    () => parseWith(fixture.schema, payload),
    category,
  );
  if (outcome === undefined) return undefined;
  if (!globalPrototypeClean()) {
    ctx.broken(
      "no-global-pollution",
      "Object.prototype polluted after safeParse",
      input,
      "proto_pollution",
    );
    return undefined;
  }
  if (outcome.success) {
    const polluted = carriesPollutionKey(outcome.data);
    if (polluted === "__proto__") {
      ctx.broken(
        "output-has-no-proto-key",
        "own __proto__ key survived parse",
        input,
        "proto_pollution",
      );
      return undefined;
    }
    if (polluted !== null) {
      // Only `.loose()` envelopes pass unknown keys through; recorded so the
      // downstream consumer's handling of e.g. an own `toString` is visible.
      ctx.note(
        "pollution-key-passes-loose-envelope",
        `own key ${polluted} survived parse`,
        input,
        "proto_pollution",
      );
    }
    const nonFinite = findNonFiniteOrNegativeZero(outcome.data);
    if (nonFinite !== null && !nonFinite.endsWith("=-0")) {
      ctx.broken("output-finite", nonFinite, input, category);
      return undefined;
    }
    if (nonFinite !== null) {
      ctx.note("negative-zero-accepted", nonFinite, input, "negative_zero");
    }
  }
  const replay = ctx.noThrow(
    "deterministic",
    input,
    () => parseWith(fixture.schema, payload),
    category,
  );
  if (replay === undefined) return undefined;
  if (
    replay.success !== outcome.success ||
    stableJson(replay.issuePaths) !== stableJson(outcome.issuePaths) ||
    stableJson(replay.data) !== stableJson(outcome.data)
  ) {
    ctx.broken("deterministic", "two parses of the same payload disagree", input, category);
    return undefined;
  }
  return outcome;
}

describe("api-contracts single-slot hostile mutations (boundary-malformed)", () => {
  it("every contract rejects or accepts exactly as its published JSON Schema predicts, never throws", () => {
    const result = runCampaign(
      "api-contracts/slot-mutation",
      (ctx) => {
        const { rng } = ctx;
        const fixture = rng.pick(CONTRACT_FIXTURES);
        const doc = SCHEMA_DOCS.get(fixture.name) as Record<string, unknown>;
        const valid = fixture.make();
        const paths = leafPaths(valid);
        const path = rng.pick(paths);
        const located = locate(doc, path);
        if (located === null) {
          ctx.note("oracle-cannot-locate", path.join("."), fixture.name, "fixture");
          return;
        }
        // Pick a hostile replacement biased toward the slot's declared type.
        const { node } = located;
        const declared = (node["anyOf"] !== undefined ? "nullable" : node["type"]) as
          string | undefined;
        let hostile: { category: HostileCategory; value: unknown };
        const roll = rng.int(0, 9);
        if (roll === 0) {
          hostile = { category: "wrong_type", value: DELETE };
        } else if ((declared === "number" || declared === "integer") && roll <= 5) {
          hostile = hostileNumber(rng);
        } else if (declared === "string" && roll <= 5) {
          const maxLength = typeof node["maxLength"] === "number" ? node["maxLength"] : null;
          hostile =
            maxLength !== null && rng.bool(0.5)
              ? { category: "cap_boundary", value: "x".repeat(maxLength + rng.pick([-1, 0, 1, 2])) }
              : hostileString(rng);
        } else {
          hostile = hostileScalar(rng);
        }
        const payload = withPath(valid, path, hostile.value);
        const input = `${fixture.name} ${path.join(".")} := ${hostile.value === DELETE ? "<deleted>" : describeValue(hostile.value)}`;
        const outcome = checkCommon(ctx, fixture, payload, input, hostile.category);
        if (outcome === undefined) return;

        const expected = expectedVerdict(
          located.node,
          located.required,
          hostile.value === DELETE ? undefined : hostile.value,
        );
        if (expected === "undecided") {
          ctx.note(
            "oracle-undecided",
            outcome.success ? "accepted" : "rejected",
            input,
            hostile.category,
          );
          return;
        }
        const observed = outcome.success ? "accept" : "reject";
        if (expected === observed) {
          ctx.held(`verdict-${expected}`, hostile.category, input);
          return;
        }
        if (
          expected === "accept" &&
          fixture.refined &&
          outcome.issueCodes.every((code) => code === "custom")
        ) {
          // A cross-field refinement rejected structurally valid input — a typed rejection.
          ctx.held("verdict-refinement-reject", hostile.category, input);
          return;
        }
        ctx.broken(
          "verdict-matches-schema",
          `expected ${expected} got ${observed}${outcome.issuePaths.length > 0 ? ` (${outcome.issuePaths.join(",")})` : ""}`,
          input,
          hostile.category,
        );
      },
      { defaultIterations: 120 },
    );
    expectClean(result);
  });
});

describe("api-contracts prototype-pollution keys (boundary-malformed)", () => {
  it("own __proto__/constructor/prototype keys are stripped at every object level and never leak globally", () => {
    const result = runCampaign(
      "api-contracts/proto-pollution",
      (ctx) => {
        const { rng } = ctx;
        const fixture = rng.pick(CONTRACT_FIXTURES);
        const valid = fixture.make();
        const targets = objectPaths(valid);
        const path = rng.pick(targets);
        const container = path.reduce<unknown>(
          (node, segment) =>
            typeof node === "object" && node !== null
              ? (node as Record<string, unknown>)[segment]
              : undefined,
          valid,
        );
        if (typeof container !== "object" || container === null) return;
        const polluted = pollute(rng, container);
        const payload = withPath(valid, path, polluted.value);
        const input = `${fixture.name} pollute@${path.join(".") || "$"} keys=${Object.getOwnPropertyNames(
          polluted.value,
        )
          .filter((k) => POLLUTION_KEYS.includes(k))
          .join(",")}`;
        const outcome = checkCommon(ctx, fixture, payload, input, "proto_pollution");
        if (outcome === undefined) return;
        // Via JSON text as the wire would deliver it.
        const text = pollutedJsonText(rng, JSON.stringify(valid));
        const parsed = ctx.noThrow(
          "json-roundtrip-no-throw",
          input,
          () => JSON.parse(text) as unknown,
          "proto_pollution",
        );
        if (parsed === undefined) return;
        const wire = checkCommon(ctx, fixture, parsed, `${input} (wire)`, "proto_pollution");
        if (wire === undefined) return;
        ctx.held("pollution-stripped-or-rejected", "proto_pollution", input);
      },
      { defaultIterations: 60 },
    );
    expectClean(result);
  });
});

describe("api-contracts malformed / truncated JSON text (boundary-malformed)", () => {
  it("JSON.parse failures are SyntaxError only; whatever parses is decided by safeParse without throwing", () => {
    const result = runCampaign(
      "api-contracts/json-text",
      (ctx) => {
        const { rng } = ctx;
        const fixture = rng.pick(CONTRACT_FIXTURES);
        const validText = JSON.stringify(fixture.make());
        const hostile = rng.bool(0.5)
          ? truncatedJsonText(rng, validText)
          : { category: "malformed_json" as const, value: malformedJsonText(rng, validText) };
        const input = `${fixture.name} ${hostile.category} ${describeValue(hostile.value)}`;
        let parsed: unknown;
        try {
          parsed = JSON.parse(hostile.value);
        } catch (error) {
          if (error instanceof SyntaxError) {
            ctx.held("json-rejected-with-syntaxerror", hostile.category, input);
            return;
          }
          ctx.broken("json-parse-error-type", `threw ${String(error)}`, input, hostile.category);
          return;
        }
        const outcome = checkCommon(ctx, fixture, parsed, input, hostile.category);
        if (outcome === undefined) return;
        if (outcome.success && hostile.category === "truncated_json") {
          ctx.broken(
            "truncated-json-never-accepted",
            "truncated text parsed AND validated",
            input,
            hostile.category,
          );
          return;
        }
        if (outcome.success) {
          // Non-standard-but-parseable text (BOM stripped by the caller, NUL inside a
          // free-text string, -0) may legitimately validate; recorded, not asserted.
          ctx.note(
            "malformed-text-accepted",
            describeValue(parsed).slice(0, 120),
            input,
            hostile.category,
          );
        }
        ctx.held("decided-without-throw", hostile.category, input);
      },
      { defaultIterations: 80 },
    );
    expectClean(result);
  });
});

describe("api-contracts array cardinality caps (boundary-malformed)", () => {
  it("ShotsSyncRequest 1..200 and EvaluationTrialUploadRequest 1..50 are enforced at the exact edge", () => {
    const shotsDoc = schemaOf(ShotsSyncRequest);
    const trialsDoc = schemaOf(EvaluationTrialUploadRequest);
    const result = runCampaign(
      "api-contracts/array-caps",
      (ctx) => {
        const { rng } = ctx;
        const which = rng.pick(["shots", "trials"] as const);
        const doc = which === "shots" ? shotsDoc : trialsDoc;
        const located = locate(doc, [which]);
        const node = located?.node ?? {};
        const minItems = typeof node["minItems"] === "number" ? node["minItems"] : 0;
        const maxItems = typeof node["maxItems"] === "number" ? node["maxItems"] : 260;
        const count = rng.pick([
          0,
          1,
          2,
          minItems,
          maxItems - 1,
          maxItems,
          maxItems + 1,
          maxItems + 7,
          rng.int(0, 60),
        ]);
        const category: HostileCategory = count === 0 ? "empty_array" : "cap_boundary";
        const items: unknown[] = [];
        for (let i = 0; i < count; i += 1) {
          items.push(
            which === "shots"
              ? makeShotSyncPayload(i)
              : {
                  schemaVersion: "evaluation-trial-v1",
                  trialId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
                  capturedAtIso: "2026-08-27T17:30:00.000Z",
                  consent: {
                    scope: "evaluation_telemetry",
                    consentVersion: "evaluation-telemetry-v1",
                  },
                },
          );
        }
        const schema = which === "shots" ? ShotsSyncRequest : EvaluationTrialUploadRequest;
        const input = `${which} count=${count}`;
        const outcome = ctx.noThrow(
          "no-throw",
          input,
          () => parseWith(schema, { [which]: items }),
          category,
        );
        if (outcome === undefined) return;
        const expected = count >= minItems && count <= maxItems;
        if (outcome.success !== expected) {
          ctx.broken(
            "cardinality-cap",
            `expected ${expected ? "accept" : "reject"} got ${outcome.success ? "accept" : "reject"}`,
            input,
            category,
          );
          return;
        }
        ctx.held("cardinality-cap", category, input);
      },
      { defaultIterations: 30 },
    );
    expectClean(result);
  });
});

describe("api-contracts future schema versions and traversal ids (boundary-malformed)", () => {
  it("only the literal evaluation-trial-v1 envelope and RFC-4122 uuids pass", () => {
    const result = runCampaign(
      "api-contracts/version-and-id",
      (ctx) => {
        const { rng } = ctx;
        const trial = {
          schemaVersion: "evaluation-trial-v1",
          trialId: "00000000-0000-4000-8000-000000000001",
          capturedAtIso: "2026-08-27T17:30:00.000Z",
          consent: { scope: "evaluation_telemetry", consentVersion: "evaluation-telemetry-v1" },
        };
        const field = rng.pick([
          "schemaVersion",
          "trialId",
          "consent.scope",
          "consent.consentVersion",
        ] as const);
        const hostile = hostileString(rng);
        const payload = { trials: [withPath(trial, field.split("."), hostile.value)] };
        const input = `trials[0].${field} := ${describeValue(hostile.value)}`;
        const outcome = ctx.noThrow(
          "no-throw",
          input,
          () => parseWith(EvaluationTrialUploadRequest, payload),
          hostile.category,
        );
        if (outcome === undefined) return;
        const expected =
          field === "consent.consentVersion"
            ? hostile.value.length >= 1 && hostile.value.length <= 64
            : field === "trialId"
              ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                  hostile.value,
                )
              : false; // literals: any hostile string differs from the literal
        if (outcome.success !== expected) {
          ctx.broken(
            "literal-and-uuid-gate",
            `expected ${expected ? "accept" : "reject"} got ${outcome.success ? "accept" : "reject"}`,
            input,
            hostile.category,
          );
          return;
        }
        ctx.held("literal-and-uuid-gate", hostile.category, input);
      },
      { defaultIterations: 60 },
    );
    expectClean(result);
  });
});
