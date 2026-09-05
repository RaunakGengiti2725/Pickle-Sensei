/**
 * Side-effect entry: import this FIRST in a stress suite so the timer
 * wrappers are in place before React / scheduler / RN capture the globals.
 * STRESS_TIMER_STACKS=1 additionally records the creation stack of every
 * timer so a leaked one can be attributed.
 */
import { installTimerProbe } from './leakProbe';

const env = (
  globalThis as unknown as {
    process: { env: Record<string, string | undefined> };
  }
).process.env;

installTimerProbe({ captureStacks: env.STRESS_TIMER_STACKS === '1' });
