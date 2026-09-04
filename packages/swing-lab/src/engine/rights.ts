/**
 * PER-MODALITY RIGHTS — legality is not "the video is online".
 *
 * Every source carries an explicit answer for each way we might use it.
 * "Publicly viewable" never implies "training permitted". A recording enters
 * the training corpus only when `train` is affirmative; anything `unclear`
 * is quarantined from training/redistribution by the release gate.
 */

export type RightAnswer = "yes" | "yes_with_attribution" | "sharealike" | "no" | "unclear";

export interface RightsProfile {
  /** Right to download and retain a private copy. */
  store: RightAnswer;
  /** Right to run analysis/inference over the media. */
  analyze: RightAnswer;
  /** Right to create and keep annotations/derived labels. */
  annotate: RightAnswer;
  /** Right to train ML models on the media or derivatives. */
  train: RightAnswer;
  /** Right to redistribute derivatives (clips, frames, overlays, datasets). */
  redistributeDerivatives: RightAnswer;
  /** Compatibility with commercial use of models/products built on it. */
  commercial: RightAnswer;
  /** Legal basis, quoted or cited (license name + why it grants the above). */
  basis: string;
  reviewedBy: string;
  reviewedAtIso: string;
  notes?: string;
}

const AFFIRMATIVE: ReadonlySet<RightAnswer> = new Set([
  "yes",
  "yes_with_attribution",
  "sharealike",
]);

export function trainingEligible(rights: RightsProfile): boolean {
  return (
    AFFIRMATIVE.has(rights.train) &&
    AFFIRMATIVE.has(rights.store) &&
    AFFIRMATIVE.has(rights.analyze)
  );
}

export function redistributionEligible(rights: RightsProfile): boolean {
  return AFFIRMATIVE.has(rights.redistributeDerivatives);
}

type CcModule = "sa" | "nc" | "nd";

interface LicenseSignals {
  publicDomain: boolean;
  /** A `CC BY…` designation was found (short form, long form, or license URL). */
  ccBy: boolean;
  modules: ReadonlySet<CcModule>;
}

/**
 * Wording that means the grant is denied, doubted, or only partial. A string
 * that carries any of these never yields an affirmative answer, whatever
 * license token also appears in it ("NOT public domain", "assessed FALSE",
 * "Mixed: … public domain, but …", "plausible PD-USGov … not confirmed").
 */
const DENIAL_OR_DOUBT: readonly RegExp[] = [
  /\b(?:not|never|isn't|is not|was not|wasn't|aren't|are not|no longer)\b[^.;]{0,60}?\b(?:public domain|pd(?:-usgov)?|cc0|cc[ -]?by|creative commons)\b/,
  /\ball rights reserved\b/,
  /\b(?:assessed|determined|found|verified)\s+(?:as\s+)?false\b/,
  /\b(?:un|not\s+)(?:verified|confirmed)\b/,
  /\bunconfirmed\b/,
  /\bplausibl[ey]\b/,
  /\bmixed\b/,
];

/** Full-word CC module names as they appear in long-form license titles. */
const MODULE_WORDS: ReadonlyArray<[RegExp, CcModule]> = [
  [/\bshare[ -]?alike\b/, "sa"],
  [/\b(?:non|no|not for)[ -]?commercial\b/, "nc"],
  [/\bno[ -]?deriv(?:ative)?s?\b/, "nd"],
];

/**
 * Every CC BY designation in the string, e.g. "cc by", "cc-by-nc-sa", "cc by nd",
 * "creativecommons.org/licenses/by-nc/". Module suffixes are captured as a
 * group so "cc by-nc" is never read as "cc by" with trailing text.
 */
const CC_BY_TOKEN = /(?:\bcc[ -]?by|creativecommons\.org\/licenses\/by)((?:[ -](?:nc|nd|sa)\b)*)/g;

function licenseSignals(normalized: string): LicenseSignals {
  const modules = new Set<CcModule>();
  let ccBy = false;
  for (const match of normalized.matchAll(CC_BY_TOKEN)) {
    ccBy = true;
    for (const [, module] of (match[1] ?? "").matchAll(/[ -](nc|nd|sa)/g)) {
      modules.add(module as CcModule);
    }
  }
  if (/\bcreative commons\b.*\battribution\b/.test(normalized)) ccBy = true;
  for (const [pattern, module] of MODULE_WORDS) {
    if (pattern.test(normalized)) modules.add(module);
  }
  const publicDomain =
    /\bpublic domain\b/.test(normalized) ||
    /\bpd-usgov\b/.test(normalized) ||
    /\bcc0\b/.test(normalized) ||
    /creativecommons\.org\/publicdomain\/(?:zero|mark)\//.test(normalized);
  return { publicDomain, ccBy, modules };
}

/**
 * Known-license derivations. Only an unambiguous, un-negated CC0 / public
 * domain / CC BY / CC BY-SA designation is affirmative. Any NonCommercial or
 * NoDerivatives module denies commercial use and derivative redistribution
 * (training a model for a commercial product is commercial use). Anything
 * else — including negated, hedged, or mixed statements — returns all-unclear.
 */
export function rightsForLicense(license: string, reviewedBy: string): RightsProfile {
  const now = new Date().toISOString();
  const normalized = license.toLowerCase();
  const signals = licenseSignals(normalized);
  const denied = DENIAL_OR_DOUBT.some((pattern) => pattern.test(normalized));
  const { modules } = signals;

  if (!denied && (modules.has("nc") || modules.has("nd"))) {
    const nc = modules.has("nc");
    const nd = modules.has("nd");
    const restriction = [nc && "NonCommercial", nd && "NoDerivatives"]
      .filter((value): value is string => typeof value === "string")
      .join(" + ");
    return {
      store: "unclear",
      analyze: "unclear",
      annotate: "unclear",
      train: nc ? "no" : "unclear",
      redistributeDerivatives: "no",
      commercial: nc ? "no" : "unclear",
      basis: `${license} — CC ${restriction}: ${
        nc
          ? "NonCommercial forbids commercial use, so training for a commercial product and any commercial redistribution are denied; "
          : ""
      }${
        nd
          ? "NoDerivatives forbids sharing adapted material (clips, frames, overlays, datasets); "
          : ""
      }remaining modalities need human review before any use beyond quarantine.`,
      reviewedBy,
      reviewedAtIso: now,
    };
  }
  if (!denied && signals.ccBy && modules.has("sa")) {
    return {
      store: "yes_with_attribution",
      analyze: "yes_with_attribution",
      annotate: "yes_with_attribution",
      train: "yes_with_attribution",
      redistributeDerivatives: "sharealike",
      commercial: "yes_with_attribution",
      basis: `${license} — CC BY-SA permits any use incl. commercial with attribution; redistributed derivatives must be ShareAlike-licensed.`,
      reviewedBy,
      reviewedAtIso: now,
    };
  }
  if (!denied && signals.ccBy) {
    return {
      store: "yes_with_attribution",
      analyze: "yes_with_attribution",
      annotate: "yes_with_attribution",
      train: "yes_with_attribution",
      redistributeDerivatives: "yes_with_attribution",
      commercial: "yes_with_attribution",
      basis: `${license} — CC BY permits any use incl. commercial with attribution.`,
      reviewedBy,
      reviewedAtIso: now,
    };
  }
  if (!denied && signals.publicDomain) {
    return {
      store: "yes",
      analyze: "yes",
      annotate: "yes",
      train: "yes",
      redistributeDerivatives: "yes",
      commercial: "yes",
      basis: `${license} — U.S. federal government works (17 U.S.C. §105) / CC0 carry no copyright restriction; DVIDS asks courtesy credit and no implied DoD endorsement.`,
      reviewedBy,
      reviewedAtIso: now,
    };
  }
  return {
    store: "unclear",
    analyze: "unclear",
    annotate: "unclear",
    train: "unclear",
    redistributeDerivatives: "unclear",
    commercial: "unclear",
    basis: `Unrecognized license "${license}" — must be reviewed by a human before any use beyond quarantine.`,
    reviewedBy,
    reviewedAtIso: now,
  };
}
