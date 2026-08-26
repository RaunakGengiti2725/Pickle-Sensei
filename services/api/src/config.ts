/** Typed service configuration. Secrets come from the environment only. */
export interface ApiConfig {
  env: "development" | "test" | "staging" | "production";
  port: number;
  host: string;
  appVersion: string;
  databaseUrl: string | null;
  devAuthSecret: string | undefined;
  oidcIssuer: string | undefined;
  oidcAudience: string | undefined;
  oidcJwksUrl: string | undefined;
  sqsQueueUrl: string | undefined;
  appleIapConfigured: boolean;
  googlePlayConfigured: boolean;
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
    databaseUrl: env["DATABASE_URL"] ?? null,
    devAuthSecret: env["DEV_AUTH_SECRET"],
    oidcIssuer: env["OIDC_ISSUER"],
    oidcAudience: env["OIDC_AUDIENCE"],
    oidcJwksUrl: env["OIDC_JWKS_URL"],
    sqsQueueUrl: env["SQS_QUEUE_URL"],
    appleIapConfigured: Boolean(env["APPLE_IAP_PRIVATE_KEY"]),
    googlePlayConfigured: Boolean(env["GOOGLE_PLAY_SERVICE_ACCOUNT"]),
  };
}
