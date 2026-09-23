import { HeroParticles } from './hero-particles.js';

const canvas = document.querySelector('#hero-particles');
const burst = document.querySelector('[data-particle-burst]');
async function initializeHero() {
  if (!canvas) return;
  let experience;
  try {
    await document.fonts.load('italic 200px Instrument');
    experience = new HeroParticles(canvas, { title: 'Alcedo', fontFamily: 'Instrument' });
    experience.setTheme(document.documentElement.dataset.theme || 'ink');
    experience.start();
    if (burst) {
      burst.hidden = false;
      burst.addEventListener('click', () => experience.burst());
    }
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const updateButton = () => {
      if (burst) burst.hidden = motion.matches || experience.metrics.renderer === 'static';
    };
    updateButton();
    if (motion.addEventListener) motion.addEventListener('change', updateButton);
    else motion.addListener?.(updateButton);
    canvas.addEventListener('webglcontextlost', () => { if (burst) burst.hidden = true; });
    canvas.addEventListener('webglcontextrestored', updateButton);
    document.addEventListener('themechange', event => experience.setTheme(event.detail));
    // Read-only diagnostics make renderer and pause behavior observable in QA.
    Object.defineProperty(window, '__homelabExperience', { get: () => experience.metrics, configurable: true });
  } catch (error) {
    experience?.destroy();
    if (burst) burst.hidden = true;
    console.warn('Particle enhancement unavailable; readable title retained.', error);
  }
}
initializeHero();

const railLinks = [...document.querySelectorAll('.chapter-rail a')];
const sections = railLinks.map(link => document.querySelector(link.getAttribute('href'))).filter(Boolean);
if (sections.length) {
  let scheduled = false;
  const update = () => {
    const marker = innerHeight * 0.4;
    let active = 0;
    sections.forEach((section, index) => { if (section.getBoundingClientRect().top <= marker) active = index; });
    railLinks.forEach((link, index) => index === active ? link.setAttribute('aria-current', 'location') : link.removeAttribute('aria-current'));
    scheduled = false;
  };
  addEventListener('scroll', () => {
    if (!scheduled) { scheduled = true; requestAnimationFrame(update); }
  }, { passive: true });
  update();
}
