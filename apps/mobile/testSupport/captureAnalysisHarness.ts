import { sha256Hex } from '@pickle/swing-domain';
import type { CapturedClip } from '../src/camera/capture';
import type { LocalDb } from '../src/data/db';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import {
  establishApiSession,
  clearApiSession,
} from '../src/account/apiSession';
import {
  createSqliteTestDb,
  seedSqliteCapture,
  closeSqliteTestDatabases,
} from './sqlite';

export function fixtureUuid(label: string): string {
  const hash = sha256Hex(label);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function signInCaptureOwner(
  owner: string,
  apiOrigin = 'https://api.test',
): void {
  setActiveDataOwner(owner);
  establishApiSession({
    canonicalAppUserId: owner,
    apiBaseUrl: apiOrigin,
    bearerToken: 'current-capture-owner-token',
    provider: 'apple',
  });
}

export function closeCaptureHarness(): void {
  closeSqliteTestDatabases();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
}

export function seedCaptureRequest(
  db: LocalDb,
  clip: CapturedClip,
  label: string,
) {
  const ownerContext = captureDataOwnerContext();
  const captureId = fixtureUuid(`capture:${label}`);
  seedSqliteCapture(db, ownerContext.ownerKey, captureId, clip);
  return {
    ownerContext,
    captureId,
    operationId: fixtureUuid(`operation:${label}`),
  };
}

/** Actual migrated SQLite: table snapshots prove rollback and durable accounting.
 * Fault callbacks target writes only; reconciliation reads stay available. */
const stores = new WeakMap<LocalDb, ReturnType<typeof createSqliteTestDb>>();

export function captureDbState(db: LocalDb) {
  const store = stores.get(db)!;
  const rows = (table: string) =>
    store.native.prepare(`SELECT * FROM ${table}`).all();
  return {
    shots: rows('local_shot').length,
    records: rows('local_analysis_record').length,
    outbox: rows('outbox').length,
    journal: rows('analysis_run_journal'),
    captures: rows('local_capture'),
  };
}

export function createCaptureAnalysisDb(
  fault?: (sql: string, index: number) => void,
) {
  const store = createSqliteTestDb();
  stores.set(store.db, store);
  if (fault)
    store.observeStatements(call => {
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(call.sql))
        fault(call.sql, store.calls.indexOf(call));
    });
  const rows = (table: string) =>
    store.native.prepare(`SELECT * FROM ${table}`).all();
  return {
    ...store,
    get shots() {
      return rows('local_shot');
    },
    get outbox() {
      return rows('outbox') as Array<{
        id: string;
        kind: string;
        payload: string;
      }>;
    },
    get analysisRecords() {
      return rows('local_analysis_record');
    },
    get journal() {
      return rows('analysis_run_journal');
    },
    get statements() {
      return store.calls;
    },
    failNext: store.failStatementOnce,
    openTransactions() {
      return store.calls.reduce(
        (open, call) =>
          open +
          (/^BEGIN/.test(call.sql)
            ? 1
            : /^(COMMIT|ROLLBACK)$/.test(call.sql)
              ? -1
              : 0),
        0,
      );
    },
  };
}
