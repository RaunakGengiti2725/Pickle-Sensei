import {
  NO_READ_VARIANTS,
  PRAISE_VARIANTS,
  SETUP_GUIDANCE_PHRASE,
  formatSpokenScore,
  worstCheckpoint,
  type CoachState,
  type CueDecision,
  type CueRules,
  type LiveCheckpointObservation,
  type LiveCoachSessionState,
  type LiveCueDecision,
  type LiveCueRules,
  type LiveRepObservation,
  type RepObservation,
} from "../../src/index.js";
import type { InputMode } from "./generators.js";

/**
 * Model-checked invariants for both cue engines. Every invariant is either
 * documented in the source (doc comments in cueEngine.ts / liveSession.ts /
 * livePhrases.ts) or a direct consequence of the documented rule set. Each
 * check receives the full step context and returns the id of the violated
 * invariant (or null).
 *
 * "hard" invariants must hold for legal AND near-legal input; "advisory"
 * invariants encode the documented intent more strictly than the code and are
 * recorded in the campaign table but never fail the suite (they are reported
 * as findings instead).
 */
export type Strength = "hard" | "advisory";

export interface Violation {
  invariant: string;
  strength: Strength;
  detail: string;
}

export const CUE_CATEGORIES = new Set([
  "CORRECTION",
  "IMPROVEMENT",
  "PERSONAL_BEST",
  "REPEAT",
  "STABLE",
  "SILENCE",
]);

export const LIVE_CATEGORIES = new Set([
  "CORRECTION",
  "REPEAT_CORRECTION",
  "IMPROVEMENT",
  "PERSONAL_BEST",
  "PRAISE",
  "NO_READ",
  "SETUP_GUIDANCE",
]);

export const NON_FINITE_TEXT = /NaN|Infinity/;

export function isFiniteOrNull(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

/** Walk any JSON-ish value and report the first non-finite number path. */
export function findNonFinite(value: unknown, path = "$"): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? null : path;
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findNonFinite(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, inner] of Object.entries(value)) {
    const hit = findNonFinite(inner, `${path}.${key}`);
    if (hit) return hit;
  }
  return null;
}

export function jsonRoundTripsExactly(value: unknown): boolean {
  return JSON.stringify(JSON.parse(JSON.stringify(value))) === JSON.stringify(value);
}

// ================================================================ cueEngine

/** Independent model of the sparse engine's bookkeeping. */
export interface CueModel {
  best: number | null;
  lowStreak: number;
  correctionRun: number;
  lastStableRepIndex: number | null;
  previous: { rep: RepObservation; decision: CueDecision } | null;
}

export const INITIAL_CUE_MODEL: CueModel = {
  best: null,
  lowStreak: 0,
  correctionRun: 0,
  lastStableRepIndex: null,
  previous: null,
};

export interface CueStep {
  mode: InputMode;
  rules: CueRules;
  before: CoachState;
  rep: RepObservation;
  decision: CueDecision;
  after: CoachState;
  /** Independent model before / after this step. */
  modelBefore: CueModel;
  modelAfter: CueModel;
}

function isStrokeCorrection(decision: CueDecision): boolean {
  return (
    (decision.category === "CORRECTION" && decision.text !== SETUP_GUIDANCE_PHRASE) ||
    decision.category === "REPEAT"
  );
}

/** Advance the independent model; returns the new model. */
export function stepCueModel(
  model: CueModel,
  rep: RepObservation,
  decision: CueDecision,
): CueModel {
  const next: CueModel = { ...model, previous: { rep, decision } };
  if (rep.resultKind === "low_confidence") {
    next.lowStreak = model.lowStreak + 1;
    if (decision.category === "CORRECTION") {
      next.lowStreak = 0;
      next.correctionRun = 0;
    }
    return next;
  }
  next.lowStreak = 0;
  if (rep.overallScore !== null && Number.isFinite(rep.overallScore)) {
    next.best = model.best === null ? rep.overallScore : Math.max(model.best, rep.overallScore);
  }
  next.correctionRun = isStrokeCorrection(decision) ? model.correctionRun + 1 : 0;
  if (decision.category === "STABLE") next.lastStableRepIndex = rep.repIndex;
  return next;
}

export function checkCueStep(step: CueStep): Violation[] {
  const out: Violation[] = [];
  const { rules, before, rep, decision, after, modelBefore, modelAfter } = step;
  const hard = (invariant: string, detail: string) =>
    out.push({ invariant, strength: "hard", detail });
  const advisory = (invariant: string, detail: string) =>
    out.push({ invariant, strength: "advisory", detail });
  const legalNumbers = step.mode !== "hostile";

  // C1 — text null exactly when SILENCE (doc: CueDecision.text).
  if ((decision.text === null) !== (decision.category === "SILENCE")) {
    hard("C1.text-iff-spoken", `${decision.category} text=${JSON.stringify(decision.text)}`);
  }
  if (decision.text !== null && decision.text.trim().length === 0) {
    hard("C1.text-nonempty", "spoken text is blank");
  }
  // C15 — spoken text never contains NaN/Infinity, whatever the input.
  if (decision.text !== null && NON_FINITE_TEXT.test(decision.text))
    hard("C15.finite-text", decision.text);
  // C2 — category from the documented set.
  if (!CUE_CATEGORIES.has(decision.category)) hard("C2.category", decision.category);
  // C3 — state stays finite (no NaN/Infinity) given finite inputs.
  if (legalNumbers) {
    const nonFinite = findNonFinite(after);
    if (nonFinite) hard("C3.finite-state", nonFinite);
  }
  // C4 — lastSpokenRepIndex advances exactly on spoken cues.
  if (decision.category === "SILENCE") {
    if (after.lastSpokenRepIndex !== before.lastSpokenRepIndex) {
      hard("C4.last-spoken", "SILENCE moved lastSpokenRepIndex");
    }
  } else if (after.lastSpokenRepIndex !== rep.repIndex) {
    hard("C4.last-spoken", `spoken but lastSpokenRepIndex=${after.lastSpokenRepIndex}`);
  }
  // C5 — bestOverallScore is the running max of scored overall scores.
  if (legalNumbers && after.bestOverallScore !== modelAfter.best) {
    hard("C5.best-overall", `engine=${after.bestOverallScore} model=${modelAfter.best}`);
  }
  // C6 — counters bounded by the rules.
  if (
    after.consecutiveCorrections < 0 ||
    after.consecutiveCorrections > rules.maxConsecutiveCorrections
  ) {
    hard("C6.consecutive-bound", `${after.consecutiveCorrections}`);
  }
  if (
    after.lowConfidenceStreak < 0 ||
    after.lowConfidenceStreak >= rules.lowConfidenceGuidanceAfter
  ) {
    hard("C6.low-streak-bound", `${after.lowConfidenceStreak}`);
  }
  // C7 — never more than maxConsecutiveCorrections stroke corrections in a row.
  if (modelAfter.correctionRun > rules.maxConsecutiveCorrections) {
    hard("C7.nag-cap", `run=${modelAfter.correctionRun}`);
  }

  if (rep.resultKind === "low_confidence") {
    // C10 — setup guidance exactly on the Nth consecutive low-confidence rep.
    const expectGuidance = modelBefore.lowStreak + 1 >= rules.lowConfidenceGuidanceAfter;
    const gotGuidance = decision.category === "CORRECTION";
    if (expectGuidance !== gotGuidance) {
      hard("C10.setup-guidance", `expect=${expectGuidance} got=${decision.category}`);
    }
    if (gotGuidance && decision.text !== SETUP_GUIDANCE_PHRASE) {
      hard("C10.setup-guidance-text", `${decision.text}`);
    }
    if (!gotGuidance && decision.category !== "SILENCE") {
      hard("C10.low-conf-silent", decision.category);
    }
    return out;
  }

  // ---- scored rep
  const prior = modelBefore.previous;
  const isPb =
    legalNumbers &&
    rep.overallScore !== null &&
    before.bestOverallScore !== null &&
    rep.overallScore > before.bestOverallScore &&
    rep.repIndex >= rules.personalBestMinRep;
  // C11 — PERSONAL_BEST iff a new best beyond personalBestMinRep.
  if (legalNumbers && isPb !== (decision.category === "PERSONAL_BEST")) {
    hard("C11.personal-best", `isPb=${isPb} got=${decision.category}`);
  }
  if (decision.category === "PERSONAL_BEST") return out;

  // C9 — REPEAT only right after a stroke correction on the same fault.
  if (decision.category === "REPEAT") {
    const ok =
      prior !== null &&
      isStrokeCorrection(prior.decision) &&
      prior.rep.focusCheckpoint === rep.focusCheckpoint &&
      prior.rep.focusDirection === rep.focusDirection;
    if (!ok) hard("C9.repeat-requires-same-fault", `prev=${prior?.decision.category ?? "none"}`);
  }

  if (decision.category === "IMPROVEMENT") {
    // C12 — an improvement follows a correction (or a forced-quiet rep) on the
    // previous rep with a focus-score gain of at least improvementDelta.
    const gain =
      prior !== null && prior.rep.focusScore !== null && rep.focusScore !== null
        ? rep.focusScore - prior.rep.focusScore
        : null;
    if (
      prior === null ||
      !before.previousWasCorrection ||
      gain === null ||
      gain < rules.improvementDelta
    ) {
      hard(
        "C12.improvement-gain",
        `gain=${gain} prevWasCorrection=${before.previousWasCorrection}`,
      );
    }
    // A1 — the improvement should be on the checkpoint that was corrected.
    if (
      before.lastCorrection !== null &&
      before.lastCorrection.checkpoint !== rep.focusCheckpoint
    ) {
      advisory(
        "A1.improvement-same-checkpoint",
        `corrected=${before.lastCorrection.checkpoint} improved=${rep.focusCheckpoint}`,
      );
    }
    return out;
  }

  const warranted = legalNumbers && rep.focusSeverity >= rules.correctionSeverity;
  if (warranted) {
    // C13 — a warranted correction is spoken unless the nag cap forces quiet.
    const forcedQuiet = before.consecutiveCorrections >= rules.maxConsecutiveCorrections;
    if (forcedQuiet) {
      if (decision.category !== "SILENCE") hard("C13.forced-quiet", decision.category);
      if (after.consecutiveCorrections !== 0) hard("C13.forced-quiet-reset", "");
    } else if (decision.category !== "CORRECTION" && decision.category !== "REPEAT") {
      hard("C13.correction-spoken", decision.category);
    } else if (decision.text === SETUP_GUIDANCE_PHRASE) {
      hard("C13.stroke-not-setup", "scored rep got setup guidance");
    }
    return out;
  }

  if (decision.category === "CORRECTION" || decision.category === "REPEAT") {
    if (legalNumbers) hard("C13.unwarranted-correction", `severity=${rep.focusSeverity}`);
    return out;
  }

  // C14 — stable praise iff severity ≤ stableSeverity and cooled down.
  if (legalNumbers) {
    const stable = rep.focusSeverity <= rules.stableSeverity;
    const cooled =
      before.lastStableRepIndex === null ||
      rep.repIndex - before.lastStableRepIndex >= rules.stableCooldownReps;
    const expectStable = stable && cooled;
    if (expectStable !== (decision.category === "STABLE")) {
      hard("C14.stable-praise", `expect=${expectStable} got=${decision.category}`);
    }
    // C8 — STABLE cues are at least stableCooldownReps apart (monotonic repIndex).
    if (
      step.mode === "legal" &&
      decision.category === "STABLE" &&
      modelBefore.lastStableRepIndex !== null &&
      rep.repIndex - modelBefore.lastStableRepIndex < rules.stableCooldownReps
    ) {
      hard("C8.stable-cooldown", `gap=${rep.repIndex - modelBefore.lastStableRepIndex}`);
    }
  }
  return out;
}

// ============================================================== liveSession

export interface LiveModel {
  best: number | null;
  noReadStreak: number;
  previous: { rep: LiveRepObservation; decision: LiveCueDecision } | null;
  lastNoReadText: string | null;
  lastPraiseBody: string | null;
}

export const INITIAL_LIVE_MODEL: LiveModel = {
  best: null,
  noReadStreak: 0,
  previous: null,
  lastNoReadText: null,
  lastPraiseBody: null,
};

export interface LiveStep {
  mode: InputMode;
  rules: LiveCueRules;
  before: LiveCoachSessionState;
  rep: LiveRepObservation;
  decision: LiveCueDecision;
  after: LiveCoachSessionState;
  modelBefore: LiveModel;
  modelAfter: LiveModel;
}

function isLiveCorrection(category: string): boolean {
  return category === "CORRECTION" || category === "REPEAT_CORRECTION";
}

/** Strip the "6.8. " score prefix when present. */
export function spokenBody(decision: LiveCueDecision): string {
  if (decision.announcedScore === null) return decision.text;
  const prefix = `${formatSpokenScore(decision.announcedScore)}. `;
  return decision.text.startsWith(prefix) ? decision.text.slice(prefix.length) : decision.text;
}

export function stepLiveModel(
  model: LiveModel,
  rep: LiveRepObservation,
  decision: LiveCueDecision,
): LiveModel {
  const next: LiveModel = { ...model, previous: { rep, decision } };
  if (rep.kind !== "scored") {
    next.noReadStreak = decision.category === "SETUP_GUIDANCE" ? 0 : model.noReadStreak + 1;
    if (decision.category === "NO_READ") next.lastNoReadText = decision.text;
    return next;
  }
  next.noReadStreak = 0;
  if (rep.overallScore !== null && Number.isFinite(rep.overallScore)) {
    next.best = model.best === null ? rep.overallScore : Math.max(model.best, rep.overallScore);
  }
  if (decision.category === "PRAISE") next.lastPraiseBody = spokenBody(decision);
  return next;
}

/** Reference implementation of the documented worst-checkpoint rule. */
export function referenceWorst(
  checkpoints: readonly LiveCheckpointObservation[],
): LiveCheckpointObservation | null {
  let worst: LiveCheckpointObservation | null = null;
  for (const c of checkpoints) {
    if (!c.applicable) continue;
    if (worst === null) {
      worst = c;
      continue;
    }
    const cScore = c.score ?? 100;
    const wScore = worst.score ?? 100;
    if (c.severity > worst.severity || (c.severity === worst.severity && cScore < wScore)) {
      worst = c;
    }
  }
  return worst;
}

export function checkLiveStep(step: LiveStep): Violation[] {
  const out: Violation[] = [];
  const { rules, before, rep, decision, after, modelBefore, modelAfter } = step;
  const hard = (invariant: string, detail: string) =>
    out.push({ invariant, strength: "hard", detail });
  const advisory = (invariant: string, detail: string) =>
    out.push({ invariant, strength: "advisory", detail });
  const legalNumbers = step.mode !== "hostile";

  // L1 — live mode always speaks.
  if (typeof decision.text !== "string" || decision.text.trim().length === 0) {
    hard("L1.always-speaks", `${decision.category} text=${JSON.stringify(decision.text)}`);
  }
  // L2 — category from the documented set.
  if (!LIVE_CATEGORIES.has(decision.category)) hard("L2.category", decision.category);
  // L13 — spoken text never contains NaN/Infinity, whatever the input.
  if (typeof decision.text === "string" && NON_FINITE_TEXT.test(decision.text)) {
    hard("L13.finite-text", decision.text);
  }
  // L11 — finite, JSON-serializable state; bounded counters.
  if (legalNumbers) {
    const nonFinite = findNonFinite(after) ?? findNonFinite(decision);
    if (nonFinite) hard("L11.finite", nonFinite);
    if (!jsonRoundTripsExactly(after)) hard("L9.json-roundtrip", "state does not survive JSON");
  }
  if (after.noReadStreak < 0 || after.noReadStreak >= rules.setupGuidanceAfter) {
    hard("L11.no-read-streak-bound", `${after.noReadStreak}`);
  }
  if (
    !Number.isInteger(after.praiseCounter) ||
    after.praiseCounter < 0 ||
    !Number.isInteger(after.noReadCounter) ||
    after.noReadCounter < 0
  ) {
    hard("L11.counters", `praise=${after.praiseCounter} noRead=${after.noReadCounter}`);
  }
  // L3 — announcedScore is exactly the 0–10 score embedded in the text.
  if (decision.announcedScore !== null) {
    if (!Number.isFinite(decision.announcedScore))
      hard("L3.announced-finite", `${decision.announcedScore}`);
    if (!Object.is(decision.announcedScore, rep.overallScore)) {
      hard("L3.announced-is-overall", `${decision.announcedScore} vs ${rep.overallScore}`);
    }
    if (legalNumbers && !decision.text.includes(formatSpokenScore(decision.announcedScore))) {
      hard("L3.announced-in-text", decision.text);
    }
  }
  // L4 — targetCheckpoint present exactly for correction/improvement cues.
  const targeted = isLiveCorrection(decision.category) || decision.category === "IMPROVEMENT";
  if ((decision.targetCheckpoint !== null) !== targeted) {
    hard("L4.target-iff-coaching", `${decision.category} target=${decision.targetCheckpoint}`);
  }
  // Every scored-rep decision carries the score when announceScores is on.
  if (
    rep.kind === "scored" &&
    rep.overallScore !== null &&
    Number.isFinite(rep.overallScore) &&
    rules.announceScores
  ) {
    if (decision.announcedScore !== rep.overallScore) {
      hard("L3.score-announced", `${decision.category} announced=${decision.announcedScore}`);
    }
  }
  if (
    !rules.announceScores &&
    decision.category !== "PERSONAL_BEST" &&
    decision.announcedScore !== null
  ) {
    hard("L3.score-suppressed", decision.category);
  }

  if (rep.kind !== "scored") {
    // L5 — honest no-read, setup guidance exactly on the Nth consecutive no-read.
    const expectGuidance = modelBefore.noReadStreak + 1 >= rules.setupGuidanceAfter;
    if (expectGuidance) {
      if (decision.category !== "SETUP_GUIDANCE") hard("L5.setup-guidance", decision.category);
      else if (decision.text !== SETUP_GUIDANCE_PHRASE)
        hard("L5.setup-guidance-text", decision.text);
    } else {
      if (decision.category !== "NO_READ") hard("L5.no-read", decision.category);
      else {
        if (!NO_READ_VARIANTS.includes(decision.text)) hard("L5.no-read-variant", decision.text);
        if (
          NO_READ_VARIANTS.length > 1 &&
          modelBefore.previous?.decision.category === "NO_READ" &&
          modelBefore.previous.decision.text === decision.text
        ) {
          hard("L5.no-read-rotates", decision.text);
        }
      }
    }
    if (decision.announcedScore !== null) hard("L3.no-read-no-score", `${decision.announcedScore}`);
    if (!Object.is(after.bestOverall, before.bestOverall)) hard("L8.best-untouched-on-no-read", "");
    if (after.praiseCounter !== before.praiseCounter) hard("L6.praise-counter-untouched", "");
    return out;
  }

  // ---- scored rep
  if (after.noReadStreak !== 0) hard("L12.streak-reset", `${after.noReadStreak}`);
  if (legalNumbers && after.bestOverall !== modelAfter.best) {
    hard("L8.best-overall", `engine=${after.bestOverall} model=${modelAfter.best}`);
  }
  const isPb =
    legalNumbers &&
    rep.overallScore !== null &&
    before.bestOverall !== null &&
    rep.overallScore > before.bestOverall &&
    rep.repIndex >= rules.personalBestMinRep;
  if (legalNumbers && isPb !== (decision.category === "PERSONAL_BEST")) {
    hard("L8.personal-best", `isPb=${isPb} got=${decision.category}`);
  }
  if (decision.category === "PERSONAL_BEST") {
    if (rep.overallScore === null || decision.announcedScore !== rep.overallScore) {
      hard("L8.pb-announces-score", `${decision.announcedScore}`);
    }
    return out;
  }

  const worst = referenceWorst(rep.checkpoints);
  const engineWorst = worstCheckpoint(rep.checkpoints);
  // L10 — worstCheckpoint matches the documented rule (applicable, max severity,
  // lower score wins ties, then input order).
  if (legalNumbers && engineWorst !== worst) {
    hard("L10.worst-checkpoint", `engine=${engineWorst?.key ?? null} ref=${worst?.key ?? null}`);
  }

  const last = before.lastSpoken;
  const lastCorrected = last !== null && isLiveCorrection(last.category) ? last.checkpoint : null;
  if (decision.category === "IMPROVEMENT") {
    // L14 — improvement is on the checkpoint just corrected, with a real gain.
    if (lastCorrected === null || decision.targetCheckpoint !== lastCorrected) {
      hard(
        "L14.improvement-on-corrected",
        `target=${decision.targetCheckpoint} last=${lastCorrected}`,
      );
    } else {
      const previousScore = before.previousCheckpointScores[lastCorrected] ?? null;
      const current = rep.checkpoints.find((c) => c.key === lastCorrected) ?? null;
      const gain =
        previousScore !== null && current?.score != null ? current.score - previousScore : null;
      if (legalNumbers && (gain === null || gain < rules.improvementDelta)) {
        hard("L14.improvement-gain", `gain=${gain}`);
      }
      if (current !== null && !current.applicable) {
        advisory("A2.improvement-inapplicable", `${lastCorrected} inapplicable this swing`);
      }
    }
    return out;
  }

  const warranted = legalNumbers && worst !== null && worst.severity >= rules.correctionSeverity;
  if (warranted && worst !== null) {
    // L7 — warranted correction spoken on the worst checkpoint; REPEAT wording
    // exactly when the same (checkpoint, direction) was corrected last rep.
    if (!isLiveCorrection(decision.category)) {
      hard("L7.correction-spoken", decision.category);
      return out;
    }
    if (decision.targetCheckpoint !== worst.key) {
      hard("L7.correction-target", `${decision.targetCheckpoint} vs ${worst.key}`);
    }
    const expectRepeat =
      last !== null &&
      isLiveCorrection(last.category) &&
      last.checkpoint === worst.key &&
      last.direction === worst.direction;
    if (expectRepeat !== (decision.category === "REPEAT_CORRECTION")) {
      hard("L7.repeat-wording", `expect=${expectRepeat} got=${decision.category}`);
    }
    if (
      decision.category === "REPEAT_CORRECTION" &&
      !spokenBody(decision).startsWith("Still there")
    ) {
      hard("L7.repeat-prefix", decision.text);
    }
    return out;
  }
  if (legalNumbers && isLiveCorrection(decision.category)) {
    hard("L7.unwarranted-correction", `worst=${worst?.severity ?? null}`);
    return out;
  }
  // L6 — praise otherwise, rotating so consecutive praise never repeats.
  if (legalNumbers && decision.category !== "PRAISE") {
    hard("L6.praise", decision.category);
    return out;
  }
  if (decision.category === "PRAISE") {
    const body = spokenBody(decision);
    if (!PRAISE_VARIANTS.includes(body)) hard("L6.praise-variant", body);
    if (PRAISE_VARIANTS.length > 1 && modelBefore.lastPraiseBody === body) {
      hard("L6.praise-rotates", body);
    }
    if (after.praiseCounter !== before.praiseCounter + 1) hard("L6.praise-counter", "");
  }
  return out;
}

// ============================================================ sessionEndLine

export function checkSessionEndLine(
  input: {
    scoredCount: number;
    startAverage: number | null;
    endAverage: number | null;
    best: number | null;
  },
  line: string,
  mode: InputMode,
): Violation[] {
  const out: Violation[] = [];
  const hard = (invariant: string, detail: string) =>
    out.push({ invariant, strength: "hard", detail });
  const advisory = (invariant: string, detail: string) =>
    out.push({ invariant, strength: "advisory", detail });
  if (typeof line !== "string" || line.trim().length === 0) hard("E1.nonempty", String(line));
  if (NON_FINITE_TEXT.test(line)) hard("E2.finite-text", line);
  if (mode !== "hostile" && /null|undefined/.test(line)) hard("E2.no-garbage", line);
  if (input.scoredCount === 0 && line !== "Session over. No swings could be scored this time.") {
    hard("E3.zero-scored", line);
  }
  if (!line.startsWith("Session over.")) hard("E4.prefix", line);
  const trend =
    /started around ([-\d.]+) and finished around ([-\d.]+) — (up|down|held steady at) ([-\d.]+)/.exec(
      line,
    );
  if (trend && mode !== "hostile") {
    const [, start, end, word, amount] = trend;
    if (start !== undefined && end !== undefined && word !== undefined && amount !== undefined) {
      const spokenDelta = Math.abs(Number(end) - Number(start));
      if (word === "held steady at") {
        if (start !== end) advisory("A3.steady-but-different-numbers", line);
      } else if (start === end) {
        advisory("A3.moved-but-same-numbers", line);
      } else if (Math.abs(spokenDelta - Number(amount)) > 1e-9) {
        advisory(
          "A3.delta-mismatch",
          `${line} (spoken numbers differ by ${spokenDelta.toFixed(1)})`,
        );
      }
    }
  }
  return out;
}
