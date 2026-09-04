import React from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import { BrandNoticeHost, showBrandNotice } from '../../src/design/BrandNotice';
import { ScoreRing, useReducedMotion } from '../../src/design/components';
import { plural } from '../../src/util/plural';
import { makeUuid } from '../../src/util/uuid';

/**
 * Attack pass 3 — self-assigned extras across the design/util scope:
 *  - BrandNotice imperative bus: pre-mount queueing, replacement while
 *    visible, two hosts (identity-unaware teardown), unicode/huge bodies.
 *  - ScoreRing: cancelAnimationFrame on unmount mid count-up, score → null
 *    mid-animation, reduced motion, hostile numbers.
 *  - useReducedMotion: live toggle fan-out, listener teardown, a rejecting
 *    native query.
 *  - util: makeUuid format/uniqueness/fallback, plural edge values.
 */

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function hostByTestId(renderer: TestRenderer.ReactTestRenderer, id: string) {
  return renderer.root.findAll(
    node => node.props.testID === id && typeof node.type === 'string',
  );
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node => React.Children.toArray(node.props.children).join(''));
}

function pressableHosts(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    n =>
      typeof n.type === 'string' &&
      typeof n.props.onClick === 'function' &&
      typeof n.props.onStartShouldSetResponder === 'function',
  );
}

function click(host: TestRenderer.ReactTestInstance) {
  act(() => {
    host.props.onClick({ currentTarget: host, target: host, nativeEvent: {} });
  });
}

let consoleErrorSpy: jest.SpyInstance;
beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('BrandNotice bus (attack 3 extras)', () => {
  it('a notice raised before the host mounts is shown on mount; dismiss via action and via onRequestClose', async () => {
    showBrandNotice({ title: 'Pre-mount', detail: 'queued' });
    const renderer = await render(<BrandNoticeHost />);
    expect(hostByTestId(renderer, 'brand-notice')).toHaveLength(1);
    expect(texts(renderer)).toContain('Pre-mount');
    click(
      pressableHosts(renderer).find(
        h => h.props.accessibilityLabel === 'Got it',
      )!,
    );
    expect(hostByTestId(renderer, 'brand-notice')).toHaveLength(0);

    act(() => showBrandNotice({ title: 'Second', detail: 'live' }));
    expect(texts(renderer)).toContain('Second');
    const modal = renderer.root.find(
      n => typeof n.props.onRequestClose === 'function' && n.props.visible,
    );
    act(() => modal.props.onRequestClose());
    expect(hostByTestId(renderer, 'brand-notice')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('two notices raised BEFORE mount: only the last survives (the first is dropped)', async () => {
    showBrandNotice({
      title: 'Account deleted',
      detail: 'local cleanup needed',
    });
    showBrandNotice({ title: 'Link failed', detail: 'could not open' });
    const renderer = await render(<BrandNoticeHost />);
    const shown = texts(renderer);
    expect(shown).toContain('Link failed');
    // Dropped, and no second dialog after dismissing the visible one.
    expect(shown).not.toContain('Account deleted');
    click(
      pressableHosts(renderer).find(
        h => h.props.accessibilityLabel === 'Got it',
      )!,
    );
    expect(hostByTestId(renderer, 'brand-notice')).toHaveLength(0);
    expect(texts(renderer)).not.toContain('Account deleted');
    act(() => renderer.unmount());
  });

  it('a notice raised WHILE one is visible replaces it (no queue) — the earlier one is never shown again', async () => {
    const renderer = await render(<BrandNoticeHost />);
    act(() =>
      showBrandNotice({
        title: 'Account deleted',
        detail: 'cleanup',
        tone: 'danger',
      }),
    );
    act(() => showBrandNotice({ title: 'Link failed', detail: 'oops' }));
    expect(texts(renderer)).toContain('Link failed');
    expect(texts(renderer)).not.toContain('Account deleted');
    click(
      pressableHosts(renderer).find(
        h => h.props.accessibilityLabel === 'Got it',
      )!,
    );
    expect(hostByTestId(renderer, 'brand-notice')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('host unmount (screen torn down) then remount: notices raised in between are delivered on remount', async () => {
    const first = await render(<BrandNoticeHost />);
    act(() => first.unmount());
    showBrandNotice({ title: 'While away', detail: 'x' });
    const second = await render(<BrandNoticeHost />);
    expect(texts(second)).toContain('While away');
    act(() => second.unmount());
  });

  it('two hosts mounted; unmounting the SECOND leaves the first unable to receive notices until remount', async () => {
    const a = await render(<BrandNoticeHost />);
    const b = await render(<BrandNoticeHost />);
    act(() => b.unmount());
    act(() => showBrandNotice({ title: 'Orphaned', detail: 'x' }));
    // Identity-unaware teardown: the surviving host is still mounted but the
    // notice is parked as pending instead of shown.
    const shownOnA = texts(a).includes('Orphaned');
    expect(hostByTestId(a, 'brand-notice')).toHaveLength(shownOnA ? 1 : 0);
    expect(shownOnA).toBe(false);
    // ...and it is delivered to the next host that mounts.
    const c = await render(<BrandNoticeHost />);
    expect(texts(c)).toContain('Orphaned');
    act(() => a.unmount());
    act(() => c.unmount());
  });

  it('unicode + huge notice bodies render and dismiss without throwing', async () => {
    const renderer = await render(<BrandNoticeHost />);
    const title = '﷽ 🥒 Ünïcödé — ' + 'T'.repeat(5_000);
    const detail = '𝔘𝔫𝔦𝔠𝔬𝔡𝔢 '.repeat(4_000);
    act(() =>
      showBrandNotice({
        title,
        detail,
        eyebrow: 'ß'.repeat(300),
        actionLabel: '確認',
      }),
    );
    expect(texts(renderer)).toContain(title);
    expect(texts(renderer)).toContain('SS'.repeat(300));
    click(
      pressableHosts(renderer).find(
        h => h.props.accessibilityLabel === '確認',
      )!,
    );
    expect(hostByTestId(renderer, 'brand-notice')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('a notice with an empty action label still renders a pressable dismiss (no dead-end dialog)', async () => {
    const renderer = await render(<BrandNoticeHost />);
    act(() => showBrandNotice({ title: 'T', detail: 'D', actionLabel: '' }));
    const hosts = pressableHosts(renderer);
    // Backdrop + X + action button are all dismiss paths here.
    expect(hosts.length).toBeGreaterThanOrEqual(2);
    const action = hosts.find(h => h.props.accessibilityLabel === '');
    expect(action).toBeDefined();
    click(action!);
    expect(hostByTestId(renderer, 'brand-notice')).toHaveLength(0);
    act(() => renderer.unmount());
  });
});

describe('ScoreRing count-up lifecycle (attack 3 extras)', () => {
  type FrameCallback = (timestamp: number) => void;
  let rafCallbacks: Map<number, FrameCallback>;
  let nextFrame: number;
  let cancelSpy: jest.SpyInstance;
  let rafSpy: jest.SpyInstance;

  beforeEach(() => {
    rafCallbacks = new Map();
    nextFrame = 1;
    rafSpy = jest
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((cb: FrameCallback) => {
        const id = nextFrame++;
        rafCallbacks.set(id, cb);
        return id;
      });
    cancelSpy = jest
      .spyOn(globalThis, 'cancelAnimationFrame')
      .mockImplementation((id: number | null | undefined) => {
        if (typeof id === 'number') rafCallbacks.delete(id);
      });
  });
  afterEach(() => {
    rafSpy.mockRestore();
    cancelSpy.mockRestore();
  });

  function step(ts: number) {
    const pending = [...rafCallbacks.entries()];
    rafCallbacks.clear();
    act(() => {
      for (const [, cb] of pending) cb(ts);
    });
  }

  it('unmount mid count-up cancels the live frame and never sets state afterwards', async () => {
    const renderer = await render(<ScoreRing score={7.4} />);
    expect(rafSpy).toHaveBeenCalledTimes(1);
    step(0);
    step(100);
    expect(rafCallbacks.size).toBe(1);
    const [liveId] = [...rafCallbacks.keys()];
    act(() => renderer.unmount());
    expect(cancelSpy).toHaveBeenCalledWith(liveId);
    expect(rafCallbacks.size).toBe(0);
    // A stray late frame (native queue already flushed) is harmless.
    expect(() => step(5_000)).not.toThrow();
    const actWarnings = consoleErrorSpy.mock.calls.filter(c =>
      String(c[0]).includes('unmounted'),
    );
    expect(actWarnings).toHaveLength(0);
  });

  it('score → null mid-animation shows the em dash, cancels the frame and labels "No technique score yet"', async () => {
    const renderer = await render(<ScoreRing score={6} />);
    step(0);
    step(200);
    await act(async () => renderer.update(<ScoreRing score={null} />));
    expect(rafCallbacks.size).toBe(0);
    expect(texts(renderer)).toContain('—');
    const ring = renderer.root.findAll(
      n =>
        typeof n.type === 'string' &&
        n.props.accessibilityLabel === 'No technique score yet',
    );
    expect(ring).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('count-up lands exactly on the target after the sweep duration; a11y label carries the FINAL score, not the interim', async () => {
    const renderer = await render(<ScoreRing score={8.3} />);
    step(0);
    step(150);
    const interim = texts(renderer).find(t => /^\d+\.\d$/.test(t))!;
    expect(Number(interim)).toBeLessThan(8.3);
    expect(
      renderer.root.findAll(
        n =>
          typeof n.type === 'string' &&
          n.props.accessibilityLabel === 'Technique score 8.3 out of 10',
      ),
    ).toHaveLength(1);
    step(10_000);
    expect(texts(renderer)).toContain('8.3');
    expect(rafCallbacks.size).toBe(0);
    act(() => renderer.unmount());
  });

  it('hostile numbers: NaN / negative / >10 / Infinity never throw; observed text recorded', async () => {
    const seen: Record<string, string[]> = {};
    for (const score of [Number.NaN, -3, 12, Number.POSITIVE_INFINITY, 1e21]) {
      const renderer = await render(<ScoreRing score={score} />);
      step(0);
      step(10_000);
      seen[String(score)] = texts(renderer);
      act(() => renderer.unmount());
    }
    // A NaN or Infinity score renders literal 'NaN' / 'Infinity' — there is
    // no clamp in ScoreRing; callers must never pass one (recorded, not
    // asserted as a defect: upstream scores are 0–10 numbers or null).
    expect(seen['NaN']).toContain('NaN');
    expect(seen['Infinity']).toContain('Infinity');
    expect(seen['-3']).toContain('-3.0');
    expect(seen['12']).toContain('12.0');
  });

  it('reduced motion: no frame is scheduled and the final value renders immediately', async () => {
    const info = AccessibilityInfo as unknown as {
      addEventListener: jest.Mock;
    };
    const renderer = await render(<ScoreRing score={5.5} />);
    const listener = info.addEventListener.mock.calls.find(
      c => c[0] === 'reduceMotionChanged',
    )?.[1] as ((v: boolean) => void) | undefined;
    expect(listener).toBeDefined();
    act(() => listener!(true));
    // Now animate=false → displayScore snaps to the score, no rAF pending.
    expect(rafCallbacks.size).toBe(0);
    expect(texts(renderer)).toContain('5.5');
    const before = rafSpy.mock.calls.length;
    await act(async () => renderer.update(<ScoreRing score={9.1} />));
    expect(rafSpy.mock.calls.length).toBe(before);
    expect(texts(renderer)).toContain('9.1');
    act(() => listener!(false));
    act(() => renderer.unmount());
  });
});

describe('useReducedMotion fan-out (attack 3 extras)', () => {
  function Probe(props: { id: string }) {
    const reduced = useReducedMotion();
    return <Text testID={props.id}>{reduced ? 'reduced' : 'motion'}</Text>;
  }

  it('a reduceMotionChanged event updates every mounted consumer; unmounted consumers are not touched', async () => {
    const info = AccessibilityInfo as unknown as {
      addEventListener: jest.Mock;
    };
    const a = await render(<Probe id="a" />);
    const b = await render(<Probe id="b" />);
    const listener = info.addEventListener.mock.calls.find(
      c => c[0] === 'reduceMotionChanged',
    )![1] as (v: boolean) => void;
    act(() => b.unmount());
    act(() => listener(true));
    expect(texts(a)).toEqual(['reduced']);
    const c = await render(<Probe id="c" />);
    expect(texts(c)).toEqual(['reduced']);
    act(() => listener(false));
    expect(texts(a)).toEqual(['motion']);
    expect(texts(c)).toEqual(['motion']);
    // Rapid flapping ×200 stays consistent.
    for (let i = 0; i < 200; i += 1) act(() => listener(i % 2 === 0));
    expect(texts(a)).toEqual(['motion']);
    expect(texts(c)).toEqual(['motion']);
    const unmountedWarnings = consoleErrorSpy.mock.calls.filter(call =>
      String(call[0]).includes('unmounted'),
    );
    expect(unmountedWarnings).toHaveLength(0);
    act(() => a.unmount());
    act(() => c.unmount());
  });
});

describe('util (attack 3 extras)', () => {
  const V4 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('makeUuid: 20k ids are RFC-4122 v4 shaped and unique (crypto path)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) {
      const id = makeUuid();
      expect(id).toMatch(V4);
      seen.add(id);
    }
    expect(seen.size).toBe(20_000);
  });

  it('makeUuid: Math.random fallback (no crypto) still yields v4 shape and uniqueness under a seeded PRNG', () => {
    const g = globalThis as { crypto?: unknown };
    const savedCrypto = g.crypto;
    // Seeded LCG so the run is reproducible (seed 20260904).
    let state = 20260904;
    const rnd = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    const randomSpy = jest.spyOn(Math, 'random').mockImplementation(rnd);
    Object.defineProperty(g, 'crypto', {
      value: undefined,
      configurable: true,
    });
    try {
      const seen = new Set<string>();
      for (let i = 0; i < 5_000; i += 1) {
        const id = makeUuid();
        expect(id).toMatch(V4);
        seen.add(id);
      }
      expect(seen.size).toBe(5_000);
      expect(randomSpy).toHaveBeenCalled();
    } finally {
      Object.defineProperty(g, 'crypto', {
        value: savedCrypto,
        configurable: true,
      });
      randomSpy.mockRestore();
    }
  });

  it('makeUuid: a getRandomValues that throws propagates (no silent fallback) — recorded', () => {
    const g = globalThis as { crypto?: unknown };
    const savedCrypto = g.crypto;
    Object.defineProperty(g, 'crypto', {
      value: {
        getRandomValues: () => {
          throw new Error('entropy unavailable');
        },
      },
      configurable: true,
    });
    try {
      expect(() => makeUuid()).toThrow('entropy unavailable');
    } finally {
      Object.defineProperty(g, 'crypto', {
        value: savedCrypto,
        configurable: true,
      });
    }
  });

  it('plural: exact-1 semantics for hostile counts', () => {
    expect(plural(1, 'day')).toBe('day');
    expect(plural(1.0, 'day')).toBe('day');
    expect(plural(-1, 'day')).toBe('days');
    expect(plural(0, 'day')).toBe('days');
    expect(plural(-0, 'day')).toBe('days');
    expect(plural(Number.NaN, 'day')).toBe('days');
    expect(plural(Number.POSITIVE_INFINITY, 'day')).toBe('days');
    expect(plural(1.0000001, 'day')).toBe('days');
    expect(plural(1e21, 'day')).toBe('days');
    expect(plural(2, '', '')).toBe('');
    expect(plural(1, '🥒')).toBe('🥒');
    expect(plural(2, '🥒')).toBe('🥒s');
    expect(plural(2, 'x'.repeat(100_000))).toHaveLength(100_001);
  });
});
