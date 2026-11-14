import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import observationsHandler from './api/observations.js';
import qualityHandler from './api/observation-quality.js';
import indexStatusHandler from './api/index-status.js';
import resolveObjectHandler from './api/resolve-object.js';
import cutoutHandler from './api/cutout.js';
import cropHandler from './api/crop.js';
import pixelQualityHandler from './api/pixel-quality.js';
import movingObservationsHandler from './api/moving-observations.js';
import gaiaHandler from './api/gaia-sources.js';
import starDetailsHandler from './api/star-details.js';
import agentHandler from './api/agent.js';
import { CONTEXT_PUBLIC_FILES } from './context-assets.js';
const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.md':'text/plain; charset=utf-8' };
export function createAppServer() { return createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/api/resolve-object') { await resolveObjectHandler(req, res); return; }
    if (pathname === '/api/observations') { await observationsHandler(req, res); return; }
    if (pathname === '/api/moving-observations') { await movingObservationsHandler(req, res); return; }
    if (pathname === '/api/agent') { await agentHandler(req, res); return; }
    if (pathname === '/api/gaia-sources') { await gaiaHandler(req,res); return; }
    if (pathname === '/api/star-details') { await starDetailsHandler(req, res); return; }
    if (pathname === '/api/observation-quality') { await qualityHandler(req, res); return; }
    if (pathname === '/api/index-status') { await indexStatusHandler(req, res); return; }
    if (pathname === '/api/cutout') { await cutoutHandler(req, res); return; }
    if (pathname === '/api/crop') { await cropHandler(req, res); return; }
    if (pathname === '/api/pixel-quality') { await pixelQualityHandler(req, res); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(root, file).replaceAll('\\', '/');
    if (!['index.html', 'viewer.html', 'workspace-ui.js', 'onboarding.js', 'home.js', 'starfield.js', 'target-search.js', 'search-route.js', 'comet-benchmark.js', 'comet-benchmark.json', 'styles.css', 'app.js', 'coordinates.js', 'presets.js', 'object-lookup.js', 'object-names.js', 'observations-ui.js', 'spectrum-explorer.js', 'observation-products.js', 'fits-viewer.js', 'cutout-loader.js', 'timelapse.js', 'timelapse-core.js', 'url-state.js', 'sky-projection.js', 'share.js', 'share-ui.js', 'lib/pixel-quality.js', 'lib/rice.js', 'lib/background.js', 'lib/stack.js', 'viewer-settings.js', 'lib/colormaps.js', 'lib/display-scale.js', 'image-worker.js', 'image-pipeline.js', 'lib/fits-engine.js', 'lib/range-fits.js', 'lib/image-resources.js', 'lib/image-scheduler.js', 'lib/crop-codec.js',
      'moving-target.js', 'moving-worker.js', 'lib/moving-view.js', 'lib/moving-stack.js', 'lib/moving-psf.js', 'lib/wavelength.js', 'lib/comet-native-fit.js', 'lib/comet-profile.js', 'lib/core-fill.js', 'agent-ui.js', 'agent-controller.js', 'lib/agent-tools.js', ...CONTEXT_PUBLIC_FILES].includes(relative)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] });
    res.end(await readFile(file));
  } catch { res.writeHead(404).end('Not found'); }
}); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 5173;
  const host = process.env.HOST || '127.0.0.1';
  createAppServer().listen(port, host, () => console.log(`Listening: http://${host}:${port}`));
}
