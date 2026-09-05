/**
 * Delta-debugging minimizer (Zeller's ddmin) over an op list. `stillFails`
 * must be a pure replay: the same op list always yields the same verdict.
 */
export async function ddmin<T>(
  ops: readonly T[],
  stillFails: (candidate: readonly T[]) => Promise<boolean>,
  maxReplays = 400,
): Promise<{ ops: T[]; replays: number }> {
  let current = [...ops];
  let granularity = 2;
  let replays = 0;
  while (current.length >= 2 && replays < maxReplays) {
    const chunk = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let start = 0; start < current.length && replays < maxReplays; start += chunk) {
      const complement = [...current.slice(0, start), ...current.slice(start + chunk)];
      if (complement.length === 0) continue;
      replays++;
      if (await stillFails(complement)) {
        current = complement;
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= current.length) break;
      granularity = Math.min(current.length, granularity * 2);
    }
  }
  return { ops: current, replays };
}
