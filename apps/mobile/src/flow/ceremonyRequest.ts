import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { HostInstance } from 'react-native';

/** The control whose activation opened a ceremony; VoiceOver focus returns
 * to it once the ceremony is dismissed. */
export type CeremonyTrigger = HostInstance | number;

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
 * screen when they register; the product-owned `notice` and `ceremony`
 * surfaces wait for the slot and are withdrawn beneath them. */
export type SurfaceKind = 'ceremony' | 'notice' | 'paywall' | 'permission';

const PREEMPTING: ReadonlySet<SurfaceKind> = new Set(['permission', 'paywall']);
const PRIORITY: Record<SurfaceKind, number> = {
  permission: 0,
  paywall: 1,
  notice: 2,
  ceremony: 3,
};

interface Surface {
  id: number;
  kind: SurfaceKind;
}

export interface SurfaceClaim {
  readonly id: number;
  release: () => void;
}

const surfaces: Surface[] = [];
let presented: Surface | null = null;
let nextSurfaceId = 0;
const surfaceListeners = new Set<() => void>();

function settleSurfaces() {
  const preempting = surfaces.filter(surface => PREEMPTING.has(surface.kind));
  let next: Surface | null;
  if (preempting.length > 0) {
    next = preempting[preempting.length - 1]!;
  } else if (presented && surfaces.includes(presented)) {
    next = presented;
  } else {
    next =
      [...surfaces].sort(
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
  kind: SurfaceKind,
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
