// Home mega menu: a full-screen launcher with an expandable left sidebar and a
// single content panel on the right.
//
// The panel is a URL hash, so /#planetx and /#explore can be linked to directly
// and the back button works. Nothing here touches the target search: the search
// widget mounts into #target-picker whether or not its panel is the visible one.

const $ = id => document.getElementById(id);
const panels = () => [...document.querySelectorAll('[data-panel-id]')];
const links = () => [...document.querySelectorAll('.mega-link')];

function showPanel(id, { updateHash = true } = {}) {
  const target = panels().find(panel => panel.dataset.panelId === id);
  if (!target) return false;
  for (const panel of panels()) panel.hidden = panel !== target;
  for (const link of links()) {
    const active = link.dataset.panel === id;
    link.classList.toggle('is-active', active);
    link.setAttribute('aria-current', active ? 'page' : 'false');
    if (active) expandGroupOf(link);
  }
  if (updateHash) {
    try { history.replaceState(history.state, '', id === 'planetx' ? location.pathname : `#${id}`); } catch { /* frames may refuse */ }
  }
  target.querySelector('h1')?.focus?.({ preventScroll: true });
  return true;
}

function expandGroupOf(element) {
  const group = element.closest('.mega-group');
  if (group) setGroup(group.dataset.group, true);
}

function setGroup(name, open) {
  const toggle = document.querySelector(`[data-group-toggle="${name}"]`);
  const group = toggle?.closest('.mega-group');
  if (!toggle || !group) return;
  toggle.setAttribute('aria-expanded', String(open));
  group.classList.toggle('is-open', open);
  const list = group.querySelector('.mega-links');
  if (list) list.hidden = !open;
}

function mount() {
  for (const toggle of document.querySelectorAll('[data-group-toggle]')) {
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      setGroup(toggle.dataset.groupToggle, open);
    });
  }
  for (const link of links()) {
    link.addEventListener('click', () => showPanel(link.dataset.panel));
  }
  const initial = (location.hash || '').replace('#', '');
  showPanel(panels().some(panel => panel.dataset.panelId === initial) ? initial : 'planetx', { updateHash: false });
  window.addEventListener('hashchange', () => {
    const id = (location.hash || '').replace('#', '');
    if (panels().some(panel => panel.dataset.panelId === id)) showPanel(id, { updateHash: false });
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
