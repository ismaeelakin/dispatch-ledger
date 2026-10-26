import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from '../src/worker.js';
import { fixture } from './helpers.js';

test('worker waits for every active send even when one attempt commit fails', async (t) => {
  const f = fixture(t);
  f.store.createEndpoint(f.a.id, { name: 'All', targetId: 'primary', subscription: '*' });
  for (let i = 0; i < 2; i++) f.store.publish(f.a.id, 'order.created', { i }, String(i));
  const finish = f.store.finish.bind(f.store);
  let commits = 0;
  f.store.finish = (lease, outcome) => {
    if (++commits === 1) throw new Error('injected database failure');
    return finish(lease, outcome);
  };
  const releases: (() => void)[] = [];
  const worker = new Worker(
    f.store,
    async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { status: 204, error: null, durationMs: 1, retryAfter: null };
    },
    2,
  );
  let settled = false;
  const result = worker.tick().catch((error) => {
    settled = true;
    return error as Error;
  });
  releases[0]!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releases[1]!();
  assert.match(((await result) as Error).message, /could not be committed/);
  assert.equal(f.store.snapshot(f.a.id).counts.succeeded, 1);
  f.advance(15_000);
  const recovered = f.store.claim();
  assert.ok(recovered);
});
test('crash on the final lease consumes the budget and dead-letters the delivery', (t) => {
  const f = fixture(t);
  f.store.createEndpoint(f.a.id, { name: 'All', targetId: 'primary', subscription: '*' });
  f.store.publish(f.a.id, 'order.created', {}, 'one');
  let id = '';
  for (let i = 0; i < 5; i++) {
    const lease = f.store.claim(1000)!;
    id = lease.id;
    f.advance(1000);
  }
  assert.equal(f.store.claim(), undefined);
  assert.equal(f.store.snapshot(f.a.id).counts.dead, 1);
  assert.equal(f.store.attempts(f.a.id, id).length, 5);
});
