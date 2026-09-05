/**
 * The mutable I/O seams the mod-run-capture-analysis stress harness controls.
 * Test files wire them in through `jest.mock` factories (which may only
 * reference modules via `jest.requireActual`), and the harness re-points them
 * per sequence so every seed is replayable:
 *
 *  - `readArtifact`   → `readCaptureArtifact` (the pose sidecar reader)
 *  - `makeUuid`       → `src/util/uuid` (seeded, so ids are deterministic)
 *  - `analyzeCapture` → optional override of the fusion engine entry point
 *                       (null = the real pipeline runs)
 */
import type { analyzeCapture as RealAnalyzeCapture } from '@pickle/analysis-pipeline';

export type AnalyzeCaptureFn = typeof RealAnalyzeCapture;

export interface StressSeams {
  readArtifact: (uri: string) => Promise<string>;
  makeUuid: () => string;
  analyzeCapture: AnalyzeCaptureFn | null;
}

export const seams: StressSeams = {
  readArtifact: () =>
    Promise.reject(new Error('stress seams: readArtifact not configured')),
  makeUuid: () => {
    throw new Error('stress seams: makeUuid not configured');
  },
  analyzeCapture: null,
};
