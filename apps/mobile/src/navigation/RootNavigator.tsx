import React from 'react';
import { Text } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { color } from '../design/tokens';
import type { RootStackParams } from './params';
import { HomeScreen } from '../screens/HomeScreen';
import { LibraryScreen } from '../screens/LibraryScreen';
import { ProgressScreen } from '../screens/ProgressScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { AnalyzeScreen } from '../screens/AnalyzeScreen';
import { ResultScreen } from '../screens/ResultScreen';
import { LiveCourtScreen } from '../screens/LiveCourtScreen';
import { LiveSummaryScreen } from '../screens/LiveSummaryScreen';

const Stack = createNativeStackNavigator<RootStackParams>();
const Tabs = createBottomTabNavigator();

const TAB_ICONS: Record<string, string> = {
  Home: '⌂',
  Library: '▤',
  Progress: '↗',
  Settings: '⚙',
};

function MainTabs() {
  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: color.court,
        tabBarInactiveTintColor: color.inkSoft,
        tabBarIcon: ({ color: tint }) => (
          <Text style={{ color: tint, fontSize: 18 }}>
            {TAB_ICONS[route.name] ?? '·'}
          </Text>
        ),
      })}
    >
      <Tabs.Screen name="Home" component={HomeScreen} />
      <Tabs.Screen name="Library" component={LibraryScreen} />
      <Tabs.Screen name="Progress" component={ProgressScreen} />
      <Tabs.Screen name="Settings" component={SettingsScreen} />
    </Tabs.Navigator>
  );
}

const theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: color.surface,
    primary: color.court,
  },
};

export function RootNavigator() {
  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator>
        <Stack.Screen
          name="Tabs"
          component={MainTabs}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="Analyze"
          component={AnalyzeScreen}
          options={{ title: 'Analyze Shot' }}
        />
        <Stack.Screen
          name="Result"
          component={ResultScreen}
          options={{ title: 'Result' }}
        />
        <Stack.Screen
          name="LiveCourt"
          component={LiveCourtScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="LiveSummary"
          component={LiveSummaryScreen}
          options={{ title: 'Summary', headerBackVisible: false }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
