import {
  UNASSIGNED_STABILITY_USER_KEY,
  classifyPreviousRun,
  createStabilityRecorder,
  recordPreviousRunOutcome,
  stabilitySlo,
} from '../src/analysis/stabilityTelemetry';
import {
  armTryAgain,
  consumeTryAgainHandoff,
  clearTryAgainHandoff,
  TRY_AGAIN_HANDOFF_TTL_MS,
} from '../src/screens/tryAgainHandoff';
import { startSessionCapture } from '../src/camera/capture';
import {
  DEV_REPLAY_RALLY,
  LiveSessionFlow,
  type SessionEventAnalysisProvider,
} from '../src/flow/session';

beforeEach(() => {
  stabilitySlo.reset();
  clearTryAgainHandoff();
});

describe('createStabilityRecorder', () => {
  it('stamps events with the current context and never throws', () => {
    const recorder = createStabilityRecorder(() => '2026-08-29T00:00:00.000Z');
    recorder.record({ kind: 'session_started' });
    recorder.setContext({ userKey: 'owner-1', sessionKey: 'run-1' });
    recorder.record({ kind: 'analysis_started' });
    const events = recorder.events();
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      kind: 'session_started',
      userKey: UNASSIGNED_STABILITY_USER_KEY,
      sessionKey: null,
      at: '2026-08-29T00:00:00.000Z',
    });
    expect(events[1]).toMatchObject({
      kind: 'analysis_started',
      userKey: 'owner-1',
      sessionKey: 'run-1',
    });
  });

  it('aggregates its own events through the shared contract', () => {
    const recorder = createStabilityRecorder();
    recorder.setContext({ userKey: 'owner-1', sessionKey: 'run-1' });
    recorder.record({ kind: 'session_started' });
    recorder.record({ kind: 'analysis_started' });
    recorder.record({ kind: 'analysis_failed', failureKind: 'unavailable' });
    const metrics = recorder.metrics();
    expect(metrics.sessionsStarted).toBe(1);
    expect(metrics.analysisCompletionRate).toBe(0);
  });

  it('records previous-run attribution without touching the current context', () => {
    const recorder = createStabilityRecorder();
    recorder.setContext({ userKey: 'owner-2', sessionKey: 'run-2' });
    recorder.recordAttributed(
      { kind: 'memory_pressure_termination' },
      { userKey: 'owner-2', sessionKey: 'run-1' },
    );
    recorder.record({ kind: 'session_started' });
    const events = recorder.events();
    expect(events[0]).toMatchObject({ sessionKey: 'run-1' });
    expect(events[1]).toMatchObject({ sessionKey: 'run-2' });
  });
});

describe('classifyPreviousRun', () => {
  const base = {
    sessionKey: 'run-0',
    endedClean: false,
    memoryWarningSeen: false,
    crashFingerprint: null,
  };

  it('classifies each marker combination honestly', () => {
    expect(classifyPreviousRun({ ...base, endedClean: true })).toBe(
      'clean_exit',
    );
    expect(classifyPreviousRun({ ...base, crashFingerprint: 'f1' })).toBe(
      'crash',
    );
    expect(classifyPreviousRun({ ...base, memoryWarningSeen: true })).toBe(
      'memory_pressure_termination',
    );
    expect(classifyPreviousRun(base)).toBe('unknown_termination');
  });

  it('emits a crash event with the previous run attribution only', () => {
    const recorder = createStabilityRecorder();
    recorder.setContext({ userKey: 'owner-now', sessionKey: 'run-now' });
    const classification = recordPreviousRunOutcome(recorder, 'owner-prev', {
      ...base,
      crashFingerprint: 'f1',
    });
    expect(classification).toBe('crash');
    expect(recorder.events()).toHaveLength(1);
    expect(recorder.events()[0]).toMatchObject({
      kind: 'crash',
      fatal: true,
      fingerprint: 'f1',
      userKey: 'owner-prev',
      sessionKey: 'run-0',
    });
  });

  it('emits NOTHING for a clean or unattributable exit', () => {
    const recorder = createStabilityRecorder();
    expect(recordPreviousRunOutcome(recorder, 'owner-prev', base)).toBe(
      'unknown_termination',
    );
    expect(
      recordPreviousRunOutcome(recorder, 'owner-prev', {
        ...base,
        endedClean: true,
      }),
    ).toBe('clean_exit');
    expect(recorder.events()).toHaveLength(0);
  });
});

describe('TRY AGAIN stability emission', () => {
  const handoff = {
    source: 'camera',
    declaredStroke: null,
    declaredCanonical: null,
    auto: true,
  } as const;

  it('records try_again_rearmed when a live handoff is consumed', () => {
    armTryAgain(handoff);
    expect(consumeTryAgainHandoff()).not.toBeNull();
    expect(stabilitySlo.events()).toHaveLength(1);
    expect(stabilitySlo.events()[0]).toMatchObject({
      kind: 'try_again_rearmed',
    });
  });

  it('records try_again_failed when an armed handoff expired', () => {
    const nowSpy = jest.spyOn(Date, 'now');
    const armedAt = 1_000_000;
    nowSpy.mockReturnValue(armedAt);
    armTryAgain(handoff);
    nowSpy.mockReturnValue(armedAt + TRY_AGAIN_HANDOFF_TTL_MS + 1);
    expect(consumeTryAgainHandoff()).toBeNull();
    nowSpy.mockRestore();
    expect(stabilitySlo.events()).toHaveLength(1);
    expect(stabilitySlo.events()[0]).toMatchObject({
      kind: 'try_again_failed',
      reason: 'handoff_expired',
    });
  });

  it('records nothing when no handoff was ever armed', () => {
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(stabilitySlo.events()).toHaveLength(0);
  });
});

describe('camera startup stability emission', () => {
  it('records camera_startup_failed when native session capture is missing', async () => {
    await expect(startSessionCapture()).rejects.toThrow(
      'Native session capture is not available on this device.',
    );
    expect(stabilitySlo.events()).toHaveLength(1);
    expect(stabilitySlo.events()[0]).toMatchObject({
      kind: 'camera_startup_failed',
      reason: 'session_capture_unavailable',
    });
  });
});

describe('session flow stability emission', () => {
  function throwingProvider(): SessionEventAnalysisProvider {
    return {
      providerId: 'test-throwing-provider',
      availability: () => ({ status: 'available' }),
      analyzeEvent: () => Promise.reject(new Error('provider blew up')),
    };
  }

  it('records session_flow_failed when an analysis dispatch fails', async () => {
    const flow = new LiveSessionFlow({
      sessionId: 'stability-test-session',
      source: 'replay',
      provider: throwingProvider(),
    });
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    flow.end();
    await flow.settled();
    const failures = stabilitySlo
      .events()
      .filter(event => event.kind === 'session_flow_failed');
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toMatchObject({ reason: 'analysis_dispatch_failed' });
  });

  it('records session_flow_failed when an onUpdate subscriber throws', () => {
    const flow = new LiveSessionFlow({
      sessionId: 'stability-test-subscriber',
      source: 'replay',
      provider: throwingProvider(),
      onUpdate: () => {
        throw new Error('subscriber blew up');
      },
    });
    flow.pushSample({ tMs: 0, v: 0.01 });
    const failures = stabilitySlo
      .events()
      .filter(
        event =>
          event.kind === 'session_flow_failed' &&
          event.reason === 'on_update_subscriber_failed',
      );
    expect(failures.length).toBeGreaterThan(0);
  });
});
