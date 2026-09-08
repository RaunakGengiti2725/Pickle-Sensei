/**
 * ADVERSARY (performance-bounds): the Progress screen on a large library.
 *
 * ProgressScreen loads `listCaptureHistory(db, null)` — EVERY durable
 * capture row of the owner, payload included, re-validated through the
 * strict clip parser — on each focus, then `buildPracticeHistory` sorts and
 * buckets the lot in a `useMemo`. Both run on the JS thread. Probed with a
 * two-years-of-daily-practice library (3 000 guided captures) through the
 * real SQLite repository and the real aggregation:
 *  - wall time of the row load + aggregation must stay inside a launch
 *    budget (V8 here; Hermes on device is several times slower);
 *  - the per-capture cost must stay linear (10× the rows → ≤ ~12× the time),
 *    i.e. no quadratic path in the sort/bucketing.
 */
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { listCaptureHistory } from '../../src/data/repository';
import { buildPracticeHistory } from '../../src/progress/practiceHistory';
import { guidedClipFixture } from '../../testSupport/guidedClipFixture';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
  seedSqliteCapture,
} from '../../testSupport/sqlite';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

const owner = '55555555-5555-4555-8555-555555555555';
const AS_OF = '2026-09-08T12:00:00.000Z';
const SMALL_LIBRARY = 300;
const LARGE_LIBRARY = 3_000;
/** Loading + aggregating a two-year library on Progress focus. */
const LARGE_LIBRARY_BUDGET_MS = 1_500;
const MAX_SCALING_RATIO = 12;

function seedLibrary(
  db: ReturnType<typeof createSqliteTestDb>['db'],
  count: number,
): number {
  const { clip } = guidedClipFixture('library');
  const asOfMs = Date.parse(AS_OF);
  let bytes = 0;
  for (let index = 0; index < count; index += 1) {
    const id = `cccccccc-cccc-4ccc-8ccc-${String(index).padStart(12, '0')}`;
    // ~4 captures a day, spread back over the library's lifetime.
    const capturedAtIso = new Date(
      asOfMs - Math.floor(index / 4) * 86_400_000 - (index % 4) * 900_000,
    ).toISOString();
    const rowClip = {
      ...clip,
      uri: `file:///captures/${id}.mov`,
      capturedAtIso,
      nativeMediaIdentity: {
        ...clip.nativeMediaIdentity!,
        videoFileName: `${id}.mov`,
      },
    };
    bytes += JSON.stringify(rowClip).length;
    seedSqliteCapture(db, owner, id, rowClip);
  }
  return bytes;
}

async function measure(count: number): Promise<{
  loadMs: number;
  aggregateMs: number;
  rows: number;
  verified: number;
  payloadBytes: number;
}> {
  const { db } = createSqliteTestDb();
  const payloadBytes = seedLibrary(db, count);
  const loadStart = performance.now();
  const captures = await listCaptureHistory(db, null);
  const loadMs = performance.now() - loadStart;
  const aggregateStart = performance.now();
  const history = buildPracticeHistory(captures, {
    asOfIso: AS_OF,
    timeZone: 'UTC',
    range: '28d',
  });
  const aggregateMs = performance.now() - aggregateStart;
  return {
    loadMs,
    aggregateMs,
    rows: captures.length,
    verified: captures.length - history.excludedCaptureCount,
    payloadBytes,
  };
}

describe('ADV perf: Progress screen over a large local library', () => {
  beforeEach(() => setActiveDataOwner(owner));
  afterEach(() => {
    closeSqliteTestDatabases();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  });

  it('loads and aggregates a 3 000-capture library inside the focus budget and linearly from 300', async () => {
    const small = await measure(SMALL_LIBRARY);
    closeSqliteTestDatabases();
    const large = await measure(LARGE_LIBRARY);
    const smallTotal = small.loadMs + small.aggregateMs;
    const largeTotal = large.loadMs + large.aggregateMs;
    console.warn(
      `[adv] ${SMALL_LIBRARY} captures (${small.payloadBytes} B payload): load ${small.loadMs.toFixed(0)} ms + aggregate ${small.aggregateMs.toFixed(0)} ms, verified ${small.verified}`,
    );
    console.warn(
      `[adv] ${LARGE_LIBRARY} captures (${large.payloadBytes} B payload): load ${large.loadMs.toFixed(0)} ms + aggregate ${large.aggregateMs.toFixed(0)} ms, verified ${large.verified}`,
    );
    expect(small.rows).toBe(SMALL_LIBRARY);
    expect(large.rows).toBe(LARGE_LIBRARY);
    expect(small.verified).toBe(SMALL_LIBRARY);
    expect(large.verified).toBe(LARGE_LIBRARY);
    expect(largeTotal).toBeLessThan(LARGE_LIBRARY_BUDGET_MS);
    expect(largeTotal / Math.max(smallTotal, 1)).toBeLessThan(
      MAX_SCALING_RATIO,
    );
  });
});
