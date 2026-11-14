// Names and aliases only: every selection still requires live catalog resolution.
export const objectNames = [
  { name: 'Barnard’s Star', query: 'Barnard star', aliases: ['Barnards Star', 'GJ 699', 'HIP 87937'] },
  { name: 'Epsilon Indi B', query: 'eps Ind B', aliases: ['Epsilon Indi B', 'eps Indi B'] },
  { name: 'WISE 0855', query: 'WISE J085510.83-071442.5', aliases: ['WISE 0855', 'WISE 085510.83-071442.5'] },
  { name: 'RW Aurigae', query: 'RW Aur', aliases: ['RW Aurigae'] },
  { name: 'R Draconis', query: 'R Dra', aliases: ['R Draconis'] },
  { name: 'Sirius', query: 'Sirius', aliases: ['Alpha Canis Majoris', 'HD 48915'] },
  { name: 'Vega', query: 'Vega', aliases: ['Alpha Lyrae', 'HD 172167'] },
  { name: 'Polaris', query: 'Polaris', aliases: ['Alpha Ursae Minoris', 'HD 8890'] },
  { name: 'Betelgeuse', query: 'Betelgeuse', aliases: ['Alpha Orionis', 'HD 39801'] },
  { name: 'Rigel', query: 'Rigel', aliases: ['Beta Orionis', 'HD 34085'] },
  { name: 'Proxima Centauri', query: 'Proxima Cen', aliases: ['Proxima Centauri', 'GJ 551'] },
  { name: 'Alpha Centauri', query: 'Alpha Cen', aliases: ['Alpha Centauri', 'Rigil Kentaurus'] },
  { name: 'Arcturus', query: 'Arcturus', aliases: ['Alpha Bootis', 'HD 124897'] },
  { name: 'Altair', query: 'Altair', aliases: ['Alpha Aquilae', 'HD 187642'] },
  { name: 'Deneb', query: 'Deneb', aliases: ['Alpha Cygni', 'HD 197345'] },
  { name: 'Andromeda Galaxy', query: 'M 31', aliases: ['Andromeda', 'M31', 'NGC 224'] },
  { name: 'Orion Nebula', query: 'M 42', aliases: ['M42', 'NGC 1976'] },
  { name: 'Pleiades', query: 'M 45', aliases: ['M45', 'Melotte 22'] },
  { name: 'Crab Nebula', query: 'M 1', aliases: ['M1', 'NGC 1952'] },
  { name: 'Whirlpool Galaxy', query: 'M 51', aliases: ['M51', 'NGC 5194'] }
];
export const normalizeName = name => name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
function distance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i), beforePrevious;
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], beforePrevious[j - 2] + 1);
    }
    beforePrevious = previous; previous = row;
  }
  return previous[b.length];
}
export function suggestNames(input, names = objectNames) {
  const normalized = normalizeName(input);
  if (normalized.length < 3) return [];
  const threshold = normalized.length <= 7 ? 1 : 2;
  const seen = new Set();
  return names.map(object => ({ object, score: Math.min(...[object.name, object.query, ...object.aliases].map(alias => distance(normalized, normalizeName(alias)))) }))
    .filter(item => item.score <= threshold).sort((a, b) => a.score - b.score || a.object.name.localeCompare(b.object.name))
    .filter(({ object }) => { if (seen.has(object.query)) return false; seen.add(object.query); return true; }).slice(0, 3).map(item => item.object);
}
