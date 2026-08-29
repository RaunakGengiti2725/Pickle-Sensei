import {
  PICKLEBALL_TECHNIQUES,
  type PickleballTechniqueSlug,
  type StrokeFamily,
} from "./pickleballTaxonomy.js";
import {
  SELECTABLE_TECHNIQUES_V1,
  type IntentResolution,
  type SelectableTechnique,
} from "./techniqueIntent.js";

/**
 * VOICE INTENT — transcript-in, intent-out (voice-intent-v2).
 *
 * Deterministic mapping from a speech transcript to the 61-technique
 * pickleball taxonomy (pickleballTaxonomy.ts). NOT a language model: a
 * bounded keyword grammar whose every output terminates in the versioned
 * taxonomy. Honesty rules, in order:
 *
 *  - a taxonomy LEAF is committed only when the transcript's own words
 *    single out exactly one technique ("crosscourt forehand dink");
 *  - a coarse phrase stays a coarse intent: "forehand" resolves to a
 *    SIDE-level candidate set and "dink" to a FAMILY-level candidate set —
 *    a leaf is never invented from an underspecified phrase;
 *  - phrases with no technique vocabulary are an honest UNKNOWN carrying
 *    re-prompt copy for the UI (the existing picker pattern: hint text +
 *    the tappable grid stays available);
 *  - "auto" / "not sure" style phrases resolve to AUTO (declared-null).
 *
 * voice-intent-v2 robustness additions (all still bounded and deterministic;
 * strictly fewer silent accepts than v1, never more):
 *  - common misspellings/ASR variants of technique words are in the grammar
 *    ("forhand", "bakhand", "volly", "surve", "crosscort", "ernie"…);
 *  - a bounded idiom list scrubs everyday phrases that reuse technique
 *    words ("serve dinner", "return my call", "drop it", "on a roll",
 *    "drive home"…) so they resolve to honest UNKNOWN, not a technique;
 *  - phrases mentioning BOTH sides ("forehand and backhand dink") stay a
 *    coarse candidate set across both sides — a side is never guessed;
 *  - a phrase whose only technique word IS a stroke family ("volley",
 *    "dink") keeps candidates within that family, so compound slugs from
 *    other families (volley serve, volley reset) don't leak in.
 *
 * The declared intent remains a PRIOR everywhere: this module only produces
 * declarations. Projection into the product-selectable capture registry
 * (SELECTABLE_TECHNIQUES_V1 → TechniqueIntent → declaredStroke) happens via
 * projectVoiceResolution below, and the analyzer's predictedStroke stays a
 * separate record (see analysis-pipeline strokeAutoResolution.ts).
 */

export const VOICE_INTENT_VERSION = "voice-intent-v2" as const;

export type VoiceSide = "forehand" | "backhand" | "two_hand_backhand";

export type VoiceIntentResolution =
  | {
      version: typeof VOICE_INTENT_VERSION;
      status: "leaf";
      slug: PickleballTechniqueSlug;
      family: StrokeFamily;
      /** Deterministic grammar match — not a probability. */
      confidence: number;
    }
  | {
      version: typeof VOICE_INTENT_VERSION;
      status: "family";
      families: readonly StrokeFamily[];
      side: VoiceSide | null;
      candidates: readonly PickleballTechniqueSlug[];
      reason: string;
    }
  | {
      version: typeof VOICE_INTENT_VERSION;
      status: "side";
      side: VoiceSide;
      candidates: readonly PickleballTechniqueSlug[];
      reason: string;
    }
  | { version: typeof VOICE_INTENT_VERSION; status: "auto" }
  | {
      version: typeof VOICE_INTENT_VERSION;
      status: "unknown";
      reason: string;
      /** Honest re-prompt copy for the UI — never a guessed technique. */
      rePrompt: string;
    };

const AUTO_PATTERN =
  /\bauto\b|\bdetect\b|\banything\b|\bwhatever\b|\bnot sure\b|\bdon'?t know\b|\bno idea\b|\bsurprise me\b/;

const TWO_HAND_PATTERN = /\btwo[-\s]?hand(ed)?(\s*(back\s?hands?|bh))?\b/;
const FOREHAND_PATTERN = /\bfore\s?hands?\b|\bforhands?\b|\bfour\s?hands?\b|\bfh\b/;
const BACKHAND_PATTERN = /\bback\s?hands?\b|\bbackands?\b|\bbakhands?\b|\bbh\b/;

/**
 * Everyday idioms that reuse technique vocabulary. When one matches, the
 * matched span is scrubbed before technique detection — if nothing else in
 * the transcript names a technique, the resolution is an honest unknown.
 * Bounded list, no fuzziness: only these exact patterns are scrubbed.
 */
const NON_TECHNIQUE_IDIOMS: readonly RegExp[] = [
  /\bserv\w*\s+(dinner|lunch|breakfast|food|drinks?|tables?)\b/,
  /\bserves?\s+(you|me|him|her|them|us)\s+right\b/,
  /\breturn\w*\s+(my|your|his|her|their|our|the|a)\s+(calls?|texts?|emails?|messages?)\b/,
  /\breturn\s+(it|that|this)\b/,
  /\bdrop\w*\s+(me|him|her|them|us)\s+off\b/,
  /\bdrop\s+(it|that|this)\b/,
  /\bkitchen\s+counters?\b/,
  /\bcounter\s?tops?\b/,
  /\bon\s+a\s+roll\b/,
  /\blet'?s\s+roll\b/,
  /\broll\s+(out|call)\b/,
  /\bblock\s+(out|of)\b/,
  /\broad\s?blocks?\b/,
  /\bdriv\w*\s+(home|back|over|away|safely?|to|us|me)\b/,
];

/**
 * Slug-component token grammar. Every taxonomy slug is a sequence of
 * components (e.g. dink_crosscourt_forehand → dink, crosscourt, forehand);
 * this table gives each component a deterministic spoken-word pattern.
 * A component with no pattern here can never be voice-committed — that is
 * intentional (nothing outside this grammar becomes a route).
 */
const COMPONENT_PATTERNS: Readonly<Record<string, RegExp>> = {
  volley: /\bvolley(s|ing|ed)?\b|\bvoll(y|ys|ie|ies)\b|\bvoleys?\b/,
  serve: /\bserves?\b|\bserving\b|\bservs?\b|\bsurves?\b/,
  drop: /\bdrops?\b|\bdrop\s?shots?\b/,
  return: /\breturns?\b|\breturning\b/,
  drive: /\bdrives?\b|\bdriving\b/,
  slice: /\bslices?\b|\bslicing\b/,
  block: /\bblocks?\b|\bblocking\b/,
  topspin: /\btop\s?spin\b/,
  third_shot: /\b(third|3rd)[-\s]?shot\b/,
  transition: /\btransition(al)?\b/,
  reset: /\bresets?\b|\bresetting\b/,
  half_volley: /\bhalf[-\s]?(volley(s|ing)?|voll(y|ie))\b/,
  dink: /\bdinks?\b|\bdinking\b/,
  straight: /\bstraight\b|\bdown[-\s]the[-\s]line\b/,
  crosscourt: /\bcross[-\s]?court\b|\bcross\s?corts?\b/,
  punch: /\bpunch(es|ing)?\b/,
  speedup: /\bspeed[-\s]?ups?\b/,
  roll: /\broll(s|ing)?\b/,
  swinging: /\bswinging\b/,
  counter: /\bcounters?\b|\bcountering\b/,
  overhead: /\boverheads?\b/,
  smash: /\bsmash(es)?\b|\bslams?\b/,
  offensive: /\boffensive\b/,
  defensive: /\bdefensive\b/,
  lob: /\blobs?\b|\blobbing\b/,
  around_the_post: /\baround[-\s]the[-\s]post\b|\batp\b/,
  erne: /\bernes?\b|\bernies?\b/,
  bert: /\bberts?\b/,
  tweener: /\btweeners?\b|\bbetween[-\s]the[-\s]legs\b/,
  squash_shot: /\bsquash(\s?shots?)?\b/,
};

const SIDE_COMPONENTS = new Set(["forehand", "backhand", "two_hand_backhand"]);

/** Slug → non-side component list, derived once from the taxonomy. */
interface SlugGrammar {
  slug: PickleballTechniqueSlug;
  family: StrokeFamily;
  side: VoiceSide | null;
  components: readonly string[];
}

function slugComponents(slug: string): { side: VoiceSide | null; components: string[] } {
  let rest = slug;
  let side: VoiceSide | null = null;
  if (rest.includes("two_hand_backhand")) {
    side = "two_hand_backhand";
    rest = rest.replace(/_?two_hand_backhand/, "");
  } else if (/(^|_)forehand($|_)/.test(rest)) {
    side = "forehand";
    rest = rest.replace(/(^|_)forehand/, "$1").replace(/^_|_$/g, "");
  } else if (/(^|_)backhand($|_)/.test(rest)) {
    side = "backhand";
    rest = rest.replace(/(^|_)backhand/, "$1").replace(/^_|_$/g, "");
  }
  const raw = rest.split("_").filter((part) => part.length > 0);
  const components: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const joined3 = raw.slice(index, index + 3).join("_");
    const joined2 = raw.slice(index, index + 2).join("_");
    if (joined3 in COMPONENT_PATTERNS) {
      components.push(joined3);
      index += 2;
    } else if (joined2 in COMPONENT_PATTERNS) {
      components.push(joined2);
      index += 1;
    } else {
      components.push(raw[index]!);
    }
  }
  return { side, components };
}

const SLUG_GRAMMARS: readonly SlugGrammar[] = PICKLEBALL_TECHNIQUES.map((technique) => {
  const { side, components } = slugComponents(technique.slug);
  return { slug: technique.slug, family: technique.family, side, components };
});

function normalize(rawTranscript: string): string {
  return rawTranscript
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detects EVERY side the transcript mentions. A two-hand phrase consumes
 * the "backhand" it contains ("two handed backhand dink" is ONE side); a
 * transcript naming both sides ("forehand and backhand dink") reports both
 * so the resolver stays coarse instead of guessing the first one.
 */
function detectSides(text: string): readonly VoiceSide[] {
  const sides: VoiceSide[] = [];
  let rest = text;
  if (TWO_HAND_PATTERN.test(rest)) {
    sides.push("two_hand_backhand");
    rest = rest.replace(TWO_HAND_PATTERN, " ");
  }
  if (FOREHAND_PATTERN.test(rest)) sides.push("forehand");
  if (BACKHAND_PATTERN.test(rest)) sides.push("backhand");
  return sides;
}

function scrubIdioms(text: string): string {
  let scrubbed = text;
  for (const idiom of NON_TECHNIQUE_IDIOMS) {
    scrubbed = scrubbed.replace(idiom, " ");
  }
  return scrubbed.replace(/\s+/g, " ").trim();
}

const FAMILY_NAMES = new Set<string>(["serve", "return", "dink", "volley"]);

/**
 * When the transcript's only family-bearing technique word IS a stroke
 * family name ("volley", "dink"), candidates stay within that family:
 * compound slugs from other families that merely contain the word (volley
 * serve → serve, volley reset → drop_reset) don't leak into the set.
 */
function filterToSpokenFamily(
  candidates: readonly SlugGrammar[],
  mentioned: readonly string[],
): readonly SlugGrammar[] {
  const spokenFamilies = mentioned.filter((component) => FAMILY_NAMES.has(component));
  if (spokenFamilies.length !== 1) return candidates;
  const family = spokenFamilies[0]! as StrokeFamily;
  const withinFamily = candidates.filter((grammar) => grammar.family === family);
  return withinFamily.length > 0 ? withinFamily : candidates;
}

/**
 * Deterministic transcript → taxonomy resolution.
 *
 * Matching rule (bounded, order-free): a slug is a candidate when EVERY
 * technique component the transcript mentions is part of the slug, at least
 * one of the slug's components was mentioned, and the mentioned side (if
 * any) matches the slug's side. A LEAF is committed only when the
 * transcript's components + side single out exactly one slug AND cover all
 * of that slug's components — an underspecified phrase keeps its full
 * candidate set and stays a family/side-level intent.
 */
export function resolveVoiceTechniqueIntent(rawTranscript: string): VoiceIntentResolution {
  const text = scrubIdioms(normalize(rawTranscript));
  if (text.length === 0) {
    return {
      version: VOICE_INTENT_VERSION,
      status: "unknown",
      reason: "empty transcript",
      rePrompt: "Say the technique you are working on — for example “backhand dink”.",
    };
  }
  if (AUTO_PATTERN.test(text)) {
    return { version: VOICE_INTENT_VERSION, status: "auto" };
  }

  const sides = detectSides(text);
  const side = sides.length === 1 ? sides[0]! : null;
  const multiSide = sides.length > 1;
  let mentioned = Object.entries(COMPONENT_PATTERNS)
    .filter(([, pattern]) => pattern.test(text))
    .map(([component]) => component)
    .filter((component) => !SIDE_COMPONENTS.has(component));
  // "half volley" subsumes the bare "volley" it contains — keep "volley"
  // only if it also occurs outside the half-volley phrase.
  if (mentioned.includes("half_volley")) {
    const outside = text.replace(COMPONENT_PATTERNS["half_volley"]!, " ");
    if (!COMPONENT_PATTERNS["volley"]!.test(outside)) {
      mentioned = mentioned.filter((component) => component !== "volley");
    }
  }

  if (mentioned.length === 0 && sides.length === 0) {
    return {
      version: VOICE_INTENT_VERSION,
      status: "unknown",
      reason: "no known technique words",
      rePrompt: "Didn’t catch a technique — try “forehand drive”, “dink”, or tap one below.",
    };
  }

  if (mentioned.length === 0 && side !== null && !multiSide) {
    const sideCandidates = SLUG_GRAMMARS.filter((grammar) => grammar.side === side).map(
      (grammar) => grammar.slug,
    );
    return {
      version: VOICE_INTENT_VERSION,
      status: "side",
      side,
      candidates: sideCandidates,
      reason: `${side.replace(/_/g, " ")} what — say the stroke too (drive, dink, volley…)`,
    };
  }

  const sideMatches = (grammar: SlugGrammar): boolean =>
    multiSide
      ? grammar.side !== null && sides.includes(grammar.side)
      : side === null || grammar.side === side;

  if (mentioned.length === 0 && multiSide) {
    return coarseResolution(
      SLUG_GRAMMARS.filter(sideMatches),
      null,
      "both sides mentioned — which one?",
    );
  }

  const candidates = SLUG_GRAMMARS.filter(
    (grammar) =>
      mentioned.some((component) => grammar.components.includes(component)) &&
      mentioned.every((component) => grammar.components.includes(component)) &&
      sideMatches(grammar),
  );

  if (candidates.length === 0) {
    // The exact combination names no single technique (e.g. "dink or
    // volley"): fall back to the union of everything any mentioned word
    // names — a coarse candidate set, never a guess.
    const relaxed = SLUG_GRAMMARS.filter(
      (grammar) =>
        mentioned.some((component) => grammar.components.includes(component)) &&
        sideMatches(grammar),
    );
    if (relaxed.length === 0) {
      return {
        version: VOICE_INTENT_VERSION,
        status: "unknown",
        reason: "technique words did not combine into any known technique",
        rePrompt: "That combination isn’t a technique I know — try again or tap one below.",
      };
    }
    return coarseResolution(
      filterToSpokenFamily(relaxed, mentioned),
      multiSide ? null : side,
      multiSide
        ? "both sides mentioned — which one?"
        : "multiple techniques mentioned — which one?",
    );
  }

  // A LEAF is committed only when exactly one candidate is fully specified
  // by the transcript's own words (all of its components mentioned, and its
  // side spoken when it has one). Extra candidates that would need
  // UNmentioned modifiers (e.g. "forehand drive" vs "forehand drive
  // RETURN") do not block the fully-specified one.
  const fullyCovered = multiSide
    ? []
    : candidates.filter(
        (grammar) =>
          grammar.components.every((component) => mentioned.includes(component)) &&
          (grammar.side === null || side !== null),
      );
  if (fullyCovered.length === 1) {
    const only = fullyCovered[0]!;
    return {
      version: VOICE_INTENT_VERSION,
      status: "leaf",
      slug: only.slug,
      family: only.family,
      confidence: 0.95,
    };
  }

  return coarseResolution(
    filterToSpokenFamily(candidates, mentioned),
    multiSide ? null : side,
    multiSide ? "both sides mentioned — which one?" : null,
  );
}

function coarseResolution(
  candidates: readonly SlugGrammar[],
  side: VoiceSide | null,
  reasonOverride: string | null,
): VoiceIntentResolution {
  const families = [...new Set(candidates.map((candidate) => candidate.family))];
  return {
    version: VOICE_INTENT_VERSION,
    status: "family",
    families,
    side,
    candidates: candidates.map((candidate) => candidate.slug),
    reason:
      reasonOverride ??
      (families.length === 1
        ? `several ${families[0]!.replace(/_/g, " ")} techniques match — which one?`
        : "several techniques match — which one?"),
  };
}

/**
 * PROJECTION into the product-selectable capture registry.
 *
 * The capture flow declares intent through SELECTABLE_TECHNIQUES_V1 (the
 * analyzer-verifiable set), which is coarser than the 61-technique
 * taxonomy. This projection is deterministic and honest: a taxonomy intent
 * that has no selectable analog (lobs, specialty shots, counters…) projects
 * to UNKNOWN with the real reason — it never rounds to a nearby technique.
 * The projected declaration remains a PRIOR: it selects the analysis
 * profile only; predictedStroke stays a separate record downstream.
 */
const FAMILY_SIDE_TO_SELECTABLE: Readonly<
  Partial<Record<StrokeFamily, Partial<Record<"forehand" | "backhand" | "none", string>>>>
> = {
  serve: { forehand: "SERVE", backhand: "SERVE", none: "SERVE" },
  return: { forehand: "RETURN", backhand: "RETURN", none: "RETURN" },
  groundstroke: { forehand: "FOREHAND_DRIVE", backhand: "BACKHAND_DRIVE" },
  dink: { forehand: "FOREHAND_DINK", backhand: "BACKHAND_DINK" },
  volley: { forehand: "FOREHAND_VOLLEY", backhand: "BACKHAND_VOLLEY" },
};

function selectableByCanonical(canonical: string): SelectableTechnique | null {
  return SELECTABLE_TECHNIQUES_V1.find((technique) => technique.canonical === canonical) ?? null;
}

function selectableForSlug(slug: PickleballTechniqueSlug): SelectableTechnique | null {
  const grammar = SLUG_GRAMMARS.find((entry) => entry.slug === slug)!;
  if (slug.startsWith("third_shot_drop") || slug.startsWith("transition_drop")) {
    return selectableByCanonical("DROP");
  }
  if (slug.startsWith("reset_")) return selectableByCanonical("RESET");
  if (slug.startsWith("speedup_")) return selectableByCanonical("SPEEDUP");
  if (slug === "overhead_smash" || slug === "backhand_overhead") {
    return selectableByCanonical("OVERHEAD");
  }
  const sideKey =
    grammar.side === "forehand"
      ? "forehand"
      : grammar.side === "backhand" || grammar.side === "two_hand_backhand"
        ? "backhand"
        : "none";
  const canonical = FAMILY_SIDE_TO_SELECTABLE[grammar.family]?.[sideKey];
  return canonical ? selectableByCanonical(canonical) : null;
}

export function projectVoiceResolution(resolution: VoiceIntentResolution): IntentResolution {
  if (resolution.status === "auto") return { status: "auto" };
  if (resolution.status === "unknown") {
    return { status: "unknown", reason: resolution.reason };
  }
  if (resolution.status === "leaf") {
    const selectable = selectableForSlug(resolution.slug);
    if (selectable) {
      return { status: "resolved", technique: selectable, confidence: resolution.confidence };
    }
    return {
      status: "unknown",
      reason: `"${resolution.slug}" is a recognized technique but is not in the capture-selectable set yet`,
    };
  }
  const selectables = [
    ...new Map(
      resolution.candidates
        .map((slug) => selectableForSlug(slug))
        .filter((technique): technique is SelectableTechnique => technique !== null)
        .map((technique) => [technique.canonical, technique] as const),
    ).values(),
  ];
  if (selectables.length === 0) {
    return {
      status: "unknown",
      reason: "no matching technique is in the capture-selectable set yet",
    };
  }
  if (selectables.length === 1) {
    return { status: "resolved", technique: selectables[0]!, confidence: 0.9 };
  }
  return { status: "ambiguous", options: selectables, reason: resolution.reason };
}
