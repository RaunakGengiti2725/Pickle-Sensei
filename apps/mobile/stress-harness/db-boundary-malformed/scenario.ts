import type { LocalDb } from '../../src/data/db';
import {
  type Cell,
  describeCell,
  flagLiteral,
  idCell,
  int,
  isoCell,
  NULL,
  numericLiteral,
  ownerCell,
  payloadCell,
  shortText,
  nullableShortText,
  sourceCell,
  sqlLiteral,
  summaryCell,
  text,
  textBlob,
} from './cells';
import {
  bytesToHex,
  fs,
  type NodeSqlite,
  nodeProcess,
  openSqlite,
  os,
  path,
  sha256Hex,
  type SqliteDatabaseSync,
  utf8Encode,
} from './node';
import {
  cellKey,
  cellText,
  completedIsZero,
  isCanonicalJson,
  jsSource,
  outboxRowDeleted,
  shotRowDeleted,
  summaryLooksFixture,
} from './oracle';
import { Rng } from './rng';
import {
  EXPECTED_CAPTURE_COLUMNS,
  EXPECTED_INDEXES,
  EXPECTED_TABLES,
  FUTURE_USER_VERSION,
  type SchemaId,
  schemaDdl,
  SHAPES,
  type Shape,
  type TableName,
} from './schemas';

export const GUEST_OWNER = 'device-guest';

export type FaultId =
  | 'none'
  | 'io-throw'
  | 'disk-full'
  | 'locked-writer'
  | 'locked-reader'
  | 'readonly'
  | 'leftover-temp';

export type ThrowShape = 'error' | 'string' | 'object';

export interface SeedRow {
  table: TableName;
  cells: Record<string, Cell>;
  /** Hex of the dump key (see `rowKeySql`) so oracle rows meet dump rows. */
  key: string;
}

export interface Probe {
  sql: string;
  params: unknown[];
  describe: string;
}

export interface Scenario {
  seed: number;
  schema: SchemaId;
  fault: FaultId;
  throwShape: ThrowShape;
  /** Position of the injected I/O failure as a fraction of the control run. */
  faultFraction: number;
  pageDelta: number;
  rows: SeedRow[];
  probes: Probe[];
  garbageBytes: Uint8Array | null;
}

/** Hooks the test file wires into its `@op-engineering/op-sqlite` mock. */
export interface OpSqliteMockState {
  file: string;
  opens: number;
  statements: string[];
  fault: { at: number; value: unknown } | null;
  maxPageCount: number | null;
  lastHandle: { closed: number } | null;
}

export interface RunContext {
  state: OpSqliteMockState;
  loadGetDb: () => () => LocalDb;
  sqlite: NodeSqlite;
}

export type CheckStatus = 'pass' | 'fail' | 'n/a' | 'unavailable';

export interface ScenarioResult {
  seed: number;
  schema: SchemaId;
  fault: FaultId;
  faultDetail: string;
  faultEffective: boolean | null;
  rowsSeeded: Record<string, number>;
  rowsRejectedAtSeed: number;
  rejectedAtSeed: string[];
  controlStatements: number;
  checks: Record<string, CheckStatus>;
  failures: string[];
  notes: string[];
  probes: { count: number; resolved: number; rejected: number };
  outcome: 'HELD' | 'BROKEN';
  replay: string;
}

// ─── Generation ─────────────────────────────────────────────────────────────

function hexOf(cell: Cell): string {
  switch (cell.kind) {
    case 'text':
      return bytesToHex(utf8Encode(cell.value));
    case 'blob':
      return bytesToHex(cell.bytes);
    case 'int':
    case 'real':
      return bytesToHex(utf8Encode(cell.literal));
    case 'null':
      return '';
    case 'expr':
      return `expr:${cell.describe}`;
  }
}

function rowKey(table: TableName, cells: Record<string, Cell>): string {
  const cell = (name: string): Cell => cells[name] ?? NULL;
  switch (table) {
    case 'kv':
      return hexOf(cell('key'));
    case 'sync_receipt':
      return `${hexOf(cell('owner_key'))}|${hexOf(cell('kind'))}|${hexOf(cell('entity_id'))}`;
    default:
      return hexOf(cell('id'));
  }
}

/** SQL expression producing the same key as `rowKey` for a stored row. */
function rowKeySql(table: string): string {
  switch (table) {
    case 'kv':
      return 'hex(key)';
    case 'sync_receipt':
      return "hex(owner_key)||'|'||hex(kind)||'|'||hex(entity_id)";
    case 'local_shot':
    case 'local_session':
    case 'local_capture':
    case 'outbox':
    case 'local_analysis_record':
    case 'local_future_v9':
      return 'hex(id)';
    default:
      return 'hex(rowid)';
  }
}

function outboxKindCell(rng: Rng): Cell {
  return rng.weighted<Cell>([
    [text('shot.sync'), 10],
    [text('session.create'), 2],
    [text('session.finalize'), 1],
    [text('capture.sync'), 2],
    [text('shot.sync '), 1],
    [text('SHOT.SYNC'), 1],
    [text('shot.sync\u0000'), 1],
    [text(''), 1],
    [textBlob('shot.sync'), 1],
    [text('shot.sync.v3'), 1],
  ]);
}

function statusCell(rng: Rng): Cell {
  return rng.weighted<Cell>([
    [text('awaiting_model'), 5],
    [text('analyzed'), 5],
    [text('ANALYZED'), 1],
    [text('analyzed\u0000'), 1],
    [text(''), 1],
    [textBlob('analyzed'), 1],
  ]);
}

function generateRows(rng: Rng, schema: SchemaId): SeedRow[] {
  const shape = SHAPES[schema];
  const rows: SeedRow[] = [];
  if (!shape.hasTables) return rows;
  const nonce = (tag: string, i: number) => `${tag}${i}`;
  const owner = (has: boolean): Record<string, Cell> =>
    has ? { owner_key: ownerCell(rng) } : {};

  const kvCount = rng.int(0, 4);
  for (let i = 0; i < kvCount; i++) {
    const cells = {
      key: idCell(rng, nonce('k', i)),
      value: payloadCell(rng, nonce('k', i)),
    };
    rows.push({ table: 'kv', cells, key: rowKey('kv', cells) });
  }
  if (shape.kvOnly) return rows;

  const sessionIds: Cell[] = [];
  const sessionCount = rng.int(0, 5);
  for (let i = 0; i < sessionCount; i++) {
    const id = idCell(rng, nonce('s', i));
    sessionIds.push(id);
    const cells: Record<string, Cell> = {
      ...owner(shape.sessionsOwner),
      id,
      mode: rng.weighted<Cell>([
        [text('practice_set'), 5],
        [text('live_court'), 2],
        [shortText(rng), 1],
      ]),
      shot_type: nullableShortText(rng),
      focus_checkpoint: nullableShortText(rng),
      started_at: isoCell(rng),
      ended_at: rng.chance(0.4) ? NULL : isoCell(rng),
      completed: flagLiteral(rng),
      summary: summaryCell(rng),
      ...(shape.future ? { future_flags: nullableShortText(rng) } : {}),
    };
    rows.push({
      table: 'local_session',
      cells,
      key: rowKey('local_session', cells),
    });
  }

  const shotCount = rng.int(0, 6);
  for (let i = 0; i < shotCount; i++) {
    const sessionRef = rng.weighted<Cell>([
      [sessionIds.length > 0 ? rng.pick(sessionIds) : NULL, 5],
      [NULL, 2],
      [idCell(rng, nonce('x', i)), 2],
    ]);
    const cells: Record<string, Cell> = {
      ...owner(shape.shotsOwner),
      id: idCell(rng, nonce('h', i)),
      session_id: sessionRef,
      shot_type: shortText(rng),
      captured_at: isoCell(rng),
      overall_score: rng.chance(0.3) ? NULL : numericLiteral(rng),
      confidence: numericLiteral(rng),
      result_kind: rng.weighted<Cell>([
        [text('scored'), 5],
        [text('low_confidence'), 2],
        [shortText(rng), 1],
      ]),
      source: sourceCell(rng),
      favorite: flagLiteral(rng),
      payload: payloadCell(rng, nonce('h', i)),
      ...(shape.future ? { future_note: nullableShortText(rng) } : {}),
    };
    rows.push({ table: 'local_shot', cells, key: rowKey('local_shot', cells) });
  }

  const outboxCount = rng.int(0, 8);
  for (let i = 0; i < outboxCount; i++) {
    const cells: Record<string, Cell> = {
      id: int(i + 1),
      ...owner(shape.outboxOwner),
      kind: outboxKindCell(rng),
      payload: payloadCell(rng, nonce('o', i)),
      attempts: flagLiteral(rng),
      created_at: isoCell(rng),
      last_error: rng.chance(0.6) ? NULL : shortText(rng),
      ...(shape.future ? { priority: flagLiteral(rng) } : {}),
    };
    rows.push({ table: 'outbox', cells, key: rowKey('outbox', cells) });
  }

  if (shape.hasCapture) {
    const captureCount = rng.int(0, 4);
    for (let i = 0; i < captureCount; i++) {
      const cells: Record<string, Cell> = {
        ...owner(shape.captureOwner),
        id: idCell(rng, nonce('c', i)),
        uri: idCell(rng, nonce('u', i)),
        shot_type: shortText(rng),
        captured_at: isoCell(rng),
        duration_ms: numericLiteral(rng),
        fps: numericLiteral(rng),
        width: numericLiteral(rng),
        height: numericLiteral(rng),
        status: statusCell(rng),
        ...(shape.captureHasPayload
          ? {
              payload: rng.chance(0.3) ? NULL : payloadCell(rng, nonce('c', i)),
            }
          : {}),
        ...(shape.captureHasFutureCols
          ? {
              declared_stroke: nullableShortText(rng),
              target_seed: nullableShortText(rng),
              training_consent: rng.weighted<Cell>([
                [text('not_asked'), 4],
                [text('granted'), 1],
                [text('denied'), 1],
                [shortText(rng), 1],
              ]),
            }
          : {}),
      };
      rows.push({
        table: 'local_capture',
        cells,
        key: rowKey('local_capture', cells),
      });
    }
  }

  if (shape.hasReceipt) {
    const receiptCount = rng.int(0, 3);
    for (let i = 0; i < receiptCount; i++) {
      const cells: Record<string, Cell> = {
        owner_key: ownerCell(rng),
        kind: outboxKindCell(rng),
        entity_id: idCell(rng, nonce('r', i)),
        accepted_at: isoCell(rng),
      };
      rows.push({
        table: 'sync_receipt',
        cells,
        key: rowKey('sync_receipt', cells),
      });
    }
  }

  if (shape.hasAnalysis) {
    const analysisCount = rng.int(0, 3);
    for (let i = 0; i < analysisCount; i++) {
      const cells: Record<string, Cell> = {
        owner_key: ownerCell(rng),
        id: idCell(rng, nonce('a', i)),
        capture_id: idCell(rng, nonce('ac', i)),
        created_at: isoCell(rng),
        engine_version: shortText(rng),
        scoring_model_version: shortText(rng),
        record: payloadCell(rng, nonce('a', i)),
      };
      rows.push({
        table: 'local_analysis_record',
        cells,
        key: rowKey('local_analysis_record', cells),
      });
    }
  }

  if (shape.future) {
    const futureCount = rng.int(0, 2);
    for (let i = 0; i < futureCount; i++) {
      const cells: Record<string, Cell> = {
        owner_key: ownerCell(rng),
        id: idCell(rng, nonce('f', i)),
        blob_data: rng.chance(0.5) ? NULL : textBlob(`future${i}`),
      };
      rows.push({
        table: 'local_future_v9',
        cells,
        key: rowKey('local_future_v9', cells),
      });
    }
  }
  return rows;
}

const PROBE_PARAMS: readonly (readonly [string, () => unknown])[] = [
  ['NaN', () => NaN],
  ['Infinity', () => Infinity],
  ['-Infinity', () => -Infinity],
  ['-0', () => -0],
  ['1e400', () => Number('1e400')],
  ['2^53+1', () => 2 ** 53 + 1],
  ['bigint-2^63-1', () => 2n ** 63n - 1n],
  ['bigint-2^64', () => 2n ** 64n],
  ['undefined', () => undefined],
  ['null', () => null],
  ['true', () => true],
  ['{}', () => ({})],
  ['[]', () => []],
  ['[1]', () => [1]],
  ['Date', () => new Date(0)],
  ['function', () => () => 0],
  ['Symbol', () => Symbol('x')],
  ['64KB', () => 'x'.repeat(65536)],
  ['1MB', () => 'x'.repeat(1048576)],
  ['NUL', () => '\u0000'],
  ['a\\0b', () => 'a\u0000b'],
  ['Uint8Array', () => new Uint8Array([0, 255, 1])],
  ['null-proto', () => Object.create(null) as unknown],
  ['injection', () => "'; DROP TABLE local_shot; --"],
  ['traversal', () => '../../etc/passwd'],
  ['__proto__', () => '__proto__'],
  ['NFD', () => 're\u0301al'],
  ['lone-surrogate', () => '\uD800'],
  ['malformed-json', () => '{"source":"fix'],
  ['deep-json', () => '['.repeat(5000) + ']'.repeat(5000)],
];

const PROBE_SQL: readonly (readonly [string, (p: string) => string])[] = [
  ['select-param', () => 'SELECT ? AS v'],
  ['where-id', () => 'SELECT count(*) AS n FROM local_shot WHERE id = ?'],
  [
    'where-kind-json',
    () =>
      'SELECT count(*) AS n FROM outbox WHERE kind = ? AND json_valid(payload)',
  ],
  ['json-extract-param', () => "SELECT json_extract(?, '$.source') AS s"],
  [
    'like-param',
    () =>
      "SELECT count(*) AS n FROM local_session WHERE summary LIKE '%' || ? || '%'",
  ],
  ['bad-sql-empty', () => ''],
  ['bad-sql-truncated', () => 'SELECT * FROM'],
  ['bad-sql-token', () => 'SELEC 1'],
  ['bad-sql-nul', () => 'SEL\u0000ECT 1'],
  ['bad-sql-huge', () => 'x'.repeat(70000)],
  ['bad-sql-missing-table', () => 'SELECT * FROM nonexistent_zzz'],
  ['bad-sql-drop-missing', () => 'DROP TABLE nonexistent_zzz'],
  ['bad-sql-two-statements', () => 'SELECT 1; SELECT 2'],
  ['pragma-read', () => 'PRAGMA integrity_check'],
];

function generateProbes(rng: Rng): Probe[] {
  const probes: Probe[] = [];
  const count = rng.int(2, 4);
  for (let i = 0; i < count; i++) {
    const [sqlName, sqlOf] = rng.pick(PROBE_SQL);
    const [paramName, paramOf] = rng.pick(PROBE_PARAMS);
    const sql = sqlOf(paramName);
    const params = sql.includes('?')
      ? [paramOf()]
      : rng.chance(0.5)
        ? []
        : [paramOf()];
    probes.push({
      sql,
      params,
      describe: `${sqlName}(${sql.includes('?') || params.length ? paramName : '-'})`,
    });
  }
  return probes;
}

export function generateScenario(seed: number): Scenario {
  const rng = new Rng(seed);
  const schema = rng.weighted<SchemaId>([
    ['fresh', 8],
    ['v0', 22],
    ['v0b-owner-col', 10],
    ['v0c-capture-unscoped', 6],
    ['v1a-no-payload', 12],
    ['current', 28],
    ['future', 10],
    ['kv-only', 5],
    ['garbage', 5],
  ]);
  const fault =
    schema === 'garbage'
      ? 'none'
      : rng.weighted<FaultId>([
          ['none', 50],
          ['io-throw', 16],
          ['disk-full', 8],
          ['locked-writer', 6],
          ['locked-reader', 5],
          ['readonly', 7],
          ['leftover-temp', 8],
        ]);
  const throwShape = rng.weighted<ThrowShape>([
    ['error', 6],
    ['string', 1],
    ['object', 1],
  ]);
  const faultFraction = rng.next();
  const pageDelta = rng.int(0, 2);
  const rows = generateRows(rng, schema);
  const probes = generateProbes(rng);
  let garbageBytes: Uint8Array | null = null;
  if (schema === 'garbage') {
    const length = rng.int(100, 4096);
    garbageBytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) garbageBytes[i] = rng.int(0, 255);
    if (rng.chance(0.3)) {
      // Valid header magic with a corrupt body: SQLite must still refuse it.
      const magic = utf8Encode('SQLite format 3\u0000');
      garbageBytes.set(magic.subarray(0, Math.min(16, length)), 0);
    }
  }
  return {
    seed,
    schema,
    fault,
    throwShape,
    faultFraction,
    pageDelta,
    rows,
    probes,
    garbageBytes,
  };
}

// ─── Seeding / dumping ───────────────────────────────────────────────────────

interface SeedOutcome {
  accepted: SeedRow[];
  rejected: string[];
}

function seedDatabase(
  sqlite: NodeSqlite,
  file: string,
  scenario: Scenario,
  withLeftoverTemp: boolean,
): SeedOutcome {
  const shape = SHAPES[scenario.schema];
  const accepted: SeedRow[] = [];
  const rejected: string[] = [];
  if (scenario.schema === 'garbage') {
    fs.writeFileSync(file, scenario.garbageBytes ?? new Uint8Array(0));
    return { accepted, rejected };
  }
  if (scenario.schema === 'fresh') {
    if (scenario.fault === 'readonly')
      fs.writeFileSync(file, new Uint8Array(0));
    return { accepted, rejected };
  }
  const db = openSqlite(sqlite, file);
  for (const ddl of schemaDdl(scenario.schema)) db.exec(ddl);
  for (const row of scenario.rows) {
    const columns = Object.keys(row.cells);
    const values = columns.map(c => sqlLiteral(row.cells[c] ?? NULL));
    const sql = `INSERT INTO ${row.table} (${columns.join(',')}) VALUES (${values.join(',')})`;
    try {
      db.exec(sql);
      accepted.push(row);
    } catch (error) {
      rejected.push(
        `${row.table}[${row.key.slice(0, 24)}]: ${errorText(error)}`,
      );
    }
  }
  if (withLeftoverTemp && shape.hasTables && !shape.kvOnly) {
    db.exec(`CREATE TABLE local_shot_account_v2 (junk TEXT, more BLOB)`);
    db.exec(`INSERT INTO local_shot_account_v2 VALUES ('leftover', X'00FF')`);
    db.exec(
      `CREATE TABLE local_session_account_v2 (owner_key TEXT NOT NULL, id TEXT NOT NULL)`,
    );
    db.exec(
      `INSERT INTO local_session_account_v2 VALUES ('ghost', 'ghost-id')`,
    );
    db.exec(`CREATE TABLE local_capture_account_v2 (id INTEGER PRIMARY KEY)`);
  }
  db.close();
  return { accepted, rejected };
}

export interface Dump {
  tables: Record<string, Record<string, Record<string, string>>>;
  tableNames: string[];
  indexNames: string[];
  userVersion: number;
  integrity: string;
}

/** Pre-image of a first launch: no file, so nothing to read. */
const EMPTY_DUMP: Dump = {
  tables: {},
  tableNames: [],
  indexNames: [],
  userVersion: 0,
  integrity: 'ok',
};

function tableInfoColumns(
  db: SqliteDatabaseSync,
  table: string,
): { name: string; pk: number }[] {
  return db
    .prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`)
    .all()
    .map(row => ({ name: String(row['name']), pk: Number(row['pk']) }));
}

export function dumpDatabase(db: SqliteDatabaseSync): Dump {
  const tableNames = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all()
    .map(row => String(row['name']));
  const indexNames = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all()
    .map(row => String(row['name']));
  const tables: Dump['tables'] = {};
  for (const table of tableNames) {
    const columns = tableInfoColumns(db, table).map(c => c.name);
    const select = columns
      .map(c => `typeof("${c}")||':'||hex("${c}") AS "${c}"`)
      .join(', ');
    const rows = db
      .prepare(`SELECT ${rowKeySql(table)} AS __key, ${select} FROM "${table}"`)
      .all();
    const byKey: Record<string, Record<string, string>> = {};
    for (const row of rows) {
      const key = String(row['__key']);
      const cells: Record<string, string> = {};
      for (const c of columns) cells[c] = String(row[c]);
      byKey[key] = cells;
    }
    tables[table] = byKey;
  }
  const version = db.prepare('PRAGMA user_version').get();
  const integrity = db
    .prepare('PRAGMA integrity_check')
    .all()
    .map(row => String(row['integrity_check']))
    .join(';');
  return {
    tables,
    tableNames,
    indexNames,
    userVersion: Number(version?.['user_version'] ?? 0),
    integrity,
  };
}

function dumpFile(sqlite: NodeSqlite, file: string): Dump {
  const db = openSqlite(sqlite, file);
  try {
    return dumpDatabase(db);
  } finally {
    db.close();
  }
}

function dumpsEqual(a: Dump, b: Dump): string[] {
  const diffs: string[] = [];
  if (a.tableNames.join(',') !== b.tableNames.join(','))
    diffs.push(`tables ${a.tableNames.join(',')} vs ${b.tableNames.join(',')}`);
  if (a.indexNames.join(',') !== b.indexNames.join(','))
    diffs.push(
      `indexes ${a.indexNames.join(',')} vs ${b.indexNames.join(',')}`,
    );
  if (a.userVersion !== b.userVersion)
    diffs.push(`user_version ${a.userVersion} vs ${b.userVersion}`);
  for (const table of a.tableNames) {
    const left = a.tables[table] ?? {};
    const right = b.tables[table] ?? {};
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      const l = left[key];
      const r = right[key];
      if (!l || !r) {
        diffs.push(
          `${table}[${key.slice(0, 24)}] ${l ? 'missing after' : 'extra after'}`,
        );
        continue;
      }
      for (const col of Object.keys(l)) {
        if (l[col] !== r[col])
          diffs.push(`${table}[${key.slice(0, 24)}].${col} differs`);
      }
    }
  }
  return diffs;
}

// ─── Oracle ─────────────────────────────────────────────────────────────────

interface ExpectedRow {
  table: TableName;
  key: string;
  preCells: Record<string, string>;
  ownerBecomesGuest: boolean;
  newColumns: Record<string, string>;
}

function hexText(value: string): string {
  return `text:${bytesToHex(utf8Encode(value))}`;
}

function expectedSurvivors(
  shape: Shape,
  accepted: SeedRow[],
  preDump: Dump,
): {
  expected: ExpectedRow[];
  jsRealDeleted: string[];
  jsDivergence: string[];
  deletedKeys: string[];
} {
  const expected: ExpectedRow[] = [];
  const jsRealDeleted: string[] = [];
  const jsDivergence: string[] = [];
  const deletedKeys: string[] = [];
  const survivingShotSessions = new Set<string>();
  const cellOf = (row: SeedRow, name: string): Cell => row.cells[name] ?? NULL;

  const survives = (row: SeedRow): boolean => {
    switch (row.table) {
      case 'outbox': {
        const kind = cellOf(row, 'kind');
        const payload = cellOf(row, 'payload');
        const deleted = outboxRowDeleted(kind, cellText(payload));
        if (deleted && kind.kind === 'text' && kind.value === 'shot.sync') {
          const raw = cellText(payload);
          if (raw !== null && jsSource(raw) === 'real') {
            (isCanonicalJson(raw) ? jsRealDeleted : jsDivergence).push(row.key);
          }
        }
        return !deleted;
      }
      case 'local_shot':
        return !shotRowDeleted(cellOf(row, 'source'));
      default:
        return true;
    }
  };

  for (const row of accepted) {
    if (row.table === 'local_shot' && survives(row)) {
      const sessionId = cellOf(row, 'session_id');
      if (sessionId.kind !== 'null')
        survivingShotSessions.add(cellKey(sessionId));
    }
  }

  for (const row of accepted) {
    let keep: boolean;
    if (row.table === 'local_session') {
      const referenced = survivingShotSessions.has(cellKey(cellOf(row, 'id')));
      const purgeable =
        completedIsZero(cellOf(row, 'completed')) ||
        summaryLooksFixture(cellOf(row, 'summary'));
      keep = referenced || !purgeable;
    } else {
      keep = survives(row);
    }
    if (!keep) {
      deletedKeys.push(`${row.table}:${row.key.slice(0, 24)}`);
      continue;
    }
    const preCells = preDump.tables[row.table]?.[row.key];
    if (!preCells) {
      // Seed insert was accepted but the pre-image dump cannot find it: the
      // key derivation is wrong for this cell shape. Surface as a failure.
      expected.push({
        table: row.table,
        key: row.key,
        preCells: { __missing_preimage__: 'true' },
        ownerBecomesGuest: false,
        newColumns: {},
      });
      continue;
    }
    let ownerBecomesGuest = false;
    const newColumns: Record<string, string> = {};
    if (row.table === 'local_shot' && !shape.shotsOwner)
      ownerBecomesGuest = true;
    if (row.table === 'local_session' && !shape.sessionsOwner)
      ownerBecomesGuest = true;
    if (row.table === 'outbox' && !shape.outboxOwner) ownerBecomesGuest = true;
    if (row.table === 'local_capture') {
      if (!shape.captureOwner) ownerBecomesGuest = true;
      if (!shape.captureHasPayload) newColumns['payload'] = 'null:';
      if (!shape.captureHasFutureCols) {
        newColumns['declared_stroke'] = 'null:';
        newColumns['target_seed'] = 'null:';
        newColumns['training_consent'] = hexText('not_asked');
      }
    }
    expected.push({
      table: row.table,
      key: row.key,
      preCells,
      ownerBecomesGuest,
      newColumns,
    });
  }
  return { expected, jsRealDeleted, jsDivergence, deletedKeys };
}

function compareToExpected(
  expected: ExpectedRow[],
  post: Dump,
  options: { requireExact: boolean; ignoreOwner: boolean },
): string[] {
  const problems: string[] = [];
  const seen = new Map<string, Set<string>>();
  for (const row of expected) {
    const actual = post.tables[row.table]?.[row.key];
    const label = `${row.table}[${row.key.slice(0, 24)}]`;
    if (!actual) {
      problems.push(`${label} missing after open`);
      continue;
    }
    if (!seen.has(row.table)) seen.set(row.table, new Set());
    seen.get(row.table)?.add(row.key);
    if (row.preCells['__missing_preimage__']) {
      problems.push(`${label} pre-image row not found by key`);
      continue;
    }
    for (const [col, value] of Object.entries(row.preCells)) {
      const want =
        col === 'owner_key' && row.ownerBecomesGuest
          ? hexText(GUEST_OWNER)
          : value;
      if (col === 'owner_key' && options.ignoreOwner) continue;
      if (!(col in actual)) {
        if (options.requireExact) problems.push(`${label}.${col} column gone`);
        continue;
      }
      if (actual[col] !== want) problems.push(`${label}.${col} changed`);
    }
    if (options.requireExact) {
      if (row.ownerBecomesGuest && !('owner_key' in row.preCells)) {
        if (actual['owner_key'] !== hexText(GUEST_OWNER))
          problems.push(`${label}.owner_key not assigned to guest bucket`);
      }
      for (const [col, want] of Object.entries(row.newColumns)) {
        if (actual[col] !== want)
          problems.push(`${label}.${col} default wrong`);
      }
    }
  }
  if (options.requireExact) {
    for (const table of EXPECTED_TABLES) {
      const actualKeys = Object.keys(post.tables[table] ?? {});
      const expectedKeys = seen.get(table) ?? new Set<string>();
      for (const key of actualKeys) {
        if (!expectedKeys.has(key))
          problems.push(`${table}[${key.slice(0, 24)}] unexpected survivor`);
      }
    }
  }
  return problems;
}

function schemaProblems(
  post: Dump,
  sqlite: NodeSqlite,
  file: string,
): string[] {
  const problems: string[] = [];
  for (const table of EXPECTED_TABLES) {
    if (!post.tableNames.includes(table))
      problems.push(`table ${table} missing`);
  }
  for (const index of EXPECTED_INDEXES) {
    if (!post.indexNames.includes(index))
      problems.push(`index ${index} missing`);
  }
  const db = openSqlite(sqlite, file);
  try {
    for (const table of [
      'local_shot',
      'local_session',
      'local_capture',
    ] as const) {
      const pk = tableInfoColumns(db, table)
        .filter(c => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map(c => c.name);
      if (pk[0] !== 'owner_key' || pk[1] !== 'id')
        problems.push(`${table} pk is (${pk.join(',')})`);
    }
    const captureColumns = tableInfoColumns(db, 'local_capture').map(
      c => c.name,
    );
    for (const col of EXPECTED_CAPTURE_COLUMNS) {
      if (!captureColumns.includes(col))
        problems.push(`local_capture.${col} missing`);
    }
    if (!tableInfoColumns(db, 'outbox').some(c => c.name === 'owner_key'))
      problems.push('outbox.owner_key missing');
  } finally {
    db.close();
  }
  return problems;
}

// ─── Running ────────────────────────────────────────────────────────────────

/**
 * Error-like check that survives jest's module-registry realm boundary
 * (node:sqlite errors are created outside the test VM, so `instanceof Error`
 * is false for them even though they are genuine Error instances).
 */
export function isErrorLike(
  error: unknown,
): error is { name?: string; message: string } {
  if (error instanceof Error) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { message?: unknown }).message === 'string' &&
    (error as { message: string }).message.length > 0
  );
}

export function errorText(error: unknown): string {
  if (isErrorLike(error)) return `${error.name ?? 'Error'}: ${error.message}`;
  if (typeof error === 'string') return `string: ${error}`;
  try {
    return `${typeof error}: ${JSON.stringify(error)}`;
  } catch {
    return `${typeof error}`;
  }
}

function injectedValue(shape: ThrowShape, seed: number): unknown {
  switch (shape) {
    case 'error':
      return new Error(`SQLITE_IOERR: disk I/O error (stress seed ${seed})`);
    case 'string':
      return `disk gone (stress seed ${seed})`;
    case 'object':
      return { code: 'SQLITE_IOERR', seed };
  }
}

function fileHash(file: string): string {
  return fs.existsSync(file) ? sha256Hex(fs.readFileSync(file)) : 'absent';
}

function chmodReadonly(file: string, readonly: boolean): void {
  const mode = readonly ? 0o444 : 0o644;
  if (fs.existsSync(file)) fs.chmodSync(file, mode);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) fs.chmodSync(file + suffix, mode);
  }
}

export function replayCommand(seed: number): string {
  return `cd apps/mobile && STRESS_ONLY=${seed} npx jest --ci __tests__/stress/dbBoundaryMalformed`;
}

export async function runScenario(
  scenario: Scenario,
  ctx: RunContext,
): Promise<ScenarioResult> {
  const { state, sqlite } = ctx;
  const shape = SHAPES[scenario.schema];
  const checks: Record<string, CheckStatus> = {};
  const failures: string[] = [];
  const notes: string[] = [];
  const check = (name: string, ok: boolean, detail?: string | string[]) => {
    checks[name] = ok ? 'pass' : 'fail';
    if (!ok) {
      const list = Array.isArray(detail) ? detail : detail ? [detail] : [];
      failures.push(
        `${name}${list.length ? ': ' + list.slice(0, 6).join(' | ') : ''}`,
      );
    }
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-db-'));
  const controlFile = path.join(dir, 'control.db');
  const faultFile = path.join(dir, 'fault.db');
  const probes = { count: 0, resolved: 0, rejected: 0 };
  let controlStatements = 0;
  let faultEffective: boolean | null = null;
  let faultDetail: string = scenario.fault;
  const rowsSeeded: Record<string, number> = {};
  let rejectedAtSeed: string[] = [];

  const resetMock = (file: string) => {
    state.file = file;
    state.opens = 0;
    state.statements = [];
    state.fault = null;
    state.maxPageCount = null;
    state.lastHandle = null;
  };

  try {
    // ── control: seed → open → oracle ──────────────────────────────────────
    const seeded = seedDatabase(
      sqlite,
      controlFile,
      scenario,
      scenario.fault === 'leftover-temp',
    );
    rejectedAtSeed = seeded.rejected;
    for (const row of seeded.accepted)
      rowsSeeded[row.table] = (rowsSeeded[row.table] ?? 0) + 1;
    const preDump = shape.hasTables
      ? dumpFile(sqlite, controlFile)
      : EMPTY_DUMP;
    const preHash = fileHash(controlFile);

    resetMock(controlFile);
    const getDb = ctx.loadGetDb();
    let handle: LocalDb | null = null;
    let openError: unknown = null;
    try {
      handle = getDb();
    } catch (error) {
      openError = error;
    }
    controlStatements = state.statements.length;

    if (scenario.schema === 'garbage') {
      check(
        'garbage-open-throws',
        handle === null,
        handle ? 'opened a non-database file' : undefined,
      );
      check(
        'garbage-typed-error',
        isErrorLike(openError),
        errorText(openError),
      );
      // Either the adapter refused to open the file (nothing to close) or the
      // first migration statement failed and openMigrated closed it exactly once.
      check(
        'garbage-handle-closed',
        state.lastHandle === null || state.lastHandle.closed === 1,
        `closed=${state.lastHandle?.closed}`,
      );
      notes.push(
        state.lastHandle === null
          ? 'garbage: open() itself rejected the file'
          : 'garbage: first statement rejected the file',
      );
      let retryError: unknown = null;
      try {
        getDb();
      } catch (error) {
        retryError = error;
      }
      check(
        'garbage-not-cached',
        state.opens === 2 && isErrorLike(retryError),
        `opens=${state.opens}`,
      );
      check('garbage-file-untouched', fileHash(controlFile) === preHash);
      if (handle) handle.close();
    } else {
      check('open-succeeds', handle !== null, errorText(openError));
      if (handle) {
        // Same-process concurrency: a second getDb() shares the cached handle
        // and parallel executes on it all settle.
        getDb();
        check(
          'cached-handle-no-reopen',
          state.opens === 1,
          `opens=${state.opens}`,
        );
        const parallel = await Promise.allSettled(
          Array.from({ length: 12 }, (_, i) =>
            handle.execute('SELECT ? AS i', [i]),
          ),
        );
        check(
          'parallel-execute-settles',
          parallel.every(p => p.status === 'fulfilled'),
          parallel
            .filter(p => p.status === 'rejected')
            .map(p => errorText((p as PromiseRejectedResult).reason)),
        );

        const postViaHandle = await handle.execute('PRAGMA integrity_check');
        check(
          'integrity-ok',
          postViaHandle.rows.length === 1 &&
            postViaHandle.rows[0]?.['integrity_check'] === 'ok',
        );

        // Malformed params / SQL through LocalDb.execute: must settle, must
        // leave the handle usable, must not write.
        const beforeProbes = dumpFile(sqlite, controlFile);
        for (const probe of scenario.probes) {
          probes.count++;
          let settled: 'resolved' | 'rejected' | 'threw-sync' = 'threw-sync';
          try {
            const pending = handle.execute(probe.sql, probe.params);
            try {
              await pending;
              settled = 'resolved';
            } catch {
              settled = 'rejected';
            }
          } catch (error) {
            check(
              `probe-settles`,
              false,
              `${probe.describe} threw synchronously: ${errorText(error)}`,
            );
          }
          if (settled === 'resolved') probes.resolved++;
          if (settled === 'rejected') probes.rejected++;
          let usable = false;
          try {
            const ping = await handle.execute('SELECT 1 AS one');
            usable = ping.rows[0]?.['one'] === 1;
          } catch {
            usable = false;
          }
          if (!usable) check('probe-handle-usable', false, probe.describe);
        }
        if (!('probe-settles' in checks)) checks['probe-settles'] = 'pass';
        if (!('probe-handle-usable' in checks))
          checks['probe-handle-usable'] = 'pass';
        const afterProbes = dumpFile(sqlite, controlFile);
        check(
          'probe-no-write',
          dumpsEqual(beforeProbes, afterProbes).length === 0,
          dumpsEqual(beforeProbes, afterProbes),
        );

        handle.close();
        const postDump = dumpFile(sqlite, controlFile);
        const schemaIssues = schemaProblems(postDump, sqlite, controlFile);
        check('schema-current', schemaIssues.length === 0, schemaIssues);
        check(
          'integrity-after-close',
          postDump.integrity === 'ok',
          postDump.integrity,
        );

        const oracle = expectedSurvivors(shape, seeded.accepted, preDump);
        const rowIssues = compareToExpected(oracle.expected, postDump, {
          requireExact: true,
          ignoreOwner: false,
        });
        check('rows-match-oracle', rowIssues.length === 0, rowIssues);
        check(
          'js-real-outbox-row-kept',
          oracle.jsRealDeleted.length === 0,
          oracle.jsRealDeleted.map(
            k =>
              `outbox[${k.slice(0, 24)}] (canonical JSON) deleted though JSON.parse sees source=real`,
          ),
        );
        for (const k of oracle.jsDivergence) {
          notes.push(
            `divergence: outbox[${k.slice(0, 24)}] purged by json_extract (first duplicate key) though JSON.parse sees source=real`,
          );
        }
        if (oracle.deletedKeys.length)
          notes.push(`purged by design: ${oracle.deletedKeys.length} row(s)`);

        // Contract: a rebuild starts with DROP TABLE IF EXISTS <table>_account_v2,
        // so a scratch table for a table that WAS rebuilt must be gone. A scratch
        // table for a table that needed no rebuild is not touched by the
        // migration; it is recorded as an orphan (see report) rather than failed.
        const leftovers = postDump.tableNames.filter(t =>
          t.endsWith('_account_v2'),
        );
        const rebuilt = new Set<string>();
        if (!shape.shotsOwner) rebuilt.add('local_shot_account_v2');
        if (!shape.sessionsOwner) rebuilt.add('local_session_account_v2');
        if (shape.hasCapture && !shape.captureOwner)
          rebuilt.add('local_capture_account_v2');
        const leftAfterRebuild = leftovers.filter(t => rebuilt.has(t));
        const orphans = leftovers.filter(t => !rebuilt.has(t));
        check(
          'no-temp-tables',
          leftAfterRebuild.length === 0,
          leftAfterRebuild,
        );
        for (const t of orphans)
          notes.push(
            `orphan scratch table ${t} survives open (its table needed no rebuild)`,
          );

        if (shape.future) {
          const futureIssues: string[] = [];
          if (postDump.userVersion !== FUTURE_USER_VERSION)
            futureIssues.push(`user_version=${postDump.userVersion}`);
          if (!postDump.tableNames.includes('local_future_v9'))
            futureIssues.push('local_future_v9 dropped');
          if (!postDump.indexNames.includes('idx_future_note'))
            futureIssues.push('idx_future_note dropped');
          const shotCols = Object.values(
            postDump.tables['local_shot'] ?? {},
          )[0];
          const sessionCols = Object.values(
            postDump.tables['local_session'] ?? {},
          )[0];
          const outboxCols = Object.values(postDump.tables['outbox'] ?? {})[0];
          if (shotCols && !('future_note' in shotCols))
            futureIssues.push('local_shot.future_note dropped');
          if (sessionCols && !('future_flags' in sessionCols))
            futureIssues.push('local_session.future_flags dropped');
          if (outboxCols && !('priority' in outboxCols))
            futureIssues.push('outbox.priority dropped');
          check(
            'future-schema-preserved',
            futureIssues.length === 0,
            futureIssues,
          );
        }

        // Second launch on the migrated file must be a pure no-op.
        const secondGetDb = ctx.loadGetDb();
        state.statements = [];
        let second: LocalDb | null = null;
        try {
          second = secondGetDb();
        } catch (error) {
          check('reopen-succeeds', false, errorText(error));
        }
        if (second) {
          checks['reopen-succeeds'] = 'pass';
          second.close();
          const reDump = dumpFile(sqlite, controlFile);
          const diffs = dumpsEqual(postDump, reDump);
          check('reopen-idempotent', diffs.length === 0, diffs);
        }

        // ── fault copy ───────────────────────────────────────────────────
        if (scenario.fault !== 'none' && scenario.fault !== 'leftover-temp') {
          seedDatabase(sqlite, faultFile, scenario, false);
          const faultPreDump = shape.hasTables
            ? dumpFile(sqlite, faultFile)
            : EMPTY_DUMP;
          resetMock(faultFile);
          let holder: SqliteDatabaseSync | null = null;
          let injected: unknown = null;
          let expectThrow = true;
          switch (scenario.fault) {
            case 'io-throw': {
              const at =
                1 +
                Math.floor(
                  scenario.faultFraction * Math.max(1, controlStatements),
                );
              injected = injectedValue(scenario.throwShape, scenario.seed);
              state.fault = { at, value: injected };
              faultDetail = `io-throw@${at}/${controlStatements} (${scenario.throwShape})`;
              break;
            }
            case 'disk-full': {
              const probe = openSqlite(sqlite, faultFile);
              const pages = Number(
                probe.prepare('PRAGMA page_count').get()?.['page_count'] ?? 1,
              );
              probe.close();
              state.maxPageCount = Math.max(1, pages + scenario.pageDelta);
              faultDetail = `disk-full max_page_count=${state.maxPageCount} (have ${pages})`;
              expectThrow = false; // effective only if the migration needs pages
              break;
            }
            case 'locked-writer':
              holder = openSqlite(sqlite, faultFile);
              holder.exec('BEGIN IMMEDIATE');
              faultDetail = 'locked-writer (other connection holds RESERVED)';
              break;
            case 'locked-reader':
              holder = openSqlite(sqlite, faultFile);
              holder.exec('BEGIN');
              holder.prepare('SELECT count(*) AS n FROM sqlite_master').get();
              faultDetail = 'locked-reader (other connection holds SHARED)';
              break;
            case 'readonly':
              if (nodeProcess.getuid?.() === 0) {
                checks['fault-throws'] = 'unavailable';
                notes.push('readonly fault unavailable: running as root');
                faultEffective = false;
                expectThrow = false;
              } else {
                chmodReadonly(faultFile, true);
                faultDetail = 'readonly (chmod 0444)';
              }
              break;
          }

          // Taken after the holder connection exists: opening a fresh path
          // creates the (empty) file, and the holder is not the code under test.
          const faultPreHash = fileHash(faultFile);

          if (checks['fault-throws'] !== 'unavailable') {
            const faultGetDb = ctx.loadGetDb();
            let faultHandle: LocalDb | null = null;
            let faultError: unknown = null;
            try {
              faultHandle = faultGetDb();
            } catch (error) {
              faultError = error;
            }
            faultEffective = faultHandle === null;
            if (faultHandle) {
              if (expectThrow)
                check('fault-throws', false, 'open succeeded under fault');
              else {
                checks['fault-throws'] = 'n/a';
                notes.push(`${faultDetail}: migration fit, open succeeded`);
              }
              faultHandle.close();
            } else {
              check('fault-throws', true);
              if (scenario.fault === 'io-throw') {
                check(
                  'fault-error-preserved',
                  faultError === injected,
                  `got ${errorText(faultError)}`,
                );
              } else {
                check(
                  'fault-typed-error',
                  isErrorLike(faultError),
                  errorText(faultError),
                );
              }
              check(
                'fault-handle-closed-once',
                state.lastHandle?.closed === 1,
                `closed=${state.lastHandle?.closed}`,
              );
              const opensBefore = state.opens;
              let retryError: unknown = null;
              let retryHandle: LocalDb | null = null;
              try {
                retryHandle = faultGetDb();
              } catch (error) {
                retryError = error;
              }
              check(
                'fault-not-cached',
                state.opens === opensBefore + 1,
                `opens ${opensBefore}→${state.opens}`,
              );
              if (retryHandle) {
                retryHandle.close();
                if (expectThrow && scenario.fault !== 'io-throw') {
                  check(
                    'fault-retry-consistent',
                    false,
                    'retry under the same fault succeeded',
                  );
                }
              } else if (scenario.fault !== 'io-throw' || state.fault) {
                checks['fault-retry-consistent'] = 'pass';
                notes.push(`retry error: ${errorText(retryError)}`);
              }
              if (
                scenario.fault === 'locked-writer' ||
                scenario.fault === 'locked-reader' ||
                scenario.fault === 'readonly'
              ) {
                check(
                  'fault-preimage-untouched',
                  fileHash(faultFile) === faultPreHash,
                );
              }
              if (
                scenario.fault === 'io-throw' ||
                scenario.fault === 'disk-full'
              ) {
                // A half-run may have purged fixtures but must never have lost
                // a row the oracle says survives.
                const midDump = dumpFile(sqlite, faultFile);
                const oracle = expectedSurvivors(
                  shape,
                  seeded.accepted,
                  faultPreDump,
                );
                const loss = compareToExpected(oracle.expected, midDump, {
                  requireExact: false,
                  ignoreOwner: true,
                });
                check('fault-no-real-row-loss', loss.length === 0, loss);
                check(
                  'fault-integrity-ok',
                  midDump.integrity === 'ok',
                  midDump.integrity,
                );
              }
            }

            // Clear the fault and prove the file converges to the control.
            state.fault = null;
            state.maxPageCount = null;
            if (holder) {
              holder.exec('ROLLBACK');
              holder.close();
              holder = null;
            }
            if (scenario.fault === 'readonly') chmodReadonly(faultFile, false);
            const recoveryGetDb = ctx.loadGetDb();
            let recovered: LocalDb | null = null;
            try {
              recovered = recoveryGetDb();
            } catch (error) {
              check('fault-recovery-opens', false, errorText(error));
            }
            if (recovered) {
              checks['fault-recovery-opens'] = 'pass';
              recovered.close();
              const recoveredDump = dumpFile(sqlite, faultFile);
              const diffs = dumpsEqual(postDump, recoveredDump);
              check('fault-recovery-converges', diffs.length === 0, diffs);
            }
          }
          if (holder) {
            holder.exec('ROLLBACK');
            holder.close();
          }
        }
      }
    }
  } catch (error) {
    check('harness-exception', false, errorText(error));
  } finally {
    chmodReadonly(faultFile, false);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return {
    seed: scenario.seed,
    schema: scenario.schema,
    fault: scenario.fault,
    faultDetail,
    faultEffective,
    rowsSeeded,
    rowsRejectedAtSeed: rejectedAtSeed.length,
    rejectedAtSeed,
    controlStatements,
    checks,
    failures,
    notes,
    probes,
    outcome: failures.length === 0 ? 'HELD' : 'BROKEN',
    replay: replayCommand(scenario.seed),
  };
}

/** Compact description of a scenario's inputs for the artifact table. */
export function describeScenario(scenario: Scenario): Record<string, unknown> {
  return {
    seed: scenario.seed,
    schema: scenario.schema,
    fault: scenario.fault,
    throwShape: scenario.throwShape,
    rows: scenario.rows.map(row => ({
      table: row.table,
      cells: Object.fromEntries(
        Object.entries(row.cells).map(([c, cell]) => [c, describeCell(cell)]),
      ),
    })),
    probes: scenario.probes.map(p => p.describe),
  };
}
