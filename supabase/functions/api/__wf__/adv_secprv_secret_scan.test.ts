// INT-security-privacy adversary — the repository's own secret-scanning gate
// must be green at the integration head, and no tracked file may carry an
// inline `<SECRET_ENV_NAME>=<value>` assignment for the env names the Edge
// function and its harnesses read.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json adv_secprv_secret_scan.test.ts
//
// The first test shells out to scripts/security-scan.sh exactly as
// scripts/verify-cloud.sh (CI `security` stage) does. gitleaks v8.30.1 is
// resolved from the pinned cache/download by the script itself; a setup
// failure (exit 2) is reported as a failure here, never as a pass.

import { assert, assertEquals } from "@std/assert";

const REPO_ROOT = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");

async function run(cmd: string[], cwd: string): Promise<{ code: number; out: string }> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const decoder = new TextDecoder();
  return { code, out: decoder.decode(stdout) + decoder.decode(stderr) };
}

// Redact anything after an `=` in the scanner's own output before it can
// land in a test log (gitleaks already redacts, this is belt and braces).
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const redact = (text: string): string =>
  text.replace(/([A-Z0-9_]{6,}=)[^\s"']{4,}/g, "$1<redacted>").replace(ANSI_ESCAPE, "");

Deno.test("scripts/security-scan.sh --tree is clean at HEAD (CI security stage)", async () => {
  const { code, out } = await run(["scripts/security-scan.sh", "--tree"], REPO_ROOT);
  assertEquals(
    code,
    0,
    `security-scan.sh --tree exited ${code} (1 = findings, 2 = setup failure):\n${
      redact(out).slice(-2_000)
    }`,
  );
});

Deno.test("scripts/security-scan.sh --history is clean for HEAD's ancestry (CI security stage)", async () => {
  const { code, out } = await run(
    ["scripts/security-scan.sh", "--history", "--log-opts", "--full-history HEAD"],
    REPO_ROOT,
  );
  assertEquals(
    code,
    0,
    `security-scan.sh --history exited ${code} (1 = findings, 2 = setup failure):\n${
      redact(out).slice(-2_000)
    }`,
  );
});

Deno.test("no tracked file assigns a literal value to a secret-bearing env name", async () => {
  // Env names the Edge function, its harnesses and CI read as secrets.
  const names = [
    "SUPABASE_SERVICE_ROLE_KEY",
    "REVENUECAT_SECRET_API_KEY",
    "REVENUECAT_WEBHOOK_AUTH",
    "APPLE_SIGN_IN_PRIVATE_KEY",
    "APPLE_TOKEN_ENCRYPTION_KEY",
    "UPSTASH_REDIS_REST_TOKEN",
    "PGRST_JWT_SECRET",
    "XC_PGRST_JWT_SECRET",
    "DATABASE_URL",
  ];
  // A literal assignment with a value ≥ 20 chars that is not a shell
  // expansion, a placeholder (`…`, `<...>`, `$VAR`, `stub-…`, `example…`),
  // or an obvious local docker password documented in AGENTS.md
  // (postgres://postgres:pg@…).
  const pattern = new RegExp(
    `\\b(?:${
      names.join("|")
    })=(?!\\$|\\.\\.\\.|…|<|"\\$|'\\$|(?:stub|placeholder|example|changeme|dummy|your)[-_])[A-Za-z0-9+/=_.\\-]{20,}`,
  );
  const { code, out } = await run(["git", "ls-files", "-z"], REPO_ROOT);
  assertEquals(code, 0, out);
  const files = out.split("\0").filter(Boolean);
  assert(files.length > 100, `unexpectedly few tracked files: ${files.length}`);
  const offenders: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for (const file of files) {
    if (
      /\.(?:png|jpe?g|gif|webp|heic|mov|mp4|m4a|wav|pdf|zip|gz|lock|tflite|mlmodel|onnx)$/i.test(
        file,
      )
    ) {
      continue;
    }
    let text: string;
    try {
      const bytes = await Deno.readFile(`${REPO_ROOT}/${file}`);
      if (bytes.byteLength > 4_000_000) continue;
      text = decoder.decode(bytes);
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const match = pattern.exec(lines[i]);
      if (match) {
        const name = match[0].split("=")[0];
        offenders.push(
          `${file}:${i + 1} assigns ${name}=<${match[0].length - name.length - 1} chars>`,
        );
      }
    }
  }
  assertEquals(
    offenders,
    [],
    `literal secret assignments in tracked files:\n${offenders.join("\n")}`,
  );
});
