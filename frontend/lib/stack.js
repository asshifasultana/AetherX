function median(values) {
  if (!values.length) return Number.NaN;
  values.sort((a, b) => a - b);
  const middle = values.length >> 1;
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

// Per-pixel median stack. NaN samples represent masked, missing, or uncovered
// pixels and do not dilute the result as zeros would.
export function medianStack(images) {
  if (!images.length || !images[0]?.length || images.some(image => image.length !== images[0].length)) {
    throw new TypeError('A stack requires equal-sized projected images.');
  }
  const length = images[0].length, values = new Float32Array(length), counts = new Uint16Array(length), scratch = [];
  let validPixelContributions = 0, coveredPixels = 0;
  for (let pixel = 0; pixel < length; pixel++) {
    scratch.length = 0;
    for (const image of images) if (Number.isFinite(image[pixel])) scratch.push(image[pixel]);
    counts[pixel] = scratch.length;
    if (scratch.length) {
      values[pixel] = median(scratch);
      validPixelContributions += scratch.length;
      coveredPixels++;
    } else values[pixel] = Number.NaN;
  }
  return { values, counts, validPixelContributions, coveredPixels, totalPixels: length };
}
