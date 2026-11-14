// Bin the published Planet Nine reference population into sky cells for the
// AI guide's "Le Verrier" quest and patrol mode.
//
// Source: Brown & Batygin (2021), "The Orbit of Planet Nine", AJ 162, 219, and
// the CaltechDATA reference population v3 (CC0), which flags the synthetic
// planets the ZTF, DES and Pan-STARRS searches would have detected.
//   https://data.caltech.edu/records/8fjad-x7y61
//
// Usage: node scripts/planet-nine-region.mjs [path/to/reference_population.csv]
// Without a path the CSV (13 MB) is downloaded. Writes frontend/data/planet-nine.json.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const RECORD = 'https://data.caltech.edu/records/8fjad-x7y61';
const CSV_URL = 'https://data.caltech.edu/api/records/8fjad-x7y61/files/reference_population.csv/content';
const CELL_DEG = 5;
const OUT = fileURLToPath(new URL('../frontend/data/planet-nine.json', import.meta.url));

const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function parsePopulation(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
  const names = lines[0].split(',').map(name => name.trim());
  return lines.slice(1).map(line => {
    const values = line.split(',').map(Number);
    return Object.fromEntries(names.map((name, index) => [name, values[index]]));
  });
}

/** Cells of the population no survey would have detected, most probable first. */
export function binRemaining(rows, cellDeg = CELL_DEG) {
  const open = rows.filter(row => row.ZTF === 0 && row.DES === 0 && row.PS1 === 0);
  const cells = new Map();
  for (const row of open) {
    const i = Math.min(Math.floor((((row.ra % 360) + 360) % 360) / cellDeg), 360 / cellDeg - 1);
    const j = Math.min(Math.floor((row.dec + 90) / cellDeg), 180 / cellDeg - 1);
    const key = `${i}:${j}`;
    if (!cells.has(key)) cells.set(key, { i, j, distances: [], magnitudes: [] });
    const cell = cells.get(key);
    cell.distances.push(row.R);
    cell.magnitudes.push(row.V);
  }
  return {
    total: rows.length,
    remaining: open.length,
    cells: [...cells.values()].map(cell => ({
      raDeg: (cell.i + 0.5) * cellDeg,
      decDeg: (cell.j + 0.5) * cellDeg - 90,
      share: Number((cell.distances.length / open.length).toFixed(5)),
      medianDistanceAu: Math.round(median(cell.distances)),
      medianVMag: Number(median(cell.magnitudes).toFixed(1))
    })).sort((a, b) => b.share - a.share)
  };
}

async function main() {
  const path = process.argv[2];
  const text = path ? await readFile(path, 'utf8') : await (await fetch(CSV_URL, { redirect: 'follow' })).text();
  const rows = parsePopulation(text);
  if (rows.length < 1000 || !('PS1' in rows[0])) throw new Error('Unexpected reference population format.');
  const binned = binRemaining(rows);
  const output = {
    source: 'Brown & Batygin 2021, AJ 162, 219: Planet Nine reference population v3 (CaltechDATA, CC0)',
    url: RECORD,
    epoch: '2018-06-01',
    note: 'Synthetic Planet Nine positions (epoch 2018) that the ZTF, DES and Pan-STARRS searches would not have detected, binned into 5° cells. Planet Nine is hypothetical; this map shows where it could still be hiding if it exists.',
    cellDeg: CELL_DEG,
    ...binned
  };
  await writeFile(OUT, JSON.stringify(output) + '\n');
  console.log(`Wrote ${binned.cells.length} cells (${binned.remaining} of ${binned.total} synthetic planets still undetected) to ${OUT}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
