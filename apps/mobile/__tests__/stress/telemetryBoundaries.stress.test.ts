import { type StabilitySloEvent } from '@pickle/shared-types';
import {
  createStabilityRecorder,
  type StabilityEventInput,
} from '../../src/analysis/stabilityTelemetry';
import {
  CONFUSION_THRESHOLDS_V1,
  createUsabilityFunnelRecorder,
  deriveConfusionEvents,
  type UsabilityFunnelEvent,
} from '../../src/analysis/usabilityTelemetry';
import {
  STRICT,
  pseudoUuid,
  randomInt,
  recordScenario,
  scenarioSeeds,
  seededRandom,
} from '../../testing/stress/telemetryConcurrency';

/**
 * mod-telemetry — boundary lens (bounded buffers, field passthrough,
 * encapsulation, clock skew semantics).
 *
 * Every test here MEASURES and records evidence in the default mode and only
 * turns red under `STRESS_STRICT=1`, where it asserts the invariants the
 * unit is specified to hold ("never leaks PII/pose, bounded buffers"). That
 * keeps a known finding from failing the default suite while its exact
 * repro stays one command away:
 *
 *   cd apps/mobile && STRESS_STRICT=1 STRESS_SEED=<seed> npx jest --ci __tests__/stress/telemetryBoundaries
 */

const SUITE = 'telemetryBoundaries';

declare const process: { memoryUsage(): { heapUsed: number } };
declare const global: { gc?: () => void };

function heapUsed(): number {
  if (typeof global.gc === 'function') global.gc();
  return process.memoryUsage().heapUsed;
}

const readinessInput = (i: number): UsabilityFunnelEvent => ({
  step: 'readiness_state',
  tMs: i,
  detail: i % 3 === 0 ? 'searching' : i % 3 === 1 ? 'adjust' : 'ready',
});

describe('bounded buffers — long-running app, no reader', () => {
  const scenario = 'buffers/unbounded-growth';
  for (const seed of scenarioSeeds(scenario)) {
    it(`seed ${seed}: N records → buffer length, heap per event (strict: bounded)`, async () => {
      const random = seededRandom(seed);
      const n = randomInt(random, 20_000, 60_000);
      await recordScenario(SUITE, scenario, seed, { n }, async () => {
        const stability = createStabilityRecorder(
          () => '2026-09-04T00:00:00.000Z',
        );
        stability.setContext({
          userKey: pseudoUuid(random),
          sessionKey: pseudoUuid(random),
        });
        const usability = createUsabilityFunnelRecorder(() => 0);
        const heapBefore = heapUsed();
        let threw = 0;
        for (let i = 0; i < n; i += 1) {
          try {
            stability.record({ kind: 'analysis_started' });
            const r = readinessInput(i);
            usability.log(r.step, r.detail);
          } catch {
            threw += 1;
          }
        }
        const heapAfter = heapUsed();
        const stabilityLen = stability.events().length;
        const usabilityLen = usability.events().length;
        const bytesPerPair = (heapAfter - heapBefore) / n;
        // HELD: recording never throws and the readers stay total at scale.
        expect(threw).toBe(0);
        expect(() => stability.metrics()).not.toThrow();
        expect(() => usability.summary()).not.toThrow();
        // Measured: both logs retain every event (no cap, no eviction).
        expect(stabilityLen).toBe(n);
        expect(usabilityLen).toBe(n);
        if (STRICT) {
          // Specified invariant: buffers are bounded independent of N.
          expect(stabilityLen).toBeLessThan(n);
          expect(usabilityLen).toBeLessThan(n);
        }
        return {
          stabilityLen,
          usabilityLen,
          // Heap numbers are only meaningful with NODE_OPTIONS=--expose-gc.
          gcAvailable: typeof global.gc === 'function',
          heapDeltaMb:
            Math.round(((heapAfter - heapBefore) / 1024 / 1024) * 100) / 100,
          bytesPerEventPair: Math.round(bytesPerPair),
          // 2 Hz readiness emission (GuidedCaptureViewController ≥500 ms)
          // for one hour of open camera at the measured cost.
          projectedMbPerCameraHour:
            Math.round((((bytesPerPair / 2) * 7_200) / 1024 / 1024) * 100) /
            100,
        };
      });
    });
  }
});

describe('field passthrough — what a caller passes is what is stored', () => {
  const scenario = 'fields/passthrough';
  const FORBIDDEN = ['poseSequence', 'email', 'stack', 'deviceId', 'joints'];
  for (const seed of scenarioSeeds(scenario)) {
    it(`seed ${seed}: extra input keys and oversized detail are stored verbatim (strict: whitelisted/bounded)`, async () => {
      const random = seededRandom(seed);
      const detailLen = randomInt(random, 10_000, 200_000);
      const extraKeys = FORBIDDEN.filter(() => random() < 0.6);
      await recordScenario(
        SUITE,
        scenario,
        seed,
        { detailLen, extraKeys },
        async () => {
          const stability = createStabilityRecorder(() => 'T');
          // A wider object flowing through the structural type (e.g. an
          // event built by spreading a richer runtime record).
          const wide: Record<string, unknown> = {
            kind: 'analysis_failed',
            failureKind: 'exception',
          };
          for (const key of extraKeys)
            wide[key] = key === 'email' ? 'a@b.c' : [1, 2, 3];
          stability.record(wide as unknown as StabilityEventInput);
          const stored = stability.events()[0] as unknown as Record<
            string,
            unknown
          >;
          const leakedKeys = extraKeys.filter(k => k in stored);
          // HELD: the recorder adds exactly its own attribution + timestamp.
          expect(stored['userKey']).toBeDefined();
          expect(stored['at']).toBe('T');
          // Measured: every extra key survived verbatim.
          expect(leakedKeys).toEqual(extraKeys);

          const usability = createUsabilityFunnelRecorder(() => 1);
          const detail = 'x'.repeat(detailLen);
          usability.log('error_shown', detail);
          const storedDetail = usability.events()[0]?.detail ?? '';
          expect(storedDetail.length).toBe(detailLen);
          if (STRICT) {
            expect(leakedKeys).toEqual([]);
            expect(storedDetail.length).toBeLessThanOrEqual(1_024);
          }
          return { leakedKeys, storedDetailLen: storedDetail.length };
        },
      );
    });
  }
});

describe('encapsulation — events() hands out the live backing array', () => {
  const scenario = 'aliasing/live-array';
  for (const seed of scenarioSeeds(scenario)) {
    it(`seed ${seed}: a consumer snapshot mutates under it, can be forged, and goes stale after reset (strict: isolated)`, async () => {
      const random = seededRandom(seed);
      const before = randomInt(random, 1, 20);
      const after = randomInt(random, 1, 20);
      await recordScenario(
        SUITE,
        scenario,
        seed,
        { before, after },
        async () => {
          const stability = createStabilityRecorder(() => 'T');
          const usability = createUsabilityFunnelRecorder(() => 1);
          for (let i = 0; i < before; i += 1) {
            stability.record({ kind: 'analysis_started' });
            usability.log('ready');
          }
          const sSnap = stability.events();
          const uSnap = usability.events();
          const sLenAtSnapshot = sSnap.length;
          for (let i = 0; i < after; i += 1) {
            stability.record({ kind: 'analysis_completed' });
            usability.log('stroke_captured');
          }
          // Measured: the "snapshot" grew — it is the recorder's own array.
          const snapshotGrew =
            sSnap.length === before + after && uSnap.length === before + after;
          // Measured: a consumer can forge rows that then count in metrics.
          (sSnap as StabilitySloEvent[]).push({
            kind: 'crash',
            fatal: true,
            fingerprint: 'forged',
            userKey: 'forged',
            sessionKey: null,
            at: 'T',
          });
          const forgedCounted = stability.metrics().fatalCrashes === 1;
          // Measured: after reset() the handed-out reference is orphaned —
          // a reader holding it never sees new events (lost update from the
          // reader's point of view), while a fresh events() call does.
          stability.reset();
          stability.record({ kind: 'session_started' });
          const staleAfterReset =
            sSnap.length === before + after + 1 &&
            stability.events().length === 1;
          expect(sLenAtSnapshot).toBe(before);
          if (STRICT) {
            expect(snapshotGrew).toBe(false);
            expect(forgedCounted).toBe(false);
            expect(staleAfterReset).toBe(false);
          } else {
            expect(snapshotGrew).toBe(true);
            expect(forgedCounted).toBe(true);
            expect(staleAfterReset).toBe(true);
          }
          return { snapshotGrew, forgedCounted, staleAfterReset };
        },
      );
    });
  }
});

describe('clock semantics — usability derivation on the app-lifetime recorder', () => {
  it('payload A: a backward clock step lets intent picks made AFTER camera open count as pre-camera churn (strict: no churn)', async () => {
    await recordScenario(
      SUITE,
      'clock/backward-step-churn',
      0,
      { payload: 'A' },
      async () => {
        // Wall clock (Date.now) steps back 5 s right after the camera opened
        // (NTP correction / manual clock change), then the user re-picks the
        // technique three times from the camera's intent control.
        const events: UsabilityFunnelEvent[] = [
          { step: 'analyze_opened', tMs: 1_000 },
          { step: 'intent_selected', tMs: 1_500, detail: 'auto' },
          { step: 'camera_opened', tMs: 10_000 },
          { step: 'intent_selected', tMs: 5_100, detail: 'drive' },
          { step: 'intent_selected', tMs: 5_200, detail: 'dink' },
          { step: 'intent_selected', tMs: 5_300, detail: 'auto' },
          { step: 'ready', tMs: 6_000 },
        ];
        const confusion = deriveConfusionEvents(events);
        const churn = confusion.filter(
          c => c.kind === 'intent_reselection_churn',
        );
        // Measured today: churn fires (4 picks with tMs <= camera_opened.tMs).
        expect(churn.length).toBe(STRICT ? 0 : 1);
        return { confusion: confusion.map(c => `${c.kind}@${c.tMs}`) };
      },
    );
  });

  it('payload B: only the FIRST camera_opened of the app run is ever measured for dwell / abandonment (strict: every attempt)', async () => {
    await recordScenario(
      SUITE,
      'clock/first-attempt-only',
      0,
      { payload: 'B' },
      async () => {
        // Attempt 1: quick and clean. Attempt 2 (same app run, recorder never
        // reset — `usabilityFunnel` is one recorder per process): 60 s of
        // dwell before ready, then the user abandons without a capture.
        const dwell = CONFUSION_THRESHOLDS_V1.preReadyDwellMs * 3;
        const events: UsabilityFunnelEvent[] = [
          { step: 'analyze_opened', tMs: 0 },
          { step: 'camera_opened', tMs: 1_000 },
          { step: 'ready', tMs: 2_000 },
          { step: 'stroke_captured', tMs: 3_000 },
          { step: 'result_opened', tMs: 4_000 },
          { step: 'analyze_opened', tMs: 100_000 },
          { step: 'camera_opened', tMs: 101_000 },
          {
            step: 'readiness_state',
            tMs: 101_000 + dwell,
            detail: 'searching',
          },
          { step: 'attempt_abandoned', tMs: 102_000 + dwell },
        ];
        const confusion = deriveConfusionEvents(events);
        const kinds = confusion.map(c => c.kind);
        if (STRICT) {
          expect(kinds).toContain('abandoned_before_capture');
        } else {
          // Measured today: attempt 2's abandonment is not surfaced because
          // attempt 1 captured a stroke earlier in the same log, and attempt
          // 2's dwell is not measured because only the first camera_opened is
          // considered.
          expect(kinds).not.toContain('abandoned_before_capture');
          expect(kinds).not.toContain('pre_ready_dwell_exceeded');
        }
        return { confusion: confusion.map(c => `${c.kind}@${c.tMs}`) };
      },
    );
  });
});
