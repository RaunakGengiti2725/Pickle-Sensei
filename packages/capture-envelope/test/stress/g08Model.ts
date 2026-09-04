import {
  G08_BYPASS_FAMILIES,
  G08_CAPTURE_LABELS,
  G08_DOWNSTREAM_OUTCOMES,
  G08_LABEL_SCHEMA_VERSION,
  G08_MINIMUM_EVIDENCE,
  G08_PROMOTION_CRITERIA,
  type G08EvalRow,
  type G08GateMetrics,
  type G08PromotionVerdict,
  type G08ValidationResult,
} from "../../src/index.js";
import { stableJson } from "./prng.js";

/**
 * Independent model of the G08 label-file validator and evidence gate,
 * written from the schema comments in src/g08LabelSchema.ts and the frozen
 * criteria in src/g08Gate.ts (NOT by copying their code).
 *
 * The campaign never fabricates evidence: every synthetic label record is
 * fed only to the validator / metric functions in memory, never written to
 * the committed label file, and the annotator is a clearly synthetic
 * "stress-harness" handle.
 */

const FAMILIES = new Set<string>(G08_BYPASS_FAMILIES);
const CAPTURES = new Set<string>(G08_CAPTURE_LABELS);
const OUTCOMES = new Set<string>(G08_DOWNSTREAM_OUTCOMES);
const KNOWN = new Set<string>([
  "USABLE",
  "DEGRADED_RESULT",
  "UNUSABLE_DISCLOSED",
  "SILENT_FAILURE",
]);

export type LooseLabel = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Per-record defects according to the documented schema contract. */
export function modelRecordDefects(raw: unknown): string[] {
  if (!isObject(raw)) return ["not an object"];
  const defects: string[] = [];
  if (typeof raw.labelId !== "string" || raw.labelId.length === 0) return ["labelId"];
  if (raw.candidateId !== null && typeof raw.candidateId !== "string") defects.push("candidateId");
  if (typeof raw.clip !== "string" || raw.clip.length === 0) defects.push("clip");
  const win = raw.windowMs;
  if (
    !isObject(win) ||
    typeof win.startMs !== "number" ||
    !(win.startMs >= 0) ||
    typeof win.durationMs !== "number" ||
    !(win.durationMs > 0)
  ) {
    defects.push("windowMs");
  }
  if (typeof raw.sessionKey !== "string" || raw.sessionKey.length === 0) defects.push("sessionKey");
  if (typeof raw.family !== "string" || !FAMILIES.has(raw.family)) defects.push("family");
  if (typeof raw.capture !== "string" || !CAPTURES.has(raw.capture)) defects.push("capture");
  if (typeof raw.downstream !== "string" || !OUTCOMES.has(raw.downstream))
    defects.push("downstream");
  if (raw.annotatorKind !== "human") defects.push("annotatorKind");
  if (typeof raw.annotator !== "string" || raw.annotator.length === 0) defects.push("annotator");
  if (typeof raw.labeledAtIso !== "string" || Number.isNaN(Date.parse(raw.labeledAtIso))) {
    defects.push("labeledAtIso");
  }
  if (typeof raw.notes !== "string") defects.push("notes");
  else if (
    (raw.capture === "UNSAFE" || raw.capture === "AMBIGUOUS") &&
    raw.notes.trim().length === 0
  ) {
    defects.push("notes_required");
  }
  if (raw.supersedesLabelId !== undefined && typeof raw.supersedesLabelId !== "string") {
    defects.push("supersedesLabelId");
  }
  return defects;
}

export interface LabelFileModel {
  /** True when the documented contract says the file is valid. */
  valid: boolean;
  /** labelIds of records that must survive supersedes resolution (only meaningful when valid). */
  expectedEffective: string[];
  /** The file contains a supersedes cycle or a self-reference (near-legal structure). */
  hasCycle: boolean;
}

export function modelLabelFile(file: {
  schemaVersion: unknown;
  provenance: unknown;
  labels: unknown[];
}): LabelFileModel {
  let valid = file.schemaVersion === G08_LABEL_SCHEMA_VERSION;
  if (typeof file.provenance !== "string" || file.provenance.length === 0) valid = false;
  const ids = new Set<string>();
  const wellFormed: LooseLabel[] = [];
  for (const raw of file.labels) {
    const defects = modelRecordDefects(raw);
    if (defects.length > 0) valid = false;
    if (isObject(raw) && typeof raw.labelId === "string" && raw.labelId.length > 0) {
      if (ids.has(raw.labelId)) valid = false;
      ids.add(raw.labelId);
      if (defects.length === 0) wellFormed.push(raw);
    }
  }
  const superseded = new Set<string>();
  let hasCycle = false;
  for (const rec of wellFormed) {
    const target = rec.supersedesLabelId;
    if (typeof target !== "string") continue;
    if (!ids.has(target)) valid = false;
    superseded.add(target);
  }
  // Cycle detection over the supersedes graph (well-formed records only).
  const next = new Map<string, string>();
  for (const rec of wellFormed) {
    if (typeof rec.supersedesLabelId === "string") {
      next.set(rec.labelId as string, rec.supersedesLabelId);
    }
  }
  for (const start of next.keys()) {
    const seen = new Set<string>();
    let cursor: string | undefined = start;
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        hasCycle = true;
        break;
      }
      seen.add(cursor);
      cursor = next.get(cursor);
    }
  }
  const expectedEffective = wellFormed
    .map((rec) => rec.labelId as string)
    .filter((id) => !superseded.has(id));
  return { valid, expectedEffective, hasCycle };
}

/** Model-check one validator result against the contract. */
export function checkValidation(
  file: { schemaVersion: unknown; provenance: unknown; labels: unknown[] },
  result: G08ValidationResult,
  second: G08ValidationResult,
): { legal: string[]; nearLegal: string[] } {
  const legal: string[] = [];
  const nearLegal: string[] = [];
  const model = modelLabelFile(file);

  if (stableJson(result) !== stableJson(second))
    legal.push("validateG08LabelFile is not deterministic");
  if (result.valid !== model.valid) {
    legal.push(`valid=${String(result.valid)} but model expects ${String(model.valid)}`);
  }
  if (result.valid !== (result.errors.length === 0)) {
    legal.push(`valid=${String(result.valid)} inconsistent with ${result.errors.length} errors`);
  }
  const effectiveIds = result.effective.map((r) => r.labelId);
  if (new Set(effectiveIds).size !== effectiveIds.length)
    legal.push("effective has duplicate labelIds");
  const allIds = new Set(
    file.labels
      .filter(isObject)
      .map((r) => r.labelId)
      .filter((id): id is string => typeof id === "string"),
  );
  for (const id of effectiveIds) {
    if (!allIds.has(id)) legal.push(`effective contains unknown labelId ${id}`);
  }
  for (const rec of result.effective) {
    const defects = modelRecordDefects(rec);
    if (defects.length > 0)
      legal.push(`effective leaks ill-formed record ${rec.labelId}: ${defects.join(",")}`);
  }
  if (result.valid) {
    if (stableJson([...effectiveIds].sort()) !== stableJson([...model.expectedEffective].sort())) {
      legal.push(
        `effective ${effectiveIds.join(",")} != model ${model.expectedEffective.join(",")}`,
      );
    }
    // Contract: a valid file's supersedes chains all end in an effective record.
    if (model.hasCycle) {
      nearLegal.push(
        "validator accepts a label file whose supersedes graph contains a cycle/self-reference (valid=true) — no record in the cycle is effective, so evidence silently disappears",
      );
    }
    if (file.labels.length > 0 && result.effective.length === 0) {
      nearLegal.push("valid file with labels but zero effective records");
    }
  }
  return { legal, nearLegal };
}

/** Independent metric model. */
export function modelMetrics(rows: G08EvalRow[]): G08GateMetrics {
  const r = (num: number, den: number) => ({
    numerator: num,
    denominator: den,
    rate: den > 0 ? num / den : null,
  });
  const unsafe = rows.filter((x) => x.capture === "UNSAFE");
  const safe = rows.filter((x) => x.capture === "SAFE");
  const degraded = rows.filter((x) => x.capture === "DEGRADED");
  const ambiguous = rows.filter((x) => x.capture === "AMBIGUOUS");
  const known = rows.filter((x) => KNOWN.has(x.downstream));
  const knownSupported = known.filter((x) => x.envelopeOverall === "SUPPORTED");
  const knownFlagged = known.filter((x) => x.envelopeOverall !== "SUPPORTED");
  return {
    n: rows.length,
    nAmbiguous: ambiguous.length,
    nSafe: safe.length,
    nDegraded: degraded.length,
    nUnsafe: unsafe.length,
    distinctSessionKeys: new Set(rows.map((x) => x.sessionKey)).size,
    falseSafeRate: r(unsafe.filter((x) => x.envelopeOverall === "SUPPORTED").length, unsafe.length),
    falseRejectRate: r(safe.filter((x) => x.envelopeOverall !== "SUPPORTED").length, safe.length),
    missedDegradationRate: r(
      degraded.filter((x) => x.envelopeOverall === "SUPPORTED").length,
      degraded.length,
    ),
    usableRateGivenSupported: r(
      knownSupported.filter((x) => x.downstream === "USABLE").length,
      knownSupported.length,
    ),
    usableRateGivenFlagged: r(
      knownFlagged.filter((x) => x.downstream === "USABLE").length,
      knownFlagged.length,
    ),
    silentFailureRateGivenSupported: r(
      knownSupported.filter((x) => x.downstream === "SILENT_FAILURE").length,
      knownSupported.length,
    ),
  };
}

const RATE_KEYS = [
  "falseSafeRate",
  "falseRejectRate",
  "missedDegradationRate",
  "usableRateGivenSupported",
  "usableRateGivenFlagged",
  "silentFailureRateGivenSupported",
] as const;

export function checkMetrics(rows: G08EvalRow[], metrics: G08GateMetrics): string[] {
  const out: string[] = [];
  const model = modelMetrics(rows);
  if (stableJson(metrics) !== stableJson(model)) {
    out.push(`metrics ${stableJson(metrics)} != model ${stableJson(model)}`);
  }
  if (metrics.n !== metrics.nAmbiguous + metrics.nSafe + metrics.nDegraded + metrics.nUnsafe) {
    out.push("n != sum of capture label counts");
  }
  if (metrics.distinctSessionKeys > metrics.n) out.push("distinctSessionKeys > n");
  for (const key of RATE_KEYS) {
    const rate = metrics[key];
    if (rate.numerator < 0 || rate.denominator < 0 || rate.numerator > rate.denominator) {
      out.push(`${key}: counts ${rate.numerator}/${rate.denominator} out of range`);
    }
    if (rate.denominator === 0 && rate.rate !== null) out.push(`${key}: rate reported without N`);
    if (rate.denominator > 0) {
      if (rate.rate === null || !Number.isFinite(rate.rate) || rate.rate < 0 || rate.rate > 1) {
        out.push(`${key}: rate ${String(rate.rate)} not in [0,1]`);
      }
    }
  }
  return out;
}

export function modelSufficient(m: G08GateMetrics): boolean {
  const req = G08_MINIMUM_EVIDENCE;
  return (
    m.n >= req.minLabeledWindows &&
    m.nUnsafe + m.nDegraded >= req.minUnsafeOrDegraded &&
    m.nSafe >= req.minSafe &&
    m.distinctSessionKeys >= req.minDistinctSessions
  );
}

export function checkPromotion(
  incumbent: G08GateMetrics,
  candidate: G08GateMetrics,
  verdict: G08PromotionVerdict,
  family: string,
): string[] {
  const out: string[] = [];
  const c = G08_PROMOTION_CRITERIA;
  if (verdict.family !== family) out.push(`verdict.family ${verdict.family} != ${family}`);
  const fs = candidate.falseSafeRate.rate;
  const fr = candidate.falseRejectRate.rate;
  const expectedDecidable = modelSufficient(candidate) && fs !== null && fr !== null;
  if (verdict.decidable !== expectedDecidable) {
    out.push(
      `decidable=${String(verdict.decidable)} but model expects ${String(expectedDecidable)}`,
    );
  }
  if (!verdict.decidable) {
    if (verdict.promote) out.push("promote=true while not decidable");
    if (verdict.reasons.length === 0) out.push("undecidable verdict carries no reasons");
    return out;
  }
  if (fs === null || fr === null) return out;
  const ifs = incumbent.falseSafeRate.rate;
  const ifr = incumbent.falseRejectRate.rate;
  const cs = candidate.silentFailureRateGivenSupported.rate;
  const is = incumbent.silentFailureRateGivenSupported.rate;
  const expectedPromote =
    fs <= c.maxFalseSafeRate &&
    fr <= c.maxFalseRejectRate &&
    (ifs === null || fs <= ifs) &&
    (ifr === null || fr <= ifr + c.maxFalseRejectRegression) &&
    (cs === null || is === null || cs <= is);
  if (verdict.promote !== expectedPromote) {
    out.push(`promote=${String(verdict.promote)} but model expects ${String(expectedPromote)}`);
  }
  if (verdict.promote !== (verdict.reasons.length === 0)) {
    out.push("promote flag inconsistent with reasons list");
  }
  return out;
}
