/**
 * Adjudication repro (xc-performance / perf-sqlite-sync + perf-mobile-render):
 * ProgressScreen calls `listRealAnalysisFacts(db, null)` on every focus, so the
 * whole `local_shot` history is SELECTed and JSON-parsed although the widest
 * dashboard range is 90 days. Timings below are a Node proxy (not Hermes);
 * the pinned facts are the unbounded SQL and the linear scaling shape.
 */
import type { LocalDb } from '../../src/data/db';
import { listRealAnalysisFacts } from '../../src/data/repository';
import { buildTechniqueDashboard } from '../../src/progress/techniqueDashboard';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

const CHECKPOINTS = Array.from({ length: 12 }, (_, i) => ({
  key: `checkpoint_${i}`,
  score: 40 + i * 4,
  confidence: 0.8,
  band: 'developing',
  direction: 'increase_' + 'x'.repeat(20),
  severity: 0.4,
  applicable: true,
  evidence: 'e'.repeat(120),
}));

function payload(i: number, capturedAtMs: number): string {
  return JSON.stringify({
    id: `${i.toString(16).padStart(8, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`,
    sessionId: null,
    shotType: i % 2 ? 'forehand_drive' : 'dink',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: new Date(capturedAtMs).toISOString(),
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    phases: Array.from({ length: 6 }, (_, p) => ({
      key: `phase_${p}`,
      startMs: p * 300,
      representativeMs: p * 300 + 100,
      endMs: p * 300 + 300,
      confidence: 0.9,
    })),
    measurements: Array.from({ length: 15 }, (_, m) => ({
      key: `measure_${m}`,
      value: m * 1.5,
      unit: 'deg',
      confidence: 0.7,
      notes: 'n'.repeat(60),
    })),
    checkpoints: CHECKPOINTS,
    overallScore: 5 + (i % 50) / 10,
    analysisConfidence: 0.9,
    resultKind: 'scored',
    guidance: { headline: 'g'.repeat(80), body: 'b'.repeat(400) },
    priorityFix: { checkpoint: 'checkpoint_3', detail: 'd'.repeat(200) },
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'test-native-1',
      poseModelVersion: 'test-pose-1',
      paddleModelVersion: 'test-paddle-1',
      strokeDetectorVersion: 'test-stroke-1',
      phaseModelVersion: 'test-phase-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  });
}

function dbWithHistory(n: number, nowMs: number) {
  // Oldest first in storage; 8 shots/day going back n/8 days.
  const rows = Array.from({ length: n }, (_, i) => ({
    payload: payload(i, nowMs - Math.floor(i / 8) * 86_400_000),
  }));
  const sqlSeen: string[] = [];
  const db: LocalDb = {
    async execute(sql: string) {
      sqlSeen.push(sql);
      const limit = /LIMIT \?/.test(sql) ? Number.NaN : rows.length;
      if (Number.isNaN(limit))
        throw new Error('unexpected LIMIT in unbounded call');
      return { rows: rows.map(r => ({ ...r })) };
    },
    close() {},
  };
  return { db, sqlSeen, bytes: rows.reduce((a, r) => a + r.payload.length, 0) };
}

describe('adjudicate: Progress loads unbounded local history', () => {
  beforeEach(() => setActiveDataOwner(GUEST_DATA_OWNER));
  afterAll(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('listRealAnalysisFacts(db, null) selects and parses every row for a 90-day view', async () => {
    const asOfIso = '2026-09-04T00:00:00.000Z';
    const nowMs = Date.parse(asOfIso);
    const report: string[] = [];
    for (const n of [500, 2000, 8000]) {
      const { db, sqlSeen, bytes } = dbWithHistory(n, nowMs);
      const t0 = Date.now();
      const facts = await listRealAnalysisFacts(db, null);
      const t1 = Date.now();
      const dashboard = buildTechniqueDashboard(facts, {
        asOfIso,
        timeZone: 'UTC',
        range: '90d',
      });
      const t2 = Date.now();
      expect(sqlSeen[0]).not.toMatch(/LIMIT/);
      expect(facts).toHaveLength(n);
      const inRange = facts.filter(
        f => nowMs - Date.parse(f.capturedAt) <= 90 * 86_400_000,
      ).length;
      report.push(
        `n=${n} payloadBytes=${bytes} listRealAnalysisFacts=${(t1 - t0).toFixed(1)}ms ` +
          `buildTechniqueDashboard=${(t2 - t1).toFixed(1)}ms factsUsedBy90d=${inRange} ` +
          `dashboardCells=${JSON.stringify(dashboard).length}`,
      );
      // Every row is parsed even though the 90d range uses at most 728 of them.
      expect(inRange).toBeLessThanOrEqual(Math.min(n, 91 * 8));
    }
    console.log(report.join('\n'));
  });
});
