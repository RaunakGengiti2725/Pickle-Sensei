import { readFileSync, writeFileSync } from "node:fs";
import { intakeClip, type IntakeInput } from "./intake.js";

/**
 * First-party clip intake CLI (D2-12).
 *
 * Usage:
 *   pnpm --filter @pickle/first-party-intake intake -- \
 *     --clip <clip.mp4> --consent-ledger <ledger.json> \
 *     --subject <subjectPseudonym> --capture-meta <capture-meta.json> \
 *     --operator <operatorId> [--out <intake-record.json>] \
 *     [--signing-key <key> | --signing-key-file <path>] [--min-max-seq <n>]
 *
 * Exit codes: 0 = accepted (SUPPORTED or DEGRADED envelope, active consent),
 * 1 = rejected (consent not established — including a ledger that fails
 * signature/watermark verification — or UNSUPPORTED envelope),
 * 2 = invalid invocation or malformed inputs. Every flag must be one of the
 * documented ones: a misspelled `--signing-key` must never be ignored.
 */

const REQUIRED_FLAGS = ["clip", "consent-ledger", "subject", "capture-meta", "operator"] as const;
const OPTIONAL_FLAGS = ["out", "signing-key", "signing-key-file", "min-max-seq"] as const;
const KNOWN_FLAGS: ReadonlySet<string> = new Set<string>([...REQUIRED_FLAGS, ...OPTIONAL_FLAGS]);

const USAGE = [
  "usage: intake --clip <clip.mp4> --consent-ledger <ledger.json> " +
    "--subject <subjectPseudonym> --capture-meta <capture-meta.json> " +
    "--operator <operatorId> [--out <intake-record.json>]",
  "              [--signing-key <key> | --signing-key-file <path>] [--min-max-seq <n>]",
  "",
  "  --signing-key / --signing-key-file  consent export contract v2 HMAC key; when",
  "                                      set, unsigned or badly signed exports are",
  "                                      REJECTED (prefer --signing-key-file: argv is",
  "                                      visible to other processes and shell history)",
  "  --min-max-seq <n>                   ledger watermark: the highest export maxSeq",
  "                                      already accepted for this subject; exports",
  "                                      behind it are stale replays and are REJECTED",
  "",
  "exit codes: 0 accepted, 1 rejected, 2 invalid invocation or malformed inputs",
].join("\n");

type ParsedArgs = { input: IntakeInput; outPath: string | null };
type ParseResult =
  { kind: "run"; args: ParsedArgs } | { kind: "help" } | { kind: "error"; problem: string };

function parseArgs(argv: string[]): ParseResult {
  while (argv[0] === "--") argv = argv.slice(1);
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { kind: "help" };

  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index]!;
    if (!token.startsWith("--")) return { kind: "error", problem: `unexpected argument ${token}` };
    const name = token.slice(2);
    if (!KNOWN_FLAGS.has(name)) return { kind: "error", problem: `unknown flag --${name}` };
    if (values.has(name)) return { kind: "error", problem: `flag --${name} given more than once` };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { kind: "error", problem: `flag --${name} requires a value` };
    }
    values.set(name, value);
  }

  const missing = REQUIRED_FLAGS.filter((flag) => !values.has(flag));
  if (missing.length > 0) {
    return {
      kind: "error",
      problem: `missing required flag(s): ${missing.map((f) => `--${f}`).join(", ")}`,
    };
  }

  const input: IntakeInput = {
    clipPath: values.get("clip")!,
    consentLedgerPath: values.get("consent-ledger")!,
    subjectPseudonym: values.get("subject")!,
    captureMetaPath: values.get("capture-meta")!,
    operatorId: values.get("operator")!,
  };

  const inlineKey = values.get("signing-key");
  const keyFile = values.get("signing-key-file");
  if (inlineKey !== undefined && keyFile !== undefined) {
    return {
      kind: "error",
      problem: "--signing-key and --signing-key-file are mutually exclusive",
    };
  }
  if (inlineKey !== undefined) {
    if (inlineKey.length === 0)
      return { kind: "error", problem: "--signing-key must not be empty" };
    input.consentSigningKey = inlineKey;
  } else if (keyFile !== undefined) {
    let fileKey: string;
    try {
      fileKey = readFileSync(keyFile, "utf8").replace(/\r?\n$/, "");
    } catch (error) {
      return {
        kind: "error",
        problem: `--signing-key-file ${keyFile} is unreadable: ${(error as Error).message}`,
      };
    }
    if (fileKey.length === 0) {
      return { kind: "error", problem: `--signing-key-file ${keyFile} is empty` };
    }
    input.consentSigningKey = fileKey;
  }

  const minMaxSeq = values.get("min-max-seq");
  if (minMaxSeq !== undefined) {
    if (!/^\d+$/.test(minMaxSeq) || !Number.isSafeInteger(Number(minMaxSeq))) {
      return {
        kind: "error",
        problem: `--min-max-seq must be a non-negative integer, got ${JSON.stringify(minMaxSeq)}`,
      };
    }
    input.consentMinMaxSeq = Number(minMaxSeq);
  }

  return { kind: "run", args: { input, outPath: values.get("out") ?? null } };
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.kind === "help") {
  console.log(USAGE);
  process.exit(0);
}
if (parsed.kind === "error") {
  console.error(`intake: ${parsed.problem}`);
  console.error(USAGE);
  process.exit(2);
}

try {
  const record = intakeClip(parsed.args.input);
  const serialized = JSON.stringify(record, null, 2);
  if (parsed.args.outPath !== null) {
    writeFileSync(parsed.args.outPath, `${serialized}\n`);
  }
  console.log(serialized);
  console.error(`intake status: ${record.status}`);
  for (const reason of record.reasons) console.error(`  - ${reason}`);
  process.exit(record.status === "REJECTED" ? 1 : 0);
} catch (error) {
  console.error(`intake failed: ${(error as Error).message}`);
  process.exit(2);
}
