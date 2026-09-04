import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONSENT_LEDGER_EXPORT_VERSION,
  CONSENT_LEDGER_EXPORT_VERSION_V2,
  canonicalConsentExportSigningPayload,
  canonicalConsentRecordsJson,
  type ConsentRecord,
  type ConsentScope,
} from "@pickle/shared-types";
import { evaluateCaptureEnvelope, measureClip } from "@pickle/capture-envelope";
import {
  checkConsentForSubject,
  intakeClip,
  loadConsentLedger,
  sha256File,
  type IntakeRecord,
} from "../src/index.js";
import {
  check,
  describeFailures,
  executeSteps,
  findNonFinite,
  readStressEnv,
  runCampaign,
  type Rng,
} from "../../../tools/stress-kit/kit.js";

/**
 * SEEDED RANDOMIZED LONG-RUN over first-party intake.
 *
 * ALL fixtures are SYNTHETIC: pseudonyms are prefixed `SYNTHETIC-STRESS`,
 * clips are ffmpeg lavfi testsrc2 patterns (no camera, no athlete, no court).
 * Nothing here is corpus data and no labels are produced or implied.
 *
 * Campaign A — consent ledger (pure + tmpfile I/O, the ≥2000-sequence run):
 *  C1  checkConsentForSubject.ok ⇔ the subject's LAST action (by seq, else by
 *      recordedAtIso) is `granted` for BOTH video_analysis and model_training;
 *      modelTrainingConsentVersion is that last grant's version, else null;
 *      subjectRecordCount is exact; ok ⇔ errors is empty.
 *  C2  a subject with no rows is NOT consented (default off), with a reason.
 *  C3  an untampered bare array / v1 / v2 export round-trips through
 *      loadConsentLedger to exactly the same records.
 *  C4  any of: dropped trailing row, flipped action, reordered rows,
 *      recordCount / maxSeq / recordsSha256 mismatch, foreign subject,
 *      malformed row, stale watermark (minMaxSeq), bad signature, unsigned v1
 *      or bare array when a signing key is configured → loadConsentLedger
 *      THROWS (never silently authorises).
 *  C5  a v1 envelope re-hashed after tampering is ACCEPTED (documented:
 *      corruption-evident only) — but the same file is REJECTED as soon as a
 *      signing key is configured (v2 tamper-evidence).
 *  C6  no NaN/Infinity in ConsentCheckResult.
 *
 * Campaign B — intakeClip end-to-end (ffprobe/ffmpeg I/O; small by design):
 *  B1  status === REJECTED ⇔ !consent.ok || envelope oracle is UNSUPPORTED;
 *      ACCEPTED vs ACCEPTED_DEGRADED follows the per-clip envelope oracle.
 *  B2  manifestDraft is non-null ⇔ accepted; when present its sha256 fields
 *      equal sha256File of the clip / ledger and its identifiers equal the
 *      capture meta; pendingBeforeSnapshot is never empty (never claims
 *      approved_for_snapshot).
 *  B3  invalid capture metadata / tampered ledger → intakeClip THROWS (no
 *      partial record).
 *  B4  no NaN/Infinity anywhere in IntakeRecord (frameCount may be null).
 *  D   same seed → identical trace (intakeAtIso, a wall-clock stamp, is the
 *      only field excluded from the trace).
 */

const SUBJECTS = [
  "SYNTHETIC-STRESS.subject-A",
  "SYNTHETIC-STRESS.subject-B",
  "SYNTHETIC-STRESS.subject-C",
] as const;
const SCOPES: readonly ConsentScope[] = [
  "video_analysis",
  "model_training",
  "evaluation_telemetry",
];
const SIGNING_KEY = "SYNTHETIC-STRESS-signing-key-not-a-secret";

type Tamper =
  | "none"
  | "dropLast"
  | "flipAction"
  | "reorder"
  | "countOff"
  | "maxSeqOff"
  | "shaOff"
  | "foreignSubject"
  | "malformedRow"
  | "staleReplay"
  | "badSignature"
  | "keyButUnsigned"
  | "rehashedV1";

type Shape = "bare" | "v1" | "v2";

type ConsentAction =
  | { kind: "grant"; subject: number; scope: number; version: number }
  | { kind: "withdraw"; subject: number; scope: number }
  | { kind: "verify"; shape: Shape; tamper: Tamper; subject: number };

const TAMPERS: readonly Tamper[] = [
  "none",
  "none",
  "none",
  "dropLast",
  "flipAction",
  "reorder",
  "countOff",
  "maxSeqOff",
  "shaOff",
  "foreignSubject",
  "malformedRow",
  "staleReplay",
  "badSignature",
  "keyButUnsigned",
  "rehashedV1",
];

function generateConsent(rng: Rng, length: number): ConsentAction[] {
  const actions: ConsentAction[] = [];
  for (let i = 0; i < length; i += 1) {
    const roll = rng.next();
    if (roll < 0.4) {
      actions.push({
        kind: "grant",
        subject: rng.int(SUBJECTS.length),
        scope: rng.int(SCOPES.length),
        version: rng.int(3),
      });
    } else if (roll < 0.6) {
      actions.push({
        kind: "withdraw",
        subject: rng.int(SUBJECTS.length),
        scope: rng.int(SCOPES.length),
      });
    } else {
      actions.push({
        kind: "verify",
        shape: rng.pick(["bare", "v1", "v2"]),
        tamper: rng.pick(TAMPERS),
        subject: rng.int(SUBJECTS.length),
      });
    }
  }
  return actions;
}

let dir: string;
let fileCounter = 0;

function tmpFile(name: string): string {
  fileCounter += 1;
  return join(dir, `${fileCounter}-${name}`);
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

interface Envelope {
  exportVersion: string;
  exportedAtIso: string;
  subjectPseudonym: string;
  recordCount: number;
  maxSeq: number | null;
  recordsSha256: string;
  records: unknown[];
  signature?: { alg: "HMAC-SHA256"; keyId: string; value: string };
}

function envelopeFor(
  records: ConsentRecord[],
  subject: string,
  version: string,
  key: string | null,
): Envelope {
  const env: Envelope = {
    exportVersion: version,
    exportedAtIso: "2026-09-04T00:00:00.000Z",
    subjectPseudonym: subject,
    recordCount: records.length,
    maxSeq: records.length > 0 ? records[records.length - 1]!.seq! : null,
    recordsSha256: sha256(canonicalConsentRecordsJson(records)),
    records,
  };
  if (key !== null) {
    env.signature = {
      alg: "HMAC-SHA256",
      keyId: "synthetic",
      value: createHmac("sha256", key)
        .update(canonicalConsentExportSigningPayload(env))
        .digest("hex"),
    };
  }
  return env;
}

/** Reference consent model: last action per scope. */
function modelStatus(
  records: readonly ConsentRecord[],
  subject: string,
): { ok: boolean; count: number; version: string | null; va: boolean; mt: boolean } {
  const mine = records.filter((r) => r.subjectPseudonym === subject);
  const last = (scope: ConsentScope) => mine.filter((r) => r.scope === scope).at(-1) ?? null;
  const va = last("video_analysis");
  const mt = last("model_training");
  const vaActive = va?.action === "granted";
  const mtActive = mt?.action === "granted";
  return {
    ok: mine.length > 0 && vaActive && mtActive,
    count: mine.length,
    version: mtActive ? mt!.consentVersion : null,
    va: vaActive,
    mt: mtActive,
  };
}

function checkConsentModel(
  records: readonly ConsentRecord[],
  subject: string,
): ReturnType<typeof checkConsentForSubject> {
  const result = checkConsentForSubject(records, subject);
  const expected = modelStatus(records, subject);
  check(result.ok === expected.ok, "C1 ok", () => `${subject}: ${result.ok} != ${expected.ok}`);
  check(
    result.subjectRecordCount === expected.count,
    "C1 count",
    () => `${result.subjectRecordCount} != ${expected.count}`,
  );
  check(
    result.videoAnalysisActive === expected.va && result.modelTrainingActive === expected.mt,
    "C1 scopes",
    () => JSON.stringify(result),
  );
  check(
    result.modelTrainingConsentVersion === expected.version,
    "C1 version",
    () => `${String(result.modelTrainingConsentVersion)} != ${String(expected.version)}`,
  );
  check(result.ok === (result.errors.length === 0), "C1 ok iff no errors", () =>
    JSON.stringify(result.errors),
  );
  if (expected.count === 0)
    check(!result.ok && result.errors.length > 0, "C2 default off", () => JSON.stringify(result));
  const nonFinite = findNonFinite(result);
  check(nonFinite === null, "C6 finite", () => nonFinite ?? "");
  return result;
}

/** First line of the thrown message with tmp paths (unique per run) elided so traces stay comparable. */
function expectThrow(fn: () => unknown, label: string): string {
  try {
    fn();
  } catch (error) {
    return ((error as Error).message.split("\n")[0] ?? "")
      .split(dir)
      .join("<tmp>")
      .replace(/<tmp>\/\d+-/g, "<tmp>/");
  }
  throw check(false, label, () => "no throw") as never;
}

function executeConsent(actions: readonly ConsentAction[]) {
  const ledger: ConsentRecord[] = [];
  let seq = 0;
  let clock = Date.parse("2026-08-01T00:00:00.000Z");
  const append = (
    subject: string,
    scope: ConsentScope,
    action: "granted" | "withdrawn",
    version: string,
  ): void => {
    seq += 1;
    clock += 1000;
    ledger.push({
      id: `SYNTHETIC-STRESS.rec-${seq}`,
      subjectPseudonym: subject,
      scope,
      action,
      consentVersion: version,
      source: "privacy_center",
      device: null,
      captureMode: action === "granted" ? "all_captures" : null,
      strokeIntent: null,
      recordedAtIso: new Date(clock).toISOString(),
      seq,
    });
  };

  return executeSteps(actions, (action) => {
    if (action.kind === "grant") {
      const scope = SCOPES[action.scope]!;
      append(
        SUBJECTS[action.subject]!,
        scope,
        "granted",
        `${scope.replace(/_/g, "-")}-v${action.version + 1}`,
      );
      const r = checkConsentModel(ledger, SUBJECTS[action.subject]!);
      return { grant: scope, ok: r.ok };
    }
    if (action.kind === "withdraw") {
      const scope = SCOPES[action.scope]!;
      append(SUBJECTS[action.subject]!, scope, "withdrawn", `${scope.replace(/_/g, "-")}-v1`);
      const r = checkConsentModel(ledger, SUBJECTS[action.subject]!);
      return { withdraw: scope, ok: r.ok };
    }

    // verify: serialize the ledger for ONE subject (exports are per subject) and load it back.
    const subject = SUBJECTS[action.subject]!;
    const subjectRecords = ledger.filter((r) => r.subjectPseudonym === subject);
    const bareRecords =
      action.shape === "bare"
        ? subjectRecords.map(({ seq: _seq, ...rest }) => rest)
        : subjectRecords;
    const key = action.shape === "v2" ? SIGNING_KEY : null;
    const loadOptions = action.shape === "v2" ? { signingKey: SIGNING_KEY } : undefined;
    const path = tmpFile(`ledger-${action.shape}-${action.tamper}.json`);

    const writeEnvelope = (
      records: unknown[],
      mutate?: (env: Envelope) => void,
      recompute = false,
    ): Envelope => {
      const version =
        action.shape === "v2" ? CONSENT_LEDGER_EXPORT_VERSION_V2 : CONSENT_LEDGER_EXPORT_VERSION;
      const env = envelopeFor(subjectRecords, subject, version, key);
      env.records = records;
      if (recompute) {
        const typed = records as ConsentRecord[];
        env.recordCount = typed.length;
        env.maxSeq = typed.length > 0 ? typed[typed.length - 1]!.seq! : null;
        env.recordsSha256 = sha256(canonicalConsentRecordsJson(typed));
      }
      mutate?.(env);
      writeFileSync(path, JSON.stringify(env));
      return env;
    };

    const requiresRecords = subjectRecords.length > 0;
    switch (action.tamper) {
      case "none": {
        if (action.shape === "bare") writeFileSync(path, JSON.stringify(bareRecords));
        else writeEnvelope([...subjectRecords]);
        const loaded = loadConsentLedger(path, loadOptions);
        check(
          JSON.stringify(loaded) === JSON.stringify(bareRecords),
          "C3 round-trip",
          () => `${loaded.length} vs ${bareRecords.length}`,
        );
        const r = checkConsentModel(loaded, subject);
        for (const other of SUBJECTS) if (other !== subject) checkConsentModel(loaded, other);
        // A watermark equal to maxSeq is not stale.
        if (action.shape !== "bare" && requiresRecords) {
          loadConsentLedger(path, {
            ...loadOptions,
            minMaxSeq: subjectRecords[subjectRecords.length - 1]!.seq!,
          });
        }
        return { verify: action.shape, ok: r.ok, n: loaded.length };
      }
      case "dropLast": {
        if (!requiresRecords) return { verify: "skip-empty" };
        if (action.shape === "bare") {
          // Bare arrays carry no integrity fields: dropping a trailing withdrawal
          // is undetectable by design — record what the consumer would conclude.
          writeFileSync(path, JSON.stringify(bareRecords.slice(0, -1)));
          const loaded = loadConsentLedger(path);
          check(loaded.length === bareRecords.length - 1, "C3 bare length", () => "");
          return { verify: "bare-dropLast-accepted", ok: checkConsentModel(loaded, subject).ok };
        }
        writeEnvelope(subjectRecords.slice(0, -1));
        return {
          verify: "throws",
          msg: expectThrow(() => loadConsentLedger(path, loadOptions), "C4 dropLast"),
        };
      }
      case "flipAction": {
        if (!requiresRecords) return { verify: "skip-empty" };
        const flipped = subjectRecords.map((r, i) =>
          i === subjectRecords.length - 1
            ? { ...r, action: r.action === "granted" ? "withdrawn" : "granted" }
            : r,
        );
        if (action.shape === "bare") {
          writeFileSync(path, JSON.stringify(flipped.map(({ seq: _seq, ...rest }) => rest)));
          return {
            verify: "bare-flip-accepted",
            ok: checkConsentModel(loadConsentLedger(path), subject).ok,
          };
        }
        writeEnvelope(flipped);
        return {
          verify: "throws",
          msg: expectThrow(() => loadConsentLedger(path, loadOptions), "C4 flipAction"),
        };
      }
      case "reorder": {
        if (subjectRecords.length < 2) return { verify: "skip-short" };
        if (action.shape === "bare") return { verify: "skip-bare" };
        writeEnvelope([...subjectRecords].reverse());
        return {
          verify: "throws",
          msg: expectThrow(() => loadConsentLedger(path, loadOptions), "C4 reorder"),
        };
      }
      case "countOff":
        if (action.shape === "bare") return { verify: "skip-bare" };
        writeEnvelope([...subjectRecords], (env) => {
          env.recordCount += 1;
        });
        return {
          verify: "throws",
          msg: expectThrow(() => loadConsentLedger(path, loadOptions), "C4 countOff"),
        };
      case "maxSeqOff":
        if (action.shape === "bare") return { verify: "skip-bare" };
        writeEnvelope([...subjectRecords], (env) => {
          env.maxSeq = (env.maxSeq ?? 0) + 1;
        });
        return {
          verify: "throws",
          msg: expectThrow(() => loadConsentLedger(path, loadOptions), "C4 maxSeqOff"),
        };
      case "shaOff":
        if (action.shape === "bare") return { verify: "skip-bare" };
        writeEnvelope([...subjectRecords], (env) => {
          env.recordsSha256 = sha256(`${env.recordsSha256}x`);
        });
        return {
          verify: "throws",
          msg: expectThrow(() => loadConsentLedger(path, loadOptions), "C4 shaOff"),
        };
      case "foreignSubject": {
        if (action.shape === "bare" || !requiresRecords) return { verify: "skip" };
        const other = SUBJECTS[(action.subject + 1) % SUBJECTS.length]!;
        writeEnvelope(
          [
            ...subjectRecords,
            {
              ...subjectRecords[0]!,
              subjectPseudonym: other,
              seq: seq + 1,
              id: "SYNTHETIC-STRESS.rec-foreign",
            },
          ],
          undefined,
          true,
        );
        return {
          verify: "throws",
          msg: expectThrow(() => loadConsentLedger(path, loadOptions), "C4 foreignSubject"),
        };
      }
      case "malformedRow": {
        const bad = [
          {
            ...subjectRecords[0],
            id: "",
            scope: "everything",
            action: "maybe",
            recordedAtIso: "not-a-date",
          },
        ];
        if (action.shape === "bare") writeFileSync(path, JSON.stringify(bad));
        else writeEnvelope(bad);
        return {
          verify: "throws",
          msg: expectThrow(() => loadConsentLedger(path, loadOptions), "C4 malformedRow"),
        };
      }
      case "staleReplay": {
        if (action.shape === "bare") return { verify: "skip-bare" };
        writeEnvelope([...subjectRecords]);
        const maxSeq = requiresRecords ? subjectRecords[subjectRecords.length - 1]!.seq! : 0;
        return {
          verify: "throws",
          msg: expectThrow(
            () => loadConsentLedger(path, { ...loadOptions, minMaxSeq: maxSeq + 1 }),
            "C4 staleReplay",
          ),
        };
      }
      case "badSignature": {
        if (action.shape !== "v2") return { verify: "skip-not-v2" };
        writeEnvelope([...subjectRecords], (env) => {
          env.signature = { ...env.signature!, value: sha256(env.signature!.value) };
        });
        return {
          verify: "throws",
          msg: expectThrow(() => loadConsentLedger(path, loadOptions), "C4 badSignature"),
        };
      }
      case "keyButUnsigned": {
        // Host has a key; file is bare or v1 → downgrade refused.
        if (action.shape === "bare") writeFileSync(path, JSON.stringify(bareRecords));
        else
          writeEnvelope([...subjectRecords], (env) => {
            env.exportVersion = CONSENT_LEDGER_EXPORT_VERSION;
            delete env.signature;
          });
        return {
          verify: "throws",
          msg: expectThrow(
            () => loadConsentLedger(path, { signingKey: SIGNING_KEY }),
            "C4 keyButUnsigned",
          ),
        };
      }
      case "rehashedV1": {
        if (!requiresRecords) return { verify: "skip-empty" };
        // Drop trailing row, recompute v1 integrity fields: accepted without a key (C5 documented) …
        const truncated = subjectRecords.slice(0, -1);
        const env = envelopeFor(truncated, subject, CONSENT_LEDGER_EXPORT_VERSION, null);
        writeFileSync(path, JSON.stringify(env));
        const loaded = loadConsentLedger(path);
        check(
          loaded.length === truncated.length,
          "C5 v1 rehash accepted (corruption-evident only)",
          () => "",
        );
        // … and refused the moment a signing key is configured.
        return {
          verify: "v1-rehash",
          msg: expectThrow(
            () => loadConsentLedger(path, { signingKey: SIGNING_KEY }),
            "C5 key refuses rehashed v1",
          ),
        };
      }
    }
  });
}

// ─── Campaign B: intakeClip end-to-end ───────────────────────────────────────

type MetaBreak = "none" | "clipId" | "recordedAt" | "cameraView" | "adaptivePlay" | "deviceClass";
type IntakeAction =
  | { kind: "grantBoth"; subject: number }
  | { kind: "withdrawTraining"; subject: number }
  | { kind: "intake"; clip: 0 | 1; subject: number; metaBreak: MetaBreak; tamperLedger: boolean };

function generateIntake(rng: Rng, length: number): IntakeAction[] {
  const actions: IntakeAction[] = [];
  for (let i = 0; i < length; i += 1) {
    const roll = rng.next();
    if (roll < 0.3) actions.push({ kind: "grantBoth", subject: rng.int(SUBJECTS.length) });
    else if (roll < 0.45)
      actions.push({ kind: "withdrawTraining", subject: rng.int(SUBJECTS.length) });
    else
      actions.push({
        kind: "intake",
        clip: rng.bool(0.7) ? 0 : 1,
        subject: rng.int(SUBJECTS.length),
        metaBreak: rng.bool(0.75)
          ? "none"
          : rng.pick(["clipId", "recordedAt", "cameraView", "adaptivePlay", "deviceClass"]),
        tamperLedger: rng.bool(0.1),
      });
  }
  return actions;
}

let clips: [string, string];
let clipOracle: [
  "ACCEPTED" | "ACCEPTED_DEGRADED" | "REJECTED",
  "ACCEPTED" | "ACCEPTED_DEGRADED" | "REJECTED",
];

function makeClip(path: string, size: string, fps: number, seconds: number): void {
  const res = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${size}:rate=${fps}`,
    "-t",
    String(seconds),
    "-pix_fmt",
    "yuv420p",
    "-y",
    path,
  ]);
  if (res.error) throw new Error(`ffmpeg unavailable: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`ffmpeg fixture failed: ${res.stderr.toString()}`);
}

function captureMeta(metaBreak: MetaBreak): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    clipId: "SYNTHETIC-STRESS.clip-01",
    athleteId: "SYNTHETIC-STRESS.athlete-01",
    athleteGroupId: "SYNTHETIC-STRESS.group-01",
    sessionId: "SYNTHETIC-STRESS.session-01",
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
  const capture = meta["capture"] as Record<string, unknown>;
  switch (metaBreak) {
    case "clipId":
      meta["clipId"] = "bad id!";
      break;
    case "recordedAt":
      meta["recordedAt"] = "yesterday";
      break;
    case "cameraView":
      capture["cameraView"] = "drone";
      break;
    case "adaptivePlay":
      capture["adaptivePlay"] = "no";
      break;
    case "deviceClass":
      capture["deviceClass"] = "";
      break;
    case "none":
      break;
  }
  return meta;
}

function executeIntake(actions: readonly IntakeAction[]) {
  const ledger: ConsentRecord[] = [];
  let seq = 0;
  let clock = Date.parse("2026-08-01T00:00:00.000Z");
  const append = (subject: string, scope: ConsentScope, action: "granted" | "withdrawn"): void => {
    seq += 1;
    clock += 1000;
    ledger.push({
      id: `SYNTHETIC-STRESS.rec-${seq}`,
      subjectPseudonym: subject,
      scope,
      action,
      consentVersion: `${scope.replace(/_/g, "-")}-v1`,
      source: "onboarding",
      device: null,
      captureMode: action === "granted" ? "all_captures" : null,
      strokeIntent: null,
      recordedAtIso: new Date(clock).toISOString(),
      seq,
    });
  };

  return executeSteps(actions, (action) => {
    if (action.kind === "grantBoth") {
      append(SUBJECTS[action.subject]!, "video_analysis", "granted");
      append(SUBJECTS[action.subject]!, "model_training", "granted");
      return { grantBoth: action.subject };
    }
    if (action.kind === "withdrawTraining") {
      append(SUBJECTS[action.subject]!, "model_training", "withdrawn");
      return { withdrawTraining: action.subject };
    }
    const subject = SUBJECTS[action.subject]!;
    const ledgerPath = tmpFile("intake-ledger.json");
    const metaPath = tmpFile("intake-meta.json");
    // Bare array (all subjects) — intakeClip's public API takes no signing key.
    const rows = action.tamperLedger
      ? [
          ...ledger,
          {
            id: "",
            subjectPseudonym: subject,
            scope: "video_analysis",
            action: "granted",
            consentVersion: "",
            source: "?",
            recordedAtIso: "x",
          },
        ]
      : ledger;
    writeFileSync(ledgerPath, JSON.stringify(rows));
    writeFileSync(metaPath, JSON.stringify(captureMeta(action.metaBreak)));
    const input = {
      clipPath: clips[action.clip],
      consentLedgerPath: ledgerPath,
      subjectPseudonym: subject,
      captureMetaPath: metaPath,
      operatorId: "SYNTHETIC-STRESS.operator",
    };

    if (action.metaBreak !== "none" || action.tamperLedger) {
      return {
        intake: "throws",
        msg: expectThrow(() => intakeClip(input), "B3 invalid input throws"),
      };
    }
    const record: IntakeRecord = intakeClip(input);
    const consent = modelStatus(ledger, subject);
    const oracle = clipOracle[action.clip];
    const expectedStatus = !consent.ok || oracle === "REJECTED" ? "REJECTED" : oracle;
    check(
      record.status === expectedStatus,
      "B1 status",
      () =>
        `${record.status} != ${expectedStatus} (consent.ok=${consent.ok}, oracle=${oracle}) reasons=${JSON.stringify(record.reasons)}`,
    );
    check(record.consent.ok === consent.ok, "B1 consent", () => JSON.stringify(record.consent));
    check(
      (record.status === "REJECTED") === record.reasons.length > 0,
      "B1 reasons iff rejected",
      () => JSON.stringify(record.reasons),
    );
    check(
      (record.manifestDraft !== null) === (record.status !== "REJECTED"),
      "B2 draft iff accepted",
      () => record.status,
    );
    if (record.manifestDraft !== null) {
      const d = record.manifestDraft;
      check(
        d.rawAsset.sha256 === sha256File(clips[action.clip]) &&
          d.consentReference.ledgerSha256 === sha256File(ledgerPath),
        "B2 sha256 pins",
        () => "",
      );
      check(
        d.clipId === "SYNTHETIC-STRESS.clip-01" &&
          d.consentReference.subjectPseudonym === subject &&
          d.consentReference.modelTrainingConsentVersion === consent.version,
        "B2 identifiers",
        () => JSON.stringify(d.consentReference),
      );
      check(
        d.pendingBeforeSnapshot.length > 0 &&
          d.capture.sourceKind === "consented_first_party_capture",
        "B2 never approved_for_snapshot",
        () => "",
      );
      check(d.rawAsset.frameCount === null || d.rawAsset.frameCount > 0, "B4 frameCount", () =>
        String(d.rawAsset.frameCount),
      );
    }
    const { intakeAtIso: _wallClock, ...deterministic } = record;
    const nonFinite = findNonFinite(deterministic);
    check(nonFinite === null, "B4 finite", () => nonFinite ?? "");
    return {
      intake: record.status,
      envelope: record.envelope?.overall ?? null,
      draft: deterministic.manifestDraft?.rawAsset.frameCount ?? null,
    };
  });
}

const env = readStressEnv(150);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "first-party-intake-stress-"));
  clips = [join(dir, "synthetic-good.mp4"), join(dir, "synthetic-lowres.mp4")];
  makeClip(clips[0], "1280x720", 30, 2);
  makeClip(clips[1], "320x240", 30, 2);
  clipOracle = clips.map((clip) => {
    const verdict = evaluateCaptureEnvelope(measureClip(clip));
    return verdict.overall === "UNSUPPORTED"
      ? "REJECTED"
      : verdict.overall === "DEGRADED"
        ? "ACCEPTED_DEGRADED"
        : "ACCEPTED";
  }) as typeof clipOracle;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("first-party-intake seeded randomized long-run", () => {
  it("consent ledger invariants C1–C6 hold for every seed and every step; same seed → same trace", () => {
    const report = runCampaign<ConsentAction>({
      campaign: "first-party-intake.consent",
      env,
      minLength: 5,
      maxLength: 60,
      generate: generateConsent,
      execute: executeConsent,
    });
    expect(report.sequencesExecuted).toBe(env.iterations);
    expect(describeFailures(report)).toBe("");
    expect(report.broken + report.nondeterministic).toBe(0);
  });

  // ffprobe/ffmpeg per intake call: ~0.2 s. Scaled down from the consent campaign.
  const intakeEnv = { ...env, iterations: Math.max(2, Math.ceil(env.iterations / 50)) };
  // Each sequence runs twice (determinism check), ≤ 8 steps, ≤ ~0.5 s per step worst case.
  const intakeTimeoutMs = Math.max(30_000, intakeEnv.iterations * 2 * 8 * 500);

  it(
    "intakeClip invariants B1–B4 hold end-to-end on synthetic lavfi clips; same seed → same trace",
    { timeout: intakeTimeoutMs },
    () => {
      const report = runCampaign<IntakeAction>({
        campaign: "first-party-intake.intakeClip",
        env: intakeEnv,
        minLength: 5,
        maxLength: 8,
        generate: generateIntake,
        execute: executeIntake,
      });
      expect(clipOracle[1]).toBe("REJECTED");
      expect(report.sequencesExecuted).toBe(intakeEnv.iterations);
      expect(describeFailures(report)).toBe("");
      expect(report.broken + report.nondeterministic).toBe(0);
    },
  );
});
