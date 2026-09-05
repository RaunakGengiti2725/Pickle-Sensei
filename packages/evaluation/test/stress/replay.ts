import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIteration } from "./campaign.js";

/**
 * Replay one or more campaign seeds and print their records.
 *
 *   pnpm --filter @pickle/evaluation exec tsx test/stress/replay.ts 17 18 19
 *   pnpm --filter @pickle/evaluation exec tsx test/stress/replay.ts --repeat 10 17
 */
async function main(argv: string[]): Promise<number> {
  let repeat = 1;
  const seeds: number[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--repeat") {
      repeat = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    const seed = Number.parseInt(arg, 10);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      console.error(`invalid seed "${arg}" (need an integer in [0, 2^32))`);
      return 2;
    }
    seeds.push(seed);
  }
  if (seeds.length === 0 || !Number.isInteger(repeat) || repeat < 1) {
    console.error("usage: replay.ts [--repeat N] <seed> [<seed> ...]");
    return 2;
  }
  const scratchDir = mkdtempSync(join(tmpdir(), "pickle-eval-stress-replay-"));
  let broken = 0;
  try {
    for (const seed of seeds) {
      const verdicts: string[] = [];
      for (let run = 0; run < repeat; run += 1) {
        const record = await runIteration(seed, scratchDir, true);
        verdicts.push(record.verdict);
        if (run === 0) console.log(JSON.stringify(record, null, 2));
        if (record.verdict === "BROKEN") broken += 1;
      }
      if (repeat > 1) {
        const rate = verdicts.filter((verdict) => verdict === "BROKEN").length;
        console.log(`seed ${seed}: BROKEN ${rate}/${repeat}`);
      }
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
  return broken > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 2;
  },
);
