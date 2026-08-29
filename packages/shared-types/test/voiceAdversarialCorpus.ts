/**
 * ADVERSARIAL voice-intent corpus (wave-f f27) — attacks the bounded 73-utterance
 * E20 eval with harder synthetic transcripts. All transcripts are hand-written
 * (no real speech, no ASR engine); golds are at the PROJECTION level, same
 * contract as voiceUtteranceEvalCorpus.ts:
 *
 *  - resolved(canonical): the ONLY silent-select outcome; anything else re-prompts.
 *  - FALSE ACCEPT: projection resolves when gold isn't resolved, or resolves the
 *    wrong canonical — the app silently mis-selects a technique the player did
 *    not declare. This is the attack surface.
 *  - MIS-SELECTION (softer miss): outcome status differs from gold but is not a
 *    silent resolve (e.g. ambiguous where gold is unknown) — UI still re-prompts.
 *
 * Categories:
 *  - near_homophone: ASR near-misses of technique words ("sink" for dink,
 *    "surf" for serve, "valley" for volley, "bernie" for erne…). Gold is
 *    unknown — the grammar must reject, never round to the nearest technique.
 *  - code_switched: Spanish/Hindi/Spanglish mixes. English technique words
 *    present → resolvable; purely non-English technique vocabulary → honest
 *    unknown (the bounded grammar is English-only and must say so).
 *  - negation: "not a dink", "no serves today", "skip the returns". A negated
 *    technique must never be selected; contrastive phrases ("backhand not
 *    forehand dink") should keep the non-negated reading.
 *  - multi_technique: full sentences naming several techniques — must narrow,
 *    never silently pick one.
 *  - ambient_speech: overheard non-command speech that reuses technique words
 *    ("she smashes records", "returning champion", "reset the router") — gold
 *    unknown.
 */
import type { EvalGold } from "./voiceUtteranceEvalCorpus.js";

export type AdversarialCategory =
  "near_homophone" | "code_switched" | "negation" | "multi_technique" | "ambient_speech";

export interface AdversarialUtterance {
  transcript: string;
  category: AdversarialCategory;
  gold: EvalGold;
}

const resolved = (canonical: string): EvalGold => ({ kind: "resolved", canonical });
const ambiguous: EvalGold = { kind: "ambiguous" };
const auto: EvalGold = { kind: "auto" };
const unknown: EvalGold = { kind: "unknown" };

export const VOICE_ADVERSARIAL_CORPUS: readonly AdversarialUtterance[] = [
  // ---- near-homophones: must reject, never round to the nearest technique ----
  // "crosscourt" is genuine technique vocabulary — narrowing to crosscourt
  // techniques and re-prompting is the defensible outcome for this homophone.
  { transcript: "think crosscourt", category: "near_homophone", gold: ambiguous },
  { transcript: "sink shot", category: "near_homophone", gold: unknown },
  { transcript: "drink at the kitchen", category: "near_homophone", gold: unknown },
  { transcript: "dank", category: "near_homophone", gold: unknown },
  { transcript: "surf", category: "near_homophone", gold: unknown },
  { transcript: "swerve left", category: "near_homophone", gold: unknown },
  { transcript: "what nerve", category: "near_homophone", gold: unknown },
  { transcript: "valley", category: "near_homophone", gold: unknown },
  { transcript: "trolley", category: "near_homophone", gold: unknown },
  { transcript: "volleyball", category: "near_homophone", gold: unknown },
  { transcript: "bernie", category: "near_homophone", gold: unknown },
  { transcript: "attorney", category: "near_homophone", gold: unknown },
  { transcript: "burt", category: "near_homophone", gold: unknown },
  { transcript: "birdie", category: "near_homophone", gold: unknown },
  { transcript: "lab shot", category: "near_homophone", gold: unknown },
  { transcript: "slob", category: "near_homophone", gold: unknown },
  { transcript: "derive the answer", category: "near_homophone", gold: unknown },
  { transcript: "smashing", category: "near_homophone", gold: unknown },
  { transcript: "reserve a court", category: "near_homophone", gold: unknown },
  { transcript: "deserve a break", category: "near_homophone", gold: unknown },
  { transcript: "dropped", category: "near_homophone", gold: unknown },
  { transcript: "blocked", category: "near_homophone", gold: unknown },
  // homophone-adjacent TRUE positives — rejecting these would be overcorrection
  { transcript: "erne", category: "near_homophone", gold: unknown }, // taxonomy leaf, not capture-selectable
  { transcript: "forehand dink", category: "near_homophone", gold: resolved("FOREHAND_DINK") },

  // ---- code-switched phrases ----
  {
    transcript: "backhand dink por favor",
    category: "code_switched",
    gold: resolved("BACKHAND_DINK"),
  },
  { transcript: "quiero practicar mi serve", category: "code_switched", gold: resolved("SERVE") },
  { transcript: "el forehand drive", category: "code_switched", gold: resolved("FOREHAND_DRIVE") },
  { transcript: "vamos con el reset", category: "code_switched", gold: resolved("RESET") },
  { transcript: "quiero practicar el saque", category: "code_switched", gold: unknown },
  { transcript: "mi derecha", category: "code_switched", gold: unknown },
  { transcript: "la volea", category: "code_switched", gold: unknown },
  { transcript: "dejadita en la cocina", category: "code_switched", gold: unknown },
  { transcript: "dink karna hai", category: "code_switched", gold: ambiguous },
  { transcript: "volley marna hai", category: "code_switched", gold: ambiguous },
  {
    transcript: "forehand volley karte hain",
    category: "code_switched",
    gold: resolved("FOREHAND_VOLLEY"),
  },
  { transcript: "sirve la pelota", category: "code_switched", gold: unknown },
  {
    transcript: "third shot drop s'il vous plait",
    category: "code_switched",
    gold: resolved("DROP"),
  },
  { transcript: "le service", category: "code_switched", gold: unknown },
  { transcript: "aaj serve practice", category: "code_switched", gold: resolved("SERVE") },

  // ---- negations: a negated technique is never selected ----
  { transcript: "not a dink", category: "negation", gold: unknown },
  { transcript: "not the serve", category: "negation", gold: unknown },
  { transcript: "no serves today", category: "negation", gold: unknown },
  { transcript: "don't do drives", category: "negation", gold: unknown },
  { transcript: "never volleys", category: "negation", gold: unknown },
  { transcript: "skip the returns", category: "negation", gold: unknown },
  { transcript: "without the volley", category: "negation", gold: unknown },
  { transcript: "no more third shot drops", category: "negation", gold: unknown },
  { transcript: "don't want to practice my backhand dink", category: "negation", gold: unknown },
  { transcript: "not overhead smash", category: "negation", gold: unknown },
  { transcript: "no dinks no volleys", category: "negation", gold: unknown },
  { transcript: "skip serves", category: "negation", gold: unknown },
  // contrastive: ideally the NON-negated technique is selected; a safe
  // re-prompt (never the negated technique) is an acceptable degradation and
  // is counted as a mis-selection, not a false accept.
  {
    transcript: "backhand not forehand dink",
    category: "negation",
    gold: resolved("BACKHAND_DINK"),
  },
  { transcript: "not the serve the return", category: "negation", gold: resolved("RETURN") },
  {
    transcript: "not forehand backhand volley",
    category: "negation",
    gold: resolved("BACKHAND_VOLLEY"),
  },
  { transcript: "instead of serves let's dink", category: "negation", gold: ambiguous },
  // "anything" is declared-null AUTO by contract — checked before negation
  { transcript: "anything but dinks", category: "negation", gold: auto },
  { transcript: "not sure honestly", category: "negation", gold: auto },

  // ---- multi-technique sentences: must narrow, never silently pick one ----
  {
    transcript: "practice dinks then finish with serves",
    category: "multi_technique",
    gold: ambiguous,
  },
  { transcript: "serve then return then drive", category: "multi_technique", gold: ambiguous },
  {
    transcript: "let's drill third shot drops and speed ups",
    category: "multi_technique",
    gold: ambiguous,
  },
  { transcript: "warm up with dinks before volleys", category: "multi_technique", gold: ambiguous },
  { transcript: "forehand drive backhand drive", category: "multi_technique", gold: ambiguous },
  { transcript: "maybe a dink maybe a drop", category: "multi_technique", gold: ambiguous },
  { transcript: "either the serve or the return", category: "multi_technique", gold: ambiguous },
  { transcript: "resets and blocks", category: "multi_technique", gold: ambiguous },
  {
    transcript: "i want to work on my serve and my forehand drive",
    category: "multi_technique",
    gold: ambiguous,
  },
  { transcript: "dink volley dink volley", category: "multi_technique", gold: ambiguous },
  { transcript: "overhead smash after the lob", category: "multi_technique", gold: ambiguous },
  {
    transcript: "first serves then third shot drops",
    category: "multi_technique",
    gold: ambiguous,
  },

  // ---- ambient speech: overheard non-command talk reusing technique words ----
  { transcript: "she smashes records", category: "ambient_speech", gold: unknown },
  { transcript: "the returning champion is here", category: "ambient_speech", gold: unknown },
  { transcript: "check the serving size", category: "ambient_speech", gold: unknown },
  { transcript: "reset the router", category: "ambient_speech", gold: unknown },
  { transcript: "reset your password", category: "ambient_speech", gold: unknown },
  { transcript: "grab your punch card", category: "ambient_speech", gold: unknown },
  { transcript: "that's a great punch line", category: "ambient_speech", gold: unknown },
  { transcript: "the block party is saturday", category: "ambient_speech", gold: unknown },
  { transcript: "roll the windows down", category: "ambient_speech", gold: unknown },
  { transcript: "the drive through lane is closed", category: "ambient_speech", gold: unknown },
  { transcript: "he drives a truck for work", category: "ambient_speech", gold: unknown },
  { transcript: "she serves on the board", category: "ambient_speech", gold: unknown },
  { transcript: "serving lunch at noon", category: "ambient_speech", gold: unknown },
  { transcript: "returning customers get a discount", category: "ambient_speech", gold: unknown },
  { transcript: "my phone battery is at ten percent", category: "ambient_speech", gold: unknown },
  { transcript: "wow nice serve", category: "ambient_speech", gold: unknown },
  { transcript: "that was a great dink by sarah", category: "ambient_speech", gold: unknown },
  { transcript: "did you see his drop shot yesterday", category: "ambient_speech", gold: unknown },
  { transcript: "the counter offer came in low", category: "ambient_speech", gold: unknown },
  { transcript: "slice of pizza", category: "ambient_speech", gold: unknown },
  { transcript: "drop the temperature a bit", category: "ambient_speech", gold: unknown },
  { transcript: "smash hit single", category: "ambient_speech", gold: unknown },
];
