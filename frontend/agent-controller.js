// Executes the AI guide's validated tool calls on the real viewer and returns
// grounded, plain-data results. It talks to the other modules only through the
// same window events the controls use, then waits for the viewer to report
// what it actually rendered.

import { shareUrl } from './share.js';
import { presets } from './presets.js';
import { locateTarget } from './lib/target-locate.js';
import { createInvestigator } from './agent-investigate.js';
import { createJobs } from './lib/background-jobs.js';

const BANDS = ['0.75–1.09 μm', '1.10–1.62 μm', '1.63–2.41 μm', '2.42–3.82 μm', '3.83–4.41 μm', '4.42–5.00 μm'];
const DISPLAY_KEYS = ['look', 'brightness', 'contrast', 'stretch', 'scaleMode', 'colours', 'invert', 'smoothing'];

const pick = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]));
const $ = id => document.getElementById(id);
const emit = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail }));

export function createViewerController() {
  const latest = { settings: {}, playback: null, summary: null, summarySeq: 0, target: null, observations: { loading: false, count: 0, failed: false }, deepStack: null };
  window.addEventListener('sky:viewer-settings-changed', event => { latest.settings = { ...latest.settings, ...event.detail }; });
  window.addEventListener('sky:playback-state', event => { latest.playback = event.detail; });
  window.addEventListener('sky:view-summary', event => { latest.summary = event.detail; latest.summarySeq++; });
  // Slow lookups keep running after a tool returns; finished ones go to the chat.
  const jobs = createJobs({ onDone: done => emit('sky:agent-job-done', done), onChange: running => emit('sky:agent-jobs-changed', { jobs: running }) });
  window.addEventListener('sky:target-selected', event => { latest.target = { ...event.detail }; latest.summary = null; latest.deepStack = null; jobs.cancelAll(); });
  window.addEventListener('sky:observations-loading', () => { latest.observations = { loading: true, count: 0, failed: false }; });
  window.addEventListener('sky:observations-loaded', event => {
    latest.observations = { loading: false, count: Array.isArray(event.detail?.observations) ? event.detail.observations.length : 0, failed: Boolean(event.detail?.failed) };
  });
  window.addEventListener('sky:deep-stack-built', event => { latest.deepStack = event.detail?.record || null; });
  window.addEventListener('sky:timeline-frames-changed', event => { latest.frames = Array.isArray(event.detail?.frames) ? event.detail.frames : []; });

  /** Resolve with an event's detail (or null on timeout / abort). */
  function waitFor(type, { timeout = 15000, signal, test = () => true } = {}) {
    return new Promise(resolve => {
      let timer;
      const finish = value => { clearTimeout(timer); window.removeEventListener(type, listener); signal?.removeEventListener('abort', onAbort); resolve(value); };
      const listener = event => { if (test(event.detail)) finish(event.detail ?? {}); };
      const onAbort = () => finish(null);
      timer = setTimeout(() => finish(null), timeout);
      window.addEventListener(type, listener);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Wait until the viewer has rendered at least once and then gone quiet. */
  async function settle({ timeout = 15000, quiet = 700, signal, since = latest.summarySeq } = {}) {
    const deadline = Date.now() + timeout;
    while (latest.summarySeq === since) {
      if (signal?.aborted || Date.now() > deadline) return false;
      const remaining = deadline - Date.now();
      if (!(await waitFor('sky:view-summary', { timeout: remaining, signal }))) return false;
    }
    for (;;) {
      const seen = latest.summarySeq;
      await new Promise(resolve => setTimeout(resolve, quiet));
      if (latest.summarySeq === seen || signal?.aborted || Date.now() > deadline) return true;
    }
  }

  function playbackCommand(action, extra = {}) {
    return new Promise(resolve => {
      let answered = false;
      const respond = result => { if (!answered) { answered = true; resolve(result); } };
      emit('sky:agent-playback', { action, ...extra, respond });
      setTimeout(() => respond({ ok: false, error: 'The timeline did not respond.' }), 30000);
    });
  }

  function refreshPlayback() { emit('sky:agent-state-requested'); return latest.playback; }

  // Results are resent to the model on every later round, so keep them to the
  // facts it needs: the caption, the measurements, and where the timeline is.
  function imageSummary() {
    const summary = latest.summary;
    if (!summary) return null;
    const result = { kind: summary.kind, caption: summary.caption };
    if (summary.kind === 'difference') Object.assign(result, { sigma: Number(summary.sigma?.toPrecision?.(3)), thresholdSigma: summary.threshold, brighterPixels: summary.brighterPixels, fainterPixels: summary.fainterPixels });
    if (summary.usedFrames) Object.assign(result, { stackedDays: summary.usedFrames, availableDays: summary.availableFrames, exposures: summary.usedExposures, skippedExposures: summary.skippedExposures });
    return result;
  }

  function timeline() {
    const playback = refreshPlayback();
    if (!playback?.count) return { frames: 0, note: latest.observations.loading ? 'Observations still loading.' : latest.observations.failed ? 'Archive search failed.' : 'No frames loaded.' };
    return {
      frame: playback.frame, of: playback.count, date: playback.frameDate.slice(0, 16).replace('T', ' '),
      first: playback.firstDate, last: playback.lastDate, playing: playback.playing, speed: playback.speed,
      ...(playback.pinnedFrame ? { pinnedFrame: playback.pinnedFrame } : {})
    };
  }

  const MODE_OPTIONS = {
    blink: ['referenceFrame', 'blinkIntervalMs'], difference: ['referenceFrame', 'differenceThreshold'],
    'motion-trail': ['trailWindow'], 'deep-stack': ['maxStackFrames'], 'time-lapse': []
  };

  // A fast-moving preset is stored at its J2000 catalogue position, which is
  // empty sky years later; report where the star is on the frame on screen.
  function targetNow(presetId) {
    const fixed = value => Number.isFinite(value) ? Number(value.toFixed(4)) : null;
    const target = latest.target;
    const frameMs = Date.parse(refreshPlayback()?.frameDate || '');
    const base = { name: $('object-name')?.textContent || '', ...(presetId && presets[presetId] ? { about: presets[presetId].description } : {}) };
    const now = Number.isFinite(frameMs) ? locateTarget({ target, frameTime: frameMs }) : null;
    if (!now || now.method !== 'preset') return { ...base, raDeg: fixed(target?.raDeg), decDeg: fixed(target?.decDeg) };
    return {
      ...base, raDeg: fixed(now.raDeg), decDeg: fixed(now.decDeg),
      catalogRaDeg: fixed(target.raDeg), catalogDecDeg: fixed(target.decDeg),
      note: 'Moves fast: raDeg/decDeg is where it is on the current frame date; catalogRaDeg/catalogDecDeg (J2000) is now empty sky. To mark it, use mark_target.'
    };
  }

  function snapshot() {
    const settings = latest.settings;
    const presetId = latest.target?.targetId;
    const overlays = Object.entries({ gaia: Boolean($('gaia-stars')?.checked), crosshair: settings.showCrosshair, compass: settings.showCompass, qualityOverlay: settings.qualityOverlay }).filter(([, on]) => on).map(([name]) => name);
    const status = $('cutout-status')?.hidden ? '' : $('cutout-status')?.textContent || '';
    return {
      target: targetNow(presetId),
      band: settings.band ? `D${settings.band} ${BANDS[settings.band - 1]}` : null,
      fov: settings.fovArcmin,
      mode: settings.viewMode,
      ...pick(settings, ['followProperMotion', ...(MODE_OPTIONS[settings.viewMode] || [])]),
      display: pick(settings, DISPLAY_KEYS),
      overlays,
      timeline: timeline(),
      image: imageSummary(),
      ...(status ? { status } : {})
    };
  }

  function current() {
    const state = snapshot();
    return { mode: state.mode, timeline: state.timeline, image: state.image, ...(state.status ? { status: state.status } : {}) };
  }

  async function applySettings(changes, { signal, timeout = 15000 } = {}) {
    const since = latest.summarySeq;
    emit('sky:agent-settings-requested', { changes });
    const rendered = await settle({ timeout, signal, since });
    return rendered;
  }

  async function needFrames(signal) {
    if (latest.observations.loading) await waitFor('sky:observations-loaded', { timeout: 45000, signal });
    const playback = refreshPlayback();
    return playback?.count ? playback : null;
  }

  async function goToFrame(playback, { frame, date }) {
    if (frame) return playbackCommand('go_to_frame', { frame: Math.min(frame, playback.count) });
    if (date) return playbackCommand('go_to_date', { date });
    return playbackCommand('last_frame');
  }

  /** A link that reopens exactly what is on screen now. */
  async function viewLink(note = '') {
    refreshPlayback();
    // Give share.js its scheduled address-bar write a moment, then build the link.
    await new Promise(resolve => setTimeout(resolve, 250));
    return shareUrl({ embed: false, note });
  }

  /** Picture of the viewer as it is now, with a plain label and a link back to it. */
  async function shoot(label = '') {
    const picture = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 3000);
      emit('sky:snapshot-requested', { respond: value => { clearTimeout(timer); resolve(value); } });
    });
    if (!picture?.src) return null;
    const settings = latest.settings, playback = refreshPlayback();
    const date = settings.viewMode === 'deep-stack' ? '' : playback?.frameDate?.slice(0, 16).replace('T', ' ') || '';
    const band = settings.band ? `D${settings.band}` : '';
    const caption = latest.summary?.caption || [date && `${date} UTC`, band, settings.viewMode].filter(Boolean).join(' · ');
    const link = await viewLink(label || caption);
    return { src: picture.src, label: label || caption, caption, date, band, mode: settings.viewMode, frame: playback?.frame ?? null, link };
  }
  const describeShot = ({ label, caption, date, band, mode, frame, link, error }) => error ? { label, error } : { label, caption, date, band, mode, frame, link };

  async function showPanel(panel, { signal }) {
    const changes = {};
    if (panel.detector && panel.detector !== latest.settings.band) changes.band = panel.detector;
    const mode = panel.mode || (latest.settings.viewMode === 'blink' ? 'time-lapse' : latest.settings.viewMode);
    if (mode !== latest.settings.viewMode) changes.viewMode = mode;
    if (changes.viewMode === 'deep-stack') {
      latest.deepStack = null;
      const built = waitFor('sky:deep-stack-built', { timeout: 90000, signal });
      emit('sky:agent-settings-requested', { changes });
      if (!(await built)) return { error: 'The deep stack did not finish in time.' };
      await settle({ timeout: 3000, signal });
    } else if (Object.keys(changes).length) await applySettings(changes, { signal, timeout: changes.band ? 30000 : 10000 });
    if (mode !== 'deep-stack' && (panel.frame || panel.date)) {
      const playback = refreshPlayback();
      if (!playback?.count) return { error: 'No frames are loaded in this band.' };
      const since = latest.summarySeq;
      const moved = await goToFrame(playback, panel);
      if (!moved.ok) return { error: moved.error || 'That frame could not be shown.' };
      await settle({ timeout: 20000, signal, since });
    }
    return null;
  }

  const handlers = {
    async take_snapshot({ caption }) {
      const shot = await shoot(caption);
      if (!shot) return { ok: false, error: 'No image is on screen yet.' };
      emit('sky:agent-snapshot', { caption, panels: [shot] });
      return { ok: true, shownInChat: true, ...describeShot(shot) };
    },

    async compare_side_by_side({ panels, caption }, { signal }) {
      const playback = await needFrames(signal);
      if (!playback) return { ok: false, error: 'No observations are loaded for this target yet.' };
      // The viewer shows one image at a time: visit each panel, photograph it,
      // then put the viewer back where it was.
      const original = { band: latest.settings.band, viewMode: latest.settings.viewMode, frame: playback.frame };
      await playbackCommand('pause');
      const shots = [];
      try {
        for (const [index, panel] of panels.entries()) {
          if (signal?.aborted) break;
          const failed = await showPanel(panel, { signal });
          const shot = failed ? null : await shoot(panel.label);
          shots.push(shot || { label: panel.label || `Panel ${index + 1}`, error: failed?.error || 'No image was rendered.' });
        }
      } finally {
        const restore = {};
        if (original.band && latest.settings.band !== original.band) restore.band = original.band;
        if (original.viewMode && latest.settings.viewMode !== original.viewMode) restore.viewMode = original.viewMode;
        if (Object.keys(restore).length) await applySettings(restore, { timeout: restore.band ? 30000 : 10000 });
        const now = refreshPlayback();
        if (now?.count && original.frame && now.frame !== original.frame) await goToFrame(now, { frame: original.frame });
      }
      const pictures = shots.filter(shot => shot.src);
      if (!pictures.length) return { ok: false, error: shots[0]?.error || 'No panel could be photographed.', panels: shots.map(describeShot) };
      emit('sky:agent-snapshot', { caption, panels: shots });
      return { ok: true, shownInChat: true, note: 'The panels are side by side in the chat, each with a link that opens that view. The viewer is back where it was.', panels: shots.map(describeShot) };
    },

    async get_view_state() { return { ...snapshot(), spots: await investigator.spotsSummary(), ...(investigator.quest() ? { quest: investigator.quest().id } : {}), ...(jobs.running().length ? { backgroundJobs: jobs.running() } : {}) }; },

    async set_display({ changes }, { signal }) {
      const rendered = await applySettings(changes, { signal, timeout: 10000 });
      return { ok: true, applied: changes, display: pick(latest.settings, DISPLAY_KEYS), ...(rendered ? { image: imageSummary() } : { note: 'Settings applied; no image is on screen yet.' }) };
    },

    async set_view_mode({ changes }, { signal }) {
      if (changes.viewMode === 'deep-stack') {
        latest.deepStack = null;
        const built = waitFor('sky:deep-stack-built', { timeout: 60000, signal });
        emit('sky:agent-settings-requested', { changes });
        const record = await built;
        if (!record) {
          const job = jobs.start('deep-stack', 'Deep stack', async jobSignal => {
            if (!latest.deepStack && !(await waitFor('sky:deep-stack-built', { timeout: 240000, signal: jobSignal }))) throw new Error('the deep stack did not finish within 4 minutes');
            await settle({ timeout: 5000, signal: jobSignal });
            return current();
          });
          return { ok: true, background: job.id, note: 'The deep stack is still downloading. It keeps building in the background and its result will arrive on its own; carry on with other checks.', ...current() };
        }
        await settle({ timeout: 3000, signal });
        return { ok: true, ...current() };
      }
      const rendered = await applySettings(changes, { signal, timeout: 20000 });
      return { ok: true, applied: changes, ...current(), ...(rendered ? {} : { pending: 'The view is still loading.' }) };
    },

    async compare_frames(args, { signal }) {
      const playback = await needFrames(signal);
      if (!playback) return { ok: false, error: 'No observations are loaded for this target yet.' };
      if (playback.count < 2) return { ok: false, error: 'Only one frame is available, so there is nothing to compare against.' };
      const view = args.view;
      if (args.reference === 'frame') {
        // Pin the chosen reference, then move to the frame being compared.
        // A deep stack ignores the timeline, so switch to the comparison view first.
        if (latest.settings.viewMode !== view) await applySettings({ viewMode: view }, { signal, timeout: 8000 });
        await playbackCommand('pause');
        const moved = await goToFrame(playback, { frame: args.reference_frame, date: args.reference_date });
        if (!moved.ok) return moved;
        await playbackCommand('pin_reference');
      } else {
        await applySettings({ viewMode: view, referenceFrame: args.reference }, { signal, timeout: 8000 });
      }
      const since = latest.summarySeq;
      const moved = await goToFrame(playback, { frame: args.target_frame, date: args.target_date });
      if (!moved.ok) return moved;
      await settle({ timeout: 20000, signal, since });
      return { ok: true, compared: { view, reference: args.reference }, ...current() };
    },

    async playback(args, { signal }) {
      if (!(await needFrames(signal))) return { ok: false, error: 'No observations are loaded for this target yet.' };
      const since = latest.summarySeq;
      const result = await playbackCommand(args.action, args);
      if (!result.ok) return result;
      if (!['play', 'pause', 'set_speed'].includes(args.action)) await settle({ timeout: 8000, signal, since });
      return { ok: true, ...current() };
    },

    async set_view({ changes, gaia }, { signal }) {
      // Band and field-of-view changes download new cutouts; overlays are instant.
      const slow = 'band' in changes || 'fovArcmin' in changes;
      const rendered = Object.keys(changes).length ? await applySettings(changes, { signal, timeout: slow ? 30000 : 4000 }) : true;
      const toggle = $('gaia-stars');
      if (typeof gaia === 'boolean' && toggle && toggle.checked !== gaia) {
        toggle.checked = gaia;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const state = snapshot();
      return { ok: true, band: state.band, fov: state.fov, overlays: state.overlays, image: state.image, ...(slow && !rendered ? { pending: 'New images are still downloading.' } : {}) };
    },

    async go_to_target(args, { signal }) {
      const selected = waitFor('sky:target-selected', { timeout: args.name && !Number.isFinite(args.raDeg) ? 15000 : 3000, signal });
      emit('sky:agent-navigate', args);
      if (!(await selected)) {
        const reason = $('lookup-status')?.textContent?.trim();
        return { ok: false, error: reason || 'That target could not be found. Try a preset, another name, or coordinates.' };
      }
      const loaded = await waitFor('sky:observations-loaded', { timeout: 60000, signal });
      if (!loaded) {
        const job = jobs.start('target-load', `Loading ${snapshot().target?.name || 'the target'}`, async jobSignal => {
          const done = latest.observations.loading ? await waitFor('sky:observations-loaded', { timeout: 180000, signal: jobSignal }) : latest.observations;
          if (!done) throw new Error('the archive search did not finish within 3 minutes');
          if (done.failed) throw new Error('the archive search failed');
          await settle({ timeout: 30000, signal: jobSignal });
          return snapshot();
        });
        return { ok: true, background: job.id, note: 'Moved to the target; the archive search continues in the background and its result will arrive on its own.', target: snapshot().target };
      }
      if (loaded.failed) return { ok: false, error: 'Moved to the target, but the archive search failed.', target: snapshot().target };
      const rendered = await settle({ timeout: 30000, signal });
      return { ok: true, ...snapshot(), ...(rendered ? {} : { pending: 'Moved to the target; the image is still loading.' }) };
    },

    async make_share_link({ note }) {
      return { ok: true, url: await viewLink(note), note };
    }
  };

  const investigator = createInvestigator({ base: handlers, latest, emit, settle, needFrames, snapshot, jobs });
  Object.assign(handlers, investigator.handlers);

  async function execute(name, args, { signal, progress } = {}) {
    const handler = handlers[name];
    if (!handler) return { ok: false, error: `Unknown tool ${name}.` };
    try { return await handler(args, { signal, progress }); }
    catch (error) { return { ok: false, error: error?.message || 'The viewer could not do that.' }; }
  }

  return { execute, snapshot, investigator, jobs };
}
