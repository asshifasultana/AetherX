// Discovery re-enactments the AI guide runs as a game master. Each quest sets
// up a real view, asks the visitor to find something, and checks the answer
// against a position the code knows (never the model's judgement). Pure,
// apart from the preset motion it reuses.

import { presets, presetMotion, motionPosition } from '../presets.js';
import { separationArcsec } from './ecliptic.js';

export const NORTH_ECLIPTIC_POLE = Object.freeze({ raDeg: 270, decDeg: 66.5607 });

export const QUESTS = Object.freeze({
  'be-barnard': {
    title: 'Be Barnard (1916)',
    goal: 'Two photos a year apart are flipping. One star jumped. Click it.',
    story: 'In 1916 E. E. Barnard compared a new photographic plate with one from 1894 and saw a "new" star — then found a matching missing star about 4 arcminutes away on the old plate. One star had moved, about 10.3 arcseconds a year, the fastest of any star in our sky. Older Harvard plates traced it back to 1888.',
    lesson: 'A pair — one star appearing and one vanishing — years apart, then checked on older photos.',
    // Held on the star's own position, the answer would sit dead centre every
    // time, so each game picks one of 16 framings that put it 3′ or 4.5′ off
    // (the default field is 16′ across). A fixed set, not a free random shift:
    // crops are cached by their exact centre, so a framing someone has already
    // played loads from the cache.
    setup: { preset: 'barnard', mode: 'blink', followProperMotion: false, compare: 'first-last', offCentre: { ringsArcmin: [3, 4.5], directions: 8 } },
    toleranceArcsec: 30
  },
  'be-tombaugh': {
    title: 'Be Tombaugh (1930)',
    goal: 'These photos are a few days apart. Find a dot that crawls between them.',
    story: 'In February 1930 Clyde Tombaugh blinked two plates taken six days apart (23 and 29 January) near Delta Geminorum and saw one dot shift slightly. After weeks of checks to rule out asteroids and plate flaws, Pluto was announced on 13 March 1930. Lowell\'s predicted "Planet X" had pointed him to the right part of the sky, even though the prediction itself was wrong.',
    lesson: 'Photos days apart, a steady small shift, and many checks before believing it.',
    setup: { raDeg: NORTH_ECLIPTIC_POLE.raDeg, decDeg: NORTH_ECLIPTIC_POLE.decDeg, name: 'North Ecliptic Pole', mode: 'blink', compare: 'days-apart' },
    toleranceArcsec: 20
  },
  'be-leverrier': {
    title: 'Be Le Verrier (1846)',
    goal: 'We are at the most probable patch of the predicted Planet Nine region. Search it for anything that changed.',
    story: 'In 1846 Urbain Le Verrier predicted where an unseen planet must be from the way Uranus was being tugged, and Johann Galle found Neptune within about a degree of that spot on the first night. In 2016 Konstantin Batygin and Mike Brown proposed Planet Nine from the clustered orbits of distant icy bodies; their 2021 map says where it could still be hiding.',
    lesson: 'Go where a prediction points, search carefully, and report what you ruled out — even if it is nothing.',
    setup: { planetNineCell: 0, mode: 'difference', compare: 'six-months' },
    toleranceArcsec: null
  },
  'hidden-planet': {
    title: 'Find the hidden planet',
    goal: 'I hid a fake faint planet somewhere in these real photos. It moves a little between the two dates. Click it when you find it.',
    story: 'Astronomers test their searches by hiding fake objects in real images and counting how many they recover. The faintest fake they can still find tells them how deep the search really is.',
    lesson: 'A search is only as good as its measured limit.',
    setup: { mode: 'blink', compare: 'first-last', inject: true },
    toleranceArcsec: 20
  }
});

export const QUEST_IDS = Object.keys(QUESTS);

/** Every framing a quest may use: evenly spaced directions on each ring, alternate rings turned half a step. */
export function viewOffsets({ ringsArcmin, directions }) {
  const round = value => Number(value.toFixed(2)) + 0;
  return ringsArcmin.flatMap((distance, ring) => Array.from({ length: directions }, (_, step) => {
    const angle = (step + (ring % 2) / 2) * 2 * Math.PI / directions;
    return { eastArcmin: round(distance * Math.cos(angle)), northArcmin: round(distance * Math.sin(angle)) };
  }));
}

/** One of those framings, picked at random. */
export function randomViewOffset(setup, random = Math.random) {
  const offsets = viewOffsets(setup);
  return offsets[Math.min(offsets.length - 1, Math.floor(random() * offsets.length))];
}

/** Where Barnard's Star is on two dates (MJD), for checking a click. */
export function barnardTrack(fromMjd, toMjd) {
  const preset = presets.barnard;
  const motion = presetMotion({ targetId: 'barnard', raDeg: preset.raDeg, decDeg: preset.decDeg });
  return [motionPosition(motion, fromMjd), motionPosition(motion, toMjd)];
}

/** Distance from a point to the segment between two sky positions, in arcsec (small-field approximation). */
export function distanceToTrackArcsec(point, [a, b]) {
  const cos = Math.cos(point.decDeg * Math.PI / 180);
  const xy = position => [((position.raDeg - point.raDeg + 540) % 360 - 180) * cos * 3600, (position.decDeg - point.decDeg) * 3600];
  const [ax, ay] = xy(a), [bx, by] = xy(b);
  const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/**
 * Check a visitor's answer. `expected` is the answer track ([from, to]
 * positions) the controller computed when it set the quest up.
 */
export function checkQuestAnswer(questId, spot, expected) {
  const quest = QUESTS[questId];
  if (!quest || !spot) return { ok: false, error: 'No quest is running or no spot was given.' };
  if (!expected?.track) return { ok: true, correct: null, note: 'This quest has no single right answer; investigate the spot with find_changes and crossmatch.' };
  const missArcsec = distanceToTrackArcsec(spot, expected.track);
  const correct = missArcsec <= quest.toleranceArcsec;
  const shiftArcsec = separationArcsec(expected.track[0], expected.track[1]);
  return {
    ok: true,
    correct,
    missArcsec: Number(missArcsec.toFixed(1)),
    shiftArcsec: Number(shiftArcsec.toFixed(1)),
    ...(correct ? { story: quest.story, lesson: quest.lesson } : { hint: missArcsec < 120 ? 'Close! Look a little nearer.' : 'Not there. Watch which dot jumps when the frames flip.' })
  };
}
