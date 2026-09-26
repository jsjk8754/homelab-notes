import { captureArticleGlyphs } from './article-glyphs.js';
import { READER_MOTION, smoother } from './reader-motion.js';

const clamp = value => Math.max(0, Math.min(1, value));
const smooth = (start, end, value) => { const t = clamp((value - start) / (end - start)); return t * t * (3 - 2 * t); };
const box = element => {
  const r = element.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};

/** The same reader serves home links and directly opened Hugo notes. */
export function createArticleReader({ engine, getHomeState, suspendHome = () => {}, restoreHome = () => {}, initialArticle = null }) {
  const standalone = Boolean(initialArticle);
  const root = document.documentElement;
  const homePath = standalone ? null : location.pathname;
  const homeTitle = document.title;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const main = document.querySelector('#main');
  const header = document.querySelector('.story-header,.site-header');
  const skip = document.querySelector('.skip-link');
  const meta = ['link[rel="canonical"]', 'meta[name="description"]', 'meta[property="og:title"]', 'meta[property="og:description"]', 'meta[property="og:type"]', 'meta[property="og:url"]'];
  const originalMeta = meta.map(selector => {
    const element = document.querySelector(selector);
    const attribute = element.tagName === 'LINK' ? 'href' : 'content';
    return { selector, element, attribute, value: element.getAttribute(attribute) };
  });
  const cache = new Map();
  const positions = new Map();
  const status = document.createElement('p');
  status.className = 'visually-hidden';
  status.setAttribute('role', 'status');
  document.body.append(status);
  let overlay, content, closeButton, toolbar, record, source, pending, turn;
  let amount = 0, phase = 'idle', animation = 0, revision = 0, scrollTimer = 0;
  let savedInert = [];

  const active = () => Boolean(overlay);
  const frameFor = link => link.closest('[data-reader-frame]');
  const linkFor = url => [...document.querySelectorAll('a[data-reader-link]')].find(link => link.href === new URL(url, location.origin).href);
  const setPhase = value => {
    phase = value;
    root.dataset.readerPhase = value;
    if (!active()) return;
    const reading = value === 'reading';
    if (content) content.inert = !reading;
    const pages = toolbar?.querySelector('.reader-pages');
    if (pages) pages.inert = !reading;
  };
  const expandedRect = () => {
    const article = content.querySelector('.article');
    const r = article.getBoundingClientRect();
    const margin = innerWidth <= 700 ? 10 : 24;
    return { x: Math.max(10, r.x - margin), y: 64, width: Math.min(innerWidth - 20, r.width + margin * 2), height: Math.max(120, innerHeight - 82) };
  };
  function glyphsFor(element) {
    try { return captureArticleGlyphs(element, { maxPoints: Math.min(16000, engine.metrics.count) }); }
    catch { return null; } // Real HTML still fades in if glyph sampling is unavailable.
  }
  function positionIncoming(element) {
    const bounds = content.getBoundingClientRect();
    // Match the final reading width and toolbar edge, including scrollbar gutters
    // and the toolbar border, so the settled glyphs do not shift during adoption.
    element.style.left = `${bounds.left}px`;
    element.style.top = `${toolbar.getBoundingClientRect().bottom}px`;
    element.style.width = `${bounds.width}px`;
    element.style.right = 'auto';
  }
  function refreshGlyphs() {
    if (!overlay) return;
    if (turn) {
      positionIncoming(turn.incoming);
      engine.setPageGlyphs(glyphsFor(content), glyphsFor(turn.incoming));
    }
    else if (!standalone) engine.setDocumentGlyphs(glyphsFor(content));
  }
  async function waitForFonts(element) {
    element.getBoundingClientRect(); // Lay out the new text to request its font subsets.
    if (!document.fonts || document.fonts.status !== 'loading') return;
    let timer;
    try { await Promise.race([document.fonts.ready, new Promise(resolve => { timer = setTimeout(resolve, 1600); })]); }
    finally { clearTimeout(timer); }
  }
  function render(value) {
    if (!overlay) return;
    amount = clamp(value);
    const end = expandedRect();
    const start = standalone ? end : box(frameFor(source));
    root.style.setProperty('--reader-home-opacity', String(1 - smooth(0, .26, amount)));
    overlay.style.setProperty('--reader-reveal', String(smooth(.14, .52, amount)));
    // The grains first form readable glyphs; only then does the matching DOM take over.
    content.style.opacity = String(engine.metrics.documentGlyphs ? smoother(READER_MOTION.open.handoff, 1, amount) : smooth(.12, .52, amount));
    engine.setDocumentMorph(amount, end, start);
  }
  function animate(destination, complete) {
    cancelAnimationFrame(animation);
    const from = amount;
    const duration = motion.matches ? 0 : (destination ? READER_MOTION.open.duration : READER_MOTION.open.closeDuration) * Math.abs(destination - from);
    let elapsedTime = 0, previousFrame = performance.now();
    const deadline = previousFrame + duration + 2000;
    const tick = now => {
      // A delayed browser frame must not skip the visible letter-forming stage.
      elapsedTime += Math.min(48, Math.max(0, now - previousFrame));
      previousFrame = now;
      // Sustained background throttling must not leave the article unreadable.
      const elapsed = motion.matches || engine.metrics.renderer === 'static' || !duration || now >= deadline ? 1 : clamp(elapsedTime / duration);
      render(from + (destination - from) * elapsed);
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
    if (history.state.alcedoReader.articleURL !== record.articleURL || history.state.alcedoReader.index !== record.index) return;
    history.replaceState({ ...history.state, readerScroll: overlay.scrollTop }, '', location.href);
  }
  const positionKey = entry => `${entry.articleURL}|${entry.index || 0}`;
  function trackScroll() {
    if (phase !== 'reading') return;
    positions.set(positionKey(record), overlay.scrollTop);
    if (positions.size > 60) positions.delete(positions.keys().next().value);
  }
  function focusTarget(target) {
    const temporaryTabIndex = !target.hasAttribute('tabindex');
    if (temporaryTabIndex) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    if (temporaryTabIndex) target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
  }
  function jumpToHash({ focus = false } = {}) {
    if (!location.hash || !overlay) return false;
    let id;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return false; }
    const target = [...content.querySelectorAll('[id]')].find(element => element.id === id);
    if (!target) return false;
    target.scrollIntoView({ behavior: 'instant', block: 'start' });
    if (focus) focusTarget(target);
    return true;
  }
  function focusTitle() {
    const title = content.querySelector('h1');
    title.tabIndex = -1;
    title.focus({ preventScroll: true });
  }
  function focusReadingDestination(scroll = 0) {
    if (scroll > 0) closeButton.focus({ preventScroll: true });
    else if (!jumpToHash({ focus: true })) focusTitle();
  }
  function updatePager() {
    toolbar.querySelector('.reader-pages')?.remove();
    const pagination = content.querySelector('.article-pagination');
    if (!pagination || Number(pagination.dataset.noteCount) < 2) return;
    const nav = document.createElement('nav');
    nav.className = 'reader-pages';
    nav.setAttribute('aria-label', '노트 넘기기');
    nav.inert = phase !== 'reading';
    for (const direction of [-1, 1]) {
      const original = pagination.querySelector(`[data-reader-page="${direction}"]`);
      const item = document.createElement(original ? 'a' : 'span');
      item.textContent = direction < 0 ? '← 이전' : '다음 →';
      if (original) {
        item.href = original.href;
        item.dataset.readerPage = String(direction);
        item.setAttribute('aria-label', `${direction < 0 ? '이전' : '다음'} 노트: ${original.querySelector('strong').textContent}`);
      } else item.setAttribute('aria-disabled', 'true');
      nav.append(item);
    }
    toolbar.append(nav);
  }
  function enhanceContent(element) {
    element.querySelectorAll('.code-copy').forEach(button => button.remove());
    element.querySelectorAll('[data-copy-ready]').forEach(button => button.removeAttribute('data-copy-ready'));
    document.dispatchEvent(new CustomEvent('articlemounted', { detail: element }));
  }
  function renderTurn(value) {
    if (!turn) return;
    turn.amount = value;
    const rect = expandedRect();
    const glyphs = engine.metrics.pageGlyphs;
    const canFormText = Boolean(glyphs?.from && glyphs?.to);
    content.style.opacity = String(1 - smoother(0, canFormText ? READER_MOTION.page.release : 1, value));
    turn.incoming.style.opacity = String(smoother(canFormText ? READER_MOTION.page.handoff : 0, 1, value));
    engine.setPageTurn(value, rect);
  }
  function finishTurn({ focus = true } = {}) {
    if (!turn) return;
    cancelAnimationFrame(animation);
    animation = 0;
    const completed = turn;
    turn = null;
    content.remove();
    content = completed.incoming;
    content.classList.remove('reader-page-incoming');
    content.removeAttribute('style');
    content.inert = false;
    overlay.scrollTop = completed.scroll;
    engine.endPageTurn();
    closeButton.disabled = false;
    setPhase('reading');
    updatePager();
    if (focus) focusReadingDestination(completed.scroll);
    else if (!completed.scroll) jumpToHash();
    status.textContent = '';
  }
  async function turnPage(link, saved = null, restoreScroll = 0) {
    finishTurn({ focus: false });
    cancelPending();
    const url = new URL(saved?.articleURL || link.href, location.origin);
    if (url.origin !== location.origin) return;
    const token = ++revision;
    const controller = new AbortController();
    pending = { controller, link };
    link?.setAttribute('aria-busy', 'true');
    status.textContent = '다음 기록을 불러오고 있습니다.';
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const data = await fetchArticle(url, controller.signal);
      if (token !== revision) return;
      if (!active()) { if (saved) location.reload(); return; }
      if (engine.metrics.renderer === 'static') { location.assign(url); return; }
      const direction = saved ? Math.sign((saved.index || 0) - (record.index || 0)) || -1 : Number(link.dataset.readerPage) || 1;
      const nextRecord = saved || { ...record, articleURL: url.href, index: (record.index || 0) + 1 };
      if (!saved) {
        saveScroll();
        history.pushState({ alcedoReader: nextRecord, readerScroll: 0 }, '', url);
      }
      record = nextRecord;
      setArticleMeta(data);
      cancelAnimationFrame(animation);
      amount = 1;
      render(1);
      const incoming = document.createElement('div');
      incoming.className = 'reader-content reader-page-incoming';
      incoming.inert = true;
      incoming.append(document.importNode(data.article, true));
      overlay.append(incoming);
      enhanceContent(incoming);
      positionIncoming(incoming);
      incoming.scrollTop = restoreScroll;
      closeButton.focus({ preventScroll: true });
      content.inert = true;
      setPhase('turning');
      engine.beginPageTurn(expandedRect(), direction);
      const nextTurn = { incoming, direction, scroll: restoreScroll, amount: 0 };
      turn = nextTurn;
      renderTurn(0);
      // The fetched article is now mounted; Escape must settle/close the turn,
      // rather than merely cancel an already completed network request.
      pending = null;
      link?.removeAttribute('aria-busy');
      await waitForFonts(incoming);
      if (token !== revision || turn !== nextTurn || !active()) return;
      refreshGlyphs();
      const duration = READER_MOTION.page.duration;
      let elapsedTime = 0, previousFrame = performance.now();
      const deadline = previousFrame + duration + 2000;
      const tick = now => {
        elapsedTime += Math.min(48, Math.max(0, now - previousFrame));
        previousFrame = now;
        const value = motion.matches || engine.metrics.renderer === 'static' || now >= deadline ? 1 : clamp(elapsedTime / duration);
        renderTurn(value);
        if (value < 1) animation = requestAnimationFrame(tick);
        else finishTurn();
      };
      animation = requestAnimationFrame(tick);
    } catch {
      if (token === revision) saved ? location.reload() : location.assign(url);
    } finally {
      clearTimeout(timeout);
      link?.removeAttribute('aria-busy');
      if (token === revision) pending = null;
    }
  }
  function mount(data, nextRecord, link, restoreScroll) {
    record = nextRecord;
    source = link;
    suspendHome(true);
    engine.clearPointer();
    if (!standalone) engine.beginDocumentMorph(box(frameFor(source)));
    overlay = document.createElement('main');
    overlay.className = 'article-reader';
    overlay.setAttribute('aria-label', '기술 기록 읽기');
    toolbar = document.createElement('div');
    toolbar.className = 'reader-toolbar';
    closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'reader-close';
    closeButton.textContent = standalone ? '← 노트 목록' : '← 기록으로 돌아가기';
    closeButton.addEventListener('click', requestClose);
    const signature = document.createElement('span');
    signature.className = 'reader-signature';
    signature.textContent = 'alcedo.';
    toolbar.append(closeButton, signature);
    content = document.createElement('div');
    content.className = 'reader-content';
    content.append(document.importNode(data.article, true));
    overlay.append(toolbar, content);
    document.body.append(overlay);
    setArticleMeta(data);
    root.classList.add('reader-open');
    if (standalone) root.classList.add('reader-standalone');
    setPhase('opening');
    // Move focus before hiding the old scene from assistive technology.
    closeButton.focus({ preventScroll: true });
    savedInert = [main, header, skip, document.querySelector('.site-footer')].filter(Boolean).map(element => [element, element.inert]);
    savedInert.forEach(([element]) => { element.inert = true; });
    enhanceContent(content);
    updatePager();
    overlay.addEventListener('scroll', () => {
      trackScroll();
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(saveScroll, 100);
    }, { passive: true });
    overlay.addEventListener('click', event => {
      const link = event.target.closest('a[href]');
      if (!link || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const url = new URL(link.href);
      if (link.hasAttribute('data-reader-page') && url.origin === location.origin) {
        if (motion.matches) return;
        event.preventDefault();
        if (phase === 'reading') turnPage(link);
        return;
      }
      if (url.origin !== location.origin || url.pathname !== location.pathname || !url.hash) return;
      event.preventDefault();
      history.replaceState(history.state, '', url);
      jumpToHash({ focus: true });
      saveScroll();
    });
    if (standalone) {
      render(1);
      setPhase('reading');
      if (restoreScroll) overlay.scrollTop = restoreScroll;
      focusReadingDestination(restoreScroll);
      return;
    }
    render(0);
    const mountedOverlay = overlay, mountedContent = content;
    waitForFonts(content).then(() => {
      if (overlay !== mountedOverlay || content !== mountedContent || phase !== 'opening') return;
      refreshGlyphs();
      animate(1, () => {
        setPhase('reading');
        if (restoreScroll) overlay.scrollTop = restoreScroll;
        focusReadingDestination(restoreScroll);
        status.textContent = '';
      });
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
      const nextRecord = saved || { articleURL: url.href, sourceURL: link.href, homeURL: home.url, progress: home.progress, scene: home.scene, index: 0 };
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
    finishTurn({ focus: false });
    clearTimeout(scrollTimer);
    setPhase('closing');
    closeButton.disabled = true;
    // Clear the first view back into the home grains, even from a long article.
    overlay.scrollTop = 0;
    refreshGlyphs();
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
    cancelPending();
    finishTurn({ focus: false });
    if (standalone) { location.assign(content.querySelector('.back-link').href); return; }
    saveScroll();
    if (history.state?.alcedoReader) history.go(-((history.state.alcedoReader.index || 0) + 1));
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
    const restoreScroll = saved ? positions.get(positionKey(saved)) ?? event.state.readerScroll ?? 0 : 0;
    if (!standalone && saved && (!saved.sourceURL || !linkFor(saved.sourceURL))) { location.reload(); return; }
    if (active() && saved?.articleURL) {
      finishTurn({ focus: false });
      if (saved.articleURL !== record.articleURL) {
        cancelAnimationFrame(animation);
        closeButton.disabled = false;
        render(1);
        setPhase('reading');
        turnPage(null, saved, restoreScroll);
        return;
      }
    }
    const link = saved?.sourceURL && linkFor(saved.sourceURL);
    if (!link && !standalone) { location.reload(); return; }
    if (standalone && !saved) { location.reload(); return; }
    if (active()) {
      if (phase === 'closing') {
        closeButton.disabled = false;
        setPhase('opening');
        animate(1, () => {
          setPhase('reading');
          overlay.scrollTop = restoreScroll;
          focusReadingDestination(restoreScroll);
        });
      } else if (phase === 'reading') {
        record = saved;
        if (restoreScroll) overlay.scrollTop = restoreScroll;
        else overlay.scrollTop = 0;
        focusReadingDestination(restoreScroll);
      }
      return;
    }
    restoreHome(saved);
    open(link, saved, restoreScroll);
  });
  addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (pending) { event.preventDefault(); cancelPending(); if (active() && new URL(record.articleURL).pathname !== location.pathname) location.reload(); }
    else if (active()) { event.preventDefault(); requestClose(); }
  });
  addEventListener('pagehide', () => { cancelPending(); saveScroll(); });
  document.addEventListener('themechange', () => { if (animation || turn) refreshGlyphs(); });
  document.fonts?.addEventListener('loadingdone', () => { if (animation) refreshGlyphs(); });
  if (standalone) {
    const data = { article: initialArticle, title: document.title, metadata: Object.fromEntries(originalMeta.map(({ selector, value }) => [selector, value])) };
    cache.set(location.origin + location.pathname, data);
    const inherited = history.state?.alcedoReader;
    const nextRecord = { ...inherited, articleURL: location.href, index: inherited?.index || 0, standalone: !inherited?.sourceURL };
    const scroll = history.state?.readerScroll ?? scrollY;
    history.replaceState({ ...history.state, alcedoReader: nextRecord, readerScroll: scroll }, '', location.href);
    history.scrollRestoration = 'manual';
    mount(data, nextRecord, null, scroll);
  }
  return {
    get active() { return active(); },
    get loading() { return Boolean(pending); },
    resize() {
      // Renderer state notifications also use this path. Sampling is only needed
      // while particles are visible, not when settling back into static reading.
      if (turn || animation) refreshGlyphs();
      if (turn) renderTurn(turn.amount);
      else if (active()) render(amount);
    },
  };
}
