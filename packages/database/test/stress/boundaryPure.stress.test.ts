import { describe, expect, it } from "vitest";
import { checksumOf, orderMigrations } from "../../src/migrate.js";
import {
  CONTROL_STRINGS,
  KB64,
  MALFORMED_JSON_TEXT,
  NUMERIC_EDGE_TEXT,
  PATH_TRAVERSAL,
  PROTO_KEYS,
  Reporter,
  Rng,
  UNICODE_PAIRS,
  campaignSeeds,
  describeInput,
  formatAnomalies,
  graphemeBomb,
  hostileString,
  iterations,
  trimMessage,
} from "./harness.js";

/**
 * LENS boundary-malformed / campaign "pure": the two pure functions the
 * migration runner is built on must never throw and must never let a hostile
 * directory entry (path traversal, null bytes, unicode look-alikes,
 * prototype keys, oversized names) through to `readFile`/`client.query`.
 *
 * Default 600 iterations (fast); STRESS_ITER scales it (x5 in this campaign).
 */

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

function hostileMigrationName(rng: Rng): string {
  const digits = () => String(rng.int(0, 9999)).padStart(4, "0");
  const variants: Array<() => string> = [
    () => `${digits()}_ok_${rng.hex(4)}.sql`,
    () => `${digits()}_${rng.pick(PATH_TRAVERSAL)}.sql`,
    () => `${rng.pick(PATH_TRAVERSAL)}/${digits()}_x.sql`,
    () => `${digits()}_x.sql/../${digits()}_y.sql`,
    () => `${digits()}_x\u0000.sql`,
    () => `${digits()}_x.sql\u0000`,
    () => `\u0000${digits()}_x.sql`,
    () => `${digits()}_${rng.pick(PROTO_KEYS)}.sql`,
    () => rng.pick(PROTO_KEYS),
    () => `${digits()}_x.SQL`,
    () => `${digits()}_X.sql`,
    () => `${digits()}_x.sql.bak`,
    () => `${digits()}_x.sql~`,
    () => `.${digits()}_x.sql`,
    () => `${digits()}_x.sql `,
    () => ` ${digits()}_x.sql`,
    () => `${digits()}_x .sql`,
    () => `${digits()}-x.sql`,
    () => `${digits()}x.sql`,
    () => `${digits()}_.sql`,
    () => `_x.sql`,
    () => `${String(rng.int(0, 99999)).padStart(5, "0")}_x.sql`,
    () => `${String(rng.int(0, 999)).padStart(3, "0")}_x.sql`,
    () => `9999_future_schema_${rng.hex(3)}.sql`,
    () => `０００１_fullwidth.sql`,
    () => `${digits()}_${rng.pick(UNICODE_PAIRS)[1]}.sql`,
    () => `${digits()}_${rng.pick(UNICODE_PAIRS)[2]}.sql`,
    () => `${digits()}_${rng.pick(CONTROL_STRINGS)}.sql`,
    () => `${digits()}_${rng.pick(NUMERIC_EDGE_TEXT)}.sql`,
    () => `${digits()}_${"a".repeat(KB64)}.sql`,
    () => `${digits()}_${graphemeBomb(100)}.sql`,
    () => `${digits()}_x.sql\n0000_y.sql`,
    () => rng.pick(MALFORMED_JSON_TEXT),
    () => "",
    () => ".",
    () => "..",
    () => "0000_x.sql".normalize("NFD"),
    () => `${digits()}_${rng.pick(["é", "ß", "ø", "ı", "İ"])}.sql`,
    () => `${digits()}_x.sql${rng.pick(["\r", "\t", "\u2028"])}`,
    () => hostileString(rng),
  ];
  return rng.pick(variants)();
}

describe("stress/boundary-malformed: orderMigrations + checksumOf (pure)", () => {
  const total = iterations(600, 5);

  it(`never throws and never admits a hostile name (${total} generated directories)`, () => {
    const reporter = new Reporter("pure-orderMigrations", { iterations: total });
    let admittedDangerous = 0;
    let oversizeNamesAdmitted = 0;

    for (const [index, seed] of campaignSeeds("pure", total).entries()) {
      const rng = new Rng(seed);
      const names = Array.from({ length: rng.int(0, 12) }, () => hostileMigrationName(rng));
      const namesBefore = JSON.stringify(names);
      const started = performance.now();
      try {
        const ordered = orderMigrations(names);
        const again = orderMigrations(orderMigrations(names));
        const shuffled = orderMigrations(rng.shuffle(names));
        const problems: string[] = [];

        // Output is a subset of the input, strictly sorted, idempotent and
        // permutation-invariant.
        for (const name of ordered) {
          if (!names.includes(name)) problems.push(`not-from-input:${describeInput(name)}`);
          if (!MIGRATION_NAME.test(name)) problems.push(`regex-miss:${describeInput(name)}`);
          if (/[/\\\s]|\.\./.test(name) || name.includes("\0") || name !== name.normalize("NFC")) {
            problems.push(`dangerous:${describeInput(name)}`);
            admittedDangerous++;
          }
          // Observation only: the regex has no length cap, but `readdir` can
          // never hand back a >255-byte entry (ENAMETOOLONG on every FS).
          if (Buffer.byteLength(name, "utf8") > 255) oversizeNamesAdmitted++;
        }
        for (let i = 1; i < ordered.length; i++) {
          if ((ordered[i - 1] as string) > (ordered[i] as string)) problems.push("unsorted");
        }
        if (JSON.stringify(again) !== JSON.stringify(ordered)) problems.push("not-idempotent");
        if (JSON.stringify(shuffled) !== JSON.stringify(ordered)) {
          problems.push("order-depends-on-input-order");
        }
        // Every valid name must survive the filter (no false rejections).
        for (const name of names) {
          if (MIGRATION_NAME.test(name) && !ordered.includes(name)) {
            problems.push(`dropped-valid:${describeInput(name)}`);
          }
        }
        // The function must not have mutated its input array.
        if (JSON.stringify(names) !== namesBefore) problems.push("input-mutated");

        reporter.add({
          seed,
          index,
          kind: "orderMigrations",
          input: describeInput(names),
          outcome: problems.length === 0 ? "ACCEPTED" : "ANOMALY_PROPERTY",
          note: problems.length ? problems.join(";") : `kept ${ordered.length}/${names.length}`,
          durationMs: performance.now() - started,
        });
      } catch (error) {
        reporter.add({
          seed,
          index,
          kind: "orderMigrations",
          input: describeInput(names),
          outcome: "ANOMALY_UNTYPED",
          message: trimMessage(String(error)),
          durationMs: performance.now() - started,
        });
      }
    }

    const path = reporter.write();
    console.warn(`[stress] pure-orderMigrations: ${JSON.stringify(reporter.summary())} → ${path}`);
    console.warn(`[stress] oversize (>255B) names admitted by regex: ${oversizeNamesAdmitted}`);
    expect(reporter.rows.length).toBe(total);
    expect(admittedDangerous).toBe(0);
    expect(formatAnomalies(reporter)).toBe("");
  });

  it(`checksumOf is total, deterministic and content-sensitive (${total} inputs)`, () => {
    const reporter = new Reporter("pure-checksumOf", { iterations: total });
    const seen = new Map<string, string>();
    let lossyUtf8Collisions = 0;

    for (const [index, seed] of campaignSeeds("pure-checksum", total).entries()) {
      const rng = new Rng(seed);
      const sql = hostileString(rng);
      const started = performance.now();
      try {
        const a = checksumOf(sql);
        const b = checksumOf(sql);
        const problems: string[] = [];
        if (!/^[0-9a-f]{64}$/.test(a)) problems.push(`shape:${a.slice(0, 20)}`);
        if (a !== b) problems.push("nondeterministic");
        const prior = seen.get(a);
        if (prior !== undefined && prior !== sql) {
          // Distinct JS strings whose UTF-8 encodings coincide (lone surrogates
          // all encode to U+FFFD) legitimately share a checksum; anything else
          // would be a SHA-256 collision.
          if (Buffer.from(prior, "utf8").equals(Buffer.from(sql, "utf8"))) {
            lossyUtf8Collisions++;
          } else {
            problems.push("collision");
          }
        }
        seen.set(a, sql);
        // A single-byte change anywhere must change the checksum.
        if (sql.length > 0) {
          const cut = rng.int(0, sql.length - 1);
          const mutated = sql.slice(0, cut) + (sql[cut] === "x" ? "y" : "x") + sql.slice(cut + 1);
          if (mutated !== sql && checksumOf(mutated) === a) problems.push("insensitive");
        }
        // Unicode normalisation pairs must NOT collide — a migration edited
        // to a look-alike form is still a modification.
        const pair = rng.pick(UNICODE_PAIRS);
        if (checksumOf(pair[1]) === checksumOf(pair[2]))
          problems.push(`nfc-nfd-collide:${pair[0]}`);
        reporter.add({
          seed,
          index,
          kind: "checksumOf",
          input: describeInput(sql),
          outcome: problems.length === 0 ? "ACCEPTED" : "ANOMALY_PROPERTY",
          ...(problems.length ? { note: problems.join(";") } : {}),
          durationMs: performance.now() - started,
        });
      } catch (error) {
        reporter.add({
          seed,
          index,
          kind: "checksumOf",
          input: describeInput(sql),
          outcome: "ANOMALY_UNTYPED",
          message: trimMessage(String(error)),
          durationMs: performance.now() - started,
        });
      }
    }

    const path = reporter.write();
    console.warn(`[stress] pure-checksumOf: ${JSON.stringify(reporter.summary())} → ${path}`);
    console.warn(
      `[stress] lone-surrogate (lossy UTF-8) checksum collisions: ${lossyUtf8Collisions}`,
    );
    expect(reporter.rows.length).toBe(total);
    expect(formatAnomalies(reporter)).toBe("");
  });
});
