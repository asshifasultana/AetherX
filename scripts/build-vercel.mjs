import { mkdir, copyFile, writeFile, cp, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CONTEXT_PUBLIC_FILES } from '../frontend/context-assets.js';
import { AGENT_PUBLIC_FILES } from '../frontend/agent-assets.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const frontend = path.join(root, 'frontend');
const output = path.join(root, '.vercel', 'output');
const publicFiles = ['index.html', 'viewer.html', 'planetx.html', 'planetx.js', 'workspace-ui.js', 'onboarding.js', 'home.js', 'starfield.js', 'target-search.js', 'search-route.js', 'comet-benchmark.js', 'comet-benchmark.json', 'styles.css', 'app.js', 'coordinates.js', 'presets.js', 'object-lookup.js', 'object-names.js', 'observations-ui.js', 'observation-products.js', 'fits-viewer.js', 'cutout-loader.js', 'timelapse.js', 'timelapse-core.js', 'url-state.js', 'sky-projection.js', 'share.js', 'share-ui.js', 'lib/pixel-quality.js', 'lib/rice.js', 'lib/background.js', 'lib/stack.js', 'viewer-settings.js', 'lib/colormaps.js', 'lib/display-scale.js', 'image-worker.js', 'image-pipeline.js', 'lib/fits-engine.js', 'lib/range-fits.js', 'lib/image-resources.js', 'lib/image-scheduler.js', 'lib/crop-codec.js'];
// Emit Vercel's documented Build Output API, avoiding framework auto-detection.
publicFiles.push('moving-target.js', 'moving-worker.js', 'lib/moving-view.js', 'lib/moving-stack.js', 'lib/moving-psf.js',
  'lib/wavelength.js', 'lib/comet-native-fit.js', 'lib/comet-profile.js', 'lib/core-fill.js', 'lib/peak.js');
publicFiles.push(...AGENT_PUBLIC_FILES);
publicFiles.push('spectrum-explorer.js', 'wavelength-guide.js');
// The search loading screen and the constellation/distance lines it shows.
publicFiles.push('search-loader.js', 'lib/constellation.js', 'lib/distance.js');
publicFiles.push(...CONTEXT_PUBLIC_FILES);
// Start clean so functions dropped or merged since the last build do not linger.
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'static'), { recursive: true });
for (const file of publicFiles) {
  const destination = path.join(output, 'static', file);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(frontend, file), destination);
}
// A browser module that imports an uncopied file 404s on Vercel and takes its whole import graph down with it.
{
  const published = new Set(publicFiles.map(file => path.posix.normalize(file)));
  const missing = [];
  for (const file of publicFiles.filter(name => name.endsWith('.js'))) {
    const source = await readFile(path.join(frontend, file), 'utf8');
    for (const [, specifier] of source.matchAll(/(?:^|[\s;])(?:import|export)\s*(?:[^'"]*?\sfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier.split(/[?#]/)[0]));
      if (!published.has(target)) missing.push(`${file} imports ${target}`);
    }
  }
  // Pages load their entry modules and stylesheets by tag, not by import.
  for (const file of publicFiles.filter(name => name.endsWith('.html'))) {
    const source = await readFile(path.join(frontend, file), 'utf8');
    for (const [, reference] of source.matchAll(/<(?:script|link)\b[^>]*?\s(?:src|href)="([^"]+)"/g)) {
      if (/^(?:[a-z]+:|\/\/|#|\/$)/i.test(reference)) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), reference.split(/[?#]/)[0].replace(/^\//, '')));
      if (!published.has(target)) missing.push(`${file} loads ${target}`);
    }
  }
  if (missing.length) throw new Error(`Static files imported but not published:\n${missing.join('\n')}`);
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
  if (['gaia-sources', 'wise-sources'].includes(name)) {
    await copyFile(path.join(frontend,'lib','gaia-catalog.js'),path.join(directory,'lib','gaia-catalog.js'));
    for(const module of ['gaia-core.js','sky-context-core.js','sky-projection.js']) await copyFile(path.join(frontend,module),path.join(directory,module));
  }
  if (!['cutout', 'crop', 'resolve-object','gaia-sources','wise-sources'].includes(name)) {
    await copyFile(path.join(frontend, 'presets.js'), path.join(directory, 'presets.js'));
    const libraries = name === 'moving-observations' ? ['observations.js', 'search-store.js'] : ['observations.js', 'quality.js', 'index-store.js', 'search-store.js'];
    for (const library of libraries) await copyFile(path.join(frontend, 'lib', library), path.join(directory, 'lib', library));
  }
  if (!['moving-observations', 'observation-quality', 'cutout', 'crop', 'resolve-object','gaia-sources','wise-sources'].includes(name)) {
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
  await copyFile(path.join(frontend, 'lib', 'agent-guard.js'), path.join(directory, 'lib', 'agent-guard.js'));
  await copyFile(path.join(frontend, 'lib', 'spots.js'), path.join(directory, 'lib', 'spots.js'));
  await copyFile(path.join(frontend, 'viewer-settings.js'), path.join(directory, 'viewer-settings.js'));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(path.join(directory, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs24.x', handler: 'api/agent.js', launcherType: 'Nodejs', maxDuration: 30 }, null, 2));
}
// The Hobby plan allows 12 functions per deployment, so related endpoints share
// one: the guide helpers (vision second opinion, JPL known-object check, saved
// records) ride in the agent function, and WISE, CatWISE and SIMBAD in the Gaia one. config.json
// rewrites their URLs to the host function with ?__route=<name>.
const ROUTE_GROUPS = {
  agent: { routes: ['agent', 'agent-vision', 'known-objects', 'cases'], maxDuration: 30 },
  'gaia-sources': { routes: ['gaia-sources', 'wise-sources', 'catwise-sources', 'simbad-sources'], maxDuration: 15 },
};
for (const [host, { routes, maxDuration }] of Object.entries(ROUTE_GROUPS)) {
  const directory = path.join(output, 'functions', 'api', `${host}.func`);
  for (const file of [...routes.map(name => `api/${name}.js`), 'lib/route-group.js']) await copyFile(path.join(frontend, file), path.join(directory, file));
  const imports = routes.map((name, i) => `import handler${i} from './${name}.js';`).join('\n');
  const table = routes.map((name, i) => `  ${JSON.stringify(name)}: handler${i},`).join('\n');
  await writeFile(path.join(directory, 'api', '_group.js'), `import { createRouteGroup } from '../lib/route-group.js';\n${imports}\nexport default createRouteGroup({\n${table}\n}, ${JSON.stringify(host)});\n`);
  await writeFile(path.join(directory, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs24.x', handler: 'api/_group.js', launcherType: 'Nodejs', maxDuration }, null, 2));
}
const routes = Object.entries(ROUTE_GROUPS).map(([host, group]) => ({
  src: `^/api/(${group.routes.filter(name => name !== host).join('|')})/?$`,
  dest: `/api/${host}?__route=$1`,
}));
// A function that imports an uncopied file crashes on load (FUNCTION_INVOCATION_FAILED
// for every request), so walk each function's import graph from its handler.
{
  const missing = [];
  const functionsDir = path.join(output, 'functions', 'api');
  for (const func of await readdir(functionsDir)) {
    const directory = path.join(functionsDir, func);
    const { handler } = JSON.parse(await readFile(path.join(directory, '.vc-config.json'), 'utf8'));
    const seen = new Set();
    const visit = async file => {
      if (seen.has(file)) return;
      seen.add(file);
      let source;
      try { source = await readFile(path.join(directory, file), 'utf8'); }
      catch { missing.push(`${func}: ${file}`); return; }
      for (const [, specifier] of source.matchAll(/(?:^|[\s;])(?:import|export)\s*(?:[^'"]*?\sfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]/g)) {
        await visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier.split(/[?#]/)[0])));
      }
    };
    await visit(handler);
  }
  if (missing.length) throw new Error(`Function files imported but not copied:\n${missing.join('\n')}`);
}
await writeFile(path.join(output, 'config.json'), JSON.stringify({ version: 3, routes }, null, 2));
console.log(`Vercel output ready: ${publicFiles.length} public assets, eleven Node.js API functions (serving seventeen endpoints), and the preset observation index.`);
