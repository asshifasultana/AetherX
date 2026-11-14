// Turns catalog parallax or redshift into a short, honest distance phrase.
export const LIGHT_YEARS_PER_PARSEC = 3.26156;
const C_KM_S = 299792.458, H0 = 70; // km/s/Mpc; a Hubble-law estimate only

const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const sig3 = value => {
  const digits = Math.max(0, 2 - Math.floor(Math.log10(value)));
  return Number(value.toPrecision(3)).toLocaleString('en-US', { maximumFractionDigits: digits });
};

/** Distance from us in light-years, with whether it is a rough estimate, or null. */
export function distanceLightYears({ parallaxMas, parallaxErrorMas, redshift } = {}) {
  const plx = numeric(parallaxMas), error = numeric(parallaxErrorMas), z = numeric(redshift);
  // Require a parallax measured to better than about 30 percent.
  if (plx > 0 && (error === null || plx / error >= 3)) return { lightYears: 1000 * LIGHT_YEARS_PER_PARSEC / plx, estimate: false };
  // Beyond the Local Group the Hubble flow dominates; nearer, peculiar motion does.
  if (z !== null && z * C_KM_S >= 1500 && z < 0.1) return { lightYears: (z * C_KM_S / H0) * 1e6 * LIGHT_YEARS_PER_PARSEC, estimate: true };
  return null;
}

/** "8.6 light-years", "642 light-years", "≈ 210 million light-years", or null. */
export function distanceLabel(input) {
  const distance = distanceLightYears(input);
  if (!distance) return null;
  const { lightYears, estimate } = distance, prefix = estimate ? '≈ ' : '';
  if (lightYears >= 1e9) return `${prefix}${sig3(lightYears / 1e9)} billion light-years`;
  if (lightYears >= 1e6) return `${prefix}${sig3(lightYears / 1e6)} million light-years`;
  return `${prefix}${sig3(lightYears)} ${lightYears === 1 ? 'light-year' : 'light-years'}`;
}
