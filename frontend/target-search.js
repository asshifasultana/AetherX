import { parseCoordinate, formatSexagesimal } from './coordinates.js';
import { presets } from './presets.js';
import { objectNames, normalizeName, suggestNames } from './object-names.js';

// Both pages render this one form; viewer-only modules can ensure it exists
// before attaching their listeners, regardless of module evaluation order.
export const searchMarkup = `
<form id="target-search-form" class="target-search" novalidate aria-busy="false">
        <div class="target-search-row">
          <label class="target-kind" hidden><span class="search-field-label">Search for</span><select id="target-type" tabindex="-1" aria-hidden="true"><option value="object">Star / object</option><option value="moving">Moving object</option><option value="coordinates">Coordinates</option></select></label>
          <div class="target-name-control"><fieldset id="name-fields" class="target-name-fields"><legend class="sr-only">Object name</legend><label for="lookup-name" id="lookup-label" class="search-field-label">Object name</label><input id="lookup-name" name="object" maxlength="200" required autocomplete="off" placeholder="Object name" aria-describedby="lookup-help lookup-status" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="target-autocomplete" aria-haspopup="listbox"></fieldset><div id="target-autocomplete" class="target-autocomplete" role="listbox" aria-label="Suggested targets" hidden></div></div>
          <fieldset id="coordinate-fields" class="coordinate-fields" hidden disabled><legend class="sr-only">Sky coordinates</legend><label>Coordinate format<select id="coordinate-format"><option value="degrees">Decimal degrees</option><option value="sexagesimal">Hours / degrees, minutes, seconds</option></select></label><label>Right ascension <span id="ra-unit">degrees</span><input id="ra" value="269.4521" required autocomplete="off" placeholder="269.4521" aria-describedby="ra-error"><small id="ra-error" class="field-error"></small></label><label>Declination <span id="dec-unit">degrees</span><input id="dec" value="4.6934" required autocomplete="off" placeholder="+4.6934" aria-describedby="dec-error"><small id="dec-error" class="field-error"></small></label></fieldset>
          <button id="target-search-submit" class="primary-button" type="submit">Search <span aria-hidden="true">↗</span></button>
          <button class="search-help-button" type="button" popovertarget="search-help" aria-label="Search help"><span aria-hidden="true">i</span></button>
          <div id="search-help" class="search-help" popover>
            <p>Find a patch of sky. See how it changes in infrared.</p>
            <p id="lookup-help">Search by name or catalog identifier. Comets and asteroids use a date range.</p>
          </div>
        </div>
        <button id="coordinate-toggle" class="coordinate-toggle" type="button" aria-expanded="false" aria-controls="coordinate-fields">Enter coordinates</button>
        <fieldset id="moving-fields" class="moving-fields" hidden disabled><legend class="sr-only">Moving-object search filters</legend>
          <label>Start date (UTC) <input name="startDate" type="date" required></label>
          <label>End date (UTC) <input name="endDate" type="date" required></label>
          <label>Search detector <select name="detector"><option value="">All</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option><option>6</option></select></label>
          <button type="button" id="moving-example">Try 3I/ATLAS</button>
        </fieldset>
        <div id="search-loading" class="search-loading" role="progressbar" aria-label="Loading" hidden><span></span></div>
        <p id="target-search-status" role="status" aria-live="polite"></p>
        <div id="preset-panel" class="target-quick-picks" role="group" aria-label="Quick picks"><span>Quick picks</span>
          <button type="button" data-target="barnard" aria-pressed="false">Barnard’s Star</button>
          <button type="button" data-target="epsilon" aria-pressed="false">Epsilon Indi B</button>
          <button type="button" data-target="wise" aria-pressed="false">WISE 0855</button>
          <button type="button" data-target="aurigae" aria-pressed="false">RW Aurigae</button>
          <button type="button" data-target="draconis" aria-pressed="false">R Draconis</button>
        </div>
        <div id="lookup-feedback"><p id="lookup-status" role="status" aria-live="polite"></p><div id="lookup-suggestions" class="lookup-suggestions"></div>
        </div>
        <div id="moving-feedback" hidden><p id="moving-status" role="status" aria-live="polite"></p><button type="button" id="moving-cancel" hidden>Cancel</button><div id="moving-choices"></div></div>
      </form>
`;
export function isMovingQuery(query) {
  return /^(?:\d+\s*[IPDC]\s*\/|[CPADX]\s*\/\s*\d{4}|\(\d+\)|\d{4}\s+[a-z]{1,2}\d*\b|(?:comet|asteroid)\s|(?:\d+\s+)?(?:ceres|pallas|juno|vesta|apophis|bennu|ryugu|eros|itokawa|halley|encke)\b)/i.test(query.trim());
}
export function ensureSearchForm() {
  if (!document.getElementById('target-search-form')) document.getElementById('target-picker').innerHTML = searchMarkup;
  if (document.getElementById('target-picker').getAttribute('data-minimal') === 'true') {
    document.getElementById('lookup-name').setAttribute('aria-describedby', 'lookup-status');
  }
}

const loadingSources = new Set();
export function setSearchLoading(source, loading) {
  if (loading) loadingSources.add(source); else loadingSources.delete(source);
  document.getElementById('search-loading').hidden = loadingSources.size === 0;
  document.getElementById('target-search-form').setAttribute('aria-busy', String(loadingSources.size > 0));
}

export function mountTargetSearch({ onObject, onCoordinates, onPreset, onMoving = () => {}, invalidate = () => {}, onEdit = () => {}, initialPosition = { raDeg: 269.4521, decDeg: 4.6934 } }) {
  ensureSearchForm();
  const $ = id => document.getElementById(id), form = $('target-search-form');
  const drafts = { object: '', moving: '' };
  let mode = 'object', coordinateFormat = 'degrees';
  let activeSuggestion = -1;
  let showAllTargets = false;
  const autocomplete = $('target-autocomplete'), nameInput = $('lookup-name');
  const presetFor = item => Object.entries(presets).find(([, target]) => normalizeName(target.name) === normalizeName(item.name));
  const targetKinds = {
    barnardsstar: 'Nearby star · proper motion', epsilonindib: 'Brown dwarf pair', wise0855: 'Brown dwarf · fast moving',
    rwaurigae: 'Young variable star', rdraconis: 'Variable star', sirius: 'Star', vega: 'Star', polaris: 'Star', betelgeuse: 'Star', rigel: 'Star',
    proximacentauri: 'Nearby star', alphacentauri: 'Star system', arcturus: 'Star', altair: 'Star', deneb: 'Star',
    andromedagalaxy: 'Galaxy', milkyway: 'Galaxy · our home galaxy', orionnebula: 'Nebula', pleiades: 'Star cluster', crabnebula: 'Nebula', whirlpoolgalaxy: 'Galaxy'
  };
  const popularNames = ['WISE 0855', 'Barnard’s Star', 'Epsilon Indi B', 'Sirius', 'Milky Way', 'Andromeda Galaxy'];
  const movingTargets = [
    { name: 'Mercury', query: 'Mercury', aliases: ['Mercury barycenter'], detail: 'Planet · solar system' },
    { name: 'Venus', query: 'Venus', aliases: ['Venus barycenter'], detail: 'Planet · solar system' },
    { name: 'Mars', query: 'Mars', aliases: ['Mars barycenter'], detail: 'Planet · solar system' },
    { name: 'Jupiter', query: 'Jupiter', aliases: ['Jupiter barycenter'], detail: 'Planet · solar system' },
    { name: 'Saturn', query: 'Saturn', aliases: ['Saturn barycenter'], detail: 'Planet · solar system' },
    { name: 'Uranus', query: 'Uranus', aliases: ['Uranus barycenter'], detail: 'Planet · solar system' },
    { name: 'Neptune', query: 'Neptune barycenter', aliases: ['Neptune'], detail: 'Planet · solar system' },
    { name: 'Pluto', query: 'Pluto barycenter', aliases: ['Pluto'], detail: 'Dwarf planet · solar system' },
    { name: '1 Ceres', query: '1 Ceres', aliases: ['Ceres'], detail: 'Dwarf planet · asteroid' },
    { name: '136199 Eris', query: '136199 Eris', aliases: ['Eris'], detail: 'Dwarf planet' },
    { name: '136472 Makemake', query: '136472 Makemake', aliases: ['Makemake'], detail: 'Dwarf planet' },
    { name: '136108 Haumea', query: '136108 Haumea', aliases: ['Haumea'], detail: 'Dwarf planet' },
    { name: '4 Vesta', query: '4 Vesta', aliases: ['Vesta'], detail: 'Asteroid' },
    { name: '99942 Apophis', query: '99942 Apophis', aliases: ['Apophis'], detail: 'Near-Earth asteroid' },
    { name: '101955 Bennu', query: '101955 Bennu', aliases: ['Bennu'], detail: 'Near-Earth asteroid' },
    { name: '162173 Ryugu', query: '162173 Ryugu', aliases: ['Ryugu'], detail: 'Near-Earth asteroid' },
    { name: '3I/ATLAS', query: '3I/ATLAS', aliases: ['3I ATLAS'], detail: 'Interstellar comet' },
    { name: '2I/Borisov', query: '2I/Borisov', aliases: ['2I Borisov'], detail: 'Interstellar comet' },
    { name: '1I/ʻOumuamua', query: '1I/2017 U1', aliases: ['1I Oumuamua', 'ʻOumuamua'], detail: 'Interstellar object' },
    { name: 'C/2023 A3 (Tsuchinshan–ATLAS)', query: 'C/2023 A3', aliases: ['Tsuchinshan-ATLAS'], detail: 'Comet' },
    { name: '1P/Halley', query: '1P/Halley', aliases: ['Halley'], detail: 'Periodic comet' },
    { name: 'C/2020 F3 (NEOWISE)', query: 'C/2020 F3', aliases: ['Comet NEOWISE'], detail: 'Comet' },
    { name: '433 Eros', query: '433 Eros', aliases: ['Eros'], detail: 'Near-Earth asteroid' },
    { name: '25143 Itokawa', query: '25143 Itokawa', aliases: ['Itokawa'], detail: 'Near-Earth asteroid' }
  ];
  const popularMovingNames = ['Neptune', 'Pluto', '3I/ATLAS', 'C/2023 A3 (Tsuchinshan–ATLAS)', '1P/Halley', '4 Vesta', '99942 Apophis'];
  const isMovingTargetQuery = query => {
    const normalized = normalizeName(query);
    return normalized.length >= 2 && movingTargets.some(item => [item.name, item.query, ...item.aliases].some(field => normalizeName(field).startsWith(normalized)));
  };
  const modeSuggestions = [
    { name: 'Stars and deep-sky objects', detail: 'Search a star, galaxy, nebula, or catalog name', mode: 'object', terms: ['star', 'stars', 'object', 'galaxy', 'nebula', 'spherex'] },
    { name: 'Moving objects', detail: 'Search comets and asteroids by name, designation, and dates', mode: 'moving', terms: ['moving', 'comet', 'comets', 'asteroid', 'asteroids'] },
    { name: 'Search by coordinates', detail: 'Enter right ascension and declination', mode: 'coordinates', terms: ['coordinates', 'coordinate', 'ra', 'dec', 'position', 'sky location'] }
  ];
  function closeAutocomplete() {
    autocomplete.hidden = true; autocomplete.replaceChildren(); activeSuggestion = -1;
    nameInput.setAttribute('aria-expanded', 'false'); nameInput.removeAttribute('aria-activedescendant');
  }
  function chooseTarget(item) {
    closeAutocomplete(); invalidate(); nameInput.value = item.name;
    if (movingTargets.includes(item)) { chooseMovingTarget(item); return; }
    if (Number.isFinite(item.raDeg) && Number.isFinite(item.decDeg)) {
      publish({ type: 'coordinates', query: item.positionLabel || item.name, format: 'degrees' });
      onCoordinates({ raDeg: item.raDeg, decDeg: item.decDeg }, { name: item.positionLabel || item.name, type: 'GALACTIC CENTER · ICRS', description: 'Representative search position at the center of the Milky Way; the Milky Way is an extended galaxy, not a single point.' });
      return;
    }
    const preset = presetFor(item);
    if (preset) {
      const [targetId, target] = preset; publish({ type: 'object', query: target.name }); onPreset(targetId, target);
    } else { publish({ type: 'object', query: item.query }); onObject(item.query); }
  }
  function chooseMovingTarget(item) {
    closeAutocomplete(); invalidate();
    if (mode !== 'moving') setMode('moving');
    nameInput.value = item.query;
    form.requestSubmit();
  }
  function appendOption({ id, titleText, detailText, onSelect }) {
    const button = document.createElement('button'); button.type = 'button'; button.role = 'option';
    button.id = `target-suggestion-${id}`; button.className = 'target-autocomplete-option'; button.setAttribute('aria-selected', 'false');
    const title = document.createElement('span'); title.className = 'target-autocomplete-title'; title.textContent = titleText;
    const detail = document.createElement('span'); detail.className = 'target-autocomplete-detail'; detail.textContent = detailText;
    button.append(title, detail);
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', onSelect); autocomplete.append(button);
  }
  function heading(text) {
    const label = document.createElement('div'); label.className = 'target-autocomplete-heading'; label.textContent = text; autocomplete.append(label);
  }
  function kindFor(item) { return item.detail || targetKinds[normalizeName(item.name)] || 'Astronomical target'; }
  function renderAutocomplete() {
    closeAutocomplete();
    if (mode === 'coordinates') return;
    const query = nameInput.value.trim(), normalized = normalizeName(query), isEmpty = !normalized;
    const movingMode = mode === 'moving';
    // Keep moving targets in the same type-ahead catalog as stars and galaxies.
    const sourceNames = movingMode ? movingTargets : [...objectNames, ...movingTargets];
    const targetMatches = isEmpty
      ? (movingMode
        ? (showAllTargets ? movingTargets : popularMovingNames.map(name => movingTargets.find(item => item.name === name)).filter(Boolean))
        : (showAllTargets ? sourceNames : popularNames.map(name => sourceNames.find(item => item.name === name)).filter(Boolean)))
      : sourceNames.map(item => {
          const nameFields = [item.name, item.query];
          const aliasFields = item.aliases || [];
          const fields = [...nameFields, ...aliasFields, kindFor(item)];
          const values = fields.map(normalizeName);
          const words = fields.flatMap(field => String(field).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)).map(normalizeName);
          const nameValues = nameFields.map(normalizeName), aliasValues = aliasFields.map(normalizeName), kindValue = normalizeName(kindFor(item));
          const namePrefix = nameValues.some(value => value.startsWith(normalized));
          const nameWordPrefix = words.some(word => word.startsWith(normalized) && nameFields.some(field => String(field).toLowerCase().split(/[^a-z0-9]+/).map(normalizeName).includes(word)));
          const aliasPrefix = aliasValues.some(value => value.startsWith(normalized));
          const kindPrefix = kindValue.startsWith(normalized) || kindValue.split(/[^a-z0-9]+/).some(word => word.startsWith(normalized));
          const prefix = namePrefix || nameWordPrefix || aliasPrefix || kindPrefix;
          const contains = normalized.length === 1 ? prefix : values.some(value => value.includes(normalized));
          const score = namePrefix ? 0 : nameWordPrefix ? 1 : aliasPrefix ? 2 : kindPrefix ? 3 : 4;
          return { item, score, contains };
        }).filter(match => match.contains).sort((a, b) => a.score - b.score || a.item.name.localeCompare(b.item.name)).map(match => match.item);
    const corrected = !isEmpty ? suggestNames(query, sourceNames).filter(item => !targetMatches.some(match => match.name === item.name)) : [];
    const actionMatches = isEmpty ? modeSuggestions : modeSuggestions.filter(item => [item.name, ...item.terms].some(term => {
      const value = normalizeName(term);
      return value.startsWith(normalized) || (normalized.length > 1 && value.includes(normalized));
    }));
    const movingContextMatches = !movingMode && !isEmpty && /\b(comet|asteroid|moving)\b/i.test(query)
      ? (/^moving$/.test(normalized)
        ? popularMovingNames.map(name => movingTargets.find(item => item.name === name)).filter(Boolean)
        : movingTargets.filter(item => [item.name, item.query, ...item.aliases, item.detail].some(field => {
          const value = normalizeName(field);
          return value.includes(normalized) || String(field).toLowerCase().split(/[^a-z0-9]+/).some(word => normalizeName(word).startsWith(normalized));
        })))
      : [];
    if (isEmpty) heading(showAllTargets ? (movingMode ? 'All moving-object targets' : 'All searchable targets') : (movingMode ? 'Popular moving objects' : 'Popular searches'));
    else if (targetMatches.length) heading('Matching targets');
    for (const item of targetMatches.slice(0, isEmpty && showAllTargets ? 30 : 7)) {
      appendOption({ id: normalizeName(item.name), titleText: item.name, detailText: kindFor(item), onSelect: () => movingMode ? chooseMovingTarget(item) : chooseTarget(item) });
    }
    if (corrected.length) {
      for (const item of corrected.slice(0, 4)) appendOption({ id: 'correct-' + normalizeName(item.name), titleText: item.name, detailText: `Did you mean this target? · ${kindFor(item)}`, onSelect: () => movingMode ? chooseMovingTarget(item) : chooseTarget(item) });
    }
    if (actionMatches.length) {
      heading(isEmpty ? 'Search categories' : 'Categories');
      for (const action of actionMatches) appendOption({
        id: action.mode, titleText: action.name, detailText: action.detail,
        onSelect: () => { closeAutocomplete(); setMode(action.mode); if (action.mode === 'coordinates') $('ra').focus(); else nameInput.focus(); }
      });
    }
    if (movingContextMatches.length) {
      heading('Moving-object targets');
      for (const item of movingContextMatches.slice(0, 5)) appendOption({ id: 'moving-' + normalizeName(item.name), titleText: item.name, detailText: item.detail, onSelect: () => chooseMovingTarget(item) });
    }
    if (!isEmpty) appendOption({
      id: 'query-' + normalized,
      titleText: `Search for “${query}”`,
      detailText: movingMode ? 'Search this moving object over the selected dates' : 'Look up this name in the object catalogs',
      onSelect: () => {
        closeAutocomplete(); invalidate();
        if (movingMode) { nameInput.value = query; form.requestSubmit(); }
        else { publish({ type: 'object', query }); onObject(query); }
      }
    });
    if (isEmpty) appendOption({
      id: showAllTargets ? 'popular-targets' : 'all-targets',
      titleText: showAllTargets ? 'Show popular searches' : 'Browse all targets',
      detailText: showAllTargets ? 'Return to suggested targets' : `${movingMode ? movingTargets.length + ' comets and asteroids' : objectNames.length + ' names, aliases, and astronomical objects'}`,
      onSelect: () => { showAllTargets = !showAllTargets; renderAutocomplete(); }
    });
    autocomplete.hidden = false; nameInput.setAttribute('aria-expanded', 'true');
  }
  function updateAutocomplete() { showAllTargets = false; renderAutocomplete(); }
  function moveAutocomplete(delta) {
    const options = [...autocomplete.querySelectorAll('[role="option"]')];
    if (!options.length) return false;
    activeSuggestion = activeSuggestion < 0
      ? (delta > 0 ? 0 : options.length - 1)
      : (activeSuggestion + delta + options.length) % options.length;
    options.forEach((option, index) => option.setAttribute('aria-selected', String(index === activeSuggestion)));
    nameInput.setAttribute('aria-activedescendant', options[activeSuggestion].id);
    return true;
  }
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
    $('lookup-name').value = drafts[mode] || ''; closeAutocomplete();
    $('lookup-name').maxLength = moving ? 80 : 200;
    $('lookup-name').placeholder = moving ? 'Comet or asteroid' : 'Object name';
    $('coordinate-toggle').textContent = coordinates ? 'Search by name' : 'Enter coordinates';
    $('coordinate-toggle').setAttribute('aria-expanded', String(coordinates));
    $('lookup-label').textContent = moving ? 'Designation' : 'Object name';
    $('lookup-help').textContent = coordinates ? 'ICRS reference frame · RA 0° to <360° · Dec −90° to +90°'
      : moving ? 'Enter a comet or asteroid designation and a UTC date range.'
      : 'Search by name or catalog identifier. Comets and asteroids use a date range.';
    $('preset-panel').hidden = mode !== 'object'; $('lookup-feedback').hidden = mode !== 'object';
    $('moving-feedback').hidden = !moving; $('target-search-status').hidden = moving;
    clearErrors();
    window.dispatchEvent(new CustomEvent('sky:entry-mode-changed', { detail: { mode } }));
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
      form.elements.startDate.value = entry.startDate || form.elements.startDate.value; form.elements.endDate.value = entry.endDate || form.elements.endDate.value; form.elements.detector.value = entry.detector;
    }
    if (entry.format) setPosition(initialPosition, entry.format);
  }
  function publish(entry) { window.dispatchEvent(new CustomEvent('sky:search-entry', { detail: entry })); }
  $('coordinate-toggle').addEventListener('click', () => {
    setMode(mode === 'coordinates' ? 'object' : 'coordinates');
    (mode === 'coordinates' ? $('ra') : $('lookup-name')).focus();
  });
  $('lookup-name').addEventListener('input', () => {
    if (mode === 'coordinates' || mode === 'moving') return;
    const query = $('lookup-name').value;
    if (isMovingQuery(query) || isMovingTargetQuery(query)) { setMode('moving'); $('lookup-name').value = query; }
  });
  // A useful, editable range for newly recognized moving objects.
  const today = new Date(), from = new Date(today);
  from.setUTCDate(from.getUTCDate() - 30);
  form.elements.startDate.value = from.toISOString().slice(0, 10);
  form.elements.endDate.value = today.toISOString().slice(0, 10);
  $('target-type').addEventListener('change', () => setMode($('target-type').value));
  nameInput.addEventListener('input', updateAutocomplete);
  nameInput.addEventListener('focus', renderAutocomplete);
  nameInput.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && !autocomplete.hidden) { event.preventDefault(); moveAutocomplete(1); }
    else if (event.key === 'ArrowUp' && !autocomplete.hidden) { event.preventDefault(); moveAutocomplete(-1); }
    else if (event.key === 'Escape' && !autocomplete.hidden) { event.preventDefault(); closeAutocomplete(); }
    else if (event.key === 'Enter' && !autocomplete.hidden) {
      const selected = autocomplete.querySelector('[aria-selected="true"]');
      if (selected) { event.preventDefault(); selected.click(); }
    }
  });
  document.addEventListener?.('click', event => { if (!event.target.closest('.target-name-control')) closeAutocomplete(); });
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
    if (mode === 'object' && isMovingQuery($('lookup-name').value)) {
      const query = $('lookup-name').value;
      setMode('moving'); $('lookup-name').value = query;
    }
    if (!form.reportValidity()) return;
    const query = $('lookup-name').value.trim();
    if (!query) {
      const status = mode === 'moving' ? $('moving-status') : $('lookup-status');
      status.setAttribute('data-error', 'true'); status.textContent = 'Enter an object name.';
      $('lookup-name').focus(); return;
    }
    if (mode === 'moving') {
      const startDate = form.elements.startDate.value, endDate = form.elements.endDate.value, detector = form.elements.detector.value;
      if (startDate > endDate) { $('moving-status').setAttribute('data-error', 'true'); $('moving-status').textContent = 'End date must be on or after the start date.'; form.elements.endDate.focus(); return; }
      const entry = { type: mode, query, startDate, endDate, detector }; publish(entry); onMoving(entry);
    } else {
      const normalized = normalizeName(query);
      const knownPosition = objectNames.find(item => Number.isFinite(item.raDeg) && [item.name, item.query, ...(item.aliases || [])].some(value => normalizeName(value) === normalized));
      if (knownPosition) chooseTarget(knownPosition);
      else { publish({ type: mode, query }); onObject(query); }
    }
  });
  $('moving-example').addEventListener('click', () => {
    if (mode !== 'moving') setMode('moving');
    $('lookup-name').value = '3I/ATLAS'; form.elements.startDate.value = '2025-08-10'; form.elements.endDate.value = '2025-08-15'; form.elements.detector.value = '1'; form.requestSubmit();
  });
  setPosition(initialPosition);
  return { setMode, setPosition, setEntry };
}
