import { parseCoordinate, formatSexagesimal } from './coordinates.js';
import { presets } from './presets.js';

// Both pages render this one form; viewer-only modules can ensure it exists
// before attaching their listeners, regardless of module evaluation order.
export const searchMarkup = `
<form id="target-search-form" class="target-search" novalidate aria-busy="false">
        <div class="target-search-row">
          <label class="target-kind">Search for<select id="target-type"><option value="object">Star / object</option><option value="moving">Moving object</option><option value="coordinates">Coordinates</option></select></label>
          <fieldset id="name-fields" class="target-name-fields"><legend class="sr-only">Object name</legend><label for="lookup-name" id="lookup-label">Object name</label><input id="lookup-name" name="object" maxlength="200" required autocomplete="off" placeholder="e.g. Sirius or M31" aria-describedby="lookup-help lookup-status"></fieldset>
          <fieldset id="coordinate-fields" class="coordinate-fields" hidden disabled><legend class="sr-only">Sky coordinates</legend><label>Coordinate format<select id="coordinate-format"><option value="degrees">Decimal degrees</option><option value="sexagesimal">Hours / degrees, minutes, seconds</option></select></label><label>Right ascension <span id="ra-unit">degrees</span><input id="ra" value="269.4521" required autocomplete="off" placeholder="269.4521" aria-describedby="ra-error"><small id="ra-error" class="field-error"></small></label><label>Declination <span id="dec-unit">degrees</span><input id="dec" value="4.6934" required autocomplete="off" placeholder="+4.6934" aria-describedby="dec-error"><small id="dec-error" class="field-error"></small></label></fieldset>
          <button id="target-search-submit" class="primary-button" type="submit">Search <span aria-hidden="true">↗</span></button>
        </div>
        <fieldset id="moving-fields" class="moving-fields" hidden disabled><legend class="sr-only">Moving-object search filters</legend>
          <label>Start date (UTC) <input name="startDate" type="date" required></label>
          <label>End date (UTC) <input name="endDate" type="date" required></label>
          <label>Search detector <select name="detector"><option value="">All</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option><option>6</option></select></label>
          <button type="button" id="moving-example">Try 3I/ATLAS</button>
        </fieldset>
        <p id="lookup-help" class="coordinate-help">Enter a common name or catalog identifier, or choose a quick pick below.</p>
        <p id="target-search-status" role="status" aria-live="polite"></p>
        <div id="preset-panel" class="target-quick-picks" role="group" aria-label="Quick picks"><span>Quick picks</span>
          <button type="button" data-target="barnard" aria-pressed="false">Barnard’s Star</button>
          <button type="button" data-target="epsilon" aria-pressed="false">Epsilon Indi B</button>
          <button type="button" data-target="wise" aria-pressed="false">WISE 0855</button>
          <button type="button" data-target="aurigae" aria-pressed="false">RW Aurigae</button>
          <button type="button" data-target="draconis" aria-pressed="false">R Draconis</button>
        </div>
        <div id="lookup-feedback"><p id="lookup-status" role="status" aria-live="polite"></p><div id="lookup-suggestions" class="lookup-suggestions"></div>
          <div id="lookup-confirmation" class="lookup-confirmation" hidden><h3 id="resolved-name"></h3><p id="resolved-coordinates"></p><p id="resolved-source"></p></div>
        </div>
        <div id="moving-feedback" hidden><p id="moving-status" role="status" aria-live="polite"></p><button type="button" id="moving-cancel" hidden>Cancel</button><div id="moving-choices"></div></div>
      </form>
`;
export function ensureSearchForm() {
  if (!document.getElementById('target-search-form')) document.getElementById('target-picker').innerHTML = searchMarkup;
}

export function mountTargetSearch({ onObject, onCoordinates, onPreset, onMoving = () => {}, invalidate = () => {}, onEdit = () => {}, initialPosition = { raDeg: 269.4521, decDeg: 4.6934 } }) {
  ensureSearchForm();
  const $ = id => document.getElementById(id), form = $('target-search-form');
  const drafts = { object: '', moving: '' };
  let mode = 'object', coordinateFormat = 'degrees';
  function clearErrors() {
    for (const axis of ['ra', 'dec']) { $(axis + '-error').textContent = ''; $(axis).removeAttribute('aria-invalid'); }
  }
  function setMode(next) {
    drafts[mode] = $('lookup-name').value;
    invalidate(); mode = next; $('target-type').value = mode;
    const coordinates = mode === 'coordinates', moving = mode === 'moving';
    for (const [id, active] of [['name-fields', !coordinates], ['coordinate-fields', coordinates], ['moving-fields', moving]]) {
      $(id).hidden = !active; $(id).disabled = !active;
    }
    $('lookup-name').value = drafts[mode] || '';
    $('lookup-name').maxLength = moving ? 80 : 200;
    $('lookup-name').placeholder = moving ? 'e.g. 3I/ATLAS or 4 Vesta' : 'e.g. Sirius or M31';
    $('lookup-label').textContent = moving ? 'Designation' : 'Object name';
    $('lookup-help').textContent = coordinates ? 'ICRS reference frame · RA 0° to <360° · Dec −90° to +90°'
      : moving ? 'Enter a comet or asteroid designation and a UTC date range.'
      : 'Enter a common name or catalog identifier, or choose a quick pick below.';
    $('preset-panel').hidden = mode !== 'object'; $('lookup-feedback').hidden = mode !== 'object';
    $('moving-feedback').hidden = !moving; $('target-search-status').hidden = moving;
    clearErrors();
  }
  function readCoordinates(format = coordinateFormat) {
    clearErrors(); const position = {}; let firstInvalid;
    for (const axis of ['ra', 'dec']) {
      try { position[axis + 'Deg'] = parseCoordinate($(axis).value, axis, format); }
      catch (error) { $(axis + '-error').textContent = error.message; $(axis).setAttribute('aria-invalid', 'true'); firstInvalid ??= $(axis); }
    }
    if (firstInvalid) { firstInvalid.focus(); return null; }
    return position;
  }
  function setPosition(position, format = coordinateFormat) {
    coordinateFormat = format; $('coordinate-format').value = format;
    for (const axis of ['ra', 'dec']) $(axis).value = format === 'sexagesimal' ? formatSexagesimal(position[axis + 'Deg'], axis) : String(position[axis + 'Deg']);
    $('ra-unit').textContent = format === 'sexagesimal' ? 'HH:MM:SS' : 'degrees';
    $('dec-unit').textContent = format === 'sexagesimal' ? '±DD:MM:SS' : 'degrees';
    $('ra').placeholder = format === 'sexagesimal' ? '17:57:48.504' : '269.4521';
    $('dec').placeholder = format === 'sexagesimal' ? '+04:41:36.240' : '+4.6934';
  }
  function setEntry(entry) {
    setMode(entry.type); $('lookup-name').value = entry.query || '';
    if (entry.type === 'moving') {
      form.elements.startDate.value = entry.startDate; form.elements.endDate.value = entry.endDate; form.elements.detector.value = entry.detector;
    }
    if (entry.format) setPosition(initialPosition, entry.format);
  }
  function publish(entry) { window.dispatchEvent(new CustomEvent('sky:search-entry', { detail: entry })); }
  $('target-type').addEventListener('change', () => setMode($('target-type').value));
  // Back/Forward may restore native form values after this module mounts.
  // Reconcile the visible fields with that restored dropdown selection.
  window.addEventListener('pageshow', () => {
    if ($('target-type').value === mode) return;
    const query = $('lookup-name').value;
    setMode($('target-type').value);
    $('lookup-name').value = query;
  });
  $('moving-search-link')?.addEventListener('click', () => { setMode('moving'); $('lookup-name').focus(); });
  $('coordinate-format').addEventListener('change', () => {
    const next = $('coordinate-format').value, position = readCoordinates();
    if (position) setPosition(position, next); else $('coordinate-format').value = coordinateFormat;
  });
  for (const axis of ['ra', 'dec']) $(axis).addEventListener('input', () => { onEdit(); $(axis + '-error').textContent = ''; $(axis).removeAttribute('aria-invalid'); });
  document.querySelectorAll('[data-target]').forEach(button => button.addEventListener('click', () => {
    invalidate(); const targetId = button.dataset.target, target = presets[targetId];
    $('lookup-name').value = target.name;
    publish({ type: 'object', query: target.name }); onPreset(targetId, target);
  }));
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (mode === 'coordinates') {
      const position = readCoordinates($('coordinate-format').value); if (!position) return;
      invalidate(); publish({ type: mode, query: '', format: coordinateFormat }); onCoordinates(position); return;
    }
    if (!form.reportValidity()) return;
    const query = $('lookup-name').value.trim();
    if (!query) { $('lookup-status').textContent = 'Enter an object name.'; $('lookup-name').focus(); return; }
    if (mode === 'moving') {
      const startDate = form.elements.startDate.value, endDate = form.elements.endDate.value, detector = form.elements.detector.value;
      if (startDate > endDate) { $('moving-status').textContent = 'End date must be on or after the start date.'; form.elements.endDate.focus(); return; }
      const entry = { type: mode, query, startDate, endDate, detector }; publish(entry); onMoving(entry);
    } else { publish({ type: mode, query }); onObject(query); }
  });
  $('moving-example').addEventListener('click', () => {
    if (mode !== 'moving') setMode('moving');
    $('lookup-name').value = '3I/ATLAS'; form.elements.startDate.value = '2025-08-10'; form.elements.endDate.value = '2025-08-15'; form.elements.detector.value = '1'; form.requestSubmit();
  });
  setPosition(initialPosition);
  return { setMode, setPosition, setEntry };
}
