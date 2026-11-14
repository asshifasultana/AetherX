// The guided tour opens Barnard's Star on its viewer half. That search follows
// proper motion, so it is a live multi-window archive query (15 s or more)
// followed by dozens of exposure downloads. scripts/bake-tour-view.mjs saves the
// search result and the cropped pixels for the default view with the site, and
// this module hands them out, so the tour opens from static files instead.
//
// Nothing here changes what is drawn: the saved crops are the proxy's own
// payloads and go through the same decode, projection and stacking. Any miss
// (another detector, field of view or a revised product) loads the usual way.
export const BAKED_VIEW_PATH = 'data/tour/barnard.json';

let view = null, pending = null;

// True when this page was opened by the tour's hand-off from the home page.
export function isTourArrival(search = globalThis.location?.search || '') {
  const params = new URLSearchParams(search);
  return params.get('target') === 'barnard' && Number(params.get('tour')) > 0;
}

export function readBakedView(data, base) {
  if (data?.schemaVersion !== 1 || typeof data.observationsQuery !== 'string' || !Array.isArray(data.response?.observations) || !data.crops || typeof data.crops !== 'object') return null;
  const crops = new Map();
  for (const [query, file] of Object.entries(data.crops)) if (/^crops\/[a-f0-9]{20}\.spxc$/.test(file)) crops.set(query, String(new URL(file, base)));
  return { observationsQuery: data.observationsQuery, response: data.response, crops };
}

// Fetched once per page. Resolves to null when the files are missing or
// unreadable, which leaves every caller on its normal path.
export function loadBakedView(fetchImpl = globalThis.fetch) {
  pending ||= (async () => {
    try {
      const base = new URL(BAKED_VIEW_PATH, globalThis.location.href);
      const response = await fetchImpl(base, { signal: AbortSignal.timeout(4000) });
      view = response.ok ? readBakedView(await response.json(), base) : null;
    } catch { view = null; }
    return view;
  })();
  return pending;
}

// The saved search result, when `query` is exactly the search that was baked.
export async function bakedObservations(query, fetchImpl) {
  const baked = await loadBakedView(fetchImpl);
  return baked && baked.observationsQuery === query ? baked.response : null;
}

// The saved crop for this exact request, or '' when there is none. Synchronous:
// crops are only ever requested after the search that loaded the view.
export function bakedCropUrl(query) { return view?.crops.get(query) || ''; }
