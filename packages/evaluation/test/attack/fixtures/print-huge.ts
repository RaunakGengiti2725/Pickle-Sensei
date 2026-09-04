/**
 * Attack fixture: print `argv[2]` MiB (default 65) of text to stdout (or to
 * stderr when `argv[3] === "stderr"`), then exit 0. Used to drive
 * `runSubprocess()` past its 64 MiB `maxBuffer`.
 *
 * Writes honour back-pressure: the parent pipe is non-blocking and a naive
 * `writeSync` loop dies with EAGAIN after the first 64 KiB.
 */
import { once } from "node:events";

const mib = Number(process.argv[2] ?? "65");
const stream = process.argv[3] === "stderr" ? process.stderr : process.stdout;
const chunk = Buffer.alloc(1024 * 1024, stream === process.stderr ? "w" : "x");

async function main(): Promise<void> {
  for (let written = 0; written < mib; written += 1) {
    if (!stream.write(chunk)) await once(stream, "drain");
  }
  if (!stream.write("\n")) await once(stream, "drain");
}

await main();
