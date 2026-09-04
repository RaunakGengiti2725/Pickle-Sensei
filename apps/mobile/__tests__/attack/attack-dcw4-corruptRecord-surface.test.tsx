/**
 * ADVERSARIAL PASS 3 — mobile-design-components-walkthrough — scenario 6.
 *
 * local_analysis_record rows that parse as JSON but are NOT record objects
 * (`[]`, `5`, `{}`, `{"id":1}`) — plus a few nastier shapes — are loaded via
 * the REAL `loadAnalysisRecordById` / `loadStrokeResultEvidence` and pushed
 * through the REAL `StrokeResult` surface. The saved-analysis fallback must
 * render (strokeResultHeader → "Saved analysis" header, abstentionLedger
 * → honest ledger) without throwing, and the pure helpers must never throw
 * on any of these shapes either.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../../src/data/db';
import {
  loadAnalysisRecordById,
  loadStrokeResultEvidence,
} from '../../src/components/strokeResultData';
import {
  abstentionLedger,
  contactMarkerPresentation,
  effectivePhaseTimeline,
  measuredRows,
  strokeResultHeader,
  type StrokeResultEvidenceRecord,
} from '../../src/components/strokeResultModel';
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

function fakeDb(record: string | null): LocalDb {
  return {
    async execute(sql: string) {
      if (sql.includes('FROM local_analysis_record')) {
        return { rows: record === null ? [] : [{ record }] };
      }
      return { rows: [] };
    },
    close() {},
  };
}

/** Assigned payloads + extras that are valid JSON but carry NO record
 * fields at all (wrong root type / unknown keys). */
const PAYLOADS: Array<[string, string]> = [
  ['[]', '[]'],
  ['5', '5'],
  ['{}', '{}'],
  ['{"id":1}', '{"id":1}'],
  ['"string"', '"just a string"'],
  ['true', 'true'],
  ['null', 'null'],
  ['nested array', '[[[]]]'],
  ['strokeIntent as number', '{"id":"x","strokeIntent":7}'],
  [
    'strokeIntent basis unknown',
    '{"id":"x","strokeIntent":{"resolutionBasis":"💥","declaredStroke":null}}',
  ],
  ['contact as string', '{"id":"x","contact":"nope"}'],
  ['unicode keys', '{"ｉｄ":"x","strokeIntent\\u0000":null,"🍕":"🍕"}'],
  ['captureId non-string', '{"id":"x","captureId":123}'],
  [
    'huge array (5k)',
    JSON.stringify(Array.from({ length: 5000 }, (_, i) => i)),
  ],
];

/** EXTRA (beyond the brief): records whose envelope keys EXIST but hold the
 * wrong type — the shape a version-skewed or partially-written row takes. */
const SHAPE_CORRUPT: Array<[string, string]> = [
  [
    'predicted_l3 with empty predictedStroke {}',
    '{"id":"x","strokeIntent":{"resolutionBasis":"predicted_l3","predictedStroke":{}}}',
  ],
  [
    'declared basis, declaredStroke number',
    '{"id":"x","strokeIntent":{"resolutionBasis":"declared","declaredStroke":42}}',
  ],
  ['result as array', '{"id":"x","result":[]}'],
  [
    'result timestamps missing',
    '{"id":"x","result":{"shotType":"forehand_drive"}}',
  ],
  [
    'phases garbage',
    '{"id":"x","temporalPhasesV2":{"kind":"segments","segments":"nope"}}',
  ],
  [
    'uncertainty garbage',
    '{"id":"x","uncertainty":{"presentation":"???","limitingFactors":5}}',
  ],
];

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

const consoleError = jest.spyOn(console, 'error');
beforeEach(() => consoleError.mockClear());
afterAll(() => consoleError.mockRestore());

describe('ATTACK S6 — non-record JSON in local_analysis_record', () => {
  describe.each(PAYLOADS)('payload %s', (_label, payload) => {
    it('loads without throwing and the pure model helpers tolerate the shape', async () => {
      const record = await loadAnalysisRecordById(
        fakeDb(payload),
        'analysis-1',
      );
      // Loader contract today: any JSON.parse-able payload is returned as-is
      // (typed as a record). Pin whatever comes back so downstream honesty
      // is what gets tested, and make sure nothing below throws on it.
      const typed = record as StrokeResultEvidenceRecord | null;
      expect(() => strokeResultHeader(typed, null)).not.toThrow();
      expect(() => contactMarkerPresentation(typed?.contact)).not.toThrow();
      expect(() => effectivePhaseTimeline(typed, null)).not.toThrow();
      expect(() =>
        abstentionLedger({ record: typed, analysis: null, clipPresent: false }),
      ).not.toThrow();
      const header = strokeResultHeader(typed, null);
      expect(typeof header.title).toBe('string');
      expect(header.title.length).toBeGreaterThan(0);
      expect(header.title).not.toMatch(/undefined|null|NaN|\[object/);
      expect(header.subtitle).not.toMatch(/undefined|NaN|\[object/);
    });

    it('loadStrokeResultEvidence resolves (no clip fabricated) and StrokeResult renders the saved-analysis fallback', async () => {
      const evidence = await loadStrokeResultEvidence(
        fakeDb(payload),
        'analysis-1',
      );
      expect(evidence.analysis).toBeNull();
      expect(evidence.clip).toBeNull();
      expect(evidence.attempts).toEqual([]);

      let renderer!: TestRenderer.ReactTestRenderer;
      await expect(
        (async () => {
          renderer = await render(
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
        })(),
      ).resolves.toBeUndefined();
      const rendered = textOf(renderer);
      // Saved-analysis header (no provenance claimed) + honest replay empty
      // state; never an invented score or technique.
      expect(rendered).toContain('Saved stroke');
      expect(rendered).toContain('From your saved analysis on this device.');
      expect(rendered).toContain(
        'No replay evidence is stored for this stroke on this device.',
      );
      expect(rendered).not.toContain('out of 10');
      expect(rendered).not.toContain('undefined');
      expect(rendered).not.toContain('NaN');
      expect(rendered).not.toContain('[object');
      // No React render/key/prop-type errors escaped either.
      expect(
        consoleError.mock.calls.filter(
          args => !String(args[0]).includes('act('),
        ),
      ).toEqual([]);
      await act(async () => renderer.unmount());
    });
  });

  describe.each(SHAPE_CORRUPT)(
    'extra: shape-corrupt record %s',
    (_label, payload) => {
      it('pure helpers (strokeResultHeader/effectivePhaseTimeline/abstentionLedger) must not throw', async () => {
        const record = (await loadAnalysisRecordById(
          fakeDb(payload),
          'analysis-1',
        )) as StrokeResultEvidenceRecord | null;
        // A well-formed row whose envelope fields hold the wrong types is a
        // corrupt row: the loader skips it (null) instead of handing it to the
        // model helpers unvalidated.
        expect(record).toBeNull();
        expect(() => strokeResultHeader(record, null)).not.toThrow();
        expect(() => effectivePhaseTimeline(record, null)).not.toThrow();
        expect(() =>
          abstentionLedger({ record, analysis: null, clipPresent: false }),
        ).not.toThrow();
        expect(() => measuredRows({ analysis: null, record })).not.toThrow();
      });

      it('StrokeResult must render a fallback instead of throwing out to the root error boundary', async () => {
        const evidence = await loadStrokeResultEvidence(
          fakeDb(payload),
          'analysis-1',
        );
        let threw: unknown = null;
        let renderer: TestRenderer.ReactTestRenderer | null = null;
        try {
          renderer = await render(
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
        } catch (error) {
          threw = error;
        }
        if (renderer) await act(async () => renderer!.unmount());
        expect(threw).toBeNull();
      });
    },
  );

  it('a syntactically corrupt payload is skipped (null), not thrown', async () => {
    for (const bad of ['{', '[1,', 'undefined', '{"id":', '\u0000']) {
      await expect(
        loadAnalysisRecordById(fakeDb(bad), 'a'),
      ).resolves.toBeNull();
    }
  });

  it('an empty string / missing row yields null', async () => {
    await expect(loadAnalysisRecordById(fakeDb(''), 'a')).resolves.toBeNull();
    await expect(loadAnalysisRecordById(fakeDb(null), 'a')).resolves.toBeNull();
  });

  it('extra: a non-string `record` column (number / Buffer-ish object) yields null, never a throw', async () => {
    const weird: LocalDb = {
      async execute(sql: string) {
        if (sql.includes('FROM local_analysis_record')) {
          return { rows: [{ record: 12345 }] };
        }
        return { rows: [] };
      },
      close() {},
    };
    await expect(loadAnalysisRecordById(weird, 'a')).resolves.toBeNull();
    const objectCol: LocalDb = {
      async execute(sql: string) {
        if (sql.includes('FROM local_analysis_record')) {
          return { rows: [{ record: { id: 'x' } as unknown as string }] };
        }
        return { rows: [] };
      },
      close() {},
    };
    await expect(loadAnalysisRecordById(objectCol, 'a')).resolves.toBeNull();
  });
});
