import { mkdir, copyFile, writeFile, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const frontend = path.join(root, 'frontend');
const output = path.join(root, '.vercel', 'output');
const publicFiles = ['index.html', 'styles.css', 'app.js', 'coordinates.js', 'presets.js', 'object-lookup.js', 'object-names.js', 'observations-ui.js', 'observation-products.js', 'fits-viewer.js'];
// Emit Vercel's documented Build Output API, avoiding framework auto-detection.
await mkdir(path.join(output, 'static'), { recursive: true });
for (const file of publicFiles) await copyFile(path.join(frontend, file), path.join(output, 'static', file));
for (const [name, maxDuration] of [['observations', 120], ['observation-quality', 30], ['index-status', 10], ['cutout', 120], ['resolve-object', 15]]) {
  const directory = path.join(output, 'functions', 'api', `${name}.func`);
  await mkdir(path.join(directory, 'api'), { recursive: true });
  await mkdir(path.join(directory, 'lib'), { recursive: true });
  await copyFile(path.join(frontend, 'api', name + '.js'), path.join(directory, 'api', name + '.js'));
  if (name !== 'resolve-object') await copyFile(path.join(frontend, 'lib', 'resources.js'), path.join(directory, 'lib', 'resources.js'));
  await copyFile(path.join(frontend, 'observation-products.js'), path.join(directory, 'observation-products.js'));
  if (name === 'resolve-object') await copyFile(path.join(frontend, 'lib', 'name-resolver.js'), path.join(directory, 'lib', 'name-resolver.js'));
  if (name === 'resolve-object') await copyFile(path.join(frontend, 'coordinates.js'), path.join(directory, 'coordinates.js'));
  for (const library of ['observations.js', 'quality.js', 'index-store.js']) if (!['cutout', 'resolve-object'].includes(name)) await copyFile(path.join(frontend, 'lib', library), path.join(directory, 'lib', library));
  if (!['observation-quality', 'cutout', 'resolve-object'].includes(name)) {
    try { await cp(path.join(frontend, 'data'), path.join(directory, 'data'), { recursive: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(path.join(directory, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs24.x', handler: `api/${name}.js`, launcherType: 'Nodejs', maxDuration }, null, 2));
}
await writeFile(path.join(output, 'config.json'), JSON.stringify({ version: 3 }, null, 2));
console.log('Vercel output ready: ten public assets, five Node.js API functions, and the preset observation index.');
