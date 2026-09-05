// stress-route-post-v1-shots — seeded case generator + reference oracle for
// the POST /v1/shots:sync fuzz/boundary campaign.
//
// Every case is a pure function of its 32-bit seed (`buildCase(seed)`), so a
// row in the results table replays with STRESS_REPLAY=<seed>. The oracle
// (`referenceValidate`) is an independent statement of the wire contract the
// route documents (apps/mobile/src/data/sync.ts ↔ parseSyncShot): a shot is
// either accepted verbatim (projected onto the RPC payload) or rejected with
// `shot.invalid_payload` / `shot.non_real_source`, never both, never silently
// dropped. Differences between the oracle and the handler are what the
// campaign reports.

import { canonicalShot, isRecord, isUuid, Prng, VERSION_VECTOR } from "./stress_shots_sync_harness.ts";

export const MAX_MS = 2_147_483_647;
export const CAMERA_VIEWS = ["side", "rear_oblique"] as const;
export const CHECKPOINT_BANDS = ["green", "yellow", "red", "unscored"] as const;
export const VERSION_VECTOR_KEYS = [
  "appVersion",
  "modelBundleVersion",
  "poseModelVersion",
  "paddleModelVersion",
  "strokeDetectorVersion",
  "phaseModelVersion",
  "scoringModelVersion",
  "shotConfigVersion",
] as const;

/** Statuses apply_synced_shot may return that the route relays verbatim. */
export const KNOWN_RPC_STATUSES = [
  "auth.required",
  "access.permit_not_found",
  "access.permit_not_reserved",
  "access.permit_expired",
  "access.paywall_required",
  "shot.session_not_found",
  "shot.id_conflict",
] as const;

export const canary = (seed: number): string => `STRESS-CANARY-${seed.toString(16)}`;

// ── Reference oracle ─────────────────────────────────────────────────────────

export interface Projection {
  id: string;
  analysisPermitId: string;
  sessionId: string | null;
  shotType: string;
  cameraView: string;
  capturedAt: string;
  startMs: number;
  contactMs: number | null;
  endMs: number;
  overallScore: number | null;
  confidence: number;
  resultKind: string;
  phases: Array<Record<string, unknown>>;
  checkpoints: Array<Record<string, unknown>>;
  versionVector: Record<string, string>;
}

export type Verdict =
  | { ok: true; projection: Projection }
  | { ok: false; id: string; code: "shot.invalid_payload" | "shot.non_real_source" };

const isMs = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_MS;
const isUnit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isBoundedText = (v: unknown, max: number, allowEmpty: boolean): v is string =>
  typeof v === "string" && v.length <= max && (allowEmpty || v.trim().length > 0);

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const ISO_MIN = Date.UTC(2000, 0, 1);
const ISO_MAX = Date.UTC(2100, 0, 1);
export function isIsoUtcInstant(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = ISO_RE.exec(v);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return false;
  }
  return ms >= ISO_MIN && ms < ISO_MAX;
}

export function referenceValidate(raw: unknown): Verdict {
  const id = isRecord(raw) && typeof raw.id === "string" ? raw.id : "unknown";
  const invalid = (): Verdict => ({ ok: false, id, code: "shot.invalid_payload" });
  if (!isRecord(raw)) return invalid();
  if (!isUuid(raw.id)) return invalid();
  if (raw.source !== "real") return { ok: false, id, code: "shot.non_real_source" };
  if (!isUuid(raw.analysisPermitId)) return invalid();
  if (raw.sessionId !== null && !isUuid(raw.sessionId)) return invalid();
  if (!isBoundedText(raw.shotType, 64, false)) return invalid();
  if (typeof raw.cameraView !== "string" || !(CAMERA_VIEWS as readonly string[]).includes(raw.cameraView)) {
    return invalid();
  }
  if (!isIsoUtcInstant(raw.capturedAt)) return invalid();
  const ts = raw.timestamps;
  if (!isRecord(ts) || !isMs(ts.startMs) || !isMs(ts.endMs) || (ts.contactMs !== null && !isMs(ts.contactMs))) {
    return invalid();
  }
  if (raw.resultKind !== "scored" && raw.resultKind !== "low_confidence") return invalid();
  if (raw.resultKind === "scored") {
    const s = raw.overallScore;
    if (typeof s !== "number" || !Number.isFinite(s) || s < 0 || s > 10) return invalid();
  } else if (raw.overallScore !== null) {
    return invalid();
  }
  if (!isUnit(raw.confidence)) return invalid();
  if (!Array.isArray(raw.phases) || raw.phases.length > 32) return invalid();
  const phaseKeys = new Set<string>();
  const phases: Projection["phases"] = [];
  for (const p of raw.phases) {
    if (
      !isRecord(p) ||
      !isBoundedText(p.key, 64, false) ||
      !isMs(p.startMs) ||
      !isMs(p.representativeMs) ||
      !isMs(p.endMs) ||
      !isUnit(p.confidence)
    ) {
      return invalid();
    }
    if (phaseKeys.has(p.key)) return invalid();
    phaseKeys.add(p.key);
    phases.push({
      key: p.key,
      startMs: p.startMs,
      representativeMs: p.representativeMs,
      endMs: p.endMs,
      confidence: p.confidence,
    });
  }
  if (!Array.isArray(raw.checkpoints) || raw.checkpoints.length > 64) return invalid();
  const checkpointKeys = new Set<string>();
  const checkpoints: Projection["checkpoints"] = [];
  for (const c of raw.checkpoints) {
    if (
      !isRecord(c) ||
      !isBoundedText(c.key, 64, false) ||
      !(c.score === null ||
        (typeof c.score === "number" && Number.isFinite(c.score) && c.score >= 0 && c.score <= 100)) ||
      !isUnit(c.confidence) ||
      typeof c.band !== "string" ||
      !(CHECKPOINT_BANDS as readonly string[]).includes(c.band) ||
      !isBoundedText(c.direction, 64, true) ||
      !isUnit(c.severity) ||
      typeof c.applicable !== "boolean"
    ) {
      return invalid();
    }
    if (checkpointKeys.has(c.key)) return invalid();
    checkpointKeys.add(c.key);
    checkpoints.push({
      key: c.key,
      score: c.score,
      confidence: c.confidence,
      band: c.band,
      direction: c.direction,
      severity: c.severity,
      applicable: c.applicable,
    });
  }
  const vv = raw.versionVector;
  if (!isRecord(vv)) return invalid();
  const versionVector: Record<string, string> = {};
  for (const key of VERSION_VECTOR_KEYS) {
    const v = vv[key];
    if (!isBoundedText(v, 64, false)) return invalid();
    versionVector[key] = v;
  }
  return {
    ok: true,
    projection: {
      id: raw.id,
      analysisPermitId: raw.analysisPermitId,
      sessionId: raw.sessionId as string | null,
      shotType: raw.shotType,
      cameraView: raw.cameraView,
      capturedAt: raw.capturedAt as string,
      startMs: ts.startMs,
      contactMs: ts.contactMs as number | null,
      endMs: ts.endMs,
      overallScore: raw.resultKind === "scored" ? (raw.overallScore as number) : null,
      confidence: raw.confidence,
      resultKind: raw.resultKind,
      phases,
      checkpoints,
      versionVector,
    },
  };
}

// ── Value generators (each pool mixes valid and invalid values on purpose;
//    validity is decided by the oracle, never by the label) ─────────────────

function uuidVariant(p: Prng, mark: string): unknown {
  const base = p.uuid();
  return p.weighted<() => unknown>([
    [() => base, 6],
    [() => base.toUpperCase(), 1],
    [() => base.replace(/-4/, "-1"), 1], // version 1 (allowed)
    [() => base.replace(/-4/, "-8"), 1], // version 8 (allowed)
    [() => base.replace(/-4/, "-0"), 1], // version 0 (refused)
    [() => base.replace(/-4/, "-9"), 1],
    [() => base.replace(/-4/, "-f"), 1],
    [() => base.replace(/-([89ab])/, "-c"), 1], // variant bits wrong
    [() => base.replace(/-([89ab])/, "-0"), 1],
    [() => "00000000-0000-0000-0000-000000000000", 1],
    [() => "ffffffff-ffff-ffff-ffff-ffffffffffff", 1],
    [() => `{${base}}`, 1],
    [() => `urn:uuid:${base}`, 1],
    [() => base.replace(/-/g, ""), 1],
    [() => base.slice(0, 35), 1],
    [() => `${base}0`, 1],
    [() => ` ${base}`, 1],
    [() => `${base}\n`, 1],
    [() => base.replace(/[0-9a-f]$/, "g"), 1],
    [() => base.replace(/[0-9a-f]$/, "０"), 1], // fullwidth digit
    [() => `${mark}-${base.slice(mark.length + 1)}`, 1],
    [() => 42, 1],
    [() => null, 1],
    [() => undefined, 1],
    [() => [base], 1],
    [() => ({ id: base }), 1],
    [() => true, 1],
    [() => "", 1],
  ])();
}

function boundedTextVariant(p: Prng, mark: string, max = 64): unknown {
  return p.weighted<() => unknown>([
    [() => p.ascii(p.int(1, max)), 6],
    [() => "x".repeat(max), 2],
    [() => "x".repeat(max + 1), 2],
    [() => "x".repeat(max - 1) + "é", 1], // still max code units
    [() => "x".repeat(max - 1) + "😀", 1], // max+1 code units (surrogate pair)
    [() => "😀".repeat(max / 2), 1], // exactly max code units
    [() => "", 2],
    [() => " ", 1],
    [() => "\t\n\r ", 1],
    [() => "\u200b", 1], // zero-width space (not trimmed by String#trim)
    [() => "\u00a0", 1], // nbsp IS trimmed by String#trim
    [() => ` ${p.ascii(3)} `, 1],
    [() => `a\u0000b`, 1],
    [() => "\udc00lone", 1],
    [() => "a\u202eb", 1], // bidi override
    [() => "x".repeat(p.int(1000, 5000)), 1],
    [() => mark, 2],
    [() => `${mark} ${p.ascii(p.int(1, 20))}`, 1],
    [() => "__proto__", 1],
    [() => "constructor", 1],
    [() => 0, 1],
    [() => 1.5, 1],
    [() => null, 1],
    [() => undefined, 1],
    [() => true, 1],
    [() => ["dink"], 1],
    [() => ({ toString: "dink" }), 1],
    [() => "'; drop table shots; --", 1],
    [() => "<script>alert(1)</script>", 1],
    [() => "${jndi:ldap://x}", 1],
  ])();
}

function isoVariant(p: Prng): unknown {
  const y = p.int(1990, 2110);
  const mo = p.int(0, 13);
  const d = p.int(0, 32);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const rnd = `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(p.int(0, 24))}:${pad(p.int(0, 60))}:${pad(p.int(0, 61))}${
    p.chance(0.5) ? `.${String(p.int(0, 999999999)).padStart(p.int(1, 9), "0").slice(0, 9)}` : ""
  }Z`;
  return p.weighted<() => unknown>([
    [() => "2026-09-01T10:00:00.000Z", 6],
    [() => rnd, 8],
    [() => "2000-01-01T00:00:00Z", 1],
    [() => "1999-12-31T23:59:59.999Z", 1],
    [() => "2099-12-31T23:59:59.999999999Z", 1],
    [() => "2100-01-01T00:00:00Z", 1],
    [() => "2024-02-29T12:00:00Z", 1],
    [() => "2023-02-29T12:00:00Z", 1],
    [() => "2026-02-30T12:00:00Z", 1],
    [() => "2026-09-31T00:00:00Z", 1],
    [() => "2026-06-30T23:59:60Z", 1],
    [() => "2026-09-01T24:00:00Z", 1],
    [() => "2026-09-01T10:00:00+00:00", 1],
    [() => "2026-09-01T10:00:00.0000000000Z", 1],
    [() => "2026-09-01T10:00:00.Z", 1],
    [() => "2026-09-01 10:00:00Z", 1],
    [() => "2026-09-01T10:00:00z", 1],
    [() => "2026-9-1T10:00:00Z", 1],
    [() => "2026-09-01T10:00:00", 1],
    [() => "2026-09-01", 1],
    [() => "Jan 1 2026 (anything)", 1],
    [() => "0000-01-01T00:00:00Z", 1],
    [() => "9999-12-31T23:59:59Z", 1],
    [() => "+02026-09-01T10:00:00Z", 1],
    [() => "２０２６-09-01T10:00:00Z", 1],
    [() => 1_756_720_800_000, 1],
    [() => "", 1],
    [() => null, 1],
    [() => undefined, 1],
    [() => ({ $date: "2026-09-01T10:00:00.000Z" }), 1],
  ])();
}

function msVariant(p: Prng): unknown {
  return p.weighted<() => unknown>([
    [() => p.int(0, 60_000), 8],
    [() => 0, 2],
    [() => -0, 1],
    [() => MAX_MS, 2],
    [() => MAX_MS + 1, 2],
    [() => -1, 2],
    [() => 1.5, 2],
    [() => 1e10, 1],
    [() => 1e21, 1],
    [() => 5e-324, 1],
    [() => Number.MAX_SAFE_INTEGER, 1],
    [() => "100", 1],
    [() => "0x10", 1],
    [() => null, 2],
    [() => undefined, 2],
    [() => true, 1],
    [() => [100], 1],
    [() => ({}), 1],
  ])();
}

function unitVariant(p: Prng): unknown {
  return p.weighted<() => unknown>([
    [() => p.next(), 8],
    [() => 0, 2],
    [() => 1, 2],
    [() => -0, 1],
    [() => 1.0000000000000002, 1],
    [() => -1e-300, 1],
    [() => 1e-300, 1],
    [() => -0.1, 1],
    [() => 1.1, 1],
    [() => 2, 1],
    [() => 1e308, 1],
    [() => "0.5", 1],
    [() => null, 1],
    [() => undefined, 1],
    [() => false, 1],
    [() => [0.5], 1],
  ])();
}

function scoreVariant(p: Prng): unknown {
  return p.weighted<() => unknown>([
    [() => Math.round(p.next() * 100) / 10, 8],
    [() => 0, 2],
    [() => 10, 2],
    [() => -0, 1],
    [() => 10.000000000000002, 1],
    [() => 9.999999, 1],
    [() => -0.0001, 1],
    [() => 10.0001, 1],
    [() => 100, 1],
    [() => 1e308, 1],
    [() => "7", 1],
    [() => null, 3],
    [() => undefined, 2],
    [() => true, 1],
  ])();
}

function phaseVariant(p: Prng, mark: string, key: string): unknown {
  const valid = {
    key,
    startMs: p.int(0, 1000),
    representativeMs: p.int(0, 1000),
    endMs: p.int(0, 1000),
    confidence: Math.round(p.next() * 1000) / 1000,
  };
  return p.weighted<() => unknown>([
    [() => valid, 10],
    [() => ({ ...valid, key: boundedTextVariant(p, mark) }), 2],
    [() => ({ ...valid, startMs: msVariant(p) }), 1],
    [() => ({ ...valid, representativeMs: msVariant(p) }), 1],
    [() => ({ ...valid, endMs: msVariant(p) }), 1],
    [() => ({ ...valid, confidence: unitVariant(p) }), 1],
    [() => ({ ...valid, extra: mark }), 1],
    [() => {
      const { confidence: _c, ...rest } = valid;
      return rest;
    }, 1],
    [() => null, 1],
    [() => key, 1],
    [() => [valid], 1],
    [() => 7, 1],
  ])();
}

function checkpointVariant(p: Prng, mark: string, key: string): unknown {
  const valid = {
    key,
    score: p.chance(0.2) ? null : Math.round(p.next() * 1000) / 10,
    confidence: Math.round(p.next() * 1000) / 1000,
    band: p.pick(CHECKPOINT_BANDS),
    direction: p.pick(["", "up", "down", "keep the paddle up", p.ascii(64)]),
    severity: Math.round(p.next() * 1000) / 1000,
    applicable: p.chance(0.8),
  };
  return p.weighted<() => unknown>([
    [() => valid, 10],
    [() => ({ ...valid, key: boundedTextVariant(p, mark) }), 2],
    [() => ({ ...valid, score: p.pick([-1, 100, 100.001, 101, "50", 0, 1e308, -0]) }), 2],
    [() => ({ ...valid, confidence: unitVariant(p) }), 1],
    [() => ({ ...valid, band: p.pick(["Green", "", "amber", null, 1, "unscored", "red "]) }), 2],
    [() => ({ ...valid, direction: boundedTextVariant(p, mark) }), 2],
    [() => ({ ...valid, severity: unitVariant(p) }), 1],
    [() => ({ ...valid, applicable: p.pick(["true", 1, null, 0, "false"]) }), 2],
    [() => {
      const { direction: _d, ...rest } = valid;
      return rest;
    }, 1],
    [() => null, 1],
    [() => key, 1],
  ])();
}

function timestampsVariant(p: Prng): unknown {
  const start = p.int(0, 1000);
  return p.weighted<() => unknown>([
    [() => ({ startMs: start, contactMs: start + 100, endMs: start + 200 }), 6],
    [() => ({ startMs: start, contactMs: null, endMs: start + 200 }), 2],
    [() => ({ startMs: start + 200, contactMs: start + 100, endMs: start }), 1], // reversed order (parser does not check)
    [() => ({ startMs: msVariant(p), contactMs: msVariant(p), endMs: msVariant(p) }), 6],
    [() => ({ startMs: start, endMs: start + 200 }), 2], // contactMs missing
    [() => ({ startMs: start, contactMs: "null", endMs: start + 200 }), 1],
    [() => ({ startMs: MAX_MS, contactMs: MAX_MS, endMs: MAX_MS }), 1],
    [() => [start, start + 100, start + 200], 1],
    [() => null, 1],
    [() => undefined, 1],
    [() => "0,100,200", 1],
    [() => ({}), 1],
  ])();
}

function versionVectorVariant(p: Prng, mark: string): unknown {
  const key = p.pick(VERSION_VECTOR_KEYS);
  return p.weighted<() => unknown>([
    [() => ({ ...VERSION_VECTOR }), 4],
    [() => ({ ...VERSION_VECTOR, [key]: boundedTextVariant(p, mark) }), 8],
    [() => {
      const copy: Record<string, unknown> = { ...VERSION_VECTOR };
      delete copy[key];
      return copy;
    }, 2],
    [() => ({ ...VERSION_VECTOR, extraKey: mark }), 1],
    [() => ({ ...VERSION_VECTOR, [key]: "x".repeat(64) }), 1],
    [() => ({ ...VERSION_VECTOR, [key]: "x".repeat(65) }), 1],
    [() => Object.fromEntries(VERSION_VECTOR_KEYS.map((k) => [k, mark])), 1],
    [() => [VERSION_VECTOR.appVersion], 1],
    [() => "1.0.0", 1],
    [() => null, 1],
    [() => undefined, 1],
    [() => ({}), 1],
  ])();
}

export interface GeneratedShot {
  raw: unknown;
  mutations: string[];
}

/** One shot: canonical, or the canonical shot with 1–3 fields perturbed. */
export function generateShot(p: Prng, mark: string, forceValid = false): GeneratedShot {
  const id = p.uuid();
  const permit = p.uuid();
  const shot = canonicalShot(id, permit);
  if (forceValid || p.chance(0.3)) {
    // Valid, but exercise the valid envelope too: some phases/checkpoints,
    // a low_confidence abstention, a session id.
    if (p.chance(0.4)) {
      shot.phases = Array.from({ length: p.int(0, 4) }, (_, i) => ({
        key: `phase-${i}`,
        startMs: i * 100,
        representativeMs: i * 100 + 50,
        endMs: i * 100 + 100,
        confidence: 0.5,
      }));
    }
    if (p.chance(0.4)) {
      shot.checkpoints = Array.from({ length: p.int(0, 4) }, (_, i) => ({
        key: `cp-${i}`,
        score: i % 3 === 0 ? null : 50,
        confidence: 0.7,
        band: CHECKPOINT_BANDS[i % 4],
        direction: i % 2 === 0 ? "" : "up",
        severity: 0.25,
        applicable: i % 2 === 0,
      }));
    }
    if (p.chance(0.3)) {
      shot.resultKind = "low_confidence";
      shot.overallScore = null;
    }
    if (p.chance(0.3)) shot.sessionId = p.uuid();
    return { raw: shot, mutations: ["valid"] };
  }
  const mutations: string[] = [];
  const count = p.weighted([[1, 6], [2, 3], [3, 1]]);
  const fields = [
    "id",
    "source",
    "analysisPermitId",
    "sessionId",
    "shotType",
    "cameraView",
    "capturedAt",
    "timestamps",
    "resultKind",
    "overallScore",
    "confidence",
    "phases",
    "checkpoints",
    "versionVector",
    "extra",
    "delete",
    "whole",
  ] as const;
  for (let i = 0; i < count; i++) {
    const field = p.pick(fields);
    mutations.push(field);
    switch (field) {
      case "id":
        shot.id = uuidVariant(p, mark);
        break;
      case "analysisPermitId":
        shot.analysisPermitId = uuidVariant(p, mark);
        break;
      case "sessionId":
        shot.sessionId = p.chance(0.3) ? null : uuidVariant(p, mark);
        break;
      case "source":
        shot.source = p.pick(["real", "REAL", "synthetic", "fixture", "", null, undefined, 1, ["real"], " real"]);
        break;
      case "shotType":
        shot.shotType = boundedTextVariant(p, mark);
        break;
      case "cameraView":
        shot.cameraView = p.pick(["side", "rear_oblique", "Side", "front", "rear-oblique", "", null, undefined, 0, [
          "side",
        ]]);
        break;
      case "capturedAt":
        shot.capturedAt = isoVariant(p);
        break;
      case "timestamps":
        shot.timestamps = timestampsVariant(p);
        break;
      case "resultKind":
        shot.resultKind = p.pick(["scored", "low_confidence", "Scored", "lowConfidence", "", null, undefined, 1]);
        if (p.chance(0.5)) shot.overallScore = shot.resultKind === "low_confidence" ? null : 7;
        break;
      case "overallScore":
        shot.overallScore = scoreVariant(p);
        break;
      case "confidence":
        shot.confidence = unitVariant(p);
        break;
      case "phases": {
        const n = p.weighted([[p.int(0, 5), 6], [32, 2], [33, 2], [p.int(34, 200), 1]]);
        const dup = p.chance(0.15);
        shot.phases = p.chance(0.1)
          ? p.pick([null, undefined, {}, "[]", 3])
          : Array.from({ length: n }, (_, i) => phaseVariant(p, mark, dup && i > 0 ? "phase-0" : `phase-${i}`));
        break;
      }
      case "checkpoints": {
        const n = p.weighted([[p.int(0, 6), 6], [64, 2], [65, 2], [p.int(66, 300), 1]]);
        const dup = p.chance(0.15);
        shot.checkpoints = p.chance(0.1)
          ? p.pick([null, undefined, {}, "[]", 3])
          : Array.from({ length: n }, (_, i) => checkpointVariant(p, mark, dup && i > 0 ? "cp-0" : `cp-${i}`));
        break;
      }
      case "versionVector":
        shot.versionVector = versionVectorVariant(p, mark);
        break;
      case "extra":
        // defineProperty so "__proto__" becomes an own key on the wire
        // rather than re-pointing the prototype of the generator's object.
        Object.defineProperty(
          shot,
          p.pick(["__proto__", "constructor", "userId", "user_id", "overall_score", "favorite", mark]),
          {
            value: p.pick([mark, { polluted: true }, 1, null]),
            enumerable: true,
            configurable: true,
            writable: true,
          },
        );
        break;
      case "delete": {
        const key = p.pick(Object.keys(shot));
        delete shot[key];
        mutations.push(`delete:${key}`);
        break;
      }
      case "whole":
        return {
          raw: p.pick([null, 1, "shot", [shot], true, [], "", { id }, { ...shot, id: undefined }]),
          mutations: ["whole"],
        };
    }
  }
  // `undefined` values vanish in JSON; the oracle sees exactly the wire shape.
  return { raw: JSON.parse(JSON.stringify(shot)), mutations };
}

// ── Cases ────────────────────────────────────────────────────────────────────

export type Category =
  | "batch"
  | "rpc-status"
  | "replay"
  | "body-shape"
  | "envelope-method"
  | "envelope-path"
  | "envelope-auth"
  | "envelope-headers"
  | "query-string"
  | "upstream-fault"
  | "burst"
  | "body-size";

export interface BatchOracle {
  /** In request order: ids the route must acknowledge as accepted. */
  accepted: string[];
  /** In request order: parse-stage rejections. */
  rejected: Array<{ id: string; code: string }>;
  /** RPC payloads expected, in order (one per parse-valid, non-replay shot). */
  rpcShots: Projection[];
  replayIds: string[];
}

export type RpcPlan =
  | { kind: "accept" }
  | { kind: "status"; status: string; expectCode: string }
  | { kind: "http-error"; status: number; body: unknown }
  | { kind: "json"; data: unknown; expectCode: string };

export type Expectation =
  /** Envelope rejection: status ∈ statuses, no PostgREST traffic at all. */
  | { kind: "reject"; statuses: number[] }
  /** Must be 200 and match the oracle exactly. */
  | { kind: "batch"; oracle: BatchOracle; rpc: RpcPlan }
  /** Either 200 (then the oracle must hold) or one of `statuses` with no
   * PostgREST traffic — used where the contract admits both outcomes (path
   * spellings, unverifiable bearers, content-type policing). */
  | { kind: "maybe"; statuses: number[]; oracle: BatchOracle }
  | { kind: "upstream-fault"; statuses: number[] }
  | { kind: "burst"; limit: number };

export interface FuzzCase {
  seed: number;
  category: Category;
  label: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
  /** For the results table (the body itself replays from the seed). */
  bodyPreview: string;
  bodyBytes: number;
  sub: string;
  ip: string;
  /** Valid client x-request-id the response must echo (if any). */
  requestIdSent: string | null;
  requestIdWellFormed: boolean;
  /** Shots the backend already holds for `sub` before the request. */
  existingShots: string[];
  /** Lookup fault (upstream-fault category). */
  lookupFault: { status: number; body: string } | "throw" | null;
  expectation: Expectation;
  mark: string;
}

const EDGE = "http://edge.stress.test";
const ROUTE = "/v1/shots:sync";

function baseHeaders(p: Prng, sub: string, ip: string): Record<string, string> {
  return {
    Authorization: `Bearer ${fakeGoogleIdToken(p, sub)}`,
    "x-forwarded-for": ip,
    "Content-Type": "application/json",
  };
}

function fakeGoogleIdToken(p: Prng, sub: string): string {
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: p.ascii(8) }));
  const payload = b64(
    JSON.stringify({ iss: "https://accounts.google.com", sub, exp: Math.floor(Date.now() / 1000) + 3600, iat: 1 }),
  );
  return `${header}.${payload}.${b64(p.ascii(16))}`;
}

const b64 = (value: string): string => btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function oracleFor(shots: unknown[], existing: string[], rpc: RpcPlan): BatchOracle {
  const accepted: string[] = [];
  const rejected: Array<{ id: string; code: string }> = [];
  const rpcShots: Projection[] = [];
  const replayIds: string[] = [];
  const existingSet = new Set(existing);
  const verdicts = shots.map(referenceValidate);
  for (const v of verdicts) if (!v.ok) rejected.push({ id: v.id, code: v.code });
  for (const v of verdicts) {
    if (!v.ok) continue;
    if (existingSet.has(v.projection.id)) {
      accepted.push(v.projection.id);
      replayIds.push(v.projection.id);
      continue;
    }
    rpcShots.push(v.projection);
    if (rpc.kind === "accept") accepted.push(v.projection.id);
    else if (rpc.kind === "status") rejected.push({ id: v.projection.id, code: rpc.expectCode });
    else if (rpc.kind === "json") rejected.push({ id: v.projection.id, code: rpc.expectCode });
    else rejected.push({ id: v.projection.id, code: "shot.write_failed" });
  }
  return { accepted, rejected, rpcShots, replayIds };
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function preview(body: string | Uint8Array | undefined): { preview: string; bytes: number } {
  if (body === undefined) return { preview: "<none>", bytes: 0 };
  if (typeof body === "string") {
    return {
      preview: body.length > 400 ? `${body.slice(0, 400)}…(+${body.length - 400} chars)` : body,
      bytes: encode(body).byteLength,
    };
  }
  return { preview: `<${body.byteLength} raw bytes>`, bytes: body.byteLength };
}

function generateBatch(p: Prng, mark: string, options: { size?: number; forceValid?: boolean } = {}): unknown[] {
  const size = options.size ?? p.weighted([[1, 5], [p.int(2, 8), 5], [p.int(9, 40), 1], [200, 1]]);
  const shots: unknown[] = [];
  for (let i = 0; i < size; i++) shots.push(generateShot(p, mark, options.forceValid).raw);
  if (p.chance(0.08) && shots.length > 1) shots[shots.length - 1] = shots[0]; // same id twice in one batch
  return shots;
}

const CATEGORY_WEIGHTS: ReadonlyArray<readonly [Category, number]> = [
  ["batch", 34],
  ["rpc-status", 8],
  ["replay", 6],
  ["body-shape", 14],
  ["envelope-method", 4],
  ["envelope-path", 7],
  ["envelope-auth", 10],
  ["envelope-headers", 10],
  ["query-string", 3],
  ["upstream-fault", 2],
  ["burst", 1],
  ["body-size", 1],
];

export function buildCase(seed: number): FuzzCase {
  const p = new Prng(seed);
  const mark = canary(seed);
  const sub = p.uuid();
  const ip = p.ip();
  const category = p.weighted(CATEGORY_WEIGHTS);
  const headers = baseHeaders(p, sub, ip);
  const base: Omit<FuzzCase, "label" | "method" | "url" | "body" | "bodyPreview" | "bodyBytes" | "expectation"> = {
    seed,
    category,
    headers,
    sub,
    ip,
    requestIdSent: null,
    requestIdWellFormed: false,
    existingShots: [],
    lookupFault: null,
    mark,
  };
  const finish = (
    partial: Omit<FuzzCase, "bodyPreview" | "bodyBytes">,
  ): FuzzCase => {
    const pv = preview(partial.body);
    return { ...partial, bodyPreview: pv.preview, bodyBytes: pv.bytes };
  };
  const url = `${EDGE}/functions/v1/api${ROUTE}`;

  switch (category) {
    case "batch": {
      const shots = generateBatch(p, mark);
      const body = JSON.stringify({ shots });
      return finish({
        ...base,
        label: `batch of ${shots.length}`,
        method: "POST",
        url,
        body,
        expectation: { kind: "batch", oracle: oracleFor(shots, [], { kind: "accept" }), rpc: { kind: "accept" } },
      });
    }
    case "rpc-status": {
      const shots = generateBatch(p, mark, { size: p.int(1, 4), forceValid: true });
      const rpc: RpcPlan = p.weighted<() => RpcPlan>([
        [() => {
          const status = p.pick(KNOWN_RPC_STATUSES);
          return { kind: "status", status, expectCode: status };
        }, 6],
        [
          () => ({
            kind: "status",
            status: `shot.write_failed:${p.pick(["23514", "22003", "22P05", "P0001", "XX000"])}`,
            expectCode: "shot.write_failed",
          }),
          3,
        ],
        [
          () => ({
            kind: "status",
            status: p.pick([
              "",
              "ACCEPTED",
              "accepted ",
              "Accepted",
              "rejected",
              mark,
              "a".repeat(5000),
              "line\nbreak",
              "\u0000\u0001",
              "access.PAYWALL_REQUIRED",
            ]),
            expectCode: "shot.write_failed",
          }),
          4,
        ],
        [
          () => ({
            kind: "http-error",
            status: p.pick([400, 401, 403, 404, 409, 500, 502, 503, 504]),
            body: { code: "PGRST" + p.int(100, 399), message: `${mark} upstream detail`, details: null, hint: null },
          }),
          3,
        ],
        [() => ({ kind: "http-error", status: p.pick([500, 502]), body: "<html>gateway</html>" }), 1],
        [
          () => ({
            kind: "json",
            data: p.pick([null, 0, 1, true, false, {}, { status: "accepted" }, ""]),
            expectCode: "shot.write_failed",
          }),
          3,
        ],
      ])();
      const body = JSON.stringify({ shots });
      return finish({
        ...base,
        label: `rpc ${rpc.kind}${
          rpc.kind === "status"
            ? ` ${JSON.stringify(rpc.status).slice(0, 40)}`
            : rpc.kind === "http-error"
            ? ` ${rpc.status}`
            : ""
        }`,
        method: "POST",
        url,
        body,
        expectation: { kind: "batch", oracle: oracleFor(shots, [], rpc), rpc },
      });
    }
    case "replay": {
      const shots = generateBatch(p, mark, { size: p.int(1, 6) });
      const ids = shots.filter((s): s is Record<string, unknown> => isRecord(s) && typeof s.id === "string").map((s) =>
        s.id as string
      );
      const existing = ids.filter(() => p.chance(0.6));
      if (p.chance(0.3)) existing.push(p.uuid()); // unrelated row for the same user
      const body = JSON.stringify({ shots });
      return finish({
        ...base,
        label: `replay ${existing.length}/${shots.length}`,
        method: "POST",
        url,
        body,
        existingShots: existing,
        expectation: { kind: "batch", oracle: oracleFor(shots, existing, { kind: "accept" }), rpc: { kind: "accept" } },
      });
    }
    case "body-shape": {
      const valid = generateBatch(p, mark, { size: 1, forceValid: true });
      const variants: Array<[string, string | Uint8Array, Expectation]> = [
        ["empty", "", { kind: "reject", statuses: [400] }],
        ["whitespace", " \n\t ", { kind: "reject", statuses: [400] }],
        ["null", "null", { kind: "reject", statuses: [400] }],
        ["array", "[]", { kind: "reject", statuses: [400] }],
        ["array-of-shots", JSON.stringify(valid), { kind: "reject", statuses: [400] }],
        ["number", "1", { kind: "reject", statuses: [400] }],
        ["string", '"shots"', { kind: "reject", statuses: [400] }],
        ["truncated", '{"shots":[{"id":', { kind: "reject", statuses: [400] }],
        ["trailing-garbage", `${JSON.stringify({ shots: valid })}garbage`, { kind: "reject", statuses: [400] }],
        ["trailing-comma", '{"shots":[],}', { kind: "reject", statuses: [400] }],
        ["single-quotes", "{'shots':[]}", { kind: "reject", statuses: [400] }],
        ["NaN-literal", '{"shots":[NaN]}', { kind: "reject", statuses: [400] }],
        // TextDecoder (ignoreBOM:false) consumes a leading BOM, so a BOM'd body
        // may parse; either outcome is contract-safe.
        ["bom-prefixed", `\ufeff${JSON.stringify({ shots: valid })}`, {
          kind: "maybe",
          statuses: [400],
          oracle: oracleFor(valid, [], { kind: "accept" }),
        }],
        ["shots-missing", "{}", { kind: "reject", statuses: [400] }],
        ["shots-null", '{"shots":null}', { kind: "reject", statuses: [400] }],
        ["shots-object", '{"shots":{"0":{}}}', { kind: "reject", statuses: [400] }],
        ["shots-string", '{"shots":"[]"}', { kind: "reject", statuses: [400] }],
        ["shots-empty", '{"shots":[]}', { kind: "reject", statuses: [400] }],
        ["shots-201", JSON.stringify({ shots: Array.from({ length: 201 }, () => valid[0]) }), {
          kind: "reject",
          statuses: [400],
        }],
        ["shots-1000-nulls", JSON.stringify({ shots: Array.from({ length: 1000 }, () => null) }), {
          kind: "reject",
          statuses: [400],
        }],
        ["Shots-capitalised", JSON.stringify({ Shots: valid }), { kind: "reject", statuses: [400] }],
        ["shots-nested", JSON.stringify({ body: { shots: valid } }), { kind: "reject", statuses: [400] }],
        ["deep-nesting", "[".repeat(100_000), { kind: "reject", statuses: [400] }],
        ["deep-nesting-objects", `${'{"a":'.repeat(50_000)}1${"}".repeat(50_000)}`, {
          kind: "reject",
          statuses: [400],
        }],
        ["random-bytes", Uint8Array.from({ length: p.int(1, 2048) }, () => p.int(0, 255)), {
          kind: "reject",
          statuses: [400],
        }],
        ["invalid-utf8", new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]), {
          kind: "reject",
          statuses: [400],
        }],
        [
          "utf16-encoded",
          Uint8Array.from(Array.from(encode(JSON.stringify({ shots: valid }))).flatMap((b) => [b, 0])),
          { kind: "reject", statuses: [400] },
        ],
        [
          "huge-string-field",
          JSON.stringify({ shots: [{ ...(valid[0] as Record<string, unknown>), shotType: "x".repeat(1_000_000) }] }),
          {
            kind: "batch",
            oracle: oracleFor([{ ...(valid[0] as Record<string, unknown>), shotType: "x".repeat(1_000_000) }], [], {
              kind: "accept",
            }),
            rpc: { kind: "accept" },
          },
        ],
        [
          "shots-200-valid",
          JSON.stringify({ shots: Array.from({ length: 200 }, () => generateShot(p, mark, true).raw) }),
          null as unknown as Expectation,
        ],
        [
          "shots-with-primitives",
          JSON.stringify({ shots: [1, "two", null, true, [], {}, valid[0]] }),
          null as unknown as Expectation,
        ],
        [
          "proto-pollution",
          `{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}},"shots":${JSON.stringify(valid)}}`,
          null as unknown as Expectation,
        ],
        ["duplicate-keys", `{"shots":[],"shots":${JSON.stringify(valid)}}`, null as unknown as Expectation],
        [
          "unicode-escapes",
          JSON.stringify({
            shots: [{ ...(valid[0] as Record<string, unknown>), shotType: "\u0000\u0001\ud83d\ude00" }],
          }),
          null as unknown as Expectation,
        ],
        [
          "lone-surrogate",
          `{"shots":[${JSON.stringify(valid[0]).replace('"shotType":"dink"', '"shotType":"\\udc00x"')}]}`,
          null as unknown as Expectation,
        ],
      ];
      const [label, body, given] = p.pick(variants);
      let expectation = given;
      if (!expectation) {
        // Oracle-derived expectation for shapes that still reach the batch.
        const parsed = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body)) as {
          shots: unknown[];
        };
        expectation = {
          kind: "batch",
          oracle: oracleFor(parsed.shots, [], { kind: "accept" }),
          rpc: { kind: "accept" },
        };
      }
      return finish({ ...base, label: `body ${label}`, method: "POST", url, body, expectation });
    }
    case "envelope-method": {
      const method = p.pick(["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "post", "Post", "PROPFIND", "PURGE"]);
      const bodyAllowed = !["GET", "HEAD"].includes(method.toUpperCase());
      const shots = generateBatch(p, mark, { size: 1, forceValid: true });
      const normalised = method.toUpperCase();
      const isPost = normalised === "POST";
      return finish({
        ...base,
        label: `method ${method}`,
        method,
        url,
        body: bodyAllowed ? JSON.stringify({ shots }) : undefined,
        expectation: isPost
          ? { kind: "batch", oracle: oracleFor(shots, [], { kind: "accept" }), rpc: { kind: "accept" } }
          : { kind: "reject", statuses: [404, 405] },
      });
    }
    case "envelope-path": {
      const shots = generateBatch(p, mark, { size: 1, forceValid: true });
      const oracle = oracleFor(shots, [], { kind: "accept" });
      const variant = p.pick<[string, string]>([
        ["mount-api", `${EDGE}/api${ROUTE}`],
        ["mount-bare", `${EDGE}${ROUTE}`],
        ["mount-nested-v1", `${EDGE}/v1${ROUTE}`],
        ["mount-random-prefix", `${EDGE}/${p.ascii(p.int(1, 30)).replace(/[/?#%\\]/g, "a")}${ROUTE}`],
        ["trailing-slash", `${url}/`],
        ["double-slash", `${EDGE}/functions/v1/api/v1//shots:sync`],
        ["percent-colon", `${EDGE}/functions/v1/api/v1/shots%3Async`],
        ["uppercase", `${EDGE}/functions/v1/api/v1/SHOTS:sync`],
        ["no-suffix", `${EDGE}/functions/v1/api/v1/shots`],
        ["other-suffix", `${EDGE}/functions/v1/api/v1/shots:bulk`],
        ["dot-segments", `${EDGE}/functions/v1/api/v1/drills/../shots:sync`],
        ["encoded-dot-segments", `${EDGE}/functions/v1/api/v1/%2e%2e/shots:sync`],
        ["v2", `${EDGE}/functions/v1/api/v2/shots:sync`],
        ["fragment", `${url}#frag`],
        ["nul-byte", `${url}%00`],
        ["unicode", `${EDGE}/functions/v1/api/v1/shots:sync\u2028`],
        ["long-path", `${url}/${"a".repeat(p.int(1000, 20_000))}`],
        ["bad-percent", `${url}%E0%A4%A`],
        ["backslash", `${EDGE}/functions/v1/api/v1\\shots:sync`],
        ["param-route-shape", `${EDGE}/functions/v1/api/v1/sessions/${encodeURIComponent(mark)}%/finalize`],
        ["mark-in-path", `${EDGE}/functions/v1/api/v1/${mark}/shots:sync`],
        ["healthz-suffix-post", `${EDGE}/functions/v1/api/v1/shots:sync/healthz`],
      ]);
      return finish({
        ...base,
        label: `path ${variant[0]}`,
        method: "POST",
        url: variant[1],
        body: JSON.stringify({ shots }),
        expectation: { kind: "maybe", statuses: [400, 404, 405], oracle },
      });
    }
    case "envelope-auth": {
      const shots = generateBatch(p, mark, { size: 1, forceValid: true });
      const oracle = oracleFor(shots, [], { kind: "accept" });
      const now = Math.floor(Date.now() / 1000);
      const jwt = (payload: unknown, header: unknown = { alg: "RS256", typ: "JWT" }) =>
        `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}.sig`;
      const google = { iss: "https://accounts.google.com", sub, exp: now + 3600 };
      const variant = p.pick<[string, string | null]>([
        ["missing", null],
        ["empty", ""],
        ["bearer-no-token", "Bearer "],
        ["bearer-no-space", "Bearer"],
        ["lowercase-scheme", `bearer ${jwt(google)}`],
        ["basic", `Basic ${b64("user:pass")}`],
        ["garbage", p.ascii(p.int(1, 200))],
        ["two-segments", `Bearer ${b64("{}")}.${b64(JSON.stringify(google))}`],
        ["four-segments", `Bearer ${jwt(google)}.extra`],
        ["payload-not-base64", "Bearer a.!!!.c"],
        ["payload-not-json", `Bearer a.${b64("not json")}.c`],
        ["payload-array", `Bearer a.${b64("[]")}.c`],
        ["payload-null", `Bearer a.${b64("null")}.c`],
        ["payload-number", `Bearer a.${b64("42")}.c`],
        ["payload-string", `Bearer a.${b64('"iss"')}.c`],
        ["iss-missing", `Bearer ${jwt({ sub, exp: now + 3600 })}`],
        ["iss-number", `Bearer ${jwt({ ...google, iss: 1 })}`],
        ["iss-trailing-slash", `Bearer ${jwt({ ...google, iss: "https://accounts.google.com/" })}`],
        ["iss-http", `Bearer ${jwt({ ...google, iss: "http://accounts.google.com" })}`],
        ["iss-no-scheme", `Bearer ${jwt({ ...google, iss: "accounts.google.com" })}`],
        ["iss-uppercase", `Bearer ${jwt({ ...google, iss: "https://ACCOUNTS.GOOGLE.COM" })}`],
        ["iss-lookalike", `Bearer ${jwt({ ...google, iss: "https://accounts.google.com.evil.test" })}`],
        ["iss-apple", `Bearer ${jwt({ ...google, iss: "https://appleid.apple.com" })}`],
        [
          "iss-supabase-other-host",
          `Bearer ${jwt({ ...google, iss: "https://evil.test/auth/v1", session_id: p.uuid() })}`,
        ],
        [
          "iss-supabase-unknown-session",
          `Bearer ${jwt({ iss: "http://supabase.stress.test/auth/v1", sub, exp: now + 3600, session_id: p.uuid() })}`,
        ],
        [
          "iss-supabase-no-sub",
          `Bearer ${jwt({ iss: "http://supabase.stress.test/auth/v1", exp: now + 3600, session_id: p.uuid() })}`,
        ],
        ["exp-expired", `Bearer ${jwt({ ...google, exp: now - 1 })}`],
        ["exp-zero", `Bearer ${jwt({ ...google, exp: 0 })}`],
        ["exp-negative", `Bearer ${jwt({ ...google, exp: -1 })}`],
        ["exp-string", `Bearer ${jwt({ ...google, exp: String(now + 3600) })}`],
        ["exp-huge", `Bearer ${jwt({ ...google, exp: 1e300 })}`],
        ["exp-missing", `Bearer ${jwt({ iss: google.iss, sub })}`],
        ["exp-ms-not-s", `Bearer ${jwt({ ...google, exp: (now + 3600) * 1000 })}`],
        ["sub-missing", `Bearer ${jwt({ iss: google.iss, exp: now + 3600 })}`],
        ["sub-empty", `Bearer ${jwt({ ...google, sub: "" })}`],
        ["sub-number", `Bearer ${jwt({ ...google, sub: 12345 })}`],
        ["sub-huge", `Bearer ${jwt({ ...google, sub: "s".repeat(10_000) })}`],
        ["sub-canary", `Bearer ${jwt({ ...google, sub: mark })}`],
        ["alg-none", `Bearer ${jwt(google, { alg: "none" })}`],
        ["header-not-json", `Bearer ${b64("nope")}.${b64(JSON.stringify(google))}.sig`],
        ["whitespace-around", `Bearer   ${jwt(google)}   `],
        ["latin1-bytes", `Bearer ${jwt(google)}\u00e9\u00ff`],
        ["very-long", `Bearer ${jwt({ ...google, pad: "p".repeat(100_000) })}`],
        ["double-bearer", `Bearer Bearer ${jwt(google)}`],
        ["valid", `Bearer ${jwt(google)}`],
      ]);
      const hdrs = { ...headers };
      if (variant[1] === null) delete hdrs.Authorization;
      else hdrs.Authorization = variant[1];
      return finish({
        ...base,
        headers: hdrs,
        label: `auth ${variant[0]}`,
        method: "POST",
        url,
        body: JSON.stringify({ shots }),
        expectation: { kind: "maybe", statuses: [401], oracle },
      });
    }
    case "envelope-headers": {
      const shots = generateBatch(p, mark, { size: 1, forceValid: true });
      const oracle = oracleFor(shots, [], { kind: "accept" });
      const body = JSON.stringify({ shots });
      const hdrs = { ...headers };
      let requestIdSent: string | null = null;
      let requestIdWellFormed = false;
      let expectation: Expectation = { kind: "batch", oracle, rpc: { kind: "accept" } };
      const latin1 = () => Array.from({ length: p.int(1, 20) }, () => String.fromCharCode(p.int(0xa1, 0xff))).join("");
      const variant = p.pick<() => string>([
        () => {
          hdrs["Content-Type"] = p.pick([
            "text/plain",
            "application/xml",
            "multipart/form-data; boundary=----x",
            "application/x-www-form-urlencoded",
            "application/json; charset=utf-16",
            "application/json;;;",
            "APPLICATION/JSON",
            "application/vnd.api+json",
            `application/json; ${"a".repeat(5000)}`,
            "",
            latin1(),
          ]);
          expectation = { kind: "maybe", statuses: [415], oracle };
          return `content-type ${JSON.stringify(hdrs["Content-Type"]).slice(0, 50)}`;
        },
        () => {
          delete hdrs["Content-Type"];
          expectation = { kind: "maybe", statuses: [415], oracle };
          return "content-type missing";
        },
        () => {
          const value = p.pick([
            "0",
            "-1",
            "abc",
            "1e3",
            " 12 ",
            "+5",
            "0x10",
            "9".repeat(400),
            "5000000",
            "1000000000000",
            "NaN",
            "Infinity",
          ]);
          hdrs["Content-Length"] = value;
          const n = Number(value);
          if (Number.isFinite(n) && n > 5_000_000) expectation = { kind: "reject", statuses: [413] };
          return `content-length ${JSON.stringify(value).slice(0, 30)}`;
        },
        () => {
          hdrs["Content-Length"] = "5000001";
          expectation = { kind: "reject", statuses: [413] };
          return "content-length 5000001 (tiny body)";
        },
        () => {
          const value = p.weighted<() => string>([
            [() => p.ascii(p.int(8, 64)).replace(/[^A-Za-z0-9._-]/g, "a"), 4],
            [() => p.ascii(7).replace(/[^A-Za-z0-9._-]/g, "a"), 1],
            [() => "a".repeat(65), 1],
            [() => "a".repeat(64), 1],
            [() => "a".repeat(8), 1],
            [() => `req id ${p.ascii(10)}`, 1],
            [() => `../../etc/passwd${p.ascii(4)}`, 1],
            [() => `${mark}%0d%0aX-Injected:1`, 1],
            [() => `${mark}:${p.ascii(4)}`, 1],
            [() => latin1() + "x".repeat(10), 1],
            [() => "", 1],
            [() => " ".repeat(10), 1],
            [() => `  ${"b".repeat(12)}  `, 1],
          ])();
          hdrs["x-request-id"] = value;
          requestIdSent = value;
          requestIdWellFormed = /^[A-Za-z0-9._-]{8,64}$/.test(value.trim());
          return `x-request-id ${JSON.stringify(value).slice(0, 40)}`;
        },
        () => {
          hdrs["x-forwarded-for"] = p.pick([
            "",
            " ",
            ",",
            ",,,",
            "1.2.3.4, 5.6.7.8",
            `${mark}, 9.9.9.9`,
            "::1",
            "2001:db8::1, ::ffff:1.2.3.4",
            "not-an-ip",
            Array.from({ length: 5000 }, () => "1.1.1.1").join(","),
            latin1(),
            "1.2.3.4\t",
          ]);
          return `x-forwarded-for ${JSON.stringify(hdrs["x-forwarded-for"]).slice(0, 40)}`;
        },
        () => {
          delete hdrs["x-forwarded-for"];
          return "x-forwarded-for missing";
        },
        () => {
          hdrs["cf-connecting-ip"] = p.pick(["", "203.0.113.9", mark, latin1(), "x".repeat(10_000)]);
          return `cf-connecting-ip ${JSON.stringify(hdrs["cf-connecting-ip"]).slice(0, 40)}`;
        },
        () => {
          hdrs[
            p.pick([
              "Accept",
              "Accept-Encoding",
              "Origin",
              "Referer",
              "User-Agent",
              "Cookie",
              "Prefer",
              "Accept-Profile",
              "Content-Profile",
              "apikey",
              "X-Client-Info",
              "Range",
              "If-None-Match",
              "Expect",
              "Transfer-Encoding",
              "Upgrade",
              "Connection",
            ])
          ] = p.pick([
            "text/html",
            "*/*",
            "",
            mark,
            latin1(),
            "return=representation",
            "bytes=0-1",
            "100-continue",
            "chunked",
            "x".repeat(20_000),
          ]);
          return `extra header ${Object.keys(hdrs).slice(-1)[0]}`;
        },
        () => {
          for (let i = 0; i < p.int(50, 300); i++) hdrs[`x-fuzz-${i}`] = p.ascii(p.int(1, 40));
          return "300 extra headers";
        },
        () => {
          // Two spellings of the same header merge into one comma-joined
          // value; the route may refuse or accept, never write on refusal.
          hdrs[p.pick(["authorization", "AUTHORIZATION"])] = hdrs.Authorization;
          expectation = { kind: "maybe", statuses: [401], oracle };
          return "authorization duplicated";
        },
      ]);
      const label = variant();
      return finish({
        ...base,
        headers: hdrs,
        requestIdSent,
        requestIdWellFormed,
        label: `headers ${label}`,
        method: "POST",
        url,
        body,
        expectation,
      });
    }
    case "query-string": {
      const shots = generateBatch(p, mark, { size: p.int(1, 3) });
      const qs = p.pick([
        "?shots=[]",
        `?shots=${encodeURIComponent(JSON.stringify(shots))}`,
        "?select=*",
        "?user_id=eq.00000000-0000-4000-8000-000000000000",
        "?id=in.(a,b)",
        `?${mark}=1`,
        `?${"a=1&".repeat(2000)}`,
        `?q=${"x".repeat(50_000)}`,
        "?%",
        "?%00",
        "?a[]=1&a[]=2",
        "?__proto__=1",
        "?&&&",
        "?=",
      ]);
      return finish({
        ...base,
        label: `query ${qs.slice(0, 40)}`,
        method: "POST",
        url: `${url}${qs}`,
        body: JSON.stringify({ shots }),
        expectation: { kind: "batch", oracle: oracleFor(shots, [], { kind: "accept" }), rpc: { kind: "accept" } },
      });
    }
    case "upstream-fault": {
      const shots = generateBatch(p, mark, { size: p.int(1, 3), forceValid: true });
      const fault = p.pick<NonNullable<FuzzCase["lookupFault"]>>([
        { status: 500, body: JSON.stringify({ code: "XX000", message: `${mark} internal` }) },
        { status: 503, body: "<html>bad gateway</html>" },
        { status: 401, body: JSON.stringify({ code: "PGRST301", message: "JWT expired" }) },
        { status: 403, body: JSON.stringify({ code: "42501", message: "permission denied for table shots" }) },
        { status: 404, body: JSON.stringify({ code: "PGRST205", message: "table not found" }) },
        { status: 200, body: "not json at all" },
        { status: 200, body: '{"id":' },
        "throw",
      ]);
      return finish({
        ...base,
        label: `lookup fault ${fault === "throw" ? "network-throw" : `${fault.status} ${fault.body.slice(0, 20)}`}`,
        method: "POST",
        url,
        body: JSON.stringify({ shots }),
        lookupFault: fault,
        expectation: { kind: "upstream-fault", statuses: [503] },
      });
    }
    case "burst": {
      const shots = generateBatch(p, mark, { size: 1, forceValid: true });
      return finish({
        ...base,
        label: "burst 31 requests / one user",
        method: "POST",
        url,
        body: JSON.stringify({ shots }),
        expectation: { kind: "burst", limit: 30 },
      });
    }
    case "body-size": {
      const shots = generateBatch(p, mark, { size: 1, forceValid: true });
      const json = JSON.stringify({ shots });
      const variant = p.pick<[string, string, Expectation]>([
        ["5_000_001 bytes no content-length", `${json}${" ".repeat(5_000_001 - encode(json).byteLength)}`, {
          kind: "reject",
          statuses: [413],
        }],
        ["exactly 5_000_000 bytes (valid batch padded)", `${json}${" ".repeat(5_000_000 - encode(json).byteLength)}`, {
          kind: "batch",
          oracle: oracleFor(shots, [], { kind: "accept" }),
          rpc: { kind: "accept" },
        }],
        ["6 MB of garbage", "g".repeat(6_000_000), { kind: "reject", statuses: [413] }],
        ["5_000_001 bytes of multibyte text", "é".repeat(2_500_001), { kind: "reject", statuses: [413] }],
      ]);
      return finish({
        ...base,
        label: `size ${variant[0]}`,
        method: "POST",
        url,
        body: variant[1],
        expectation: variant[2],
      });
    }
  }
}
