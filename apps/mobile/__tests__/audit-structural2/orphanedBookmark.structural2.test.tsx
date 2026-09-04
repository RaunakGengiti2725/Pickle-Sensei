/**
 * Structural audit #2 — orphaned bookmark, end to end on mobile.
 *
 * Server truth (pinned in supabase/functions/api/__wf__/
 * audit_structural2_training_routes.test.ts): GET /v1/me/saved-drills answers
 * a placeholder for a slug that left the catalog ("This drill is no longer in
 * the published catalog…", fresh random id per response) and
 * GET /v1/catalog/drills/:slug answers a coded 404 `drill.not_found`.
 *
 * This suite drives the REAL training store + LibraryScreen against a fake
 * API that answers exactly that, and asks what the user can do about it.
 * REPRO cases are expected to FAIL on 4d812e1a.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';
import type {
  DrillDetail,
  SavedDrill,
  TrainingApi,
} from '../../src/training/types';
import { TrainingError } from '../../src/training/types';

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

jest.mock('../../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));
jest.mock('../../src/data/repository', () => ({
  listShots: jest.fn(async () => []),
  listPendingCaptures: jest.fn(async () => []),
}));
jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: (
    selector: (state: { session: { localOnly: boolean } }) => unknown,
  ) => selector({ session: { localOnly: false } }),
}));

import { LibraryScreen } from '../../src/screens/LibraryScreen';

const liveDrill: SavedDrill = {
  id: 'a2e6f9d0-1111-4222-8333-444455556666',
  slug: 'dink-target-ladder',
  title: 'Dink Target Ladder',
  description: 'Land four consecutive cross-court dinks per kitchen zone.',
  coachName: 'Pickle Sensei Training Library',
  equipment: ['paddle', 'balls'],
  difficultyMin: null,
  difficultyMax: null,
  savedAt: '2026-08-30T10:00:00.000Z',
};

const liveDetail: DrillDetail = {
  ...liveDrill,
  saved: true,
  mappings: [],
  instructionalMedia: [],
};

/** Exactly what index.ts savedDrillEntry() answers for a retired slug. */
function serverPlaceholder(id: string): SavedDrill {
  return {
    id,
    slug: 'retired-drill',
    title: 'retired-drill',
    description:
      'This drill is no longer in the published catalog. Its full instructions are unavailable.',
    coachName: 'Pickle Sensei Training Library',
    equipment: [],
    difficultyMin: null,
    difficultyMax: null,
    savedAt: '2026-08-29T10:00:00.000Z',
  };
}

const notFound = () =>
  new TrainingError(
    'drill.not_found',
    'This drill is not in the catalog.',
    false,
    404,
  );

let listCalls = 0;
function fakeApi(): TrainingApi & { unsaveDrill: jest.Mock } {
  return {
    listCatalogDrills: jest.fn(async () => []),
    getDrill: jest.fn(async (slug: string) => {
      if (slug === liveDrill.slug) return liveDetail;
      throw notFound();
    }),
    // Fresh random id per response, like the real edge fn.
    listSavedDrills: jest.fn(async () => [
      liveDrill,
      serverPlaceholder(
        `0000000${++listCalls}-0000-4000-8000-000000000000`.slice(-36),
      ),
    ]),
    saveDrill: jest.fn(async () => {}),
    unsaveDrill: jest.fn(async () => {}),
    getCurrentPlan: jest.fn(async () => null),
    createPlan: jest.fn(),
    completeDrill: jest.fn(),
    reassessPlan: jest.fn(),
  } as unknown as TrainingApi & { unsaveDrill: jest.Mock };
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object' && 'children' in node)
      walk((node as { children: unknown }).children);
  };
  walk(renderer.toJSON());
  return out.join(' ').replace(/\s+/g, ' ');
}

function pressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAll(
      n =>
        typeof n.props.onPress === 'function' &&
        typeof n.props.accessibilityLabel === 'string',
    )
    .map(n => n.props.accessibilityLabel as string);
}

function openSavedTab(renderer: TestRenderer.ReactTestRenderer): void {
  const tabs = renderer.root.findAll(
    n =>
      n.props.accessibilityRole === 'tab' &&
      typeof n.props.onPress === 'function',
  );
  const saved = tabs.find(
    n => n.findAll(c => c.props.children === 'Saved drills').length > 0,
  );
  if (!saved) throw new Error('Saved drills tab not found');
  act(() => saved.props.onPress());
}

async function renderLibrary(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<LibraryScreen />);
  });
  await act(async () => {});
  return renderer;
}

describe('orphaned bookmark on mobile — structural audit #2', () => {
  let api: ReturnType<typeof fakeApi>;
  let renderer: TestRenderer.ReactTestRenderer | null = null;

  beforeEach(() => {
    listCalls = 0;
    api = fakeApi();
    configureTrainingStore(api);
    mockNavigate.mockClear();
  });

  afterEach(() => {
    if (renderer) act(() => renderer!.unmount());
    renderer = null;
    clearTrainingStoreConfiguration();
  });

  it('VERIFY: the store keeps the orphaned entry (never drops a bookmark) and swallows its detail 404 without an error state', async () => {
    const ok = await useTrainingStore.getState().loadSavedDrills();
    const state = useTrainingStore.getState();
    expect(ok).toBe(true);
    expect(state.savedStatus).toBe('ready');
    expect(state.savedError).toBeNull();
    expect(state.savedDrills.map(d => d.slug)).toEqual([
      liveDrill.slug,
      'retired-drill',
    ]);
    expect(Object.keys(state.drillDetails)).toEqual([liveDrill.slug]);
  });

  it('REPRO: an orphaned bookmark is either shown with the server\'s honest placeholder copy or removable — not a permanent "could not be loaded" count whose Try again can never succeed (store.ts:81-96 discards the 404; LibraryScreen.tsx:165-168, 394-405)', async () => {
    renderer = await renderLibrary();
    openSavedTab(renderer);
    const before = renderedText(renderer);
    expect(before).toContain('Dink Target Ladder');

    // The retry the UI offers re-runs the same 404 — nothing can change.
    const retry = renderer.root.findAll(
      n => n.props.accessibilityLabel === 'Try again',
    )[0];
    if (retry) {
      await act(async () => {
        retry.props.onPress();
      });
    }
    const after = renderedText(renderer);
    const labels = pressables(renderer);

    expect({
      placeholderCopyShown: after.includes(
        'no longer in the published catalog',
      ),
      removable: labels.some(
        l => /remove|unsave/i.test(l) && /retired-drill/i.test(l),
      ),
      stuckAsUnloadable:
        after.includes('additional saved entry is hidden') &&
        after.includes('could not be loaded'),
    }).toEqual({
      placeholderCopyShown: true,
      removable: true,
      stuckAsUnloadable: false,
    });
  });

  it('VERIFY: the visible (live) bookmark is still removable and its unsave reaches the server exactly once', async () => {
    renderer = await renderLibrary();
    openSavedTab(renderer);
    const remove = renderer.root.findAll(
      n =>
        typeof n.props.onPress === 'function' &&
        typeof n.props.accessibilityLabel === 'string' &&
        /remove|unsave/i.test(n.props.accessibilityLabel) &&
        /Dink Target Ladder/.test(n.props.accessibilityLabel),
    )[0];
    expect(remove).toBeDefined();
    await act(async () => {
      remove!.props.onPress();
    });
    await act(async () => {});
    expect(api.unsaveDrill).toHaveBeenCalledTimes(1);
    expect(api.unsaveDrill).toHaveBeenCalledWith(liveDrill.slug);
  });
});
