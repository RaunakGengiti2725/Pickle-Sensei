import { Platform, StatusBar } from 'react-native';
import {
  initialWindowMetrics,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

/** Native full-screen modals can briefly report zero system insets on iOS. */
export function useReliableSafeAreaInsets(): {
  top: number;
  bottom: number;
} {
  const insets = useSafeAreaInsets();
  const topFallback =
    Platform.OS === 'ios' ? 44 : (StatusBar.currentHeight ?? 0);
  const bottomFallback = Platform.OS === 'ios' ? 34 : 0;
  return {
    top: Math.max(insets.top, initialWindowMetrics?.insets.top ?? topFallback),
    bottom: Math.max(
      insets.bottom,
      initialWindowMetrics?.insets.bottom ?? bottomFallback,
    ),
  };
}
