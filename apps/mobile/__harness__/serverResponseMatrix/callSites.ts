/**
 * Every mobile → `supabase/functions/api` call site, wrapped so the matrix can
 * invoke it against the scenario server and classify the outcome uniformly.
 *
 * `source` is the fetch call in the client module; `consumer` is where the
 * app reacts to a rejection (store / screen / outbox), so a finding can be
 * pinned to both ends. `goodBody` is a payload the client's parser accepts —
 * the fuzzers mutate it, the oversized scenario pads it, the prefix/truncated
 * scenarios cut it.
 */
import type { ApiSession } from '../../src/account/apiSession';
import {
  bootstrapCanonicalAccount,
  AccountBootstrapError,
} from '../../src/account/bootstrap';
import {
  ConsentApiError,
  fetchConsentStatus,
  grantEvaluationTelemetryConsent,
  grantModelTrainingConsent,
  withdrawEvaluationTelemetryConsent,
  withdrawModelTrainingConsent,
} from '../../src/account/consentApi';
import {
  AccountDeletionError,
  confirmAccountDeletion,
  requestAccountDeletion,
} from '../../src/account/deletion';
import {
  fetchCanonicalOnboardingProfile,
  OnboardingSyncError,
  saveCanonicalOnboardingProfile,
} from '../../src/account/onboarding';
import {
  refreshApiSession,
  revokeApiSession,
  SessionRefreshError,
} from '../../src/account/sessionLifecycle';
import { createCanonicalAccessClient } from '../../src/billing/accessApi';
import { BillingError } from '../../src/billing/types';
import {
  ApiError,
  createAnalysisPermitClient,
  createTransport,
  submitAnalysisFeedback,
} from '../../src/data/api';
import { isPermanentSyncFailure } from '../../src/data/sync';
import {
  fetchCanonicalProgress,
  ProgressApiError,
} from '../../src/progress/api';
import {
  fetchPlayerRank,
  PlayerRankApiError,
} from '../../src/progress/playerRank';
import { createTrainingApi } from '../../src/training/api';
import { TrainingError } from '../../src/training/types';

export const HARNESS_UUID = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
export const HARNESS_UUID_2 = '1a2b3c4d-5e6f-4788-9900-aabbccddeeff';
export const HARNESS_UUID_3 = '2b3c4d5e-6f70-4899-aa11-bbccddeeff00';
const ISO = '2026-09-01T12:00:00.000Z';

export type CallSiteFamily =
  | 'outbox'
  | 'permit'
  | 'feedback'
  | 'training'
  | 'billing'
  | 'progress'
  | 'rank'
  | 'bootstrap'
  | 'onboarding'
  | 'consent'
  | 'deletion'
  | 'session';

/**
 * How a resolved value must be read:
 *  - `value`: resolution means the server delivered a parsed payload; any
 *    resolution on a malformed 2xx body is a fake success.
 *  - `nullable`: `null` is a legitimate parsed answer (no plan / unranked /
 *    no profile) — a malformed 2xx resolving to `null` is therefore a silent
 *    misread, tracked separately from fake success.
 *  - `void`: nothing is parsed; a 2xx of any body is by design a success.
 *  - `best_effort`: the client swallows every failure on purpose (logout).
 */
export type ReturnContract = 'value' | 'nullable' | 'void' | 'best_effort';

export interface InvokeContext {
  baseUrl: string;
  token: string;
  canonicalAppUserId: string;
}

export interface CallSite {
  id: string;
  family: CallSiteFamily;
  method: string;
  path: string;
  source: string;
  consumer: string;
  returns: ReturnContract;
  /** A 2xx body the client's parser accepts; `status` when not 200. */
  good: { body?: unknown; status?: number };
  /**
   * `nullable` sites whose documented "absent" signal is the good body with
   * its top-level value(s) set to null (e.g. `{plan: null}`, `{rank: null}`):
   * resolving null on the keys-nulled scenarios is the contract, not a
   * silent-null violation.
   */
  nullOnNulledKeys?: true;
  invoke(ctx: InvokeContext): Promise<unknown>;
}

function session(ctx: InvokeContext): ApiSession {
  return {
    apiBaseUrl: ctx.baseUrl,
    bearerToken: ctx.token,
    canonicalAppUserId: ctx.canonicalAppUserId,
    provider: 'apple',
    refreshToken: 'harness-refresh-token',
    bearerExpiresAtMs: Date.now() + 3_600_000,
  };
}

const GOOD_ACCESS = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 1,
    reserved: 0,
    remaining: 1,
    availableToReserve: 1,
  },
  canStartRating: true,
  paywallRequired: false,
};

const GOOD_CATALOG_DRILL = {
  id: HARNESS_UUID,
  slug: 'dink-wall-rally',
  title: 'Dink wall rally',
  description: 'Soft dinks against a wall.',
  coach_name: 'Coach A',
  equipment: ['paddle', 'ball'],
  difficulty_min: 'beginner',
  difficulty_max: null,
  families: ['dinks'],
  validation_state: 'UNVALIDATED',
  saved: false,
};

const GOOD_SAVED_DRILL = {
  id: HARNESS_UUID,
  slug: 'dink-wall-rally',
  title: 'Dink wall rally',
  description: 'Soft dinks against a wall.',
  coach_name: 'Coach A',
  equipment: ['paddle'],
  difficulty_min: null,
  difficulty_max: null,
  saved_at: ISO,
};

const GOOD_MAPPING = {
  checkpoint: 'contact_position',
  shot_type: 'dink',
  plan_role: 'targeted',
  fault_directions: ['late'],
  cue_text: 'Contact out front.',
  target_sets: 2,
  target_repetitions_per_set: 10,
  target_duration_seconds: null,
  rest_seconds: 30,
};

const GOOD_DRILL_DETAIL = {
  drill: { ...GOOD_CATALOG_DRILL, saved: true },
  mappings: [GOOD_MAPPING],
  instructionalMedia: [],
};

const GOOD_COMPLETION = {
  id: HARNESS_UUID_2,
  completedAt: ISO,
  actualRepetitions: 10,
  actualDurationSeconds: null,
  qualifiesForStreak: true,
};

const GOOD_PLAN = {
  id: HARNESS_UUID,
  status: 'active',
  algorithmVersion: 'plan-v1',
  sourceShotId: HARNESS_UUID_2,
  shotType: 'dink',
  priorityCheckpoint: 'contact_position',
  priorityDirection: 'late',
  baselineScore: 5.5,
  baselineCheckpointScore: 4.5,
  scoreDelta: null,
  reassessmentShotId: null,
  createdAt: ISO,
  completedAt: null,
  items: [
    {
      id: HARNESS_UUID_3,
      position: 1,
      kind: 'targeted',
      drill: {
        slug: 'dink-wall-rally',
        title: 'Dink wall rally',
        description: 'Soft dinks against a wall.',
        coachName: 'Coach A',
        equipment: [],
        saved: false,
      },
      cueText: 'Contact out front.',
      targetSets: 2,
      targetRepetitionsPerSet: 10,
      targetDurationSeconds: null,
      restSeconds: 30,
      completion: null,
    },
  ],
};

export const GOOD_SYNC_SHOT_ID = HARNESS_UUID;
export const GOOD_TRIAL_ID = HARNESS_UUID_2;

export const CALL_SITES: readonly CallSite[] = [
  // ── src/data/api.ts — shared `request` helper (20 s timeout) ──────────────
  {
    id: 'data.transport.syncShots',
    family: 'outbox',
    method: 'POST',
    path: '/v1/shots:sync',
    source: 'apps/mobile/src/data/api.ts:118',
    consumer: 'apps/mobile/src/data/sync.ts:216',
    returns: 'value',
    good: { body: { acceptedIds: [GOOD_SYNC_SHOT_ID], rejected: [] } },
    invoke: ctx =>
      createTransport({ baseUrl: ctx.baseUrl, token: ctx.token }).syncShots([
        { id: GOOD_SYNC_SHOT_ID },
      ]),
  },
  {
    id: 'data.transport.createSession',
    family: 'outbox',
    method: 'POST',
    path: '/v1/sessions',
    source: 'apps/mobile/src/data/api.ts:121',
    consumer: 'apps/mobile/src/data/sync.ts:171',
    returns: 'void',
    good: { body: { id: HARNESS_UUID } },
    invoke: ctx =>
      createTransport({ baseUrl: ctx.baseUrl, token: ctx.token }).createSession(
        { id: HARNESS_UUID, startedAt: ISO },
      ),
  },
  {
    id: 'data.transport.finalizeSession',
    family: 'outbox',
    method: 'POST',
    path: `/v1/sessions/${HARNESS_UUID}/finalize`,
    source: 'apps/mobile/src/data/api.ts:124',
    consumer: 'apps/mobile/src/data/sync.ts:172',
    returns: 'void',
    good: { body: { id: HARNESS_UUID, endedAt: ISO } },
    invoke: ctx =>
      createTransport({
        baseUrl: ctx.baseUrl,
        token: ctx.token,
      }).finalizeSession(HARNESS_UUID),
  },
  {
    id: 'data.transport.uploadEvaluationTrials',
    family: 'outbox',
    method: 'POST',
    path: '/v1/me/evaluation/trials',
    source: 'apps/mobile/src/data/api.ts:127',
    consumer: 'apps/mobile/src/data/sync.ts:286',
    returns: 'value',
    good: { body: { acceptedTrialIds: [GOOD_TRIAL_ID], rejected: [] } },
    invoke: ctx => {
      const transport = createTransport({
        baseUrl: ctx.baseUrl,
        token: ctx.token,
      });
      if (!transport.uploadEvaluationTrials) {
        throw new Error('transport lacks uploadEvaluationTrials');
      }
      return transport.uploadEvaluationTrials([{ trialId: GOOD_TRIAL_ID }]);
    },
  },
  {
    id: 'data.permits.reserve',
    family: 'permit',
    method: 'POST',
    path: '/v1/analysis-permits',
    source: 'apps/mobile/src/data/api.ts:151',
    consumer: 'apps/mobile/src/analysis/runCaptureAnalysis.ts:259',
    returns: 'value',
    good: {
      body: {
        permit: {
          id: HARNESS_UUID,
          accessSource: 'free',
          status: 'reserved',
          expiresAt: ISO,
        },
        access: GOOD_ACCESS,
      },
    },
    invoke: ctx =>
      createAnalysisPermitClient({
        baseUrl: ctx.baseUrl,
        token: ctx.token,
      }).reserve(HARNESS_UUID_2),
  },
  {
    id: 'data.permits.release',
    family: 'permit',
    method: 'POST',
    path: `/v1/analysis-permits/${HARNESS_UUID}/finalize`,
    source: 'apps/mobile/src/data/api.ts:176',
    consumer: 'apps/mobile/src/analysis/runCaptureAnalysis.ts:347',
    returns: 'void',
    good: { body: { permit: { id: HARNESS_UUID, status: 'released' } } },
    invoke: ctx =>
      createAnalysisPermitClient({
        baseUrl: ctx.baseUrl,
        token: ctx.token,
      }).release(HARNESS_UUID, 'failed'),
  },
  {
    id: 'data.submitAnalysisFeedback',
    family: 'feedback',
    method: 'POST',
    path: `/v1/analyses/${HARNESS_UUID}/feedback`,
    source: 'apps/mobile/src/data/api.ts:226',
    consumer: 'apps/mobile/src/components/AnalysisFeedbackPrompt.tsx:46',
    returns: 'value',
    good: { body: { feedback: { reviewEligible: true } } },
    invoke: ctx =>
      submitAnalysisFeedback(
        { baseUrl: ctx.baseUrl, token: ctx.token },
        HARNESS_UUID,
        'not_quite',
        'wrong_stroke',
      ),
  },

  // ── src/training/api.ts — no request timeout ─────────────────────────────
  {
    id: 'training.listCatalogDrills',
    family: 'training',
    method: 'GET',
    path: '/v1/catalog/drills?family=dinks',
    source: 'apps/mobile/src/training/api.ts:426',
    consumer: 'apps/mobile/src/screens/LibraryScreen.tsx (catalog load)',
    returns: 'value',
    good: { body: { items: [GOOD_CATALOG_DRILL] } },
    invoke: ctx =>
      createTrainingApi({
        baseUrl: ctx.baseUrl,
        token: ctx.token,
      }).listCatalogDrills({ family: 'dinks' }),
  },
  {
    id: 'training.listSavedDrills',
    family: 'training',
    method: 'GET',
    path: '/v1/me/saved-drills',
    source: 'apps/mobile/src/training/api.ts:426',
    consumer: 'apps/mobile/src/training/store.ts:112',
    returns: 'value',
    good: { body: { items: [GOOD_SAVED_DRILL] } },
    invoke: ctx =>
      createTrainingApi({
        baseUrl: ctx.baseUrl,
        token: ctx.token,
      }).listSavedDrills(),
  },
  {
    id: 'training.getDrill',
    family: 'training',
    method: 'GET',
    path: '/v1/catalog/drills/dink-wall-rally',
    source: 'apps/mobile/src/training/api.ts:426',
    consumer: 'apps/mobile/src/training/store.ts:81',
    returns: 'value',
    good: { body: GOOD_DRILL_DETAIL },
    invoke: ctx =>
      createTrainingApi({ baseUrl: ctx.baseUrl, token: ctx.token }).getDrill(
        'dink-wall-rally',
      ),
  },
  {
    id: 'training.saveDrill',
    family: 'training',
    method: 'PUT',
    path: '/v1/me/saved-drills/dink-wall-rally',
    source: 'apps/mobile/src/training/api.ts:426',
    consumer: 'apps/mobile/src/training/store.ts:269',
    returns: 'void',
    good: { body: { slug: 'dink-wall-rally', saved: true } },
    invoke: ctx =>
      createTrainingApi({ baseUrl: ctx.baseUrl, token: ctx.token }).saveDrill(
        'dink-wall-rally',
      ),
  },
  {
    id: 'training.unsaveDrill',
    family: 'training',
    method: 'DELETE',
    path: '/v1/me/saved-drills/dink-wall-rally',
    source: 'apps/mobile/src/training/api.ts:426',
    consumer: 'apps/mobile/src/training/store.ts:269',
    returns: 'void',
    good: { status: 204 },
    invoke: ctx =>
      createTrainingApi({
        baseUrl: ctx.baseUrl,
        token: ctx.token,
      }).unsaveDrill('dink-wall-rally'),
  },
  {
    id: 'training.getCurrentPlan',
    family: 'training',
    method: 'GET',
    path: '/v1/training-plans/current',
    source: 'apps/mobile/src/training/api.ts:426',
    consumer: 'apps/mobile/src/training/store.ts:151',
    returns: 'nullable',
    nullOnNulledKeys: true,
    good: { body: { plan: GOOD_PLAN } },
    invoke: ctx =>
      createTrainingApi({
        baseUrl: ctx.baseUrl,
        token: ctx.token,
      }).getCurrentPlan(),
  },
  {
    id: 'training.createPlan',
    family: 'training',
    method: 'POST',
    path: '/v1/training-plans',
    source: 'apps/mobile/src/training/api.ts:426',
    consumer: 'apps/mobile/src/training/store.ts:200',
    returns: 'value',
    good: { body: { plan: GOOD_PLAN } },
    invoke: ctx =>
      createTrainingApi({ baseUrl: ctx.baseUrl, token: ctx.token }).createPlan(
        HARNESS_UUID_2,
      ),
  },
  {
    id: 'training.completeDrill',
    family: 'training',
    method: 'POST',
    path: '/v1/drill-completions',
    source: 'apps/mobile/src/training/api.ts:426',
    consumer: 'apps/mobile/src/training/store.ts:330',
    returns: 'value',
    good: { body: { completion: GOOD_COMPLETION } },
    invoke: ctx =>
      createTrainingApi({
        baseUrl: ctx.baseUrl,
        token: ctx.token,
      }).completeDrill({
        id: HARNESS_UUID_2,
        drillSlug: 'dink-wall-rally',
        trainingPlanItemId: HARNESS_UUID_3,
        completedAt: ISO,
        actualRepetitions: 10,
        actualDurationSeconds: null,
      }),
  },
  {
    id: 'training.reassessPlan',
    family: 'training',
    method: 'POST',
    path: `/v1/training-plans/${HARNESS_UUID}/reassessment`,
    source: 'apps/mobile/src/training/api.ts:426',
    consumer: 'apps/mobile/src/training/store.ts:240',
    returns: 'value',
    good: { body: { plan: GOOD_PLAN } },
    invoke: ctx =>
      createTrainingApi({
        baseUrl: ctx.baseUrl,
        token: ctx.token,
      }).reassessPlan(HARNESS_UUID, HARNESS_UUID_2),
  },

  // ── src/billing/accessApi.ts — no request timeout ────────────────────────
  {
    id: 'billing.getAccess',
    family: 'billing',
    method: 'GET',
    path: '/v1/me/access',
    source: 'apps/mobile/src/billing/accessApi.ts:162',
    consumer: 'apps/mobile/src/state/accessStore.ts:133',
    returns: 'value',
    good: { body: GOOD_ACCESS },
    invoke: ctx =>
      createCanonicalAccessClient({
        baseUrl: ctx.baseUrl,
        token: ctx.token,
      }).getAccess(),
  },
  {
    id: 'billing.syncBilling',
    family: 'billing',
    method: 'POST',
    path: '/v1/billing/sync',
    source: 'apps/mobile/src/billing/accessApi.ts:162',
    consumer: 'apps/mobile/src/state/accessStore.ts:232',
    returns: 'value',
    good: {
      body: {
        billing: {
          premium: false,
          productKey: null,
          expiresAt: null,
          verifiedAt: ISO,
        },
        access: GOOD_ACCESS,
      },
    },
    invoke: ctx =>
      createCanonicalAccessClient({
        baseUrl: ctx.baseUrl,
        token: ctx.token,
      }).syncBilling(),
  },

  // ── src/progress ─────────────────────────────────────────────────────────
  {
    id: 'progress.fetchCanonicalProgress',
    family: 'progress',
    method: 'GET',
    path: '/v1/progress',
    source: 'apps/mobile/src/progress/api.ts:148',
    consumer: 'apps/mobile/src/screens/HomeScreen.tsx:135',
    returns: 'value',
    good: {
      body: {
        series: [
          {
            day: '2026-09-01',
            shot_type: 'dink',
            scoring_model_version: 'v1',
            shot_count: 3,
            avg_score: 55,
            best_score: 70,
          },
        ],
        improving: [{ checkpoint: 'contact_position', delta: 0.4 }],
        needsAttention: [{ checkpoint: 'preparation', avg: 4.1 }],
        streak: {
          currentDays: 1,
          longestDays: 3,
          practicedToday: true,
          lastPracticeDate: '2026-09-01',
        },
      },
    },
    invoke: ctx => fetchCanonicalProgress(session(ctx)),
  },
  {
    id: 'progress.fetchPlayerRank',
    family: 'rank',
    method: 'GET',
    path: '/v1/rank',
    source: 'apps/mobile/src/progress/playerRank.ts:139',
    consumer: 'apps/mobile/src/components/PlayerRankCard.tsx:52',
    returns: 'nullable',
    nullOnNulledKeys: true,
    good: {
      body: {
        rank: {
          rating: 5.5,
          tier: 'intermediate',
          techniqueCount: 1,
          scoredShotCount: 3,
          updatedAt: ISO,
          techniques: [
            {
              shot_type: 'dink',
              score: 55,
              captured_at: ISO,
              sampled_count: 3,
            },
          ],
        },
      },
    },
    invoke: ctx => fetchPlayerRank(session(ctx)),
  },

  // ── src/account ──────────────────────────────────────────────────────────
  {
    id: 'account.bootstrapCanonicalAccount',
    family: 'bootstrap',
    method: 'POST',
    path: '/v1/account/bootstrap',
    source: 'apps/mobile/src/account/bootstrap.ts:200',
    consumer: 'apps/mobile/src/auth/authStore.ts (signIn / hydrate)',
    returns: 'value',
    good: {
      body: {
        user: { id: HARNESS_UUID, email: null },
        onboardingState: 'pending',
        session: {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresAt: 1_800_000_000,
        },
      },
    },
    invoke: ctx =>
      bootstrapCanonicalAccount({
        apiBaseUrl: ctx.baseUrl,
        bearerToken: ctx.token,
        provider: 'apple',
        environment: {
          locale: 'en-US',
          timezone: 'UTC',
          device: {
            platform: 'ios',
            osVersion: '18.0',
            appVersion: '1.0.0',
            model: 'iPhone',
          },
        },
      }),
  },
  {
    id: 'account.fetchCanonicalOnboardingProfile',
    family: 'onboarding',
    method: 'GET',
    path: '/v1/me',
    source: 'apps/mobile/src/account/onboarding.ts:44',
    consumer: 'apps/mobile/src/state/appStore.ts:138',
    returns: 'nullable',
    good: {
      body: {
        onboardingState: 'complete',
        profile: {
          skill_level: 'beginner',
          handedness: 'right',
          primary_goal: 'dinks',
          biggest_problem: 'consistency',
        },
      },
    },
    invoke: ctx => fetchCanonicalOnboardingProfile(session(ctx)),
  },
  {
    id: 'account.saveCanonicalOnboardingProfile',
    family: 'onboarding',
    method: 'PUT',
    path: '/v1/me/onboarding',
    source: 'apps/mobile/src/account/onboarding.ts:44',
    consumer: 'apps/mobile/src/state/appStore.ts:170',
    returns: 'value',
    good: { body: { recommendedCheckpoint: 'contact_position' } },
    invoke: ctx =>
      saveCanonicalOnboardingProfile(session(ctx), {
        skillLevel: 'beginner',
        handedness: 'right',
        goal: 'dinks',
        biggestProblem: 'consistency',
        focusCheckpoint: 'contact_position',
      }),
  },
  {
    id: 'account.fetchConsentStatus',
    family: 'consent',
    method: 'GET',
    path: '/v1/me/consent/status',
    source: 'apps/mobile/src/account/consentApi.ts:120',
    consumer: 'apps/mobile/src/state/consentStore.ts:88',
    returns: 'value',
    good: {
      body: {
        subjectPseudonym: null,
        scopes: [
          {
            scope: 'model_training',
            active: true,
            lastAction: 'granted',
            lastActionAt: ISO,
            consentVersion: 'model-training-v1',
          },
        ],
      },
    },
    invoke: ctx => fetchConsentStatus(session(ctx)),
  },
  {
    id: 'account.grantModelTrainingConsent',
    family: 'consent',
    method: 'POST',
    path: '/v1/me/consent/grant',
    source: 'apps/mobile/src/account/consentApi.ts:120',
    consumer: 'apps/mobile/src/state/consentStore.ts:123',
    returns: 'value',
    good: {
      body: {
        subjectPseudonym: 'p',
        scopes: [
          {
            scope: 'model_training',
            active: true,
            lastAction: 'granted',
            lastActionAt: ISO,
            consentVersion: 'model-training-v1',
          },
        ],
      },
    },
    invoke: ctx => grantModelTrainingConsent(session(ctx), 'iPhone'),
  },
  {
    id: 'account.withdrawModelTrainingConsent',
    family: 'consent',
    method: 'POST',
    path: '/v1/me/consent/withdraw',
    source: 'apps/mobile/src/account/consentApi.ts:120',
    consumer: 'apps/mobile/src/state/consentStore.ts:124',
    returns: 'value',
    good: {
      body: {
        subjectPseudonym: 'p',
        scopes: [
          {
            scope: 'model_training',
            active: false,
            lastAction: 'withdrawn',
            lastActionAt: ISO,
            consentVersion: 'model-training-v1',
          },
        ],
      },
    },
    invoke: ctx => withdrawModelTrainingConsent(session(ctx), 'iPhone'),
  },
  {
    id: 'account.grantEvaluationTelemetryConsent',
    family: 'consent',
    method: 'POST',
    path: '/v1/me/consent/grant',
    source: 'apps/mobile/src/account/consentApi.ts:120',
    consumer: 'apps/mobile/src/state/consentStore.ts (evaluation telemetry)',
    returns: 'value',
    good: {
      body: {
        subjectPseudonym: 'p',
        scopes: [
          {
            scope: 'evaluation_telemetry',
            active: true,
            lastAction: 'granted',
            lastActionAt: ISO,
            consentVersion: 'evaluation-telemetry-v1',
          },
        ],
      },
    },
    invoke: ctx => grantEvaluationTelemetryConsent(session(ctx), 'iPhone'),
  },
  {
    id: 'account.withdrawEvaluationTelemetryConsent',
    family: 'consent',
    method: 'POST',
    path: '/v1/me/consent/withdraw',
    source: 'apps/mobile/src/account/consentApi.ts:120',
    consumer: 'apps/mobile/src/state/consentStore.ts (evaluation telemetry)',
    returns: 'value',
    good: {
      body: {
        subjectPseudonym: 'p',
        scopes: [
          {
            scope: 'evaluation_telemetry',
            active: false,
            lastAction: 'withdrawn',
            lastActionAt: ISO,
            consentVersion: 'evaluation-telemetry-v1',
          },
        ],
      },
    },
    invoke: ctx => withdrawEvaluationTelemetryConsent(session(ctx), 'iPhone'),
  },
  {
    id: 'account.requestAccountDeletion',
    family: 'deletion',
    method: 'POST',
    path: '/v1/me/delete-request',
    source: 'apps/mobile/src/account/deletion.ts:110',
    consumer: 'apps/mobile/src/screens/SettingsScreen.tsx (delete account)',
    returns: 'value',
    good: { body: { challenge: 'challenge-token', expiresAt: ISO } },
    invoke: ctx =>
      requestAccountDeletion(session(ctx), {
        reason: 'other',
        wanted: null,
        details: null,
        platform: 'ios',
        appVersion: '1.0.0',
      }),
  },
  {
    id: 'account.confirmAccountDeletion',
    family: 'deletion',
    method: 'POST',
    path: '/v1/me/delete-confirm',
    source: 'apps/mobile/src/account/deletion.ts:110',
    consumer: 'apps/mobile/src/screens/SettingsScreen.tsx (delete account)',
    returns: 'value',
    good: {
      body: { deleted: true, appleAuthorizationRevocation: 'not_applicable' },
    },
    invoke: ctx => confirmAccountDeletion(session(ctx), 'challenge-token'),
  },
  {
    id: 'account.refreshApiSession',
    family: 'session',
    method: 'POST',
    path: '/v1/auth/refresh',
    source: 'apps/mobile/src/account/sessionLifecycle.ts:72',
    consumer: 'apps/mobile/src/account/sessionKeeper.ts (rotation loop)',
    returns: 'value',
    good: {
      body: {
        session: {
          accessToken: 'access-token-2',
          refreshToken: 'refresh-token-2',
          expiresAt: 1_800_000_000,
        },
      },
    },
    invoke: ctx =>
      refreshApiSession({
        apiBaseUrl: ctx.baseUrl,
        refreshToken: 'harness-refresh-token',
      }),
  },
  {
    id: 'account.revokeApiSession',
    family: 'session',
    method: 'POST',
    path: '/v1/auth/logout',
    source: 'apps/mobile/src/account/sessionLifecycle.ts:131',
    consumer: 'apps/mobile/src/auth/authStore.ts (signOut)',
    returns: 'best_effort',
    good: { body: { revoked: true } },
    invoke: ctx => revokeApiSession(session(ctx)),
  },
];

/** Uniform view of a rejection, whatever error class the client uses. */
export interface ClassifiedError {
  name: string;
  message: string;
  code: string | null;
  status: number | null;
  /**
   * The client's own retry verdict: the error class's `retryable` flag, or
   * `!isPermanentSyncFailure` for the outbox transport's `ApiError`.
   * `null` when the class carries no verdict (consumer just shows "unavailable").
   */
  retryable: boolean | null;
  /** True for a bare TypeError/RangeError/etc. — a parser crash, not a typed API error. */
  untyped: boolean;
}

function isErrorLike(
  value: unknown,
): value is { name: string; message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof ApiError) {
    return {
      name: 'ApiError',
      message: error.message,
      code: error.code,
      status: error.status,
      retryable: !isPermanentSyncFailure(error),
      untyped: false,
    };
  }
  if (error instanceof TrainingError) {
    return {
      name: 'TrainingError',
      message: error.message,
      code: error.code,
      status: error.status,
      retryable: error.retryable,
      untyped: false,
    };
  }
  if (error instanceof BillingError) {
    return {
      name: 'BillingError',
      message: error.message,
      code: error.code,
      status: null,
      retryable: error.retryable,
      untyped: false,
    };
  }
  if (error instanceof AccountBootstrapError) {
    return {
      name: 'AccountBootstrapError',
      message: error.message,
      code: error.code,
      status: null,
      retryable: error.retryable,
      untyped: false,
    };
  }
  if (error instanceof AccountDeletionError) {
    return {
      name: 'AccountDeletionError',
      message: error.message,
      code: error.code,
      status: null,
      retryable: error.retryable,
      untyped: false,
    };
  }
  if (error instanceof SessionRefreshError) {
    return {
      name: 'SessionRefreshError',
      message: error.message,
      code: null,
      status: null,
      retryable: error.retryable,
      untyped: false,
    };
  }
  if (
    error instanceof OnboardingSyncError ||
    error instanceof ConsentApiError ||
    error instanceof ProgressApiError ||
    error instanceof PlayerRankApiError
  ) {
    return {
      name: error.constructor.name,
      message: error.message,
      code: null,
      status: null,
      retryable: null,
      untyped: false,
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: null,
      status: null,
      retryable: null,
      untyped: true,
    };
  }
  // undici's `TypeError: fetch failed` is constructed in Node's realm, so
  // `instanceof Error` is false inside the Jest vm context; the app (one
  // realm) would see a plain TypeError. Classify by shape.
  if (isErrorLike(error)) {
    return {
      name: `${error.name} (foreign realm)`,
      message: error.message,
      code: null,
      status: null,
      retryable: null,
      untyped: true,
    };
  }
  return {
    name: 'non-error',
    message: String(error),
    code: null,
    status: null,
    retryable: null,
    untyped: true,
  };
}
