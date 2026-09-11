import { request } from "node:http";

/** docker-compose `elasticmq` service (see scripts/verify-cloud.sh SQS_ENDPOINT_DEFAULT). */
export const DEFAULT_LOCAL_SQS_ENDPOINT = "http://localhost:9324";

/**
 * True when something answers HTTP at `url`. ElasticMQ replies 400 to a bare
 * GET, so any response — not a 2xx — counts; connection refused / timeout /
 * non-http URL count as unreachable.
 */
export function isHttpEndpointReachable(url: string, timeoutMs = 3000): Promise<boolean> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  if (target.protocol !== "http:") return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    const req = request(target, { method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => req.destroy(new Error("probe timeout")));
    req.on("error", () => resolve(false));
    req.end();
  });
}

/**
 * Endpoint for the ElasticMQ integration suite, or "" to skip it.
 * An explicit SQS_ENDPOINT_TEST always wins (empty string = opt out of the
 * probe); when unset, the docker-compose default is used iff it is reachable.
 */
export async function resolveSqsTestEndpoint(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fallback: string = DEFAULT_LOCAL_SQS_ENDPOINT,
): Promise<string> {
  const explicit = env["SQS_ENDPOINT_TEST"];
  if (explicit !== undefined) return explicit;
  return (await isHttpEndpointReachable(fallback)) ? fallback : "";
}
