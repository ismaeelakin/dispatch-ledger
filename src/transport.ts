import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { performance } from 'node:perf_hooks';
import { signature, type Lease, type Outcome, type Target } from './domain.js';

export type Transport = (lease: Lease, target: Target) => Promise<Outcome>;
export function transport(timeoutMs = 3000): Transport {
  return (lease, target) =>
    new Promise((resolve) => {
      const start = performance.now(),
        timestamp = String(Math.floor(Date.now() / 1000));
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      function finish(
        status: number | null,
        error: Outcome['error'],
        retryAfter: string | null = null,
      ): void {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve({ status, error, durationMs: performance.now() - start, retryAfter });
      }
      const url = new URL(target.url);
      const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(lease.body),
            'X-Dispatch-Id': lease.id,
            'X-Dispatch-Endpoint': lease.endpointId,
            'X-Dispatch-Timestamp': timestamp,
            'X-Dispatch-Signature': signature(lease.secret, timestamp, lease.id, lease.body),
            'User-Agent': 'DispatchLedger/0.1',
          },
        },
        (response) => {
          // Status + headers are the acknowledgment contract. Never buffer receiver
          // bodies, persist their secrets, or follow Location redirects.
          const status = response.statusCode ?? 500;
          const header = response.headers['retry-after'];
          finish(status, null, typeof header === 'string' ? header : null);
          response.destroy();
        },
      );
      req.on('error', () => finish(null, 'network'));
      timer = setTimeout(() => {
        finish(null, 'timeout');
        req.destroy();
      }, timeoutMs);
      req.end(lease.body);
    });
}
