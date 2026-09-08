/**
 * Adjudication reproduction for area xc-ux-a11y-i18n (Library reads tab).
 *
 *  D1 — a repository failure while loading reads/pending clips was swallowed
 *       (`.catch(() => { setShots([]); setCaptures([]); })`) and rendered as
 *       the first-run empty state, with no error copy and no retry.
 *       FIXED (XC-UAI-05): the reads tab now renders an error state with a
 *       retry; both the regression reproduction and the expected-state test
 *       assert this contract.
 *  D2 — FIXED: every pending clip counted by the header renders a row.
 *
 * Run: cd apps/mobile && npx jest --ci __tests__/adjudicateXcUxA11yI18nLibrary.test.tsx
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { PendingCapture } from '../src/data/repository';
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
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = require('react') as typeof import('react');
    ReactModule.useEffect(() => callback(), [callback]);
  },
}));

jest.mock('../src/data/db', () => ({
  getDb: jest.fn(() => ({})),
}));

const mockListShots = jest.fn(async (): Promise<unknown[]> => []);
const mockListPendingCaptures = jest.fn(
  async (): Promise<PendingCapture[]> => [],
);
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
  pendingEvidenceCopy,
} from '../src/screens/LibraryScreen';

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

async function renderLibrary(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<LibraryScreen />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return renderer;
}

function pendingCapture(index: number): PendingCapture {
  return {
    id: `capture-${index}`,
    shotType: 'forehand_dink',
    declaredStroke: null,
    uri: `file:///clips/${index}.mov`,
    capturedAtIso: `2026-09-0${(index % 9) + 1}T10:00:00.000Z`,
    durationMs: 4000 + index,
    fps: 30,
    width: 1080,
    height: 1920,
    clip: null,
    evidenceStatus: 'legacy',
  };
}

beforeEach(() => {
  mockNavigate.mockClear();
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

describe('D1 — Library repository failure stays distinct from the first-run empty state', () => {
  const EMPTY_TITLE = 'Your measured reads, in one place.';

  test('regression: listShots rejecting keeps the error and retry state', async () => {
    mockListShots.mockImplementation(async () => {
      throw new Error('SQLITE_IOERR: disk I/O error');
    });
    const renderer = await renderLibrary();
    const text = renderedText(renderer);
    expect(text).not.toContain(EMPTY_TITLE);
    expect(text).not.toContain('Analyze your first stroke');
    expect(text).toMatch(/couldn.t|try again|retry|unavailable/i);
    act(() => renderer.unmount());
  });

  test('expected: a repository failure shows error copy with a retry, never the first-run empty state', async () => {
    mockListShots.mockImplementation(async () => {
      throw new Error('SQLITE_IOERR: disk I/O error');
    });
    const renderer = await renderLibrary();
    const text = renderedText(renderer);
    expect(text).not.toContain(EMPTY_TITLE);
    expect(text).toMatch(/try again|retry/i);
    act(() => renderer.unmount());
  });
});

/** Every rendered pending row carries the same evidence caption. */
function countRows(text: string): number {
  const caption = pendingEvidenceCopy(pendingCapture(0));
  return text.split(caption).length - 1;
}

describe('D2 — Library renders every counted pending clip', () => {
  test('regression: 5 pending clips → header says 5 and all 5 rows render', async () => {
    mockListPendingCaptures.mockImplementation(async () =>
      [0, 1, 2, 3, 4].map(pendingCapture),
    );
    const renderer = await renderLibrary();
    const text = renderedText(renderer);
    expect(text).toContain('5 pending clips');
    expect(countRows(text)).toBe(5);
    expect(text).not.toMatch(/show more|see all|more clips|and \d+ more/i);
    act(() => renderer.unmount());
  });

  test('expected: every counted pending clip is reachable (rendered or behind a "more" affordance)', async () => {
    mockListPendingCaptures.mockImplementation(async () =>
      [0, 1, 2, 3, 4].map(pendingCapture),
    );
    const renderer = await renderLibrary();
    const text = renderedText(renderer);
    expect(
      countRows(text) === 5 ||
        /show more|see all|more clips|and \d+ more/i.test(text),
    ).toBe(true);
    act(() => renderer.unmount());
  });
});
