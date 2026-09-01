import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { DrillDetail, SavedDrill } from '../src/training/types';
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

jest.mock('../src/data/repository', () => ({
  listShots: jest.fn(async () => []),
  listPendingCaptures: jest.fn(async () => []),
}));

jest.mock('../src/auth/authStore', () => ({
  useAuthStore: (
    selector: (state: { session: { localOnly: boolean } }) => unknown,
  ) => selector({ session: { localOnly: false } }),
}));

import { LibraryScreen } from '../src/screens/LibraryScreen';

/**
 * Saved-drills visibility: a user's saved entry renders whenever its server
 * catalog detail loaded — coach-reviewed prescription mappings are a label
 * on the card (SavedDrillCard), never a visibility gate. The old gate hid
 * EVERY saved drill because the catalog serves `mappings: []` for all
 * drills; these tests pin the fixed behavior plus the honest held state for
 * entries whose catalog detail could not be fetched.
 */

const savedDrill: SavedDrill = {
  id: 'a2e6f9d0-1111-4222-8333-444455556666',
  slug: 'dink-target-ladder',
  title: 'Dink Target Ladder',
  description:
    'Land four consecutive cross-court dinks per kitchen zone, then move up.',
  coachName: 'Pickle Sensei Training Library',
  equipment: ['paddle', 'balls'],
  difficultyMin: null,
  difficultyMax: null,
  savedAt: '2026-08-30T10:00:00.000Z',
};

const savedDetail: DrillDetail = {
  id: savedDrill.id,
  slug: savedDrill.slug,
  title: savedDrill.title,
  description: savedDrill.description,
  coachName: savedDrill.coachName,
  equipment: ['paddle'],
  difficultyMin: null,
  difficultyMax: null,
  saved: true,
  mappings: [],
  instructionalMedia: [],
};

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

function openSavedTab(renderer: TestRenderer.ReactTestRenderer): void {
  const tabs = renderer.root.findAll(
    node =>
      node.props.accessibilityRole === 'tab' &&
      typeof node.props.onPress === 'function',
  );
  const saved = tabs.find(
    node =>
      node.findAll(child => child.props.children === 'Saved drills').length > 0,
  );
  expect(saved).toBeDefined();
  act(() => saved!.props.onPress());
}

async function renderLibrary(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<LibraryScreen />);
  });
  return renderer;
}

describe('Library saved drills visibility', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    useTrainingStore.setState({
      savedStatus: 'ready',
      planStatus: 'ready',
      mutation: 'idle',
      savedDrills: [savedDrill],
      drillDetails: { [savedDrill.slug]: savedDetail },
      currentPlan: null,
      savedError: null,
      planError: null,
      mutationError: null,
      loadSavedDrills: async () => true,
      loadCurrentPlan: async () => true,
    });
  });

  it('renders a saved entry whose catalog detail loaded, even with zero coach mappings', async () => {
    const renderer = await renderLibrary();
    openSavedTab(renderer);
    const text = renderedText(renderer);

    expect(text).toContain('Dink Target Ladder');
    // The card labels its provenance honestly (no prescription claimed).
    expect(text).toContain('Server catalog');
    expect(text).not.toContain('Reviewed prescription');
    // The old always-hidden state never shows for a loaded entry.
    expect(text).not.toContain('couldn’t be verified right now');

    act(() => renderer.unmount());
  });

  it('holds entries whose catalog detail could not be loaded, with honest copy and a retry', async () => {
    useTrainingStore.setState({ drillDetails: {} });
    const renderer = await renderLibrary();
    openSavedTab(renderer);
    const text = renderedText(renderer);

    expect(text).toContain('Saved entries couldn’t be verified right now.');
    expect(text).toContain('server catalog entry could not be loaded');
    expect(text).not.toContain('Dink Target Ladder');
    expect(
      renderer.root.findAll(
        node => node.props.accessibilityLabel === 'Try again',
      ).length,
    ).toBeGreaterThan(0);

    act(() => renderer.unmount());
  });

  it('mixes loaded and unloadable entries: loaded render, the rest are counted honestly', async () => {
    useTrainingStore.setState({
      savedDrills: [
        savedDrill,
        { ...savedDrill, id: 'other-id', slug: 'gone-drill', title: 'Gone' },
      ],
    });
    const renderer = await renderLibrary();
    openSavedTab(renderer);
    const text = renderedText(renderer);

    expect(text).toContain('Dink Target Ladder');
    expect(text).not.toContain('Gone ');
    expect(text).toContain('1 additional saved');
    expect(text).toContain('entry is hidden');

    act(() => renderer.unmount());
  });
});
