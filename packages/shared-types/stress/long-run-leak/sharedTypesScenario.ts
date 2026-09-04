/**
 * One seeded invocation of the @pickle/shared-types runtime surface for the
 * long-run-leak campaign. Inputs are either committed fixtures (the two voice
 * corpora, reused with their committed gold — nothing relabelled) or seeded
 * synthetic streams; every value derives from the seed, so a row's seed
 * replays its exact inputs.
 *
 * Property checks per iteration (violations → BROKEN):
 *  - rank: null iff no countable input; rating/technique scores finite in
 *    [0, 10]; input order does not change the result (documented contract);
 *  - voice/intent: statuses inside the declared unions; a resolved technique
 *    is always a member of SELECTABLE_TECHNIQUES_V1 / PICKLEBALL_TECHNIQUES;
 *    zero false accepts against committed gold; confidence finite;
 *  - evaluation trial: unmodified template validates; every seeded
 *    corruption is rejected with ≥1 reason; ok ⇔ errors is empty;
 *  - consent: one status per scope; active ⇔ last action granted; empty
 *    scope inactive; order-independent when every record carries a unique seq;
 *  - stability SLO: rates null or finite in [0, 1]; decision consistent with
 *    verdicts; reducing rollout exposure is always allowed;
 *  - media retention: deadline null or a valid Date; expired is boolean.
 */
import {
  CONSENT_ACTIONS,
  CONSENT_CAPTURE_MODES,
  CONSENT_SCOPES,
  CONSENT_SOURCES,
  EVALUATION_TRIAL_SCHEMA_VERSION,
  MEDIA_ASSET_KINDS,
  MEDIA_RETENTION_POLICY_V1,
  PICKLEBALL_TECHNIQUES,
  PLAYER_RANK_TIERS,
  SELECTABLE_TECHNIQUES_V1,
  SHOT_TYPES,
  STABILITY_EVENT_KINDS,
  TRIAL_USER_FLAGS,
  aggregateStabilitySlo,
  computePlayerRank,
  deriveConsentStatus,
  evaluateStabilitySlo,
  guardRolloutAdvance,
  isRetentionExpired,
  projectVoiceResolution,
  resolveTechniqueIntent,
  resolveVoiceTechniqueIntent,
  retentionDeadline,
  stabilityRolloutDecision,
  validateEvaluationTrial,
  type ConsentRecord,
  type IntentResolution,
  type PlayerRankAnalysisInput,
  type StabilitySloEvent,
  type VoiceIntentResolution,
} from "../../src/index.js";
import { VOICE_ADVERSARIAL_CORPUS } from "../../test/voiceAdversarialCorpus.js";
import { VOICE_EVAL_CORPUS } from "../../test/voiceUtteranceEvalCorpus.js";
import type { ScenarioResult } from "./campaign.js";
import { createRng, type Rng } from "./rng.js";

const SELECTABLE_CANONICALS = new Set(SELECTABLE_TECHNIQUES_V1.map((t) => t.canonical));
const TAXONOMY_SLUGS = new Set(PICKLEBALL_TECHNIQUES.map((t) => t.slug));
const TIER_KEYS = new Set(PLAYER_RANK_TIERS.map((t) => t.key));

interface CorpusEntry {
  transcript: string;
  gold: { kind: "resolved"; canonical: string } | { kind: "ambiguous" | "auto" | "unknown" };
}

const CORPUS: readonly CorpusEntry[] = [
  ...VOICE_EVAL_CORPUS.map((u) => ({ transcript: u.transcript, gold: u.gold })),
  ...VOICE_ADVERSARIAL_CORPUS.map((u) => ({ transcript: u.transcript, gold: u.gold })),
];

const NOISE_ALPHABET = "abcdefghijklmnopqrstuvwxyz      ,.!?'-0123456789éüñ日本語😀\n\t";

function isFiniteIn(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

// ---------------------------------------------------------------- player rank

function seededAnalysis(rng: Rng): PlayerRankAnalysisInput {
  const scoreRoll = rng.next();
  const overallScore =
    scoreRoll < 0.7
      ? Math.round(rng.next() * 1000) / 100
      : scoreRoll < 0.8
        ? null
        : scoreRoll < 0.88
          ? rng.pick([-3, 10.01, 42, -0.001])
          : rng.pick([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
  const input: PlayerRankAnalysisInput = {
    shotType: rng.chance(0.9) ? rng.pick(SHOT_TYPES) : rng.word(rng.int(0, 12)),
    overallScore,
    resultKind: rng.chance(0.75) ? "scored" : rng.pick(["low_confidence", "abstained", ""]),
    capturedAt: rng.chance(0.92) ? rng.isoDate() : rng.pick(["", "not-a-date", "2026-13-40"]),
  };
  if (rng.chance(0.8)) input.id = rng.uuid();
  if (rng.chance(0.85)) input.source = rng.chance(0.9) ? "real" : rng.pick(["synthetic", "demo"]);
  return input;
}

function exerciseRank(rng: Rng, violations: string[], stats: Record<string, number>) {
  const analyses = Array.from({ length: rng.int(0, 40) }, () => seededAnalysis(rng));
  const summary = computePlayerRank(analyses);
  const shuffled = computePlayerRank(rng.shuffle(analyses));
  stats.rankInputs = analyses.length;
  stats.rankNull = summary === null ? 1 : 0;
  const countable = analyses.filter(
    (a) =>
      a.resultKind === "scored" &&
      typeof a.overallScore === "number" &&
      Number.isFinite(a.overallScore) &&
      a.overallScore >= 0 &&
      a.overallScore <= 10 &&
      (a.source === undefined || a.source === "real") &&
      (SHOT_TYPES as readonly string[]).includes(a.shotType) &&
      !Number.isNaN(Date.parse(a.capturedAt)),
  );
  if (summary === null) {
    if (countable.length > 0) {
      violations.push(`rank: null although ${countable.length} countable analyses were supplied`);
    }
  } else {
    if (!isFiniteIn(summary.rating, 0, 10)) violations.push(`rank: rating ${summary.rating}`);
    if (!TIER_KEYS.has(summary.tier)) violations.push(`rank: unknown tier ${summary.tier}`);
    if (summary.techniqueCount !== summary.techniques.length) {
      violations.push("rank: techniqueCount != techniques.length");
    }
    if (summary.scoredAnalysisCount < summary.techniqueCount) {
      violations.push("rank: scoredAnalysisCount < techniqueCount");
    }
    for (const technique of summary.techniques) {
      if (!isFiniteIn(technique.score, 0, 10)) {
        violations.push(`rank: technique ${technique.shotType} score ${technique.score}`);
      }
    }
    if (summary.nextTier !== null && !isFiniteIn(summary.nextTier.pointsNeeded, 0, 10)) {
      violations.push(`rank: pointsNeeded ${summary.nextTier.pointsNeeded}`);
    }
  }
  if (JSON.stringify(summary) !== JSON.stringify(shuffled)) {
    violations.push("rank: result depends on input order");
  }
  return { analyses, summary };
}

// -------------------------------------------------------------- voice intent

function mutateTranscript(rng: Rng, transcript: string): string {
  let out = transcript;
  if (rng.chance(0.5)) {
    out = [...out].map((ch) => (rng.chance(0.3) ? ch.toUpperCase() : ch)).join("");
  }
  if (rng.chance(0.4)) out = `  ${out.replaceAll(" ", rng.pick(["  ", " \t", "\n"]))}  `;
  if (rng.chance(0.4)) out = `${out}${rng.pick([".", "!", "?", "...", " um", ", please"])}`;
  return out;
}

function noiseTranscript(rng: Rng): string {
  const length = rng.int(0, 160);
  let out = "";
  for (let i = 0; i < length; i += 1) out += NOISE_ALPHABET[rng.int(0, NOISE_ALPHABET.length - 1)];
  return out;
}

function checkVoiceShape(
  label: string,
  voice: VoiceIntentResolution,
  projected: IntentResolution,
  violations: string[],
) {
  switch (voice.status) {
    case "leaf":
      if (!TAXONOMY_SLUGS.has(voice.slug)) violations.push(`${label}: leaf slug ${voice.slug}`);
      if (!isFiniteIn(voice.confidence, 0, 1)) {
        violations.push(`${label}: leaf confidence ${voice.confidence}`);
      }
      break;
    case "family":
    case "side":
      for (const slug of voice.candidates) {
        if (!TAXONOMY_SLUGS.has(slug)) violations.push(`${label}: candidate slug ${slug}`);
      }
      if (voice.candidates.length === 0)
        violations.push(`${label}: ${voice.status} with no candidates`);
      break;
    case "auto":
      break;
    case "unknown":
      if (typeof voice.rePrompt !== "string" || voice.rePrompt.length === 0) {
        violations.push(`${label}: unknown without rePrompt`);
      }
      break;
    default:
      violations.push(`${label}: voice status outside union`);
  }
  checkIntentShape(label, projected, violations);
}

function checkIntentShape(label: string, intent: IntentResolution, violations: string[]) {
  switch (intent.status) {
    case "resolved":
      if (!SELECTABLE_CANONICALS.has(intent.technique.canonical)) {
        violations.push(`${label}: resolved outside registry ${intent.technique.canonical}`);
      }
      if (!isFiniteIn(intent.confidence, 0, 1))
        violations.push(`${label}: confidence ${intent.confidence}`);
      break;
    case "ambiguous":
      if (intent.options.length === 0) violations.push(`${label}: ambiguous with no options`);
      for (const option of intent.options) {
        if (!SELECTABLE_CANONICALS.has(option.canonical)) {
          violations.push(`${label}: ambiguous option outside registry ${option.canonical}`);
        }
      }
      break;
    case "auto":
    case "unknown":
      break;
    default:
      violations.push(`${label}: intent status outside union`);
  }
}

function exerciseVoice(rng: Rng, violations: string[], stats: Record<string, number>) {
  const picked = rng.shuffle(CORPUS).slice(0, 12);
  const corpusOutcomes = picked.map((entry) => {
    const voice = resolveVoiceTechniqueIntent(entry.transcript);
    const projected = projectVoiceResolution(voice);
    checkVoiceShape(`corpus "${entry.transcript}"`, voice, projected, violations);
    const canonical = projected.status === "resolved" ? projected.technique.canonical : null;
    const falseAccept =
      projected.status === "resolved" &&
      (entry.gold.kind !== "resolved" || canonical !== entry.gold.canonical);
    if (falseAccept) {
      violations.push(`voice false accept: "${entry.transcript}" → ${canonical}`);
    }
    const abstained = projected.status !== "resolved";
    return { transcript: entry.transcript, voice, projected, abstained };
  });
  stats.voiceCorpus = corpusOutcomes.length;
  stats.voiceCorpusAbstained = corpusOutcomes.filter((o) => o.abstained).length;

  const mutated = picked.slice(0, 6).map((entry) => {
    const transcript = mutateTranscript(rng, entry.transcript);
    const voice = resolveVoiceTechniqueIntent(transcript);
    const projected = projectVoiceResolution(voice);
    checkVoiceShape(`mutated "${transcript}"`, voice, projected, violations);
    if (projected.status === "resolved" && entry.gold.kind === "resolved") {
      if (projected.technique.canonical !== entry.gold.canonical) {
        violations.push(
          `voice mutated false accept: "${transcript}" → ${projected.technique.canonical} (gold ${entry.gold.canonical})`,
        );
      }
    } else if (projected.status === "resolved") {
      violations.push(
        `voice mutated false accept: "${transcript}" → ${projected.technique.canonical}`,
      );
    }
    return { transcript, voice, projected };
  });
  stats.voiceMutated = mutated.length;

  const noise = Array.from({ length: 6 }, () => {
    const transcript = noiseTranscript(rng);
    const voice = resolveVoiceTechniqueIntent(transcript);
    const projected = projectVoiceResolution(voice);
    checkVoiceShape(`noise ${JSON.stringify(transcript)}`, voice, projected, violations);
    const intent = resolveTechniqueIntent(transcript);
    checkIntentShape(`noise intent ${JSON.stringify(transcript)}`, intent, violations);
    return { transcript, voice, projected, intent };
  });
  stats.voiceNoise = noise.length;
  stats.voiceNoiseResolved = noise.filter((n) => n.projected.status === "resolved").length;

  const intents = picked.slice(0, 6).map((entry) => {
    const intent = resolveTechniqueIntent(entry.transcript);
    checkIntentShape(`intent "${entry.transcript}"`, intent, violations);
    return { transcript: entry.transcript, intent };
  });
  return { corpusOutcomes, mutated, noise, intents };
}

// ---------------------------------------------------------- evaluation trial

function trialTemplate(rng: Rng): Record<string, unknown> {
  return {
    schemaVersion: EVALUATION_TRIAL_SCHEMA_VERSION,
    trialId: rng.uuid(),
    captureId: rng.word(8),
    analysisId: rng.chance(0.8) ? rng.word(6) : null,
    capturedAtIso: rng.isoDate(),
    recordedAtIso: rng.isoDate(),
    outcomeKind: rng.pick(["scored", "low_confidence", "unavailable", "quality_blocked"]),
    outcomeReason: rng.chance(0.5) ? rng.word(10) : null,
    envelopeOverall: rng.pick(["SUPPORTED", "DEGRADED", "UNSUPPORTED", null]),
    latencyMs: rng.chance(0.8) ? rng.int(0, 30000) : null,
    appVersion: `0.${rng.int(0, 9)}.${rng.int(0, 99)}`,
    engineVersion: rng.chance(0.7) ? rng.word(7) : null,
    modelBundleVersion: rng.chance(0.7) ? rng.word(9) : null,
    declaredStroke: rng.chance(0.5) ? rng.pick(SHOT_TYPES) : null,
    claims: {
      targetLock: { status: rng.pick(["presented", "abstained", "not_measured"]) },
      eventSelection: {
        status: "presented",
        startMs: rng.int(0, 1000),
        endMs: rng.int(1000, 3000),
      },
      strokeLabel: {
        status: "presented",
        label: rng.chance(0.8) ? "FOREHAND" : null,
        confidence: rng.next(),
      },
      contactMarker: {
        status: rng.pick(["presented", "abstained"]),
        estimatedContactMs: rng.chance(0.5) ? rng.int(0, 3000) : null,
        ballConfirmed: rng.chance(0.5),
        paddleConfirmed: rng.chance(0.5),
      },
      phaseRender: {
        status: "presented",
        contactMs: rng.int(0, 3000),
        followThroughEndMs: rng.int(0, 3000),
      },
      resultScore: {
        status: "presented",
        overallScore: rng.chance(0.8) ? rng.int(0, 100) : null,
        analysisConfidence: rng.next(),
        presentation: rng.pick(["normal", "lower_confidence", "abstain", null]),
      },
    },
    limitingFactors: Array.from({ length: rng.int(0, 4) }, () => rng.word(6)),
    userFlags: rng.shuffle(TRIAL_USER_FLAGS).slice(0, rng.int(0, 3)),
    dims: {
      userPseudonym: rng.chance(0.5) ? rng.word(12) : null,
      sessionId: rng.chance(0.8) ? rng.word(8) : null,
      courtId: null,
      deviceModel: rng.chance(0.9) ? `iPhone${rng.int(12, 17)},${rng.int(1, 4)}` : null,
      devicePlatform: "ios",
      osVersion: `${rng.int(15, 19)}.${rng.int(0, 6)}`,
    },
    consent: { scope: "evaluation_telemetry", consentVersion: "evaluation-telemetry-v1" },
  };
}

type TrialCorruption = { kind: string; apply: (trial: Record<string, unknown>) => unknown };

const TRIAL_CORRUPTIONS: readonly TrialCorruption[] = [
  { kind: "primitive", apply: () => 42 },
  { kind: "null", apply: () => null },
  { kind: "array", apply: (t) => [t] },
  { kind: "schemaVersion", apply: (t) => ({ ...t, schemaVersion: "evaluation-trial-v0" }) },
  { kind: "dropTrialId", apply: ({ trialId: _drop, ...rest }) => rest },
  { kind: "emptyAppVersion", apply: (t) => ({ ...t, appVersion: "" }) },
  { kind: "latencyNaN", apply: (t) => ({ ...t, latencyMs: Number.NaN }) },
  { kind: "latencyInfinity", apply: (t) => ({ ...t, latencyMs: Number.POSITIVE_INFINITY }) },
  { kind: "outcomeKind", apply: (t) => ({ ...t, outcomeKind: "verdict" }) },
  { kind: "envelope", apply: (t) => ({ ...t, envelopeOverall: "GREAT" }) },
  { kind: "claimsMissing", apply: ({ claims: _drop, ...rest }) => rest },
  {
    kind: "claimStatus",
    apply: (t) => ({
      ...t,
      claims: { ...(t.claims as Record<string, unknown>), targetLock: { status: "guessed" } },
    }),
  },
  {
    kind: "scoreNaN",
    apply: (t) => ({
      ...t,
      claims: {
        ...(t.claims as Record<string, unknown>),
        resultScore: {
          status: "presented",
          overallScore: Number.NaN,
          analysisConfidence: 0.5,
          presentation: "normal",
        },
      },
    }),
  },
  {
    kind: "contactConfirmations",
    apply: (t) => ({
      ...t,
      claims: {
        ...(t.claims as Record<string, unknown>),
        contactMarker: {
          status: "presented",
          estimatedContactMs: 12,
          ballConfirmed: "yes",
          paddleConfirmed: true,
        },
      },
    }),
  },
  { kind: "userFlags", apply: (t) => ({ ...t, userFlags: ["definitely_broken"] }) },
  { kind: "limitingFactors", apply: (t) => ({ ...t, limitingFactors: [1, 2] }) },
  {
    kind: "dimsPlatform",
    apply: (t) => ({ ...t, dims: { ...(t.dims as object), devicePlatform: "web" } }),
  },
  {
    kind: "consentScope",
    apply: (t) => ({ ...t, consent: { scope: "model_training", consentVersion: "x" } }),
  },
  {
    kind: "consentVersionEmpty",
    apply: (t) => ({ ...t, consent: { scope: "evaluation_telemetry", consentVersion: "" } }),
  },
];

function exerciseTrial(rng: Rng, violations: string[], stats: Record<string, number>) {
  const template = trialTemplate(rng);
  const clean = validateEvaluationTrial(template);
  if (!clean.ok || clean.errors.length !== 0) {
    violations.push(`trial: clean template rejected: ${clean.errors.join("; ")}`);
  }
  const corruptions = rng.shuffle(TRIAL_CORRUPTIONS).slice(0, rng.int(1, 5));
  const rejected = corruptions.map((corruption) => {
    const result = validateEvaluationTrial(corruption.apply(structuredClone(template)));
    if (result.ok || result.errors.length === 0) {
      violations.push(`trial: corruption ${corruption.kind} accepted`);
    }
    if (result.ok !== (result.errors.length === 0)) violations.push("trial: ok/errors disagree");
    return { kind: corruption.kind, result };
  });
  stats.trialCorruptions = rejected.length;
  return { clean, rejected };
}

// ------------------------------------------------------------------- consent

function seededConsentRecord(rng: Rng, seq: number | undefined): ConsentRecord {
  const record: ConsentRecord = {
    id: rng.uuid(),
    subjectPseudonym: rng.word(16),
    scope: rng.pick(CONSENT_SCOPES),
    action: rng.pick(CONSENT_ACTIONS),
    consentVersion: `${rng.pick(["video-analysis", "model-training", "evaluation-telemetry"])}-v${rng.int(1, 3)}`,
    source: rng.pick(CONSENT_SOURCES),
    device: rng.chance(0.6) ? rng.word(8) : null,
    captureMode: rng.chance(0.6) ? rng.pick(CONSENT_CAPTURE_MODES) : null,
    strokeIntent: rng.chance(0.3) ? rng.pick(SHOT_TYPES) : null,
    recordedAtIso: rng.isoDate(),
  };
  if (seq !== undefined) record.seq = seq;
  return record;
}

function exerciseConsent(rng: Rng, violations: string[], stats: Record<string, number>) {
  const count = rng.int(0, 30);
  const mode = rng.pick(["all_seq", "no_seq", "mixed_seq"] as const);
  const records = Array.from({ length: count }, (_, i) =>
    seededConsentRecord(
      rng,
      mode === "all_seq"
        ? i + 1
        : mode === "no_seq"
          ? undefined
          : rng.chance(0.5)
            ? i + 1
            : undefined,
    ),
  );
  // Ties on the millisecond timestamp are realistic; force some.
  if (records.length > 2 && rng.chance(0.5)) {
    const tieAt = rng.isoDate();
    for (const record of records) if (rng.chance(0.4)) record.recordedAtIso = tieAt;
  }
  const status = deriveConsentStatus(records);
  const shuffledStatus = deriveConsentStatus(rng.shuffle(records));
  stats.consentRecords = count;
  if (status.length !== CONSENT_SCOPES.length) violations.push("consent: status count != scopes");
  for (const scope of CONSENT_SCOPES) {
    const entries = status.filter((s) => s.scope === scope);
    if (entries.length !== 1) {
      violations.push(`consent: scope ${scope} appears ${entries.length} times`);
      continue;
    }
    const entry = entries[0]!;
    if (entry.active !== (entry.lastAction === "granted")) {
      violations.push(`consent: ${scope} active=${entry.active} lastAction=${entry.lastAction}`);
    }
    if (!records.some((r) => r.scope === scope)) {
      if (entry.active || entry.lastAction !== null || entry.consentVersion !== null) {
        violations.push(`consent: ${scope} not inactive without records`);
      }
    }
  }
  const orderIndependent = JSON.stringify(status) === JSON.stringify(shuffledStatus);
  if (mode === "all_seq" && !orderIndependent) {
    violations.push("consent: status depends on input order despite unique seq on every record");
  }
  stats.consentOrderDivergence = orderIndependent ? 0 : 1;
  stats[`consentOrderDivergence_${mode}`] = orderIndependent ? 0 : 1;
  return { mode, status, orderIndependent };
}

// ------------------------------------------------------------- stability SLO

function seededStabilityEvent(
  rng: Rng,
  users: readonly string[],
  sessions: readonly string[],
): StabilitySloEvent {
  const base = {
    userKey: rng.pick(users),
    sessionKey: rng.chance(0.9) ? rng.pick(sessions) : null,
    at: rng.isoDate(),
  };
  const kind = rng.pick(STABILITY_EVENT_KINDS);
  switch (kind) {
    case "crash":
      return { ...base, kind, fatal: rng.chance(0.6), fingerprint: rng.word(16) };
    case "analysis_failed":
      return { ...base, kind, failureKind: rng.word(6) };
    case "camera_startup_failed":
    case "try_again_failed":
    case "session_flow_failed":
      return { ...base, kind, reason: rng.word(6) };
    default:
      return { ...base, kind };
  }
}

function exerciseStability(rng: Rng, violations: string[], stats: Record<string, number>) {
  const users = Array.from({ length: rng.int(1, 6) }, () => rng.word(10));
  const sessions = Array.from({ length: rng.int(1, 10) }, () => rng.word(10));
  const events = Array.from({ length: rng.int(0, 200) }, () =>
    seededStabilityEvent(rng, users, sessions),
  );
  const metrics = aggregateStabilitySlo(events);
  const shuffledMetrics = aggregateStabilitySlo(rng.shuffle(events));
  stats.stabilityEvents = events.length;
  // Crash-free rates are "users/sessions without a fatal crash ÷ observed",
  // so [0, 1] holds by construction. The other rates are documented ratios
  // (completed ÷ started, terminations ÷ sessions) whose numerator is not
  // bounded by the denominator inside one window — >1 is counted, not failed.
  stats.sloRateAbove1 = 0;
  for (const [key, value] of Object.entries(metrics)) {
    if (key.endsWith("Rate")) {
      if (value === null) continue;
      const bounded = key.startsWith("crashFree");
      if (!isFiniteIn(value, 0, bounded ? 1 : Number.MAX_SAFE_INTEGER)) {
        violations.push(`slo: ${key} = ${String(value)}`);
      } else if (value > 1) {
        stats.sloRateAbove1 += 1;
      }
    } else if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) {
      violations.push(`slo: ${key} = ${String(value)}`);
    }
  }
  if (JSON.stringify(metrics) !== JSON.stringify(shuffledMetrics)) {
    violations.push("slo: aggregation depends on event order");
  }
  const evaluation = evaluateStabilitySlo(metrics);
  const decision = stabilityRolloutDecision(evaluation);
  const breached = evaluation.results.filter((r) => r.verdict === "breach").length;
  const notEvaluable = evaluation.results.filter((r) => r.verdict === "not_evaluable").length;
  const expectedAction = breached > 0 ? "pause" : notEvaluable > 0 ? "hold" : "proceed";
  if (decision.action !== expectedAction) {
    violations.push(`slo: action ${decision.action} expected ${expectedAction}`);
  }
  const current = rng.int(0, 100);
  const requested = rng.int(0, 100);
  const guard = guardRolloutAdvance(decision, current, requested);
  if (requested <= current && !guard.allowed) violations.push("slo: reducing exposure was blocked");
  if (requested > current && guard.allowed && decision.action !== "proceed") {
    violations.push(`slo: advance allowed under ${decision.action}`);
  }
  if (!Number.isFinite(guard.effectiveRolloutPercent))
    violations.push("slo: effective percent non-finite");
  return { metrics, evaluation, decision, guard: { current, requested, ...guard } };
}

// ------------------------------------------------------------ media retention

function exerciseRetention(rng: Rng, violations: string[], stats: Record<string, number>) {
  const checks = Array.from({ length: 8 }, () => {
    const kind = rng.pick(MEDIA_ASSET_KINDS);
    const createdAt = new Date(Date.parse(rng.isoDate()));
    const userRetentionDays = rng.chance(0.5)
      ? null
      : rng.pick([0, -1, 1, 7, 30, 365, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 1e9]);
    const expiresAt = rng.chance(0.3) ? new Date(Date.parse(rng.isoDate())) : null;
    const now = new Date(Date.parse(rng.isoDate()));
    const deadline = retentionDeadline(
      MEDIA_RETENTION_POLICY_V1.rules[kind],
      createdAt,
      userRetentionDays,
    );
    if (deadline !== null && Number.isNaN(deadline.getTime())) {
      violations.push(`retention: invalid deadline for ${kind} days=${String(userRetentionDays)}`);
    }
    const expired = isRetentionExpired(
      { kind, createdAt, expiresAt, userRetentionDays },
      MEDIA_RETENTION_POLICY_V1,
      now,
    );
    if (typeof expired !== "boolean") violations.push("retention: expired not boolean");
    return { kind, createdAt, userRetentionDays, expiresAt, now, deadline, expired };
  });
  stats.retentionChecks = checks.length;
  return checks;
}

// ------------------------------------------------------------------ scenario

export function sharedTypesScenario(seed: number): ScenarioResult {
  const rng = createRng(seed);
  const violations: string[] = [];
  const stats: Record<string, number> = {};
  const rank = exerciseRank(rng, violations, stats);
  const voice = exerciseVoice(rng, violations, stats);
  const trial = exerciseTrial(rng, violations, stats);
  const consent = exerciseConsent(rng, violations, stats);
  const stability = exerciseStability(rng, violations, stats);
  const retention = exerciseRetention(rng, violations, stats);
  return {
    // Inputs with non-finite numbers are deliberately fed to the unit; only
    // OUTPUTS are fingerprinted/scanned, so a NaN here would be the unit's.
    outputs: {
      rank: rank.summary,
      voice,
      trial,
      consent: {
        mode: consent.mode,
        status: consent.status,
        orderIndependent: consent.orderIndependent,
      },
      stability,
      retention: retention.map((c) => ({ kind: c.kind, deadline: c.deadline, expired: c.expired })),
    },
    violations,
    stats,
  };
}
