/**
 * Lets a stubbed route (the Home tab in the stress suites) hand the real
 * React Navigation `navigation` object to the test, so the campaign drives
 * the REAL root stack (`navigate('Analyze')` / `goBack()`) instead of poking
 * a private navigation ref.
 */
export interface NavigationProbe {
  navigate(name: string, params?: object): void;
  goBack(): void;
  canGoBack(): boolean;
  getState(): { index: number; routes: readonly { name: string }[] };
}

export const navigationProbe: { current: NavigationProbe | null } = {
  current: null,
};
