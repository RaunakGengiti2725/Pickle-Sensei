import { describe, expect, it, vi } from "vitest";
import { SqsJobQueue } from "../../src/index.js";
import { KNOWN_GAPS, replay } from "./campaign.js";
import { fakeBroker } from "./fakeBroker.js";

/**
 * Minimized, seed-replayable pins for the gaps the boundary-malformed
 * campaign reproduced in SqsJobQueue.receive. Each `it` asserts the CURRENT
 * (broken) behaviour so the campaign can tolerate it by gapId without hiding
 * new failures. When a gap is fixed this file goes red: delete the pin AND
 * its KNOWN_GAPS entry in campaign.ts together with the fix.
 *
 * Seeds come from `STRESS_SEED=20260904 STRESS_ITER=1000` (decode campaign);
 * the direct repro next to each seed is the minimized payload.
 */

vi.mock("@aws-sdk/client-sqs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-sqs")>();
  const { FakeSQSClient } = await import("./fakeBroker.js");
  return { ...actual, SQSClient: FakeSQSClient };
});

const QUEUE_URL = "fake://sqs/000000000000/known-gaps";

function queue(): SqsJobQueue {
  return new SqsJobQueue({ queueUrl: QUEUE_URL, region: "fake" });
}

describe("GAP-QUEUE-1: JSON document `null` as a message body", () => {
  it("is registered as a known gap", () => {
    expect(KNOWN_GAPS.map((gap) => gap.id)).toContain("GAP-QUEUE-1-null-body-throws");
  });

  it("minimized: receive() rejects with TypeError instead of flagging the message", async () => {
    fakeBroker.reset();
    fakeBroker.inject(QUEUE_URL, "null");
    await expect(queue().receive(10)).rejects.toThrow(
      /Cannot read properties of null \(reading 'kind'\)/,
    );
    expect(fakeBroker.deletes).toHaveLength(0);
  });

  it("one `null` body loses its whole batch: valid neighbours are neither returned nor acked", async () => {
    fakeBroker.reset();
    const before = fakeBroker.inject(
      QUEUE_URL,
      JSON.stringify({ kind: "media.process", payload: {} }),
    );
    fakeBroker.inject(QUEUE_URL, "null");
    const after = fakeBroker.inject(
      QUEUE_URL,
      JSON.stringify({ kind: "media.purge", payload: {} }),
    );
    await expect(queue().receive(10)).rejects.toBeInstanceOf(TypeError);
    // All three were handed out by the broker (receive counts advanced) but
    // the caller got nothing back to ack — identical to a crashed consumer.
    expect(before.receiveCount).toBe(1);
    expect(after.receiveCount).toBe(1);
    expect(fakeBroker.deletes).toHaveLength(0);
  });

  it.each([3116352722, 595876589])("replays from seed %d", async (seed) => {
    const row = await replay("decode", seed);
    expect(row.category).toMatch(/json-nonobject-null$/);
    expect(row.outcome).toBe("BROKEN");
    expect(row.violations).toEqual(["receive_threw"]);
    expect(row.gapId).toBe("GAP-QUEUE-1-null-body-throws");
    expect(row.error).toMatch(/TypeError/);
  });

  it("contrast: every other non-object JSON document decodes without throwing", async () => {
    for (const body of ["123", '"abc"', "true", "false", "[1,2]", "[]", "{}"]) {
      fakeBroker.reset();
      fakeBroker.inject(QUEUE_URL, body);
      const received = await queue().receive(10);
      expect(received).toHaveLength(1);
    }
  });
});

describe("GAP-QUEUE-2: non-integer ApproximateReceiveCount becomes the attempt", () => {
  it("is registered as a known gap", () => {
    expect(KNOWN_GAPS.map((gap) => gap.id)).toContain("GAP-QUEUE-2-attempt-not-integer");
  });

  it.each([
    ["abc", Number.NaN],
    ["NaN", Number.NaN],
    ["", 0],
    ["1e999", Number.POSITIVE_INFINITY],
    ["1.5", 1.5],
    ["-1", -1],
  ])("minimized: ApproximateReceiveCount=%j → attempt %s", async (raw, attempt) => {
    fakeBroker.reset();
    fakeBroker.inject(QUEUE_URL, JSON.stringify({ kind: "media.process", payload: {} }), {
      ApproximateReceiveCount: raw,
    });
    const [entry] = await queue().receive(10);
    expect(entry).toBeDefined();
    expect(entry?.job.attempt).toBe(attempt);
    expect(Number.isInteger(entry?.job.attempt) && (entry?.job.attempt ?? 0) >= 1).toBe(false);
  });

  it.each([4115361623, 3903053709, 2923272690])("replays from seed %d", async (seed) => {
    const row = await replay("decode", seed);
    expect(row.category).toMatch(/^attr-garbage\|/);
    expect(row.outcome).toBe("BROKEN");
    expect(row.violations).toContain("attempt_not_finite");
    expect(row.gapId).toBe("GAP-QUEUE-2-attempt-not-integer");
  });

  it("contrast: an absent Attributes block yields attempt 1", async () => {
    fakeBroker.reset();
    fakeBroker.inject(QUEUE_URL, JSON.stringify({ kind: "media.process", payload: {} }), null);
    const [entry] = await queue().receive(10);
    expect(entry?.job.attempt).toBe(1);
  });
});
