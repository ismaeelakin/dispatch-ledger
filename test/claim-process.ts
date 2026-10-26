import { Store } from '../src/store.js';
import { Vault, targets } from '../src/domain.js';
const path = process.argv[2]!,
  now = Number(process.argv[3]);
const store = new Store(
  path,
  new Vault(Buffer.alloc(32, 7)),
  targets([{ id: 'primary', url: 'https://receiver.example.test/hooks' }]),
  () => now,
);
const ids: string[] = [];
try {
  for (;;) {
    const lease = store.claim();
    if (!lease) break;
    ids.push(lease.id);
  }
} finally {
  store.close();
}
process.stdout.write(JSON.stringify(ids));
