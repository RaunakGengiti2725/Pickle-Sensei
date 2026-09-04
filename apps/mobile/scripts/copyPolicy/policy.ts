/**
 * Release copy policy — the machine-readable form of the store/user-facing
 * copy rules in docs/APP_STORE_SUBMISSION.md §0 rules 4–5, REVIEW.md
 * "Launch flow & copy" and docs/CLAIM_REVIEW.md ("the claim may not be used").
 *
 * Two families of rule:
 *   forbidden_term — words that must not appear in user-visible copy at all
 *                    (Android, Google Play, guest mode, Live Court, DUPR,
 *                    competitor names).
 *   claim          — accuracy percentages, superlatives and "as good as a
 *                    coach" equivalence claims.
 *
 * Every rule carries a `confidence`: `strict` rules are policy violations on
 * their own; `triage` rules are broad nets (e.g. the bare word "best") whose
 * hits need a human read and are reported separately so the strict set stays
 * zero-noise.
 */

export type RuleCategory = 'forbidden_term' | 'claim';
export type RuleConfidence = 'strict' | 'triage';

export interface CopyRule {
  id: string;
  category: RuleCategory;
  confidence: RuleConfidence;
  /** Source rule the pattern implements (for the report). */
  source: string;
  pattern: RegExp;
  /**
   * Optional second pattern that must ALSO match the same string for the rule
   * to fire (compound rules such as "a percentage next to an accuracy word").
   */
  requires?: RegExp;
}

const APP_STORE_RULE_4 = 'docs/APP_STORE_SUBMISSION.md §0 rule 4';
const APP_STORE_RULE_5 = 'docs/APP_STORE_SUBMISSION.md §0 rule 5';
const CLAIM_REVIEW = 'docs/CLAIM_REVIEW.md verdict';

export const COPY_RULES: readonly CopyRule[] = [
  // ---- forbidden terms -------------------------------------------------
  {
    id: 'android',
    category: 'forbidden_term',
    confidence: 'strict',
    source: APP_STORE_RULE_4,
    pattern: /\bandroid\b/i,
  },
  {
    id: 'google_play',
    category: 'forbidden_term',
    confidence: 'strict',
    source: APP_STORE_RULE_4,
    pattern: /\b(google\s*play|play\s+store)\b/i,
  },
  {
    id: 'guest_mode',
    category: 'forbidden_term',
    confidence: 'strict',
    source: APP_STORE_RULE_4,
    pattern: /\bguest\s*(mode|account|access|sign[- ]?in|user)\b/i,
  },
  {
    id: 'guest_word',
    category: 'forbidden_term',
    confidence: 'triage',
    source: `${APP_STORE_RULE_4} (broad net: any "guest")`,
    pattern: /\bguests?\b/i,
  },
  {
    id: 'live_court',
    category: 'forbidden_term',
    confidence: 'strict',
    source: APP_STORE_RULE_4,
    pattern: /\blive\s*court\b/i,
  },
  {
    id: 'dupr',
    category: 'forbidden_term',
    confidence: 'strict',
    source: `${APP_STORE_RULE_4} (third-party trademark)`,
    pattern: /\bDUPR\b/i,
  },
  {
    id: 'competitor',
    category: 'forbidden_term',
    confidence: 'strict',
    source: `${APP_STORE_RULE_4} (guideline 2.3.7; names from docs/CLAIM_REVIEW.md)`,
    pattern:
      /\b(swing\s*vision|pb\s*vision|selkirk|joola|sports\s*reflector|dink\s*ai|stroke\s*analy[sz]er\s+app|home\s*court|zepp)\b/i,
  },

  // ---- claims ----------------------------------------------------------
  {
    id: 'accuracy_percent',
    category: 'claim',
    confidence: 'strict',
    source: `${APP_STORE_RULE_5} (accuracy percentages)`,
    pattern: /\d{1,3}(?:\.\d+)?\s?(?:%|percent\b)/i,
    requires:
      /\b(accura\w*|precis\w*|correct\w*|reliab\w*|detect\w*|success\w*|confiden\w*|error\s+rate|recall|hit\s+rate)\b/i,
  },
  {
    id: 'percent_literal',
    category: 'claim',
    confidence: 'triage',
    source: `${APP_STORE_RULE_5} (broad net: any percentage in copy)`,
    pattern: /\d{1,3}(?:\.\d+)?\s?(?:%|percent\b)/i,
  },
  {
    id: 'superlative',
    category: 'claim',
    confidence: 'strict',
    source: `${APP_STORE_RULE_5} / ${CLAIM_REVIEW} (superlatives)`,
    pattern:
      /(?<!\w)#\s?1\b|\b(the\s+best\s+(pickleball|app|coach|analy\w+|way)|best[- ]in[- ]class|number\s+one|no\.\s?1\b|world[- ]class|most\s+(accurate|advanced|precise|powerful|trusted|popular|reliable)|unmatched|unrivall?ed|industry[- ]leading|market[- ]leading|leading\s+(pickleball|app|coach\w*|analy\w+)|top[- ]rated|revolutionary|perfectly\s+accurate|guarantee[ds]?\s+(improvement|results?|accura\w+)|flawless|the\s+ultimate|the\s+only\s+(app|coach|way)|cutting[- ]edge|state[- ]of[- ]the[- ]art|professional[- ]grade|pro[- ]grade|elite[- ]level|expert[- ]level|unbeatable|clinically\s+proven|scientifically\s+proven)\b/i,
  },
  {
    id: 'superlative_word',
    category: 'claim',
    confidence: 'triage',
    source: `${APP_STORE_RULE_5} (broad net: best / perfect / guarantee / proven / ultimate / expert / elite / pro-level)`,
    pattern:
      /\b(best|perfect\w*|guarantee\w*|proven|ultimate|expert\w*|elite|pro[- ]level|world|leading|revolution\w*|advanced)\b/i,
  },
  {
    id: 'ai_coach_equivalence',
    category: 'claim',
    confidence: 'strict',
    source: `${APP_STORE_RULE_5} (AI-coach equivalence)`,
    pattern:
      /\b(replace[sd]?|replacing|as\s+good\s+as|better\s+than|equivalent\s+to|equal\s+to|like\s+having|just\s+like|same\s+as|instead\s+of|no\s+need\s+for|without\s+(a|an|the)|rivals?|matches)\b[^.\n]{0,40}\b(coach\w*|instructor|trainer|lesson|pro)\b|\b(ai|a\.i\.|virtual|personal|private|pocket|24\/7|robot)\s+(pickleball\s+)?coach(es|ing)?\b|\bcoach(es)?\s+in\s+your\s+pocket\b|\b(certified|expert|professional|pro|real)\s+coach(es)?\b/i,
  },
  {
    id: 'ai_mention',
    category: 'claim',
    confidence: 'triage',
    source: `${APP_STORE_RULE_5} (broad net: AI / machine learning wording)`,
    pattern:
      /\bAI\b|\bA\.I\.|\bartificial\s+intelligence\b|\bmachine[- ]learning\b|\bneural\b|\bdeep[- ]learning\b/,
  },
  {
    id: 'accuracy_word',
    category: 'claim',
    confidence: 'triage',
    source: `${APP_STORE_RULE_5} (broad net: accurate / precise wording)`,
    pattern: /\b(accura\w*|precis\w*)\b/i,
  },
];

export const STRICT_RULE_IDS: readonly string[] = COPY_RULES.filter(
  r => r.confidence === 'strict',
).map(r => r.id);

/** Language the dossier approves for ratings/analysis. Reported for balance. */
export const APPROVED_LANGUAGE =
  /\b(validated|server[- ]accepted|estimate[sd]?)\b/i;

export function rulesById(): Map<string, CopyRule> {
  return new Map(COPY_RULES.map(r => [r.id, r]));
}
