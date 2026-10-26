import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault, canonical, retryDelay, signature, targets, verify } from '../src/domain.js';

test('HMAC covers raw bytes, timestamp and delivery identity', () => {
  const body = '{"event":"café"}',
    signed = signature('test-secret', '1700000000', 'delivery-a', body);
  assert.equal(verify('test-secret', '1700000000', 'delivery-a', body, signed, 1700000000), true);
  for (const [secret, timestamp, id, data] of [
    ['wrong', '1700000000', 'delivery-a', body],
    ['test-secret', '1700000001', 'delivery-a', body],
    ['test-secret', '1700000000', 'delivery-b', body],
    ['test-secret', '1700000000', 'delivery-a', body + ' '],
  ])
    assert.equal(verify(secret!, timestamp!, id!, data!, signed, 1700000000), false);
  assert.equal(verify('test-secret', '1700000000', 'delivery-a', body, signed, 1700000301), false);
  assert.equal(
    verify('test-secret', '1700000000', 'delivery-a', body, 'v1=oops', 1700000000),
    false,
  );
});
test('AES-GCM rejects ciphertext tampering, wrong key and swapped endpoint context', () => {
  const vault = new Vault(Buffer.alloc(32, 1)),
    sealed = vault.seal('secret-material', 'tenant-a:endpoint-a');
  assert.equal(vault.open(sealed, 'tenant-a:endpoint-a'), 'secret-material');
  assert.throws(() => vault.open(sealed, 'tenant-b:endpoint-a'));
  assert.throws(() => new Vault(Buffer.alloc(32, 2)).open(sealed, 'tenant-a:endpoint-a'));
  const [iv, tag, body] = sealed.split('.');
  const changed = Buffer.from(body!, 'base64url');
  changed[0] = changed[0]! ^ 1;
  assert.throws(() =>
    vault.open(`${iv}.${tag}.${changed.toString('base64url')}`, 'tenant-a:endpoint-a'),
  );
});
test('canonical JSON is stable, bounded and safe for special object keys', () => {
  assert.equal(canonical({ b: 2, a: [1, { z: true }] }), canonical({ a: [1, { z: true }], b: 2 }));
  assert.match(canonical(JSON.parse('{"__proto__":{"polluted":true}}')), /__proto__/);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  assert.throws(() => canonical({ n: NaN }));
  assert.throws(() => canonical('a'.repeat(60_001)));
  let deep: unknown = 0;
  for (let i = 0; i < 34; i++) deep = [deep];
  assert.throws(() => canonical(deep));
});
test('target policy rejects arbitrary insecure destinations and credentials', () => {
  for (const url of [
    'http://example.test/hook',
    'https://user:pass@example.test/hook',
    'https://example.test/hook?token=secret',
    'https://example.test/#fragment',
    'file:///etc/passwd',
  ]) {
    assert.throws(() => targets([{ id: 'primary', url }]));
  }
  assert.throws(() =>
    targets([
      { id: 'a', url: 'https://example.test' },
      { id: 'a', url: 'https://example.test' },
    ]),
  );
  assert.equal(targets([{ id: 'demo', url: 'http://127.0.0.1:9000/hook' }], true).size, 1);
  assert.throws(() => targets([{ id: 'demo', url: 'http://localhost:9000/hook' }], true));
});
test('retry delays are deterministic, bounded and honor capped delta Retry-After', () => {
  assert.equal(retryDelay('a', 3, null), retryDelay('a', 3, null));
  assert.equal(retryDelay('a', 1, '120'), 120);
  assert.equal(retryDelay('a', 1, '999999'), 300);
  assert.ok(retryDelay('a', 1, 'Wed, 21 Oct 2015 07:28:00 GMT') < 4);
  for (let n = 1; n < 100; n++) assert.ok(retryDelay('a', n, null) <= 300);
});
