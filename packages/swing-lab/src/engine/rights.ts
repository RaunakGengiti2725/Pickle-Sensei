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

/**
 * License identifiers must START the string (after optional whitespace) so a
 * negated or descriptive phrase ("NOT public domain", "no CC BY grant") can
 * never match by containing a known identifier as a substring.
 */
const PUBLIC_DOMAIN_LICENSE = /^\s*(?:public domain\b|pd(?:[ -]|$)|cc0\b)/;

/**
 * Creative Commons "BY" family: `CC BY` followed by any of the NC / ND / SA
 * elements, then a version or end of identifier. The captured element list
 * decides which modalities the license restricts.
 */
const CC_BY_LICENSE = /^\s*cc[ -]by((?:[ -](?:nc|nd|sa))*)(?:[ -]v?\d|\s|$)/;

/** Known-license derivations. Anything not matched returns all-unclear. */
export function rightsForLicense(license: string, reviewedBy: string): RightsProfile {
  const now = new Date().toISOString();
  const normalized = license.toLowerCase();
  if (PUBLIC_DOMAIN_LICENSE.test(normalized)) {
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
  const ccBy = CC_BY_LICENSE.exec(normalized);
  if (ccBy) {
    const elements = new Set(ccBy[1]!.split(/[ -]/).filter((element) => element.length > 0));
    const nonCommercial = elements.has("nc");
    const noDerivatives = elements.has("nd");
    const shareAlike = elements.has("sa");
    if (nonCommercial || noDerivatives) {
      const restrictions = [
        nonCommercial
          ? "NonCommercial forbids commercial use, and models shipped in a commercial product are commercial use"
          : null,
        noDerivatives
          ? "NoDerivatives forbids sharing adapted material, and whether a trained model or derived dataset is an adaptation needs a human legal call"
          : null,
      ]
        .filter((restriction): restriction is string => restriction !== null)
        .join("; ");
      return {
        store: "yes_with_attribution",
        analyze: "yes_with_attribution",
        annotate: "yes_with_attribution",
        train: "unclear",
        redistributeDerivatives: noDerivatives ? "no" : shareAlike ? "sharealike" : "unclear",
        commercial: nonCommercial ? "no" : "unclear",
        basis: `${license} — CC BY with restrictive elements: ${restrictions}. Private copies, analysis and annotations are permitted with attribution; training and redistribution stay quarantined until a human review grants them.`,
        reviewedBy,
        reviewedAtIso: now,
      };
    }
    if (shareAlike) {
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
