/** Typed service configuration. Secrets come from the environment only. */
export interface ApiConfig {
  env: "development" | "test" | "staging" | "production";
  port: number;
  host: string;
  appVersion: string;
  /** Connection string for the API's runtime role (DATABASE_URL_APP), falling
   * back to DATABASE_URL so existing single-credential local setups keep
   * working. Migrations never use this — they run with owner credentials
   * through the @pickle/database CLI. */
  databaseUrl: string | null;
  devAuthSecret: string | undefined;
  oidcIssuer: string | undefined;
  oidcAudience: string | undefined;
  oidcJwksUrl: string | undefined;
  sqsQueueUrl: string | undefined;
  /** HMAC key for signing consent ledger exports (export contract v2).
   * When unset the export route serves the unsigned v1 envelope. */
  consentExportSigningKey: string | undefined;
  consentExportSigningKeyId: string;
  appleIapConfigured: boolean;
  googlePlayConfigured: boolean;
  /** Auth subjects allowed to hold the admin role. An `admin` token claim is
   * honoured only for these subjects; outside development the claim alone is
   * never enough (a mis-mapped IdP claim must not mint an administrator). */
  adminAuthSubjects?: readonly string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const rawEnv = env["PICKLE_ENV"] ?? env["NODE_ENV"] ?? "development";
  const allowed = ["development", "test", "staging", "production"] as const;
  const found = allowed.find((e) => e === rawEnv);
  if (!found) {
    throw new Error(`PICKLE_ENV must be one of ${allowed.join(", ")}; got "${rawEnv}"`);
  }
  return {
    env: found,
    port: Number(env["PORT"] ?? 3001),
    host: env["HOST"] ?? "127.0.0.1",
    appVersion: env["APP_VERSION"] ?? "0.1.0",
    databaseUrl: env["DATABASE_URL_APP"] ?? env["DATABASE_URL"] ?? null,
    devAuthSecret: env["DEV_AUTH_SECRET"],
    oidcIssuer: env["OIDC_ISSUER"],
    oidcAudience: env["OIDC_AUDIENCE"],
    oidcJwksUrl: env["OIDC_JWKS_URL"],
    sqsQueueUrl: env["SQS_QUEUE_URL"],
    consentExportSigningKey: env["CONSENT_EXPORT_SIGNING_KEY"],
    consentExportSigningKeyId: env["CONSENT_EXPORT_SIGNING_KEY_ID"] ?? "consent-export-k1",
    adminAuthSubjects: (env["ADMIN_AUTH_SUBJECTS"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    appleIapConfigured: Boolean(env["APPLE_IAP_PRIVATE_KEY"]),
    googlePlayConfigured: Boolean(env["GOOGLE_PLAY_SERVICE_ACCOUNT"]),
  };
}
