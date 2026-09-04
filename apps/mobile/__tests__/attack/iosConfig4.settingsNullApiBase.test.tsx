import React from 'react';
import { Linking, NativeModules, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Attack pass mobile-ios-config-4 / scenario S5: `API_BASE_URL` is `null`
 * (the shape runtimeConfig.ts declares as legal) and SettingsScreen renders.
 * The legal rows must disappear (or be inert) — never open `null/privacy`.
 *
 * Unlike a hand-written mirror of the config, the mock below is the REAL
 * `src/config/runtimeConfig.ts` source with ONLY the `API_BASE_URL` literal
 * swapped for `null`, compiled through the app's own Babel config. Whatever
 * derivation the module does for the legal URLs is therefore under test.
 */

// Node built-ins, typed the way the wf suites do (the RN tsconfig ships no
// node types).
interface NodeFs {
  readFileSync(file: string, encoding: 'utf8'): string;
}
interface NodePath {
  join(...parts: string[]): string;
}
interface BabelCore {
  transformSync(
    code: string,
    options: {
      filename: string;
      cwd: string;
      babelrc: boolean;
      configFile: string;
    },
  ): { code?: string | null } | null;
}

jest.mock('../../src/config/runtimeConfig', () => {
  // Compiled inside the factory so the mocked module IS the real module with
  // API_BASE_URL = null (jest hoists this factory; only globals and jest are
  // reachable from here).
  const babel = jest.requireActual<BabelCore>('@babel/core');
  const fsActual = jest.requireActual<NodeFs>('fs');
  const pathActual = jest.requireActual<NodePath>('path');
  // `expect` is one of the few globals a hoisted factory may touch; its
  // state carries this file's absolute path (apps/mobile/__tests__/attack/…).
  const testPath = expect.getState().testPath;
  if (!testPath) throw new Error('jest did not expose testPath');
  const mobileRoot = pathActual.join(testPath, '..', '..', '..');
  const runtimeConfigPath = pathActual.join(
    mobileRoot,
    'src',
    'config',
    'runtimeConfig.ts',
  );
  const source = fsActual.readFileSync(runtimeConfigPath, 'utf8');
  const pattern = /const API_BASE_URL: string \| null =\s*'https:\/\/[^']+';/;
  if (!pattern.test(source)) {
    throw new Error(
      'runtimeConfig.ts no longer declares API_BASE_URL as a non-null https literal — update the attack',
    );
  }
  const mutated = source.replace(
    pattern,
    'const API_BASE_URL: string | null = null;',
  );
  const compiled = babel.transformSync(mutated, {
    filename: runtimeConfigPath,
    cwd: mobileRoot,
    babelrc: false,
    configFile: pathActual.join(mobileRoot, 'babel.config.js'),
  });
  if (!compiled?.code) throw new Error('babel produced no code');
  const compiledModule = { exports: {} as Record<string, unknown> };
  const localRequire = (specifier: string) => {
    if (specifier === 'react-native') {
      return jest.requireActual('react-native');
    }
    throw new Error(`unexpected import in runtimeConfig.ts: ${specifier}`);
  };
  new Function('require', 'module', 'exports', compiled.code)(
    localRequire,
    compiledModule,
    compiledModule.exports,
  );
  return compiledModule.exports;
});

const mockKvTable = new Map<string, string>();
jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactActual = jest.requireActual<typeof import('react')>('react');
    ReactActual.useEffect(() => callback(), [callback]);
  },
}));

import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import { SettingsScreen } from '../../src/screens/SettingsScreen';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import {
  clearAccessStoreConfiguration,
  useAccessStore,
} from '../../src/state/accessStore';
import { useConsentStore } from '../../src/state/consentStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: '22222222-2222-4222-8222-222222222222',
  canonicalAppUserId: '22222222-2222-4222-8222-222222222222',
  localOnly: false,
  displayName: 'Sam Rivera',
  email: 'sam@example.com',
};

const mounted: TestRenderer.ReactTestRenderer[] = [];
let openUrlSpy: jest.SpyInstance;

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<SettingsScreen />);
  });
  mounted.push(renderer);
  return renderer;
}

function isPressable(node: TestRenderer.ReactTestInstance): boolean {
  if (typeof node.type === 'string') return false;
  const component = node.type as { displayName?: string; name?: string };
  return (component.displayName ?? component.name) === 'Pressable';
}

function pressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node => isPressable(node) && typeof node.props.onPress === 'function',
  );
}

function rowsStartingWith(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  return pressables(renderer).filter(
    node =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith(`${label},`),
  );
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

beforeEach(() => {
  mockKvTable.clear();
  mockNavigate.mockClear();
  (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview = {
    requestReview: jest.fn(() => Promise.resolve(true)),
  };
  openUrlSpy = jest
    .spyOn(Linking, 'openURL')
    .mockImplementation(() => Promise.resolve());
  useAuthStore.setState({
    hydrated: true,
    session: syncedSession,
    busy: false,
    error: null,
    signOut: jest.fn(() => Promise.resolve()),
  });
  useAppStore.setState({
    profile: {
      firstName: 'Sam',
      gender: 'female',
      skillLevel: 'beginner',
      handedness: 'left',
      goal: 'dinks',
      biggestProblem: 'consistency',
      focusCheckpoint: 'contact_position',
    },
  });
  clearAccessStoreConfiguration();
  useAccessStore.setState({ status: 'idle', canonicalAccess: null });
  useConsentStore.setState({
    availability: 'ready',
    modelTrainingActive: false,
    busy: false,
    error: null,
    hydrate: jest.fn(() => Promise.resolve()),
  });
  useNotificationStore.setState({ permission: 'unknown' });
  useConsistencyStore.setState({ snapshot: null });
  useWalkthroughStore.setState({ visible: false });
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    if (renderer.toJSON() !== null) act(() => renderer.unmount());
  }
  openUrlSpy.mockRestore();
});

afterAll(() => {
  delete (NativeModules as { PickleStoreReview?: unknown }).PickleStoreReview;
});

describe('S5 — real runtimeConfig with API_BASE_URL = null', () => {
  it('derives null legal URLs (never the string "null/privacy")', () => {
    const config = getRuntimePublicConfig();
    expect(config.apiBaseUrl).toBeNull();
    expect(config.legalPrivacyUrl).toBeNull();
    expect(config.legalTermsUrl).toBeNull();
    // The other public values survive untouched — the mutation was surgical.
    expect(config.appVersion).toMatch(/^\d+(\.\d+)*$/);
    expect(config.revenueCatPublicSdkKey).toMatch(/^appl_/);
    expect(JSON.stringify(config)).not.toMatch(/null\/(privacy|terms)/);
  });

  it('SettingsScreen renders without legal rows and never opens a null-derived URL', () => {
    const renderer = renderScreen();
    expect(rowsStartingWith(renderer, 'Privacy policy')).toHaveLength(0);
    expect(rowsStartingWith(renderer, 'Terms of use')).toHaveLength(0);
    // No visible text leaks the missing origin.
    const copy = allText(renderer);
    expect(copy).not.toMatch(/\bnull\b/);
    expect(copy).not.toContain('undefined');
    // The About card keeps its remaining rows so the section is not empty.
    expect(copy).toContain('App version');
    expect(rowsStartingWith(renderer, 'Rate Pickle Sensei')).toHaveLength(1);
  });

  it('pressing every pressable on the screen (rapidly, twice) never hands Linking a null-derived URL', async () => {
    const renderer = renderScreen();
    const targets = pressables(renderer).filter(node => {
      const label = String(node.props.accessibilityLabel ?? '');
      // Sign-out opens a confirmation sheet; everything else is fair game.
      return !/sign out/i.test(label);
    });
    expect(targets.length).toBeGreaterThan(3);
    for (let round = 0; round < 2; round += 1) {
      for (const node of targets) {
        await act(async () => {
          node.props.onPress();
          await Promise.resolve();
        });
      }
    }
    // The Rate row did reach Linking (write-review deep link) — the sweep
    // pressed real handlers, and none of them carried a null-derived URL.
    expect(openUrlSpy).toHaveBeenCalled();
    for (const call of openUrlSpy.mock.calls) {
      const url = String(call[0]);
      expect(url).not.toMatch(/^null|\/null\b|undefined/);
      expect(url).toMatch(/^https:\/\//);
    }
  });
});
