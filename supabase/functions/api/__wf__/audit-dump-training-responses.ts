// Execution-audit helper (mobile-training-drills): drives the REAL edge
// handler (routesHarness — Supabase/RevenueCat stubbed at the fetch layer)
// through every route apps/mobile/src/training/api.ts calls and prints the
// raw {status, contentType, body} per case as JSON on stdout. The output is
// committed as apps/mobile/__tests__/audit/fixtures/edgeTrainingResponses.json
// and replayed through the real mobile client by
// apps/mobile/__tests__/audit/edgeContractTrainingApi.test.ts, so the
// server→client contract is executed end to end instead of being asserted
// against hand-written fixtures on each side.
//
// Regenerate (inside __wf__/; the handler's request log goes to stdout, so
// the fixture is written to the path given as the first argument):
//   deno run -A --no-check --config deno.json audit-dump-training-responses.ts \
//     ../../../../apps/mobile/__tests__/audit/fixtures/edgeTrainingResponses.json
//
// Not a test module on purpose (name does not match deno's *test* pattern).

import { drillCatalog } from "../drills.ts";
import { loadHarness, TEST_USER_ID, userRequest } from "./routesHarness.ts";

interface DumpedResponse {
  name: string;
  method: string;
  path: string;
  status: number;
  contentType: string | null;
  body: unknown;
}

async function dump(
  name: string,
  method: string,
  path: string,
  options: { body?: unknown; tables?: Record<string, unknown[]>; ip: string },
): Promise<DumpedResponse> {
  const h = await loadHarness();
  Object.assign(h.tables, options.tables ?? {});
  const res = await h.handler(
    userRequest(method, path, { ip: options.ip, body: options.body }),
  );
  const contentType = res.headers.get("content-type");
  const text = await res.text();
  let body: unknown = text.length === 0 ? null : text;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { name, method, path, status: res.status, contentType, body };
}

const catalog = await drillCatalog();
const first = catalog[0];
const family = first.families[0];
const savedRows = [
  { slug: first.slug, saved_at: "2026-09-04T10:00:00.000Z" },
  { slug: catalog[1].slug, saved_at: "2026-09-03T10:00:00.000Z" },
];

const cases: DumpedResponse[] = [];
let ip = 10;
const nextIp = () => `198.51.100.${ip++}`;

cases.push(
  await dump("catalog.list.all", "GET", "/v1/catalog/drills", {
    ip: nextIp(),
    tables: { user_saved_drills: [{ slug: first.slug }] },
  }),
);
cases.push(
  await dump(
    "catalog.list.family",
    "GET",
    `/v1/catalog/drills?family=${encodeURIComponent(family)}`,
    { ip: nextIp() },
  ),
);
cases.push(
  await dump(
    "catalog.list.q",
    "GET",
    `/v1/catalog/drills?q=${encodeURIComponent(first.title.split(" ")[0])}`,
    { ip: nextIp() },
  ),
);
cases.push(
  await dump(
    "catalog.list.unknownFamily",
    "GET",
    "/v1/catalog/drills?family=no-such-family",
    {
      ip: nextIp(),
    },
  ),
);
cases.push(
  await dump(
    "catalog.list.emptyQuery",
    "GET",
    "/v1/catalog/drills?q=zzzzzzzzzz",
    {
      ip: nextIp(),
    },
  ),
);
for (const entry of catalog) {
  cases.push(
    await dump(
      `catalog.detail.${entry.slug}`,
      "GET",
      `/v1/catalog/drills/${encodeURIComponent(entry.slug)}`,
      { ip: nextIp() },
    ),
  );
}
cases.push(
  await dump(
    "catalog.detail.notFound",
    "GET",
    "/v1/catalog/drills/not-a-real-drill",
    {
      ip: nextIp(),
    },
  ),
);
cases.push(
  await dump(
    "catalog.detail.encodedSlug",
    "GET",
    `/v1/catalog/drills/${encodeURIComponent("weird slug/with?chars")}`,
    { ip: nextIp() },
  ),
);
cases.push(
  await dump("saved.list", "GET", "/v1/me/saved-drills", {
    ip: nextIp(),
    tables: { user_saved_drills: savedRows },
  }),
);
cases.push(
  await dump("saved.list.empty", "GET", "/v1/me/saved-drills", {
    ip: nextIp(),
  }),
);
cases.push(
  await dump("saved.list.unknownSlug", "GET", "/v1/me/saved-drills", {
    ip: nextIp(),
    tables: {
      user_saved_drills: [{
        slug: "removed-from-catalog",
        saved_at: "2026-09-01T00:00:00Z",
      }],
    },
  }),
);
cases.push(
  await dump("saved.put", "PUT", `/v1/me/saved-drills/${first.slug}`, {
    ip: nextIp(),
    tables: {
      user_saved_drills: [{
        slug: first.slug,
        saved_at: "2026-09-04T10:00:00.000Z",
      }],
    },
  }),
);
cases.push(
  await dump(
    "saved.put.invalidSlug",
    "PUT",
    `/v1/me/saved-drills/${encodeURIComponent("Bad Slug!")}`,
    {
      ip: nextIp(),
    },
  ),
);
cases.push(
  await dump("saved.delete", "DELETE", `/v1/me/saved-drills/${first.slug}`, {
    ip: nextIp(),
  }),
);
cases.push(
  await dump("plans.current", "GET", "/v1/training-plans/current", {
    ip: nextIp(),
  }),
);
cases.push(
  await dump("plans.create", "POST", "/v1/training-plans", {
    ip: nextIp(),
    body: { sourceShotId: "b8aece05-d9dc-49eb-af98-54fe0b6e8db7" },
  }),
);
cases.push(
  await dump(
    "plans.reassess",
    "POST",
    "/v1/training-plans/78a7815a-176a-4487-a736-66eb2cc04455/reassessment",
    { ip: nextIp(), body: { shotId: "9c32cbd4-b6aa-491a-b23f-2f982eabb380" } },
  ),
);
cases.push(
  await dump("completions.create", "POST", "/v1/drill-completions", {
    ip: nextIp(),
    body: {
      id: "0e3f1d8a-6b2c-4f5e-9a7d-1c2b3a4d5e6f",
      drillSlug: first.slug,
      trainingPlanItemId: "d32bb05c-d72c-42dd-8075-3af93a63e700",
      completedAt: "2026-09-04T10:00:00.000Z",
      actualRepetitions: 24,
      actualDurationSeconds: null,
    },
  }),
);

const outPath = Deno.args[0];
if (!outPath) {
  console.error("usage: audit-dump-training-responses.ts <output.json>");
  Deno.exit(2);
}
await Deno.writeTextFile(
  outPath,
  JSON.stringify(
    {
      generatedFrom:
        "supabase/functions/api/index.ts via __wf__/routesHarness.ts",
      testUserId: TEST_USER_ID,
      catalogSize: catalog.length,
      cases,
    },
    null,
    2,
  ) + "\n",
);
console.error(`wrote ${cases.length} cases to ${outPath}`);
