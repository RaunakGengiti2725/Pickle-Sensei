import * as pipeline from '@pickle/analysis-pipeline';
import type { CaptureAnalysisRecord } from '@pickle/analysis-pipeline';
import { ok } from '@pickle/shared-types';

/**
 * Test double for the ONE outcome the shipping analyzer no longer produces on
 * its own.
 *
 * Since 2026-09-10 the scoring engine abstains only when NO applicable
 * checkpoint was observed, so a real capture with a tracked body always
 * scores — the "low-visibility abstention" fixtures that lowered every
 * landmark to 0.5 visibility to trip the old 0.65 confidence floor now score
 * with `lower_confidence`. The permit, receipt and replay contracts for an
 * ABSTAINED run (`kind: 'low_confidence'`: a durable mechanics record, the
 * permit released as low_confidence, nothing synced or spent) are still the
 * pipeline's contract, so these suites keep exercising them through a spy
 * that turns the analyzer's verdict into the exact abstention the engine
 * emits — every other stage (sidecar parsing, the pre-analysis gate, the
 * permit round trip, the durable commit) stays real.
 *
 * The spy fires only for the fixtures' own marker: a pose sequence whose
 * EVERY frame confidence is at or below `ABSTAINING_FIXTURE_CONFIDENCE`.
 * Full-visibility fixtures are untouched and score as in production.
 */
export const ABSTAINING_FIXTURE_CONFIDENCE = 0.5;

export const ABSTAIN_GUIDANCE =
  "Couldn't read this stroke clearly. Reposition the phone.";

/** The record `analyzeCapture` returns when the engine withholds the grade. */
export function abstainedRecord(
  record: CaptureAnalysisRecord,
): CaptureAnalysisRecord {
  if (!record.result) return record;
  return {
    ...record,
    result: {
      ...record.result,
      overallScore: null,
      resultKind: 'low_confidence',
      guidance: ABSTAIN_GUIDANCE,
      priorityFix: null,
      checkpoints: record.result.checkpoints.map(checkpoint => ({
        ...checkpoint,
        score: null,
        band: 'unscored',
      })),
    },
    faults: [],
    uncertainty: {
      ...record.uncertainty,
      presentation: 'abstain',
      limitingFactors: [
        ...new Set([
          ...record.uncertainty.limitingFactors,
          'analysis_confidence_below_threshold',
        ]),
      ],
    },
  };
}

/**
 * Installs the spy on the (namespace-mocked) pipeline module. Suites must
 * `jest.mock('@pickle/analysis-pipeline', () => ({ __esModule: true,
 * ...jest.requireActual('@pickle/analysis-pipeline') }))` so the export is
 * writable. Returns the spy; `mockRestore()` removes it.
 */
export function installAbstainingScorer(): jest.SpyInstance {
  const actual = jest.requireActual<typeof pipeline>(
    '@pickle/analysis-pipeline',
  ).analyzeCapture;
  return jest
    .spyOn(pipeline, 'analyzeCapture')
    .mockImplementation(async (providers, input, options) => {
      const result = await actual(providers, input, options);
      const frames = input.pose.frames;
      const abstaining =
        frames.length > 0 &&
        frames.every(
          frame => frame.confidence <= ABSTAINING_FIXTURE_CONFIDENCE,
        );
      if (!result.ok || !abstaining) return result;
      return ok(abstainedRecord(result.value));
    });
}
