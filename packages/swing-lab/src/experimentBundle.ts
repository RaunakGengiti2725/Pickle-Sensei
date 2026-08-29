import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Experiment-artifact bundle export/import for cross-machine handoff
 * (Linux ⇄ Mac). A bundle is a single schema-versioned JSON file carrying the
 * exact bytes (base64) + sha256 of every selected artifact under
 * datasets/experiments/, selectable by wave (directory) and/or workstream
 * (filename prefix, e.g. c14 / W13 / D4-08).
 *
 * Contract:
 *  - schema-versioned: importers refuse any bundleVersion other than
 *    experiment-bundle-v1;
 *  - deterministic: files are sorted by relative path and content is hashed,
 *    so export → import → export is byte-stable for a fixed generatedAtIso;
 *  - append-only import: a file that already exists at the destination with
 *    identical bytes is a no-op; different bytes is a CONFLICT reported
 *    explicitly — the existing file is never overwritten.
 */

export const BUNDLE_VERSION = "experiment-bundle-v1" as const;

export interface BundleFile {
  /** Path relative to the experiments root, POSIX separators. */
  path: string;
  sha256: string;
  bytesBase64: string;
}

export interface ExperimentBundle {
  bundleVersion: typeof BUNDLE_VERSION;
  generatedAtIso: string;
  selection: { waves: string[]; workstreams: string[] };
  files: BundleFile[];
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export interface Selection {
  /** Wave directory names, e.g. ["wave-c"]. Empty = all waves + root files. */
  waves: string[];
  /** Case-insensitive workstream filename prefixes, e.g. ["c14"]. Empty = all. */
  workstreams: string[];
}

export function matchesSelection(relPath: string, selection: Selection): boolean {
  const segments = relPath.split("/");
  const wave = segments.length > 1 ? segments[0]! : null;
  if (selection.waves.length > 0) {
    if (wave === null || !selection.waves.includes(wave)) return false;
  }
  if (selection.workstreams.length > 0) {
    const scoped = segments.length > 1 ? segments[1]! : segments[0]!;
    const lowered = scoped.toLowerCase();
    if (!selection.workstreams.some((ws) => lowered.startsWith(ws.toLowerCase()))) return false;
  }
  return true;
}

export function buildBundle(
  experimentsRoot: string,
  selection: Selection,
  generatedAtIso: string,
): ExperimentBundle {
  const files = listFilesRecursive(experimentsRoot)
    .map((full) => toPosix(relative(experimentsRoot, full)))
    .filter((rel) => matchesSelection(rel, selection))
    .sort()
    .map((rel) => {
      const bytes = readFileSync(join(experimentsRoot, rel.split("/").join(sep)));
      return { path: rel, sha256: sha256Hex(bytes), bytesBase64: bytes.toString("base64") };
    });
  return {
    bundleVersion: BUNDLE_VERSION,
    generatedAtIso,
    selection: {
      waves: [...selection.waves].sort(),
      workstreams: [...selection.workstreams].sort(),
    },
    files,
  };
}

export function serializeBundle(bundle: ExperimentBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export interface BundleParseResult {
  bundle: ExperimentBundle | null;
  problems: string[];
}

export function parseBundle(payload: unknown): BundleParseResult {
  const problems: string[] = [];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { bundle: null, problems: ["bundle must be a JSON object"] };
  }
  const record = payload as Record<string, unknown>;
  if (record.bundleVersion !== BUNDLE_VERSION) {
    return {
      bundle: null,
      problems: [
        `unknown bundleVersion ${JSON.stringify(record.bundleVersion ?? null)} — this importer only accepts ${BUNDLE_VERSION}`,
      ],
    };
  }
  if (
    typeof record.generatedAtIso !== "string" ||
    Number.isNaN(Date.parse(record.generatedAtIso))
  ) {
    problems.push("generatedAtIso must be an ISO timestamp");
  }
  if (!Array.isArray(record.files)) {
    problems.push("files must be an array");
    return { bundle: null, problems };
  }
  record.files.forEach((file: unknown, index: number) => {
    if (typeof file !== "object" || file === null) {
      problems.push(`files[${index}] must be an object`);
      return;
    }
    const entry = file as Record<string, unknown>;
    if (typeof entry.path !== "string" || entry.path.length === 0) {
      problems.push(`files[${index}].path required`);
    } else if (entry.path.startsWith("/") || entry.path.split("/").includes("..")) {
      problems.push(`files[${index}].path must be a relative path without .. segments`);
    }
    if (typeof entry.bytesBase64 !== "string") {
      problems.push(`files[${index}].bytesBase64 required`);
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      problems.push(`files[${index}].sha256 must be a 64-char hex digest`);
    } else if (typeof entry.bytesBase64 === "string") {
      const digest = sha256Hex(Buffer.from(entry.bytesBase64, "base64"));
      if (digest !== entry.sha256) {
        problems.push(`files[${index}] (${String(entry.path)}): sha256 mismatch — bundle corrupt`);
      }
    }
  });
  if (problems.length > 0) return { bundle: null, problems };
  return { bundle: payload as ExperimentBundle, problems: [] };
}

export interface ImportReport {
  written: string[];
  unchanged: string[];
  conflicts: Array<{ path: string; detail: string }>;
}

/** Append-only import: never overwrites an existing differing file. */
export function importBundle(
  bundle: ExperimentBundle,
  destinationRoot: string,
  options: { dryRun?: boolean } = {},
): ImportReport {
  const report: ImportReport = { written: [], unchanged: [], conflicts: [] };
  for (const file of bundle.files) {
    const destination = join(destinationRoot, file.path.split("/").join(sep));
    const bytes = Buffer.from(file.bytesBase64, "base64");
    if (existsSync(destination)) {
      const existing = readFileSync(destination);
      if (sha256Hex(existing) === file.sha256) {
        report.unchanged.push(file.path);
      } else {
        report.conflicts.push({
          path: file.path,
          detail: `existing file sha256 ${sha256Hex(existing)} ≠ bundle sha256 ${file.sha256}; existing file kept, bundle copy NOT applied`,
        });
      }
      continue;
    }
    if (!options.dryRun) {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    }
    report.written.push(file.path);
  }
  return report;
}

function usage(): never {
  console.error(
    [
      "Usage:",
      "  tsx src/experimentBundle.ts export --out <bundle.json> [--wave <wave>]... [--workstream <ws>]... [--root <experimentsDir>] [--now <iso>]",
      "  tsx src/experimentBundle.ts import --bundle <bundle.json> [--dest <experimentsDir>] [--dry-run]",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): { command: string; flags: Map<string, string[]> } {
  const [command, ...rest] = argv;
  if (command !== "export" && command !== "import") usage();
  const flags = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!;
    if (!flag.startsWith("--")) usage();
    const name = flag.slice(2);
    if (name === "dry-run") {
      flags.set(name, ["true"]);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) usage();
    index += 1;
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { command, flags };
}

function main(): void {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const defaultRoot = resolve(process.cwd(), "../../datasets/experiments");
  if (command === "export") {
    const out = flags.get("out")?.[0];
    if (!out) usage();
    const root = resolve(flags.get("root")?.[0] ?? defaultRoot);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      console.error(`experiments root not found: ${root}`);
      process.exit(1);
    }
    const selection: Selection = {
      waves: flags.get("wave") ?? [],
      workstreams: flags.get("workstream") ?? [],
    };
    const bundle = buildBundle(root, selection, flags.get("now")?.[0] ?? new Date().toISOString());
    if (bundle.files.length === 0) {
      console.error("selection matched 0 files — refusing to write an empty bundle");
      process.exit(1);
    }
    writeFileSync(resolve(out), serializeBundle(bundle));
    const totalBytes = bundle.files.reduce(
      (sum, file) => sum + Buffer.from(file.bytesBase64, "base64").length,
      0,
    );
    console.log(
      `wrote ${resolve(out)}: ${bundle.files.length} files, ${totalBytes} bytes (waves=${bundle.selection.waves.join(",") || "ALL"}, workstreams=${bundle.selection.workstreams.join(",") || "ALL"})`,
    );
    return;
  }
  const bundlePath = flags.get("bundle")?.[0];
  if (!bundlePath) usage();
  const parsed = parseBundle(JSON.parse(readFileSync(resolve(bundlePath), "utf8")));
  if (parsed.bundle === null) {
    console.error(`bundle REFUSED:\n  ${parsed.problems.join("\n  ")}`);
    process.exit(1);
  }
  const destination = resolve(flags.get("dest")?.[0] ?? defaultRoot);
  const report = importBundle(parsed.bundle, destination, {
    dryRun: flags.has("dry-run"),
  });
  console.log(
    `${flags.has("dry-run") ? "[dry-run] " : ""}written=${report.written.length} unchanged=${report.unchanged.length} conflicts=${report.conflicts.length}`,
  );
  for (const conflict of report.conflicts) {
    console.error(`CONFLICT ${conflict.path}: ${conflict.detail}`);
  }
  if (report.conflicts.length > 0) process.exit(1);
}

const isMain = process.argv[1]?.endsWith("experimentBundle.ts");
if (isMain) main();
