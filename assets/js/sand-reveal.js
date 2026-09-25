import { sandFront } from './sand-flow.js';

const NS = 'http://www.w3.org/2000/svg';
let sequence = 0;
const node = (name, attributes = {}) => {
  const element = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
};

/** Two reusable, feathered vector masks; no screenshots or per-frame image encoding. */
export function createSandReveal(container) {
  if (!globalThis.CSS?.supports('mask-image', 'url("#sand")')) {
    return {
      paint(element, index, { progress, exiting = false }) { element.style.opacity = exiting ? 1 - progress : progress; },
      clear(element) { element.style.removeProperty('opacity'); },
    };
  }
  const prefix = `reader-sand-${++sequence}`;
  const svg = node('svg', { width: 0, height: 0, 'aria-hidden': 'true', focusable: 'false', class: 'reader-sand-defs' });
  const defs = node('defs');
  const filter = node('filter', { id: `${prefix}-grain`, x: '-15%', y: '-15%', width: '130%', height: '130%', 'color-interpolation-filters': 'sRGB' });
  filter.append(
    node('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: 7, result: 'soft' }),
    node('feTurbulence', { type: 'fractalNoise', baseFrequency: '.065 .11', numOctaves: 2, seed: 12, result: 'grain' }),
    node('feDisplacementMap', { in: 'soft', in2: 'grain', scale: 20, xChannelSelector: 'R', yChannelSelector: 'G' }),
  );
  defs.append(filter);
  const masks = [0, 1].map(index => {
    const id = `${prefix}-${index}`;
    const mask = node('mask', { id, maskUnits: 'userSpaceOnUse', maskContentUnits: 'userSpaceOnUse', 'mask-type': 'alpha' });
    const path = node('path', { fill: 'white', filter: `url(#${prefix}-grain)` });
    mask.append(path);
    defs.append(mask);
    return { id, mask, path };
  });
  svg.append(defs);
  container.append(svg);

  function clear(element) { element.style.removeProperty('mask'); }
  function paint(element, index, { progress, rect, axis = 'vertical', direction = 1, exiting = false }) {
    const { id, mask, path } = masks[index];
    const bounds = element.getBoundingClientRect();
    const pad = 40;
    const width = innerWidth, height = innerHeight;
    const point = (x, y) => `${(x - bounds.x).toFixed(1)},${(y - bounds.y).toFixed(1)}`;
    const points = [];
    const offset = exiting ? .07 : -.07;
    if (axis === 'vertical') {
      const edge = exiting ? height + pad : -pad;
      points.push(point(-pad, edge));
      for (let step = 0; step <= 40; step++) {
        const x = -pad + (width + pad * 2) * step / 40;
        points.push(point(x, rect.y + (sandFront((x - rect.x) / rect.width, progress) + offset) * rect.height));
      }
      points.push(point(width + pad, edge));
    } else {
      const fromRight = direction > 0;
      const edge = fromRight !== exiting ? width + pad : -pad;
      points.push(point(edge, -pad));
      for (let step = 0; step <= 40; step++) {
        const y = -pad + (height + pad * 2) * step / 40;
        const front = sandFront((y - rect.y) / rect.height, progress) + offset;
        points.push(point(rect.x + (fromRight ? 1 - front : front) * rect.width, y));
      }
      points.push(point(edge, height + pad));
    }
    mask.setAttribute('x', -bounds.x - pad);
    mask.setAttribute('y', -bounds.y - pad);
    mask.setAttribute('width', width + pad * 2);
    mask.setAttribute('height', height + pad * 2);
    path.setAttribute('d', `M${points.join(' L')}Z`);
    element.style.mask = `url("#${id}")`;
  }
  return { paint, clear };
}
