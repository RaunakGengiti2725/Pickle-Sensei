/**
 * Boundary / malformed-input stress campaigns for @pickle/shared-types.
 *
 * Every public entry point that receives data from a wire, a store or a user
 * (trial validator, consent-version gate, text/voice intent resolvers, rank
 * computation, stability aggregation, retention policy, consent ledger fold)
 * is driven with seeded hostile inputs and held to these contracts:
 *   - never throws (graceful, typed rejection instead);
 *   - outputs stay in their declared domain (no NaN/Infinity/-0, bounded
 *     statuses, registry-only techniques);
 *   - deterministic for the same input, order-independent where documented;
 *   - Object.prototype is never polluted by hostile keys.
 *
 * Scale: STRESS_ITER iterations per campaign (default small so the suite stays
 * fast); STRESS_SEED picks the campaign; STRESS_ONLY=<seed> replays one
 * iteration; STRESS_OUT=<dir> writes the seed → outcome JSON tables.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CONSENT_SCOPES,
  PICKLEBALL_TECHNIQUES,
  SELECTABLE_TECHNIQUES_V1,
  MEDIA_ASSET_KINDS,
  MEDIA_RETENTION_POLICY_V1,
  STABILITY_SLO_THRESHOLDS_V1,
  aggregateStabilitySlo,
  canonicalConsentRecordsJson,
  checkConsentVersionAcceptable,
  computePlayerRank,
  deriveConsentStatus,
  evaluateStabilitySlo,
  guardRolloutAdvance,
  isFeedbackReviewEligible,
  isRetentionExpired,
  parseConsentVersionMajor,
  projectVoiceResolution,
  resolveTechniqueIntent,
  resolveVoiceTechniqueIntent,
  stabilityRolloutDecision,
  validateEvaluationTrial,
  type ConsentRecord,
  type ConsentScope,
  type MediaAssetKind,
  type PlayerRankAnalysisInput,
  type StabilitySloEvent,
} from "../../src/index.js";
import {
  campaignTimeoutMs,
  findNonFiniteOrNegativeZero,
  runCampaign,
  stableJson,
  summarizeBroken,
  type CampaignResult,
} from "./campaign.js";
import {
  DELETE,
  TRIAL_FIELD_SPECS,
  makeConsentRecord,
  makeRankInput,
  makeStabilityEvent,
  makeTrialFixture,
  trialFieldAccepts,
  withPath,
} from "./fixtures.js";
import {
  HUGE_LENGTH,
  describeValue,
  futureVersionString,
  hostileNumber,
  hostileScalar,
  hostileString,
  hugeString,
  malformedJsonText,
  normalizationPair,
  pollute,
  pollutedJsonText,
  truncatedJsonText,
  wrongTypeValue,
} from "./generators.js";

const SELECTABLE_CANONICALS = new Set(SELECTABLE_TECHNIQUES_V1.map((t) => t.canonical));
const TAXONOMY_SLUGS = new Set<string>(PICKLEBALL_TECHNIQUES.map((t) => t.slug));
/** Per-call wall-clock budget for a pure resolver on ≤ 1 MB of text. */
const RESOLVER_BUDGET_MS = 1_000;

function globalPrototypeClean(): boolean {
  const probe: Record<string, unknown> = {};
  return probe["polluted"] === undefined && probe["isAdmin"] === undefined;
}

vi.setConfig({ testTimeout: campaignTimeoutMs() });

/**
 * Campaign assertion. `knownBroken` lists checks whose failures are the
 * reproduced findings pinned by the `it.fails` cases at the bottom of this
 * file; the campaign still records every such row in its JSON table, but only
 * a NEW class of failure turns the campaign red. Remove a check from the list
 * (and its `it.fails` case) once the defect is fixed.
 */
function expectClean(result: CampaignResult, knownBroken: readonly string[] = []): void {
  expect(result.executed).toBeGreaterThan(0);
  const unexpected = result.broken.filter((row) => !knownBroken.includes(row.check));
  expect(unexpected, summarizeBroken({ ...result, broken: unexpected })).toEqual([]);
}

describe("validateEvaluationTrial under hostile input (boundary-malformed)", () => {
  it("never throws, rejects malformed records exactly where the contract says, stays deterministic", () => {
    const result = runCampaign("validateEvaluationTrial", (ctx) => {
      const { rng } = ctx;
      const mode = rng.int(0, 9);

      if (mode === 0) {
        // Whole-value garbage: scalars, wrong containers, huge strings.
        const hostile = hostileScalar(rng);
        const input = describeValue(hostile.value);
        const verdict = ctx.noThrow(
          "no-throw",
          input,
          () => validateEvaluationTrial(hostile.value),
          hostile.category,
        );
        if (verdict === undefined) return;
        if (verdict.ok)
          ctx.broken("rejects-non-record", "accepted a non-record", input, hostile.category);
        else if (verdict.errors.length === 0)
          ctx.broken("errors-when-rejecting", "ok=false with no errors", input, hostile.category);
        else ctx.held("rejects-non-record", hostile.category);
        return;
      }

      if (mode === 1) {
        // Prototype-pollution keys as OWN properties on an otherwise valid record.
        const polluted = pollute(rng, makeTrialFixture());
        const input =
          "valid trial + " +
          Object.keys(polluted.value)
            .filter((k) => !(k in makeTrialFixture()))
            .join(",");
        const verdict = ctx.noThrow(
          "no-throw",
          input,
          () => validateEvaluationTrial(polluted.value),
          "proto_pollution",
        );
        if (verdict === undefined) return;
        if (!globalPrototypeClean())
          ctx.broken("no-global-pollution", "Object.prototype polluted", input, "proto_pollution");
        else ctx.held("no-global-pollution", "proto_pollution");
        // Unknown keys are ignored by the structural validator; record it.
        ctx.note("unknown-keys-ignored", `ok=${String(verdict.ok)}`, input, "proto_pollution");
        return;
      }

      if (mode === 2) {
        // Malformed / truncated JSON text of a valid record → typed parse
        // failure (SyntaxError) or, when it parses, no throw from the validator.
        const text = JSON.stringify(makeTrialFixture());
        const hostile = rng.bool()
          ? truncatedJsonText(rng, text)
          : { category: "malformed_json" as const, value: malformedJsonText(rng, text) };
        let parsed: unknown;
        try {
          parsed = JSON.parse(hostile.value) as unknown;
        } catch (error) {
          if (error instanceof SyntaxError || error instanceof RangeError) {
            ctx.held("json-parse-typed-rejection", hostile.category);
            // The raw text itself must also be rejected gracefully.
            const raw = ctx.noThrow(
              "no-throw-raw-text",
              describeValue(hostile.value),
              () => validateEvaluationTrial(hostile.value),
              hostile.category,
            );
            if (raw !== undefined && raw.ok)
              ctx.broken(
                "rejects-raw-text",
                "accepted raw JSON text as a record",
                describeValue(hostile.value),
                hostile.category,
              );
            return;
          }
          ctx.broken(
            "json-parse-typed-rejection",
            `unexpected ${String(error)}`,
            describeValue(hostile.value),
            hostile.category,
          );
          return;
        }
        const input = describeValue(hostile.value);
        const verdict = ctx.noThrow(
          "no-throw",
          input,
          () => validateEvaluationTrial(parsed),
          hostile.category,
        );
        if (verdict === undefined) return;
        const hit = findNonFiniteOrNegativeZero(parsed);
        if (verdict.ok && hit !== null) {
          // -0 is finite; the contract (finite-or-null) admits it. Observation only.
          ctx.note("finite-contract-admits-negative-zero", hit, input, "negative_zero");
        } else {
          ctx.held("no-throw", hostile.category);
        }
        return;
      }

      if (mode === 3) {
        // Future schema versions must be rejected, not silently accepted.
        const version = futureVersionString(rng);
        const record = { ...makeTrialFixture(), schemaVersion: version };
        const input = `schemaVersion=${JSON.stringify(version)}`;
        const verdict = ctx.noThrow(
          "no-throw",
          input,
          () => validateEvaluationTrial(record),
          "future_schema",
        );
        if (verdict === undefined) return;
        if (verdict.ok)
          ctx.broken(
            "rejects-future-schema",
            "accepted unknown schemaVersion",
            input,
            "future_schema",
          );
        else ctx.held("rejects-future-schema", "future_schema");
        return;
      }

      // Modes 4..9: targeted field mutations with an independent oracle.
      const mutations = rng.int(1, 3);
      let record: unknown = makeTrialFixture();
      // Later mutations of the same field overwrite earlier ones, so the oracle
      // keeps only the final verdict per field.
      const fieldAccepts = new Map<string, boolean>();
      const descriptions: string[] = [];
      let category: Parameters<typeof ctx.held>[1] = "wrong_type";
      for (let m = 0; m < mutations; m += 1) {
        const spec = rng.pick(TRIAL_FIELD_SPECS);
        const deleteIt = rng.bool(0.15);
        if (deleteIt) {
          record = withPath(record, spec.path, DELETE);
          fieldAccepts.set(spec.path.join("."), false);
          descriptions.push(`${spec.path.join(".")}=<deleted>`);
          continue;
        }
        const hostile = hostileScalar(rng);
        category = hostile.category;
        record = withPath(record, spec.path, hostile.value);
        const accepts = trialFieldAccepts(spec.field, hostile.value);
        fieldAccepts.set(spec.path.join("."), accepts);
        descriptions.push(`${spec.path.join(".")}=${describeValue(hostile.value)}`);
        if (accepts && typeof hostile.value === "string" && hostile.value.length >= HUGE_LENGTH) {
          ctx.note(
            "uncapped-string-accepted",
            `${spec.path.join(".")} accepts ${hostile.value.length} code units`,
            descriptions.at(-1) ?? "",
            "huge_string",
          );
        }
        if (
          accepts &&
          typeof hostile.value === "number" &&
          hostile.value < 0 &&
          spec.path.at(-1) !== "overallScore"
        ) {
          ctx.note(
            "negative-number-accepted",
            `${spec.path.join(".")} accepts ${String(hostile.value)}`,
            descriptions.at(-1) ?? "",
            "numeric_overflow",
          );
        }
      }
      const expectedOk = [...fieldAccepts.values()].every(Boolean);
      const input = descriptions.join("; ");
      const verdict = ctx.noThrow(
        "no-throw",
        input,
        () => validateEvaluationTrial(record),
        category,
      );
      if (verdict === undefined) return;
      if (verdict.ok !== expectedOk) {
        ctx.broken(
          expectedOk ? "accepts-well-formed" : "rejects-malformed",
          `validator ok=${String(verdict.ok)} but contract says ok=${String(expectedOk)}; errors=${verdict.errors.join(" | ").slice(0, 200)}`,
          input,
          category,
        );
        return;
      }
      if (!verdict.ok && verdict.errors.length === 0) {
        ctx.broken("errors-when-rejecting", "ok=false with no errors", input, category);
        return;
      }
      const again = validateEvaluationTrial(record);
      if (stableJson(again) !== stableJson(verdict)) {
        ctx.broken("deterministic", "two calls differ", input, category);
        return;
      }
      if (verdict.ok) {
        // Accepted ⇒ the JSON round trip (what actually gets stored) is accepted too.
        const roundTrip = validateEvaluationTrial(JSON.parse(JSON.stringify(record)) as unknown);
        if (!roundTrip.ok) {
          ctx.broken(
            "accepted-survives-json-roundtrip",
            roundTrip.errors.join(" | "),
            input,
            category,
          );
          return;
        }
      }
      ctx.held("oracle-agrees", category, input);
    });
    expectClean(result);
  });
});

describe("consent version gate under hostile input (boundary-malformed)", () => {
  it("never throws, only accepts canonical versions, never loses precision in the downgrade guard", () => {
    const result = runCampaign("checkConsentVersionAcceptable", (ctx) => {
      const { rng } = ctx;
      const scope = rng.pick(CONSENT_SCOPES);
      const prefix = {
        video_analysis: "video-analysis",
        model_training: "model-training",
        evaluation_telemetry: "evaluation-telemetry",
      }[scope];
      const mode = rng.int(0, 5);

      const requested: string =
        mode === 0
          ? hostileString(rng).value
          : mode === 1
            ? futureVersionString(rng)
            : mode === 2
              ? `${prefix}-v${rng.int(0, 1_000)}`
              : mode === 3
                ? `${prefix}-v${"9".repeat(rng.int(1, 400))}`
                : mode === 4
                  ? `${prefix}-v${rng.int(1, 9)}${rng.pick(["\u0000", " ", "\n", "\u200b", "٠", "1e3", ".0"])}`
                  : `${prefix}-v${"1" + "0".repeat(rng.int(15, 60)) + rng.pick(["0", "1"])}`;
      const latest: string | null = rng.bool(0.4)
        ? null
        : rng.bool()
          ? `${prefix}-v${rng.int(0, 1_000)}`
          : `${prefix}-v${"1" + "0".repeat(rng.int(15, 60)) + rng.pick(["0", "1"])}`;

      const input = `scope=${scope} requested=${describeValue(requested)} latest=${describeValue(latest)}`;
      const started = performance.now();
      const check = ctx.noThrow(
        "no-throw",
        input,
        () => checkConsentVersionAcceptable(scope, requested, latest),
        mode === 0 ? "huge_string" : "future_schema",
      );
      const elapsed = performance.now() - started;
      if (check === undefined) return;
      if (elapsed > RESOLVER_BUDGET_MS)
        ctx.broken("time-bounded", `${elapsed.toFixed(1)}ms`, input, "huge_string");

      const canonical = new RegExp(`^${prefix}-v(0|[1-9][0-9]*)$`).exec(requested);
      if (!check.ok) {
        if (check.rejection === null || check.message === null) {
          ctx.broken("typed-rejection", "ok=false without rejection/message", input);
          return;
        }
        if (check.rejection === "malformed" && canonical !== null) {
          ctx.broken("accepts-canonical", "canonical version reported malformed", input);
          return;
        }
        ctx.held("typed-rejection", mode === 0 ? "huge_string" : "future_schema");
        return;
      }
      // Accepted.
      if (canonical === null) {
        ctx.broken(
          "rejects-non-canonical",
          "accepted a non-canonical version string",
          input,
          "future_schema",
        );
        return;
      }
      if (check.major === null || !Number.isFinite(check.major)) {
        ctx.broken(
          "no-non-finite-output",
          `major=${String(check.major)}`,
          input,
          "numeric_overflow",
        );
        return;
      }
      if (!Number.isSafeInteger(check.major) || String(check.major) !== canonical[1]) {
        ctx.broken(
          "major-exact",
          `major=${String(check.major)} for digits ${canonical[1]?.slice(0, 40)}… (precision lost)`,
          input,
          "numeric_overflow",
        );
        return;
      }
      if (latest !== null) {
        const latestCanonical = new RegExp(`^${prefix}-v(0|[1-9][0-9]*)$`).exec(latest);
        if (
          latestCanonical !== null &&
          BigInt(canonical[1] as string) < BigInt(latestCanonical[1] as string)
        ) {
          ctx.broken(
            "downgrade-blocked-exactly",
            `requested ${canonical[1]} < granted ${latestCanonical[1]} yet accepted`,
            input,
            "numeric_overflow",
          );
          return;
        }
      }
      ctx.held("accepts-canonical-only", "future_schema");
    });
    expectClean(result, ["major-exact", "no-non-finite-output"]);
  });

  it("parseConsentVersionMajor never throws for hostile scope strings that reach it untyped", () => {
    const result = runCampaign("parseConsentVersionMajor.hostileScope", (ctx) => {
      const scope = ctx.rng.pick([
        "__proto__",
        "constructor",
        "toString",
        "hasOwnProperty",
        "",
        "video_analysis ",
        "VIDEO_ANALYSIS",
        "../model_training",
      ]);
      const version = ctx.rng.bool() ? hostileString(ctx.rng).value : `${scope}-v1`;
      const input = `scope=${JSON.stringify(scope)} version=${describeValue(version)}`;
      const major = ctx.noThrow(
        "no-throw",
        input,
        () => parseConsentVersionMajor(scope as ConsentScope, version),
        "proto_pollution",
      );
      if (major === undefined) return;
      if (major !== null)
        ctx.broken(
          "unknown-scope-never-parses",
          `major=${String(major)}`,
          input,
          "proto_pollution",
        );
      else ctx.held("unknown-scope-never-parses", "proto_pollution");
    });
    expectClean(result);
  });
});

describe("technique / voice intent resolvers under hostile text (boundary-malformed)", () => {
  it("resolveTechniqueIntent: bounded statuses, registry techniques, finite confidence, time-bounded", () => {
    const result = runCampaign("resolveTechniqueIntent", (ctx) => {
      const { rng } = ctx;
      const hostile = rng.bool(0.6) ? hostileString(rng) : hugeString(rng);
      const text = rng.bool(0.3) ? `forehand ${hostile.value} dink` : hostile.value;
      const input = describeValue(text);
      const started = performance.now();
      const resolution = ctx.noThrow(
        "no-throw",
        input,
        () => resolveTechniqueIntent(text),
        hostile.category,
      );
      const elapsed = performance.now() - started;
      if (resolution === undefined) return;
      if (elapsed > RESOLVER_BUDGET_MS) {
        ctx.broken(
          "time-bounded",
          `${elapsed.toFixed(1)}ms for ${text.length} code units`,
          input,
          hostile.category,
        );
        return;
      }
      switch (resolution.status) {
        case "resolved":
          if (!SELECTABLE_CANONICALS.has(resolution.technique.canonical)) {
            ctx.broken("registry-only", resolution.technique.canonical, input, hostile.category);
            return;
          }
          if (
            !Number.isFinite(resolution.confidence) ||
            resolution.confidence < 0 ||
            resolution.confidence > 1
          ) {
            ctx.broken(
              "confidence-in-unit-interval",
              String(resolution.confidence),
              input,
              hostile.category,
            );
            return;
          }
          break;
        case "ambiguous":
          if (
            resolution.options.length === 0 ||
            resolution.options.some((o) => !SELECTABLE_CANONICALS.has(o.canonical))
          ) {
            ctx.broken(
              "registry-only",
              "ambiguous with empty/unknown options",
              input,
              hostile.category,
            );
            return;
          }
          break;
        case "auto":
        case "unknown":
          break;
        default:
          ctx.broken(
            "bounded-status",
            String((resolution as { status: string }).status),
            input,
            hostile.category,
          );
          return;
      }
      if (stableJson(resolveTechniqueIntent(text)) !== stableJson(resolution)) {
        ctx.broken("deterministic", "two calls differ", input, hostile.category);
        return;
      }
      ctx.held("bounded-output", hostile.category);
    });
    expectClean(result);
  });

  it("resolveVoiceTechniqueIntent + projectVoiceResolution: taxonomy-only, no invented routes, time-bounded", () => {
    const result = runCampaign("resolveVoiceTechniqueIntent", (ctx) => {
      const { rng } = ctx;
      const hostile = rng.bool(0.6) ? hostileString(rng) : hugeString(rng);
      const glue = rng.pick([
        "",
        "not ",
        "two handed backhand ",
        "serve ",
        "i want to work on my ",
      ]);
      const text = `${glue}${hostile.value}`;
      const input = describeValue(text);
      const started = performance.now();
      const resolution = ctx.noThrow(
        "no-throw",
        input,
        () => resolveVoiceTechniqueIntent(text),
        hostile.category,
      );
      const elapsed = performance.now() - started;
      if (resolution === undefined) return;
      if (elapsed > RESOLVER_BUDGET_MS) {
        ctx.broken(
          "time-bounded",
          `${elapsed.toFixed(1)}ms for ${text.length} code units`,
          input,
          hostile.category,
        );
        return;
      }
      if (resolution.version !== "voice-intent-v3") {
        ctx.broken("versioned-output", String(resolution.version), input, hostile.category);
        return;
      }
      if (resolution.status === "leaf") {
        if (!TAXONOMY_SLUGS.has(resolution.slug)) {
          ctx.broken("taxonomy-only", resolution.slug, input, hostile.category);
          return;
        }
        if (
          !Number.isFinite(resolution.confidence) ||
          resolution.confidence < 0 ||
          resolution.confidence > 1
        ) {
          ctx.broken(
            "confidence-in-unit-interval",
            String(resolution.confidence),
            input,
            hostile.category,
          );
          return;
        }
      } else if (resolution.status === "family" || resolution.status === "side") {
        if (resolution.candidates.some((slug) => !TAXONOMY_SLUGS.has(slug))) {
          ctx.broken("taxonomy-only", "candidate outside taxonomy", input, hostile.category);
          return;
        }
      } else if (resolution.status !== "auto" && resolution.status !== "unknown") {
        ctx.broken(
          "bounded-status",
          String((resolution as { status: string }).status),
          input,
          hostile.category,
        );
        return;
      }
      const projected = ctx.noThrow(
        "projection-no-throw",
        input,
        () => projectVoiceResolution(resolution),
        hostile.category,
      );
      if (projected === undefined) return;
      if (
        projected.status === "resolved" &&
        !SELECTABLE_CANONICALS.has(projected.technique.canonical)
      ) {
        ctx.broken(
          "projection-registry-only",
          projected.technique.canonical,
          input,
          hostile.category,
        );
        return;
      }
      if (
        projected.status === "ambiguous" &&
        projected.options.some((o) => !SELECTABLE_CANONICALS.has(o.canonical))
      ) {
        ctx.broken("projection-registry-only", "option outside registry", input, hostile.category);
        return;
      }
      if (stableJson(resolveVoiceTechniqueIntent(text)) !== stableJson(resolution)) {
        ctx.broken("deterministic", "two calls differ", input, hostile.category);
        return;
      }
      ctx.held("bounded-output", hostile.category);
    });
    expectClean(result);
  });

  it("unicode normalization pairs: canonically equivalent transcripts resolve identically", () => {
    const result = runCampaign("resolvers.normalizationPairs", (ctx) => {
      const [nfc, nfd] = normalizationPair(ctx.rng);
      const template = ctx.rng.pick([
        "${x} dink",
        "forehand ${x}",
        "${x}",
        "serve ${x} drop",
        "back${x}hand",
      ]);
      const a = template.replace("${x}", nfc);
      const b = template.replace("${x}", nfd);
      const input = `${describeValue(a)} vs ${describeValue(b)}`;
      const ra = ctx.noThrow(
        "no-throw",
        input,
        () => resolveTechniqueIntent(a),
        "unicode_normalization",
      );
      const rb = ctx.noThrow(
        "no-throw",
        input,
        () => resolveTechniqueIntent(b),
        "unicode_normalization",
      );
      const va = ctx.noThrow(
        "no-throw",
        input,
        () => resolveVoiceTechniqueIntent(a),
        "unicode_normalization",
      );
      const vb = ctx.noThrow(
        "no-throw",
        input,
        () => resolveVoiceTechniqueIntent(b),
        "unicode_normalization",
      );
      if (ra === undefined || rb === undefined || va === undefined || vb === undefined) return;
      // Only canonical (NFC/NFD) pairs are required to agree, and only on the
      // routing outcome (status + technique), not on human-readable reasons;
      // compatibility pairs (ligatures) legitimately differ and are recorded.
      const canonical = a.normalize("NFC") === b.normalize("NFC");
      const textOutcome = (r: typeof ra) =>
        r.status === "resolved"
          ? `resolved:${r.technique.canonical}`
          : r.status === "ambiguous"
            ? `ambiguous:${r.options.map((o) => o.canonical).join(",")}`
            : r.status;
      const voiceOutcome = (r: typeof va) =>
        r.status === "leaf"
          ? `leaf:${r.slug}`
          : r.status === "family" || r.status === "side"
            ? `${r.status}:${r.candidates.join(",")}`
            : r.status;
      const textAgree = textOutcome(ra) === textOutcome(rb);
      const voiceAgree = voiceOutcome(va) === voiceOutcome(vb);
      if (canonical && (!textAgree || !voiceAgree)) {
        ctx.broken(
          "normalization-invariant",
          `text: ${textOutcome(ra)} vs ${textOutcome(rb)}; voice: ${voiceOutcome(va)} vs ${voiceOutcome(vb)}`,
          input,
          "unicode_normalization",
        );
        return;
      }
      if (!canonical && (!textAgree || !voiceAgree)) {
        ctx.note(
          "compatibility-pair-differs",
          `text=${String(textAgree)} voice=${String(voiceAgree)}`,
          input,
          "unicode_normalization",
        );
      }
      ctx.held("normalization-invariant", "unicode_normalization");
    });
    expectClean(result, ["normalization-invariant"]);
  });
});

describe("computePlayerRank under hostile rows (boundary-malformed)", () => {
  it("never throws, outputs finite in-range numbers, is order-independent and deterministic", () => {
    const result = runCampaign("computePlayerRank", (ctx) => {
      const { rng } = ctx;
      const count = rng.pick([0, 1, 2, 3, 5, 8, 9, 20, 50]);
      const rows: PlayerRankAnalysisInput[] = [];
      let category: Parameters<typeof ctx.held>[1] = "fixture";
      for (let i = 0; i < count; i += 1) {
        const row = makeRankInput(rng);
        if (rng.bool(0.35)) {
          // Corrupt one field with a hostile value (a damaged local row).
          const field = rng.pick([
            "shotType",
            "overallScore",
            "resultKind",
            "capturedAt",
            "id",
            "source",
          ] as const);
          const hostile =
            field === "overallScore" && rng.bool(0.6) ? hostileNumber(rng) : hostileScalar(rng);
          category = hostile.category;
          rows.push({ ...row, [field]: hostile.value } as PlayerRankAnalysisInput);
        } else {
          rows.push(row);
        }
      }
      if (rng.bool(0.2)) {
        const polluted = pollute(
          rng,
          rows.length > 0 ? (rows[0] as PlayerRankAnalysisInput) : makeRankInput(rng),
        );
        rows.push(polluted.value);
        category = "proto_pollution";
      }
      const input = `${rows.length} rows: ${describeValue(rows.slice(0, 3))}`;
      const summary = ctx.noThrow("no-throw", input, () => computePlayerRank(rows), category);
      if (summary === undefined) return;
      if (!globalPrototypeClean()) {
        ctx.broken("no-global-pollution", "Object.prototype polluted", input, "proto_pollution");
        return;
      }
      if (summary !== null) {
        const hit = findNonFiniteOrNegativeZero(summary);
        if (hit !== null) {
          ctx.broken("no-non-finite-output", hit, input, category);
          return;
        }
        if (summary.rating < 0 || summary.rating > 10) {
          ctx.broken("rating-in-range", String(summary.rating), input, category);
          return;
        }
        if (summary.techniques.some((t) => t.score < 0 || t.score > 10)) {
          ctx.broken(
            "technique-score-in-range",
            describeValue(summary.techniques),
            input,
            category,
          );
          return;
        }
        if (summary.nextTier !== null && summary.nextTier.pointsNeeded < 0) {
          ctx.broken(
            "points-needed-non-negative",
            String(summary.nextTier.pointsNeeded),
            input,
            category,
          );
          return;
        }
        if (summary.techniqueCount !== summary.techniques.length) {
          ctx.broken(
            "technique-count-consistent",
            `${summary.techniqueCount} vs ${summary.techniques.length}`,
            input,
            category,
          );
          return;
        }
      }
      const shuffled = rng.shuffle(rows);
      const again = computePlayerRank(shuffled);
      if (stableJson(again) !== stableJson(summary)) {
        ctx.broken(
          "order-independent",
          `original=${describeValue(summary)} shuffled=${describeValue(again)}`,
          describeValue(rows),
          category,
        );
        return;
      }
      if (stableJson(computePlayerRank(rows)) !== stableJson(summary)) {
        ctx.broken("deterministic", "two calls differ", input, category);
        return;
      }
      ctx.held("bounded-output", category);
    });
    expectClean(result, ["no-throw", "no-non-finite-output", "order-independent"]);
  });
});

describe("stability SLO pipeline under hostile events (boundary-malformed)", () => {
  it("aggregate → evaluate → decide → guard never throws and never emits NaN/Infinity", () => {
    const result = runCampaign("stabilitySlo", (ctx) => {
      const { rng } = ctx;
      const count = rng.pick([0, 1, 5, 20, 100]);
      const events: StabilitySloEvent[] = [];
      let category: Parameters<typeof ctx.held>[1] = "fixture";
      for (let i = 0; i < count; i += 1) {
        const event = makeStabilityEvent(rng, rng.int(0, 10));
        if (rng.bool(0.3)) {
          const field = rng.pick([
            "kind",
            "userKey",
            "sessionKey",
            "at",
            "fatal",
            "fingerprint",
            "reason",
          ]);
          const hostile = hostileScalar(rng);
          category = hostile.category;
          events.push({ ...event, [field]: hostile.value } as StabilitySloEvent);
        } else if (rng.bool(0.1)) {
          events.push(pollute(rng, event).value);
          category = "proto_pollution";
        } else {
          events.push(event);
        }
      }
      const input = `${events.length} events: ${describeValue(events.slice(0, 3))}`;
      const metrics = ctx.noThrow(
        "aggregate-no-throw",
        input,
        () => aggregateStabilitySlo(events),
        category,
      );
      if (metrics === undefined) return;
      const hit = findNonFiniteOrNegativeZero(metrics);
      if (hit !== null) {
        ctx.broken("metrics-finite", hit, input, category);
        return;
      }
      for (const [key, value] of Object.entries(metrics)) {
        if (key.endsWith("Rate") && value !== null && (typeof value !== "number" || value < 0)) {
          ctx.broken("rates-non-negative", `${key}=${String(value)}`, input, category);
          return;
        }
        if (key.endsWith("Rate") && typeof value === "number" && value > 1) {
          // completed/started style ratios exceed 1 when the submitted log is
          // internally inconsistent (completions without starts) — honest
          // arithmetic over the log, recorded rather than asserted.
          ctx.note(
            "rate-exceeds-one-on-inconsistent-log",
            `${key}=${String(value)}`,
            input,
            category,
          );
        }
        if (
          typeof value === "number" &&
          !key.endsWith("Rate") &&
          (!Number.isInteger(value) || value < 0)
        ) {
          ctx.broken("counts-non-negative-integers", `${key}=${String(value)}`, input, category);
          return;
        }
      }
      const evaluation = ctx.noThrow(
        "evaluate-no-throw",
        input,
        () => evaluateStabilitySlo(metrics, STABILITY_SLO_THRESHOLDS_V1),
        category,
      );
      if (evaluation === undefined) return;
      if (
        evaluation.results.some((r) => !["pass", "breach", "not_evaluable"].includes(r.verdict))
      ) {
        ctx.broken("bounded-verdicts", describeValue(evaluation.results), input, category);
        return;
      }
      const decision = ctx.noThrow(
        "decide-no-throw",
        input,
        () => stabilityRolloutDecision(evaluation),
        category,
      );
      if (decision === undefined) return;
      if (!["proceed", "hold", "pause"].includes(decision.action)) {
        ctx.broken("bounded-actions", decision.action, input, category);
        return;
      }
      // Guard: hostile percentages must never yield a non-finite effective percentage.
      const current = rng.bool(0.5) ? rng.int(0, 100) : hostileNumber(rng).value;
      const requested = rng.bool(0.5) ? rng.int(0, 100) : hostileNumber(rng).value;
      const guardInput = `decision=${decision.action} current=${describeValue(current)} requested=${describeValue(requested)}`;
      const verdict = ctx.noThrow(
        "guard-no-throw",
        guardInput,
        () => guardRolloutAdvance(decision, current, requested),
        "nan",
      );
      if (verdict === undefined) return;
      if (
        verdict.allowed &&
        decision.action !== "proceed" &&
        Number.isFinite(current) &&
        Number.isFinite(requested) &&
        requested > current
      ) {
        ctx.broken(
          "guard-blocks-advance",
          "advance allowed under hold/pause",
          guardInput,
          "fixture",
        );
        return;
      }
      if (!Number.isFinite(current) || !Number.isFinite(requested)) {
        // guardRolloutAdvance is typed `number` and both production callers
        // (services/api admin routes) zod-guard the percentage to an integer
        // 0..100 before calling it, so non-finite input cannot reach it; its
        // pass-through arithmetic is recorded, not asserted.
        ctx.note(
          "guard-passes-through-non-finite",
          `allowed=${String(verdict.allowed)} effective=${String(verdict.effectiveRolloutPercent)}`,
          guardInput,
          "nan",
        );
      }
      ctx.held("pipeline-bounded", category);
    });
    expectClean(result);
  });
});

describe("media retention policy under hostile rows (boundary-malformed)", () => {
  it("isRetentionExpired returns a boolean for every asset kind / date / window combination", () => {
    const result = runCampaign("isRetentionExpired", (ctx) => {
      const { rng } = ctx;
      const knownKind = rng.bool(0.6);
      const kind = knownKind
        ? rng.pick(MEDIA_ASSET_KINDS)
        : rng.pick([
            "__proto__",
            "constructor",
            "toString",
            "hasOwnProperty",
            "",
            "pose_cache",
            "raw_video ",
            "RAW_VIDEO",
            "../raw_video",
            "\u0000",
          ]);
      const dates = [
        new Date("2026-01-01T00:00:00.000Z"),
        new Date(Number.NaN),
        new Date(8.64e15),
        new Date(-8.64e15),
        new Date(0),
        new Date(8.64e15 - 1),
      ];
      const createdAt = rng.pick(dates);
      const expiresAt = rng.bool(0.6) ? null : rng.pick(dates);
      const userRetentionDays = rng.bool(0.4)
        ? null
        : rng.bool(0.5)
          ? rng.int(-5, 400)
          : hostileNumber(rng).value;
      const now = rng.pick(dates);
      const input = `kind=${JSON.stringify(kind)} createdAt=${describeValue(createdAt)} expiresAt=${describeValue(expiresAt)} userRetentionDays=${describeValue(userRetentionDays)} now=${describeValue(now)}`;
      const category = knownKind
        ? typeof userRetentionDays === "number" && !Number.isFinite(userRetentionDays)
          ? "infinity"
          : "fixture"
        : kind.startsWith("_") ||
            kind === "constructor" ||
            kind === "toString" ||
            kind === "hasOwnProperty"
          ? "proto_pollution"
          : "future_schema";
      const expired = ctx.noThrow(
        "no-throw",
        input,
        () =>
          isRetentionExpired(
            { kind: kind as MediaAssetKind, createdAt, expiresAt, userRetentionDays },
            MEDIA_RETENTION_POLICY_V1,
            now,
          ),
        category,
      );
      if (expired === undefined) return;
      if (typeof expired !== "boolean") {
        ctx.broken("boolean-output", describeValue(expired), input, category);
        return;
      }
      // Fail-safe direction: an unparseable or overflowed deadline must not
      // delete the asset (expired=false) unless an explicit expiresAt says so.
      if (
        expiresAt === null &&
        expired &&
        (Number.isNaN(createdAt.getTime()) || Number.isNaN(now.getTime()))
      ) {
        ctx.broken(
          "fail-safe-on-invalid-dates",
          "expired=true with an invalid date",
          input,
          category,
        );
        return;
      }
      ctx.held("boolean-output", category);
    });
    expectClean(result, ["no-throw"]);
  });
});

describe("consent ledger fold / export serializer under hostile records (boundary-malformed)", () => {
  it("deriveConsentStatus is total over the scope set, order-independent, and canonical JSON is stable", () => {
    const result = runCampaign("consentLedger", (ctx) => {
      const { rng } = ctx;
      const count = rng.pick([0, 1, 2, 3, 6, 12, 40]);
      const useSeq = rng.bool(0.7);
      const records: ConsentRecord[] = [];
      let category: Parameters<typeof ctx.held>[1] = "fixture";
      const seqs = rng.shuffle(
        Array.from({ length: count }, (_v, i) =>
          rng.bool(0.1) ? Number.MAX_SAFE_INTEGER - i : i + 1,
        ),
      );
      for (let i = 0; i < count; i += 1) {
        const record = makeConsentRecord(rng, useSeq ? seqs[i] : undefined);
        if (rng.bool(0.3)) {
          // Hostile STRING content in string slots (what a corrupted or
          // adversarial ledger row could carry); structure stays intact.
          const field = rng.pick([
            "id",
            "consentVersion",
            "device",
            "strokeIntent",
            "subjectPseudonym",
          ] as const);
          const hostile = hostileString(rng);
          category = hostile.category;
          records.push({ ...record, [field]: hostile.value });
        } else if (rng.bool(0.1)) {
          records.push(pollute(rng, record).value);
          category = "proto_pollution";
        } else {
          records.push(record);
        }
      }
      const input = `${records.length} records (seq=${String(useSeq)}): ${describeValue(records.slice(0, 2))}`;
      const status = ctx.noThrow(
        "derive-no-throw",
        input,
        () => deriveConsentStatus(records),
        category,
      );
      if (status === undefined) return;
      if (
        status.length !== CONSENT_SCOPES.length ||
        CONSENT_SCOPES.some((scope) => !status.some((s) => s.scope === scope))
      ) {
        ctx.broken("total-over-scopes", describeValue(status.map((s) => s.scope)), input, category);
        return;
      }
      if (status.some((s) => s.active && s.lastAction !== "granted")) {
        ctx.broken("active-implies-granted", describeValue(status), input, category);
        return;
      }
      if (records.length === 0 && status.some((s) => s.active)) {
        ctx.broken("default-deny", "active with no records", input, category);
        return;
      }
      // Order independence is a documented contract when ordering is decidable
      // (unique seq on every record, or distinct timestamps without seq).
      const decidable = useSeq
        ? new Set(records.map((r) => r.seq)).size === records.length
        : new Set(records.map((r) => r.recordedAtIso)).size === records.length;
      if (decidable) {
        const shuffled = deriveConsentStatus(rng.shuffle(records));
        if (stableJson(shuffled) !== stableJson(status)) {
          ctx.broken(
            "order-independent",
            `original=${describeValue(status)} shuffled=${describeValue(shuffled)}`,
            describeValue(records),
            category,
          );
          return;
        }
      }
      const eligible = ctx.noThrow(
        "eligibility-no-throw",
        input,
        () => isFeedbackReviewEligible(records),
        category,
      );
      if (eligible === undefined) return;
      const modelTraining = status.find((s) => s.scope === "model_training");
      if (eligible !== (modelTraining?.active ?? false)) {
        ctx.broken(
          "eligibility-matches-ledger",
          `eligible=${String(eligible)} active=${String(modelTraining?.active)}`,
          input,
          category,
        );
        return;
      }
      const json = ctx.noThrow(
        "canonical-json-no-throw",
        input,
        () => canonicalConsentRecordsJson(records),
        category,
      );
      if (json === undefined) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(json) as unknown;
      } catch (error) {
        ctx.broken("canonical-json-valid", String(error), input, category);
        return;
      }
      if (!Array.isArray(parsed) || parsed.length !== records.length) {
        ctx.broken(
          "canonical-json-complete",
          `serialized ${Array.isArray(parsed) ? parsed.length : "non-array"} of ${records.length}`,
          input,
          category,
        );
        return;
      }
      if (canonicalConsentRecordsJson(records) !== json) {
        ctx.broken("canonical-json-deterministic", "two calls differ", input, category);
        return;
      }
      if (!globalPrototypeClean()) {
        ctx.broken("no-global-pollution", "Object.prototype polluted", input, "proto_pollution");
        return;
      }
      ctx.held("ledger-bounded", category);
    });
    expectClean(result);
  });
});

describe("prototype-pollution text payloads never reach Object.prototype", () => {
  it('parsing {"__proto__":…} text and validating it leaves the global prototype clean', () => {
    const result = runCampaign("protoPollutionText", (ctx) => {
      const text = pollutedJsonText(ctx.rng, JSON.stringify(makeTrialFixture()));
      const input = describeValue(text);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch (error) {
        ctx.broken("generator-produces-valid-json", String(error), input, "proto_pollution");
        return;
      }
      const verdict = ctx.noThrow(
        "no-throw",
        input,
        () => validateEvaluationTrial(parsed),
        "proto_pollution",
      );
      if (verdict === undefined) return;
      const wrong = wrongTypeValue(ctx.rng);
      ctx.noThrow(
        "no-throw-wrong-type",
        describeValue(wrong.value),
        () => validateEvaluationTrial(wrong.value),
        wrong.category,
      );
      if (!globalPrototypeClean()) {
        ctx.broken("no-global-pollution", "Object.prototype polluted", input, "proto_pollution");
        return;
      }
      ctx.held("no-global-pollution", "proto_pollution");
    });
    expectClean(result);
  });
});

/**
 * Minimized reproductions of the findings the campaigns above surfaced. Each
 * case asserts the CORRECT contract and is marked `it.fails`: it passes while
 * the defect exists and turns red the moment the production code is fixed —
 * at which point delete the case and drop the check from the campaign's
 * `knownBroken` list. Seeds that first hit each one are in the stress report.
 */
describe("reproduced findings (expected failures until fixed)", () => {
  it.fails(
    "consent.ts: parseConsentVersionMajor keeps majors above 2^53 distinct (seed 2107917436)",
    () => {
      // Both strings fit ConsentGrantRequest.consentVersion (max 64 chars);
      // Number() maps them to the same double so the downgrade guard accepts.
      const granted = "model-training-v9007199254740993";
      const requested = "model-training-v9007199254740992";
      const check = checkConsentVersionAcceptable("model_training", requested, granted);
      expect(check.ok).toBe(false);
      expect(check.rejection).toBe("downgrade");
    },
  );

  it.fails("consent.ts: parseConsentVersionMajor never returns Infinity (seed 3785578598)", () => {
    const major = parseConsentVersionMajor("model_training", `model-training-v1${"0".repeat(309)}`);
    expect(major === null || Number.isFinite(major)).toBe(true);
  });

  it.fails(
    "techniqueIntent.ts: NFC and NFD spellings of one transcript route identically (seed 463339209)",
    () => {
      const nfc = "forehand serv\u00e9";
      const nfd = "forehand serve\u0301";
      expect(nfd.normalize("NFC")).toBe(nfc);
      expect(resolveTechniqueIntent(nfd).status).toBe(resolveTechniqueIntent(nfc).status);
    },
  );

  it.fails(
    "playerRank.ts: computePlayerRank rejects a non-string capturedAt instead of throwing (seed 3685967043)",
    () => {
      const rows = [
        {
          shotType: "serve",
          overallScore: 5,
          resultKind: "scored",
          capturedAt: Object.create(null) as string,
        },
      ] satisfies PlayerRankAnalysisInput[];
      expect(() => computePlayerRank(rows)).not.toThrow();
    },
  );

  it.fails(
    "playerRank.ts: computePlayerRank never echoes a non-finite capturedAt (seed 4052327751)",
    () => {
      const rows = [
        {
          shotType: "serve",
          overallScore: 5,
          resultKind: "scored",
          capturedAt: Number.NEGATIVE_INFINITY as unknown as string,
        },
      ] satisfies PlayerRankAnalysisInput[];
      expect(findNonFiniteOrNegativeZero(computePlayerRank(rows))).toBeNull();
    },
  );

  it.fails(
    "playerRank.ts: computePlayerRank is order-independent for id-less rows sharing a capture instant (seed 1755069022)",
    () => {
      const at = "2026-08-01T10:00:00.000Z";
      const low = {
        shotType: "serve",
        overallScore: 1,
        resultKind: "scored",
        capturedAt: at,
      } satisfies PlayerRankAnalysisInput;
      const high = {
        shotType: "serve",
        overallScore: 9,
        resultKind: "scored",
        capturedAt: at,
      } satisfies PlayerRankAnalysisInput;
      expect(computePlayerRank([low, high])?.rating).toBe(computePlayerRank([high, low])?.rating);
    },
  );

  it.fails(
    "mediaRetention.ts: isRetentionExpired rejects an unknown asset kind instead of throwing (seed 1991770426)",
    () => {
      const now = new Date("2026-01-01T00:00:00.000Z");
      expect(() =>
        isRetentionExpired(
          {
            kind: "../raw_video" as MediaAssetKind,
            createdAt: now,
            expiresAt: null,
            userRetentionDays: 30,
          },
          MEDIA_RETENTION_POLICY_V1,
          now,
        ),
      ).not.toThrow();
    },
  );
});
