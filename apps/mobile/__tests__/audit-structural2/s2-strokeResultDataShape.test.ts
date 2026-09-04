/**
 * Structural audit #2: `loadAnalysisRecordById` documents that a corrupt row
 * is "skipped — never repaired into a fake analysis". `JSON.parse` succeeds
 * for any JSON value, so a row whose payload is valid JSON but not an object
 * (array, number, string, boolean) must also be treated as corrupt and yield
 * null rather than being cast to StrokeResultEvidenceRecord.
 */
import type { LocalDb } from '../../src/data/db';
import { loadAnalysisRecordById } from '../../src/components/strokeResultData';

function dbWithRecord(record: string): LocalDb {
  return {
    async execute(sql: string) {
      if (sql.includes('FROM local_analysis_record')) {
        return { rows: [{ record }] };
      }
      return { rows: [] };
    },
  } as unknown as LocalDb;
}

describe('loadAnalysisRecordById payload shape', () => {
  it.each([
    ['array', '[]'],
    ['number', '5'],
    ['string', '"not a record"'],
    ['boolean', 'true'],
  ])('skips a valid-JSON %s payload as corrupt (null)', async (_kind, raw) => {
    await expect(
      loadAnalysisRecordById(dbWithRecord(raw), 'analysis-1'),
    ).resolves.toBeNull();
  });

  it('skips a JSON null payload (verified invariant)', async () => {
    await expect(
      loadAnalysisRecordById(dbWithRecord('null'), 'analysis-1'),
    ).resolves.toBeNull();
  });

  it('skips a syntactically corrupt payload (verified invariant)', async () => {
    await expect(
      loadAnalysisRecordById(dbWithRecord('{not json'), 'analysis-1'),
    ).resolves.toBeNull();
  });
});
