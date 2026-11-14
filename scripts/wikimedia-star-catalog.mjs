import { setTimeout as delay } from 'node:timers/promises';
import { publicStarProfile, starAlias, starLookupKeys, starProfiles } from '../frontend/lib/star-profiles.js';

const wikipedia = 'https://en.wikipedia.org/w/api.php';
const wikidata = 'https://www.wikidata.org/w/api.php';
const license = 'https://creativecommons.org/licenses/by-sa/4.0/';
const entityId = /^Q[1-9]\d*$/;
const batches = function* (items, size) {
  for (let offset = 0; offset < items.length; offset += size) yield items.slice(offset, offset + size);
};

async function wikiRequest(endpoint, params, userAgent) {
  const query = new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params });
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(endpoint + '?' + query, {
      headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(20000)
    }).catch(() => null);
    const body = response?.ok ? await response.json() : null;
    if (!response || response.status === 429 || response.status >= 500 || body?.error?.code === 'maxlag') {
      const retryAfter = response?.headers.get('retry-after');
      await response?.body?.cancel().catch(() => {});
      if (attempt === 3) break;
      const seconds = Number(retryAfter) || (Date.parse(retryAfter) - Date.now()) / 1000 || 2 ** (attempt + 1);
      if (seconds > 60) break;
      await delay(Math.max(seconds, 1) * 1000);
      continue;
    }
    if (!response.ok || body.error) throw new Error(`Wikimedia request failed (${body?.error?.code ?? response.status}).`);
    return body;
  }
  throw new Error(`Wikimedia temporarily unavailable at ${endpoint}.`);
}

async function starArticleIds(userAgent) {
  const ids = new Set();
  let continuation;
  do {
    const result = await wikiRequest(wikipedia, {
      action: 'query', list: 'embeddedin', eititle: 'Template:Starbox begin',
      einamespace: '0', eifilterredir: 'nonredirects', eilimit: 'max', ...continuation
    }, userAgent);
    for (const page of result.query.embeddedin) {
      if (!/^(?:list of|lists of|table of|index of) /i.test(page.title)) ids.add(page.pageid);
    }
    continuation = result.continue;
  } while (continuation);
  return [...ids];
}

const claims = (entity, property) => (entity?.claims?.[property] ?? []).filter(claim => claim.rank !== 'deprecated');
const value = claim => claim?.mainsnak?.datavalue?.value;
const relatedIds = (entity, property) => claims(entity, property).map(claim => value(claim)?.id).filter(id => entityId.test(id));
const discoveryMethods = entity => [...claims(entity, 'P61'), ...claims(entity, 'P575')]
  .flatMap(claim => claim.qualifiers?.P459 ?? [])
  .map(snak => snak.datavalue?.value?.id).filter(id => entityId.test(id));

function discoveryDate(entity) {
  for (const claim of claims(entity, 'P575')) {
    const date = value(claim);
    const match = /^([+-])(\d+)-(\d{2})-(\d{2})T/.exec(date?.time);
    if (!match || date.precision < 9) continue;
    const [, era, year, month, day] = match;
    if (era === '-') return `${Number(year)} BCE`;
    if (date.precision < 10 || month === '00') return String(Number(year));
    const monthName = new Date(Date.UTC(2000, Number(month) - 1)).toLocaleString('en', { month: 'long', timeZone: 'UTC' });
    return `${date.precision >= 11 && day !== '00' ? Number(day) + ' ' : ''}${monthName} ${Number(year)}`;
  }
}

async function entitiesFor(ids, props, userAgent) {
  const entities = {};
  for (const batch of batches([...new Set(ids)], 50)) {
    const result = await wikiRequest(wikidata, {
      action: 'wbgetentities', ids: batch.join('|'), props, languages: 'en'
    }, userAgent);
    Object.assign(entities, result.entities);
  }
  return entities;
}

function articleRow(page, entity, labels) {
  const id = page.pageprops?.wikibase_item;
  const pageUrl = 'https://en.wikipedia.org/wiki/' + encodeURIComponent(page.title.replaceAll(' ', '_'));
  const label = ids => [...new Set(ids.map(id => labels[id]?.labels?.en?.value).filter(Boolean))].join(', ') || undefined;
  const namedAfter = label(relatedIds(entity, 'P138'));
  const discoverer = label(relatedIds(entity, 'P61'));
  const method = label(discoveryMethods(entity));
  const date = discoveryDate(entity);
  const aliases = [page.title, entity?.labels?.en?.value, ...(entity?.aliases?.en ?? []).map(alias => alias.value)];
  for (const claim of claims(entity, 'P3083')) {
    const simbad = value(claim);
    if (typeof simbad === 'string') aliases.push(simbad, '* ' + simbad, 'V* ' + simbad, 'NAME ' + simbad);
  }
  for (const claim of claims(entity, 'P528')) aliases.push(value(claim));
  const lookupKeys = [...new Set(aliases.filter(alias => typeof alias === 'string' && alias.trim()).map(alias => 'name:' + starAlias(alias)))];
  return {
    id: entityId.test(id) ? id : 'enwiki-' + page.pageid,
    lookup_keys: lookupKeys,
    profile: {
      name: page.title, description: page.extract.trim(),
      nameOrigin: namedAfter ? 'Named after ' + namedAfter : undefined,
      discoverer, discoveryDate: date, discoveryMethod: method,
      discoverySources: discoverer || date || method ? [{ title: 'Wikidata discovery statements', url: 'https://www.wikidata.org/wiki/' + id }] : undefined,
      source: { title: page.title, url: pageUrl, license, revision: page.lastrevid }
    }
  };
}

export function combineStarRows(rows, curated = starProfiles) {
  const matchedTitles = new Set(curated.filter(item => item.article && !item.component).map(item => item.article));
  const byTitle = new Map(rows.map(row => [row.profile.source.title, row]));
  const reviewedKeys = new Set(curated.flatMap(starLookupKeys));
  const occurrences = new Map();
  for (const row of rows) {
    for (const key of row.lookup_keys) occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }
  const unambiguous = key => !reviewedKeys.has(key) && occurrences.get(key) === 1;
  const curatedRows = curated.map(item => {
    const bulk = item.component ? undefined : byTitle.get(item.article);
    const reviewed = publicStarProfile(item);
    return {
      id: item.id,
      lookup_keys: [...starLookupKeys(item), ...(bulk?.lookup_keys.filter(unambiguous) ?? [])],
      profile: bulk ? { ...bulk.profile, ...reviewed, description: bulk.profile.description, source: bulk.profile.source } : reviewed
    };
  });
  const remaining = rows.filter(row => !matchedTitles.has(row.profile.source.title))
    .map(row => ({ ...row, lookup_keys: row.lookup_keys.filter(unambiguous) }));
  return [...curatedRows, ...remaining];
}

export async function collectStarRows(userAgent, progress = console.log, saveArticles = async () => {}) {
  const ids = await starArticleIds(userAgent);
  if (!ids.length) throw new Error('Wikipedia returned no stellar article IDs.');
  progress(`Found ${ids.length} English Wikipedia stellar articles. Collecting descriptions and catalog identifiers.`);
  const pageBatches = [...batches(ids, 20)];
  const fetched = [];
  let scanned = 0;
  let nextBatch = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (nextBatch < pageBatches.length) {
      const index = nextBatch++;
      const batch = pageBatches[index];
      const result = await wikiRequest(wikipedia, {
        action: 'query', pageids: batch.join('|'), prop: 'extracts|info|pageprops',
        exintro: '1', explaintext: '1', exsentences: '2', exlimit: 'max', ppprop: 'wikibase_item|disambiguation'
      }, userAgent);
      fetched[index] = result.query.pages.filter(page =>
        !page.missing && !page.redirect && !Object.hasOwn(page.pageprops ?? {}, 'disambiguation')
        && Number.isInteger(page.lastrevid) && page.extract?.trim());
      scanned += batch.length;
      if (scanned % 500 === 0) progress(`Scanned ${scanned}/${ids.length} Wikipedia articles.`);
    }
  }));
  const articles = fetched.flat();
  if (!articles.length) throw new Error('Wikipedia returned no valid stellar article descriptions.');
  const articleRows = combineStarRows(articles.map(page => articleRow(page, null, {})));
  await saveArticles(articleRows);
  progress(`Read ${articles.length} article descriptions. Collecting structured Wikidata facts.`);
  try {
    const entities = await entitiesFor(articles.map(page => page.pageprops?.wikibase_item).filter(id => entityId.test(id)), 'labels|aliases|claims', userAgent);
    const labels = await entitiesFor(Object.values(entities).flatMap(entity => [
      ...relatedIds(entity, 'P61'), ...relatedIds(entity, 'P138'), ...discoveryMethods(entity)
    ]), 'labels', userAgent);
    return combineStarRows(articles.map(page => articleRow(page, entities[page.pageprops?.wikibase_item], labels)));
  } catch (error) {
    progress(`Wikidata enrichment failed: ${error.message} Keeping the Wikipedia articles and reviewed facts.`);
    return articleRows;
  }
}
