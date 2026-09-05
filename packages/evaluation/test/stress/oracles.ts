/**
 * Invariant checks shared by every stress surface. Each returns `null` when the
 * invariant holds and a short human-readable reason otherwise.
 */

/** Global objects a hostile record key can reach through inherited lookups. */
const GLOBAL_PROTOTYPES: ReadonlyArray<readonly [string, object]> = [
  ["Object.prototype", Object.prototype],
  ["Array.prototype", Array.prototype],
  ["Function.prototype", Function.prototype],
  ["String.prototype", String.prototype],
  ["Number.prototype", Number.prototype],
  ["Object", Object],
  ["Object.prototype.toString", Object.prototype.toString],
  ["Object.prototype.valueOf", Object.prototype.valueOf],
  ["Object.prototype.hasOwnProperty", Object.prototype.hasOwnProperty],
  ["Object.prototype.isPrototypeOf", Object.prototype.isPrototypeOf],
  ["Object.prototype.propertyIsEnumerable", Object.prototype.propertyIsEnumerable],
  ["Object.prototype.toLocaleString", Object.prototype.toLocaleString],
];

export interface PrototypeSnapshot {
  names: ReadonlyArray<readonly [string, string[]]>;
}

export function snapshotPrototypes(): PrototypeSnapshot {
  return {
    names: GLOBAL_PROTOTYPES.map(
      ([label, proto]) => [label, Reflect.ownKeys(proto).map(String).sort()] as const,
    ),
  };
}

/** Prototype pollution oracle: the global prototypes must be byte-identical to the snapshot. */
export function prototypesUnchanged(snapshot: PrototypeSnapshot): string | null {
  const now = snapshotPrototypes();
  for (let index = 0; index < now.names.length; index += 1) {
    const [label, keys] = now.names[index]!;
    const before = snapshot.names[index]![1];
    const added = keys.filter((key) => !before.includes(key));
    const removed = before.filter((key) => !keys.includes(key));
    if (added.length > 0 || removed.length > 0) {
      return `${label} polluted: +[${added.join(",")}] -[${removed.join(",")}]`;
    }
  }
  const probe: Record<string, unknown> = {};
  for (const key in probe) return `fresh object inherits enumerable key ${key}`;
  return null;
}

/** Removes any pollution left behind so one BROKEN iteration cannot poison the next. */
export function restorePrototypes(snapshot: PrototypeSnapshot): void {
  const now = snapshotPrototypes();
  for (let index = 0; index < now.names.length; index += 1) {
    const [, keys] = now.names[index]!;
    const before = snapshot.names[index]![1];
    const proto = GLOBAL_PROTOTYPES[index]![1];
    for (const key of keys) {
      if (!before.includes(key)) Reflect.deleteProperty(proto, key);
    }
  }
}

/** Children of a JSON-ish node, with their path suffixes. */
function children(value: unknown, path: string): Array<[unknown, string]> {
  if (Array.isArray(value)) return value.map((item, index) => [item, `${path}[${index}]`]);
  if (typeof value === "object" && value !== null) {
    return Object.keys(value).map((key) => [
      (value as Record<string, unknown>)[key],
      `${path}.${key}`,
    ]);
  }
  return [];
}

/** Walks a value (iteratively — payloads may be 50k levels deep); returns the first NaN / ±Infinity path, or null. */
export function findNonFinite(value: unknown, path = "$"): string | null {
  const stack: Array<[unknown, string]> = [[value, path]];
  while (stack.length > 0) {
    const [node, at] = stack.pop()!;
    if (typeof node === "number" && !Number.isFinite(node)) return `${at}=${String(node)}`;
    const next = children(node, at);
    for (let index = next.length - 1; index >= 0; index -= 1) stack.push(next[index]!);
  }
  return null;
}

/**
 * Structural equality with `===` number semantics (so -0 equals 0, as JSON
 * round-trips do) over OWN enumerable keys — an own `__proto__` key counts.
 */
export function deepEqual(a: unknown, b: unknown, path = "$"): string | null {
  const stack: Array<[unknown, unknown, string]> = [[a, b, path]];
  while (stack.length > 0) {
    const [left, right, at] = stack.pop()!;
    if (left === right) continue;
    if (
      typeof left === "number" &&
      typeof right === "number" &&
      Number.isNaN(left) &&
      Number.isNaN(right)
    )
      continue;
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right)) return `${at}: array vs non-array`;
      if (left.length !== right.length) return `${at}: length ${left.length} vs ${right.length}`;
      for (let index = left.length - 1; index >= 0; index -= 1)
        stack.push([left[index], right[index], `${at}[${index}]`]);
      continue;
    }
    if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
      const keysA = Object.keys(left).sort();
      const keysB = Object.keys(right).sort();
      if (keysA.join("\u0000") !== keysB.join("\u0000")) {
        return `${at}: keys [${keysA.join(",")}] vs [${keysB.join(",")}]`;
      }
      for (let index = keysA.length - 1; index >= 0; index -= 1) {
        const key = keysA[index]!;
        stack.push([
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
          `${at}.${key}`,
        ]);
      }
      continue;
    }
    return `${at}: ${describeScalar(left)} vs ${describeScalar(right)}`;
  }
  return null;
}

function describeScalar(value: unknown): string {
  if (typeof value === "string")
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return "[function]";
  if (typeof value === "object" && value !== null)
    return `[${value.constructor?.name ?? "object"}]`;
  return String(value);
}

/** Every nested plain object must have Object.prototype as its prototype. */
export function allPlainObjects(value: unknown, path = "$"): string | null {
  const stack: Array<[unknown, string]> = [[value, path]];
  while (stack.length > 0) {
    const [node, at] = stack.pop()!;
    if (typeof node === "object" && node !== null && !Array.isArray(node)) {
      const proto: unknown = Object.getPrototypeOf(node);
      if (proto !== Object.prototype)
        return `${at}: prototype is ${proto === null ? "null" : "not Object.prototype"}`;
    }
    const next = children(node, at);
    for (let index = next.length - 1; index >= 0; index -= 1) stack.push(next[index]!);
  }
  return null;
}

export function looksLikeStackTrace(text: string): boolean {
  return /^\s+at\s+\S+/m.test(text);
}

export interface TypedFailureShape {
  kind: string;
  code: string;
  message: string;
}

/** A `Result` failure from @pickle/shared-types must be fully typed and non-empty. */
export function typedFailure(value: unknown): TypedFailureShape | string {
  if (typeof value !== "object" || value === null) return "failure is not an object";
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string" || record.kind.length === 0) return "failure.kind missing";
  if (typeof record.code !== "string" || record.code.length === 0) return "failure.code missing";
  if (typeof record.message !== "string" || record.message.length === 0)
    return "failure.message missing";
  if (typeof record.retryable !== "boolean") return "failure.retryable missing";
  return { kind: record.kind, code: record.code, message: record.message };
}

export function errorSummary(error: unknown): string {
  if (error instanceof Error) return `${error.constructor.name}: ${error.message.slice(0, 160)}`;
  return `non-Error throw: ${String(error).slice(0, 160)}`;
}
