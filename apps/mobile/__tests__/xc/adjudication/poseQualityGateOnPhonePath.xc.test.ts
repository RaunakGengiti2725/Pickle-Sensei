/**
 * xc-matrix adjudication pin (XC-ADJ-VIS-1).
 *
 * docs/PERCEPTION.md §2 says the capture-quality gate
 * (`evaluateCaptureQuality`, reasons such as `tracking_dropout_gap`,
 * `player_too_small_in_frame`) is "decided BEFORE scoring". The phone's
 * scoring path (`src/analysis/runCaptureAnalysis.ts`) applies the
 * capture-envelope gate and the sidecar integrity checks, then hands the
 * parsed pose sequence straight to `analyzeCapture`; neither
 * `evaluateCaptureQuality` nor `evaluatePreAnalysisGate` is consulted. The
 * only consumer of the gate is the desktop lab (`packages/swing-lab`).
 *
 * `packages/analysis-pipeline/test/visibilityMatrix.knownGaps.test.ts` pins
 * (it.fails) that `analyzeCapture` scores dropout-gap / far-camera streams
 * with presentation "normal", so on the phone those streams are rated.
 *
 * `test.failing`: this file goes red (remove it) once the phone path consumes
 * the gate. It reads the production source rather than driving the pipeline
 * so the pin cannot be satisfied by a synthetic fixture.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const PHONE_SCORING_PATH = join(
  __dirname,
  '../../../src/analysis/runCaptureAnalysis.ts',
);

describe('XC-ADJ-VIS-1: pose-quality gate on the phone scoring path', () => {
  const source = readFileSync(PHONE_SCORING_PATH, 'utf8');

  it('the phone path does call analyzeCapture (the pin targets the right file)', () => {
    expect(source).toMatch(/\banalyzeCapture\(/);
    expect(source).toMatch(/from '@pickle\/analysis-pipeline'/);
  });

  test.failing(
    'runCaptureAnalysis consults evaluateCaptureQuality / evaluatePreAnalysisGate before analyzeCapture',
    () => {
      expect(source).toMatch(
        /\b(evaluateCaptureQuality|evaluatePreAnalysisGate)\(/,
      );
    },
  );
});
