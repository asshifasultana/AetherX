// Timing is kept separate from DOM placement so delayed help can be tested
// deterministically without real-time sleeps.
export function createHelpController({ show, hide, schedule = setTimeout, cancel = clearTimeout }) {
  let timer, visible = false;
  function dismiss() { cancel(timer); timer = undefined; visible = false; hide(); }
  function reveal(item) { cancel(timer); timer = undefined; visible = true; show(item); }
  return {
    hover(item) { cancel(timer); timer = schedule(() => reveal(item), 1000); },
    focus: reveal,
    dismiss,
    get visible() { return visible; }
  };
}

export function mountWorkspace() {
  const $ = id => document.getElementById(id);
  const workspace = $('workspace'), sidebar = $('workspace-sidebar'), content = $('sidebar-content');
  const header = document.querySelector('.viewer-header');
  const sizeHeader = () => document.documentElement.style.setProperty('--workspace-header-height', header.getBoundingClientRect().height + 'px');
  sizeHeader();
  new ResizeObserver(sizeHeader).observe(header);
  const toolbar = document.querySelector('.viewer-toolbar');
  if (toolbar) {
    const sizeToolbar = () => document.documentElement.style.setProperty('--viewer-toolbar-height', toolbar.getBoundingClientRect().height + 'px');
    sizeToolbar();
    new ResizeObserver(sizeToolbar).observe(toolbar);
  }
  const mobile = window.matchMedia('(max-width: 900px)');
  const toggles = [$('sidebar-toggle'), $('sidebar-rail-toggle'), $('sidebar-collapse')];
  let open = !mobile.matches, returnFocus = $('sidebar-toggle');
  function setOpen(next, { focus = false, trigger } = {}) {
    open = next;
    if (trigger && open) returnFocus = trigger;
    workspace.dataset.sidebarOpen = String(open);
    content.hidden = !open;
    sidebar.inert = mobile.matches && !open;
    $('sidebar-rail-toggle').hidden = open || mobile.matches;
    $('sidebar-backdrop').hidden = !mobile.matches || !open;
    if (mobile.matches && open) { sidebar.setAttribute('role', 'dialog'); sidebar.setAttribute('aria-modal', 'true'); }
    else { sidebar.removeAttribute('role'); sidebar.removeAttribute('aria-modal'); }
    for (const toggle of toggles) toggle.setAttribute('aria-expanded', String(open));
    $('sidebar-toggle').setAttribute('aria-label', open ? 'Close settings sidebar' : 'Open settings sidebar');
    if (focus) {
      if (open) $('sidebar-collapse').focus();
      else (mobile.matches ? returnFocus : $('sidebar-rail-toggle')).focus();
    }
  }
  for (const toggle of toggles) toggle.addEventListener('click', () => setOpen(!open, { focus: true, trigger: toggle }));
  $('sidebar-backdrop').addEventListener('click', () => setOpen(false, { focus: true }));
  mobile.addEventListener('change', () => { help.dismiss(); setOpen(!mobile.matches); });

  const tooltip = $('settings-tooltip');
  let active;
  const help = createHelpController({
    show(item) {
      if (active && active !== item) {
        active.querySelector('.setting-help').setAttribute('aria-expanded', 'false');
        active.querySelector('input').removeAttribute('aria-describedby');
      }
      active = item;
      tooltip.textContent = item.dataset.tooltip;
      tooltip.hidden = false;
      item.querySelector('.setting-help').setAttribute('aria-expanded', 'true');
      item.querySelector('input').setAttribute('aria-describedby', 'settings-tooltip');
      const rect = item.getBoundingClientRect(), width = Math.min(280, window.innerWidth - 24);
      tooltip.style.width = width + 'px';
      tooltip.style.left = Math.max(12, Math.min(rect.right + 12, window.innerWidth - width - 12)) + 'px';
      tooltip.style.top = Math.max(12, Math.min(rect.top, window.innerHeight - tooltip.offsetHeight - 12)) + 'px';
    },
    hide() {
      tooltip.hidden = true;
      if (active) {
        active.querySelector('.setting-help').setAttribute('aria-expanded', 'false');
        active.querySelector('input').removeAttribute('aria-describedby');
      }
      active = null;
    }
  });
  for (const item of document.querySelectorAll('.setting-check')) {
    item.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') help.hover(item); });
    item.addEventListener('pointerleave', help.dismiss);
    item.addEventListener('focusin', () => help.focus(item));
    item.addEventListener('focusout', event => { if (!item.contains(event.relatedTarget)) help.dismiss(); });
    item.querySelector('.setting-help').addEventListener('click', () => help.focus(item));
  }
  sidebar.addEventListener('scroll', help.dismiss);
  document.addEventListener('pointerdown', event => { if (active && !active.contains(event.target)) help.dismiss(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (help.visible) { help.dismiss(); event.preventDefault(); return; }
      if (mobile.matches && open) { setOpen(false, { focus: true }); event.preventDefault(); }
    }
    if (event.key !== 'Tab' || !mobile.matches || !open) return;
    const controls = [...content.querySelectorAll('button, input, select, summary, a[href]')].filter(element => element.getClientRects().length && !element.disabled);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
    else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
  });
  for (const toggle of toggles) toggle.addEventListener('click', help.dismiss);
  setOpen(open);
}

if (typeof document !== 'undefined') mountWorkspace();
