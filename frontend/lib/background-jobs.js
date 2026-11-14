// Background jobs for the AI guide: slow lookups (JPL still computing, a deep
// stack still downloading) keep running after the tool call returns, so the
// guide can carry on with other checks. When a job finishes, onDone hands its
// result back and the chat feeds it to the guide. Pure: no DOM.

const sleep = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

/**
 * Call `attempt` until it returns a value that is not undefined, waiting
 * `intervalMs` between tries. Throws on timeout or abort.
 */
export async function pollUntil(attempt, { intervalMs = 5000, timeoutMs = 180_000, signal, now = () => Date.now(), pause = sleep } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new Error('cancelled');
    const value = await attempt(signal);
    if (value !== undefined) return value;
    if (now() + intervalMs > deadline) throw new Error('timed out');
    await pause(intervalMs, signal);
  }
}

export function createJobs({ onDone = () => {} } = {}) {
  const jobs = new Map(); // key → { id, label, controller, promise }
  let next = 1;

  /**
   * Start `run(signal)` in the background unless a job with the same key is
   * already running; returns { id, label, joined }.
   */
  function start(key, label, run, extra = {}) {
    const existing = jobs.get(key);
    if (existing) return { id: existing.id, label: existing.label, joined: true };
    const id = `job-${next++}`;
    const controller = new AbortController();
    const startedAt = Date.now();
    const entry = { id, label, controller, extra };
    jobs.set(key, entry);
    entry.promise = Promise.resolve()
      .then(() => run(controller.signal))
      .then(result => ({ ok: true, result }), error => ({ ok: false, error: error?.message || 'failed' }))
      .then(outcome => {
        if (jobs.get(key) === entry) jobs.delete(key);
        if (controller.signal.aborted) return;
        onDone({ id, key, label, ...extra, seconds: Math.round((Date.now() - startedAt) / 1000), ...outcome });
      });
    return { id, label, joined: false };
  }

  /** Jobs still running, for the guide's view of what is pending. */
  const running = () => [...jobs.values()].map(({ id, label }) => ({ id, label }));

  function cancelAll() {
    for (const entry of jobs.values()) entry.controller.abort();
    jobs.clear();
  }

  return { start, running, cancelAll };
}

/** The message the guide reads when a background job finishes. */
export function describeDone(done, maxChars = 1500) {
  const body = done.ok ? JSON.stringify(done.result) : JSON.stringify({ error: done.error });
  return `[Background result ${done.id}] ${done.label} finished after ${done.seconds} s: ${body.length > maxChars ? body.slice(0, maxChars) + '…' : body}`;
}
