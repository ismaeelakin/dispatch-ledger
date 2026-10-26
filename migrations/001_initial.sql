CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE
) STRICT;
CREATE TABLE endpoints (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  target_id TEXT NOT NULL,
  subscription TEXT NOT NULL,
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  secret TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(id,tenant_id)
) STRICT;
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(id,tenant_id),
  UNIQUE(tenant_id,idempotency_key)
) STRICT;
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','in_flight','succeeded','dead')),
  attempts INTEGER NOT NULL,
  total_attempts INTEGER NOT NULL,
  available_at INTEGER NOT NULL,
  lease_until INTEGER,
  lease_token TEXT,
  last_status INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(event_id,tenant_id) REFERENCES events(id,tenant_id),
  FOREIGN KEY(endpoint_id,tenant_id) REFERENCES endpoints(id,tenant_id),
  UNIQUE(event_id,endpoint_id),
  UNIQUE(id,tenant_id)
) STRICT;
CREATE INDEX deliveries_ready ON deliveries(state,available_at,created_at,id);
CREATE INDEX deliveries_tenant ON deliveries(tenant_id,created_at DESC,id DESC);
CREATE INDEX deliveries_expired ON deliveries(state,lease_until);
CREATE TABLE attempts (
  delivery_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  status INTEGER,
  error TEXT,
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(delivery_id,sequence),
  FOREIGN KEY(delivery_id,tenant_id) REFERENCES deliveries(id,tenant_id)
) STRICT;
CREATE TABLE audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  action TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX audit_tenant ON audit(tenant_id,created_at DESC);
CREATE TABLE demo_inbox (delivery_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL) STRICT;
PRAGMA user_version=1;
