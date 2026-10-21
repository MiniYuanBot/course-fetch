// 教学网页面：课堂实录 DOM 提取、分页、课程名识别、定位播放列表。

import { normalizeText, parseRows, dedupeAndSort } from './parser.js';
import { abortError } from './downloader.js';
import { capturePlaylist } from './capture.js';

export function resolveUrl(href, base) {
  const h = String(href || '').trim();
  if (!h || h === '#' || /^javascript:/i.test(h)) return null;
  try {
    const u = new URL(h, base);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch (_) {
    return null;
  }
}

/** 优先用 href；若是 javascript:/onclick 形式，尝试从中提取一个 URL。 */
function linkTarget(a, base) {
  const href = a.getAttribute('href');
  const direct = resolveUrl(href, base);
  if (direct) return direct;
  const src = `${href || ''} ${a.getAttribute('onclick') || ''}`;
  const m = /['"]([^'"\s]+\.(?:action|do|jsp|php|html?)(?:\?[^'"\s]*)?)['"]/i.exec(src);
  return m ? resolveUrl(m[1], base) : null;
}

// 注意：教学网（Blackboard）加载了 Prototype.js，它把全局 Array.from 替换成只接受一个参数的 $A，
// Array.from(list, mapFn) 的 mapFn 会被静默忽略。因此处理 DOM 集合时一律用普通循环。
function toList(collection) {
  const out = [];
  if (collection) for (let i = 0; i < collection.length; i++) out.push(collection[i]);
  return out;
}

function textOf(node) {
  return node && typeof node.textContent === 'string' ? normalizeText(node.textContent) : '';
}

/** 通用 fallback：各单元格文本以空格拼接。 */
function rowText(tr) {
  const cells = toList(tr.cells || tr.children);
  if (cells.length) return cells.map(textOf).join(' ');
  return textOf(tr);
}

/**
 * 按教学网实际 DOM 分列提取：
 *   th[scope="row"]                → 名称（日期/节次）
 *   td .table-data-cell-value [0]  → 开始时间
 *   td .table-data-cell-value [1]  → 教师
 * 播放链接由调用方按“观看”或“预览”识别。
 * 结构不符时返回 null，由调用方走通用 fallback。
 */
function extractCols(tr) {
  if (typeof tr.querySelector !== 'function') return null;
  const th = tr.querySelector('th[scope="row"]');
  const values = toList(tr.querySelectorAll('td .table-data-cell-value'));
  if (!th || values.length < 2) return null;
  return {
    title: textOf(th), startTime: textOf(values[0]), teacher: textOf(values[1]),
  };
}

/** 仅识别下一页按钮，支持图片和文字形式。 */
function isNextPage(a, label) {
  const id = a.getAttribute('id') || '';
  if (a.getAttribute('aria-disabled') === 'true') return false;

  if (/(?:^|_)nextpage(?:_|$)/i.test(id)) return true;
  if ((a.getAttribute('rel') || '').toLowerCase().split(/\s+/).includes('next')) return true;
  const labels = [label, a.getAttribute('title'), a.getAttribute('aria-label')];
  if (typeof a.querySelectorAll === 'function') {
    for (const img of toList(a.querySelectorAll('img'))) labels.push(img.getAttribute('alt'));
  }
  return labels.some((s) => /^(下一页|next(?:\s+page)?)$/i.test(normalizeText(s)));
}

/**
 * 从一个 Document 中提取“观看”/“预览”行和“下一页”链接。
 * 只依赖 querySelectorAll / getAttribute / closest / textContent，测试中可用假对象。
 */
export function extractPage(doc, baseUrl) {
  const rows = [];
  const issues = [];
  let next = null;
  for (const a of toList(doc.querySelectorAll('a'))) {
    const label = textOf(a);
    if (label === '观看' || label === '预览') {
      const tr = a.closest ? a.closest('tr') : null;
      if (!tr) {
        issues.push(`有一个“${label}”链接不在表格行内，已跳过`);
        continue;
      }
      const cols = extractCols(tr);
      if (cols) rows.push({ cols, watchUrl: linkTarget(a, baseUrl) });
      else rows.push({ text: rowText(tr), watchUrl: linkTarget(a, baseUrl) });
    } else if ((!next || !next.url) && isNextPage(a, label)) {
      next = { url: linkTarget(a, baseUrl), hasHref: a.getAttribute('href') != null };
    }
  }
  return { rows, next, issues };
}

/**
 * 从第一页开始沿“下一页”翻页，汇总、解析、去重。
 * fetchDoc(url) => Promise<Document>，由调用方注入（浏览器用 fetch，测试用假对象）。
 * 末页没有下一页按钮；visited 和 maxPages 防止异常分页造成循环。
 */
export async function crawlCourse({ firstDoc, firstUrl, fetchDoc, maxPages = 50, onProgress = () => { } }) {
  const stripHash = (u) => String(u).split('#')[0];
  const warnings = [];
  const rows = [];
  const visited = new Set([stripHash(firstUrl)]);
  let pageNo = 1;
  const addPage = (pg, n) => {
    for (const r of pg.rows) {
      rows.push({ ...r, page: n });
    }
    pg.issues.forEach((msg) => warnings.push(`第 ${n} 页：${msg}`));
  };

  let page = extractPage(firstDoc, firstUrl);
  addPage(page, 1);

  while (page.next) {
    if (!page.next.url) {
      if (page.next.hasHref) {
        warnings.push(`第 ${pageNo} 页的翻页链接是脚本跳转，无法自动请求；只收集到前 ${pageNo} 页`);
      }
      break; // 没有 href 通常表示已经是最后一页
    }
    const url = stripHash(page.next.url);
    if (visited.has(url)) {
      warnings.push('翻页链接指向已读取过的页面，停止翻页');
      break;
    }
    if (pageNo >= maxPages) {
      warnings.push(`已达到最大页数 ${maxPages}，停止翻页`);
      break;
    }
    visited.add(url);
    onProgress(`正在读取第 ${pageNo + 1} 页…`);
    let doc;
    try {
      doc = await fetchDoc(url);
    } catch (e) {
      warnings.push(`读取第 ${pageNo + 1} 页失败（${e.message}），已保留前 ${pageNo} 页的结果`);
      break;
    }
    pageNo += 1;
    page = extractPage(doc, url);
    if (!page.rows.length) warnings.push(`第 ${pageNo} 页没有找到“观看”或“预览”条目（登录可能已过期）`);
    addPage(page, pageNo);
  }

  const { entries, failures } = parseRows(rows);
  const { entries: sorted, duplicates } = dedupeAndSort(entries);

  failures.forEach((f) => warnings.push(`第 ${f.page} 页：${f.error}：“${f.text.slice(0, 60)}”`));
  if (duplicates.length) warnings.push(`发现 ${duplicates.length} 条重复录像，已合并`);
  if (!rows.length) warnings.push('当前页面没有找到文本为“观看”或“预览”的链接');

  const status =
    `共 ${pageNo} 页，${sorted.length} 条录像` + (failures.length ? `，${failures.length} 行解析失败` : '');
  return { entries: sorted, duplicates, failures, warnings, pages: pageNo, status };
}

// ---- 播放页 ------------------------------------------------------------------

/**
 * 找到 playlist.m3u8：打开临时播放页自动捕获（见 capture.js）；超时后才请用户手动粘贴。
 * 不再猜测 playVideo 页面或其 iframe 的 HTML。
 */
export async function locatePlaylist(watchUrl, { signal, capture = capturePlaylist, ask = askPlaylistUrl, allowManual = true } = {}) {
  try {
    return await capture({ watchUrl, signal });
  } catch (e) {
    if (e.name !== 'CaptureTimeout' || !allowManual) throw e;
    console.warn(`[Course Fetch] ${e.message}，改为手动输入`);
  }
  if (signal && signal.aborted) throw abortError();
  return ask();
}

function askPlaylistUrl() {
  const manual = prompt(
    '自动捕获播放列表超时。\n' +
    '可以打开该录像的播放页，按 F12 → Network 搜索 “m3u8”，复制请求地址粘贴到这里：',
  );
  if (manual && /^https?:\/\/\S+\.m3u8/i.test(manual.trim())) return manual.trim();
  if (manual === null) throw abortError();
  throw new Error('未找到 playlist.m3u8');
}

// ---- 浏览器端：当前页面 ---------------------------------------------------------

export function detectCourseName() {
  const docs = [document];
  for (const w of [window.parent, window.top]) {
    try {
      if (w && w !== window && w.document && !docs.includes(w.document)) docs.push(w.document);
    } catch (_) {
      /* 跨域 frame，忽略 */
    }
  }
  const selectors = [
    '.path .coursePath #crumb_1',
    '#courseMenu_link',
    '.courseName',
    '.course-name',
    '#crumb_1',
  ];
  // 课程面包屑可能在父级 frame；先跨文档查同一选择器，避免当前页侧栏抢先命中。
  for (const sel of selectors) {
    for (const d of docs) {
      const el = d.querySelector(sel);
      if (!el) continue;
      const txt = normalizeText(el.textContent) || normalizeText(el.getAttribute('title'));
      if (txt && txt.length <= 80) return txt;
    }
  }
  for (const d of docs) {
    const body = normalizeText(d.body && d.body.textContent).slice(0, 5000);
    const m = /课程名称\s*[:：]\s*([^\s|]+)/.exec(body);
    if (m) return m[1];
  }
  for (const d of docs) {
    const title = normalizeText(d.title);
    if (title && !/^(课堂实录|教学网|Blackboard|北京大学)/i.test(title)) return title;
  }
  return '';
}

/** 同源请求分页 HTML，按响应头或 <meta charset> 解码（教学网部分页面是 GBK）。 */
export async function fetchDocument(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const headerCharset = (/charset=([\w-]+)/i.exec(res.headers.get('content-type') || '') || [])[1];
  const decode = (cs) => {
    try {
      return new TextDecoder(cs).decode(buf);
    } catch (_) {
      return null;
    }
  };
  let html = decode(headerCharset || document.characterSet || 'utf-8') || decode('utf-8');
  if (!headerCharset) {
    const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(html.slice(0, 4096));
    if (meta && meta[1].toLowerCase() !== String(document.characterSet).toLowerCase()) {
      html = decode(meta[1]) || html;
    }
  }
  return new DOMParser().parseFromString(html, 'text/html');
}
