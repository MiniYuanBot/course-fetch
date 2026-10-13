// 浏览器冒烟测试：在 headless Chrome 中加载真实 userscript，验证下载进度与取消后的页面恢复。
// 用法：npm run smoke（先构建 dist/，再测试；可用 CHROME=/path/to/chrome 指定浏览器）
// 本地 HTTP 服务模拟 videoList / playVideo 页面和一个 AES-128 HLS 流；脚本中没有 GM_* API 时走 fetch 分支。
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTs } from './ts-fixture.js';
import { readMp4 } from './mp4-reader.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'dist', 'course-fetch.user.js'), 'utf8');
const KEY = crypto.randomBytes(16);
const SEGMENTS = 24;

function iv(seq) {
  const b = Buffer.alloc(16);
  b.writeBigUInt64BE(BigInt(seq), 8);
  return b;
}
// 合成的 H.264 + AAC TS 分片：默认输出格式为 MP4，脚本在浏览器中边下载边转封装。
const FRAMES_PER_SEGMENT = 3;
const FIXTURE = makeTs({ segments: SEGMENTS, framesPerSegment: FRAMES_PER_SEGMENT });
const tsPayload = (i) => Buffer.from(FIXTURE.segments[i]);
const mp4Frames = (bytes) => {
  try {
    const mp4 = readMp4(Uint8Array.from(bytes));
    return mp4.types.join(',') === 'ftyp,mdat,moov' ? mp4.tracks.map((t) => t.samples.length) : null;
  } catch (_) {
    return null;
  }
};
const encrypt = (plain, seq) => {
  const c = crypto.createCipheriv('aes-128-cbc', KEY, iv(seq));
  return Buffer.concat([c.update(plain), c.final()]);
};

const ROW = (i, date, token) => `
  <tr id="listContainer_row:${i}">
    <th scope="row" valign="top">\n        ${date}第3-4节\n    </th>
    <td valign="top"><span class="mobile-table-label">时间: </span><span class="table-data-cell-value">\n ${date} 10:10:00 \n</span></td>
    <td valign="top"><span class="mobile-table-label">教师: </span><span class="table-data-cell-value">\n 陈向群 \n</span></td>
    <td valign="top"><span class="mobile-table-label">操作: </span><span class="table-data-cell-value">
      <a class="inlineAction" target="_blank" href="playVideo.action?token=${token}">\n 观看 \n</a></span></td>
  </tr>`;

// 模拟 Tampermonkey 的 GM storage / 值变化监听 / 打开标签页（同源页面共享 localStorage，跨标签页用 storage 事件）
const GM_SHIM = `(() => {
  const P = 'gm:';
  window.GM_getValue = (k, d) => { const v = localStorage.getItem(P + k); return v == null ? d : JSON.parse(v); };
  window.GM_setValue = (k, v) => localStorage.setItem(P + k, JSON.stringify(v));
  window.GM_deleteValue = (k) => localStorage.removeItem(P + k);
  const listeners = new Map(); let n = 0;
  window.GM_addValueChangeListener = (k, cb) => {
    const id = ++n;
    const h = (e) => { if (e.key === P + k) cb(k, e.oldValue && JSON.parse(e.oldValue), e.newValue && JSON.parse(e.newValue), true); };
    addEventListener('storage', h); listeners.set(id, h); return id;
  };
  window.GM_removeValueChangeListener = (id) => { removeEventListener('storage', listeners.get(id)); listeners.delete(id); };
  window.__tabs = [];
  window.GM_openInTab = (url) => {
    const w = window.open(url, '_blank'); const t = { url, closed: false }; window.__tabs.push(t);
    return { close() { t.closed = true; if (w) w.close(); } };
  };
})();`;

// playVideo 页面：静态 HTML 里没有 m3u8；播放器在 iframe 中运行后才动态请求
const PLAY_HTML = (t) => `<!doctype html><html><head><meta charset="utf-8">
<script src="/gm-shim.js"></script><script src="/course-fetch.user.js"></script></head>
<body><iframe src="/player/outer.html?token=${t}"></iframe></body></html>`;
const OUTER_HTML = (t) => `<!doctype html><html><head>
<script src="/gm-shim.js"></script><script src="/course-fetch.user.js"></script></head>
<body><iframe src="/player/index.html?token=${t}"></iframe></body></html>`;
const PLAYER_HTML = (t) => `<!doctype html><html><head><meta charset="utf-8">
<script src="/gm-shim.js"></script><script src="/course-fetch.user.js"></script></head>
<body><video></video><script>
  setTimeout(() => fetch('/hls/${t}/playlist.m3u8?sig=abc'), 300);
</script></body></html>`;

const LIST_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>课堂实录</title>
<script src="/gm-shim.js"></script>
<script>
  // 测试钩子：自动确认弹窗；记录 saveBlob 保存的文件
  window.confirm = () => true;
  window.__saved = [];
  const origCreate = URL.createObjectURL;
  let lastBlob = null;
  URL.createObjectURL = (b) => { lastBlob = b; return origCreate(b); };
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && lastBlob) window.__saved.push({ name: this.download, blob: lastBlob });
  };
  // 先模拟不支持目录写入的浏览器：单条/批量走 OPFS 临时文件分支（后面的步骤会换成真实/假的目录）
  delete window.showDirectoryPicker;
</script></head><body>
<table><tbody>${ROW(0, '2026-09-30', 'SLOW')}${ROW(1, '2026-09-23', 'FAST')}</tbody></table>
<script src="/course-fetch.user.js"></script>
</body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'text/html; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type });
    res.end(body);
  };
  if (url.pathname === '/course-fetch.user.js') return send(200, SCRIPT, 'text/javascript; charset=utf-8');
  if (url.pathname === '/webapps/videoList.action') return send(200, LIST_HTML);
  if (url.pathname === '/gm-shim.js') return send(200, GM_SHIM, 'text/javascript; charset=utf-8');
  if (url.pathname === '/webapps/playVideo.action') return send(200, PLAY_HTML(url.searchParams.get('token')));
  if (url.pathname === '/player/outer.html') return send(200, OUTER_HTML(url.searchParams.get('token')));
  if (url.pathname === '/player/index.html') return send(200, PLAYER_HTML(url.searchParams.get('token')));
  let m = /^\/hls\/(\w+)\/playlist\.m3u8$/.exec(url.pathname);
  if (m) {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-KEY:METHOD=AES-128,URI="/hls/key"'];
    for (let i = 0; i < SEGMENTS; i++) lines.push('#EXTINF:10.0,', `segment_${i}.ts`);
    lines.push('#EXT-X-ENDLIST');
    return send(200, lines.join('\n'), 'application/vnd.apple.mpegurl');
  }
  if (url.pathname === '/hls/key') return send(200, KEY, 'application/octet-stream');
  m = /^\/hls\/(\w+)\/segment_(\d+)\.ts$/.exec(url.pathname);
  if (m) {
    const i = Number(m[2]);
    if (m[1] === 'SLOW' && i >= 4) return; // 之后的分片永不返回，模拟卡住的请求
    await new Promise((r) => setTimeout(r, 40));
    return send(200, encrypt(tsPayload(i), i), 'video/mp2t');
  }
  send(404, 'not found');
});

// ---- 浏览器中执行的测试 --------------------------------------------------------
async function pageTest() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, ms, what) {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`超时：${what}`);
      await sleep(20);
    }
  }
  const root = (await until(() => document.querySelector('#course-fetch-host'), 3000, '面板')).shadowRoot;
  const $ = (s) => root.querySelector(s);
  const rowBtn = (n) => root.querySelectorAll('tbody tr')[n].querySelector('button[data-row="download"]');
  const snap = () => ({
    dlHidden: $('.dl').hidden,
    l1: $('.dl-l1').textContent,
    l2: $('.dl-l2').textContent,
    width: $('.dl-fill').style.width,
    header: $('.count').textContent,
    status: $('.status').textContent,
    btn0: rowBtn(0).textContent,
    btn1: rowBtn(1).textContent,
    btn1Disabled: rowBtn(1).disabled,
    note: $('.dl-note').hidden ? '' : $('.dl-note').textContent,
  });
  const out = { samples: [] };
  await until(() => /共 1 页，2 条录像/.test($('.status').textContent), 5000, '扫描完成');
  console.info('[smoke] 列表与面板就绪');

  // 真实 Shadow DOM 中验证完整主题链路，下面的下载测试仍使用本地合成数据。
  const host = document.querySelector('#course-fetch-host');
  const chooseTheme = (value) => { $('.theme').value = value; $('.theme').dispatchEvent(new Event('change')); };
  chooseTheme('dark');
  if (host.dataset.theme !== 'dark' || getComputedStyle($('.cf')).backgroundColor !== 'rgb(32, 32, 35)') throw new Error('独立深色没有生效');
  document.documentElement.setAttribute('data-pku-prism', 'enabled');
  document.documentElement.setAttribute('data-pku-prism-theme', 'light');
  await until(() => host.dataset.theme === 'light', 1000, '继承 Prism 浅色');
  if (!$('.theme').disabled || getComputedStyle($('.cf')).color !== 'rgb(24, 24, 27)') throw new Error('Prism 浅色文字/控件状态不正确');
  document.documentElement.setAttribute('data-pku-prism-theme', 'dark');
  await until(() => host.dataset.theme === 'dark', 1000, '跟随 Prism 切换');
  document.documentElement.removeAttribute('data-pku-prism');
  document.documentElement.removeAttribute('data-pku-prism-theme');
  await until(() => !$('.theme').disabled, 1000, '停用 Prism 后恢复偏好');
  if (host.dataset.theme !== 'dark' || $('.theme').value !== 'dark' || GM_getValue('appearance') !== 'dark') throw new Error('独立偏好被 Prism 覆盖');
  chooseTheme('light');
  if (getComputedStyle($('.cf')).backgroundColor !== 'rgb(255, 255, 255)') throw new Error('独立浅色没有生效');
  const collapsed = $('.cf').classList.contains('collapsed');
  $('.hd').click();
  if ($('.hd').getAttribute('aria-expanded') !== String(collapsed)) throw new Error('折叠按钮无障碍状态没有同步');
  $('.hd').click();
  chooseTheme('system');
  out.appearancePassed = true;
  console.info('[smoke] Prism 继承、动态切换、独立偏好与折叠状态通过');

  // 1) 完整下载 L01（FAST），采样进度
  rowBtn(0).click();
  out.started = snap();
  await until(() => {
    const s = snap();
    if (!s.dlHidden) out.samples.push(s);
    return /已完成/.test(s.status);
  }, 15000, '下载完成');
  out.done = snap();
  const saved = window.__saved[0];
  out.saved = saved && { name: saved.name, size: saved.blob.size };
  if (saved) out.saved.bytes = Array.from(new Uint8Array(await saved.blob.arrayBuffer()));

  // 2) 下载 L02（SLOW，第 5 个分片起卡住），中途取消
  rowBtn(1).click();
  await until(() => /分片 [3-9] \//.test($('.dl-l1').textContent), 5000, '慢速下载开始');
  out.beforeCancel = snap();
  const t0 = Date.now();
  $('.dl-cancel').click();
  await until(() => $('.dl').hidden, 3000, '取消后面板隐藏');
  out.cancelMs = Date.now() - t0;
  out.afterCancel = snap();

  // 3) 取消后能再次开始下载
  rowBtn(0).click();
  await until(() => /已完成/.test($('.status').textContent), 15000, '再次下载完成');
  out.again = snap();
  out.savedCount = window.__saved.length;
  console.info('[smoke] 单条下载、取消、再次下载完成');

  // 4) 不支持目录 API 时改用浏览器临时文件保存（Safari/Firefox 也可用）；取消目录选择也不能启动 capture。
  $('[data-act="all"]').click();
  root.querySelectorAll('tbody input[type=checkbox]')[1].click(); // 只保留 FAST：SLOW 的分片会卡住批次
  delete window.showDirectoryPicker;
  $('[data-act="download"]').click();
  await until(() => /批次结束：成功 1，失败 0，取消 0/.test($('.status').textContent), 15000, '浏览器保存模式批量下载');
  out.browserSave = { task: root.querySelectorAll('.task-state')[0].textContent, saved: window.__saved.length, l2: $('.dl-l2').textContent };
  $('.dl-cancel').click(); // 「确定」恢复页面
  let pickerCalls = 0;
  window.showDirectoryPicker = async () => { pickerCalls++; throw new DOMException('cancel', 'AbortError'); };
  $('[data-act="all"]').click();
  $('[data-act="download"]').click();
  await until(() => /已取消批量下载（未选择目录）/.test($('.status').textContent), 2000, '取消目录');
  out.pickerCancelled = snap();
  out.tabsBeforeBatch = window.__tabs.length;

  // 5) 一个目录、两个并发捕获、AES 顺序写入；FAST 完成，独立取消 SLOW。
  const files = new Map();
  window.showDirectoryPicker = async () => {
    pickerCalls++;
    return {
      async getFileHandle(name, options = {}) {
        if (!files.has(name)) {
          if (!options.create) throw new DOMException('missing', 'NotFoundError');
          files.set(name, { chunks: [], committed: false });
        }
        const file = files.get(name);
        return { async createWritable() { return {
          async write(arg) {
            await sleep(5);
            if (arg instanceof Uint8Array) return file.chunks.push(arg.slice());
            // MP4 完成时用 { type: 'write', position } 回填 mdat 大小
            const all = new Uint8Array(file.chunks.reduce((n, b) => n + b.length, 0));
            let o = 0;
            for (const b of file.chunks) { all.set(b, o); o += b.length; }
            all.set(arg.data, arg.position);
            file.chunks = [all];
          },
          async close() { file.committed = true; },
          async abort() { file.chunks = []; },
        }; } };
      },
      async removeEntry(name) { files.delete(name); },
    };
  };
  const taskState = (index) => root.querySelectorAll('.task-state')[index];
  $('[data-act="download"]').click();
  await until(() => /已完成/.test(taskState(0).textContent) && /4\/24/.test(taskState(1).textContent), 15000, '并发批量进度');
  out.batchMid = { header: $('.count').textContent, overall: $('.dl-l1').textContent, tasks: [taskState(0).textContent, taskState(1).textContent] };
  root.querySelectorAll('[data-row="batch-cancel"]')[1].click();
  await until(() => /批次结束：成功 1，失败 0，取消 1/.test($('.status').textContent), 3000, '取消单条批量任务');
  out.batchDone = snap();
  console.info('[smoke] 并发批量下载与取消单条完成');
  out.batchFiles = [...files].map(([name, f]) => ({ name, committed: f.committed, bytes: f.chunks.flatMap((b) => Array.from(b)) }));

  // 6) 再开一批，在 capture 阶段取消整个批次；排队/捕获文件都应清理。
  $('[data-act="download"]').click();
  await until(() => [...root.querySelectorAll('.task-state')].some((n) => /自动捕获/.test(n.textContent)), 3000, '新批次捕获');
  $('.dl-cancel').click();
  await until(() => /批次结束：成功 0，失败 0，取消 2/.test($('.status').textContent), 3000, '整个批次取消');
  out.batchCancelAll = snap();
  out.pickerCalls = pickerCalls;
  out.filesAfterCancelAll = files.size;
  out.blobCountAfterBatch = window.__saved.length;
  await sleep(100);
  out.tabs = window.__tabs.map((t) => ({ url: t.url, closed: t.closed }));
  out.leftover = Object.keys(localStorage).filter((k) => k.startsWith('gm:capture'));

  // 7) 真实 FileSystemWritableFileStream（OPFS 与 showDirectoryPicker 返回同一种句柄）：顺序写入 + 按位置回填 mdat 头。
  const opfs = await navigator.storage.getDirectory();
  for await (const name of opfs.keys()) await opfs.removeEntry(name, { recursive: true });
  window.showDirectoryPicker = async () => opfs;
  root.querySelectorAll('tbody input[type=checkbox]')[1].click(); // 只保留 FAST（第 1 行）
  $('[data-act="download"]').click();
  await until(() => /批次结束：成功 1/.test($('.status').textContent), 15000, 'OPFS 批量下载');
  out.batchConfirm = { button: $('.dl-cancel').textContent, l1: $('.dl-l1').textContent, header: $('.count').textContent };
  $('.dl-cancel').click(); // 「确定」恢复页面
  out.afterConfirm = { dlHidden: $('.dl').hidden, header: $('.count').textContent, states: [...root.querySelectorAll('.task-state')].map((n) => n.textContent) };
  // 单条也选目录直接写盘：同名文件自动加后缀
  const blobsBefore = window.__saved.length;
  rowBtn(0).click();
  await until(() => /已完成：L01-2026-09-23-第3-4节 \(2\)\.mp4/.test($('.status').textContent), 15000, 'OPFS 单条下载');
  out.singleBlobs = window.__saved.length - blobsBefore;
  out.opfs = [];
  for await (const [name, handle] of opfs.entries()) {
    out.opfs.push({ name, bytes: Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer())) });
  }
  return out;
}

// ---- Chrome DevTools Protocol --------------------------------------------------
function findChrome() {
  const candidates = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('找不到 Chrome，请设置 CHROME 环境变量');
  return found;
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-smoke-'));
  const chrome = spawn(findChrome(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', '--disable-popup-blocking', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let ws;

  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r, j) => {
      const timer = setTimeout(() => j(new Error('Chrome DevTools 连接超时')), 5000);
      ws.onopen = () => { clearTimeout(timer); r(); };
      ws.onerror = (error) => { clearTimeout(timer); j(error); };
    });
    let id = 0;
    const waiting = new Map();
    const consoleLines = [];
    const loaded = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && waiting.has(msg.id)) waiting.get(msg.id)(msg);
      if (msg.method === 'Runtime.consoleAPICalled') {
        const line = msg.params.args.map((a) => a.value ?? a.description).join(' ');
        consoleLines.push(line);
        if (line.startsWith('[smoke]')) console.log(line);
      }
      if (msg.method === 'Runtime.exceptionThrown') consoleLines.push(`EXCEPTION ${msg.params.exceptionDetails.exception?.description}`);
      if (msg.method === 'Page.loadEventFired') loaded.forEach((f) => f());
    };
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        const timer = setTimeout(() => { waiting.delete(n); reject(new Error(`CDP ${method} 超时`)); }, method === 'Runtime.evaluate' ? 60000 : 10000);
        waiting.set(n, (m) => {
          clearTimeout(timer); waiting.delete(n);
          return m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        });
        ws.send(JSON.stringify({ id: n, method, params }));
      });

    await send('Runtime.enable');
    await send('Page.enable');
    const load = new Promise((r, j) => {
      const timer = setTimeout(() => j(new Error('本地模拟页面加载超时')), 10000);
      loaded.push(() => { clearTimeout(timer); r(); });
    });
    await send('Page.navigate', { url: `${base}/webapps/videoList.action?course_id=_1_1` });
    await load;
    const r = await send('Runtime.evaluate', { expression: `(${pageTest})()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    ws.close();
    return { out: r.result.value, consoleLines };
  } finally {
    ws?.close();
    chrome.kill();
    server.closeAllConnections();
    server.close();
  }
}

const check = (cond, msg) => {
  console.log(`${cond ? '✔' : '✖'} ${msg}`);
  if (!cond) process.exitCode = 1;
};

main()
  .then(({ out, consoleLines }) => {
    check(out.appearancePassed, '浅深色、Prism 启停继承、手动偏好与折叠 ARIA 状态');
    check(consoleLines.some((l) => /\[Course Fetch\] v[\d.]+ loaded/.test(l)), `启动日志：${consoleLines.find((l) => l.includes('loaded'))}`);
    check(!consoleLines.some((l) => l.startsWith('EXCEPTION')), '页面没有未捕获异常');
    check(!out.started.dlHidden, `点击下载后立即显示进度面板（${out.started.l1}）`);
    const progress = out.samples.filter((s) => /分片 \d+ \/ 24/.test(s.l1));
    const widths = [...new Set(progress.map((s) => s.width))];
    check(widths.length >= 3, `进度条宽度逐步增长（采样到 ${widths.length} 个不同宽度，例如 ${widths.slice(0, 4).join(', ')}）`);
    const mid = progress[Math.floor(progress.length / 2)] || {};
    check(/已下载 .+ · 视频 .+ \/ 4:00 · 浏览器临时存储/.test(mid.l2 || ''), `详细信息：${mid.l2}`);
    check(/不支持目录写入.*使用浏览器临时存储/.test(mid.note || ''), `不支持目录写入时说明临时存储原因：${mid.note}`);
    check(/^下载 \d+%$/.test(mid.header || ''), `标题栏显示进度：${mid.header}`);
    check(/^\d+%$/.test(mid.btn0 || ''), `行内按钮显示进度：${mid.btn0}`);
    check(mid.btn1Disabled === true, '下载中其它行的下载按钮被禁用');
    check(out.done.dlHidden && /已完成：L01-2026-09-23-第3-4节\.mp4/.test(out.done.status), `完成：${out.done.status}`);
    check(out.saved && out.saved.name === 'L01-2026-09-23-第3-4节.mp4', `保存文件名：${out.saved && out.saved.name}`);
    const savedFrames = out.saved && mp4Frames(out.saved.bytes);
    check(savedFrames && savedFrames[0] === FIXTURE.video.length && savedFrames[1] === FIXTURE.audio.length,
      `浏览器临时文件保存的 MP4 完整：视频 ${savedFrames?.[0]} / ${FIXTURE.video.length} 帧，音频 ${savedFrames?.[1]} / ${FIXTURE.audio.length} 帧`);
    check(out.cancelMs < 1500, `请求卡住时取消，${out.cancelMs} ms 内恢复`);
    const a = out.afterCancel;
    check(a.dlHidden && /已取消下载/.test(a.status), `取消后状态：${a.status}`);
    check(a.btn0 === '下载' && a.btn1 === '下载' && !a.btn1Disabled, '取消后按钮恢复为“下载”且可用');
    check(a.header === '2 条', `取消后标题栏恢复：${a.header}`);
    check(/已完成/.test(out.again.status) && out.savedCount === 2, '取消后可以再次下载');
    check(/已完成/.test(out.browserSave.task) && out.browserSave.saved === 3, `不支持目录写入时批量用浏览器保存（${out.browserSave.task}，累计保存 ${out.browserSave.saved} 个）`);
    check(/未选择目录/.test(out.pickerCancelled.status) && out.pickerCancelled.dlHidden && out.tabsBeforeBatch === 4, '取消目录选择不启动捕获或下载，并直接恢复页面');
    check(/批量 \d+% · 1\/2/.test(out.batchMid.header) && /成功 1/.test(out.batchMid.overall), '批量总体进度与完成数量可见');
    check(/已完成/.test(out.batchMid.tasks[0]) && /4\/24/.test(out.batchMid.tasks[1]), '每条录像状态和分片进度独立显示');
    check(/成功 1，失败 0，取消 1/.test(out.batchDone.status), '取消单条不影响另一条完成');
    const batchFrames = out.batchFiles[0] && mp4Frames(out.batchFiles[0].bytes);
    check(out.batchFiles.length === 1 && out.batchFiles[0].committed && /\.mp4$/.test(out.batchFiles[0].name) && batchFrames?.[0] === FIXTURE.video.length,
      `批量 AES 直接写盘的 MP4 完整（${out.batchFiles[0]?.name}，${batchFrames?.[0]} 帧），取消条目的文件已移除`);
    check(/取消 2/.test(out.batchCancelAll.status) && !out.batchCancelAll.btn1Disabled && out.filesAfterCancelAll === 1, '取消整个批次后按钮恢复、未完成文件清理');
    check(out.pickerCalls === 3 && out.blobCountAfterBatch === 3, '每个批次只选一次目录，批量从未走 Blob 保存');
    check(out.tabs.length === 8 && out.tabs.every((t) => /\/webapps\/playVideo\.action\?token=(FAST|SLOW)#course-fetch-capture=/.test(t.url)), `每个 capture 临时页携带独立任务 ID（${out.tabs.length} 次）`);
    check(out.tabs.every((t) => t.closed), '捕获到 m3u8 后临时页均已关闭');
    const opfsFrames = out.opfs[0] && mp4Frames(out.opfs[0].bytes);
    check(out.opfs.length === 2 && out.opfs.every((f) => /\.mp4$/.test(f.name) && mp4Frames(f.bytes)?.[0] === FIXTURE.video.length) && opfsFrames?.[1] === FIXTURE.audio.length,
      `真实文件流写入的 MP4 完整（批量 + 单条：${out.opfs.map((f) => f.name).join(', ')}，视频 ${opfsFrames?.[0]} 帧，音频 ${opfsFrames?.[1]} 帧）`);
    check(out.singleBlobs === 0, '有目录写入时单条下载直接写盘，不在内存合并');
    check(out.batchConfirm.button === '确定' && /批量下载已结束：成功 1/.test(out.batchConfirm.l1) && /批量结束/.test(out.batchConfirm.header), `批次结束后等待确认：${out.batchConfirm.l1}`);
    check(out.afterConfirm.dlHidden && out.afterConfirm.header === '2 条' && out.afterConfirm.states.every((t) => t === ''), '点「确定」后进度区和每行结果清除，页面恢复');
    check(out.leftover.length === 0, `GM storage 中没有残留 capture 记录（${out.leftover.join(', ') || '无'}）`);
  })
  .catch((e) => {
    console.error('✖ 冒烟测试失败：', e.message);
    process.exitCode = 1;
  });
