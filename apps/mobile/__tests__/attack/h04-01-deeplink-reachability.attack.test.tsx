/**
 * H04-01 adversarial test — GHSA-vcc3-ghjq-m6fr reachability.
 *
 * docs/security/ADVISORIES_2026-09-08.md §4.3 accepts the decode-uri-component
 * advisory on the claim that the vulnerable decoder is bundled but has NO input
 * path: the app's only <NavigationContainer> passes no `linking` prop, so a
 * hostile deep-link URL (initial URL or `url` event) never reaches
 * `queryString.parse()` → `decodeComponent()`.
 *
 * This suite attacks that claim with the REAL @react-navigation/native
 * container wired exactly like RootNavigator (ref + theme, no linking):
 *  1. hostile initial URL at mount           → decoder must never run
 *  2. hostile `url` event after mount        → decoder must never run
 *  3. positive control: the same container WITH `linking` → decoder DOES run
 *     (proves the spies see the real path and the test is sensitive)
 *  4. static guard: RootNavigator.tsx's container has no `linking` prop and
 *     the iOS project has no associated-domains / JS-handled URL scheme.
 */
import * as React from 'react';
import { Linking } from 'react-native';
import { act, create } from 'react-test-renderer';
import * as fs from 'fs';
import * as path from 'path';

const mockDecodeSpy = jest.fn();
jest.mock('decode-uri-component', () => {
  const actual = jest.requireActual('decode-uri-component');
  return (value: string) => {
    mockDecodeSpy(value);
    return actual(value);
  };
});

const mockParseSpy = jest.fn();
jest.mock('query-string', () => {
  const actual = jest.requireActual('query-string');
  return {
    ...actual,
    parse: (query: string, options?: unknown) => {
      mockParseSpy(query);
      return actual.parse(query, options);
    },
  };
});

jest.mock('react-native-safe-area-context', () => {
  const mock = jest.requireActual<{ default: Record<string, unknown> }>(
    'react-native-safe-area-context/jest/mock',
  );
  return mock.default;
});

import {
  NavigationContainer,
  createNavigationContainerRef,
  DefaultTheme,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Text, View } from 'react-native';

type Params = { Tabs: undefined; Paywall: { source?: string } | undefined };
const Stack = createNativeStackNavigator<Params>();
const Home = () => (
  <View>
    <Text>home</Text>
  </View>
);

const HOSTILE_QUERY = 'x=' + '%25'.repeat(12) + '%2525&y=%2525%25';
const HOSTILE_URL = `picklesensei://Tabs?${HOSTILE_QUERY}`;

const linkingMock = Linking as unknown as {
  getInitialURL: jest.Mock;
  addEventListener: jest.Mock;
};

function mountLikeRootNavigator(linking?: {
  prefixes: string[];
  enabled?: boolean;
}) {
  const ref = createNavigationContainerRef<Params>();
  const theme = { ...DefaultTheme };
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <NavigationContainer ref={ref} theme={theme} linking={linking}>
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Tabs" component={Home} />
          <Stack.Screen name="Paywall" component={Home} />
        </Stack.Navigator>
      </NavigationContainer>,
    );
  });
  return { ref, renderer: renderer! };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('H04-01 §4.3 — decode-uri-component has no input path while linking is disabled', () => {
  let urlListeners: Array<(event: { url: string }) => void>;

  beforeEach(() => {
    mockDecodeSpy.mockClear();
    mockParseSpy.mockClear();
    urlListeners = [];
    linkingMock.getInitialURL.mockImplementation(() =>
      Promise.resolve(HOSTILE_URL),
    );
    linkingMock.addEventListener.mockImplementation(
      (type: string, cb: (event: { url: string }) => void) => {
        if (type === 'url') urlListeners.push(cb);
        return { remove: jest.fn() };
      },
    );
  });

  it('hostile initial URL never reaches queryString.parse / decodeComponent (no linking prop)', async () => {
    const { ref, renderer } = mountLikeRootNavigator();
    await flush();
    expect(ref.isReady()).toBe(true);
    expect(ref.getRootState()?.routes.map(r => r.name)).toEqual(['Tabs']);
    expect(linkingMock.getInitialURL).not.toHaveBeenCalled();
    expect(mockParseSpy).not.toHaveBeenCalled();
    expect(mockDecodeSpy).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('hostile `url` event after mount never reaches queryString.parse / decodeComponent (no linking prop)', async () => {
    const { ref, renderer } = mountLikeRootNavigator();
    await flush();
    // useLinking subscribes to `url` even when linking is disabled (the guard
    // is inside the listener), so the hostile URL really is delivered to it.
    expect(urlListeners.length).toBeGreaterThan(0);
    act(() => {
      for (const cb of urlListeners) cb({ url: HOSTILE_URL });
    });
    await flush();
    expect(ref.getRootState()?.routes.map(r => r.name)).toEqual(['Tabs']);
    expect(mockParseSpy).not.toHaveBeenCalled();
    expect(mockDecodeSpy).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('positive control: the SAME container with a `linking` prop feeds the hostile query to the decoder', async () => {
    const { renderer } = mountLikeRootNavigator({
      prefixes: ['picklesensei://'],
    });
    await flush();
    expect(linkingMock.getInitialURL).toHaveBeenCalled();
    expect(mockParseSpy).toHaveBeenCalledWith(HOSTILE_QUERY);
    expect(mockDecodeSpy).toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('positive control: `url` event with linking enabled reaches the decoder', async () => {
    const { renderer } = mountLikeRootNavigator({
      prefixes: ['picklesensei://'],
    });
    await flush();
    mockParseSpy.mockClear();
    mockDecodeSpy.mockClear();
    expect(urlListeners.length).toBeGreaterThan(0);
    act(() => {
      for (const cb of urlListeners) cb({ url: HOSTILE_URL });
    });
    await flush();
    expect(mockParseSpy).toHaveBeenCalledWith(HOSTILE_QUERY);
    expect(mockDecodeSpy).toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});

describe('H04-01 §4.3 — static guards behind the accepted risk', () => {
  const mobileRoot = path.resolve(__dirname, '..', '..');
  const read = (rel: string) =>
    fs.readFileSync(path.join(mobileRoot, rel), 'utf8');

  it('RootNavigator renders exactly one NavigationContainer and it has no `linking` prop', () => {
    const src = read('src/navigation/RootNavigator.tsx');
    const opens = src.match(/<NavigationContainer\b[^>]*>/g) ?? [];
    expect(opens).toHaveLength(1);
    expect(opens[0]).not.toMatch(/\blinking\b/);
    expect(src).not.toMatch(
      /\bgetStateFromPath\b|\buseLinkTo\b|\buseLinkProps\b/,
    );
  });

  it('no app source subscribes to inbound URLs or resolves an initial URL', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full, out);
        } else if (
          /\.(ts|tsx)$/.test(entry.name) &&
          !/\.test\./.test(entry.name)
        ) {
          out.push(full);
        }
      }
      return out;
    };
    const offenders = walk(path.join(mobileRoot, 'src')).filter(file => {
      const text = fs.readFileSync(file, 'utf8');
      return /Linking\.(addEventListener|getInitialURL)\(/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('iOS project has no associated domains and its only URL scheme is the Google Sign-In return scheme', () => {
    const entitlements = read('ios/PickleSensei/PickleSensei.entitlements');
    expect(entitlements).not.toMatch(/associated-domains/);
    const plist = read('ios/PickleSensei/Info.plist');
    const schemes = [
      ...plist.matchAll(
        /<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/g,
      ),
    ].flatMap(m =>
      [...(m[1] ?? '').matchAll(/<string>([^<]+)<\/string>/g)].map(
        s => s[1] ?? '',
      ),
    );
    expect(schemes).toHaveLength(1);
    expect(schemes[0]).toMatch(/^com\.googleusercontent\.apps\./);
    const appDelegate = read('ios/PickleSensei/AppDelegate.swift');
    expect(appDelegate).not.toMatch(
      /RCTLinkingManager|openURL|continue userActivity/,
    );
  });
});
