import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT, ResultTable } from "./support.js";

/**
 * Linux-plane static scan of the native unit's Swift sources (no toolchain
 * needed). Pins structural invariants that the static review relies on:
 *  - every NSLock `lock()` has a matching `unlock()` in the same file and
 *    every CVPixelBufferLockBaseAddress a matching Unlock;
 *  - no `try!` / `as!` force paths (a trap is never an acceptable failure
 *    mode in capture code);
 *  - every `@unchecked Sendable` class owns a lock or a serial queue;
 *  - the inventory of force unwraps, `try?` swallows, `Thread.sleep`s and
 *    `.sync` hops is written to JSON as review evidence (counts are
 *    reported, not pinned — production may legitimately change them).
 */

const SCAN_ROOTS = ["native/camera-engine/Sources", "native/swing-lab/Sources"];

function swiftFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...swiftFiles(full));
    else if (entry.endsWith(".swift")) out.push(full);
  }
  return out;
}

interface Occurrence {
  line: number;
  text: string;
}

interface FileInventory {
  file: string;
  lines: number;
  lockCalls: number;
  unlockCalls: number;
  pixelBufferLocks: number;
  pixelBufferUnlocks: number;
  forceTry: Occurrence[];
  forceCast: Occurrence[];
  forceUnwrap: Occurrence[];
  trySwallow: Occurrence[];
  threadSleep: Occurrence[];
  syncHops: Occurrence[];
  uncheckedSendable: Occurrence[];
  ownsLockOrSerialQueue: boolean;
}

function stripCommentsAndStrings(line: string): string {
  // Good enough for structural counting: drop // comments and string literals.
  const noComment = line.replace(/\/\/.*$/, "");
  return noComment.replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function occurrences(lines: string[], pattern: RegExp): Occurrence[] {
  const out: Occurrence[] = [];
  lines.forEach((raw, index) => {
    const code = stripCommentsAndStrings(raw);
    if (pattern.test(code)) out.push({ line: index + 1, text: raw.trim().slice(0, 140) });
  });
  return out;
}

function count(lines: string[], pattern: RegExp): number {
  return lines.reduce((total, raw) => {
    const code = stripCommentsAndStrings(raw);
    return total + (code.match(pattern)?.length ?? 0);
  }, 0);
}

function inventory(path: string): FileInventory {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const code = lines.map(stripCommentsAndStrings).join("\n");
  return {
    file: relative(REPO_ROOT, path),
    lines: lines.length,
    lockCalls: count(lines, /\b\w+Lock\.lock\(\)/g),
    unlockCalls: count(lines, /\b\w+Lock\.unlock\(\)/g),
    pixelBufferLocks: count(lines, /CVPixelBufferLockBaseAddress\(/g),
    pixelBufferUnlocks: count(lines, /CVPixelBufferUnlockBaseAddress\(/g),
    forceTry: occurrences(lines, /\btry!/),
    forceCast: occurrences(lines, /\bas!/),
    // identifier/call/subscript followed by `!` that is not `!=`; excludes prefix-! negation.
    forceUnwrap: occurrences(lines, /[\w)\]]!(?![=])/),
    trySwallow: occurrences(lines, /\btry\?/),
    threadSleep: occurrences(lines, /Thread\.sleep|usleep\(|sleep\(/),
    syncHops: occurrences(lines, /\.sync\s*[({]/),
    uncheckedSendable: occurrences(lines, /@unchecked Sendable/),
    ownsLockOrSerialQueue: /NSLock\(\)|DispatchQueue\(label:/.test(code),
  };
}

const files = SCAN_ROOTS.flatMap((root) => swiftFiles(join(REPO_ROOT, root)));
const inventories = files.map(inventory);
const table = new ResultTable("swift-static-scan");

afterAll(() => {
  const dir =
    process.env.STRESS_RESULTS_DIR ?? join(REPO_ROOT, "artifacts", "stress", "linux-harness");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "swift-static-inventory.json"),
    `${JSON.stringify({ plane: "linux", roots: SCAN_ROOTS, files: inventories }, null, 2)}\n`,
  );
  const path = table.flush();
  expect(table.brokenCount, `BROKEN rows in ${path}`).toBe(0);
});

describe("native unit Swift static scan", () => {
  it("scans the expected production files", () => {
    const names = inventories.map((entry) => entry.file);
    expect(names).toContain("native/camera-engine/Sources/CameraEngine.swift");
    expect(names).toContain("native/camera-engine/Sources/SessionCaptureCoordinator.swift");
    expect(names).toContain("native/swing-lab/Sources/main.swift");
  });

  it.each(inventories.map((entry) => [entry.file, entry] as const))(
    "%s: lock/unlock and CVPixelBuffer lock/unlock calls are balanced",
    (file, entry) => {
      const held =
        entry.lockCalls === entry.unlockCalls &&
        entry.pixelBufferLocks === entry.pixelBufferUnlocks;
      table.record(
        "lock_balance",
        file,
        held ? "HELD" : "BROKEN",
        `lock=${entry.lockCalls} unlock=${entry.unlockCalls} cvLock=${entry.pixelBufferLocks} cvUnlock=${entry.pixelBufferUnlocks}`,
      );
      expect(entry.lockCalls, `${file} NSLock.lock/unlock imbalance`).toBe(entry.unlockCalls);
      expect(entry.pixelBufferLocks, `${file} CVPixelBuffer lock/unlock imbalance`).toBe(
        entry.pixelBufferUnlocks,
      );
    },
  );

  it.each(inventories.map((entry) => [entry.file, entry] as const))(
    "%s: no try! / as! force paths",
    (file, entry) => {
      const held = entry.forceTry.length === 0 && entry.forceCast.length === 0;
      table.record(
        "no_force_paths",
        file,
        held ? "HELD" : "BROKEN",
        `try!=${entry.forceTry.map((o) => o.line).join(",")} as!=${entry.forceCast.map((o) => o.line).join(",")}`,
      );
      expect(entry.forceTry, `${file} try!`).toEqual([]);
      expect(entry.forceCast, `${file} as!`).toEqual([]);
    },
  );

  it.each(inventories.map((entry) => [entry.file, entry] as const))(
    "%s: every @unchecked Sendable type owns a lock or serial queue",
    (file, entry) => {
      const held = entry.uncheckedSendable.length === 0 || entry.ownsLockOrSerialQueue;
      table.record(
        "unchecked_sendable_guarded",
        file,
        held ? "HELD" : "BROKEN",
        `uncheckedSendable=${entry.uncheckedSendable.length} ownsLockOrQueue=${entry.ownsLockOrSerialQueue}`,
      );
      expect(held, `${file} declares @unchecked Sendable without NSLock/serial queue`).toBe(true);
    },
  );

  it("force unwraps in the unit are the known bounded set (inventory recorded)", () => {
    const all = inventories.flatMap((entry) =>
      entry.forceUnwrap.map((o) => `${entry.file}:${o.line} ${o.text}`),
    );
    table.record("force_unwrap_inventory", "static", "HELD", `count=${all.length}`);
    // Not pinned to a number: recorded for the review log. It must stay bounded
    // (a runaway count means force paths crept into capture code).
    expect(all.length).toBeLessThan(40);
  });
});
