// Bakes the view the guided tour opens on its viewer half: Barnard's Star at the
// default settings. That search follows proper motion, so it is a live
// multi-window archive query, then dozens of exposure downloads. Saving both
// with the site lets the tour open from static files, with no loading screen.
//
// Writes frontend/data/tour/barnard.json (the search result and an index of the
// crops) and frontend/data/tour/crops/*.spxc (one gzipped /api/crop payload per
// exposure of the default detector). frontend/lib/baked-view.js reads them.
// Crops already on disk are kept, so a re-run only downloads what changed.
//
// Size: the files are gzipped, but gzip alone saves little, because the low
// bits of a float pixel are noise (5.7 MB for 61 exposures). So each pixel is
// first rounded to a step of at most 1/16 of that image's own noise, which
// leaves every value within 1/32 of the noise of the archive's and cuts the
// files to under half. Pass --lossless to keep the archive's exact values.
// Run with network access after the archive revises or adds Barnard exposures:
//   node scripts/bake-tour-view.mjs [--lossless]
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createSearchService, COLLECTIONS } from '../frontend/lib/observations.js';
import { createFitsRangeLoader } from '../frontend/lib/range-fits.js';
import { encodeCrop, validateCrop, CROP_VERSION } from '../frontend/api/crop.js';
import { cropQuery } from '../frontend/lib/crop-codec.js';
import { presets, viewerTarget, exposureCenter } from '../frontend/presets.js';
import { DEFAULT_SETTINGS } from '../frontend/viewer-settings.js';
import { estimateBackground } from '../frontend/lib/background.js';

const NOISE_STEPS = 16;
const lossless = process.argv.includes('--lossless');
// Round to a power-of-two step so the discarded mantissa bits become zeros,
// which is what lets gzip shrink the result. Blank (NaN) pixels are untouched.
function roundToNoise(values) {
  const { noise } = estimateBackground(values);
  if (!(noise > 0)) return;
  const step = 2 ** Math.floor(Math.log2(noise / NOISE_STEPS));
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) values[i] = Math.round(values[i] / step) * step;
}

const TARGET_ID = 'barnard';
const directory = new URL('../frontend/data/tour/', import.meta.url);
const cropDirectory = new URL('crops/', directory);
const preset = presets[TARGET_ID];
const position = { raDeg: preset.raDeg, decDeg: preset.decDeg, frame: 'icrs', targetId: TARGET_ID };

// Exactly the search observations-ui.js submits for this preset with untouched filters.
const observationsQuery = new URLSearchParams({ raDeg: position.raDeg, decDeg: position.decDeg, detector: 'all', release: 'all', startDate: '', endDate: '', targetId: TARGET_ID });

let collections = COLLECTIONS;
try { collections = JSON.parse(await readFile(new URL('../frontend/data/index.json', import.meta.url), 'utf8')).collections || COLLECTIONS; } catch { /* No index yet: use the built-in list. */ }

console.log(`Searching the archive for ${preset.name}…`);
const result = await createSearchService({ collections })(observationsQuery);
if (result.source.kind !== 'live' || result.truncated || !result.observations.length) throw new Error('The archive search did not return a complete live result; nothing was written.');
const savedAt = new Date().toISOString();
const response = {
  ...result, cached: false,
  source: { ...result.source, kind: 'saved-example', savedAt },
  warnings: [...result.warnings, `Saved with the site on ${savedAt.slice(0, 10)} for the guided tour. Observations released since then are missing; search again for the live archive.`,
    ...(lossless ? [] : [`Saved D${DEFAULT_SETTINGS.band} pixel values are rounded to within 1/${NOISE_STEPS * 2} of each image’s noise to keep the files small.`])]
};

// The crop each exposure needs is the one fits-viewer.js requests for it at the
// default settings, so the keys below match what the browser asks for.
const settings = { ...DEFAULT_SETTINGS, includeFlags: true };
const target = viewerTarget(position, settings.followProperMotion);
const exposures = result.observations.filter(item => item.accessUrl && Number(item.detector) === settings.band);
console.log(`${result.count} detector images found; baking ${exposures.length} D${settings.band} exposures at ${settings.fovArcmin}′.`);

await mkdir(cropDirectory, { recursive: true });
const existing = new Set(await readdir(cropDirectory));
const load = createFitsRangeLoader();
const crops = {};
let downloaded = 0, reused = 0, bytes = 0;

async function bake(exposure) {
  const query = cropQuery({ accessUrl: exposure.accessUrl, target: exposureCenter(target, exposure), settings, revision: exposure.productModifiedAt || exposure.metadataModifiedAt || '' });
  const name = createHash('sha256').update(`spxc${CROP_VERSION}|${lossless ? 'exact' : 'noise/' + NOISE_STEPS}|${query}`).digest('hex').slice(0, 20) + '.spxc';
  crops[query] = 'crops/' + name;
  if (existing.has(name)) { reused++; return; }
  // The same steps as api/crop.js, so the file has exactly a proxy payload's layout.
  const input = validateCrop(new URLSearchParams(query));
  let image;
  for (let attempt = 0; ; attempt++) {
    try {
      image = await load(input.url, { raDeg: input.raDeg, decDeg: input.decDeg }, { fovArcmin: input.fovArcmin, hideBadPixels: input.flags, includeFlags: input.flags, includeVariance: input.variance }, AbortSignal.timeout(120000), input.revision);
      break;
    } catch (error) { if (attempt === 2) throw new Error(`${exposure.observationId} D${exposure.detector}: ${error.message}`); }
  }
  if (!lossless) roundToNoise(image.values);
  const payload = gzipSync(encodeCrop(image), { level: 9 });
  await writeFile(new URL(name, cropDirectory), payload);
  downloaded++; bytes += payload.length;
  console.log(`  ${downloaded + reused}/${exposures.length} ${exposure.observedStartUtc.slice(0, 10)} ${exposure.observationId} · ${(payload.length / 1024).toFixed(0)} KB`);
}

const queue = [...exposures];
await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await bake(queue.shift()); }));

// Sorted keys keep the file stable between runs that change nothing.
const ordered = Object.fromEntries(Object.entries(crops).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
await writeFile(new URL('barnard.json', directory), JSON.stringify({
  schemaVersion: 1, target: TARGET_ID, savedAt, detector: settings.band, fovArcmin: settings.fovArcmin, pixelPrecision: lossless ? 'exact' : `noise/${NOISE_STEPS}`,
  observationsQuery: observationsQuery.toString(), response, crops: ordered
}) + '\n');
const wanted = new Set(Object.values(crops).map(file => file.slice('crops/'.length)));
let removed = 0;
for (const name of existing) if (!wanted.has(name)) { await rm(new URL(name, cropDirectory)); removed++; }
console.log(`Done: ${downloaded} downloaded (${(bytes / 1048576).toFixed(1)} MB), ${reused} kept, ${removed} outdated removed.`);
