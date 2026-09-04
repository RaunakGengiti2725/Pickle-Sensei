/**
 * XC journey harness — module seams. Import this file FIRST in a journey test
 * (before anything that pulls in the screens) so the mocks below are
 * registered before the real modules are evaluated.
 *
 * What is replaced and why:
 *  - `@op-engineering/op-sqlite`  → real SQLite (node:sqlite) in a worker; the
 *    production `src/data/db.ts` migrations and every repository query run
 *    unmodified against it.
 *  - `@react-navigation/*`         → the in-process stack host
 *    (navigationHarness.tsx): react-native-screens has no test host.
 *  - `react-native-safe-area-context`, `react-native-svg`,
 *    `react-native-linear-gradient`, `react-native-webview` → plain Views
 *    (native-only renderers; the WebView belongs to DrillLibrary, off-journey).
 *  - `src/camera/capture`          → the typed native camera seam
 *    (cameraSeam.ts); iOS/Vision execution is BLOCKED_EXTERNAL on Linux.
 *
 * `fetch` is NOT mocked here: the harness installs the scripted journey
 * server as `globalThis.fetch` so the production API clients run verbatim.
 */
import React from 'react';

jest.mock('@op-engineering/op-sqlite', () => {
  const { opSqliteMockModule } = jest.requireActual<
    typeof import('./nodeSqliteOpSqlite')
  >('./nodeSqliteOpSqlite');
  return opSqliteMockModule;
});

jest.mock('@react-navigation/native', () => {
  const harness = jest.requireActual<typeof import('./navigationHarness')>(
    './navigationHarness',
  );
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  return {
    NavigationContainer: (props: { children?: React.ReactNode }) =>
      ReactLib.createElement(ReactLib.Fragment, null, props.children),
    DefaultTheme: { dark: false, colors: {} },
    createNavigationContainerRef: () => ({
      isReady: () => false,
      navigate: () => {},
    }),
    useNavigation: () => {
      const { stack, route } = harness.useHarnessRoute();
      return stack.navigationFor(route);
    },
    useRoute: () => harness.useHarnessRoute().route,
    useFocusEffect: harness.useHarnessFocusEffect,
    useIsFocused: harness.useHarnessFocused,
  };
});

jest.mock('@react-navigation/native-stack', () => {
  const harness = jest.requireActual<typeof import('./navigationHarness')>(
    './navigationHarness',
  );
  return {
    createNativeStackNavigator: () => ({
      Navigator: harness.HarnessStackNavigator,
      Screen: () => null,
    }),
  };
});

jest.mock('@react-navigation/bottom-tabs', () => {
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    createBottomTabNavigator: () => ({
      Navigator: () =>
        ReactLib.createElement(View, { testID: 'xc-tabs-placeholder' }),
      Screen: () => null,
    }),
  };
});

jest.mock('react-native-safe-area-context', () => {
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaProvider: (props: { children?: React.ReactNode }) =>
      ReactLib.createElement(ReactLib.Fragment, null, props.children),
    SafeAreaView: (props: { children?: React.ReactNode; testID?: string }) =>
      ReactLib.createElement(View, { testID: props.testID }, props.children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

jest.mock('react-native-svg', () => {
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    ReactLib.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Defs: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    RadialGradient: Mock,
    LinearGradient: Mock,
    Rect: Mock,
    Stop: Mock,
    Text: Mock,
  };
});

jest.mock('react-native-linear-gradient', () => {
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactLib.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

jest.mock('react-native-webview', () => {
  const ReactLib = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const WebView = (props: { testID?: string }) =>
    ReactLib.createElement(View, { testID: props.testID ?? 'xc-webview' });
  return { __esModule: true, default: WebView, WebView };
});

jest.mock('../../src/camera/capture', () => {
  const { cameraSeamModule } =
    jest.requireActual<typeof import('./cameraSeam')>('./cameraSeam');
  return cameraSeamModule(
    jest.requireActual<Record<string, unknown>>('../../src/camera/capture'),
  );
});
