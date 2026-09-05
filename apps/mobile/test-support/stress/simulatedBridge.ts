/**
 * Simulated `PickleVideoCapture` native module + event emitter for the
 * capture stress harness — NEVER the real bridge (Linux cannot run
 * AVFoundation/Vision; see AGENTS.md). Every bridge method is scripted per
 * call by the harness (`script.impl[name]`) and every invocation is
 * recorded (`script.calls`) so the harness can prove which native calls a
 * public-API action made — and which it must not have made.
 *
 * Built inside the `jest.mock('react-native', …)` factory of the stress
 * suite via `require`, so it must stay free of jest globals.
 */
export type BridgeMethod = (...args: unknown[]) => unknown;

export interface BridgeCall {
  method: string;
  args: unknown[];
}

export interface BridgeScript {
  impl: Record<string, BridgeMethod | undefined>;
  calls: BridgeCall[];
}

export const BRIDGE_METHODS = [
  'capture',
  'importVideo',
  'cancel',
  'readTextFile',
  'setCompletionStrategy',
  'startSessionCapture',
  'stopSessionCapture',
  'extractSessionEventClip',
  'extractImportedPoseSequence',
] as const;

export type BridgeMethodName = (typeof BRIDGE_METHODS)[number];

export interface SimulatedBridge {
  /** The object installed as `NativeModules.PickleVideoCapture` (mutable). */
  bridge: Record<string, unknown>;
  /** Original method implementations, to restore after a removal. */
  originals: Record<BridgeMethodName, BridgeMethod>;
  script: BridgeScript;
  /** Listeners registered through the simulated NativeEventEmitter. */
  listeners: Array<(event: object) => void>;
  /** The NativeEventEmitter replacement for the react-native mock. */
  NativeEventEmitter: new () => {
    addListener(
      type: string,
      listener: (event: object) => void,
    ): { remove(): void };
  };
}

export function createSimulatedBridge(): SimulatedBridge {
  const script: BridgeScript = { impl: {}, calls: [] };
  const listeners: Array<(event: object) => void> = [];
  const method =
    (name: BridgeMethodName): BridgeMethod =>
    (...args: unknown[]) => {
      script.calls.push({ method: name, args });
      const impl = script.impl[name];
      if (!impl) {
        throw new Error(`simulated bridge: ${name} called without a script`);
      }
      return impl(...args);
    };
  const originals = Object.fromEntries(
    BRIDGE_METHODS.map(name => [name, method(name)]),
  ) as Record<BridgeMethodName, BridgeMethod>;
  const bridge: Record<string, unknown> = {
    ...originals,
    addListener: () => undefined,
    removeListeners: () => undefined,
  };
  class SimulatedNativeEventEmitter {
    addListener(_type: string, listener: (event: object) => void) {
      listeners.push(listener);
      return {
        remove: () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      };
    }
  }
  return {
    bridge,
    originals,
    script,
    listeners,
    NativeEventEmitter: SimulatedNativeEventEmitter,
  };
}
