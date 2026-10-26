import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Vault, targets, type Target } from './domain.js';
import { Store } from './store.js';

export function configuredStore(): Store {
  const key = process.env['DISPATCH_MASTER_KEY'] ?? '';
  if (!/^[a-f0-9]{64}$/.test(key))
    throw new Error('Set DISPATCH_MASTER_KEY to 32 bytes encoded as 64 lowercase hex characters');
  const raw: unknown = JSON.parse(process.env['DISPATCH_TARGETS'] ?? '[]');
  if (
    !Array.isArray(raw) ||
    raw.some(
      (item) =>
        !item ||
        typeof item !== 'object' ||
        typeof item.id !== 'string' ||
        typeof item.url !== 'string',
    )
  )
    throw new Error('DISPATCH_TARGETS must be a JSON array of {id,url}');
  const path = resolve(process.env['DISPATCH_DB'] ?? 'data/dispatch.db');
  mkdirSync(dirname(path), { recursive: true });
  return new Store(path, new Vault(Buffer.from(key, 'hex')), targets(raw as Target[]));
}
