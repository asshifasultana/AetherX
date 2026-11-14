// Separate worker keeps client buffers out of server RSS measurements. No NASA requests.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { get } from 'node:http';
import { fileURLToPath } from 'node:url';

const MiB = 1024 * 1024;
if (process.argv.includes('--worker')) {
  const lines = (await readFile(new URL('../frontend/tests/fixtures/irsa-sample.csv', import.meta.url), 'utf8')).trim().split(/\r?\n/);
  const header = lines[0] + ',padding\n';
  const base = lines[1] + ',';
  const row = base + 'x'.repeat(Math.floor((12_000_000 - Buffer.byteLength(header)) / 2001) - Buffer.byteLength(base) - 1) + '\n';
  const encode = new TextEncoder();
  globalThis.fetch = async url => {
    if (String(url).includes('/TAP/sync')) {
      let index = -1;
      return new Response(new ReadableStream({ pull(controller) {
        if (index === -1) { controller.enqueue(encode.encode(header)); index++; }
        else if (index < 2001) controller.enqueue(encode.encode(row.replaceAll('2025W19_1B_0116_1', `2025W19_1B_${String(index++).padStart(4, '0')}_1`)));
        else controller.close();
      } }));
    }
    assert.ok(new URL(url).searchParams.has('center'), 'Only target-centered cutouts may be fetched');
    let sent = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (sent === 24 * MiB) { controller.close(); return; }
      const chunk = Buffer.alloc(64 * 1024);
      if (!sent) chunk.write('SIMPLE  ');
      sent += chunk.length; controller.enqueue(chunk);
    } }));
  };
  const { createAppServer } = await import('../frontend/server.mjs');
  const server = createAppServer();
  let peak = 0;
  const sample = () => { peak = Math.max(peak, process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024); };
  const timer = setInterval(sample, 5);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); sample();
  process.send({ port: server.address().port });
  process.on('message', async message => {
    if (message !== 'stop') return;
    sample(); clearInterval(timer); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    process.send({ peak }); process.disconnect();
  });
} else {
  const worker = fork(fileURLToPath(import.meta.url), ['--worker'], { execArgv: ['--max-old-space-size=192'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const exited = once(worker, 'exit');
  try {
    const [{ port }] = await once(worker, 'message');
    const base = `http://127.0.0.1:${port}`;
    const cutout = base + '/api/cutout?' + new URLSearchParams({ url: 'https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/mock.fits', raDeg: 1, decDeg: 2, fovArcmin: 16 });
    // Pausing the HTTP client exercises backpressure without retaining the complete file.
    const slowCutout = () => new Promise((resolve, reject) => {
      const request = get(cutout, response => {
        if (response.statusCode !== 200) { response.resume(); reject(new Error(`Cutout returned ${response.statusCode}`)); return; }
        let bytes = 0;
        response.on('data', chunk => { bytes += chunk.length; response.pause(); setTimeout(() => response.resume(), 2); });
        response.on('error', reject); response.on('end', () => { try { assert.equal(bytes, 24 * MiB); resolve(); } catch (error) { reject(error); } });
      });
      request.on('error', reject);
    });
    for (let round = 0; round < 3; round++) {
      const transfer = slowCutout().catch(error => error);
      for (let query = 0; query < 10; query++) {
        const response = await fetch(`${base}/api/observations?raDeg=${round * 10 + query + 1}&decDeg=0`);
        assert.equal(response.status, 200); const data = await response.json(); assert.equal(data.source.kind, 'live'); assert.equal(data.count, 2000);
      }
      const transferError = await transfer; if (transferError) throw transferError;
    }
    const report = once(worker, 'message'); worker.send('stop');
    const [{ peak }] = await report;
    console.log(`Peak server RSS: ${(peak / MiB).toFixed(1)} MiB (limit: 350 MiB); 30 near-12 MB metadata queries and three slow 24 MiB cutouts.`);
    assert.ok(peak < 350 * MiB, 'Server exceeds the 350 MiB rollout budget');
    await exited;
  } finally { if (worker.exitCode === null) worker.kill(); }
}
