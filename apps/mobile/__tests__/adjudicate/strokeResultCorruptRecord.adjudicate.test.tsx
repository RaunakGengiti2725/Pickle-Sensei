/**
 * ADJUDICATION — mobile-design-components-walkthrough — confirmed item C1.
 *
 * `loadAnalysisRecordById` guards JSON *syntax* only: any parseable payload
 * is returned typed as a `StrokeResultEvidenceRecord`. Non-object JSON is
 * surfaced as a record instead of being skipped, and an object whose
 * envelope keys hold the wrong type reaches `StrokeResult`, whose render
 * path throws a TypeError (no error boundary exists in the app).
 *
 * Fix-agnostic acceptance: the loader must return null for non-object JSON,
 * and a shape-corrupt object row must never make `StrokeResult` throw —
 * whether the fix validates in the loader (→ null → "Result missing") or
 * hardens the model helpers is the fixer's choice.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../../src/data/db';
import {
  loadAnalysisRecordById,
  loadStrokeResultEvidence,
} from '../../src/components/strokeResultData';
import { StrokeResult } from '../../src/components/StrokeResult';

jest.mock('../../src/components/ClipPlayer', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    clipPlaybackAvailable: () => false,
    ClipPlayer: (props: Record<string, unknown>) =>
      ReactActual.createElement(RN.View, { testID: 'clip-player', ...props }),
  };
});

function fakeDb(record: string): LocalDb {
  return {
    async execute(sql: string) {
      if (sql.includes('FROM local_analysis_record')) {
        return { rows: [{ record }] };
      }
      return { rows: [] };
    },
    close() {},
  };
}

const NON_OBJECT_JSON = ['5', '[]', '"text"', 'true', '[{"result":null}]'];

const SHAPE_CORRUPT_OBJECTS: Array<[string, string]> = [
  [
    'predicted_l3 with empty predictedStroke',
    '{"id":"x","strokeIntent":{"resolutionBasis":"predicted_l3","predictedStroke":{}}}',
  ],
  [
    'declared basis with numeric declaredStroke',
    '{"id":"x","strokeIntent":{"resolutionBasis":"declared","declaredStroke":42}}',
  ],
  ['result is an array', '{"id":"x","result":[]}'],
  [
    'result without timestamps',
    '{"id":"x","result":{"shotType":"forehand_drive"}}',
  ],
  [
    'temporalPhasesV2 segments is a string',
    '{"id":"x","temporalPhasesV2":{"kind":"segments","segments":"nope"}}',
  ],
  [
    'uncertainty limitingFactors is a number',
    '{"id":"x","uncertainty":{"presentation":"???","limitingFactors":5}}',
  ],
];

describe('C1 — loadAnalysisRecordById returns null for non-object JSON', () => {
  it.each(NON_OBJECT_JSON)('payload %s → null', async payload => {
    await expect(
      loadAnalysisRecordById(fakeDb(payload), 'analysis-1'),
    ).resolves.toBeNull();
  });

  it('a genuine object record still round-trips', async () => {
    await expect(
      loadAnalysisRecordById(fakeDb('{"id":"analysis-1"}'), 'analysis-1'),
    ).resolves.toEqual({ id: 'analysis-1' });
  });
});

describe('C1 — a shape-corrupt object row never throws out of StrokeResult', () => {
  it.each(SHAPE_CORRUPT_OBJECTS)('%s', async (_label, payload) => {
    const evidence = await loadStrokeResultEvidence(
      fakeDb(payload),
      'analysis-1',
    );
    let renderer: TestRenderer.ReactTestRenderer | null = null;
    await expect(
      act(async () => {
        renderer = TestRenderer.create(
          <StrokeResult
            analysis={evidence.analysis}
            record={evidence.record}
            clip={evidence.clip}
            attempts={evidence.attempts}
            currentAnalysisId="analysis-1"
            onTryAgain={() => undefined}
            onDone={() => undefined}
          />,
        );
      }),
    ).resolves.toBeUndefined();
    if (renderer) await act(async () => renderer!.unmount());
  });
});
