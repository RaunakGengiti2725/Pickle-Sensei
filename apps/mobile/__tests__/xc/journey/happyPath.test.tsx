/**
 * XC journey — HAPPY PATH, full tree.
 *
 * Analyze (gate → camera landing) → native capture sequence → permit reserve →
 * runCaptureAnalysis (real scoring on a seeded synthetic swing, real SQLite)
 * → Result guide → ResultDetails → FormReview, all hosted by the REAL
 * RootNavigator route table. Every screen is the production component; only
 * the native camera, react-navigation's native host, StoreKit and the
 * network are seams.
 *
 * ResultDetails has no UI link from the guide any more (product decision
 * 2026-09-02, see ResultScreen.tsx header), so it is entered at route level
 * — exactly what any remaining caller (deep link, other screen) would issue.
 *
 * Replay: `XC_JOURNEY_SEED=<n> npx jest __tests__/xc/journey/happyPath`.
 */
import '../../../xc/journey/mocks';
import {
  collectedEvidence,
  runScenario,
  writeEvidence,
} from '../../../xc/journey/harness';
import { shutdownSqliteBridge } from '../../../xc/journey/nodeSqliteOpSqlite';

const SEED = Number(process.env['XC_JOURNEY_SEED'] ?? 101);

afterAll(async () => {
  const written = writeEvidence('happyPath');
  await shutdownSqliteBridge();
  expect(collectedEvidence().length).toBeGreaterThan(0);
  expect(written.tablePath).toContain('happyPath.scenarios.json');
});

describe('journey: Analyze → Result → ResultDetails → FormReview', () => {
  it('scores a seeded stroke and reaches FormReview with a way back at every step', async () => {
    await runScenario({ scenario: 'happy-path', seed: SEED }, async j => {
      // Gate: access loads from the journey server, then the camera landing.
      await j.waitFor(
        () => j.text().includes('Open automatic camera'),
        'Analyze camera landing after access check',
      );
      expect(j.server.requestsFor('/v1/me/access').length).toBeGreaterThan(0);
      expect(j.routeNames()).toEqual(['Tabs', 'Analyze']);

      // Declare on the real chip grid → zero-touch scoring once the clip lands.
      await j.pressButton('Forehand Drive');
      const { clip } = j.clip('happy-1');
      const capture = j.armCapture();
      await j.pressButton('Open automatic camera');
      await j.flush(200);
      j.driveNativeCaptureSequence();
      await j.flush(50);
      capture.resolve(clip);

      await j.waitFor(
        () => j.topRoute() === 'Result',
        'replace(Result) after a scored analysis',
      );
      expect(j.routeNames()).toEqual(['Tabs', 'Result']);
      const reserve = j.server.requestsFor('/v1/analysis-permits');
      expect(reserve.length).toBeGreaterThanOrEqual(1);
      expect(reserve[0]!.status).toBe(200);
      const analysisId = (j.stack.top().params as { analysisId: string })
        .analysisId;
      expect(typeof analysisId).toBe('string');

      // Result guide settles; the outbox drains for real.
      await j.waitFor(() => j.has('result-guide'), 'Result guide mounted');
      await j.waitFor(
        () => j.server.syncedShotIds.length === 1,
        'outbox drained to /v1/shots:sync',
      );
      await j.waitFor(
        () => !j.has('stroke-result-analyzing'),
        'Result analyzing surface gone',
      );
      const settled = j.probeSpinners('result-settled');
      expect(settled.resultAnalyzing).toBe(0);
      expect(settled.analysisProgress).toBe(0);

      // Walk the guide to its last page: TRY AGAIN + Done are both there.
      for (let guard = 0; guard < 6 && j.has('result-guide-next'); guard += 1) {
        await j.pressTestId('result-guide-next');
      }
      expect(j.has('result-guide-done')).toBe(true);
      expect(j.has('result-guide-try-again')).toBe(true);
      j.recordRecovery(['result-guide-done', 'result-guide-try-again']);

      // ResultDetails: route-level entry, full breakdown tree.
      await j.navigateTo('ResultDetails', { analysisId });
      await j.waitFor(
        () => j.topRoute() === 'ResultDetails' && j.has('result-details'),
        'ResultDetails ready tree',
      );
      expect(j.has('result-details-breakdown')).toBe(true);
      await j.waitFor(
        () => j.has('form-review-card'),
        'form review entry card on the breakdown sheet',
      );

      await j.pressTestId('form-review-card');
      await j.waitFor(
        () => j.topRoute() === 'FormReview' && j.has('form-review-screen'),
        'FormReview ready tree',
      );
      expect(j.has('form-review-back')).toBe(true);
      expect(j.has('form-review-reanalyze')).toBe(true);
      j.recordRecovery(['form-review-back', 'form-review-reanalyze']);

      // Back unwinds exactly one level each time.
      await j.pressTestId('form-review-back');
      expect(j.topRoute()).toBe('ResultDetails');
      await j.pressButtonIn('ResultDetails', 'Back');
      expect(j.topRoute()).toBe('Result');
      await j.pressTestId('result-guide-done');
      expect(j.routeNames()).toEqual(['Tabs']);

      const finalProbe = j.probeSpinners('final');
      expect(finalProbe.brandSpinners).toBe(0);
      expect(finalProbe.resultAnalyzing).toBe(0);
    });
  });
});
