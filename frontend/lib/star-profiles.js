export function starAlias(name) {
  const compact = name.normalize('NFKC').replace(/[’‘]/g, "'").replace(/−/g, '-').trim().replace(/\s+/g, ' ');
  // Uppercase variable-star designations such as NU Orionis differ from Bayer names such as Nu Orionis.
  const variable = /^(NU|MU|PI|XI) (?=[a-z])/i.exec(compact)?.[1];
  return variable && variable === variable.toUpperCase()
    ? variable + compact.slice(variable.length).toLowerCase()
    : compact.toLowerCase();
}

// Reviewed fallback profiles also serve as the batch import manifest.
export const starProfiles = [
  {
    id: 'barnard', name: 'Barnard’s Star', aliases: ["Barnard's Star", 'GJ 699', 'HIP 87937', 'V2500 Oph', 'V* V2500 Oph'],
    article: "Barnard's Star", description: 'A faint red dwarf about six light-years away in Ophiuchus, with exceptionally fast apparent motion across the sky.',
    nameOrigin: 'Named for Edward Emerson Barnard.',
    discoverer: 'Edward Emerson Barnard (identified its rapid motion)', discoveryDate: '1916',
    discoveryMethod: 'Barnard compared the star’s position on photographs taken years apart and measured a shift of about 10 arcseconds per year.',
    discoverySources: [{ title: 'Barnard’s 1916 report', url: 'https://doi.org/10.1086/104156' }]
  },
  {
    id: 'epsilon', name: 'Epsilon Indi B', aliases: ['Epsilon Indi B', 'Epsilon Indi Bab', 'eps Ind B', '* eps Ind B'],
    article: 'Epsilon Indi', component: true,
    description: 'A pair of T-type brown dwarfs, Epsilon Indi Ba and Bb, in a wide orbit around Epsilon Indi A.',
    discoverer: 'Ralf-Dieter Scholz and colleagues (Epsilon Indi B), Mark McCaughrean and colleagues (resolved Ba and Bb)',
    discoveryDate: '2003',
    discoveryMethod: 'The first team found a fast-moving object in sky survey images and classified it using infrared observations. The second team used adaptive optics on the Very Large Telescope to see that it was two brown dwarfs.',
    discoverySources: [
      { title: 'Discovery report', url: 'https://arxiv.org/abs/astro-ph/0212487' },
      { title: 'Binary identification', url: 'https://arxiv.org/abs/astro-ph/0309256' }
    ]
  },
  {
    id: 'wise', name: 'WISE 0855', aliases: ['WISE 0855', 'WISE 0855−0714', 'WISE 0855-0714', 'WISE J085510.83-071442.5', 'WISEA J085510.74-071442.5'],
    article: 'WISE 0855−0714', description: 'A very cold brown dwarf in Hydra and one of the closest known objects outside the Solar System.',
    discoverer: 'Kevin Luhman', discoveryDate: 'March 2013',
    discoveryMethod: 'Luhman spotted the object shifting between WISE infrared images. Follow-up observations with Spitzer confirmed its rapid motion and measured its parallax.',
    discoverySources: [{ title: 'Luhman’s discovery paper', url: 'https://doi.org/10.1088/2041-8205/786/2/L18' }],
    history: 'The discovery was announced in April 2014.'
  },
  {
    id: 'aurigae', name: 'RW Aurigae', aliases: ['RW Aurigae', 'RW Aur', 'V* RW Aur'],
    article: 'RW Aurigae', description: 'A young binary system in Auriga. Its primary is a T Tauri star surrounded by a disk.',
    discoverer: 'Lidiya Ceraski (identified its variability)', discoveryDate: '1906',
    discoveryMethod: 'Ceraski noticed irregular changes in the star’s brightness on photographic plates from Moscow.',
    discoverySources: [{ title: 'Joy’s account of the early observations', url: 'https://articles.adsabs.harvard.edu/pdf/1945ApJ...102..168J#page=8' }]
  },
  {
    id: 'draconis', name: 'R Draconis', aliases: ['R Draconis', 'R Dra', 'V* R Dra'],
    description: 'A Mira-type variable star in Draco whose brightness changes over a long cycle.',
    source: {
      title: 'AAVSO Eyepiece Views, July 2002',
      url: 'https://www.aavso.org/sites/default/files/newsletter/EPViews/0702.pdf'
    }
  },
  {
    id: 'sirius', name: 'Sirius', aliases: ['Sirius', 'Alpha Canis Majoris', 'alf CMa', '* alf CMa', 'HD 48915', 'HIP 32349'],
    article: 'Sirius', description: 'The brightest star in the night sky, in Canis Major. The system includes a white dwarf companion.',
    nameOrigin: 'From Latin Sīrius, ultimately from the Greek Seirios, meaning glowing or scorching.',
    history: 'Recorded in ancient Greek literature, including the work of Hesiod.'
  },
  {
    id: 'vega', name: 'Vega', aliases: ['Vega', 'Alpha Lyrae', 'alf Lyr', '* alf Lyr', 'HD 172167', 'HIP 91262'],
    article: 'Vega', description: 'A bright, nearby main-sequence star in Lyra and one of the three stars of the Summer Triangle.',
    nameOrigin: 'From an Arabic phrase meaning the falling eagle.'
  },
  {
    id: 'polaris', name: 'Polaris', aliases: ['Polaris', 'Alpha Ursae Minoris', 'alf UMi', '* alf UMi', 'HD 8890', 'HIP 11767'],
    article: 'Polaris', description: 'A multiple star system in Ursa Minor. Its brightest component lies close to the north celestial pole.',
    nameOrigin: 'Shortened from the Neo-Latin stella polaris, meaning polar star.'
  },
  {
    id: 'betelgeuse', name: 'Betelgeuse', aliases: ['Betelgeuse', 'Alpha Orionis', 'alf Ori', '* alf Ori', 'HD 39801', 'HIP 27989'],
    article: 'Betelgeuse', description: 'A red supergiant in Orion whose brightness varies over time.',
    nameOrigin: 'The European name traces back to the Arabic Yad al-Jawzāʾ, the hand of al-Jawzāʾ.'
  },
  {
    id: 'proxima', name: 'Proxima Centauri', aliases: ['Proxima Centauri', 'Alpha Centauri C', 'alf Cen C', '* alf Cen C', 'GJ 551', 'HIP 70890', 'V* V645 Cen'],
    article: 'Proxima Centauri', description: 'A red dwarf in the Alpha Centauri system and the closest star to the Sun.',
    discoverer: 'Robert Innes', discoveryDate: '1915',
    discoveryMethod: 'Innes compared photographic plates and spotted a faint star moving across the sky at nearly the same rate and direction as Alpha Centauri.',
    discoverySources: [{ title: 'Innes’s discovery report', url: 'https://articles.adsabs.harvard.edu/pdf/1915CiUO...30..235I' }]
  }
];

export const starLookupKeys = profile => [...new Set([
  'preset:' + profile.id, ...profile.aliases.map(name => 'name:' + starAlias(name))
])];

export function publicStarProfile({ id, aliases, component, article, source, ...profile }) {
  return {
    ...profile,
    source: source ?? {
      title: article,
      url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(article.replaceAll(' ', '_')),
      license: 'https://creativecommons.org/licenses/by-sa/4.0/'
    }
  };
}
