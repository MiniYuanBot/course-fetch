import test from 'node:test';
import assert from 'node:assert/strict';
import { APPEARANCE_KEY, mountAppearance, resolveAppearance } from '../src/theme.js';

class Element extends EventTarget {
  attrs = new Map();
  style = {};
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  setAttribute(name, value) { this.attrs.set(name, value); }
  removeAttribute(name) { this.attrs.delete(name); }
}

function fixture(preference = 'system', systemDark = false, ancestors = []) {
  const root = new Element(), host = new Element(), select = new Element(), status = new Element();
  const option = {};
  select.querySelector = () => option;
  const media = new EventTarget();
  media.matches = systemDark;
  let notifyMutation, disconnected = false, storageListener;
  const observed = [], writes = [];
  const win = new EventTarget();
  win.matchMedia = () => media;
  win.MutationObserver = class {
    constructor(callback) { notifyMutation = callback; }
    observe(root, options) { observed.push({ root, options }); }
    disconnect() { disconnected = true; }
  };
  let parent = win;
  for (const ancestor of ancestors) { parent.parent = ancestor; parent = ancestor; }
  if (!ancestors.length) win.parent = win;
  const storage = {
    get(key, fallback) { assert.equal(key, APPEARANCE_KEY); return preference ?? fallback; },
    set(key, value) { writes.push([key, value]); },
    onChange(key, callback) {
      assert.equal(key, APPEARANCE_KEY);
      storageListener = callback;
      return () => { storageListener = null; };
    },
  };
  const controller = mountAppearance({ host, select, status, win, doc: { documentElement: root }, storage });
  return {
    root, host, select, status, media, observed, writes, option, controller,
    get disconnected() { return disconnected; },
    get storageListener() { return storageListener; },
    mutation() { notifyMutation(); },
    remote(value) { storageListener(value); },
    choose(value) { select.value = value; select.dispatchEvent(new Event('change')); },
    system(dark) { media.matches = dark; media.dispatchEvent(new Event('change')); },
    theme: () => host.getAttribute('data-theme'),
    source: () => host.getAttribute('data-theme-source'),
  };
}
function prism(root, theme = 'dark') {
  root.setAttribute('data-pku-prism', 'enabled');
  root.setAttribute('data-pku-prism-theme', theme);
}

test('主题优先级：有效 Prism > 独立浅深色 > 系统；无效偏好和属性安全回退', () => {
  assert.deepEqual(resolveAppearance({ preference: 'light', prismTheme: 'dark' }), { theme: 'dark', source: 'prism' });
  assert.deepEqual(resolveAppearance({ preference: 'dark', systemDark: false }), { theme: 'dark', source: 'manual' });
  assert.deepEqual(resolveAppearance({ preference: 'broken', prismTheme: 'broken', systemDark: true }), { theme: 'dark', source: 'system' });
  const f = fixture('broken');
  assert.equal(f.select.value, 'system');
  assert.equal(f.theme(), 'light');
  f.controller.destroy();
});

test('没有 Prism 时选择立即生效、持久化、跨标签页同步；系统变化不覆盖手动选择', () => {
  const f = fixture();
  f.system(true);
  assert.equal(f.theme(), 'dark');
  f.choose('light');
  assert.equal(f.theme(), 'light');
  assert.deepEqual(f.writes, [[APPEARANCE_KEY, 'light']]);
  f.system(false); f.system(true);
  assert.equal(f.theme(), 'light');
  f.remote('dark');
  assert.equal(f.theme(), 'dark');
  assert.equal(f.select.value, 'dark');
  f.remote('system');
  f.system(false);
  assert.equal(f.theme(), 'light');
  assert.equal(f.source(), 'system');
  f.controller.destroy();
});

test('Prism 动态启停和切换：继承时锁定控件，不覆盖独立偏好，停用立即恢复', () => {
  const f = fixture('light');
  prism(f.root); f.mutation();
  assert.equal(f.theme(), 'dark');
  assert.equal(f.source(), 'prism');
  assert.equal(f.select.value, 'prism');
  assert.equal(f.select.disabled, true);
  assert.equal(f.option.hidden, false);
  assert.match(f.status.textContent, /由 Prism 管理/);
  f.choose('dark'); // disabled 控件不能改写后备偏好
  assert.deepEqual(f.writes, []);
  f.root.setAttribute('data-pku-prism-theme', 'light'); f.mutation();
  assert.equal(f.theme(), 'light');
  f.remote('dark'); // 其他标签页更新独立偏好，不抢占 Prism
  assert.equal(f.theme(), 'light');
  f.root.removeAttribute('data-pku-prism'); f.mutation();
  assert.equal(f.theme(), 'dark');
  assert.equal(f.select.disabled, false);
  assert.equal(f.select.value, 'dark');
  assert.equal(f.option.hidden, true);
  assert.deepEqual(f.observed[0].options.attributeFilter, ['data-pku-prism', 'data-pku-prism-theme']);
  f.controller.destroy();
});

test('同源父页面可继承，当前页面优先；不访问跨域父页面内容', () => {
  const parentRoot = new Element(); prism(parentRoot);
  const parent = { document: { documentElement: parentRoot } }; parent.parent = parent;
  const f = fixture('light', false, [parent]);
  assert.equal(f.theme(), 'dark');
  assert.equal(f.observed.length, 2);
  prism(f.root, 'light'); f.mutation();
  assert.equal(f.theme(), 'light');
  f.controller.destroy();
  const crossOrigin = { get document() { throw new Error('SecurityError'); } };
  const isolated = fixture('dark', false, [crossOrigin]);
  assert.equal(isolated.theme(), 'dark');
  assert.equal(isolated.source(), 'manual');
  isolated.controller.destroy();
});

test('销毁后清理观察与监听，重复销毁安全', () => {
  const f = fixture();
  f.controller.destroy(); f.controller.destroy();
  assert.equal(f.disconnected, true);
  assert.equal(f.storageListener, null);
  f.choose('dark'); f.system(true); prism(f.root); f.mutation();
  assert.equal(f.theme(), 'light');
  assert.deepEqual(f.writes, []);
});
