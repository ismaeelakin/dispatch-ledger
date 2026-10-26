import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fields, Problem, bad, record, type Target } from './domain.js';
import type { Store, Tenant } from './store.js';

export interface ServerOptions {
  demo?: boolean;
  rateLimit?: number;
  clock?: () => number;
}
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

export function server(store: Store, options: ServerOptions = {}) {
  const window = new Map<string, { start: number; count: number }>();
  const clock = options.clock ?? Date.now;
  const respond = (
    res: ServerResponse,
    status: number,
    value: unknown,
    mime = 'application/json; charset=utf-8',
  ): void => {
    const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    res.writeHead(status, {
      'Content-Type': mime,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    res.end(body);
  };
  async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
      throw new Problem(415, 'content_type', 'Content-Type must be application/json');
    if (Number(req.headers['content-length']) > 65_536)
      throw new Problem(413, 'body_limit', 'Request exceeds 64 KiB');
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0,
        settled = false;
      req.on('data', (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > 65_536) {
          settled = true;
          reject(new Problem(413, 'body_limit', 'Request exceeds 64 KiB'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      req.on('end', () => {
        if (settled) return;
        settled = true;
        try {
          resolve(
            record(
              JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
            ),
          );
        } catch (error) {
          reject(
            error instanceof Problem
              ? error
              : new Problem(400, 'invalid_request', 'Invalid UTF-8 JSON'),
          );
        }
      });
      req.on('error', () => {
        if (!settled) {
          settled = true;
          reject(new Problem(400, 'request_aborted', 'Request body interrupted'));
        }
      });
    });
  }
  const instance = createServer(
    { requestTimeout: 10_000, headersTimeout: 10_000, maxHeaderSize: 8192 },
    (req, res) => {
      void handle(req, res).catch((error) => {
        if (res.headersSent || res.destroyed) return;
        if (error instanceof Problem)
          respond(res, error.status, { error: { code: error.code, message: error.message } });
        else
          respond(res, 503, {
            error: { code: 'service_unavailable', message: 'Service temporarily unavailable' },
          });
      });
    },
  );
  instance.maxRequestsPerSocket = 100;
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = instance.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    const trustedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!trustedHosts.includes(req.headers.host ?? ''))
      throw new Problem(403, 'host', 'Untrusted Host');
    if (
      req.headers.origin &&
      !trustedHosts.map((host) => `http://${host}`).includes(req.headers.origin)
    )
      throw new Problem(403, 'origin', 'Cross-origin requests are disabled');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const asset = assets.get(url.pathname);
    if (method === 'GET' && asset) {
      respond(
        res,
        200,
        await readFile(new URL(`../../public/${asset[0]}`, import.meta.url)),
        asset[1],
      );
      return;
    }
    if (method === 'GET' && url.pathname === '/health') {
      respond(res, 200, { status: 'ok' });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/config') {
      respond(res, 200, {
        demo: options.demo === true,
        targets: [...store.targetMap.values()].map((target: Target) => ({ id: target.id })),
      });
      return;
    }
    if (!url.pathname.startsWith('/api/')) throw new Problem(404, 'not_found', 'Route not found');
    const match = /^Bearer ([A-Za-z0-9_-]{24,128})$/.exec(req.headers.authorization ?? '');
    const tenant: Tenant | undefined = match?.[1] ? store.authenticate(match[1]) : undefined;
    if (!tenant) throw new Problem(401, 'unauthorized', 'A valid tenant API token is required');
    const now = clock(),
      previous = window.get(tenant.id);
    if (!previous || now - previous.start >= 60_000)
      window.set(tenant.id, { start: now, count: 1 });
    else if (++previous.count > (options.rateLimit ?? 120)) {
      res.setHeader(
        'Retry-After',
        String(Math.max(1, Math.ceil((60_000 - (now - previous.start)) / 1000))),
      );
      throw new Problem(
        429,
        'rate_limit',
        'Tenant request limit reached; retry after the current window',
      );
    }
    // Only authenticated tenant IDs are retained; old windows are bounded by
    // the provisioned tenant set, with lazy cleanup for inactive tenants.
    if (window.size > 1000)
      for (const [id, entry] of window) if (now - entry.start > 120_000) window.delete(id);
    if (method === 'GET' && url.pathname === '/api/overview') {
      respond(res, 200, {
        tenant,
        ...store.snapshot(tenant.id, url.searchParams.get('state'), url.searchParams.get('cursor')),
      });
      return;
    }
    const attempts = /^\/api\/deliveries\/([a-f0-9-]{36})\/attempts$/.exec(url.pathname);
    if (method === 'GET' && attempts?.[1]) {
      respond(res, 200, { attempts: store.attempts(tenant.id, attempts[1]) });
      return;
    }
    const data = method === 'POST' ? await body(req) : {};
    if (method === 'POST' && url.pathname === '/api/events') {
      fields(data, ['type', 'data']);
      if (!Object.hasOwn(data, 'data')) bad('data is required');
      const result = store.publish(tenant.id, data.type, data.data, req.headers['idempotency-key']);
      respond(res, result.created ? 201 : 200, result);
      return;
    }
    if (method === 'POST' && url.pathname === '/api/endpoints') {
      fields(data, ['name', 'targetId', 'subscription']);
      respond(
        res,
        201,
        store.createEndpoint(tenant.id, {
          name: data.name,
          targetId: data.targetId,
          subscription: data.subscription,
        }),
      );
      return;
    }
    const endpoint = /^\/api\/endpoints\/([a-f0-9-]{36})\/state$/.exec(url.pathname);
    if (method === 'POST' && endpoint?.[1]) {
      fields(data, ['active']);
      store.setEndpoint(tenant.id, endpoint[1], data.active);
      respond(res, 200, { ok: true });
      return;
    }
    const replay = /^\/api\/deliveries\/([a-f0-9-]{36})\/replay$/.exec(url.pathname);
    if (method === 'POST' && replay?.[1]) {
      fields(data, ['reason']);
      store.replay(tenant.id, replay[1], data.reason);
      respond(res, 200, { ok: true });
      return;
    }
    throw new Problem(404, 'not_found', 'Route not found');
  }
  return instance;
}
