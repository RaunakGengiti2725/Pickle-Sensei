import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import {
  adminClient,
  bucketReachable,
  harnessEnvFromProcess,
  inventory,
  runStoragePolicyMatrix,
  type CaseResult,
} from "./storagePolicyHarness.js";

/**
 * CLI for the storage-policy adversarial matrix (see storagePolicyHarness.ts).
 *
 *   S3_TEST_ENDPOINT=http://localhost:9000 S3_TEST_ACCESS_KEY_ID=… \
 *   S3_TEST_SECRET_ACCESS_KEY=… S3_TEST_BUCKET=pickle-media-dev \
 *   pnpm --filter @pickle/api exec tsx test/support/storagePolicyHarnessCli.ts \
 *     --seed 20260904 --cases 25 --out ../../artifacts/storage-policies/<UTC>
 *
 * Writes `matrix.json` (summary + every case with its derived seed and raw
 * storage answer), `failures.json` (the failing subset) and `cases.ndjson`
 * (one line per case as it ran). Exit code is 0 only when every case passed;
 * 2 when the environment is not configured; 3 when the bucket is unreachable.
 * Credentials are read from the environment and never written to disk.
 */

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ?? fallback;
}

async function main(): Promise<number> {
  const env = harnessEnvFromProcess(process.env);
  if (!env) {
    console.error(
      "storage harness: set S3_TEST_ENDPOINT, S3_TEST_ACCESS_KEY_ID, S3_TEST_SECRET_ACCESS_KEY, S3_TEST_BUCKET",
    );
    return 2;
  }
  const runSeed = Number(argValue("--seed", "20260904"));
  const casesPerFamily = Number(argValue("--cases", "10"));
  const outDir = argValue(
    "--out",
    join("..", "..", "artifacts", "storage-policies", new Date().toISOString().replaceAll(":", "")),
  );
  const familiesArg = argValue("--families", "");
  const families = familiesArg ? familiesArg.split(",") : undefined;
  if (!Number.isInteger(runSeed) || !Number.isInteger(casesPerFamily) || casesPerFamily < 1) {
    console.error("storage harness: --seed and --cases must be integers (cases >= 1)");
    return 2;
  }

  if (process.argv.includes("--create-bucket")) {
    const admin = adminClient(env);
    try {
      await admin.send(new HeadBucketCommand({ Bucket: env.bucket }));
    } catch {
      await admin.send(new CreateBucketCommand({ Bucket: env.bucket }));
    }
  }
  if (!(await bucketReachable(env))) {
    console.error(`storage harness: bucket ${env.bucket} unreachable at ${env.endpoint}`);
    return 3;
  }

  mkdirSync(outDir, { recursive: true });
  const ndjson = join(outDir, "cases.ndjson");
  writeFileSync(ndjson, "");
  const before = await inventory(env);
  const run = await runStoragePolicyMatrix(env, {
    runSeed,
    casesPerFamily,
    ...(families ? { families } : {}),
    onCase: (result: CaseResult) => {
      writeFileSync(ndjson, `${JSON.stringify(result)}\n`, { flag: "a" });
      const mark = result.pass ? "ok  " : "FAIL";
      console.error(
        `${mark} ${result.id} seed=${result.caseSeed} storage=${result.storage?.status ?? "-"}/${result.storage?.code ?? "-"} complete=${result.completeDecision ?? "-"}`,
      );
    },
  });
  const after = await inventory(env);

  const matrix = {
    ...run.summary,
    bucketInventory: { before, after },
    replay: `pnpm --filter @pickle/api exec tsx test/support/storagePolicyHarnessCli.ts --seed ${runSeed} --cases ${casesPerFamily}`,
  };
  writeFileSync(
    join(outDir, "matrix.json"),
    JSON.stringify({ summary: matrix, results: run.results }, null, 2),
  );
  writeFileSync(
    join(outDir, "failures.json"),
    JSON.stringify(
      run.results.filter((r) => !r.pass),
      null,
      2,
    ),
  );
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(matrix, null, 2));
  console.error(
    `storage harness: ${run.summary.passed}/${run.summary.total} passed (seed ${runSeed}, ${casesPerFamily}/family) → ${outDir}`,
  );
  return run.summary.failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`storage harness crashed: ${(error as Error).stack ?? String(error)}`);
    process.exit(4);
  },
);
