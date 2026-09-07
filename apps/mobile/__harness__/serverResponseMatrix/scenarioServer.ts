/// <reference types="node" />
/**
 * Real loopback HTTP server that serves ONE programmable adversarial response
 * per request: status-code classes, malformed / partial / oversized bodies,
 * duplicate acknowledgements and hangs. Every mobile API client under test
 * talks to it through the same undici `fetch` the Jest environment exposes,
 * so the whole response-parsing path (headers → body stream → JSON → parser)
 * is exercised for real instead of being stubbed with a fake `Response`.
 *
 * Test-only harness; never imported by production code.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type ScenarioResponse =
  /** Fixed status with an (optional) JSON error envelope. */
  | {
      kind: 'status';
      status: number;
      body?: unknown;
      headers?: Record<string, string>;
    }
  /** 2xx with a JSON-serialisable body (well-formed or wrong-shaped). */
  | { kind: 'json'; status?: number; body: unknown }
  /** 2xx with raw bytes and a content-type of the scenario's choosing. */
  | { kind: 'raw'; status?: number; body: string; contentType?: string }
  /**
   * Declares the full Content-Length but only sends a prefix, then destroys
   * the socket: the client sees a 2xx status and a body stream that fails.
   */
  | { kind: 'truncated'; status?: number; body: string; sendBytes: number }
  /**
   * Sends a prefix of a valid JSON body with a Content-Length that matches
   * the prefix (a "clean" cut — the transfer completes, the JSON does not).
   */
  | { kind: 'prefix'; status?: number; body: string; cut: number }
  /** Never answers (or answers headers only and never ends the body). */
  | { kind: 'hang'; mode: 'no_response' | 'headers_only' }
  /** Closes the connection before any status line is written. */
  | { kind: 'reset' };

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  receivedAt: number;
}

export type ScenarioResolver = (
  request: RecordedRequest,
  ordinal: number,
) => ScenarioResponse;

export interface ScenarioServer {
  baseUrl: string;
  requests: RecordedRequest[];
  /** Program the response(s) for subsequent requests. */
  respondWith(resolver: ScenarioResolver | ScenarioResponse): void;
  /** Forget recorded requests and the ordinal counter (keeps the resolver). */
  resetLog(): void;
  close(): Promise<void>;
}

function toBuffer(body: unknown): Buffer {
  if (body === undefined) return Buffer.alloc(0);
  return Buffer.from(JSON.stringify(body), 'utf8');
}

export async function startScenarioServer(): Promise<ScenarioServer> {
  const requests: RecordedRequest[] = [];
  const openSockets = new Set<import('node:net').Socket>();
  let resolver: ScenarioResolver = () => ({
    kind: 'status',
    status: 599,
    body: { error: { code: 'harness.unprogrammed', message: 'no scenario' } },
  });
  let ordinal = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        receivedAt: Date.now(),
      };
      requests.push(recorded);
      const scenario = resolver(recorded, ordinal++);
      switch (scenario.kind) {
        case 'status': {
          const buffer =
            scenario.body === undefined
              ? Buffer.alloc(0)
              : toBuffer(scenario.body);
          res.writeHead(scenario.status, {
            ...(scenario.body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
            'content-length': String(buffer.length),
            ...(scenario.headers ?? {}),
          });
          res.end(buffer);
          return;
        }
        case 'json': {
          const buffer = toBuffer(scenario.body);
          res.writeHead(scenario.status ?? 200, {
            'content-type': 'application/json',
            'content-length': String(buffer.length),
          });
          res.end(buffer);
          return;
        }
        case 'raw': {
          const buffer = Buffer.from(scenario.body, 'utf8');
          res.writeHead(scenario.status ?? 200, {
            'content-type': scenario.contentType ?? 'application/json',
            'content-length': String(buffer.length),
          });
          res.end(buffer);
          return;
        }
        case 'truncated': {
          const buffer = Buffer.from(scenario.body, 'utf8');
          res.writeHead(scenario.status ?? 200, {
            'content-type': 'application/json',
            'content-length': String(buffer.length),
          });
          res.write(buffer.subarray(0, scenario.sendBytes), () => {
            res.socket?.destroy();
          });
          return;
        }
        case 'prefix': {
          const buffer = Buffer.from(scenario.body, 'utf8').subarray(
            0,
            scenario.cut,
          );
          res.writeHead(scenario.status ?? 200, {
            'content-type': 'application/json',
            'content-length': String(buffer.length),
          });
          res.end(buffer);
          return;
        }
        case 'hang': {
          if (scenario.mode === 'headers_only') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.write('{"partial":');
            res.flushHeaders();
          }
          // Intentionally never ends; close() destroys the socket.
          return;
        }
        case 'reset': {
          res.socket?.destroy();
          return;
        }
      }
    });
  });
  server.on('connection', socket => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });
  server.keepAliveTimeout = 1_000;

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    respondWith(next) {
      resolver = typeof next === 'function' ? next : () => next;
      ordinal = 0;
    },
    resetLog() {
      requests.length = 0;
      ordinal = 0;
    },
    async close() {
      for (const socket of openSockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
