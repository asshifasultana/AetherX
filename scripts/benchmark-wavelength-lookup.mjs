// Times the per-exposure wavelength lookup (IMAGE header + WCS-WAVE tail, no
// pixels) for one preset target's full observation list at a few concurrency
// levels. Usage: node scripts/benchmark-wavelength-lookup.mjs [targetId] [limit]
import { readFile } from 'node:fs/promises';
import { createTargetWavelengths } from '../frontend/lib/target-wavelengths.js';
import { createFitsRangeLoader } from '../frontend/lib/range-fits.js';
import { createWavelengthReader } from '../frontend/lib/wavelength.js';

const [targetId = 'barnard', limitArg] = process.argv.slice(2);
const index = JSON.parse(await readFile(new URL('../frontend/data/index.json', import.meta.url)));
const target = index.targets.find(item => item.id === targetId);
if (!target) throw new Error(`No preset target ${targetId}.`);
const snapshot = JSON.parse(await readFile(new URL(`../frontend/data/${target.snapshot}`, import.meta.url)));
const all = snapshot.products.filter(item => item.accessUrl);
const limit = Number(limitArg) || all.length;
const position = { raDeg: target.raDeg, decDeg: target.decDeg };
console.log(`${target.name}: ${all.length} products; timing ${Math.min(limit, all.length)} per run.`);
let offset = 0;
for (const concurrency of [4, 8, 16]) {
  // A fresh slice and fresh caches per run, so no run benefits from another.
  const list = all.slice(offset, offset + limit).length ? all.slice(offset, offset + limit) : all.slice(0, limit);
  offset += limit;
  const lookup = createTargetWavelengths({ readImageHeader: createFitsRangeLoader().imageHeader, wavelengthAt: createWavelengthReader(), concurrency });
  const start = performance.now();
  const result = await lookup.lookup(list, position);
  const seconds = (performance.now() - start) / 1000;
  const values = [...result.values()];
  console.log(`concurrency ${String(concurrency).padStart(2)}: ${result.size}/${list.length} resolved, ${result.failed} failed, ${seconds.toFixed(1)} s (${(list.length / seconds).toFixed(1)} exposures/s); range ${Math.min(...values).toFixed(3)}–${Math.max(...values).toFixed(3)} μm`);
}
