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
  /** The full breakdown of one result (stroke map, evidence ledger, sync +
   * provenance, training plan, feedback) — everything the four-page Result
   * guide keeps off its pages, on its own light sheet. */
  ResultDetails: { analysisId: string };
  /** Guided replay of one scored stroke (exoskeleton + heat map + arrows).
   * `phase` opens the review paused on that measured phase's checkpoint
   * stop (from a "See it in your form review" link); absent → from the top. */
  FormReview: { analysisId: string; phase?: string };
  DrillLibrary: undefined;
  StreakCalendar: undefined;
  ConnectAccount: undefined;
  ManageAccount: undefined;
  ConsentSettings: undefined;
  NotificationSettings: undefined;
  Paywall: { source?: 'rating' | 'training' | 'settings' } | undefined;
};
