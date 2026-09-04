/**
 * Defects the randomized campaigns reproduce on 1fb0efd7 (all present on
 * origin/main too). Each entry names the invariant it violates and a matcher
 * over the recorded failure so campaigns can separate KNOWN breakage from
 * NEW breakage; liveCourtKnownDefects.stress.test.ts pins each one with a
 * `test.failing` block that asserts the EXPECTED behaviour. When a defect is
 * fixed, that block starts failing ("expected to fail but passed") — remove
 * the entry here and flip the block to a plain `test`.
 */
import type { SequenceOutcome } from './seededStress';

export interface KnownDefect {
  id: string;
  invariant: string;
  title: string;
  matches: (outcome: SequenceOutcome) => boolean;
}

export const KNOWN_DEFECTS: readonly KnownDefect[] = [
  {
    id: 'LC-1',
    invariant: 'I6',
    title:
      'LiveSessionFlow accepts a non-finite sample time and durationMs becomes NaN/Infinity for the rest of the session',
    matches: outcome =>
      outcome.invariant === 'I6' &&
      /durationMs is (NaN|Infinity)/.test(outcome.failure ?? ''),
  },
  {
    id: 'LC-2',
    invariant: 'I8',
    title:
      'LiveSessionCoach.sessionStarted() after sessionEnded()/dispose() still speaks the session-start line',
    matches: outcome =>
      outcome.invariant === 'I8' &&
      (outcome.failure ?? '').includes('SESSION_START'),
  },
  {
    id: 'LC-3',
    invariant: 'E1',
    title:
      'LiveCourtEngine.onStroke() stamps repIndex after the await — overlapping strokes share/skip indices',
    matches: outcome => outcome.invariant === 'E1',
  },
  {
    id: 'LC-4',
    invariant: 'I11',
    title:
      'completed-session registry snapshot lags flow.snapshot().onUpdateFailures when the end() notify throws',
    // Never recorded as a BROKEN outcome: the model compares the registry
    // WITHOUT onUpdateFailures and counts occurrences in stats.registryLagObserved.
    matches: () => false,
  },
  {
    id: 'LC-5',
    invariant: 'I12',
    title:
      'parseLiveSessionSummaryRecord zeroes a non-integer durationMs that buildLiveSessionSummaryRecord wrote verbatim',
    matches: outcome =>
      outcome.invariant === 'I12' &&
      /round trip differs/.test(outcome.failure ?? '') &&
      /"durationMs":\d+\.\d+/.test(outcome.failure ?? ''),
  },
  {
    id: 'LC-6',
    invariant: 'throughput',
    title:
      'SessionEventEngine re-proposes over the whole sample series on every pushSample — per-sample cost grows with session length (measured only in liveCourtKnownDefects / recorded by the soak)',
    matches: () => false,
  },
];

export function knownDefectFor(outcome: SequenceOutcome): KnownDefect | null {
  return KNOWN_DEFECTS.find(defect => defect.matches(outcome)) ?? null;
}

export function summarizeBroken(outcomes: readonly SequenceOutcome[]): {
  known: Record<string, number>;
  unexpected: SequenceOutcome[];
} {
  const known: Record<string, number> = {};
  const unexpected: SequenceOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.status !== 'BROKEN') continue;
    const defect = knownDefectFor(outcome);
    if (defect === null) unexpected.push(outcome);
    else known[defect.id] = (known[defect.id] ?? 0) + 1;
  }
  return { known, unexpected };
}
