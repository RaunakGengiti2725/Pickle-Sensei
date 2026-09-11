import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { LocalDb } from '../src/data/db';
import {
  getCaptureTargetSeed,
  parseCaptureTargetSeed,
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

  it('distinguishes absent seeds from corrupt or malformed selection evidence', async () => {
    setActiveDataOwner(owner);
    const rowsByCall: Array<Record<string, unknown>[]> = [
      [],
      [{ target_seed: null }],
      [{ target_seed: '{not-json' }],
      [{ target_seed: '' }],
      [{ target_seed: JSON.stringify({ ...seed, point: { x: 1.1, y: 0.5 } }) }],
      [
        {
          target_seed: JSON.stringify({ ...seed, point: { x: 0.5, y: -0.1 } }),
        },
      ],
      [
        {
          target_seed: JSON.stringify({
            ...seed,
            selectedAtIso: '2026-02-30T00:00:00.000Z',
          }),
        },
      ],
      [
        {
          target_seed: JSON.stringify({ ...seed, selectedAtIso: 'not a date' }),
        },
      ],
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
      if (rows.length === 0 || rows[0]?.target_seed === null) {
        expect(parseCaptureTargetSeed(rows[0]?.target_seed)).toEqual({
          kind: 'absent',
        });
        await expect(getCaptureTargetSeed(db, 'capture-1')).resolves.toBeNull();
      } else {
        expect(parseCaptureTargetSeed(rows[0]?.target_seed)).toEqual({
          kind: 'corrupt',
        });
        await expect(getCaptureTargetSeed(db, 'capture-1')).rejects.toThrow(
          'corrupt',
        );
      }
    }
  });

  it.each([
    { ...seed, point: { x: 2, y: 0.5 } },
    { ...seed, point: { x: 0.5, y: Number.NaN } },
    { ...seed, selectedAtIso: '2026-02-30T00:00:00.000Z' },
  ])('rejects corrupt target input before any write: %j', async invalid => {
    setActiveDataOwner(owner);
    const execute = jest.fn(async () => ({ rows: [] }));
    await expect(
      setCaptureTargetSeed({ execute, close() {} }, 'capture-1', invalid),
    ).rejects.toThrow('invalid');
    expect(execute).not.toHaveBeenCalled();
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
