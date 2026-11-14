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
  // All settings live in the same drawer, including on phones where the
  // modal backdrop prevents interacting with the image workspace.
  const displayPanel = $('display-panel');
  if (displayPanel) content.append(displayPanel);
  const sizeHeader = () => document.documentElement.style.setProperty('--workspace-header-height', header.getBoundingClientRect().height + 'px');
  const playback = document.querySelector('.timeline-panel');
  if (playback) {
    const sizePlayback = () => document.documentElement.style.setProperty('--playback-height', playback.getBoundingClientRect().height + 'px');
    sizePlayback();
    new ResizeObserver(sizePlayback).observe(playback);
  }
  sizeHeader();
  new ResizeObserver(sizeHeader).observe(header);
  const toolbar = document.querySelector('.viewer-toolbar');
  if (toolbar) {
    const sizeToolbar = () => document.documentElement.style.setProperty('--viewer-toolbar-height', toolbar.getBoundingClientRect().height + 'px');
    sizeToolbar();
    new ResizeObserver(sizeToolbar).observe(toolbar);
  }
  const settingsToggles = [$('sidebar-toggle'), $('sidebar-rail-toggle'), $('sidebar-collapse')];
  const agent = $('ai-guide'), agentToggle = $('agent-toggle'), agentClose = $('agent-close');
  const backdrop = $('sidebar-backdrop');
  let settingsOpen = false, agentOpen = false, returnFocus = $('sidebar-toggle');
  // On wide screens the guide is a side panel beside the image, not a modal:
  // visitors keep clicking the image to mark spots while they chat.
  const agentModal = () => !globalThis.matchMedia || globalThis.matchMedia('(max-width: 899px)').matches;
  function renderDrawers({ focus = false } = {}) {
    workspace.dataset.sidebarOpen = String(settingsOpen);
    workspace.dataset.agentOpen = String(agentOpen);
    sidebar.inert = !settingsOpen;
    agent.inert = !agentOpen;
    $('sidebar-rail-toggle').hidden = true;
    sidebar.toggleAttribute('aria-modal', settingsOpen);
    agent.toggleAttribute('aria-modal', agentOpen && agentModal());
    workspace.dataset.agentPanel = String(agentOpen && !agentModal());
    if (settingsOpen) sidebar.setAttribute('role', 'dialog'); else sidebar.removeAttribute('role');
    if (agentOpen) agent.setAttribute('role', 'dialog'); else agent.removeAttribute('role');
    for (const toggle of settingsToggles) toggle.setAttribute('aria-expanded', String(settingsOpen));
    agentToggle.setAttribute('aria-expanded', String(agentOpen));
    $('sidebar-toggle').setAttribute('aria-label', settingsOpen ? 'Close settings' : 'Open settings');
    agentToggle.setAttribute('aria-label', agentOpen ? 'Close AI guide' : 'Open AI guide');
    const anyOpen = settingsOpen || agentOpen;
    backdrop.tabIndex = anyOpen ? 0 : -1;
    backdrop.setAttribute('aria-hidden', String(!anyOpen));
    if (focus) {
      if (settingsOpen) $('sidebar-collapse').focus();
      else if (agentOpen) agentClose.focus();
      else returnFocus.focus();
    }
  }
  function setSettingsOpen(next, options = {}) {
    settingsOpen = next;
    if (next) { agentOpen = false; returnFocus = options.trigger || $('sidebar-toggle'); }
    renderDrawers(options);
  }
  function setAgentOpen(next, options = {}) {
    agentOpen = next;
    if (next) { settingsOpen = false; returnFocus = options.trigger || agentToggle; }
    renderDrawers(options);
  }
  $('sidebar-toggle').addEventListener('click', () => setSettingsOpen(!settingsOpen, { focus: true, trigger: $('sidebar-toggle') }));
  $('sidebar-collapse').addEventListener('click', () => setSettingsOpen(false, { focus: true }));
  agentToggle.addEventListener('click', () => setAgentOpen(!agentOpen, { focus: true, trigger: agentToggle }));
  agentClose.addEventListener('click', () => setAgentOpen(false, { focus: true }));
  window.addEventListener('sky:open-agent', () => { if (!agentOpen) setAgentOpen(true, { trigger: agentToggle }); });
  globalThis.matchMedia?.('(max-width: 899px)').addEventListener?.('change', () => renderDrawers());
  backdrop.addEventListener('click', () => {
    settingsOpen = false; agentOpen = false; renderDrawers({ focus: true });
  });

  const tooltip = $('settings-tooltip');
  let active;
  const help = createHelpController({
    show(item) {
      if (active && active !== item) {
        active.querySelector('.setting-help').setAttribute('aria-expanded', 'false');
        active.querySelector('input, select')?.removeAttribute('aria-describedby');
      }
      active = item;
      tooltip.textContent = item.dataset.tooltip;
      tooltip.hidden = false;
      item.querySelector('.setting-help').setAttribute('aria-expanded', 'true');
      item.querySelector('input, select')?.setAttribute('aria-describedby', 'settings-tooltip');
      const rect = item.getBoundingClientRect(), width = Math.min(280, window.innerWidth - 24);
      tooltip.style.width = width + 'px';
      const fitsRight = rect.right + 12 + width <= window.innerWidth - 12;
      tooltip.style.left = Math.max(12, fitsRight ? rect.right + 12 : rect.left - width - 12) + 'px';
      tooltip.style.top = Math.max(12, Math.min(rect.top, window.innerHeight - tooltip.offsetHeight - 12)) + 'px';
    },
    hide() {
      tooltip.hidden = true;
      if (active) {
        active.querySelector('.setting-help').setAttribute('aria-expanded', 'false');
        active.querySelector('input, select')?.removeAttribute('aria-describedby');
      }
      active = null;
    }
  });
  for (const item of document.querySelectorAll('[data-tooltip]')) {
    if (!item.querySelector('.setting-help')) continue;
    item.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') help.hover(item); });
    item.addEventListener('pointerleave', help.dismiss);
    item.addEventListener('focusin', () => help.focus(item));
    item.addEventListener('focusout', event => { if (!item.contains(event.relatedTarget)) help.dismiss(); });
    item.querySelector('.setting-help').addEventListener('click', () => help.focus(item));
  }
  sidebar.addEventListener('scroll', help.dismiss);
  window.addEventListener('scroll', help.dismiss, { passive: true });
  document.addEventListener('pointerdown', event => { if (active && !active.contains(event.target)) help.dismiss(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (help.visible) { help.dismiss(); event.preventDefault(); return; }
      if (settingsOpen || agentOpen) {
        settingsOpen = false; agentOpen = false; renderDrawers({ focus: true }); event.preventDefault();
      }
    }
    if (event.key !== 'Tab' || (!settingsOpen && !(agentOpen && agentModal()))) return;
    const activeDrawer = settingsOpen ? content : agent;
    const controls = [...activeDrawer.querySelectorAll('button, input, textarea, select, summary, a[href]')].filter(element => element.getClientRects().length && !element.disabled);
    const first = controls[0], last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
    else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
  });
  for (const toggle of [...settingsToggles, agentToggle, agentClose]) toggle.addEventListener('click', help.dismiss);
  renderDrawers();
}

if (typeof document !== 'undefined') mountWorkspace();
