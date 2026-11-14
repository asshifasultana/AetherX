import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createStarProfileStore } from '../frontend/lib/star-profile-store.js';
import { combineStarRows, collectStarRows } from './wikimedia-star-catalog.mjs';

const snapshot = new URL('../.local/star-profiles.json', import.meta.url);

async function saveSnapshot(rows, enriched) {
  await mkdir(new URL('.', snapshot), { recursive: true });
  const staging = new URL(`star-profiles.${process.pid}.tmp`, snapshot);
  await writeFile(staging, JSON.stringify({ retrievedAt: new Date().toISOString(), enriched, rows }));
  await rename(staging, snapshot);
}

async function main() {
  const store = createStarProfileStore();
  const mode = process.argv[2];
  if (mode && !['--seed-only', '--collect-only', '--from-snapshot'].includes(mode)) {
    throw new Error('Use --seed-only, --collect-only, or --from-snapshot.');
  }
  if (!store && (mode === '--seed-only' || mode === '--from-snapshot')) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY before uploading.');
  }
  let rows;
  let enriched = false;
  if (mode === '--seed-only') {
    rows = combineStarRows([]);
  } else if (mode === '--from-snapshot') {
    ({ rows, enriched } = JSON.parse(await readFile(snapshot, 'utf8')));
  } else {
    const userAgent = process.env.WIKIMEDIA_USER_AGENT;
    if (!userAgent) throw new Error('Set WIKIMEDIA_USER_AGENT to an app name and contact URL or email.');
    let baseRows;
    let savedBase = false;
    rows = await collectStarRows(userAgent, console.log, async articles => {
      baseRows = articles;
      const exists = await stat(snapshot).then(() => true, error => {
        if (error.code !== 'ENOENT') throw error;
        return false;
      });
      if (!exists) {
        await saveSnapshot(articles, false);
        savedBase = true;
      }
    });
    enriched = rows !== baseRows;
    if (enriched) await saveSnapshot(rows, true);
    if (enriched || savedBase) console.log(`Saved ${rows.length} profiles in .local/star-profiles.json.`);
    else console.log('Kept the existing local snapshot while Wikidata is unavailable.');
  }
  if (mode === '--collect-only') return;
  if (!store) {
    console.log('Supabase is unconfigured. Set its credentials and rerun with --from-snapshot to upload.');
    return;
  }
  if (!Array.isArray(rows) || !rows.length || new Set(rows.map(row => row.id)).size !== rows.length) {
    throw new Error('The catalog has missing or duplicate profile IDs.');
  }
  for (let offset = 0; offset < rows.length; offset += 250) {
    await store.upsert(rows.slice(offset, offset + 250), { seedOnly: !enriched });
    console.log(`Submitted ${Math.min(offset + 250, rows.length)}/${rows.length} profiles to Supabase.`);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
