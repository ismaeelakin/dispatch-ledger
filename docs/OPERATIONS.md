# Operations and failure drills

## Startup

Install Node 22.16+ and run `npm ci && npm run build`. Provision tenants with a stable configured master key and target map. Protect the newly printed API token and returned endpoint signing secrets. The service does not read `.env` automatically.

Database, WAL and SHM files belong on local disk. Treat database contents as sensitive because payloads and audit reasons are not encrypted. Keep the master key outside the database and retain a protected backup of it. SQLite backups should use a consistent SQLite backup mechanism; copying only the main file while WAL writes are active is not a backup procedure.

## Practical drills

1. **Producer retry:** post identical type/data/key twice. Expect the same event ID and no additional delivery rows. Change data with the same key; expect 409.
2. **Temporary receiver outage:** in the demo, inspect `invoice.paid`. Two 503s should precede a 204. Status, duration and sequence are visible in attempt history.
3. **Permanent failure:** inspect the demo `customer.updated` 422. Replay with an explicit reason. The history remains, and another 422 will return it to dead letter.
4. **Tenant boundary:** switch the demo to Northstar. Only its analytics subscription and event are visible. Automated tests also try to mutate foreign resource UUIDs directly.
5. **Crash recovery:** the process-level claim tests show exclusivity; injected-clock tests expire a lease and reject the stale worker's result before allowing a new lease to complete.
6. **Endpoint pause:** disable an endpoint, publish a matching event and confirm that new fanout excludes it. Already-existing pending deliveries pause until it is enabled.

## Shutdown and recovery

Normal shutdown closes the API, waits for the active bounded worker tick, then closes SQLite. If the process is killed, the next claim transaction records any expired in-flight attempt as `worker_lost`; the delivery is retried or dead-lettered according to its budget. A receiver may already have performed the side effect.

If the master key is wrong or ciphertext was swapped/tampered with, decryption fails before claim mutation. Fix configuration rather than repeatedly replaying work. A target removed from configuration becomes a permanent 410-style worker result; existing target identities should therefore be managed deliberately.

## Deliberate limits

There is no retention/compaction policy, distributed quota, token/key rotation workflow, production telemetry exporter, long-polling, receiver circuit breaker, ordered delivery, global tenant fairness, or public TLS/connection-limiting adapter. Audit records are append-only by application convention, not tamper-evident against a database administrator. Request rate limits reset on restart and are not shared between processes.

Before a public deployment, add those controls according to actual requirements and load measurements. Before claiming throughput, measure enqueue/claim latency, SQLite lock wait, event-loop delay, database growth and behavior under a slow receiver with the same workload and build settings.
