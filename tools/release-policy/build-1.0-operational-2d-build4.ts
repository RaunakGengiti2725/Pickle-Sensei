// Prepare the immutable build-4 successor to 1.0-operational-2d. This writes
// policy bytes only; it never installs, approves, activates or withdraws one.
// See docs/release-policy/1.0-operational-2d-build4.md for the exact command.
import {
  type AnalysisReleasePolicyDocument,
  validateAnalysisReleasePolicy,
} from "../../packages/shared-types/src/analysisReleasePolicy.ts";
import {
  canonicalizeOfflineJson,
  digestCanonicalOfflineJson,
} from "../../supabase/functions/api/canonicalDigest.ts";
import { document as predecessor } from "./build-1.0-operational-2d.ts";

export const POLICY_VERSION = "1.0-operational-2d-build4";
export const ANALYZER_COMMIT = "c7a20769d9b617645c03ecfd62ac77f1f75008df";
export const EVIDENCE_PATH = "docs/RELEASE_READINESS_2026-09-11_BUILD4.md";

/** SHA-256 of raw blobs or `git ls-tree -r <commit> -- <path>` bytes. */
const artifacts = {
  pipeline: {
    kind: "tree",
    path: "packages/analysis-pipeline/src",
    sha256: "6dceb292b61d0f7e93a5101f98a0fb6f757fd11f28ae4873e396c2e6de2c3dd8",
  },
  definition: {
    kind: "tree",
    path: "packages/scoring/src",
    sha256: "5c5e597de273e57ce2a9832dee21806807c0a8eda358aa1958c55b6d963ff85d",
  },
  model: {
    kind: "tree",
    path: ["packages/model-registry/src/defaultManifest.ts", "packages/vision-geometry/src"],
    sha256: "5335cebf1c4f03d3e12d8113b31bf0eb368be2c59da4ac6d0181989431812306",
  },
  preprocessing: {
    kind: "tree",
    path: "native/vision-core/Sources",
    sha256: "b00c96c596078bcec8cffab7d3afe65166e914ac21fb389a1978651dc9b78ad4",
  },
  calibration: {
    kind: "blob",
    path: "packages/scoring/src/config/v1.ts",
    sha256: "3511404ae43432e3d05bfc870f7c3238a2a42c3a4e5efc271c5155563bc74798",
  },
  dataset: {
    kind: "blob",
    path: "datasets/releases/pickle-real-v0.3/manifest.json",
    sha256: "8da130571db9a9d8508ae5547aa38d6a20982be5de2d38d3bbb8b1eb3c60a56c",
  },
  supportedDomain: {
    kind: "blob",
    path: "packages/capture-envelope/src/core.ts",
    sha256: "c9f8c5ab697143079c0676d3a56937bfdab593ebba3a22ae78cd1f277497f526",
  },
  benchmarkContract: {
    kind: "blob",
    path: "packages/shared-types/src/techniqueBenchmark.ts",
    sha256: "f9f3a90a8af1ea0341f8630c3e1effdddff3f300c30c5cf82eaf94778deeb221",
  },
} as const;

async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer)),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function git(...args: string[]): Promise<Uint8Array> {
  const result = await new Deno.Command("git", { args, stdout: "piped", stderr: "piped" }).output();
  if (!result.success) throw new Error(`git ${args.join(" ")} failed.`);
  return result.stdout;
}

/** Both committed HEAD and its working files must still be this analyzer. */
export async function verifyAnalyzerArtifacts(): Promise<void> {
  for (const [name, artifact] of Object.entries(artifacts)) {
    const paths = typeof artifact.path === "string" ? [artifact.path] : [...artifact.path];
    for (const commit of [ANALYZER_COMMIT, "HEAD"]) {
      const bytes =
        artifact.kind === "tree"
          ? await git("ls-tree", "-r", commit, "--", ...paths)
          : await git("show", `${commit}:${artifact.path}`);
      if ((await sha256(bytes)) !== artifact.sha256)
        throw new Error(`${name} differs at ${commit}; create a new policy for changed artifacts.`);
    }
    if (
      (await git("diff", "HEAD", "--", ...paths)).length > 0 ||
      (await git("ls-files", "--others", "--exclude-standard", "--", ...paths)).length > 0
    )
      throw new Error(`${name} has uncommitted changes; cannot bind an unverified analyzer.`);
  }
}

export function buildPolicy(evidenceSha256: string): AnalysisReleasePolicyDocument {
  if (!/^[a-f0-9]{64}$/.test(evidenceSha256))
    throw new Error("A lowercase evidence SHA-256 is required.");
  const previous = predecessor.mechanics.lineage;
  const reference = (name: keyof typeof previous & keyof typeof artifacts) => ({
    version: previous[name].version,
    sha256: artifacts[name].sha256,
  });
  const lineage = {
    pipeline: reference("pipeline"),
    definition: reference("definition"),
    model: reference("model"),
    preprocessing: reference("preprocessing"),
    calibration: reference("calibration"),
    dataset: reference("dataset"),
    validationReport: {
      version: "release-readiness-2026-09-11-build4-operational-no-accuracy-claim",
      sha256: evidenceSha256,
    },
    supportedDomain: reference("supportedDomain"),
  };
  const document: AnalysisReleasePolicyDocument = {
    ...predecessor,
    version: POLICY_VERSION,
    validFrom: 1789084800, // 2026-09-11T00:00:00Z
    validUntil: 1820620800, // 2027-09-11T00:00:00Z
    mechanics: { lineage },
    benchmark: {
      ...predecessor.benchmark,
      lineage: {
        ...predecessor.benchmark.lineage,
        pipeline: lineage.pipeline,
        preprocessing: lineage.preprocessing,
        dataset: lineage.dataset,
        validationReport: lineage.validationReport,
        supportedDomain: lineage.supportedDomain,
      },
    },
  };
  if (!validateAnalysisReleasePolicy(document))
    throw new Error("Release policy validation failed.");
  return document;
}

async function preserveImmutableFile(path: string, value: string, check: boolean): Promise<void> {
  let existing: string | null = null;
  try {
    existing = await Deno.readTextFile(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (existing !== null) {
    if (existing !== value) throw new Error(`${path} already contains different immutable bytes.`);
  } else if (check) throw new Error(`${path} is missing.`);
  else await Deno.writeTextFile(path, value, { createNew: true });
}

if (import.meta.main) {
  const args = [...Deno.args];
  let evidenceSha256 = "";
  let outDir = "docs/release-policy";
  let check = false;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--evidence-sha256") evidenceSha256 = args.shift() ?? "";
    else if (arg === "--out-dir") outDir = args.shift() ?? "";
    else if (arg === "--check") check = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!outDir) throw new Error("An output directory is required.");
  const document = buildPolicy(evidenceSha256);
  await verifyAnalyzerArtifacts();
  if ((await sha256(await Deno.readFile(EVIDENCE_PATH))) !== evidenceSha256)
    throw new Error(`${EVIDENCE_PATH} does not match the explicitly pinned evidence digest.`);
  const canonical = canonicalizeOfflineJson(document);
  const digest = await digestCanonicalOfflineJson(document);
  if (!check) await Deno.mkdir(outDir, { recursive: true });
  await preserveImmutableFile(`${outDir}/${POLICY_VERSION}.canonical.json`, canonical, check);
  await preserveImmutableFile(`${outDir}/${POLICY_VERSION}.sha256`, `${digest}\n`, check);
  console.log(
    JSON.stringify({
      version: POLICY_VERSION,
      sha256: digest,
      bytes: canonical.length,
      inputs: document.supportedInputs.length,
      check,
    }),
  );
}
