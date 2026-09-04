import React from 'react';
import { create } from 'zustand';

/**
 * Deep-child render-throw injector for the App.tsx root Gate stress suite.
 *
 * Every stubbed Gate branch renders one `CrashProbe`. Arming the store
 * re-renders ONLY the probe (zustand selector subscription), which throws a
 * render error far below the root — the situation `RootErrorBoundary` exists
 * for — without touching any store the Gate itself selects from.
 */
export const useCrashProbeStore = create<{ armed: boolean }>(() => ({
  armed: false,
}));

export class InjectedRenderError extends Error {
  constructor() {
    super('stress: injected render throw below the root Gate');
    this.name = 'InjectedRenderError';
  }
}

export function CrashProbe(): React.ReactElement | null {
  const armed = useCrashProbeStore(s => s.armed);
  if (armed) throw new InjectedRenderError();
  return null;
}

export function armCrashProbe(armed: boolean): void {
  useCrashProbeStore.setState({ armed });
}
