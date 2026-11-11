// The AI guide's case file: for every marked spot, a list of suspects (possible
// explanations) that tool results rule out or support. Evidence is applied by
// these rules from measured results, never by the model, so a spot is only
// called "unexplained" when every ordinary explanation has been checked.
// Pure and DOM-free.
//
// An area spot (radiusArcsec) holds many sources, so no suspect can be ruled
// in or out for it. Its case file collects findings about what is inside
// instead, and its verdict is always "area".

export const SUSPECTS = Object.freeze({
  glitch: { label: 'Camera glitch or cosmic ray', test: 'measure_source', mundane: true },
  colour_shift: { label: 'Colour-shift ghost around a star', test: 'crossmatch', mundane: true },
  known_star: { label: 'Known star (Gaia, CatWISE, SIMBAD)', test: 'crossmatch', mundane: true },
  proper_motion_star: { label: 'Nearby fast-moving star', test: 'crossmatch', mundane: true },
  known_asteroid: { label: 'Known asteroid or comet (JPL)', test: 'crossmatch', mundane: true },
  variable_star: { label: 'Star changing brightness', test: 'measure_source', mundane: false },
  distant_unknown: { label: 'Something distant and uncatalogued', test: 'predict_parallax_pair', mundane: false }
});

const MATCH_STAR_ARCSEC = 6;
const NEAR_STAR_ARCSEC = 15;
const MATCH_ASTEROID_ARCSEC = 30;
const FAST_STAR_MAS_YR = 100;
const DETECTION_SNR = 3;
const MOTION_SIGMA = 3;
const MOTION_DATES = 3;
const CATALOGUE_NOTE = 'A catalogue entry means the object is known, not that its nature is understood.';
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const compass = degrees => COMPASS[Math.round((((degrees % 360) + 360) % 360) / 45) % 8];
const note = (file, text) => { if (!file.notes.includes(text)) file.notes.push(text); };
// The star catalogues crossmatch asks, in the order they are named.
const STAR_CATALOGUES = [['gaia', 'Gaia'], ['catwise', 'CatWISE2020'], ['simbad', 'SIMBAD']];
function starName(catalog, star) {
  if (catalog === 'SIMBAD') return `SIMBAD ${star.name || star.sourceId}${star.otype ? ` (type ${star.otype})` : ''}`;
  if (catalog === 'Gaia') return `Gaia star ${star.sourceId}${star.gMag != null ? ` (G ${star.gMag})` : ''}`;
  return `${catalog} source ${star.sourceId}${star.w2 != null ? ` (W2 ${star.w2})` : ''}`;
}

export function createCase(spot) {
  return {
    spot: spot.n,
    raDeg: spot.raDeg,
    decDeg: spot.decDeg,
    origin: spot.origin || 'user',
    radiusArcsec: spot.radiusArcsec || null,
    findings: {},
    suspects: Object.fromEntries(Object.keys(SUSPECTS).map(key => [key, { status: 'open', evidence: [] }])),
    notes: []
  };
}

function set(file, key, status, evidence, { onlyIfOpen = false } = {}) {
  const suspect = file.suspects[key];
  if (!suspect) return;
  if (onlyIfOpen && suspect.status !== 'open') { suspect.evidence.push(evidence); return; }
  suspect.status = status;
  suspect.evidence.push(evidence);
}

/** Apply one tool result to a case file. Returns the same (mutated) case. */
export function applyEvidence(file, tool, result) {
  if (!file || !result || result.ok === false) return file;
  if (file.radiusArcsec) return applyAreaEvidence(file, tool, result);
  if (tool === 'find_changes' && result.blob) {
    const blob = result.blob;
    if (blob.singlePixel) set(file, 'glitch', 'supported', `The change is a single pixel (${blob.peakSigma}σ), typical of a cosmic ray or hot pixel.`, { onlyIfOpen: true });
    if (result.pairedAdjacent) set(file, 'colour_shift', 'supported', 'Brighter and fainter patches sit right next to each other, typical of a residual around a star.', { onlyIfOpen: true });
    if (blob.touchesMask) set(file, 'colour_shift', 'supported', 'The change sits next to masked pixels: often a saturated-star residual.', { onlyIfOpen: true });
    if (Number.isInteger(result.pairedWith)) file.findings.pair = { spot: result.pairedWith };
  }
  if (tool === 'measure_source') {
    const detected = (result.measurements || []).filter(entry => entry.snr >= DETECTION_SNR);
    const dates = new Set(detected.map(entry => entry.date));
    const measured = (result.measurements || []).length;
    if (dates.size >= 2) set(file, 'glitch', 'ruled_out', `Detected above ${DETECTION_SNR}σ on ${dates.size} separate dates; a glitch would not repeat.`);
    else if (measured >= 3 && dates.size === 1) set(file, 'glitch', 'supported', `Detected on 1 of ${measured} measured dates only.`, { onlyIfOpen: true });
    // Nothing on any date is not a glitch (that shows on one date): there is no source here.
    if (measured >= 3 && dates.size === 0) file.findings.empty = { measured };
    else if (dates.size) delete file.findings.empty;
    if (detected.length >= 3 && Number.isFinite(result.variabilitySigma)) {
      if (result.variabilitySigma >= 5) set(file, 'variable_star', 'supported', `Brightness changes by ${result.variabilitySigma}σ between dates at a fixed position.`);
      else set(file, 'variable_star', 'ruled_out', `Brightness is steady within ${result.variabilitySigma}σ across ${detected.length} detections.`);
    }
  }
  if (tool === 'crossmatch') {
    const gaia = result.gaia;
    // Every star catalogue that answered; one that failed neither confirms nor rules out.
    const answered = STAR_CATALOGUES.map(([key, name]) => [name, result[key]]).filter(([, value]) => value && !value.error);
    const failed = STAR_CATALOGUES.filter(([key]) => result[key]?.error).map(([, name]) => name);
    if (answered.length) {
      // SIMBAD is named first when it matches: it gives the object's name and type.
      const matches = answered.map(([name, value]) => [name, value.nearest]).filter(([, star]) => star && star.separationArcsec <= MATCH_STAR_ARCSEC)
        .sort(([a], [b]) => (b === 'SIMBAD') - (a === 'SIMBAD'));
      if (matches.length) {
        const [[name, star]] = matches;
        const others = matches.slice(1).map(([other]) => other);
        set(file, 'known_star', 'supported', `${starName(name, star)} is ${star.separationArcsec}″ away at this date${others.length ? `; also listed in ${others.join(' and ')}` : ''}.`);
        note(file, CATALOGUE_NOTE);
        const fast = matches.find(([, entry]) => Math.hypot(entry.pmra || 0, entry.pmdec || 0) >= FAST_STAR_MAS_YR);
        if (fast) set(file, 'proper_motion_star', 'supported', `That star moves ${Math.round(Math.hypot(fast[1].pmra || 0, fast[1].pmdec || 0))} mas per year.`);
        else set(file, 'proper_motion_star', 'ruled_out', 'The matching catalogue star moves slowly.');
      } else if (file.suspects.known_star.status !== 'supported') {
        // A later answer from one catalogue (a background retry) never overturns another's match.
        const names = answered.map(([name]) => name === 'Gaia' ? 'Gaia (G ≤ 18)' : name);
        const listed = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0];
        set(file, 'known_star', 'ruled_out', `No star within ${MATCH_STAR_ARCSEC}″ in ${listed}${failed.length ? ` (${failed.join(' and ')} did not answer)` : ''}.`);
        // A fast star whose track crossed this spot since 2000 (its old place is now empty).
        const movedThrough = Array.isArray(result.movedThrough) ? result.movedThrough : gaia?.movedThrough;
        const pass = (movedThrough || [])[0];
        const since = result.trackedSince || gaia?.trackedSince || 2000, upTo = result.date ? ` and ${result.date}` : ' and now';
        if (pass) {
          const catalog = pass.catalog || 'Gaia';
          file.findings.movedStar = { ...pass, catalog, date: result.date || null };
          set(file, 'proper_motion_star', 'supported', `${starName(catalog, pass)} moves ${pass.pmArcsecPerYear}″ per year and was here around ${pass.closestYear}; ${result.date ? `on ${result.date}` : 'now'} it is ${pass.now.offsetArcmin}′ ${pass.now.direction}.`);
        } else if (Array.isArray(movedThrough) && file.suspects.proper_motion_star.status !== 'supported') {
          const truncated = gaia?.truncated || result.truncated;
          set(file, 'proper_motion_star', 'ruled_out', `No fast-moving catalogued star (≥ ${FAST_STAR_MAS_YR} mas per year) passed within 12″ of here between ${since}${upTo}${truncated ? ' (only the brightest 1000 nearby stars checked)' : ''}.`);
        }
      }
    }
    if (gaia && !gaia.error) {
      const bright = (gaia.within || []).find(star => star.separationArcsec <= NEAR_STAR_ARCSEC && star.gMag <= 14);
      if (file.suspects.colour_shift.status !== 'supported') {
        if (bright) set(file, 'colour_shift', 'supported', `A bright Gaia star (G ${bright.gMag}) is only ${bright.separationArcsec}″ away; its colour residuals can mimic a change.`);
        else set(file, 'colour_shift', 'ruled_out', `No bright star (G ≤ 14) within ${NEAR_STAR_ARCSEC}″ to leave a colour residual.`);
      }
    }
    const jpl = result.jpl;
    if (jpl && jpl.checked) {
      const match = jpl.nearest && jpl.nearest.separationArcsec <= MATCH_ASTEROID_ARCSEC ? jpl.nearest : null;
      if (match) set(file, 'known_asteroid', 'supported', `JPL predicts ${match.name} ${match.separationArcsec}″ away on ${jpl.date}.`);
      else set(file, 'known_asteroid', 'ruled_out', `JPL lists no known asteroid or comet within ${MATCH_ASTEROID_ARCSEC}″ on ${jpl.date}.`);
    }
  }
  if (tool === 'confirm_motion' && Number.isFinite(result.detectedOnDates)) {
    const motion = { detectedOnDates: result.detectedOnDates, of: result.of, motionArcsecPerYear: result.motionArcsecPerYear, directionDeg: result.directionDeg, significance: result.significance, consistent: Boolean(result.consistent) };
    file.findings.motion = motion;
    if (motion.consistent && motion.detectedOnDates >= MOTION_DATES) {
      set(file, 'glitch', 'ruled_out', `Found on ${motion.detectedOnDates} of ${motion.of} dates along one straight line; a glitch would not repeat.`);
      if (motion.significance >= MOTION_SIGMA) {
        set(file, 'colour_shift', 'ruled_out', `Its position follows one straight line across ${motion.detectedOnDates} dates (${motion.motionArcsecPerYear}″ per year); colour residuals jump around.`);
        file.findings.mover = motion;
      } else delete file.findings.mover;
    } else {
      delete file.findings.mover;
      if (motion.detectedOnDates >= 2) set(file, 'colour_shift', 'supported', 'Positions jump between dates: typical of alignment or colour residuals.', { onlyIfOpen: true });
    }
  }
  if (tool === 'precover' && Number.isFinite(result.recovered)) {
    if (result.recovered >= 1) set(file, 'distant_unknown', 'supported', `Found again at the predicted position on ${result.recovered} other date(s).`);
    else file.notes.push('Not found at the predicted positions in other frames.');
  }
  if (tool === 'second_opinion' && result.label) {
    // A vision model's opinion is a note, never a ruling on its own.
    file.notes.push(`Vision second opinion: ${result.label}${result.reason ? ` (${result.reason})` : ''}.`);
  }
  return file;
}

const AREA_CHECKS = { stars: 'crossmatch', asteroids: 'crossmatch', brightness: 'measure_source' };

// Findings for an area, keyed so a repeated check replaces its earlier line.
function applyAreaEvidence(file, tool, result) {
  const findings = file.findings;
  if (tool === 'crossmatch') {
    const gaia = result.gaia;
    if (gaia && !gaia.error && Number.isFinite(gaia.starsInside)) {
      const count = `${gaia.starsInside}${gaia.countIsLowerLimit ? '+' : ''}`;
      const brightest = gaia.brightest?.[0];
      findings.stars = gaia.starsInside
        ? `${count} Gaia star${gaia.starsInside === 1 ? '' : 's'} (G ≤ 18) inside${brightest ? `; the brightest is G ${brightest.gMag}` : ''}${gaia.fastMovingCount ? `; ${gaia.fastMovingCount} move${gaia.fastMovingCount === 1 ? 's' : ''} fast (≥ ${FAST_STAR_MAS_YR} mas per year)` : ''}.`
        : 'No Gaia star (G ≤ 18) inside.';
    }
    const simbad = result.simbad;
    if (simbad && !simbad.error && Number.isFinite(simbad.objectsInside)) {
      findings.named = simbad.objectsInside
        ? `SIMBAD lists ${simbad.objectsInside} named object${simbad.objectsInside === 1 ? '' : 's'} inside: ${simbad.named.join(', ')}${simbad.objectsInside > simbad.named.length ? ', …' : ''}.`
        : 'SIMBAD lists no named object inside.';
    }
    const jpl = result.jpl;
    if (jpl && jpl.checked && Number.isFinite(jpl.objectsInside)) {
      findings.asteroids = jpl.objectsInside
        ? `JPL lists ${jpl.objectsInside} known asteroid${jpl.objectsInside === 1 ? '' : 's'} or comet${jpl.objectsInside === 1 ? '' : 's'} inside on ${jpl.date}: ${jpl.objects.map(object => object.name).join(', ')}${jpl.objectsInside > jpl.objects.length ? ', …' : ''}.`
        : `JPL lists no known asteroid or comet inside on ${jpl.date}.`;
    }
  }
  if (tool === 'measure_source') {
    const measured = (result.measurements || []).length;
    const detected = (result.measurements || []).filter(entry => entry.snr >= DETECTION_SNR).length;
    if (detected >= 3 && Number.isFinite(result.variabilitySigma)) {
      findings.brightness = result.variabilitySigma >= 5
        ? `The total brightness inside changes by ${result.variabilitySigma}σ between dates.`
        : `The total brightness inside is steady within ${result.variabilitySigma}σ across ${detected} dates.`;
    } else if (measured) findings.brightness = `The area is brighter than its surroundings (above ${DETECTION_SNR}σ) on ${detected} of ${measured} measured dates.`;
  }
  if (tool === 'precover' && Number.isFinite(result.recovered)) file.notes.push(result.recovered >= 1 ? `Found again at the predicted position on ${result.recovered} other date(s).` : 'Not found at the predicted positions in other frames.');
  if (tool === 'second_opinion' && result.label) file.notes.push(`Vision second opinion: ${result.label}${result.reason ? ` (${result.reason})` : ''}.`);
  return file;
}

/** The computed verdict, plus what to test next. */
export function verdict(file) {
  if (file.radiusArcsec) {
    const next = [...new Set(Object.entries(AREA_CHECKS).filter(([key]) => !file.findings?.[key]).map(([, test]) => test))];
    return {
      label: 'area',
      detail: 'An area, not one source: the checks describe what is inside it. To investigate one object in it, mark a point on that object.',
      open: [], suggest: [], ...(next.length ? { next } : {})
    };
  }
  const s = file.suspects;
  const supported = key => s[key].status === 'supported';
  const open = Object.entries(s).filter(([, value]) => value.status === 'open').map(([key]) => key);
  const n = file.spot, findings = file.findings || {};
  // A detection no catalogue explains that has not been followed across dates yet.
  const pair = findings.pair?.spot;
  const confirmMotion = { tool: 'confirm_motion', args: { spot: n, ...(pair ? { to_spot: pair } : {}) }, why: pair ? `Follow spots ${n} and ${pair} across many dates to see if it really moves` : 'Follow it across many dates to see if it moves in a straight line' };
  const needsMotion = !findings.motion && !findings.empty && (Boolean(pair) || s.known_star.status === 'ruled_out');
  const done = (label, detail, extra = {}) => ({ label, detail, open, suggest: [], ...extra });
  if (supported('known_asteroid')) return done('known object', 'Matches a known asteroid or comet.');
  const moved = findings.movedStar;
  if (moved && supported('proper_motion_star') && !supported('known_star')) {
    const who = moved.catalog === 'SIMBAD' ? `SIMBAD ${moved.name || moved.sourceId}` : `${moved.catalog === 'CatWISE2020' ? 'CatWISE2020 source' : 'Gaia star'} ${moved.sourceId}`;
    return done('moved away', `${findings.empty ? 'Nothing is here now. ' : ''}${who} was here around ${moved.closestYear} and has since moved ${moved.now.offsetArcmin}′ ${moved.now.direction} (${moved.now.raDeg}°, ${moved.now.decDeg}°${moved.date ? ` on ${moved.date}` : ''}). Mark it there to check it.`, {
      star: moved.now,
      suggest: [{ tool: 'mark_spot', args: { raDeg: moved.now.raDeg, decDeg: moved.now.decDeg, label: 'moved star' }, why: 'Mark the star where it is now' }]
    });
  }
  if (supported('proper_motion_star')) return done('known object', 'A catalogued fast-moving star explains it.');
  if (supported('known_star') && !supported('variable_star')) return done('known object', 'A catalogued star sits at this position.');
  const mover = findings.mover;
  if (mover && s.known_star.status === 'ruled_out') {
    return done('uncatalogued mover — needs follow-up', `Moves ${mover.motionArcsecPerYear}″ per year towards the ${compass(mover.directionDeg)} (${mover.significance}σ, found on ${mover.detectedOnDates} of ${mover.of} dates) and matches no catalogue: motion selected it; only a spectrum can identify it.`, {
      suggest: [{ tool: 'get_spectrum', args: { spot: n }, why: 'Measure its spectrum: only that can say what it is' }]
    });
  }
  if (supported('glitch') || supported('colour_shift')) {
    return done('likely artefact', supported('glitch') ? 'Looks like a camera glitch.' : 'Looks like a colour residual around a star.', {
      suggest: [{ tool: 'second_opinion', args: { spot: n }, why: 'Ask for a second opinion on whether it looks real' }]
    });
  }
  if (findings.empty) return done('no source', `Nothing is detected here on any of ${findings.empty.measured} measured dates: empty sky at this sensitivity. If you expected an object here, it may have moved.`);
  if (supported('variable_star')) return done('variable source', 'Something at a fixed position that changes brightness.', { suggest: needsMotion ? [confirmMotion] : [] });
  const mundaneOpen = open.filter(key => SUSPECTS[key].mundane);
  if (!mundaneOpen.length) {
    const suggest = [
      ...(needsMotion ? [confirmMotion] : []),
      { tool: 'get_spectrum', args: { spot: n }, why: 'Look for a methane dip near 3.3 µm' },
      ...(pair ? [{ tool: 'precover', args: { from_spot: pair, to_spot: n }, why: 'Look for it again in other frames along its track' }] : [])
    ];
    return done('unexplained — needs follow-up', 'Every ordinary explanation was ruled out. It still needs another sighting before anyone can say what it is.', { suggest });
  }
  const next = [...new Set(mundaneOpen.map(key => SUSPECTS[key].test))];
  const why = { crossmatch: 'Check it against star and asteroid catalogues', measure_source: 'Measure its brightness on every date' };
  // The catalogue check rules out the most suspects, so it goes first.
  const first = next.includes('crossmatch') ? 'crossmatch' : next[0];
  const suggest = [{ tool: first, args: { spot: n }, why: why[first] || 'Run the next check' }, ...(needsMotion ? [confirmMotion] : [])];
  // Lower-case only the first letter, so catalogue names keep their capitals.
  return done('open', `Still to check: ${mundaneOpen.map(key => SUSPECTS[key].label[0].toLowerCase() + SUSPECTS[key].label.slice(1)).join('; ')}.`, { next, suggest });
}

/** Plain summary for the model and the case card. */
export function summarize(file) {
  return {
    spot: file.spot,
    raDeg: Number(file.raDeg.toFixed(5)),
    decDeg: Number(file.decDeg.toFixed(5)),
    ...(file.radiusArcsec ? { radiusArcsec: file.radiusArcsec, findings: Object.values(file.findings || {}) } : {}),
    suspects: file.radiusArcsec ? [] : Object.entries(file.suspects).map(([key, value]) => ({ key, label: SUSPECTS[key].label, status: value.status, evidence: value.evidence.at(-1) || '' })),
    notes: file.notes.slice(-3),
    verdict: verdict(file)
  };
}

export function createCaseBook() {
  const cases = new Map();
  return {
    ensure(spot) {
      const existing = cases.get(spot.n);
      if (existing && Math.abs(existing.raDeg - spot.raDeg) < 1e-6 && Math.abs(existing.decDeg - spot.decDeg) < 1e-6 && (existing.radiusArcsec || null) === (spot.radiusArcsec || null)) return existing;
      const file = createCase(spot);
      cases.set(spot.n, file);
      return file;
    },
    get(n) { return cases.get(Number(n)) || null; },
    remove(n) { cases.delete(Number(n)); },
    clear() { cases.clear(); },
    all() { return [...cases.values()]; }
  };
}
