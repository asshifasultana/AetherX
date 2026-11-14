// The legacy server admits one cutout transfer at a time. S3 reads use the
// separate shared exposure scheduler; fallback requests stay serialized here.
const queue = [];
let active = null;
const abortError = () => new DOMException('The cutout request was cancelled.', 'AbortError');
const wait = (ms, signal) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const abort = () => { clearTimeout(timer); reject(signal.reason || abortError()); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});
async function download(job) {
  for (let attempt = 0; attempt < 3; attempt++) {
    job.controller.signal.throwIfAborted();
    const response = await fetch(job.url, { signal: job.controller.signal, cache: 'force-cache' });
    if (response.status === 503 && attempt < 2) {
      const retry = response.headers.get('retry-after');
      await response.body?.cancel();
      await wait(Math.min(30000, Math.max(500, Number(retry) * 1000 || 5000)), job.controller.signal);
      continue;
    }
    if (!response.ok) {
      let message = '';
      try { message = (await response.json())?.error || ''; } catch {}
      throw new Error(message || `The cutout could not be retrieved (${response.status}).`);
    }
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 24 * 1024 * 1024) throw new Error('This cutout exceeds the 24 MiB limit. Choose a smaller field of view.');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const result = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result.buffer;
  }
}
function pump() {
  if (active || !queue.length) return;
  const job = queue.shift(); active = job;
  download(job).then(job.resolve, job.reject).finally(() => {
    job.cleanup(); active = null; pump();
  });
}
export function loadCutout(url, { signal, priority = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || abortError()); return; }
    const controller = new AbortController();
    const job = { url, resolve, reject, controller, cleanup: () => signal?.removeEventListener('abort', abort) };
    const abort = () => {
      controller.abort(signal.reason || abortError());
      const index = queue.indexOf(job);
      if (index >= 0) { queue.splice(index, 1); job.cleanup(); reject(signal.reason || abortError()); }
      // Keep the active slot occupied until fetch cancellation has settled.
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (priority) queue.unshift(job); else queue.push(job);
    pump();
  });
}
