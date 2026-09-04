/**
 * xc-matrix adjudication pin (XC-ADJ-VIS-1), now positive.
 *
 * docs/PERCEPTION.md §2 says the capture-quality gate
 * (`evaluateCaptureQuality`, reasons such as `tracking_dropout_gap`,
 * `player_too_small_in_frame`) is "decided BEFORE scoring". The phone's
 * scoring path (`src/analysis/runCaptureAnalysis.ts`) must therefore run
 * `evaluateCaptureQuality` → `evaluatePreAnalysisGate` on the parsed pose
 * sequence and withhold `analyzeCapture` when the stream is not analyzable.
 *
 * It reads the production source rather than driving the pipeline so the
 * pin cannot be satisfied by a synthetic fixture; the behavioural half lives
 * in `__tests__/xcBehavioral/permitLifecycleMatrix.test.ts` (dropout-gap
 * sidecar ⇒ not scored, permit released, no local shot).
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

  it('runCaptureAnalysis consults evaluateCaptureQuality and evaluatePreAnalysisGate before analyzeCapture', () => {
    const quality = source.search(/\bevaluateCaptureQuality\(/);
    const gate = source.search(/\bevaluatePreAnalysisGate\(/);
    const analyze = source.search(/\bawait analyzeCapture\(/);
    expect(quality).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(analyze).toBeGreaterThan(-1);
    expect(quality).toBeLessThan(analyze);
    expect(gate).toBeLessThan(analyze);
  });
});
