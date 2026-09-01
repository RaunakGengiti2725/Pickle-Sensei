import { useEffect, useRef } from 'react';
import type { HostInstance } from 'react-native';

/**
 * Walkthrough target registry. The spotlight tour points at REAL interface
 * elements — the Coach button, the rank banner, the tabs — so the components
 * that own those elements register a measurer here and the overlay asks for
 * live window coordinates at show time. Nothing is hardcoded to a device
 * size, and a target that is not currently on screen simply measures null so
 * its step is skipped instead of pointing at empty space.
 */

export type WalkthroughTargetKey =
  'coach-fab' | 'rank-banner' | 'tab-library' | 'tab-progress';

export interface TargetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type TargetMeasurer = () => Promise<TargetRect | null>;

const measurers = new Map<WalkthroughTargetKey, TargetMeasurer>();

/** Register the live measurer for a target; returns the unregister cleanup.
 * Last writer wins — remounts replace their stale predecessor. */
export function registerWalkthroughMeasurer(
  key: WalkthroughTargetKey,
  measure: TargetMeasurer,
): () => void {
  measurers.set(key, measure);
  return () => {
    if (measurers.get(key) === measure) measurers.delete(key);
  };
}

export function hasWalkthroughTarget(key: WalkthroughTargetKey): boolean {
  return measurers.has(key);
}

/** Current window rect of a target, or null when the target is unregistered,
 * unmounted, or has no laid-out size (hidden tab screens measure as zero). */
export async function measureWalkthroughTarget(
  key: WalkthroughTargetKey,
): Promise<TargetRect | null> {
  const measure = measurers.get(key);
  if (!measure) return null;
  try {
    return await measure();
  } catch {
    // A measurement failure means "cannot point at it right now" — the step
    // is skipped; it must never take the tour down.
    return null;
  }
}

/** Attach a real view as a walkthrough target: spread the returned ref onto
 * the element the arrow should point at. */
export function useWalkthroughTarget(key: WalkthroughTargetKey) {
  const ref = useRef<HostInstance | null>(null);

  useEffect(() => {
    return registerWalkthroughMeasurer(
      key,
      () =>
        new Promise<TargetRect | null>(resolve => {
          const node = ref.current;
          if (!node || typeof node.measureInWindow !== 'function') {
            resolve(null);
            return;
          }
          node.measureInWindow((x, y, width, height) => {
            if (
              !Number.isFinite(x) ||
              !Number.isFinite(y) ||
              !Number.isFinite(width) ||
              !Number.isFinite(height) ||
              width <= 0 ||
              height <= 0
            ) {
              resolve(null);
              return;
            }
            resolve({ x, y, width, height });
          });
        }),
    );
  }, [key]);

  return ref;
}
