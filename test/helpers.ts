import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { Vault, targets, type Target } from '../src/domain.js';
import { Store } from '../src/store.js';

export const testKey = Buffer.alloc(32, 7);
export function fixture(
  t: TestContext,
  targetInput: Target[] = [{ id: 'primary', url: 'https://receiver.example.test/hooks' }],
  local = false,
) {
  const directory = mkdtempSync(join(tmpdir(), 'dispatch-test-'));
  const path = join(directory, 'ledger.db');
  let now = 1_700_000_000_000;
  const store = new Store(path, new Vault(testKey), targets(targetInput, local), () => now);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const a = store.provision('Acme'),
    b = store.provision('Northstar');
  return {
    store,
    path,
    a,
    b,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
