import { updateIndex } from './observation-index.mjs';

const flags = process.argv.slice(2);
if (flags.includes('--help')) {
  console.log('Usage: node scripts/update-observation-index.mjs [--allow-empty]\nChecks all five preset positions, all available dates and public releases.\nPublishes a complete persistent index only after every query succeeds.\n--allow-empty permits a previously populated target to become empty after you verify the archive.');
} else if (flags.some(flag => flag !== '--allow-empty')) {
  console.error('Unknown option. Use --help.'); process.exitCode = 1;
} else {
  try {
    const result = await updateIndex({ allowEmpty: flags.includes('--allow-empty'), log: message => console.log(message) });
    console.log(JSON.stringify({ status: result.status, checkedAt: result.lastSuccessfulCheckAt, totalObservations: result.totalObservations, changes: result.changes }));
  } catch (error) { console.error('Index update failed:', error.message); process.exitCode = 1; }
}
