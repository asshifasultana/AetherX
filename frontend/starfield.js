// Subtle animated starfield for the home page background.
// Three depth layers drift slowly and twinkle; the cursor adds a faint parallax.
// Honors prefers-reduced-motion by drawing a single static frame.

const LAYERS = [
  { depth: 0.25, density: 1 / 5200, size: [0.35, 0.8], alpha: [0.25, 0.55] },
  { depth: 0.55, density: 1 / 11000, size: [0.6, 1.1], alpha: [0.4, 0.75] },
  { depth: 1.0, density: 1 / 32000, size: [0.9, 1.6], alpha: [0.6, 0.95] }
];
const TINTS = ['220,234,255', '235,240,255', '255,244,228', '200,214,255', '255,230,214'];
const DRIFT = { x: -2.2, y: 0.9 }; // px/s at depth 1 — barely perceptible
const PARALLAX = 14; // max px shift at depth 1

const rand = (min, max) => min + Math.random() * (max - min);

export function mountStarfield(canvas) {
  const ctx = canvas.getContext('2d');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let width = 0, height = 0, stars = [], frame = 0, last = 0;
  let offsetX = 0, offsetY = 0;
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

  function populate() {
    const area = width * height;
    stars = LAYERS.flatMap(layer => Array.from({ length: Math.round(area * layer.density) }, () => ({
      layer,
      x: Math.random() * width,
      y: Math.random() * height,
      r: rand(...layer.size),
      a: rand(...layer.alpha),
      tint: TINTS[Math.floor(Math.random() * TINTS.length)],
      phase: Math.random() * Math.PI * 2,
      speed: rand(0.15, 0.7),
      depthTwinkle: Math.random() < 0.18 ? rand(0.35, 0.6) : rand(0.05, 0.18)
    })));
  }

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    width = innerWidth;
    height = innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    populate();
  }

  function draw(time) {
    ctx.clearRect(0, 0, width, height);
    const t = time / 1000;
    for (const s of stars) {
      const d = s.layer.depth;
      let x = (s.x + offsetX * d + pointer.x * d) % width;
      let y = (s.y + offsetY * d + pointer.y * d) % height;
      if (x < 0) x += width;
      if (y < 0) y += height;
      const twinkle = 1 - s.depthTwinkle * (0.5 + 0.5 * Math.sin(t * s.speed + s.phase));
      const alpha = s.a * twinkle;
      ctx.fillStyle = `rgba(${s.tint},${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, s.r, 0, Math.PI * 2);
      ctx.fill();
      if (s.r > 1.2) { // soft halo on the brightest stars
        ctx.fillStyle = `rgba(${s.tint},${(alpha * 0.12).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, s.r * 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function tick(time) {
    const dt = last ? Math.min((time - last) / 1000, 0.1) : 0;
    last = time;
    offsetX += DRIFT.x * dt;
    offsetY += DRIFT.y * dt;
    pointer.x += (pointer.tx - pointer.x) * Math.min(dt * 1.5, 1);
    pointer.y += (pointer.ty - pointer.y) * Math.min(dt * 1.5, 1);
    draw(time);
    frame = requestAnimationFrame(tick);
  }

  function start() {
    cancelAnimationFrame(frame);
    last = 0;
    if (motion.matches) draw(0);
    else frame = requestAnimationFrame(tick);
  }

  addEventListener('resize', () => { resize(); if (motion.matches) draw(0); });
  addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse') return;
    pointer.tx = -(event.clientX / width - 0.5) * PARALLAX;
    pointer.ty = -(event.clientY / height - 0.5) * PARALLAX;
  }, { passive: true });
  motion.addEventListener('change', start);

  resize();
  start();
}
