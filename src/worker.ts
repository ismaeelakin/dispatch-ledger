import type { Store } from './store.js';
import type { Transport } from './transport.js';

export class Worker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private current: Promise<number> | undefined;
  constructor(
    private readonly store: Store,
    private readonly send: Transport,
    private readonly concurrency = 4,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
      throw new Error('concurrency must be 1–16');
  }
  tick(): Promise<number> {
    if (this.current) return Promise.resolve(0);
    this.current = this.performTick().finally(() => {
      this.current = undefined;
    });
    return this.current;
  }
  private async performTick(): Promise<number> {
    const leases = [];
    for (let i = 0; i < this.concurrency; i++) {
      const lease = this.store.claim();
      if (!lease) break;
      leases.push(lease);
    }
    const results = await Promise.allSettled(
      leases.map(async (lease) => {
        const target = this.store.targetMap.get(lease.targetId);
        const outcome = target
          ? await this.send(lease, target).catch(() => ({
              status: null,
              error: 'network' as const,
              durationMs: 0,
              retryAfter: null,
            }))
          : { status: 410, error: null, durationMs: 0, retryAfter: null };
        this.store.finish(lease, outcome);
      }),
    );
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('One or more attempt records could not be committed');
    return leases.length;
  }
  start(intervalMs = 500): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // The caller decides how to recover; do not leak payloads or credentials.
      void this.tick().catch(() =>
        console.error('worker tick failed; inspect storage configuration'),
      );
    }, intervalMs);
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.current?.catch(() => undefined);
  }
}
