import { parseHeader } from './fits-engine.js';
import { cloudUrl } from './range-fits.js';

const BLOCK = 2880;

export function createWavelengthReader(fetchRange = fetch) {
  const tables = new Map();
  return async function wavelengthAt(accessUrl, x, y) {
    const url = cloudUrl(accessUrl);
    if (!tables.has(url)) {
      const table = (async () => {
        const response = await fetchRange(url, { headers: { Range: `bytes=-${4 * BLOCK}` }, signal: AbortSignal.timeout(20000) });
        if (response.status !== 206) {
          await response.body?.cancel();
          throw new Error(`WCS-WAVE range request failed (${response.status}).`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const marker = new TextDecoder('ascii').decode(bytes).lastIndexOf("XTENSION= 'BINTABLE'");
        if (marker < 0) throw new Error('WCS-WAVE extension unavailable.');
        const { header, dataOffset } = parseHeader(bytes, marker);
        const nx = Number.parseInt(header.TFORM1), ny = Number.parseInt(header.TFORM2);
        if (header.EXTNAME !== 'WCS-WAVE' || header.NAXIS2 !== 1 || nx < 2 || ny < 2 ||
            !/^\d+J$/.test(header.TFORM1) || !/^\d+J$/.test(header.TFORM2) ||
            header.TFORM3 !== `${2 * nx * ny}E` || dataOffset + 4 * (nx + ny + 2 * nx * ny) > bytes.length) {
          throw new Error('Unsupported WCS-WAVE layout.');
        }
        const view = new DataView(bytes.buffer, dataOffset);
        const xs = Array.from({ length: nx }, (_, i) => view.getInt32(i * 4));
        const ys = Array.from({ length: ny }, (_, i) => view.getInt32((nx + i) * 4));
        return { xs, ys, view };
      })();
      if (tables.size >= 128) tables.delete(tables.keys().next().value);
      tables.set(url, table);
      table.catch(() => { if (tables.get(url) === table) tables.delete(url); });
    }
    const { xs, ys, view } = await tables.get(url);
    const bracket = (axis, coordinate) => {
      const upper = axis.findIndex(node => node >= coordinate);
      const i = upper < 0 ? axis.length - 2 : Math.max(0, upper - 1);
      return [i, Math.min(1, Math.max(0, (coordinate - axis[i]) / (axis[i + 1] - axis[i])))];
    };
    const [i, fx] = bracket(xs, x + 1), [j, fy] = bracket(ys, y + 1);
    const at = (dx, dy) => view.getFloat32(4 * (xs.length + ys.length + 2 * ((j + dy) * xs.length + i + dx)));
    return (at(0, 0) * (1 - fx) + at(1, 0) * fx) * (1 - fy) + (at(0, 1) * (1 - fx) + at(1, 1) * fx) * fy;
  };
}

