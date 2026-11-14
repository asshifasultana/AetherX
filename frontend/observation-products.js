// SPHEREx archive releases: quick releases (QR2, QR3, …) and data releases
// (DR1, …). A data release supersedes every quick release.
export const RELEASE_PATTERN = /^(?:qr|dr)[1-9]\d*$/i;
export const COLLECTION_PATTERN = /^spherex_(?:qr|dr)\d+(?:_deep)?$/;
export function releaseFromCollection(collection) {
  return /^spherex_((?:qr|dr)\d+)/i.exec(collection || '')?.[1].toUpperCase() || null;
}
export function releaseFromPath(path) {
  return /\/spherex\/((?:qr|dr)\d+)\//i.exec(path || '')?.[1].toUpperCase() || null;
}
/** [tier, number]: any DR outranks any QR, then the higher number wins. */
export function releaseRank(release) {
  const match = /^(qr|dr)(\d+)$/i.exec(release || '');
  return match ? [match[1].toLowerCase() === 'dr' ? 2 : 1, Number(match[2])] : [0, 0];
}
/** Newest release first. */
export function compareReleases(a, b) {
  const [ta, na] = releaseRank(a), [tb, nb] = releaseRank(b);
  return tb - ta || nb - na;
}

function versionRank(observation) {
  const version = /v(\d+)-(\d{4})-(\d{3})/.exec(observation.processingVersion || '');
  return [...releaseRank(observation.release), ...(version ? version.slice(1).map(Number) : [0, 0, 0]), observation.processingVersion?.includes('retry') ? 1 : 0, observation.collection?.endsWith('_deep') ? 0 : 1];
}
export function preferredProducts(observations) {
  const records = new Map();
  for (const observation of observations) {
    if (!observation.observationId || !observation.detector) throw new TypeError('IRSA returned an observation without a valid identifier or detector.');
    const key = `${observation.observationId}/D${observation.detector}`;
    const existing = records.get(key);
    const rank = versionRank(observation), previous = existing ? versionRank(existing) : [];
    const firstDifference = rank.findIndex((v, i) => v !== previous[i]);
    if (!existing || (firstDifference >= 0 && rank[firstDifference] > previous[firstDifference])) records.set(key, observation);
  }
  return [...records.values()].sort((a, b) => (a.startMjd ?? Infinity) - (b.startMjd ?? Infinity) || a.observationId.localeCompare(b.observationId) || a.detector - b.detector);
}
