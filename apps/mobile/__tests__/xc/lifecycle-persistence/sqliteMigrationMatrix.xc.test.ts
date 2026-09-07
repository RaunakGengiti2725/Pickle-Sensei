/**
 * XC lifecycle/persistence matrix — harness B: REAL SQLite schema migration.
 *
 * Runs the production `getDb()` (src/data/db.ts: LOCAL_MIGRATIONS +
 * ensureAccountScopedSchema) against real SQLite files seeded with every
 * historical on-device schema this app ever shipped or built with:
 *
 *   fresh            no database file (first launch after install)
 *   v0-unscoped      c297902 — local_shot(id PK), local_session(id PK),
 *                    outbox without owner_key, no local_capture/sync_receipt
 *   v0b-owner-col    dev interim: v0 + owner_key column but still id PK
 *   v1a-no-payload   scoped tables, local_capture without payload,
 *                    outbox without owner_key
 *   v1-52ba173       scoped tables, capture payload, no ALTER columns
 *   v1b-b2731c9      v1 + declared_stroke + target_seed
 *   v2-current       v1 already migrated by one prior production launch
 *                    (an existing install on this build; warm path)
 *   kv-only          only the kv table exists
 *   garbage          the file is not a SQLite database
 *
 * crossed with row faults (malformed outbox payload, leftover temp table
 * from an interrupted migration, read-only file) and seeded row populations
 * (real/fixture shots, complete/incomplete sessions, outbox rows, captures,
 * corrupt kv bytes, corrupt shot payloads).
 *
 * Invariants:
 *   coldLaunchOpens      getDb() does not throw on the first launch
 *   realShotsPreserved   every seeded real shot survives byte-for-byte under
 *                        its owner (legacy rows → device-guest)
 *   fixtureShotsRemoved  non-real rows are gone (documented one-time purge)
 *   sessionsPreserved    sessions with shots / completed non-fixture survive
 *   outboxPreserved      real shot.sync + other kinds survive with an owner
 *   capturesPreserved    capture rows survive; new columns get defaults
 *   kvBytesPreserved     every kv value is byte-identical (raw + getKv)
 *   schemaCurrent        table_info matches the current schema exactly
 *   integrityOk          PRAGMA integrity_check = ok
 *   warmIdempotent       launch 2 (close → getDb) changes nothing
 *   cachedHandleReused   launch 3 (no close) does not reopen/re-migrate
 *   productReadsWork     listShots / listActivityShots / getKv see the rows
 *   tornOutboxRowKept    an outbox row whose payload is not valid JSON is not
 *                        a fixture read: the launch opens and the row is
 *                        left (owner-scoped) for the sync layer's row-level
 *                        failure handling instead of aborting every open
 *
 * node:sqlite is behind `--experimental-sqlite` on Node 22.12; when the flag
 * is missing this file re-executes itself under jest with the flag set, so a
 * plain `npx jest` still runs (never skips) the matrix.
 *
 * Replay one row: XC_SQLITE_ONLY='<scenario name>' npx jest … this file.
 */
import type { LocalDb } from '../../../src/data/db';
import {
  childProcess,
  fs,
  loadNodeSqlite,
  nodeProcess,
  os,
  path,
  resolveModule,
  type SqlInputValue,
  type SqliteDatabaseSync as DatabaseSync,
} from '../../../xc-harness/lifecycle-persistence/nodeShim';
import {
  CANONICAL_ID,
  OTHER_CANONICAL_ID,
  RAW_STRING_VARIANTS,
  RAW_VARIANT_NAMES,
  makePrng,
  pick,
} from '../../../xc-harness/lifecycle-persistence/seeds';
import {
  heapSnapshot,
  matrixMarkdown,
  summarize,
  writeJsonArtifact,
  writeTextArtifact,
  type MatrixRow,
} from '../../../xc-harness/lifecycle-persistence/artifacts';
import {
  getKv,
  listActivityShots,
  listShots,
  getAnalysis,
} from '../../../src/data/repository';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';

declare const __dirname: string;
declare const __filename: string;

const sqlite = loadNodeSqlite();

// ─── op-sqlite seam: the production module opens through this adapter ────────

const mockSqlite = {
  dir: '',
  opens: 0,
  statements: [] as string[],
  open(name: string) {
    if (!sqlite) throw new Error('node:sqlite unavailable');
    mockSqlite.opens += 1;
    const inner = new sqlite.DatabaseSync(path.join(mockSqlite.dir, name));
    const run = (sql: string, params: unknown[]) => {
      mockSqlite.statements.push(sql);
      const rows = inner
        .prepare(sql)
        .all(...(params as SqlInputValue[])) as Record<string, unknown>[];
      return { rows };
    };
    return {
      executeSync: (sql: string, params: unknown[] = []) => run(sql, params),
      execute: async (sql: string, params: unknown[] = []) => run(sql, params),
      close: () => inner.close(),
    };
  },
};

jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options.name),
}));

const DB_FILE = 'pickle-sensei.db';

function loadGetDb(): () => LocalDb {
  let getDb: (() => LocalDb) | null = null;
  jest.isolateModules(() => {
    getDb = jest.requireActual<typeof import('../../../src/data/db')>(
      '../../../src/data/db',
    ).getDb;
  });
  if (!getDb) throw new Error('db module did not load');
  return getDb;
}

// ─── Historical schemas (DDL copied verbatim from the named commits) ──────────

const V0_DDL = [
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

const SCOPED_CORE_DDL = [
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS local_shot (
     owner_key TEXT NOT NULL,
     id TEXT NOT NULL,
     session_id TEXT,
     shot_type TEXT NOT NULL,
     captured_at TEXT NOT NULL,
     overall_score REAL,
     confidence REAL NOT NULL,
     result_kind TEXT NOT NULL,
     source TEXT NOT NULL,
     favorite INTEGER NOT NULL DEFAULT 0,
     payload TEXT NOT NULL,
     PRIMARY KEY (owner_key, id)
   )`,
  `CREATE TABLE IF NOT EXISTS local_session (
     owner_key TEXT NOT NULL,
     id TEXT NOT NULL,
     mode TEXT NOT NULL,
     shot_type TEXT,
     focus_checkpoint TEXT,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     completed INTEGER NOT NULL DEFAULT 0,
     summary TEXT,
     PRIMARY KEY (owner_key, id)
   )`,
];

const CAPTURE_WITH_PAYLOAD_DDL = `CREATE TABLE IF NOT EXISTS local_capture (
     owner_key TEXT NOT NULL,
     id TEXT NOT NULL,
     uri TEXT NOT NULL,
     shot_type TEXT NOT NULL,
     captured_at TEXT NOT NULL,
     duration_ms INTEGER NOT NULL,
     fps REAL NOT NULL,
     width INTEGER NOT NULL,
     height INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('awaiting_model','analyzed')),
     payload TEXT,
     PRIMARY KEY (owner_key, id),
     UNIQUE (owner_key, uri)
   )`;

const CAPTURE_WITHOUT_PAYLOAD_DDL = `CREATE TABLE IF NOT EXISTS local_capture (
     owner_key TEXT NOT NULL,
     id TEXT NOT NULL,
     uri TEXT NOT NULL,
     shot_type TEXT NOT NULL,
     captured_at TEXT NOT NULL,
     duration_ms INTEGER NOT NULL,
     fps REAL NOT NULL,
     width INTEGER NOT NULL,
     height INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('awaiting_model','analyzed')),
     PRIMARY KEY (owner_key, id),
     UNIQUE (owner_key, uri)
   )`;

const OUTBOX_SCOPED_DDL = `CREATE TABLE IF NOT EXISTS outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     owner_key TEXT NOT NULL,
     kind TEXT NOT NULL,
     payload TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_error TEXT
   )`;

const OUTBOX_UNSCOPED_DDL = V0_DDL[4] as string;

const SYNC_RECEIPT_DDL = `CREATE TABLE IF NOT EXISTS sync_receipt (
     owner_key TEXT NOT NULL,
     kind TEXT NOT NULL,
     entity_id TEXT NOT NULL,
     accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (owner_key, kind, entity_id)
   )`;

const ANALYSIS_RECORD_DDL = [
  `CREATE TABLE IF NOT EXISTS local_analysis_record (
     owner_key TEXT NOT NULL,
     id TEXT NOT NULL,
     capture_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     engine_version TEXT NOT NULL,
     scoring_model_version TEXT NOT NULL,
     record TEXT NOT NULL,
     PRIMARY KEY (owner_key, id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_local_analysis_capture
     ON local_analysis_record (owner_key, capture_id, created_at DESC)`,
];

const SCHEMAS = [
  'fresh',
  'v0-unscoped',
  'v0b-owner-col',
  'v1a-no-payload',
  'v1-52ba173',
  'v1b-b2731c9',
  'v2-current',
  'kv-only',
  'garbage',
] as const;
type SchemaName = (typeof SCHEMAS)[number];

const FAULTS = [
  'none',
  'leftover-temp-table',
  'malformed-outbox-payload',
  'readonly-file',
] as const;
type FaultName = (typeof FAULTS)[number];

interface SchemaShape {
  hasTables: boolean;
  scoped: boolean;
  ownerColumnOnShots: boolean;
  capture: 'none' | 'no-payload' | 'payload' | 'payload+stroke+seed';
  outboxOwner: boolean;
  syncReceipt: boolean;
  analysisRecord: boolean;
}

function shapeOf(schema: SchemaName): SchemaShape {
  switch (schema) {
    case 'fresh':
    case 'garbage':
    case 'kv-only':
      return {
        hasTables: false,
        scoped: false,
        ownerColumnOnShots: false,
        capture: 'none',
        outboxOwner: false,
        syncReceipt: false,
        analysisRecord: false,
      };
    case 'v0-unscoped':
      return {
        hasTables: true,
        scoped: false,
        ownerColumnOnShots: false,
        capture: 'none',
        outboxOwner: false,
        syncReceipt: false,
        analysisRecord: false,
      };
    case 'v0b-owner-col':
      return {
        hasTables: true,
        scoped: false,
        ownerColumnOnShots: true,
        capture: 'none',
        outboxOwner: false,
        syncReceipt: false,
        analysisRecord: false,
      };
    case 'v1a-no-payload':
      return {
        hasTables: true,
        scoped: true,
        ownerColumnOnShots: true,
        capture: 'no-payload',
        outboxOwner: false,
        syncReceipt: false,
        analysisRecord: false,
      };
    case 'v1-52ba173':
      return {
        hasTables: true,
        scoped: true,
        ownerColumnOnShots: true,
        capture: 'payload',
        outboxOwner: true,
        syncReceipt: true,
        analysisRecord: true,
      };
    case 'v1b-b2731c9':
    case 'v2-current':
      return {
        hasTables: true,
        scoped: true,
        ownerColumnOnShots: true,
        capture: 'payload+stroke+seed',
        outboxOwner: true,
        syncReceipt: true,
        analysisRecord: true,
      };
  }
}

function createSchema(db: DatabaseSync, schema: SchemaName): void {
  const shape = shapeOf(schema);
  if (schema === 'kv-only') {
    db.exec(V0_DDL[0] as string);
    return;
  }
  if (!shape.hasTables) return;
  if (!shape.scoped) {
    for (const sql of V0_DDL) db.exec(sql);
    if (shape.ownerColumnOnShots) {
      db.exec(
        `ALTER TABLE local_shot ADD COLUMN owner_key TEXT NOT NULL DEFAULT '${GUEST_DATA_OWNER}'`,
      );
    }
    return;
  }
  for (const sql of SCOPED_CORE_DDL) db.exec(sql);
  db.exec(
    shape.capture === 'no-payload'
      ? CAPTURE_WITHOUT_PAYLOAD_DDL
      : CAPTURE_WITH_PAYLOAD_DDL,
  );
  if (shape.capture === 'payload+stroke+seed') {
    db.exec('ALTER TABLE local_capture ADD COLUMN declared_stroke TEXT');
    db.exec('ALTER TABLE local_capture ADD COLUMN target_seed TEXT');
  }
  db.exec(shape.outboxOwner ? OUTBOX_SCOPED_DDL : OUTBOX_UNSCOPED_DDL);
  if (shape.syncReceipt) db.exec(SYNC_RECEIPT_DDL);
  if (shape.analysisRecord) for (const sql of ANALYSIS_RECORD_DDL) db.exec(sql);
}

// ─── Seeded population ───────────────────────────────────────────────────────

interface SeedShot {
  owner: string;
  id: string;
  sessionId: string | null;
  source: 'real' | 'fixture' | 'demo';
  capturedAt: string;
  overallScore: number | null;
  confidence: number;
  resultKind: 'scored' | 'low_confidence';
  favorite: 0 | 1;
  payload: string;
}

interface SeedSession {
  owner: string;
  id: string;
  completed: 0 | 1;
  summary: string | null;
  startedAt: string;
}

interface SeedOutbox {
  owner: string;
  kind: string;
  payload: string;
}

interface SeedCapture {
  owner: string;
  id: string;
  uri: string;
  status: 'awaiting_model' | 'analyzed';
  payload: string | null;
}

interface Population {
  shots: SeedShot[];
  sessions: SeedSession[];
  outbox: SeedOutbox[];
  captures: SeedCapture[];
  kv: Record<string, string>;
}

const OWNERS = [GUEST_DATA_OWNER, CANONICAL_ID, OTHER_CANONICAL_ID] as const;

const KV_KEYS = [
  'auth.local-mode',
  'auth.last-provider',
  'auth.session',
  `profile:${GUEST_DATA_OWNER}`,
  `profile:${CANONICAL_ID}`,
  'onboarding.pending-profile',
  `notifications:${CANONICAL_ID}`,
  `consistency:${GUEST_DATA_OWNER}`,
  `rank.celebrated:${CANONICAL_ID}`,
  'review.prompt-state',
  `practice.set:${CANONICAL_ID}`,
  'walkthrough.device-complete',
  'consent.training',
] as const;

/** Raw kv variants except the 1 MB one (kept to a deterministic subset of
 * seeds so the matrix stays fast and the artifact stays readable) and the
 * embedded-NUL one (how a driver round-trips NUL inside TEXT is a driver
 * property; op-sqlite's cannot be observed from Linux). */
const KV_RAW_NAMES = RAW_VARIANT_NAMES.filter(
  name => name !== 'absent' && name !== 'huge-1mb' && name !== 'nul-bytes',
);

function isoAt(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
}

function population(seed: number, shape: SchemaShape): Population {
  const rng = makePrng(seed ^ 0x5eed);
  const owners: readonly string[] = shape.ownerColumnOnShots
    ? OWNERS
    : [GUEST_DATA_OWNER];
  const realCount = Math.floor(rng() * 41);
  const fixtureCount = Math.floor(rng() * 6);
  const sessionCount = Math.floor(rng() * 8);
  const sessions: SeedSession[] = [];
  for (let i = 0; i < sessionCount; i += 1) {
    const kind = pick(rng, [
      'complete-with-shots',
      'incomplete-with-shots',
      'incomplete-no-shots',
      'complete-no-shots',
      'complete-fixture-no-shots',
    ] as const);
    sessions.push({
      owner: pick(rng, owners),
      id: `sess-${seed}-${i}-${kind}`,
      completed: kind.startsWith('complete') ? 1 : 0,
      summary:
        kind === 'complete-fixture-no-shots'
          ? 'fixture summary'
          : kind.startsWith('complete')
            ? `summary ${i}`
            : null,
      startedAt: isoAt(i),
    });
  }
  const shotSessions = sessions.filter(s => s.id.includes('-with-shots'));
  const shots: SeedShot[] = [];
  const makeShot = (i: number, source: SeedShot['source']): SeedShot => {
    const owner = pick(rng, owners);
    const attached =
      shotSessions.length > 0 && rng() < 0.6 ? pick(rng, shotSessions) : null;
    const corruptPayload = rng() < 0.15;
    const scored = rng() < 0.8;
    const id = `shot-${seed}-${source}-${i}`;
    return {
      owner: attached ? attached.owner : owner,
      id,
      sessionId: attached ? attached.id : null,
      source,
      capturedAt: isoAt(1000 + i),
      overallScore: scored ? Math.round(rng() * 1000) / 10 : null,
      confidence: Math.round(rng() * 1000) / 1000,
      resultKind: scored ? 'scored' : 'low_confidence',
      favorite: rng() < 0.2 ? 1 : 0,
      payload: corruptPayload
        ? (RAW_STRING_VARIANTS[pick(rng, KV_RAW_NAMES)] as string)
        : JSON.stringify({ id, source, shotType: 'forehand_drive', i }),
    };
  };
  for (let i = 0; i < realCount; i += 1) shots.push(makeShot(i, 'real'));
  for (let i = 0; i < fixtureCount; i += 1) {
    shots.push(makeShot(i, pick(rng, ['fixture', 'demo'] as const)));
  }
  const outbox: SeedOutbox[] = [];
  const outboxCount = Math.floor(rng() * 8);
  for (let i = 0; i < outboxCount; i += 1) {
    const kind = pick(rng, [
      'shot.sync-real',
      'shot.sync-fixture',
      'shot.sync-nosource',
      'capture.upload',
      'session.finish',
    ] as const);
    outbox.push({
      owner: pick(rng, owners),
      kind: kind.startsWith('shot.sync') ? 'shot.sync' : kind,
      payload:
        kind === 'shot.sync-real'
          ? JSON.stringify({ id: `ob-${seed}-${i}`, source: 'real' })
          : kind === 'shot.sync-fixture'
            ? JSON.stringify({ id: `ob-${seed}-${i}`, source: 'fixture' })
            : kind === 'shot.sync-nosource'
              ? JSON.stringify({ id: `ob-${seed}-${i}` })
              : JSON.stringify({ kind, i }),
    });
  }
  const captures: SeedCapture[] = [];
  if (shape.capture !== 'none') {
    const captureCount = Math.floor(rng() * 6);
    for (let i = 0; i < captureCount; i += 1) {
      captures.push({
        owner: pick(rng, owners),
        id: `cap-${seed}-${i}`,
        uri: `file:///captures/${seed}/${i}.mov`,
        status: rng() < 0.5 ? 'awaiting_model' : 'analyzed',
        payload:
          shape.capture === 'no-payload'
            ? null
            : rng() < 0.3
              ? null
              : JSON.stringify({ clip: i }),
      });
    }
  }
  const kv: Record<string, string> = {};
  for (const key of KV_KEYS) {
    const roll = rng();
    if (roll < 0.3) continue;
    const name = roll > 0.97 ? ('huge-1mb' as const) : pick(rng, KV_RAW_NAMES);
    kv[key] = RAW_STRING_VARIANTS[name] as string;
  }
  return { shots, sessions, outbox, captures, kv };
}

function seedRows(db: DatabaseSync, shape: SchemaShape, pop: Population): void {
  if (!shape.hasTables) {
    if (dbHasTable(db, 'kv')) {
      for (const [key, value] of Object.entries(pop.kv)) {
        db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(key, value);
      }
    }
    return;
  }
  for (const [key, value] of Object.entries(pop.kv)) {
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(key, value);
  }
  for (const shot of pop.shots) {
    if (shape.ownerColumnOnShots) {
      db.prepare(
        `INSERT INTO local_shot (owner_key,id,session_id,shot_type,captured_at,overall_score,confidence,result_kind,source,favorite,payload)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        shot.owner,
        shot.id,
        shot.sessionId,
        'forehand_drive',
        shot.capturedAt,
        shot.overallScore,
        shot.confidence,
        shot.resultKind,
        shot.source,
        shot.favorite,
        shot.payload,
      );
    } else {
      db.prepare(
        `INSERT INTO local_shot (id,session_id,shot_type,captured_at,overall_score,confidence,result_kind,source,favorite,payload)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        shot.id,
        shot.sessionId,
        'forehand_drive',
        shot.capturedAt,
        shot.overallScore,
        shot.confidence,
        shot.resultKind,
        shot.source,
        shot.favorite,
        shot.payload,
      );
    }
  }
  for (const session of pop.sessions) {
    if (shape.scoped) {
      db.prepare(
        `INSERT INTO local_session (owner_key,id,mode,shot_type,focus_checkpoint,started_at,ended_at,completed,summary)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        session.owner,
        session.id,
        'practice_set',
        'forehand_drive',
        null,
        session.startedAt,
        session.completed ? isoAt(5000) : null,
        session.completed,
        session.summary,
      );
    } else {
      db.prepare(
        `INSERT INTO local_session (id,mode,shot_type,focus_checkpoint,started_at,ended_at,completed,summary)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        session.id,
        'practice_set',
        'forehand_drive',
        null,
        session.startedAt,
        session.completed ? isoAt(5000) : null,
        session.completed,
        session.summary,
      );
    }
  }
  for (const entry of pop.outbox) {
    if (shape.outboxOwner) {
      db.prepare(
        'INSERT INTO outbox (owner_key, kind, payload) VALUES (?,?,?)',
      ).run(entry.owner, entry.kind, entry.payload);
    } else {
      db.prepare('INSERT INTO outbox (kind, payload) VALUES (?,?)').run(
        entry.kind,
        entry.payload,
      );
    }
  }
  for (const capture of pop.captures) {
    if (shape.capture === 'no-payload') {
      db.prepare(
        `INSERT INTO local_capture (owner_key,id,uri,shot_type,captured_at,duration_ms,fps,width,height,status)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        capture.owner,
        capture.id,
        capture.uri,
        'forehand_drive',
        isoAt(7000),
        3000,
        60,
        1080,
        1920,
        capture.status,
      );
    } else {
      db.prepare(
        `INSERT INTO local_capture (owner_key,id,uri,shot_type,captured_at,duration_ms,fps,width,height,status,payload)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        capture.owner,
        capture.id,
        capture.uri,
        'forehand_drive',
        isoAt(7000),
        3000,
        60,
        1080,
        1920,
        capture.status,
        capture.payload,
      );
    }
  }
}

function dbHasTable(db: DatabaseSync, table: string): boolean {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .all(table).length > 0
  );
}

function applyFault(db: DatabaseSync, shape: SchemaShape, fault: FaultName) {
  if (fault === 'leftover-temp-table' && shape.hasTables) {
    db.exec(`CREATE TABLE local_shot_account_v2 (
      owner_key TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT,
      shot_type TEXT NOT NULL, captured_at TEXT NOT NULL, overall_score REAL,
      confidence REAL NOT NULL, result_kind TEXT NOT NULL, source TEXT NOT NULL,
      favorite INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL,
      PRIMARY KEY (owner_key, id))`);
    db.prepare(
      `INSERT INTO local_shot_account_v2 (owner_key,id,session_id,shot_type,captured_at,overall_score,confidence,result_kind,source,favorite,payload)
       VALUES ('stale-owner','stale-shot',NULL,'forehand_drive','2025-01-01T00:00:00.000Z',1,1,'scored','real',0,'{}')`,
    ).run();
  }
  if (fault === 'malformed-outbox-payload' && shape.hasTables) {
    if (shape.outboxOwner) {
      db.prepare(
        `INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)`,
      ).run(GUEST_DATA_OWNER, TORN_OUTBOX_PAYLOAD);
    } else {
      db.prepare(
        `INSERT INTO outbox (kind, payload) VALUES ('shot.sync', ?)`,
      ).run(TORN_OUTBOX_PAYLOAD);
    }
  }
}

// ─── Snapshots ───────────────────────────────────────────────────────────────

interface TableSnapshot {
  rows: Record<string, unknown>[];
}

function snapshotAll(db: LocalDb): Promise<Record<string, TableSnapshot>> {
  return (async () => {
    const out: Record<string, TableSnapshot> = {};
    const { rows: master } = await db.execute(
      `SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`,
    );
    out['sqlite_master'] = {
      rows: master.map(row => ({
        ...row,
        sql:
          typeof row['sql'] === 'string'
            ? row['sql'].replace(/\s+/g, ' ').trim()
            : row['sql'],
      })),
    };
    for (const row of master) {
      if (row['type'] !== 'table') continue;
      const table = String(row['name']);
      if (table.startsWith('sqlite_')) continue;
      const { rows } = await db.execute(`SELECT * FROM ${table}`);
      out[table] = {
        rows: rows
          .map(r => {
            const entries = Object.entries(r).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            );
            return Object.fromEntries(entries);
          })
          .sort((a, b) => {
            const ka = JSON.stringify(a);
            const kb = JSON.stringify(b);
            return ka < kb ? -1 : ka > kb ? 1 : 0;
          }),
      };
    }
    return out;
  })();
}

async function tableInfo(
  db: LocalDb,
  table: string,
): Promise<{ name: string; pk: number; notnull: number; dflt: unknown }[]> {
  const { rows } = await db.execute(`PRAGMA table_info(${table})`);
  return rows.map(row => ({
    name: String(row['name']),
    pk: Number(row['pk']),
    notnull: Number(row['notnull']),
    dflt: row['dflt_value'],
  }));
}

function pkOf(info: { name: string; pk: number }[]): string[] {
  return info
    .filter(c => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map(c => c.name);
}

const EXPECTED_SHOT_COLUMNS = [
  'owner_key',
  'id',
  'session_id',
  'shot_type',
  'captured_at',
  'overall_score',
  'confidence',
  'result_kind',
  'source',
  'favorite',
  'payload',
];
const EXPECTED_CAPTURE_COLUMNS = [
  'owner_key',
  'id',
  'uri',
  'shot_type',
  'captured_at',
  'duration_ms',
  'fps',
  'width',
  'height',
  'status',
  'payload',
  'declared_stroke',
  'target_seed',
  'training_consent',
];

// ─── Known deviations ────────────────────────────────────────────────────────

/**
 * Contract deviations reproduced and triaged but not yet fixed. Every row
 * failing through one of these is recorded as a known deviation instead of
 * a failure, and the suite asserts each is still reproduced. Currently
 * empty: every invariant above is asserted strictly.
 */
const KNOWN_DEVIATIONS: Record<string, string> = {};

const TORN_OUTBOX_PAYLOAD = '{"id":"torn-write","source":"re';

// ─── Scenario ────────────────────────────────────────────────────────────────

interface MigrationScenario {
  name: string;
  seed: number;
  schema: SchemaName;
  fault: FaultName;
}

function scenarioDir(name: string): string {
  const dir = path.join(
    os.tmpdir(),
    'xc-sqlite-migration',
    name.replace(/[^a-zA-Z0-9._-]/g, '_'),
  );
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

const IS_ROOT =
  typeof nodeProcess.getuid === 'function' && nodeProcess.getuid() === 0;

async function runScenario(scenario: MigrationScenario): Promise<MatrixRow> {
  if (!sqlite) throw new Error('node:sqlite unavailable');
  const started = Date.now();
  const shape = shapeOf(scenario.schema);
  const dir = scenarioDir(scenario.name);
  const file = path.join(dir, DB_FILE);
  const pop = population(scenario.seed, shape);
  const knownDeviations: string[] = [];
  const invariants: Record<string, boolean> = {};
  const observed: Record<string, unknown> = {};

  // ── seed the on-device file exactly as the older build left it ──────────
  if (scenario.schema === 'garbage') {
    const rng = makePrng(scenario.seed);
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i += 1)
      bytes[i] = Math.floor(rng() * 256);
    fs.writeFileSync(file, bytes);
  } else if (scenario.schema !== 'fresh') {
    const seedDb = new sqlite.DatabaseSync(file);
    createSchema(seedDb, scenario.schema);
    seedRows(seedDb, shape, pop);
    seedDb.close();
    if (scenario.schema === 'v2-current') {
      // One prior launch on the current build migrates the v1b file.
      mockSqlite.dir = dir;
      const priorGetDb = loadGetDb();
      priorGetDb().close();
    }
    const faultDb = new sqlite.DatabaseSync(file);
    applyFault(faultDb, shape, scenario.fault);
    faultDb.close();
  } else if (scenario.fault === 'malformed-outbox-payload') {
    // A fresh install has no outbox yet: the fault cannot exist.
  }
  const readonlyApplied =
    scenario.fault === 'readonly-file' && fs.existsSync(file) && !IS_ROOT;
  if (readonlyApplied) {
    fs.chmodSync(file, 0o444);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (fs.existsSync(file + suffix)) fs.chmodSync(file + suffix, 0o444);
    }
  }
  const faultEffective =
    (scenario.fault === 'malformed-outbox-payload' && shape.hasTables) ||
    (scenario.fault === 'leftover-temp-table' && shape.hasTables) ||
    readonlyApplied;

  // ── expected survivors ──────────────────────────────────────────────────
  const shotOwner = (shot: SeedShot) =>
    shape.ownerColumnOnShots ? shot.owner : GUEST_DATA_OWNER;
  const rowOwner = (owner: string, scopedByShape: boolean) =>
    scopedByShape ? owner : GUEST_DATA_OWNER;
  const expectedShots = shape.hasTables
    ? pop.shots
        .filter(s => s.source === 'real')
        .map(s => ({ ...s, owner: shotOwner(s) }))
    : [];
  const survivingSessionIds = new Set(
    expectedShots.map(s => s.sessionId).filter((id): id is string => !!id),
  );
  const expectedSessions = shape.hasTables
    ? pop.sessions
        .filter(
          s =>
            survivingSessionIds.has(s.id) ||
            (s.completed === 1 && !(s.summary ?? '').includes('fixture')),
        )
        .map(s => ({ ...s, owner: rowOwner(s.owner, shape.scoped) }))
    : [];
  const expectedOutbox = shape.hasTables
    ? pop.outbox
        .filter(
          o =>
            !(
              o.kind === 'shot.sync' &&
              (JSON.parse(o.payload) as { source?: string }).source !==
                undefined &&
              (JSON.parse(o.payload) as { source?: string }).source !== 'real'
            ),
        )
        .map(o => ({ ...o, owner: rowOwner(o.owner, shape.outboxOwner) }))
    : [];

  // ── launch 1: cold ──────────────────────────────────────────────────────
  mockSqlite.dir = dir;
  mockSqlite.opens = 0;
  mockSqlite.statements = [];
  const getDb = loadGetDb();
  let handle: LocalDb | null = null;
  let coldError: string | null = null;
  try {
    handle = getDb();
  } catch (error) {
    coldError = errorText(error);
  }
  observed['coldError'] = coldError;
  observed['coldOpens'] = mockSqlite.opens;
  observed['coldStatements'] = mockSqlite.statements.length;
  invariants['coldLaunchOpens'] = handle !== null;

  const expectThrow = scenario.schema === 'garbage' || readonlyApplied;
  if (!invariants['coldLaunchOpens']) {
    if (scenario.schema === 'garbage' || readonlyApplied) {
      // Not a database / not writable: nothing the app could have done. The
      // contract we check is that it fails the same way every time and the
      // fix-27 retry path does not cache the dead handle.
      observed['expectedUnopenable'] = true;
      invariants['coldLaunchOpens'] = true;
    }
    let retryError: string | null = null;
    try {
      getDb().close();
    } catch (error) {
      retryError = errorText(error);
    }
    observed['retryError'] = retryError;
    invariants['retryFailsIdentically'] = retryError === coldError;
    invariants['deadHandleNotCached'] = mockSqlite.opens === 2;
  } else if (expectThrow) {
    // The fault was expected to bite and did not: record, do not fail — the
    // matrix must report what the engine does, not what we guessed.
    observed['expectedThrowButOpened'] = true;
  }

  const checkData = async (db: LocalDb, label: string): Promise<boolean> => {
    const snap = await snapshotAll(db);
    observed[`${label}Snapshot`] = compactSnapshot(snap);
    const shotsAfter = (snap['local_shot']?.rows ?? []).map(r => ({
      owner: String(r['owner_key']),
      id: String(r['id']),
      sessionId: r['session_id'] === null ? null : String(r['session_id']),
      source: String(r['source']),
      capturedAt: String(r['captured_at']),
      overallScore:
        r['overall_score'] === null ? null : Number(r['overall_score']),
      confidence: Number(r['confidence']),
      resultKind: String(r['result_kind']),
      favorite: Number(r['favorite']),
      payload: String(r['payload']),
    }));
    const key = (s: {
      owner: string;
      id: string;
      sessionId: string | null;
      source: string;
      capturedAt: string;
      overallScore: number | null;
      confidence: number;
      resultKind: string;
      favorite: number;
      payload: string;
    }) =>
      JSON.stringify([
        s.owner,
        s.id,
        s.sessionId,
        s.source,
        s.capturedAt,
        s.overallScore,
        s.confidence,
        s.resultKind,
        s.favorite,
        s.payload,
      ]);
    const expectedKeys = expectedShots
      .map(s => key({ ...s, favorite: s.favorite }))
      .sort();
    const actualKeys = shotsAfter.map(key).sort();
    const realOk = JSON.stringify(expectedKeys) === JSON.stringify(actualKeys);
    invariants[`${label}RealShotsPreserved`] = realOk;
    if (!realOk) {
      observed[`${label}ShotDiff`] = {
        missing: expectedKeys.filter(k => !actualKeys.includes(k)).slice(0, 5),
        unexpected: actualKeys
          .filter(k => !expectedKeys.includes(k))
          .slice(0, 5),
      };
    }
    invariants[`${label}FixtureShotsRemoved`] = shotsAfter.every(
      s => s.source === 'real',
    );

    const sessionsAfter = (snap['local_session']?.rows ?? [])
      .map(r =>
        JSON.stringify([
          String(r['owner_key']),
          String(r['id']),
          Number(r['completed']),
          r['summary'],
        ]),
      )
      .sort();
    const sessionsExpected = expectedSessions
      .map(s => JSON.stringify([s.owner, s.id, s.completed, s.summary]))
      .sort();
    invariants[`${label}SessionsPreserved`] =
      JSON.stringify(sessionsAfter) === JSON.stringify(sessionsExpected);

    const outboxRows = snap['outbox']?.rows ?? [];
    const tornRows = outboxRows.filter(
      r => String(r['payload']) === TORN_OUTBOX_PAYLOAD,
    );
    invariants[`${label}TornOutboxRowKept`] =
      scenario.fault === 'malformed-outbox-payload' && shape.hasTables
        ? tornRows.length === 1 &&
          String(tornRows[0]?.['kind']) === 'shot.sync' &&
          String(tornRows[0]?.['owner_key']) === GUEST_DATA_OWNER
        : tornRows.length === 0;
    const outboxAfter = outboxRows
      .filter(r => String(r['payload']) !== TORN_OUTBOX_PAYLOAD)
      .map(r =>
        JSON.stringify([
          String(r['owner_key']),
          String(r['kind']),
          String(r['payload']),
        ]),
      )
      .sort();
    const outboxExpected = expectedOutbox
      .map(o => JSON.stringify([o.owner, o.kind, o.payload]))
      .sort();
    invariants[`${label}OutboxPreserved`] =
      JSON.stringify(outboxAfter) === JSON.stringify(outboxExpected);

    const capturesAfter = (snap['local_capture']?.rows ?? [])
      .map(r =>
        JSON.stringify([
          String(r['owner_key']),
          String(r['id']),
          String(r['uri']),
          String(r['status']),
          r['payload'] === null ? null : String(r['payload']),
          r['training_consent'],
        ]),
      )
      .sort();
    const capturesExpected = pop.captures
      .filter(() => shape.capture !== 'none')
      .map(c =>
        JSON.stringify([
          c.owner,
          c.id,
          c.uri,
          c.status,
          c.payload,
          'not_asked',
        ]),
      )
      .sort();
    invariants[`${label}CapturesPreserved`] =
      JSON.stringify(capturesAfter) === JSON.stringify(capturesExpected);

    const kvRows = snap['kv']?.rows ?? [];
    const kvAfter = new Map(
      kvRows.map(r => [String(r['key']), String(r['value'])]),
    );
    const seededKv =
      scenario.schema === 'garbage' || scenario.schema === 'fresh'
        ? {}
        : pop.kv;
    let kvOk = kvAfter.size === Object.keys(seededKv).length;
    for (const [k, v] of Object.entries(seededKv)) {
      if (kvAfter.get(k) !== v) kvOk = false;
      // getKv() reads '' as absent (`rows[0]?.value ? … : null`) by design.
      if ((await getKv(db, k)) !== (v === '' ? null : v)) kvOk = false;
    }
    invariants[`${label}KvBytesPreserved`] = kvOk;

    const shotInfo = await tableInfo(db, 'local_shot');
    const sessionInfo = await tableInfo(db, 'local_session');
    const captureInfo = await tableInfo(db, 'local_capture');
    const outboxInfo = await tableInfo(db, 'outbox');
    const tables = new Set(
      (snap['sqlite_master']?.rows ?? [])
        .filter(r => r['type'] === 'table')
        .map(r => String(r['name'])),
    );
    const indexes = new Set(
      (snap['sqlite_master']?.rows ?? [])
        .filter(r => r['type'] === 'index')
        .map(r => String(r['name'])),
    );
    const consent = captureInfo.find(c => c.name === 'training_consent');
    invariants[`${label}SchemaCurrent`] =
      JSON.stringify(pkOf(shotInfo)) === JSON.stringify(['owner_key', 'id']) &&
      JSON.stringify(shotInfo.map(c => c.name)) ===
        JSON.stringify(EXPECTED_SHOT_COLUMNS) &&
      JSON.stringify(pkOf(sessionInfo)) ===
        JSON.stringify(['owner_key', 'id']) &&
      JSON.stringify(pkOf(captureInfo)) ===
        JSON.stringify(['owner_key', 'id']) &&
      JSON.stringify(captureInfo.map(c => c.name)) ===
        JSON.stringify(EXPECTED_CAPTURE_COLUMNS) &&
      consent !== undefined &&
      consent.notnull === 1 &&
      String(consent.dflt) === "'not_asked'" &&
      outboxInfo.some(c => c.name === 'owner_key') &&
      [
        'kv',
        'local_shot',
        'local_session',
        'local_capture',
        'outbox',
        'sync_receipt',
        'local_analysis_record',
      ].every(t => tables.has(t)) &&
      [
        'idx_local_shot_owner_time',
        'idx_local_capture_owner_time',
        'idx_outbox_owner_created',
        'idx_local_analysis_capture',
      ].every(i => indexes.has(i));
    observed[`${label}OrphanTables`] = [...tables].filter(t =>
      t.endsWith('_account_v2'),
    );

    const { rows: integrity } = await db.execute('PRAGMA integrity_check');
    invariants[`${label}IntegrityOk`] =
      integrity.length === 1 && integrity[0]?.['integrity_check'] === 'ok';
    return realOk;
  };

  if (handle) {
    await checkData(handle, 'cold');
    // Product reads through the real repository on the migrated handle.
    const readErrors: string[] = [];
    let readsOk = true;
    for (const owner of OWNERS) {
      setActiveDataOwner(owner);
      try {
        const listed = await listShots(handle, 1000);
        const activity = await listActivityShots(handle);
        const expectedForOwner = expectedShots.filter(s => s.owner === owner);
        if (listed.length !== expectedForOwner.length) readsOk = false;
        if (activity.length !== expectedForOwner.length) readsOk = false;
        const sortedAsc = [...activity].every(
          (row, i, arr) =>
            i === 0 || (arr[i - 1]?.capturedAt ?? '') <= row.capturedAt,
        );
        if (!sortedAsc) readsOk = false;
      } catch (error) {
        readsOk = false;
        readErrors.push(`${owner}: ${errorText(error)}`);
      }
    }
    // getAnalysis on corrupt payloads: strokeResultData.ts wraps it in
    // .catch(() => null), so a throw is contained; recorded, not asserted.
    let analysisThrows = 0;
    for (const shot of expectedShots) {
      setActiveDataOwner(shot.owner);
      try {
        await getAnalysis(handle, shot.id);
      } catch {
        analysisThrows += 1;
      }
    }
    setActiveDataOwner(GUEST_DATA_OWNER);
    observed['getAnalysisThrowsOnCorruptPayload'] = analysisThrows;
    observed['corruptPayloadShots'] = expectedShots.filter(s => {
      try {
        JSON.parse(s.payload);
        return false;
      } catch {
        return true;
      }
    }).length;
    observed['readErrors'] = readErrors;
    invariants['productReadsWork'] = readsOk;

    // ── launch 2: warm (close, reopen) ───────────────────────────────────
    const coldSnapshot = JSON.stringify(await snapshotAll(handle));
    handle.close();
    mockSqlite.statements = [];
    const opensBefore = mockSqlite.opens;
    let warm: LocalDb | null = null;
    try {
      warm = getDb();
    } catch (error) {
      observed['warmError'] = errorText(error);
    }
    invariants['warmLaunchOpens'] = warm !== null;
    if (warm) {
      const warmSnapshot = JSON.stringify(await snapshotAll(warm));
      const mutating = mockSqlite.statements.filter(sql =>
        /^\s*(DROP|ALTER|INSERT)\b/i.test(sql),
      );
      invariants['warmIdempotent'] =
        warmSnapshot === coldSnapshot && mutating.length === 0;
      observed['warmMutatingStatements'] = mutating;
      observed['warmOpens'] = mockSqlite.opens - opensBefore;
      // ── launch 3: same process, handle cached ──────────────────────────
      const opensBeforeThird = mockSqlite.opens;
      const statementsBeforeThird = mockSqlite.statements.length;
      const third = getDb();
      invariants['cachedHandleReused'] =
        mockSqlite.opens === opensBeforeThird &&
        mockSqlite.statements.length === statementsBeforeThird;
      await third.execute('SELECT 1');
      warm.close();
    }
  }

  if (readonlyApplied) fs.chmodSync(file, 0o644);
  fs.rmSync(dir, { recursive: true, force: true });

  const failed = Object.entries(invariants)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  return {
    suite: 'sqlite-migration',
    scenario: scenario.name,
    seed: scenario.seed,
    inputs: {
      ...scenario,
      faultEffective,
      population: {
        realShots: pop.shots.filter(s => s.source === 'real').length,
        fixtureShots: pop.shots.filter(s => s.source !== 'real').length,
        corruptPayloads: pop.shots.filter(s => {
          try {
            JSON.parse(s.payload);
            return false;
          } catch {
            return true;
          }
        }).length,
        sessions: pop.sessions.map(s => s.id.split('-').slice(3).join('-')),
        outbox: pop.outbox.map(o => o.kind),
        captures: pop.captures.length,
        kvKeys: Object.keys(pop.kv),
        kvBytes: Object.values(pop.kv).reduce((n, v) => n + v.length, 0),
      },
    },
    observed: { ...observed, knownDeviations },
    invariants,
    ok: failed.length === 0,
    failed,
    durationMs: Date.now() - started,
  };
}

function compactSnapshot(
  snap: Record<string, TableSnapshot>,
): Record<string, number | string[]> {
  const out: Record<string, number | string[]> = {};
  for (const [table, { rows }] of Object.entries(snap)) {
    out[table] =
      table === 'sqlite_master'
        ? rows.map(r => `${r['type']}:${r['name']}`)
        : rows.length;
  }
  return out;
}

// ─── Execution ───────────────────────────────────────────────────────────────

const allRows: MatrixRow[] = [];
const only = nodeProcess.env['XC_SQLITE_ONLY'];

function singleFactor(): MigrationScenario[] {
  const out: MigrationScenario[] = [];
  for (const schema of SCHEMAS) {
    for (const fault of FAULTS) {
      for (const seed of [1, 2, 3]) {
        out.push({
          name: `${schema}/${fault}/seed-${seed}`,
          seed,
          schema,
          fault,
        });
      }
    }
  }
  return out;
}

function seededScenario(index: number): MigrationScenario {
  const rng = makePrng(index * 7919 + 13);
  const schema = pick(rng, SCHEMAS);
  const fault = pick(rng, FAULTS);
  return {
    name: `seeded/${index}/${schema}/${fault}`,
    seed: index,
    schema,
    fault,
  };
}

async function runBatch(scenarios: MigrationScenario[]): Promise<MatrixRow[]> {
  const rows: MatrixRow[] = [];
  for (const scenario of scenarios) {
    if (only && !scenario.name.includes(only)) continue;
    rows.push(await runScenario(scenario));
  }
  allRows.push(...rows);
  return rows;
}

function failuresOf(rows: MatrixRow[]): string[] {
  return rows
    .filter(row => !row.ok)
    .map(
      row =>
        `${row.scenario} failed ${row.failed.join(',')} :: inputs=${JSON.stringify(row.inputs)} observed=${JSON.stringify(row.observed).slice(0, 1500)}`,
    );
}

const SEEDED_COUNT = 3000;
const CHUNK = 250;

if (sqlite === null) {
  describe('sqlite migration matrix (re-exec under --experimental-sqlite)', () => {
    it(
      'runs the whole file under node --experimental-sqlite',
      () => {
        if (nodeProcess.env['XC_SQLITE_CHILD'] === '1') {
          throw new Error(
            'node:sqlite is unavailable even with --experimental-sqlite; Node >= 22.5 is required for this matrix',
          );
        }
        const jestBin = resolveModule('jest/bin/jest');
        const result = childProcess.spawnSync(
          nodeProcess.execPath,
          [
            jestBin,
            '--ci',
            '--runInBand',
            '--silent',
            '--runTestsByPath',
            __filename,
          ],
          {
            cwd: path.resolve(__dirname, '../../..'),
            env: {
              ...nodeProcess.env,
              XC_SQLITE_CHILD: '1',
              NODE_OPTIONS:
                `${nodeProcess.env['NODE_OPTIONS'] ?? ''} --experimental-sqlite`.trim(),
            },
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(
          -6000,
        );
        expect({ status: result.status, tail }).toEqual({ status: 0, tail });
      },
      15 * 60_000,
    );
  });
} else {
  describe('sqlite schema migration matrix (real SQLite via node:sqlite)', () => {
    afterAll(() => {
      const summary = {
        ...summarize(allRows),
        knownDeviations: KNOWN_DEVIATIONS,
        knownDeviationRows: allRows.reduce<Record<string, number>>(
          (acc, row) => {
            for (const d of (row.observed as { knownDeviations: string[] })
              .knownDeviations) {
              const id = d.split(':')[0] as string;
              acc[id] = (acc[id] ?? 0) + 1;
            }
            return acc;
          },
          {},
        ),
        bySchema: SCHEMAS.reduce<
          Record<string, { rows: number; failed: number }>
        >((acc, schema) => {
          const rows = allRows.filter(
            r => (r.inputs as { schema: string }).schema === schema,
          );
          acc[schema] = {
            rows: rows.length,
            failed: rows.filter(r => !r.ok).length,
          };
          return acc;
        }, {}),
        sqliteVersion: (() => {
          const probe = new sqlite.DatabaseSync(':memory:');
          const row = probe.prepare('SELECT sqlite_version() AS v').get() as {
            v: string;
          };
          probe.close();
          return row.v;
        })(),
      };
      writeJsonArtifact('sqlite-migration-matrix.rows.json', allRows);
      writeJsonArtifact('sqlite-migration-matrix.summary.json', summary);
      writeTextArtifact(
        'sqlite-migration-matrix.matrix.md',
        matrixMarkdown(allRows),
      );
    });

    it('every schema × fault, three fixed seeds each', async () => {
      const batch = await runBatch(singleFactor());
      expect(failuresOf(batch)).toEqual([]);
    });

    for (let from = 0; from < SEEDED_COUNT; from += CHUNK) {
      it(`seeded populations ${from}..${from + CHUNK - 1} (mulberry32(index*7919+13))`, async () => {
        const before = heapSnapshot();
        const batch = await runBatch(
          Array.from({ length: CHUNK }, (_, i) => seededScenario(from + i)),
        );
        const after = heapSnapshot();
        writeJsonArtifact(`sqlite-migration-matrix.heap.${from}.json`, {
          before,
          after,
        });
        expect(failuresOf(batch)).toEqual([]);
      });
    }

    it('every triaged deviation is still reproduced (remove it from KNOWN_DEVIATIONS once fixed)', () => {
      if (only) return;
      const seen = new Set<string>();
      for (const row of allRows) {
        for (const d of (row.observed as { knownDeviations: string[] })
          .knownDeviations) {
          seen.add(d.split(':')[0] as string);
        }
      }
      expect([...seen].sort()).toEqual(Object.keys(KNOWN_DEVIATIONS).sort());
    });
  });
}
