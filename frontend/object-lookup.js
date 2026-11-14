import { suggestNames } from './object-names.js';
// Keep pending resolution separate from the active sky position.
export function createLookupController({ fetchImpl = fetch, render, select }) {
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
    } catch {
      if (current === generation) render({ state: 'error', message: 'Object lookup is temporarily unavailable. Retry or use presets or coordinates.', suggestions: [] });
    }
  }
  function confirm() { if (!pending) return; const data = pending; invalidate(); select(data); }
  return { invalidate, resolve, confirm };
}
export function mountObjectLookup(select) {
  const $ = id => document.getElementById(id);
  const form = $('object-lookup-form'), input = $('lookup-name');
  const lookup = createLookupController({ select, render({ state, data, message, invalidName = false, suggestions = [] }) {
    form.setAttribute('aria-busy', String(state === 'loading'));
    $('resolve-object').disabled = state === 'loading';
    $('lookup-confirmation').hidden = state !== 'ready';
    $('lookup-status').textContent = state === 'loading' ? 'Resolving object name…' : state === 'ready' ? 'Catalog position found. Review it, then use this target.' : message || '';
    input.setAttribute('aria-invalid', String(invalidName));
    $('lookup-suggestions').replaceChildren();
    if (state === 'ready') {
      $('resolved-name').textContent = data.resolvedName || data.submittedName;
      $('resolved-coordinates').textContent = `RA ${data.raDeg}° · Dec ${data.decDeg >= 0 ? '+' : ''}${data.decDeg}° · ICRS`;
      $('resolved-source').textContent = `${data.source.name} / ${data.source.resolver} · Retrieved ${data.retrievedAt}. Fixed catalog position; no proper-motion correction.`;
    }
    if (suggestions.length) {
      const label = document.createElement('p'); label.textContent = 'Did you mean…? Suggestions require catalog verification.'; $('lookup-suggestions').append(label);
      for (const suggestion of suggestions) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = suggestion.name;
        button.addEventListener('click', () => { input.value = suggestion.query; lookup.resolve(suggestion.query); });
        $('lookup-suggestions').append(button);
      }
    }
  } });
  form.addEventListener('submit', event => { event.preventDefault(); lookup.resolve(input.value); });
  input.addEventListener('input', lookup.invalidate);
  $('use-resolved-target').addEventListener('click', lookup.confirm);
  return lookup;
}
