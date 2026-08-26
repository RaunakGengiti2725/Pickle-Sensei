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
});
