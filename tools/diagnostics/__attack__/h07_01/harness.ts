// Shared helpers for the H07-01 adversarial tests. Every attack drives the real
// candidate script (tools/diagnostics/edge_cold_start.ts at the attacked sha)
// either in-process (exported helpers) or as a subprocess (`deno run -A`).
// Nothing here touches the hosted Supabase project; the subprocess attacks that
// need Docker use only the local `pickle-sensei` stack.

import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const CANDIDATE_SCRIPT = join(REPO_ROOT, "tools", "diagnostics", "edge_cold_start.ts");

const decoder = new TextDecoder();

export interface Exec {
  code: number;
  stdout: string;
  stderr: string;
}

export async function exec(
  cmd: string,
  args: readonly string[],
  init: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Exec> {
  const output = await new Deno.Command(cmd, {
    args: [...args],
    cwd: init.cwd,
    env: init.env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

export async function execOk(
  cmd: string,
  args: readonly string[],
  init: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Exec> {
  const result = await exec(cmd, args, init);
  if (result.code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${result.code}\n${result.stderr}`);
  }
  return result;
}

/** A fresh scratch directory under the OS temp dir (removed by the caller). */
export async function scratchDir(label: string): Promise<string> {
  return await Deno.makeTempDir({ prefix: `h07-attack-${label}-` });
}

/**
 * The minimum checkout the candidate needs: root deno.json/deno.lock, the edge
 * function, shared-types, supabase/config.toml + the tracked cli-latest marker and
 * the candidate script itself (so `import.meta.url` resolves repoRoot to the
 * copy). The copy gets its own git history so `git rev-parse HEAD` succeeds.
 */
export async function makeRepoCopy(dest: string): Promise<void> {
  const paths = [
    "deno.json",
    "deno.lock",
    "package.json",
    "supabase/config.toml",
    "supabase/.temp/cli-latest",
    "supabase/functions/api",
    "packages/shared-types/src",
    "tools/diagnostics/edge_cold_start.ts",
  ];
  for (const rel of paths) {
    await Deno.mkdir(join(dest, dirname(rel)), { recursive: true });
    await execOk("cp", ["-R", join(REPO_ROOT, rel), join(dest, rel)]);
  }
  await execOk("git", ["init", "-q"], { cwd: dest });
  await execOk("git", ["add", "-A"], { cwd: dest });
  await execOk(
    "git",
    ["-c", "user.email=attack@example.invalid", "-c", "user.name=attack", "commit", "-qm", "base"],
    { cwd: dest },
  );
}

/** Write executable shell shims into `dir` (prepend `dir` to PATH to use them). */
export async function writeShims(dir: string, shims: Record<string, string>): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(shims)) {
    const path = join(dir, name);
    await Deno.writeTextFile(path, `#!/bin/sh\n${body}\n`);
    await Deno.chmod(path, 0o755);
  }
}

export function pathWith(prefix: string): string {
  return `${prefix}:${Deno.env.get("PATH") ?? ""}`;
}

/** Run the candidate script (of the given checkout) to completion. */
export async function runCandidate(
  repoRoot: string,
  args: readonly string[],
  init: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Exec> {
  return await exec(
    Deno.execPath(),
    ["run", "-A", join(repoRoot, "tools", "diagnostics", "edge_cold_start.ts"), ...args],
    init,
  );
}

export interface ReportShape {
  status: string;
  error: string | null;
  gitHead: string | null;
  ok: boolean;
  options: { cycles: number; warmRequests: number; outDir: string | null };
  environment: { stack: string | null };
  bundle: {
    sha256: string;
    rawBytes: number;
    pathNormalization: { rewrites: number; unresolved: number };
  } | null;
  serve: Array<{
    target: string;
    status: string;
    reason: string | null;
    cycles: Array<{ cycle: number }>;
  }>;
}

export async function readReport(outDir: string): Promise<ReportShape> {
  return JSON.parse(await Deno.readTextFile(join(outDir, "report.json"))) as ReportShape;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

export function lockPath(projectId: string): string {
  return join(tmpdir(), `edge-cold-start-${projectId}.lock`);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Processes whose command line contains `functions serve` (any owner). */
export async function serveProcesses(): Promise<string[]> {
  const ps = await exec("ps", ["-axo", "pid=,args="]);
  return ps.stdout
    .split("\n")
    .filter((line) => /\bfunctions\s+serve\b/.test(line) && !/ps -axo/.test(line));
}

export async function dockerNames(): Promise<Set<string>> {
  const result = await exec("docker", ["ps", "-a", "--format", "{{.Names}}"]);
  return new Set(result.stdout.split("\n").filter((name) => name.length > 0));
}
