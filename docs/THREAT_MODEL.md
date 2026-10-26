# Threat model

## Supported boundary

The service runs on one trusted host and binds to loopback. Operators control configuration, the master key, database files and provisioning. Tenants hold distinct bearer tokens and may publish events or manage subscriptions within their own tenant. Receivers may be slow, unavailable, malicious, or return misleading redirect destinations.

| Threat                                  | Implemented control                                                                      | Remaining boundary                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Tenant reads or mutates another tenant  | Tenant-scoped predicates, 404 for foreign resources, composite foreign keys              | Worker/CLI and host operators remain privileged                                            |
| Arbitrary URL / SSRF input              | API accepts target IDs only; operator URLs require HTTPS; no redirects                   | Allowlisted domains and DNS must be trusted; network egress controls are still necessary   |
| Endpoint-secret disclosure in DB backup | AES-256-GCM; tenant/endpoint identity as AAD; master key outside DB                      | Payloads and audit details are plaintext; a compromised process can use secrets            |
| API-token disclosure in DB              | Store SHA-256 digest of high-entropy random tokens                                       | Tokens are bearer capabilities; no automatic rotation or expiry in v0.1                    |
| Forged webhook attempt                  | HMAC over timestamp, delivery ID and exact bytes                                         | Receiver must keep secret, verify timestamp and deduplicate IDs                            |
| Signature replay                        | Five-minute time window; receiver inbox example                                          | Clock synchronization matters; the signature alone does not prevent duplicate side effects |
| Slow receiver / huge response           | Three-second timeout, bounded worker concurrency, response body discarded                | Per-endpoint circuit breaking and process memory limits are not implemented                |
| Browser script injection                | DOM `textContent`, no payload HTML, same-origin CSP, no external scripts                 | Browser extensions and host compromise are outside scope                                   |
| Browser-to-localhost writes             | Bearer authorization header, Origin/Host checks, JSON-only writes, no CORS               | Local processes with a token can access the service                                        |
| Request abuse                           | 64 KiB body cap, depth limit, target/endpoint limits, per-tenant fixed-window rate limit | Rate limit is per process; no global tenant storage quota or bounded connection pool       |
| Leaked receiver error body              | Persist status/error category only; discard response bodies                              | Operator replay reasons must not contain secrets                                           |

The public demo tokens are not valid in a separately provisioned database. Demo mode creates a random master key and temporary data for each run. Its local-only HTTP targets are enabled explicitly by the demo entry point, not the normal configuration loader.

The cryptographic primitives come from Node's standard library; they are not custom algorithms. The protocol is project-specific, not GitHub's webhook format. There has been no independent security audit. Do not expose this version directly to the internet or store sensitive event payloads without extending the deployment controls and retention model.
