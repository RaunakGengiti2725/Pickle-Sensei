// Shared output helpers for the adversarial harnesses: results go to stdout
// (the repo's root lint reserves console.log for CLIs it enumerates) and the
// JSON table goes to `--out <path>` / the per-harness default.

const encoder = new TextEncoder();

export function println(line: string): void {
  Deno.stdout.writeSync(encoder.encode(`${line}\n`));
}

export function outPath(defaultPath: string): string {
  const i = Deno.args.indexOf("--out");
  return i >= 0 ? Deno.args[i + 1] : defaultPath;
}

export async function writeReport(path: string, report: unknown): Promise<void> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, `${JSON.stringify(report, null, 2)}\n`);
  println(`wrote ${path}`);
}
