// The AI guide section: a chat that runs a tool-calling loop against
// /api/agent (an OpenRouter proxy) and executes each tool call on the real
// viewer. It also shows numbered spot chips, the red-dot nudge on the AI icon,
// live step narration, plan lines, case cards and report cards, and checks
// every reply (lib/agent-guard.js) before the visitor sees it.

import { validateToolCall } from './lib/agent-tools.js';
import { checkReply, stripProblems, correctionPrompt, asksPermission, plainToolNames } from './lib/agent-guard.js';
import { summarize } from './lib/case-file.js';
import { describeDone } from './lib/background-jobs.js';
import { createViewerController } from './agent-controller.js';
import { copyText } from './share-ui.js';
import { isEmbedded } from './share.js';

const MAX_ROUNDS = 16;
const MAX_HISTORY = 40;
const MAX_RESULT_CHARS = 3000;
const OLD_RESULT_CHARS = 300;
const TIGHT_HISTORY = 20;
const SLOW_RETRIES = 2;
const DRAFT_KEY = 'spherex-guide-draft-v1';

const $ = id => document.getElementById(id);
const controller = createViewerController();
let history = [];
let running = null;
let attached = new Set();   // spot numbers attached to the next message
let knownSpots = [];
let started = false;
const sceptical = new Set(); // spots the sceptic already reviewed
let inbox = [];              // finished background jobs the guide has not read yet
let inboxTimer = null;

const formatSpot = spot => `${spot.raDeg.toFixed(3)}°, ${spot.decDeg >= 0 ? '+' : ''}${spot.decDeg.toFixed(3)}°`;

const describe = {
  get_view_state: () => 'Checked what the viewer is showing',
  set_display: ({ changes }) => `Adjusted the display (${Object.entries(changes).map(([key, value]) => `${key} ${value}`).join(', ')})`,
  set_view_mode: ({ changes }) => `Switched to ${changes.viewMode}${changes.referenceFrame ? ` vs ${changes.referenceFrame} frame` : ''}`,
  compare_frames: args => `Compared frames (${args.view} against ${args.reference === 'frame' ? `frame ${args.reference_frame || args.reference_date}` : `${args.reference} frame`})`,
  playback: args => `Timeline: ${args.action.replaceAll('_', ' ')}${args.frame ? ` ${args.frame}` : ''}${args.date ? ` ${args.date}` : ''}${args.speed ? ` ${args.speed}×` : ''}`,
  set_view: ({ changes, gaia }) => [
    changes.band && `detector D${changes.band}`,
    changes.fovArcmin && `${changes.fovArcmin}′ field`,
    (typeof gaia === 'boolean' || 'showCrosshair' in changes || 'showCompass' in changes || 'qualityOverlay' in changes) && 'overlays'
  ].filter(Boolean).join(', ').replace(/^/, 'Changed '),
  go_to_target: args => `Moving to ${args.preset || args.name || `${args.raDeg.toFixed(3)}°, ${args.decDeg.toFixed(3)}°`}`,
  make_share_link: () => 'Made a share link',
  take_snapshot: () => 'Took a snapshot of the viewer',
  compare_side_by_side: args => 'Put ' + args.panels.length + ' views side by side',
  find_changes: () => 'Listed the changes in the difference image',
  mark_target: () => 'Marked the target star where it is on this date',
  mark_spot: args => args.radiusArcsec ? 'Marked an area' : 'Marked a spot',
  resize_spot: args => args.radiusArcsec ? `Resized spot ${args.spot}` : `Made spot ${args.spot} a point`,
  remove_spots: args => args.all ? 'Removed all spots' : args.keep ? `Kept only spot${args.keep.length > 1 ? 's' : ''} ${args.keep.join(', ')}` : `Removed spot${args.spots.length > 1 ? 's' : ''} ${args.spots.join(', ')}`,
  measure_source: args => `Measured spot ${args.spot} on each date`,
  get_spectrum: args => `Measured spot ${args.spot} across wavelengths`,
  crossmatch: args => `Checked spot ${args.spot} against star catalogues (Gaia, CatWISE, SIMBAD) and JPL`,
  confirm_motion: args => `Checked whether spot ${args.spot} moves in a straight line across dates`,
  get_case: args => `Opened the case file for spot ${args.spot}`,
  pick_epochs: args => `Compared frames about ${args.gap_days} days apart`,
  predict_parallax_pair: args => `Predicted where spot ${args.spot} would be at ${args.distance_au} AU`,
  precover: args => `Looked for spot ${args.to_spot} in other frames`,
  second_opinion: args => `Asked for a vision second opinion on spot ${args.spot}`,
  start_quest: args => `Started the game “${args.id}”`,
  check_answer: args => `Checked spot ${args.spot} against the answer`,
  planet_nine_region: args => args.go ? 'Moving to the Planet Nine region' : 'Read the Planet Nine region map',
  patrol: args => `Patrolling ${args.cells} Planet Nine cells`,
  start_tour: () => 'Playing the tour',
  prepare_report: args => `Prepared a report for spot ${args.spot}`
};

// What the activity row says while each tool runs.
const ACTIVITY = {
  get_view_state: 'Looking at the screen…',
  set_display: 'Adjusting the stretch…',
  set_view_mode: 'Switching views…',
  compare_frames: 'Blinking frames…',
  playback: 'Scrubbing the timeline…',
  set_view: 'Changing the view…',
  go_to_target: 'Slewing to the target…',
  make_share_link: 'Writing a share link…',
  take_snapshot: 'Taking a snapshot…',
  compare_side_by_side: 'Photographing each view…',
  find_changes: 'Squinting at pixels…',
  mark_target: 'Finding the star on this date…',
  mark_spot: 'Placing a marker…',
  resize_spot: 'Resizing the marker…',
  remove_spots: 'Tidying up the markers…',
  measure_source: 'Measuring brightness on each date…',
  get_spectrum: 'Splitting the light into colours…',
  crossmatch: 'Asking Gaia, CatWISE, SIMBAD and JPL who lives here…',
  confirm_motion: 'Following it across the dates…',
  get_case: 'Opening the case file…',
  pick_epochs: 'Finding photos six months apart…',
  predict_parallax_pair: 'Working out the parallax…',
  precover: 'Rewinding older photos…',
  second_opinion: 'Getting a second pair of eyes…',
  start_quest: 'Setting up the game…',
  check_answer: 'Checking your answer…',
  planet_nine_region: 'Unrolling the Planet Nine map…',
  patrol: 'On patrol…',
  start_tour: 'Starting the tour…',
  prepare_report: 'Filling in the report…'
};
const THINKING = ['Consulting the star charts…', 'Thinking…', 'Weighing the suspects…', 'Squinting at the infrared…', 'Planning the next step…'];
let thinkingTimer = null;

// Keep the newest message in view while the visitor follows the chat. Scrolling
// up to reread stops the follow; sending a message (or scrolling back down)
// resumes it. A message taller than the log is shown from its first line.
let followLog = true;
let logWatched = false;
function watchLog(log) {
  if (logWatched) return;
  logWatched = true;
  log.addEventListener('scroll', () => { followLog = log.scrollHeight - log.scrollTop - log.clientHeight < 48; }, { passive: true });
  // The activity row and composer change the log's height without a new entry.
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (followLog) log.scrollTop = log.scrollHeight; }).observe(log);
}
function revealEntry(item, { force = false } = {}) {
  const log = $('ai-guide-log');
  if (!log) return;
  watchLog(log);
  if (force) followLog = true;
  if (!followLog) return;
  // Wait a frame so the layout (e.g. the chat filling the panel) has settled.
  requestAnimationFrame(() => {
    if (item.offsetHeight > log.clientHeight - 24) {
      log.scrollTop += item.getBoundingClientRect().top - log.getBoundingClientRect().top - 8;
    } else log.scrollTop = log.scrollHeight;
  });
}

function setActivity(text, { thinking = false } = {}) {
  const row = $('ai-guide-activity');
  clearInterval(thinkingTimer);
  if (!row) return;
  if (!text) { row.hidden = true; $('ai-guide-status').textContent = ''; return; }
  row.hidden = false;
  $('ai-guide-activity-text').textContent = text;
  $('ai-guide-status').textContent = text;
  if (thinking) {
    let index = 0;
    thinkingTimer = setInterval(() => { index = (index + 1) % THINKING.length; $('ai-guide-activity-text').textContent = THINKING[index]; }, 2400);
  }
}

// Model text is untrusted: render it as text, with only **bold** and line breaks.
function renderRichText(container, text) {
  for (const [index, block] of String(text).trim().split(/\n{2,}/).entries()) {
    const paragraph = document.createElement('p');
    if (index === 0) paragraph.className = 'first';
    block.split('\n').forEach((line, lineIndex) => {
      if (lineIndex) paragraph.append(document.createElement('br'));
      line.split(/\*\*(.+?)\*\*/g).forEach((part, partIndex) => {
        if (!part) return;
        if (partIndex % 2) { const strong = document.createElement('strong'); strong.textContent = part; paragraph.append(strong); }
        else appendLinked(paragraph, part.replace(/^\s*[-*]\s+/, '• '));
      });
    });
    container.append(paragraph);
  }
}

// Only links back into this viewer become clickable; any other address stays
// plain text, so a model reply can never send a visitor somewhere unexpected.
function viewerLink(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === location.origin && /^\/(?:viewer\.html)?$/.test(parsed.pathname) ? parsed.href : null;
  } catch { return null; }
}
function linkElement(href, text) {
  const link = document.createElement('a');
  link.href = href; link.target = '_blank'; link.rel = 'noopener'; link.className = 'ai-guide-link';
  link.textContent = text;
  return link;
}
const LINK_PATTERN = /\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g;
function appendLinked(parent, text) {
  let last = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    if (match.index > last) parent.append(text.slice(last, match.index));
    const href = viewerLink(match[2] || match[3]);
    if (href) parent.append(linkElement(href, match[1] || 'Open this view ↗'));
    else parent.append(match[0]);
    last = match.index + match[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

// Pictures the guide took of the viewer: one, or several side by side. Each
// opens its exact view in a new tab, since the viewer holds one image at a time.
function renderSnapshot({ caption, panels }) {
  const item = document.createElement('li');
  item.className = 'ai-guide-entry is-snapshot';
  if (caption) { const title = document.createElement('p'); title.className = 'ai-guide-snapshot-title'; title.textContent = caption; item.append(title); }
  const grid = document.createElement('div');
  grid.className = `ai-guide-snapshot-grid is-${Math.min(panels.length, 4)}`;
  for (const panel of panels) {
    const figure = document.createElement('figure');
    figure.className = 'ai-guide-snapshot';
    if (panel.src) {
      const image = document.createElement('img');
      image.src = panel.src; image.alt = panel.label || panel.caption || 'Snapshot of the viewer';
      image.loading = 'lazy'; image.title = 'Click to enlarge';
      image.addEventListener('click', () => grid.classList.toggle('is-expanded'));
      figure.append(image);
    } else {
      const missing = document.createElement('div');
      missing.className = 'ai-guide-snapshot-missing'; missing.textContent = panel.error || 'Not available';
      figure.append(missing);
    }
    const label = document.createElement('figcaption');
    label.textContent = panel.label || panel.caption || '';
    if (panel.label && panel.caption && panel.caption !== panel.label) label.title = panel.caption;
    const href = panel.link && viewerLink(panel.link);
    if (href || panel.src) {
      const actions = document.createElement('span');
      actions.className = 'ai-guide-snapshot-actions';
      if (href) actions.append(linkElement(href, 'Open view ↗'));
      if (panel.src) {
        const save = document.createElement('a');
        save.href = panel.src; save.className = 'ai-guide-link';
        save.download = `spherex-${(panel.date || 'view').slice(0, 10)}${panel.band ? `-${panel.band}` : ''}.jpg`;
        save.textContent = 'Save';
        actions.append(save);
      }
      label.append(actions);
    }
    figure.append(label);
    grid.append(figure);
  }
  item.append(grid);
  $('ai-guide-log').append(item);
  revealEntry(item);
  $('ai-guide-reset').hidden = false;
}

// Background jobs the guide left running (deep stacks, slow lookups): a count
// in the guide's header and on the guide button, so the visitor knows to wait.
function showJobs(list) {
  const count = list.length;
  const names = list.map(job => job.label).join(', ');
  const header = $('ai-guide-jobs'), badge = $('agent-jobs-badge');
  if (header) {
    header.hidden = !count;
    $('ai-guide-jobs-text').textContent = count === 1 ? '1 job running' : `${count} jobs running`;
    header.title = count ? `Still working in the background: ${names}` : '';
  }
  if (badge) {
    badge.hidden = !count;
    badge.textContent = String(count);
    badge.title = header?.title || '';
  }
}

function addEntry(kind, text, { chips = [] } = {}) {
  const item = document.createElement('li');
  item.className = `ai-guide-entry is-${kind}`;
  if (chips.length) {
    const row = document.createElement('span');
    row.className = 'ai-guide-quote-row';
    for (const spot of chips) {
      const chip = document.createElement('span');
      chip.className = 'ai-guide-quote';
      chip.textContent = `↩ Spot ${spot.n}`;
      chip.title = formatSpot(spot);
      row.append(chip);
    }
    item.append(row);
  }
  if (kind === 'guide' || kind === 'plan' || kind === 'sceptic') {
    if (kind === 'sceptic') { const who = document.createElement('strong'); who.className = 'ai-guide-who'; who.textContent = 'Sceptic'; item.append(who); }
    renderRichText(item, text);
  } else if (text) item.append(document.createTextNode(text));
  $('ai-guide-log').append(item);
  revealEntry(item, { force: kind === 'user' });
  $('ai-guide-reset').hidden = false;
  return item;
}

function showShare(url, note) {
  $('ai-guide-share').hidden = false;
  $('ai-guide-share-url').value = url;
  $('ai-guide-share-open').href = url;
  $('ai-guide-share-note').textContent = note ? `Note for viewers: “${note}”` : '';
}

// ---- case and report cards ---------------------------------------------------
const caseCards = new Map();
const STATUS_ICON = { ruled_out: '✗', supported: '✓', open: '?' };
const STATUS_TEXT = { ruled_out: 'ruled out', supported: 'supported', open: 'not checked yet' };

function renderCase(summary) {
  let item = caseCards.get(summary.spot);
  if (!item || !item.isConnected) {
    item = document.createElement('li');
    item.className = 'ai-guide-entry is-case';
    caseCards.set(summary.spot, item);
  }
  const heading = document.createElement('div');
  heading.className = 'case-head';
  const title = document.createElement('strong');
  title.textContent = `${summary.radiusArcsec ? 'Area' : 'Spot'} ${summary.spot}`;
  const badge = document.createElement('span');
  badge.className = `case-verdict is-${summary.verdict.label.split(' ')[0].replace(/[^a-z]/g, '')}`;
  badge.textContent = summary.verdict.label;
  heading.append(title, badge);
  const list = document.createElement('ul');
  list.className = 'case-suspects';
  for (const suspect of summary.suspects) {
    const row = document.createElement('li');
    row.className = `is-${suspect.status}`;
    row.title = suspect.evidence || STATUS_TEXT[suspect.status];
    const icon = document.createElement('span'); icon.className = 'case-icon'; icon.textContent = STATUS_ICON[suspect.status]; icon.setAttribute('aria-label', STATUS_TEXT[suspect.status]);
    const label = document.createElement('span'); label.textContent = suspect.label;
    row.append(icon, label);
    if (suspect.evidence) { const why = document.createElement('small'); why.textContent = suspect.evidence; row.append(why); }
    list.append(row);
  }
  for (const finding of summary.findings || []) {
    const row = document.createElement('li');
    row.className = 'is-finding';
    const icon = document.createElement('span'); icon.className = 'case-icon'; icon.textContent = '•'; icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.textContent = finding;
    row.append(icon, label);
    list.append(row);
  }
  const detail = document.createElement('p');
  detail.className = 'case-detail';
  detail.textContent = summary.verdict.detail;
  const parts = [heading, list, detail];
  // The case's own suggestion for the next check, sent like a prompt chip.
  const next = summary.verdict.suggest?.[0];
  if (next?.why) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'case-next';
    button.textContent = `Next: ${next.why}`;
    button.addEventListener('click', () => submit(`Spot ${summary.spot}: ${next.why}`));
    parts.push(button);
  }
  item.replaceChildren(...parts);
  $('ai-guide-log').append(item);
  revealEntry(item);
  const direct = $('direct-case-card');
  if (direct) {
    direct.replaceChildren(...[...item.childNodes].map(node => node.cloneNode(true)));
    direct.querySelector('.case-next')?.remove();
    direct.hidden = false;
  }
}

function renderReport(report) {
  const item = document.createElement('li');
  item.className = 'ai-guide-entry is-report';
  const title = document.createElement('strong');
  title.textContent = `Think you’ve got one? · Spot ${report.spot}`;
  const facts = document.createElement('dl');
  for (const [term, value] of [['Position', `${report.raDeg}°, ${report.decDeg}°`], ['Verdict', report.verdict], ['Ruled out', report.ruledOut.join('; ') || 'nothing yet'], ['Still open', report.stillOpen.join('; ') || 'nothing']]) {
    const dt = document.createElement('dt'); dt.textContent = term;
    const dd = document.createElement('dd'); dd.textContent = value;
    facts.append(dt, dd);
  }
  const note = document.createElement('p');
  note.className = 'case-detail';
  note.textContent = 'Most leads turn out to be artefacts or known objects, so please don’t call it a discovery. The team reviews every report.';
  const actions = document.createElement('div');
  actions.className = 'ai-guide-share-row';
  const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'share-button'; copy.textContent = 'Copy link';
  copy.addEventListener('click', async () => setActivity((await copyText(report.url)) ? 'Link copied.' : 'Copying failed — open the link and copy it.'));
  const open = document.createElement('a'); open.className = 'share-button'; open.href = report.url; open.target = '_blank'; open.rel = 'noopener'; open.textContent = 'Open ↗';
  actions.append(copy, open);
  if (report.canSend) {
    const send = document.createElement('button'); send.type = 'button'; send.className = 'share-button primary'; send.textContent = 'Send to the SphereX team';
    send.addEventListener('click', async () => {
      send.disabled = true;
      const { canSend, ...payload } = report;
      const response = await fetch('/api/cases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'report', payload }) }).catch(() => null);
      send.textContent = response?.ok ? 'Sent — thank you!' : 'Could not send; share the link instead.';
    });
    actions.append(send);
  }
  item.append(title, facts, note, actions);
  $('ai-guide-log').append(item);
  revealEntry(item);
}

// ---- red-dot nudge on the AI icon ----------------------------------------------
let noticeTimer = null;
const guideOpen = () => $('workspace')?.dataset.agentOpen === 'true';
function notify(text) {
  if (isEmbedded || guideOpen()) return;
  const toggle = $('agent-toggle'), bubble = $('agent-notice');
  toggle?.classList.add('has-notice');
  if (toggle) toggle.title = `AI guide · ${text}`;
  if (!bubble) return;
  bubble.textContent = text;
  bubble.hidden = false;
  bubble.classList.remove('is-fading');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => bubble.classList.add('is-fading'), 5000);
}
function clearNotice() {
  $('agent-toggle')?.classList.remove('has-notice');
  if ($('agent-toggle')) $('agent-toggle').title = 'AI guide';
  if ($('agent-notice')) $('agent-notice').hidden = true;
}

// ---- spot chips ------------------------------------------------------------------
function renderChips() {
  const row = $('ai-guide-spots');
  if (!row) return;
  const chips = knownSpots.filter(spot => attached.has(spot.n)).map(spot => {
    const chip = document.createElement('span');
    chip.className = `ai-guide-chip is-${spot.origin}${spot.found ? ' is-found' : ''}`;
    const label = document.createElement('span');
    label.textContent = `↩ Spot ${spot.n} · ${formatSpot(spot)}`;
    const remove = document.createElement('button');
    remove.type = 'button'; remove.textContent = '×';
    remove.setAttribute('aria-label', `Don't attach spot ${spot.n}`);
    remove.addEventListener('click', () => { attached.delete(spot.n); renderChips(); });
    chip.append(label, remove);
    return chip;
  });
  row.replaceChildren(...chips);
  row.hidden = !chips.length;
}

// Every round resends the conversation, so shorten older results to limit token use.
// `tight` (used when the model was too slow) keeps fewer messages and also
// shortens this question's earlier results, keeping only the latest round whole.
function trimmedHistory({ tight = false } = {}) {
  const userFrom = from => { let i = Math.max(0, from); while (i < history.length && history[i].role !== 'user') i++; return i; };
  let start = userFrom(history.length - MAX_HISTORY);
  if (tight) { const tighter = userFrom(history.length - TIGHT_HISTORY); if (tighter < history.length) start = tighter; }
  // Background results and guide checks arrive as user turns; only a real
  // visitor message starts a new question.
  const lastUser = history.findLastIndex(message => message.role === 'user' && !/^\[(Background result|Guide check|Sceptic)/.test(message.content));
  const cutBefore = tight ? Math.max(lastUser, history.findLastIndex(message => message.role === 'assistant' && message.tool_calls?.length)) : lastUser;
  return history.slice(start).map((message, offset) => message.role === 'tool' && start + offset < cutBefore && message.content.length > OLD_RESULT_CHARS
    ? { ...message, content: message.content.slice(0, OLD_RESULT_CHARS) + '…' } : message);
}

const wait = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

// When the reply isn't the guide's own JSON, the host or a proxy answered instead.
function unavailableReason(status) {
  if (status === 404 || status === 405) return `The AI guide isn't available on this server (HTTP ${status}).`;
  if (status === 504 || status === 408) return 'The guide took too long and the server cut it off. Please retry.';
  if (status === 502 || status === 503) return `The server is restarting or overloaded (HTTP ${status}). Please retry in a moment.`;
  return `The guide is unavailable right now (HTTP ${status}). Please retry.`;
}

// The model (not a data lookup) ran past the server's time budget, or a proxy cut it off.
const tooSlow = (status, data) => data.code === 'AGENT_TIMEOUT' || data.code === 'AGENT_UPSTREAM' || (!data.error && [408, 502, 503, 504].includes(status));

// A slow answer is retried with a shorter history, then with the server's fast
// model (OPENROUTER_FAST_MODEL; the server ignores `fast` when none is set).
async function ask(signal, { final = false, fast = false } = {}) {
  for (let attempt = 0, slow = 0; ; attempt++) {
    let response;
    try {
      response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: trimmedHistory({ tight: slow > 0 }), ...(final ? { final: true } : {}), ...(fast || slow >= SLOW_RETRIES ? { fast: true } : {}) }),
        signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw Object.assign(new Error("Can't reach the server. Check your connection and try again."), { code: 'NETWORK' });
    }
    const data = await response.json().catch(() => ({}));
    // Wait for the upstream rate limit before trying again.
    if (response.status === 429 && data.code === 'AGENT_BUSY' && attempt < 3) {
      const seconds = Math.min(60, Math.max(2, Math.ceil(Number(data.retryAfter) || 10)));
      for (let left = seconds; left > 0 && !signal.aborted; left--) {
        setActivity(`The AI guide is rate limited. Retrying in ${left} s…`);
        await wait(1000, signal);
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      continue;
    }
    if (!response.ok && tooSlow(response.status, data) && slow < SLOW_RETRIES) {
      slow++;
      setActivity('The guide is slow to answer — retrying…');
      await wait(1000, signal);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      continue;
    }
    if (!response.ok) {
      if (!data.error) console.warn('AI guide: /api/agent answered HTTP %d without a JSON error', response.status);
      throw Object.assign(new Error(data.error || unavailableReason(response.status)), { code: data.code || `HTTP_${response.status}` });
    }
    if (!data.message) throw new Error('The guide returned an empty answer.');
    return { message: data.message, flagged: data.flagged || [] };
  }
}

async function askSceptic(summary, signal) {
  if (sceptical.has(summary.spot)) return null;
  const capabilities = await controller.investigator.getCapabilities();
  if (!capabilities.critic) return null;
  sceptical.add(summary.spot);
  setActivity('The sceptic is reviewing the case…');
  try {
    const response = await fetch('/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'critic', case: summary }), signal });
    const data = await response.json().catch(() => ({}));
    return response.ok && data.objection ? data.objection : null;
  } catch { return null; }
}

// Tool errors carry hints meant for the model ("Call compare_frames … first").
// The log shows people only the plain part; the model still gets the full text.
function forPeople(error) {
  const text = String(error || 'Something went wrong');
  const mentionsTool = s => /\b[a-z]+_[a-z_]+\b/.test(s);
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
  const kept = sentences.filter(s => !mentionsTool(s)).join('').trim();
  if (kept) return kept;
  const lead = text.split(':')[0].trim();
  return mentionsTool(lead) ? 'Not possible right now.' : `${lead}.`;
}

async function runTool(call, signal, turnSources) {
  const checked = validateToolCall(call.function?.name, call.function?.arguments);
  if (!checked.ok) return { ok: false, error: checked.error };
  setActivity(ACTIVITY[checked.name] || 'Working the viewer…');
  const label = describe[checked.name]?.(checked.args) || checked.name;
  const line = addEntry('action', `↳ ${label}…`);
  const progress = text => { addEntry('progress', text); setActivity(text); };
  const result = await controller.execute(checked.name, checked.args, { signal, progress });
  line.textContent = `↳ ${label}${result.ok === false ? ` — ${forPeople(result.error)}` : result.pending ? ' — still loading' : ''}`;
  line.classList.toggle('is-failed', result.ok === false);
  if (checked.name === 'make_share_link' && result.url) showShare(result.url, result.note);
  turnSources.push(JSON.stringify(result));
  return result;
}

// Finished background jobs become messages the guide reads before its next step.
function drainInbox(turnSources) {
  const done = inbox;
  inbox = [];
  for (const job of done) {
    const content = describeDone(job);
    history.push({ role: 'user', content });
    turnSources.push(content);
    const line = addEntry('action', `↳ Background: ${job.label} ${job.ok ? 'finished' : `stopped — ${forPeople(job.error)}`}`);
    line.classList.toggle('is-failed', !job.ok);
  }
  return done.length;
}

// Resolve when a background job reports back, or after `ms`.
function waitForInbox(ms, signal) {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); window.removeEventListener('sky:agent-job-done', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    window.addEventListener('sky:agent-job-done', finish);
    signal.addEventListener('abort', finish, { once: true });
  });
}

const BACKGROUND_TURN = 'The visitor did not type anything: the background results above arrived on their own. In 1-2 sentences, tell the visitor what they changed. Run a follow-up check only if one clearly helps. Do not ask questions.';

// When the guide is idle and a background job finishes, pick it back up on its own.
function scheduleBackgroundTurn() {
  clearTimeout(inboxTimer);
  // A short pause lets several jobs that finish together share one turn.
  inboxTimer = setTimeout(() => {
    if (!inbox.length || running) return;
    setStarted(true);
    void converse(null, []);
  }, 400);
}

async function converse(text, chips) {
  const abort = new AbortController();
  running = abort;
  $('ai-guide-send').disabled = true;
  $('ai-guide-stop').hidden = false;
  const turnSources = [];
  drainInbox(turnSources);
  if (text === null) {
    // A background-only turn: no visitor bubble, just the results.
    history.push({ role: 'user', content: `[Guide check] ${BACKGROUND_TURN}` });
  } else {
    const prefix = chips.map(spot => `[Spot ${spot.n}: ra=${spot.raDeg.toFixed(5)}, dec=${spot.decDeg.toFixed(5)}${spot.radiusArcsec ? `, area radius=${spot.radiusArcsec}arcsec` : ''}, origin=${spot.origin}]`).join('\n');
    const content = prefix ? `${prefix}\n${text}` : text;
    history.push({ role: 'user', content });
    addEntry('user', text, { chips });
    turnSources.push(content);
  }
  let corrected = false;
  let nudged = false;
  let redraft = false;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      drainInbox(turnSources);
      if (redraft) {
        redraft = false;
        history.push({ role: 'user', content: `[Guide check] Your draft was not shown because new results arrived. Write the complete answer for the visitor now: everything found ${text === null ? 'in these results' : 'for their request'}, updated with the new results.` });
      }
      setActivity(round ? 'Reading the results…' : THINKING[0], { thinking: true });
      const final = round === MAX_ROUNDS - 1;
      if (final) history.push({ role: 'user', content: '[Guide check] Step budget reached: stop calling tools and summarise briefly what was measured, what was ruled out and what is still open.' });
      // A background-only turn needs just 1-2 sentences: use the fast model.
      const { message, flagged } = await ask(abort.signal, { final, fast: text === null });
      history.push(message);
      const plan = /^\s*plan:/i.test(message.content || '');
      if (!message.tool_calls?.length) {
        const reply = message.content || 'Done.';
        const check = checkReply(reply, turnSources);
        if (flagged.length) check.forbidden.push(...flagged.filter(phrase => !check.forbidden.includes(phrase)));
        check.ok = !check.ungrounded.length && !check.forbidden.length && !check.leaked.length;
        // A background result landed while the guide was writing: let it read
        // that first rather than send an answer that is already out of date.
        if (inbox.length && !final) { redraft = true; continue; }
        // Once per turn, send the guide back to work instead of handing the
        // next step to the visitor.
        const askedPermission = !nudged && !final && text !== null && asksPermission(reply);
        const rewrite = !check.ok && !corrected && !final;
        if (rewrite || askedPermission) {
          // The visitor never sees the rejected draft.
          if (rewrite) corrected = true;
          if (askedPermission) nudged = true;
          history.push({ role: 'user', content: `[Guide check] ${correctionPrompt(rewrite ? check : {}, { askedPermission })}` });
          continue;
        }
        const shown = check.ok ? reply : stripProblems(reply, check) || 'I could not phrase that from the measurements alone. Ask me to measure it first.';
        addEntry(plan ? 'plan' : 'guide', shown);
        if (check.ungrounded.length || check.forbidden.length) addEntry('note', 'Some statements were removed because no measurement backed them.');
        return;
      }
      if (message.content) addEntry(plan ? 'plan' : 'guide', plainToolNames(message.content));
      let objection = null;
      for (const call of message.tool_calls) {
        if (abort.signal.aborted) return;
        const result = await runTool(call, abort.signal, turnSources);
        const resultText = JSON.stringify(result);
        history.push({ role: 'tool', tool_call_id: call.id, content: resultText.length > MAX_RESULT_CHARS ? resultText.slice(0, MAX_RESULT_CHARS) : resultText });
        if (!objection && String(result.case?.label || '').startsWith('unexplained')) {
          const file = controller.investigator.cases.get(result.spot ?? result.toSpot);
          if (file) objection = { spot: file.spot, text: await askSceptic(summarize(file), abort.signal) };
        }
      }
      // Only re-checking the screen while a background job runs is polling:
      // sleep until a job reports back instead of spending a step on it.
      if (!inbox.length && controller.jobs.running().length && message.tool_calls.every(call => call.function?.name === 'get_view_state')) {
        setActivity(`Waiting for ${controller.jobs.running()[0].label.toLowerCase()}…`);
        await waitForInbox(45_000, abort.signal);
      }
      if (objection?.text) {
        addEntry('sceptic', objection.text);
        turnSources.push(objection.text);
        history.push({ role: 'user', content: `[Sceptic on spot ${objection.spot}] ${objection.text} Answer this briefly, or run the check it suggests.` });
      }
    }
    addEntry('guide', 'I took several steps and stopped there. Ask me to continue if you want more.');
  } catch (error) {
    if (abort.signal.aborted) { addEntry('note', 'Stopped.'); return; }
    // The background result is already in the spot's case file, so a failed
    // comment on it is not worth a red error.
    if (text === null) addEntry('note', 'The background result is in the spot\'s case file. The guide couldn\'t comment on it just now.');
    else addEntry('error', error.message || 'Something went wrong. Please try again.');
    // Drop an unanswered tool request so the next question starts cleanly.
    const last = history.at(-1);
    if (last?.role === 'assistant' && last.tool_calls?.length) history.pop();
  } finally {
    if (running === abort) running = null;
    setActivity('');
    $('ai-guide-send').disabled = false;
    $('ai-guide-stop').hidden = true;
    if (inbox.length && !abort.signal.aborted) scheduleBackgroundTurn();
  }
}

async function playTour() {
  if (running) return;
  const abort = new AbortController();
  running = abort;
  setStarted(true);
  $('ai-guide-send').disabled = true;
  $('ai-guide-stop').hidden = false;
  addEntry('user', 'Take me on the tour.');
  try {
    const result = await controller.execute('start_tour', { id: 'highlights' }, {
      signal: abort.signal,
      progress: text => { addEntry(text.startsWith('(') ? 'note' : 'guide', text); setActivity(ACTIVITY.start_tour); }
    });
    addEntry('guide', result.ok === false ? result.error : result.outro);
  } finally {
    if (running === abort) running = null;
    setActivity('');
    $('ai-guide-send').disabled = false;
    $('ai-guide-stop').hidden = true;
    if (inbox.length) scheduleBackgroundTurn();
  }
}

async function runDirectTool(name, args, label) {
  if (running) return;
  const abort = new AbortController();
  running = abort;
  setStarted(true);
  $('ai-guide-send').disabled = true;
  $('ai-guide-stop').hidden = false;
  addEntry('action', `↳ ${label}…`);
  try {
    const result = await controller.execute(name, args, {
      signal: abort.signal,
      progress: text => addEntry(text.startsWith('(') ? 'note' : 'progress', text)
    });
    if (result.ok === false) { addEntry('guide', forPeople(result.error)); $('direct-action-status').textContent = forPeople(result.error); }
    else if (name === 'start_quest') { const message = `${result.title}: ${result.goal} Use Mark on the image, click your answer, then press Ask to request an answer check. This game is running directly; no model is needed to start it.`; addEntry('guide', message); $('direct-action-status').textContent = message; }
    else if (name === 'check_answer') { const message = result.correct ? `Correct — ${result.story || 'you found it.'} ${result.lesson || ''}` : result.correct === false ? `Not yet. ${result.hint || 'Try another marked spot.'}` : result.note || 'The answer needs more evidence.'; addEntry('guide', message); $('direct-action-status').textContent = message; }
    else { const message = `Case file opened for Spot ${args.spot}. Verdict: ${result.verdict?.label || 'evidence recorded'}.`; addEntry('guide', message); $('direct-action-status').textContent = message; }
  } catch (error) {
    const message = forPeople(error?.message); addEntry('guide', message); $('direct-action-status').textContent = message;
  } finally {
    if (running === abort) running = null;
    $('ai-guide-send').disabled = false;
    $('ai-guide-stop').hidden = true;
    setActivity('');
  }
}

function setStarted(value) {
  started = value;
  const section = $('ai-guide');
  section?.classList.toggle('is-chatting', value);
  // Lets the chat log fill the panel once a conversation starts (styles.css).
  section?.classList.toggle('has-conversation', value);
  const intro = section?.querySelector('.ai-guide-intro'), cards = $('ai-guide-suggestions'), more = $('ai-guide-more');
  if (intro) intro.hidden = value;
  if (cards) cards.hidden = value;
  if (more) { more.hidden = !value; more.setAttribute('aria-expanded', 'false'); }
}

function submit(text) {
  const value = text.trim();
  if (!value || running) return;
  $('ai-guide-input').value = '';
  autosize($('ai-guide-input'));
  try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* storage unavailable */ }
  const chips = knownSpots.filter(spot => attached.has(spot.n));
  attached = new Set();
  renderChips();
  setStarted(true);
  void converse(value, chips);
}

// Grow the composer with its text (up to the CSS max-height), then scroll inside it.
function autosize(input) {
  input.style.height = 'auto';
  const max = parseFloat(getComputedStyle(input).maxHeight) || Infinity;
  const height = Math.min(input.scrollHeight, max);
  input.style.height = `${height}px`;
  input.style.overflowY = input.scrollHeight > max ? 'auto' : 'hidden';
}

function mount() {
  const section = $('ai-guide');
  if (!section) return;
  if (isEmbedded) { section.hidden = true; return; }
  const input = $('ai-guide-input');
  try { input.value = sessionStorage.getItem(DRAFT_KEY) || ''; } catch { /* storage unavailable */ }
  input.addEventListener('input', () => {
    autosize(input);
    try { sessionStorage.setItem(DRAFT_KEY, input.value); } catch { /* storage unavailable */ }
  });
  // The panel starts hidden, so size the restored draft once it can be measured.
  new ResizeObserver(() => autosize(input)).observe(input.parentElement);
  // Clicking the box's padding focuses the textarea, as in a chat composer.
  $('ai-guide-form').addEventListener('mousedown', event => {
    if (event.target === event.currentTarget) { event.preventDefault(); input.focus(); }
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(input.value); }
  });
  $('ai-guide-form').addEventListener('submit', event => { event.preventDefault(); submit(input.value); });
  $('ai-guide-stop').addEventListener('click', () => running?.abort());
  for (const chip of section.querySelectorAll('[data-prompt]')) chip.addEventListener('click', () => submit(chip.dataset.prompt));
  for (const card of section.querySelectorAll('[data-direct-quest]')) card.addEventListener('click', () => runDirectTool('start_quest', { id: card.dataset.directQuest }, describe.start_quest({ id: card.dataset.directQuest })));
  for (const card of document.querySelectorAll('#challenge-launchpad [data-direct-quest]')) card.addEventListener('click', () => runDirectTool('start_quest', { id: card.dataset.directQuest }, describe.start_quest({ id: card.dataset.directQuest })));
  $('open-case-direct')?.addEventListener('click', () => {
    const spot = [...knownSpots].reverse().find(item => item.origin === 'user') || knownSpots.at(-1);
    if (!spot) { $('direct-action-status').textContent = 'Choose Mark beside the image and click a source first. Then open this case file directly.'; return; }
    void runDirectTool('get_case', { spot: spot.n }, `Open case file for Spot ${spot.n}`);
  });
  $('check-answer-direct')?.addEventListener('click', () => {
    const spot = [...knownSpots].reverse().find(item => item.origin === 'user');
    if (!spot) { $('direct-action-status').textContent = 'Mark your answer on the image first. The check runs directly and does not call the AI model.'; return; }
    void runDirectTool('check_answer', { spot: spot.n }, `Check Spot ${spot.n}`);
  });
  // The tour is scripted: it runs without the model, so it cannot stall on stage.
  section.querySelector('[data-action="tour"]')?.addEventListener('click', () => { void playTour(); });
  const launch = new URLSearchParams(location.search).get('launch');
  if (launch) {
    if (launch === 'tour') { $('agent-toggle')?.click(); setTimeout(() => { void playTour(); }, 120); }
    else if (launch === 'games') $('challenge-launchpad')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else {
      const quests = { hidden: 'hidden-planet', tombaugh: 'be-tombaugh', barnard: 'be-barnard', planetnine: 'be-leverrier' };
      if (quests[launch]) setTimeout(() => runDirectTool('start_quest', { id: quests[launch] }, `Started ${quests[launch]}`), 180);
      else if (launch === 'case') { $('challenge-launchpad')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); $('direct-action-status').textContent = 'Mark a source on the image, then use Open latest case file. No model request is made.'; }
    }
  }
  $('ai-guide-more')?.addEventListener('click', event => {
    const cards = $('ai-guide-suggestions'), open = cards.hidden;
    cards.hidden = !open;
    event.currentTarget.setAttribute('aria-expanded', String(open));
  });
  $('ai-guide-reset').addEventListener('click', () => {
    running?.abort();
    controller.jobs.cancelAll();
    inbox = [];
    clearTimeout(inboxTimer);
    history = [];
    caseCards.clear();
    sceptical.clear();
    $('ai-guide-log').replaceChildren();
    $('ai-guide-share').hidden = true;
    $('ai-guide-reset').hidden = true;
    setStarted(false);
    setActivity('');
  });
  $('ai-guide-share-copy').addEventListener('click', async () => {
    const ok = await copyText($('ai-guide-share-url').value);
    setActivity(ok ? 'Link copied.' : 'Copying failed — select the link and copy it.');
    setTimeout(() => { if (!running) setActivity(''); }, 2000);
  });

  // Spots: new user spots attach to the next message and nudge the AI icon.
  window.addEventListener('sky:spots-changed', event => {
    const next = Array.isArray(event.detail?.spots) ? event.detail.spots : [];
    const before = new Set(knownSpots.map(spot => `${spot.n}|${spot.raDeg}|${spot.decDeg}`));
    const added = next.filter(spot => !before.has(`${spot.n}|${spot.raDeg}|${spot.decDeg}`));
    knownSpots = next;
    for (const n of [...attached]) if (!next.some(spot => spot.n === n)) attached.delete(n);
    for (const spot of added) if (spot.origin === 'user') attached.add(spot.n);
    renderChips();
    const user = added.filter(spot => spot.origin === 'user');
    if (user.length === 1) notify(`Spot ${user[0].n} marked — ask the guide about it`);
    else if (user.length) notify(`Spots ${user.map(spot => spot.n).join(', ')} marked — ask the guide about them`);
    else if (added.length) notify(`The guide marked ${added.length === 1 ? `spot ${added[0].n}` : `${added.length} spots`}`);
  });
  window.addEventListener('sky:spot-selected', event => {
    const spot = event.detail;
    if (!spot) return;
    attached.add(spot.n);
    renderChips();
    window.dispatchEvent(new CustomEvent('sky:open-agent'));
    input.focus();
  });
  window.addEventListener('sky:case-updated', event => {
    const summary = event.detail?.case;
    if (summary && (!event.detail.quiet || caseCards.get(summary.spot)?.isConnected)) renderCase(summary);
  });
  window.addEventListener('sky:report-ready', event => { if (event.detail?.report) renderReport(event.detail.report); });
  window.addEventListener('sky:agent-snapshot', event => { if (event.detail?.panels?.length) renderSnapshot(event.detail); });
  window.addEventListener('sky:agent-jobs-changed', event => showJobs(Array.isArray(event.detail?.jobs) ? event.detail.jobs : []));
  window.addEventListener('sky:agent-job-done', event => {
    const done = event.detail;
    if (!done || !started) return;
    inbox.push(done);
    if (!guideOpen()) notify(`${done.label} finished`);
    if (!running) scheduleBackgroundTurn();
  });
  window.addEventListener('sky:agent-notice', event => { if (event.detail?.text) notify(event.detail.text); });

  // Contextual nudges: a quest for this preset, or a difference with many changes.
  const QUEST_HINTS = { barnard: 'Try the game “Be Barnard” in the AI guide', wise: 'Ask the guide to show WISE 0855 moving' };
  window.addEventListener('sky:target-selected', event => { const hint = QUEST_HINTS[event.detail?.targetId]; if (hint) notify(hint); });
  let nudgedDifference = '';
  window.addEventListener('sky:view-summary', event => {
    const detail = event.detail || {};
    if (detail.kind !== 'difference' || !(detail.brighterPixels + detail.fainterPixels >= 4)) return;
    const key = `${detail.caption}`;
    if (key === nudgedDifference) return;
    nudgedDifference = key;
    notify('Changes found — the guide can list and check them');
  });
  const workspace = $('workspace');
  if (workspace && typeof MutationObserver !== 'undefined') new MutationObserver(() => { if (guideOpen()) clearNotice(); }).observe(workspace, { attributes: true, attributeFilter: ['data-agent-open'] });

  // Hide cards whose feature this server has not enabled.
  void controller.investigator.getCapabilities().then(capabilities => {
    for (const card of section.querySelectorAll('[data-requires]')) card.hidden = !capabilities[card.dataset.requires];
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
