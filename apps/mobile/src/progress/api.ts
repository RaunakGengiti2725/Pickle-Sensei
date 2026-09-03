import type { ApiSession } from '../account/apiSession';
import { getRuntimePublicConfig } from '../config/runtimeConfig';

export interface CanonicalProgressSeriesPoint {
  day: string;
  shotType: string;
  scoringModelVersion: string;
  shotCount: number;
  avgScore: number;
  bestScore: number;
}

export interface CanonicalProgress {
  series: CanonicalProgressSeriesPoint[];
  improving: Array<{ checkpoint: string; delta: number }>;
  needsAttention: Array<{ checkpoint: string; avg: number }>;
  streak: {
    currentDays: number;
    longestDays: number;
    practicedToday: boolean;
    lastPracticeDate: string | null;
  };
}

export type ProgressFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export const PROGRESS_REQUEST_TIMEOUT_MS = 15_000;

export class ProgressApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProgressApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseProgress(payload: unknown): CanonicalProgress {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload['series']) ||
    !Array.isArray(payload['improving']) ||
    !Array.isArray(payload['needsAttention']) ||
    !isRecord(payload['streak'])
  ) {
    throw new ProgressApiError(
      'The progress server returned an invalid response.',
    );
  }

  const series = payload['series'].map(row => {
    if (!isRecord(row)) throw new ProgressApiError('Invalid progress series.');
    const day = row['day'];
    const shotType = row['shot_type'];
    const scoringModelVersion = row['scoring_model_version'];
    const shotCount = finiteNumber(row['shot_count']);
    const avgScore100 = finiteNumber(row['avg_score']);
    const bestScore100 = finiteNumber(row['best_score']);
    if (
      typeof day !== 'string' ||
      typeof shotType !== 'string' ||
      typeof scoringModelVersion !== 'string' ||
      shotCount === null ||
      avgScore100 === null ||
      bestScore100 === null
    ) {
      throw new ProgressApiError('Invalid progress series.');
    }
    return {
      day,
      shotType,
      scoringModelVersion,
      shotCount,
      avgScore: avgScore100 / 10,
      bestScore: bestScore100 / 10,
    };
  });

  const parseTrend = (
    rows: unknown[],
    valueKey: 'delta' | 'avg',
  ): Array<{ checkpoint: string; value: number }> =>
    rows.map(row => {
      if (!isRecord(row)) throw new ProgressApiError('Invalid progress trend.');
      const checkpoint = row['checkpoint'];
      const value = finiteNumber(row[valueKey]);
      if (typeof checkpoint !== 'string' || value === null) {
        throw new ProgressApiError('Invalid progress trend.');
      }
      return { checkpoint, value };
    });

  const improving = parseTrend(payload['improving'], 'delta').map(item => ({
    checkpoint: item.checkpoint,
    delta: item.value,
  }));
  const needsAttention = parseTrend(payload['needsAttention'], 'avg').map(
    item => ({ checkpoint: item.checkpoint, avg: item.value }),
  );
  const streak = payload['streak'];
  const currentDays = finiteNumber(streak['currentDays']);
  const longestDays = finiteNumber(streak['longestDays']);
  const practicedToday = streak['practicedToday'];
  const lastPracticeDate = streak['lastPracticeDate'];
  if (
    currentDays === null ||
    longestDays === null ||
    typeof practicedToday !== 'boolean' ||
    !(lastPracticeDate === null || typeof lastPracticeDate === 'string')
  ) {
    throw new ProgressApiError('Invalid practice streak.');
  }

  return {
    series,
    improving,
    needsAttention,
    streak: {
      currentDays,
      longestDays,
      practicedToday,
      lastPracticeDate,
    },
  };
}

export async function fetchCanonicalProgress(
  session: ApiSession,
  fetchFn: ProgressFetch = globalThis.fetch,
): Promise<CanonicalProgress> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    PROGRESS_REQUEST_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetchFn(`${session.apiBaseUrl}/v1/progress`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${session.bearerToken}`,
        'X-Client-Version': getRuntimePublicConfig().appVersion,
      },
    });
  } catch {
    throw new ProgressApiError('Account progress is temporarily unavailable.');
  } finally {
    clearTimeout(timeout);
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new ProgressApiError('Account progress is temporarily unavailable.');
  }
  return parseProgress(payload);
}
