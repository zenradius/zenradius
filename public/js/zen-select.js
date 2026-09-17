/**
 * ZenRadius Custom Select
 * Mengubah <select class="fs"> menjadi dropdown melayang bergaya .lang-menu.
 * Native <select> tetap ada (hidden) & tersinkron → form/onchange tetap berjalan.
 */
(function () {
  const SKIP_ATTR = 'data-native';

  function build(select) {
    if (select.dataset.zsReady || select.hasAttribute(SKIP_ATTR) || select.multiple) return;
    select.dataset.zsReady = '1';

    const wrap = document.createElement('div');
    wrap.className = 'zs';
    // salin ukuran inline (width/max-width) dari select ke wrapper
    if (select.style.width) wrap.style.width = select.style.width;
    if (select.style.maxWidth) wrap.style.maxWidth = select.style.maxWidth;
    if (select.style.minWidth) wrap.style.minWidth = select.style.minWidth;
    if (select.style.flex) wrap.style.flex = select.style.flex;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'zs-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    if (select.disabled) btn.disabled = true;

    const label = document.createElement('span');
    label.className = 'zs-label';
    const chev = document.createElement('i');
    chev.className = 'bi bi-chevron-down zs-chev';
    btn.appendChild(label);
    btn.appendChild(chev);

    const menu = document.createElement('div');
    menu.className = 'zs-menu';
    menu.setAttribute('role', 'listbox');

    function renderItems() {
      menu.innerHTML = '';
      Array.from(select.options).forEach((opt, idx) => {
        const item = document.createElement('div');
        item.className = 'zs-item' + (opt.selected ? ' active' : '') + (opt.disabled ? ' disabled' : '');
        item.setAttribute('role', 'option');
        item.dataset.index = String(idx);
        item.innerHTML = '<span class="zs-item-text"></span><i class="bi bi-check2 zs-check"></i>';
        item.querySelector('.zs-item-text').textContent = opt.textContent.trim();
        if (!opt.disabled) {
          item.addEventListener('click', (e) => {
            e.stopPropagation();
            select.selectedIndex = idx;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            sync();
            close();
          });
        }
        menu.appendChild(item);
      });
    }

    function sync() {
      const opt = select.options[select.selectedIndex];
      label.textContent = opt ? opt.textContent.trim() : '';
      label.classList.toggle('placeholder', !!opt && opt.value === '');
      menu.querySelectorAll('.zs-item').forEach((el) => {
        el.classList.toggle('active', Number(el.dataset.index) === select.selectedIndex);
      });
      btn.disabled = select.disabled;
    }

    function open() {
      document.querySelectorAll('.zs.open').forEach((z) => z !== wrap && (z._zsClose ? z._zsClose() : z.classList.remove('open')));
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      positionMenu();
      const act = menu.querySelector('.zs-item.active');
      if (act) act.scrollIntoView({ block: 'nearest' });
    }
    function close() {
      wrap.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      menu.classList.remove('zs-menu-open', 'zs-menu-up');
      menu.style.maxHeight = '';
      menu.style.top = '';
      menu.style.left = '';
      menu.style.width = '';
      menu.style.bottom = '';
      menu.style.opacity = '';
      menu.style.pointerEvents = '';
    }
    function positionMenu() {
      if (!wrap.classList.contains('open')) return;
      const r = btn.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom;
      const spaceAbove = r.top;
      const openUp = spaceBelow < 260 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(140, Math.min(280, (openUp ? spaceAbove : spaceBelow) - 16));
      menu.classList.toggle('zs-menu-up', openUp);
      menu.classList.add('zs-menu-open');
      menu.style.maxHeight = `${maxHeight}px`;
      menu.style.top = openUp ? 'auto' : `${r.bottom + 8}px`;
      menu.style.bottom = openUp ? `${window.innerHeight - r.top + 8}px` : 'auto';
      menu.style.left = `${r.left}px`;
      menu.style.width = `${Math.max(r.width, 160)}px`;
      menu.style.opacity = '1';
      menu.style.pointerEvents = 'auto';
    }

    wrap._zsPosition = positionMenu;
    wrap._zsClose = close;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      wrap.classList.contains('open') ? close() : open();
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        let i = select.selectedIndex;
        do { i = (i + dir + select.options.length) % select.options.length; } while (select.options[i].disabled);
        select.selectedIndex = i;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        sync();
      } else if (e.key === 'Escape') close();
    });

    // Sinkron saat select diubah dari JS lain (mis. fetch data → isi ulang option)
    select.addEventListener('change', sync);
    const mo = new MutationObserver(() => { renderItems(); sync(); });
    mo.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

    // form reset
    if (select.form) select.form.addEventListener('reset', () => setTimeout(sync, 0));

    wrap.appendChild(btn);
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    menu.classList.add('zs-menu-portal');
    document.body.appendChild(menu);
    select.classList.add('zs-native');
    select.tabIndex = -1;

    renderItems();
    sync();
  }

  function init(root) {
    (root || document).querySelectorAll('select.fs').forEach(build);
  }

  document.addEventListener('click', () => {
    document.querySelectorAll('.zs.open').forEach((z) => z._zsClose ? z._zsClose() : z.classList.remove('open'));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.zs.open').forEach((z) => z._zsClose ? z._zsClose() : z.classList.remove('open'));
  });
  window.addEventListener('resize', () => {
    document.querySelectorAll('.zs.open').forEach((z) => z._zsPosition && z._zsPosition());
  });
  window.addEventListener('scroll', () => {
    document.querySelectorAll('.zs.open').forEach((z) => z._zsPosition && z._zsPosition());
  }, true);

  // select yang ditambahkan dinamis (modal, tabel) ikut di-enhance
  const bodyObs = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        if (n.matches && n.matches('select.fs')) build(n);
        else if (n.querySelectorAll) init(n);
      });
    }
  });

  function start() {
    init();
    bodyObs.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.ZenSelect = { init, build };
})();
