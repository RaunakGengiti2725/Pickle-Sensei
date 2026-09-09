import type {
  AnalysisReleaseApproval,
  AnalysisReleasePolicyDocument,
} from '@pickle/shared-types';
import { ANALYSIS_RELEASE_POLICY_PATH } from '../src/data/api';
import {
  RELEASE_AUTHORITY_SCHEMA_VERSION,
  canonicalizeReleasePolicyJson,
  digestReleasePolicyJson,
} from '../src/analysis/releasePolicyClient';

/**
 * The `GET /v1/analysis/release-policy` answer a simulated server gives when a
 * release policy is installed and active: a self-consistent document, its
 * canonical bytes and an approval whose digest binds them, valid around the
 * suite's clock. Fake servers that only knew the permit routes answer this so
 * the numerical path they exercise stays authorized exactly as production is.
 */
export interface ReleaseAuthorityBody {
  schemaVersion: typeof RELEASE_AUTHORITY_SCHEMA_VERSION;
  serverTime: number;
  policy: {
    document: AnalysisReleasePolicyDocument;
    canonicalDocument: string;
    approval: AnalysisReleaseApproval;
  } | null;
}

const artifact = { version: 'fixture-1', sha256: 'a'.repeat(64) };
const lineage = {
  pipeline: artifact,
  definition: artifact,
  model: artifact,
  preprocessing: artifact,
  calibration: artifact,
  dataset: artifact,
  validationReport: artifact,
  supportedDomain: artifact,
};

export function isReleasePolicyRequest(url: string): boolean {
  return url.endsWith(ANALYSIS_RELEASE_POLICY_PATH);
}

/** The recorded fetch calls that are NOT the release-policy read — i.e. the
 * permit traffic a suite counts to prove "one reservation and nothing else". */
export function permitCalls(fetchMock: {
  mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> };
}): ReadonlyArray<ReadonlyArray<unknown>> {
  return fetchMock.mock.calls.filter(
    ([url]) => !isReleasePolicyRequest(String(url)),
  );
}

export function activeReleasePolicyDocument(
  nowMs = Date.now(),
): AnalysisReleasePolicyDocument {
  const validFrom = Math.floor(nowMs / 1000) - 86_400;
  return {
    schemaVersion: 'analysis-release-policy-v1',
    version: 'test-support-active-policy-1',
    validFrom,
    validUntil: validFrom + 366 * 86_400,
    mechanics: { lineage },
    benchmark: {
      lineage,
      uncertainty: {
        kind: 'calibrated_prediction_interval',
        nominalCoverage: 0.9,
        coverageScope: 'supported_slice',
        calibrationUnit: 'player_session',
      },
      maximumIntervalWidth: 1.5,
      boundaryStep: 0.25,
      supportedIntervals: [{ lower: 3, upper: 5 }],
    },
    supportedInputs: [
      {
        shotType: 'forehand_drive',
        cameraView: 'side',
        handedness: 'right',
        captureMode: 'automatic_pose_trigger',
      },
    ],
  };
}

/** A 200 `Response` carrying `activeReleaseAuthority()`, for fake servers
 * that build their own permit responses inline. */
export function activeReleaseAuthorityResponse(nowMs = Date.now()): Response {
  const body = activeReleaseAuthority(nowMs);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

export function activeReleaseAuthority(
  nowMs = Date.now(),
): ReleaseAuthorityBody {
  const document = activeReleasePolicyDocument(nowMs);
  return {
    schemaVersion: RELEASE_AUTHORITY_SCHEMA_VERSION,
    serverTime: Math.floor(nowMs / 1000),
    policy: {
      document,
      canonicalDocument: canonicalizeReleasePolicyJson(document),
      approval: {
        policy: {
          version: document.version,
          sha256: digestReleasePolicyJson(document),
        },
        mechanicsApprovedAt: document.validFrom,
        benchmarkApprovedAt: document.validFrom,
        withdrawnAt: null,
        denyNewAuthorizations: false,
      },
    },
  };
}
