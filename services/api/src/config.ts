/** Typed service configuration. Secrets come from the environment only. */
export interface ApiConfig {
  env: "development" | "test" | "staging" | "production";
  port: number;
  host: string;
  appVersion: string;
  databaseUrl: string | null;
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
  };
}
