// SPDX-License-Identifier: AGPL-3.0-or-later
// Small DOM helpers: element builder, dialogs, menus, toasts.

export const $ = (id) => document.getElementById(id);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) el.append(child.nodeType ? child : String(child));
  return el;
}

export function icon(name) {
  const paths = {
    verify: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
    upload: 'M12 4l-1.4 1.4 5.6 5.6H4v2h12.2l-5.6 5.6L12 20l8-8z',
    monitor: 'M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 15.5l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z',
    plotter: 'M3 17h2v-5H3v5zm4 0h2V7H7v10zm4 0h2v-8h-2v8zm4 0h2V4h-2v13zm4 0h2v-3h-2v3zM3 19h18v2H3z',
    sketchbook: 'M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z',
    boards: 'M15 9H9v6h6V9zm-2 4h-2v-2h2v2zm8-2V9h-2V7a2 2 0 0 0-2-2h-2V3h-2v2h-2V3H9v2H7a2 2 0 0 0-2 2v2H3v2h2v2H3v2h2v2a2 2 0 0 0 2 2h2v2h2v-2h2v2h2v-2h2a2 2 0 0 0 2-2v-2h2v-2h-2v-2h2zm-4 6H7V7h10v10z',
    libraries: 'M4 6H2v14a2 2 0 0 0 2 2h14v-2H4V6zm16-4H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-1 9H9V9h10v2zm-4 4H9v-2h6v2zm4-8H9V5h10v2z',
    search: 'M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z',
    close: 'M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z',
    chevron: 'M7 10l5 5 5-5z',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name]);
  svg.append(path);
  return svg;
}

// Modal dialog. actions: [{label, value, primary}] -> resolves with value (or undefined on cancel).
export function dialog({ title, body, actions = [{ label: 'Close', value: undefined }], wide = false, onOpen }) {
  const el = $('dialog');
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      el.close();
      resolve(value);
    };
    const form = h('form', { method: 'dialog', class: wide ? 'dialog wide' : 'dialog', onsubmit: (e) => { e.preventDefault(); const primary = actions.find((a) => a.primary); if (primary) done(typeof primary.value === 'function' ? primary.value() : primary.value); } },
      h('header', {}, h('h2', {}, title), h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Close', onclick: () => done(undefined) }, icon('close'))),
      h('div', { class: 'dialog-body' }, body),
      actions.length ? h('footer', {}, actions.map((a) => h('button', { type: a.primary ? 'submit' : 'button', class: a.primary ? 'primary' : '', onclick: a.primary ? undefined : () => done(typeof a.value === 'function' ? a.value() : a.value) }, a.label))) : null,
    );
    el.replaceChildren(form);
    el.onclose = () => done(undefined);
    el.showModal();
    onOpen?.(el, done);
    el.querySelector('input:not([type=checkbox]),select,textarea')?.focus();
  });
}

export async function askText(title, label, value = '', validate = () => '') {
  const input = h('input', { value, spellcheck: false });
  const error = h('p', { class: 'error' });
  input.oninput = () => (error.textContent = validate(input.value.trim()));
  for (;;) {
    const result = await dialog({ title, body: [h('label', {}, label, input), error], actions: [{ label: 'Cancel' }, { label: 'OK', primary: true, value: () => input.value.trim() }] });
    if (result === undefined) return undefined;
    const message = validate(result);
    if (!message) return result;
    error.textContent = message;
    value = result;
    input.value = result;
  }
}

export const confirmDialog = (title, message, label = 'OK') => dialog({ title, body: h('p', {}, message), actions: [{ label: 'Cancel' }, { label, primary: true, value: true }] });

let toastTimer;
export function toast(message, kind = 'info') {
  const el = $('toast');
  el.textContent = message;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), kind === 'error' ? 7000 : 3500);
}

// Menu bar with nested submenus. Items: {label, action, shortcut, checked, disabled, submenu: () => items} or '-'.
export function createMenubar(root, menus) {
  let open = null;
  const closeAll = () => {
    document.querySelectorAll('.menu-popup').forEach((p) => p.remove());
    root.querySelectorAll('.active').forEach((b) => b.classList.remove('active'));
    open = null;
  };
  const popup = (items, x, y, level = 0) => {
    document.querySelectorAll('.menu-popup').forEach((p) => Number(p.dataset.level) >= level && p.remove());
    const el = h('div', { class: 'menu-popup', role: 'menu', 'data-level': level });
    for (const item of items) {
      if (item === '-') { el.append(h('div', { class: 'menu-separator' })); continue; }
      const row = h('button', { class: 'menu-item', role: 'menuitem', disabled: item.disabled },
        h('span', { class: 'check' }, item.checked ? '✓' : ''),
        h('span', { class: 'label' }, item.label),
        h('span', { class: 'shortcut' }, item.submenu ? '▸' : item.shortcut || ''));
      if (item.submenu) {
        const show = () => {
          const rect = row.getBoundingClientRect();
          const sub = item.submenu();
          popup(sub.length ? sub : [{ label: '(empty)', disabled: true }], rect.right - 2, rect.top - 4, level + 1);
        };
        row.addEventListener('mouseenter', show);
        row.addEventListener('click', (e) => { e.stopPropagation(); show(); });
      } else {
        row.addEventListener('mouseenter', () => document.querySelectorAll('.menu-popup').forEach((p) => Number(p.dataset.level) > level && p.remove()));
        row.addEventListener('click', (e) => { e.stopPropagation(); closeAll(); item.action?.(); });
      }
      el.append(row);
    }
    document.body.append(el);
    const rect = el.getBoundingClientRect();
    el.style.left = Math.max(0, Math.min(x, innerWidth - rect.width - 4)) + 'px';
    el.style.top = Math.max(0, Math.min(y, innerHeight - rect.height - 4)) + 'px';
    return el;
  };
  for (const menu of menus) {
    const button = h('button', { class: 'menubar-item' }, menu.label);
    const show = () => {
      closeAll();
      open = menu;
      button.classList.add('active');
      const rect = button.getBoundingClientRect();
      popup(menu.items(), rect.left, rect.bottom);
    };
    button.addEventListener('click', (e) => { e.stopPropagation(); open === menu ? closeAll() : show(); });
    button.addEventListener('mouseenter', () => open && open !== menu && show());
    root.append(button);
  }
  document.addEventListener('click', closeAll);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeAll());
  return { popup, closeAll };
}

export function download(name, data, type = 'application/octet-stream') {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
