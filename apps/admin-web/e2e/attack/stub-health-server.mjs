// Foreign impostor for 127.0.0.1:3001 (adversarial S4): looks healthy to
// Playwright's webServer probe but rejects every bearer.
import { createServer } from "node:http";

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (req.method === "GET" && url === "/v1/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "foreign-stub" }));
    return;
  }
  res.writeHead(401, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      error: {
        kind: "auth_failed",
        code: "auth.invalid_token",
        message: "Token verification failed (foreign stub).",
        retryable: false,
        requestId: "stub",
      },
    }),
  );
});

server.listen(3001, "127.0.0.1", () => {
  console.log("stub listening on 127.0.0.1:3001");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
