export function parseCoordinate(raw, axis, format = 'degrees') {
  const input = raw.trim().replace(/−/g, '-');
  if (!input) throw new Error(`Enter ${axis === 'ra' ? 'right ascension' : 'declination'}.`);
  let result;
  if (format === 'degrees') {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(input)) throw new Error('Enter a valid decimal number.');
    result = Number(input);
  } else {
    const match = input.match(/^([+-]?)(\d{1,3})(?:[:\s]+|[hHdD°]\s*)(\d{1,2})(?:[:\s]+|[mM′']\s*)(\d{1,2}(?:\.\d*)?)(?:[sS″"])?$/);
    if (!match) throw new Error(axis === 'ra' ? 'Use HH:MM:SS, e.g. 08:55:10.831.' : 'Use ±DD:MM:SS, e.g. −07:14:42.53.');
    const [, sign, first, minutes, seconds] = match;
    if (+minutes >= 60 || +seconds >= 60) throw new Error('Minutes and seconds must be less than 60.');
    result = (+first + +minutes / 60 + +seconds / 3600) * (sign === '-' ? -1 : 1) * (axis === 'ra' ? 15 : 1);
  }
  if (!Number.isFinite(result) || (axis === 'ra' ? result < 0 || result >= 360 : result < -90 || result > 90)) throw new Error(axis === 'ra' ? 'RA must be 0° to less than 360° (0–24 hours).' : 'Declination must be −90° to +90°.');
  return result;
}
export function formatSexagesimal(value, axis) {
  const total = Math.round(Math.abs(value) / (axis === 'ra' ? 15 : 1) * 3600000);
  return `${value < 0 || Object.is(value, -0) ? '-' : axis === 'dec' ? '+' : ''}${String(Math.floor(total / 3600000)).padStart(2, '0')}:${String(Math.floor(total % 3600000 / 60000)).padStart(2, '0')}:${(total % 60000 / 1000).toFixed(3).padStart(6, '0')}`;
}
