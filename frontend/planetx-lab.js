// PlanetX "Planted Planet Lab": three independent practice sections.
// 1. Plant a fake planet into two real SPHEREx exposures and blink them.
// 2. Spot the methane dip among three illustrative spectra.
// 3. A gallery of what searches really find, each one click into the viewer.
import { magToPeak, peakSigma, limitingMag, visibility, planetShift, plantInto, decodePlane, SPHEREX_DEPTH_AB } from './lib/planted-lab.js';
import { MYSTERY_SPECTRA, METHANE_BAND_UM, spectrumSamples } from './lib/mystery-spectra.js';
import { spectralHints } from './lib/spectral-hints.js';

const $ = id => document.getElementById(id);
const lab = $('planetx-lab');
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ---- tabs ----------------------------------------------------------------------
const tabs = [...lab.querySelectorAll('[role=tab]')];
function selectTab(tab, focus = false) {
  for (const other of tabs) {
    const selected = other === tab;
    other.setAttribute('aria-selected', String(selected));
    other.tabIndex = selected ? 0 : -1;
    $(other.getAttribute('aria-controls')).hidden = !selected;
  }
  if (focus) tab.focus();
  if (tab.id === 'lab-tab-plant') plant.resume(); else plant.pause();
}
for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    const index = tabs.indexOf(tab);
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectTab(tabs[(next + tabs.length) % tabs.length], true);
  });
}

// ---- 1. plant a planet -----------------------------------------------------------
const plant = (() => {
  const canvas = $('lab-canvas'), context = canvas.getContext('2d');
  const distanceInput = $('lab-distance'), magInput = $('lab-mag');
  const status = $('lab-game-status');
  const DIST_MIN = 50, DIST_MAX = 1500;
  const toDistance = value => DIST_MIN * (DIST_MAX / DIST_MIN) ** (value / 1000);
  const fromDistance = au => 1000 * Math.log(au / DIST_MIN) / Math.log(DIST_MAX / DIST_MIN);
  const magPercent = mag => 100 * (mag - Number(magInput.min)) / (Number(magInput.max) - Number(magInput.min));
  let data = null, frames = [], noise = 0, scale = null, frameIndex = 0, timer = null;
  let playing = !reducedMotion, showRing = true, active = false;
  let spot = null, game = null, loading = null;
  const offscreen = document.createElement('canvas');

  function setBand(element, from, to) {
    element.style.left = `${Math.min(from, to)}%`;
    element.style.width = `${Math.abs(to - from)}%`;
  }

  function state() {
    const distanceAu = toDistance(Number(distanceInput.value)), mag = Number(magInput.value);
    const [a, b] = frames;
    const shift = planetShift({ raDeg: data.field.raDeg, decDeg: data.field.decDeg, distanceAu, fromMjd: a.midMjd, toMjd: b.midMjd, pixelArcsec: data.pixelArcsec });
    const peak = magToPeak(mag, { pixelArcsec: data.pixelArcsec });
    const positions = [{ x: spot.x - shift.dx / 2, y: spot.y - shift.dy / 2 }, { x: spot.x + shift.dx / 2, y: spot.y + shift.dy / 2 }];
    return { distanceAu, mag, shift, peak, sigma: peakSigma(peak, noise), positions };
  }

  // One stretch for both frames, set from the real pixels only, so planting a
  // brighter planet never changes how the rest of the image looks.
  function computeScale() {
    const sorted = Float32Array.from(frames[0].values.filter(Number.isFinite)).sort();
    const high = Math.max(sorted[Math.floor(sorted.length * 0.997)] || 0, 30 * noise);
    return { low: -1.5 * noise, high, soft: 6 * noise };
  }

  function render() {
    if (!data || !active) return;
    const s = state(), width = data.width, frame = frames[frameIndex];
    const values = plantInto(frame.values, width, s.positions[frameIndex], s.peak);
    offscreen.width = offscreen.height = width;
    const offContext = offscreen.getContext('2d'), image = offContext.createImageData(width, width);
    const { low, high, soft } = scale, norm = Math.asinh((high - low) / soft);
    for (let i = 0; i < values.length; i++) {
      const v = values[i], at = i * 4;
      const t = Number.isFinite(v) ? Math.max(0, Math.min(1, Math.asinh(Math.max(0, v - low) / soft) / norm)) : 0;
      image.data[at] = 255 * t ** 1.05; image.data[at + 1] = 255 * t; image.data[at + 2] = Math.min(255, 255 * t * 1.04 + 6); image.data[at + 3] = 255;
    }
    offContext.putImageData(image, 0, 0);
    const box = canvas.getBoundingClientRect(), ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (!box.width) return;
    canvas.width = Math.round(box.width * ratio); canvas.height = Math.round(box.height * ratio);
    context.imageSmoothingEnabled = false;
    context.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
    const unit = canvas.width / width;
    if (showRing && !game) {
      const { x, y } = s.positions[frameIndex];
      context.strokeStyle = '#f3d27ad9'; context.lineWidth = 1.5 * ratio;
      context.beginPath(); context.arc((x + 0.5) * unit, (y + 0.5) * unit, Math.max(9 * ratio, 3.2 * unit), 0, Math.PI * 2); context.stroke();
    }
    if (game?.revealed) {
      context.strokeStyle = '#f08f6e'; context.lineWidth = 2 * ratio;
      for (const { x, y } of s.positions) { context.beginPath(); context.arc((x + 0.5) * unit, (y + 0.5) * unit, Math.max(9 * ratio, 3.2 * unit), 0, Math.PI * 2); context.stroke(); }
    }
    for (const guess of game?.guesses || []) {
      context.strokeStyle = '#ffffffaa'; context.lineWidth = 1 * ratio;
      const gx = (guess.x + 0.5) * unit, gy = (guess.y + 0.5) * unit, r = 5 * ratio;
      context.beginPath(); context.moveTo(gx - r, gy - r); context.lineTo(gx + r, gy + r); context.moveTo(gx + r, gy - r); context.lineTo(gx - r, gy + r); context.stroke();
    }
    const date = new Date(frame.date).toISOString().slice(0, 10);
    $('lab-frame-label').textContent = `Frame ${frameIndex ? 'B' : 'A'} · ${date} · ${frame.wavelengthUm.toFixed(2)} μm`;
  }

  function updateReadout() {
    if (!data) return;
    const s = state(), verdict = visibility(s.sigma), limit = limitingMag(noise, 5, { pixelArcsec: data.pixelArcsec });
    $('lab-distance-out').textContent = `${Math.round(s.distanceAu).toLocaleString()} AU`;
    $('lab-mag-out').textContent = `${s.mag.toFixed(1)} AB`;
    $('lab-sigma').textContent = s.sigma >= 100 ? `${Math.round(s.sigma)}× the noise` : `${s.sigma.toFixed(1)}× the noise`;
    const chip = $('lab-verdict');
    chip.textContent = verdict.label; chip.className = `lab-verdict is-${verdict.id}`;
    $('lab-verdict-note').textContent = verdict.note;
    $('lab-shift').textContent = `${s.shift.arcsec.toFixed(1)}″ (${s.shift.pixels.toFixed(1)} px) in ${s.shift.days.toFixed(1)} days`;
    const halfYear = planetShift({ raDeg: data.field.raDeg, decDeg: data.field.decDeg, distanceAu: s.distanceAu, fromMjd: frames[0].midMjd, toMjd: frames[0].midMjd + 182.6, pixelArcsec: data.pixelArcsec });
    const sixMonths = halfYear.arcsec >= 120 ? `${(halfYear.arcsec / 60).toFixed(1)}′` : `${halfYear.arcsec.toFixed(0)}″`;
    $('lab-hop-note').textContent = s.shift.pixels < 1
      ? `Less than a pixel. SPHEREx looks about 90° from the Sun, almost along Earth’s path for this patch, so a body this far barely shifts in days. Six months later, from the other side of Earth’s orbit, it would sit about ${sixMonths} away.`
      : `Six months later, from the other side of Earth’s orbit, it would sit about ${sixMonths} away: far outside this ${data.fovArcmin}′ picture.`;
    $('lab-limit').textContent = `${limit.toFixed(1)} AB in one exposure`;
    $('lab-limit-tick').style.left = `${Math.max(0, Math.min(100, magPercent(limit)))}%`;
    $('lab-limit-copy').textContent = `One SPHEREx exposure reaches about AB ${limit.toFixed(1)} here; combining the whole survey reaches roughly ${SPHEREX_DEPTH_AB.join('–')} per channel. Models put Planet Nine near visual magnitude 21–24 (this tile’s median: ${data.field.medianVMag}), past both. V and AB are different scales, so treat this as a rough comparison.`;
    $('lab-limit-banner').hidden = !(s.mag > limit);
  }

  function update() { updateReadout(); render(); }

  function setPlaying(next) {
    playing = next;
    $('lab-blink').setAttribute('aria-pressed', String(playing));
    $('lab-blink').textContent = playing ? 'Pause blink' : 'Blink';
    clearInterval(timer); timer = null;
    if (playing && active && data) timer = setInterval(() => { frameIndex = 1 - frameIndex; render(); }, 700);
  }

  function randomSpot() {
    const w = data.width, margin = 0.22 * w;
    return { x: margin + Math.random() * (w - 2 * margin), y: margin + Math.random() * (w - 2 * margin) };
  }

  function startGame() {
    spot = randomSpot();
    game = { misses: 0, guesses: [], revealed: false };
    canvas.classList.add('is-guessing');
    status.textContent = state().shift.pixels < 1
      ? 'I re-planted it and hid the marker. At this distance it hardly moves, so it looks like every other star. That is the real problem! Pull Distance below ~100 AU for a fair game, then click where you think it is.'
      : 'I re-planted it somewhere new and hid the marker. Watch the blink, then click where you think it is.';
    $('lab-hide').textContent = 'Give up · show me';
    update();
  }
  function endGame(message, reveal) {
    if (reveal) game.revealed = true;
    status.textContent = message;
    canvas.classList.remove('is-guessing');
    $('lab-hide').textContent = 'Hide it again';
    game.over = true;
    render();
  }
  $('lab-hide').addEventListener('click', () => {
    if (!data) return;
    if (game && !game.over) { endGame(`There it was: ${state().sigma.toFixed(1)}× the noise. ${visibility(state().sigma).note}`, true); return; }
    startGame();
  });
  canvas.addEventListener('click', event => {
    if (!game || game.over) return;
    const box = canvas.getBoundingClientRect();
    const guess = { x: (event.clientX - box.left) / box.width * data.width - 0.5, y: (event.clientY - box.top) / box.height * data.width - 0.5 };
    const s = state();
    const miss = Math.min(...s.positions.map(p => Math.hypot(p.x - guess.x, p.y - guess.y)));
    if (miss <= 2.5) { endGame(`Found it! It was ${s.sigma.toFixed(1)}× the noise and hopped ${s.shift.arcsec.toFixed(0)}″. Try it fainter or farther away.`, true); return; }
    game.guesses.push(guess);
    if (++game.misses >= 3) { endGame(`Three misses, so here it is (circled): ${s.sigma.toFixed(1)}× the noise. ${s.sigma < 5 ? 'Below 5σ a real search could not claim it either.' : 'Try again; it helps to watch one small patch while it blinks.'}`, true); return; }
    status.textContent = `Not there (${3 - game.misses} ${game.misses === 2 ? 'try' : 'tries'} left). ${miss < 12 ? 'Close! ' : ''}${s.shift.pixels < 1 ? 'It barely moves at this distance, so nothing gives it away. Try a closer distance.' : 'Look for a dot that jumps between the two frames.'}`;
    render();
  });

  distanceInput.addEventListener('input', update);
  magInput.addEventListener('input', update);
  $('lab-blink').addEventListener('click', () => setPlaying(!playing));
  $('lab-flip').addEventListener('click', () => { setPlaying(false); frameIndex = 1 - frameIndex; render(); });
  $('lab-ring').addEventListener('click', () => {
    showRing = !showRing;
    $('lab-ring').setAttribute('aria-pressed', String(showRing));
    $('lab-ring').textContent = showRing ? 'Hide marker' : 'Show marker';
    render();
  });
  $('lab-planet-nine').addEventListener('click', () => {
    if (!data) return;
    distanceInput.value = String(Math.round(fromDistance(data.field.medianDistanceAu)));
    magInput.value = String(data.field.medianVMag);
    status.textContent = `This tile’s model Planet Nine: about ${data.field.medianDistanceAu} AU and visual magnitude ${data.field.medianVMag} (V, read here as AB for a rough comparison).`;
    update();
  });
  new ResizeObserver(() => render()).observe(canvas);

  async function load() {
    loading ||= (async () => {
      try {
        const response = await fetch('/data/planted-lab.json');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        data = await response.json();
        frames = data.frames.map(frame => ({ ...frame, values: decodePlane(frame.values) }));
        noise = (frames[0].noise + frames[1].noise) / 2;
        scale = computeScale();
        spot = { x: data.width * 0.62, y: data.width * 0.4 };
        setBand($('lab-distance-band'), fromDistance(400) / 10, fromDistance(800) / 10);
        setBand($('lab-mag-band'), magPercent(21), magPercent(24));
        const [a, b] = frames, day = frame => frame.date.slice(0, 10);
        $('lab-provenance').textContent = `Real SPHEREx ${a.release?.toUpperCase() || ''} exposures ${a.observationId} (${day(a)}) and ${b.observationId} (${day(b)}), detector D${a.detector}, of model patch #${data.field.patchNumber} at RA ${data.field.raDeg.toFixed(1)}°, Dec ${data.field.decDeg.toFixed(1)}°. The planet is fake; the stars and the noise are real. Brightness uses a simple ${data.pixelArcsec}″-pixel point-source model, so limits are approximate.`;
        update();
        setPlaying(playing);
      } catch {
        $('lab-frame-label').textContent = 'The real images could not be loaded. Please refresh and try again.';
      }
    })();
    return loading;
  }

  return {
    async resume() { active = true; await load(); setPlaying(playing); render(); },
    pause() { active = false; clearInterval(timer); timer = null; }
  };
})();

// ---- 2. spot the methane dip ---------------------------------------------------------
const methane = (() => {
  const container = $('lab-spectra'), result = $('lab-spectra-result');
  const W = 300, H = 170, PAD = { l: 8, r: 8, t: 12, b: 24 };
  const X_MIN = 0.7, X_MAX = 5.05;
  const sx = w => PAD.l + (w - X_MIN) / (X_MAX - X_MIN) * (W - PAD.l - PAD.r);
  let order = [], answered = false;
  const svgNS = 'http://www.w3.org/2000/svg';
  const el = (name, attributes = {}, text) => {
    const node = document.createElementNS(svgNS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function chart(samples) {
    const max = Math.max(...samples.map(s => s.fluxMicroJy)) * 1.1;
    const sy = f => H - PAD.b - Math.max(0, f) / max * (H - PAD.t - PAD.b);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
    const band = METHANE_BAND_UM;
    svg.append(el('rect', { class: 'lab-methane-band', x: sx(band[0]), y: PAD.t, width: sx(band[1]) - sx(band[0]), height: H - PAD.t - PAD.b }));
    svg.append(el('text', { class: 'lab-methane-band-label', x: (sx(band[0]) + sx(band[1])) / 2, y: PAD.t - 2, 'text-anchor': 'middle' }, 'methane'));
    const axis = el('g', { class: 'lab-axis' });
    axis.append(el('line', { x1: PAD.l, x2: W - PAD.r, y1: H - PAD.b, y2: H - PAD.b }));
    for (const tick of [1, 2, 3, 4, 5]) axis.append(el('text', { x: sx(tick), y: H - PAD.b + 15, 'text-anchor': 'middle' }, `${tick} μm`));
    svg.append(axis);
    svg.append(el('path', { class: 'lab-line', d: samples.map((s, i) => `${i ? 'L' : 'M'}${sx(s.wavelengthUm).toFixed(1)},${sy(s.fluxMicroJy).toFixed(1)}`).join('') }));
    const cross = el('line', { class: 'lab-cross', y1: PAD.t, y2: H - PAD.b, visibility: 'hidden' });
    const dot = el('circle', { class: 'lab-cross-dot', r: 4, visibility: 'hidden' });
    svg.append(cross, dot);
    return { svg, sy, cross, dot };
  }

  function card(entry, index) {
    const samples = spectrumSamples(entry.id);
    const item = document.createElement('figure');
    item.className = 'lab-spectrum'; item.style.margin = '0';
    const letter = 'ABC'[index];
    item.innerHTML = `<div class="lab-spectrum-head"><h3>Mystery ${letter}</h3><span>brightness vs. wavelength</span></div>`;
    const { svg, sy, cross, dot } = chart(samples);
    svg.setAttribute('aria-label', `Mystery spectrum ${letter}: brightness against wavelength from 0.75 to 5 microns.`);
    const tip = document.createElement('div');
    tip.className = 'lab-tip'; tip.hidden = true;
    svg.addEventListener('pointermove', event => {
      const box = svg.getBoundingClientRect(), x = (event.clientX - box.left) / box.width * W;
      const nearest = samples.reduce((best, s) => Math.abs(sx(s.wavelengthUm) - x) < Math.abs(sx(best.wavelengthUm) - x) ? s : best);
      const px = sx(nearest.wavelengthUm), py = sy(nearest.fluxMicroJy);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.style.left = `${(px / W) * box.width + 14}px`; tip.style.top = `${(py / H) * box.height + 52}px`;
      tip.textContent = `${nearest.wavelengthUm.toFixed(2)} μm · ${nearest.fluxMicroJy.toPrecision(3)} μJy`;
    });
    svg.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; });
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'lab-button is-accent lab-pick';
    button.textContent = `${letter} is the cold object`;
    button.addEventListener('click', () => pick(entry, letter));
    const reveal = document.createElement('figcaption');
    reveal.className = 'lab-spectrum-reveal'; reveal.hidden = true;
    item.append(svg, tip, button, reveal);
    item.dataset.id = entry.id;
    return item;
  }

  function pick(entry, letter) {
    if (answered) return;
    answered = true;
    const hints = spectralHints(spectrumSamples(entry.id));
    const correct = hints.methaneDip === true;
    result.innerHTML = correct
      ? `<span class="is-right">Right — ${letter} is the cold brown dwarf.</span> The hint code found a dip near 3.3 μm deeper than the noise allows: methane, which only survives in very cold air.`
      : `<span class="is-wrong">Not ${letter}.</span> The hint code checked it and says: “${hints.hints[0]}” There is no methane dip. Each card now says what it was; the cold one is outlined in gold.`;
    container.classList.add('show-band');
    $('lab-methane-hint').setAttribute('aria-pressed', 'true');
    for (const item of container.children) {
      const spec = MYSTERY_SPECTRA.find(s => s.id === item.dataset.id);
      const itemHints = spectralHints(spectrumSamples(spec.id));
      item.classList.toggle('is-correct', itemHints.methaneDip === true);
      item.classList.toggle('is-wrong', item.dataset.id === entry.id && !correct);
      item.querySelector('.lab-pick').hidden = true;
      const reveal = item.querySelector('.lab-spectrum-reveal');
      reveal.hidden = false;
      reveal.innerHTML = `<strong>${spec.kind}.</strong> ${spec.explanation}<ul>${itemHints.hints.map(h => `<li>${h}</li>`).join('')}</ul>`;
    }
  }

  function shuffle() {
    order = [...MYSTERY_SPECTRA];
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    answered = false;
    result.textContent = '';
    container.classList.remove('show-band');
    $('lab-methane-hint').setAttribute('aria-pressed', 'false');
    container.replaceChildren(...order.map(card));
  }
  $('lab-shuffle').addEventListener('click', shuffle);
  $('lab-methane-hint').addEventListener('click', event => {
    const on = !container.classList.contains('show-band');
    container.classList.toggle('show-band', on);
    event.currentTarget.setAttribute('aria-pressed', String(on));
  });
  return { shuffle };
})();

// ---- 3. gallery --------------------------------------------------------------------
const GALLERY = [
  { icon: '✶', kind: 'Fast-moving star', name: 'Barnard’s Star', href: '/viewer.html?target=barnard&mode=blink',
    copy: 'The fastest-moving star in our sky, 6 light-years away. Blink the dates and watch it hop while the background stays put.' },
  { icon: '◐', kind: 'Cold brown dwarf', name: 'WISE 0855', href: '/viewer.html?target=wise&mode=blink',
    copy: 'One of the coldest objects known outside the Solar System, found by a search much like this one. Faint, red, and on the move.' },
  { icon: '☄', kind: 'Comet', name: '3I/ATLAS', href: '/viewer.html?searchType=moving&q=3I%2FATLAS&from=2025-08-01&to=2025-08-31',
    copy: 'An interstellar comet SPHEREx caught in August 2025. The viewer follows its path so its fuzzy glow stays centred.' },
  { icon: '⋯', kind: 'Asteroid', name: '4 Vesta', href: '/viewer.html?searchType=moving&q=4+Vesta&from=2026-07-01&to=2026-07-31',
    copy: 'Main-belt asteroids crawl across SPHEREx images every day. Track one and see how fast nearby things move compared with Planet Nine.' },
  { icon: '∿', kind: 'Variable star', name: 'R Draconis', href: '/viewer.html?target=draconis&mode=time-lapse',
    copy: 'A star that swells and fades over months. Play the dates as a time-lapse: change does not always mean motion.' }
];
$('lab-gallery').replaceChildren(...GALLERY.map(entry => {
  const item = document.createElement('li');
  item.innerHTML = `<a href="${entry.href}"><span class="lab-gallery-icon" aria-hidden="true">${entry.icon}</span><small>${entry.kind}</small><h3>${entry.name}</h3><p>${entry.copy}</p><span class="lab-gallery-open">Open in viewer <span aria-hidden="true">↗</span></span></a>`;
  return item;
}));

// ---- start ---------------------------------------------------------------------------
methane.shuffle();
lab.addEventListener('toggle', () => {
  if (!lab.open) { plant.pause(); return; }
  if (!$('lab-panel-plant').hidden) plant.resume();
});
if (lab.open) plant.resume();
