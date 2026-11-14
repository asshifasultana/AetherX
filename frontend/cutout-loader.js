// Serialises archive cutout downloads in the browser. The server admits one
// cutout at a time, so firing several frames at once just returns 503. A single
// queue keeps every request valid, and speculative preloading can yield to the
// frame the viewer is actually showing.
//
// Responses use the browser's HTTP cache (`force-cache`), so a preloaded frame
// viewed later is served from disk without another archive request.

const queue = [];
let active = null;

const abortError = () => new DOMException('The cutout request was cancelled.', 'AbortError');

function release(job) {
  job.done = true;
  job.cleanup?.();
  job.cleanup = null;
}

function abortJob(job) {
  if (!job || job.done) return;
  release(job);
  const queued = queue.indexOf(job);
  if (queued >= 0) queue.splice(queued, 1);
  if (active === job) {
    active = null;
    job.controller?.abort(abortError());
  }
  job.reject(abortError());
  pump();
}

async function readResponse(response) {
  if (!response.ok) {
    let message = '';
    try { message = (await response.json())?.error || ''; } catch {}
    throw new Error(message || `The cutout could not be retrieved (${response.status}).`);
  }
  return response.arrayBuffer();
}

function pump() {
  if (active || !queue.length) return;
  const job = queue.shift();
  if (job.done) { pump(); return; }
  active = job;
  const controller = new AbortController();
  job.controller = controller;
  const forwardAbort = () => controller.abort(job.signal?.reason);
  if (job.signal) {
    if (job.signal.aborted) controller.abort(job.signal.reason);
    else job.signal.addEventListener('abort', forwardAbort, { once: true });
  }
  job.cleanup = () => job.signal?.removeEventListener('abort', forwardAbort);
  fetch(job.url, { signal: controller.signal, cache: 'force-cache' })
    .then(readResponse)
    .then(bytes => { if (!job.done) job.resolve(bytes); })
    .catch(error => { if (!job.done) job.reject(error); })
    .finally(() => {
      release(job);
      if (active === job) active = null;
      pump();
    });
}

export function loadCutout(url, { signal, priority = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? abortError()); return; }
    const job = { url, priority, resolve, reject, signal, done: false, controller: null, cleanup: null };
    if (signal) {
      const onAbort = () => abortJob(job);
      signal.addEventListener('abort', onAbort, { once: true });
      job.cleanup = () => signal.removeEventListener('abort', onAbort);
    }
    if (priority) {
      queue.unshift(job);
      // Speculative downloads must never delay the frame being displayed.
      if (active && !active.priority) abortJob(active);
    } else {
      queue.push(job);
    }
    pump();
  });
}
