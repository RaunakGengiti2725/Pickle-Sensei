import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import {
  BOOTSTRAP_BODY,
  TEST_DATABASE_URL,
  attackConfig,
  bearer,
  minter,
  resetTestDatabase,
  writeArtifact,
  type ErrorEnvelope,
} from "./support.js";

/**
 * ATTACK S3 — malformed `POST /v1/account/bootstrap` requests:
 *   - `content-type: text/plain`      → expected 415 validation.unsupported_media_type
 *   - 2 MB JSON body                  → expected 413 validation.payload_too_large
 *   - `device.platform = "windows"`   → expected 400 validation.bootstrap
 * Each request carries a VALID dev bearer token so only the body/headers are
 * under attack. Every response is recorded (status + typed envelope).
 */

interface Attempt {
  name: string;
  contentType: string;
  bodyBytes: number;
  status: number;
  body: unknown;
}

describe.skipIf(!TEST_DATABASE_URL)("ATTACK S3: bootstrap content-type / size / platform", () => {
  let app: FastifyInstance;
  let token: string;
  const attempts: Attempt[] = [];

  beforeAll(async () => {
    await resetTestDatabase(TEST_DATABASE_URL!);
    app = buildApp(attackConfig());
    token = await minter().mint("attack4|bootstrap-victim");
  }, 120_000);

  afterAll(async () => {
    writeArtifact("s3-bootstrap-validation.json", { scenario: "S3", attempts });
    await app?.close();
  });

  async function attempt(name: string, contentType: string, payload: string): Promise<Attempt> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: { ...bearer(token), "content-type": contentType },
      payload,
    });
    const record: Attempt = {
      name,
      contentType,
      bodyBytes: Buffer.byteLength(payload),
      status: res.statusCode,
      body: res.json(),
    };
    attempts.push(record);
    return record;
  }

  it("text/plain body is refused with 415 validation.unsupported_media_type", async () => {
    const r = await attempt("text/plain", "text/plain", JSON.stringify(BOOTSTRAP_BODY));
    expect(r.status, JSON.stringify(r.body)).toBe(415);
    expect((r.body as ErrorEnvelope).error.code).toBe("validation.unsupported_media_type");
  });

  it("text/plain with charset is refused with 415 too", async () => {
    const r = await attempt(
      "text/plain; charset=utf-8",
      "text/plain; charset=utf-8",
      JSON.stringify(BOOTSTRAP_BODY),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(415);
    expect((r.body as ErrorEnvelope).error.code).toBe("validation.unsupported_media_type");
  });

  it("contrast: a media type Fastify has NO default parser for (application/xml) IS mapped to 415", async () => {
    // Pins the mechanism behind the text/plain result: the 415 mapping in
    // app.ts fires for unknown media types, but Fastify ships a built-in
    // text/plain parser, so text/plain bodies are parsed to a string and
    // fall through to the route's schema check (400) instead.
    const r = await attempt("application/xml", "application/xml", "<bootstrap/>");
    expect(r.status, JSON.stringify(r.body)).toBe(415);
    expect((r.body as ErrorEnvelope).error.code).toBe("validation.unsupported_media_type");
  });

  it("2 MB JSON body is refused with 413 validation.payload_too_large", async () => {
    const huge = JSON.stringify({
      ...BOOTSTRAP_BODY,
      padding: "x".repeat(2 * 1024 * 1024),
    });
    expect(huge.length).toBeGreaterThan(2 * 1024 * 1024);
    const r = await attempt("2MB json", "application/json", huge);
    expect(r.status, JSON.stringify(r.body)).toBe(413);
    expect((r.body as ErrorEnvelope).error.code).toBe("validation.payload_too_large");
  });

  it("2 MB body with a lying content-length is not accepted either", async () => {
    // Fastify checks content-length first; also try the streaming path by
    // omitting the header entirely so the limit must trigger on actual bytes.
    const huge = JSON.stringify({ ...BOOTSTRAP_BODY, padding: "y".repeat(2 * 1024 * 1024) });
    const res = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: { ...bearer(token), "content-type": "application/json", "content-length": "10" },
      payload: huge,
    });
    attempts.push({
      name: "2MB json, content-length: 10",
      contentType: "application/json",
      bodyBytes: huge.length,
      status: res.statusCode,
      body: res.json(),
    });
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect((res.json() as ErrorEnvelope).error.code).not.toBe("api.internal_error");
  });

  it("device.platform='windows' is refused with 400 validation.bootstrap and creates no account", async () => {
    const r = await attempt(
      "platform=windows",
      "application/json",
      JSON.stringify({
        ...BOOTSTRAP_BODY,
        device: { ...BOOTSTRAP_BODY.device, platform: "windows" },
      }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect((r.body as ErrorEnvelope).error.code).toBe("validation.bootstrap");
    expect((r.body as ErrorEnvelope).error.kind).toBe("permanent");

    // No account row was created by the rejected bootstrap.
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) });
    expect(me.statusCode, "rejected bootstrap must not create the account").toBe(401);
  });

  it("unicode / case-variant platform values are refused the same way", async () => {
    for (const platform of ["iOS", "ＩＯＳ", "ios\u0000", " ios", "android "]) {
      const r = await attempt(
        `platform=${JSON.stringify(platform)}`,
        "application/json",
        JSON.stringify({ ...BOOTSTRAP_BODY, device: { ...BOOTSTRAP_BODY.device, platform } }),
      );
      expect(r.status, `${r.name}: ${JSON.stringify(r.body)}`).toBe(400);
      expect((r.body as ErrorEnvelope).error.code).toBe("validation.bootstrap");
    }
  });
});
