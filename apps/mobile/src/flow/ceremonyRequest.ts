import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import {
  AccessibilityInfo,
  findNodeHandle,
  type HostInstance,
} from 'react-native';

/** The control whose activation opened a ceremony; VoiceOver focus returns
 * to it once the ceremony is dismissed. */
export type CeremonyTrigger = HostInstance | number;

/** Hands VoiceOver focus back to `trigger` once its ceremony is gone. The
 * control may have unmounted meanwhile (the screen that opened the ceremony
 * was swapped out while it stayed up); React Native then refuses to resolve
 * its node, and there is nothing left to focus, so the trigger is ignored. */
export function restoreFocusToTrigger(trigger: CeremonyTrigger): boolean {
  let handle: number | null | undefined;
  try {
    handle = findNodeHandle(trigger);
  } catch {
    return false;
  }
  if (handle == null) return false;
  AccessibilityInfo.setAccessibilityFocus(handle);
  return true;
}

interface CeremonyIdentity {
  order: number;
  ownerKey: string | null;
  trigger: CeremonyTrigger | null;
}

const identities = new WeakMap<object, CeremonyIdentity>();
let nextOrder = 0;
let pendingTrigger: CeremonyTrigger | null = null;

export function identifyCeremony(
  content: object,
  ownerKey: string | null = null,
): CeremonyIdentity {
  const existing = identities.get(content);
  if (existing) return existing;
  const identity = { order: ++nextOrder, ownerKey, trigger: pendingTrigger };
  pendingTrigger = null;
  identities.set(content, identity);
  return identity;
}

/** Runs `open` on behalf of `trigger`: the first ceremony identified while it
 * runs (synchronously) remembers the control so dismissal can hand focus
 * back. A run that opens nothing leaves no trigger behind. */
export function openCeremonyFrom<T>(
  trigger: CeremonyTrigger | null,
  open: () => T,
): T {
  const previous = pendingTrigger;
  pendingTrigger = trigger;
  try {
    return open();
  } finally {
    pendingTrigger = previous;
  }
}

/** Modal surfaces competing for the one presentation slot. `permission`
 * (the system sheet) and `paywall` (a navigation route) are already on
 * screen when they register and never take the slot themselves: they
 * withdraw the product-owned surfaces listed in `WITHDRAWS` beneath them.
 * The system sheet covers everything; the paywall withdraws only
 * ceremonies — a notice raised while it is up is the paywall's own error
 * feedback (a Terms/Privacy link that could not be opened) and is shown
 * over it at once. `notice` and `ceremony` wait for the slot. */
type SlotKind = 'ceremony' | 'notice';
type BlockerKind = 'paywall' | 'permission';
export type SurfaceKind = SlotKind | BlockerKind;

const WITHDRAWS: Record<BlockerKind, readonly SlotKind[]> = {
  permission: ['notice', 'ceremony'],
  paywall: ['ceremony'],
};
const PRIORITY: Record<SlotKind, number> = {
  notice: 0,
  ceremony: 1,
};

function isSlotKind(kind: SurfaceKind): kind is SlotKind {
  return kind in PRIORITY;
}

interface Surface {
  id: number;
  kind: SurfaceKind;
}
interface SlotSurface extends Surface {
  kind: SlotKind;
}

export interface SurfaceClaim {
  readonly id: number;
  release: () => void;
}

const surfaces: Surface[] = [];
let presented: SlotSurface | null = null;
let nextSurfaceId = 0;
const surfaceListeners = new Set<() => void>();

function settleSurfaces() {
  const withdrawn = new Set<SlotKind>();
  for (const surface of surfaces) {
    if (!isSlotKind(surface.kind)) {
      WITHDRAWS[surface.kind].forEach(kind => withdrawn.add(kind));
    }
  }
  const candidates = surfaces.filter(
    (surface): surface is SlotSurface =>
      isSlotKind(surface.kind) && !withdrawn.has(surface.kind),
  );
  let next: SlotSurface | null;
  if (presented && candidates.includes(presented)) {
    next = presented;
  } else {
    next =
      candidates.sort(
        (a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.id - b.id,
      )[0] ?? null;
  }
  if (next === presented) return;
  presented = next;
  surfaceListeners.forEach(listener => listener());
}

export function claimSurface(kind: SurfaceKind): SurfaceClaim {
  const surface: Surface = { id: ++nextSurfaceId, kind };
  surfaces.push(surface);
  settleSurfaces();
  return {
    id: surface.id,
    release: () => {
      const index = surfaces.indexOf(surface);
      if (index === -1) return;
      surfaces.splice(index, 1);
      settleSurfaces();
    },
  };
}

export function presentedSurfaceId(): number | null {
  return presented?.id ?? null;
}

export function subscribeToSurfaces(listener: () => void): () => void {
  surfaceListeners.add(listener);
  return () => {
    surfaceListeners.delete(listener);
  };
}

/** Holds the slot while `wanted`; returns whether this claimant currently
 * owns it. A new `generation` releases and re-claims so that a waiting
 * higher-priority surface (an error notice) goes before the next ceremony. */
export function useSurfaceSlot(
  kind: SlotKind,
  wanted: boolean,
  generation = 0,
): boolean {
  const [claimId, setClaimId] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!wanted) return;
    const claim = claimSurface(kind);
    setClaimId(claim.id);
    return () => {
      claim.release();
      setClaimId(id => (id === claim.id ? null : id));
    };
  }, [kind, wanted, generation]);
  const presentedId = useSyncExternalStore(
    subscribeToSurfaces,
    presentedSurfaceId,
    presentedSurfaceId,
  );
  return claimId !== null && presentedId === claimId;
}
