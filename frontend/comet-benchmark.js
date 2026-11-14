const status = document.querySelector('#comet-benchmark-status');
const canvas = document.querySelector('#comet-benchmark-canvas');
const selector = document.querySelector('#comet-benchmark-stage');

async function showBenchmark() {
  const response = await fetch(new URL('./comet-benchmark.json', import.meta.url));
  if (!response.ok) throw new Error('Benchmark data unavailable.');
  const { size, pixelArcsec, apertureRadiusPixels, wavelengthRange, outerRecovery, stages, exposures } = await response.json();
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  const pixels = context.createImageData(size, size);
  const magnitudes = stages.flatMap(stage => stage.values.filter(Number.isFinite).map(Math.abs)).sort((a, b) => a - b);
  const limit = magnitudes[Math.floor(0.99 * (magnitudes.length - 1))];
  const scale = limit / 8;

  function render() {
    const index = Number(selector.value);
    const { values, apertureContrast, apertureSkyScatter } = stages[index];
    values.forEach((value, i) => {
      const normalized = Number.isFinite(value) ? Math.asinh(value / scale) / Math.asinh(8) : -1;
      const shade = Math.round(255 * Math.max(0, Math.min(1, 0.2 + 0.8 * normalized)));
      pixels.data.set([shade, shade, shade, 255], 4 * i);
    });
    context.putImageData(pixels, 0, 0);
    canvas.setAttribute('aria-label', `Comet 3I/ATLAS, ${selector.selectedOptions[0].textContent}. North is up.`);
    document.querySelector('#comet-score-label').textContent = index === 1 ? 'Best measured aperture contrast' : 'Aperture contrast';
    document.querySelector('#comet-score').textContent = apertureContrast.toFixed(2);
    document.querySelector('#comet-scatter').textContent = apertureSkyScatter.toFixed(4);
  }

  const aperture = document.querySelector('#comet-aperture');
  aperture.style.width = `${200 * apertureRadiusPixels / size}%`;
  const references = exposures.filter(exposure => exposure.centralReferenceCount >= 2).length;
  document.querySelector('#comet-benchmark-method').textContent =
    `D1 · ${wavelengthRange.map(value => value.toFixed(3)).join('–')} µm. Contrast uses a ${apertureRadiusPixels}-pixel (${pixelArcsec}″) radius and ${stages[1].controlApertures} offset apertures. The weighted stack subtracted sky at the central pixel in ${references} of ${exposures.length} exposures and recovered ${(100 * outerRecovery.fraction).toFixed(1)}% of the injected diffuse outer coma.`;
  const rows = exposures.map(exposure => {
    const row = document.createElement('li');
    const link = document.createElement('a');
    link.href = exposure.url;
    link.textContent = new URL(exposure.url).pathname.split('/').at(-1);
    row.append(`${exposure.observedStartUtc} · ${exposure.wavelength.toFixed(3)} µm · `, link);
    return row;
  });
  document.querySelector('#comet-exposures').replaceChildren(...rows);
  selector.addEventListener('change', render);
  render();
  document.querySelector('#comet-benchmark-controls').hidden = false;
  document.querySelector('#comet-benchmark-figure').hidden = false;
  status.textContent = '';
}

showBenchmark().catch(() => {
  status.textContent = 'The saved comet benchmark could not be loaded. Reload the page to try again.';
});
