const encoder = new TextEncoder();

/** Root eslint forbids console.log in *.ts; these CLIs' reports ARE their stdout. */
export function print(line: string): void {
  Deno.stdout.writeSync(encoder.encode(`${line}\n`));
}
