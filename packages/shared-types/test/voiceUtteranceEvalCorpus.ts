/**
 * Expanded voice-intent robustness corpus — SYNTHETIC transcripts written by
 * hand (no real user speech, no speech engine). Gold labels are at the
 * PROJECTION level (the picker acts on projectVoiceResolution output):
 *
 *  - resolved(canonical): the ONLY silent-select outcome. Anything else the
 *    UI re-prompts (ambiguous narrows the grid, unknown shows re-prompt copy).
 *  - ambiguous: must narrow, never auto-pick.
 *  - auto: declared-null AUTO DETECT.
 *  - unknown: honest re-prompt (includes taxonomy techniques with no
 *    capture-selectable analog — never rounded).
 *
 * FALSE ACCEPT (the metric that matters): projection returns resolved when
 * gold is not resolved, or resolved with the wrong canonical — i.e. the app
 * silently mis-selects a technique the player did not declare.
 */

export type EvalGold =
  | { kind: "resolved"; canonical: string }
  | { kind: "ambiguous" }
  | { kind: "auto" }
  | { kind: "unknown" };

export type EvalCategory =
  | "clean"
  | "misspelling"
  | "filler"
  | "multi_intent"
  | "non_technique"
  | "ambiguous_term"
  | "auto"
  | "unselectable_specialty";

export interface EvalUtterance {
  transcript: string;
  category: EvalCategory;
  gold: EvalGold;
}

const resolved = (canonical: string): EvalGold => ({ kind: "resolved", canonical });
const ambiguous: EvalGold = { kind: "ambiguous" };
const auto: EvalGold = { kind: "auto" };
const unknown: EvalGold = { kind: "unknown" };

export const VOICE_EVAL_CORPUS: readonly EvalUtterance[] = [
  // ---- clean, fully/product-level specified phrases ----
  { transcript: "backhand dink", category: "clean", gold: resolved("BACKHAND_DINK") },
  { transcript: "forehand drive", category: "clean", gold: resolved("FOREHAND_DRIVE") },
  { transcript: "serve", category: "clean", gold: resolved("SERVE") },
  { transcript: "returns", category: "clean", gold: resolved("RETURN") },
  { transcript: "overhead smash", category: "clean", gold: resolved("OVERHEAD") },
  { transcript: "forehand third shot drop", category: "clean", gold: resolved("DROP") },
  { transcript: "reset", category: "clean", gold: resolved("RESET") },
  { transcript: "forehand speed up", category: "clean", gold: resolved("SPEEDUP") },
  { transcript: "forehand volley", category: "clean", gold: resolved("FOREHAND_VOLLEY") },
  { transcript: "crosscourt forehand dink", category: "clean", gold: resolved("FOREHAND_DINK") },
  { transcript: "backhand slice return", category: "clean", gold: resolved("RETURN") },
  { transcript: "work on my forehand drive", category: "clean", gold: resolved("FOREHAND_DRIVE") },

  // ---- misspellings / ASR-style variants ----
  { transcript: "forhand drive", category: "misspelling", gold: resolved("FOREHAND_DRIVE") },
  { transcript: "fourhand drive", category: "misspelling", gold: resolved("FOREHAND_DRIVE") },
  { transcript: "four hand drive", category: "misspelling", gold: resolved("FOREHAND_DRIVE") },
  { transcript: "bakhand dink", category: "misspelling", gold: resolved("BACKHAND_DINK") },
  { transcript: "backand dink", category: "misspelling", gold: resolved("BACKHAND_DINK") },
  { transcript: "back hand dink", category: "misspelling", gold: resolved("BACKHAND_DINK") },
  { transcript: "forehand volly", category: "misspelling", gold: resolved("FOREHAND_VOLLEY") },
  { transcript: "backhand vollie", category: "misspelling", gold: resolved("BACKHAND_VOLLEY") },
  { transcript: "surve", category: "misspelling", gold: resolved("SERVE") },
  { transcript: "serv", category: "misspelling", gold: resolved("SERVE") },
  {
    transcript: "crosscort forehand dink",
    category: "misspelling",
    gold: resolved("FOREHAND_DINK"),
  },
  { transcript: "3rd shot drop", category: "misspelling", gold: resolved("DROP") },
  { transcript: "overhead slam", category: "misspelling", gold: resolved("OVERHEAD") },

  // ---- fillers / conversational padding ----
  { transcript: "um my forehand drive", category: "filler", gold: resolved("FOREHAND_DRIVE") },
  {
    transcript: "uh like a backhand dink i guess",
    category: "filler",
    gold: resolved("BACKHAND_DINK"),
  },
  { transcript: "let's work on um the serve", category: "filler", gold: resolved("SERVE") },
  {
    transcript: "okay so basically my third shot drop",
    category: "filler",
    gold: resolved("DROP"),
  },
  { transcript: "hmm maybe reset", category: "filler", gold: resolved("RESET") },
  {
    transcript: "i wanna practice my forehand volley please",
    category: "filler",
    gold: resolved("FOREHAND_VOLLEY"),
  },
  { transcript: "uh speed up", category: "filler", gold: resolved("SPEEDUP") },
  { transcript: "er the return", category: "filler", gold: resolved("RETURN") },

  // ---- multi-intent phrases: must narrow, never silently pick one ----
  { transcript: "forehand and backhand dink", category: "multi_intent", gold: ambiguous },
  { transcript: "forehand or backhand drive", category: "multi_intent", gold: ambiguous },
  { transcript: "backhand and forehand volley", category: "multi_intent", gold: ambiguous },
  { transcript: "dink or volley", category: "multi_intent", gold: ambiguous },
  { transcript: "serve and return", category: "multi_intent", gold: ambiguous },
  { transcript: "drives and dinks", category: "multi_intent", gold: ambiguous },
  { transcript: "forehand drive and backhand volley", category: "multi_intent", gold: ambiguous },
  { transcript: "dinks volleys and resets", category: "multi_intent", gold: ambiguous },

  // ---- non-technique speech (incl. idioms reusing technique words) ----
  { transcript: "make me a sandwich", category: "non_technique", gold: unknown },
  { transcript: "what's the score", category: "non_technique", gold: unknown },
  { transcript: "serve dinner tonight", category: "non_technique", gold: unknown },
  { transcript: "that serves you right", category: "non_technique", gold: unknown },
  { transcript: "return my call later", category: "non_technique", gold: unknown },
  { transcript: "can you return it", category: "non_technique", gold: unknown },
  { transcript: "drop me off at the court", category: "non_technique", gold: unknown },
  { transcript: "just drop it", category: "non_technique", gold: unknown },
  { transcript: "the kitchen counter", category: "non_technique", gold: unknown },
  { transcript: "on a roll today", category: "non_technique", gold: unknown },
  { transcript: "let's roll", category: "non_technique", gold: unknown },
  { transcript: "drive home safely", category: "non_technique", gold: unknown },
  { transcript: "block out the sun", category: "non_technique", gold: unknown },
  { transcript: "my elbow hurts", category: "non_technique", gold: unknown },

  // ---- ambiguous single terms: narrow the grid, never guess a side ----
  { transcript: "dink", category: "ambiguous_term", gold: ambiguous },
  { transcript: "volley", category: "ambiguous_term", gold: ambiguous },
  { transcript: "drop", category: "ambiguous_term", gold: ambiguous },
  { transcript: "my backhand", category: "ambiguous_term", gold: ambiguous },
  { transcript: "forehand", category: "ambiguous_term", gold: ambiguous },
  { transcript: "punch volley", category: "ambiguous_term", gold: ambiguous },
  { transcript: "slice", category: "ambiguous_term", gold: ambiguous },

  // ---- auto / declared-null ----
  { transcript: "auto detect", category: "auto", gold: auto },
  { transcript: "just detect it", category: "auto", gold: auto },
  { transcript: "not sure", category: "auto", gold: auto },
  { transcript: "no idea", category: "auto", gold: auto },
  { transcript: "surprise me", category: "auto", gold: auto },
  { transcript: "whatever you think", category: "auto", gold: auto },

  // ---- taxonomy techniques with no capture-selectable analog ----
  { transcript: "tweener", category: "unselectable_specialty", gold: unknown },
  { transcript: "bert", category: "unselectable_specialty", gold: unknown },
  { transcript: "forehand erne", category: "unselectable_specialty", gold: unknown },
  { transcript: "ernie", category: "unselectable_specialty", gold: unknown },
  { transcript: "backhand defensive lob", category: "unselectable_specialty", gold: unknown },
];
