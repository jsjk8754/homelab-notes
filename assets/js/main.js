(() => {
  'use strict';
  const root = document.documentElement;
  const themeButton = document.querySelector('[data-theme-toggle]');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const applyTheme = theme => {
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === 'ink' ? '#141413' : '#eeeadf';
    themeButton.setAttribute('aria-label', theme === 'ink' ? '종이 테마로 변경' : '먹 테마로 변경');
    try { localStorage.setItem('alcedo-theme', theme); } catch { /* Storage may be disabled. */ }
    document.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
  };
  if (themeButton) {
    themeButton.hidden = false;
    applyTheme(root.dataset.theme || 'ink');
    let changing = false;
    themeButton.addEventListener('click', async event => {
      if (changing) return;
      changing = true;
      const theme = root.dataset.theme === 'ink' ? 'paper' : 'ink';
      try {
        if (document.startViewTransition && !reducedMotion.matches) {
          const rect = themeButton.getBoundingClientRect();
          const x = event.clientX || rect.left + rect.width / 2;
          const y = event.clientY || rect.top + rect.height / 2;
          const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
          const transition = document.startViewTransition(() => applyTheme(theme));
          await transition.ready;
          await root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] }, {
            duration: 560, easing: 'cubic-bezier(.22,.61,.36,1)', pseudoElement: '::view-transition-new(root)'
          }).finished;
          await transition.finished;
        } else applyTheme(theme);
      } catch { applyTheme(theme); }
      finally { changing = false; }
    });
  }
  const dialog = document.querySelector('#search-dialog');
  const input = dialog?.querySelector('[data-search-input]');
  let indexPromise;
  const loadIndex = () => {
    if (!indexPromise) {
      indexPromise = fetch(document.body.dataset.searchIndex)
        .then(response => {
          if (!response.ok) throw new Error('Search index unavailable');
          return response.json();
        })
        .catch(error => { indexPromise = undefined; throw error; });
    }
    return indexPromise;
  };
  const normalise = value => String(value || '').normalize('NFKC').toLocaleLowerCase();
  const bindSearch = container => {
    const field = container.querySelector('[data-search-input]');
    field.disabled = false;
    const status = container.querySelector('[data-search-status]');
    const list = container.querySelector('[data-search-results]');
    let revision = 0;
    const render = async () => {
      const current = ++revision;
      const query = field.value.trim();
      list.replaceChildren();
      if (!query) {
        status.textContent = '검색어를 입력하면 프로젝트와 노트를 함께 찾습니다.';
        return;
      }
      status.textContent = '기록을 찾고 있습니다…';
      try {
        const records = await loadIndex();
        if (current !== revision) return;
        const words = normalise(query).split(/\s+/);
        const matches = records.filter(record => {
          const haystack = normalise([record.title, record.summary, record.content, ...(record.tags || [])].join(' '));
          return words.every(word => haystack.includes(word));
        }).sort((a,b) => Number(normalise(b.title).includes(normalise(query))) - Number(normalise(a.title).includes(normalise(query))));
        status.textContent = matches.length ? `“${query}”에 관한 기록 ${matches.length}개` : `“${query}”에 관한 기록이 없습니다. 다른 검색어를 입력해 보세요.`;
        for (const record of matches.slice(0,30)) {
          const url = new URL(record.url, location.href);
          if (url.origin !== location.origin) continue;
          const li = document.createElement('li');
          const link = document.createElement('a');
          link.href = url.href;
          const section = document.createElement('span'); section.textContent = record.section;
          const title = document.createElement('strong'); title.textContent = record.title;
          const description = document.createElement('p'); description.textContent = record.summary;
          link.append(section,title,description); li.append(link); list.append(li);
        }
      } catch {
        if (current === revision) status.textContent = '검색 자료를 불러오지 못했습니다. 다시 입력하거나 Projects·Notes 목록을 이용해 주세요.';
      }
    };
    field.addEventListener('input',render);
    field.addEventListener('keydown',event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); list.querySelector('a')?.focus(); }
      if (event.key === 'Enter') { event.preventDefault(); list.querySelector('a')?.click(); }
    });
    return render;
  };
  if (dialog && typeof dialog.showModal === 'function') {
    bindSearch(dialog);
    const openSearch = () => { if (!dialog.open) dialog.showModal(); input.focus(); };
    document.querySelectorAll('[data-search-open]').forEach(link => link.addEventListener('click',event => { event.preventDefault(); openSearch(); }));
    dialog.querySelector('[data-search-close]').addEventListener('click',() => dialog.close());
    dialog.addEventListener('click',event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    document.addEventListener('keydown',event => {
      const editing = event.target.isContentEditable || event.target.closest('input, textarea, select');
      if (((event.code === 'KeyK' || event.key.toLowerCase() === 'k') && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !editing && !event.metaKey && !event.ctrlKey && !event.altKey)) {
        event.preventDefault(); openSearch();
      }
    });
  }
  const searchPage = document.querySelector('[data-search-page]');
  if (searchPage) {
    const render = bindSearch(searchPage);
    const query = new URLSearchParams(location.search).get('q');
    if (query) { searchPage.querySelector('[data-search-input]').value = query; render(); }
  }
  document.querySelectorAll('.prose table').forEach(table => {
    const wrapper = document.createElement('div'); wrapper.className = 'table-scroll';
    wrapper.tabIndex = 0; wrapper.setAttribute('role','region'); wrapper.setAttribute('aria-label','표, 가로로 스크롤할 수 있습니다');
    table.before(wrapper); wrapper.append(table);
  });
  if (navigator.clipboard?.writeText) {
    document.querySelectorAll('.prose .highlight').forEach(block => {
      const code = block.querySelector('pre code'); if (!code) return;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'code-copy'; button.textContent = '복사'; button.setAttribute('aria-label','코드 복사');
      button.addEventListener('click',async () => {
        try { await navigator.clipboard.writeText(code.textContent); button.textContent = '복사됨'; }
        catch { button.textContent = '직접 선택해 복사'; }
        setTimeout(() => { button.textContent = '복사'; },2200);
      });
      block.append(button);
    });
    document.querySelectorAll('[data-copy-link]').forEach(button => {
      button.hidden = false;
      button.addEventListener('click',async () => {
        const status = document.querySelector('[data-copy-status]');
        try { await navigator.clipboard.writeText(document.querySelector('link[rel="canonical"]').href); status.textContent = '글 주소를 복사했습니다.'; }
        catch { status.textContent = '주소창에서 글 주소를 복사해 주세요.'; }
      });
    });
  }
})();
