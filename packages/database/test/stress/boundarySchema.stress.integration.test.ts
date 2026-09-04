import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { runMigrations } from "../../src/migrate.js";
import { seed } from "../../src/seed.js";
import {
  CONTROL_STRINGS,
  KB64,
  MALFORMED_JSON_TEXT,
  MIGRATIONS_DIR,
  NUMERIC_EDGE_JS,
  NUMERIC_EDGE_TEXT,
  PATH_TRAVERSAL,
  PROTO_KEYS,
  Reporter,
  Rng,
  TEST_URL,
  UNICODE_PAIRS,
  campaignSeeds,
  classifyError,
  describeInput,
  formatAnomalies,
  graphemeBomb,
  hostileJsonValue,
  hostileString,
  iterations,
  schemaPool,
  trimMessage,
  type Outcome,
} from "./harness.js";

/**
 * LENS boundary-malformed / campaign "schema": the migrated schema is the
 * legacy stack's last line of defence, so every generated row is a
 * parameterised INSERT (exactly what services/api does) with 1–3 columns
 * replaced by hostile values — wrong types, NaN/±Infinity/-0, overflow,
 * null bytes, 64 KiB+ strings and grapheme bombs, path traversal in
 * ids/slugs, malformed/truncated JSON, prototype-pollution keys, future
 * schema versions, empty arrays/objects, unicode normalisation pairs,
 * malformed uuids/timestamps — plus shape attacks (unknown column, missing
 * required column, duplicate column, parameter-count mismatch).
 *
 * Invariants per iteration:
 *   - the statement either commits a row or fails with a typed SQLSTATE
 *     (never an internal/connection-class error, never a JS throw);
 *   - a rejected INSERT leaves the table's row count unchanged;
 *   - an accepted row never stores a non-finite number;
 *   - reading back a jsonb payload with `__proto__` keys does not pollute
 *     `Object.prototype`;
 *   - the pool stays healthy and `seed()` is still idempotent afterwards.
 *
 * Default 300 rows; STRESS_ITER scales it (x1).
 */

type Kind =
  | "text"
  | "enum"
  | "int"
  | "smallint"
  | "bigint"
  | "numeric"
  | "float"
  | "bool"
  | "uuid"
  | "fk"
  | "jsonb"
  | "timestamptz";

interface Column {
  name: string;
  kind: Kind;
  valid: (rng: Rng, fx: Fixtures) => unknown;
  /** Allowed values for `enum` columns (used to build near-miss variants). */
  allowed?: readonly string[];
}

interface TableSpec {
  table: string;
  columns: Column[];
  /** Derive columns that depend on sibling values (before hostile mutation). */
  finalize?: (values: Record<string, unknown>) => void;
}

interface Fixtures {
  userId: string;
  shotTypeId: string;
  scoringModelId: string;
  scoringModelVersion: string;
  checkpointId: string;
  sessionId: string;
  mediaAssetId: string;
  analysisJobId: string;
  analysisJobIds: string[];
  shotId: string;
  hardCaseId: string;
  modelBundleId: string;
}

const enumCol = (name: string, allowed: readonly string[]): Column => ({
  name,
  kind: "enum",
  allowed,
  valid: (rng) => rng.pick(allowed),
});
const text = (name: string, valid: (rng: Rng) => string): Column => ({ name, kind: "text", valid });
const fk = (name: string, pick: (fx: Fixtures) => string): Column => ({
  name,
  kind: "fk",
  valid: (_rng, fx) => pick(fx),
});
const uuidCol = (name: string): Column => ({ name, kind: "uuid", valid: (rng) => rng.uuid() });
const json = (name: string, valid: (rng: Rng) => unknown): Column => ({
  name,
  kind: "jsonb",
  valid,
});
const num = (name: string, kind: Kind, valid: (rng: Rng) => number): Column => ({
  name,
  kind,
  valid,
});
const ts = (name: string): Column => ({
  name,
  kind: "timestamptz",
  valid: (rng) =>
    new Date(Date.UTC(2026, rng.int(0, 11), rng.int(1, 28), rng.int(0, 23))).toISOString(),
});

const TABLES: TableSpec[] = [
  {
    table: "app_user",
    columns: [
      text("auth_subject", (rng) => `apple:${rng.hex(24)}`),
      text("email", (rng) => `u${rng.hex(8)}@example.test`),
      enumCol("status", ["active", "suspended", "deleted"]),
      text("locale", () => "en-US"),
      text("timezone", () => "America/Los_Angeles"),
    ],
  },
  {
    table: "user_profile",
    columns: [
      { name: "user_id", kind: "fk", valid: (rng) => rng.uuid() },
      text("display_name", (rng) => `Player ${rng.hex(4)}`),
      enumCol("handedness", ["right", "left", "ambidextrous"]),
      enumCol("age_band", ["13-15", "16-17", "18-24", "25-34", "35-44", "45-54", "55-64", "65+"]),
      { name: "profile_public", kind: "bool", valid: (rng) => rng.chance(0.5) },
      text("handle", (rng) => `handle_${rng.hex(10)}`),
    ],
  },
  {
    table: "shot_type",
    columns: [
      text("slug", (rng) => `slug_${rng.hex(8)}`),
      text("name", (rng) => `Shot ${rng.hex(4)}`),
      text("description", () => "generated"),
      num("display_order", "smallint", (rng) => rng.int(100, 30000)),
      { name: "enabled", kind: "bool", valid: () => true },
    ],
  },
  {
    table: "checkpoint_definition",
    columns: [
      text("slug", (rng) => `cp_${rng.hex(8)}`),
      text("name", (rng) => `Checkpoint ${rng.hex(4)}`),
      text("description", () => "generated"),
      text("default_explanation_key", (rng) => `expl.${rng.hex(4)}`),
      num("display_order", "smallint", (rng) => rng.int(100, 30000)),
    ],
  },
  {
    table: "feature_flag",
    columns: [
      text("key", (rng) => `flag_${rng.hex(8)}`),
      text("description", () => "generated"),
      { name: "enabled", kind: "bool", valid: (rng) => rng.chance(0.5) },
      num("rollout_percent", "smallint", (rng) => rng.int(0, 100)),
      json("conditions", () => ({})),
    ],
  },
  {
    table: "billing_offering",
    columns: [
      text("product_key", (rng) => `prod_${rng.hex(8)}`),
      json("platform_product_ids", (rng) => ({ ios: `pickle_${rng.hex(4)}` })),
      text("display_name", () => "Pro"),
      text("description", () => "generated"),
      num("price_usd_cents", "int", (rng) => rng.int(99, 99999)),
      enumCol("period", ["monthly", "annual", "lifetime"]),
      num("trial_days", "int", (rng) => rng.int(0, 30)),
      json("features", () => []),
      { name: "active", kind: "bool", valid: () => true },
      num("display_order", "smallint", (rng) => rng.int(100, 30000)),
    ],
  },
  {
    table: "achievement",
    columns: [
      text("slug", (rng) => `ach_${rng.hex(8)}`),
      text("name", (rng) => `Achievement ${rng.hex(4)}`),
      text("description", () => "generated"),
      num("points", "int", (rng) => rng.int(0, 1000)),
      { name: "active", kind: "bool", valid: () => true },
    ],
  },
  {
    table: "model_bundle",
    columns: [
      text("version", (rng) => `${rng.int(1, 9)}.${rng.int(0, 99)}.${rng.hex(4)}`),
      text("manifest_sha256", (rng) => rng.hex(64)),
      text("ios_min_app_version", () => "1.0.0"),
      enumCol("status", ["draft", "canary", "active", "retired"]),
      num("rollout_percent", "smallint", (rng) => rng.int(0, 100)),
      json("metadata", () => ({})),
    ],
  },
  {
    table: "scoring_model",
    columns: [
      fk("shot_type_id", (fx) => fx.shotTypeId),
      text("version", (rng) => `stress-${rng.hex(8)}`),
      enumCol("status", ["draft", "validating", "active", "retired"]),
      num("min_analysis_confidence", "numeric", (rng) => rng.int(0, 9999) / 10000),
      num("lower_confidence_threshold", "numeric", (rng) => rng.int(0, 9999) / 10000),
      json("config", () => ({ weights: {} })),
      text("dataset_snapshot_id", (rng) => `ds_${rng.hex(6)}`),
      text("evaluation_report_sha256", (rng) => rng.hex(64)),
    ],
  },
  {
    table: "scoring_target",
    columns: [
      fk("scoring_model_id", (fx) => fx.scoringModelId),
      fk("checkpoint_definition_id", (fx) => fx.checkpointId),
      text("metric_key", (rng) => `metric_${rng.hex(6)}`),
      enumCol("target_kind", ["interval", "gaussian", "categorical", "monotonic", "custom"]),
      num("lower_bound", "float", (rng) => rng.int(-1000, 1000) / 10),
      num("upper_bound", "float", (rng) => rng.int(1000, 2000) / 10),
      num("sigma", "float", (rng) => rng.int(1, 100) / 10),
      num("metric_weight", "numeric", (rng) => rng.int(0, 999) / 1000),
      json("params", () => ({})),
    ],
  },
  {
    table: "media_asset",
    columns: [
      fk("owner_user_id", (fx) => fx.userId),
      enumCol("kind", ["raw_video", "normalized_video", "thumbnail", "share_video", "features"]),
      text("storage_provider", () => "s3"),
      text("bucket", () => "pickle-media"),
      text("object_key", (rng) => `users/${rng.hex(8)}/clip.mov`),
      text("content_type", () => "video/quicktime"),
      num("size_bytes", "bigint", (rng) => rng.int(1, 2 ** 31)),
      num("width", "int", () => 1080),
      num("height", "int", () => 1920),
      num("fps", "numeric", (rng) => rng.pick([24, 29.97, 30, 59.94, 60])),
      num("duration_ms", "int", (rng) => rng.int(500, 60000)),
      text("sha256", (rng) => rng.hex(64)),
      enumCol("status", ["pending", "uploading", "ready", "processing", "failed", "deleted"]),
    ],
  },
  {
    table: "practice_session",
    columns: [
      uuidCol("id"),
      fk("user_id", (fx) => fx.userId),
      enumCol("mode", ["live", "guided_drill", "single", "import"]),
      fk("selected_shot_type_id", (fx) => fx.shotTypeId),
      fk("scoring_model_id", (fx) => fx.scoringModelId),
      enumCol("camera_view", ["side", "rear_oblique"]),
      ts("started_at"),
      num("avg_score", "numeric", (rng) => rng.int(0, 1000) / 100),
      num("shot_count", "int", (rng) => rng.int(0, 500)),
      { name: "completed", kind: "bool", valid: () => false },
    ],
  },
  {
    table: "analysis_job",
    columns: [
      fk("user_id", (fx) => fx.userId),
      fk("media_asset_id", (fx) => fx.mediaAssetId),
      fk("session_id", (fx) => fx.sessionId),
      fk("expected_shot_type_id", (fx) => fx.shotTypeId),
      enumCol("inference_mode", ["on_device", "cloud_deep"]),
      enumCol("status", ["queued", "processing", "complete", "failed", "cancelled"]),
      json("metadata", () => ({})),
    ],
  },
  {
    table: "analysis_permit",
    columns: [
      fk("user_id", (fx) => fx.userId),
      uuidCol("idempotency_key"),
      enumCol("access_source", ["free", "premium"]),
      enumCol("status", ["reserved", "consumed", "released", "expired"]),
      { name: "reserved_at", kind: "timestamptz", valid: () => "2026-01-01T00:00:00Z" },
      { name: "expires_at", kind: "timestamptz", valid: () => "2026-01-01T00:10:00Z" },
    ],
  },
  {
    table: "shot",
    columns: [
      uuidCol("id"),
      fk("user_id", (fx) => fx.userId),
      fk("session_id", (fx) => fx.sessionId),
      fk("shot_type_id", (fx) => fx.shotTypeId),
      fk("scoring_model_id", (fx) => fx.scoringModelId),
      enumCol("camera_view", ["side", "rear_oblique"]),
      ts("captured_at"),
      num("start_ms", "int", (rng) => rng.int(0, 1000)),
      num("contact_ms", "int", (rng) => rng.int(1000, 2000)),
      num("end_ms", "int", (rng) => rng.int(2000, 3000)),
      num("overall_score", "numeric", (rng) => rng.int(0, 1000) / 100),
      num("confidence", "numeric", (rng) => rng.int(0, 9999) / 10000),
      {
        name: "result_kind",
        kind: "enum",
        allowed: ["scored", "low_confidence"],
        valid: () => "scored",
      },
      enumCol("source", ["real", "fixture"]),
      { name: "favorite", kind: "bool", valid: () => false },
      text("model_bundle_version", () => "1.0.0"),
      {
        name: "version_vector",
        kind: "jsonb",
        valid: (_rng, fx) => ({ scoringModelVersion: fx.scoringModelVersion, schemaVersion: 1 }),
      },
      text("sync_payload_sha256", (rng) => rng.hex(64)),
    ],
  },
  {
    table: "analysis_run",
    columns: [
      fk("user_id", (fx) => fx.userId),
      fk("shot_id", (fx) => fx.shotId),
      fk("scoring_model_id", (fx) => fx.scoringModelId),
      { name: "scoring_model_version", kind: "text", valid: (_rng, fx) => fx.scoringModelVersion },
      num("overall_score", "numeric", (rng) => rng.int(0, 1000) / 100),
      {
        name: "result_kind",
        kind: "enum",
        allowed: ["scored", "low_confidence"],
        valid: () => "scored",
      },
      ts("produced_at"),
    ],
  },
  {
    table: "analysis_issue_report",
    columns: [
      fk("user_id", (fx) => fx.userId),
      { name: "analysis_job_id", kind: "fk", valid: (rng, fx) => rng.pick(fx.analysisJobIds) },
      enumCol("failure_category", [
        "wrong_shot_type",
        "score_too_low",
        "score_too_high",
        "no_shot_detected",
      ]),
      text("comment", (rng) => `comment ${rng.hex(6)}`),
      text("app_version", () => "1.2.3"),
      enumCol("device_platform", ["ios"]),
      text("device_os_version", () => "iOS 18.1"),
      text("device_model", () => "iPhone16,1"),
      json("version_vector", () => ({ schemaVersion: 1 })),
      json("diagnostics", () => ({})),
      enumCol("triage_status", ["open", "in_review", "resolved", "dismissed"]),
      text("triage_note", (rng) => `note ${rng.hex(6)}`),
    ],
  },
  {
    table: "consent_record",
    columns: [
      num("seq", "bigint", (rng) => rng.int(1_000_000, 2 ** 40)),
      uuidCol("subject_pseudonym"),
      enumCol("scope", ["video_analysis", "model_training", "evaluation_telemetry"]),
      enumCol("action", ["granted", "withdrawn"]),
      text("consent_version", () => "2026-01"),
      enumCol("source", ["mobile_settings", "onboarding", "privacy_center", "support"]),
      text("device", () => "iPhone"),
      enumCol("capture_mode", ["automatic_pose_trigger", "imported_video", "all_captures"]),
      text("stroke_intent", () => "dink"),
      ts("recorded_at"),
    ],
  },
  {
    table: "hard_case",
    columns: [
      text("fingerprint", (rng) => `fp_${rng.hex(12)}`),
      enumCol("source", [
        "user_feedback",
        "shadow_disagreement",
        "model_disagreement",
        "high_uncertainty",
      ]),
      enumCol("category", ["TARGET", "EVENT", "PADDLE", "BALL", "CONTACT", "PHASE", "STROKE"]),
      text("subject_key", (rng) => `rec-${rng.hex(6)}`),
      enumCol("state", ["new", "triaged", "in-review", "resolved", "regression"]),
      enumCol("severity", ["low", "medium", "high", "critical"]),
      num("occurrence_count", "int", (rng) => rng.int(1, 50)),
      num("regression_count", "int", (rng) => rng.int(0, 5)),
    ],
  },
  {
    table: "hard_case_event",
    columns: [
      fk("hard_case_id", (fx) => fx.hardCaseId),
      enumCol("event_type", ["ingested", "merged", "regression_reopened", "transitioned"]),
      text("actor", () => "stress-harness"),
      text("source", () => "generated"),
      text("evidence_ref", (rng) => `s3://evidence/${rng.hex(6)}`),
      text("detail", (rng) => `detail ${rng.hex(4)}`),
    ],
  },
  {
    table: "coach_review",
    finalize: (v) => {
      v["review_id"] = `${String(v["queue_item_id"])}.${String(v["coach_id"])}`;
    },
    columns: [
      { name: "review_id", kind: "text", valid: () => "" },
      text("queue_item_id", (rng) => `q_${rng.hex(8)}`),
      text("coach_id", (rng) => `coach_${rng.hex(6)}`),
      text("coach_credential_ref", (rng) => `cred:${rng.hex(6)}`),
      num("schema_version", "int", (rng) => rng.int(3, 9)),
      text("stroke_taxonomy_version", () => "1.0"),
      text("fault_taxonomy_version", () => "1.0"),
      text("drill_library_version", () => "1.0"),
      json("record", () => ({ verdict: "ok" })),
      json("qualification_snapshot", () => ({ level: 3 })),
    ],
  },
  {
    table: "evaluation_trial",
    columns: [
      uuidCol("trial_id"),
      uuidCol("subject_pseudonym"),
      text("schema_version", () => "1"),
      text("consent_version", () => "2026-01"),
      ts("captured_at"),
      json("record", () => ({ trial: true })),
    ],
  },
  {
    table: "model_rollout",
    columns: [
      uuidCol("rollout_id"),
      text("model_id", (rng) => `model_${rng.hex(4)}`),
      text("candidate_version", () => "2.0.0"),
      text("known_good_version", () => "1.0.0"),
      text("active_version", () => "1.0.0"),
      { name: "stage_percent", kind: "int", valid: (rng) => rng.pick([0, 1, 5, 20, 50, 100]) },
      enumCol("status", ["in_progress", "paused"]),
      text("criteria_id", (rng) => `crit_${rng.hex(4)}`),
      text("criteria_sha256", (rng) => rng.hex(64)),
    ],
  },
  {
    table: "deletion_task",
    columns: [
      fk("user_id", (fx) => fx.userId),
      enumCol("kind", [
        "media_purge",
        "ml_dataset_review",
        "idp_revoke",
        "social_cleanup",
        "final_hard_delete",
      ]),
      enumCol("status", ["queued", "processing", "done", "failed"]),
      json("detail", () => ({})),
      num("attempts", "int", (rng) => rng.int(0, 5)),
    ],
  },
  {
    table: "idempotency_record",
    columns: [
      fk("user_id", (fx) => fx.userId),
      text("idempotency_key", (rng) => `idem_${rng.hex(12)}`),
      num("response_code", "int", (rng) => rng.pick([200, 201, 400, 409])),
      json("response_body", () => ({ ok: true })),
    ],
  },
  {
    table: "audit_log",
    columns: [
      fk("actor_user_id", (fx) => fx.userId),
      text("actor_service", () => "api"),
      text("action", (rng) => `action.${rng.hex(4)}`),
      text("target_kind", () => "shot"),
      text("target_id", (rng) => rng.uuid()),
      text("ip_hash", (rng) => rng.hex(64)),
      text("request_id", (rng) => rng.uuid()),
      json("metadata", () => ({})),
    ],
  },
];

// ---------------------------------------------------------------------------
// Hostile values per column kind
// ---------------------------------------------------------------------------

const HOSTILE_TIMESTAMPS: readonly string[] = [
  "2026-13-45T00:00:00Z",
  "0000-00-00 00:00:00",
  "2026-02-30T00:00:00Z",
  "infinity",
  "-infinity",
  "epoch",
  "now",
  "today",
  "294277-01-01T00:00:00Z",
  "4714-11-24 00:00:00 BC",
  "1e10",
  "2026-01-01T25:61:61Z",
  "2026-01-01T00:00:00+25:00",
  "2026-01-01T00:00:00\u0000",
  "2026-01-01",
  "01/02/2026",
  "yesterday",
  "\u0661\u0662\u0663",
  "",
  " ",
];

const HOSTILE_UUIDS: readonly string[] = [
  "not-a-uuid",
  "00000000-0000-0000-0000-00000000000",
  "00000000-0000-0000-0000-0000000000000",
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffffffff-ffff-ffff-ffffffffffff",
  "{12345678-1234-1234-1234-123456789abc}",
  "12345678123412341234123456789abc",
  "12345678-1234-1234-1234-123456789ABC",
  "12345678-1234-1234-1234-123456789abc\u0000",
  " 12345678-1234-1234-1234-123456789abc",
  "gggggggg-gggg-gggg-gggg-gggggggggggg",
  "١٢٣٤٥٦٧٨-1234-1234-1234-123456789abc",
];

function wrongTypeValue(rng: Rng): unknown {
  const variants: Array<() => unknown> = [
    () => rng.pick(NUMERIC_EDGE_JS),
    () => rng.pick([true, false]),
    () => ({}),
    () => [],
    () => [rng.pick(CONTROL_STRINGS)],
    () => [[1, 2], [3]],
    () => ({ [rng.pick(PROTO_KEYS)]: 1 }),
    () => new Date(Number.NaN),
    () => new Date(8.64e15),
    () => new Date(-8.64e15),
    () => Buffer.from([0x00, 0xff, 0xfe]),
    () => Buffer.alloc(0),
    () => Buffer.alloc(KB64 + 1, 0x41),
    () => Symbol("hostile"),
    () => BigInt("9223372036854775808"),
    () => BigInt(-1),
    () => (): void => undefined,
    () => ({ toPostgres: () => rng.pick(CONTROL_STRINGS) }),
    () => ({ toPostgres: () => ({ nested: true }) }),
    () => {
      const circular: Record<string, unknown> = {};
      circular["self"] = circular;
      return circular;
    },
  ];
  return rng.pick(variants)();
}

function hostileFor(rng: Rng, column: Column): { value: unknown; label: string } {
  if (rng.chance(0.08)) return { value: null, label: "null" };
  if (rng.chance(0.08)) return { value: undefined, label: "undefined" };
  if (rng.chance(0.12)) return { value: wrongTypeValue(rng), label: "wrong-type" };
  switch (column.kind) {
    case "text": {
      const s = hostileString(rng);
      return { value: s, label: `text:${s.length}` };
    }
    case "enum": {
      const base = rng.pick(column.allowed ?? ["x"]);
      const variants: Array<() => string> = [
        () => base.toUpperCase(),
        () => `${base[0]?.toUpperCase() ?? ""}${base.slice(1)}`,
        () => ` ${base}`,
        () => `${base} `,
        () => `${base}\u0000`,
        () => `\u0000${base}`,
        () => base.normalize("NFD"),
        () => base.replace(/_/g, "-"),
        () => base.replace(/-/g, "_"),
        () => `${base}s`,
        () => base.slice(0, -1),
        () => base.replace(/e/g, "\u0435"),
        () => base.replace(/a/g, "\u0430"),
        () => `${base}\u200b`,
        () => rng.pick(PATH_TRAVERSAL),
        () => hostileString(rng),
      ];
      const v = rng.pick(variants)();
      return { value: v, label: "enum-near-miss" };
    }
    case "int":
    case "smallint":
    case "bigint":
    case "numeric":
    case "float": {
      if (rng.chance(0.5)) {
        const n = rng.pick(NUMERIC_EDGE_JS);
        return { value: n, label: `num:${describeInput(n)}` };
      }
      const s = rng.pick(NUMERIC_EDGE_TEXT);
      return { value: s, label: `numtext:${describeInput(s)}` };
    }
    case "bool": {
      const v = rng.pick([
        "yes",
        "no",
        "1",
        "0",
        2,
        -1,
        "TRUE ",
        "t",
        "f",
        "on",
        "off",
        "\u0000",
        "null",
        "",
        " ",
        "True",
      ]);
      return { value: v, label: `bool:${describeInput(v)}` };
    }
    case "uuid":
    case "fk": {
      const v = rng.chance(0.4)
        ? rng.uuid()
        : rng.chance(0.5)
          ? rng.pick(HOSTILE_UUIDS)
          : hostileString(rng);
      return {
        value: v,
        label: column.kind === "fk" ? "fk-dangling-or-malformed" : "uuid-malformed",
      };
    }
    case "jsonb": {
      if (rng.chance(0.45)) {
        const raw = rng.pick(MALFORMED_JSON_TEXT);
        return { value: raw, label: `json-raw:${describeInput(raw, 40)}` };
      }
      if (rng.chance(0.2)) {
        const n = rng.pick(NUMERIC_EDGE_JS);
        return { value: n, label: `json-number:${describeInput(n)}` };
      }
      const v = hostileJsonValue(rng);
      return { value: v, label: `json-shape:${describeInput(v, 40)}` };
    }
    case "timestamptz": {
      const v = rng.chance(0.6)
        ? rng.pick(HOSTILE_TIMESTAMPS)
        : rng.chance(0.5)
          ? rng.pick(NUMERIC_EDGE_JS)
          : hostileString(rng);
      return { value: v, label: `ts:${describeInput(v, 40)}` };
    }
  }
}

type Shape = "value" | "unknown-column" | "missing-required" | "duplicate-column" | "param-count";

interface Probe {
  table: string;
  shape: Shape;
  columns: string[];
  values: unknown[];
  sql: string;
  mutated: string[];
}

function buildProbe(rng: Rng, fx: Fixtures): Probe {
  const spec = rng.pick(TABLES);
  const columns = spec.columns.map((c) => c.name);
  const values = spec.columns.map((c) => c.valid(rng, fx));
  if (spec.finalize) {
    const record = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
    spec.finalize(record);
    columns.forEach((c, i) => {
      values[i] = record[c];
    });
  }
  const mutated: string[] = [];
  const roll = rng.next();
  const shape: Shape =
    roll < 0.04
      ? "unknown-column"
      : roll < 0.08
        ? "missing-required"
        : roll < 0.1
          ? "duplicate-column"
          : roll < 0.12
            ? "param-count"
            : "value";

  if (shape === "value" || shape === "param-count" || shape === "duplicate-column") {
    const n = rng.int(1, 3);
    for (const i of rng.shuffle(spec.columns.map((_, i) => i)).slice(0, n)) {
      const col = spec.columns[i] as Column;
      const { value, label } = hostileFor(rng, col);
      values[i] = value;
      mutated.push(`${col.name}=${label}`);
    }
  }
  if (shape === "unknown-column") {
    const name = rng.pick([
      "schema_version",
      "__proto__",
      "id; DROP TABLE shot; --",
      `"${rng.hex(4)}"`,
      "𝕔𝕠𝕝",
      "x".repeat(70),
    ]);
    columns.push(name.replace(/"/g, ""));
    values.push(hostileString(rng));
    mutated.push(`+${name}`);
  }
  if (shape === "missing-required") {
    const i = rng.int(0, columns.length - 1);
    mutated.push(`-${columns[i]}`);
    columns.splice(i, 1);
    values.splice(i, 1);
  }
  if (shape === "duplicate-column") {
    const i = rng.int(0, columns.length - 1);
    columns.push(columns[i] as string);
    values.push(values[i]);
    mutated.push(`dup:${columns[i]}`);
  }
  let params = columns.map((_, i) => `$${i + 1}`);
  if (shape === "param-count") {
    if (rng.chance(0.5)) values.pop();
    else values.push(hostileString(rng));
    mutated.push(`params:${values.length}/${columns.length}`);
  }
  const quoted = columns.map((c) => `"${c.replace(/"/g, '""')}"`);
  // jsonb parameters arrive as text; cast so string payloads are parsed
  // server-side (matching how the legacy API binds them).
  const byName = new Map(spec.columns.map((c) => [c.name, c]));
  params = params.map((p, i) =>
    byName.get(columns[i] as string)?.kind === "jsonb" ? `${p}::jsonb` : p,
  );
  const sql = `INSERT INTO ${spec.table} (${quoted.join(", ")}) VALUES (${params.join(", ")}) RETURNING *`;
  return { table: spec.table, shape, columns, values, sql, mutated };
}

const NUMERIC_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  "int",
  "smallint",
  "bigint",
  "numeric",
  "float",
]);

function nonFinite(row: Record<string, unknown>, columns: readonly Column[]): string[] {
  const bad: string[] = [];
  for (const c of columns) {
    if (!NUMERIC_KINDS.has(c.kind)) continue;
    const v = row[c.name];
    if (typeof v === "number" && !Number.isFinite(v)) bad.push(`${c.name}=${v}`);
    if (typeof v === "string" && /^(NaN|-?Infinity)$/.test(v)) bad.push(`${c.name}=${v}`);
  }
  return bad;
}

const SEED_OWNED_TABLES = [
  "shot_type",
  "checkpoint_definition",
  "scoring_model",
  "scoring_target",
  "billing_offering",
  "feature_flag",
  "achievement",
];

const SEED_KEYS: Record<string, string> = {
  shot_type: "slug",
  checkpoint_definition: "slug",
  scoring_model: "shot_type_id::text || '@' || version",
  scoring_target:
    "scoring_model_id::text || '@' || checkpoint_definition_id::text || '@' || metric_key",
  billing_offering: "product_key",
  feature_flag: "key",
  achievement: "slug",
};

/** Seed-owned catalog rows keyed by natural key (hostile rows added by the campaign are ignored). */
async function catalogSnapshot(pool: pg.Pool): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const table of SEED_OWNED_TABLES) {
    const { rows } = await pool.query<{ k: string; row: unknown }>(
      `SELECT ${SEED_KEYS[table]} AS k, to_jsonb(t) - 'created_at' - 'updated_at' AS row FROM ${table} t`,
    );
    for (const r of rows) out.set(`${table}:${r.k}`, JSON.stringify(r.row));
  }
  return out;
}

/** Columns with no CHECK constraint that could refuse NaN/±Infinity (see the `it.fails` case). */
const UNGUARDED_NUMERIC = new Set([
  "scoring_model.min_analysis_confidence",
  "scoring_model.lower_confidence_threshold",
  "scoring_target.lower_bound",
  "scoring_target.upper_bound",
  "scoring_target.sigma",
  "scoring_target.metric_weight",
  "media_asset.fps",
  "practice_session.avg_score",
  "shot.confidence",
]);

describe.skipIf(!TEST_URL)("stress/boundary-malformed: migrated schema vs hostile rows", () => {
  const SCHEMA = "stress_schema_boundary";
  const admin = new pg.Pool({ connectionString: TEST_URL, max: 2 });
  const pool = schemaPool(SCHEMA);
  const total = iterations(300, 1);
  const fx: Fixtures = {
    userId: "",
    shotTypeId: "",
    scoringModelId: "",
    scoringModelVersion: "",
    checkpointId: "",
    sessionId: "",
    mediaAssetId: "",
    analysisJobId: "",
    analysisJobIds: [],
    shotId: "",
    hardCaseId: "",
    modelBundleId: "",
  };
  let seededSnapshot = new Map<string, string>();

  beforeAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await runMigrations(pool, MIGRATIONS_DIR);
    await seed(pool);
    const one = async <T extends Record<string, string>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<T> => {
      const { rows } = await pool.query<T>(sql, params);
      const row = rows[0];
      if (!row) throw new Error(`fixture query returned no row: ${sql}`);
      return row;
    };
    fx.userId = (
      await one<{ id: string }>(
        "INSERT INTO app_user (auth_subject, email) VALUES ('stress:fixture', 'stress@example.test') RETURNING id",
      )
    ).id;
    fx.shotTypeId = (
      await one<{ id: string }>("SELECT id FROM shot_type ORDER BY display_order LIMIT 1")
    ).id;
    const model = await one<{ id: string; version: string }>(
      "SELECT id, version FROM scoring_model WHERE shot_type_id = $1 ORDER BY version LIMIT 1",
      [fx.shotTypeId],
    );
    fx.scoringModelId = model.id;
    fx.scoringModelVersion = model.version;
    fx.checkpointId = (
      await one<{ id: string }>(
        "SELECT id FROM checkpoint_definition ORDER BY display_order LIMIT 1",
      )
    ).id;
    fx.sessionId = (
      await one<{ id: string }>(
        "INSERT INTO practice_session (id, user_id, mode, started_at) VALUES (gen_random_uuid(), $1, 'single', now()) RETURNING id",
        [fx.userId],
      )
    ).id;
    fx.mediaAssetId = (
      await one<{ id: string }>(
        "INSERT INTO media_asset (owner_user_id, kind, storage_provider) VALUES ($1, 'raw_video', 's3') RETURNING id",
        [fx.userId],
      )
    ).id;
    const newJob = async (): Promise<string> =>
      (
        await one<{ id: string }>(
          "INSERT INTO analysis_job (user_id, inference_mode, status) VALUES ($1, 'on_device', 'complete') RETURNING id",
          [fx.userId],
        )
      ).id;
    fx.analysisJobId = await newJob();
    for (let i = 0; i < 64; i++) fx.analysisJobIds.push(await newJob());
    fx.shotId = (
      await one<{ id: string }>(
        `INSERT INTO shot (id, user_id, session_id, shot_type_id, scoring_model_id, captured_at, start_ms, end_ms,
           overall_score, confidence, result_kind, source, model_bundle_version, version_vector)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), 0, 1000, 7.5, 0.9, 'scored', 'real', '1.0.0',
           jsonb_build_object('scoringModelVersion', $5::text)) RETURNING id`,
        [fx.userId, fx.sessionId, fx.shotTypeId, fx.scoringModelId, fx.scoringModelVersion],
      )
    ).id;
    fx.hardCaseId = (
      await one<{ id: string }>(
        "INSERT INTO hard_case (fingerprint, source, category, subject_key, severity) VALUES ('fp-stress-fixture', 'user_feedback', 'OTHER', 'rec-stress', 'low') RETURNING id",
      )
    ).id;
    fx.modelBundleId = (
      await one<{ id: string }>(
        "INSERT INTO model_bundle (version) VALUES ('stress-fixture') RETURNING id",
      )
    ).id;
    seededSnapshot = await catalogSnapshot(pool);
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it(`rejects or safely stores ${total} hostile rows without escaping the boundary`, async () => {
    const reporter = new Reporter("schema-hostile-rows", {
      iterations: total,
      tables: TABLES.length,
    });
    const protoBefore = JSON.stringify(Object.getOwnPropertyNames(Object.prototype).sort());
    const nonFiniteStored: string[] = [];

    for (const [index, seed] of campaignSeeds("schema", total).entries()) {
      const rng = new Rng(seed);
      const probe = buildProbe(rng, fx);
      // Determinism: regenerating from the same seed yields the same probe.
      const replay = buildProbe(new Rng(seed), fx);
      const started = performance.now();
      const problems: string[] = [];
      if (
        replay.sql !== probe.sql ||
        describeInput(replay.values, 2000) !== describeInput(probe.values, 2000)
      ) {
        problems.push("nondeterministic-generator");
      }

      let outcome: Outcome = "ACCEPTED";
      let sqlstate: string | undefined;
      let message: string | undefined;
      let note: string | undefined;
      try {
        const before = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${probe.table}`,
        );
        let inserted: Record<string, unknown> | undefined;
        try {
          const result = await pool.query<Record<string, unknown>>(probe.sql, probe.values);
          inserted = result.rows[0];
        } catch (error) {
          const c = classifyError(error);
          outcome = c.outcome;
          sqlstate = c.sqlstate;
          message = c.message;
        }
        const after = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${probe.table}`,
        );
        const delta = Number(after.rows[0]?.n) - Number(before.rows[0]?.n);
        if (outcome === "ACCEPTED") {
          if (delta !== 1) problems.push(`accepted-but-rowcount-delta=${delta}`);
          if (inserted) {
            const bad = nonFinite(
              inserted,
              TABLES.find((t) => t.table === probe.table)?.columns ?? [],
            );
            if (bad.length) {
              for (const b of bad) nonFiniteStored.push(`${probe.table}.${b} seed=${seed}`);
              note = `non-finite-stored:${bad.join(",")}`;
            }
            for (const v of Object.values(inserted)) {
              if (typeof v === "string" && v.length >= KB64)
                note = `${note ? `${note};` : ""}oversize-text-stored:${v.length}`;
            }
          }
        } else if (delta !== 0) {
          problems.push(`rejected-but-rowcount-delta=${delta}`);
          outcome = "ANOMALY_WRITE";
        }
      } catch (error) {
        problems.push(`harness-threw:${trimMessage(String(error))}`);
      }
      if (problems.length && !outcome.startsWith("ANOMALY")) outcome = "ANOMALY_PROPERTY";
      reporter.add({
        seed,
        index,
        kind: `${probe.table}/${probe.shape}`,
        input: describeInput({ mutated: probe.mutated, values: probe.values }, 300),
        outcome,
        ...(sqlstate ? { sqlstate } : {}),
        ...(message ? { message } : {}),
        ...(problems.length || note
          ? { note: [...problems, ...(note ? [note] : [])].join(";") }
          : {}),
        durationMs: performance.now() - started,
      });
    }

    // Prototype pollution: read back every jsonb payload we stored.
    for (const table of [
      "feature_flag",
      "billing_offering",
      "shot",
      "audit_log",
      "evaluation_trial",
      "coach_review",
    ]) {
      const cols =
        TABLES.find((t) => t.table === table)?.columns.filter((c) => c.kind === "jsonb") ?? [];
      for (const c of cols) await pool.query(`SELECT "${c.name}" FROM ${table}`);
    }
    const protoAfter = JSON.stringify(Object.getOwnPropertyNames(Object.prototype).sort());
    const polluted = Object.prototype.hasOwnProperty.call(Object.prototype, "polluted");

    // Pool health + seed idempotence after the onslaught.
    const health = await pool.query<{ ok: number }>("SELECT 1 AS ok");
    await seed(pool);
    const afterSnapshot = await catalogSnapshot(pool);
    const catalogDrift = [...seededSnapshot]
      .filter(([k, v]) => afterSnapshot.get(k) !== v)
      .map(([k]) => k);

    reporter.meta["nonFiniteStored"] = nonFiniteStored;
    const path = reporter.write();
    console.warn(`[stress] schema-hostile-rows: ${JSON.stringify(reporter.summary())} → ${path}`);
    expect(reporter.rows.length).toBe(total);
    expect(formatAnomalies(reporter)).toBe("");
    expect(protoAfter).toBe(protoBefore);
    expect(polluted).toBe(false);
    expect(health.rows[0]?.ok).toBe(1);
    expect(catalogDrift).toEqual([]);
    // Non-finite values on the unguarded columns are the known finding pinned
    // below; any other column storing NaN/±Infinity is a new escape.
    expect(nonFiniteStored.filter((s) => !UNGUARDED_NUMERIC.has(s.split("=")[0] ?? ""))).toEqual(
      [],
    );
  });

  /**
   * Every numeric column x {NaN, "NaN", Infinity, "Infinity", "-Infinity", -0,
   * "-0", "1e309", 2^53+1}. Run once, asserted twice below.
   */
  let numericEdges: { stored: string[]; reporter: Reporter } | undefined;
  const probeNumericEdges = async (): Promise<{ stored: string[]; reporter: Reporter }> => {
    if (numericEdges) return numericEdges;
    const numericColumns = TABLES.flatMap((t) =>
      t.columns
        .filter((c) => NUMERIC_KINDS.has(c.kind))
        .map((c) => ({ table: t.table, column: c })),
    );
    const payloads: readonly unknown[] = [
      Number.NaN,
      "NaN",
      Number.POSITIVE_INFINITY,
      "Infinity",
      "-Infinity",
      -0,
      "-0",
      "1e309",
      "9007199254740993",
    ];
    const reporter = new Reporter("schema-numeric-edges", {
      iterations: numericColumns.length * payloads.length,
    });
    const stored: string[] = [];
    let index = 0;
    for (const { table, column } of numericColumns) {
      const spec = TABLES.find((t) => t.table === table) as TableSpec;
      for (const payload of payloads) {
        const rng = new Rng(index + 1);
        const columns = spec.columns.map((c) => c.name);
        const values = spec.columns.map((c) => c.valid(rng, fx));
        if (spec.finalize) {
          const record = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
          spec.finalize(record);
          columns.forEach((c, i) => {
            values[i] = record[c];
          });
        }
        values[columns.indexOf(column.name)] = payload;
        const params = columns.map((c, i) =>
          spec.columns[i]?.kind === "jsonb" ? `$${i + 1}::jsonb` : `$${i + 1}`,
        );
        const sql = `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${params.join(", ")}) RETURNING "${column.name}"`;
        let outcome: Outcome = "ACCEPTED";
        let sqlstate: string | undefined;
        let message: string | undefined;
        let note: string | undefined;
        try {
          const { rows } = await pool.query<Record<string, unknown>>(sql, values);
          const back = rows[0]?.[column.name];
          note = `stored=${describeInput(back)}`;
          if (nonFinite({ [column.name]: back }, [column]).length) {
            stored.push(
              `${table}.${column.name} <- ${describeInput(payload)} => ${describeInput(back)}`,
            );
            note = `non-finite-stored:${note}`;
          }
        } catch (error) {
          const c = classifyError(error);
          outcome = c.outcome;
          sqlstate = c.sqlstate;
          message = c.message;
        }
        reporter.add({
          seed: index,
          index,
          kind: `${table}.${column.name}`,
          input: describeInput(payload),
          outcome,
          ...(sqlstate ? { sqlstate } : {}),
          ...(message ? { message } : {}),
          ...(note ? { note } : {}),
          durationMs: 0,
        });
        index++;
      }
    }
    reporter.meta["nonFiniteStored"] = stored;
    const path = reporter.write();
    console.warn(`[stress] schema-numeric-edges: ${JSON.stringify(reporter.summary())} → ${path}`);
    console.warn(`[stress] non-finite stored:\n${stored.join("\n")}`);
    numericEdges = { stored, reporter };
    return numericEdges;
  };

  it("numeric columns: overflow / -0 / 2^53+1 / NaN on CHECK-bounded or integer columns never escape", async () => {
    const { stored, reporter } = await probeNumericEdges();
    expect(formatAnomalies(reporter)).toBe("");
    // Integer columns and the [0,10] score columns (shot.overall_score,
    // analysis_run.overall_score) refuse every non-finite payload.
    expect(stored.filter((s) => !UNGUARDED_NUMERIC.has(s.split(" <- ")[0] ?? ""))).toEqual([]);
  });

  /**
   * FINDING (P2): `numeric(5,4)` / `numeric(4,2)` / `numeric(7,4)` accept the
   * literal NaN (PostgreSQL semantics) and the float8 scoring_target bounds
   * accept NaN and ±Infinity, so a malformed sync payload can persist
   * `shot.confidence = NaN`, `practice_session.avg_score = NaN` or a
   * `scoring_target` whose interval is [NaN, Infinity]. Nothing in the
   * migrations guards these columns the way `overall_score` is guarded. The
   * invariant below is the one the lens demands; `it.fails` pins that it does
   * NOT hold today and starts failing once a migration adds the guards.
   */
  it.fails("numeric columns: NaN / ±Infinity never reach disk (currently broken)", async () => {
    const { stored } = await probeNumericEdges();
    expect(stored).toEqual([]);
  });

  it(`walks the hard_case state machine with ${Math.max(20, Math.round(total / 10))} random sequences`, async () => {
    const walks = Math.max(20, Math.round(total / 10));
    const reporter = new Reporter("schema-hard-case-walks", { iterations: walks });
    const states = ["new", "triaged", "in-review", "resolved", "regression"] as const;
    const legal = new Set([
      "new>triaged",
      "triaged>in-review",
      "in-review>resolved",
      "in-review>regression",
      "resolved>regression",
      "regression>triaged",
    ]);
    for (const [index, seed] of campaignSeeds("hard-case", walks).entries()) {
      const rng = new Rng(seed);
      const started = performance.now();
      const problems: string[] = [];
      const trail: string[] = [];
      let sqlstate: string | undefined;
      try {
        const { rows } = await pool.query<{ id: string; state: string }>(
          "INSERT INTO hard_case (fingerprint, source, category, subject_key, severity) VALUES ($1, 'user_feedback', 'OTHER', $2, 'medium') RETURNING id, state",
          [`fp-walk-${seed}`, `rec-${rng.hex(6)}`],
        );
        let current = rows[0]?.state ?? "new";
        const id = rows[0]?.id as string;
        for (let step = 0; step < rng.int(1, 12); step++) {
          const target = rng.chance(0.15)
            ? hostileFor(rng, enumCol("state", states)).value
            : rng.pick(states);
          const edge = `${current}>${String(target)}`;
          let moved = false;
          try {
            await pool.query("UPDATE hard_case SET state = $1 WHERE id = $2", [target, id]);
            moved = true;
          } catch (error) {
            const c = classifyError(error);
            sqlstate = c.sqlstate;
            if (c.outcome.startsWith("ANOMALY")) problems.push(`${edge}:${c.outcome}:${c.message}`);
          }
          const now = (
            await pool.query<{ state: string }>("SELECT state FROM hard_case WHERE id = $1", [id])
          ).rows[0]?.state;
          if (moved) {
            if (target === current) {
              // no-op update is always legal
            } else if (!legal.has(edge)) problems.push(`illegal-transition-accepted:${edge}`);
            if (now !== target) problems.push(`moved-but-state=${now}`);
          } else if (now !== current) {
            problems.push(`rejected-but-state-changed:${current}->${now}`);
          }
          trail.push(`${edge}${moved ? "✓" : "✗"}`);
          current = now ?? current;
        }
      } catch (error) {
        problems.push(`harness-threw:${trimMessage(String(error))}`);
      }
      reporter.add({
        seed,
        index,
        kind: "hard_case-walk",
        input: describeInput(trail, 400),
        outcome: problems.length ? "ANOMALY_PROPERTY" : "ACCEPTED",
        ...(sqlstate ? { sqlstate } : {}),
        ...(problems.length ? { note: problems.join(";") } : {}),
        durationMs: performance.now() - started,
      });
    }
    const path = reporter.write();
    console.warn(
      `[stress] schema-hard-case-walks: ${JSON.stringify(reporter.summary())} → ${path}`,
    );
    expect(reporter.rows.length).toBe(walks);
    expect(formatAnomalies(reporter)).toBe("");
  });

  it("unicode normalisation pairs are distinct keys (no silent merge, no crash)", async () => {
    const reporter = new Reporter("schema-unicode-pairs", { iterations: UNICODE_PAIRS.length * 2 });
    for (const [index, [label, a, b]] of UNICODE_PAIRS.entries()) {
      for (const [j, [first, second]] of [[a, b] as const, [b, a] as const].entries()) {
        const started = performance.now();
        const slugA = `pair_${label}_${index}_${j}_${first}`;
        const slugB = `pair_${label}_${index}_${j}_${second}`;
        let outcome: Outcome = "ACCEPTED";
        let note: string | undefined;
        try {
          await pool.query(
            "INSERT INTO feature_flag (key, description, enabled, rollout_percent) VALUES ($1, 'pair', false, 0)",
            [slugA],
          );
          await pool.query(
            "INSERT INTO feature_flag (key, description, enabled, rollout_percent) VALUES ($1, 'pair', false, 0)",
            [slugB],
          );
          const { rows } = await pool.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM feature_flag WHERE key = $1 OR key = $2",
            [slugA, slugB],
          );
          if (rows[0]?.n !== "2") {
            outcome = "ANOMALY_PROPERTY";
            note = `expected 2 distinct keys, found ${rows[0]?.n}`;
          }
        } catch (error) {
          const c = classifyError(error);
          outcome =
            c.outcome === "REJECTED_TYPED" && c.sqlstate === "23505"
              ? "ANOMALY_PROPERTY"
              : c.outcome;
          note = c.message;
        }
        reporter.add({
          seed: index * 2 + j,
          index: index * 2 + j,
          kind: `unicode-pair:${label}`,
          input: describeInput([slugA, slugB]),
          outcome,
          ...(note ? { note } : {}),
          durationMs: performance.now() - started,
        });
      }
    }
    const path = reporter.write();
    console.warn(`[stress] schema-unicode-pairs: ${JSON.stringify(reporter.summary())} → ${path}`);
    expect(formatAnomalies(reporter)).toBe("");
  });

  it("graphemes vs bytes vs code points: the 1000-char comment cap counts code points", async () => {
    // char_length() counts code points, so a 999-grapheme ZWJ-family comment
    // (6993 code points, 24975 bytes) is rejected while 1000 astral code points
    // (2000 UTF-16 units, 4000 bytes) are accepted. Pins the cap's unit.
    const insert = async (comment: string) => {
      const job = await pool.query<{ id: string }>(
        "INSERT INTO analysis_job (user_id, inference_mode, status) VALUES ($1, 'on_device', 'complete') RETURNING id",
        [fx.userId],
      );
      return pool.query(
        `INSERT INTO analysis_issue_report (user_id, analysis_job_id, failure_category, comment, app_version,
           device_platform, device_os_version, device_model, version_vector, diagnostics)
         VALUES ($1, $2, 'score_too_low', $3, '1.0.0', 'ios', '18.0', 'iPhone', '{}'::jsonb, '{}'::jsonb)`,
        [fx.userId, job.rows[0]?.id, comment],
      );
    };
    const astral = "\u{1D54F}".repeat(1000);
    expect(astral.length).toBe(2000);
    await insert(astral);
    const combining = `a${"\u0301".repeat(1000)}`;
    await expect(insert(combining)).rejects.toMatchObject({ code: "23514" });
    const family = graphemeBomb(999);
    await expect(insert(family)).rejects.toMatchObject({ code: "23514" });
  });
});
