// Shared animated starfield for the homepage and full-screen search loader.
// Stars stream outward from a vanishing point as if cruising slowly through space,
// over a faint fixed backdrop; the cursor adds a gentle parallax. With `labels`,
// passing stars are tagged with names every few seconds; each name rides along
// with its star, sliding off the screen with it rather than vanishing at the edge.
// Honors prefers-reduced-motion by drawing a single static frame without labels.

import { objectNames } from './object-names.js';

// The sky drifts through the colour wheel (see the `sky-hue` animation in styles.css)
// and stars take their colour from it. Each star has a tint role, given in HSL as it
// looks against the unrotated magenta nebula; sky-coloured roles are put through the
// same hue-rotate() matrix as the nebula every frame, so they stay matched to what
// the browser actually draws. Neutral roles never rotate.
const HUE_PERIOD = 45;  // seconds per colour cycle; must match `sky-hue` in styles.css
const TINT_ROLES = [
  { h: 220, s: 0.35, l: 0.95, fixed: true }, // near-white, slightly cool
  { h: 35, s: 0.7, l: 0.93, fixed: true },   // near-white, slightly warm
  { h: 300, s: 0.55, l: 0.9 },               // pale, sky-coloured
  { h: 305, s: 0.85, l: 0.8 },               // clearly sky-coloured
  { h: 255, s: 0.7, l: 0.84 }                // neighbouring hue for variety
];
const TINT_WEIGHTS = [0, 0, 0, 1, 1, 2, 2, 2, 3, 3, 4]; // mostly pale, some vivid
const pickTint = () => TINT_WEIGHTS[Math.floor(Math.random() * TINT_WEIGHTS.length)];

// The colour cycle runs on one clock for the whole browser tab: `sky-epoch` in
// sessionStorage is the wall-clock second the cycle started (a random point in it on the
// first visit), so moving from the homepage to the viewer's loader carries on where it
// was instead of jumping to a new colour. An inline script in each page's <head> sets
// `--sky-start` from the same key before first paint; this is the fallback.
const SKY_KEY = 'sky-epoch';
function readSkyEpoch() {
  let epoch = NaN;
  try { epoch = parseFloat(sessionStorage.getItem(SKY_KEY)); } catch { /* storage blocked */ }
  if (!Number.isFinite(epoch)) {
    epoch = Date.now() / 1000 - Math.random() * HUE_PERIOD;
    try { sessionStorage.setItem(SKY_KEY, String(epoch)); } catch { /* storage blocked */ }
  }
  return epoch;
}
const skyEpoch = readSkyEpoch();
const skySeconds = () => Date.now() / 1000 - skyEpoch;

const root = document.documentElement;
if (!root.style.getPropertyValue('--sky-start')) root.style.setProperty('--sky-start', skySeconds().toFixed(2));
const skyStart = parseFloat(root.style.getPropertyValue('--sky-start')) || 0;

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + h / 30) % 12;
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}
const TINT_RGB = TINT_ROLES.map(role => hslToRgb(role.h, role.s, role.l));

// Current rotation of the sky in degrees, read from the running CSS animation so
// stars and nebula stay in step.
function skyRotation(animated) {
  let progress = skyStart / HUE_PERIOD;
  if (animated) {
    const animation = document.getAnimations().find(item => item.animationName === 'sky-hue');
    const timing = animation && animation.effect.getComputedTiming();
    progress = timing && timing.progress !== null
      ? timing.progress
      : skySeconds() / HUE_PERIOD;
  }
  return progress * 360;
}

// The CSS/SVG hue-rotate() matrix applied to each sky-coloured tint.
function skyPalette(degrees) {
  const c = Math.cos(degrees * Math.PI / 180), s = Math.sin(degrees * Math.PI / 180);
  const m = [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072
  ];
  const channel = value => Math.round(clamp(value, 0, 255));
  return TINT_RGB.map(([r, g, b], i) => TINT_ROLES[i].fixed
    ? `${channel(r)},${channel(g)},${channel(b)}`
    : `${channel(m[0] * r + m[1] * g + m[2] * b)},${channel(m[3] * r + m[4] * g + m[5] * b)},${channel(m[6] * r + m[7] * g + m[8] * b)}`);
}
const Z_NEAR = 0.05, Z_FAR = 1;
const SPEED = 0.06;        // depth units per second: a star crosses the field in ~16 s
const FADE_IN_DEPTH = 0.15; // stars fade in over the farthest part of the field
const FLYING_DENSITY = 1 / 2600, MAX_FLYING = 900;
const BACKDROP_DENSITY = 1 / 9000;
const PARALLAX = 14;        // max px shift for the backdrop; flying stars scale with nearness

const LABEL = {
  first: 1.5,
  every: [2, 3.2],     // seconds between new names; with a 5 s life, two or three overlap
  max: 4,              // names on screen at the same time
  retry: 0.4,          // seconds before trying again when no star fits
  life: 5, fadeIn: 0.8, fadeOut: 1.6, drop: 0.5,
  depth: [0.45, 0.97], // farther stars drift slowly enough to read beside
  stay: 0.35,          // fraction of the label's life its star must stay on screen
  edge: 16, pad: 12,   // px kept clear of the screen edge and of `avoid` boxes when a name appears
  font: '600 12px Manrope, sans-serif'
};
// Bright and well-known stars, tagged with their Bayer designation.
const BRIGHT_STARS = [
  'Canopus α Car', 'Capella α Aur', 'Aldebaran α Tau', 'Antares α Sco', 'Spica α Vir', 'Fomalhaut α PsA',
  'Regulus α Leo', 'Procyon α CMi', 'Achernar α Eri', 'Bellatrix γ Ori', 'Pollux β Gem', 'Castor α Gem',
  'Acrux α Cru', 'Mimosa β Cru', 'Gacrux γ Cru', 'Hadar β Cen', 'Shaula λ Sco', 'Sargas θ Sco',
  'Alnilam ε Ori', 'Alnitak ζ Ori', 'Mintaka δ Ori', 'Saiph κ Ori', 'Alnair α Gru', 'Dubhe α UMa',
  'Merak β UMa', 'Alioth ε UMa', 'Mizar ζ UMa', 'Alkaid η UMa', 'Mirfak α Per', 'Algol β Per',
  'Menkalinan β Aur', 'Elnath β Tau', 'Alcyone η Tau', 'Alhena γ Gem', 'Wezen δ CMa', 'Adhara ε CMa',
  'Mirzam β CMa', 'Aludra η CMa', 'Peacock α Pav', 'Kaus Australis ε Sgr', 'Nunki σ Sgr', 'Alphard α Hya',
  'Hamal α Ari', 'Diphda β Cet', 'Menkar α Cet', 'Mira ο Cet', 'Rasalhague α Oph', 'Sabik η Oph',
  'Kochab β UMi', 'Schedar α Cas', 'Caph β Cas', 'Algieba γ Leo', 'Denebola β Leo', 'Alphecca α CrB',
  'Unukalhai α Ser', 'Eltanin γ Dra', 'Thuban α Dra', 'Enif ε Peg', 'Markab α Peg', 'Scheat β Peg',
  'Alpheratz α And', 'Mirach β And', 'Almach γ And', 'Sadr γ Cyg', 'Albireo β Cyg', 'Vindemiatrix ε Vir',
  'Zubenelgenubi α Lib', 'Izar ε Boo', 'Muphrid η Boo', 'Suhail λ Vel', 'Avior ε Car', 'Miaplacidus β Car',
  'Atria α TrA', 'Alderamin α Cep', 'Ankaa α Phe', 'Naos ζ Pup'
].map(entry => {
  const parts = entry.split(' ');
  return { name: parts.slice(0, -2).join(' '), tag: parts.slice(-2).join(' ') };
});
const STAR_NAMES = [
  ...objectNames
    .filter(entry => !/Galaxy|Nebula|Pleiades/.test(entry.name))
    .map(entry => ({ name: entry.name, tag: entry.aliases.find(alias => /^(HD|HIP|GJ) /.test(alias)) || '' })),
  ...BRIGHT_STARS
];

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const shuffle = list => {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
};

export function mountStarfield(canvas, { paused = false, labels = false, avoid = null } = {}) {
  const ctx = canvas.getContext('2d');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  // `avoid` takes elements or selectors whose boxes labels must stay clear of.
  const avoidElements = [avoid].flat().filter(Boolean)
    .map(item => typeof item === 'string' ? document.querySelector(item) : item).filter(Boolean);
  let width = 0, height = 0, focal = 1, spreadX = 1, spreadY = 1;
  let flying = [], backdrop = [], frame = 0, last = 0, elapsed = 0;
  let tags = [], nextLabelAt = LABEL.first, deck = [];
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

  function spawn(star, z, visibleOnly) {
    const reach = visibleOnly ? z : 1; // initial stars start on screen; respawns enter at the far plane
    star.x = rand(-spreadX, spreadX) * reach;
    star.y = rand(-spreadY, spreadY) * reach;
    star.z = z;
    star.gen = (star.gen || 0) + 1;
    star.px = null;
    star.label = null; // a respawned star is a new star: any name on it fades where it was
    return star;
  }

  function populate() {
    const area = width * height;
    flying = Array.from({ length: Math.min(MAX_FLYING, Math.round(area * FLYING_DENSITY)) }, () => spawn({
      r: rand(0.35, 0.95),
      a: rand(0.55, 0.95),
      tint: pickTint(),
      phase: Math.random() * Math.PI * 2,
      speed: rand(0.15, 0.7),
      twinkle: Math.random() < 0.18 ? rand(0.3, 0.5) : rand(0.05, 0.15)
    }, rand(Z_NEAR + 0.05, Z_FAR), true));
    backdrop = Array.from({ length: Math.round(area * BACKDROP_DENSITY) }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: rand(0.3, 0.7),
      a: rand(0.18, 0.4),
      tint: pickTint(),
      phase: Math.random() * Math.PI * 2,
      speed: rand(0.15, 0.6)
    }));
    tags = [];
  }

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    width = innerWidth;
    height = innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    focal = Math.max(width, height) * 0.5;
    spreadX = (width / 2 / focal) * 1.1;
    spreadY = (height / 2 / focal) * 1.1;
    populate();
  }

  // Screen position of a flying star at depth z, including pointer parallax.
  function project(star, z) {
    const near = Math.min(1 / z, 6) * 0.25;
    return [
      width / 2 + (star.x / z) * focal + pointer.x * near,
      height / 2 + (star.y / z) * focal + pointer.y * near
    ];
  }

  const onScreen = (x, y, margin = 0) => x >= margin && x <= width - margin && y >= margin && y <= height - margin;

  function blockedRects() {
    return avoidElements.map(element => element.getBoundingClientRect()).filter(rect => rect.width && rect.height);
  }

  // Box covered by the ring, leader line and text of a label on a star at (x, y).
  const labelBox = (x, y, dir, textWidth) => dir > 0
    ? { left: x - 12, right: x + 36 + textWidth, top: y - 30, bottom: y + 12 }
    : { left: x - 36 - textWidth, right: x + 12, top: y - 30, bottom: y + 12 };
  const boxClear = (box, rects) =>
    box.left >= LABEL.edge && box.right <= width - LABEL.edge && box.top >= LABEL.edge && box.bottom <= height - LABEL.edge
    && !rects.some(rect => box.left < rect.right + LABEL.pad && box.right > rect.left - LABEL.pad
      && box.top < rect.bottom + LABEL.pad && box.bottom > rect.top - LABEL.pad);

  function pickLabel() {
    if (!deck.length) deck = shuffle([...STAR_NAMES]);
    const entry = deck[deck.length - 1];
    ctx.font = LABEL.font;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
    const textWidth = ctx.measureText(entry.name.toUpperCase()).width;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    // Keep clear of the page content and of names already on screen.
    const rects = [...blockedRects(), ...tags.map(tag => labelBox(tag.x, tag.y, tag.dir, tag.textWidth))];
    const travel = SPEED * LABEL.life;
    const candidates = [];
    for (const star of flying) {
      if (star.z < LABEL.depth[0] || star.z > LABEL.depth[1] || star.px === null || star.label) continue;
      const [x, y] = project(star, star.z);
      // Point the label toward the centre: as the star drifts outward the text
      // trails behind it and stays on screen, moving away from the page content.
      const dir = x < width / 2 ? 1 : -1;
      if (!boxClear(labelBox(x, y, dir, textWidth), rects)) continue;
      // The star should still be on screen as the label starts to fade.
      const [fx, fy] = project(star, Math.max(star.z - travel * LABEL.stay, Z_NEAR));
      if (onScreen(fx, fy, LABEL.edge)) candidates.push({ star, dir });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.star.r - a.star.r); // favour the brighter stars
    const { star, dir } = candidates[Math.floor(Math.random() * Math.min(candidates.length, 12))];
    deck.pop();
    const [x, y] = project(star, star.z);
    star.label = { star, dir, textWidth, gen: star.gen, ...entry, born: elapsed, dropAt: null, alpha: 0, x, y, size: star.sr };
    return star.label;
  }

  // Draws one name; returns false once it has finished.
  function drawTag(label) {
    const { star } = label;
    if (label.dropAt === null && star.gen === label.gen) {
      [label.x, label.y] = [star.sx, star.sy];
      label.size = star.sr;
    } else if (label.dropAt === null) {
      label.dropAt = elapsed; // star passed the camera: fade out where it was
    }
    const age = elapsed - label.born;
    const dropped = label.dropAt !== null ? (elapsed - label.dropAt) / LABEL.drop : 0;
    const box = labelBox(label.x, label.y, label.dir, label.textWidth);
    const gone = box.right < 0 || box.left > width || box.bottom < 0 || box.top > height; // slid fully off screen
    // Finished by time, not by alpha: alpha is also 0 on the frame a name is born.
    if (age >= LABEL.life || dropped >= 1 || gone) {
      if (star.label === label) star.label = null;
      return false;
    }
    const alpha = Math.min(age / LABEL.fadeIn, 1, (LABEL.life - age) / LABEL.fadeOut, 1 - dropped);
    label.alpha = alpha;

    const { x, y } = label;
    ctx.save();
    ctx.font = LABEL.font;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
    const name = label.name.toUpperCase();
    const { dir } = label;

    ctx.strokeStyle = `rgba(230,237,247,${(alpha * 0.6).toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, label.size + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + dir * (label.size + 6) * 0.7, y - (label.size + 6) * 0.7);
    ctx.lineTo(x + dir * 18, y - 18);
    ctx.lineTo(x + dir * 28, y - 18);
    ctx.stroke();

    ctx.textBaseline = 'middle';
    ctx.textAlign = dir > 0 ? 'left' : 'right';
    ctx.fillStyle = `rgba(240,245,252,${alpha.toFixed(3)})`;
    ctx.fillText(name, x + dir * 33, y - 18);
    if (label.tag) {
      ctx.font = '500 10px Manrope, sans-serif';
      if ('letterSpacing' in ctx) ctx.letterSpacing = '1px';
      ctx.fillStyle = `rgba(172,185,204,${(alpha * 0.7).toFixed(3)})`;
      ctx.fillText(label.tag, x + dir * 33, y - 4);
    }
    ctx.restore();
    return true;
  }

  // `streaks` is true for animated frames; the static reduced-motion frame uses the
  // visit's fixed starting hue, matching the unanimated nebula.
  function draw(time, streaks) {
    ctx.clearRect(0, 0, width, height);
    const t = time / 1000;
    const palette = skyPalette(skyRotation(streaks));

    for (const s of backdrop) {
      let x = (s.x + pointer.x * 0.3) % width, y = (s.y + pointer.y * 0.3) % height;
      if (x < 0) x += width;
      if (y < 0) y += height;
      const alpha = s.a * (1 - 0.3 * (0.5 + 0.5 * Math.sin(t * s.speed + s.phase)));
      ctx.fillStyle = `rgba(${palette[s.tint]},${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const s of flying) {
      const [x, y] = project(s, s.z);
      // A named star keeps being tracked past the edge so its name slides off with it.
      if (!onScreen(x, y, -20) && !s.label) { s.sx = null; continue; }
      const nearness = clamp((Z_FAR - s.z) / (Z_FAR - 0.3), 0, 1);
      const fadeIn = clamp((Z_FAR - s.z) / FADE_IN_DEPTH, 0, 1);
      const twinkle = 1 - s.twinkle * (0.5 + 0.5 * Math.sin(t * s.speed + s.phase));
      let alpha = s.a * fadeIn * (0.35 + 0.65 * nearness) * twinkle;
      let r = clamp(s.r * 0.45 / s.z, 0.25, 2.6);
      if (s.label) { // the named star brightens while tagged
        alpha = Math.max(alpha, 0.95 * s.label.alpha);
        r = Math.max(r, 0.9 + 0.5 * s.label.alpha);
      }
      s.sx = x; s.sy = y; s.sr = r;

      if (streaks && s.px !== null) {
        const dx = x - s.px, dy = y - s.py, moved = Math.hypot(dx, dy);
        if (moved > 1.5 && moved < 80) {
          ctx.strokeStyle = `rgba(${palette[s.tint]},${(alpha * 0.35).toFixed(3)})`;
          ctx.lineWidth = r * 0.8;
          ctx.beginPath();
          ctx.moveTo(x - dx * 3, y - dy * 3);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
      }
      s.px = x; s.py = y;

      ctx.fillStyle = `rgba(${palette[s.tint]},${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (r > 1.2) { // soft halo on the nearest stars
        ctx.fillStyle = `rgba(${palette[s.tint]},${(alpha * 0.12).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, r * 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    tags = tags.filter(drawTag);
  }

  function tick(time) {
    const dt = last ? Math.min((time - last) / 1000, 0.1) : 0;
    last = time;
    elapsed += dt;
    pointer.x += (pointer.tx - pointer.x) * Math.min(dt * 1.5, 1);
    pointer.y += (pointer.ty - pointer.y) * Math.min(dt * 1.5, 1);
    for (const s of flying) {
      s.z -= SPEED * dt;
      if (s.z < Z_NEAR || (s.sx === null && !s.label)) spawn(s, Z_FAR, false); // off-screen stars re-enter far away
    }
    if (labels && elapsed >= nextLabelAt) {
      const tag = tags.length < LABEL.max ? pickLabel() : null;
      if (tag) tags.push(tag);
      nextLabelAt = elapsed + (tag ? rand(...LABEL.every) : LABEL.retry);
    }
    draw(time, true);
    frame = requestAnimationFrame(tick);
  }

  function start() {
    cancelAnimationFrame(frame);
    last = 0;
    for (const tag of tags) if (tag.star.label === tag) tag.star.label = null;
    tags = [];
    if (paused) return;
    if (motion.matches) draw(0, false);
    else frame = requestAnimationFrame(tick);
  }

  addEventListener('resize', () => { resize(); if (!paused && motion.matches) draw(0, false); });
  addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse') return;
    pointer.tx = -(event.clientX / width - 0.5) * PARALLAX;
    pointer.ty = -(event.clientY / height - 0.5) * PARALLAX;
  }, { passive: true });
  motion.addEventListener('change', start);

  resize();
  start();
  return {
    setPaused(value) {
      if (paused === value) return;
      paused = value;
      start();
    }
  };
}

// The loader uses exactly the homepage renderer, and runs it only while visible.
const loadingCanvas = document.getElementById('loading-starfield');
if (loadingCanvas) {
  const loader = document.getElementById('preview-loading');
  // The loader's nebula animations restart each time it is shown, so stamp the
  // current point in the shared colour cycle on it just before it renders.
  const syncSky = () => { if (!loader.hidden) loader.style.setProperty('--sky-start', skySeconds().toFixed(2)); };
  syncSky();
  // Star names drift by while a search loads too, kept clear of the ring and its text.
  const starfield = mountStarfield(loadingCanvas, { paused: loader.hidden, labels: true, avoid: ['.loader-stage'] });
  new MutationObserver(() => { syncSky(); starfield.setPaused(loader.hidden); })
    .observe(loader, { attributes: true, attributeFilter: ['hidden'] });
}
