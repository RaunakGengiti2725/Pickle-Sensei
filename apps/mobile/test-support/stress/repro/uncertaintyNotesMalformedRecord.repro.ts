/**
 * REPRO — finding F2 (P2), found by the boundary/i18n/a11y stress campaign
 * (`__tests__/stress/analysisFeedbackProgressBoundaryI18nA11y.test.tsx`,
 * failing seeds recorded in artifacts/stress/boundary-i18n-a11y.json).
 *
 * THIS SUITE IS RED ON PURPOSE: it is the minimized reproduction of a
 * production defect, not a characterization of intended behaviour. It goes
 * green when `phaseTimelinePresentation` treats a `temporalPhasesV2` object
 * whose `boundaries` are missing as "no timeline" (the same honest null every
 * other malformed-evidence path returns). Nothing here may be relaxed.
 *
 * Defect: persisted analysis records are read with
 * `JSON.parse(payload) as StrokeResultEvidenceRecord`
 * (src/components/strokeResultData.ts:70) — a cast, with no shape validation;
 * the comment there promises "a corrupt row is skipped — never repaired",
 * which holds for unparseable JSON but not for parseable JSON of the wrong
 * shape. `phaseTimelinePresentation` then does
 * `const b = phases.boundaries; ... b.anchorBasis`
 * (src/components/strokeResultModel.ts:480-481) after only checking
 * `status === 'abstained'`, so a row like
 * `{"temporalPhasesV2":{"status":"segmented"}}` throws a TypeError inside
 * `uncertaintyNotes()` — i.e. inside Result-surface render, which the root
 * error boundary (App.tsx:70) turns into the app-level error screen instead of
 * the result the user asked for.
 *
 * Every other malformed shape in the same reader IS handled: null contact,
 * non-finite `contactMs`, out-of-order boundaries and abstentions all return
 * `{kind:'none'}`.
 */
import { uncertaintyNotes } from '../../../src/components/UncertaintyNote';
import type { StrokeResultEvidenceRecord } from '../../../src/components/strokeResultModel';

/** Exactly what a truncated/rolled-back persisted payload parses to. */
function malformedRecord(
  phases: Record<string, unknown>,
): StrokeResultEvidenceRecord {
  return JSON.parse(
    JSON.stringify({
      id: 'analysis-corrupt',
      captureId: 'capture-corrupt',
      createdAtIso: '2026-09-04T00:00:00.000Z',
      result: null,
      contact: null,
      temporalPhasesV2: phases,
    }),
  ) as StrokeResultEvidenceRecord;
}

describe('F2 · uncertaintyNotes on a shape-corrupt persisted record', () => {
  it('does not throw when temporalPhasesV2 has no boundaries', () => {
    const record = malformedRecord({ status: 'segmented' });
    expect(() => uncertaintyNotes({ record, analysis: null })).not.toThrow();
  });

  it('does not throw when temporalPhasesV2 is an empty object', () => {
    const record = malformedRecord({});
    expect(() => uncertaintyNotes({ record, analysis: null })).not.toThrow();
  });

  it('handles every OTHER malformed shape honestly (contrast, holds today)', () => {
    const honest = [
      { status: 'abstained', reason: 'no_motion' },
      {
        status: 'segmented',
        boundaries: {
          version: 'v2',
          source: 'wrist',
          anchor: 'contact_estimate',
          confidence: 0.4,
          preparationStartMs: null,
          accelerationStartMs: 10,
          contactMs: null, // non-finite anchor ⇒ "incomplete", not a throw
          followThroughEndMs: 20,
          recoveryEndMs: null,
        },
      },
      {
        status: 'segmented',
        boundaries: {
          version: 'v2',
          source: 'paddle',
          anchor: 'speed_peak',
          confidence: 0.9,
          preparationStartMs: 100,
          accelerationStartMs: 90, // out of order ⇒ "out of order", not a throw
          contactMs: 80,
          followThroughEndMs: 70,
          recoveryEndMs: 60,
        },
      },
    ];
    for (const phases of honest) {
      const record = malformedRecord(phases);
      const notes = uncertaintyNotes({ record, analysis: null });
      expect(notes.map(n => n.kind)).toContain('phase_timing');
    }
  });
});
