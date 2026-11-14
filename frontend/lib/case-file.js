// The AI guide's case file: for every marked spot, a list of suspects (possible
// explanations) that tool results rule out or support. Evidence is applied by
// these rules from measured results, never by the model, so a spot is only
// called "unexplained" when every ordinary explanation has been checked.
// Pure and DOM-free.

export const SUSPECTS = Object.freeze({
  glitch: { label: 'Camera glitch or cosmic ray', test: 'measure_source', mundane: true },
  colour_shift: { label: 'Colour-shift ghost around a star', test: 'crossmatch', mundane: true },
  known_star: { label: 'Known star (Gaia)', test: 'crossmatch', mundane: true },
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

export function createCase(spot) {
  return {
    spot: spot.n,
    raDeg: spot.raDeg,
    decDeg: spot.decDeg,
    origin: spot.origin || 'user',
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
  if (tool === 'find_changes' && result.blob) {
    const blob = result.blob;
    if (blob.singlePixel) set(file, 'glitch', 'supported', `The change is a single pixel (${blob.peakSigma}σ), typical of a cosmic ray or hot pixel.`, { onlyIfOpen: true });
    if (result.pairedAdjacent) set(file, 'colour_shift', 'supported', 'Brighter and fainter patches sit right next to each other, typical of a residual around a star.', { onlyIfOpen: true });
  }
  if (tool === 'measure_source') {
    const detected = (result.measurements || []).filter(entry => entry.snr >= DETECTION_SNR);
    const dates = new Set(detected.map(entry => entry.date));
    if (dates.size >= 2) set(file, 'glitch', 'ruled_out', `Detected above ${DETECTION_SNR}σ on ${dates.size} separate dates; a glitch would not repeat.`);
    else if ((result.measurements || []).length >= 3 && dates.size <= 1) set(file, 'glitch', 'supported', `Detected on ${dates.size} of ${result.measurements.length} measured dates only.`, { onlyIfOpen: true });
    if (detected.length >= 3 && Number.isFinite(result.variabilitySigma)) {
      if (result.variabilitySigma >= 5) set(file, 'variable_star', 'supported', `Brightness changes by ${result.variabilitySigma}σ between dates at a fixed position.`);
      else set(file, 'variable_star', 'ruled_out', `Brightness is steady within ${result.variabilitySigma}σ across ${detected.length} detections.`);
    }
  }
  if (tool === 'crossmatch') {
    const gaia = result.gaia;
    if (gaia && !gaia.error) {
      const nearest = gaia.nearest;
      if (nearest && nearest.separationArcsec <= MATCH_STAR_ARCSEC) {
        set(file, 'known_star', 'supported', `Gaia star ${nearest.sourceId} (G ${nearest.gMag}) is ${nearest.separationArcsec}″ away.`);
        if (Math.hypot(nearest.pmra || 0, nearest.pmdec || 0) >= FAST_STAR_MAS_YR) set(file, 'proper_motion_star', 'supported', `That star moves ${Math.round(Math.hypot(nearest.pmra || 0, nearest.pmdec || 0))} mas per year.`);
        else set(file, 'proper_motion_star', 'ruled_out', 'The matching Gaia star moves slowly.');
      } else {
        set(file, 'known_star', 'ruled_out', `No Gaia star within ${MATCH_STAR_ARCSEC}″ (G ≤ 18).`);
        const fast = (gaia.within || []).find(star => Math.hypot(star.pmra || 0, star.pmdec || 0) >= FAST_STAR_MAS_YR && star.separationArcsec <= 60);
        if (fast) set(file, 'proper_motion_star', 'supported', `Gaia star ${fast.sourceId} ${fast.separationArcsec}″ away moves fast enough to shift between dates.`);
        else set(file, 'proper_motion_star', 'ruled_out', 'No fast-moving Gaia star within 60″.');
      }
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

/** The computed verdict, plus what to test next. */
export function verdict(file) {
  const s = file.suspects;
  const supported = key => s[key].status === 'supported';
  const open = Object.entries(s).filter(([, value]) => value.status === 'open').map(([key]) => key);
  if (supported('known_asteroid')) return { label: 'known object', detail: 'Matches a known asteroid or comet.', open };
  if (supported('proper_motion_star')) return { label: 'known object', detail: 'A catalogued fast-moving star explains it.', open };
  if (supported('known_star') && !supported('variable_star')) return { label: 'known object', detail: 'A catalogued star sits at this position.', open };
  if (supported('glitch') || supported('colour_shift')) return { label: 'likely artefact', detail: supported('glitch') ? 'Looks like a camera glitch.' : 'Looks like a colour residual around a star.', open };
  if (supported('variable_star')) return { label: 'variable source', detail: 'Something at a fixed position that changes brightness.', open };
  const mundaneOpen = open.filter(key => SUSPECTS[key].mundane);
  if (!mundaneOpen.length) return { label: 'unexplained — needs follow-up', detail: 'Every ordinary explanation was ruled out. It still needs another sighting before anyone can say what it is.', open };
  return { label: 'open', detail: `Still to check: ${mundaneOpen.map(key => SUSPECTS[key].label.toLowerCase()).join('; ')}.`, open, next: [...new Set(mundaneOpen.map(key => SUSPECTS[key].test))] };
}

/** Plain summary for the model and the case card. */
export function summarize(file) {
  return {
    spot: file.spot,
    raDeg: Number(file.raDeg.toFixed(5)),
    decDeg: Number(file.decDeg.toFixed(5)),
    suspects: Object.entries(file.suspects).map(([key, value]) => ({ key, label: SUSPECTS[key].label, status: value.status, evidence: value.evidence.at(-1) || '' })),
    notes: file.notes.slice(-3),
    verdict: verdict(file)
  };
}

export function createCaseBook() {
  const cases = new Map();
  return {
    ensure(spot) {
      const existing = cases.get(spot.n);
      if (existing && Math.abs(existing.raDeg - spot.raDeg) < 1e-6 && Math.abs(existing.decDeg - spot.decDeg) < 1e-6) return existing;
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
