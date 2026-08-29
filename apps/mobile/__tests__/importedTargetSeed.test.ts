import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { LocalDb } from '../src/data/db';
import {
  getCaptureTargetSeed,
  setCaptureTargetSeed,
  type CaptureTargetSeed,
} from '../src/data/repository';

const owner = '22222222-2222-4222-8222-222222222222';

const seed: CaptureTargetSeed = {
  point: { x: 0.42, y: 0.61 },
  selectedAtIso: '2026-08-29T12:00:00.000Z',
};

describe('imported-capture target seed persistence', () => {
  afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('writes the tap to the owner-scoped capture row', async () => {
    setActiveDataOwner(owner);
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db: LocalDb = {
      async execute(sql, params = []) {
        calls.push({ sql, params });
        return { rows: [] };
      },
      close() {},
    };

    await setCaptureTargetSeed(db, 'capture-1', seed);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('UPDATE local_capture SET target_seed');
    expect(calls[0]?.params).toEqual([
      JSON.stringify(seed),
      owner,
      'capture-1',
    ]);
  });

  it('round-trips the persisted tap', async () => {
    setActiveDataOwner(owner);
    const db: LocalDb = {
      async execute() {
        return { rows: [{ target_seed: JSON.stringify(seed) }] };
      },
      close() {},
    };

    await expect(getCaptureTargetSeed(db, 'capture-1')).resolves.toEqual(seed);
  });

  it('reads absent, corrupt, or malformed seeds as null, never a reconstructed tap', async () => {
    setActiveDataOwner(owner);
    const rowsByCall: Array<Record<string, unknown>[]> = [
      [],
      [{ target_seed: null }],
      [{ target_seed: '{not-json' }],
      [{ target_seed: JSON.stringify({ point: { x: 'a', y: 0.5 } }) }],
      [
        {
          target_seed: JSON.stringify({
            point: { x: Number.NaN, y: 0.5 },
            selectedAtIso: seed.selectedAtIso,
          }),
        },
      ],
    ];
    for (const rows of rowsByCall) {
      const db: LocalDb = {
        async execute() {
          return { rows };
        },
        close() {},
      };
      await expect(getCaptureTargetSeed(db, 'capture-1')).resolves.toBeNull();
    }
  });

  it('refuses to write for a read-only owner scope', async () => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const db: LocalDb = {
      async execute() {
        throw new Error('must not reach the database');
      },
      close() {},
    };
    await expect(setCaptureTargetSeed(db, 'capture-1', seed)).rejects.toThrow();
  });
});
