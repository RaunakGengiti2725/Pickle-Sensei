# media-worker execution-audit scripts

Reproduction helpers written during the storage-media-worker execution audit
(pass 2, commit 4d812e1a). They drive the REAL `pnpm --filter @pickle/media-worker start`
entrypoint against the docker-compose services (`docker compose up -d postgres redis elasticmq minio`).
Nothing here is production code and nothing is run by CI.

Run each from `services/media-worker/` so `@aws-sdk/client-s3` and `pg` resolve
(`cp` the script there first, or `node --experimental-default-type=module` from this directory).

| script                   | what it shows                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `minio-prefix-probe.mjs` | MinIO returns `[]` for `ListObjectsV2(Prefix="x/")` while an object named `x` exists, so `deleteObjectAndDerived` (worker.ts) orphans derived |
| `main-purge-seed.mjs`    | `seed` inserts two deleted `media_asset` rows + MinIO objects + queue messages; `check '<json>'` reports what the worker left behind          |
| `main-poison-seed.mjs`   | `seed` enqueues malformed / missing-data jobs (non-uuid id, `{}` payload, `null` payload, non-JSON body); `check` prints queue depth          |

Example (bounded run of the real entrypoint):

```bash
export DATABASE_URL=postgres://pickle:pickle_dev_password@localhost:5432/pickle_dev
pnpm --filter @pickle/database migrate && pnpm --filter @pickle/database seed
STATE=$(node ./main-purge-seed.mjs seed)
S3_MEDIA_BUCKET=media-audit S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY_ID=pickle-local \
S3_SECRET_ACCESS_KEY=pickle-local-secret AWS_REGION=us-east-1 \
SQS_QUEUE_URL=http://localhost:9324/000000000000/media-audit SQS_ENDPOINT=http://localhost:9324 \
AWS_ACCESS_KEY_ID=x AWS_SECRET_ACCESS_KEY=x WORKER_INTERVAL_MS=1000 \
timeout 15 pnpm --filter @pickle/media-worker start
node ./main-purge-seed.mjs check "$STATE"
```

The vitest harness `../objectStore.minio.integration.test.ts` covers the same
surfaces in-process and is gated on `S3_ENDPOINT_TEST` (plus `SQS_ENDPOINT_TEST` /
`DATABASE_URL_TEST` for the end-to-end block). Three of its assertions fail against
MinIO for the prefix-listing reason above; they encode the S3 contract the worker
relies on and are left failing on purpose as the finding's reproduction.
