/**
 * ADVERSARIAL PASS 3 — mobile-design-components-walkthrough — scenario 8.
 *
 * walkthroughStore.maybeShowFirstRun under a slow KV: the durable "seen"
 * write is still pending when `dismiss()` is called explicitly. When the
 * write then resolves the tour must NOT be raised over the dismissal.
 * Extra attacks: N concurrent mounts against a pending KV, dismiss while
 * queued behind another ceremony, a KV that throws synchronously, a write
 * that fails then a later retry, and replay/dismiss interleaved with the
 * pending first-run write.
 */

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};
function mockDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mockKv = new Map<string, string>();
const mockPendingReads: Array<Deferred<{ rows: Array<{ value: string }> }>> =
  [];
const mockPendingWrites: Array<Deferred<{ rows: never[] }>> = [];
let mockDeferReads = false;
let mockDeferWrites = false;
let mockThrowSyncOnGetDb = false;
let mockWriteCount = 0;

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    if (mockThrowSyncOnGetDb) throw new Error('sqlite not open');
    return {
      async execute(sql: string, params: unknown[] = []) {
        if (sql.startsWith('SELECT value FROM kv')) {
          const value = mockKv.get(String(params[0]));
          const rows = value === undefined ? [] : [{ value }];
          if (mockDeferReads) {
            const d = mockDeferred<{ rows: Array<{ value: string }> }>();
            mockPendingReads.push(d);
            return d.promise;
          }
          return { rows };
        }
        if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
          mockWriteCount += 1;
          if (mockDeferWrites) {
            const d = mockDeferred<{ rows: never[] }>();
            mockPendingWrites.push(d);
            // Commit lazily when the deferred resolves so ordering matches
            // a real async SQLite write.
            void d.promise.then(
              () => mockKv.set(String(params[0]), String(params[1])),
              () => undefined,
            );
            return d.promise;
          }
          mockKv.set(String(params[0]), String(params[1]));
          return { rows: [] };
        }
        return { rows: [] };
      },
      close() {},
    };
  },
}));

import {
  WALKTHROUGH_KV_KEY,
  WALKTHROUGH_SEEN_VALUE,
  useWalkthroughStore,
  walkthroughYieldsTo,
} from '../../src/walkthrough/walkthroughStore';

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

beforeEach(() => {
  mockKv.clear();
  mockPendingReads.length = 0;
  mockPendingWrites.length = 0;
  mockDeferReads = false;
  mockDeferWrites = false;
  mockThrowSyncOnGetDb = false;
  mockWriteCount = 0;
  useWalkthroughStore.setState({ visible: false, queued: false });
});

describe('ATTACK S8 — dismiss() while the first-run setKv is pending', () => {
  it('the tour is NOT raised when the pending write resolves after an explicit dismiss', async () => {
    mockDeferWrites = true;
    const store = useWalkthroughStore.getState();
    const run = store.maybeShowFirstRun();
    await flush();
    expect(mockPendingWrites).toHaveLength(1);
    expect(useWalkthroughStore.getState().visible).toBe(false);

    // Explicit user intent while the durable record is still being written.
    store.dismiss();
    expect(useWalkthroughStore.getState().visible).toBe(false);

    mockPendingWrites[0]!.resolve({ rows: [] });
    await run;
    await flush();

    // BREAK PROBE: `raise()` runs unconditionally after the awaited write;
    // there is no generation/cancellation check against a dismiss that
    // happened in between, so the tour pops over the user's dismissal.
    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(useWalkthroughStore.getState().queued).toBe(false);
    // The durable record still gets written (correct: never replay on
    // relaunch).
    expect(mockKv.get(WALKTHROUGH_KV_KEY)).toBe(WALKTHROUGH_SEEN_VALUE);
  });

  it('same race on the READ: dismiss() while getKv is pending, then the read resolves empty', async () => {
    mockDeferReads = true;
    const store = useWalkthroughStore.getState();
    const run = store.maybeShowFirstRun();
    await flush();
    expect(mockPendingReads).toHaveLength(1);
    store.dismiss();
    mockPendingReads[0]!.resolve({ rows: [] });
    await run;
    await flush();
    expect(useWalkthroughStore.getState().visible).toBe(false);
  });

  it('replay() then dismiss() while the first-run write is pending: the resolved write must not re-raise the tour', async () => {
    mockDeferWrites = true;
    const store = useWalkthroughStore.getState();
    const run = store.maybeShowFirstRun();
    await flush();
    store.replay();
    expect(useWalkthroughStore.getState().visible).toBe(true);
    store.dismiss();
    expect(useWalkthroughStore.getState().visible).toBe(false);
    mockPendingWrites[0]!.resolve({ rows: [] });
    await run;
    await flush();
    expect(useWalkthroughStore.getState().visible).toBe(false);
  });
});

describe('ATTACK S8 extras — concurrency, ceremonies, failing KV', () => {
  it('extra: 25 concurrent mounts against a pending KV → exactly one write, one raise', async () => {
    mockDeferReads = true;
    mockDeferWrites = true;
    const store = useWalkthroughStore.getState();
    const runs = Array.from({ length: 25 }, () => store.maybeShowFirstRun());
    await flush();
    // Serialized: only the first evaluation has reached the read.
    expect(mockPendingReads).toHaveLength(1);
    mockPendingReads[0]!.resolve({ rows: [] });
    await flush();
    expect(mockPendingWrites).toHaveLength(1);
    mockPendingWrites[0]!.resolve({ rows: [] });
    await flush();
    // The remaining 24 evaluations see visible=true and short-circuit, or
    // read the persisted record; either way no second write/raise.
    let guard = 0;
    while (mockPendingReads.length > 1 && guard < 100) {
      const d = mockPendingReads[mockPendingReads.length - 1]!;
      d.resolve({ rows: [{ value: WALKTHROUGH_SEEN_VALUE }] });
      await flush();
      guard += 1;
    }
    await Promise.all(runs);
    expect(mockWriteCount).toBe(1);
    expect(useWalkthroughStore.getState().visible).toBe(true);
  });

  it('extra: dismiss() while QUEUED behind another ceremony — the ceremony ending must not raise the tour', async () => {
    let showing = true;
    const listeners = new Set<() => void>();
    const unregister = walkthroughYieldsTo({
      isShowing: () => showing,
      subscribe: listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    try {
      await useWalkthroughStore.getState().maybeShowFirstRun();
      expect(useWalkthroughStore.getState()).toMatchObject({
        queued: true,
        visible: false,
      });
      useWalkthroughStore.getState().dismiss();
      showing = false;
      listeners.forEach(l => l());
      expect(useWalkthroughStore.getState()).toMatchObject({
        queued: false,
        visible: false,
      });
      // And the record is durable, so a later mount does not re-arm it.
      await useWalkthroughStore.getState().maybeShowFirstRun();
      expect(useWalkthroughStore.getState().visible).toBe(false);
    } finally {
      unregister();
    }
  });

  it('extra: ceremony flapping (show/hide 50x) while queued raises the tour exactly once and never while the ceremony shows', async () => {
    let showing = true;
    const listeners = new Set<() => void>();
    const unregister = walkthroughYieldsTo({
      isShowing: () => showing,
      subscribe: listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    try {
      await useWalkthroughStore.getState().maybeShowFirstRun();
      expect(useWalkthroughStore.getState().queued).toBe(true);
      let raises = 0;
      const unsub = useWalkthroughStore.subscribe((state, prev) => {
        if (state.visible && !prev.visible) {
          raises += 1;
          expect(showing).toBe(false);
        }
      });
      let seed = 31337;
      for (let i = 0; i < 50; i += 1) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        showing = seed % 2 === 0;
        listeners.forEach(l => l());
      }
      showing = false;
      listeners.forEach(l => l());
      unsub();
      expect(raises).toBe(1);
      expect(useWalkthroughStore.getState().visible).toBe(true);
    } finally {
      unregister();
    }
  });

  it('extra: getDb throwing synchronously must not reject maybeShowFirstRun (App fires it with `void`)', async () => {
    mockThrowSyncOnGetDb = true;
    await expect(
      useWalkthroughStore.getState().maybeShowFirstRun(),
    ).resolves.toBeUndefined();
    expect(useWalkthroughStore.getState().visible).toBe(false);
    // Recovery: once the DB opens, the next mount shows the tour normally.
    mockThrowSyncOnGetDb = false;
    await useWalkthroughStore.getState().maybeShowFirstRun();
    expect(useWalkthroughStore.getState().visible).toBe(true);
  });

  it('extra: a rejected write never shows; the next mount retries the write and shows', async () => {
    mockDeferWrites = true;
    const run = useWalkthroughStore.getState().maybeShowFirstRun();
    await flush();
    mockPendingWrites[0]!.reject(new Error('disk full'));
    await run;
    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(mockKv.has(WALKTHROUGH_KV_KEY)).toBe(false);
    mockDeferWrites = false;
    await useWalkthroughStore.getState().maybeShowFirstRun();
    expect(useWalkthroughStore.getState().visible).toBe(true);
    expect(mockKv.get(WALKTHROUGH_KV_KEY)).toBe(WALKTHROUGH_SEEN_VALUE);
  });

  it('extra: hostile non-empty stored values (garbage / unicode / "0" / "null") count as seen — never a relaunch loop', async () => {
    for (const stored of ['garbage', '{"version":"💥"}', '0', 'null', ' ']) {
      mockKv.set(WALKTHROUGH_KV_KEY, stored);
      useWalkthroughStore.setState({ visible: false, queued: false });
      await useWalkthroughStore.getState().maybeShowFirstRun();
      expect(useWalkthroughStore.getState().visible).toBe(false);
    }
    expect(mockWriteCount).toBe(0);
  });

  it('extra: an EMPTY-STRING record is read as null by getKv → shows once and self-heals the record (no loop)', async () => {
    mockKv.set(WALKTHROUGH_KV_KEY, '');
    await useWalkthroughStore.getState().maybeShowFirstRun();
    expect(useWalkthroughStore.getState().visible).toBe(true);
    expect(mockKv.get(WALKTHROUGH_KV_KEY)).toBe(WALKTHROUGH_SEEN_VALUE);
    useWalkthroughStore.getState().dismiss();
    await useWalkthroughStore.getState().maybeShowFirstRun();
    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(mockWriteCount).toBe(1);
  });
});
