import { configuredStore } from './config.js';
import { server } from './server.js';
import { Worker } from './worker.js';
import { transport } from './transport.js';

const store = configuredStore(),
  app = server(store),
  worker = new Worker(store, transport());
const port = Number(process.env['PORT'] ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
app.listen(port, '127.0.0.1', () => {
  worker.start();
  console.log(`Dispatch Ledger: http://127.0.0.1:${port}`);
});
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await new Promise<void>((resolve) => {
    app.close(() => resolve());
    app.closeIdleConnections();
  });
  await worker.stop();
  store.close();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
