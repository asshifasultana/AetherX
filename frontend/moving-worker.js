import { createMovingView } from './lib/moving-view.js';

const viewer = createMovingView();
let active = false;
self.onmessage = async ({ data }) => {
  if (active) return;
  active = true;
  const progress = value => self.postMessage({ type: 'progress', value });
  try {
    const value = data.type === 'scan' ? await viewer.scan(data.search, data.exposures, progress)
      : await viewer.stack(data, progress);
    self.postMessage({ type: 'result', value });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  } finally { active = false; }
};
