// Small deterministic MEFs exercise the same IMAGE/FLAGS layouts as the archive.
export const block = 2880;
export function header(fields) {
  const cards = Object.entries(fields).map(([key, value]) => {
    const field = typeof value === 'string' ? `'${value}'` : typeof value === 'boolean' ? (value ? 'T' : 'F') : String(value);
    return `${key.padEnd(8)}= ${field}`.padEnd(80);
  });
  cards.push('END'.padEnd(80));
  const bytes = Buffer.alloc(Math.ceil(cards.length * 80 / block) * block, 32);
  bytes.write(cards.join(''), 'ascii'); return bytes;
}
export function pad(bytes) { const out = Buffer.alloc(Math.ceil(bytes.length / block) * block); bytes.copy(out); return out; }
export function makeFits({ width = 64, height = 64, bitpix = -32, ra = 359.999, dec = 4.69, compressed = null, sip = false } = {}) {
  const wcs = {
    CTYPE1: sip ? 'RA---TAN-SIP' : 'RA---TAN', CTYPE2: sip ? 'DEC--TAN-SIP' : 'DEC--TAN',
    CRVAL1: ra, CRVAL2: dec, CRPIX1: width / 2 + .3, CRPIX2: height / 2 + .7,
    CD1_1: -6.15 / 3600, CD1_2: 0, CD2_1: 0, CD2_2: 6.15 / 3600,
    ...(sip ? { A_ORDER: 2, B_ORDER: 2, A_2_0: 1e-6, B_0_2: -1e-6 } : {})
  };
  const science = Buffer.alloc(width * height * Math.abs(bitpix) / 8);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = 10 + Math.sin(x * .7) + Math.cos(y * .4) + 40 * Math.exp(-((x - width / 2) ** 2 + (y - height / 2) ** 2) / 5);
    if (bitpix === -32) science.writeFloatBE(value, (y * width + x) * 4);
    else science.writeDoubleBE(value, (y * width + x) * 8);
  }
  const imageHeader = header({ XTENSION: 'IMAGE', BITPIX: bitpix, NAXIS: 2, NAXIS1: width, NAXIS2: height, PCOUNT: 0, GCOUNT: 1, EXTNAME: 'IMAGE', BSCALE: 2, BZERO: 3, DETECTOR: 1, OBSID: 'fixture', BUNIT: 'MJy/sr', ...wcs });
  let flagsHeader, flags;
  if (compressed) {
    const descriptors = Buffer.alloc(height * 8), heap = Buffer.concat(Array.from({ length: height }, () => compressed));
    for (let y = 0; y < height; y++) { descriptors.writeInt32BE(compressed.length, y * 8); descriptors.writeInt32BE(y * compressed.length, y * 8 + 4); }
    flags = Buffer.concat([descriptors, heap]);
    flagsHeader = header({ XTENSION: 'BINTABLE', BITPIX: 8, NAXIS: 2, NAXIS1: 8, NAXIS2: height, PCOUNT: heap.length, GCOUNT: 1, TFIELDS: 1, TFORM1: '1PB', EXTNAME: 'FLAGS', ZIMAGE: true, ZBITPIX: 32, ZNAXIS: 2, ZNAXIS1: width, ZNAXIS2: height, ZTILE1: width, ZTILE2: 1, ZCMPTYPE: 'RICE_1', ZNAME1: 'BLOCKSIZE', ZVAL1: 32 });
  } else {
    flags = Buffer.alloc(width * height * 4);
    flags.writeUInt32BE(1 << 9, (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4);
    flagsHeader = header({ XTENSION: 'IMAGE', BITPIX: 32, NAXIS: 2, NAXIS1: width, NAXIS2: height, PCOUNT: 0, GCOUNT: 1, EXTNAME: 'FLAGS' });
  }
  return Buffer.concat([header({ SIMPLE: true, BITPIX: 8, NAXIS: 0, EXTEND: true }), imageHeader, pad(science), flagsHeader, pad(flags), Buffer.alloc(34560)]);
}
