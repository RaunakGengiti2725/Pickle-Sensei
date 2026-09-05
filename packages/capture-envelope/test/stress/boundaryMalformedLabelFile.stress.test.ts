import { afterAll, describe, expect, it } from "vitest";
import {
  G08_BYPASS_FAMILIES,
  G08_CAPTURE_LABELS,
  G08_DOWNSTREAM_OUTCOMES,
  G08_LABEL_SCHEMA_VERSION,
  validateG08LabelFile,
  type G08ValidationResult,
} from "../../src/g08LabelSchema.js";
import { referenceValidate, type ReferenceDeviation } from "./boundaryMalformedReference.js";
import {
  boundaryString,
  describeValue,
  FUTURE_SCHEMA_VERSIONS,
  isPrototypeClean,
  PATH_TRAVERSALS,
  ResultTable,
  SeededRng,
  stableJson,
  STRESS_ITER,
  STRESS_OUT,
  STRESS_SEED,
  UNICODE_PAIRS,
  validLabelFile,
  withPollutionKeys,
  writeTable,
} from "./boundaryMalformedSupport.js";

/**
 * boundary-malformed stress — `validateG08LabelFile(data: unknown)`, the one
 * untrusted-input parser in this package (g08EvalGate.ts feeds it
 * `JSON.parse(readFileSync(...))`). Two generators:
 *   json      — mutations that a JSON document can carry (wrong types, missing
 *               keys, future schema versions, 64KB+/NUL/unicode strings, path
 *               traversal, 1e400 → Infinity, -0, empty arrays/objects,
 *               duplicate/NFC-vs-NFD ids, supersede self/cycle/dangling, holes
 *               closed after truncation);
 *   non-json  — values only an in-process caller can pass (bigint, NaN,
 *               undefined, functions, symbols, cycles, throwing toJSON,
 *               null-prototype objects, sparse arrays, typed arrays, Dates).
 */

const RECORD_FIELDS = [
  "labelId",
  "candidateId",
  "clip",
  "windowMs",
  "sessionKey",
  "family",
  "capture",
  "downstream",
  "annotatorKind",
  "annotator",
  "labeledAtIso",
  "notes",
  "supersedesLabelId",
] as const;

const BAD_ISO = [
  "",
  " ",
  "not-a-date",
  "2026-13-45T00:00:00Z",
  "2026-02-30",
  "0000-00-00T00:00:00Z",
  "2026-08-29T00:00:00+99:00",
  "9999999999999",
  "1e400",
  "2026-08-29T00:00:00Z\u0000",
  "\u0000",
  "２０２６-08-29",
  "2026-08-29T25:61:61Z",
  "Sat Sep 05 2026",
  "2026-08-29T00:00:00.000000000000000000Z",
] as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function jsonWrongType(rng: SeededRng): Json {
  switch (rng.int(9)) {
    case 0:
      return null;
    case 1:
      return rng.int(1000);
    case 2:
      return -0;
    case 3:
      return true;
    case 4:
      return [];
    case 5:
      return {};
    case 6:
      return [rng.int(10)];
    case 7:
      return { nested: rng.int(10) };
    default:
      return Number.POSITIVE_INFINITY;
  }
}

function asMutable(file: ReturnType<typeof validLabelFile>): Record<string, unknown> {
  return { ...file, labels: file.labels.map((label) => ({ ...label })) };
}

interface Mutation {
  name: string;
  apply: (rng: SeededRng, file: Record<string, unknown>) => void;
}

function records(file: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(file.labels) ? (file.labels as Array<Record<string, unknown>>) : [];
}

function pickRecord(rng: SeededRng, file: Record<string, unknown>): Record<string, unknown> | null {
  const list = records(file).filter(
    (r) => typeof r === "object" && r !== null && !Array.isArray(r),
  );
  return list.length > 0 ? rng.pick(list) : null;
}

const JSON_MUTATIONS: Mutation[] = [
  {
    name: "schema.future",
    apply: (rng, f) => void (f.schemaVersion = rng.pick(FUTURE_SCHEMA_VERSIONS)),
  },
  { name: "schema.wrongType", apply: (rng, f) => void (f.schemaVersion = jsonWrongType(rng)) },
  { name: "schema.missing", apply: (_rng, f) => void delete f.schemaVersion },
  { name: "provenance.empty", apply: (_rng, f) => void (f.provenance = "") },
  {
    name: "provenance.boundaryString",
    apply: (rng, f) => void (f.provenance = boundaryString(rng)),
  },
  { name: "provenance.wrongType", apply: (rng, f) => void (f.provenance = jsonWrongType(rng)) },
  { name: "labels.wrongType", apply: (rng, f) => void (f.labels = jsonWrongType(rng)) },
  { name: "labels.missing", apply: (_rng, f) => void delete f.labels },
  { name: "labels.empty", apply: (_rng, f) => void (f.labels = []) },
  {
    name: "labels.nonObjectEntry",
    apply: (rng, f) => {
      const list = records(f);
      list.splice(rng.int(list.length + 1), 0, jsonWrongType(rng) as Record<string, unknown>);
    },
  },
  {
    name: "labels.arrayEntry",
    apply: (rng, f) => {
      const list = records(f);
      const victim = pickRecord(rng, f);
      list.push((victim ? [victim] : []) as unknown as Record<string, unknown>);
    },
  },
  {
    name: "record.fieldWrongType",
    apply: (rng, f) => {
      const r = pickRecord(rng, f);
      if (r) r[rng.pick(RECORD_FIELDS)] = jsonWrongType(rng);
    },
  },
  {
    name: "record.fieldMissing",
    apply: (rng, f) => {
      const r = pickRecord(rng, f);
      if (r) delete r[rng.pick(RECORD_FIELDS)];
    },
  },
  {
    name: "record.fieldBoundaryString",
    apply: (rng, f) => {
      const r = pickRecord(rng, f);
      if (r) r[rng.pick(RECORD_FIELDS)] = boundaryString(rng);
    },
  },
  {
    name: "record.clipTraversal",
    apply: (rng, f) => {
      const r = pickRecord(rng, f);
      if (r) r.clip = rng.pick(PATH_TRAVERSALS);
    },
  },
  {
    name: "record.idTraversal",
    apply: (rng, f) => {
      const r = pickRecord(rng, f);
      if (r)
        r[rng.pick(["labelId", "sessionKey", "candidateId"] as const)] = rng.pick(PATH_TRAVERSALS);
    },
  },
  {
    name: "record.windowBoundary",
    apply: (rng, f) => {
      const r = pickRecord(rng, f);
      if (!r) return;
      const palette = [
        0,
        -0,
        -1,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.MIN_VALUE,
        Number.MAX_SAFE_INTEGER + 2,
        1e308,
      ];
      r.windowMs = rng.bool(0.2)
        ? jsonWrongType(rng)
        : { startMs: rng.pick(palette), durationMs: rng.pick(palette) };
    },
  },
  {
    name: "record.windowExtraOrMissingKeys",
    apply: (rng, f) => {
      const r = pickRecord(rng, f);
      if (!r) return;
      r.windowMs = rng.bool() ? { startMs: 0 } : { startMs: 0, durationMs: 1000, endMs: 5 };
    },
  },
  {
    name: "record.enumNearMiss",
    apply: (rng, f) => {
      const r = pickRecord(rng, f);
      if (!r) return;
      const field = rng.pick(["family", "capture", "downstream", "annotatorKind"] as const);
      const canonical =
        field === "family"
          ? rng.pick(G08_BYPASS_FAMILIES)
          : field === "capture"
            ? rng.pick(G08_CAPTURE_LABELS)
            : field === "downstream"
              ? rng.pick(G08_DOWNSTREAM_OUTCOMES)
              : "human";
      const variants = [
        canonical.toLowerCase(),
        canonical.toUpperCase(),
        `${canonical} `,
        ` ${canonical}`,
        `${canonical}\u0000`,
        canonical.normalize("NFD"),
        `${canonical}\u200d`,
        "machine",
        "Human",
        "",
      ];
      r[field] = rng.pick(variants);
    },
  },
  {
    name: "record.badIso",
    apply: (rng, f) => {
      const r = pickRecord(rng, f);
      if (r) r.labeledAtIso = rng.pick(BAD_ISO);
    },
  },
  {
    name: "record.notesEmptyForUnsafe",
    apply: (rng, f) => {
      const r = pickRecord(rng, f);
      if (!r) return;
      r.capture = rng.pick(["UNSAFE", "AMBIGUOUS"]);
      r.notes = rng.pick(["", " ", "\t\n", "\u00a0", "\u200b", "\ufeff"]);
    },
  },
  {
    name: "record.duplicateId",
    apply: (rng, f) => {
      const list = records(f);
      const victim = pickRecord(rng, f);
      if (victim) list.push({ ...victim });
    },
  },
  {
    name: "record.unicodePairIds",
    apply: (rng, f) => {
      const list = records(f);
      const victim = pickRecord(rng, f);
      if (!victim) return;
      const pair = rng.pick(UNICODE_PAIRS);
      victim.labelId = `id-${pair[0]}`;
      list.push({ ...victim, labelId: `id-${pair[1]}` });
    },
  },
  {
    name: "record.supersedeSelf",
    apply: (rng, f) => {
      const r = pickRecord(rng, f);
      if (r && typeof r.labelId === "string") r.supersedesLabelId = r.labelId;
    },
  },
  {
    name: "record.supersedeCycle",
    apply: (rng, f) => {
      const list = records(f).filter((r) => typeof r.labelId === "string");
      if (list.length < 2) return;
      const a = rng.pick(list);
      const b = rng.pick(list.filter((r) => r !== a));
      a.supersedesLabelId = b.labelId;
      b.supersedesLabelId = a.labelId;
    },
  },
  {
    name: "record.supersedeDangling",
    apply: (rng, f) => {
      const r = pickRecord(rng, f);
      if (r) r.supersedesLabelId = `missing-${rng.int(1000)}`;
    },
  },
  {
    name: "record.supersedeValid",
    apply: (rng, f) => {
      const list = records(f).filter((r) => typeof r.labelId === "string");
      if (list.length < 2) return;
      const a = rng.pick(list);
      const b = rng.pick(list.filter((r) => r !== a));
      a.supersedesLabelId = b.labelId;
    },
  },
  {
    name: "record.pollutionKeys",
    apply: (rng, f) => {
      const list = records(f);
      const index = list.findIndex((r) => typeof r === "object" && r !== null && !Array.isArray(r));
      if (index >= 0) list[index] = withPollutionKeys(rng, list[index]!);
    },
  },
  { name: "root.pollutionKeys", apply: (rng, f) => Object.assign(f, withPollutionKeys(rng, {})) },
  {
    name: "record.extraKeys",
    apply: (rng, f) => {
      const r = pickRecord(rng, f);
      if (r) r[`extra_${rng.int(100)}`] = jsonWrongType(rng);
    },
  },
];

/** Truncate the JSON text at a random point, then close it so JSON.parse accepts it. */
function truncatedAndClosed(rng: SeededRng, file: Record<string, unknown>): unknown | undefined {
  const text = JSON.stringify(file);
  const cut = rng.intBetween(1, Math.max(1, text.length - 1));
  const head = text.slice(0, cut);
  const closers = ['"', '"}', '"}]}', "}", "}]}", "]}", '"]}', "0}]}", '":0}]}', "null}", "[]}"];
  for (const closer of closers) {
    try {
      return JSON.parse(head + closer) as unknown;
    } catch {
      continue;
    }
  }
  return undefined;
}

function nonJsonValue(rng: SeededRng): unknown {
  switch (rng.int(14)) {
    case 0:
      return BigInt(rng.int(1000));
    case 1:
      return Number.NaN;
    case 2:
      return undefined;
    case 3:
      return () => "x";
    case 4:
      return Symbol("s");
    case 5: {
      const cyclic: Record<string, unknown> = { a: 1 };
      cyclic.self = cyclic;
      return cyclic;
    }
    case 6:
      return {
        toJSON() {
          throw new Error("toJSON boom");
        },
      };
    case 7:
      return Object.create(null) as Record<string, unknown>;
    case 8:
      return new Array(rng.intBetween(1, 5));
    case 9:
      return new Uint8Array([1, 2, 3]);
    case 10:
      return new Date(Number.NaN);
    case 11:
      return new Map([["k", 1]]);
    case 12:
      return Object.assign(Object.create(null) as Record<string, unknown>, { length: 1, 0: "x" });
    default:
      return new Set(["human"]);
  }
}

interface RunOutcome {
  result?: G08ValidationResult;
  error?: unknown;
  repeatable: boolean;
}

function runValidator(data: unknown): RunOutcome {
  let first: RunOutcome;
  try {
    first = { result: validateG08LabelFile(data), repeatable: true };
  } catch (error) {
    first = { error, repeatable: true };
  }
  let second: string;
  try {
    second = stableJson(validateG08LabelFile(data));
  } catch (error) {
    second = `threw:${describeValue(error)}`;
  }
  const firstKey = first.result ? stableJson(first.result) : `threw:${describeValue(first.error)}`;
  first.repeatable = firstKey === second;
  return first;
}

/** Contract invariants that must hold for every non-throwing result. */
function resultProblems(data: unknown, result: G08ValidationResult): string[] {
  const problems: string[] = [];
  if (result.valid !== (result.errors.length === 0)) problems.push("valid ≠ errors.length===0");
  if (!Array.isArray(result.effective)) problems.push("effective not an array");
  if (!result.errors.every((e) => typeof e === "string" && e.length > 0))
    problems.push("blank error");
  const labelCount =
    typeof data === "object" &&
    data !== null &&
    Array.isArray((data as { labels?: unknown }).labels)
      ? (data as { labels: unknown[] }).labels.length
      : 0;
  if (result.effective.length > labelCount) problems.push("effective longer than labels");
  if (result.valid) {
    const ids = result.effective.map((r) => r.labelId);
    if (new Set(ids).size !== ids.length) problems.push("duplicate effective ids in a valid file");
    if (!result.effective.every((r) => r.annotatorKind === "human"))
      problems.push("non-human label effective");
  }
  if (!isPrototypeClean()) problems.push("Object.prototype polluted");
  return problems;
}

const table = new ResultTable();
const deviationSeeds: Record<ReferenceDeviation, number[]> = {
  "window-nonfinite": [],
  "clip-not-repo-relative": [],
  "supersede-self-or-cycle": [],
};
const schemaVersionThrowSeeds: number[] = [];

afterAll(() => {
  writeTable(STRESS_OUT, "labelfile", table);
  process.stderr.write(
    `[stress labelfile] executed=${table.rows.length} broken=${table.broken().length} byKind=${JSON.stringify(table.countByKind())}\n`,
  );
});

describe("boundary-malformed stress: validateG08LabelFile (JSON-reachable inputs)", () => {
  it(`mutated label files × ${STRESS_ITER} seeds: never throw, valid⇔no errors, human-only effective, deterministic, reference agreement`, () => {
    const failures: string[] = [];
    for (let i = 0; i < STRESS_ITER; i += 1) {
      const seed = STRESS_SEED + 10_000_000 + i;
      const rng = new SeededRng(seed);
      const file = asMutable(validLabelFile(rng, rng.int(6)));
      const applied: string[] = [];
      let data: unknown = file;
      if (rng.bool(0.12)) {
        const truncated = truncatedAndClosed(rng, file);
        applied.push("truncate+close");
        if (truncated === undefined) {
          table.record({
            seed,
            generator: "labelfile.json",
            kind: "truncated-json-unparseable",
            outcome: "HELD",
            detail: "JSON.parse rejected every closer",
          });
          continue;
        }
        data = truncated;
      } else if (rng.bool(0.05)) {
        data = jsonWrongType(rng);
        applied.push("root.wrongType");
      } else {
        const count = rng.intBetween(0, 4);
        for (let k = 0; k < count; k += 1) {
          const mutation = rng.pick(JSON_MUTATIONS);
          mutation.apply(rng, file);
          applied.push(mutation.name);
        }
      }
      const run = runValidator(data);
      const label = applied.length > 0 ? applied.join("+") : "valid";
      if (run.error !== undefined) {
        failures.push(`seed ${seed} [${label}]: threw ${describeValue(run.error)}`);
        table.record({
          seed,
          generator: "labelfile.json",
          kind: "throw",
          outcome: "BROKEN",
          detail: `${label}: ${describeValue(run.error)}`,
        });
        continue;
      }
      const result = run.result!;
      const problems = resultProblems(data, result);
      if (!run.repeatable) problems.push("non-deterministic");
      const reference = referenceValidate(data);
      if (reference.lenientValid !== result.valid) {
        problems.push(
          `lenient reference says valid=${reference.lenientValid}, implementation valid=${result.valid} errors=${describeValue(result.errors)}`,
        );
      } else if (
        result.valid &&
        stableJson(reference.effectiveIds) !== stableJson(result.effective.map((r) => r.labelId))
      ) {
        problems.push(
          `effective ids ${describeValue(result.effective.map((r) => r.labelId))} vs reference ${describeValue(reference.effectiveIds)}`,
        );
      }
      if (result.valid && reference.strictOnly.length > 0) {
        for (const deviation of reference.strictOnly) deviationSeeds[deviation].push(seed);
        table.record({
          seed,
          generator: "labelfile.json",
          kind: `accepted:${reference.strictOnly.join("+")}`,
          outcome: "BROKEN",
          detail: `${label}: accepted with effective=${result.effective.length}`,
        });
      }
      if (problems.length > 0) {
        failures.push(`seed ${seed} [${label}]: ${problems.join("; ")}`);
        table.record({
          seed,
          generator: "labelfile.json",
          kind: "invariant",
          outcome: "BROKEN",
          detail: `${label}: ${problems.join("; ")}`,
        });
      } else {
        table.record({
          seed,
          generator: "labelfile.json",
          kind: "invariants",
          outcome: "HELD",
          detail: `${label}: valid=${result.valid} errors=${result.errors.length} effective=${result.effective.length}`,
        });
      }
    }
    expect(failures).toEqual([]);
  });

  it("a JSON `1e400` literal reaches the validator as Infinity (the boundary the pinned deviation relies on)", () => {
    const parsed = JSON.parse('{"startMs":1e400,"durationMs":-0}') as {
      startMs: number;
      durationMs: number;
    };
    expect(parsed.startMs).toBe(Number.POSITIVE_INFINITY);
    expect(Object.is(parsed.durationMs, -0)).toBe(true);
  });

  it.fails(
    "PINNED DEVIATION: non-finite windowMs (JSON 1e400) should be rejected at validation, not handed to ffmpeg",
    () => {
      const rng = new SeededRng(STRESS_SEED);
      const file = asMutable(validLabelFile(rng, 1));
      records(file)[0]!.windowMs = { startMs: 0, durationMs: Number.POSITIVE_INFINITY };
      expect(validateG08LabelFile(file).valid).toBe(false);
      expect(deviationSeeds["window-nonfinite"]).toEqual([]);
    },
  );

  it.fails(
    "PINNED DEVIATION: `clip` documented as repo-relative should reject absolute paths, `..` segments and NUL bytes",
    () => {
      const rng = new SeededRng(STRESS_SEED);
      const file = asMutable(validLabelFile(rng, 1));
      records(file)[0]!.clip = "../../../etc/passwd";
      expect(validateG08LabelFile(file).valid).toBe(false);
      expect(deviationSeeds["clip-not-repo-relative"]).toEqual([]);
    },
  );

  it.fails(
    "PINNED DEVIATION: a record superseding itself (or a cycle) should be an error, not a silently vanished human label",
    () => {
      const rng = new SeededRng(STRESS_SEED);
      const file = asMutable(validLabelFile(rng, 1));
      const only = records(file)[0]!;
      only.supersedesLabelId = only.labelId;
      const result = validateG08LabelFile(file);
      expect(result.valid && result.effective.length === 0).toBe(false);
      expect(deviationSeeds["supersede-self-or-cycle"]).toEqual([]);
    },
  );
});

describe("boundary-malformed stress: validateG08LabelFile (in-process-only values)", () => {
  it(`bigint/NaN/undefined/function/symbol/cycle/toJSON/null-proto/sparse × ${STRESS_ITER} seeds: only the schemaVersion serializer can throw`, () => {
    const failures: string[] = [];
    for (let i = 0; i < STRESS_ITER; i += 1) {
      const seed = STRESS_SEED + 20_000_000 + i;
      const rng = new SeededRng(seed);
      const file = asMutable(validLabelFile(rng, rng.intBetween(0, 3)));
      const applied: string[] = [];
      let data: unknown = file;
      const mode = rng.int(6);
      if (mode === 0) {
        data = nonJsonValue(rng);
        applied.push("root.nonJson");
      } else if (mode === 1) {
        file.schemaVersion = nonJsonValue(rng);
        applied.push("schema.nonJson");
      } else if (mode === 2) {
        file.labels = nonJsonValue(rng);
        applied.push("labels.nonJson");
      } else if (mode === 3) {
        const list = records(file);
        list.splice(rng.int(list.length + 1), 0, nonJsonValue(rng) as Record<string, unknown>);
        applied.push("labels.nonJsonEntry");
      } else {
        const r = pickRecord(rng, file);
        if (r) {
          const field = rng.pick(RECORD_FIELDS);
          r[field] = nonJsonValue(rng);
          applied.push(`record.${field}.nonJson`);
        }
        if (rng.bool(0.5)) {
          const r2 = pickRecord(rng, file);
          if (r2) {
            r2.windowMs = {
              startMs: rng.pick([Number.NaN, -0, 0]),
              durationMs: rng.pick([Number.NaN, Number.POSITIVE_INFINITY, 1]),
            };
            applied.push("record.windowMs.nan");
          }
        }
      }
      const label = applied.join("+") || "valid";
      const run = runValidator(data);
      if (run.error !== undefined) {
        const schemaSerializerThrow =
          run.error instanceof Error &&
          (run.error.message.includes("BigInt") ||
            run.error.message.includes("circular") ||
            run.error.message.includes("toJSON boom") ||
            run.error.message.includes("Symbol"));
        const message = describeValue(run.error instanceof Error ? run.error.message : run.error);
        if (schemaSerializerThrow) {
          schemaVersionThrowSeeds.push(seed);
          table.record({
            seed,
            generator: "labelfile.non-json",
            kind: "schemaVersion-serializer-throw",
            outcome: "BROKEN",
            detail: `${label}: ${message}`,
          });
        } else {
          failures.push(`seed ${seed} [${label}]: threw ${message}`);
          table.record({
            seed,
            generator: "labelfile.non-json",
            kind: "throw",
            outcome: "BROKEN",
            detail: `${label}: ${message}`,
          });
        }
        continue;
      }
      const result = run.result!;
      const problems = resultProblems(data, result);
      if (!run.repeatable) problems.push("non-deterministic");
      if (problems.length > 0) {
        failures.push(`seed ${seed} [${label}]: ${problems.join("; ")}`);
        table.record({
          seed,
          generator: "labelfile.non-json",
          kind: "invariant",
          outcome: "BROKEN",
          detail: `${label}: ${problems.join("; ")}`,
        });
      } else {
        table.record({
          seed,
          generator: "labelfile.non-json",
          kind: "invariants",
          outcome: "HELD",
          detail: `${label}: valid=${result.valid} errors=${result.errors.length}`,
        });
      }
    }
    expect(failures).toEqual([]);
  });

  it.fails(
    "PINNED DEVIATION: a non-serializable schemaVersion should yield a typed validation error, not escape as TypeError",
    () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      let threw = false;
      try {
        validateG08LabelFile({ schemaVersion: cyclic, provenance: "p", labels: [] });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(schemaVersionThrowSeeds).toEqual([]);
    },
  );

  it("the committed (empty) label file remains the only accepted real fixture shape", () => {
    expect(
      validateG08LabelFile({ schemaVersion: G08_LABEL_SCHEMA_VERSION, provenance: "x", labels: [] })
        .valid,
    ).toBe(true);
  });
});
