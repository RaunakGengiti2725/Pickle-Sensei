/// <reference types="node" />
/**
 * Adversarial network layer for the process-death attack suite: a loopback
 * HTTP proxy the child talks to instead of the rating service. Every request
 * is forwarded verbatim to the upstream service unless a fault rule matches,
 * in which case the proxy answers on its own (429 + Retry-After, 5xx, a
 * redirect, or a stall past the client's request timeout) and the upstream
 * never sees the request. Rules count matches per `resetCounters()` window so
 * one launch can be faulted while the next launch runs clean.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type Fault =
  | {
      readonly kind: 'status';
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: unknown;
    }
  | {
      readonly kind: 'redirect';
      readonly status: 301 | 302 | 307 | 308;
      /** What the redirect target answers: a captive portal's HTML page, or
       * a JSON 404 from an API origin that has no such route. */
      readonly target: 'portal_html' | 'not_found';
    }
  | {
      readonly kind: 'text';
      readonly status: number;
      readonly contentType: string;
      readonly text: string;
    }
  | { readonly kind: 'stall'; readonly ms: number };

export const REDIRECT_TARGET_PATH = '/attack-redirect-target';

export interface FaultRule {
  readonly pathIncludes: string;
  /** 1-based match ordinal within the current counter window, or every match. */
  readonly ordinal: number | 'all';
  readonly fault: Fault;
}

export interface ProxiedRequest {
  readonly method: string;
  readonly path: string;
  readonly faulted: Fault | null;
  readonly status: number;
}

export interface FaultProxy {
  readonly baseUrl: string;
  setRules(rules: readonly FaultRule[]): void;
  resetCounters(): void;
  requests(): readonly ProxiedRequest[];
  close(): Promise<void>;
}

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('error', reject);
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function forward(
  upstream: URL,
  request: http.IncomingMessage,
  body: Buffer,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const headers = { ...request.headers };
    delete headers['host'];
    const outbound = http.request(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        method: request.method,
        path: request.url,
        headers,
      },
      response => {
        void readBody(response).then(payload =>
          resolve({
            status: response.statusCode ?? 502,
            headers: response.headers,
            body: payload,
          }),
        );
      },
    );
    outbound.on('error', reject);
    outbound.end(body);
  });
}

export async function startFaultProxy(
  upstreamBaseUrl: string,
): Promise<FaultProxy> {
  const upstream = new URL(upstreamBaseUrl);
  const mountPath = upstream.pathname;
  let rules: readonly FaultRule[] = [];
  let counters = new Map<FaultRule, number>();
  const log: ProxiedRequest[] = [];
  const sleeping = new Set<ReturnType<typeof setTimeout>>();

  const matchFault = (path: string): Fault | null => {
    for (const rule of rules) {
      if (!path.includes(rule.pathIncludes)) continue;
      const seen = (counters.get(rule) ?? 0) + 1;
      counters.set(rule, seen);
      if (rule.ordinal === 'all' || rule.ordinal === seen) return rule.fault;
    }
    return null;
  };

  const server = http.createServer((request, response) => {
    void (async () => {
      const method = request.method ?? 'GET';
      const url = new URL(request.url ?? '/', 'http://localhost');
      const path = url.pathname.startsWith(mountPath)
        ? url.pathname.slice(mountPath.length)
        : url.pathname;
      const body = await readBody(request);
      if (path.startsWith(REDIRECT_TARGET_PATH)) {
        const target = url.searchParams.get('target');
        if (target === 'portal_html') {
          const page = '<html><body>Sign in to the network</body></html>';
          log.push({ method, path, faulted: null, status: 200 });
          response.writeHead(200, {
            'content-type': 'text/html',
            'content-length': Buffer.byteLength(page),
          });
          response.end(page);
          return;
        }
        const missing = JSON.stringify({
          error: { code: 'not_found', message: 'No such route.' },
        });
        log.push({ method, path, faulted: null, status: 404 });
        response.writeHead(404, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(missing),
        });
        response.end(missing);
        return;
      }
      const fault = matchFault(path);
      if (fault === null) {
        const answer = await forward(upstream, request, body);
        log.push({ method, path, faulted: null, status: answer.status });
        response.writeHead(answer.status, answer.headers);
        response.end(answer.body);
        return;
      }
      if (fault.kind === 'stall') {
        log.push({ method, path, faulted: fault, status: 0 });
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            sleeping.delete(timer);
            resolve();
          }, fault.ms);
          sleeping.add(timer);
        });
        response.destroy();
        return;
      }
      if (fault.kind === 'text') {
        log.push({ method, path, faulted: fault, status: fault.status });
        response.writeHead(fault.status, {
          'content-type': fault.contentType,
          'content-length': Buffer.byteLength(fault.text),
        });
        response.end(fault.text);
        return;
      }
      if (fault.kind === 'redirect') {
        log.push({ method, path, faulted: fault, status: fault.status });
        response.writeHead(fault.status, {
          location: `${mountPath}${REDIRECT_TARGET_PATH}?target=${fault.target}`,
          'content-length': 0,
        });
        response.end();
        return;
      }
      const payload = JSON.stringify(
        fault.body ?? {
          error: {
            code: 'attack.injected',
            message: `Injected ${fault.status}`,
          },
        },
      );
      log.push({ method, path, faulted: fault, status: fault.status });
      response.writeHead(fault.status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...(fault.headers ?? {}),
      });
      response.end(payload);
    })();
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}${mountPath}`,
    setRules(next) {
      rules = next;
      counters = new Map();
    },
    resetCounters() {
      counters = new Map();
    },
    requests: () => [...log],
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const timer of sleeping) clearTimeout(timer);
        server.closeAllConnections();
        server.close(err => (err ? reject(err) : resolve()));
      }),
  };
}
