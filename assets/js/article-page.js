import { ParticleExperience } from './particles.js';
import { createArticleReader } from './article-reader.js';

const article = document.querySelector('article.article:has(.article-pagination)');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
if (article && !motion.matches) {
  const canvas = document.createElement('canvas');
  canvas.id = 'reader-particles';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);
  let engine;
  try {
    engine = new ParticleExperience(canvas);
    engine.setTheme(document.documentElement.dataset.theme);
    if (engine.metrics.renderer === 'static') throw new Error('No particle renderer');
    const reader = createArticleReader({ engine, initialArticle: article });
    let timer;
    addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { engine.resize(); reader.resize(); }, 100);
    });
    canvas.addEventListener('particlestatechange', () => reader.resize());
    document.addEventListener('themechange', event => engine.setTheme(event.detail));
    Object.defineProperty(window, '__particleReader', { value: { get state() { return engine.metrics; } }, configurable: true });
  } catch {
    engine?.destroy();
    canvas.remove();
  }
}
