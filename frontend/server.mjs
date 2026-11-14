import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import observationsHandler from './api/observations.js';
import qualityHandler from './api/observation-quality.js';
import indexStatusHandler from './api/index-status.js';
import resolveObjectHandler from './api/resolve-object.js';
import cutoutHandler from './api/cutout.js';
const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
export function createAppServer() { return createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/api/resolve-object') { await resolveObjectHandler(req, res); return; }
    if (pathname === '/api/observations') { await observationsHandler(req, res); return; }
    if (pathname === '/api/observation-quality') { await qualityHandler(req, res); return; }
    if (pathname === '/api/index-status') { await indexStatusHandler(req, res); return; }
    if (pathname === '/api/cutout') { await cutoutHandler(req, res); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(root, file).replaceAll('\\', '/');
    if (!['index.html', 'styles.css', 'app.js', 'coordinates.js', 'presets.js', 'object-lookup.js', 'object-names.js', 'observations-ui.js', 'observation-products.js', 'fits-viewer.js', 'cutout-loader.js', 'timelapse.js', 'timelapse-core.js'].includes(relative)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] });
    res.end(await readFile(file));
  } catch { res.writeHead(404).end('Not found'); }
}); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 5173;
  const host = process.env.HOST || '127.0.0.1';
  createAppServer().listen(port, host, () => console.log(`Listening: http://${host}:${port}`));
}
