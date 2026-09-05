import { NativeModules } from 'react-native';
import type { LocalDb } from '../data/db';

const NATIVE_BATCH_SIZE = 128;

const ERROR_MESSAGES = {
  'capture.invalid_owner':
    'An explicit account is required for capture cleanup.',
  'capture.read_failed': 'Capture references could not be read. Please retry.',
  'capture.references_unreadable':
    'Capture references could not be verified. Local records have been retained.',
  'capture.native_unavailable':
    'Private capture cleanup is unavailable on this build.',
  'capture.delete_failed':
    'Some private capture files could not be removed. Please retry.',
} as const;

export type CaptureCleanupErrorCode = keyof typeof ERROR_MESSAGES;

export class CaptureCleanupError extends Error {
  readonly code: CaptureCleanupErrorCode;

  constructor(code: CaptureCleanupErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'CaptureCleanupError';
    this.code = code;
  }
}

export interface CaptureCleanupSummary {
  deletedCount: number;
  missingCount: number;
  sharedCount: number;
}

type CaptureDeletionBridge = {
  deleteCaptureFiles?: (uris: string[]) => Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readReferences(
  db: LocalDb,
  sql: string,
  owner: string,
): Promise<Record<string, unknown>[]> {
  try {
    const result = await db.execute(sql, [owner]);
    if (!Array.isArray(result.rows)) {
      throw new CaptureCleanupError('capture.read_failed');
    }
    return result.rows;
  } catch {
    throw new CaptureCleanupError('capture.read_failed');
  }
}

function referenceBasename(uri: string): string {
  const decodedUri = decodeURIComponent(uri);
  if (
    uri.trim().length === 0 ||
    uri.includes('?') ||
    uri.includes('#') ||
    decodedUri.includes('\\') ||
    [...decodedUri].some(character => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new CaptureCleanupError('capture.references_unreadable');
  }
  const basename = decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1));
  if (
    basename.length === 0 ||
    basename === '.' ||
    basename === '..' ||
    basename.includes('/')
  ) {
    throw new CaptureCleanupError('capture.references_unreadable');
  }
  return basename.normalize('NFD').toLowerCase().toUpperCase().normalize('NFD');
}

function collectReferences(
  rows: Record<string, unknown>[],
): Map<string, string> {
  const references = new Map<string, string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new CaptureCleanupError('capture.references_unreadable');
    }
    references.set(value, referenceBasename(value));
  };
  const addOptional = (value: unknown) => {
    if (value !== undefined && value !== null) add(value);
  };
  try {
    for (const row of rows) {
      if (!isRecord(row)) {
        throw new CaptureCleanupError('capture.references_unreadable');
      }
      add(row.uri);
      if (
        row.payload === null ||
        row.payload === undefined ||
        row.payload === ''
      ) {
        continue;
      }
      if (typeof row.payload !== 'string') {
        throw new CaptureCleanupError('capture.references_unreadable');
      }
      const payload: unknown = JSON.parse(row.payload);
      if (!isRecord(payload)) {
        throw new CaptureCleanupError('capture.references_unreadable');
      }
      addOptional(payload.uri);
      addOptional(payload.posterUri);
      if (payload.poseSequence !== undefined && payload.poseSequence !== null) {
        if (!isRecord(payload.poseSequence)) {
          throw new CaptureCleanupError('capture.references_unreadable');
        }
        add(payload.poseSequence.uri);
      }
    }
  } catch {
    throw new CaptureCleanupError('capture.references_unreadable');
  }
  return references;
}

function acknowledgeBatch(
  response: unknown,
  expectedCount: number,
): Pick<CaptureCleanupSummary, 'deletedCount' | 'missingCount'> {
  if (
    !isRecord(response) ||
    !Array.isArray(response.results) ||
    response.results.length !== expectedCount
  ) {
    throw new CaptureCleanupError('capture.delete_failed');
  }
  const indices = new Set<number>();
  let deletedCount = 0;
  let missingCount = 0;
  for (const result of response.results) {
    if (
      !isRecord(result) ||
      typeof result.index !== 'number' ||
      !Number.isInteger(result.index) ||
      result.index < 0 ||
      result.index >= expectedCount ||
      indices.has(result.index)
    ) {
      throw new CaptureCleanupError('capture.delete_failed');
    }
    indices.add(result.index);
    if (result.status === 'deleted') {
      deletedCount += 1;
    } else if (result.status === 'missing') {
      missingCount += 1;
    } else {
      throw new CaptureCleanupError('capture.delete_failed');
    }
  }
  return { deletedCount, missingCount };
}

export async function cleanupAccountCaptures(
  db: LocalDb,
  deletedOwner: string,
): Promise<CaptureCleanupSummary> {
  if (typeof deletedOwner !== 'string' || deletedOwner.trim().length === 0) {
    throw new CaptureCleanupError('capture.invalid_owner');
  }
  const ownedRows = await readReferences(
    db,
    'SELECT uri, payload FROM local_capture WHERE owner_key = ?',
    deletedOwner,
  );
  const summary: CaptureCleanupSummary = {
    deletedCount: 0,
    missingCount: 0,
    sharedCount: 0,
  };
  if (ownedRows.length === 0) return summary;

  const otherRows = await readReferences(
    db,
    'SELECT uri, payload FROM local_capture WHERE owner_key <> ? OR owner_key IS NULL',
    deletedOwner,
  );
  const owned = collectReferences(ownedRows);
  const others = collectReferences(otherRows);
  const sharedBasenames = new Set(others.values());
  const removable: string[] = [];
  for (const [uri, basename] of owned) {
    if (others.has(uri) || sharedBasenames.has(basename)) {
      summary.sharedCount += 1;
    } else {
      removable.push(uri);
    }
  }
  if (removable.length === 0) return summary;

  const native = NativeModules.PickleVideoCapture as
    CaptureDeletionBridge | undefined;
  if (typeof native?.deleteCaptureFiles !== 'function') {
    throw new CaptureCleanupError('capture.native_unavailable');
  }
  for (let offset = 0; offset < removable.length; offset += NATIVE_BATCH_SIZE) {
    const batch = removable.slice(offset, offset + NATIVE_BATCH_SIZE);
    let response: unknown;
    try {
      response = await native.deleteCaptureFiles(batch);
    } catch {
      throw new CaptureCleanupError('capture.delete_failed');
    }
    const counts = acknowledgeBatch(response, batch.length);
    summary.deletedCount += counts.deletedCount;
    summary.missingCount += counts.missingCount;
  }
  return summary;
}
