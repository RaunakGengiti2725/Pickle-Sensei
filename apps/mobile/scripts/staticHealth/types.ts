/**
 * Static code-health scanner for apps/mobile — shared types.
 *
 * Every finding carries a stable `fingerprint` (file + category + anchor
 * text, never a line number) so a committed baseline can ratchet: new
 * offenders fail the pinning suite, removed offenders only surface as stale
 * baseline entries.
 */
export type Category =
  | 'marker'
  | 'empty-catch'
  | 'catch-swallows-rejection'
  | 'catch-drops-error'
  | 'as-any'
  | 'double-cast'
  | 'non-null-index'
  | 'non-null'
  | 'ts-directive'
  | 'eslint-disable'
  | 'floating-promise'
  | 'voided-promise-unhandled'
  | 'then-without-catch'
  | 'effect-without-cleanup'
  | 'effect-cleanup-incomplete'
  | 'ref-timer-not-cleared'
  | 'timer-handle-discarded'
  | 'module-timer-uncleared'
  | 'unbounded-loop'
  | 'poll-loop'
  | 'self-rescheduling-timer'
  | 'dead-export'
  | 'test-only-export'
  | 'dead-file'
  | 'constant-condition'
  | 'boolean-const-flag'
  | 'platform-branch'
  | 'dev-branch';

export interface Finding {
  category: Category;
  /** Path relative to apps/mobile, posix separators. */
  file: string;
  line: number;
  column: number;
  /** Stable identity used by the ratchet baseline. */
  fingerprint: string;
  /** Short source excerpt (single line, trimmed). */
  snippet: string;
  /** Why this matters / what was detected. */
  message: string;
  /** Extra structured detail (callee, declaration site, importer list…). */
  detail?: Record<string, string | number | boolean | string[] | null>;
}

export interface ScanReport {
  schemaVersion: 1;
  generatedAt: string;
  root: string;
  files: { production: number; test: number; total: number };
  counts: Record<Category, number>;
  findings: Finding[];
  durationMs: number;
  /** process.memoryUsage() right after the scan, in MiB. */
  memory: { heapUsedMB: number; rssMB: number };
  /** Tool versions the numbers were produced with. */
  versions: { typescript: string; node: string };
}
