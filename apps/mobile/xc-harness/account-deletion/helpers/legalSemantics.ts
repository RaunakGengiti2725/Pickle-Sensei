/**
 * Semantic crosswalk between the in-app deletion confirmation copy
 * (ManageAccountScreen review page + Settings path) and legal.ts §7
 * (RETENTION) / §8 (ACCOUNT DELETION AND OTHER CHOICES).
 *
 * Each clause carries two probes: `legalProbe` must match the shipped
 * legal.ts source (so a future edit to the policy that drops a clause fails
 * here too) and `uiProbe` must match the rendered full-tree copy.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LegalClause {
  id: string;
  section: '§7' | '§8';
  meaning: string;
  legalProbe: RegExp;
  uiProbe: RegExp;
}

const LEGAL_PATH = join(
  __dirname,
  '../../../../../supabase/functions/api/legal.ts',
);

export function legalSource(): string {
  return readFileSync(LEGAL_PATH, 'utf8').replace(/\s+/g, ' ');
}

export const LEGAL_SEMANTICS: readonly LegalClause[] = [
  {
    id: 'path',
    section: '§8',
    meaning: 'Deletion lives at Settings → Manage account → Delete account',
    legalProbe: /Settings → Manage account → Delete account/,
    uiProbe: /Manage account[\s\S]*Delete account/,
  },
  {
    id: 'permanent',
    section: '§8',
    meaning: 'After the final confirmation deletion is permanent',
    legalProbe: /deletion is permanent/,
    uiProbe: /permanently deletes[\s\S]*cannot be undone/,
  },
  {
    id: 'scope',
    section: '§8',
    meaning:
      'Removes the account, profile, synced analysis history, progress and entitlement (membership) records',
    legalProbe:
      /removes the account and its associated profile, synced analysis history[\s\S]*progress data[\s\S]*entitlement row/,
    uiProbe:
      /account and all synced data[\s\S]*profile, analysis history, progress, and membership records/,
  },
  {
    id: 'free-ratings-retained',
    section: '§8',
    meaning:
      'Used free ratings are not restored; same Apple/Google sign-in does not get them again (§7 hashed ledger)',
    legalProbe:
      /Free ratings you have already used are not restored by deleting the account[\s\S]*same Apple or Google account/,
    uiProbe:
      /Free ratings you've already used stay used[\s\S]*same Apple or Google sign-in won't get them again/,
  },
  {
    id: 'device-clips',
    section: '§7',
    meaning:
      'Device-only clips stay in app-private storage until app deletion; server deletion does not erase them',
    legalProbe:
      /Deleting your server account does not itself erase a clip file already stored on the phone/,
    uiProbe:
      /Clips saved on this phone stay on this phone until you delete the app/,
  },
  {
    id: 'subscription',
    section: '§8',
    meaning:
      'Deletion does not cancel an auto-renewing subscription nor create a refund; cancel in the store first',
    legalProbe:
      /does not cancel an auto-renewing subscription[\s\S]*does not itself create a refund/,
    uiProbe:
      /does not cancel a subscription or issue a refund[\s\S]*cancel before deleting/,
  },
  {
    id: 'survey-optional',
    section: '§8',
    meaning: 'The exit survey is optional and can be skipped',
    legalProbe: /The optional survey can be skipped/,
    uiProbe: /Skip the survey|Skip this question|or skip and continue/,
  },
  {
    id: 'two-step',
    section: '§8',
    meaning: 'A separate final confirmation precedes deletion',
    legalProbe: /After the separate final confirmation succeeds/,
    uiProbe: /Continue to delete|Permanently delete/,
  },
];

/** Forbidden user-facing terms (APP_STORE_SUBMISSION.md §1 rule 4/5). DUPR
 * is deliberately excluded here because the dossier records the in-app
 * "DUPR-style estimate" disclaimer on the Settings root as a known,
 * accepted item; the deletion dialog itself must still be clean. */
export const FORBIDDEN_COPY_TERMS: readonly RegExp[] = [
  /Android/,
  /Google Play/,
  /guest mode/i,
  /Live Court/,
  /SwingVision|PB Vision|Selkirk|JOOLA/,
  /\d+\s?% accura/i,
  /\bbest\b/i,
];

export interface LegalCheck {
  passed: string[];
  failed: string[];
  legalMissing: string[];
}

export function checkCopyAgainstLegal(uiCopy: string): LegalCheck {
  const legal = legalSource();
  const copy = uiCopy.replace(/\s+/g, ' ').replace(/[’]/g, "'");
  const out: LegalCheck = { passed: [], failed: [], legalMissing: [] };
  for (const clause of LEGAL_SEMANTICS) {
    if (!clause.legalProbe.test(legal)) out.legalMissing.push(clause.id);
    if (clause.uiProbe.test(copy)) out.passed.push(clause.id);
    else out.failed.push(clause.id);
  }
  return out;
}
