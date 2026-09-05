import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import type { RootStackParams } from '../../src/navigation/params';
import {
  armTryAgain,
  tryAgainFromResult,
} from '../../src/screens/tryAgainHandoff';

/**
 * Sibling-screen stubs for the RootNavigator stress mount. The unit under
 * test is `AnalyzeScreen` rendered by the PRODUCTION `RootNavigator`
 * (real NavigationContainer, real native-stack + bottom-tab navigators, real
 * `AnalyzeRoute` access gate). The OTHER screens are replaced with minimal
 * stand-ins so the stress budget is spent on the unit — each stub renders a
 * `stress-route` marker the driver reads to know which route is on top, and
 * exposes the handful of navigation edges the real screen has INTO Analyze
 * (Home → Analyze, Result → "Try again" → Analyze, Paywall → close).
 */
type Nav = NativeStackNavigationProp<RootStackParams>;

function Marker({ name }: { name: string }) {
  return <Text testID="stress-route">{name}</Text>;
}

function Action({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
    >
      <Text>{label}</Text>
    </Pressable>
  );
}

export function StubHomeScreen() {
  const navigation = useNavigation<Nav>();
  return (
    <View>
      <Marker name="Tabs/Home" />
      <Action
        label="Start Auto Analyze"
        onPress={() => navigation.navigate('Analyze', { source: 'camera' })}
      />
      <Action
        label="Import a video"
        onPress={() => navigation.navigate('Analyze', { source: 'library' })}
      />
    </View>
  );
}

export function StubResultScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute();
  const params = (route.params ?? {}) as { analysisId?: string };
  return (
    <View>
      <Marker name={`Result:${params.analysisId ?? 'missing'}`} />
      <Action
        label="Try again from result"
        onPress={() => {
          armTryAgain(tryAgainFromResult(null, null));
          navigation.navigate('Analyze', { source: 'camera' });
        }}
      />
      <Action label="Close result" onPress={() => navigation.popToTop()} />
    </View>
  );
}

export function StubPaywallScreen({ onClose }: { onClose: () => void }) {
  return (
    <View>
      <Marker name="Paywall" />
      <Action label="Close paywall" onPress={onClose} />
    </View>
  );
}

export function StubSignInScreen({ onBack }: { onBack: () => void }) {
  return (
    <View>
      <Marker name="ConnectAccount" />
      <Action label="Back from sign in" onPress={onBack} />
    </View>
  );
}

export function stubNamed(name: string): () => React.JSX.Element {
  const Stub = () => <Marker name={name} />;
  Stub.displayName = `Stub(${name})`;
  return Stub;
}

/**
 * Tab buttons with the production tab bar's navigation edge
 * (`props.navigation.navigate(route.name)`), so a sequence can return to
 * Home after "Open Library" the way a player would.
 */
export function StubTabBar(props: BottomTabBarProps) {
  return (
    <View>
      {props.state.routes.map((route, index) => (
        <Action
          key={route.key}
          label={`Tab ${route.name}`}
          onPress={() => {
            if (index === props.state.index) return;
            props.navigation.navigate(route.name);
          }}
        />
      ))}
    </View>
  );
}
