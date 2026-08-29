import { writeFileSync } from "node:fs";
import { intakeClip, type IntakeInput } from "./intake.js";

/**
 * First-party clip intake CLI (D2-12).
 *
 * Usage:
 *   pnpm --filter @pickle/first-party-intake intake -- \
 *     --clip <clip.mp4> --consent-ledger <ledger.json> \
 *     --subject <subjectPseudonym> --capture-meta <capture-meta.json> \
 *     --operator <operatorId> [--out <intake-record.json>]
 *
 * Exit codes: 0 = accepted (SUPPORTED or DEGRADED envelope, active consent),
 * 1 = rejected, 2 = invalid invocation or malformed inputs.
 */

const USAGE =
  "usage: intake --clip <clip.mp4> --consent-ledger <ledger.json> " +
  "--subject <subjectPseudonym> --capture-meta <capture-meta.json> " +
  "--operator <operatorId> [--out <intake-record.json>]";

function parseArgs(argv: string[]): (IntakeInput & { outPath: string | null }) | null {
  const values = new Map<string, string>();
  while (argv[0] === "--") argv = argv.slice(1);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) return null;
    values.set(flag.slice(2), value);
  }
  const clip = values.get("clip");
  const ledger = values.get("consent-ledger");
  const subject = values.get("subject");
  const meta = values.get("capture-meta");
  const operator = values.get("operator");
  if (!clip || !ledger || !subject || !meta || !operator) return null;
  return {
    clipPath: clip,
    consentLedgerPath: ledger,
    subjectPseudonym: subject,
    captureMetaPath: meta,
    operatorId: operator,
    outPath: values.get("out") ?? null,
  };
}

const args = parseArgs(process.argv.slice(2));
if (args === null) {
  console.error(USAGE);
  process.exit(2);
}

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
