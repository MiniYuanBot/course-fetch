// 本地打包脚本冒烟用 DOM：在原 parser 假 DOM 上补充节点变更、Shadow DOM 和事件冒泡。
import { h } from './mini-dom.js';

export function uiDocument(bodyChildren = []) {
  const document = { shadowRoot: null, title: '课堂实录' };
  function element(tag, attrs = {}) {
    const node = h(tag, attrs);
    const listeners = new Map();
    const textGet = Object.getOwnPropertyDescriptor(node, 'textContent').get;
    Object.defineProperties(node, {
      className: { get: () => node.attrs.class || '', set: (value) => { node.attrs.class = value; } },
      textContent: { get: textGet, set: (value) => { node.children = []; node.childNodes = [String(value)]; } },
      lastChild: { get: () => node.childNodes.at(-1) },
      innerHTML: { set: (html) => {
        node.replaceChildren();
        const stack = [node];
        for (const token of html.match(/<[^>]*>|[^<]+/g) || []) {
          if (token.startsWith('</')) { stack.pop(); continue; }
          if (token.startsWith('<')) {
            const match = /^<([\w-]+)([\s\S]*?)\/?>(?:$)/.exec(token);
            if (!match) continue;
            const childAttrs = {};
            for (const attr of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) childAttrs[attr[1]] = attr[2] ?? '';
            const child = element(match[1], childAttrs);
            if ('hidden' in childAttrs) child.hidden = true;
            if ('disabled' in childAttrs) child.disabled = true;
            stack.at(-1).appendChild(child);
            if (!token.endsWith('/>') && !['input', 'br', 'hr', 'meta', 'img'].includes(match[1])) stack.push(child);
          } else stack.at(-1).childNodes.push(token);
        }
      } },
    });
    node.style = {};
    node.setAttribute = (name, value) => { node.attrs[name] = String(value); };
    node.dataset = new Proxy({}, {
      get: (_, key) => node.attrs[`data-${key}`],
      set: (_, key, value) => { node.attrs[`data-${key}`] = value; return true; },
    });
    node.classList = {
      contains: (name) => node.className.split(/\s+/).includes(name),
      add(name) { if (!this.contains(name)) node.className = `${node.className} ${name}`.trim(); },
      remove(name) { node.className = node.className.split(/\s+/).filter((n) => n !== name).join(' '); },
      toggle(name, force) { if (force ?? !this.contains(name)) this.add(name); else this.remove(name); },
    };
    node.appendChild = (child) => {
      if (child.fragment) { for (const item of [...child.children]) node.appendChild(item); return child; }
      child.parent = node; node.children.push(child); node.childNodes.push(child); return child;
    };
    node.replaceChildren = (...children) => {
      for (const child of node.children) child.parent = null;
      node.children = []; node.childNodes = [];
      for (const child of children) node.appendChild(child);
    };
    node.remove = () => { if (node.parent) node.parent.replaceChildren(...node.parent.children.filter((c) => c !== node)); };
    node.addEventListener = (type, cb) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(cb); };
    node.dispatch = (type, target = node) => {
      for (const cb of listeners.get(type) || []) cb({ target });
      node.parent?.dispatch?.(type, target);
    };
    node.click = () => { if (!node.disabled) node.dispatch('click'); };
    node.attachShadow = () => { document.shadowRoot = element('shadow-root'); return document.shadowRoot; };
    return node;
  }
  document.body = element('body');
  for (const child of bodyChildren) document.body.appendChild(child);
  document.querySelector = (sel) => document.body.querySelector(sel.replace(/#([\w-]+)/g, '[id="$1"]'));
  document.querySelectorAll = (sel) => document.body.querySelectorAll(sel);
  document.createElement = element;
  document.createDocumentFragment = () => Object.assign(element('fragment'), { fragment: true });
  return document;
}
