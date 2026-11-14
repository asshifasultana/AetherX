function versionRank(observation) {
  const version = /v(\d+)-(\d{4})-(\d{3})/.exec(observation.processingVersion || '');
  return [Number(observation.release?.replace('QR', '')) || 0, ...(version ? version.slice(1).map(Number) : [0, 0, 0]), observation.processingVersion?.includes('retry') ? 1 : 0, observation.collection?.endsWith('_deep') ? 0 : 1];
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
