// The AI guide section: a chat that runs a tool-calling loop against
// /api/agent (an OpenRouter proxy) and executes each tool call on the real viewer.

import { validateToolCall } from './lib/agent-tools.js';
import { createViewerController } from './agent-controller.js';
import { copyText } from './share-ui.js';
import { isEmbedded } from './share.js';

const MAX_ROUNDS = 12;
const MAX_HISTORY = 36;
const MAX_RESULT_CHARS = 2500;
const OLD_RESULT_CHARS = 300;
const DRAFT_KEY = 'spherex-guide-draft-v1';

const $ = id => document.getElementById(id);
const controller = createViewerController();
let history = [];
let running = null;

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
  make_share_link: () => 'Made a share link'
};

function setStatus(text) { $('ai-guide-status').textContent = text; }

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
        else paragraph.append(part.replace(/^\s*[-*]\s+/, '• '));
      });
    });
    container.append(paragraph);
  }
}

function addEntry(kind, text) {
  const item = document.createElement('li');
  item.className = `ai-guide-entry is-${kind}`;
  if (kind === 'guide') renderRichText(item, text);
  else item.textContent = text;
  $('ai-guide-log').append(item);
  // Once the conversation starts, give the whole drawer to the chat: hide the
  // intro and prompt chips so the log can grow into the available height.
  $('ai-guide')?.classList.add('is-chatting');
  item.scrollIntoView?.({ block: 'nearest' });
  $('ai-guide-reset').hidden = false;
  return item;
}

function showShare(url, note) {
  $('ai-guide-share').hidden = false;
  $('ai-guide-share-url').value = url;
  $('ai-guide-share-open').href = url;
  $('ai-guide-share-note').textContent = note ? `Note for viewers: “${note}”` : '';
}

// Every round resends the conversation, so shorten older results to limit token use.
function trimmedHistory() {
  let start = Math.max(0, history.length - MAX_HISTORY);
  while (start < history.length && history[start].role !== 'user') start++;
  const lastUser = history.findLastIndex(message => message.role === 'user');
  return history.slice(start).map((message, offset) => message.role === 'tool' && start + offset < lastUser && message.content.length > OLD_RESULT_CHARS
    ? { ...message, content: message.content.slice(0, OLD_RESULT_CHARS) + '…' } : message);
}

const wait = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

async function ask(signal) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: trimmedHistory() }),
      signal
    });
    const data = await response.json().catch(() => ({}));
    // Wait for the upstream rate limit before trying again.
    if (response.status === 429 && data.code === 'AGENT_BUSY' && attempt < 3) {
      const seconds = Math.min(60, Math.max(2, Math.ceil(Number(data.retryAfter) || 10)));
      for (let left = seconds; left > 0 && !signal.aborted; left--) {
        setStatus(`The AI guide is rate limited. Retrying in ${left} s…`);
        await wait(1000, signal);
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      continue;
    }
    if (!response.ok) throw Object.assign(new Error(data.error || 'The guide is unavailable right now.'), { code: data.code });
    if (!data.message) throw new Error('The guide returned an empty answer.');
    return data.message;
  }
}

async function runTool(call, signal) {
  const checked = validateToolCall(call.function?.name, call.function?.arguments);
  if (!checked.ok) return { ok: false, error: checked.error };
  const line = addEntry('action', `↳ ${describe[checked.name]?.(checked.args) || checked.name}…`);
  const result = await controller.execute(checked.name, checked.args, { signal });
  line.textContent = `↳ ${describe[checked.name]?.(checked.args) || checked.name}${result.ok === false ? ` — ${result.error}` : result.pending ? ' — still loading' : ''}`;
  line.classList.toggle('is-failed', result.ok === false);
  if (checked.name === 'make_share_link' && result.url) showShare(result.url, result.note);
  return result;
}

async function converse(text) {
  const abort = new AbortController();
  running = abort;
  $('ai-guide-send').disabled = true;
  $('ai-guide-stop').hidden = false;
  history.push({ role: 'user', content: text });
  addEntry('user', text);
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      setStatus(round ? 'Working the viewer…' : 'Thinking…');
      const message = await ask(abort.signal);
      history.push(message);
      if (!message.tool_calls?.length) {
        addEntry('guide', message.content || 'Done.');
        return;
      }
      if (message.content) addEntry('guide', message.content);
      for (const call of message.tool_calls) {
        if (abort.signal.aborted) return;
        const result = await runTool(call, abort.signal);
        const content = JSON.stringify(result);
        history.push({ role: 'tool', tool_call_id: call.id, content: content.length > MAX_RESULT_CHARS ? content.slice(0, MAX_RESULT_CHARS) : content });
      }
    }
    addEntry('guide', 'I took several steps and stopped there. Ask me to continue if you want more.');
  } catch (error) {
    if (abort.signal.aborted) { addEntry('note', 'Stopped.'); return; }
    addEntry('error', error.message || 'Something went wrong. Please try again.');
    // Drop an unanswered tool request so the next question starts cleanly.
    const last = history.at(-1);
    if (last?.role === 'assistant' && last.tool_calls?.length) history.pop();
  } finally {
    if (running === abort) running = null;
    setStatus('');
    $('ai-guide-send').disabled = false;
    $('ai-guide-stop').hidden = true;
  }
}

function submit(text) {
  const value = text.trim();
  if (!value || running) return;
  $('ai-guide-input').value = '';
  try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* storage unavailable */ }
  void converse(value);
}

function mount() {
  const section = $('ai-guide');
  if (!section) return;
  if (isEmbedded) { section.hidden = true; return; }
  const input = $('ai-guide-input');
  try { input.value = sessionStorage.getItem(DRAFT_KEY) || ''; } catch { /* storage unavailable */ }
  input.addEventListener('input', () => { try { sessionStorage.setItem(DRAFT_KEY, input.value); } catch { /* storage unavailable */ } });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(input.value); }
  });
  $('ai-guide-form').addEventListener('submit', event => { event.preventDefault(); submit(input.value); });
  $('ai-guide-stop').addEventListener('click', () => running?.abort());
  for (const chip of section.querySelectorAll('[data-prompt]')) chip.addEventListener('click', () => submit(chip.dataset.prompt));
  $('ai-guide-reset').addEventListener('click', () => {
    running?.abort();
    history = [];
    $('ai-guide-log').replaceChildren();
    $('ai-guide-share').hidden = true;
    $('ai-guide-reset').hidden = true;
    section.classList.remove('is-chatting');
    setStatus('');
  });
  $('ai-guide-share-copy').addEventListener('click', async () => {
    const ok = await copyText($('ai-guide-share-url').value);
    setStatus(ok ? 'Link copied.' : 'Copying failed — select the link and copy it.');
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
