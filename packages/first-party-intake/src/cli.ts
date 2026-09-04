import { writeFileSync } from "node:fs";
import { intakeClip, type IntakeInput } from "./intake.js";

/**
 * First-party clip intake CLI (D2-12).
 *
 * Usage:
 *   pnpm --filter @pickle/first-party-intake intake -- \
 *     --clip <clip.mp4> --consent-ledger <ledger.json> \
 *     --subject <subjectPseudonym> --capture-meta <capture-meta.json> \
 *     --operator <operatorId> [--out <intake-record.json>] \
 *     [--signing-key <hmacKey>] [--min-max-seq <n>]
 *
 * `--signing-key` makes the host require export contract v2: unsigned (v1 or
 * bare-array) ledgers and bad signatures are REJECTED. `--min-max-seq` pins
 * the highest export maxSeq already accepted for the subject; exports behind
 * it are stale replays and are REJECTED.
 *
 * Exit codes: 0 = accepted (SUPPORTED or DEGRADED envelope, active consent),
 * 1 = rejected (including a ledger that fails verification), 2 = invalid
 * invocation (unknown/repeated/valueless flag) or unreadable inputs.
 */

const USAGE =
  "usage: intake --clip <clip.mp4> --consent-ledger <ledger.json> " +
  "--subject <subjectPseudonym> --capture-meta <capture-meta.json> " +
  "--operator <operatorId> [--out <intake-record.json>] " +
  "[--signing-key <hmacKey>] [--min-max-seq <n>]";

const KNOWN_FLAGS = new Set([
  "clip",
  "consent-ledger",
  "subject",
  "capture-meta",
  "operator",
  "out",
  "signing-key",
  "min-max-seq",
]);

type ParsedArgs = IntakeInput & { outPath: string | null };

type ParseResult = { ok: true; args: ParsedArgs } | { ok: false; error: string };

function parseArgs(argv: string[]): ParseResult {
  const values = new Map<string, string>();
  while (argv[0] === "--") argv = argv.slice(1);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    if (!flag.startsWith("--")) return { ok: false, error: `unexpected argument: ${flag}` };
    const name = flag.slice(2);
    if (!KNOWN_FLAGS.has(name)) return { ok: false, error: `unknown flag: ${flag}` };
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, error: `flag ${flag} requires a value` };
    }
    if (values.has(name)) return { ok: false, error: `flag ${flag} given more than once` };
    values.set(name, value);
  }
  const clip = values.get("clip");
  const ledger = values.get("consent-ledger");
  const subject = values.get("subject");
  const meta = values.get("capture-meta");
  const operator = values.get("operator");
  if (!clip || !ledger || !subject || !meta || !operator) {
    return { ok: false, error: "missing required flag(s)" };
  }
  const signingKey = values.get("signing-key");
  if (signingKey !== undefined && signingKey.length === 0) {
    return { ok: false, error: "--signing-key must not be empty" };
  }
  const minMaxSeqRaw = values.get("min-max-seq");
  let minMaxSeq: number | undefined;
  if (minMaxSeqRaw !== undefined) {
    if (!/^\d+$/.test(minMaxSeqRaw)) {
      return { ok: false, error: `--min-max-seq must be a non-negative integer: ${minMaxSeqRaw}` };
    }
    minMaxSeq = Number(minMaxSeqRaw);
    if (!Number.isSafeInteger(minMaxSeq)) {
      return { ok: false, error: `--min-max-seq is out of range: ${minMaxSeqRaw}` };
    }
  }
  const args: ParsedArgs = {
    clipPath: clip,
    consentLedgerPath: ledger,
    subjectPseudonym: subject,
    captureMetaPath: meta,
    operatorId: operator,
    outPath: values.get("out") ?? null,
  };
  if (signingKey !== undefined) args.consentSigningKey = signingKey;
  if (minMaxSeq !== undefined) args.consentMinMaxSeq = minMaxSeq;
  return { ok: true, args };
}

const argv = process.argv.slice(2);
if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
  console.log(USAGE);
  process.exit(0);
}
const parsed = parseArgs(argv);
if (!parsed.ok) {
  console.error(`intake: ${parsed.error}`);
  console.error(USAGE);
  process.exit(2);
}
const args = parsed.args;

try {
  const record = intakeClip(args);
  const serialized = JSON.stringify(record, null, 2);
  if (args.outPath !== null) {
    writeFileSync(args.outPath, `${serialized}\n`);
  }
  console.log(serialized);
  console.error(`intake status: ${record.status}`);
  for (const reason of record.reasons) console.error(`  - ${reason}`);
  process.exit(record.status === "REJECTED" ? 1 : 0);
} catch (error) {
  console.error(`intake failed: ${(error as Error).message}`);
  process.exit(2);
}
