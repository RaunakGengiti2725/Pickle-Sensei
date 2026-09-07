/**
 * XC-UAI-05 orderings the happy-path tests do not drive: a stale in-flight
 * read that settles AFTER a newer focus load, a read that settles after
 * blur/unmount, a retry that fails again, a partial failure (only pending
 * clips reject), the Saved tab while reads are broken, and the tablist
 * inside the error state. Only the newest read may touch state.
 *
 * Run: cd apps/mobile && npx jest --ci __tests__/libraryReadsLoadRace.test.tsx
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalShotRow, PendingCapture } from '../src/data/repository';
import { useTrainingStore } from '../src/training/store';

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

const mockNavigate = jest.fn();
type FocusCallback = () => void | (() => void);
const mockFocus: {
  callback: FocusCallback | null;
  cleanup: void | (() => void);
} = { callback: null, cleanup: undefined };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
  // Mirrors @react-navigation's contract: the callback runs on focus, its
  // return value runs on blur. `refocus()` below replays blur → focus.
  useFocusEffect: (callback: FocusCallback) => {
    const ReactModule = require('react') as typeof import('react');
    ReactModule.useEffect(() => {
      mockFocus.callback = callback;
      mockFocus.cleanup = callback();
      return () => {
        if (typeof mockFocus.cleanup === 'function') mockFocus.cleanup();
        mockFocus.cleanup = undefined;
      };
    }, [callback]);
  },
}));

jest.mock('../src/data/db', () => ({
  getDb: jest.fn(() => ({})),
}));

const mockListShots = jest.fn<Promise<LocalShotRow[]>, []>();
const mockListPendingCaptures = jest.fn<Promise<PendingCapture[]>, []>();
jest.mock('../src/data/repository', () => ({
  listShots: () => mockListShots(),
  listPendingCaptures: () => mockListPendingCaptures(),
}));

jest.mock('../src/auth/authStore', () => ({
  useAuthStore: (
    selector: (state: { session: { localOnly: boolean } }) => unknown,
  ) => selector({ session: { localOnly: false } }),
}));

import {
  LibraryScreen,
  READS_LOAD_ERROR_TITLE,
} from '../src/screens/LibraryScreen';

const EMPTY_TITLE = 'Your measured reads, in one place.';
const SPINNER = 'Opening your library…';

const readRow: LocalShotRow = {
  id: 'shot-0001',
  sessionId: null,
  shotType: 'forehand_drive',
  capturedAt: '2026-09-01T10:00:00.000Z',
  overallScore: 7.2,
  confidence: 0.9,
  resultKind: 'scored',
  source: 'guided_camera',
  favorite: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return out.join(' ').replace(/\s+/g, ' ');
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const mounted: TestRenderer.ReactTestRenderer[] = [];

async function renderLibrary(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<LibraryScreen />);
  });
  mounted.push(renderer);
  await flush();
  return renderer;
}

afterEach(() => {
  // A failing assertion must never leak a mounted screen (and its shared
  // mocks) into the next test.
  while (mounted.length) {
    const renderer = mounted.pop()!;
    act(() => renderer.unmount());
  }
});

/** Blur then focus again, exactly what leaving and returning to the tab does. */
async function refocus(): Promise<void> {
  await act(async () => {
    if (typeof mockFocus.cleanup === 'function') mockFocus.cleanup();
    mockFocus.cleanup = mockFocus.callback?.();
  });
  await flush();
}

function pressByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): TestRenderer.ReactTestInstance {
  const matches = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityRole !== undefined,
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function pressTab(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): void {
  const tab = renderer.root
    .findAll(node => node.props.accessibilityRole === 'tab')
    .find(node => renderedTextOf(node).includes(label));
  expect(tab).toBeDefined();
  act(() => tab!.props.onPress());
}

function renderedTextOf(node: TestRenderer.ReactTestInstance): string {
  return node
    .findAll(child => typeof child.props.children === 'string')
    .map(child => child.props.children as string)
    .join(' ');
}

beforeEach(() => {
  mockNavigate.mockClear();
  mockFocus.callback = null;
  mockFocus.cleanup = undefined;
  mockListShots.mockReset().mockImplementation(async () => []);
  mockListPendingCaptures.mockReset().mockImplementation(async () => []);
  useTrainingStore.setState({
    savedStatus: 'ready',
    planStatus: 'ready',
    mutation: 'idle',
    savedDrills: [],
    drillDetails: {},
    currentPlan: null,
    savedError: null,
    planError: null,
    mutationError: null,
    loadSavedDrills: async () => true,
    loadCurrentPlan: async () => true,
  });
});

describe('XC-UAI-05 · stale in-flight reads settle after a newer focus load', () => {
  test('a stale rejection must not replace reads that a newer focus load rendered successfully', async () => {
    const stale = deferred<LocalShotRow[]>();
    mockListShots
      .mockImplementationOnce(() => stale.promise)
      .mockImplementation(async () => [readRow]);

    const renderer = await renderLibrary();
    expect(renderedText(renderer)).toContain(SPINNER);

    // User leaves the tab and comes back while the first read is still
    // running; the second read completes first and renders the reads.
    await refocus();
    expect(mockListShots).toHaveBeenCalledTimes(2);
    let text = renderedText(renderer);
    expect(text).toContain('1 analyzed read');
    expect(text).not.toContain(READS_LOAD_ERROR_TITLE);

    // Now the superseded first read fails.
    await act(async () => {
      stale.reject(new Error('SQLITE_IOERR: disk I/O error'));
      await Promise.resolve();
    });
    await flush();

    text = renderedText(renderer);
    expect(text).toContain('1 analyzed read');
    expect(text).not.toContain(READS_LOAD_ERROR_TITLE);
  });

  test('a stale success must not clear an error that a newer focus load reported', async () => {
    const stale = deferred<LocalShotRow[]>();
    mockListShots
      .mockImplementationOnce(() => stale.promise)
      .mockImplementation(async () => {
        throw new Error('SQLITE_IOERR: disk I/O error');
      });

    const renderer = await renderLibrary();
    await refocus();
    expect(mockListShots).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer)).toContain(READS_LOAD_ERROR_TITLE);

    await act(async () => {
      stale.resolve([]);
      await Promise.resolve();
    });
    await flush();

    const text = renderedText(renderer);
    expect(text).toContain(READS_LOAD_ERROR_TITLE);
    expect(text).not.toContain(EMPTY_TITLE);
  });

  test('a read that settles after blur/unmount must not touch state ', async () => {
    const pending = deferred<LocalShotRow[]>();
    mockListShots.mockImplementationOnce(() => pending.promise);
    const errors: unknown[] = [];
    const spy = jest
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => errors.push(args));

    const renderer = await renderLibrary();
    expect(renderedText(renderer)).toContain(SPINNER);
    act(() => mounted.pop()!.unmount());
    await act(async () => {
      pending.reject(new Error('SQLITE_IOERR'));
      await Promise.resolve();
    });
    await flush();
    spy.mockRestore();
    expect(errors).toEqual([]);
  });
});

describe('XC-UAI-05 · retry and partial-failure orderings', () => {
  test('retry that fails again lands back on the error state, never spinner or empty state', async () => {
    mockListShots.mockImplementation(async () => {
      throw new Error('SQLITE_IOERR: disk I/O error');
    });
    const renderer = await renderLibrary();
    expect(renderedText(renderer)).toContain(READS_LOAD_ERROR_TITLE);

    await act(async () => {
      pressByLabel(renderer, 'Try again').props.onPress();
    });
    await flush();

    expect(mockListShots).toHaveBeenCalledTimes(2);
    const text = renderedText(renderer);
    expect(text).toContain(READS_LOAD_ERROR_TITLE);
    expect(text).not.toContain(SPINNER);
    expect(text).not.toContain(EMPTY_TITLE);
  });

  test('retry shows the spinner while in flight, not the first-run empty state and not stale reads', async () => {
    const retryLoad = deferred<LocalShotRow[]>();
    mockListShots
      .mockImplementationOnce(async () => [readRow])
      .mockImplementationOnce(async () => {
        throw new Error('SQLITE_IOERR: disk I/O error');
      })
      .mockImplementationOnce(() => retryLoad.promise);

    const renderer = await renderLibrary();
    expect(renderedText(renderer)).toContain('1 analyzed read');

    await refocus();
    expect(renderedText(renderer)).toContain(READS_LOAD_ERROR_TITLE);

    await act(async () => {
      pressByLabel(renderer, 'Try again').props.onPress();
    });
    let text = renderedText(renderer);
    expect(text).toContain(SPINNER);
    expect(text).not.toContain(EMPTY_TITLE);
    expect(text).not.toContain(READS_LOAD_ERROR_TITLE);

    await act(async () => {
      retryLoad.resolve([readRow]);
      await Promise.resolve();
    });
    await flush();
    text = renderedText(renderer);
    expect(text).toContain('1 analyzed read');
  });

  test('only listPendingCaptures rejecting is still a read failure (no half-rendered library)', async () => {
    mockListShots.mockImplementation(async () => [readRow]);
    mockListPendingCaptures.mockImplementation(async () => {
      throw new Error('SQLITE_CORRUPT');
    });
    const renderer = await renderLibrary();
    const text = renderedText(renderer);
    expect(text).toContain(READS_LOAD_ERROR_TITLE);
    expect(text).not.toContain('1 analyzed read');
    expect(text).not.toContain(EMPTY_TITLE);
  });

  test('getDb throwing synchronously is handled like a rejected read', async () => {
    const dbModule = jest.requireMock('../src/data/db') as {
      getDb: jest.Mock;
    };
    dbModule.getDb.mockImplementationOnce(() => {
      throw new Error('database locked');
    });
    const renderer = await renderLibrary();
    const text = renderedText(renderer);
    expect(text).toContain(READS_LOAD_ERROR_TITLE);
    expect(text).not.toContain(SPINNER);
  });
});

describe('XC-UAI-05 · error state does not trap the user', () => {
  test('the Saved drills tab stays reachable from the reads error state and back', async () => {
    mockListShots.mockImplementation(async () => {
      throw new Error('SQLITE_IOERR: disk I/O error');
    });
    const renderer = await renderLibrary();
    expect(renderedText(renderer)).toContain(READS_LOAD_ERROR_TITLE);

    pressTab(renderer, 'Saved drills');
    let text = renderedText(renderer);
    expect(text).toContain('No saved drills yet.');
    expect(text).not.toContain(READS_LOAD_ERROR_TITLE);

    pressTab(renderer, 'Reads');
    text = renderedText(renderer);
    expect(text).toContain(READS_LOAD_ERROR_TITLE);
  });

  test('a reads failure while on the Saved tab never hijacks the Saved tab', async () => {
    mockListShots.mockImplementation(async () => [readRow]);
    const renderer = await renderLibrary();
    pressTab(renderer, 'Saved drills');
    expect(renderedText(renderer)).toContain('No saved drills yet.');

    mockListShots.mockImplementation(async () => {
      throw new Error('SQLITE_IOERR: disk I/O error');
    });
    await refocus();
    const text = renderedText(renderer);
    expect(text).toContain('No saved drills yet.');
    expect(text).not.toContain(READS_LOAD_ERROR_TITLE);
  });

  test('error state is announced as an alert and its retry is a button', async () => {
    mockListShots.mockImplementation(async () => {
      throw new Error('SQLITE_IOERR: disk I/O error');
    });
    const renderer = await renderLibrary();
    const alerts = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityRole === 'alert',
    );
    expect(alerts.length).toBe(1);
    const retry = pressByLabel(renderer, 'Try again');
    expect(retry.props.accessibilityRole).toBe('button');
  });
});
