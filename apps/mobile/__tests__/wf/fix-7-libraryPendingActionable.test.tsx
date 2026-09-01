import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { PendingCapture } from '../../src/data/repository';
import { useTrainingStore } from '../../src/training/store';

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

jest.mock('../../src/data/db', () => ({
  getDb: jest.fn(() => ({})),
}));

const mockListShots = jest.fn(async () => []);
const mockListPendingCaptures = jest.fn(
  async (): Promise<PendingCapture[]> => [],
);
jest.mock('../../src/data/repository', () => ({
  listShots: () => mockListShots(),
  listPendingCaptures: () => mockListPendingCaptures(),
}));

jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: (
    selector: (state: { session: { localOnly: boolean } }) => unknown,
  ) => selector({ session: { localOnly: false } }),
}));

import {
  LibraryScreen,
  MUTATION_ERROR_DISMISS_HINT,
  PENDING_SECTION_LABEL,
  PENDING_SECTION_NOTE,
} from '../../src/screens/LibraryScreen';

const pendingCapture: PendingCapture = {
  id: 'cap-1',
  shotType: 'unrecognized',
  declaredStroke: 'forehand_drive',
  uri: 'file:///captures/cap-1.mov',
  capturedAtIso: '2026-08-27T18:00:00.000Z',
  durationMs: 4200,
  fps: 59.94,
  width: 720,
  height: 1280,
  clip: null,
  evidenceStatus: 'valid',
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

async function renderLibrary(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<LibraryScreen />);
  });
  return renderer;
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

describe('Library reads tab with pending clips and no scored reads', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockListShots.mockResolvedValue([]);
    mockListPendingCaptures.mockResolvedValue([pendingCapture]);
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

  it('keeps the Analyze CTA reachable and tells the truth about saved clips', async () => {
    const renderer = await renderLibrary();
    const text = renderedText(renderer);

    expect(text).toContain(PENDING_SECTION_LABEL);
    expect(text).not.toMatch(/ready to analyze/i);
    expect(text).toContain(PENDING_SECTION_NOTE);
    expect(text).toContain('Forehand Drive · auto capture');

    expect(
      renderer.root.findAll(node => node.props.name === 'lock').length,
    ).toBe(0);

    const cta = renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === 'Analyze your first stroke' &&
        typeof node.props.onPress === 'function',
    );
    expect(cta.length).toBeGreaterThan(0);
    act(() => cta[0]!.props.onPress());
    expect(mockNavigate).toHaveBeenCalledWith('Analyze');

    act(() => renderer.unmount());
  });

  it('exposes the saved-drills mutation error as a dismiss button for assistive tech', async () => {
    useTrainingStore.setState({
      mutationError: {
        code: 'network',
        message: 'Could not update saved drills.',
        retryable: true,
        status: null,
      },
      clearMutationError: () =>
        useTrainingStore.setState({ mutationError: null }),
    });
    const renderer = await renderLibrary();
    openSavedTab(renderer);

    const banner = renderer.root.findAll(
      node =>
        node.props.accessibilityRole === 'button' &&
        node.props.accessibilityHint === MUTATION_ERROR_DISMISS_HINT &&
        typeof node.props.onPress === 'function',
    );
    expect(banner.length).toBe(1);
    expect(banner[0]!.props.accessibilityLabel).toBe(
      'Could not update saved drills.',
    );
    expect(renderedText(renderer)).toContain('DISMISS');

    act(() => banner[0]!.props.onPress());
    expect(useTrainingStore.getState().mutationError).toBeNull();
    expect(
      renderer.root.findAll(
        node => node.props.accessibilityHint === MUTATION_ERROR_DISMISS_HINT,
      ).length,
    ).toBe(0);

    act(() => renderer.unmount());
  });
});
