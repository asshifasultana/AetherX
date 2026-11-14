// Shared registration prevents local/Vercel asset lists from drifting.
export const CONTEXT_PUBLIC_FILES = ['context-assets.js','sky-context.js','sky-context-core.js','gaia-core.js','gaia-overlay.js','display-grid.js','star-details.js',
  'cultural-sky.json','cultural-sources.json',
  ...['hawaiian_starlines','indian'].flatMap(culture=>['index.json','description.md'].map(file=>`cultural-sources/${culture}/${file}`))];
