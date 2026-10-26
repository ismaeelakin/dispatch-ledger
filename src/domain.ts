import {
  createHash,
  createHmac,
  timingSafeEqual,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';

export class Problem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const bad = (message: string): never => {
  throw new Problem(400, 'invalid_request', message);
};
export const notFound = (): never => {
  throw new Problem(404, 'not_found', 'Resource not found');
};
export const conflict = (message: string): never => {
  throw new Problem(409, 'conflict', message);
};

export function text(value: unknown, field: string, min = 1, max = 128): string {
  if (typeof value !== 'string' || value.length < min || value.length > max)
    return bad(`${field} must contain ${min}–${max} characters`);
  return value;
}
export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return bad('Expected a JSON object');
  return value as Record<string, unknown>;
}
export function fields(input: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key))) bad('Unknown request field');
}
export function eventType(value: unknown): string {
  const result = text(value, 'type', 1, 80);
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(result))
    bad('type must be a lowercase event name, such as order.created');
  return result;
}
export function canonical(value: unknown): string {
  // Sorting entry arrays, rather than assigning to {}, handles __proto__ safely.
  function normalize(v: unknown, depth: number): unknown {
    if (depth > 32) return bad('JSON exceeds 32 nesting levels');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map((item) => normalize(item, depth + 1));
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, item]) => [k, normalize(item, depth + 1)]),
      );
    return bad('data must be finite JSON');
  }
  const result = JSON.stringify(normalize(value, 0));
  if (Buffer.byteLength(result) > 60_000) bad('data exceeds 60000 encoded bytes');
  return result;
}
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const token = (): string => randomBytes(32).toString('base64url');

export class Vault {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Master key must decode to 32 bytes');
  }
  seal(secret: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
  }
  open(encrypted: string, context: string): string {
    const [iv, tag, body] = encrypted.split('.').map((part) => Buffer.from(part, 'base64url'));
    if (!iv || !tag || !body) throw new Error('Invalid ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }
}

export function signature(
  secret: string,
  timestamp: string,
  deliveryId: string,
  body: string,
): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.${body}`).digest('hex')}`;
}
export function verify(
  secret: string,
  timestamp: string,
  deliveryId: string,
  body: string,
  supplied: string,
  nowSeconds: number,
): boolean {
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > 300) return false;
  if (!/^v1=[a-f0-9]{64}$/.test(supplied)) return false;
  return timingSafeEqual(
    Buffer.from(signature(secret, timestamp, deliveryId, body)),
    Buffer.from(supplied),
  );
}

export interface Target {
  id: string;
  url: string;
}
export function targets(input: Target[], allowLocal = false): ReadonlyMap<string, Target> {
  if (input.length === 0 || input.length > 20) throw new Error('Configure 1–20 trusted targets');
  const output = new Map<string, Target>();
  for (const target of input) {
    if (!/^[a-z0-9_-]{1,40}$/.test(target.id) || output.has(target.id))
      throw new Error('Target IDs must be unique lowercase names');
    const url = new URL(target.url);
    const local = allowLocal && url.protocol === 'http:' && url.hostname === '127.0.0.1';
    if (
      (!local && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error(
        'Targets require HTTPS without credentials, query or fragment; explicit demo mode permits 127.0.0.1 HTTP',
      );
    output.set(target.id, Object.freeze({ id: target.id, url: url.href }));
  }
  return output;
}

export type DeliveryState = 'pending' | 'in_flight' | 'succeeded' | 'dead';
export interface Lease {
  id: string;
  tenantId: string;
  endpointId: string;
  eventId: string;
  targetId: string;
  body: string;
  secret: string;
  token: string;
  attempt: number;
}
export interface Outcome {
  status: number | null;
  error: 'timeout' | 'network' | null;
  durationMs: number;
  retryAfter: string | null;
}
export function retryDelay(id: string, attempt: number, retryAfter: string | null): number {
  const base = Math.min(256, 2 ** Math.min(attempt, 8));
  const jitter =
    parseInt(digest(`${id}:${attempt}`).slice(0, 4), 16) % Math.max(1, Math.ceil(base / 4));
  const requested =
    retryAfter && /^\d{1,6}$/.test(retryAfter) ? Math.min(300, Number(retryAfter)) : 0;
  return Math.min(300, Math.max(base + jitter, requested));
}
export const retryable = (outcome: Outcome): boolean =>
  outcome.error !== null ||
  outcome.status === 408 ||
  outcome.status === 425 ||
  outcome.status === 429 ||
  (outcome.status !== null && outcome.status >= 500);
