import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Vault, targets, verify } from './domain.js';
import { Store } from './store.js';
import { Worker } from './worker.js';
import { transport } from './transport.js';
import { server } from './server.js';

export const demoTokens = {
  acme: 'demo_acme_public_token_0000000001',
  northstar: 'demo_northstar_public_token_00001',
};
const directory = mkdtempSync(join(resolve('.'), 'demo-data-'));
const receiverPort = Number(process.env['DEMO_RECEIVER_PORT'] ?? 9081),
  apiPort = Number(process.env['PORT'] ?? 8080);
const store = new Store(
  join(directory, 'ledger.db'),
  new Vault(randomBytes(32)),
  targets(
    [
      { id: 'healthy', url: `http://127.0.0.1:${receiverPort}/healthy` },
      { id: 'flaky', url: `http://127.0.0.1:${receiverPort}/flaky` },
      { id: 'rejected', url: `http://127.0.0.1:${receiverPort}/rejected` },
    ],
    true,
  ),
);
const failures = new Map<string, number>();
const receiver = createServer((req, res) => {
  let raw = '',
    bytes = 0;
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 65_536) req.destroy();
    else raw += String(chunk);
  });
  req.on('end', () => {
    const endpointId = String(req.headers['x-dispatch-endpoint'] ?? ''),
      id = String(req.headers['x-dispatch-id'] ?? '');
    const secret = store.receiverSecret(endpointId);
    if (
      !secret ||
      !verify(
        secret,
        String(req.headers['x-dispatch-timestamp']),
        id,
        raw,
        String(req.headers['x-dispatch-signature']),
        Math.floor(Date.now() / 1000),
      )
    ) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.url === '/rejected') {
      res.writeHead(422);
      res.end();
      return;
    }
    const attempt = (failures.get(id) ?? 0) + 1;
    failures.set(id, attempt);
    if (req.url === '/flaky' && attempt < 3) {
      res.writeHead(503, { 'Retry-After': '3' });
      res.end();
      return;
    }
    store.receiveOnce(id); // Atomic duplicate suppression before the demo acknowledgment.
    res.writeHead(204);
    res.end();
  });
});
const acme = store.provision('Acme Commerce', demoTokens.acme),
  northstar = store.provision('Northstar Labs', demoTokens.northstar);
store.createEndpoint(acme.id, {
  name: 'Order fulfillment',
  targetId: 'healthy',
  subscription: 'order.created',
});
store.createEndpoint(acme.id, {
  name: 'Accounting sync',
  targetId: 'flaky',
  subscription: 'invoice.paid',
});
store.createEndpoint(acme.id, {
  name: 'Legacy CRM',
  targetId: 'rejected',
  subscription: 'customer.updated',
});
store.createEndpoint(northstar.id, {
  name: 'Product analytics',
  targetId: 'healthy',
  subscription: '*',
});
for (let i = 0; i < 3; i++)
  store.publish(
    acme.id,
    'order.created',
    { order_id: `ORD-${1042 + i}`, total_minor: 12900 + i * 100, currency: 'USD' },
    `seed-order-${i}`,
  );
store.publish(
  acme.id,
  'invoice.paid',
  { invoice_id: 'INV-302', total_minor: 8400 },
  'seed-invoice',
);
store.publish(
  acme.id,
  'customer.updated',
  { customer_id: 'CUS-81', segment: 'business' },
  'seed-customer',
);
store.publish(northstar.id, 'workspace.created', { workspace_id: 'WS-12' }, 'northstar-seed');
const app = server(store, { demo: true }),
  worker = new Worker(store, transport());
receiver.listen(receiverPort, '127.0.0.1', () => {
  app.listen(apiPort, '127.0.0.1', () => {
    worker.start();
    console.log(
      `Dispatch Ledger demo: http://127.0.0.1:${apiPort}\nSynthetic tenants only. Database and encryption key are temporary; Ctrl+C removes the demo database.`,
    );
  });
});
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await new Promise<void>((resolve) => {
    app.close(() => resolve());
    app.closeAllConnections();
  });
  await worker.stop();
  await new Promise<void>((resolve) => {
    receiver.close(() => resolve());
    receiver.closeAllConnections();
  });
  store.close();
  // This exact directory was created above inside the current project.
  rmSync(directory, { recursive: true, force: true });
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
