/**
 * AUDIT — BrandNoticeHost / showBrandNotice (design/BrandNotice.tsx): the
 * imperative one-way notice channel has no direct tests. Pins: a notice
 * fired before the host mounts is shown on mount; the dialog is dismissible
 * from its action, its close button and the hardware back; and the single
 * pending slot COALESCES to the most recent notice (documented behaviour —
 * every caller fires one user-triggered notice at a time).
 */
import React from 'react';
import { Modal, Text } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

jest.mock('react-native-svg', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});

import { BrandNoticeHost, showBrandNotice } from '../../src/design/BrandNotice';

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function texts(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => React.Children.toArray(node.props.children))
    .filter((child): child is string => typeof child === 'string');
}

function pressables(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.onStartShouldSetResponder !== undefined,
  );
}

function click(host: ReactTestInstance) {
  act(() => {
    host.props.onClick({
      currentTarget: host,
      target: host,
      nativeEvent: {},
      stopPropagation: () => {},
    });
  });
}

describe('BrandNoticeHost', () => {
  it('VERIFIED: a notice fired before the host mounts is presented on mount and dismissed by its action', () => {
    showBrandNotice({
      title: 'Terms could not be opened',
      detail: 'Read it in a browser.',
      tone: 'danger',
      eyebrow: 'Link unavailable',
    });
    const renderer = render(<BrandNoticeHost />);
    const modal = renderer.root.findByType(Modal);
    expect(modal.props.visible).toBe(true);
    expect(texts(renderer)).toEqual(
      expect.arrayContaining([
        'LINK UNAVAILABLE',
        'Terms could not be opened',
        'Read it in a browser.',
        'Got it',
      ]),
    );
    const action = pressables(renderer).find(
      node => node.props.accessibilityLabel === 'Got it',
    );
    expect(action).toBeDefined();
    click(action!);
    expect(renderer.root.findByType(Modal).props.visible).toBe(false);
    act(() => renderer.unmount());
  });

  it('VERIFIED: a mounted host presents notices immediately; the custom action label is used', () => {
    const renderer = render(<BrandNoticeHost />);
    expect(renderer.root.findByType(Modal).props.visible).toBe(false);
    act(() => {
      showBrandNotice({
        title: 'Rating unavailable right now',
        detail: 'Try the App Store page.',
        actionLabel: 'OK',
      });
    });
    expect(renderer.root.findByType(Modal).props.visible).toBe(true);
    expect(texts(renderer)).toEqual(expect.arrayContaining(['OK']));
    // Hardware back / close button both route to the same dismiss.
    act(() => {
      renderer.root.findByType(Modal).props.onRequestClose();
    });
    expect(renderer.root.findByType(Modal).props.visible).toBe(false);
    act(() => renderer.unmount());
  });

  it('VERIFIED (documented coalescing): two notices before mount → only the latest is shown; a notice while one is open replaces it', () => {
    showBrandNotice({ title: 'First', detail: 'one' });
    showBrandNotice({ title: 'Second', detail: 'two' });
    const renderer = render(<BrandNoticeHost />);
    const shown = texts(renderer);
    expect(shown).toContain('Second');
    expect(shown).not.toContain('First');
    act(() => {
      showBrandNotice({ title: 'Third', detail: 'three' });
    });
    const replaced = texts(renderer);
    expect(replaced).toContain('Third');
    expect(replaced).not.toContain('Second');
    act(() => renderer.unmount());
  });

  it('VERIFIED: after the host unmounts, a notice parks again instead of calling a dead setState', () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const first = render(<BrandNoticeHost />);
    act(() => first.unmount());
    showBrandNotice({ title: 'Parked', detail: 'until a host mounts' });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
    const second = render(<BrandNoticeHost />);
    expect(texts(second)).toContain('Parked');
    act(() => second.unmount());
  });
});
