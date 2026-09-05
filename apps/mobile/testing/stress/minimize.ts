/**
 * ddmin-style minimizer for a failing action sequence: repeatedly tries to
 * drop chunks of the recorded actions while the (replayed) sequence still
 * reproduces a failure. Bounded by `maxReplays` so a stubborn seed cannot
 * stall the campaign; the result is always a subsequence of the original.
 */
export async function minimizeSequence<T>(
  actions: T[],
  stillFails: (candidate: T[]) => Promise<boolean>,
  maxReplays = 80,
): Promise<{ actions: T[]; replays: number }> {
  let current = actions;
  let replays = 0;
  let granularity = 2;
  while (current.length >= 2 && replays < maxReplays) {
    const chunk = Math.ceil(current.length / granularity);
    let reduced = false;
    for (
      let start = 0;
      start < current.length && replays < maxReplays;
      start += chunk
    ) {
      const candidate = [
        ...current.slice(0, start),
        ...current.slice(start + chunk),
      ];
      if (candidate.length === 0) continue;
      replays += 1;
      if (await stillFails(candidate)) {
        current = candidate;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= current.length) break;
      granularity = Math.min(current.length, granularity * 2);
    }
  }
  return { actions: current, replays };
}
