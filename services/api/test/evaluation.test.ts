import { afterAll, describe, expect, it } from "vitest";
import { EvaluationTrialUploadRequest } from "@pickle/api-contracts";
import { buildApp } from "../src/app.js";
import type { ApiConfig } from "../src/config.js";

const config: ApiConfig = {
  env: "test",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-test",
  databaseUrl: null,
  devAuthSecret: "test-secret-0123456789",
  oidcIssuer: undefined,
  oidcAudience: undefined,
  oidcJwksUrl: undefined,
  sqsQueueUrl: undefined,
  consentExportSigningKey: undefined,
  consentExportSigningKeyId: "consent-export-k1",
  appleIapConfigured: false,
  googlePlayConfigured: false,
};

const app = buildApp(config);
afterAll(async () => {
  await app.close();
});

describe("evaluation trial intake", () => {
  it("requires authentication", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/evaluation/trials",
      payload: { trials: [] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("upload contract rejects envelopes without an evaluation_telemetry consent reference", () => {
    const base = {
      schemaVersion: "evaluation-trial-v1",
      trialId: "11111111-1111-4111-8111-111111111111",
      capturedAtIso: "2026-08-29T00:00:00.000Z",
    };
    expect(
      EvaluationTrialUploadRequest.safeParse({
        trials: [
          {
            ...base,
            consent: { scope: "model_training", consentVersion: "model-training-v1" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      EvaluationTrialUploadRequest.safeParse({
        trials: [
          {
            ...base,
            consent: {
              scope: "evaluation_telemetry",
              consentVersion: "evaluation-telemetry-v1",
            },
          },
        ],
      }).success,
    ).toBe(true);
    expect(EvaluationTrialUploadRequest.safeParse({ trials: [] }).success).toBe(false);
  });
});
