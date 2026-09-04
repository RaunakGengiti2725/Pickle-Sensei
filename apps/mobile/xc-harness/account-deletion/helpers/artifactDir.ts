import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the harness writes its raw evidence (scenario tables, request logs,
 * survival matrices, heap numbers, finding.*.json repros).
 *
 * Deliberately OUTSIDE the repository tree by default: the dumps contain
 * production row shapes (`owner_key: <uuid>`) that the gitleaks gate flags
 * as generic-api-key, and prettier's format:check would flag the raw JSON.
 * Override with XC_ARTIFACT_DIR. The server-side wrapper
 * (supabase/tests/xc/run_account_deletion_cascade.sh) uses the same default.
 */
export const XC_ARTIFACT_DIR: string =
  process.env.XC_ARTIFACT_DIR ??
  join(
    homedir(),
    '.cache',
    'pickle-sensei',
    'xc-artifacts',
    'account-deletion',
  );

mkdirSync(XC_ARTIFACT_DIR, { recursive: true });
