/**
 * Bounded concurrency for the privileged host adapters.
 *
 * The runtime used to chain every privileged call onto a single promise, which
 * made the slowest call the rate limit for all of them. One ten-minute
 * `spawn_subagent` kept an unrelated `codexclaw_native` and a one-second
 * `aside_native --help` from starting at all, and several subagents dispatched
 * together ran strictly one after another. A caller that gave up while waiting
 * also kept its place in line, so cancelling it released nothing.
 *
 * A gate keeps the property that chain actually existed for — a hard ceiling on
 * how many unsandboxed host processes this runtime has in flight — without
 * turning one long call into a global stop. Admission is FIFO, so a burst of
 * broker calls cannot starve an earlier waiter, and an aborted waiter leaves the
 * queue immediately instead of holding a slot it will never use.
 */
export class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  /** Every call created through run(), so shutdown can wait for live children. */
  private readonly started = new Set<Promise<void>>();

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Gate limit must be a positive integer');
  }

  stats() { return { limit: this.limit, active: this.active, waiting: this.waiting.length }; }

  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const op = (async () => {
      await this.enter(signal);
      try { return await task(); } finally { this.leave(); }
    })();
    // Tracked as a settled-either-way promise: drain() must not turn a failed
    // call into an unhandled rejection, and the caller still sees the real error.
    const tracked = op.then(() => {}, () => {});
    this.started.add(tracked);
    void tracked.then(() => { this.started.delete(tracked); });
    return op;
  }

  /**
   * Wait for every call this gate has admitted or queued.
   *
   * Callers abort their jobs before draining, which is what releases a waiter
   * that has not been admitted yet; draining alone is not a cancellation.
   */
  async drain() {
    while (this.started.size) await Promise.all([...this.started]);
  }

  private enter(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('Cancelled while waiting for a privileged adapter slot'));
    // Queue behind existing waiters even when a slot is free, so admission stays
    // first-come rather than favouring whoever asks at the right moment.
    if (this.active < this.limit && this.waiting.length === 0) { this.active++; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const admit = () => { detach(); this.active++; resolve(); };
      const drop = () => {
        detach();
        const index = this.waiting.indexOf(admit);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new Error('Cancelled while waiting for a privileged adapter slot'));
      };
      const detach = () => signal?.removeEventListener('abort', drop);
      this.waiting.push(admit);
      signal?.addEventListener('abort', drop, { once: true });
    });
  }

  private leave() {
    this.active--;
    this.waiting.shift()?.();
  }
}
