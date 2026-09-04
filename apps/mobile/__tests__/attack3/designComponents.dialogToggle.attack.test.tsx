import React from 'react';
import { Modal, StyleSheet } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import { BrandDialog, BrandToggle, Button } from '../../src/design/components';

/**
 * Attack pass 3 / scenarios 5–7 — design-system primitives under hostile
 * props:
 *   5. BrandDialog visible with NO onDismiss: Modal.onRequestClose (Android
 *      back / iOS sheet swipe) must not throw and must not close the dialog;
 *   6. BrandDialog with two actions sharing the label 'Continue' (React key
 *      collision) — both render, each fires ITS OWN handler;
 *   7. BrandToggle disabled + on: role=switch, accessibilityState
 *      {checked:true, disabled:true}, hitSlop 5, 54×44 container.
 */

function hostByTestId(renderer: TestRenderer.ReactTestRenderer, id: string) {
  return renderer.root.findAll(
    node => node.props.testID === id && typeof node.type === 'string',
  );
}

/** Host views wired by Pressability (what the OS actually dispatches to). */
function pressableHosts(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    n =>
      typeof n.type === 'string' &&
      typeof n.props.onClick === 'function' &&
      typeof n.props.onStartShouldSetResponder === 'function',
  );
}

function hostsLabelled(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  return pressableHosts(renderer).filter(
    n => n.props.accessibilityLabel === label,
  );
}

/** Drives Pressability's accessibility click (VoiceOver double-tap). The real
 * RN handler refuses to fire onPress while disabled. */
function click(host: TestRenderer.ReactTestInstance) {
  act(() => {
    host.props.onClick({ currentTarget: host, target: host, nativeEvent: {} });
  });
}

function textContent(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAll(node => String(node.type) === 'Text')
    .map(node => React.Children.toArray(node.props.children).join(''))
    .join('\n');
}

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

let consoleErrorSpy: jest.SpyInstance;
beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('BrandDialog — no onDismiss (attack 3 / S5)', () => {
  it('Modal.onRequestClose is inert: no throw, dialog stays visible, no close affordance', async () => {
    const onContinue = jest.fn();
    const renderer = await render(
      <BrandDialog
        visible
        title="Session expired"
        detail="Sign in again to keep syncing."
        actions={[{ label: 'Continue', onPress: onContinue }]}
        testID="dlg"
      />,
    );
    expect(hostByTestId(renderer, 'dlg')).toHaveLength(1);
    const modal = renderer.root.findByType(Modal);
    const onRequestClose = modal.props.onRequestClose as
      (() => void) | undefined;
    // What the native host does on back/swipe: invoke the prop if present.
    expect(() => {
      onRequestClose?.();
      // …and what a careless caller would do:
      if (typeof onRequestClose === 'function') onRequestClose();
    }).not.toThrow();
    await act(async () => {});
    expect(hostByTestId(renderer, 'dlg')).toHaveLength(1);
    expect(modal.props.visible).toBe(true);
    // No "Close dialog" X when not dismissible; backdrop is disabled.
    expect(
      renderer.root.findAll(n => n.props.accessibilityLabel === 'Close dialog'),
    ).toHaveLength(0);
    const backdrop = pressableHosts(renderer).find(
      p => p.props.accessible === false,
    );
    expect(backdrop).toBeDefined();
    expect(backdrop!.props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
    // Tapping the disabled backdrop through the real Pressability handler
    // does nothing and the dialog is still there.
    click(backdrop!);
    expect(hostByTestId(renderer, 'dlg')).toHaveLength(1);
    expect(onContinue).not.toHaveBeenCalled();
    // The one action still works.
    click(hostsLabelled(renderer, 'Continue')[0]!);
    expect(onContinue).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('with onDismiss, onRequestClose / backdrop / X all route to it exactly once per invocation', async () => {
    const onDismiss = jest.fn();
    const renderer = await render(
      <BrandDialog
        visible
        title="T"
        detail="D"
        actions={[]}
        onDismiss={onDismiss}
        testID="dlg"
      />,
    );
    const modal = renderer.root.findByType(Modal);
    act(() => modal.props.onRequestClose());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    const backdrop = pressableHosts(renderer).find(
      p => p.props.accessible === false,
    )!;
    expect(backdrop.props.accessibilityState?.disabled).toBeFalsy();
    click(backdrop);
    expect(onDismiss).toHaveBeenCalledTimes(2);
    const close = hostsLabelled(renderer, 'Close dialog')[0]!;
    click(close);
    expect(onDismiss).toHaveBeenCalledTimes(3);
    act(() => renderer.unmount());
  });

  it('visible=false renders no card; toggling visible on/off ×10 never leaks a card', async () => {
    const renderer = await render(
      <BrandDialog
        visible={false}
        title="T"
        detail="D"
        actions={[]}
        testID="dlg"
      />,
    );
    expect(hostByTestId(renderer, 'dlg')).toHaveLength(0);
    for (let i = 0; i < 10; i += 1) {
      await act(async () =>
        renderer.update(
          <BrandDialog
            visible={i % 2 === 0}
            title="T"
            detail="D"
            actions={[]}
            testID="dlg"
          />,
        ),
      );
      expect(hostByTestId(renderer, 'dlg')).toHaveLength(i % 2 === 0 ? 1 : 0);
    }
    act(() => renderer.unmount());
  });

  it('is announced as a modal region (accessibilityViewIsModal) and shows title/detail/eyebrow text including unicode', async () => {
    const title = '🥒 Sesión expirada — Überprüfen ﷽';
    const detail = 'x'.repeat(20_000);
    const renderer = await render(
      <BrandDialog
        visible
        title={title}
        detail={detail}
        eyebrow="straße"
        actions={[]}
        testID="dlg"
      />,
    );
    const card = hostByTestId(renderer, 'dlg')[0]!;
    expect(card.props.accessibilityViewIsModal).toBe(true);
    const text = textContent(renderer);
    expect(text).toContain(title);
    expect(text).toContain(detail);
    expect(text).toContain('STRASSE');
    act(() => renderer.unmount());
  });
});

describe('BrandDialog — duplicate action labels (attack 3 / S6)', () => {
  it("two actions both labelled 'Continue' render both and each fires its own handler", async () => {
    const first = jest.fn();
    const second = jest.fn();
    const renderer = await render(
      <BrandDialog
        visible
        title="Pick one"
        detail="Two identical labels."
        actions={[
          { label: 'Continue', onPress: first, variant: 'secondary' },
          { label: 'Continue', onPress: second, variant: 'primary' },
        ]}
        testID="dlg"
      />,
    );
    const buttons = renderer.root.findAllByType(Button);
    expect(buttons).toHaveLength(2);
    const hosts = hostsLabelled(renderer, 'Continue');
    expect(hosts).toHaveLength(2);
    click(hosts[0]!);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    click(hosts[1]!);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    // Both still present after presses (dialog does not self-dismiss).
    expect(hostByTestId(renderer, 'dlg')).toHaveLength(1);
    // React warns about the duplicate key — that is the collision the
    // scenario targets; record whether it surfaced.
    const keyWarnings = consoleErrorSpy.mock.calls.filter(call =>
      call.some((arg: unknown) => String(arg).includes('same key')),
    );
    expect(keyWarnings.length).toBeGreaterThanOrEqual(1);
    act(() => renderer.unmount());
  });

  it('reordering / swapping the two identical-label actions rebinds handlers to the right button', async () => {
    const a = jest.fn();
    const b = jest.fn();
    const make = (actions: Array<{ label: string; onPress: () => void }>) => (
      <BrandDialog
        visible
        title="T"
        detail="D"
        actions={actions}
        testID="dlg"
      />
    );
    const renderer = await render(
      make([
        { label: 'Continue', onPress: a },
        { label: 'Continue', onPress: b },
      ]),
    );
    await act(async () =>
      renderer.update(
        make([
          { label: 'Continue', onPress: b },
          { label: 'Continue', onPress: a },
        ]),
      ),
    );
    const hosts = hostsLabelled(renderer, 'Continue');
    expect(hosts).toHaveLength(2);
    click(hosts[0]!);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    click(hosts[1]!);
    expect(a).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('removing the FIRST of two identical-label actions keeps the survivor bound to its own handler', async () => {
    const a = jest.fn();
    const b = jest.fn();
    const renderer = await render(
      <BrandDialog
        visible
        title="T"
        detail="D"
        actions={[
          { label: 'Continue', onPress: a },
          { label: 'Continue', onPress: b },
        ]}
        testID="dlg"
      />,
    );
    await act(async () =>
      renderer.update(
        <BrandDialog
          visible
          title="T"
          detail="D"
          actions={[{ label: 'Continue', onPress: b }]}
          testID="dlg"
        />,
      ),
    );
    const hosts = hostsLabelled(renderer, 'Continue');
    expect(hosts).toHaveLength(1);
    click(hosts[0]!);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('a disabled duplicate does not swallow the enabled twin', async () => {
    const enabled = jest.fn();
    const disabled = jest.fn();
    const renderer = await render(
      <BrandDialog
        visible
        title="T"
        detail="D"
        actions={[
          { label: 'Continue', onPress: disabled, disabled: true },
          { label: 'Continue', onPress: enabled },
        ]}
        testID="dlg"
      />,
    );
    const hosts = hostsLabelled(renderer, 'Continue');
    expect(hosts).toHaveLength(2);
    expect(hosts[0]!.props.accessibilityState).toEqual({ disabled: true });
    expect(hosts[1]!.props.accessibilityState).toEqual({ disabled: undefined });
    click(hosts[0]!);
    expect(disabled).not.toHaveBeenCalled();
    click(hosts[1]!);
    expect(enabled).toHaveBeenCalledTimes(1);
    expect(disabled).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('ten identical labels: every handler is individually addressable', async () => {
    const handlers = Array.from({ length: 10 }, () => jest.fn());
    const renderer = await render(
      <BrandDialog
        visible
        title="T"
        detail="D"
        actions={handlers.map(onPress => ({ label: 'Continue', onPress }))}
        testID="dlg"
      />,
    );
    const hosts = hostsLabelled(renderer, 'Continue');
    expect(hosts).toHaveLength(10);
    hosts.forEach((h, i) => {
      click(h);
      expect(handlers[i]).toHaveBeenCalledTimes(1);
    });
    expect(handlers.reduce((n, h) => n + h.mock.calls.length, 0)).toBe(10);
    act(() => renderer.unmount());
  });
});

describe('BrandToggle — disabled + on (attack 3 / S7)', () => {
  function toggleHost(renderer: TestRenderer.ReactTestRenderer) {
    return pressableHosts(renderer).filter(
      n => n.props.accessibilityRole === 'switch',
    )[0]!;
  }

  it('exposes role=switch, state {checked:true, disabled:true}, hitSlop 5 and a 54×44 container', async () => {
    const onValueChange = jest.fn();
    const renderer = await render(
      <BrandToggle
        label="Practice reminders"
        value
        disabled
        onValueChange={onValueChange}
        testID="tgl"
      />,
    );
    const host = toggleHost(renderer);
    expect(host).toBeDefined();
    expect(host.props.accessibilityRole).toBe('switch');
    expect(host.props.accessibilityLabel).toBe('Practice reminders');
    expect(host.props.accessibilityState).toEqual({
      checked: true,
      disabled: true,
    });
    expect(host.props.hitSlop).toBe(5);
    expect(host.props.testID).toBe('tgl');
    const hostView = hostByTestId(renderer, 'tgl')[0]!;
    expect(hostView).toBe(host);
    // Disabled: the real Pressability click handler must not flip the value.
    click(host);
    expect(onValueChange).not.toHaveBeenCalled();

    // Container: the nearest HOST ancestor of the pressable View is the
    // Animated.View scale wrapper carrying styles.toggleContainer.
    let container = hostView.parent!;
    while (typeof container.type !== 'string') container = container.parent!;
    const flat = StyleSheet.flatten(container.props.style) as {
      width?: number;
      height?: number;
    };
    expect(flat.width).toBe(54);
    expect(flat.height).toBe(44);

    // onLayout is NOT wired on the container: simulate what layout would
    // report for the resolved style and verify it matches the 44pt target.
    const onLayout = jest.fn();
    onLayout({
      nativeEvent: {
        layout: { x: 0, y: 0, width: flat.width, height: flat.height },
      },
    });
    expect(onLayout).toHaveBeenCalledWith({
      nativeEvent: { layout: { x: 0, y: 0, width: 54, height: 44 } },
    });
    expect(container.props.onLayout).toBeUndefined();
    // Disabled opacity is applied on the host.
    const hostStyle = StyleSheet.flatten(host.props.style) as {
      opacity?: number;
      width?: number;
      height?: number;
    };
    expect(hostStyle.opacity).toBe(0.42);
    expect(hostStyle.width).toBe(54);
    expect(hostStyle.height).toBe(34);
    act(() => renderer.unmount());
  });

  it('disabled: 20 a11y clicks + a full responder grant/release never call onValueChange', async () => {
    const onValueChange = jest.fn();
    const renderer = await render(
      <BrandToggle
        label="L"
        value
        disabled
        onValueChange={onValueChange}
        testID="tgl"
      />,
    );
    const host = toggleHost(renderer);
    for (let i = 0; i < 20; i += 1) click(host);
    // Full responder cycle too (grant → release), as a finger would do.
    // Pressability measures the responder on grant; give it a node that can.
    const responder = {
      measure: (
        cb: (
          x: number,
          y: number,
          w: number,
          h: number,
          px: number,
          py: number,
        ) => void,
      ) => cb(0, 0, 54, 34, 0, 0),
    };
    const touch = {
      nativeEvent: {
        touches: [],
        changedTouches: [],
        pageX: 1,
        pageY: 1,
        timestamp: Date.now(),
      },
      currentTarget: responder,
      target: responder,
      persist() {},
    };
    // The responder system consults onStartShouldSetResponder before any
    // grant; Pressability refuses while disabled — that refusal is the ONLY
    // thing keeping the release path (which does not re-check `disabled`)
    // from firing onPress, so pin it and only drive the cycle if granted.
    const wantsResponder: boolean = host.props.onStartShouldSetResponder();
    expect(wantsResponder).toBe(false);
    if (wantsResponder) {
      act(() => {
        host.props.onResponderGrant(touch);
        host.props.onResponderRelease(touch);
      });
    }
    expect(onValueChange).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('enabled: a press reports the flipped value; rapid ×50 presses report alternating values with no drift', async () => {
    const seen: boolean[] = [];
    let value = false;
    const make = () => (
      <BrandToggle
        label="L"
        value={value}
        onValueChange={next => {
          seen.push(next);
          value = next;
        }}
        testID="tgl"
      />
    );
    const renderer = await render(make());
    for (let i = 0; i < 50; i += 1) {
      const host = toggleHost(renderer);
      expect(host.props.accessibilityState).toEqual({
        checked: value,
        disabled: undefined,
      });
      click(host);
      await act(async () => renderer.update(make()));
    }
    expect(seen).toHaveLength(50);
    expect(seen.every((v, i) => v === (i % 2 === 0))).toBe(true);
    act(() => renderer.unmount());
  });

  it('flipping disabled on/off while on keeps checked=true and updates disabled only', async () => {
    const renderer = await render(
      <BrandToggle
        label="L"
        value
        disabled
        onValueChange={() => {}}
        testID="tgl"
      />,
    );
    expect(toggleHost(renderer).props.accessibilityState).toEqual({
      checked: true,
      disabled: true,
    });
    await act(async () =>
      renderer.update(
        <BrandToggle label="L" value onValueChange={() => {}} testID="tgl" />,
      ),
    );
    expect(toggleHost(renderer).props.accessibilityState).toEqual({
      checked: true,
      disabled: undefined,
    });
    act(() => renderer.unmount());
  });
});
