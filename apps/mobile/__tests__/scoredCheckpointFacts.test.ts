// The repository module is imported directly against a fake LocalDb; the
// SQLite-backed db module never loads under jest.
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

import type { LocalDb } from '../src/data/db';
import { GUEST_DATA_OWNER, setActiveDataOwner } from '../src/data/accountScope';
import { listScoredCheckpointFacts } from '../src/data/repository';

/**
 * The drill library's local evidence read. Every row crosses an unvalidated
 * JSON boundary, so this suite hammers it with corrupt, hostile, and legacy
 * payload shapes: nothing throws, nothing is repaired into fake evidence,
 * and only real scored analyses with a checkpoints array survive.
 */

const owner = '44444444-4444-4444-8444-444444444444';

interface RecordedCall {
  sql: string;
  params: unknown[] | undefined;
}

function fakeDb(rows: Record<string, unknown>[]): {
  db: LocalDb;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const db: LocalDb = {
    async execute(sql, params) {
      calls.push({ sql, params });
      return { rows };
    },
    close() {},
  };
  return { db, calls };
}

function payloadRow(payload: unknown): Record<string, unknown> {
  return {
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

function validAnalysis(overrides?: Record<string, unknown>) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    shotType: 'dink',
    capturedAtIso: '2026-08-02T10:00:00.000Z',
    source: 'real',
    resultKind: 'scored',
    checkpoints: [
      { key: 'contact_position', score: 61.5, applicable: true },
      { key: 'athletic_base', score: 80, applicable: true },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  setActiveDataOwner(owner);
});

describe('listScoredCheckpointFacts', () => {
  it('parses valid scored rows and scopes the query to the active owner', async () => {
    const { db, calls } = fakeDb([payloadRow(validAnalysis())]);
    const facts = await listScoredCheckpointFacts(db);
    expect(facts).toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        shotType: 'dink',
        capturedAt: '2026-08-02T10:00:00.000Z',
        checkpoints: [
          { key: 'contact_position', score: 61.5, applicable: true },
          { key: 'athletic_base', score: 80, applicable: true },
        ],
      },
    ]);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    // Scored real analyses only, newest first, owner-scoped, bounded.
    expect(call.sql).toContain("source = 'real'");
    expect(call.sql).toContain("result_kind = 'scored'");
    expect(call.sql).toContain('ORDER BY captured_at DESC');
    expect(call.params).toEqual([owner, 120]);
  });

  it('works for the guest owner bucket too', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    const { db, calls } = fakeDb([]);
    await expect(listScoredCheckpointFacts(db)).resolves.toEqual([]);
    expect(calls[0]!.params).toEqual([GUEST_DATA_OWNER, 120]);
  });

  it('skips corrupt rows without throwing and without repairing them', async () => {
    const { db } = fakeDb([
      payloadRow('{"definitely not json'),
      payloadRow('null'),
      payloadRow('42'),
      payloadRow('"a string"'),
      { payload: null },
      { payload: undefined },
      {},
      payloadRow(validAnalysis()),
    ]);
    const facts = await listScoredCheckpointFacts(db);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.id).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('re-verifies provenance after the SQL boundary: fixtures and abstentions never become evidence', async () => {
    const { db } = fakeDb([
      payloadRow(validAnalysis({ source: 'fixture' })),
      payloadRow(validAnalysis({ resultKind: 'low_confidence' })),
      payloadRow(validAnalysis({ source: undefined })),
      payloadRow(validAnalysis({ resultKind: undefined })),
    ]);
    await expect(listScoredCheckpointFacts(db)).resolves.toEqual([]);
  });

  it('drops rows whose checkpoints are not an array', async () => {
    const { db } = fakeDb([
      payloadRow(validAnalysis({ checkpoints: null })),
      payloadRow(validAnalysis({ checkpoints: 'nope' })),
      payloadRow(validAnalysis({ checkpoints: { key: 'x' } })),
      payloadRow(validAnalysis({ checkpoints: undefined })),
    ]);
    await expect(listScoredCheckpointFacts(db)).resolves.toEqual([]);
  });

  it('sanitizes checkpoint entries: non-finite or non-number scores become null, applicable must be exactly true', async () => {
    const { db } = fakeDb([
      payloadRow(
        validAnalysis({
          checkpoints: [
            { key: 'contact_position', score: '80', applicable: true },
            { key: 'athletic_base', score: true, applicable: 1 },
            { key: 'paddle_path', score: null, applicable: 'yes' },
            { key: 'sequencing', score: 55, applicable: true },
            { key: 7, score: 44, applicable: true },
            {
              key: 'follow_through',
              score: Number.MAX_VALUE,
              applicable: true,
            },
          ],
        }),
      ),
    ]);
    const facts = await listScoredCheckpointFacts(db);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.checkpoints).toEqual([
      { key: 'contact_position', score: null, applicable: true },
      { key: 'athletic_base', score: null, applicable: false },
      { key: 'paddle_path', score: null, applicable: false },
      { key: 'sequencing', score: 55, applicable: true },
      { key: '7', score: 44, applicable: true },
      { key: 'follow_through', score: Number.MAX_VALUE, applicable: true },
    ]);
  });

  it('rejects invalid limits loudly instead of querying garbage', async () => {
    const { db, calls } = fakeDb([]);
    await expect(listScoredCheckpointFacts(db, 0)).rejects.toThrow(
      'positive integer',
    );
    await expect(listScoredCheckpointFacts(db, -5)).rejects.toThrow(
      'positive integer',
    );
    await expect(listScoredCheckpointFacts(db, 2.5)).rejects.toThrow(
      'positive integer',
    );
    await expect(listScoredCheckpointFacts(db, Number.NaN)).rejects.toThrow(
      'positive integer',
    );
    expect(calls).toHaveLength(0);
    await expect(listScoredCheckpointFacts(db, 7)).resolves.toEqual([]);
    expect(calls[0]!.params).toEqual([owner, 7]);
  });

  it('propagates real database failures instead of swallowing them', async () => {
    const db: LocalDb = {
      async execute() {
        throw new Error('disk I/O error');
      },
      close() {},
    };
    await expect(listScoredCheckpointFacts(db)).rejects.toThrow(
      'disk I/O error',
    );
  });

  it('handles 500 mixed rows in one pass without throwing', async () => {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 500; i += 1) {
      if (i % 5 === 0) {
        rows.push(payloadRow('{corrupt'));
      } else if (i % 5 === 1) {
        rows.push(payloadRow(validAnalysis({ source: 'fixture' })));
      } else {
        rows.push(
          payloadRow(
            validAnalysis({
              id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
              capturedAtIso: `2026-08-${String(1 + (i % 28)).padStart(
                2,
                '0',
              )}T10:00:00.000Z`,
            }),
          ),
        );
      }
    }
    const { db } = fakeDb(rows);
    const facts = await listScoredCheckpointFacts(db, 500);
    expect(facts).toHaveLength(300);
    for (const fact of facts) {
      expect(fact.shotType).toBe('dink');
      expect(Array.isArray(fact.checkpoints)).toBe(true);
    }
  });
});
