import { createFitsRangeLoader } from './lib/range-fits.js';
import { prepareImage, projectImage, projectionKey, readFits } from './lib/fits-engine.js';
import { combineStack, medianStack } from './lib/stack.js';
import { loadViaProxy } from './lib/crop-codec.js';

const load = createFitsRangeLoader();
const controllers = new Map();
function transfers(value, buffers = new Set()) {
  if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) transfers(item, buffers);
  return [...buffers];
}
self.onmessage = async ({ data }) => {
  const { id, type, payload } = data;
  if (type === 'cancel') { controllers.get(id)?.abort(); return; }
  const controller = new AbortController(); controllers.set(id, controller);
  try {
    let result;
    if (type === 'load') {
      result = await loadViaProxy(payload, controller.signal);
      const transport = result ? 'proxy' : 's3';
      result ||= await load(payload.accessUrl, payload.target, payload.settings, controller.signal, payload.revision);
      result.projection = projectImage(result, payload.target, payload.settings);
      result.projectionKey = projectionKey(payload.target, payload.settings);
      result.transport = transport;
    } else if (type === 'decode') {
      result = prepareImage(readFits(payload.bytes), payload.target, payload.settings);
      result.transport = 'irsa';
    } else if (type === 'project') {
      result = projectImage(payload.image, payload.target, payload.settings);
    } else if (type === 'median') result = medianStack(payload.images);
    else if (type === 'combine') result = combineStack(payload.images, payload.options);
    else throw new Error('Unknown image worker operation.');
    controller.signal.throwIfAborted();
    self.postMessage({ id, result }, transfers(result));
  } catch (error) { self.postMessage({ id, error: { name: error.name, message: error.message } }); }
  finally { controllers.delete(id); }
};
self.postMessage({ ready: true });
