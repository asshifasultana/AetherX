import { loadCutout } from './cutout-loader.js';
import { readFits, prepareImage, projectImage } from './lib/fits-engine.js';
import { medianStack } from './lib/stack.js';
import { ImageScheduler, abortError } from './lib/image-scheduler.js';

export class ImagePipeline {
  constructor() { this.scheduler = new ImageScheduler(4); this.pending = new Map(); this.sequence = 0; this.disabled = false; }
  async start() {
    if (this.disabled || typeof Worker === 'undefined') return false;
    if (!this.starting) this.starting = new Promise(resolve => {
      let settled = false;
      const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const fail = () => {
        this.disabled = true; this.worker?.terminate();
        for (const job of this.pending.values()) { job.cleanup(); job.reject(new Error('Image worker is unavailable.')); }
        this.pending.clear(); finish(false);
      };
      const timer = setTimeout(fail, 5000);
      try {
        this.worker = new Worker(new URL('./image-worker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = ({ data }) => {
          if (data.ready) { finish(true); return; }
          const job = this.pending.get(data.id);
          if (!job) return;
          this.pending.delete(data.id); job.cleanup();
          if (data.error) job.reject(Object.assign(new Error(data.error.message), { name: data.error.name }));
          else job.resolve(data.result);
        };
        this.worker.onerror = fail;
      } catch { fail(); }
    });
    return this.starting;
  }
  async request(type, payload, signal, transfers = []) {
    signal?.throwIfAborted();
    if (!await this.start()) throw new Error('Image worker is unavailable.');
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const abort = () => { this.worker.postMessage({ id, type: 'cancel' }); this.pending.delete(id); cleanup(); reject(signal.reason || abortError()); };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.worker.postMessage({ id, type, payload }, transfers); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }
  load(url, accessUrl, target, settings, { signal, priority = 1 } = {}) {
    return this.scheduler.run(`load|${url}|${Boolean(settings.hideBadPixels)}`, async jobSignal => {
      const payload = { accessUrl, target, settings, revision: new URL(url, 'http://localhost').searchParams.get('revision') || '' };
      let forceLegacy = false;
      try { forceLegacy = typeof localStorage !== 'undefined' && localStorage.getItem('spherex-image-loader') === 'legacy'; } catch { /* Storage can be disabled independently of workers. */ }
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
  async median(images, signal) {
    if (await this.start()) return this.request('median', { images }, signal);
    return medianStack(images);
  }
}
export const imagePipeline = new ImagePipeline();
