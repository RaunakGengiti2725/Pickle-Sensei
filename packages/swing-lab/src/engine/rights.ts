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

/**
 * Answers ordered from most permissive to most restrictive. A license term
 * can only move an answer DOWN this ladder (see `meet`); `unclear` sits above
 * `no` because an unknown answer still routes to a human, while `no` is final.
 */
const RESTRICTIVENESS: Readonly<Record<RightAnswer, number>> = {
  yes: 0,
  yes_with_attribution: 1,
  sharealike: 2,
  unclear: 3,
  no: 4,
};

/** The more restrictive of two answers (commutative, associative, idempotent). */
function meet(a: RightAnswer, b: RightAnswer): RightAnswer {
  return RESTRICTIVENESS[a] >= RESTRICTIVENESS[b] ? a : b;
}

export function trainingEligible(rights: RightsProfile): boolean {
  return (
    AFFIRMATIVE.has(rights.train) &&
    AFFIRMATIVE.has(rights.store) &&
    AFFIRMATIVE.has(rights.analyze)
  );
}

/**
 * Derivatives (clips, frames, overlays, datasets) are redistributed by a
 * commercial product, so the profile must affirm commercial use as well as
 * the redistribution itself.
 */
export function redistributionEligible(rights: RightsProfile): boolean {
  return AFFIRMATIVE.has(rights.redistributeDerivatives) && AFFIRMATIVE.has(rights.commercial);
}

// ── License parsing ───────────────────────────────────────────────────────
//
// A free-text license string is first PARSED into a structured designation and
// only then mapped to rights. The designation must lead the string (like an
// SPDX identifier) and be delimited, so a longer identifier can never be
// swallowed by a shorter prefix ("CC BY-NC" is not "CC BY"), and text that
// merely mentions a license ("NOT public domain") does not name one.

/** Creative Commons license elements. `by` is implied by every CC license we accept. */
export type CcElement = "by" | "sa" | "nc" | "nd";

const CC_ELEMENTS: ReadonlySet<string> = new Set<CcElement>(["by", "sa", "nc", "nd"]);

function isCcElement(token: string): token is CcElement {
  return CC_ELEMENTS.has(token);
}

/** The six per-modality answers, without the review metadata. */
type ModalityAnswers = Omit<RightsProfile, "basis" | "reviewedBy" | "reviewedAtIso">;

type Modality = Exclude<keyof ModalityAnswers, "notes">;

const MODALITIES: ReadonlyArray<Modality> = [
  "store",
  "analyze",
  "annotate",
  "train",
  "redistributeDerivatives",
  "commercial",
];

export type ParsedLicense =
  | { kind: "public_domain"; designation: string }
  | { kind: "creative_commons"; elements: ReadonlySet<CcElement>; version: string | null }
  | { kind: "unrecognized"; reason: string };

/**
 * Words that signal the string hedges, negates, or disputes the license it
 * mentions. Any of them anywhere in the string means a human must read it.
 * Long-form CC element names are canonicalised BEFORE this check so that
 * "NonCommercial" / "NoDerivatives" are not mistaken for negations.
 */
const HEDGE_MARKERS =
  /\b(?:not|no|non|never|isn'?t|aren'?t|wasn'?t|un(?:confirmed|verified|clear|known|licensed|determined)|disputed|pending|possibly|maybe|probably|likely|plausibl[ey]|except|unless|proprietary|claimed|alleged|assessed|false|incorrect|invalid|mixed|partial(?:ly)?|prohibited|forbidden|restrict(?:ed|ions?)|only|exclusive(?:ly)?|may|revoked|reverted|withdrawn|expired|editorial|research|educational|personal|dual)\b|all rights reserved|©|\(c\)/;

/**
 * A Creative Commons element token that appears AFTER the parsed designation
 * ("CC BY 4.0 — no derivatives", "CC BY 3.0 NonCommercial") restricts the
 * grant but is not part of the identifier; the composition rules cannot see it,
 * so the string must go to a human rather than inherit the CC BY profile.
 * Restating the designation's own elements (a licenseurl `/by-nc-sa/4.0/`) is
 * not stray.
 */
const CC_ELEMENT_TOKENS = /(?:^|[^a-z0-9])(sa|nc|nd)(?![a-z0-9])/g;

function strayCcElement(rest: string, elements: ReadonlySet<CcElement>): CcElement | null {
  for (const match of rest.matchAll(CC_ELEMENT_TOKENS)) {
    const token = match[1] ?? "";
    if (isCcElement(token) && !elements.has(token)) return token;
  }
  return null;
}

const LONG_FORM_ELEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bcreative commons\b/g, "cc"],
  [/\bcc[ -]?zero\b/g, "cc0"],
  [/\battribution\b/g, "by"],
  [/\bshare[ -]?alike\b/g, "sa"],
  [/\bnon[ -]?commercial\b/g, "nc"],
  [/\bno[ -]?deriv(?:ative)?s?\b/g, "nd"],
];

const PUBLIC_DOMAIN_DESIGNATION =
  /^(?:public domain|pd(?:-[a-z0-9]+)+|cc0(?:[ -]v?\d+(?:\.\d+)?)?)(?![a-z0-9-])/;

const CREATIVE_COMMONS_DESIGNATION =
  /^cc[ -]by((?:[ -](?:sa|nc|nd))*)(?:[ -]v?(\d+(?:\.\d+)?))?(?![a-z0-9.-])/;

function canonicalize(license: string): string {
  let text = license
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  for (const [pattern, replacement] of LONG_FORM_ELEMENTS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function parseLicense(license: string): ParsedLicense {
  const text = canonicalize(license);
  if (text.length === 0) {
    return { kind: "unrecognized", reason: "empty license string" };
  }
  const hedge = HEDGE_MARKERS.exec(text);
  if (hedge) {
    return {
      kind: "unrecognized",
      reason: `contains a negation/hedge marker ("${hedge[0]}")`,
    };
  }
  const pd = PUBLIC_DOMAIN_DESIGNATION.exec(text);
  if (pd) {
    return { kind: "public_domain", designation: pd[0] };
  }
  const cc = CREATIVE_COMMONS_DESIGNATION.exec(text);
  if (cc) {
    const elements = new Set<CcElement>(["by"]);
    for (const token of (cc[1] ?? "").split(/[ -]/)) {
      if (isCcElement(token)) elements.add(token);
    }
    if (elements.has("sa") && elements.has("nd")) {
      return {
        kind: "unrecognized",
        reason: "ShareAlike and NoDerivatives never appear together in a Creative Commons license",
      };
    }
    const stray = strayCcElement(text.slice(cc[0].length), elements);
    if (stray) {
      return {
        kind: "unrecognized",
        reason: `Creative Commons element "${stray}" appears outside the license designation`,
      };
    }
    return { kind: "creative_commons", elements, version: cc[2] ?? null };
  }
  return { kind: "unrecognized", reason: "no known license designation leads the string" };
}

// ── Rights derivation ─────────────────────────────────────────────────────

function uniform(answer: RightAnswer): ModalityAnswers {
  return {
    store: answer,
    analyze: answer,
    annotate: answer,
    train: answer,
    redistributeDerivatives: answer,
    commercial: answer,
  };
}

interface CcElementTerm {
  /** The answers this element caps; modalities it does not name are untouched. */
  caps: Readonly<Partial<Record<Modality, RightAnswer>>>;
  term: string;
}

/**
 * What each Creative Commons element says about our use, as a cap on the
 * CC BY baseline. NonCommercial caps derivatives at `unclear` (they may only
 * be shared non-commercially, which our redistribution is not) and
 * NoDerivatives at `no`; both leave training for a commercial product to a
 * human. The caps are DATA — composition happens in `creativeCommonsRights`.
 */
const CC_ELEMENT_TERMS: Readonly<Record<CcElement, CcElementTerm>> = {
  by: {
    caps: {},
    term: "CC BY permits use with attribution",
  },
  sa: {
    caps: { redistributeDerivatives: "sharealike" },
    term: "ShareAlike: redistributed derivatives must carry the same license",
  },
  nc: {
    caps: { commercial: "no", train: "unclear", redistributeDerivatives: "unclear" },
    term: "NonCommercial: no commercial use; training a model for a commercial product, and sharing derivatives from one, need human review",
  },
  nd: {
    caps: { redistributeDerivatives: "no", train: "unclear" },
    term: "NoDerivatives: adapted material may not be shared; whether a trained model is adapted material needs human review",
  },
};

/** Canonical element order for the basis text; the composed answers do not depend on it. */
const CC_ELEMENT_ORDER: ReadonlyArray<CcElement> = ["by", "sa", "nc", "nd"];

/**
 * Compose the profile for a parsed Creative Commons license from its elements.
 * Each modality takes the `meet` (most restrictive) of the CC BY baseline and
 * every element's cap, so an element can only ever restrict the baseline —
 * never widen it, and never leave a sibling element's more permissive answer
 * standing — whatever order the elements appear in.
 */
function creativeCommonsRights(elements: ReadonlySet<CcElement>): {
  rights: ModalityAnswers;
  terms: string[];
} {
  const rights = uniform("yes_with_attribution");
  const terms: string[] = [];
  for (const element of CC_ELEMENT_ORDER) {
    if (!elements.has(element)) continue;
    const { caps, term } = CC_ELEMENT_TERMS[element];
    for (const modality of MODALITIES) {
      const cap = caps[modality];
      if (cap !== undefined) rights[modality] = meet(rights[modality], cap);
    }
    terms.push(term);
  }
  return { rights, terms };
}

/**
 * Rule-derived rights for a license string. Only a designation the parser
 * recognizes yields anything other than all-unclear; every Creative Commons
 * element is applied compositionally so restrictive variants (NC, ND) can
 * never inherit the permissive CC BY profile.
 */
export function rightsForLicense(license: string, reviewedBy: string): RightsProfile {
  const now = new Date().toISOString();
  const parsed = parseLicense(license);
  switch (parsed.kind) {
    case "public_domain":
      return {
        ...uniform("yes"),
        basis: `${license} — U.S. federal government works (17 U.S.C. §105) / CC0 carry no copyright restriction; DVIDS asks courtesy credit and no implied DoD endorsement.`,
        reviewedBy,
        reviewedAtIso: now,
      };
    case "creative_commons": {
      const { rights, terms } = creativeCommonsRights(parsed.elements);
      return {
        ...rights,
        basis: `${license} — ${terms.join("; ")}.`,
        reviewedBy,
        reviewedAtIso: now,
      };
    }
    case "unrecognized":
      return {
        ...uniform("unclear"),
        basis: `Unrecognized license "${license}" (${parsed.reason}) — must be reviewed by a human before any use beyond quarantine.`,
        reviewedBy,
        reviewedAtIso: now,
      };
  }
}
