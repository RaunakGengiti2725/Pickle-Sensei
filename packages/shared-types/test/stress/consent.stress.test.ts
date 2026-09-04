import { describe, it } from "vitest";
import {
  CONSENT_CAPTURE_MODES,
  CONSENT_SCOPES,
  CONSENT_SOURCES,
  CONSENT_VERSION_PREFIX,
  canonicalConsentRecordsJson,
  checkConsentVersionAcceptable,
  deriveConsentStatus,
  isEvaluationTelemetryConsentActive,
  isFeedbackReviewEligible,
  isModelTrainingConsentActive,
  parseConsentVersionMajor,
  type ConsentAction,
  type ConsentRecord,
  type ConsentScope,
} from "../../src/index.js";
import {
  bump,
  check,
  checkEqual,
  expectCampaignHeld,
  makeRng,
  runStressCampaign,
  type Rng,
  type StressCampaign,
  stressTestTimeoutMs,
} from "./harness.js";

/**
 * Seeded stress of the consent ledger fold (consent.ts):
 *  - absence of records is NEVER consent (default deny);
 *  - status is the ledger-sequence-latest action per scope, independent of
 *    the array order handed in;
 *  - the version gate accepts only scope-canonical versions and never a
 *    downgrade below the granted contract;
 *  - the export canonicalization is a pure function of the records.
 *
 * Legal domain: every record carries a unique seq (DB identity); timestamps
 * are non-decreasing and may tie at millisecond precision. The legacy
 * (seq-less) domain gets strictly increasing timestamps because that is the
 * only order the contract defines for it.
 */

type Mode = "seq" | "legacy";

type Action =
  | {
      kind: "grant";
      scope: ConsentScope;
      major: number;
      tsStep: number;
      sourceIx: number;
      modeIx: number;
    }
  | { kind: "withdraw"; scope: ConsentScope; tsStep: number; sourceIx: number }
  | { kind: "shuffle"; permutationSeed: number }
  | { kind: "version_check"; scope: ConsentScope; requested: string };

interface ScopeModel {
  lastAction: ConsentAction | null;
  version: string | null;
  at: string | null;
  latestGrantedVersion: string | null;
}

interface Model {
  mode: Mode;
  records: ConsentRecord[];
  nextSeq: number;
  lastMs: number;
  scopes: Record<ConsentScope, ScopeModel>;
}

const BASE_MS = Date.parse("2026-08-29T00:00:00.000Z");

function uuidFrom(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function versionFor(scope: ConsentScope, major: number): string {
  return `${CONSENT_VERSION_PREFIX[scope]}-v${major}`;
}

const MALFORMED_VERSIONS = [
  "",
  "  ",
  "v1",
  "model-training",
  "model-training-v",
  "model-training-v01",
  "totally-made-up-v9",
  "video-analysis-v1 ",
  "MODEL-TRAINING-V1",
  "model-training-v-1",
  "model-training-v1.0",
];

function genAction(rng: Rng): Action {
  const roll = rng.next();
  const scope = rng.pick(CONSENT_SCOPES);
  if (roll < 0.4) {
    return {
      kind: "grant",
      scope,
      major: rng.int(1, 4),
      tsStep: rng.chance(0.3) ? 0 : rng.int(1, 5000),
      sourceIx: rng.int(0, CONSENT_SOURCES.length - 1),
      modeIx: rng.int(0, CONSENT_CAPTURE_MODES.length - 1),
    };
  }
  if (roll < 0.7) {
    return {
      kind: "withdraw",
      scope,
      tsStep: rng.chance(0.3) ? 0 : rng.int(1, 5000),
      sourceIx: rng.int(0, CONSENT_SOURCES.length - 1),
    };
  }
  if (roll < 0.85) return { kind: "shuffle", permutationSeed: rng.int(0, 0xffffffff) };
  const requested = rng.chance(0.3)
    ? rng.pick(MALFORMED_VERSIONS)
    : rng.chance(0.15)
      ? versionFor(rng.pick(CONSENT_SCOPES.filter((s) => s !== scope)), rng.int(1, 3))
      : versionFor(scope, rng.int(0, 5));
  return { kind: "version_check", scope, requested };
}

function newScopeModel(): ScopeModel {
  return { lastAction: null, version: null, at: null, latestGrantedVersion: null };
}

function makeCampaign(mode: Mode): StressCampaign<Action, Model> {
  const stats: Record<string, number> = {};
  return {
    name: `consent-ledger-${mode}`,
    stats,
    init: () => ({
      mode,
      records: [],
      nextSeq: 1,
      lastMs: BASE_MS,
      scopes: {
        video_analysis: newScopeModel(),
        model_training: newScopeModel(),
        evaluation_telemetry: newScopeModel(),
      },
    }),
    genAction: (rng) => genAction(rng),
    step(model, action) {
      if (action.kind === "grant" || action.kind === "withdraw") {
        // Legacy (seq-less) ledgers only define order through strictly
        // increasing timestamps; seq ledgers may tie at the millisecond.
        const advance = model.mode === "legacy" ? Math.max(1, action.tsStep) : action.tsStep;
        model.lastMs += advance;
        const recordedAtIso = new Date(model.lastMs).toISOString();
        const seq = model.nextSeq;
        model.nextSeq += 1;
        const version =
          action.kind === "grant"
            ? versionFor(action.scope, action.major)
            : (model.scopes[action.scope].version ?? versionFor(action.scope, 1));
        const record: ConsentRecord = {
          id: uuidFrom(seq),
          subjectPseudonym: uuidFrom(0xaa),
          scope: action.scope,
          action: action.kind === "grant" ? "granted" : "withdrawn",
          consentVersion: version,
          source: CONSENT_SOURCES[action.sourceIx]!,
          device: null,
          captureMode: action.kind === "grant" ? CONSENT_CAPTURE_MODES[action.modeIx]! : null,
          strokeIntent: null,
          recordedAtIso,
          ...(model.mode === "seq" ? { seq } : {}),
        };
        model.records.push(record);
        const scopeModel = model.scopes[action.scope];
        scopeModel.lastAction = record.action;
        scopeModel.version = version;
        scopeModel.at = recordedAtIso;
        if (record.action === "granted") scopeModel.latestGrantedVersion = version;
        bump(stats, action.kind);
      } else if (action.kind === "shuffle") {
        const order = makeRng(action.permutationSeed).permutation(model.records.length);
        model.records = order.map((i) => model.records[i]!);
        bump(stats, "shuffle");
      } else {
        const scopeModel = model.scopes[action.scope];
        const result = checkConsentVersionAcceptable(
          action.scope,
          action.requested,
          scopeModel.latestGrantedVersion,
        );
        const major = parseConsentVersionMajor(action.scope, action.requested);
        const previous =
          scopeModel.latestGrantedVersion === null
            ? null
            : parseConsentVersionMajor(action.scope, scopeModel.latestGrantedVersion);
        const expectedMajor =
          /^[a-z-]+-v(0|[1-9][0-9]*)$/.test(action.requested) &&
          action.requested.startsWith(`${CONSENT_VERSION_PREFIX[action.scope]}-v`)
            ? Number(action.requested.slice(action.requested.lastIndexOf("v") + 1))
            : null;
        checkEqual(major, expectedMajor, "version-parse-canonical-shape");
        if (major === null) {
          check(
            !result.ok && result.rejection === "malformed" && result.major === null,
            "version-malformed-rejected",
            () => JSON.stringify({ action, result }),
          );
        } else if (previous !== null && major < previous) {
          check(
            !result.ok && result.rejection === "downgrade" && result.major === major,
            "version-downgrade-rejected",
            () => JSON.stringify({ action, previous, result }),
          );
        } else {
          check(
            result.ok &&
              result.rejection === null &&
              result.message === null &&
              result.major === major,
            "version-upgrade-or-regrant-accepted",
            () => JSON.stringify({ action, previous, result }),
          );
        }
        bump(stats, `version_check_${result.ok ? "ok" : result.rejection}`);
        return `vc:${result.ok ? "ok" : result.rejection}`;
      }

      const status = deriveConsentStatus(model.records);
      checkEqual(
        status.map((s) => s.scope),
        [...CONSENT_SCOPES],
        "status-covers-every-scope-in-order",
      );
      for (const entry of status) {
        const expected = model.scopes[entry.scope];
        checkEqual(
          entry,
          {
            scope: entry.scope,
            active: expected.lastAction === "granted",
            consentVersion: expected.version,
            lastAction: expected.lastAction,
            lastActionAtIso: expected.at,
          },
          "status-is-ledger-latest-action",
        );
        if (expected.lastAction === null) {
          check(!entry.active, "default-deny-without-records", () => JSON.stringify(entry));
        }
      }
      const modelTraining = status.find((s) => s.scope === "model_training")!.active;
      checkEqual(
        isModelTrainingConsentActive(model.records),
        modelTraining,
        "model-training-helper-matches-fold",
      );
      checkEqual(
        isFeedbackReviewEligible(model.records),
        modelTraining,
        "feedback-review-eligibility-is-model-training-consent",
      );
      checkEqual(
        isEvaluationTelemetryConsentActive(model.records),
        status.find((s) => s.scope === "evaluation_telemetry")!.active,
        "telemetry-helper-matches-fold",
      );

      // Array order is not ledger order: any permutation folds identically.
      const reversed = [...model.records].reverse();
      checkEqual(deriveConsentStatus(reversed), status, "fold-is-array-order-independent");
      checkEqual(deriveConsentStatus(model.records), status, "fold-is-deterministic");

      const canonical = canonicalConsentRecordsJson(model.records);
      check(
        canonical === canonicalConsentRecordsJson(model.records),
        "canonical-json-deterministic",
        () => canonical,
      );
      const parsed = JSON.parse(canonical) as Array<Record<string, unknown>>;
      check(
        parsed.length === model.records.length,
        "canonical-json-preserves-count",
        () => `${parsed.length} vs ${model.records.length}`,
      );
      parsed.forEach((row, i) => {
        const source = model.records[i]!;
        checkEqual(
          Object.keys(row),
          [
            "id",
            "subjectPseudonym",
            "scope",
            "action",
            "consentVersion",
            "source",
            "device",
            "captureMode",
            "strokeIntent",
            "recordedAtIso",
            "seq",
          ],
          "canonical-json-fixed-key-order",
        );
        checkEqual(row["seq"], source.seq ?? null, "canonical-json-seq-null-when-absent");
        checkEqual(row["id"], source.id, "canonical-json-keeps-record-identity");
      });

      const active = status.filter((s) => s.active).length;
      bump(stats, `active_scopes_${active}`);
      return `${action.kind}:${status.map((s) => (s.active ? "1" : "0")).join("")}`;
    },
  };
}

describe("consent ledger — seeded randomized long-run", () => {
  it(
    "holds every documented invariant on seq-ordered ledgers",
    async () => {
      expectCampaignHeld(await runStressCampaign(makeCampaign("seq")));
    },
    stressTestTimeoutMs(),
  );

  it(
    "holds every documented invariant on legacy timestamp-ordered ledgers",
    async () => {
      expectCampaignHeld(await runStressCampaign(makeCampaign("legacy")));
    },
    stressTestTimeoutMs(),
  );
});
