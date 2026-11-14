// Lazy Aladin Lite context panels. The dated SPHEREx FITS viewer remains the
// primary view; Aladin supplies wider, pre-built multi-epoch survey context.
const panels = [
  { details: document.querySelector('#aladin-context'), map: document.querySelector('#aladin-context-map'), status: document.querySelector('#aladin-context-status'), fov: 8 },
  { details: document.querySelector('#planetx-aladin-context'), map: document.querySelector('#planetx-aladin-map'), status: document.querySelector('#planetx-aladin-status'), fov: 8 }
].filter(panel => panel.details && panel.map && panel.status);
let target = { raDeg: 269.4521, decDeg: 4.6934 };
let loadPromise;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src; script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { script.remove(); reject(new Error(`Aladin Lite could not be loaded from ${src}`)); };
    document.head.append(script);
  });
}
async function loadAladin() {
  if (window.A?.aladin) return;
  if (!loadPromise) loadPromise = (async () => {
    try { await loadScript('https://aladin.u-strasbg.fr/AladinLite/api/v3/latest/aladin.js'); }
    catch { await loadScript('https://aladin.cds.unistra.fr/aladin_3.9.0-beta.js'); }
    if (!window.A?.init) throw new Error('Aladin Lite did not initialize.');
    await window.A.init;
  })().catch(error => {
    loadPromise = undefined;
    throw error;
  });
  return loadPromise;
}
function setTarget(raDeg, decDeg) {
  if (!Number.isFinite(Number(raDeg)) || !Number.isFinite(Number(decDeg))) return;
  target = { raDeg: Number(raDeg), decDeg: Number(decDeg) };
  for (const panel of panels) if (panel.aladin) panel.aladin.gotoRaDec(target.raDeg, target.decDeg);
}
async function openPanel(panel) {
  if (panel.aladin || panel.loading) return;
  panel.loading = true;
  panel.status.textContent = 'Loading Aladin Lite and survey tiles…';
  try {
    await loadAladin();
    panel.aladin = window.A.aladin(`#${panel.map.id}`, {
      // Use ESA's mirror directly: the CDS registry currently resolves DSS2
      // to an unavailable host, leaving the viewer stuck on "loading".
      survey: 'https://skies.esac.esa.int/DSSColor', target: `${target.raDeg} ${target.decDeg}`,
      fov: panel.fov, cooFrame: 'ICRS', showLayersControl: true,
      showCooGridControl: true, showReticle: true
    });
    panel.status.textContent = 'Survey maps are assembled from observations taken on different dates. Use the layer control to switch surveys.';
  } catch (error) {
    panel.status.replaceChildren(document.createTextNode('The embedded map could not load. Survey services may be unavailable. '));
    const link = document.createElement('a');
    link.href = `https://aladin.cds.unistra.fr/AladinLite/?target=${encodeURIComponent(`${target.raDeg} ${target.decDeg}`)}&fov=${panel.fov}&survey=P%2FDSS2%2Fcolor`;
    link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open Aladin Lite in a new tab ↗';
    panel.status.append(link);
  } finally { panel.loading = false; }
}
for (const panel of panels) panel.details.addEventListener('toggle', () => { if (panel.details.open) void openPanel(panel); });
window.addEventListener('sky:target-selected', event => setTarget(event.detail?.raDeg, event.detail?.decDeg));
window.addEventListener('sky:viewer-settings-changed', event => {
  const fovArcmin = Number(event.detail?.fovArcmin);
  if (Number.isFinite(fovArcmin)) for (const panel of panels) panel.aladin?.setFoV(Math.max(1, fovArcmin / 60));
});
window.addEventListener('sky:planetx-region-selected', event => {
  const { raDeg, decDeg } = event.detail || {};
  setTarget(raDeg, decDeg);
  const panel = panels.find(item => item.details.id === 'planetx-aladin-context');
  if (panel) { panel.details.open = true; void openPanel(panel); }
});
