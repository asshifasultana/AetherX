import { mkdir, copyFile, writeFile, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CONTEXT_PUBLIC_FILES } from '../frontend/context-assets.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const frontend = path.join(root, 'frontend');
const output = path.join(root, '.vercel', 'output');
const publicFiles = ['index.html', 'viewer.html', 'workspace-ui.js', 'home.js', 'starfield.js', 'target-search.js', 'search-route.js', 'comet-benchmark.js', 'comet-benchmark.json', 'styles.css', 'app.js', 'coordinates.js', 'presets.js', 'object-lookup.js', 'object-names.js', 'observations-ui.js', 'observation-products.js', 'fits-viewer.js', 'cutout-loader.js', 'timelapse.js', 'timelapse-core.js', 'url-state.js', 'sky-projection.js', 'share.js', 'share-ui.js', 'lib/pixel-quality.js', 'lib/rice.js', 'lib/background.js', 'lib/stack.js', 'viewer-settings.js', 'lib/colormaps.js', 'lib/display-scale.js', 'image-worker.js', 'image-pipeline.js', 'lib/fits-engine.js', 'lib/range-fits.js', 'lib/image-resources.js', 'lib/image-scheduler.js', 'lib/crop-codec.js'];
// Emit Vercel's documented Build Output API, avoiding framework auto-detection.
publicFiles.push('moving-target.js', 'moving-worker.js', 'lib/moving-view.js', 'lib/moving-stack.js', 'lib/moving-psf.js',
  'lib/wavelength.js', 'lib/comet-native-fit.js', 'lib/comet-profile.js', 'lib/core-fill.js');
publicFiles.push('agent-ui.js', 'agent-controller.js', 'lib/agent-tools.js');
publicFiles.push(...CONTEXT_PUBLIC_FILES);
await mkdir(path.join(output, 'static'), { recursive: true });
for (const file of publicFiles) {
  const destination = path.join(output, 'static', file);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(frontend, file), destination);
}
for (const [name, maxDuration] of [['observations', 120], ['moving-observations', 120], ['observation-quality', 30], ['pixel-quality', 10], ['index-status', 10], ['cutout', 120], ['crop', 30], ['resolve-object', 15], ['gaia-sources',15]]) {
  const directory = path.join(output, 'functions', 'api', `${name}.func`);
  await mkdir(path.join(directory, 'api'), { recursive: true });
  await mkdir(path.join(directory, 'lib'), { recursive: true });
  await copyFile(path.join(frontend, 'api', name + '.js'), path.join(directory, 'api', name + '.js'));
  if (name !== 'resolve-object') await copyFile(path.join(frontend, 'lib', 'resources.js'), path.join(directory, 'lib', 'resources.js'));
  await copyFile(path.join(frontend, 'observation-products.js'), path.join(directory, 'observation-products.js'));
  if (name === 'resolve-object') await copyFile(path.join(frontend, 'lib', 'name-resolver.js'), path.join(directory, 'lib', 'name-resolver.js'));
  if (name === 'crop') for (const library of ['range-fits.js', 'fits-engine.js', 'rice.js', 'background.js', 'pixel-quality.js']) await copyFile(path.join(frontend, 'lib', library), path.join(directory, 'lib', library));
  if (name === 'pixel-quality') await copyFile(path.join(frontend, 'lib', 'pixel-quality.js'), path.join(directory, 'lib', 'pixel-quality.js'));
  if (name === 'resolve-object') await copyFile(path.join(frontend, 'coordinates.js'), path.join(directory, 'coordinates.js'));
  if (name === 'gaia-sources') {
    await copyFile(path.join(frontend,'lib','gaia-catalog.js'),path.join(directory,'lib','gaia-catalog.js'));
    for(const module of ['gaia-core.js','sky-context-core.js','sky-projection.js']) await copyFile(path.join(frontend,module),path.join(directory,module));
  }
  if (!['cutout', 'crop', 'resolve-object','gaia-sources'].includes(name)) {
    await copyFile(path.join(frontend, 'presets.js'), path.join(directory, 'presets.js'));
    const libraries = name === 'moving-observations' ? ['observations.js', 'search-store.js'] : ['observations.js', 'quality.js', 'index-store.js', 'search-store.js'];
    for (const library of libraries) await copyFile(path.join(frontend, 'lib', library), path.join(directory, 'lib', library));
  }
  if (!['moving-observations', 'observation-quality', 'cutout', 'crop', 'resolve-object','gaia-sources'].includes(name)) {
    try { await cp(path.join(frontend, 'data'), path.join(directory, 'data'), { recursive: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(path.join(directory, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs24.x', handler: `api/${name}.js`, launcherType: 'Nodejs', maxDuration, ...(name === 'crop' ? { regions: ['iad1'] } : {}) }, null, 2));
}
{
  const directory = path.join(output, 'functions', 'api', 'star-details.func');
  for (const file of ['api/star-details.js', 'lib/star-profiles.js', 'lib/star-profile-store.js']) {
    const destination = path.join(directory, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(frontend, file), destination);
  }
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(path.join(directory, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs24.x', handler: 'api/star-details.js', launcherType: 'Nodejs', maxDuration: 10 }, null, 2));
}
// The AI guide proxy only needs its tool schemas and the settings rules they use.
{
  const directory = path.join(output, 'functions', 'api', 'agent.func');
  await mkdir(path.join(directory, 'api'), { recursive: true });
  await mkdir(path.join(directory, 'lib'), { recursive: true });
  await copyFile(path.join(frontend, 'api', 'agent.js'), path.join(directory, 'api', 'agent.js'));
  await copyFile(path.join(frontend, 'lib', 'agent-tools.js'), path.join(directory, 'lib', 'agent-tools.js'));
  await copyFile(path.join(frontend, 'viewer-settings.js'), path.join(directory, 'viewer-settings.js'));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(path.join(directory, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs24.x', handler: 'api/agent.js', launcherType: 'Nodejs', maxDuration: 30 }, null, 2));
}
await writeFile(path.join(output, 'config.json'), JSON.stringify({ version: 3 }, null, 2));
console.log(`Vercel output ready: ${publicFiles.length} public assets, eleven Node.js API functions, and the preset observation index.`);
