// 界面：Shadow DOM 面板、列表渲染、下载进度、事件绑定。业务动作由 main.js 通过 actions 注入。

import {
  DEFAULT_TEMPLATE, entryKey, buildListText, applyExclusions, parseDateRanges, matchesDateRanges,
  holidayRanges, collectExclusions,
} from './parser.js';
import { store } from './storage.js';
import { batchProgress, isTaskFinished } from './batch.js';
import { mountAppearance } from './theme.js';
import PANEL_CSS from './ui.css';

const PANEL_HTML = `
  <style>${PANEL_CSS}</style>
  <div class="cf" role="region" aria-label="Course Fetch 录像工具">
    <button type="button" class="hd" aria-expanded="false" aria-controls="cf-body">
      <svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4"/></svg>
      <b>Course Fetch</b><span class="count"></span>
      <span class="arrow"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>
    </button>
    <div class="bd" id="cf-body">
      <label><span>课程</span><input type="text" class="course"></label>
      <label><span>命名模板</span><input type="text" class="tpl"><button class="reset-tpl">重置</button></label>
      <details class="template-help"><summary>模板变量说明</summary>
      <div class="hint">变量：{index:02d}, {date}, {YYYY}, {YY}, {MM}, {DD}, {periodStart}, {periodEnd}, {teacher}, {time}, {startTime}</div>
      <div class="hint">课程：{course} 完整名称, {courseName} 课程名, {academicYear} 学年（如 24-25）, {semester} 学期（如 1）</div>
      </details>
      <div class="preferences">
      <label><span>输出格式</span><select class="fmt"><option value="mp4">MP4（无损转封装，推荐）</option><option value="ts">TS（原始流）</option></select></label>
      <div class="appearance">
        <label><span>外观</span><select class="theme" aria-describedby="cf-theme-source">
          <option value="prism" hidden>跟随 PKU Prism</option>
          <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
        </select></label>
        <span class="theme-source" id="cf-theme-source" role="status"></span>
      </div>
      </div>
      <details class="excl-box">
        <summary class="excl-sum">排除日期</summary>
        <div class="excl-bd">
          <div class="excl-rows"></div>
          <div class="holidays"></div>
        </div>
      </details>
      <div class="bar">
        <button data-act="scan">重新扫描</button>
        <button data-act="all">全选</button>
        <button data-act="none">全不选</button>
        <button data-act="open">打开选中</button>
        <button data-act="copy">复制清单</button>
        <button data-act="export">导出 JSON</button>
        <button class="primary" data-act="download">下载选中</button>
      </div>
      <div class="dl" hidden>
        <div class="dl-top"><span class="dl-name"></span><button class="dl-cancel">取消</button></div>
        <div class="dl-bar"><div class="dl-fill"></div></div>
        <div class="dl-l1"></div>
        <div class="dl-l2"></div>
        <div class="dl-warn" hidden></div>
        <div class="dl-note" hidden></div>
      </div>
      <div class="status" role="status" aria-live="polite"></div>
      <details class="warn" hidden><summary></summary><ul></ul></details>
      <div class="tbl"><table>
        <thead><tr><th><input type="checkbox" class="chk-all" aria-label="选择全部可用录像"></th><th>#</th><th>文件名</th><th>开始时间</th><th>教师</th><th>操作</th></tr></thead>
        <tbody></tbody>
      </table></div>
    </div>
  </div>`;

const PHASE_LABEL = {
  pick: '选择保存目录',
  locate: '打开播放页，自动捕获播放列表',
  download: '下载中',
  finish: '写入文件',
  file: '创建文件',
  queued: '排队中',
};

export function formatBytes(n) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/**
 * 创建面板并挂到页面上。
 * actions: { scan, openEntries, exportManifest, downloadEntry, cancelDownload }
 * outputNameOf(entry)：带实际输出扩展名（.mp4 / .ts）的文件名
 * 返回 { render, setStatus, flash, updateDownloadUI, destroy }
 */
export function createUI({ state, courseId, filenameOf, outputNameOf = filenameOf, actions }) {
  const host = document.createElement('div');
  host.id = 'course-fetch-host';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = PANEL_HTML;
  document.body.appendChild(host);

  const $ = (sel) => root.querySelector(sel);
  const ui = {
    panel: $('.cf'),
    count: $('.count'),
    course: $('.course'),
    tpl: $('.tpl'),
    fmt: $('.fmt'),
    exclSummary: $('.excl-sum'),
    exclRows: $('.excl-rows'),
    holidays: $('.holidays'),
    status: $('.status'),
    warn: $('.warn'),
    tbody: $('tbody'),
    chkAll: $('.chk-all'),
    dl: {
      root: $('.dl'),
      name: $('.dl-name'),
      cancel: $('.dl-cancel'),
      bar: $('.dl-bar'),
      fill: $('.dl-fill'),
      l1: $('.dl-l1'),
      l2: $('.dl-l2'),
      warn: $('.dl-warn'),
      note: $('.dl-note'),
    },
  };

  const appearance = mountAppearance({ host, select: $('.theme'), status: $('.theme-source') });

  const selectedEntries = () => state.entries.filter((e) => state.selected.has(entryKey(e)));
  // 被排除的条目不可勾选、不参与编号，相关计数一律以它为准
  const selectableEntries = () => state.entries.filter((e) => !e.excluded);

  /** 当前的排除映射：entryKey → 命中的节假日标签名（手动排除的为 ''）。 */
  const exclusionsOf = (entries) =>
    collectExclusions(entries, state.excluded, holidayRanges(state.holidays));

  /** 按手动排除 + 节假日标签重算编号；被排除项移出勾选。 */
  function applyExcluded() {
    const labels = exclusionsOf(state.entries);
    state.entries = applyExclusions(state.entries, new Set(labels.keys()));
    for (const e of state.entries) if (e.excluded) state.selected.delete(entryKey(e));
  }

  /** 更新本课程的手动排除集合：记住、重算、重绘。 */
  function setExcluded(next) {
    state.excluded = next;
    const keys = [...next];
    if (keys.length) store.set(`excluded:${courseId}`, keys);
    else store.delete(`excluded:${courseId}`);
    applyExcluded();
    render();
  }

  /** 更新全局节假日标签：记住、重算、重绘。 */
  function setHolidays(next) {
    state.holidays = next;
    if (next.length) store.set('holidays', next);
    else store.delete('holidays');
    applyExcluded();
    render();
  }

  // 「排除日期」里可增删的日期行，每行各自处理。只活在面板内存里，不落存储——要长期保留的是标签。
  let exclLines = [''];
  let nameFor = null; // 正在填标签名的那一行的下标
  let tagName = '';

  let flashTimer = null;
  function setStatus(msg) {
    state.status = msg;
    render();
  }
  function flash(msg) {
    ui.status.textContent = msg;
    ui.status.classList.add('flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      ui.status.classList.remove('flash');
      ui.status.textContent = state.status;
    }, 2500);
  }

  async function copyText(text, okMsg) {
    try {
      if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text');
      else await navigator.clipboard.writeText(text);
      flash(okMsg);
    } catch (e) {
      flash(`复制失败：${e.message}`);
    }
  }

  /** 面板折叠时标题栏也显示下载进度。 */
  function headerCount() {
    const d = state.download;
    if (d) return d.total ? `下载 ${Math.floor((d.done / d.total) * 100)}%` : '下载准备中…';
    if (state.batch) {
      const p = batchProgress(state.batch);
      if (!state.batch.running) return `批量结束 · 成功 ${p.completed}/${p.total}`;
      return `批量 ${Math.floor(p.percent)}% · ${p.settled}/${p.total}`;
    }
    if (state.scanning) return '扫描中…';
    const excluded = state.entries.length - selectableEntries().length;
    return excluded ? `${state.entries.length} 条（排除 ${excluded}）` : `${state.entries.length} 条`;
  }

  /** 「排除日期」折叠时的标题：把生效中的标签名列出来，免得折叠后看不出排除了什么。 */
  function summaryText() {
    const active = state.holidays.filter((h) => h.enabled !== false).map((h) => h.name);
    return active.length ? `排除日期 · ${active.join('、')}` : '排除日期';
  }

  function downloadButtonLabel(key) {
    const d = state.download;
    if (!d || d.key !== key) return '下载';
    if (d.aborting) return '取消中…';
    return d.total ? `${Math.floor((d.done / d.total) * 100)}%` : '准备中…';
  }

  /** 下载进度只更新下载面板和该行按钮，不重建表格。 */
  function updateDownloadUI() {
    const d = state.download;
    const box = ui.dl;
    box.root.hidden = !d && !state.batch;
    box.root.classList.toggle('done', !!state.batch && !state.batch.running);
    ui.count.textContent = headerCount();
    if (state.batch) {
      const batch = state.batch;
      const p = batchProgress(batch);
      box.name.textContent = `批量下载 · ${p.total} 条录像`;
      box.name.title = box.name.textContent;
      box.bar.classList.toggle('indeterminate', batch.phase === 'pick' && batch.running);
      box.fill.style.width = `${p.percent.toFixed(1)}%`;
      box.note.hidden = true;
      if (!batch.running) {
        // 批次结束：保留每条结果，等用户确认后恢复页面
        box.cancel.disabled = false;
        box.cancel.textContent = '确定';
        box.l1.textContent = `批量下载已结束：成功 ${p.completed} · 失败 ${p.failed} · 取消 ${p.cancelled}`;
        box.l2.textContent = `已写入 ${formatBytes(p.bytes)} · 每条结果见下表，点「确定」清除结果并恢复列表`;
      } else {
        box.cancel.disabled = batch.aborting;
        box.cancel.textContent = batch.aborting ? '取消中…' : '取消整个批次';
        box.l1.textContent = batch.phase === 'pick' ? '选择目标目录' :
          `已处理 ${p.settled} / ${p.total}（${p.percent.toFixed(0)}%）· 成功 ${p.completed} · 失败 ${p.failed} · 取消 ${p.cancelled}`;
        const batchSave = batch.sinkKind === 'file' ? '直接写入磁盘'
          : batch.sinkKind === 'opfs' ? '浏览器临时存储'
          : '内存合并，逐条保存';
        box.l2.textContent = `正在处理 ${p.active} · 排队 ${p.queued} · 已写入 ${formatBytes(p.bytes)} · ${batchSave}（总进度按录像等权，含失败/取消）`;
      }
      const notes = [];
      if (p.fallbacks) notes.push(`注意：${p.fallbacks} 条录像编码无法无损转为 MP4，已改存为 TS`);
      if (batch.sinkKind === 'opfs') notes.push(`注意：${batch.sinkNote || '当前浏览器不支持目录写入'}，使用浏览器临时存储，完成后保存`);
      else if (batch.sinkKind === 'memory') notes.push(`注意：${batch.sinkNote || '当前浏览器不支持目录写入'}，内存合并，逐条保存`);
      box.note.hidden = !notes.length;
      box.note.textContent = notes.join('；');
      box.warn.hidden = !p.badTs;
      box.warn.textContent = p.badTs ? `注意：${p.badTs} 个分片不是有效的 TS 数据，请检查对应录像` : '';
      for (const task of batch.tasks) {
        const row = ui.tbody.querySelector(`tr[data-key="${CSS.escape(task.key)}"]`);
        if (!row) continue;
        const label = row.querySelector('.task-state');
        label.dataset.status = task.status;
        const progress = task.total ? ` · ${task.done}/${task.total} 分片 · ${formatBytes(task.bytes)}` : '';
        label.textContent = (task.status === 'completed' ? '已完成' : task.status === 'failed' ? `失败：${task.error}` :
          task.status === 'cancelled' ? '已取消' : task.aborting ? '取消中…' : PHASE_LABEL[task.phase]) + progress +
          (task.badTs ? ` · 注意：${task.badTs} 个异常 TS 分片` : '');
        if (task.notice) label.appendChild(Object.assign(document.createElement('span'), { className: 'notice', textContent: ` · 注意：${task.notice}` }));
        label.title = `${task.filename}${task.error ? `：${task.error}` : ''}${task.notice ? `：${task.notice}` : ''}`;
        const cancel = row.querySelector('[data-row="batch-cancel"]');
        cancel.hidden = !batch.running || isTaskFinished(task);
        cancel.disabled = task.aborting;
      }
      return;
    }
    if (!d) return;

    const pct = d.total ? (d.done / d.total) * 100 : 0;
    box.name.textContent = d.filename;
    box.name.title = d.filename;
    box.bar.classList.toggle('indeterminate', !d.total);
    box.fill.style.width = d.total ? `${pct.toFixed(1)}%` : '';
    box.cancel.disabled = d.aborting;
    box.cancel.textContent = d.aborting ? '取消中…' : '取消';

    let line1 = PHASE_LABEL[d.phase] || d.phase;
    if (d.total) line1 += ` · 分片 ${d.done} / ${d.total}（${pct.toFixed(0)}%）`;
    box.l1.textContent = line1;

    const parts = [];
    if (d.total) {
      const elapsed = (Date.now() - d.startedAt) / 1000;
      parts.push(`已下载 ${formatBytes(d.bytes)}`);
      if (d.totalSeconds) parts.push(`视频 ${formatDuration(d.seconds)} / ${formatDuration(d.totalSeconds)}`);
      if (elapsed > 1 && d.bytes) {
        parts.push(`${formatBytes(d.bytes / elapsed)}/s`);
        if (d.done > 0 && d.done < d.total) parts.push(`剩余约 ${formatDuration((elapsed / d.done) * (d.total - d.done))}`);
      }
      parts.push(d.sinkKind === 'file' ? '直接写入磁盘' : d.sinkKind === 'opfs' ? '浏览器临时存储，完成后保存' : '内存中合并，完成后保存');
      if (/\.mp4$/i.test(d.filename)) parts.push('边下载边转封装 MP4');
    }
    box.l2.textContent = parts.join(' · ');
    box.warn.hidden = !d.badTs;
    box.warn.textContent = d.badTs
      ? `注意：${d.badTs} 个分片解密后不是有效的 TS 数据（key/IV 可能不对），建议取消后检查`
      : '';
    const note = [
      d.sinkKind === 'memory' && d.sinkNote ? `${d.sinkNote}，改为在内存中合并（占用内存约等于视频大小）` : '',
      d.sinkKind === 'opfs' ? `${d.sinkNote || '当前浏览器不支持目录写入'}，使用浏览器临时存储，完成后保存` : '',
      d.notice,
    ].filter(Boolean);
    box.note.hidden = !note.length;
    box.note.textContent = note.map((n) => `注意：${n}`).join('；');

    const btn = ui.tbody.querySelector(`tr[data-key="${CSS.escape(d.key)}"] button[data-row="download"]`);
    if (btn) btn.textContent = downloadButtonLabel(d.key);
  }

  function render() {
    ui.panel.classList.toggle('collapsed', state.collapsed);
    $('.hd').setAttribute('aria-expanded', String(!state.collapsed));
    ui.count.textContent = headerCount();
    if (root.activeElement !== ui.course) ui.course.value = state.course;
    if (root.activeElement !== ui.tpl) ui.tpl.value = state.template;
    ui.fmt.value = state.format;
    if (!ui.status.classList.contains('flash')) ui.status.textContent = state.status;
    const busy = !!state.download || !!state.batch?.running;
    root.querySelectorAll('.bar button').forEach((b) => (b.disabled = state.scanning || (busy && ['scan', 'download'].includes(b.dataset.act))));
    ui.fmt.disabled = busy;
    ui.exclSummary.textContent = summaryText();
    ui.exclRows.replaceChildren(...exclLines.map((line, i) => {
      const item = document.createElement('div');
      item.className = 'excl-item';
      const row = document.createElement('div');
      row.className = 'excl-row';
      // 第一行左端是「＋」加行，其余行是「－」删掉整行
      const step = Object.assign(document.createElement('button'), {
        className: i ? 'excl-del' : 'excl-add',
        textContent: i ? '−' : '+',
        title: i ? '删掉这一行' : '再加一行日期',
        disabled: busy,
      });
      step.dataset[i ? 'exclDel' : 'exclAdd'] = String(i);
      const input = Object.assign(document.createElement('input'), { type: 'text', value: line, disabled: busy });
      input.className = 'excl-line';
      input.dataset.exclLine = String(i);
      if (!i) input.placeholder = '2026-10-01 或 2026-10-01~2026-10-07';
      const acts = document.createElement('span');
      acts.className = 'excl-acts';
      for (const [cls, key, label, title] of [
        ['excl-apply', 'exclApply', '排除', '排除当前课程中落在这一行日期的录像'],
        ['excl-restore', 'exclRestore', '恢复', '恢复这一行日期对应的条目（由标签排除的要停用或删除标签）'],
        ['excl-tag', 'exclTag', '存为标签', '把这一行的日期存成标签，对所有课程自动生效'],
      ]) {
        const b = Object.assign(document.createElement('button'), { className: cls, textContent: label, title, disabled: busy });
        b.dataset[key] = String(i);
        acts.appendChild(b);
      }
      row.appendChild(step);
      row.appendChild(input);
      row.appendChild(acts);
      item.appendChild(row);
      if (nameFor === i) {
        const wrap = document.createElement('div');
        wrap.className = 'excl-name';
        const name = Object.assign(document.createElement('input'), { type: 'text', value: tagName, placeholder: '名称', disabled: busy });
        name.className = 'tag-name';
        name.dataset.exclName = String(i);
        const save = Object.assign(document.createElement('button'), { className: 'excl-save', textContent: '保存', disabled: busy });
        save.dataset.exclSave = String(i);
        wrap.appendChild(name);
        wrap.appendChild(save);
        item.appendChild(wrap);
      }
      return item;
    }));

    ui.warn.hidden = !state.warnings.length;
    ui.warn.querySelector('summary').textContent = `${state.warnings.length} 条提示`;
    ui.warn.querySelector('ul').replaceChildren(
      ...state.warnings.map((w) => Object.assign(document.createElement('li'), { textContent: w })),
    );

    ui.holidays.replaceChildren(...state.holidays.map((h, i) => {
      const chip = document.createElement('span');
      chip.className = h.enabled === false ? 'hol off' : 'hol';
      const box = Object.assign(document.createElement('input'), {
        type: 'checkbox', checked: h.enabled !== false,
      });
      box.dataset.hol = String(i);
      box.title = '停用后不再自动排除';
      box.setAttribute('aria-label', `启用排除标签 ${h.name}`);
      const name = Object.assign(document.createElement('span'), { textContent: h.name });
      const dates = Object.assign(document.createElement('span'), {
        className: 'dates',
        textContent: h.ranges.map((r) => (r.from === r.to ? r.from : `${r.from}~${r.to}`)).join(' '),
      });
      const del = Object.assign(document.createElement('button'), { className: 'link', textContent: '删除' });
      del.dataset.holDel = String(i);
      for (const node of [box, name, dates, del]) chip.appendChild(node);
      return chip;
    }));

    const labels = exclusionsOf(state.entries);
    const frag = document.createDocumentFragment();
    for (const e of state.entries) {
      const key = entryKey(e);
      const tr = document.createElement('tr');
      tr.dataset.key = key;
      if (e.excluded) tr.className = 'excluded';
      const cells = [
        Object.assign(document.createElement('input'), {
          type: 'checkbox', checked: !e.excluded && state.selected.has(key), disabled: e.excluded,
        }),
        e.excluded ? '—' : String(e.index),
        outputNameOf(e),
        e.startTime ? e.startTime.slice(0, 16) : e.date,
        e.teacher,
      ];
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        if (i === 2) td.className = 'fn';
        if (typeof c === 'string') td.textContent = c;
        else { c.setAttribute('aria-label', `选择录像 ${e.index ?? e.origIndex}`); td.appendChild(c); }
        tr.appendChild(td);
      });
      const act = document.createElement('td');
      const otherDownload = (state.download && state.download.key !== key) || state.batch?.running;
      act.innerHTML =
        `<button class="link" data-row="open"${e.watchUrl ? '' : ' disabled title="无可用链接"'}>打开</button>` +
        '<button class="link" data-row="copy">复制名</button>';
      // 由节假日标签排除的条目不能单独恢复，只标注标签名（悬停说明去哪恢复）
      const holiday = labels.get(key);
      const exclude = document.createElement(holiday ? 'span' : 'button');
      if (holiday) {
        exclude.className = 'hol-tag';
        exclude.textContent = holiday;
        exclude.title = `由「${holiday}」标签自动排除；停用或删除该标签即可恢复`;
      } else {
        exclude.className = 'link';
        exclude.dataset.row = 'toggle-exclude';
        exclude.textContent = e.excluded ? '恢复' : '排除';
      }
      act.appendChild(exclude);
      const download = document.createElement('button');
      download.className = 'link';
      download.dataset.row = 'download';
      if (!e.watchUrl || otherDownload) download.disabled = true;
      if (state.download && !otherDownload) download.title = '点击取消';
      download.textContent = downloadButtonLabel(key);
      act.appendChild(download);
      const taskState = document.createElement('span');
      taskState.className = 'task-state';
      const cancel = document.createElement('button');
      cancel.className = 'link';
      cancel.dataset.row = 'batch-cancel';
      cancel.textContent = '取消此条';
      cancel.hidden = true;
      act.appendChild(taskState);
      act.appendChild(cancel);
      tr.appendChild(act);
      frag.appendChild(tr);
    }
    if (!state.entries.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="6" class="muted">${state.scanning ? '扫描中…' : '暂无条目'}</td>`;
      frag.appendChild(tr);
    }
    ui.tbody.replaceChildren(frag);
    const selectable = selectableEntries().length;
    ui.chkAll.checked = selectable > 0 && state.selected.size === selectable;
    updateDownloadUI();
  }

  // ---- 事件 ----------------------------------------------------------------------
  $('.hd').addEventListener('click', () => {
    state.collapsed = !state.collapsed;
    store.set('collapsed', state.collapsed);
    render();
  });

  ui.course.addEventListener('input', () => {
    state.course = ui.course.value.trim();
    store.set(`course:${courseId}`, state.course);
    render();
  });
  ui.tpl.addEventListener('input', () => {
    state.template = ui.tpl.value || DEFAULT_TEMPLATE;
    store.set('template', state.template);
    render();
  });
  ui.fmt.addEventListener('change', () => {
    state.format = ui.fmt.value === 'ts' ? 'ts' : 'mp4';
    store.set('format', state.format);
    render();
  });
  $('.reset-tpl').addEventListener('click', () => {
    state.template = DEFAULT_TEMPLATE;
    store.set('template', state.template);
    ui.tpl.value = state.template;
    render();
  });

  const rowTag = (i) => (exclLines.length > 1 ? `第 ${i + 1} 行：` : '');
  const invalidTail = (invalid) => (invalid.length ? `（未识别：${invalid.join(' ')}）` : '');

  /** 解析第 i 行的日期；没有可用日期时提示并返回 null。 */
  function parseLine(i) {
    const { ranges, invalid } = parseDateRanges(exclLines[i] || '');
    if (!ranges.length) {
      flash(invalid.length ? `${rowTag(i)}没识别出日期：${invalid.join(' ')}` : `${rowTag(i)}请先填写日期`);
      return null;
    }
    return { ranges, invalid };
  }

  /** 排除第 i 行日期对应的条目。 */
  function applyLine(i) {
    const parsed = parseLine(i);
    if (!parsed) return;
    const next = new Set(state.excluded);
    let hit = 0;
    for (const e of state.entries) {
      if (e.excluded || !matchesDateRanges(e.date, parsed.ranges)) continue;
      next.add(entryKey(e));
      hit += 1;
    }
    if (!hit) return flash(`${rowTag(i)}这些日期没有对应的录像`);
    setExcluded(next);
    flash(`${rowTag(i)}已排除 ${hit} 条${invalidTail(parsed.invalid)}`);
  }

  /** 恢复第 i 行日期对应的条目：只对本课程手动排除的有效，标签排除的要动标签。 */
  function restoreLine(i) {
    const parsed = parseLine(i);
    if (!parsed) return;
    const next = new Set(state.excluded);
    let hit = 0;
    let tagged = 0;
    for (const e of state.entries) {
      if (!matchesDateRanges(e.date, parsed.ranges)) continue;
      if (next.delete(entryKey(e))) hit += 1;
      else if (e.excluded) tagged += 1;
    }
    if (hit) {
      setExcluded(next);
      flash(`${rowTag(i)}已恢复 ${hit} 条${invalidTail(parsed.invalid)}`);
    } else if (tagged) {
      flash(`${rowTag(i)}这些条目由标签排除，停用或删除标签即可恢复`);
    } else {
      flash(`${rowTag(i)}这些日期没有已排除的条目`);
    }
  }

  /** 「存为标签」先把这一行展开成名称输入；再点一次收起。 */
  function toggleTagName(i) {
    nameFor = nameFor === i ? null : i;
    tagName = '';
    render();
    if (nameFor === null) return;
    const input = ui.exclRows.children[i] && ui.exclRows.children[i].querySelector('.tag-name');
    if (input && typeof input.focus === 'function') input.focus();
  }

  /** 把第 i 行存成全局标签；名字留空就用日期本身，存完这一行就收掉。 */
  function saveTagLine(i) {
    const parsed = parseLine(i);
    if (!parsed) return;
    const name = (nameFor === i && tagName.trim()) || (exclLines[i] || '').trim();
    const holidays = [...state.holidays, { name, ranges: parsed.ranges, enabled: true }];
    nameFor = null;
    tagName = '';
    exclLines.splice(i, 1);
    if (!exclLines.length) exclLines = [''];
    setHolidays(holidays);
    flash(`已添加「${name}」，对所有课程生效${invalidTail(parsed.invalid)}`);
  }

  function addLine() {
    exclLines.push('');
    render();
    const item = ui.exclRows.children[exclLines.length - 1];
    const input = item && item.querySelector('.excl-line');
    if (input && typeof input.focus === 'function') input.focus();
  }

  function delLine(i) {
    if (i < 1 || exclLines.length < 2) return;
    exclLines.splice(i, 1);
    if (nameFor === i) nameFor = null;
    else if (nameFor > i) nameFor -= 1;
    render();
  }

  // 输入只记进 exclLines / tagName，不重绘（免得打断输入）
  ui.exclRows.addEventListener('input', (ev) => {
    const d = ev.target.dataset || {};
    if (d.exclLine !== undefined) exclLines[Number(d.exclLine)] = ev.target.value;
    else if (d.exclName !== undefined) tagName = ev.target.value;
  });
  ui.exclRows.addEventListener('click', (ev) => {
    const d = ev.target.dataset || {};
    if (d.exclAdd !== undefined) return addLine();
    if (d.exclDel !== undefined) return delLine(Number(d.exclDel));
    if (d.exclApply !== undefined) return applyLine(Number(d.exclApply));
    if (d.exclRestore !== undefined) return restoreLine(Number(d.exclRestore));
    if (d.exclTag !== undefined) return toggleTagName(Number(d.exclTag));
    if (d.exclSave !== undefined) return saveTagLine(Number(d.exclSave));
  });
  ui.exclRows.addEventListener('keydown', (ev) => {
    const d = ev.target.dataset || {};
    if (d.exclLine !== undefined && ev.key === 'Enter') applyLine(Number(d.exclLine));
    else if (d.exclName !== undefined && ev.key === 'Enter') saveTagLine(Number(d.exclName));
    else if (ev.key === 'Escape' && nameFor !== null) {
      nameFor = null;
      tagName = '';
      render();
    }
  });

  ui.holidays.addEventListener('change', (ev) => {
    const i = Number(ev.target.dataset && ev.target.dataset.hol);
    if (!Number.isInteger(i) || !state.holidays[i]) return;
    const holidays = state.holidays.map((h, n) => (n === i ? { ...h, enabled: !!ev.target.checked } : h));
    setHolidays(holidays);
    flash(ev.target.checked ? `已启用「${holidays[i].name}」` : `已停用「${holidays[i].name}」`);
  });

  ui.holidays.addEventListener('click', (ev) => {
    const i = Number(ev.target.dataset && ev.target.dataset.holDel);
    if (!Number.isInteger(i) || !state.holidays[i]) return;
    const name = state.holidays[i].name;
    setHolidays(state.holidays.filter((_, n) => n !== i));
    flash(`已删除「${name}」`);
  });

  ui.chkAll.addEventListener('change', () => {
    state.selected = ui.chkAll.checked ? new Set(selectableEntries().map(entryKey)) : new Set();
    render();
  });

  $('.bar').addEventListener('click', (ev) => {
    const act = ev.target.dataset && ev.target.dataset.act;
    if (act === 'scan') actions.scan();
    else if (act === 'all') (state.selected = new Set(selectableEntries().map(entryKey))), render();
    else if (act === 'none') (state.selected = new Set()), render();
    else if (act === 'open') actions.openEntries(selectedEntries());
    else if (act === 'copy') {
      if (!state.entries.length) return flash('没有可复制的条目');
      const list = state.selected.size ? selectedEntries() : selectableEntries();
      copyText(
        buildListText({ course: state.course, template: state.template, entries: list }),
        `已复制 ${list.length} 条清单` + (state.selected.size ? '（仅选中）' : ''),
      );
    } else if (act === 'export') actions.exportManifest();
    else if (act === 'download') actions.downloadSelected(selectedEntries());
  });

  ui.tbody.addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr');
    const key = tr && tr.dataset.key;
    if (!key) return;
    const entry = state.entries.find((e) => entryKey(e) === key);
    if (ev.target.type === 'checkbox') {
      if (entry.excluded) return;
      if (ev.target.checked) state.selected.add(key);
      else state.selected.delete(key);
      const selectable = selectableEntries().length;
      ui.chkAll.checked = selectable > 0 && state.selected.size === selectable;
    } else if (ev.target.dataset.row === 'toggle-exclude') {
      const next = new Set(state.excluded);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setExcluded(next);
      flash(entry.excluded ? '已恢复该条' : '已排除该条');
    } else if (ev.target.dataset.row === 'open') {
      actions.openEntries([entry]);
    } else if (ev.target.dataset.row === 'copy') {
      copyText(outputNameOf(entry), '已复制文件名');
    } else if (ev.target.dataset.row === 'download') {
      const d = state.download;
      if (d && d.key === key) {
        if (confirm(`取消下载 ${d.filename}？`)) actions.cancelDownload();
      } else {
        actions.downloadEntry(entry);
      }
    } else if (ev.target.dataset.row === 'batch-cancel') {
      actions.cancelTask(key);
    }
  });

  ui.dl.cancel.addEventListener('click', () => {
    if (state.batch?.running) return actions.cancelBatchDownload();
    if (state.batch) return actions.dismissBatch();
    const d = state.download;
    if (d && confirm(`取消下载 ${d.filename}？`)) actions.cancelDownload();
  });

  const onPageHide = (event) => { if (!event.persisted) appearance.destroy(); };
  window.addEventListener('pagehide', onPageHide);
  function destroy() {
    clearTimeout(flashTimer);
    appearance.destroy();
    window.removeEventListener?.('pagehide', onPageHide);
    host.remove();
  }
  return { render, setStatus, flash, updateDownloadUI, destroy };
}
