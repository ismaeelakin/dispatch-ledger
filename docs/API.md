# HTTP API

Default base URL: `http://127.0.0.1:8080`. Requests to `/api/overview`, endpoint operations, events and attempt history need `Authorization: Bearer <tenant-token>`. POST bodies use `application/json`. Unknown fields are rejected.

| Method / route                      | Request                                      | Result                                                                                           |
| ----------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /health`                       | None                                         | `{status:"ok"}`                                                                                  |
| `GET /api/config`                   | None                                         | Demo flag and configured target IDs; no target URLs or credentials                               |
| `GET /api/overview`                 | Optional `state`, `cursor`                   | Tenant name, all-state counts, 25 deliveries, next cursor, endpoints and latest 15 audit entries |
| `POST /api/events`                  | Header `Idempotency-Key`; body `{type,data}` | 201 `{id,created:true,deliveries}` or 200 original event                                         |
| `POST /api/endpoints`               | `{name,targetId,subscription}`               | 201 `{id,signingSecret}`; secret is returned once                                                |
| `POST /api/endpoints/{id}/state`    | `{active:boolean}`                           | `{ok:true}`                                                                                      |
| `GET /api/deliveries/{id}/attempts` | None                                         | Ordered attempt metadata; no response body, payload or secret                                    |
| `POST /api/deliveries/{id}/replay`  | `{reason}`                                   | `{ok:true}`; dead deliveries only                                                                |

Errors use `{error:{code,message}}`: 400 validation, 401 invalid/missing token, 403 Host/Origin, 404 foreign/missing resource or route, 409 changed idempotency request or invalid state, 413 body size, 415 content type, 429 tenant rate limit, 503 temporary service/storage failure. Rate-limit responses include `Retry-After` delta seconds.

Limits: 120 authenticated requests/minute/tenant/process; 20 endpoints/tenant; 60,000 bytes of canonical event data; 64 KiB complete HTTP body; JSON depth 32; event names 1–80 lowercase characters matching `order.created`-style components; names 1–80; keys 1–128; replay reason 1–200. Times are integer Unix milliseconds unless noted. Counts include delayed pending jobs and all states, even when a list is filtered. Keyset cursors are opaque to clients; never parse or construct them.

## Signing protocol

```text
X-Dispatch-Id: stable delivery UUID
X-Dispatch-Endpoint: endpoint UUID
X-Dispatch-Timestamp: Unix seconds for this attempt
X-Dispatch-Signature: v1=<lowercase HMAC-SHA256 hex>

signed bytes = timestamp + "." + delivery_id + "." + exact_utf8_body
```

The body is an immutable envelope `{id,type,created_at,data}`. `id` identifies the event; `X-Dispatch-Id` identifies one event-to-endpoint delivery and stays stable across retries and replay. Each attempt gets a fresh timestamp/signature. A successful acknowledgment is any 2xx response header status. Response bodies are not read or saved, and redirects are never followed.

Use `verify()` from `src/domain.ts` with raw bytes decoded consistently as UTF-8, or implement the same HMAC contract in your receiver. Compare digests in constant time, reject timestamps outside ±300 seconds, then atomically deduplicate delivery ID with the business update. Do not parse and reserialize JSON before checking the signature.
