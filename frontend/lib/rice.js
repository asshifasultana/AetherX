// FITS RICE_1 decoder for 32-bit integer image tiles (CFITSIO convention).
export function decodeRice32(compressed, output, blockSize = 32) {
  const c = compressed instanceof Uint8Array ? compressed : new Uint8Array(compressed);
  if (!(output instanceof Int32Array) || !Number.isInteger(blockSize) || blockSize < 1 || blockSize > 32 || c.length < 5) {
    throw new Error('Invalid RICE_1 tile.');
  }
  const readByte = () => {
    if (position >= c.length) throw new Error('Truncated RICE_1 tile.');
    return c[position++];
  };
  let position = 4;
  let lastPixel = ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | c[3]) | 0;
  let bitBuffer = readByte(), bitsLeft = 8;
  const appendByte = () => { bitBuffer = (bitBuffer << 8) | readByte(); bitsLeft += 8; };
  const fsBits = 5, fsMax = 25;
  for (let i = 0; i < output.length;) {
    bitsLeft -= fsBits;
    while (bitsLeft < 0) appendByte();
    const fs = ((bitBuffer >>> bitsLeft) & 31) - 1;
    bitBuffer &= (1 << bitsLeft) - 1;
    const blockEnd = Math.min(i + blockSize, output.length);
    if (fs < 0) {
      while (i < blockEnd) output[i++] = lastPixel;
      continue;
    }
    while (i < blockEnd) {
      let difference;
      if (fs === fsMax) {
        let shift = 32 - bitsLeft;
        difference = (bitBuffer << shift) >>> 0;
        for (shift -= 8; shift >= 0; shift -= 8) { bitBuffer = readByte(); difference = (difference | (bitBuffer << shift)) >>> 0; }
        if (bitsLeft > 0) { bitBuffer = readByte(); difference = (difference | (bitBuffer >>> -shift)) >>> 0; bitBuffer &= (1 << bitsLeft) - 1; }
        else bitBuffer = 0;
      } else {
        while (bitBuffer === 0) { bitsLeft += 8; bitBuffer = readByte(); }
        const zeros = bitsLeft - (31 - Math.clz32(bitBuffer)) - 1;
        bitsLeft -= zeros + 1;
        bitBuffer ^= 1 << bitsLeft;
        bitsLeft -= fs;
        while (bitsLeft < 0) appendByte();
        difference = ((zeros << fs) | (bitBuffer >>> bitsLeft)) >>> 0;
        bitBuffer &= (1 << bitsLeft) - 1;
      }
      const delta = difference & 1 ? ~(difference >>> 1) : difference >>> 1;
      lastPixel = (delta + lastPixel) | 0;
      output[i++] = lastPixel;
    }
  }
  return output;
}
