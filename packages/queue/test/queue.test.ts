import { describe, expect, it } from "vitest";
import { InMemoryJobQueue } from "../src/index.js";

describe("InMemoryJobQueue", () => {
  it("delivers jobs once when acked", async () => {
    const q = new InMemoryJobQueue();
    await q.enqueue("media.process", { assetId: "a1" });
    const received = await q.receive(10);
    expect(received).toHaveLength(1);
    expect(received[0]?.job.kind).toBe("media.process");
    await received[0]?.ack();
    q.expireInFlight();
    expect(await q.size()).toBe(0);
  });

  it("redelivers unacked jobs with incremented attempt", async () => {
    const q = new InMemoryJobQueue();
    await q.enqueue("share.render", { id: "s1" });
    const first = await q.receive(1);
    expect(first[0]?.job.attempt).toBe(1);
    q.expireInFlight(); // no ack — visibility expires
    const second = await q.receive(1);
    expect(second[0]?.job.attempt).toBe(2);
    expect(second[0]?.job.payload).toEqual({ id: "s1" });
  });

  it("respects max receive count", async () => {
    const q = new InMemoryJobQueue();
    for (let i = 0; i < 5; i++) await q.enqueue("k", i);
    expect(await q.receive(2)).toHaveLength(2);
    expect(await q.size()).toBe(3);
  });

  it("reports oldest unfinished job age, including unacked in-flight jobs", async () => {
    const q = new InMemoryJobQueue();
    expect(await q.oldestJobAgeMs()).toBeNull();
    await q.enqueue("media.purge", { id: "m1" });
    const queuedAge = await q.oldestJobAgeMs();
    expect(queuedAge).not.toBeNull();
    expect(queuedAge!).toBeGreaterThanOrEqual(0);
    // Receiving without acking must NOT hide the job from the age metric —
    // an in-flight job that never completes is exactly the stall we measure.
    const [received] = await q.receive(1);
    expect(await q.oldestJobAgeMs()).not.toBeNull();
    await received!.ack();
    expect(await q.oldestJobAgeMs()).toBeNull();
  });

  it("keeps age visible across visibility-timeout expiry (crash simulation)", async () => {
    const q = new InMemoryJobQueue();
    await q.enqueue("analysis.deep", { shotId: "s1" });
    await q.receive(1); // worker "crashes": no ack
    q.expireInFlight();
    expect(await q.oldestJobAgeMs()).not.toBeNull();
    expect(await q.size()).toBe(1);
  });
});
