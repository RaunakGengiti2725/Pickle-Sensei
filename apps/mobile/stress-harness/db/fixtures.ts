/**
 * Deterministic inputs for the db.ts concurrency stress suites: a legacy
 * (pre-account-scope) on-disk schema the migration must transform, seeded
 * populations for it, and a minimal real `ShotAnalysis` factory.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import { pick } from '../../xc-harness/lifecycle-persistence/seeds';
import {
  fs,
  path,
  nodeProcess,
  type SqliteDatabaseSync,
} from '../../xc-harness/lifecycle-persistence/nodeShim';

declare const __dirname: string;

/** Pre-account-scope schema (single-owner primary keys, ownerless outbox). */
export const LEGACY_V0_DDL = [
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS local_shot (
     id TEXT PRIMARY KEY,
     session_id TEXT,
     shot_type TEXT NOT NULL,
     captured_at TEXT NOT NULL,
     overall_score REAL,
     confidence REAL NOT NULL,
     result_kind TEXT NOT NULL,
     source TEXT NOT NULL,
     favorite INTEGER NOT NULL DEFAULT 0,
     payload TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_local_shot_time ON local_shot (captured_at DESC)`,
  `CREATE TABLE IF NOT EXISTS local_session (
     id TEXT PRIMARY KEY,
     mode TEXT NOT NULL,
     shot_type TEXT,
     focus_checkpoint TEXT,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     completed INTEGER NOT NULL DEFAULT 0,
     summary TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,
     payload TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_error TEXT
   )`,
];

export interface LegacyShot {
  id: string;
  source: 'real' | 'fixture';
  capturedAt: string;
  score: number | null;
}

export interface LegacyPopulation {
  shots: LegacyShot[];
  sessions: string[];
  /** Outbox payload strings by kind, in insertion order. */
  outbox: Array<{ kind: string; payload: string }>;
}

export const TORN_OUTBOX_PAYLOAD = '{"id":"torn","source":"re';

export function seededLegacyPopulation(
  rng: () => number,
  size: number,
): LegacyPopulation {
  const shots: LegacyShot[] = [];
  const sessions: string[] = [];
  const outbox: Array<{ kind: string; payload: string }> = [];
  for (let i = 0; i < size; i += 1) {
    const source = rng() < 0.25 ? 'fixture' : 'real';
    const id = uuidFrom(rng, i);
    const capturedAt = new Date(
      Date.UTC(2026, 0, 1) + Math.floor(rng() * 200) * 86_400_000,
    ).toISOString();
    shots.push({
      id,
      source,
      capturedAt,
      score: rng() < 0.2 ? null : Math.round(rng() * 100) / 10,
    });
    if (rng() < 0.5) {
      outbox.push({
        kind: 'shot.sync',
        payload: JSON.stringify({ id, source, analysisPermitId: 'p' }),
      });
    }
    if (rng() < 0.3) sessions.push(uuidFrom(rng, 1000 + i));
  }
  if (rng() < 0.5)
    outbox.push({ kind: 'shot.sync', payload: TORN_OUTBOX_PAYLOAD });
  if (rng() < 0.5) {
    outbox.push({
      kind: 'session.create',
      payload: JSON.stringify({
        id: pick(rng, sessions.length ? sessions : ['s']),
      }),
    });
  }
  return { shots, sessions, outbox };
}

export function seedLegacyFile(
  raw: SqliteDatabaseSync,
  population: LegacyPopulation,
): void {
  for (const ddl of LEGACY_V0_DDL) raw.exec(ddl);
  const insertShot = raw.prepare(
    `INSERT INTO local_shot (id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, favorite, payload)
     VALUES (?, NULL, 'forehand_drive', ?, ?, 0.9, ?, ?, 0, ?)`,
  );
  for (const shot of population.shots) {
    insertShot.run(
      shot.id,
      shot.capturedAt,
      shot.score,
      shot.score === null ? 'low_confidence' : 'scored',
      shot.source,
      JSON.stringify({ id: shot.id, source: shot.source }),
    );
  }
  const insertSession = raw.prepare(
    `INSERT INTO local_session (id, mode, shot_type, focus_checkpoint, started_at) VALUES (?, 'live', NULL, NULL, ?)`,
  );
  for (const id of population.sessions) {
    insertSession.run(id, '2026-01-01T00:00:00.000Z');
  }
  const insertOutbox = raw.prepare(
    `INSERT INTO outbox (kind, payload) VALUES (?, ?)`,
  );
  for (const entry of population.outbox) {
    insertOutbox.run(entry.kind, entry.payload);
  }
}

/** Real shots the migration must carry over, keyed the way it stores them. */
export function expectedMigratedShots(
  population: LegacyPopulation,
): Array<{ owner: string; id: string }> {
  return population.shots
    .filter(shot => shot.source === 'real')
    .map(shot => ({ owner: 'device-guest', id: shot.id }));
}

export function uuidFrom(rng: () => number, salt: number): string {
  const hex = () => Math.floor(rng() * 16).toString(16);
  const block = (n: number) => Array.from({ length: n }, hex).join('');
  const tail = (salt % 0xffff).toString(16).padStart(4, '0');
  return `${block(8)}-${block(4)}-4${block(3)}-8${block(3)}-${tail}${block(8)}`;
}

export function realAnalysis(
  overrides: Partial<ShotAnalysis> & { id: string },
): ShotAnalysis {
  return {
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-27T18:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 900, endMs: 1800 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.8,
    analysisConfidence: 0.91,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'validated-bundle-1',
      poseModelVersion: 'pose-1',
      paddleModelVersion: 'paddle-1',
      strokeDetectorVersion: 'stroke-1',
      phaseModelVersion: 'phase-1',
      scoringModelVersion: 'score-1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
    ...overrides,
  };
}

/**
 * Artifact root for the stress suites: `<repo>/artifacts/stress-mod-db/`
 * (gitignored). Override with STRESS_ARTIFACT_DIR.
 */
export function stressArtifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../../artifacts/stress-mod-db');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeStressJson(name: string, value: unknown): string {
  const file = path.join(stressArtifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

export function writeStressText(name: string, text: string): string {
  const file = path.join(stressArtifactDir(), name);
  fs.writeFileSync(file, text);
  return file;
}

/** Iteration budget: STRESS_ITER (default small so the suite stays fast). */
export function stressIterations(defaultCount: number): number {
  const raw = nodeProcess.env['STRESS_ITER'];
  if (!raw) return defaultCount;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`STRESS_ITER must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

/** Optional single-seed replay: STRESS_SEED=<n>. */
export function stressReplaySeed(): number | null {
  const raw = nodeProcess.env['STRESS_SEED'];
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`STRESS_SEED must be an integer, got "${raw}"`);
  }
  return parsed >>> 0;
}
