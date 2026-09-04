/**
 * ATTACK S3 — capture payload.fps = 30.0000001 vs column fps = 30.
 *
 * parseCaptureRow (repository.ts:683-716) compares the JSON payload against
 * the adjacent columns with strict `===` on every numeric field. The attack
 * checks that a sub-ppm float drift is NOT waved through as `valid`, and
 * probes SQLite's REAL/INTEGER affinity round-trips with seeded perturbations
 * so the strict comparison is pinned from both sides (identical doubles must
 * still read `valid`).
 *
 * Real production schema on node:sqlite; rows come from savePendingCapture
 * and the drift is applied with a targeted UPDATE of one column.
 */
import type { LocalDb } from '../../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import {
  getPendingCapture,
  listCaptureHistory,
  savePendingCapture,
} from '../../../src/data/repository';
import {
  OWNER_A,
  capturedClip,
} from '../../../testing/attack/mobileDataSyncFixtures';
import {
  loadRealGetDb,
  seededRandom,
  uuidAt,
} from '../../../testing/attack/mobileDataSync4Harness';
import { createOpSqliteModuleMock } from '../../../testing/attack/nodeSqliteOpAdapter';

const mockOpSqlite = createOpSqliteModuleMock();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockOpSqlite.open(options),
}));

const SEED = 0x53_03_2026;

describe('ATTACK S3 — parseCaptureRow float drift [real sqlite]', () => {
  let db: LocalDb;

  beforeEach(() => {
    db = loadRealGetDb()();
    setActiveDataOwner(OWNER_A);
  });

  afterEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    db.close();
  });

  it('payload.fps 30.0000001 against column fps 30 reads metadata_mismatch, never valid', async () => {
    const id = uuidAt(0xca0, 1);
    await savePendingCapture(db, id, 'forehand_drive', {
      ...capturedClip,
      fps: 30.0000001,
    });
    // Column drifts (e.g. a future migration rounding fps) while the payload
    // keeps the original double.
    await db.execute(
      `UPDATE local_capture SET fps = 30 WHERE owner_key = ? AND id = ?`,
      [OWNER_A, id],
    );
    const { rows } = await db.execute(
      `SELECT fps, typeof(fps) AS t, json_extract(payload, '$.fps') AS pfps
         FROM local_capture WHERE id = ?`,
      [id],
    );
    expect(rows[0]).toMatchObject({ fps: 30, pfps: 30.0000001 });

    const pending = await getPendingCapture(db, id);
    expect(pending).not.toBeNull();
    expect(pending!.evidenceStatus).toBe('metadata_mismatch');
    expect(pending!.clip).toBeNull();
    expect(pending!.fps).toBe(30);

    const history = await listCaptureHistory(db);
    expect(history).toHaveLength(1);
    expect(history[0]!.evidenceStatus).toBe('metadata_mismatch');
  });

  it('the reverse drift (payload 30, column 30.0000001) is also a mismatch', async () => {
    const id = uuidAt(0xca0, 2);
    await savePendingCapture(db, id, 'forehand_drive', {
      ...capturedClip,
      fps: 30,
    });
    await db.execute(
      `UPDATE local_capture SET fps = 30.0000001 WHERE owner_key = ? AND id = ?`,
      [OWNER_A, id],
    );
    const pending = await getPendingCapture(db, id);
    expect(pending!.evidenceStatus).toBe('metadata_mismatch');
  });

  it(`seeded (${SEED}) REAL round-trips: an untouched row with any finite fps/durationMs reads valid, any perturbation reads metadata_mismatch`, async () => {
    const random = seededRandom(SEED);
    const perturbations: Array<{ fps: number; drift: number }> = [];
    for (let n = 0; n < 24; n++) {
      // fps values like 29.97, 59.94, 120, 240.0000003 — full double range.
      const fps = Math.round(random() * 240 * 1e7) / 1e7 + 1e-7;
      const drift = (random() - 0.5) * 1e-6;
      perturbations.push({ fps, drift: drift === 0 ? 1e-9 : drift });
    }

    for (const [n, { fps, drift }] of perturbations.entries()) {
      const id = uuidAt(0xca1, n);
      // ≥ fixture trigger window (isTrigger bounds endMs by durationMs); the
      // fractional tail makes the INTEGER-affinity column hold a REAL.
      const durationMs = 3900 + Math.round(random() * 5000) + random();
      await savePendingCapture(db, id, 'forehand_drive', {
        ...capturedClip,
        uri: `file:///private/captures/seeded-${n}.mov`,
        fps,
        durationMs,
      });
      const untouched = await getPendingCapture(db, id);
      expect({ n, fps, status: untouched!.evidenceStatus }).toEqual({
        n,
        fps,
        status: 'valid',
      });
      expect(untouched!.clip?.fps).toBe(fps);

      await db.execute(
        `UPDATE local_capture SET fps = ? WHERE owner_key = ? AND id = ?`,
        [fps + drift, OWNER_A, id],
      );
      const drifted = await getPendingCapture(db, id);
      expect({ n, fps, drift, status: drifted!.evidenceStatus }).toEqual({
        n,
        fps,
        drift,
        status: 'metadata_mismatch',
      });
    }
  });

  it('SQLite affinity: an INTEGER-affinity duration_ms column keeps a fractional payload duration exactly (valid), and 0 fps vs -0 payload stays valid (=== treats them equal)', async () => {
    const id = uuidAt(0xca2, 1);
    await savePendingCapture(db, id, 'forehand_drive', {
      ...capturedClip,
      durationMs: 3900.25,
      fps: 0,
    });
    const { rows } = await db.execute(
      `SELECT typeof(duration_ms) AS td, duration_ms, typeof(fps) AS tf FROM local_capture WHERE id = ?`,
      [id],
    );
    expect(rows[0]).toMatchObject({ td: 'real', duration_ms: 3900.25 });
    expect((await getPendingCapture(db, id))!.evidenceStatus).toBe('valid');

    await db.execute(`UPDATE local_capture SET fps = -0.0 WHERE id = ?`, [id]);
    expect((await getPendingCapture(db, id))!.evidenceStatus).toBe('valid');
  });
});
