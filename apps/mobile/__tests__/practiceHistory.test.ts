import type { CapturedClip, CaptureEvidenceV1 } from '../src/camera/capture';
import type { PendingCapture } from '../src/data/repository';
import {
  aggregatePracticeHistory,
  buildPracticeHistory,
  PRACTICE_HISTORY_RANGES,
} from '../src/progress/practiceHistory';

type AutomaticClip = Extract<
  CapturedClip,
  { captureMode: 'automatic_pose_trigger' }
>;

const options = {
  asOfIso: '2026-08-27T20:00:00.000Z',
  timeZone: 'UTC',
  rangeDays: 3,
};

describe('practice history from persisted capture evidence', () => {
  it('aggregates only measured pose evidence with deterministic ranges', () => {
    const captures = [
      pending('old-1', '2026-08-22T12:00:00.000Z', {
        poseFrameCount: 4,
        poseMissingFrameCount: 0,
        trackedDurationMs: 100,
        meanJointCoverage: 0.5,
        minimumJointCoverage: 0.4,
        meanCanonicalJointVisibility: 0.6,
        fullBodyVisibleFrameCount: 1,
      }),
      pending('old-2', '2026-08-23T12:00:00.000Z', {
        poseFrameCount: 2,
        poseMissingFrameCount: 2,
        trackedDurationMs: 200,
        meanJointCoverage: 0.6,
        minimumJointCoverage: 0.5,
        meanCanonicalJointVisibility: 0.7,
        fullBodyVisibleFrameCount: 0,
      }),
      pending('old-3', '2026-08-24T12:00:00.000Z', {
        poseFrameCount: 3,
        poseMissingFrameCount: 1,
        trackedDurationMs: 300,
        meanJointCoverage: 0.7,
        minimumJointCoverage: 0.6,
        meanCanonicalJointVisibility: 0.8,
        fullBodyVisibleFrameCount: 2,
      }),
      pending('current-1', '2026-08-26T12:00:00.000Z', {
        poseFrameCount: 5,
        poseMissingFrameCount: 0,
        trackedDurationMs: 400,
        meanJointCoverage: 0.8,
        minimumJointCoverage: 0.7,
        meanCanonicalJointVisibility: 0.9,
        fullBodyVisibleFrameCount: 4,
      }),
      pending('current-2', '2026-08-27T12:00:00.000Z', {
        poseFrameCount: 8,
        poseMissingFrameCount: 2,
        trackedDurationMs: 500,
        meanJointCoverage: 0.9,
        minimumJointCoverage: 0.75,
        meanCanonicalJointVisibility: 0.95,
        fullBodyVisibleFrameCount: 6,
      }),
    ];

    const history = aggregatePracticeHistory(captures, options);

    expect(history.lifetime.eligibleCaptureCount).toBe(5);
    expect(history.lifetime.activeDayCount).toBe(5);
    expect(history.lifetime.trackedPoseDurationMs).toBe(1_500);
    expect(history.lifetime.poseAvailability).toEqual({
      analysisInputFrameCount: 27,
      poseFrameCount: 22,
      poseMissingFrameCount: 5,
      rate: 22 / 27,
    });
    expect(history.lifetime.jointTracking.meanCoverage).toBeCloseTo(0.75);
    expect(
      history.lifetime.jointTracking.meanCanonicalJointVisibility,
    ).toBeCloseTo(18.3 / 22);
    expect(history.lifetime.jointTracking.minimumCoverage).toBe(0.4);
    expect(history.lifetime.jointTracking.fullBodyVisibleFrameRate).toBeCloseTo(
      13 / 22,
    );
    expect(history.streak).toEqual({
      currentDays: 2,
      longestDays: 3,
      practicedToday: true,
      lastPracticeDay: '2026-08-27',
    });

    expect(history.dayBuckets.map(bucket => bucket.day)).toEqual([
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
    ]);
    expect(history.dayBuckets[0]).toMatchObject({
      eligibleCaptureCount: 0,
      activeDayCount: 0,
      trackedPoseDurationMs: 0,
      poseAvailability: { rate: null },
      jointTracking: { meanCoverage: null, minimumCoverage: null },
    });
    expect(history.rangeBuckets.current).toMatchObject({
      startDay: '2026-08-25',
      endDay: '2026-08-27',
      eligibleCaptureCount: 2,
      activeDayCount: 2,
      trackedPoseDurationMs: 900,
      poseAvailability: { rate: 13 / 15 },
      jointTracking: { meanCoverage: 11.2 / 13 },
    });
    expect(history.rangeBuckets.previous).toMatchObject({
      startDay: '2026-08-22',
      endDay: '2026-08-24',
      eligibleCaptureCount: 3,
      activeDayCount: 3,
      trackedPoseDurationMs: 600,
      poseAvailability: { rate: 9 / 12 },
      jointTracking: { meanCoverage: 5.3 / 9 },
    });
    expect(history.priorPeriodComparison).toMatchObject({
      eligibleCaptureDelta: -1,
      activeDayDelta: -1,
      trackedPoseDurationDeltaMs: 300,
    });
    expect(history.priorPeriodComparison.poseAvailabilityRateDelta).toBeCloseTo(
      13 / 15 - 9 / 12,
    );
    expect(history.priorPeriodComparison.meanJointCoverageDelta).toBeCloseTo(
      11.2 / 13 - 5.3 / 9,
    );
  });

  it('uses the explicit IANA timezone for day and streak boundaries', () => {
    const captures = [
      pending('late-26', '2026-08-27T06:30:00.000Z'),
      pending('early-27', '2026-08-27T07:30:00.000Z'),
    ];

    const history = aggregatePracticeHistory(captures, {
      asOfIso: '2026-08-27T12:00:00.000Z',
      timeZone: 'America/Los_Angeles',
      rangeDays: 1,
    });

    expect(history.asOfDay).toBe('2026-08-27');
    expect(history.dayBuckets[0]?.eligibleCaptureCount).toBe(1);
    expect(history.rangeBuckets.previous).toMatchObject({
      startDay: '2026-08-26',
      endDay: '2026-08-26',
      eligibleCaptureCount: 1,
    });
    expect(history.streak).toEqual({
      currentDays: 2,
      longestDays: 2,
      practicedToday: true,
      lastPracticeDay: '2026-08-27',
    });
  });

  it('excludes untrusted, imported, mismatched, and future captures', () => {
    const real = pending('real', '2026-08-27T12:00:00.000Z');
    const legacy: PendingCapture = {
      ...real,
      id: 'legacy',
      clip: null,
      evidenceStatus: 'legacy',
    };
    const corrupt: PendingCapture = {
      ...real,
      id: 'corrupt',
      clip: null,
      evidenceStatus: 'corrupt',
    };
    const mismatch: PendingCapture = {
      ...real,
      id: 'mismatch',
      uri: 'file:///captures/not-the-clip.mov',
    };
    const imported = importedPending('imported', '2026-08-27T10:00:00.000Z');
    const future = pending('future', '2026-08-28T12:00:00.000Z');

    const history = aggregatePracticeHistory(
      [real, legacy, corrupt, mismatch, imported, future],
      options,
    );

    expect(history.sourceCaptureCount).toBe(6);
    expect(history.excludedCaptureCount).toBe(5);
    expect(history.lifetime.eligibleCaptureCount).toBe(1);
    expect(history.lifetime.trackedPoseDurationMs).toBe(
      real.clip?.captureMode === 'automatic_pose_trigger'
        ? real.clip.captureEvidence.trackedDurationMs
        : -1,
    );
  });

  it('keeps a current streak through yesterday and expires it after a gap', () => {
    const captures = [
      pending('one', '2026-08-26T10:00:00.000Z'),
      pending('two', '2026-08-27T10:00:00.000Z'),
    ];
    const throughYesterday = aggregatePracticeHistory(captures, {
      ...options,
      asOfIso: '2026-08-28T09:00:00.000Z',
    });
    const afterGap = aggregatePracticeHistory(captures, {
      ...options,
      asOfIso: '2026-08-29T09:00:00.000Z',
    });

    expect(throughYesterday.streak.currentDays).toBe(2);
    expect(throughYesterday.streak.practicedToday).toBe(false);
    expect(afterGap.streak.currentDays).toBe(0);
    expect(afterGap.streak.longestDays).toBe(2);
  });

  it('returns zero-filled metrics and null rates without evidence', () => {
    const history = aggregatePracticeHistory([], options);

    expect(history.excludedCaptureCount).toBe(0);
    expect(history.lifetime).toMatchObject({
      eligibleCaptureCount: 0,
      activeDayCount: 0,
      trackedPoseDurationMs: 0,
      poseAvailability: { rate: null },
      jointTracking: {
        meanCoverage: null,
        minimumCoverage: null,
        meanCanonicalJointVisibility: null,
        fullBodyVisibleFrameRate: null,
      },
    });
    expect(history.priorPeriodComparison).toEqual({
      eligibleCaptureDelta: 0,
      activeDayDelta: 0,
      trackedPoseDurationDeltaMs: 0,
      poseAvailabilityRateDelta: null,
      meanJointCoverageDelta: null,
    });
  });

  it('is independent of input order and rejects ambiguous options', () => {
    const captures = [
      pending('b', '2026-08-27T11:00:00.000Z'),
      pending('a', '2026-08-26T11:00:00.000Z'),
    ];
    expect(aggregatePracticeHistory(captures, options)).toEqual(
      aggregatePracticeHistory([...captures].reverse(), options),
    );
    expect(() =>
      aggregatePracticeHistory(captures, {
        ...options,
        asOfIso: '2026-08-27T20:00:00',
      }),
    ).toThrow('explicit timezone');
    expect(() =>
      aggregatePracticeHistory(captures, { ...options, rangeDays: 0 }),
    ).toThrow('rangeDays');
    expect(() =>
      aggregatePracticeHistory(captures, {
        ...options,
        timeZone: 'Not/A_Timezone',
      }),
    ).toThrow('supported IANA timezone');
  });

  it('builds an ordered range result ready for the progress UI', () => {
    const result = buildPracticeHistory(
      [
        pending('previous', '2026-08-20T12:00:00.000Z'),
        pending('current-a', '2026-08-26T12:00:00.000Z'),
        pending('current-b', '2026-08-27T12:00:00.000Z'),
      ],
      {
        asOfIso: options.asOfIso,
        timeZone: 'UTC',
        range: '7d',
      },
    );

    expect(PRACTICE_HISTORY_RANGES).toEqual([
      { key: '7d', label: '7 days', days: 7 },
      { key: '28d', label: '4 weeks', days: 28 },
      { key: '90d', label: '90 days', days: 90 },
    ]);
    expect(result.buckets).toHaveLength(7);
    expect(result.buckets[0]).toEqual({
      key: '2026-08-21',
      label: 'Aug 21',
      count: 0,
    });
    expect(result.buckets.at(-1)).toEqual({
      key: '2026-08-27',
      label: 'Aug 27',
      count: 1,
    });
    expect(result).toMatchObject({
      range: '7d',
      captureCount: 2,
      activeDays: 2,
      currentStreak: 2,
      longestStreak: 2,
      trackedDurationMs: 600,
      meanPoseAvailability: 0.8,
      meanJointCoverage: 0.75,
      priorPeriodDelta: {
        captureCount: 1,
        activeDays: 1,
        trackedDurationMs: 300,
        meanPoseAvailability: 0,
        meanJointCoverage: 0,
      },
    });
  });

  it('applies the historical offset for each instant across DST', () => {
    const result = aggregatePracticeHistory(
      [
        // 23:30 PST on March 7, before the spring transition.
        pending('before-dst', '2026-03-08T07:30:00.000Z'),
        // 23:30 PDT on March 8, after the transition.
        pending('after-dst', '2026-03-09T06:30:00.000Z'),
        // 00:30 PDT on March 9.
        pending('next-day', '2026-03-09T07:30:00.000Z'),
      ],
      {
        asOfIso: '2026-03-09T12:00:00.000Z',
        timeZone: 'America/Los_Angeles',
        rangeDays: 3,
      },
    );

    expect(result.asOfDay).toBe('2026-03-09');
    expect(
      result.dayBuckets.map(bucket => [
        bucket.day,
        bucket.eligibleCaptureCount,
      ]),
    ).toEqual([
      ['2026-03-07', 1],
      ['2026-03-08', 1],
      ['2026-03-09', 1],
    ]);
    expect(result.streak.currentDays).toBe(3);
  });

  it('keeps consecutive local days consecutive across the fall-back 25h day', () => {
    // America/Los_Angeles leaves DST on 2026-11-01; that local day lasts 25h.
    const result = aggregatePracticeHistory(
      [
        // 23:30 PDT on October 31.
        pending('pre-fallback', '2026-11-01T06:30:00.000Z'),
        // 23:30 PST on November 1, the long day.
        pending('long-day', '2026-11-02T07:30:00.000Z'),
        // 23:30 PST on November 2.
        pending('post-fallback', '2026-11-03T07:30:00.000Z'),
      ],
      {
        asOfIso: '2026-11-03T07:45:00.000Z', // 23:45 PST on November 2
        timeZone: 'America/Los_Angeles',
        rangeDays: 3,
      },
    );

    expect(result.asOfDay).toBe('2026-11-02');
    expect(
      result.dayBuckets.map(bucket => [
        bucket.day,
        bucket.eligibleCaptureCount,
      ]),
    ).toEqual([
      ['2026-10-31', 1],
      ['2026-11-01', 1],
      ['2026-11-02', 1],
    ]);
    expect(result.streak).toMatchObject({
      currentDays: 3,
      longestDays: 3,
      practicedToday: true,
    });
  });

  it('assigns instants at exact local midnight to the starting day', () => {
    const result = aggregatePracticeHistory(
      [
        // 2026-08-26T00:00:00 PDT sharp.
        pending('midnight', '2026-08-26T07:00:00.000Z'),
        // 2026-08-26T23:59:59.999 PDT, a millisecond before the next day.
        pending('last-ms', '2026-08-27T06:59:59.999Z'),
      ],
      {
        asOfIso: '2026-08-27T06:59:59.999Z',
        timeZone: 'America/Los_Angeles',
        rangeDays: 2,
      },
    );

    expect(result.asOfDay).toBe('2026-08-26');
    expect(
      result.dayBuckets.map(bucket => [
        bucket.day,
        bucket.eligibleCaptureCount,
      ]),
    ).toEqual([
      ['2026-08-25', 0],
      ['2026-08-26', 2],
    ]);
    expect(result.streak).toMatchObject({
      currentDays: 1,
      longestDays: 1,
      practicedToday: true,
    });
  });
});

function pending(
  id: string,
  capturedAtIso: string,
  evidenceOverrides: Partial<CaptureEvidenceV1> = {},
): PendingCapture {
  const poseFrameCount = evidenceOverrides.poseFrameCount ?? 4;
  const poseMissingFrameCount = evidenceOverrides.poseMissingFrameCount ?? 1;
  const evidence: CaptureEvidenceV1 = {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: 'apple_vision_body_pose',
    poseModelVersion: 'apple-vision-bodypose-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
    motionUnit: 'normalized_image_units_per_second',
    poseFrameCount,
    poseMissingFrameCount,
    trackedDurationMs: 300,
    meanCanonicalJointVisibility: 0.8,
    meanJointCoverage: 0.75,
    minimumJointCoverage: 0.6,
    fullBodyVisibleFrameCount: 2,
    jointMotion: [
      {
        joint: 'right_wrist',
        sampleCount: 2,
        meanNormalizedPerSecond: 0.8,
        peakNormalizedPerSecond: 1.2,
      },
    ],
    ...evidenceOverrides,
    analysisInputFrameCount: poseFrameCount + poseMissingFrameCount,
  };
  const uri = `file:///captures/${id}.mov`;
  const clip: AutomaticClip = {
    uri,
    capturedAtIso,
    durationMs: 3_000,
    fps: 60,
    width: 1_080,
    height: 1_920,
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 1_000,
      endMs: 1_800,
      peakMotionMs: 1_500,
      confidence: 0.82,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: evidence,
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 1_000,
    postRollMs: 1_200,
  };
  return {
    id,
    shotType: 'unrecognized',
    declaredStroke: null,
    uri,
    capturedAtIso,
    durationMs: clip.durationMs,
    fps: clip.fps,
    width: clip.width,
    height: clip.height,
    clip,
    evidenceStatus: 'valid',
  };
}

function importedPending(id: string, capturedAtIso: string): PendingCapture {
  const uri = `file:///captures/${id}.mov`;
  const clip: CapturedClip = {
    uri,
    capturedAtIso,
    durationMs: 2_000,
    fps: 30,
    width: 1_080,
    height: 1_920,
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
  };
  return {
    id,
    shotType: 'unrecognized',
    declaredStroke: null,
    uri,
    capturedAtIso,
    durationMs: clip.durationMs,
    fps: clip.fps,
    width: clip.width,
    height: clip.height,
    clip,
    evidenceStatus: 'valid',
  };
}
