/**
 * xc-matrix adjudication pin (XC-ADJ-VIS-1).
 *
 * docs/PERCEPTION.md §2 says the capture-quality gate
 * (`evaluateCaptureQuality`, reasons such as `tracking_dropout_gap`,
 * `player_too_small_in_frame`) is "decided BEFORE scoring". The phone's
 * scoring path (`src/analysis/runCaptureAnalysis.ts`) must therefore consult
 * `evaluateCaptureQuality` / `evaluatePreAnalysisGate` on the parsed sidecar
 * BEFORE handing it to `analyzeCapture`, so an unmeasurable stream is an
 * honest abstention rather than a rating.
 *
 * The pin reads the production source rather than driving the pipeline so it
 * cannot be satisfied by a synthetic fixture; the behavioural half lives in
 * `importedClipStrokeWindowGate.xc.test.ts` / `importedClip24fpsGate.xc.test.ts`
 * beside this file (unmeasurable sidecar ⇒ not scored, one reserve, one
 * release, zero local_shot rows; valid 24 fps / lead-in footage ⇒ scored) and
 * `packages/analysis-pipeline/test/visibilityMatrix.knownGaps.test.ts`.
 */
export {};

declare const require: (id: string) => unknown;
declare const __dirname: string;
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

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

  it('runCaptureAnalysis consults evaluateCaptureQuality / evaluatePreAnalysisGate before analyzeCapture', () => {
    const gateCall = source.search(
      /\b(evaluateCaptureQuality|evaluatePreAnalysisGate)\(/,
    );
    const analyzeCall = source.search(/\bawait analyzeCapture\(/);
    expect(gateCall).toBeGreaterThan(-1);
    expect(analyzeCall).toBeGreaterThan(-1);
    expect(gateCall).toBeLessThan(analyzeCall);
  });
});
