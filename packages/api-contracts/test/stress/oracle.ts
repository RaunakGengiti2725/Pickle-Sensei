/**
 * Independent acceptance oracle for a single-slot mutation of a valid
 * payload, derived from the JSON Schema that `z.toJSONSchema` emits for the
 * contract (the same document the OpenAPI export publishes). The oracle is
 * deliberately simple; where it cannot decide it says so, and the harness
 * records a note instead of asserting.
 */
import { z } from "zod";

export type Verdict = "accept" | "reject" | "undecided";

type JsonSchema = Record<string, unknown>;

function asSchema(value: unknown): JsonSchema | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonSchema)
    : null;
}

export function schemaOf(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as JsonSchema;
}

/** Split an `anyOf` with a `{type:"null"}` branch into (base, nullable). */
function unwrapNullable(node: JsonSchema): { base: JsonSchema; nullable: boolean } {
  const anyOf = node["anyOf"];
  if (Array.isArray(anyOf)) {
    const branches = anyOf.map(asSchema).filter((b): b is JsonSchema => b !== null);
    const nullBranch = branches.find((b) => b["type"] === "null");
    const others = branches.filter((b) => b["type"] !== "null");
    if (nullBranch !== undefined && others.length === 1) {
      return { base: others[0] as JsonSchema, nullable: true };
    }
  }
  return { base: node, nullable: false };
}

/** Sub-schema at `path` (object keys / array indices) plus whether the leaf key is required. */
export function locate(
  root: JsonSchema,
  path: readonly string[],
): { node: JsonSchema; required: boolean } | null {
  let node = root;
  let required = true;
  for (const segment of path) {
    const { base } = unwrapNullable(node);
    if (base["type"] === "array") {
      const items = asSchema(base["items"]);
      if (items === null) return null;
      node = items;
      required = true;
      continue;
    }
    const properties = asSchema(base["properties"]);
    if (properties === null) return null;
    let next = asSchema(properties[segment]);
    if (next === null) {
      // `.loose()` objects publish `additionalProperties: {}` — any value passes.
      const additional = asSchema(base["additionalProperties"]);
      if (additional === null) return null;
      next = additional;
    }
    const req = base["required"];
    required = Array.isArray(req) && req.includes(segment);
    node = next;
  }
  return { node, required };
}

const regexCache = new Map<string, RegExp>();
function matches(pattern: string, value: string): boolean {
  let re = regexCache.get(pattern);
  if (re === undefined) {
    re = new RegExp(pattern, "u");
    regexCache.set(pattern, re);
  }
  return re.test(value);
}

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** Expected verdict for replacing the slot described by `node` with `value`. */
export function expectedVerdict(node: JsonSchema, required: boolean, value: unknown): Verdict {
  if (value === undefined) return required ? "reject" : "accept";
  const { base, nullable } = unwrapNullable(node);
  if (Object.keys(base).length === 0) return "accept"; // unconstrained slot
  if (value === null) return nullable ? "accept" : "reject";
  const type = base["type"];
  switch (typeof value) {
    case "string": {
      if (type !== "string") return "reject";
      if ("const" in base) return base["const"] === value ? "accept" : "reject";
      const enumValues = base["enum"];
      if (Array.isArray(enumValues)) return enumValues.includes(value) ? "accept" : "reject";
      const minLength = num(base["minLength"]);
      const maxLength = num(base["maxLength"]);
      if (minLength !== null && value.length < minLength) return "reject";
      if (maxLength !== null && value.length > maxLength) return "reject";
      const pattern = base["pattern"];
      if (typeof pattern === "string") return matches(pattern, value) ? "accept" : "reject";
      if (typeof base["format"] === "string") return "undecided";
      return "accept";
    }
    case "number": {
      if (type !== "number" && type !== "integer") return "reject";
      if (!Number.isFinite(value)) return "reject";
      if (type === "integer" && !Number.isSafeInteger(value)) return "reject";
      const minimum = num(base["minimum"]);
      const maximum = num(base["maximum"]);
      const exclusiveMinimum = num(base["exclusiveMinimum"]);
      const exclusiveMaximum = num(base["exclusiveMaximum"]);
      if (minimum !== null && value < minimum) return "reject";
      if (maximum !== null && value > maximum) return "reject";
      if (exclusiveMinimum !== null && value <= exclusiveMinimum) return "reject";
      if (exclusiveMaximum !== null && value >= exclusiveMaximum) return "reject";
      return "accept";
    }
    case "boolean":
      return type === "boolean" ? "accept" : "reject";
    case "bigint":
    case "symbol":
    case "function":
      return "reject";
    case "object": {
      if (Array.isArray(value)) {
        if (type !== "array") return "reject";
        const minItems = num(base["minItems"]);
        if (value.length === 0) return minItems !== null && minItems > 0 ? "reject" : "accept";
        // Non-empty hostile arrays only ever carry `[]` items here.
        const items = asSchema(base["items"]);
        if (items === null) return "undecided";
        return expectedVerdict(items, true, value[0]);
      }
      if (value instanceof Date) return "reject";
      if (type !== "object") return "reject";
      const required = base["required"];
      const ownKeys = Object.keys(value as object);
      if (
        Array.isArray(required) &&
        required.some((key) => typeof key === "string" && !ownKeys.includes(key))
      ) {
        return "reject";
      }
      return "undecided";
    }
    default:
      return "undecided";
  }
}

/** Enumerate every leaf path in a payload (object keys and array indices). */
export function leafPaths(value: unknown, prefix: readonly string[] = []): string[][] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => leafPaths(item, [...prefix, String(index)]));
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [prefix.slice()];
    return entries.flatMap(([key, child]) => leafPaths(child, [...prefix, key]));
  }
  return [prefix.slice()];
}

/** Every object path in a payload (for key-level mutations). */
export function objectPaths(value: unknown, prefix: readonly string[] = []): string[][] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => objectPaths(item, [...prefix, String(index)]));
  }
  if (typeof value === "object" && value !== null && !(value instanceof Date)) {
    const own = [prefix.slice()];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      own.push(...objectPaths(child, [...prefix, key]));
    }
    return own;
  }
  return [];
}
