import { ParticleExperience } from './particles.js';
import { createArticleReader } from './article-reader.js';

const root = document.documentElement;
const canvas = document.querySelector('#story-particles');
const panels = [...document.querySelectorAll('[data-panel]')];
const chapters = [...document.querySelectorAll('#story-navigation [data-scene]')];
const navigation = document.querySelector('#story-navigation');
const header = document.querySelector('.story-header');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const stops = [0, 1.35, 2.45, 3.25, 4.55, 5.25];
const end = 5.82;
let experience, enhanced = false, progress = 0, current = 0, scheduled = false;
let resizing = 0, hashTimer = 0, pendingFocus = null, ready = false;
let resizeProgress = 0, resizeDestination = null;
let reader, suspended = false;
const homePath = location.pathname;

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const smooth = (a, b, value) => { const t = clamp((value - a) / (b - a)); return t * t * (3 - 2 * t); };
const maxScroll = () => Math.max(1, document.documentElement.scrollHeight - innerHeight);
const rect = selector => {
  const element = typeof selector === 'string' ? document.querySelector(selector) : selector;
  if (!element) return null;
  const box = element.getBoundingClientRect();
  return { x: box.x, y: box.y, width: box.width, height: box.height };
};
const layout = () => ({
  code: rect('[data-particle-code]'), project: rect('[data-particle-project]'),
  notes: [...document.querySelectorAll('[data-particle-note]')].map(rect),
  final: rect('[data-particle-final]'), finalButton: rect('[data-particle-final-button]'),
});
const hashScene = () => panels.findIndex(panel => '#' + panel.id === location.hash);

function update() {
  scheduled = false;
  if (!enhanced || suspended || resizing) return;
  resizeDestination = null;
  progress = clamp(scrollY / maxScroll() * end, 0, end);
  const scene = Math.min(panels.length - 1, Math.floor(progress));
  const local = progress - scene;
  const opacity = motion.matches || scene === 5 ? 1 : 1 - smooth(.77, .98, local);
  const intro = progress < .06;
  if (intro && (header.contains(document.activeElement) || navigation.contains(document.activeElement))) {
    const title = panels[0].querySelector('h1');
    title.tabIndex = -1;
    title.focus({ preventScroll: true });
  }
  root.dataset.storyIntro = String(intro);
  for (const chrome of [header, navigation]) {
    chrome.inert = intro;
    chrome.setAttribute('aria-hidden', String(intro));
  }
  root.dataset.scene = String(scene);
  panels.forEach((panel, index) => {
    const active = index === scene;
    const accessible = active && opacity > .02;
    if (!accessible && panel.contains(document.activeElement)) {
      // Keep focus out of a subtree before making it inert/hidden.
      document.activeElement.blur();
      if (progress >= .06) chapters[scene]?.focus({ preventScroll: true });
    }
    panel.classList.toggle('is-active', active);
    panel.style.opacity = active ? opacity : 0;
    panel.inert = !accessible;
    panel.setAttribute('aria-hidden', String(!accessible));
  });
  if (current !== scene || !ready) {
    current = scene;
    chapters.forEach((link, index) => index === scene ? link.setAttribute('aria-current', 'step') : link.removeAttribute('aria-current'));
  }
  if (pendingFocus === scene && opacity > .8) {
    const heading = panels[scene].querySelector('h1,h2');
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    pendingFocus = null;
  }
  experience.setProgress(motion.matches ? (scene === 0 ? 0 : stops[scene]) : progress);
  ready = true;
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    if (!enhanced || suspended || location.pathname !== homePath) return;
    const hash = '#' + panels[current].id;
    if (location.hash !== hash && (current > 0 || location.hash)) window.history.replaceState(window.history.state, '', hash);
  }, 220);
}
function requestUpdate() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(update);
}
function goToScene(scene, { history = true, focus = false, instant = false } = {}) {
  if (suspended || location.pathname !== homePath) return;
  scene = clamp(scene, 0, panels.length - 1);
  if (!enhanced) {
    panels[scene].scrollIntoView({ behavior: 'auto' });
    return;
  }
  clearTimeout(hashTimer);
  if (history && location.hash !== '#' + panels[scene].id) window.history.pushState({}, '', '#' + panels[scene].id);
  // Keep explicit navigation until the next settled frame: a resize event may
  // still be queued even if a rapid rotation returned to the original size.
  resizeDestination = stops[scene];
  pendingFocus = focus ? scene : null;
  scrollTo({ top: maxScroll() * stops[scene] / end, behavior: instant || motion.matches ? 'instant' : 'smooth' });
  requestUpdate();
}
function fallback() {
  enhanced = false;
  window.history.scrollRestoration = 'auto';
  root.classList.remove('immersive-ready');
  delete root.dataset.storyIntro;
  for (const chrome of [header, navigation]) { chrome.inert = false; chrome.removeAttribute('aria-hidden'); }
  panels.forEach(panel => {
    panel.inert = false;
    panel.removeAttribute('aria-hidden');
    panel.style.removeProperty('opacity');
    panel.classList.remove('is-active');
  });
  panels[current]?.scrollIntoView({ behavior: 'instant' });
}
function enhance() {
  const visible = panels.reduce((best, panel, index) => Math.abs(panel.getBoundingClientRect().top) < Math.abs(panels[best].getBoundingClientRect().top) ? index : best, 0);
  progress = stops[visible];
  root.classList.add('immersive-ready');
  enhanced = true;
  window.history.scrollRestoration = 'manual';
  experience.resize(layout());
  scrollTo({ top: maxScroll() * progress / end, behavior: 'instant' });
  update();
}

async function initialize() {
  if (!canvas || !panels.length) return;
  const initial = hashScene();
  if (initial >= 0) current = initial;
  try {
    // A delayed/failed font must never make the actual journal inaccessible.
    let timer;
    await Promise.race([
      document.fonts.load('italic 180px Instrument'),
      new Promise(resolve => { timer = setTimeout(resolve, 3500); }),
    ]).finally(() => clearTimeout(timer));
    root.classList.add('immersive-ready');
    experience = new ParticleExperience(canvas, { title: 'Alcedo' });
    experience.resize(layout());
    experience.setTheme(root.dataset.theme || 'ink');
    experience.setReducedMotion(motion.matches);
    if (experience.metrics.renderer === 'static') { fallback(); return; }
    enhanced = true;
    // Scene hashes own scroll position; browser pixel restoration can otherwise
    // override popstate while a native smooth scroll is still in flight.
    window.history.scrollRestoration = 'manual';
    experience.start();
    if (initial >= 0) goToScene(initial, { history: false, instant: true });
    update();
    reader = createArticleReader({
      engine: experience,
      getHomeState: () => ({ enhanced, progress, scene: current, url: new URL(homePath + '#' + panels[current].id, location.origin).href }),
      suspendHome(value) { suspended = value; clearTimeout(hashTimer); },
      restoreHome(record) {
        const scene = location.pathname === homePath ? Math.max(0, hashScene()) : record.scene;
        const destination = scene === record.scene ? record.progress : stops[scene];
        if (experience.metrics.renderer === 'static') { current = scene; fallback(); return; }
        experience.resize(layout());
        scrollTo({ top: maxScroll() * destination / end, behavior: 'instant' });
        update();
      },
    });

    document.querySelectorAll('a[data-scene]').forEach(link => link.addEventListener('click', event => {
      if (!enhanced || suspended || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      goToScene(Number(link.dataset.scene), { focus: event.detail === 0 });
    }));
    addEventListener('scroll', requestUpdate, { passive: true });
    addEventListener('hashchange', () => { if (reader.active || reader.loading || location.pathname !== homePath) return; const scene = hashScene(); if (scene >= 0) goToScene(scene, { history: false, instant: true }); });
    addEventListener('popstate', () => { if (reader.active || reader.loading || location.pathname !== homePath) return; const scene = hashScene(); goToScene(scene >= 0 ? scene : 0, { history: false, instant: true }); });
    addEventListener('resize', () => {
      // Resize can clamp scrollY before its scroll event arrives. Keep the last
      // scene position until layout is rebuilt instead of treating that as input.
      clearTimeout(hashTimer);
      if (!resizing) resizeProgress = progress;
      clearTimeout(resizing);
      resizing = setTimeout(() => {
        resizing = 0;
        const destination = resizeDestination ?? resizeProgress;
        resizeDestination = null;
        if (!enhanced) return;
        if (reader.active) { experience.resize(layout()); reader.resize(); return; }
        experience.resize(layout());
        scrollTo({ top: maxScroll() * destination / end, behavior: 'instant' });
        update();
      }, 140);
    });
    document.fonts.ready.then(() => { if (enhanced) { experience.resize(layout()); if (reader.active) reader.resize(); else update(); } });
    document.addEventListener('themechange', event => experience.setTheme(event.detail));
    const onMotion = () => { experience.setReducedMotion(motion.matches); update(); };
    if (motion.addEventListener) motion.addEventListener('change', onMotion);
    else motion.addListener?.(onMotion);
    canvas.addEventListener('particlestatechange', () => {
      if (!experience) return;
      if (reader.active) { reader.resize(); return; }
      if (experience.metrics.renderer === 'static') fallback();
      else if (!enhanced) enhance();
    });
    addEventListener('pointermove', event => {
      if (suspended || event.pointerType === 'touch' || document.querySelector('dialog[open]')) return;
      experience.setPointer(event.clientX, event.clientY);
    }, { passive: true });
    addEventListener('pointerout', event => { if (!event.relatedTarget) experience.clearPointer(); }, { passive: true });
    addEventListener('pointerdown', event => {
      if (suspended || event.button !== 0 || event.target.closest('a,button,input,dialog')) return;
      experience.pulse(event.clientX, event.clientY, 1.1);
    }, { passive: true });
    addEventListener('pointerup', event => { if (event.pointerType === 'touch') experience.clearPointer(); }, { passive: true });
    addEventListener('keydown', event => {
      if (!enhanced || suspended || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || document.querySelector('dialog[open]')) return;
      if (event.target.isContentEditable || event.target.closest('input,textarea,select,button,a')) return;
      const destination = { ArrowDown: current + 1, PageDown: current + 1, ArrowUp: current - 1, PageUp: current - 1, Home: 0, End: 5 }[event.key];
      if (destination === undefined) return;
      event.preventDefault();
      goToScene(destination, { focus: true });
    });
    // Inspector only: no mutation API is exposed by the production page.
    Object.defineProperty(window, '__particleStory', { value: {
      get state() { return { ...experience.metrics, scene: current, progress, enhanced }; },
      sample() { return experience.sample(); },
    }, configurable: true });
  } catch (error) {
    experience?.destroy();
    fallback();
    console.warn('Particle scenes unavailable; the full journal remains readable.', error);
  }
}
initialize();
