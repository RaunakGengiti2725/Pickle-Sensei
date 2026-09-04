/**
 * AUDIT — strokeResultData.loadAnalysisRecordById (strokeResultData.ts:70)
 * casts `JSON.parse(payload)` straight to StrokeResultEvidenceRecord. A row
 * holding VALID JSON that is not an object ("5", "[]", "\"x\"", "true") is
 * therefore returned as a "record", and isAbstainedResult() then reports an
 * honest-abstention surface for what is actually a corrupt row — the exact
 * "repair" the file's own comment forbids.
 */
import type { LocalDb } from '../../src/data/db';
import { loadAnalysisRecordById } from '../../src/components/strokeResultData';
import { isAbstainedResult } from '../../src/components/strokeResultModel';

function dbWithRecord(payload: string | null): LocalDb {
  return {
    async execute(sql: string) {
      if (sql.includes('FROM local_analysis_record')) {
        return { rows: payload === null ? [] : [{ record: payload }] };
      }
      return { rows: [] };
    },
    close() {},
  };
}

describe('loadAnalysisRecordById with well-formed but non-object JSON', () => {
  it('VERIFIED: an object record round-trips; "null" JSON and unparseable text yield null', async () => {
    await expect(
      loadAnalysisRecordById(dbWithRecord('{"id":"a"}'), 'a'),
    ).resolves.toEqual({ id: 'a' });
    await expect(
      loadAnalysisRecordById(dbWithRecord('null'), 'a'),
    ).resolves.toBeNull();
    await expect(
      loadAnalysisRecordById(dbWithRecord('{oops'), 'a'),
    ).resolves.toBeNull();
    await expect(
      loadAnalysisRecordById(dbWithRecord(null), 'a'),
    ).resolves.toBeNull();
  });

  it.each(['5', '[]', '"text"', 'true', '[{"result":null}]'])(
    'PROBE: payload %s is not a record — loader must return null, not surface it as an abstention',
    async payload => {
      const record = await loadAnalysisRecordById(dbWithRecord(payload), 'a');
      // Concrete failure mode: a truthy non-object "record" makes the result
      // route present an abstention surface from a corrupt row.
      const presentedAsAbstention = isAbstainedResult(record, null);
      expect({ record, presentedAsAbstention }).toEqual({
        record: null,
        presentedAsAbstention: false,
      });
    },
  );
});
