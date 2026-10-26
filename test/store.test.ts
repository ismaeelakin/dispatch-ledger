import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { Vault, targets, type Outcome } from '../src/domain.js';
import { fixture, testKey } from './helpers.js';

const ok: Outcome = { status: 204, error: null, durationMs: 1, retryAfter: null };
test('tenant auth uses token hashes and snapshots never expose credentials', (t) => {
  const f = fixture(t);
  assert.equal(f.store.authenticate(f.a.apiToken)?.id, f.a.id);
  assert.equal(f.store.authenticate('invalid-token-is-long-enough'), undefined);
  const endpoint = f.store.createEndpoint(f.a.id, {
    name: 'Billing',
    targetId: 'primary',
    subscription: '*',
  });
  const raw = JSON.stringify(f.store.snapshot(f.a.id));
  assert.ok(!raw.includes(endpoint.signingSecret) && !raw.includes(f.a.apiToken));
  const encrypted = f.store.db.prepare('SELECT secret FROM endpoints WHERE id=?').get(endpoint.id)![
    'secret'
  ];
  assert.notEqual(encrypted, endpoint.signingSecret);
  assert.notEqual(
    f.store.db.prepare('SELECT token_hash FROM tenants WHERE id=?').get(f.a.id)!['token_hash'],
    f.a.apiToken,
  );
});
test('event publication atomically fans out to matching tenant subscriptions', (t) => {
  const f = fixture(t);
  f.store.createEndpoint(f.a.id, { name: 'All', targetId: 'primary', subscription: '*' });
  f.store.createEndpoint(f.a.id, {
    name: 'Orders',
    targetId: 'primary',
    subscription: 'order.created',
  });
  f.store.createEndpoint(f.a.id, {
    name: 'Invoices',
    targetId: 'primary',
    subscription: 'invoice.paid',
  });
  f.store.createEndpoint(f.b.id, { name: 'Other tenant', targetId: 'primary', subscription: '*' });
  const event = f.store.publish(f.a.id, 'order.created', { id: 42 }, 'order-42');
  assert.equal(event.deliveries, 2);
  assert.equal(f.store.snapshot(f.b.id).deliveries.length, 0);
});
test('a failed outbox insert rolls back event and audit together', (t) => {
  const f = fixture(t);
  f.store.createEndpoint(f.a.id, { name: 'All', targetId: 'primary', subscription: '*' });
  f.store.db.exec(
    "CREATE TRIGGER reject_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
  );
  assert.throws(() => f.store.publish(f.a.id, 'order.created', {}, 'rollback'));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM events').get()!['n'], 0);
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='event.accepted'").get()!['n'],
    0,
  );
});
test('idempotency is canonical, tenant scoped and preserves original fanout', (t) => {
  const f = fixture(t);
  const first = f.store.publish(f.a.id, 'order.created', { b: 2, a: 1 }, 'same');
  f.store.createEndpoint(f.a.id, { name: 'Added later', targetId: 'primary', subscription: '*' });
  assert.deepEqual(f.store.publish(f.a.id, 'order.created', { a: 1, b: 2 }, 'same'), {
    ...first,
    created: false,
  });
  assert.throws(
    () => f.store.publish(f.a.id, 'order.created', { a: 2 }, 'same'),
    /different event/,
  );
  assert.notEqual(f.store.publish(f.b.id, 'order.created', {}, 'same').id, first.id);
});
test('composite foreign keys reject cross-tenant delivery links', (t) => {
  const f = fixture(t),
    endpoint = f.store.createEndpoint(f.b.id, {
      name: 'Other',
      targetId: 'primary',
      subscription: '*',
    });
  const event = f.store.publish(f.a.id, 'order.created', {}, 'a');
  assert.throws(
    () =>
      f.store.db
        .prepare(
          "INSERT INTO deliveries(id,tenant_id,event_id,endpoint_id,state,attempts,total_attempts,available_at,created_at,updated_at) VALUES('bad',?,?,?,'pending',0,0,0,0,0)",
        )
        .run(f.a.id, event.id, endpoint.id),
    /FOREIGN KEY/,
  );
});
test('expired worker cannot complete a reclaimed lease', (t) => {
  const f = fixture(t);
  f.store.createEndpoint(f.a.id, { name: 'All', targetId: 'primary', subscription: '*' });
  f.store.publish(f.a.id, 'order.created', {}, 'a');
  const old = f.store.claim(1000)!;
  f.advance(1000);
  assert.equal(f.store.finish(old, ok), false);
  const current = f.store.claim(1000)!;
  assert.notEqual(current.token, old.token);
  assert.equal(f.store.finish(old, ok), false);
  assert.equal(f.store.finish(current, ok), true);
  assert.equal(f.store.snapshot(f.a.id).counts.succeeded, 1);
  assert.equal(f.store.attempts(f.a.id, old.id).length, 2);
});
test('retry budget, dead-letter replay and immutable attempt history', (t) => {
  const f = fixture(t);
  f.store.createEndpoint(f.a.id, { name: 'All', targetId: 'primary', subscription: '*' });
  f.store.publish(f.a.id, 'order.created', {}, 'a');
  let id = '';
  for (let i = 0; i < 5; i++) {
    const lease = f.store.claim()!;
    id = lease.id;
    f.store.finish(lease, { status: 503, error: null, durationMs: 10, retryAfter: '10' });
    if (i < 4) assert.equal(f.store.claim(), undefined);
    f.advance(400_000);
  }
  assert.equal(f.store.snapshot(f.a.id).counts.dead, 1);
  assert.throws(() => f.store.replay(f.b.id, id, 'wrong tenant'), /not found/);
  f.store.replay(f.a.id, id, 'Receiver configuration corrected');
  const replay = f.store.claim()!;
  assert.equal(replay.attempt, 6);
  f.store.finish(replay, ok);
  assert.equal(f.store.attempts(f.a.id, id).length, 6);
  assert.throws(() => f.store.replay(f.a.id, id, 'already done'), /Only dead/);
});
test('permanent 4xx is dead immediately; disabled endpoints pause future claims', (t) => {
  const f = fixture(t),
    endpoint = f.store.createEndpoint(f.a.id, {
      name: 'All',
      targetId: 'primary',
      subscription: '*',
    });
  f.store.publish(f.a.id, 'order.created', {}, 'a');
  f.store.setEndpoint(f.a.id, endpoint.id, false);
  assert.equal(f.store.claim(), undefined);
  f.store.setEndpoint(f.a.id, endpoint.id, true);
  f.store.finish(f.store.claim()!, { status: 401, error: null, durationMs: 1, retryAfter: null });
  assert.equal(f.store.snapshot(f.a.id).counts.dead, 1);
  assert.equal(f.store.claim(), undefined);
});
test('keyset pagination stays tenant scoped without overlap', (t) => {
  const f = fixture(t);
  f.store.createEndpoint(f.a.id, { name: 'All', targetId: 'primary', subscription: '*' });
  for (let i = 0; i < 31; i++) f.store.publish(f.a.id, 'order.created', { i }, `a-${i}`);
  const first = f.store.snapshot(f.a.id),
    second = f.store.snapshot(f.a.id, null, first.nextCursor);
  assert.equal(first.deliveries.length, 25);
  assert.equal(second.deliveries.length, 6);
  const ids = [...first.deliveries, ...second.deliveries].map((row) => (row as { id: string }).id);
  assert.equal(new Set(ids).size, 31);
  assert.equal(f.store.snapshot(f.b.id, null, first.nextCursor).deliveries.length, 0);
  assert.throws(() => f.store.snapshot(f.a.id, null, 'invalid'), /Invalid pagination/);
});
test('jobs and encrypted endpoint secrets survive reopen', (t) => {
  const f = fixture(t),
    endpoint = f.store.createEndpoint(f.a.id, {
      name: 'All',
      targetId: 'primary',
      subscription: '*',
    });
  f.store.publish(f.a.id, 'order.created', {}, 'a');
  const reopened = new Store(
    f.path,
    new Vault(testKey),
    targets([{ id: 'primary', url: 'https://receiver.example.test/hooks' }]),
    f.now,
  );
  try {
    assert.equal(reopened.claim()!.secret, endpoint.signingSecret);
  } finally {
    reopened.close();
  }
});
test('separate worker processes cannot claim the same delivery', async (t) => {
  const f = fixture(t);
  f.store.createEndpoint(f.a.id, { name: 'All', targetId: 'primary', subscription: '*' });
  for (let i = 0; i < 30; i++) f.store.publish(f.a.id, 'order.created', { i }, `a-${i}`);
  const child = fileURLToPath(new URL('./claim-process.js', import.meta.url));
  const run = () =>
    new Promise<string[]>((resolve, reject) => {
      const proc = spawn(process.execPath, [child, f.path, String(f.now())], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '',
        errors = '';
      proc.stdout.on('data', (data) => {
        output += String(data);
      });
      proc.stderr.on('data', (data) => {
        errors += String(data);
      });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve(JSON.parse(output) as string[]);
        else reject(new Error(errors));
      });
    });
  const ids = (await Promise.all([run(), run(), run(), run()])).flat();
  assert.equal(ids.length, 30);
  assert.equal(new Set(ids).size, 30);
});
