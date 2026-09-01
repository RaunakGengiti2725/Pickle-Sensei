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
  DrillLibrary: undefined;
  StreakCalendar: undefined;
  ConnectAccount: undefined;
  ManageAccount: undefined;
  ConsentSettings: undefined;
  NotificationSettings: undefined;
  Paywall: { source?: 'rating' | 'training' | 'settings' } | undefined;
};
