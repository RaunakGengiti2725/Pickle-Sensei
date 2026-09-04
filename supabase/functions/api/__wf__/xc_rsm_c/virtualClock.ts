// Process-wide virtual clock. The edge function, cache.ts, rateLimit.ts and
// the fake Supabase all read time through Date.now(), so overriding it lets a
// run jump forward through rate-limit windows and cache TTLs (or backwards,
// to model clock skew) without sleeping. Real timers are untouched.

const realDateNow = Date.now;

export interface VirtualClock {
  now(): number;
  /** Move the clock by `ms` (negative = backwards skew). Returns the new time. */
  advance(ms: number): number;
  set(ms: number): void;
  /** Milliseconds moved forward since install (backward moves excluded). */
  readonly travelledForwardMs: number;
  restore(): void;
}

let installed: VirtualClock | null = null;

export function installVirtualClock(startMs = realDateNow()): VirtualClock {
  if (installed) return installed;
  let current = Math.floor(startMs);
  let forward = 0;
  const clock: VirtualClock = {
    now: () => current,
    advance(ms) {
      const delta = Math.trunc(ms);
      current += delta;
      if (delta > 0) forward += delta;
      return current;
    },
    set(ms) {
      const next = Math.floor(ms);
      if (next > current) forward += next - current;
      current = next;
    },
    get travelledForwardMs() {
      return forward;
    },
    restore() {
      Date.now = realDateNow;
      installed = null;
    },
  };
  Date.now = () => current;
  installed = clock;
  return clock;
}

export function realNow(): number {
  return realDateNow();
}
