import { describe, expect, it } from "vitest";
import type { EvaluationTrialRecord, TrialClaims } from "@pickle/shared-types";
import {
  detectClassifierOscillation,
  detectContactOutsideEventBounds,
  detectContactWithoutPaddleEvidence,
  detectDeclaredPredictedMismatch,
  detectDegradedCaptureConfidentAnalysis,
  detectHighConfidenceContradictoryModalities,
  detectImpossiblePhaseOrdering,
  detectImpossibleSessionEventDensity,
  detectRapidRepeatedRetries,
  detectTargetIdentityInstability,
  detectTriageSignals,
  TRIAGE_SIGNAL_KINDS,
  TRIAGE_THRESHOLDS,
} from "../src/triageSignals.js";
import { buildFreshUserReport } from "../src/freshUserTrials.js";

function claims(overrides: Partial<TrialClaims> = {}): TrialClaims {
  return {
    targetLock: { status: "presented" },
    eventSelection: { status: "presented", startMs: 0, endMs: 900 },
    strokeLabel: { status: "presented", label: "FOREHAND_DRIVE", confidence: 0.8 },
    contactMarker: {
      status: "presented",
      estimatedContactMs: 450,
      ballConfirmed: true,
      paddleConfirmed: true,
    },
    phaseRender: { status: "presented", contactMs: 450, followThroughEndMs: 800 },
    resultScore: {
      status: "presented",
      overallScore: 72,
      analysisConfidence: 0.6,
      presentation: "normal",
    },
    ...overrides,
  };
}

function trial(overrides: Partial<EvaluationTrialRecord> = {}): EvaluationTrialRecord {
  return {
    schemaVersion: "evaluation-trial-v1",
    trialId: "trial-1",
    captureId: "cap-1",
    analysisId: "an-1",
    capturedAtIso: "2026-08-29T00:00:00.000Z",
    recordedAtIso: "2026-08-29T00:00:01.000Z",
    outcomeKind: "scored",
    outcomeReason: null,
    envelopeOverall: "SUPPORTED",
    latencyMs: 900,
    appVersion: "0.1.0",
    engineVersion: "fusion-1",
    modelBundleVersion: "on-device-fusion-1",
    declaredStroke: null,
    claims: claims(),
    limitingFactors: [],
    userFlags: [],
    dims: {
      userPseudonym: "u1",
      sessionId: "s1",
      courtId: "court-a",
      deviceModel: "iPhone15,2",
      devicePlatform: "ios",
      osVersion: "17.5",
    },
    consent: { scope: "evaluation_telemetry", consentVersion: "evaluation-telemetry-v1" },
    ...overrides,
  };
}

const atSeconds = (seconds: number): string =>
  new Date(Date.parse("2026-08-29T00:00:00.000Z") + seconds * 1000).toISOString();

describe("HIGH_CONFIDENCE_CONTRADICTORY_MODALITIES", () => {
  it("fires when a very confident normal Result carries contact modalities that disagree beyond the fabricated-marker bound", () => {
    const t = trial({
      claims: claims({
        contactMarker: {
          status: "presented",
          estimatedContactMs: 450,
          ballConfirmed: true,
          paddleConfirmed: true,
        },
        phaseRender: { status: "presented", contactMs: 700, followThroughEndMs: 1200 },
        resultScore: {
          status: "presented",
          overallScore: 80,
          analysisConfidence: 0.9,
          presentation: "normal",
        },
      }),
    });
    const signal = detectHighConfidenceContradictoryModalities(t);
    expect(signal?.kind).toBe("HIGH_CONFIDENCE_CONTRADICTORY_MODALITIES");
    expect(signal?.trialIds).toEqual(["trial-1"]);
  });

  it("stays silent when modalities agree, confidence is low, or the Result is not presented normal", () => {
    const agree = trial({
      claims: claims({
        resultScore: {
          status: "presented",
          overallScore: 80,
          analysisConfidence: 0.9,
          presentation: "normal",
        },
      }),
    });
    expect(detectHighConfidenceContradictoryModalities(agree)).toBeNull();
    const lowConfidence = trial({
      claims: claims({
        phaseRender: { status: "presented", contactMs: 700, followThroughEndMs: 1200 },
      }),
    });
    expect(detectHighConfidenceContradictoryModalities(lowConfidence)).toBeNull();
    const lowered = trial({
      claims: claims({
        phaseRender: { status: "presented", contactMs: 700, followThroughEndMs: 1200 },
        resultScore: {
          status: "presented",
          overallScore: 80,
          analysisConfidence: 0.9,
          presentation: "lower_confidence",
        },
      }),
    });
    expect(detectHighConfidenceContradictoryModalities(lowered)).toBeNull();
  });
});

describe("DECLARED_PREDICTED_MISMATCH", () => {
  it("fires when the declared L1 side contradicts the presented label", () => {
    const t = trial({
      declaredStroke: "BACKHAND_DINK",
      claims: claims({
        strokeLabel: { status: "presented", label: "FOREHAND_DRIVE", confidence: 0.9 },
      }),
    });
    expect(detectDeclaredPredictedMismatch(t)?.kind).toBe("DECLARED_PREDICTED_MISMATCH");
  });

  it("stays silent on matching sides, no declaration, abstained label, or sideless labels", () => {
    expect(detectDeclaredPredictedMismatch(trial({ declaredStroke: "FOREHAND_DRIVE" }))).toBeNull();
    expect(detectDeclaredPredictedMismatch(trial({ declaredStroke: null }))).toBeNull();
    const abstained = trial({
      declaredStroke: "BACKHAND_DINK",
      claims: claims({ strokeLabel: { status: "abstained", label: null, confidence: null } }),
    });
    expect(detectDeclaredPredictedMismatch(abstained)).toBeNull();
    const sideless = trial({
      declaredStroke: "SERVE",
      claims: claims({
        strokeLabel: { status: "presented", label: "FOREHAND_DRIVE", confidence: 0.9 },
      }),
    });
    expect(detectDeclaredPredictedMismatch(sideless)).toBeNull();
  });
});

describe("TARGET_IDENTITY_INSTABILITY", () => {
  const lock = (status: "presented" | "abstained" | "not_measured") =>
    claims({ targetLock: { status } });

  it("fires when the lock flips presented/abstained repeatedly within a session", () => {
    const trials = [
      trial({ trialId: "a", capturedAtIso: atSeconds(0), claims: lock("presented") }),
      trial({ trialId: "b", capturedAtIso: atSeconds(10), claims: lock("abstained") }),
      trial({ trialId: "c", capturedAtIso: atSeconds(20), claims: lock("presented") }),
    ];
    const signals = detectTargetIdentityInstability(trials);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe("TARGET_IDENTITY_INSTABILITY");
    expect(signals[0]!.sessionId).toBe("s1");
    expect(signals[0]!.trialIds).toEqual(["a", "b", "c"]);
  });

  it("stays silent for a stable lock, a single flip, or trials without a session", () => {
    const stable = [
      trial({ trialId: "a", capturedAtIso: atSeconds(0), claims: lock("presented") }),
      trial({ trialId: "b", capturedAtIso: atSeconds(10), claims: lock("presented") }),
      trial({ trialId: "c", capturedAtIso: atSeconds(20), claims: lock("presented") }),
    ];
    expect(detectTargetIdentityInstability(stable)).toHaveLength(0);
    const oneFlip = [
      trial({ trialId: "a", capturedAtIso: atSeconds(0), claims: lock("presented") }),
      trial({ trialId: "b", capturedAtIso: atSeconds(10), claims: lock("abstained") }),
    ];
    expect(detectTargetIdentityInstability(oneFlip)).toHaveLength(0);
    const noSession = [
      trial({
        trialId: "a",
        capturedAtIso: atSeconds(0),
        claims: lock("presented"),
        dims: { ...trial().dims, sessionId: null },
      }),
      trial({
        trialId: "b",
        capturedAtIso: atSeconds(10),
        claims: lock("abstained"),
        dims: { ...trial().dims, sessionId: null },
      }),
      trial({
        trialId: "c",
        capturedAtIso: atSeconds(20),
        claims: lock("presented"),
        dims: { ...trial().dims, sessionId: null },
      }),
    ];
    expect(detectTargetIdentityInstability(noSession)).toHaveLength(0);
  });
});

describe("CONTACT_OUTSIDE_EVENT_BOUNDS", () => {
  it("fires when the presented contact marker lies outside the presented event window", () => {
    const t = trial({
      claims: claims({
        contactMarker: {
          status: "presented",
          estimatedContactMs: 1500,
          ballConfirmed: true,
          paddleConfirmed: true,
        },
      }),
    });
    expect(detectContactOutsideEventBounds(t)?.kind).toBe("CONTACT_OUTSIDE_EVENT_BOUNDS");
  });

  it("stays silent for a contact inside bounds or with either claim abstained", () => {
    expect(detectContactOutsideEventBounds(trial())).toBeNull();
    const noEvent = trial({
      claims: claims({
        eventSelection: { status: "abstained", startMs: null, endMs: null },
        contactMarker: {
          status: "presented",
          estimatedContactMs: 1500,
          ballConfirmed: true,
          paddleConfirmed: true,
        },
      }),
    });
    expect(detectContactOutsideEventBounds(noEvent)).toBeNull();
    const noContact = trial({
      claims: claims({
        contactMarker: {
          status: "abstained",
          estimatedContactMs: null,
          ballConfirmed: false,
          paddleConfirmed: false,
        },
      }),
    });
    expect(detectContactOutsideEventBounds(noContact)).toBeNull();
  });
});

describe("CONTACT_WITHOUT_PADDLE_EVIDENCE", () => {
  it("fires when a contact marker is presented with neither paddle nor ball confirmation", () => {
    const t = trial({
      claims: claims({
        contactMarker: {
          status: "presented",
          estimatedContactMs: 450,
          ballConfirmed: false,
          paddleConfirmed: false,
        },
      }),
    });
    expect(detectContactWithoutPaddleEvidence(t)?.kind).toBe("CONTACT_WITHOUT_PADDLE_EVIDENCE");
  });

  it("stays silent when paddle or ball evidence backs the marker, or the marker abstained", () => {
    expect(detectContactWithoutPaddleEvidence(trial())).toBeNull();
    const ballOnly = trial({
      claims: claims({
        contactMarker: {
          status: "presented",
          estimatedContactMs: 450,
          ballConfirmed: true,
          paddleConfirmed: false,
        },
      }),
    });
    expect(detectContactWithoutPaddleEvidence(ballOnly)).toBeNull();
    const abstained = trial({
      claims: claims({
        contactMarker: {
          status: "abstained",
          estimatedContactMs: null,
          ballConfirmed: false,
          paddleConfirmed: false,
        },
      }),
    });
    expect(detectContactWithoutPaddleEvidence(abstained)).toBeNull();
  });
});

describe("IMPOSSIBLE_PHASE_ORDERING", () => {
  it("fires when followThroughEnd is at or before contact", () => {
    const t = trial({
      claims: claims({
        phaseRender: { status: "presented", contactMs: 800, followThroughEndMs: 450 },
      }),
    });
    expect(detectImpossiblePhaseOrdering(t)?.kind).toBe("IMPOSSIBLE_PHASE_ORDERING");
    const equal = trial({
      claims: claims({
        phaseRender: { status: "presented", contactMs: 450, followThroughEndMs: 450 },
      }),
    });
    expect(detectImpossiblePhaseOrdering(equal)?.kind).toBe("IMPOSSIBLE_PHASE_ORDERING");
  });

  it("stays silent for valid ordering, missing boundaries, or an abstained render", () => {
    expect(detectImpossiblePhaseOrdering(trial())).toBeNull();
    const missing = trial({
      claims: claims({
        phaseRender: { status: "presented", contactMs: null, followThroughEndMs: 450 },
      }),
    });
    expect(detectImpossiblePhaseOrdering(missing)).toBeNull();
    const abstained = trial({
      claims: claims({
        phaseRender: { status: "abstained", contactMs: null, followThroughEndMs: null },
      }),
    });
    expect(detectImpossiblePhaseOrdering(abstained)).toBeNull();
  });
});

describe("CLASSIFIER_OSCILLATION", () => {
  const labeled = (id: string, seconds: number, label: string) =>
    trial({
      trialId: id,
      capturedAtIso: atSeconds(seconds),
      claims: claims({ strokeLabel: { status: "presented", label, confidence: 0.9 } }),
    });

  it("fires when the L1 side alternates A→B→A repeatedly within a session", () => {
    const trials = [
      labeled("a", 0, "FOREHAND_DRIVE"),
      labeled("b", 10, "BACKHAND_DRIVE"),
      labeled("c", 20, "FOREHAND_DRIVE"),
      labeled("d", 30, "BACKHAND_DRIVE"),
    ];
    const signals = detectClassifierOscillation(trials);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe("CLASSIFIER_OSCILLATION");
    expect(signals[0]!.trialIds).toEqual(["a", "b", "c", "d"]);
  });

  it("stays silent for stable labels, a single side change, or sideless labels", () => {
    const stable = [
      labeled("a", 0, "FOREHAND_DRIVE"),
      labeled("b", 10, "FOREHAND_DINK"),
      labeled("c", 20, "FOREHAND_DRIVE"),
      labeled("d", 30, "FOREHAND_DRIVE"),
    ];
    expect(detectClassifierOscillation(stable)).toHaveLength(0);
    const oneChange = [
      labeled("a", 0, "FOREHAND_DRIVE"),
      labeled("b", 10, "BACKHAND_DRIVE"),
      labeled("c", 20, "BACKHAND_DRIVE"),
      labeled("d", 30, "BACKHAND_DRIVE"),
    ];
    expect(detectClassifierOscillation(oneChange)).toHaveLength(0);
    const sideless = [
      labeled("a", 0, "SERVE"),
      labeled("b", 10, "LOB"),
      labeled("c", 20, "SERVE"),
      labeled("d", 30, "LOB"),
    ];
    expect(detectClassifierOscillation(sideless)).toHaveLength(0);
  });
});

describe("DEGRADED_CAPTURE_CONFIDENT_ANALYSIS", () => {
  const confident = claims({
    resultScore: {
      status: "presented",
      overallScore: 85,
      analysisConfidence: 0.92,
      presentation: "normal",
    },
  });

  it("fires when the envelope is DEGRADED or UNSUPPORTED but the Result is very confident and normal", () => {
    const degraded = trial({ envelopeOverall: "DEGRADED", claims: confident });
    expect(detectDegradedCaptureConfidentAnalysis(degraded)?.kind).toBe(
      "DEGRADED_CAPTURE_CONFIDENT_ANALYSIS",
    );
    const unsupported = trial({ envelopeOverall: "UNSUPPORTED", claims: confident });
    expect(detectDegradedCaptureConfidentAnalysis(unsupported)?.kind).toBe(
      "DEGRADED_CAPTURE_CONFIDENT_ANALYSIS",
    );
  });

  it("stays silent for a supported envelope, low confidence, or lowered presentation", () => {
    expect(
      detectDegradedCaptureConfidentAnalysis(
        trial({ envelopeOverall: "SUPPORTED", claims: confident }),
      ),
    ).toBeNull();
    expect(
      detectDegradedCaptureConfidentAnalysis(trial({ envelopeOverall: "DEGRADED" })),
    ).toBeNull();
    const lowered = trial({
      envelopeOverall: "DEGRADED",
      claims: claims({
        resultScore: {
          status: "presented",
          overallScore: 85,
          analysisConfidence: 0.92,
          presentation: "lower_confidence",
        },
      }),
    });
    expect(detectDegradedCaptureConfidentAnalysis(lowered)).toBeNull();
  });
});

describe("IMPOSSIBLE_SESSION_EVENT_DENSITY", () => {
  it("fires when more trials land in the density window than a human can hit strokes", () => {
    const count = TRIAGE_THRESHOLDS.densityMaxTrialsPerWindow + 1;
    const trials = Array.from({ length: count }, (_, i) =>
      trial({ trialId: `t${i}`, capturedAtIso: atSeconds(i) }),
    );
    const signals = detectImpossibleSessionEventDensity(trials);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe("IMPOSSIBLE_SESSION_EVENT_DENSITY");
    expect(signals[0]!.trialIds).toHaveLength(count);
  });

  it("stays silent at the plausible maximum or when trials are spread out", () => {
    const atMax = Array.from({ length: TRIAGE_THRESHOLDS.densityMaxTrialsPerWindow }, (_, i) =>
      trial({ trialId: `t${i}`, capturedAtIso: atSeconds(i) }),
    );
    expect(detectImpossibleSessionEventDensity(atMax)).toHaveLength(0);
    const spread = Array.from({ length: TRIAGE_THRESHOLDS.densityMaxTrialsPerWindow + 1 }, (_, i) =>
      trial({ trialId: `t${i}`, capturedAtIso: atSeconds(i * 120) }),
    );
    expect(detectImpossibleSessionEventDensity(spread)).toHaveLength(0);
  });
});

describe("RAPID_REPEATED_RETRIES", () => {
  const retry = (id: string, seconds: number, captureId = "cap-1") =>
    trial({
      trialId: id,
      captureId,
      capturedAtIso: atSeconds(0),
      recordedAtIso: atSeconds(seconds),
    });

  it("fires when the same capture is re-analyzed three times inside the retry window", () => {
    const signals = detectRapidRepeatedRetries([retry("a", 0), retry("b", 20), retry("c", 40)]);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe("RAPID_REPEATED_RETRIES");
    expect(signals[0]!.trialIds).toEqual(["a", "b", "c"]);
  });

  it("stays silent for distinct captures or retries spread beyond the window", () => {
    const distinct = [retry("a", 0, "cap-1"), retry("b", 20, "cap-2"), retry("c", 40, "cap-3")];
    expect(detectRapidRepeatedRetries(distinct)).toHaveLength(0);
    const spread = [retry("a", 0), retry("b", 120), retry("c", 240)];
    expect(detectRapidRepeatedRetries(spread)).toHaveLength(0);
  });
});

describe("detectTriageSignals summary + report wiring", () => {
  it("aggregates all detectors with per-kind counts and the never-labels disposition", () => {
    const trials = [
      trial({
        trialId: "bad",
        envelopeOverall: "DEGRADED",
        claims: claims({
          contactMarker: {
            status: "presented",
            estimatedContactMs: 1500,
            ballConfirmed: false,
            paddleConfirmed: false,
          },
          phaseRender: { status: "presented", contactMs: 800, followThroughEndMs: 450 },
          resultScore: {
            status: "presented",
            overallScore: 90,
            analysisConfidence: 0.95,
            presentation: "normal",
          },
        }),
      }),
    ];
    const summary = detectTriageSignals(trials);
    expect(summary.disposition).toBe("route_to_human_triage_never_labels");
    expect(summary.countsByKind.CONTACT_OUTSIDE_EVENT_BOUNDS).toBe(1);
    expect(summary.countsByKind.CONTACT_WITHOUT_PADDLE_EVIDENCE).toBe(1);
    expect(summary.countsByKind.IMPOSSIBLE_PHASE_ORDERING).toBe(1);
    expect(summary.countsByKind.DEGRADED_CAPTURE_CONFIDENT_ANALYSIS).toBe(1);
    expect(summary.countsByKind.HIGH_CONFIDENCE_CONTRADICTORY_MODALITIES).toBe(1);
    for (const kind of TRIAGE_SIGNAL_KINDS) {
      expect(summary.countsByKind[kind]).toBeGreaterThanOrEqual(0);
    }
    expect(Object.keys(summary.countsByKind).sort()).toEqual([...TRIAGE_SIGNAL_KINDS].sort());
  });

  it("emits no signals for a clean trial set", () => {
    const summary = detectTriageSignals([trial()]);
    expect(summary.signals).toHaveLength(0);
  });

  it("surfaces triage signals in the fresh-user report without touching silent-failure counts", () => {
    const trials = [
      trial({
        trialId: "bad",
        claims: claims({
          phaseRender: { status: "presented", contactMs: 800, followThroughEndMs: 450 },
        }),
      }),
    ];
    const report = buildFreshUserReport(trials, [], () => "2026-08-29T03:00:00.000Z");
    expect(report.triage.countsByKind.IMPOSSIBLE_PHASE_ORDERING).toBe(1);
    expect(report.triage.disposition).toBe("route_to_human_triage_never_labels");
    // Signals are triage routing only — silent-failure events still require human labels.
    expect(report.silentFailures.byEvent.IMPOSSIBLE_PHASE).toBe(0);
    expect(report.silentFailures.trialsUnlabeled).toBe(1);
  });
});
