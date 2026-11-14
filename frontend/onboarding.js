const STORAGE_KEY = 'spherex-onboarding-v2';

const homeSteps = [
  { target: '.target-search-row', title: 'Start with a name', copy: 'Search for a star, galaxy, comet or asteroid. For a moving object, you can choose the dates to look through.' },
  { target: '#coordinate-toggle', title: 'Know where to look?', copy: 'Choose Enter coordinates to use right ascension and declination. Decimal degrees and hours, minutes, seconds both work.' },
  { target: '#preset-panel', title: 'Or try a quick pick', copy: 'Choose one of these objects to open its infrared images. Next, we’ll open the viewer so you can see how it works.' }
];

const viewerStepCount = 3;

function viewerSteps(moving) {
  return [
    { target: moving ? '#moving-target' : '.viewer-shell > .viewer', title: 'See your patch of sky', copy: 'This is Barnard’s Star. The large frame shows an infrared image for one observation date. Images can take a moment to arrive from the archive.' },
    { target: moving ? '#moving-target' : '.timeline-panel', title: 'Play or choose any frame', copy: 'Playback and all dated frame thumbnails stay below the image. Press Play when you’re ready, drag the timeline, or choose a thumbnail to compare dates. Playback never starts automatically.' },
    { target: '#sidebar-toggle', title: 'Adjust the view anytime', copy: 'Open Settings to change the detector, brightness or view mode. Choose New search when you want to look somewhere else.' }
  ];
}

export function readTourProgress(storage) {
  try { return JSON.parse(storage?.getItem(STORAGE_KEY) || '{}') || {}; }
  catch { return {}; }
}

export function saveTourProgress(storage, progress) {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(progress)); }
  catch { /* Browsing still works when storage is unavailable. */ }
}

export function mountOnboarding() {
  if (document.documentElement.classList.contains('is-embed')) return;
  const home = document.body.classList.contains('home-page');
  let storage;
  try { storage = window.localStorage; } catch { /* Storage may be blocked. */ }
  let progress = readTourProgress(storage);
  const moving = document.getElementById('workspace')?.dataset.entryMode === 'moving';
  const steps = home ? homeSteps : viewerSteps(moving);
  const tourLength = homeSteps.length + viewerStepCount;

  // The tour is one continuous run: search controls on the home page, then the
  // real viewer controls on the viewer page. The ?tour=N parameter carries the
  // place across that navigation instead of embedding a second copy of the app.
  const requested = Number(new URLSearchParams(location.search).get('tour'));
  const requestedStep = Number.isInteger(requested) ? requested : 0;
  let stepOffset = 0;
  let totalSteps = steps.length;
  let startIndex = 0;
  let continuation = false;
  if (home) {
    totalSteps = tourLength;
    if (requestedStep >= 1 && requestedStep <= homeSteps.length) startIndex = requestedStep - 1;
  } else if (requestedStep > homeSteps.length && requestedStep <= tourLength) {
    stepOffset = homeSteps.length;
    totalSteps = tourLength;
    startIndex = requestedStep - stepOffset - 1;
    continuation = true;
  }

  let root, index = 0, previousFocus, inertElements = [];
  let resizeObserver;
  function forgetRequestedTour() {
    startIndex = 0;
    if (!home) { stepOffset = 0; totalSteps = steps.length; continuation = false; }
    if (!requestedStep) return;
    try {
      const url = new URL(location.href);
      url.searchParams.delete('tour');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    } catch { /* A sandboxed frame may refuse. */ }
  }
  function close() {
    if (!root) return;
    progress = { ...progress, home: true, viewer: true };
    saveTourProgress(storage, progress);
    forgetRequestedTour();
    resizeObserver?.disconnect();
    window.removeEventListener('resize', position);
    window.removeEventListener('scroll', position, true);
    document.removeEventListener('keydown', keyboard);
    for (const [element, inert] of inertElements) element.inert = inert;
    inertElements = [];
    root.remove(); root = null;
    (previousFocus?.isConnected ? previousFocus : document.getElementById('tour-restart'))?.focus({ preventScroll: true });
  }
  function continueToViewer() {
    progress = { ...progress, home: true };
    saveTourProgress(storage, progress);
    location.assign(`/viewer.html?target=barnard&tour=${homeSteps.length + 1}`);
  }
  function backToSearch() {
    location.assign(`/?tour=${homeSteps.length}`);
  }
  function position() {
    if (!root) return;
    const step = steps[index];
    const target = step.target ? document.querySelector(step.target) : null;
    const card = root.querySelector('.tour-card');
    const targetRect = target?.getBoundingClientRect();
    const rect = targetRect && targetRect.width && targetRect.height ? {
      left: targetRect.left, top: targetRect.top,
      bottom: targetRect.bottom, width: targetRect.width, height: targetRect.height
    } : null;
    const width = window.innerWidth, height = window.innerHeight, padding = 8;
    const hole = root.querySelector('#tour-hole');
    if (rect) {
      hole.setAttribute('x', Math.max(4, rect.left - padding));
      hole.setAttribute('y', Math.max(4, rect.top - padding));
      hole.setAttribute('width', Math.min(width - 8, rect.width + padding * 2));
      hole.setAttribute('height', Math.min(height - 8, rect.height + padding * 2));
    }
    if (!rect) { hole.setAttribute('width', 0); hole.setAttribute('height', 0); }
    const bounds = card.getBoundingClientRect();
    const below = (rect?.bottom ?? height / 3) + 24;
    const above = (rect?.top ?? height / 2) - bounds.height - 24;
    const top = !rect ? (height - bounds.height) / 2 : below + bounds.height < height - 16 ? below : above >= 16 ? above : (height - bounds.height) / 2;
    card.style.top = `${Math.max(16, Math.min(height - bounds.height - 16, top))}px`;
    const side = rect && rect.left > bounds.width + 40;
    if (side) card.style.top = `${Math.max(16, Math.min(height - bounds.height - 16, rect.top))}px`;
    const left = side ? rect.left - bounds.width - 24 : rect?.left ?? (width - bounds.width) / 2;
    card.style.left = `${Math.max(16, Math.min(width - bounds.width - 16, left))}px`;
  }
  function render() {
    const step = steps[index];
    root.querySelector('#tour-title').textContent = step.title;
    root.querySelector('#tour-copy').textContent = step.copy;
    root.querySelector('.tour-progress').textContent = `${stepOffset + index + 1} of ${totalSteps}`;
    root.querySelector('#tour-back').disabled = index === 0 && !continuation;
    root.querySelector('#tour-next').textContent = index === steps.length - 1 ? (home ? 'Next' : 'Got it') : 'Next';
    for (const [i, dot] of [...root.querySelectorAll('.tour-dot')].entries()) dot.dataset.active = String(i === stepOffset + index);
    // The viewer page scrolls now, so bring a target that is below (or above)
    // the fold into view before drawing the spotlight around it.
    const target = step.target && document.querySelector(step.target);
    const targetRect = target?.getBoundingClientRect();
    const outOfView = targetRect && (targetRect.bottom < 80 || targetRect.top > window.innerHeight - 80);
    if (outOfView && !target.closest('header')) {
      target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }
    position();
  }
  function keyboard(event) {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...root.querySelectorAll('button')].filter(button => !button.disabled);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
    else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
  }
  function open(at = startIndex) {
    if (root) return;
    index = Math.max(0, Math.min(at, steps.length - 1));
    previousFocus = document.activeElement;
    root = document.createElement('div'); root.className = 'guided-tour';
    root.innerHTML = `<svg class="tour-shade" width="100%" height="100%" aria-hidden="true"><defs><mask id="tour-mask"><rect width="100%" height="100%" fill="white"/><rect id="tour-hole" rx="6" fill="black"/></mask></defs><rect width="100%" height="100%" fill="#080d18" fill-opacity=".74" mask="url(#tour-mask)"/></svg>
      <section class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-copy">
        <div class="tour-topline"><span class="tour-progress"></span><button id="tour-skip" type="button">Skip tour</button></div>
        <div aria-live="polite" aria-atomic="true"><h2 id="tour-title"></h2><p id="tour-copy"></p></div>
        <div class="tour-bottom"><div class="tour-dots" aria-hidden="true">${Array.from({ length: totalSteps }, () => '<span class="tour-dot"></span>').join('')}</div><button id="tour-back" type="button">Back</button><button id="tour-next" type="button">Next</button></div>
      </section>`;
    for (const element of document.body.children) {
      if (['SCRIPT', 'STYLE'].includes(element.tagName)) continue;
      inertElements.push([element, element.inert]); element.inert = true;
    }
    document.body.append(root);
    root.querySelector('#tour-skip').addEventListener('click', () => close());
    root.querySelector('#tour-back').addEventListener('click', () => {
      if (index > 0) { index--; render(); }
      else if (continuation) backToSearch();
    });
    root.querySelector('#tour-next').addEventListener('click', () => {
      if (index === steps.length - 1) { if (home) continueToViewer(); else close(); }
      else { index++; render(); }
    });
    document.addEventListener('keydown', keyboard);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    resizeObserver = new ResizeObserver(position);
    steps.forEach(step => { const target = step.target && document.querySelector(step.target); if (target) resizeObserver.observe(target); });
    render(); root.querySelector('#tour-next').focus({ preventScroll: true });
  }
  document.getElementById('tour-restart')?.addEventListener('click', () => open(0));
  // First visit runs the search half on the home page, then hands off to the
  // real viewer. Viewer help stays available from its own button afterwards.
  if (home) {
    if (requestedStep >= 1 && requestedStep <= homeSteps.length) open(startIndex);
    else if (!progress.home) open(0);
  } else if (continuation) open(startIndex);
}

if (typeof document !== 'undefined') mountOnboarding();
