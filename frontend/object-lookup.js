import { setSearchLoading } from './target-search.js';
import { suggestNames } from './object-names.js';
// Reject stale responses before publishing a resolved target.
export function createLookupController({ fetchImpl = fetch, render, select, autoSelect = false }) {
  let generation = 0, controller, pending;
  function invalidate() { generation++; controller?.abort(); pending = null; render({ state: 'idle' }); }
  async function resolve(name) {
    invalidate(); const current = generation; controller = new AbortController();
    render({ state: 'loading' });
    try {
      const response = await fetchImpl('/api/resolve-object?' + new URLSearchParams({ name }), { signal: controller.signal });
      const data = await response.json();
      if (current !== generation) return;
      if (!response.ok) { render({ state: 'error', invalidName: response.status === 400 || response.status === 404, message: data.error || 'Object lookup failed. Please retry.', suggestions: response.status === 404 && data.code === 'NOT_FOUND' ? suggestNames(name) : [] }); return; }
      if (!Number.isFinite(data.raDeg) || data.raDeg < 0 || data.raDeg >= 360 || !Number.isFinite(data.decDeg) || data.decDeg < -90 || data.decDeg > 90 || data.frame !== 'icrs' || !data.source?.resolver) throw new Error('Invalid resolver response');
      pending = data; render({ state: 'ready', data });
      if (autoSelect && current === generation) { pending = null; select(data); }
    } catch {
      if (current === generation) render({ state: 'error', message: 'Object lookup is temporarily unavailable. Retry or use presets or coordinates.', suggestions: [] });
    }
  }
  function confirm() { if (!pending) return; const data = pending; invalidate(); select(data); }
  return { invalidate, resolve, confirm };
}
export function mountObjectLookup(select) {
  const $ = id => document.getElementById(id);
  const input = $('lookup-name');
  const lookup = createLookupController({ select, autoSelect: true, render({ state, message, invalidName = false, suggestions = [] }) {
    setSearchLoading('lookup', state === 'loading');
    $('target-search-submit').disabled = state === 'loading';
    $('target-search-submit').textContent = 'Search ↗';
    $('lookup-status').textContent = message || '';
    input.setAttribute('aria-invalid', String(invalidName));
    $('lookup-suggestions').replaceChildren();
    if (suggestions.length) {
      const label = document.createElement('p'); label.textContent = 'Did you mean…? Suggestions require catalog verification.'; $('lookup-suggestions').append(label);
      for (const suggestion of suggestions) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = suggestion.name;
        button.addEventListener('click', () => {
          input.value = suggestion.query;
          window.dispatchEvent(new CustomEvent('sky:search-entry', { detail: { type: 'object', query: suggestion.query } }));
          lookup.resolve(suggestion.query);
        });
        $('lookup-suggestions').append(button);
      }
    }
  } });
  input.addEventListener('input', lookup.invalidate);
  return lookup;
}
