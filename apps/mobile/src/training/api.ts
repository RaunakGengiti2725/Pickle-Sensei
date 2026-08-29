import {
  TrainingError,
  type DrillCompletion,
  type DrillDetail,
  type DrillMapping,
  type InstructionalMedia,
  type SavedDrill,
  type TrainingApi,
  type TrainingPlan,
  type TrainingPlanItem,
} from './types';

export type TrainingFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface TrainingApiConfig {
  baseUrl: string | null | undefined;
  token: string | null | undefined;
  fetchFn?: TrainingFetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isIso(value: unknown): value is string {
  return isString(value) && !Number.isNaN(Date.parse(value));
}

function isHttpsUrl(value: unknown): value is string {
  return isString(value) && value.startsWith('https://');
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidResponse(
  message = 'The training server returned an invalid response.',
) {
  return new TrainingError('training.invalid_response', message, true);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (!isString(value)) throw invalidResponse();
  return value;
}

function requiredUuid(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key);
  if (!UUID_PATTERN.test(value)) throw invalidResponse();
  return value;
}

function nullableUuid(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = nullableString(record, key);
  if (value !== null && !UUID_PATTERN.test(value)) throw invalidResponse();
  return value;
}

function nullableString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  if (!isNullableString(value)) throw invalidResponse();
  return value;
}

function parseSavedDrill(value: unknown): SavedDrill {
  if (!isRecord(value) || !isIso(value['saved_at'])) throw invalidResponse();
  return {
    id: requiredUuid(value, 'id'),
    slug: requiredString(value, 'slug'),
    title: requiredString(value, 'title'),
    description: requiredString(value, 'description'),
    coachName: requiredString(value, 'coach_name'),
    equipment: Array.isArray(value['equipment']) ? value['equipment'] : [],
    difficultyMin: nullableString(value, 'difficulty_min'),
    difficultyMax: nullableString(value, 'difficulty_max'),
    savedAt: value['saved_at'],
  };
}

function parseInstructionalMedia(value: unknown): InstructionalMedia {
  if (!isRecord(value)) throw invalidResponse();
  const sourceUrl = value['sourceUrl'];
  if (!isHttpsUrl(sourceUrl)) throw invalidResponse();
  const common = {
    id: requiredUuid(value, 'id'),
    sourceUrl,
    creatorName: requiredString(value, 'creatorName'),
    licenseName: requiredString(value, 'licenseName'),
    licenseUrl: nullableString(value, 'licenseUrl'),
    attribution: requiredString(value, 'attribution'),
  };
  if (common.licenseUrl !== null && !isHttpsUrl(common.licenseUrl)) {
    throw invalidResponse();
  }
  if (value['kind'] === 'hosted') {
    if (!isHttpsUrl(value['playbackUrl']) || !isIso(value['expiresAt'])) {
      throw invalidResponse();
    }
    return {
      ...common,
      kind: 'hosted',
      playbackUrl: value['playbackUrl'],
      expiresAt: value['expiresAt'],
    };
  }
  if (value['kind'] === 'embed') {
    if (
      (value['provider'] !== 'youtube' && value['provider'] !== 'vimeo') ||
      !isString(value['videoId']) ||
      !isHttpsUrl(value['embedUrl'])
    ) {
      throw invalidResponse();
    }
    const expectedEmbed =
      value['provider'] === 'youtube'
        ? `https://www.youtube-nocookie.com/embed/${value['videoId']}`
        : `https://player.vimeo.com/video/${value['videoId']}`;
    if (value['embedUrl'] !== expectedEmbed) throw invalidResponse();
    return {
      ...common,
      kind: 'embed',
      provider: value['provider'],
      videoId: value['videoId'],
      embedUrl: value['embedUrl'],
    };
  }
  throw invalidResponse();
}

function parseMapping(value: unknown): DrillMapping {
  if (!isRecord(value)) throw invalidResponse();
  const targetSets = Number(value['target_sets']);
  const reps = value['target_repetitions_per_set'];
  const duration = value['target_duration_seconds'];
  const rest = value['rest_seconds'];
  if (
    (value['plan_role'] !== 'warmup' && value['plan_role'] !== 'targeted') ||
    !Number.isSafeInteger(targetSets) ||
    targetSets < 1 ||
    !isNullableNumber(reps) ||
    !isNullableNumber(duration) ||
    !isNullableNumber(rest) ||
    !Array.isArray(value['fault_directions']) ||
    !value['fault_directions'].every(isString)
  ) {
    throw invalidResponse();
  }
  return {
    checkpoint: requiredString(value, 'checkpoint'),
    shotType: requiredString(value, 'shot_type'),
    planRole: value['plan_role'],
    faultDirections: [...value['fault_directions']],
    cueText: requiredString(value, 'cue_text'),
    targetSets,
    targetRepetitionsPerSet: reps,
    targetDurationSeconds: duration,
    restSeconds: rest,
  };
}

function parseDrillDetail(value: unknown): DrillDetail {
  if (!isRecord(value) || !isRecord(value['drill'])) throw invalidResponse();
  const drill = value['drill'];
  if (typeof drill['saved'] !== 'boolean') throw invalidResponse();
  const mappings = value['mappings'];
  const media = value['instructionalMedia'];
  if (!Array.isArray(mappings) || !Array.isArray(media))
    throw invalidResponse();
  return {
    id: requiredUuid(drill, 'id'),
    slug: requiredString(drill, 'slug'),
    title: requiredString(drill, 'title'),
    description: requiredString(drill, 'description'),
    coachName: requiredString(drill, 'coach_name'),
    equipment: Array.isArray(drill['equipment']) ? drill['equipment'] : [],
    difficultyMin: nullableString(drill, 'difficulty_min'),
    difficultyMax: nullableString(drill, 'difficulty_max'),
    saved: drill['saved'],
    mappings: mappings.map(parseMapping),
    instructionalMedia: media.map(parseInstructionalMedia),
  };
}

function parseCompletion(value: unknown): DrillCompletion {
  if (
    !isRecord(value) ||
    !isIso(value['completedAt']) ||
    !isNullableNumber(value['actualRepetitions']) ||
    !isNullableNumber(value['actualDurationSeconds']) ||
    typeof value['qualifiesForStreak'] !== 'boolean'
  ) {
    throw invalidResponse();
  }
  return {
    id: requiredUuid(value, 'id'),
    completedAt: value['completedAt'],
    actualRepetitions: value['actualRepetitions'],
    actualDurationSeconds: value['actualDurationSeconds'],
    qualifiesForStreak: value['qualifiesForStreak'],
  };
}

function parsePlanItem(value: unknown): TrainingPlanItem {
  if (!isRecord(value)) throw invalidResponse();
  const position = Number(value['position']);
  const kind = value['kind'];
  if (
    !Number.isSafeInteger(position) ||
    (kind !== 'warmup' && kind !== 'targeted' && kind !== 'reassessment') ||
    !isNullableString(value['cueText']) ||
    !isNullableNumber(value['targetSets']) ||
    !isNullableNumber(value['targetRepetitionsPerSet']) ||
    !isNullableNumber(value['targetDurationSeconds']) ||
    !isNullableNumber(value['restSeconds'])
  ) {
    throw invalidResponse();
  }
  let drill: TrainingPlanItem['drill'] = null;
  if (value['drill'] !== null) {
    if (
      !isRecord(value['drill']) ||
      typeof value['drill']['saved'] !== 'boolean'
    ) {
      throw invalidResponse();
    }
    drill = {
      slug: requiredString(value['drill'], 'slug'),
      title: requiredString(value['drill'], 'title'),
      description: requiredString(value['drill'], 'description'),
      coachName: requiredString(value['drill'], 'coachName'),
      equipment: Array.isArray(value['drill']['equipment'])
        ? value['drill']['equipment']
        : [],
      saved: value['drill']['saved'],
    };
  }
  if ((kind === 'reassessment') !== (drill === null)) throw invalidResponse();
  return {
    id: requiredUuid(value, 'id'),
    position,
    kind,
    drill,
    cueText: value['cueText'],
    targetSets: value['targetSets'],
    targetRepetitionsPerSet: value['targetRepetitionsPerSet'],
    targetDurationSeconds: value['targetDurationSeconds'],
    restSeconds: value['restSeconds'],
    completion:
      value['completion'] === null
        ? null
        : parseCompletion(value['completion']),
  };
}

function parsePlan(value: unknown): TrainingPlan {
  if (!isRecord(value) || !Array.isArray(value['items']))
    throw invalidResponse();
  const status = value['status'];
  if (
    status !== 'active' &&
    status !== 'completed' &&
    status !== 'superseded'
  ) {
    throw invalidResponse();
  }
  const baselineScore = value['baselineScore'];
  if (
    !isFiniteNumber(baselineScore) ||
    !isNullableNumber(value['baselineCheckpointScore']) ||
    !isNullableNumber(value['scoreDelta']) ||
    !isNullableString(value['reassessmentShotId']) ||
    !isIso(value['createdAt']) ||
    !(value['completedAt'] === null || isIso(value['completedAt']))
  ) {
    throw invalidResponse();
  }
  return {
    id: requiredUuid(value, 'id'),
    status,
    algorithmVersion: requiredString(value, 'algorithmVersion'),
    sourceShotId: requiredUuid(value, 'sourceShotId'),
    shotType: requiredString(value, 'shotType'),
    priorityCheckpoint: requiredString(value, 'priorityCheckpoint'),
    priorityDirection: requiredString(value, 'priorityDirection'),
    baselineScore,
    baselineCheckpointScore: value['baselineCheckpointScore'],
    reassessmentShotId: nullableUuid(value, 'reassessmentShotId'),
    scoreDelta: value['scoreDelta'],
    createdAt: value['createdAt'],
    completedAt: value['completedAt'],
    items: value['items'].map(parsePlanItem),
  };
}

function configured(config: TrainingApiConfig): {
  baseUrl: string;
  token: string;
  fetchFn: TrainingFetch;
} {
  const baseUrl = config.baseUrl?.trim().replace(/\/+$/, '');
  const token = config.token?.trim();
  if (!baseUrl || !token) {
    throw new TrainingError(
      'training.unconfigured',
      'Sign in to a synced account before loading training plans.',
      false,
    );
  }
  const fetchFn = config.fetchFn ?? globalThis.fetch;
  if (!fetchFn) {
    throw new TrainingError(
      'training.unconfigured',
      'Network access is not configured in this build.',
      false,
    );
  }
  return { baseUrl, token, fetchFn };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw invalidResponse();
  }
}

export function createTrainingApi(config: TrainingApiConfig): TrainingApi {
  const request = async (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const values = configured(config);
    let response: Response;
    try {
      response = await values.fetchFn(`${values.baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${values.token}`,
          'X-Client-Version': '0.1.0',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new TrainingError(
        'training.unavailable',
        'Training is temporarily offline. Your existing reads are still safe.',
        true,
      );
    }
    if (response.status === 204) return null;
    const payload = await readJson(response);
    if (!response.ok) {
      const error =
        isRecord(payload) && isRecord(payload['error'])
          ? payload['error']
          : null;
      throw new TrainingError(
        error && isString(error['code'])
          ? error['code']
          : 'training.request_failed',
        error && isString(error['message'])
          ? error['message']
          : 'The training request could not be completed.',
        response.status >= 500 || response.status === 429,
        response.status,
      );
    }
    return payload;
  };

  const detailPath = (slug: string) =>
    `/v1/catalog/drills/${encodeURIComponent(slug)}`;

  return {
    listSavedDrills: async () => {
      const payload = await request('GET', '/v1/me/saved-drills');
      if (!isRecord(payload) || !Array.isArray(payload['items'])) {
        throw invalidResponse();
      }
      return payload['items'].map(parseSavedDrill);
    },
    getDrill: async slug =>
      parseDrillDetail(await request('GET', detailPath(slug))),
    saveDrill: async slug => {
      const payload = await request(
        'PUT',
        `/v1/me/saved-drills/${encodeURIComponent(slug)}`,
      );
      if (
        !isRecord(payload) ||
        payload['slug'] !== slug ||
        payload['saved'] !== true
      ) {
        throw invalidResponse();
      }
    },
    unsaveDrill: async slug => {
      await request(
        'DELETE',
        `/v1/me/saved-drills/${encodeURIComponent(slug)}`,
      );
    },
    getCurrentPlan: async () => {
      const payload = await request('GET', '/v1/training-plans/current');
      if (!isRecord(payload)) throw invalidResponse();
      return payload['plan'] === null ? null : parsePlan(payload['plan']);
    },
    createPlan: async sourceShotId => {
      const payload = await request('POST', '/v1/training-plans', {
        sourceShotId,
      });
      if (!isRecord(payload) || payload['plan'] === null)
        throw invalidResponse();
      return parsePlan(payload['plan']);
    },
    completeDrill: async evidence => {
      const payload = await request('POST', '/v1/drill-completions', evidence);
      if (!isRecord(payload)) throw invalidResponse();
      return parseCompletion(payload['completion']);
    },
    reassessPlan: async (planId, shotId) => {
      const payload = await request(
        'POST',
        `/v1/training-plans/${encodeURIComponent(planId)}/reassessment`,
        { shotId },
      );
      if (!isRecord(payload) || payload['plan'] === null)
        throw invalidResponse();
      return parsePlan(payload['plan']);
    },
  };
}
