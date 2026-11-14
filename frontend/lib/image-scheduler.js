export const abortError = () => new DOMException('Image request cancelled.', 'AbortError');

// Shared jobs have independent subscribers: cancelling prefetch must not cancel
// a foreground reader of the same exposure.
export class ImageScheduler {
  constructor(limit = 4) { this.limit = limit; this.active = 0; this.jobs = new Map(); this.queue = []; }
  run(key, execute, { signal, priority = 1 } = {}) {
    signal?.throwIfAborted();
    let job = this.jobs.get(key);
    if (!job) {
      job = { key, execute, priority, controller: new AbortController(), subscribers: new Set(), started: false };
      this.jobs.set(key, job); this.queue.push(job);
    }
    job.priority = Math.min(job.priority, priority);
    return new Promise((resolve, reject) => {
      const subscriber = { resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) };
      const abort = () => {
        subscriber.cleanup(); job.subscribers.delete(subscriber); reject(signal.reason || abortError());
        if (!job.subscribers.size) {
          job.controller.abort();
          this.jobs.delete(key);
          this.queue = this.queue.filter(entry => entry !== job);
        }
      };
      job.subscribers.add(subscriber);
      signal?.addEventListener('abort', abort, { once: true });
      this.pump();
    });
  }
  pump() {
    this.queue.sort((a, b) => a.priority - b.priority);
    while (this.active < this.limit && this.queue.length) {
      const job = this.queue.shift();
      if (!job.subscribers.size) continue;
      this.active++; job.started = true;
      Promise.resolve().then(() => job.execute(job.controller.signal)).then(
        value => { for (const s of job.subscribers) s.resolve(value); },
        error => { for (const s of job.subscribers) s.reject(error); }
      ).finally(() => {
        for (const s of job.subscribers) s.cleanup();
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
        this.active--; this.pump();
      });
    }
  }
}
