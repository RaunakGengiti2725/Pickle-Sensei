/**
 * ADJUDICATION probe: does an over-long route parameter (> Fastify's default
 * maxParamLength=100) come back in the API's typed error envelope?
 * Run: node --import tsx test/adjudicate/routeParamEnvelope.probe.ts
 */
import { buildApp } from "../../src/app.js";
import type { ApiConfig } from "../../src/config.js";
import { InMemoryJobQueue } from "@pickle/queue";

const config: ApiConfig = {
  env: "test",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-adjudicate",
  databaseUrl: null,
  devAuthSecret: "adjudicate-secret-0123456789abcdef",
  oidcIssuer: undefined,
  oidcAudience: undefined,
  oidcJwksUrl: undefined,
  sqsQueueUrl: undefined,
  consentExportSigningKey: undefined,
  consentExportSigningKeyId: "consent-export-k1",
  appleIapConfigured: false,
  googlePlayConfigured: false,
  adminAuthSubjects: [],
};

const app = buildApp(config, { queue: new InMemoryJobQueue() });
await app.ready();
for (const url of [`/v1/shots/${"a".repeat(101)}`, `/v1/admin/flags/${"k".repeat(4096)}`]) {
  const res = await app.inject({ method: "GET", url, headers: { authorization: "Bearer x" } });
  console.log(`GET ${url.slice(0, 40)}… → ${res.statusCode} ${res.body.slice(0, 200)}`);
}
const malformed = await app.inject({
  method: "POST",
  url: "/v1/account/bootstrap",
  headers: { authorization: "Bearer x", "content-type": "application/json" },
  payload: "{ not json",
});
console.log(`POST malformed JSON → ${malformed.statusCode} ${malformed.body.slice(0, 300)}`);
await app.close();
