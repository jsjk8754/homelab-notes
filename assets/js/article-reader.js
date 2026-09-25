const clamp = value => Math.max(0, Math.min(1, value));
const ease = value => value < .5 ? 4 * value ** 3 : 1 - (-2 * value + 2) ** 3 / 2;
const box = element => {
  const r = element.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};

/** Home-only enhancement. Every destination remains an ordinary Hugo URL. */
export function createArticleReader({ engine, getHomeState, suspendHome, restoreHome }) {
  const root = document.documentElement;
  const homePath = location.pathname;
  const homeTitle = document.title;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const main = document.querySelector('#main');
  const header = document.querySelector('.story-header');
  const skip = document.querySelector('.skip-link');
  const meta = ['link[rel="canonical"]', 'meta[name="description"]', 'meta[property="og:title"]', 'meta[property="og:description"]', 'meta[property="og:type"]', 'meta[property="og:url"]'];
  const originalMeta = meta.map(selector => {
    const element = document.querySelector(selector);
    const attribute = element.tagName === 'LINK' ? 'href' : 'content';
    return { selector, element, attribute, value: element.getAttribute(attribute) };
  });
  const cache = new Map();
  const status = document.createElement('p');
  status.className = 'visually-hidden';
  status.setAttribute('role', 'status');
  document.body.append(status);
  let overlay, paper, content, closeButton, record, source, pending;
  let amount = 0, phase = 'idle', animation = 0, revision = 0, scrollTimer = 0;
  let savedInert = [];

  const active = () => Boolean(overlay);
  const frameFor = link => link.closest('[data-reader-frame]');
  const linkFor = url => [...document.querySelectorAll('a[data-reader-link]')].find(link => link.href === new URL(url, location.origin).href);
  const setPhase = value => { phase = value; root.dataset.readerPhase = value; };
  const expandedRect = () => {
    const article = content.querySelector('.article');
    const r = article.getBoundingClientRect();
    const margin = innerWidth <= 700 ? 10 : 24;
    return { x: Math.max(10, r.x - margin), y: 64, width: Math.min(innerWidth - 20, r.width + margin * 2), height: Math.max(120, innerHeight - 82) };
  };
  function render(value) {
    if (!overlay) return;
    amount = clamp(value);
    const start = box(frameFor(source));
    const end = expandedRect();
    const t = clamp(amount / .84);
    const travel = t * t * (3 - 2 * t);
    const mix = (a, b) => a + (b - a) * travel;
    const bounds = { left: mix(start.x, end.x), top: mix(start.y, end.y), width: mix(start.width, end.width), height: mix(start.height, end.height) };
    for (const [property, value] of Object.entries(bounds)) paper.style[property] = value + 'px';
    root.style.setProperty('--reader-home-opacity', String(1 - clamp(amount / .38)));
    overlay.style.setProperty('--reader-reveal', String(clamp((amount - .5) / .48)));
    // The article appears inside the expanding paper, not outside its edges.
    const top = bounds.top - content.getBoundingClientRect().top;
    const right = bounds.left + bounds.width;
    const bottom = top + bounds.height;
    content.style.clipPath = amount === 1 ? 'none' : `polygon(${bounds.left}px ${top}px, ${right}px ${top}px, ${right}px ${bottom}px, ${bounds.left}px ${bottom}px)`;
    paper.style.opacity = String(Math.sin(amount * Math.PI) * .7);
    engine.setDocumentMorph(amount, end, start);
  }
  function animate(destination, complete) {
    cancelAnimationFrame(animation);
    const from = amount;
    const duration = motion.matches ? 0 : (destination ? 560 : 480) * Math.abs(destination - from);
    const started = performance.now();
    const tick = now => {
      const elapsed = motion.matches || !duration ? 1 : clamp((now - started) / duration);
      render(from + (destination - from) * ease(elapsed));
      if (elapsed < 1) animation = requestAnimationFrame(tick);
      else { animation = 0; complete(); }
    };
    animation = requestAnimationFrame(tick);
  }
  function setArticleMeta(data) {
    document.title = data.title;
    originalMeta.forEach(({ selector, element, attribute }) => {
      const value = data.metadata[selector];
      if (value !== null) element.setAttribute(attribute, value);
    });
  }
  function cancelPending() {
    if (!pending) return;
    pending.controller.abort();
    pending.link?.removeAttribute('aria-busy');
    pending = null;
    revision += 1;
    if (!active()) setPhase('idle');
    status.textContent = '';
  }
  async function fetchArticle(url, signal) {
    const key = url.origin + url.pathname;
    if (cache.has(key)) return cache.get(key);
    const response = await fetch(key, { signal, credentials: 'same-origin' });
    const destination = new URL(response.url);
    if (!response.ok || destination.origin !== location.origin || destination.pathname.replace(/\/$/, '') !== url.pathname.replace(/\/$/, '') || !response.headers.get('content-type')?.includes('text/html')) throw new Error('Article response unavailable');
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    const article = page.querySelector('article.article');
    if (!article?.querySelector('h1')) throw new Error('Article not found');
    const data = { article, title: page.title, metadata: {} };
    originalMeta.forEach(({ selector, attribute }) => { data.metadata[selector] = page.querySelector(selector)?.getAttribute(attribute) ?? null; });
    cache.set(key, data);
    if (cache.size > 6) cache.delete(cache.keys().next().value);
    return data;
  }
  function saveScroll() {
    if (phase !== 'reading' || !history.state?.alcedoReader) return;
    history.replaceState({ ...history.state, readerScroll: overlay.scrollTop }, '', location.href);
  }
  function jumpToHash() {
    if (!location.hash || !overlay) return false;
    let id;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return false; }
    const target = [...content.querySelectorAll('[id]')].find(element => element.id === id);
    if (!target) return false;
    target.scrollIntoView({ behavior: 'instant', block: 'start' });
    return true;
  }
  function mount(data, nextRecord, link, restoreScroll) {
    record = nextRecord;
    source = link;
    suspendHome(true);
    engine.clearPointer();
    engine.beginDocumentMorph(box(frameFor(source)));
    overlay = document.createElement('main');
    overlay.className = 'article-reader';
    overlay.setAttribute('aria-label', '기술 기록 읽기');
    paper = document.createElement('div');
    paper.className = 'reader-paper';
    paper.setAttribute('aria-hidden', 'true');
    const toolbar = document.createElement('div');
    toolbar.className = 'reader-toolbar';
    closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'reader-close';
    closeButton.textContent = '← 기록으로 돌아가기';
    closeButton.addEventListener('click', requestClose);
    const signature = document.createElement('span');
    signature.className = 'reader-signature';
    signature.textContent = 'alcedo.';
    toolbar.append(closeButton, signature);
    content = document.createElement('div');
    content.className = 'reader-content';
    content.append(document.importNode(data.article, true));
    overlay.append(paper, toolbar, content);
    document.body.append(overlay);
    setArticleMeta(data);
    root.classList.add('reader-open');
    setPhase('opening');
    // Move focus before hiding the old scene from assistive technology.
    closeButton.focus({ preventScroll: true });
    savedInert = [main, header, skip].map(element => [element, element.inert]);
    savedInert.forEach(([element]) => { element.inert = true; });
    document.dispatchEvent(new CustomEvent('articlemounted', { detail: content }));
    overlay.addEventListener('scroll', () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(saveScroll, 100);
    }, { passive: true });
    content.addEventListener('click', event => {
      const link = event.target.closest('a[href]');
      if (!link || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin || url.pathname !== location.pathname || !url.hash) return;
      event.preventDefault();
      history.replaceState(history.state, '', url);
      jumpToHash();
      saveScroll();
    });
    render(0);
    animate(1, () => {
      setPhase('reading');
      if (!jumpToHash()) overlay.scrollTop = restoreScroll || 0;
      const title = content.querySelector('h1');
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
      status.textContent = '';
    });
  }
  async function open(link, saved = null, restoreScroll = 0) {
    cancelPending();
    const token = ++revision;
    const url = new URL(saved?.articleURL || link.href, location.origin);
    const controller = new AbortController();
    pending = { controller, link };
    link.setAttribute('aria-busy', 'true');
    setPhase('loading');
    status.textContent = '기록을 불러오고 있습니다.';
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const data = await fetchArticle(url, controller.signal);
      if (token !== revision) return;
      const home = getHomeState();
      if (motion.matches || !home.enhanced || engine.metrics.renderer === 'static') { location.assign(url); return; }
      // If the visitor scrolled away while fetching, use the normal destination.
      if (!saved && Number(link.closest('[data-panel]').dataset.panel) !== home.scene) { location.assign(url); return; }
      const nextRecord = saved || { articleURL: url.href, sourceURL: link.href, homeURL: home.url, progress: home.progress, scene: home.scene };
      if (!saved) {
        history.replaceState({ ...history.state, alcedoReturn: nextRecord }, '', nextRecord.homeURL);
        history.pushState({ alcedoReader: nextRecord, readerScroll: 0 }, '', url);
      }
      mount(data, nextRecord, link, restoreScroll);
    } catch {
      if (token === revision) location.assign(url);
    } finally {
      clearTimeout(timeout);
      link.removeAttribute('aria-busy');
      if (token === revision) pending = null;
    }
  }
  function close() {
    if (!overlay || phase === 'closing') return;
    clearTimeout(scrollTimer);
    setPhase('closing');
    closeButton.disabled = true;
    // Fold the first page, even when returning from the end of a long article.
    overlay.scrollTop = 0;
    animate(0, () => {
      overlay.remove();
      overlay = null;
      engine.endDocumentMorph();
      root.classList.remove('reader-open');
      root.style.removeProperty('--reader-home-opacity');
      savedInert.forEach(([element, inert]) => { element.inert = inert; });
      originalMeta.forEach(({ element, attribute, value }) => element.setAttribute(attribute, value));
      document.title = homeTitle;
      suspendHome(false);
      restoreHome(record);
      setPhase('idle');
      if (!source.closest('[inert]')) source.focus({ preventScroll: true });
    });
  }
  function requestClose() {
    if (!overlay || phase === 'closing') return;
    saveScroll();
    if (history.state?.alcedoReader) history.back();
    else location.assign(record.homeURL);
  }
  document.addEventListener('click', event => {
    const link = event.target.closest('a[data-reader-link]');
    if (!link || active() || event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || motion.matches || !getHomeState().enhanced || engine.metrics.renderer === 'static') return;
    event.preventDefault();
    open(link);
  });
  addEventListener('popstate', event => {
    cancelPending();
    if (location.pathname === homePath) { if (active()) close(); return; }
    const saved = event.state?.alcedoReader;
    const link = saved && linkFor(saved.sourceURL);
    if (!link) { location.reload(); return; }
    if (active()) {
      if (phase === 'closing') {
        closeButton.disabled = false;
        setPhase('opening');
        animate(1, () => { setPhase('reading'); overlay.scrollTop = event.state.readerScroll || 0; });
      }
      return;
    }
    restoreHome(saved);
    open(link, saved, event.state.readerScroll);
  });
  addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (pending && !active()) { event.preventDefault(); cancelPending(); }
    else if (active()) { event.preventDefault(); requestClose(); }
  });
  addEventListener('pagehide', () => { cancelPending(); saveScroll(); });
  return {
    get active() { return active(); },
    get loading() { return Boolean(pending); },
    resize() { if (active()) render(amount); },
  };
}
