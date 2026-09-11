/**
 * Release identity of the candidate this binary was built from.
 *
 * The Xcode bundle phase (src/diagnostics/bundle-xcode.sh) runs
 * `scripts/release-identity.mjs --check --require-committed --json` and
 * writes its version, build number, bundle identifier, commit and committed
 * verdict to `releaseIdentity.generated.json` right before Metro bundles, so
 * the marketing version, native build number and source commit carried by
 * diagnostics are the ones the validator proved coherent and committed for
 * that archive. Nothing here derives, increments or defaults an identity:
 * the file is read as written, validated against the same shape
 * `diagnosticsIdentity()` accepts, and cross-checked against the runtime
 * configuration. Any mismatch, uncommitted candidate or missing file yields
 * `null`, which the diagnostics gate reports as `blocked_identity`.
 */
import { readGeneratedReleaseIdentity } from './readGeneratedReleaseIdentity';
import type { RuntimeDiagnosticsConfig } from './runtimeConfig';

export interface GeneratedReleaseIdentity {
  readonly bundleIdentifier: 'com.picklesensei';
  readonly marketingVersion: string;
  readonly nativeBuildNumber: string;
  readonly sourceRevision: string;
}

const BUNDLE_IDENTIFIER = 'com.picklesensei';
const MARKETING_VERSION_PATTERN = /^[0-9]{1,4}(?:\.[0-9]{1,4}){0,2}$/;
const MAX_BUILD_NUMBER = 99_999_999;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/;

function field(record: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Validates one record printed by `release-identity.mjs --json`. Only a
 * committed candidate with an in-range integer build number, a dotted
 * marketing version, the shipping bundle identifier and a full lowercase
 * commit SHA is accepted; everything else, including a record whose
 * properties throw, is `null`.
 */
export function parseGeneratedReleaseIdentity(
  input: unknown,
): GeneratedReleaseIdentity | null {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return null;
    }
    if (field(input, 'committed') !== true) return null;
    const bundleIdentifier = field(input, 'bundleIdentifier');
    if (bundleIdentifier !== BUNDLE_IDENTIFIER) return null;
    const marketingVersion = field(input, 'marketingVersion');
    if (
      typeof marketingVersion !== 'string' ||
      !MARKETING_VERSION_PATTERN.test(marketingVersion)
    ) {
      return null;
    }
    const buildNumber = field(input, 'buildNumber');
    if (
      typeof buildNumber !== 'number' ||
      !Number.isSafeInteger(buildNumber) ||
      buildNumber < 1 ||
      buildNumber > MAX_BUILD_NUMBER
    ) {
      return null;
    }
    const sourceRevision = field(input, 'gitSha');
    if (
      typeof sourceRevision !== 'string' ||
      !SOURCE_REVISION_PATTERN.test(sourceRevision)
    ) {
      return null;
    }
    return Object.freeze({
      bundleIdentifier: BUNDLE_IDENTIFIER,
      marketingVersion,
      nativeBuildNumber: String(buildNumber),
      sourceRevision,
    });
  } catch {
    return null;
  }
}

/** The identity the build wrote for this binary, or `null` without one. */
export function generatedReleaseIdentity(): GeneratedReleaseIdentity | null {
  try {
    return parseGeneratedReleaseIdentity(readGeneratedReleaseIdentity());
  } catch {
    return null;
  }
}

/**
 * Completes the diagnostics configuration with the candidate's build number
 * and source commit. The runtime configuration ships both as `null`, so the
 * generated identity is the only source of either; when the configuration
 * does carry a value it must equal the candidate's, and the bundle
 * identifier and marketing version must agree. Drift or a missing candidate
 * is `null`, never a partially completed configuration.
 */
export function applyGeneratedReleaseIdentity(
  config: RuntimeDiagnosticsConfig,
  generated: GeneratedReleaseIdentity | null,
): RuntimeDiagnosticsConfig | null {
  try {
    if (generated === null) return null;
    if (config.bundleIdentifier !== generated.bundleIdentifier) return null;
    if (config.marketingVersion !== generated.marketingVersion) return null;
    const { nativeBuildNumber, sourceRevision } = config;
    if (
      nativeBuildNumber !== null &&
      nativeBuildNumber !== generated.nativeBuildNumber
    ) {
      return null;
    }
    if (
      sourceRevision !== null &&
      sourceRevision !== generated.sourceRevision
    ) {
      return null;
    }
    return {
      ...config,
      nativeBuildNumber: generated.nativeBuildNumber,
      sourceRevision: generated.sourceRevision,
    };
  } catch {
    return null;
  }
}
