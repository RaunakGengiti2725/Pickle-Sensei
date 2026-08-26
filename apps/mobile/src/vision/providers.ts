import { createFixtureVisionProviderSet } from '@pickle/vision-contracts';
import type { VisionProviderSet } from '@pickle/vision-contracts';
import type { ShotTypeSlug } from '@pickle/shared-types';

/**
 * Vision provider selection (directive §5/§61).
 *   RealVisionProvider  → native VisionCore TurboModule (Stage-3 native work;
 *                         module contract defined in native/vision-core).
 *   FixtureVisionProvider → development only, unmistakably labeled in UI.
 *
 * In release builds (__DEV__ === false) there is NO fixture fallback: without
 * the native module the app reports MODEL_UNAVAILABLE instead of pretending.
 */

export type ProviderAvailability =
  | { kind: 'real'; providers: VisionProviderSet }
  | { kind: 'fixture'; providers: VisionProviderSet }
  | { kind: 'unavailable'; reason: string };

export function selectVisionProviders(
  shotType: ShotTypeSlug,
): ProviderAvailability {
  // Native VisionCore module not yet shipped; when it lands it is detected here
  // via TurboModuleRegistry.get('PickleVisionCore').
  const nativeAvailable = false;
  if (nativeAvailable) {
    return { kind: 'unavailable', reason: 'native provider wiring pending' };
  }
  if (__DEV__) {
    return {
      kind: 'fixture',
      providers: createFixtureVisionProviderSet(shotType),
    };
  }
  return {
    kind: 'unavailable',
    reason: 'On-device analysis models are not available in this build.',
  };
}
