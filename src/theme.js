// 只读取 Prism 的公开 DOM 状态；独立偏好保存在本脚本的 GM storage 中。
import { store } from './storage.js';

export const APPEARANCE_KEY = 'appearance';
const validTheme = (value) => value === 'light' || value === 'dark';
const preferenceOf = (value) => validTheme(value) ? value : 'system';

export function resolveAppearance({ preference, prismTheme, systemDark = false }) {
  if (validTheme(prismTheme)) return { theme: prismTheme, source: 'prism' };
  if (validTheme(preference)) return { theme: preference, source: 'manual' };
  return { theme: systemDark ? 'dark' : 'light', source: 'system' };
}

export function mountAppearance({ host, select, status, win = window, doc = document, storage = store }) {
  const roots = [];
  // 从当前页向外读取同源父框架；到达跨域边界即停止。
  let cursor = win;
  while (cursor) {
    try {
      const root = (cursor === win ? doc : cursor.document)?.documentElement;
      if (root) roots.push(root);
      if (!cursor.parent || cursor.parent === cursor) break;
      cursor = cursor.parent;
    } catch { break; }
  }
  let preference = preferenceOf(storage.get(APPEARANCE_KEY, 'system'));
  let destroyed = false;
  const media = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-color-scheme: dark)') : null;
  const prismOption = select.querySelector('option[value="prism"]');
  const readPrism = () => {
    for (const root of roots) {
      const theme = root.getAttribute('data-pku-prism-theme');
      if (root.getAttribute('data-pku-prism') === 'enabled' && validTheme(theme)) return theme;
    }
    return null;
  };
  function refresh() {
    if (destroyed) return;
    const { theme, source } = resolveAppearance({ preference, prismTheme: readPrism(), systemDark: media?.matches });
    host.setAttribute('data-theme', theme);
    host.setAttribute('data-theme-source', source);
    host.style.colorScheme = theme;
    const inherited = source === 'prism';
    if (prismOption) prismOption.hidden = !inherited;
    select.value = inherited ? 'prism' : preference;
    select.disabled = inherited;
    const label = theme === 'dark' ? '深色' : '浅色';
    status.textContent = inherited ? `${label} · 由 Prism 管理` : source === 'system' ? `当前${label} · 跟随系统` : `当前${label} · 已记住`;
    select.title = inherited ? '请在 PKU Prism 中切换主题；停用 Prism 后恢复独立偏好' : '没有启用 PKU Prism 时使用此偏好';
  }
  function change() {
    if (select.disabled) return;
    preference = preferenceOf(select.value);
    storage.set(APPEARANCE_KEY, preference);
    refresh();
  }
  const observer = typeof win.MutationObserver === 'function' ? new win.MutationObserver(refresh) : null;
  for (const root of roots) observer?.observe(root, { attributes: true, attributeFilter: ['data-pku-prism', 'data-pku-prism-theme'] });
  select.addEventListener('change', change);
  if (media?.addEventListener) media.addEventListener('change', refresh);
  else media?.addListener?.(refresh);
  win.addEventListener?.('pageshow', refresh);
  const stopStorage = storage.onChange(APPEARANCE_KEY, (value) => { preference = preferenceOf(value); refresh(); });
  refresh();
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer?.disconnect();
      select.removeEventListener?.('change', change);
      if (media?.removeEventListener) media.removeEventListener('change', refresh);
      else media?.removeListener?.(refresh);
      win.removeEventListener?.('pageshow', refresh);
      stopStorage();
    },
  };
}
