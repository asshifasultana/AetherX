import { mkdir, copyFile, writeFile, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const frontend = path.join(root, 'frontend');
const output = path.join(root, '.vercel', 'output');
const publicFiles = ['index.html', 'styles.css', 'app.js', 'coordinates.js', 'presets.js', 'observations-ui.js', 'observation-products.js'];
// Emit Vercel's documented Build Output API, avoiding framework auto-detection.
await mkdir(path.join(output, 'static'), { recursive: true });
for (const file of publicFiles) await copyFile(path.join(frontend, file), path.join(output, 'static', file));
for (const [name, maxDuration] of [['observations', 120], ['observation-quality', 30], ['index-status', 10]]) {
  const directory = path.join(output, 'functions', 'api', `${name}.func`);
  await mkdir(path.join(directory, 'api'), { recursive: true });
  await mkdir(path.join(directory, 'lib'), { recursive: true });
  await copyFile(path.join(frontend, 'api', name + '.js'), path.join(directory, 'api', name + '.js'));
  await copyFile(path.join(frontend, 'observation-products.js'), path.join(directory, 'observation-products.js'));
  for (const library of ['observations.js', 'quality.js', 'index-store.js']) await copyFile(path.join(frontend, 'lib', library), path.join(directory, 'lib', library));
  if (name !== 'observation-quality') {
    try { await cp(path.join(frontend, 'data'), path.join(directory, 'data'), { recursive: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(path.join(directory, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs24.x', handler: `api/${name}.js`, launcherType: 'Nodejs', maxDuration }, null, 2));
}
await writeFile(path.join(output, 'config.json'), JSON.stringify({ version: 3 }, null, 2));
console.log('Vercel output ready: seven public assets, three Node.js API functions, and the preset observation index.');
