import {
  CONFUSION_THRESHOLDS_V1,
  createUsabilityFunnelRecorder,
  deriveConfusionEvents,
  OBSERVER_CONFUSION_CODES_V1,
  summarizeUsabilityFunnel,
  USABILITY_PROTOCOL_VERSION,
  type UsabilityFunnelEvent,
} from '../src/analysis/usabilityTelemetry';

/**
 * zero-handholding-usability-v1 — funnel recorder + pure confusion
 * derivation. Deterministic event logs in, deterministic verdicts out.
 */

const ev = (
  step: UsabilityFunnelEvent['step'],
  tMs: number,
  detail?: string,
): UsabilityFunnelEvent =>
  detail === undefined ? { step, tMs } : { step, tMs, detail };

describe('createUsabilityFunnelRecorder', () => {
  it('records ordered events with the injected clock', () => {
    let t = 1000;
    const recorder = createUsabilityFunnelRecorder(() => (t += 10));
    recorder.log('analyze_opened');
    recorder.log('intent_selected', 'AUTO');
    expect(recorder.events()).toEqual([
      { step: 'analyze_opened', tMs: 1010 },
      { step: 'intent_selected', tMs: 1020, detail: 'AUTO' },
    ]);
  });

  it('reset clears the session', () => {
    const recorder = createUsabilityFunnelRecorder(() => 1);
    recorder.log('analyze_opened');
    recorder.reset();
    expect(recorder.events()).toEqual([]);
  });
});

describe('deriveConfusionEvents', () => {
  it('a clean happy-path session derives zero confusion events', () => {
    const events = [
      ev('analyze_opened', 0),
      ev('intent_selected', 1_000, 'FOREHAND_DRIVE'),
      ev('camera_opened', 2_000),
      ev('readiness_state', 3_000, 'no_person'),
      ev('readiness_state', 4_000, 'hold_still'),
      ev('ready', 6_000),
      ev('readiness_state', 6_000, 'ready'),
      ev('stroke_captured', 9_000),
      ev('capture_saved', 9_500, 'locked'),
      ev('analysis_started', 9_600),
      ev('result_opened', 12_000),
    ];
    expect(deriveConfusionEvents(events)).toEqual([]);
  });

  it('flags intent reselection churn before the camera opens', () => {
    const events = [
      ev('intent_selected', 100, 'DINK'),
      ev('intent_selected', 200, 'AUTO'),
      ev('intent_selected', 300, 'SERVE'),
      ev('camera_opened', 400),
    ];
    const confusion = deriveConfusionEvents(events);
    expect(confusion).toHaveLength(1);
    expect(confusion[0]).toMatchObject({
      kind: 'intent_reselection_churn',
      tMs: 300,
    });
  });

  it('does not count intent changes after the camera opened', () => {
    const events = [
      ev('intent_selected', 100, 'DINK'),
      ev('camera_opened', 200),
      ev('intent_selected', 300, 'AUTO'),
      ev('intent_selected', 400, 'SERVE'),
    ];
    expect(deriveConfusionEvents(events)).toEqual([]);
  });

  it('flags slow camera-open → first-ready dwell', () => {
    const events = [
      ev('camera_opened', 0),
      ev('ready', CONFUSION_THRESHOLDS_V1.preReadyDwellMs + 1),
    ];
    const confusion = deriveConfusionEvents(events);
    expect(confusion).toHaveLength(1);
    expect(confusion[0]?.kind).toBe('pre_ready_dwell_exceeded');
  });

  it('a session that never reaches ready or capture derives no dwell signal', () => {
    expect(deriveConfusionEvents([ev('camera_opened', 0)])).toEqual([]);
  });

  it('flags readiness oscillation only at the threshold', () => {
    const once = [ev('ready', 100), ev('readiness_state', 200, 'no_person')];
    expect(deriveConfusionEvents(once)).toEqual([]);
    const twice = [
      ...once,
      ev('ready', 300),
      ev('readiness_state', 400, 'move_closer'),
    ];
    const confusion = deriveConfusionEvents(twice);
    expect(confusion).toHaveLength(1);
    expect(confusion[0]).toMatchObject({
      kind: 'readiness_oscillation',
      tMs: 400,
    });
  });

  it('flags the same error shown twice consecutively, once per streak', () => {
    const events = [
      ev('error_shown', 100, 'network down'),
      ev('error_shown', 200, 'network down'),
      ev('error_shown', 300, 'network down'),
    ];
    const confusion = deriveConfusionEvents(events);
    expect(confusion).toHaveLength(1);
    expect(confusion[0]).toMatchObject({ kind: 'repeated_error', tMs: 200 });
  });

  it('different consecutive errors are not a repeated-error signal', () => {
    const events = [
      ev('error_shown', 100, 'network down'),
      ev('error_shown', 200, 'pose sequence unreadable'),
    ];
    expect(deriveConfusionEvents(events)).toEqual([]);
  });

  it('flags abandonment only when nothing was captured first', () => {
    expect(
      deriveConfusionEvents([
        ev('camera_opened', 0),
        ev('attempt_abandoned', 5_000),
      ]),
    ).toEqual([
      {
        kind: 'abandoned_before_capture',
        tMs: 5_000,
        detail: 'camera closed before any stroke was captured',
      },
    ]);
    expect(
      deriveConfusionEvents([
        ev('camera_opened', 0),
        ev('stroke_captured', 3_000),
        ev('attempt_abandoned', 5_000),
      ]),
    ).toEqual([]);
  });
});

describe('summarizeUsabilityFunnel', () => {
  it('reports honest per-task completion (absence stays false)', () => {
    const summary = summarizeUsabilityFunnel([
      ev('analyze_opened', 0),
      ev('intent_selected', 100, 'AUTO'),
      ev('camera_opened', 200),
    ]);
    expect(summary).toMatchObject({
      protocolVersion: USABILITY_PROTOCOL_VERSION,
      reachedAnalyze: true,
      selectedIntent: true,
      openedCamera: true,
      sawReadiness: false,
      reachedReady: false,
      capturedStroke: false,
      reachedOutcome: false,
      usedTryAgain: false,
    });
  });

  it('an honest outcome surface counts as reaching an outcome', () => {
    const summary = summarizeUsabilityFunnel([
      ev('intent_outcome_shown', 100, 'abstained'),
    ]);
    expect(summary.reachedOutcome).toBe(true);
  });
});

describe('protocol vocabulary', () => {
  it('observer confusion codes carry non-empty definitions', () => {
    for (const definition of Object.values(OBSERVER_CONFUSION_CODES_V1)) {
      expect(definition.length).toBeGreaterThan(10);
    }
  });
});
