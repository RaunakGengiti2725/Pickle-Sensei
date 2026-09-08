// Minimal assertions on top of node:assert so the attack suite adds no lockfile
// entries (the root deno.lock is frozen).

import { deepStrictEqual, notDeepStrictEqual, ok } from "node:assert/strict";

export function assert(condition: unknown, message: string): asserts condition {
  ok(condition, message);
}

export function assertEquals<T>(actual: T, expected: T, message: string): void {
  deepStrictEqual(actual, expected, message);
}

export function assertNotEquals<T>(actual: T, expected: T, message: string): void {
  notDeepStrictEqual(actual, expected, message);
}
