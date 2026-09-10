import { describe, expect, it } from "vitest";
import {
  OFFLINE_RECEIPT_BATCH_LIMITS,
  OFFLINE_RECEIPT_BATCH_MAX_BODY_BYTES,
  OFFLINE_RECEIPT_BATCH_MAX_ENTRIES,
  OFFLINE_RECEIPT_BATCH_TOO_LARGE_CODE,
  OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
  planOfflineReceiptBatches,
  type OfflineDeviceReceipt,
} from "../index.js";

// The delayed-reconciliation route (POST /v1/offline/receipts) reads at most
// OFFLINE_RECEIPT_BATCH_MAX_BODY_BYTES of JSON per request and decides at most
// OFFLINE_RECEIPT_BATCH_MAX_ENTRIES new receipts per request. The device
// drains EVERY pending receipt, so a queue that outgrows the byte cap in one
// POST would be refused identically on every drain and never settle. The plan
// below is what a drain uses to split the queue into requests the route
// accepts, in queue order, every receipt exactly once.

const OWNER = "12345678-1234-4234-8234-123456789abc";
const HASH = "a".repeat(64);
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64url(length: number, seed: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += BASE64URL[(seed * 31 + i * 7) % BASE64URL.length];
  return out;
}

/** A compact ES256 grant JWS of the size the shipping issuer produces (~1.5 KB). */
function compactJws(seed: number): string {
  return `${base64url(96, seed)}.${base64url(1280, seed + 1)}.${base64url(86, seed + 2)}`;
}

function deviceReceipt(n: number): OfflineDeviceReceipt {
  return {
    receiptId: `pro-receipt-${n}`,
    ownerId: OWNER,
    installationKeyId: "mobile-installation-key",
    grantId: "mobile-grant-1",
    grantJwsSha256: HASH,
    lifecycleSequence: n,
    ticket: null,
    operationId: `pro-operation-${n}`,
    resultId: `7100${String(n).padStart(4, "0")}-0404-4000-8000-000000000000`,
    fullOutputSha256: HASH,
    billingDisposition: "joint_verification_required",
    queuedAt: "2026-09-10T12:00:00.000Z",
  };
}

/** The rated-shot output the receipt carries (the `shot.sync` payload shape). */
function output(n: number): Record<string, unknown> {
  return {
    id: `7100${String(n).padStart(4, "0")}-0404-4000-8000-000000000000`,
    sessionId: "72000000-0404-4000-8000-000000000000",
    technique: "dink",
    capturedAt: "2026-09-10T11:59:00.000Z",
    resultKind: "scored",
    overallScore: 71.5,
    lowConfidence: false,
    source: { kind: "real", captureId: `73000000-0404-4000-8000-${String(n).padStart(12, "0")}` },
    timestamps: { startMs: 0, contactMs: 240, endMs: 600 },
    phases: [
      { name: "preparation", startMs: 0, endMs: 200, score: 70 },
      { name: "contact", startMs: 200, endMs: 300, score: 74 },
      { name: "follow_through", startMs: 300, endMs: 600, score: 70 },
    ],
    measurements: [
      { key: "paddle_angle_deg", value: 12.5 },
      { key: "knee_flex_deg", value: 31 },
      { key: "contact_height_cm", value: 78 },
    ],
    checkpoints: [
      { key: "ready_position", passed: true },
      { key: "soft_hands", passed: true },
      { key: "recovery", passed: false },
    ],
  };
}

interface Entry {
  readonly receipt: OfflineDeviceReceipt;
  readonly grant: { readonly schemaVersion: string; readonly compactJws: string };
  readonly output: Record<string, unknown> | null;
}

function entry(n: number): Entry {
  return {
    receipt: deviceReceipt(n),
    grant: { schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION, compactJws: compactJws(n) },
    output: output(n),
  };
}

const encoder = new TextEncoder();

/** The exact bytes the device puts on the wire for one request. */
function wireBytes(batch: readonly unknown[]): number {
  return encoder.encode(JSON.stringify({ receipts: batch })).length;
}

describe("planOfflineReceiptBatches", () => {
  it("publishes the route's caps and the coded refusal the app can act on", () => {
    expect(OFFLINE_RECEIPT_BATCH_MAX_BODY_BYTES).toBe(2_000_000);
    expect(OFFLINE_RECEIPT_BATCH_MAX_ENTRIES).toBe(250);
    expect(OFFLINE_RECEIPT_BATCH_TOO_LARGE_CODE).toBe("offline.batch_too_large");
    expect(OFFLINE_RECEIPT_BATCH_LIMITS).toEqual({
      maxBodyBytes: 2_000_000,
      maxEntries: 250,
    });
  });

  it("splits a queue whose one-POST body exceeds the byte cap into requests the route accepts, in order, every receipt exactly once", () => {
    const entryBytes = wireBytes([entry(1)]) - wireBytes([]) + 1;
    const count = Math.ceil(OFFLINE_RECEIPT_BATCH_MAX_BODY_BYTES / entryBytes) + 1;
    const queue = Array.from({ length: count }, (_, i) => entry(i + 1));
    expect(wireBytes(queue)).toBeGreaterThan(OFFLINE_RECEIPT_BATCH_MAX_BODY_BYTES);

    const plan = planOfflineReceiptBatches(queue);
    expect(plan.oversized).toEqual([]);
    expect(plan.batches.length).toBeGreaterThanOrEqual(2);
    for (const batch of plan.batches) {
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.length).toBeLessThanOrEqual(OFFLINE_RECEIPT_BATCH_MAX_ENTRIES);
      expect(wireBytes(batch)).toBeLessThanOrEqual(OFFLINE_RECEIPT_BATCH_MAX_BODY_BYTES);
    }
    // Queue order, nothing dropped, nothing duplicated — the same objects.
    const flat = plan.batches.flat();
    expect(flat.length).toBe(count);
    flat.forEach((item, i) => expect(item).toBe(queue[i]));
    // Every batch is full: the next queued receipt would not have fit.
    for (let i = 0; i + 1 < plan.batches.length; i += 1) {
      const batch = plan.batches[i];
      const next = plan.batches[i + 1][0];
      const wouldBe = wireBytes([...batch, next]);
      expect(
        wouldBe > OFFLINE_RECEIPT_BATCH_MAX_BODY_BYTES ||
          batch.length === OFFLINE_RECEIPT_BATCH_MAX_ENTRIES,
      ).toBe(true);
    }
  });

  it("never asks the route to decide more than its per-request budget", () => {
    const tiny = Array.from({ length: 2 * OFFLINE_RECEIPT_BATCH_MAX_ENTRIES + 7 }, (_, i) => ({
      receipt: deviceReceipt(i + 1),
      grant: { schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION, compactJws: "a.b.c" },
      output: null,
    }));
    const plan = planOfflineReceiptBatches(tiny);
    expect(plan.batches.map((batch) => batch.length)).toEqual([
      OFFLINE_RECEIPT_BATCH_MAX_ENTRIES,
      OFFLINE_RECEIPT_BATCH_MAX_ENTRIES,
      7,
    ]);
    expect(plan.oversized).toEqual([]);
    expect(plan.batches.flat()).toEqual(tiny);
  });

  it("sets aside a receipt that can never fit one request instead of dropping it or sending a request that is refused", () => {
    const huge: Entry = {
      ...entry(2),
      output: { ...output(2), notes: "x".repeat(OFFLINE_RECEIPT_BATCH_MAX_BODY_BYTES) },
    };
    const queue = [entry(1), huge, entry(3)];
    const plan = planOfflineReceiptBatches(queue);
    expect(plan.oversized).toEqual([huge]);
    expect(plan.batches).toEqual([[queue[0], queue[2]]]);
    // A receipt exactly at the cap still travels alone.
    const envelope = wireBytes([]);
    const filler = "y".repeat(OFFLINE_RECEIPT_BATCH_MAX_BODY_BYTES - envelope - 2);
    expect(wireBytes([filler])).toBe(OFFLINE_RECEIPT_BATCH_MAX_BODY_BYTES);
    const exact = planOfflineReceiptBatches([filler, "z"]);
    expect(exact.oversized).toEqual([]);
    expect(exact.batches).toEqual([[filler], ["z"]]);
    const over = planOfflineReceiptBatches([`${filler}!`]);
    expect(over.batches).toEqual([]);
    expect(over.oversized).toEqual([`${filler}!`]);
  });

  it("counts UTF-8 bytes on the wire, not string length", () => {
    const limits = { maxBodyBytes: 120, maxEntries: 250 };
    const paddle = "\u{1F3D3}".repeat(20); // 20 code points, 40 UTF-16 units, 80 UTF-8 bytes
    const accent = "\u00e9".repeat(30); // 30 units, 60 bytes
    const cjk = "\u6253".repeat(20); // 20 units, 60 bytes
    const items = [paddle, accent, cjk, paddle];
    for (const item of items) expect(wireBytes([item])).toBeLessThanOrEqual(limits.maxBodyBytes);
    const plan = planOfflineReceiptBatches(items, limits);
    expect(plan.oversized).toEqual([]);
    for (const batch of plan.batches) {
      expect(wireBytes(batch)).toBeLessThanOrEqual(limits.maxBodyBytes);
    }
    expect(plan.batches.flat()).toEqual(items);
    // Counting UTF-16 units would have packed accent+cjk (70 "bytes") into one
    // request; on the wire that pair is 140 B and every pair exceeds the cap.
    expect(plan.batches).toEqual([[paddle], [accent], [cjk], [paddle]]);
  });

  it("plans nothing for an empty queue and refuses nonsensical limits", () => {
    expect(planOfflineReceiptBatches([])).toEqual({ batches: [], oversized: [] });
    expect(() => planOfflineReceiptBatches([entry(1)], { maxBodyBytes: 0, maxEntries: 1 })).toThrow(
      RangeError,
    );
    expect(() => planOfflineReceiptBatches([entry(1)], { maxBodyBytes: 100, maxEntries: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      planOfflineReceiptBatches([entry(1)], { maxBodyBytes: Number.NaN, maxEntries: 1 }),
    ).toThrow(RangeError);
  });
});
