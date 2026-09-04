import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { canonicalConsentRecordsJson, type ConsentRecord } from "@pickle/shared-types";
import {
  checkConsentForSubject,
  intakeClip,
  loadCaptureMeta,
  loadConsentLedger,
  type CaptureMeta,
  type IntakeInput,
} from "../src/index.js";
import {
  campaignTimeoutMs,
  campaignVerdict,
  findNonFinite,
  findOwnProtoKeys,
  outputDir,
  runCampaign,
  runGuarded,
  typedShapeGap,
  writeReport,
  type ExecResult,
  type KnownGap,
  type StressCase,
} from "../../../tools/stress/boundary-malformed/harness.js";
import {
  describeValue,
  materialize,
  planMutations,
  type FieldSpec,
} from "../../../tools/stress/boundary-malformed/payloads.js";

/**
 * Boundary / malformed-input stress campaign for @pickle/first-party-intake.
 *
 * Targets the three parse boundaries (`loadCaptureMeta`, `loadConsentLedger`,
 * `checkConsentForSubject`) and the `intakeClip` composition with seeded
 * malformed files, wrong types, prototype-pollution keys, numeric edges,
 * null bytes, 64KiB+ strings, path traversal, future schema versions, empty
 * containers and Unicode normalization pairs. ALL fixtures are SYNTHETIC
 * (`SYNTHETIC-TEST-FIXTURE` prefix) and every file lives in a per-execution
 * scratch directory that is deleted afterwards.
 *
 * Scale: STRESS_ITER (default 60). Replay one row: STRESS_REPLAY=<seed>.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SUBJECT = "SYNTHETIC-TEST-FIXTURE.stress-subject";

const CAPTURE_META: CaptureMeta = {
  clipId: "SYNTHETIC-TEST-FIXTURE.clip-01",
  athleteId: "SYNTHETIC-TEST-FIXTURE.athlete-01",
  athleteGroupId: "SYNTHETIC-TEST-FIXTURE.group-01",
  sessionId: "SYNTHETIC-TEST-FIXTURE.session-01",
  recordedAt: "2026-08-15T10:00:00.000Z",
  capture: {
    cameraView: "rear",
    environment: "outdoor",
    lighting: "daylight",
    deviceClass: "synthetic-lavfi-generator",
    handedness: "unknown",
    skillBand: "unknown",
    ageBand: "withheld",
    adaptivePlay: false,
    bystanderState: "none",
  },
};

const META_FIELDS: FieldSpec[] = [
  { path: ["clipId"], kind: "string" },
  { path: ["athleteId"], kind: "string" },
  { path: ["athleteGroupId"], kind: "string" },
  { path: ["sessionId"], kind: "string" },
  { path: ["recordedAt"], kind: "string" },
  { path: ["capture"], kind: "object" },
  { path: ["capture", "cameraView"], kind: "enum" },
  { path: ["capture", "environment"], kind: "enum" },
  { path: ["capture", "lighting"], kind: "enum" },
  { path: ["capture", "deviceClass"], kind: "string" },
  { path: ["capture", "handedness"], kind: "enum" },
  { path: ["capture", "skillBand"], kind: "enum" },
  { path: ["capture", "ageBand"], kind: "enum" },
  { path: ["capture", "adaptivePlay"], kind: "boolean" },
  { path: ["capture", "bystanderState"], kind: "enum" },
];

function consentRecord(overrides: Partial<ConsentRecord>): ConsentRecord {
  return {
    id: "SYNTHETIC-TEST-FIXTURE.record",
    subjectPseudonym: SUBJECT,
    scope: "model_training",
    action: "granted",
    consentVersion: "model-training-v1",
    source: "mobile_settings",
    device: null,
    captureMode: "all_captures",
    strokeIntent: null,
    recordedAtIso: "2026-08-29T00:00:00.000Z",
    seq: 1,
    ...overrides,
  };
}

const RECORDS: ConsentRecord[] = [
  consentRecord({ id: "SYNTHETIC-TEST-FIXTURE.r1", scope: "video_analysis", seq: 1 }),
  consentRecord({
    id: "SYNTHETIC-TEST-FIXTURE.r2",
    scope: "model_training",
    seq: 2,
    recordedAtIso: "2026-08-29T00:01:00.000Z",
  }),
];

function v1Envelope(records: ConsentRecord[]): Record<string, unknown> {
  return {
    exportVersion: "consent-ledger-export-v1",
    exportedAtIso: "2026-08-29T00:00:01.000Z",
    subjectPseudonym: SUBJECT,
    recordCount: records.length,
    maxSeq: records.length > 0 ? (records[records.length - 1]?.seq ?? null) : null,
    recordsSha256: createHash("sha256").update(canonicalConsentRecordsJson(records)).digest("hex"),
    records,
  };
}

const RECORD_FIELDS = (index: number): FieldSpec[] => [
  { path: ["records", index], kind: "object" },
  { path: ["records", index, "id"], kind: "string" },
  { path: ["records", index, "subjectPseudonym"], kind: "string" },
  { path: ["records", index, "scope"], kind: "enum" },
  { path: ["records", index, "action"], kind: "enum" },
  { path: ["records", index, "consentVersion"], kind: "string" },
  { path: ["records", index, "source"], kind: "enum" },
  { path: ["records", index, "device"], kind: "string" },
  { path: ["records", index, "captureMode"], kind: "enum" },
  { path: ["records", index, "strokeIntent"], kind: "string" },
  { path: ["records", index, "recordedAtIso"], kind: "string" },
  { path: ["records", index, "seq"], kind: "number" },
];

const ENVELOPE_FIELDS: FieldSpec[] = [
  { path: ["exportVersion"], kind: "enum" },
  { path: ["exportedAtIso"], kind: "string" },
  { path: ["subjectPseudonym"], kind: "string" },
  { path: ["recordCount"], kind: "number" },
  { path: ["maxSeq"], kind: "number" },
  { path: ["recordsSha256"], kind: "string" },
  { path: ["records"], kind: "array" },
  { path: ["signature"], kind: "object" },
  ...RECORD_FIELDS(0),
  ...RECORD_FIELDS(1),
];

const KNOWN_ENUMS = {
  scope: ["video_analysis", "model_training"],
  action: ["granted", "withdrawn"],
} as const;

/* ------------------------------------------------------------------------ */
/* Output oracles                                                            */
/* ------------------------------------------------------------------------ */

const META_KEYS = ["clipId", "athleteId", "athleteGroupId", "sessionId", "recordedAt", "capture"];
const CAPTURE_KEYS = Object.keys(CAPTURE_META.capture);

function validateMeta(meta: CaptureMeta): string[] {
  const problems: string[] = [];
  const extraTop = Object.keys(meta).filter((k) => !META_KEYS.includes(k));
  const extraCapture = Object.keys(meta.capture).filter((k) => !CAPTURE_KEYS.includes(k));
  if (extraTop.length > 0)
    problems.push(`unknown top-level keys passed through: ${extraTop.join(",")}`);
  if (extraCapture.length > 0) {
    problems.push(`unknown capture keys passed through: ${extraCapture.join(",")}`);
  }
  if (typeof meta.capture.deviceClass !== "string" || meta.capture.deviceClass.trim() === "") {
    problems.push("deviceClass not a non-empty string");
  }
  if (meta.capture.deviceClass.length > 4096) {
    problems.push(`deviceClass of ${meta.capture.deviceClass.length} chars accepted (no cap)`);
  }
  if (Number.isNaN(Date.parse(meta.recordedAt))) problems.push("recordedAt not a date");
  return problems;
}

function validateRecords(records: ConsentRecord[]): string[] {
  const problems: string[] = [];
  records.forEach((record, index) => {
    if (record.seq !== undefined && !Number.isInteger(record.seq)) {
      problems.push(`records[${index}].seq accepted as non-integer ${describeValue(record.seq)}`);
    }
    if (!(KNOWN_ENUMS.scope as readonly string[]).includes(record.scope)) {
      problems.push(`records[${index}].scope accepted: ${describeValue(record.scope)}`);
    }
    if (!(KNOWN_ENUMS.action as readonly string[]).includes(record.action)) {
      problems.push(`records[${index}].action accepted: ${describeValue(record.action)}`);
    }
    if (typeof record.id !== "string" || record.id.length === 0) {
      problems.push(`records[${index}].id accepted: ${describeValue(record.id)}`);
    }
  });
  problems.push(...findOwnProtoKeys(records).map((p) => `own proto key persisted at ${p}`));
  return problems;
}

/* ------------------------------------------------------------------------ */
/* Cases                                                                     */
/* ------------------------------------------------------------------------ */

interface FileBase {
  kind: "meta" | "envelope" | "bare-array" | "intake";
  body: unknown;
  /** Extra direct-call arguments (string inputs to intakeClip / subject). */
  subject: string;
  operatorId: string;
  options?: { signingKey?: string; minMaxSeq?: number };
}

function writeScratch(dir: string, name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

/** Files present in the scratch dir after an execution that the executor did not create. */
function unexpectedWrites(dir: string, allowed: readonly string[]): string[] {
  return readdirSync(dir).filter((name) => !allowed.includes(name));
}

const loadCaptureMetaCase: StressCase<FileBase> = {
  api: "loadCaptureMeta",
  mutationRoot: (base) => base.body,
  weight: 3,
  generate(rng) {
    const plan = planMutations(rng, META_FIELDS, {
      jsonOnly: true,
      allowText: true,
      objectPaths: [[], ["capture"]],
      schemaPaths: [["schemaVersion"], ["intakeVersion"]],
    });
    return {
      category: plan.category,
      base: { kind: "meta", body: CAPTURE_META, subject: SUBJECT, operatorId: "op-1" },
      mutations: plan.mutations,
    };
  },
  execute(base, mutations, ctx) {
    const { text } = materialize(base.body, mutations);
    const path = writeScratch(ctx.tmpDir, "meta.json", text ?? "");
    const result = runGuarded(() => loadCaptureMeta(path), validateMeta);
    result.violations.push(...unexpectedWrites(ctx.tmpDir, ["meta.json"]).map((f) => `wrote ${f}`));
    return result;
  },
};

const loadConsentLedgerCase: StressCase<FileBase> = {
  api: "loadConsentLedger",
  mutationRoot: (base) => base.body,
  weight: 4,
  generate(rng) {
    const bare = rng.chance(0.25);
    const plan = planMutations(
      rng,
      bare
        ? [...RECORD_FIELDS(0), ...RECORD_FIELDS(1)].map((f) => ({ ...f, path: f.path.slice(1) }))
        : ENVELOPE_FIELDS,
      {
        jsonOnly: true,
        allowText: true,
        objectPaths: bare ? [[0], [1]] : [[], ["records", 0], ["records", 1], ["signature"]],
        schemaPaths: bare ? [] : [["exportVersion"]],
      },
    );
    const options = rng.chance(0.2)
      ? { signingKey: "SYNTHETIC-TEST-FIXTURE.key" }
      : rng.chance(0.2)
        ? { minMaxSeq: 2 }
        : undefined;
    const base: FileBase = {
      kind: bare ? "bare-array" : "envelope",
      body: bare ? RECORDS : v1Envelope(RECORDS),
      subject: SUBJECT,
      operatorId: "op-1",
    };
    if (options) base.options = options;
    return { category: plan.category, base, mutations: plan.mutations };
  },
  execute(base, mutations, ctx) {
    const { text } = materialize(base.body, mutations);
    const path = writeScratch(ctx.tmpDir, "ledger.json", text ?? "");
    const result = runGuarded(() => loadConsentLedger(path, base.options), validateRecords);
    result.violations.push(
      ...unexpectedWrites(ctx.tmpDir, ["ledger.json"]).map((f) => `wrote ${f}`),
    );
    return result;
  },
};

const checkConsentCase: StressCase<FileBase> = {
  api: "checkConsentForSubject",
  surface: "typed",
  mutationRoot: (base) => base.body,
  weight: 2,
  generate(rng) {
    const plan = planMutations(
      rng,
      [
        ...[...RECORD_FIELDS(0), ...RECORD_FIELDS(1)].map((f) => ({ ...f, path: f.path.slice(1) })),
        { path: ["__subject"], kind: "string" },
      ],
      { jsonOnly: false, allowText: false, objectPaths: [[0], [1]] },
    );
    return {
      category: plan.category,
      base: { kind: "bare-array", body: RECORDS, subject: SUBJECT, operatorId: "op-1" },
      mutations: plan.mutations,
    };
  },
  execute(base, mutations) {
    const subjectMutation = mutations.find((m) => m.op === "set" && m.path[0] === "__subject");
    const recordMutations = mutations.filter((m) => !(m.op === "set" && m.path[0] === "__subject"));
    const { value } = materialize(base.body, recordMutations);
    const subject =
      subjectMutation && subjectMutation.op === "set" ? subjectMutation.value : base.subject;
    return runGuarded(
      () => checkConsentForSubject(value as ConsentRecord[], subject as string),
      (check) => {
        const problems: string[] = [];
        if (typeof check.ok !== "boolean") problems.push("ok not boolean");
        if (!Number.isInteger(check.subjectRecordCount) || check.subjectRecordCount < 0) {
          problems.push(`subjectRecordCount=${describeValue(check.subjectRecordCount)}`);
        }
        if (check.ok && (!check.videoAnalysisActive || !check.modelTrainingActive)) {
          problems.push("ok=true without both scopes active");
        }
        if (check.ok && check.subjectRecordCount === 0) problems.push("ok=true with zero records");
        problems.push(...findNonFinite(check));
        return problems;
      },
    );
  },
};

let validClip: Buffer | null = null;

function ensureClip(): Buffer {
  if (validClip !== null) return validClip;
  const probe = spawnSync("ffmpeg", ["-version"]);
  if (probe.status !== 0) {
    validClip = Buffer.from("not a video");
    return validClip;
  }
  const res = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=64x64:rate=30",
    "-t",
    "0.5",
    "-pix_fmt",
    "yuv420p",
    "-f",
    "mp4",
    "-movflags",
    "frag_keyframe+empty_moov",
    "pipe:1",
  ]);
  validClip = res.status === 0 && res.stdout.length > 0 ? res.stdout : Buffer.from("not a video");
  return validClip;
}

const intakeClipCase: StressCase<FileBase> = {
  api: "intakeClip",
  mutationRoot: (base) => base.body,
  weight: 1,
  generate(rng) {
    const which = rng.int(0, 2);
    const fields: FieldSpec[] =
      which === 0
        ? META_FIELDS.map((f) => ({ ...f, path: ["meta", ...f.path] }))
        : which === 1
          ? ENVELOPE_FIELDS.map((f) => ({ ...f, path: ["ledger", ...f.path] }))
          : [
              { path: ["args", "clipPath"], kind: "string" },
              { path: ["args", "consentLedgerPath"], kind: "string" },
              { path: ["args", "captureMetaPath"], kind: "string" },
              { path: ["args", "subjectPseudonym"], kind: "string" },
              { path: ["args", "operatorId"], kind: "string" },
            ];
    const plan = planMutations(rng, fields, {
      jsonOnly: true,
      allowText: false,
      objectPaths: [["meta"], ["meta", "capture"], ["ledger"], ["args"]],
      schemaPaths: [
        ["ledger", "exportVersion"],
        ["meta", "schemaVersion"],
      ],
    });
    return {
      category: plan.category,
      base: {
        kind: "intake",
        body: { meta: CAPTURE_META, ledger: v1Envelope(RECORDS), args: {} },
        subject: SUBJECT,
        operatorId: "op-1",
      },
      mutations: plan.mutations,
    };
  },
  execute(base, mutations, ctx) {
    const { value } = materialize(base.body, mutations);
    const body = value as { meta: unknown; ledger: unknown; args: Record<string, unknown> };
    const clipPath = join(ctx.tmpDir, "clip.mp4");
    writeFileSync(clipPath, ensureClip());
    const metaPath = writeScratch(ctx.tmpDir, "meta.json", JSON.stringify(body.meta));
    const ledgerPath = writeScratch(ctx.tmpDir, "ledger.json", JSON.stringify(body.ledger));
    const args = body.args;
    for (const key of ["clipPath", "consentLedgerPath", "captureMetaPath"] as const) {
      if (typeof args[key] === "number") {
        // fs.readFileSync(<integer>) reads that FILE DESCRIPTOR: 0/1/2 are the worker's
        // stdio pipes and the read blocks forever, so this input is reported, not executed.
        return {
          outcome: "returned-invalid",
          detail:
            `${key}=${describeValue(args[key])} not executed: intakeClip() passes the value ` +
            "straight to fs.readFileSync, which treats an integer as a file descriptor",
          violations: ["fd-read-hazard"],
        };
      }
    }
    const input: IntakeInput = {
      clipPath: (args["clipPath"] as string | undefined) ?? clipPath,
      consentLedgerPath: (args["consentLedgerPath"] as string | undefined) ?? ledgerPath,
      captureMetaPath: (args["captureMetaPath"] as string | undefined) ?? metaPath,
      subjectPseudonym: (args["subjectPseudonym"] as string | undefined) ?? base.subject,
      operatorId: (args["operatorId"] as string | undefined) ?? base.operatorId,
    };
    const before = readdirSync(ctx.tmpDir).sort().join(",");
    const result: ExecResult = runGuarded(
      () => intakeClip(input),
      (record) => {
        const problems: string[] = [];
        if (!["ACCEPTED", "DEGRADED", "REJECTED"].includes(record.status)) {
          problems.push(`status=${describeValue(record.status)}`);
        }
        if (record.status !== "REJECTED" && record.manifestDraft === null) {
          problems.push("non-REJECTED without manifestDraft");
        }
        if (record.status === "REJECTED" && record.manifestDraft !== null) {
          problems.push("REJECTED with manifestDraft (must never write a draft on rejection)");
        }
        if (record.status !== "REJECTED" && record.reasons.length > 0) {
          problems.push("non-REJECTED with reasons");
        }
        problems.push(...findNonFinite(record));
        problems.push(...findOwnProtoKeys(record).map((p) => `own proto key persisted at ${p}`));
        return problems;
      },
    );
    const after = readdirSync(ctx.tmpDir).sort().join(",");
    if (before !== after) result.violations.push(`scratch dir changed: ${after}`);
    return result;
  },
};

/* ------------------------------------------------------------------------ */
/* Known gaps (reproduced, documented behaviour — see the campaign report)   */
/* ------------------------------------------------------------------------ */

const KNOWN_GAPS: KnownGap[] = [
  {
    id: "FPI-ERR-ECHO-UNBOUNDED",
    finding:
      "captureMeta.ts pushIfNotEnum() and consentRef.ts verifyExportEnvelope() interpolate the " +
      "offending file value verbatim into the thrown message (`got ${String(value)}`, " +
      "`unknown exportVersion ${String(version)}`); a 64 KiB field on disk yields a 64 KiB+ " +
      "error string.",
    matches: (row) =>
      row.outcome === "rejected-error" &&
      (row.detail.startsWith("Error: capture metadata ") ||
        row.detail.startsWith("Error: consent ledger export ")) &&
      row.violations.length > 0 &&
      row.violations.every((v) => v.startsWith("oversized-error-message")),
  },
  {
    id: "FPI-FS-ERROR-PASSTHROUGH",
    finding:
      "intakeClip()/loadCaptureMeta() let Node fs errors (ENAMETOOLONG, ENOENT) escape untouched; " +
      "the message echoes the full caller-supplied path, so a 64 KiB path yields a 64 KiB+ " +
      "error string.",
    matches: (row) =>
      row.outcome === "rejected-io" &&
      row.violations.length > 0 &&
      row.violations.every((v) => v.startsWith("oversized-error-message")),
  },
  {
    id: "FPI-META-UNKNOWN-KEYS-PASSTHROUGH",
    finding:
      "loadCaptureMeta() validates the known fields then returns the parsed JSON object itself, " +
      "so unknown top-level / capture keys (including own `__proto__`, `constructor`, " +
      "`prototype` keys and a future `schemaVersion`) flow into the CaptureMeta consumers.",
    matches: (row) =>
      row.api === "loadCaptureMeta" &&
      row.outcome === "returned-invalid" &&
      row.violations.length === 0 &&
      row.detail
        .split("; ")
        .every(
          (p) =>
            p.startsWith("unknown top-level keys passed through: ") ||
            p.startsWith("unknown capture keys passed through: "),
        ),
  },
  {
    id: "FPI-LEDGER-RECORD-PASSTHROUGH",
    finding:
      "loadConsentLedger() returns the parsed record objects verbatim after integrity " +
      "verification; because canonicalConsentRecordsJson() projects only the known fields, a " +
      "record carrying extra own keys (including `__proto__` / `constructor` / `prototype`) " +
      "still matches recordsSha256 and is handed to callers with those keys attached.",
    matches: (row) =>
      row.api === "loadConsentLedger" &&
      row.outcome === "returned-invalid" &&
      row.violations.length === 0 &&
      row.detail.split("; ").every((p) => p.startsWith("own proto key persisted at ")),
  },
  {
    id: "FPI-LEDGER-SEQ-UNVALIDATED",
    finding:
      "consentRef.ts isConsentRecord() never type-checks `seq`; for a bare-array (legacy) ledger " +
      "nothing else looks at it either, so a record whose seq is a string, null (JSON form of " +
      "Infinity/NaN) or a fraction is accepted and returned as a ConsentRecord.",
    matches: (row) =>
      row.api === "loadConsentLedger" &&
      row.outcome === "returned-invalid" &&
      row.violations.length === 0 &&
      row.detail.split("; ").every((p) => /^records\[\d+\]\.seq accepted as non-integer /.test(p)),
  },
  {
    id: "FPI-PATH-FD-HAZARD",
    finding:
      "intake.ts intakeClip() / captureMeta.ts loadCaptureMeta() hand clipPath, " +
      "consentLedgerPath and captureMetaPath to fs.readFileSync without a string guard; an " +
      "integer is read as a file descriptor (0/1/2 = stdio, blocking indefinitely on a pipe). " +
      "Reproduced once (seed 2772486010 hung the worker at ~0% CPU); the harness now reports " +
      "such inputs instead of executing them.",
    matches: (row) =>
      row.api === "intakeClip" &&
      row.outcome === "returned-invalid" &&
      row.violations.length === 1 &&
      row.violations[0] === "fd-read-hazard",
  },
  typedShapeGap(
    "FPI-TYPED-NO-GUARDS",
    "checkConsentForSubject() applies no runtime guard to its typed `ledger` argument; a " +
      "non-array ends in a native TypeError.",
  ),
];

describe("first-party-intake boundary/malformed stress", () => {
  beforeAll(() => {
    ensureClip();
  });

  it(
    "rejects malformed inputs with typed errors, never crashes or writes",
    () => {
      const report = runCampaign<FileBase>({
        pkg: "first-party-intake",
        cases: [loadCaptureMetaCase, loadConsentLedgerCase, checkConsentCase, intakeClipCase],
        knownGaps: KNOWN_GAPS,
      });
      const path = writeReport(report, outputDir(REPO_ROOT));
      expect(campaignVerdict(report, path)).toBeNull();
    },
    campaignTimeoutMs(),
  );
});
