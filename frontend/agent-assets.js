// Browser files of the AI guide. The local server and the Vercel build both
// publish exactly this list, so a new guide module cannot 404 in production.
export const AGENT_PUBLIC_FILES = Object.freeze([
  'agent-ui.js', 'agent-controller.js', 'agent-investigate.js',
  'lib/agent-tools.js', 'lib/agent-guard.js', 'lib/background-jobs.js', 'lib/spots.js', 'lib/blobs.js', 'lib/case-file.js',
  'lib/ecliptic.js', 'lib/photometry.js', 'lib/spectral-hints.js', 'lib/quests.js', 'lib/tours.js',
  'data/planet-nine.json'
]);
