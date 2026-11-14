import { Worker as NodeWorker } from 'node:worker_threads';

// Run the actual browser worker module, with only its host messaging/fetch
// adapted to Node. This exercises structured cloning and buffer transfers.
export function browserWorkerClass(bytes, { failS3 = false, delay = 0 } = {}) {
  const workers = [];
  class BrowserWorker {
    constructor(url) {
      this.node = new NodeWorker(`
        const { parentPort, workerData } = require('node:worker_threads');
        global.self = { postMessage: (data, transfer) => parentPort.postMessage(data, transfer) };
        parentPort.on('message', data => self.onmessage?.({ data }));
        global.fetch = async (url, options) => {
          if (workerData.delay) await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, workerData.delay);
            options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
          });
          options.signal.throwIfAborted();
          if (workerData.failS3) return new Response('missing', { status: 404 });
          const match = options.headers.Range.match(/bytes=(\\d+)-(\\d+)/), start = Number(match[1]), end = Number(match[2]);
          return new Response(workerData.bytes.slice(start, end + 1), { status: 206, headers: { 'content-range': 'bytes ' + start + '-' + end + '/' + workerData.bytes.length } });
        };
        import(workerData.url).catch(error => { throw error; });
      `, { eval: true, workerData: { url: String(url), bytes, failS3, delay } });
      workers.push(this.node);
      this.node.on('message', data => this.onmessage?.({ data }));
      this.node.on('error', error => this.onerror?.(error));
    }
    postMessage(message, transfer = []) { this.node.postMessage(message, transfer); }
    terminate() { return this.node.terminate(); }
  }
  BrowserWorker.close = () => Promise.all(workers.map(worker => worker.terminate()));
  return BrowserWorker;
}
