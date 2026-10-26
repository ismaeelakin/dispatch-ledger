import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Worker } from '../src/worker.js';
import { transport } from '../src/transport.js';
import { verify, type Outcome } from '../src/domain.js';
import { fixture } from './helpers.js';

test('real HTTP delivery signs exact bytes and records receiver acknowledgment', async (t) => {
  let seen = false;
  let expectedSecret = '';
  const receiver = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (data) => {
      body += String(data);
    });
    req.on('end', () => {
      seen = verify(
        expectedSecret,
        String(req.headers['x-dispatch-timestamp']),
        String(req.headers['x-dispatch-id']),
        body,
        String(req.headers['x-dispatch-signature']),
        Math.floor(Date.now() / 1000),
      );
      res.writeHead(seen ? 204 : 401);
      res.end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        receiver.close(() => resolve());
        receiver.closeAllConnections();
      }),
  );
  const address = receiver.address();
  if (!address || typeof address === 'string') throw new Error();
  const f = fixture(t, [{ id: 'local', url: `http://127.0.0.1:${address.port}/hook` }], true);
  expectedSecret = f.store.createEndpoint(f.a.id, {
    name: 'Signed',
    targetId: 'local',
    subscription: '*',
  }).signingSecret;
  f.store.publish(f.a.id, 'order.created', { customer: 'café' }, 'one');
  await new Worker(f.store, transport()).tick();
  assert.equal(seen, true);
  assert.equal(f.store.snapshot(f.a.id).counts.succeeded, 1);
});
test('transport refuses redirects and bounds response wait time', async (t) => {
  let redirected = false;
  const receiver = createServer((req, res) => {
    if (req.url === '/hang') return;
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/followed' });
      res.end();
      return;
    }
    redirected = true;
    res.end();
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        receiver.close(() => resolve());
        receiver.closeAllConnections();
      }),
  );
  const address = receiver.address();
  if (!address || typeof address === 'string') throw new Error();
  const f = fixture(
    t,
    [
      { id: 'redirect', url: `http://127.0.0.1:${address.port}/redirect` },
      { id: 'hang', url: `http://127.0.0.1:${address.port}/hang` },
    ],
    true,
  );
  f.store.createEndpoint(f.a.id, {
    name: 'Redirect',
    targetId: 'redirect',
    subscription: 'redirect.test',
  });
  f.store.publish(f.a.id, 'redirect.test', {}, 'redirect');
  await new Worker(f.store, transport(100)).tick();
  assert.equal(redirected, false);
  assert.equal(f.store.snapshot(f.a.id).counts.dead, 1);
  f.store.createEndpoint(f.a.id, { name: 'Hang', targetId: 'hang', subscription: 'timeout.test' });
  f.store.publish(f.a.id, 'timeout.test', {}, 'timeout');
  await new Worker(f.store, transport(40)).tick();
  assert.equal(f.store.snapshot(f.a.id).counts.pending, 1);
});
test('worker bounds concurrent sends and graceful stop awaits the active tick', async (t) => {
  const f = fixture(t);
  f.store.createEndpoint(f.a.id, { name: 'All', targetId: 'primary', subscription: '*' });
  for (let i = 0; i < 8; i++) f.store.publish(f.a.id, 'order.created', { i }, String(i));
  let active = 0,
    maximum = 0;
  const releases: (() => void)[] = [];
  const worker = new Worker(
    f.store,
    async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return { status: 200, error: null, durationMs: 1, retryAfter: null };
    },
    3,
  );
  const pending = worker.tick();
  assert.equal(await worker.tick(), 0);
  let stopped = false;
  const stop = worker.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  for (const release of releases) release();
  assert.equal(await pending, 3);
  await stop;
  assert.equal(maximum, 3);
  assert.equal(f.store.snapshot(f.a.id).counts.pending, 5);
});
test('worker converts transport exceptions to retryable failures without secret text', async (t) => {
  const f = fixture(t);
  const endpoint = f.store.createEndpoint(f.a.id, {
    name: 'All',
    targetId: 'primary',
    subscription: '*',
  });
  f.store.publish(f.a.id, 'order.created', {}, 'a');
  await new Worker(f.store, async (): Promise<Outcome> => {
    throw new Error(endpoint.signingSecret);
  }).tick();
  const result = JSON.stringify(f.store.snapshot(f.a.id));
  assert.equal(f.store.snapshot(f.a.id).counts.pending, 1);
  assert.ok(!result.includes(endpoint.signingSecret));
});
test('receiver inbox makes duplicate successful delivery IDs a no-op', (t) => {
  const f = fixture(t);
  assert.equal(f.store.receiveOnce('same-delivery'), true);
  assert.equal(f.store.receiveOnce('same-delivery'), false);
});
