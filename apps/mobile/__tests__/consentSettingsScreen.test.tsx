import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
}));

import { ConsentSettingsScreen } from '../src/screens/ConsentSettingsScreen';
import { BrandToggle } from '../src/design/components';
import { useConsentStore } from '../src/state/consentStore';

/**
 * Pins the non-manipulative consent surface: model training defaults OFF,
 * the two scopes are presented separately, signed-out users are told
 * nothing is shared, and failures are shown instead of a fake success.
 */

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<ConsentSettingsScreen />);
  });
  return renderer;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

describe('ConsentSettingsScreen', () => {
  beforeEach(() => {
    useConsentStore.setState({
      availability: 'signed_out',
      modelTrainingActive: false,
      lastActionAt: null,
      busy: false,
      error: null,
      hydrate: jest.fn(() => Promise.resolve()),
      setModelTrainingConsent: jest.fn(() => Promise.resolve()),
    });
  });

  it('renders the training toggle OFF by default and disabled when signed out', () => {
    const renderer = renderScreen();
    const toggle = renderer.root.findByType(BrandToggle);
    expect(toggle.props.value).toBe(false);
    expect(toggle.props.disabled).toBe(true);
    expect(allText(renderer)).toContain(
      'Sign in to change this. Nothing is shared while signed out.',
    );
    act(() => renderer.unmount());
  });

  it('separates analyze-my-video from model-training opt-in', () => {
    const renderer = renderScreen();
    const copy = allText(renderer);
    expect(copy).toContain('Analyze my video');
    expect(copy).toContain('Use my video to improve models');
    expect(copy).toContain('never used to train models under this');
    act(() => renderer.unmount());
  });

  it('forwards an explicit toggle to the store when ready', () => {
    const setConsent = jest.fn(() => Promise.resolve());
    useConsentStore.setState({
      availability: 'ready',
      setModelTrainingConsent: setConsent,
    });
    const renderer = renderScreen();
    const toggle = renderer.root.findByType(BrandToggle);
    expect(toggle.props.disabled).toBe(false);
    act(() => {
      toggle.props.onValueChange(true);
    });
    expect(setConsent).toHaveBeenCalledWith(true);
    act(() => renderer.unmount());
  });

  it('reflects an active grant from the server and allows withdrawal', () => {
    const setConsent = jest.fn(() => Promise.resolve());
    useConsentStore.setState({
      availability: 'ready',
      modelTrainingActive: true,
      setModelTrainingConsent: setConsent,
    });
    const renderer = renderScreen();
    const toggle = renderer.root.findByType(BrandToggle);
    expect(toggle.props.value).toBe(true);
    act(() => {
      toggle.props.onValueChange(false);
    });
    expect(setConsent).toHaveBeenCalledWith(false);
    act(() => renderer.unmount());
  });

  it('shows a visible error instead of pretending the change saved', () => {
    useConsentStore.setState({
      availability: 'ready',
      error: 'Your consent change could not be saved. Nothing was changed.',
    });
    const renderer = renderScreen();
    expect(allText(renderer)).toContain(
      'Your consent change could not be saved. Nothing was changed.',
    );
    act(() => renderer.unmount());
  });
});
