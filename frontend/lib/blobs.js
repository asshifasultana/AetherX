// Find compact changes in a difference image: groups of touching pixels that
// are significantly brighter or fainter than the reference. Pure and DOM-free,
// so the AI guide gets a list of positions instead of only pixel counts.

const NEIGHBOURS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/**
 * @param {object} input
 * @param {Uint8Array} input.significant 1 = brighter, 2 = fainter, 0 = no change
 * @param {Float32Array} input.values difference values
 * @param {number} input.width grid width (square grid)
 * @param {number} input.sigma noise of the difference image
 * @returns {Array<{sign:'brighter'|'fainter', x:number, y:number, pixels:number, peakSigma:number, edge:boolean, singlePixel:boolean}>}
 */
export function findBlobs({ significant, values, width, sigma }, { limit = 12, edgePx = 2 } = {}) {
  if (!significant || !values || !width || !(sigma > 0)) return [];
  const height = Math.floor(significant.length / width);
  const seen = new Uint8Array(significant.length);
  const blobs = [];
  for (let start = 0; start < significant.length; start++) {
    const kind = significant[start];
    if (!kind || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let pixels = 0, weight = 0, sx = 0, sy = 0, peak = 0, edge = false;
    while (stack.length) {
      const index = stack.pop();
      const x = index % width, y = (index - x) / width;
      const strength = Math.abs(values[index]) / sigma;
      pixels++;
      weight += strength; sx += x * strength; sy += y * strength;
      if (strength > peak) peak = strength;
      if (x < edgePx || y < edgePx || x >= width - edgePx || y >= height - edgePx) edge = true;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (!seen[next] && significant[next] === kind) { seen[next] = 1; stack.push(next); }
      }
    }
    blobs.push({
      sign: kind === 1 ? 'brighter' : 'fainter',
      x: weight ? sx / weight : start % width,
      y: weight ? sy / weight : Math.floor(start / width),
      pixels,
      peakSigma: Number(peak.toFixed(1)),
      edge,
      singlePixel: pixels === 1
    });
  }
  // Strong, compact, multi-pixel changes first; single hot pixels last.
  const score = blob => blob.peakSigma * Math.sqrt(Math.min(blob.pixels, 25)) * (blob.singlePixel ? 0.3 : 1) * (blob.edge ? 0.5 : 1);
  return blobs.sort((a, b) => score(b) - score(a)).slice(0, limit);
}

/**
 * Pair a brighter blob with a nearby fainter one: the signature of something
 * that moved between the two dates (or of a residual around a star when the
 * two sit right next to each other).
 */
export function pairBlobs(blobs, { maxSeparationPx = 10, minSeparationPx = 1 } = {}) {
  const brighter = blobs.filter(blob => blob.sign === 'brighter');
  const fainter = blobs.filter(blob => blob.sign === 'fainter');
  const used = new Set(), pairs = [];
  for (const now of brighter) {
    let best = null, bestDistance = Infinity;
    for (const before of fainter) {
      if (used.has(before)) continue;
      const distance = Math.hypot(now.x - before.x, now.y - before.y);
      if (distance >= minSeparationPx && distance <= maxSeparationPx && distance < bestDistance) { best = before; bestDistance = distance; }
    }
    if (best) {
      used.add(best);
      pairs.push({ now, before: best, separationPx: Number(bestDistance.toFixed(1)), adjacent: bestDistance <= 2.5 });
    }
  }
  return pairs;
}
