import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checksumOf, loadMigrations, orderMigrations } from "../../src/migrate.js";
import { Rng, deriveSeed } from "./rng.js";

/**
 * Pure lens: seeded random action sequences over the filesystem-facing half of
 * the migration runner API (orderMigrations / checksumOf / loadMigrations),
 * model-checked after every step. No database. Invariants (from the
 * migrate.ts doc comment "ordered NNNN_name.sql files ... checksum
 * verification"):
 *
 *   P1  orderMigrations(names) == sorted(legal(names)) where legal is exactly
 *       /^\d{4}_[a-z0-9_]+\.sql$/; every output matches that regex.
 *   P2  orderMigrations is permutation-invariant and idempotent.
 *   P3  loadMigrations(dir) returns exactly orderMigrations(readdir(dir)), in
 *       order, with checksum == sha256(utf8 content) as 64 lowercase hex.
 *   P4  checksumOf is stable for equal input and distinct for the distinct
 *       contents generated in a sequence (content-sensitive incl. CRLF/BOM).
 *   P5  same seed => identical trace.
 */

export const LEGAL_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

export type PureActionKind =
  | "add_legal"
  | "add_near_legal"
  | "modify_content"
  | "delete_file"
  | "order_check"
  | "load_check"
  | "checksum_check";

export interface PureActionSpec {
  kind: PureActionKind;
  r: [number, number, number];
}

const PURE_WEIGHTS: ReadonlyArray<readonly [PureActionKind, number]> = [
  ["add_legal", 22],
  ["add_near_legal", 14],
  ["modify_content", 10],
  ["delete_file", 8],
  ["order_check", 18],
  ["load_check", 18],
  ["checksum_check", 10],
];

export function generatePureSequence(
  seed: number,
  minLen = 5,
  maxLen = 60,
): { length: number; actions: PureActionSpec[] } {
  const rng = new Rng(seed);
  const length = rng.int(minLen, maxLen);
  const actions: PureActionSpec[] = [];
  for (let i = 0; i < length; i++) {
    actions.push({
      kind: rng.weighted(PURE_WEIGHTS),
      r: [rng.next(), rng.next(), rng.next()],
    });
  }
  return { length, actions };
}

export interface PureFailure {
  step: number;
  kind: PureActionKind;
  invariant: string;
  detail: string;
}

export interface PureStep {
  i: number;
  kind: PureActionKind;
  outcome: Record<string, unknown>;
}

export interface PureSequenceResult {
  lens: "pure";
  seed: number;
  length: number;
  executedSteps: number;
  status: "HELD" | "BROKEN";
  failures: PureFailure[];
  observations: Record<string, number>;
  trace: PureStep[];
  durationMs: number;
}

function idx(r: number, n: number): number {
  return Math.min(n - 1, Math.floor(r * n));
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function nearLegalName(rng: Rng, n: number): string {
  const num = String(n).padStart(4, "0");
  const slug = rng.slug(1, 8);
  const variants: string[] = [
    `${num}_${slug.toUpperCase()}.sql`, // uppercase slug
    `${num}-${slug}.sql`, // dash separator
    `${num}_${slug}-x.sql`, // dash inside slug
    `${String(n).padStart(3, "0")}_${slug}.sql`, // 3-digit prefix
    `${String(n).padStart(5, "0")}_${slug}.sql`, // 5-digit prefix
    `${num}_${slug}.SQL`, // uppercase extension
    `${num}_${slug}.sql.bak`, // backup suffix
    `${num}${slug}.sql`, // missing underscore
    `${num}_.sql`, // empty slug
    `${num}_${slug}.sql~`, // editor temp
    `.${num}_${slug}.sql`, // hidden file
    `${num}_${slug} .sql`, // space
    `${num}_${slug}\u00e9.sql`, // non-ascii
    `${num}_${slug}.sqk`, // typo extension
    `${num}_${slug}.txt`,
  ];
  return rng.pick(variants);
}

function randomContent(rng: Rng, tag: string): string {
  const eol = rng.chance(0.2) ? "\r\n" : "\n";
  const bom = rng.chance(0.1) ? "\ufeff" : "";
  const lines = [
    `-- stress ${tag}`,
    `CREATE TABLE stress_${rng.slug(3, 10)} (id int${rng.chance(0.5) ? " PRIMARY KEY" : ""});`,
  ];
  if (rng.chance(0.3))
    lines.push(`COMMENT ON TABLE x IS '${rng.chance(0.5) ? "ünïcödé" : "plain"}';`);
  return bom + lines.join(eol) + (rng.chance(0.5) ? eol : "");
}

export async function runPureSequence(
  seed: number,
  actions?: PureActionSpec[],
): Promise<PureSequenceResult> {
  const started = Date.now();
  const spec = actions ?? generatePureSequence(seed).actions;
  const rng = new Rng(deriveSeed(seed, 7));
  const dir = await mkdtemp(join(tmpdir(), "pickle-stress-pure-"));
  const files = new Map<string, string>();
  const failures: PureFailure[] = [];
  const observations: Record<string, number> = {};
  const trace: PureStep[] = [];
  const observe = (k: string) => {
    observations[k] = (observations[k] ?? 0) + 1;
  };
  const fail = (step: number, kind: PureActionKind, invariant: string, detail: string) => {
    failures.push({ step, kind, invariant, detail });
  };

  const legalSorted = () => [...files.keys()].filter((n) => LEGAL_NAME.test(n)).sort();

  try {
    for (let i = 0; i < spec.length; i++) {
      const action = spec[i];
      if (!action) break;
      const outcome: Record<string, unknown> = {};
      const names = [...files.keys()];
      switch (action.kind) {
        case "add_legal": {
          const n = Math.floor(action.r[0] * 100);
          const name = `${String(n).padStart(4, "0")}_${rng.slug(1, 12)}.sql`;
          const content = randomContent(rng, `${seed}-${i}`);
          files.set(name, content);
          await writeFile(join(dir, name), content, "utf8");
          outcome["name"] = name;
          outcome["legal"] = LEGAL_NAME.test(name);
          if (!LEGAL_NAME.test(name)) fail(i, action.kind, "GEN", `generated illegal ${name}`);
          break;
        }
        case "add_near_legal": {
          const name = nearLegalName(rng, Math.floor(action.r[0] * 100));
          const content = randomContent(rng, `${seed}-${i}`);
          files.set(name, content);
          await writeFile(join(dir, name), content, "utf8");
          outcome["name"] = name;
          outcome["legal"] = LEGAL_NAME.test(name);
          if (!LEGAL_NAME.test(name)) observe("near_legal_name_ignored");
          break;
        }
        case "modify_content": {
          if (names.length === 0) {
            outcome["noop"] = true;
            break;
          }
          const name = names.sort()[idx(action.r[0], names.length)];
          if (!name) break;
          const before = files.get(name) ?? "";
          const content = before + `\n-- edit ${i}`;
          files.set(name, content);
          await writeFile(join(dir, name), content, "utf8");
          outcome["name"] = name;
          outcome["checksumChanged"] = checksumOf(before) !== checksumOf(content);
          if (checksumOf(before) === checksumOf(content))
            fail(i, action.kind, "P4", `checksum unchanged after edit of ${name}`);
          break;
        }
        case "delete_file": {
          if (names.length === 0) {
            outcome["noop"] = true;
            break;
          }
          const name = names.sort()[idx(action.r[0], names.length)];
          if (!name) break;
          files.delete(name);
          await unlink(join(dir, name));
          outcome["name"] = name;
          break;
        }
        case "order_check": {
          const expected = legalSorted();
          const out = orderMigrations(names);
          const shuffled = orderMigrations(rng.shuffle(names));
          const again = orderMigrations(out);
          outcome["n"] = names.length;
          outcome["legal"] = expected.length;
          if (JSON.stringify(out) !== JSON.stringify(expected))
            fail(
              i,
              action.kind,
              "P1",
              `got ${JSON.stringify(out)} want ${JSON.stringify(expected)}`,
            );
          if (JSON.stringify(shuffled) !== JSON.stringify(out))
            fail(i, action.kind, "P2", "not permutation-invariant");
          if (JSON.stringify(again) !== JSON.stringify(out))
            fail(i, action.kind, "P2", "not idempotent");
          for (const n of out)
            if (!LEGAL_NAME.test(n)) fail(i, action.kind, "P1", `illegal in output: ${n}`);
          break;
        }
        case "load_check": {
          const loaded = await loadMigrations(dir);
          const expected = orderMigrations(await readdir(dir));
          outcome["n"] = loaded.length;
          if (JSON.stringify(loaded.map((f) => f.name)) !== JSON.stringify(expected))
            fail(
              i,
              action.kind,
              "P3",
              `loaded ${JSON.stringify(loaded.map((f) => f.name))} want ${JSON.stringify(expected)}`,
            );
          if (JSON.stringify(expected) !== JSON.stringify(legalSorted()))
            fail(i, action.kind, "P3", "readdir/model divergence");
          const seen = new Map<string, string>();
          for (const f of loaded) {
            const content = files.get(f.name);
            if (content === undefined) {
              fail(i, action.kind, "P3", `loaded unknown ${f.name}`);
              continue;
            }
            if (f.sql !== content) fail(i, action.kind, "P3", `content mismatch ${f.name}`);
            if (!/^[0-9a-f]{64}$/.test(f.checksum))
              fail(i, action.kind, "P3", `checksum not 64 hex ${f.name}`);
            if (f.checksum !== sha256Hex(content))
              fail(i, action.kind, "P3", `checksum != sha256(content) ${f.name}`);
            const prev = seen.get(f.checksum);
            if (prev !== undefined && (files.get(prev) ?? "") !== content)
              fail(i, action.kind, "P4", `collision ${prev} / ${f.name}`);
            seen.set(f.checksum, f.name);
          }
          break;
        }
        case "checksum_check": {
          const base = randomContent(rng, `${seed}-${i}`);
          const a = checksumOf(base);
          const b = checksumOf(base);
          const crlf = checksumOf(base.replace(/\n/g, "\r\n"));
          const bom = checksumOf(`\ufeff${base}`);
          const trailing = checksumOf(`${base} `);
          outcome["stable"] = a === b;
          if (a !== b) fail(i, action.kind, "P4", "unstable checksum");
          if (base.includes("\n") && !base.includes("\r\n") && crlf === a)
            fail(i, action.kind, "P4", "CRLF not content-sensitive");
          if (!base.startsWith("\ufeff") && bom === a)
            fail(i, action.kind, "P4", "BOM not content-sensitive");
          if (trailing === a) fail(i, action.kind, "P4", "trailing space not content-sensitive");
          if (!/^[0-9a-f]{64}$/.test(a)) fail(i, action.kind, "P4", "not 64 lowercase hex");
          break;
        }
      }
      trace.push({ i, kind: action.kind, outcome });
      if (failures.length > 0) break;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return {
    lens: "pure",
    seed,
    length: spec.length,
    executedSteps: trace.length,
    status: failures.length === 0 ? "HELD" : "BROKEN",
    failures,
    observations,
    trace,
    durationMs: Date.now() - started,
  };
}

export function pureTraceKey(result: PureSequenceResult): string {
  return JSON.stringify({ t: result.trace, f: result.failures, o: result.observations });
}
