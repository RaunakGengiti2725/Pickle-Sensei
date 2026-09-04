/**
 * ADVERSARIAL PASS 3 — scenario 4 (mobile-design-components-walkthrough).
 *
 * Attack: the imperative `showBrandNotice` channel with two notices fired
 * (a) before `BrandNoticeHost` mounts, (b) inside ONE React `act()` while the
 * host is mounted, (c) while a notice is already on screen, and (d) across a
 * host unmount / remount and a second host. Oracle: a one-way notice "may
 * outlive its source screen" (BrandNotice.tsx docstring) — so no notice may
 * be silently dropped; each must be presented, in order, exactly once.
 *
 * The module keeps a SINGLE pending slot and a single setState presenter, so
 * the expected sequences below document the contract the surface should
 * hold; failures are the finding.
 */
import React from 'react';
import { Modal, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import * as mod from '../../src/design/BrandNotice';

/**
 * The channel is module-global state (one pending slot, one presenter); a
 * fresh module per test would drag a second React copy along, so instead
 * every test ends by mounting a scratch host, draining whatever is parked, and
 * unmounting it — leaving `pendingNotice === null` and `presentNotice === null`.
 */
async function scrubModuleState() {
  let scratch!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    scratch = TestRenderer.create(<mod.BrandNoticeHost />);
  });
  await drain(scratch);
  act(() => scratch.unmount());
}

function visibleTitle(renderer: TestRenderer.ReactTestRenderer): string | null {
  const modal = renderer.root.findAllByType(Modal)[0];
  if (!modal || modal.props.visible !== true) return null;
  const texts = renderer.root
    .findAllByType(Text)
    .map(node => React.Children.toArray(node.props.children).join(''));
  // Title is the h1 immediately before the detail; both are plain strings.
  return texts.find(t => t.startsWith('notice-')) ?? null;
}

async function dismiss(renderer: TestRenderer.ReactTestRenderer) {
  const close = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === 'Close dialog' &&
      typeof n.props.onPress === 'function',
  )[0];
  expect(close).toBeDefined();
  await act(async () => {
    close!.props.onPress();
  });
}

/** Drain every notice the host presents, dismissing each, in order. */
async function drain(
  renderer: TestRenderer.ReactTestRenderer,
  max = 5,
): Promise<string[]> {
  const shown: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const title = visibleTitle(renderer);
    if (title === null) break;
    shown.push(title);
    await dismiss(renderer);
  }
  return shown;
}

const A = { title: 'notice-A', detail: 'Link could not be opened.' };
const B = {
  title: 'notice-B',
  detail: 'Some data could not be removed.',
  tone: 'danger' as const,
};

describe('showBrandNotice / BrandNoticeHost adversarial', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  afterEach(async () => {
    if (renderer) act(() => renderer!.unmount());
    renderer = null;
    await scrubModuleState();
  });

  it('A then B fired BEFORE the host mounts are both presented, A first', async () => {
    mod.showBrandNotice(A);
    mod.showBrandNotice(B);
    await act(async () => {
      renderer = TestRenderer.create(<mod.BrandNoticeHost />);
    });
    expect(visibleTitle(renderer!)).toBe('notice-A');
    expect(await drain(renderer!)).toEqual(['notice-A', 'notice-B']);
  });

  it('A then B fired in ONE act() with the host mounted are both presented, A first', async () => {
    await act(async () => {
      renderer = TestRenderer.create(<mod.BrandNoticeHost />);
    });
    expect(visibleTitle(renderer!)).toBeNull();
    await act(async () => {
      mod.showBrandNotice(A);
      mod.showBrandNotice(B);
    });
    expect(visibleTitle(renderer!)).toBe('notice-A');
    expect(await drain(renderer!)).toEqual(['notice-A', 'notice-B']);
  });

  it('B fired while A is on screen does not erase A before the user saw it', async () => {
    await act(async () => {
      renderer = TestRenderer.create(<mod.BrandNoticeHost />);
    });
    await act(async () => {
      mod.showBrandNotice(A);
    });
    expect(visibleTitle(renderer!)).toBe('notice-A');
    await act(async () => {
      mod.showBrandNotice(B);
    });
    expect(visibleTitle(renderer!)).toBe('notice-A');
    expect(await drain(renderer!)).toEqual(['notice-A', 'notice-B']);
  });

  it('a single notice fired before mount is delivered exactly once and cleared', async () => {
    mod.showBrandNotice(A);
    await act(async () => {
      renderer = TestRenderer.create(<mod.BrandNoticeHost />);
    });
    expect(await drain(renderer!)).toEqual(['notice-A']);
    // Remounting must not replay the already-consumed pending notice.
    act(() => renderer!.unmount());
    await act(async () => {
      renderer = TestRenderer.create(<mod.BrandNoticeHost />);
    });
    expect(visibleTitle(renderer!)).toBeNull();
  });

  it('a notice fired while NO host is mounted (after unmount) is parked and delivered on remount', async () => {
    await act(async () => {
      renderer = TestRenderer.create(<mod.BrandNoticeHost />);
    });
    act(() => renderer!.unmount());
    mod.showBrandNotice(B);
    await act(async () => {
      renderer = TestRenderer.create(<mod.BrandNoticeHost />);
    });
    expect(visibleTitle(renderer!)).toBe('notice-B');
  });

  it('a second host mounting and unmounting must not disconnect the surviving host', async () => {
    await act(async () => {
      renderer = TestRenderer.create(<mod.BrandNoticeHost />);
    });
    let second!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      second = TestRenderer.create(<mod.BrandNoticeHost />);
    });
    act(() => second.unmount());
    await act(async () => {
      mod.showBrandNotice(A);
    });
    expect(visibleTitle(renderer!)).toBe('notice-A');
  });

  it('unicode + 10k-character notice renders without throwing and dismisses', async () => {
    await act(async () => {
      renderer = TestRenderer.create(<mod.BrandNoticeHost />);
    });
    const huge = {
      title: `notice-🎾 ünïcode ${'x'.repeat(10_000)}`,
      detail: '\u202e reversed \u0000 nul',
      eyebrow: 'ß ｆｕｌｌｗｉｄｔｈ',
      actionLabel: 'OK 👍',
    };
    await act(async () => {
      mod.showBrandNotice(huge);
    });
    expect(visibleTitle(renderer!)).toBe(huge.title);
    expect(await drain(renderer!)).toEqual([huge.title]);
  });
});
