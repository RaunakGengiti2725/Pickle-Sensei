#!/usr/bin/env node
// Reverse proxy in front of registry.npmjs.org that black-holes the advisory
// endpoints (`/-/npm/v1/security/*`) so `npm audit` / `pnpm audit` can be run
// against a registry whose metadata + tarballs work but whose advisory API is
// down. Everything else is forwarded verbatim.
//
//   node advisory-blackhole-proxy.mjs --port 4873 --mode 503|reset|hang
//
// Prints `LISTENING <port>` on stdout once ready. Writes one JSON line per
// request to stderr so the run can prove which paths were blocked.
import http from "node:http";
import https from "node:https";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const port = Number(opt("port", "4873"));
const mode = opt("mode", "503");
const upstream = new URL(opt("upstream", "https://registry.npmjs.org"));
const blockedPrefix = "/-/npm/v1/security/";

const log = (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`);

const server = http.createServer((req, res) => {
  const path = req.url ?? "/";
  if (path.startsWith(blockedPrefix)) {
    log({ blocked: true, mode, method: req.method, path });
    if (mode === "reset") {
      req.socket.destroy();
      return;
    }
    if (mode === "hang") {
      return; // never answer; caller must rely on its own timeout
    }
    res.writeHead(503, { "content-type": "application/json", "retry-after": "60" });
    res.end(JSON.stringify({ error: "advisory endpoint unavailable (attack harness)" }));
    return;
  }
  log({ blocked: false, method: req.method, path });
  const headers = { ...req.headers, host: upstream.host };
  delete headers["accept-encoding"];
  const proxied = https.request(
    { host: upstream.host, port: 443, method: req.method, path, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  proxied.on("error", (err) => {
    log({ upstreamError: String(err), path });
    res.writeHead(502);
    res.end();
  });
  req.pipe(proxied);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`LISTENING ${port}\n`);
});
