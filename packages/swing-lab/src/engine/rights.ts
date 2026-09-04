/**
 * PER-MODALITY RIGHTS — legality is not "the video is online".
 *
 * Every source carries an explicit answer for each way we might use it.
 * "Publicly viewable" never implies "training permitted". A recording enters
 * the training corpus only when `train` is affirmative; anything `unclear`
 * is quarantined from training/redistribution by the release gate.
 *
 * License strings are PARSED into a canonical license (CC0, public domain, or
 * a Creative Commons element set) before any answer is derived — never
 * substring-matched. A restrictive element (NC, ND) constrains the profile it
 * belongs to, a negation/reservation marker anywhere in the text quarantines
 * it, and two licenses that would answer differently are ambiguous.
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

// ── canonical license parsing ────────────────────────────────────────────

export type CcElement = "by" | "sa" | "nc" | "nd";

export type CanonicalLicense =
  | { kind: "public_domain"; id: "public-domain" }
  | { kind: "cc0"; id: "cc0" }
  | { kind: "cc"; id: string; elements: readonly CcElement[]; version: string | null };

export type LicenseParse =
  | { status: "recognized"; license: CanonicalLicense }
  | {
      status: "unrecognized" | "malformed" | "contradicted" | "ambiguous";
      reason: string;
    };

const CC_ELEMENTS: ReadonlySet<string> = new Set<CcElement>(["by", "sa", "nc", "nd"]);
const CC_ELEMENT_ORDER: readonly CcElement[] = ["by", "nc", "nd", "sa"];
const VERSION = /^\d+(\.\d+)?$/;

/**
 * Words that, left over after the license tokens are consumed, mean the text
 * is denying or qualifying the license rather than granting it.
 */
const CONTRADICTION_MARKERS: ReadonlySet<string> = new Set([
  "not",
  "no",
  "non",
  "never",
  "neither",
  "nor",
  "without",
  "except",
  "unless",
  "reserved",
  "proprietary",
  "restricted",
  "copyrighted",
  "unlicensed",
  "revoked",
  "disputed",
  "unverified",
]);

/** Hyphen-joined compounds stay together ("cc-by-nc-nd" is one unit). */
function tokenize(license: string): string[][] {
  return license
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^a-z0-9.-]+/)
    .map((unit) =>
      unit
        .split("-")
        .map((part) => part.replace(/^\.+|\.+$/g, ""))
        .filter(Boolean),
    )
    .filter((unit) => unit.length > 0);
}

function ccCanonical(elements: readonly CcElement[], version: string | null): CanonicalLicense {
  const ordered = CC_ELEMENT_ORDER.filter((element) => elements.includes(element));
  return { kind: "cc", id: `cc-${ordered.join("-")}`, elements: ordered, version };
}

export function parseLicense(license: string): LicenseParse {
  const units = tokenize(license);
  const found: CanonicalLicense[] = [];
  const residual: string[] = [];

  let index = 0;
  while (index < units.length) {
    const unit = units[index]!;
    const head = unit[0]!;

    if (head === "cc0" && unit.length === 1) {
      found.push({ kind: "cc0", id: "cc0" });
      index += 1;
      if (index < units.length && units[index]!.length === 1 && VERSION.test(units[index]![0]!))
        index += 1;
      continue;
    }
    if (head === "pd" && unit.length >= 1) {
      // "PD", "PD-USGov", "PD-US", "PD-self" … — the qualifier names the reason.
      found.push({ kind: "public_domain", id: "public-domain" });
      index += 1;
      continue;
    }
    if (head === "public" && unit.length === 1 && units[index + 1]?.join("-") === "domain") {
      found.push({ kind: "public_domain", id: "public-domain" });
      index += 2;
      continue;
    }
    if (head === "cc") {
      // Grammar: cc by (sa|nc|nd)* [version] — elements may be hyphenated to
      // "cc" or stand as their own hyphen-compound ("CC BY-NC-SA").
      const parts = unit.slice(1);
      index += 1;
      if (parts.length === 0 && index < units.length) {
        const next = units[index]!;
        if (CC_ELEMENTS.has(next[0]!)) {
          parts.push(...next);
          index += 1;
        }
      }
      if (parts.length === 0) {
        return { status: "malformed", reason: `"${license}": "CC" without a license element` };
      }
      const unknown = parts.find((part) => !CC_ELEMENTS.has(part));
      if (unknown !== undefined) {
        return {
          status: "malformed",
          reason: `"${license}": unrecognized Creative Commons element "${unknown}"`,
        };
      }
      const elements = parts as CcElement[];
      if (!elements.includes("by")) {
        return {
          status: "malformed",
          reason: `"${license}": Creative Commons license without the BY element is not a recognized deed`,
        };
      }
      let version: string | null = null;
      if (index < units.length && units[index]!.length === 1 && VERSION.test(units[index]![0]!)) {
        version = units[index]![0]!;
        index += 1;
      }
      found.push(ccCanonical(elements, version));
      continue;
    }

    residual.push(...unit);
    index += 1;
  }

  if (found.length === 0) {
    return { status: "unrecognized", reason: `Unrecognized license "${license}"` };
  }
  const marker = residual.find((word) => CONTRADICTION_MARKERS.has(word));
  if (marker !== undefined) {
    return {
      status: "contradicted",
      reason: `"${license}": the text qualifies or denies the license ("${marker}")`,
    };
  }
  const distinctIds = [...new Set(found.map((candidate) => candidate.id))];
  if (distinctIds.length > 1) {
    return {
      status: "ambiguous",
      reason: `"${license}": more than one license named (${distinctIds.join(", ")})`,
    };
  }
  return { status: "recognized", license: found[0]! };
}

// ── canonical license → per-modality rights ──────────────────────────────

type ModalityAnswers = Pick<
  RightsProfile,
  "store" | "analyze" | "annotate" | "train" | "redistributeDerivatives" | "commercial"
>;

/** Restrictiveness rank — combining answers keeps the most restrictive one. */
const RANK: Record<RightAnswer, number> = {
  yes: 4,
  yes_with_attribution: 3,
  sharealike: 2,
  unclear: 1,
  no: 0,
};

function mostRestrictive(a: RightAnswer, b: RightAnswer): RightAnswer {
  return RANK[a] <= RANK[b] ? a : b;
}

const UNRESTRICTED: ModalityAnswers = {
  store: "yes",
  analyze: "yes",
  annotate: "yes",
  train: "yes",
  redistributeDerivatives: "yes",
  commercial: "yes",
};

const ATTRIBUTION: ModalityAnswers = {
  store: "yes_with_attribution",
  analyze: "yes_with_attribution",
  annotate: "yes_with_attribution",
  train: "yes_with_attribution",
  redistributeDerivatives: "yes_with_attribution",
  commercial: "yes_with_attribution",
};

const QUARANTINE: ModalityAnswers = {
  store: "unclear",
  analyze: "unclear",
  annotate: "unclear",
  train: "unclear",
  redistributeDerivatives: "unclear",
  commercial: "unclear",
};

/**
 * What each Creative Commons element constrains. Pickle Sensei is a
 * commercial product, so NonCommercial refuses training and derivative
 * redistribution outright and leaves the private modalities to human review;
 * NoDerivatives refuses sharing adaptations and leaves training unclear
 * (whether a trained model is an adaptation is unsettled).
 */
const CC_ELEMENT_CONSTRAINTS: Record<
  CcElement,
  { answers: Partial<ModalityAnswers>; basis: string }
> = {
  by: {
    answers: {},
    basis: "CC BY permits any use incl. commercial with attribution.",
  },
  sa: {
    answers: { redistributeDerivatives: "sharealike" },
    basis: "ShareAlike: redistributed derivatives must be ShareAlike-licensed.",
  },
  nc: {
    answers: {
      store: "unclear",
      analyze: "unclear",
      annotate: "unclear",
      train: "no",
      redistributeDerivatives: "no",
      commercial: "no",
    },
    basis:
      "NonCommercial: commercial use is not licensed; models feeding a commercial product may not be trained on it and derivatives may not be redistributed — private storage/analysis/annotation need human review.",
  },
  nd: {
    answers: { train: "unclear", redistributeDerivatives: "no" },
    basis:
      "NoDerivatives: adaptations may not be shared — derivative redistribution is refused and model training needs human review.",
  },
};

function answersForCanonical(canonical: CanonicalLicense): {
  answers: ModalityAnswers;
  basis: string;
} {
  switch (canonical.kind) {
    case "public_domain":
      return {
        answers: UNRESTRICTED,
        basis:
          "U.S. federal government works (17 U.S.C. §105) / public domain carry no copyright restriction; DVIDS asks courtesy credit and no implied DoD endorsement.",
      };
    case "cc0":
      return {
        answers: UNRESTRICTED,
        basis: "CC0 waives all copyright and related rights; no restriction on any use.",
      };
    case "cc": {
      const answers: ModalityAnswers = { ...ATTRIBUTION };
      const restricted = canonical.elements.some((element) => element === "nc" || element === "nd");
      const notes: string[] = restricted ? ["Attribution required for every use."] : [];
      for (const element of canonical.elements) {
        const constraint = CC_ELEMENT_CONSTRAINTS[element];
        for (const modality of Object.keys(constraint.answers) as (keyof ModalityAnswers)[]) {
          answers[modality] = mostRestrictive(answers[modality], constraint.answers[modality]!);
        }
        if (!(element === "by" && restricted)) notes.push(constraint.basis);
      }
      return { answers, basis: notes.join(" ") };
    }
  }
}

/**
 * Known-license derivations. Anything not recognized — or recognized but
 * contradicted, malformed, or ambiguous — returns all-unclear (quarantine).
 */
export function rightsForLicense(license: string, reviewedBy: string): RightsProfile {
  const now = new Date().toISOString();
  const parsed = parseLicense(license);
  if (parsed.status !== "recognized") {
    return {
      ...QUARANTINE,
      basis: `${parsed.reason} — must be reviewed by a human before any use beyond quarantine.`,
      reviewedBy,
      reviewedAtIso: now,
    };
  }
  const { answers, basis } = answersForCanonical(parsed.license);
  return {
    ...answers,
    basis: `${license} — ${basis}`,
    reviewedBy,
    reviewedAtIso: now,
  };
}
