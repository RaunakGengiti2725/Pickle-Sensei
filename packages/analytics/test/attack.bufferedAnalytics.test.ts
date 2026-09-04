/**
 * Adversarial pass (shared-packages-ops #1, pass 3) — BufferedAnalytics.
 *
 * Every test here pins what the implementation at 4d812e1a ACTUALLY does.
 * `it(...)` = the attack HELD (behaviour is what the contract promises).
 * `it.fails(...)` = the attack BROKE the contract: the assertion inside states
 * the EXPECTED behaviour and currently fails; the sibling `it` pins the
 * observed behaviour so a fix flips exactly one pair of tests.
 */
import { describe, expect, it } from "vitest";
import { BufferedAnalytics, type AnalyticsEvent } from "../src/index.js";

const at = "2026-09-04T12:00:00.000Z";

function drill(i: number): AnalyticsEvent {
  return { name: "drill_opened", drillSlug: `drill-${String(i).padStart(3, "0")}`, at };
}
function slugsOf(batch: AnalyticsEvent[]): string[] {
  return batch.map((e) => (e.name === "drill_opened" ? e.drillSlug : e.name));
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("S1 — maxBuffer=3, permanently failing transport, 10 synchronous tracks", () => {
  it("retains all 10 events and calls the transport exactly 3 times (auto-flush at 3, 6, 9)", async () => {
    let calls = 0;
    const analytics = new BufferedAnalytics(async () => {
      calls++;
      throw new Error("permanent transport failure");
    }, 3);
    for (let i = 1; i <= 10; i++) analytics.track(drill(i));
    await settle();
    expect(calls).toBe(3);
    expect(analytics.pendingCount()).toBe(10);
    expect(analytics.droppedViolationCount()).toBe(0);
  });

  it.fails("EXPECTED: re-buffered events keep chronological order", async () => {
    const analytics = new BufferedAnalytics(async () => {
      throw new Error("permanent transport failure");
    }, 3);
    for (let i = 1; i <= 10; i++) analytics.track(drill(i));
    await settle();
    // Peek at the retained order through a now-succeeding transport.
    const delivered: string[] = [];
    (analytics as unknown as { transport: (b: AnalyticsEvent[]) => Promise<void> }).transport =
      async (b) => {
        delivered.push(...slugsOf(b));
      };
    await analytics.flush();
    expect(delivered).toEqual(Array.from({ length: 10 }, (_, i) => slugsOf([drill(i + 1)])[0]));
  });

  it("OBSERVED: failed batches are PREPENDED, so retained order is 7,8,9,4,5,6,1,2,3,10", async () => {
    const analytics = new BufferedAnalytics(async () => {
      throw new Error("permanent transport failure");
    }, 3);
    for (let i = 1; i <= 10; i++) analytics.track(drill(i));
    await settle();
    const delivered: string[] = [];
    (analytics as unknown as { transport: (b: AnalyticsEvent[]) => Promise<void> }).transport =
      async (b) => {
        delivered.push(...slugsOf(b));
      };
    await analytics.flush();
    expect(delivered.map((s) => Number(s.slice(-3)))).toEqual([7, 8, 9, 4, 5, 6, 1, 2, 3, 10]);
  });

  it("OBSERVED: with a permanently failing transport the buffer is UNBOUNDED (maxBuffer bounds only the re-buffered batch)", async () => {
    let calls = 0;
    const analytics = new BufferedAnalytics(async () => {
      calls++;
      throw new Error("permanent transport failure");
    }, 3);
    for (let i = 1; i <= 3000; i++) analytics.track(drill(i));
    await settle();
    expect(calls).toBe(1000);
    expect(analytics.pendingCount()).toBe(3000);
  });

  it.fails(
    "EXPECTED: pendingCount never exceeds maxBuffer (memory bound) OR a drop counter is exposed",
    async () => {
      const analytics = new BufferedAnalytics(async () => {
        throw new Error("permanent transport failure");
      }, 3);
      for (let i = 1; i <= 3000; i++) analytics.track(drill(i));
      await settle();
      expect(analytics.pendingCount()).toBeLessThanOrEqual(3);
    },
  );
});

describe("S1b — sequential (awaited) tracks with a failing transport: silent loss", () => {
  it("OBSERVED: once the buffer is full every track() re-flushes, and the OLDEST event is dropped with no counter", async () => {
    let calls = 0;
    const analytics = new BufferedAnalytics(async () => {
      calls++;
      throw new Error("permanent transport failure");
    }, 3);
    for (let i = 1; i <= 10; i++) {
      analytics.track(drill(i));
      await settle();
    }
    // tracks 3..10 each trigger a flush (8 calls); every failed flush keeps only
    // the last 3 of the failed batch → events 1..7 are gone.
    expect(calls).toBe(8);
    expect(analytics.pendingCount()).toBe(3);
    const delivered: string[] = [];
    (analytics as unknown as { transport: (b: AnalyticsEvent[]) => Promise<void> }).transport =
      async (b) => {
        delivered.push(...slugsOf(b));
      };
    await analytics.flush();
    expect(delivered.map((s) => Number(s.slice(-3)))).toEqual([8, 9, 10]);
    // The drop is invisible: the only counter is the redaction-violation one.
    expect(analytics.droppedViolationCount()).toBe(0);
  });

  it.fails(
    "EXPECTED: events dropped by the bounded re-buffer are accounted for somewhere observable",
    async () => {
      const analytics = new BufferedAnalytics(async () => {
        throw new Error("permanent transport failure");
      }, 3);
      for (let i = 1; i <= 10; i++) {
        analytics.track(drill(i));
        await settle();
      }
      const dropped = 10 - analytics.pendingCount();
      expect(dropped).toBe(7);
      const anyCounter = analytics as unknown as { droppedOverflowCount?: () => number };
      expect(typeof anyCounter.droppedOverflowCount).toBe("function");
    },
  );
});

describe("S2 — flush() twice concurrently while the first transport promise is pending", () => {
  it("HELD: no duplicate delivery and no loss (second flush is a no-op on the emptied buffer)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const batches: string[][] = [];
    const analytics = new BufferedAnalytics(async (batch) => {
      batches.push(slugsOf(batch));
      await gate;
    }, 50);
    for (let i = 1; i <= 5; i++) analytics.track(drill(i));
    const first = analytics.flush();
    const second = analytics.flush();
    expect(analytics.pendingCount()).toBe(0);
    release();
    await Promise.all([first, second]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(5);
    expect(new Set(batches.flat()).size).toBe(5);
    expect(analytics.pendingCount()).toBe(0);
  });

  it("HELD: events tracked while a flush is in flight are delivered exactly once by the next flush", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const batches: string[][] = [];
    let firstCall = true;
    const analytics = new BufferedAnalytics(async (batch) => {
      batches.push(slugsOf(batch));
      if (firstCall) {
        firstCall = false;
        await gate;
      }
    }, 50);
    for (let i = 1; i <= 3; i++) analytics.track(drill(i));
    const first = analytics.flush();
    analytics.track(drill(4));
    analytics.track(drill(5));
    const second = analytics.flush();
    release();
    await Promise.all([first, second]);
    expect(batches.flat().map((s) => Number(s.slice(-3)))).toEqual([1, 2, 3, 4, 5]);
    expect(analytics.pendingCount()).toBe(0);
  });

  it("OBSERVED: if the in-flight flush FAILS while a later flush succeeded, the older batch lands AFTER the newer one (ordering inversion, no loss)", async () => {
    let rejectFirst: (e: Error) => void = () => {};
    const gate = new Promise<void>((_, rej) => {
      rejectFirst = rej;
    });
    const batches: number[][] = [];
    let call = 0;
    const analytics = new BufferedAnalytics(async (batch) => {
      call++;
      if (call === 1) await gate;
      batches.push(slugsOf(batch).map((s) => Number(s.slice(-3))));
    }, 50);
    analytics.track(drill(1));
    analytics.track(drill(2));
    const first = analytics.flush();
    analytics.track(drill(3));
    const second = analytics.flush();
    rejectFirst(new Error("late failure"));
    await Promise.all([first, second]);
    expect(batches).toEqual([[3]]);
    expect(analytics.pendingCount()).toBe(2);
    await analytics.flush();
    expect(batches).toEqual([[3], [1, 2]]);
  });

  it("HELD: a transport that throws SYNCHRONOUSLY (not a rejected promise) is still caught and re-buffered", async () => {
    const analytics = new BufferedAnalytics(
      (() => {
        throw new Error("sync throw");
      }) as unknown as (batch: AnalyticsEvent[]) => Promise<void>,
      50,
    );
    analytics.track(drill(1));
    await expect(analytics.flush()).resolves.toBeUndefined();
    expect(analytics.pendingCount()).toBe(1);
  });

  async function flakyRun(): Promise<{ delivered: number[]; pending: number }> {
    // Seeded LCG so the interleaving is reproducible (seed 20260904).
    let seed = 20260904;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const delivered: number[] = [];
    const analytics = new BufferedAnalytics(async (batch) => {
      if (rnd() < 0.4) throw new Error("flaky");
      delivered.push(...slugsOf(batch).map((s) => Number(s.slice(-3))));
    }, 7);
    const pending: Promise<void>[] = [];
    for (let i = 1; i <= 200; i++) {
      analytics.track(drill(i));
      if (rnd() < 0.3) pending.push(analytics.flush());
      if (rnd() < 0.2) await settle();
    }
    await Promise.all(pending);
    for (let k = 0; k < 50 && analytics.pendingCount() > 0; k++) await analytics.flush();
    return { delivered, pending: analytics.pendingCount() };
  }

  it("HELD: 200 interleaved track/flush pairs with a 40%-flaky transport never deliver an event twice", async () => {
    const { delivered, pending } = await flakyRun();
    expect(pending).toBe(0);
    expect(new Set(delivered).size).toBe(delivered.length);
  });

  it("OBSERVED: the same run silently LOSES 15 of 200 events (transient failures, not permanent)", async () => {
    const { delivered } = await flakyRun();
    expect(delivered).toHaveLength(185);
  });

  it.fails(
    "EXPECTED: a transiently failing transport eventually delivers every event",
    async () => {
      const { delivered } = await flakyRun();
      expect(delivered).toHaveLength(200);
    },
  );
});
