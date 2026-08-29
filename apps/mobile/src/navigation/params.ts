import type { NavigatorScreenParams } from '@react-navigation/native';

export type MainTabParams = {
  Home: undefined;
  Library: undefined;
  Add: undefined;
  Performance: undefined;
  Settings: undefined;
};

export type RootStackParams = {
  Tabs: NavigatorScreenParams<MainTabParams> | undefined;
  Analyze: { source?: 'camera' | 'library' } | undefined;
  Result: { analysisId: string };
  LiveCourt: undefined;
  LiveSummary: { sessionId: string };
  ConnectAccount: undefined;
  ConsentSettings: undefined;
  Paywall:
    { source?: 'rating' | 'live_court' | 'training' | 'settings' } | undefined;
};
