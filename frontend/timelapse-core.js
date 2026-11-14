// Pure helpers for the observation time-lapse. No DOM access here so the
// frame ordering and date-gap rules can be unit tested in Node.
const DAY_MS = 86400000;

export const SPEEDS = [0.5, 1, 2, 4];
export const BASE_FRAME_MS = 900;

export function observationTime(observation) {
  const time = Date.parse(observation?.observedStartUtc || '');
  return Number.isFinite(time) ? time : null;
}

export function observationKey(observation) {
  return observation?.accessUrl
    || `${observation?.observationId || ''}|${observation?.detector || ''}|${observation?.observedStartUtc || ''}`;
}

export function summarizeReleases(observations) {
  const releases = [...new Set((observations || []).map(item => item.release || /^spherex_(qr\d+)/i.exec(item.collection || '')?.[1]?.toUpperCase()).filter(Boolean))]
    .sort((a, b) => Number(b.replace(/^QR/i, '')) - Number(a.replace(/^QR/i, '')));
  return { releases, mixed: releases.length > 1, label: releases.length > 1 ? `Mixed ${releases.join(' / ')}` : releases[0] || 'Release not reported' };
}

// Summarize only products present in the current result set. Callers should
// label these counts as loaded when the archive has another page available.
export function summarizeDetectorCoverage(observations, { searchedDetector = 'all' } = {}) {
  return Array.from({ length: 6 }, (_, index) => {
    const detector = index + 1;
    const searched = searchedDetector === 'all' || Number(searchedDetector) === detector;
    const products = searched ? (observations || []).filter(item => Number(item.detector) === detector) : [];
    const dates = products.map(item => Date.parse(item.observedStartUtc || '')).filter(Number.isFinite).sort((a, b) => a - b);
    const wavelengths = products.flatMap(item => [item.wavelengthMinUm, item.wavelengthMaxUm])
      .filter(value => value !== null && value !== undefined && value !== '')
      .map(Number).filter(Number.isFinite);
    return {
      detector, searched, count: products.length,
      firstDate: dates.length ? new Date(dates[0]).toISOString() : null,
      lastDate: dates.length ? new Date(dates.at(-1)).toISOString() : null,
      wavelengthMinUm: wavelengths.length ? Math.min(...wavelengths) : null,
      wavelengthMaxUm: wavelengths.length ? Math.max(...wavelengths) : null
    };
  });
}

// Build chronological frames for one detector band. Same-day exposures can be
// collapsed to one frame so a day with several visits does not dominate playback.
export function buildFrames(observations, { band = null, combineExposures = true } = {}) {
  const dated = [];
  for (const observation of observations || []) {
    const time = observationTime(observation);
    if (time === null) continue;
    if (band !== null && band !== undefined && Number(observation.detector) !== Number(band)) continue;
    dated.push({ observation, time });
  }
  dated.sort((a, b) => a.time - b.time || Number(a.observation.detector) - Number(b.observation.detector));
  if (!combineExposures) {
    return dated.map(({ observation, time }) => ({
      ...observation,
      frameTime: time,
      exposureCount: 1,
      exposures: [observation],
      ...summarizeReleases([observation])
    }));
  }
  const byDay = new Map();
  for (const item of dated) {
    const day = item.observation.observedStartUtc.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(item);
  }
  return [...byDay.values()].map(group => ({
    ...group[0].observation,
    frameTime: group[0].time,
    observedEndUtc: group.at(-1).observation.observedEndUtc || group.at(-1).observation.observedStartUtc,
    exposureCount: group.length,
    exposureSeconds: group.reduce((sum, item) => sum + (Number(item.observation.exposureSeconds) || 0), 0),
    exposures: group.map(item => item.observation),
    ...summarizeReleases(group.map(item => item.observation))
  }));
}

export function frameTime(frame) {
  return Number.isFinite(frame?.frameTime) ? frame.frameTime : observationTime(frame) ?? 0;
}

// Positions on a time-proportional axis. A long gap therefore produces a long
// visual gap instead of an equal Index-based step.
export function frameFractions(frames) {
  if (!frames?.length) return [];
  const times = frames.map(frameTime);
  const first = times[0], last = times[times.length - 1];
  if (last <= first) return frames.map((_, index) => frames.length === 1 ? 0 : index / (frames.length - 1));
  return times.map(time => (time - first) / (last - first));
}

export function nearestFrameIndex(frames, fraction) {
  if (!frames?.length) return 0;
  const fractions = frameFractions(frames);
  const target = Math.max(0, Math.min(1, Number(fraction) || 0));
  let best = 0, bestDistance = Infinity;
  for (let index = 0; index < fractions.length; index++) {
    const distance = Math.abs(fractions[index] - target);
    if (distance < bestDistance) { best = index; bestDistance = distance; }
  }
  return best;
}

export function nearestFrameIndexByTime(frames, time) {
  if (!frames?.length) return 0;
  const first = frameTime(frames[0]), last = frameTime(frames[frames.length - 1]);
  if (last <= first) return 0;
  return nearestFrameIndex(frames, (time - first) / (last - first));
}

export function frameGaps(frames) {
  const gaps = [];
  for (let index = 1; index < (frames?.length || 0); index++) {
    gaps.push({
      afterIndex: index - 1,
      days: (frameTime(frames[index]) - frameTime(frames[index - 1])) / DAY_MS
    });
  }
  return gaps;
}

export function formatGap(days) {
  const value = Number(days);
  if (!Number.isFinite(value) || value <= 0) return 'same time';
  if (value >= 1) {
    const rounded = value >= 10 ? Math.round(value) : Number(value.toFixed(1));
    return `${rounded} ${rounded === 1 ? 'day' : 'days'}`;
  }
  if (value >= 1 / 24) {
    const hours = Math.max(1, Math.round(value * 24));
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  const minutes = Math.max(1, Math.round(value * 1440));
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

export function formatGapShort(days) {
  const value = Number(days);
  if (!Number.isFinite(value) || value <= 0) return '0m';
  if (value >= 1) {
    const rounded = value >= 10 ? Math.round(value) : Number(value.toFixed(1));
    return `${rounded}d`;
  }
  if (value >= 1 / 24) return `${Math.max(1, Math.round(value * 24))}h`;
  return `${Math.max(1, Math.round(value * 1440))}m`;
}

export function nextSpeed(speed) {
  const index = SPEEDS.indexOf(Number(speed));
  return SPEEDS[(index + 1) % SPEEDS.length];
}

export function frameDelayMs(speed) {
  const value = Number(speed);
  return Math.round(BASE_FRAME_MS / (Number.isFinite(value) && value > 0 ? value : 1));
}
