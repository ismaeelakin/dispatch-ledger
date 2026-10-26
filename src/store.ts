import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Vault,
  bad,
  canonical,
  conflict,
  digest,
  eventType,
  notFound,
  retryable,
  retryDelay,
  text,
  token,
  type DeliveryState,
  type Lease,
  type Outcome,
  type Target,
} from './domain.js';

interface EndpointRow {
  id: string;
  tenant_id: string;
  name: string;
  target_id: string;
  subscription: string;
  active: number;
  secret: string;
  created_at: number;
}
interface DeliveryRow {
  id: string;
  tenant_id: string;
  endpoint_id: string;
  event_id: string;
  state: DeliveryState;
  attempts: number;
  total_attempts: number;
  available_at: number;
  lease_until: number | null;
  lease_token: string | null;
  last_status: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}
interface EventRow {
  id: string;
  tenant_id: string;
  type: string;
  body: string;
  fingerprint: string;
  created_at: number;
}
export interface Tenant {
  id: string;
  name: string;
}

export class Store {
  readonly db: DatabaseSync;
  constructor(
    path: string,
    private readonly vault: Vault,
    readonly targetMap: ReadonlyMap<string, Target>,
    private readonly clock: () => number = Date.now,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;',
    );
    const version = this.one<{ user_version: number }>('PRAGMA user_version')!.user_version;
    if (version !== 0 && version !== 1) {
      this.db.close();
      throw new Error('Unsupported database schema version');
    }
    if (version === 0) {
      try {
        this.tx(() => {
          // A second process may have migrated while this one waited for the lock.
          const lockedVersion = this.one<{ user_version: number }>(
            'PRAGMA user_version',
          )!.user_version;
          if (lockedVersion === 0)
            this.db.exec(
              readFileSync(new URL('../../migrations/001_initial.sql', import.meta.url), 'utf8'),
            );
          else if (lockedVersion !== 1) throw new Error('Unsupported database schema version');
        });
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
  }
  close(): void {
    this.db.close();
  }
  private one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  private write(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params);
  }
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private audit(
    tenant: string,
    action: string,
    resource: string,
    detail: string,
    now: number,
  ): void {
    this.write(
      'INSERT INTO audit(id,tenant_id,action,resource_id,detail,created_at) VALUES(?,?,?,?,?,?)',
      randomUUID(),
      tenant,
      action,
      resource,
      detail,
      now,
    );
  }
  provision(name: string, suppliedToken?: string): Tenant & { apiToken: string } {
    text(name, 'name', 1, 80);
    const apiToken = suppliedToken ?? token();
    text(apiToken, 'API token', 24, 128);
    const id = randomUUID();
    this.tx(() => {
      this.write(
        'INSERT INTO tenants(id,name,token_hash) VALUES(?,?,?)',
        id,
        name,
        digest(apiToken),
      );
      this.audit(id, 'tenant.created', id, 'Tenant provisioned', this.clock());
    });
    return { id, name, apiToken };
  }
  authenticate(apiToken: string): Tenant | undefined {
    if (apiToken.length < 24 || apiToken.length > 128) return undefined;
    return this.one<Tenant>('SELECT id,name FROM tenants WHERE token_hash=?', digest(apiToken));
  }
  createEndpoint(
    tenantId: string,
    input: { name: unknown; targetId: unknown; subscription: unknown },
  ): { id: string; signingSecret: string } {
    const name = text(input.name, 'name', 1, 80);
    const targetId = text(input.targetId, 'targetId', 1, 40);
    if (!this.targetMap.has(targetId)) bad('Unknown configured target');
    const subscription = input.subscription === '*' ? '*' : eventType(input.subscription);
    const id = randomUUID(),
      signingSecret = token();
    this.tx(() => {
      if (
        this.one<{ n: number }>('SELECT COUNT(*) n FROM endpoints WHERE tenant_id=?', tenantId)!
          .n >= 20
      )
        bad('Tenant endpoint limit reached (20)');
      const now = this.clock();
      this.write(
        'INSERT INTO endpoints(id,tenant_id,name,target_id,subscription,active,secret,created_at) VALUES(?,?,?,?,?,1,?,?)',
        id,
        tenantId,
        name,
        targetId,
        subscription,
        this.vault.seal(signingSecret, `${tenantId}:${id}`),
        now,
      );
      this.audit(
        tenantId,
        'endpoint.created',
        id,
        `Target ${targetId}; subscription ${subscription}`,
        now,
      );
    });
    return { id, signingSecret };
  }
  endpoints(tenantId: string): Omit<EndpointRow, 'secret' | 'tenant_id'>[] {
    return this.all(
      'SELECT id,name,target_id,subscription,active,created_at FROM endpoints WHERE tenant_id=? ORDER BY created_at,id',
      tenantId,
    );
  }
  setEndpoint(tenantId: string, id: string, active: unknown): void {
    if (typeof active !== 'boolean') bad('active must be boolean');
    this.tx(() => {
      if (!this.one('SELECT id FROM endpoints WHERE id=? AND tenant_id=?', id, tenantId))
        notFound();
      this.write(
        'UPDATE endpoints SET active=? WHERE id=? AND tenant_id=?',
        active ? 1 : 0,
        id,
        tenantId,
      );
      this.audit(
        tenantId,
        active ? 'endpoint.enabled' : 'endpoint.disabled',
        id,
        'Operator changed endpoint state',
        this.clock(),
      );
    });
  }
  publish(
    tenantId: string,
    typeInput: unknown,
    data: unknown,
    keyInput: unknown,
  ): { id: string; deliveries: number; created: boolean } {
    const type = eventType(typeInput),
      key = text(keyInput, 'Idempotency-Key', 1, 128);
    const normalized = canonical(data),
      fingerprint = digest(`${type}\n${normalized}`);
    return this.tx(() => {
      const previous = this.one<EventRow>(
        'SELECT * FROM events WHERE tenant_id=? AND idempotency_key=?',
        tenantId,
        key,
      );
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          conflict('Idempotency key belongs to a different event');
        return {
          id: previous.id,
          deliveries: this.one<{ n: number }>(
            'SELECT COUNT(*) n FROM deliveries WHERE tenant_id=? AND event_id=?',
            tenantId,
            previous.id,
          )!.n,
          created: false,
        };
      }
      const now = this.clock(),
        id = randomUUID();
      const body = `{"id":${JSON.stringify(id)},"type":${JSON.stringify(type)},"created_at":${now},"data":${normalized}}`;
      this.write(
        'INSERT INTO events(id,tenant_id,type,body,fingerprint,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?)',
        id,
        tenantId,
        type,
        body,
        fingerprint,
        key,
        now,
      );
      const endpoints = this.all<EndpointRow>(
        "SELECT * FROM endpoints WHERE tenant_id=? AND active=1 AND (subscription='*' OR subscription=?)",
        tenantId,
        type,
      );
      for (const endpoint of endpoints)
        this.write(
          "INSERT INTO deliveries(id,tenant_id,event_id,endpoint_id,state,attempts,total_attempts,available_at,created_at,updated_at) VALUES(?,?,?,?,'pending',0,0,?,?,?)",
          randomUUID(),
          tenantId,
          id,
          endpoint.id,
          now,
          now,
          now,
        );
      this.audit(tenantId, 'event.accepted', id, `${type}; ${endpoints.length} deliveries`, now);
      return { id, deliveries: endpoints.length, created: true };
    });
  }
  claim(leaseMs = 15_000): Lease | undefined {
    if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 60_000)
      throw new Error('Invalid lease duration');
    return this.tx(() => {
      const now = this.clock();
      const expired = this.all<DeliveryRow>(
        "SELECT * FROM deliveries WHERE state='in_flight' AND lease_until<=?",
        now,
      );
      for (const row of expired) {
        this.write(
          'INSERT INTO attempts(delivery_id,tenant_id,sequence,status,error,duration_ms,created_at) VALUES(?,?,?,NULL,?,0,?)',
          row.id,
          row.tenant_id,
          row.total_attempts,
          'worker_lost',
          now,
        );
        this.write(
          "UPDATE deliveries SET state=?,lease_until=NULL,lease_token=NULL,last_error='worker_lost',updated_at=? WHERE id=?",
          row.attempts >= 5 ? 'dead' : 'pending',
          now,
          row.id,
        );
        this.audit(row.tenant_id, 'delivery.lease_expired', row.id, 'Worker lease expired', now);
      }
      const row = this.one<DeliveryRow & { target_id: string; secret: string; body: string }>(
        `SELECT d.*,e.target_id,e.secret,v.body FROM deliveries d
        JOIN endpoints e ON e.id=d.endpoint_id AND e.tenant_id=d.tenant_id
        JOIN events v ON v.id=d.event_id AND v.tenant_id=d.tenant_id
        WHERE d.state='pending' AND d.available_at<=? AND e.active=1
        ORDER BY d.available_at,d.created_at,d.id LIMIT 1`,
        now,
      );
      if (!row) return undefined;
      // Decrypt before mutation. A wrong key or damaged ciphertext rolls back.
      const secret = this.vault.open(row.secret, `${row.tenant_id}:${row.endpoint_id}`);
      const leaseToken = token();
      this.write(
        "UPDATE deliveries SET state='in_flight',attempts=attempts+1,total_attempts=total_attempts+1,lease_until=?,lease_token=?,updated_at=? WHERE id=?",
        now + leaseMs,
        leaseToken,
        now,
        row.id,
      );
      return {
        id: row.id,
        tenantId: row.tenant_id,
        endpointId: row.endpoint_id,
        eventId: row.event_id,
        targetId: row.target_id,
        body: row.body,
        secret,
        token: leaseToken,
        attempt: row.total_attempts + 1,
      };
    });
  }
  finish(lease: Lease, outcome: Outcome): boolean {
    return this.tx(() => {
      const now = this.clock();
      const row = this.one<DeliveryRow>(
        "SELECT * FROM deliveries WHERE id=? AND tenant_id=? AND state='in_flight' AND lease_token=? AND lease_until>?",
        lease.id,
        lease.tenantId,
        lease.token,
        now,
      );
      if (!row) return false;
      const success =
        outcome.status !== null &&
        outcome.status >= 200 &&
        outcome.status < 300 &&
        outcome.error === null;
      const state: DeliveryState = success
        ? 'succeeded'
        : retryable(outcome) && row.attempts < 5
          ? 'pending'
          : 'dead';
      const delay =
        state === 'pending' ? retryDelay(row.id, row.attempts, outcome.retryAfter) * 1000 : 0;
      const error = outcome.error ?? (success ? null : `http_${outcome.status}`);
      this.write(
        'INSERT INTO attempts(delivery_id,tenant_id,sequence,status,error,duration_ms,created_at) VALUES(?,?,?,?,?,?,?)',
        row.id,
        row.tenant_id,
        row.total_attempts,
        outcome.status,
        error,
        Math.round(outcome.durationMs),
        now,
      );
      this.write(
        'UPDATE deliveries SET state=?,available_at=?,lease_until=NULL,lease_token=NULL,last_status=?,last_error=?,updated_at=? WHERE id=?',
        state,
        now + delay,
        outcome.status,
        error,
        now,
        row.id,
      );
      this.audit(
        row.tenant_id,
        `delivery.${state}`,
        row.id,
        success ? 'Receiver acknowledged' : (error ?? 'Delivery failed'),
        now,
      );
      return true;
    });
  }
  replay(tenantId: string, id: string, reasonInput: unknown): void {
    const reason = text(reasonInput, 'reason', 1, 200);
    this.tx(() => {
      const row = this.one<DeliveryRow>(
        'SELECT * FROM deliveries WHERE id=? AND tenant_id=?',
        id,
        tenantId,
      );
      if (!row) return notFound();
      if (row.state !== 'dead') conflict('Only dead deliveries can be replayed');
      const now = this.clock();
      this.write(
        "UPDATE deliveries SET state='pending',attempts=0,available_at=?,updated_at=?,last_error=NULL,last_status=NULL WHERE id=? AND tenant_id=?",
        now,
        now,
        id,
        tenantId,
      );
      this.audit(tenantId, 'delivery.replayed', id, reason, now);
    });
  }
  snapshot(
    tenantId: string,
    stateInput: string | null = null,
    cursor: string | null = null,
  ): {
    counts: Record<DeliveryState, number>;
    deliveries: unknown[];
    nextCursor: string | null;
    endpoints: unknown[];
    audit: unknown[];
  } {
    const states: DeliveryState[] = ['pending', 'in_flight', 'succeeded', 'dead'];
    if (stateInput !== null && !states.includes(stateInput as DeliveryState))
      bad('Unknown delivery state');
    let before: [number, string] | undefined;
    if (cursor) {
      try {
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) throw new Error();
        const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (
          !Array.isArray(value) ||
          value.length !== 2 ||
          !Number.isSafeInteger(value[0]) ||
          typeof value[1] !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(value[1])
        )
          throw new Error();
        before = value as [number, string];
      } catch {
        bad('Invalid pagination cursor');
      }
    }
    this.db.exec('BEGIN');
    try {
      const counts: Record<DeliveryState, number> = {
        pending: 0,
        in_flight: 0,
        succeeded: 0,
        dead: 0,
      };
      for (const row of this.all<{ state: DeliveryState; n: number }>(
        'SELECT state,COUNT(*) n FROM deliveries WHERE tenant_id=? GROUP BY state',
        tenantId,
      ))
        counts[row.state] = row.n;
      const params: SQLInputValue[] = [tenantId];
      let where = 'd.tenant_id=?';
      if (stateInput) {
        where += ' AND d.state=?';
        params.push(stateInput);
      }
      if (before) {
        where += ' AND (d.created_at<? OR (d.created_at=? AND d.id<?))';
        params.push(before[0], before[0], before[1]);
      }
      const rows = this.all<DeliveryRow & { type: string; endpoint_name: string }>(
        `SELECT d.id,d.event_id,d.endpoint_id,d.state,d.attempts,d.total_attempts,d.available_at,d.last_status,d.last_error,d.created_at,d.updated_at,v.type,e.name endpoint_name
        FROM deliveries d JOIN events v ON v.id=d.event_id AND v.tenant_id=d.tenant_id JOIN endpoints e ON e.id=d.endpoint_id AND e.tenant_id=d.tenant_id
        WHERE ${where} ORDER BY d.created_at DESC,d.id DESC LIMIT 26`,
        ...params,
      );
      const page = rows.slice(0, 25),
        last = page.at(-1);
      const nextCursor =
        rows.length > 25 && last
          ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString('base64url')
          : null;
      const audit = this.all(
        'SELECT action,resource_id,detail,created_at FROM audit WHERE tenant_id=? ORDER BY created_at DESC,rowid DESC LIMIT 15',
        tenantId,
      );
      const endpoints = this.endpoints(tenantId);
      this.db.exec('COMMIT');
      return { counts, deliveries: page, nextCursor, endpoints, audit };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  attempts(tenantId: string, id: string): unknown[] {
    if (!this.one('SELECT id FROM deliveries WHERE id=? AND tenant_id=?', id, tenantId)) notFound();
    return this.all(
      'SELECT sequence,status,error,duration_ms,created_at FROM attempts WHERE tenant_id=? AND delivery_id=? ORDER BY sequence',
      tenantId,
      id,
    );
  }
  receiverSecret(endpointId: string): string | undefined {
    const row = this.one<EndpointRow>('SELECT * FROM endpoints WHERE id=?', endpointId);
    return row ? this.vault.open(row.secret, `${row.tenant_id}:${row.id}`) : undefined;
  }
  receiveOnce(deliveryId: string): boolean {
    return (
      Number(
        this.db
          .prepare('INSERT OR IGNORE INTO demo_inbox(delivery_id,created_at) VALUES(?,?)')
          .run(deliveryId, this.clock()).changes,
      ) === 1
    );
  }
}
