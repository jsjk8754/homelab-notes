const clippedOverflow = new Set(['auto', 'hidden', 'scroll', 'clip']);
const ignoredTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'TEXTAREA', 'SELECT']);
const graphemeSegmenter = globalThis.Intl?.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

const emptyCapture = (width, height) => ({
  points: new Float32Array(0),
  count: 0,
  width,
  height,
});

const intersects = (rect, clip) => (
  rect.width > 0
  && rect.height > 0
  && rect.right > clip.left
  && rect.left < clip.right
  && rect.bottom > clip.top
  && rect.top < clip.bottom
);

function transformedText(text, transform, wordStart) {
  if (transform === 'uppercase') return text.toLocaleUpperCase();
  if (transform === 'lowercase') return text.toLocaleLowerCase();
  if (transform === 'capitalize' && wordStart) return text.toLocaleUpperCase();
  return text;
}

function segmentsFor(text) {
  if (graphemeSegmenter) {
    return [...graphemeSegmenter.segment(text)]
      .map(part => ({ text: part.segment, index: part.index }));
  }
  const parts = [];
  let index = 0;
  for (const textPart of text) {
    parts.push({ text: textPart, index });
    index += textPart.length;
  }
  return parts;
}

function fontFor(style) {
  return [
    style.fontStyle,
    style.fontVariant,
    style.fontWeight,
    style.fontSize,
    style.fontFamily,
  ].filter(Boolean).join(' ');
}

/**
 * Rasterize the visible article's real DOM glyphs, then reduce their strokes to
 * viewport-space particle targets. The element is never cloned or restyled.
 */
export function captureArticleGlyphs(element, {
  maxPoints = 16000,
  top = 64,
  bottom = innerHeight,
} = {}) {
  const width = Math.max(0, Math.round(innerWidth));
  const height = Math.max(0, Math.round(innerHeight));
  const limit = Math.max(0, Math.floor(Number(maxPoints) || 0));
  if (!element || !width || !height || !limit) return emptyCapture(width, height);

  const article = element.matches?.('article') ? element : element.querySelector?.('article') || element;
  const articleRect = article.getBoundingClientRect();
  const rasterLeft = Math.max(0, Math.floor(articleRect.left));
  const rasterRight = Math.min(width, Math.ceil(articleRect.right));
  const rasterTop = Math.max(0, Math.floor(Number(top) || 0));
  const rasterBottom = Math.min(height, Math.ceil(Number(bottom) || height));
  if (rasterRight <= rasterLeft || rasterBottom <= rasterTop) return emptyCapture(width, height);

  const canvas = document.createElement('canvas');
  // One CSS pixel is sufficient for point targets and avoids a fourfold Retina
  // readback cost immediately before the transition starts.
  const ratio = 1;
  canvas.width = Math.max(1, Math.ceil((rasterRight - rasterLeft) * ratio));
  canvas.height = Math.max(1, Math.ceil((rasterBottom - rasterTop) * ratio));
  const context = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
  if (!context) return emptyCapture(width, height);

  const viewportClip = {
    left: 0,
    right: width,
    top: rasterTop,
    bottom: rasterBottom,
  };
  if (viewportClip.bottom <= viewportClip.top) return emptyCapture(width, height);

  const setViewportTransform = (scaleX = 1, originX = rasterLeft) => {
    context.setTransform(
      ratio * scaleX,
      0,
      0,
      ratio,
      (originX - rasterLeft) * ratio,
      -rasterTop * ratio,
    );
  };
  setViewportTransform();
  context.textBaseline = 'alphabetic';
  const styleCache = new WeakMap();
  const hiddenCache = new WeakMap();
  const clipCache = new WeakMap();
  const measurementCache = new Map();
  const styleFor = node => {
    if (!styleCache.has(node)) styleCache.set(node, getComputedStyle(node));
    return styleCache.get(node);
  };

  const isHidden = node => {
    if (hiddenCache.has(node)) return hiddenCache.get(node);
    let hidden = false;
    for (let current = node; current; current = current.parentElement) {
      if (ignoredTags.has(current.tagName)
        || current.matches?.('.code-copy,[aria-hidden="true"]')
        || styleFor(current).display === 'none'
        || ['hidden', 'collapse'].includes(styleFor(current).visibility)) {
        hidden = true;
        break;
      }
      if (current === element) break;
    }
    hiddenCache.set(node, hidden);
    return hidden;
  };

  const clipFor = node => {
    if (clipCache.has(node)) return clipCache.get(node);
    const clip = { ...viewportClip };
    for (let current = node; current; current = current.parentElement) {
      const style = styleFor(current);
      const clipsX = clippedOverflow.has(style.overflowX);
      const clipsY = clippedOverflow.has(style.overflowY);
      if (clipsX || clipsY || style.contain.includes('paint')) {
        const rect = current.getBoundingClientRect();
        if (clipsX || style.contain.includes('paint')) {
          clip.left = Math.max(clip.left, rect.left);
          clip.right = Math.min(clip.right, rect.right);
        }
        if (clipsY || style.contain.includes('paint')) {
          clip.top = Math.max(clip.top, rect.top);
          clip.bottom = Math.min(clip.bottom, rect.bottom);
        }
      }
      if (current === element) break;
    }
    clipCache.set(node, clip);
    return clip;
  };

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || !node.data || isHidden(parent)) continue;
    const clip = clipFor(parent);
    if (clip.right <= clip.left || clip.bottom <= clip.top) continue;

    range.selectNodeContents(node);
    if (![...range.getClientRects()].some(rect => intersects(rect, clip))) continue;

    const style = styleFor(parent);
    context.save();
    setViewportTransform();
    context.beginPath();
    context.rect(clip.left, clip.top, clip.right - clip.left, clip.bottom - clip.top);
    context.clip();
    const font = fontFor(style);
    if (context.font !== font) context.font = font;
    if (context.fillStyle !== style.color) context.fillStyle = style.color;
    if (context.direction !== style.direction) context.direction = style.direction;
    if ('fontKerning' in context && context.fontKerning !== style.fontKerning) context.fontKerning = style.fontKerning;
    if ('fontStretch' in context && context.fontStretch !== style.fontStretch) context.fontStretch = style.fontStretch;
    if ('fontVariantCaps' in context && context.fontVariantCaps !== style.fontVariantCaps) context.fontVariantCaps = style.fontVariantCaps;
    if ('textRendering' in context && context.textRendering !== style.textRendering) context.textRendering = style.textRendering;
    const fontKey = `${font}\u0000${style.fontKerning}\u0000${style.fontStretch}\u0000${style.fontVariantCaps}`;

    const parts = segmentsFor(node.data);
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex];
      if (/^\s+$/u.test(part.text)) continue;
      const end = parts[partIndex + 1]?.index ?? node.data.length;
      range.setStart(node, part.index);
      range.setEnd(node, end);
      const rects = [...range.getClientRects()].filter(rect => intersects(rect, clip));
      if (!rects.length) continue;

      const prior = node.data.slice(0, part.index);
      const wordStart = part.index === 0 || /[\s\p{P}\p{S}]$/u.test(prior);
      const glyph = transformedText(part.text, style.textTransform, wordStart);
      const measurementKey = `${fontKey}\u0000${glyph}`;
      let measurement = measurementCache.get(measurementKey);
      if (!measurement) {
        measurement = context.measureText(glyph);
        measurementCache.set(measurementKey, measurement);
      }
      const fontSize = parseFloat(style.fontSize) || 16;
      const ascent = measurement.fontBoundingBoxAscent || measurement.actualBoundingBoxAscent || fontSize * 0.8;
      const descent = measurement.fontBoundingBoxDescent || measurement.actualBoundingBoxDescent || fontSize * 0.2;
      const tracking = style.letterSpacing === 'normal' ? 0 : parseFloat(style.letterSpacing) || 0;

      for (const rect of rects) {
        const baseline = rect.top + (rect.height - ascent - descent) / 2 + ascent;
        const measuredWidth = Math.max(0.01, measurement.width);
        const targetWidth = Math.max(0.01, rect.width - tracking);
        const scaleX = Math.max(0.65, Math.min(1.5, targetWidth / measuredWidth));
        const rtl = style.direction === 'rtl';
        setViewportTransform(scaleX, rtl ? rect.right : rect.left);
        const alignment = rtl ? 'right' : 'left';
        if (context.textAlign !== alignment) context.textAlign = alignment;
        context.fillText(glyph, 0, baseline);
      }
    }
    context.restore();
  }
  range.detach?.();

  let image;
  try {
    image = context.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return emptyCapture(width, height);
  }
  const pixels = image.data;
  const totalPixels = canvas.width * canvas.height;
  let offsets = new Uint32Array(Math.min(totalPixels, Math.max(32768, limit * 8)));
  let inkCount = 0;
  // Scan alpha once. Previous block-grid retries revisited the entire Retina
  // canvas several times and dominated capture time.
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] <= 12) continue;
    if (inkCount === offsets.length) {
      const grown = new Uint32Array(Math.min(totalPixels, Math.max(offsets.length + 1, offsets.length * 2)));
      grown.set(offsets);
      offsets = grown;
    }
    offsets[inkCount] = offset;
    inkCount += 1;
  }
  if (!inkCount) return emptyCapture(width, height);

  const count = Math.min(inkCount, limit);
  const points = new Float32Array(count * 6);
  for (let index = 0; index < count; index += 1) {
    const sourceIndex = inkCount <= limit
      ? index
      : Math.min(inkCount - 1, Math.floor((index + 0.5) * inkCount / count));
    const offset = offsets[sourceIndex];
    const pixel = offset / 4;
    const x = pixel % canvas.width;
    const y = Math.floor(pixel / canvas.width);
    const target = index * 6;
    points[target] = rasterLeft + (x + 0.5) / ratio;
    points[target + 1] = rasterTop + (y + 0.5) / ratio;
    points[target + 2] = pixels[offset] / 255;
    points[target + 3] = pixels[offset + 1] / 255;
    points[target + 4] = pixels[offset + 2] / 255;
    points[target + 5] = pixels[offset + 3] / 255;
  }

  return { points, count, width, height };
}
