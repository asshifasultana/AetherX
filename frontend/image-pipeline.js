import { loadCutout } from './cutout-loader.js';
import { readFits, prepareImage, projectImage, projectionKey } from './lib/fits-engine.js';
import { combineStack } from './lib/stack.js';
import { ImageScheduler, abortError } from './lib/image-scheduler.js';

// Decoding and projection are independent per exposure, so they spread across a
// small pool of workers; one core is left for the page itself.
export function defaultWorkerCount() {
  const cores = Number(globalThis.navigator?.hardwareConcurrency) || 2;
  return Math.min(4, Math.max(1, cores - 1));
}
function loaderMode() {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem('spherex-image-loader') || '' : ''; } catch { return ''; /* Storage can be disabled independently of workers. */ }
}
function proxyEndpoint() {
  try { return typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? String(new URL('api/crop', location.href)) : ''; } catch { return ''; }
}

export class ImagePipeline {
  constructor({ workers = defaultWorkerCount() } = {}) { this.scheduler = new ImageScheduler(8); this.workerCount = workers; this.workers = []; this.sequence = 0; this.disabled = false; }
  async start() {
    if (this.disabled || typeof Worker === 'undefined') return false;
    if (!this.starting) this.starting = Promise.all(Array.from({ length: this.workerCount }, () => this.spawn())).then(results => {
      this.workers = results.filter(Boolean);
      if (!this.workers.length) this.disabled = true;
      return this.workers.length > 0;
    });
    return this.starting;
  }
  spawn() {
    return new Promise(resolve => {
      const slot = { pending: new Map(), ready: false };
      let settled = false;
      const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const fail = () => {
        slot.worker?.terminate();
        for (const job of slot.pending.values()) { job.cleanup(); job.reject(new Error('Image worker is unavailable.')); }
        slot.pending.clear();
        const index = this.workers.indexOf(slot);
        if (index >= 0) this.workers.splice(index, 1);
        if (slot.ready && !this.workers.length) this.disabled = true;
        finish(null);
      };
      const timer = setTimeout(fail, 5000);
      try {
        slot.worker = new Worker(new URL('./image-worker.js', import.meta.url), { type: 'module' });
        slot.worker.onmessage = ({ data }) => {
          if (data.ready) { slot.ready = true; finish(slot); return; }
          const job = slot.pending.get(data.id);
          if (!job) return;
          slot.pending.delete(data.id); job.cleanup();
          if (data.error) job.reject(Object.assign(new Error(data.error.message), { name: data.error.name }));
          else job.resolve(data.result);
        };
        slot.worker.onerror = fail;
      } catch { fail(); }
    });
  }
  async request(type, payload, signal, transfers = []) {
    signal?.throwIfAborted();
    if (!await this.start()) throw new Error('Image worker is unavailable.');
    signal?.throwIfAborted();
    if (!this.workers.length) throw new Error('Image worker is unavailable.');
    const slot = this.workers.reduce((best, item) => item.pending.size < best.pending.size ? item : best);
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const abort = () => { slot.worker.postMessage({ id, type: 'cancel' }); slot.pending.delete(id); cleanup(); reject(signal.reason || abortError()); };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      slot.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      try { slot.worker.postMessage({ id, type, payload }, transfers); }
      catch (error) { slot.pending.delete(id); cleanup(); reject(error); }
    });
  }
  load(url, accessUrl, target, settings, { signal, priority = 1 } = {}) {
    return this.scheduler.run(`load|${url}|${projectionKey(target, settings)}`, async jobSignal => {
      // 'legacy' skips the worker transports entirely; 's3' skips only the cropping proxy.
      const mode = loaderMode(), forceLegacy = mode === 'legacy';
      const payload = { accessUrl, target, settings, revision: new URL(url, 'http://localhost').searchParams.get('revision') || '' };
      if (mode !== 's3' && mode !== 'legacy') { const proxyUrl = proxyEndpoint(); if (proxyUrl) payload.proxyUrl = proxyUrl; }
      if (!forceLegacy && await this.start()) {
        try { return await this.request('load', payload, jobSignal); }
        catch (error) { if (jobSignal.aborted || error.name === 'ImageBudgetError') throw error; }
      }
      jobSignal.throwIfAborted();
      const bytes = await loadCutout(url, { signal: jobSignal, priority: priority === 0 });
      if (!forceLegacy && !this.disabled && typeof Worker !== 'undefined') return this.request('decode', { ...payload, bytes }, jobSignal, [bytes]);
      const image = prepareImage(readFits(bytes), target, settings); image.transport = 'irsa'; return image;
    }, { signal, priority });
  }
  async project(image, target, settings, signal) {
    if (await this.start()) return this.request('project', { image, target, settings }, signal);
    return projectImage(image, target, settings);
  }
  async combine(images, options = {}, signal) {
    if (await this.start()) return this.request('combine', { images, options }, signal);
    return combineStack(images, options);
  }
  median(images, signal) { return this.combine(images, { statistic: 'median' }, signal); }
}
export const imagePipeline = new ImagePipeline();
