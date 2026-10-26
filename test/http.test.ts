import test from 'node:test';
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import { server } from '../src/server.js';
import { fixture } from './helpers.js';

async function listen(app: Server): Promise<string> {
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  const address = app.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  return `http://127.0.0.1:${address.port}`;
}
async function close(app: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    app.close(() => resolve());
    app.closeAllConnections();
  });
}

test('API authenticates tenant and rejects cross-tenant resource mutations', async (t) => {
  const f = fixture(t),
    app = server(f.store),
    base = await listen(app);
  t.after(() => close(app));
  const headers = { Authorization: `Bearer ${f.a.apiToken}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/overview`)).status, 401);
  const created = await fetch(`${base}/api/endpoints`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Billing', targetId: 'primary', subscription: '*' }),
  });
  assert.equal(created.status, 201);
  const endpoint = (await created.json()) as { id: string; signingSecret: string };
  const wrongTenant = { ...headers, Authorization: `Bearer ${f.b.apiToken}` };
  assert.equal(
    (
      await fetch(`${base}/api/endpoints/${endpoint.id}/state`, {
        method: 'POST',
        headers: wrongTenant,
        body: '{"active":false}',
      })
    ).status,
    404,
  );
  const published = await fetch(`${base}/api/events`, {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': 'a' },
    body: '{"type":"order.created","data":{"n":1}}',
  });
  assert.equal(published.status, 201);
  const lease = f.store.claim()!;
  assert.equal(
    (await fetch(`${base}/api/deliveries/${lease.id}/attempts`, { headers: wrongTenant })).status,
    404,
  );
  assert.equal(
    (
      await fetch(`${base}/api/deliveries/${lease.id}/replay`, {
        method: 'POST',
        headers: wrongTenant,
        body: '{"reason":"wrong"}',
      })
    ).status,
    404,
  );
  const own = await (await fetch(`${base}/api/overview`, { headers })).text();
  assert.ok(
    !own.includes(endpoint.signingSecret) &&
      !own.includes(lease.token) &&
      !own.includes(f.a.apiToken),
  );
  const other = (await (await fetch(`${base}/api/overview`, { headers: wrongTenant })).json()) as {
    deliveries: unknown[];
  };
  assert.equal(other.deliveries.length, 0);
});
test('API validates JSON, target policy, idempotency and request boundaries', async (t) => {
  const f = fixture(t),
    app = server(f.store),
    base = await listen(app);
  t.after(() => close(app));
  const headers = {
    Authorization: `Bearer ${f.a.apiToken}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': 'same',
  };
  const post = (body: string, extra = {}) =>
    fetch(`${base}/api/events`, { method: 'POST', headers: { ...headers, ...extra }, body });
  assert.equal((await post('{"type":"order.created","data":{}}')).status, 201);
  assert.equal((await post('{"type":"order.created","data":{}}')).status, 200);
  assert.equal((await post('{"type":"order.created","data":{"changed":true}}')).status, 409);
  assert.equal((await post('{"type":"order.created","data":{},"tenant_id":"other"}')).status, 400);
  assert.equal((await post('{bad-json')).status, 400);
  assert.equal((await post('[]')).status, 400);
  assert.equal((await post('{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('{}', { Origin: 'https://untrusted.example.test' })).status, 403);
  const untrustedHost = await new Promise<number>((resolve, reject) => {
    const req = request(
      `${base}/api/overview`,
      { headers: { Host: 'untrusted.example.test' } },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(untrustedHost, 403);
  assert.equal((await post(' '.repeat(65_537))).status, 413);
  const endpoint = await fetch(`${base}/api/endpoints`, {
    method: 'POST',
    headers,
    body: '{"name":"Bad","targetId":"http://127.0.0.1/admin","subscription":"*"}',
  });
  assert.equal(endpoint.status, 400);
  assert.equal((await fetch(`${base}/api/overview?cursor=bad`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/api/overview?state=unknown`, { headers })).status, 400);
});
test('tenant rate limits are independent and reset with the injected clock', async (t) => {
  const f = fixture(t),
    app = server(f.store, { rateLimit: 2, clock: f.now }),
    base = await listen(app);
  t.after(() => close(app));
  const get = (key: string) =>
    fetch(`${base}/api/overview`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal((await get(f.a.apiToken)).status, 200);
  assert.equal((await get(f.a.apiToken)).status, 200);
  const denied = await get(f.a.apiToken);
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get('Retry-After'), '60');
  assert.equal((await get(f.b.apiToken)).status, 200);
  f.advance(60_000);
  assert.equal((await get(f.a.apiToken)).status, 200);
});
test('public assets use an allowlist and security headers', async (t) => {
  const f = fixture(t),
    app = server(f.store),
    base = await listen(app);
  t.after(() => close(app));
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const index = await fetch(base);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('Content-Security-Policy')!, /frame-ancestors 'none'/);
  assert.equal((await fetch(`${base}/migrations/001_initial.sql`)).status, 404);
  assert.equal((await fetch(`${base}/api/overview?apiToken=${f.a.apiToken}`)).status, 401);
});
