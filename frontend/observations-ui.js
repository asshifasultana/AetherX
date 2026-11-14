import { preferredProducts } from './observation-products.js';
import { observeCutout } from './fits-viewer.js';
import { initialViewState } from './share.js';
import { summarizeDetectorCoverage } from './timelapse-core.js';
import { presetMotion } from './presets.js';
const $ = id => document.getElementById(id);
const make = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
const formatNumber = (value, digits = 3) => Number.isFinite(value) ? value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '') : 'Not reported';
const formatTime = value => value ? value.replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'Not reported';
const pageSize = 25;
let position = { raDeg: 269.4521, decDeg: 4.6934, frame: 'icrs' };
let targetName = 'Barnard’s Star', result = null, page = 0, controller, requestNumber = 0;
let submittedParams, searchFailed = false, hasTarget = false, filterTimer;
const qualityCache = new Map();
const sourceLabel = data => data.source.kind === 'scheduled-index' ? (data.source.fallback ? 'Preset index fallback' : 'Scheduled preset index') : data.cached ? 'Cached IRSA search' : 'Live IRSA search';
const emit = (type, detail) => {
  if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent(type, { detail }));
};

function updateTarget() {
  $('search-target').textContent = presetMotion(position)
    ? `${targetName} · proper-motion search`
    : `${targetName} · ${position.raDeg.toFixed(6)}°, ${position.decDeg >= 0 ? '+' : ''}${position.decDeg.toFixed(6)}° · ICRS`;
}
window.addEventListener('sky:target-selected', event => {
  hasTarget = true; clearTimeout(filterTimer);
  position = { ...event.detail }; targetName = $('object-name').textContent;
  updateTarget(); search();
});
function setBusy(busy) {
  $('observations').setAttribute('aria-busy', String(busy));
  if (busy) $('observation-overview').textContent = 'Searching archive…';
  else if (searchFailed) $('observation-overview').textContent = $('search-error').textContent || 'Archive search failed. Expand to retry.';
  else if (!result) $('observation-overview').textContent = $('search-error').hidden ? $('search-status').textContent : $('search-error').textContent;
  $('retry-observations').hidden = busy || !searchFailed;
  $('retry-observations').disabled = busy; $('cancel-search').hidden = !busy;
}
async function search() {
  clearTimeout(filterTimer);
  if (!hasTarget) return;
  controller?.abort(); const current = ++requestNumber; controller = new AbortController(); const activeController = controller;
  searchFailed = false;
  result = null; page = 0; $('observation-results').hidden = true; $('search-error').hidden = true;
  $('archive-mode-label').textContent = 'IRSA archive';
  const startDate = $('search-start').value, endDate = $('search-end').value;
  if (startDate && endDate && startDate > endDate) { setBusy(false); $('search-error').textContent = 'Through date must be on or after the from date.'; $('search-error').hidden = false; emit('sky:observations-loaded', { observations: [], targetName, position: { ...position }, failed: true }); return; }
  const params = new URLSearchParams({ raDeg: position.raDeg, decDeg: position.decDeg, detector: $('search-detector').value, release: $('search-release').value, startDate, endDate });
  if (presetMotion(position)) params.set('targetId', position.targetId);
  submittedParams = params;
  emit('sky:observations-loading', { targetName, position: { ...position } });
  setBusy(true); $('search-status').textContent = '';
  const timeout = setTimeout(() => activeController.abort('timeout'), 100000);
  try {
    const response = await fetch('/api/observations?' + params, { signal: activeController.signal });
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) throw new Error('The observation API is not available. Start the supplied Node server locally, or deploy the API functions with the frontend.');
    const data = await response.json();
    if (!response.ok) throw new Error(data.code === 'IRSA_UNAVAILABLE' ? 'IRSA’s observation service is temporarily unavailable. Your target is selected. Retry shortly.' : data.error || 'The archive search failed. Please retry.');
    if (!Array.isArray(data.observations)) throw new Error('The observation service returned an invalid response. Please retry.');
    if (current !== requestNumber) return;
    result = data;
    $('search-status').textContent = data.count ? `Found ${data.count} ${presetMotion(position) ? 'candidate detector images for' : 'detector images covering'} ${targetName}.` : data.source.fallback
      ? 'The preset fallback index has no matches for these filters. Live IRSA search was unavailable; current coverage could not be checked.'
      : 'No observations cover this position with the selected filters. Try another date range, release, or detector.';
    renderResults();
    emit('sky:observations-loaded', { observations: data.observations, targetName, position: { ...position }, source: data.source, count: data.count, detectorFilter: submittedParams.get('detector'), moreAvailable: Boolean(data.nextCursor) });
  } catch (error) {
    if (current !== requestNumber) return;
    if (activeController.signal.aborted && activeController.signal.reason !== 'timeout') { $('search-status').textContent = 'Search cancelled. You can search again.'; emit('sky:observations-loaded', { observations: [], targetName, position: { ...position }, failed: true }); return; }
    searchFailed = true;
    $('search-status').textContent = 'Search did not complete.';
    $('search-error').textContent = activeController.signal.reason === 'timeout' ? 'The archive search timed out. Try a shorter date range or one detector.' : error.message;
    $('search-error').hidden = false;
    emit('sky:observations-loaded', { observations: [], targetName, position: { ...position }, failed: true });
  } finally { clearTimeout(timeout); if (current === requestNumber) setBusy(false); }
}
$('observation-search-form').addEventListener('submit', event => { event.preventDefault(); search(); });
$('retry-observations').addEventListener('click', () => search());
// A shared link can carry a date range. Seed the inputs before the restored
// target triggers its first search, then publish later edits to the link state.
if (initialViewState.startDate) $('search-start').value = initialViewState.startDate;
if (initialViewState.endDate) $('search-end').value = initialViewState.endDate;
function scheduleFilterSearch() {
  clearTimeout(filterTimer);
  if (!hasTarget) return;
  // Reject late responses as soon as the filters change, before the debounce.
  controller?.abort(); requestNumber++;
  result = null; $('observation-results').hidden = true;
  const start = $('search-start'), end = $('search-end');
  if (start.validity?.valid === false || end.validity?.valid === false || start.value && end.value && start.value > end.value) {
    searchFailed = false; setBusy(false);
    $('search-error').textContent = 'Enter a valid UTC date range with the through date on or after the from date.';
    $('search-error').hidden = false;
    emit('sky:observations-loaded', { observations: [], targetName, position: { ...position }, failed: true });
    return;
  }
  filterTimer = setTimeout(() => search(), 300);
}
for (const id of ['search-start', 'search-end', 'search-release', 'search-detector']) {
  $(id).addEventListener('change', () => {
    if (id === 'search-start' || id === 'search-end') emit('sky:search-filters-changed', { startDate: $('search-start').value, endDate: $('search-end').value });
    scheduleFilterSearch();
  });
}
$('cancel-search').addEventListener('click', () => {
  clearTimeout(filterTimer); controller?.abort(); requestNumber++;
  searchFailed = false; setBusy(false); $('search-error').hidden = true;
  $('search-status').textContent = 'Search cancelled.';
  emit('sky:observations-loaded', { observations: [], targetName, position: { ...position }, failed: true });
});
$('result-sort').addEventListener('change', () => { page = 0; renderRows(); });
$('results-previous').addEventListener('click', () => { page--; renderRows(); });
$('results-next').addEventListener('click', () => { page++; renderRows(); });
function renderResults() {
  const dates = result.observations.map(item => item.observedStartUtc?.slice(0, 10)).filter(Boolean).sort();
  const detectors = [...new Set(result.observations.map(item => 'D' + item.detector))].sort();
  $('observation-overview').textContent = result.count
    ? result.count.toLocaleString() + ' images · ' + detectors.join(', ') + (dates.length ? ' · ' + dates[0] + '–' + dates.at(-1) + ' UTC' : '')
    : 'No observations match these filters.';
  $('observation-results').hidden = false;
  $('results-summary').textContent = `${result.count.toLocaleString()} detector images loaded · ${new Set(result.observations.map(o => o.observationId)).size.toLocaleString()} pointings${result.nextCursor ? ' · more available' : ''}`;
  $('load-more-observations').hidden = !result.nextCursor; $('load-more-observations').disabled = false; $('load-more-observations').textContent = 'Load more observations ↓';
  const indexed = result.source.kind === 'scheduled-index';
  $('archive-mode-label').textContent = sourceLabel(result);
  $('results-provenance').textContent = `Source: ${result.source.name} · ${indexed ? 'Preset index checked' : 'Retrieved'} ${formatTime(result.source.retrievedAt)}${!indexed && result.cached ? ' · Cached (up to 5 minutes)' : ''} · ${result.duplicatesRemoved} duplicate / older products removed.`;
  $('detector-summary').replaceChildren();
  const searchedDetector = submittedParams?.get('detector') || 'all';
  for (const band of summarizeDetectorCoverage(result.observations, { searchedDetector })) {
    const card = make('article', undefined, `detector-coverage-card${band.count ? '' : ' empty-count'}`);
    const heading = make('div', undefined, 'detector-coverage-heading');
    heading.append(make('strong', `D${band.detector}`), make('span', band.searched ? `${band.count} loaded` : 'Not searched'));
    card.append(heading);
    if (band.count) {
      const dateRange = band.firstDate === band.lastDate
        ? new Date(band.firstDate).toLocaleDateString('en', { dateStyle: 'medium', timeZone: 'UTC' })
        : `${new Date(band.firstDate).toLocaleDateString('en', { dateStyle: 'medium', timeZone: 'UTC' })} – ${new Date(band.lastDate).toLocaleDateString('en', { dateStyle: 'medium', timeZone: 'UTC' })}`;
      card.append(make('p', `${formatNumber(band.wavelengthMinUm, 3)}–${formatNumber(band.wavelengthMaxUm, 3)} μm`), make('small', dateRange));
      const stackLabel = result.nextCursor ? `Build D${band.detector} median · loaded results only ↗` : `Build D${band.detector} median view ↗`;
      const stack = make('button', stackLabel, 'text-button detector-stack-button');
      stack.type = 'button'; stack.addEventListener('click', () => {
        emit('sky:coverage-stack-requested', { detector: band.detector });
        document.getElementById('explorer').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      card.append(stack);
    } else if (!band.searched) {
      card.append(make('p', `Search filter is D${searchedDetector}.`));
      const searchBand = make('button', `Search D${band.detector}`, 'text-button detector-stack-button');
      searchBand.type = 'button'; searchBand.addEventListener('click', () => {
        $('search-detector').value = String(band.detector);
        $('observation-search-form').requestSubmit();
      });
      card.append(searchBand);
    } else {
      card.append(make('p', result.source.fallback
        ? 'Coverage not confirmed: the preset fallback index had no match; live archive search was unavailable.'
        : 'No coverage in this search.'));
    }
    $('detector-summary').append(card);
  }
  $('results-warnings').replaceChildren();
  const actionable = (result.warnings || []).filter(text => text.startsWith('More archive products are available'));
  for (const warning of actionable) $('results-warnings').append(make('p', warning));
  $('results-warnings').hidden = !actionable.length;
  renderRows();
}
$('load-more-observations').addEventListener('click', async () => {
  if (!result?.nextCursor) return;
  const current = requestNumber, previous = result;
  const params = new URLSearchParams(submittedParams); params.set('cursor', previous.nextCursor);
  if (previous.source.indexHash) params.set('indexVersion', previous.source.indexHash);
  controller?.abort(); controller = new AbortController(); const activeController = controller;
  const button = $('load-more-observations'); button.disabled = true; button.textContent = 'Loading more…';
  $('search-error').hidden = true; $('cancel-search').hidden = false;
  $('search-status').textContent = 'Loading the next batch of archive products…';
  const timer = setTimeout(() => activeController.abort('timeout'), 100000);
  try {
    const response = await fetch('/api/observations?' + params, { signal: activeController.signal });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not load more observations.');
    if (current !== requestNumber) return;
    const observations = preferredProducts([...previous.observations, ...data.observations]);
    result = { ...data, observations, count: observations.length, matchedProducts: previous.matchedProducts + data.matchedProducts, duplicatesRemoved: previous.matchedProducts + data.matchedProducts - observations.length };
    renderResults(); $('search-status').textContent = `${result.count.toLocaleString()} detector images loaded${result.nextCursor ? '. More observations are available.' : '. All matching archive products have been loaded.'}`;
    emit('sky:observations-loaded', { observations: result.observations, targetName, position: { ...position }, source: result.source, count: result.count, detectorFilter: submittedParams.get('detector'), moreAvailable: Boolean(result.nextCursor) });
  } catch (error) {
    if (current !== requestNumber) return;
    $('search-status').textContent = 'Existing observations are retained.';
    if (!activeController.signal.aborted || activeController.signal.reason === 'timeout') { $('search-error').textContent = error.message; $('search-error').hidden = false; }
  } finally { clearTimeout(timer); if (current === requestNumber) { button.disabled = false; button.textContent = 'Load more observations ↓'; $('cancel-search').hidden = true; } }
});
function field(list, name, value) { const group = make('div'); group.append(make('dt', name), make('dd', value === null || value === undefined || value === '' ? 'Not reported' : String(value))); list.append(group); }
function renderRows() {
  if (!result) return;
  const sorted = $('result-sort').value === 'newest' ? [...result.observations].reverse() : result.observations;
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize)); page = Math.max(0, Math.min(page, pages - 1));
  $('observation-rows').replaceChildren();
  for (const observation of sorted.slice(page * pageSize, (page + 1) * pageSize)) {
    const row = make('tr');
    row.append(make('td', formatTime(observation.observedStartUtc), 'observation-date'), make('td', `D${observation.detector}`), make('td', `${formatNumber(observation.wavelengthMinUm, 4)}–${formatNumber(observation.wavelengthMaxUm, 4)}`));
    const qualityCell = make('td'); qualityCell.append(make('span', observation.quality.archiveFlag || 'Not reported', 'quality-badge')); row.append(qualityCell);
    const versionCell = make('td'); versionCell.append(make('strong', observation.release || observation.collection), make('small', observation.processingVersion || 'Version not reported')); row.append(versionCell);
    const detailCell = make('td'), toggle = make('button', 'Details +', 'text-button'); toggle.type = 'button'; toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-label', `Details for ${observation.observationId} detector ${observation.detector}`);
    detailCell.append(toggle); row.append(detailCell);
    const detailRow = make('tr', undefined, 'observation-detail-row'); detailRow.hidden = true;
    const content = make('td'); content.colSpan = 6;
    const details = make('div', undefined, 'observation-detail'), list = make('dl', undefined, 'metadata-list');
    field(list, 'Observation ID', observation.observationId); field(list, 'Product ID', observation.productId);
    field(list, 'Collection', observation.collection); field(list, 'Exposure', observation.exposureSeconds === null ? null : `${formatNumber(observation.exposureSeconds)} seconds`);
    field(list, 'Observation end (UTC)', formatTime(observation.observedEndUtc)); field(list, 'Processing version', observation.processingVersion);
    field(list, 'Pipeline version', observation.pipelineVersion); field(list, 'Product release date (archive value)', observation.releasedAt);
    field(list, 'Processed at (archive value)', observation.processedAt); field(list, 'Metadata modified (archive value)', observation.metadataModifiedAt);
    field(list, 'Calibration level', observation.quality.calibrationLevel); field(list, 'File size', observation.sizeBytes === null ? null : `${formatNumber(observation.sizeBytes / 1e6, 1)} MB`);
    details.append(list, make('p', observation.quality.description, 'quality-description'));
    const actions = make('div', undefined, 'metadata-actions'), inspection = make('div', undefined, 'quality-inspection'); inspection.setAttribute('role', 'status');
    if (observation.accessUrl) {
      const view = make('button', 'View aligned cutout ↗', 'primary-button'); view.type = 'button';
      view.addEventListener('click', () => { observeCutout(observation); document.getElementById('explorer').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      actions.append(view);
      const link = make('a', 'Open FITS product ↗', 'reset-settings'); link.href = observation.accessUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; actions.append(link);
      const inspect = make('button', 'Inspect quality header', 'reset-settings'); inspect.type = 'button';
      inspect.addEventListener('click', () => inspectQuality(observation, inspection, inspect)); actions.append(inspect);
    }
    details.append(actions, inspection); content.append(details); detailRow.append(content);
    const id = `observation-detail-${page}-${$('observation-rows').children.length}`; detailRow.id = id; toggle.setAttribute('aria-controls', id);
    toggle.addEventListener('click', () => { detailRow.hidden = !detailRow.hidden; toggle.setAttribute('aria-expanded', String(!detailRow.hidden)); toggle.textContent = detailRow.hidden ? 'Details +' : 'Close −'; });
    $('observation-rows').append(row, detailRow);
  }
  $('results-page').textContent = `Page ${page + 1} of ${pages}`; $('results-previous').disabled = page === 0; $('results-next').disabled = page >= pages - 1;
}
async function inspectQuality(observation, container, button) {
  button.disabled = true; container.replaceChildren(make('p', 'Reading the FITS header only. No image is being loaded…'));
  try {
    const key = observation.accessUrl + '|' + (observation.productModifiedAt || observation.metadataModifiedAt || '');
    const cached = qualityCache.get(key); let data = cached && cached.expires > Date.now() ? cached.data : null;
    if (!data) { const response = await fetch('/api/observation-quality?' + new URLSearchParams({ url: observation.accessUrl })); data = await response.json(); if (!response.ok) throw new Error(data.error || 'Quality inspection failed.'); qualityCache.set(key, { data, expires: Date.now() + 300000 }); }
    container.replaceChildren(make('h4', 'FITS quality information'));
    if (data.fineAstrometry) container.append(make('p', `${data.fineAstrometry.keyword} = ${data.fineAstrometry.value} · ${data.fineAstrometry.comment || 'No header description provided'}`));
    else container.append(make('p', 'Fine-astrometry quality flag is not reported in this header.'));
    const list = make('dl', undefined, 'metadata-list quality-counts');
    for (const item of data.flaggedPixelCounts) field(list, item.description || item.keyword, item.count.toLocaleString());
    if (data.flaggedPixelCounts.length) container.append(list);
    else container.append(make('p', 'No image-wide flagged-pixel counts were reported.'));
    container.append(make('p', data.note), make('p', `${data.bytesRead.toLocaleString()} header bytes read · ${data.source}`));
  } catch (error) { container.replaceChildren(make('p', error.message, 'search-error')); }
  finally { button.disabled = false; }
}
$('export-observations').addEventListener('click', () => {
  if (!result) return;
  const headers = ['observationId', 'detector', 'observedStartUtc', 'observedEndUtc', 'exposureSeconds', 'wavelengthMinUm', 'wavelengthMaxUm', 'collection', 'processingVersion', 'pipelineVersion', 'archiveQualityFlag', 'calibrationLevel', 'pixelAssessment', 'accessUrl'];
  const cell = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
  const lines = [headers.join(','), ...result.observations.map(o => headers.map(h => cell(h === 'archiveQualityFlag' ? o.quality.archiveFlag : h === 'calibrationLevel' ? o.quality.calibrationLevel : h === 'pixelAssessment' ? o.quality.pixelAssessment : o[h])).join(','))];
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = make('a'); link.href = url; link.download = 'spherex-observations.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
updateTarget();
let previousIndexStatus = '';
async function loadIndexStatus() {
  try {
    const response = await fetch('/api/index-status');
    const status = await response.json();
    if (!response.ok) throw new Error(status.error || 'Index status is unavailable.');
    const signature = JSON.stringify(status); if (signature === previousIndexStatus) return;
    previousIndexStatus = signature;
    let message = status.available ? `Last successful check: ${formatTime(status.lastSuccessfulCheckAt)} · ${status.totalObservations.toLocaleString()} indexed detector images.` : 'The index has not been initialized yet. Searches use IRSA directly.';
    if (status.available) message += ' Fresh snapshots serve fixed preset positions; moving targets use live queries.';
    if (status.available && status.stale) message += ' The fallback index is overdue for its daily check.';
    if (status.status === 'error') message += ' Latest check failed; the last good index is retained.';
    $('index-update-summary').textContent = message;
    $('index-update-changes').textContent = status.changes ? `Most recent check: ${status.changes.added} new · ${status.changes.revised} revised · ${status.changes.removed} removed. Scheduled around 10:27 AM Bangladesh time daily.` : 'Scheduled around 10:27 AM Bangladesh time daily after the update workflow is enabled on GitHub.';
    if (result?.source.kind === 'scheduled-index') {
      const target = status.targets.find(t => t.id === result.source.targetId);
      if (target && target.hash !== result.source.indexHash) $('index-update-summary').textContent += ' Updated results are available—run your search again to load them.';
    }
    const selected = $('search-release').value;
    const releases = [...new Set((status.collections || []).map(c => /^spherex_(qr\d+)/.exec(c)?.[1]).filter(Boolean))].sort((a, b) => Number(b.slice(2)) - Number(a.slice(2)));
    if (releases.length) {
      $('search-release').replaceChildren(); const all = make('option', 'All public releases · prefer latest'); all.value = 'all'; $('search-release').append(all);
      for (const release of releases) { const option = make('option', release.toUpperCase() + ' only'); option.value = release; $('search-release').append(option); }
      $('search-release').value = releases.includes(selected) ? selected : 'all';
    }
  } catch {
    $('index-update-summary').textContent = 'Automatic-update status is unavailable. You can still try an archive search.';
    $('index-update-changes').textContent = '';
  }
}
loadIndexStatus();
setInterval(() => { if (!document.hidden) loadIndexStatus(); }, 300000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadIndexStatus(); });
