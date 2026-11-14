const panel = document.getElementById('cultural-context');
const section = document.getElementById('star-profile');
const card = document.getElementById('star-profile-card');
const status = document.getElementById('star-profile-status');
const retry = document.getElementById('star-profile-retry');
let selection, request, loaded = false;

function node(tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

function render(profile) {
  const { starTarget: target, raDeg, decDeg } = selection;
  card.replaceChildren(node('h4', profile?.name || target.label), node('p', profile?.description || target.description));
  const fields = node('dl', '');
  for (const [label, value] of [
    [target.name ? 'Catalog designation' : 'Object type', target.name || target.type],
    ['ICRS position', `${raDeg.toFixed(4)}°, ${decDeg.toFixed(4)}°`],
    ['Name origin', profile?.nameOrigin],
    ['Discovered by', profile?.discoverer || 'No verified record available'],
    ['Discovery date', profile?.discoveryDate],
    ['How it was discovered', profile?.discoveryMethod || 'No verified record available'],
    ['History', profile?.history]
  ]) {
    if (value) fields.append(node('dt', label), node('dd', value));
  }
  card.append(fields);
  const sources = node('details', '');
  sources.append(node('summary', 'Sources'));
  const references = node('p', 'Discovery sources');
  for (const source of profile?.discoverySources ?? []) {
    if (!source?.url?.startsWith('https://')) continue;
    const link = node('a', source.title);
    link.href = source.url;
    references.append(document.createTextNode(' · '), link);
  }
  if (references.childElementCount) sources.append(references);
  const source = profile?.source;
  const wikipedia = source?.url?.startsWith('https://en.wikipedia.org/wiki/');
  if (wikipedia || source?.url?.startsWith('https://www.aavso.org/')) {
    const credits = node('p', wikipedia ? 'Adapted from Wikipedia contributors · ' : 'Source · ');
    const article = node('a', source.title);
    article.href = source.url;
    credits.append(article);
    if (wikipedia) {
      const license = node('a', 'CC BY-SA 4.0');
      license.href = 'https://creativecommons.org/licenses/by-sa/4.0/';
      credits.append(document.createTextNode(' · '), license);
    }
    if (wikipedia && Number.isInteger(source.revision)) {
      const revision = node('a', 'Revision');
      revision.href = 'https://en.wikipedia.org/w/index.php?oldid=' + source.revision;
      credits.append(document.createTextNode(' · '), revision);
    }
    sources.append(credits);
  }
  if (sources.childElementCount > 1) card.append(sources);
}

async function load() {
  if (!panel.open || panel.hidden || !selection?.starTarget || request || loaded) return;
  const controller = new AbortController();
  request = controller;
  const { preset, name } = selection.starTarget;
  status.textContent = 'Loading star profile…';
  retry.hidden = true;
  try {
    const query = new URLSearchParams(preset ? { preset } : { name });
    const response = await fetch('/api/star-details?' + query, { signal: controller.signal });
    if (!response.ok) throw new Error();
    const { profile } = await response.json();
    if (request !== controller) return;
    render(profile);
    status.textContent = profile ? '' : 'No Wikipedia profile is available for this target.';
    loaded = true;
  } catch {
    if (request !== controller) return;
    status.textContent = 'The star profile is temporarily unavailable.';
    retry.hidden = false;
  } finally {
    if (request === controller) request = null;
  }
}

window.addEventListener('sky:target-selected', event => {
  request?.abort();
  request = null;
  loaded = false;
  selection = event.detail;
  section.hidden = !selection.starTarget;
  retry.hidden = true;
  status.textContent = '';
  if (section.hidden) card.replaceChildren();
  else render(null);
  void load();
});
panel.addEventListener('toggle', load);
retry.addEventListener('click', load);
window.addEventListener('sky:entry-mode-changed', load);
window.addEventListener('sky:search-entry', load);
