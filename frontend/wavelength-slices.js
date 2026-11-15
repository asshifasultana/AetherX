// Wavelength order for the time-lapse, plus window stacks and line maps.
// Every exposure saw the target at one wavelength (it moves across SPHEREx's
// linear-variable filters from visit to visit), so once those wavelengths are
// known the viewer can scrub the field from 0.75 to 5 μm channel by channel,
// stack any window, or subtract the continuum around a spectral feature.
// Wavelengths come from small S3 reads per exposure (lib/target-wavelengths.js)
// and are those at the target, i.e. the field centre; they shift by about one
// channel across a 10′ field.

import { createTargetWavelengths } from './lib/target-wavelengths.js';
import { buildWindowFrame } from './timelapse-core.js';
import { showLineMap, showCutout } from './fits-viewer.js';
import { exposureCenter } from './presets.js';
import { SPECTRAL_FEATURES } from './lib/detectors.js';

const $ = id => document.getElementById(id);
const order = $('timeline-order'), tools = $('wavelength-tools'), toolsStatus = $('wavelength-tools-status');
let lookups = null;
let observationState = window.spherexObservationState || null;
let wavelengths = null, wavelengthKey = '', controller = null;

const setTimelineStatus = text => { const node = $('timeline-status'); if (node) node.textContent = text; };
const setToolsStatus = text => { if (toolsStatus) toolsStatus.textContent = text; };
const stateKey = () => {
  const list = observationState?.observations || [];
  return `${observationState?.position?.raDeg}|${observationState?.position?.decDeg}|${list.map(item => item.accessUrl).join(',')}`;
};

function resetOrder() {
  controller?.abort(); controller = null;
  if (order) { order.value = 'date'; order.disabled = !observationState?.observations?.length; }
  if (tools) tools.hidden = true;
}

async function useWavelengthOrder() {
  const list = (observationState?.observations || []).filter(item => item.accessUrl);
  const position = observationState?.position;
  if (!list.length || !position) { resetOrder(); return; }
  const key = stateKey();
  if (!wavelengths || wavelengthKey !== key) {
    controller?.abort();
    controller = new AbortController();
    const active = controller;
    lookups ||= createTargetWavelengths({ concurrency: 6 });
    order.disabled = true;
    setTimelineStatus(`Finding the wavelength at the target in ${list.length} exposures… (small reads per exposure; about 10 a second)`);
    try {
      const result = await lookups.lookup(list, position, {
        signal: active.signal,
        positionFor: observation => exposureCenter(position, observation),
        onProgress: ({ done, failed, total }) => { if (controller === active) setTimelineStatus(`Finding wavelengths at the target · ${done}/${total}${failed ? ` · ${failed} unavailable` : ''}…`); }
      });
      if (controller !== active) return;
      wavelengths = result; wavelengthKey = key;
    } catch (error) {
      if (controller === active) { setTimelineStatus(`Wavelength order is unavailable: ${error?.message || 'the lookups failed'}.`); resetOrder(); }
      return;
    } finally {
      if (controller === active) { controller = null; order.disabled = false; }
    }
  }
  if (order.value !== 'wavelength') return;
  tools.hidden = false;
  window.dispatchEvent(new CustomEvent('sky:timeline-axis-changed', { detail: { axis: 'wavelength', wavelengths } }));
}

order?.addEventListener('change', () => {
  if (order.value === 'wavelength') { void useWavelengthOrder(); return; }
  controller?.abort(); controller = null; order.disabled = false;
  if (tools) tools.hidden = true;
  window.dispatchEvent(new CustomEvent('sky:timeline-axis-changed', { detail: { axis: 'date' } }));
});

window.addEventListener('sky:target-selected', () => { observationState = null; wavelengths = null; resetOrder(); });
window.addEventListener('sky:observations-loading', () => { observationState = null; resetOrder(); });
window.addEventListener('sky:observations-loaded', event => {
  observationState = event.detail?.failed ? null : event.detail;
  resetOrder();
});
resetOrder();

// ---- Window stack and line map -----------------------------------------

const readWindow = (minId, maxId) => {
  const low = Number($(minId).value), high = Number($(maxId).value);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low === high) return null;
  return [Math.min(low, high), Math.max(low, high)];
};
const exposures = frame => frame ? `${frame.exposureCount} exposure${frame.exposureCount === 1 ? '' : 's'}` : 'no exposures';

$('stack-window')?.addEventListener('click', async () => {
  if (!wavelengths) return;
  const range = readWindow('window-min', 'window-max');
  if (!range) { setToolsStatus('Enter a window such as 3.20 – 3.40 μm.'); return; }
  const frame = buildWindowFrame(observationState.observations, wavelengths, ...range);
  if (!frame) { setToolsStatus(`No exposure saw the target between ${range[0].toFixed(2)} and ${range[1].toFixed(2)} μm.`); return; }
  setToolsStatus(`Stacking ${exposures(frame)} that saw the target between ${range[0].toFixed(2)} and ${range[1].toFixed(2)} μm${frame.detectors.length > 1 ? ` (detectors ${frame.detectors.map(d => `D${d}`).join(' and ')})` : ''}…`);
  await showCutout(frame);
  setToolsStatus(`Window ${range[0].toFixed(2)}–${range[1].toFixed(2)} μm · ${exposures(frame)} · wavelengths at the field centre.`);
});

$('line-preset')?.addEventListener('change', event => {
  const feature = SPECTRAL_FEATURES.find(item => item.id === event.target.value);
  if (!feature) return;
  $('line-min').value = feature.lowUm.toFixed(2);
  $('line-max').value = feature.highUm.toFixed(2);
});
for (const id of ['line-min', 'line-max']) $(id)?.addEventListener('input', () => { $('line-preset').value = 'custom'; });

/** Feature window plus two equal-width continuum windows touching it on either side. */
export function lineMapWindows(low, high) {
  const width = high - low;
  return { feature: [low, high], continuum: [[low - width, low], [high, high + width]] };
}

$('show-line-map')?.addEventListener('click', async () => {
  if (!wavelengths) return;
  const range = readWindow('line-min', 'line-max');
  if (!range) { setToolsStatus('Enter a feature window such as 3.25 – 3.35 μm.'); return; }
  const windows = lineMapWindows(...range);
  const list = observationState.observations;
  const on = buildWindowFrame(list, wavelengths, ...windows.feature);
  const continuum = windows.continuum.map(window => buildWindowFrame(list, wavelengths, ...window)).filter(Boolean);
  if (!on) { setToolsStatus(`No exposure saw the target inside ${range[0].toFixed(2)}–${range[1].toFixed(2)} μm.`); return; }
  if (!continuum.length) { setToolsStatus('No exposures on either side of the feature to use as continuum.'); return; }
  const preset = SPECTRAL_FEATURES.find(item => item.id === $('line-preset').value);
  setToolsStatus(`Line map: ${exposures(on)} on the feature, ${continuum.map(exposures).join(' + ')} beside it…`);
  try {
    const result = await showLineMap({ on, continuum, label: preset ? `${preset.label} line map` : 'Line map' });
    if (result) setToolsStatus(`Line map ${range[0].toFixed(2)}–${range[1].toFixed(2)} μm · ${exposures(on)} on the feature, ${continuum.map(exposures).join(' + ')} of continuum · ${result.brighter} pixels brighter and ${result.fainter} fainter than the continuum beyond the threshold.${continuum.length < 2 ? ' Only one side had continuum exposures.' : ''}`);
  } catch (error) { setToolsStatus(error?.message || 'The line map could not be built.'); }
});
