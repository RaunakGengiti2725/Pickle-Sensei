/**
 * `useFocusEffect` stand-in that also lets a test re-fire "screen focused"
 * without remounting, the way tab navigation does when the user returns to
 * a screen. Registered callbacks run on mount (like the navigation hook) and
 * again on every `refocus()`, with the previous cleanup run first.
 */
import { useEffect } from 'react';

type FocusCallback = () => void | (() => void);

const active = new Map<FocusCallback, (() => void) | void>();

export function useFocusEffectMock(callback: FocusCallback): void {
  useEffect(() => {
    active.set(callback, callback());
    return () => {
      const cleanup = active.get(callback);
      active.delete(callback);
      if (typeof cleanup === 'function') cleanup();
    };
  }, [callback]);
}

export function refocus(): void {
  for (const [callback, cleanup] of Array.from(active.entries())) {
    if (typeof cleanup === 'function') cleanup();
    active.set(callback, callback());
  }
}

export function focusedCallbackCount(): number {
  return active.size;
}
