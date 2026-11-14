import { readFile } from 'node:fs/promises';
import { createFitsRangeLoader } from '../frontend/lib/range-fits.js';
import { exposureTiming, positionAt } from '../frontend/lib/moving-stack.js';
import { fitNativeSequence, loadCometEpsf, nativeTemplates, nuisanceTemplates } from '../frontend/lib/comet-native-fit.js';
import { injectProfile, offsetTarget } from '../frontend/lib/comet-profile.js';
import { createSpectralMapReader, loadD5ResponseCurves, makeLineResponse } from '../frontend/lib/comet-spectral-fit.js';

const settings = { fovArcmin: 49 * 6.15 / 60, hideBadPixels: true, includeVariance: true };
const load = createFitsRangeLoader();
const median = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[sorted.length >> 1] + sorted[(sorted.length - 1) >> 1]) / 2;
};

function apertureCoefficients(image, template, inner = 0, outer = 2) {
  const sums = [0, 0];
  for (let i = 0; i < image.values.length; i++) {
    const distance = Math.hypot(i % image.width - template.x, Math.floor(i / image.width) - template.y);
    if (distance < inner || distance > outer) continue;
    sums[0] += template.core[i];
    sums[1] += template.coma[i];
  }
  return sums;
}

function setup(frames, east = 0, north = 0, shape) {
  return frames.map(({ image, target, epsf }) => {
    const offset = offsetTarget(target, east, north);
    const template = nativeTemplates(image, offset, epsf, shape);
    return { image, signal: [template.core, template.coma], nuisance: nuisanceTemplates(image, offset, epsf),
      aperture: apertureCoefficients(image, template), template };
  });
}

function apertureFit(frames) {
  const { coefficients, covariance } = fitNativeSequence(frames);
  const aperture = coefficients.map((_, j) => frames.reduce((sum, f) => sum + f.aperture[j], 0) / frames.length);
  const signal = coefficients.reduce((sum, value, j) => sum + value * aperture[j], 0);
  const variance = covariance.reduce((sum, row, j) => sum + row.reduce((s, value, k) => s + value * aperture[j] * aperture[k], 0), 0);
  return { signal, nominalSigma: Math.sqrt(variance), coefficients };
}

function measureNative(frames) {
  const shape = { radius: 20, scale: 4 };
  const central = setup(frames, 0, 0, shape);
  const real = apertureFit(central);
  const controls = [];
  for (let north = 18; north >= -18; north -= 5) for (let east = 18; east >= -18; east -= 5) {
    if (Math.hypot(east, north) < 8 || Math.hypot(east, north) > 19) continue;
    try { controls.push(apertureFit(setup(frames, east, north, shape)).signal); }
    catch (error) { if (!/Degenerate|Insufficient/.test(error.message)) throw error; }
  }
  const sky = median(controls), scatter = 1.4826 * median(controls.map(value => Math.abs(value - sky)));
  const injections = [
    { name: 'same diffuse injection as stack benchmark', shape: { radius: 20, scale: 4, east: 0.35, north: -0.25, amplitude: 0.4 } },
    { name: 'ePSF-convolved model check', amplitude: 0.4 }
  ];
  const recovery = injections.map(({ name, shape: profile, amplitude }) => {
    const truth = central.map((frame, index) => {
      if (!profile) return frame.signal[1].map(value => value * amplitude);
      const zero = { ...frame.image, values: new Float32Array(frame.image.values.length) };
      return injectProfile(zero, frames[index].target, profile).values;
    });
    const simulated = central.map((frame, index) => {
      const image = { ...frame.image, values: frame.image.values.map((value, i) => value + truth[index][i]) };
      return { ...frame, image };
    });
    const delta = fitNativeSequence(simulated).coefficients.map((value, i) => value - real.coefficients[i]);
    const recover = (inner, outer) => {
      let expected = 0, predicted = 0;
      for (const [j, frame] of central.entries()) {
        predicted += apertureCoefficients(frame.image, frame.template, inner, outer).reduce((sum, v, i) => sum + v * delta[i], 0);
        for (let i = 0; i < frame.image.values.length; i++) {
          const r = Math.hypot(i % frame.image.width - frame.template.x, Math.floor(i / frame.image.width) - frame.template.y);
          if (r >= inner && r <= outer) expected += truth[j][i];
        }
      }
      return predicted / expected;
    };
    return { name, coreRecovery: recover(0, 2), outerComaRecovery: recover(9, 15) };
  });
  return { ...real, apertureContrast: (real.signal - sky) / scatter, controlApertures: controls.length,
    controlsAtOrAboveTarget: controls.filter(value => value >= real.signal).length, scatter, recovery };
}

async function prepare(exposures, ephemeris, grid = settings) {
  const frames = [];
  for (let start = 0; start < exposures.length; start += 4) {
    const batch = await Promise.all(exposures.slice(start, start + 4).map(async exposure => {
      try {
        const first = exposure.target ?? positionAt(ephemeris, exposure.mjd);
        let image = await load(exposure.url, first, grid);
        const target = exposure.target ?? positionAt(ephemeris, exposureTiming(image.header, exposure).midpoint);
        if (first.raDeg !== target.raDeg || first.decDeg !== target.decDeg) image = await load(exposure.url, target, grid);
        return { exposure, target, image, epsf: await loadCometEpsf(exposure.detector) };
      } catch (error) {
        throw new Error(`Could not prepare ${exposure.url}`, { cause: error });
      }
    }));
    frames.push(...batch);
  }
  return frames;
}

async function officialSpectralCases() {
  const root = 'https://irsa.ipac.caltech.edu/data/SPHEREx/docs/comet3iatlas/';
  const [votable, downloadList] = await Promise.all(['obscore_3I_Atlas.vot', '3IATLASImages-curl.sh'].map(async file => {
    const response = await fetch(root + file, { signal: AbortSignal.timeout(60000) }).catch(error => {
      throw new Error(`Could not read IRSA comet catalog file ${file}`, { cause: error });
    });
    if (!response.ok) throw new Error(`IRSA comet catalog HTTP ${response.status}`);
    return response.text();
  }));
  const urls = new Map([...downloadList.matchAll(/'(https:\/\/irsa\.ipac\.caltech\.edu\/[^']+\/level2_([^/']+?)_spx_[^']+\.fits)'/g)]
    .map(match => [match[2], match[1]]));
  const ids = [
    ['2025W33_1B_0599_1D5', '2025W32_2D_0189_4D5', '2025W31_2A_0219_3D5', '2025W33_1B_0399_1D5', '2025W32_2D_0201_1D5'],
    ['2025W50_2A_0712_1D5', '2025W50_2A_0712_2D5', '2025W50_2A_0698_4D5', '2025W50_2A_0712_3D5', '2025W50_2A_0698_3D5']
  ];
  const rows = new Map([...votable.matchAll(/<TR>([\s\S]*?)<\/TR>/g)].map(match => {
    const cells = [...match[1].matchAll(/<TD>(.*?)<\/TD>/g)].map(cell => cell[1]);
    return [cells[5], cells];
  }));
  return ids.map((campaign, i) => ({
    name: i ? 'December 2025 D5' : 'August 2025 D5',
    exposures: campaign.map(id => {
      const row = rows.get(id), url = urls.get(id);
      if (!row || !url) throw new Error(`Missing catalog entry for ${id}.`);
      return { id, url, detector: 5, mjd: Number(row[10]), target: { raDeg: Number(row[8]), decDeg: Number(row[9]) } };
    })
  }));
}

async function measureSpectral(exposures, curves) {
  const frames = await prepare(exposures, null, { ...settings, fovArcmin: 81 * 6.15 / 60 });
  const spectralMaps = createSpectralMapReader();
  const response = makeLineResponse(curves);
  const broaderResponse = makeLineResponse(curves, 4.26, 0.011);
  const maps = await Promise.all(frames.map(async frame => {
    const { center, bandwidth } = await spectralMaps(frame.image, frame.exposure.detector);
    const weights = center.map((value, i) => response(value, bandwidth[i]));
    const alternate = center.map((value, i) => broaderResponse(value, bandwidth[i]));
    return { weights, alternate };
  }));
  const model = (east, north, key = 'weights') => frames.map(({ image, target, epsf }, i) => {
    const offset = offsetTarget(target, east, north);
    const template = nativeTemplates(image, offset, epsf, { radius: 29, scale: 5 });
    const line = template.coma.map((value, j) => value * maps[i][key][j]);
    return { image, signal: [template.core, template.coma, line], nuisance: nuisanceTemplates(image, offset, epsf, undefined, 12) };
  });
  const central = model(0, 0);
  const result = fitNativeSequence(central);
  const controls = [];
  for (let north = -25; north <= 25; north += 10) for (let east = -25; east <= 25; east += 10) {
    if (Math.hypot(east, north) < 14 || Math.hypot(east, north) > 29) continue;
    controls.push(fitNativeSequence(model(east, north)).coefficients[2]);
  }
  const sky = median(controls), scatter = 1.4826 * median(controls.map(value => Math.abs(value - sky)));
  const inject = (injected, lineAmplitude) => fitNativeSequence(central.map((frame, i) => ({
    ...frame, image: { ...frame.image, values: frame.image.values.map((value, j) =>
      value + 0.2 * frame.signal[1][j] + lineAmplitude * injected[i].signal[2][j]) }
  }))).coefficients[2] - result.coefficients[2];
  return { coefficients: result.coefficients, lineContrast: (result.coefficients[2] - sky) / scatter,
    controlTracks: controls.length, lineScatter: scatter, nominalLineSigma: Math.sqrt(result.covariance[2][2]),
    sameTemplateRecovery: inject(central, 0.6) / 0.6,
    broaderLineRecovery: inject(model(0, 0, 'alternate'), 0.6) / 0.6,
    continuumOnlyLineLeak: inject(central, 0),
    files: exposures.map(exposure => exposure.id) };
}

const [path] = process.argv.slice(2);
if (!path) throw new Error('Usage: node scripts/benchmark-comet-fit.mjs manifest.json | --official-co2');
if (path === '--official-co2') {
  const [cases, curves] = await Promise.all([officialSpectralCases(), loadD5ResponseCurves().catch(error => {
    throw new Error('Could not read the pinned D5 transmission curves.', { cause: error });
  })]);
  for (const entry of cases) {
    console.log(JSON.stringify({ case: entry.name, stage: 'response-weighted CO₂ and continuum fit',
      exposures: entry.exposures.length, ...await measureSpectral(entry.exposures, curves) }));
  }
} else {
  const input = JSON.parse(await readFile(path, 'utf8'));
  const manifest = input.manifest ?? input;
  for (const entry of manifest.cases) {
    if (!entry.exposures.length) continue;
    const frames = await prepare(entry.exposures, manifest.ephemeris);
    console.log(JSON.stringify({ case: entry.name, stage: 'native-ePSF-fit', exposures: frames.length, ...measureNative(frames) }));
  }
}
