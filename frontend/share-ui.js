// Share and embed controls. Keeps the summary line in step with the live view
// state and owns the clipboard plumbing, so app.js stays a settings controller.

import { currentViewState, embedSnippet, initialViewIssues, initialViewState, isEmbedded, shareUrl } from './share.js';

const $ = id => document.getElementById(id);
const BAND_RANGES = ['0.75 – 1.09', '1.10 – 1.62', '1.63 – 2.41', '2.42 – 3.82', '3.83 – 4.41', '4.42 – 5.00'];
const signed = value => `${value < 0 ? '' : '+'}${value.toFixed(4)}`;

let statusTimer = null;
function announce(text, { error = false, sticky = false } = {}) {
  const status = $('share-status');
  if (!status) return;
  status.textContent = text;
  status.classList.toggle('is-error', error);
  clearTimeout(statusTimer);
  if (!sticky) statusTimer = setTimeout(() => { status.textContent = ''; }, 6000);
}

function summaryText() {
  const state = currentViewState();
  const parts = [`${state.raDeg.toFixed(4)}°, ${signed(state.decDeg)}°`];
  parts.push(`${state.fovArcmin}′ field`);
  const range = BAND_RANGES[state.band - 1];
  parts.push(range ? `D${state.band} ${range} μm` : `D${state.band}`);
  if (state.startDate && state.endDate) parts.push(`${state.startDate} → ${state.endDate}`);
  else if (state.startDate) parts.push(`from ${state.startDate}`);
  else if (state.endDate) parts.push(`through ${state.endDate}`);
  if (state.frameDate) parts.push(`frame ${state.frameDate}`);
  if(state.culture!=='all')parts.push(`culture: ${state.culture}`);
  if(state.gaia)parts.push('Gaia markers');
  if (state.wise) parts.push('AllWISE markers');
  if (Number.isFinite(state.markRaDeg) && Number.isFinite(state.markDecDeg)) {
    parts.push(`marked source ${state.markRaDeg.toFixed(4)}°, ${signed(state.markDecDeg)}°`);
  }
  return parts.join(' · ');
}

function refresh() {
  const summary = $('share-summary');
  if (summary) summary.textContent = summaryText();
  const clear = $('clear-mark');
  const state = currentViewState();
  if (clear) clear.hidden = !(Number.isFinite(state.markRaDeg) && Number.isFinite(state.markDecDeg));
}

export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* Falls through to the selection-based path. */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

function renderNotice() {
  const notice = $('share-notice');
  if (!notice) return;
  const lines = [];
  if (initialViewState.note) {
    const line = document.createElement('p');
    const label = document.createElement('strong');
    label.textContent = 'From the SphereX guide: ';
    line.className = 'share-notice-note';
    line.append(label, initialViewState.note);
    lines.push(line);
  }
  for (const text of initialViewIssues) {
    const line = document.createElement('p');
    line.textContent = text;
    lines.push(line);
  }
  if (!lines.length) { notice.hidden = true; return; }
  notice.replaceChildren(...lines);
  notice.hidden = false;
}

function mount() {
  renderNotice();
  if (isEmbedded) document.documentElement.classList.add('is-embed');
  refresh();

  $('copy-link')?.addEventListener('click', async () => {
    const url = shareUrl();
    const ok = await copyText(url);
    announce(ok ? `Link copied — it reopens this exact sky position at ${url.replace(/^https?:\/\/[^/]+/, '') || 'the default view'}.`
      : 'Copying failed. Select the address bar to copy this view.', { error: !ok });
  });

  $('copy-embed')?.addEventListener('click', async () => {
    const panel = $('embed-panel');
    const code = $('embed-code');
    if (!panel || !code) return;
    const snippet = embedSnippet();
    code.value = snippet;
    panel.hidden = false;
    code.focus();
    code.select();
    const ok = await copyText(snippet);
    announce(ok ? 'Embed code copied. Paste it into any page to show this view.'
      : 'Embed code ready below — copy it from the box.', { error: !ok });
  });

  $('clear-mark')?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('sky:clear-source-mark'));
    announce('Marked source cleared.');
  });

  for (const type of ['sky:target-selected', 'sky:viewer-settings-changed', 'sky:search-filters-changed',
    'sky:source-marked', 'sky:frame-shown', 'sky:context-settings-changed']) {
    window.addEventListener(type, refresh);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
