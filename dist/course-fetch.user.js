// ==UserScript==
// @name         Course Fetch
// @namespace    https://github.com/MiniYuanBot/course-fetch
// @version      0.6.0
// @description  北大教学网课堂实录：枚举整门课程录像、排序、命名、导出 manifest，支持单条和批量下载，无损保存为 MP4。
// @homepageURL  https://github.com/MiniYuanBot/course-fetch
// @supportURL   https://github.com/MiniYuanBot/course-fetch/issues
// @updateURL    https://github.com/MiniYuanBot/course-fetch/releases/latest/download/course-fetch.user.js
// @downloadURL  https://github.com/MiniYuanBot/course-fetch/releases/latest/download/course-fetch.user.js
// @match        *://*.pku.edu.cn/*videoList.action*
// @match        *://*.pku.edu.cn/*playVideo.action*
// @match        *://onlineroomse.pku.edu.cn/*
// @include      /^https?:\/\/[^/]*pku\.edu\.cn\/.*videoList\.action.*/
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      pku.edu.cn
// @connect      self
// @run-at       document-idle
// @license      MIT
// @author       miniyuan & Kristina
// ==/UserScript==

/*
 * 功能：课程录像枚举、metadata 解析、排序、命名、工作流辅助；单条和批量录像下载（标准 HLS AES-128）。
 * 下载只使用当前浏览器登录会话本来就能访问的 m3u8 / key / 分片：遇到 401/403 直接失败，
 * 不做任何登录或权限绕过；不支持 SAMPLE-AES、非 identity KEYFORMAT 等 DRM 方案。
 * 播放链接（“观看”/“预览”）和 AES key 只保存在内存中，不写入 storage / manifest / 剪贴板清单。
 * m3u8 地址由临时打开的播放页自动捕获，经 GM storage 短暂传回列表页，读取后立即删除。
 * 播放页 / 播放器 iframe 上只在下载时存在未过期的 capture 请求时才运行捕获，平时什么都不做。
 *
 * 本文件由 src/ 下的模块经 esbuild 打包生成，请修改 src/ 后运行 npm run build。
 */
(() => {
  // src/parser.js
  var DEFAULT_TEMPLATE = "L{index:02d}-{date}-第{periodStart}-{periodEnd}节.mp4";
  var DATE_PERIOD_RE = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\s*第\s*(\d{1,2})\s*(?:[-－–—~～至到]\s*(\d{1,2}))?\s*节/;
  var DATETIME_RE = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/;
  var TIME_RE = new RegExp("时间\\s*[:：]\\s*" + DATETIME_RE.source);
  var TEACHER_RE = /教师\s*[:：]\s*(.*?)\s*(?:操作\s*[:：]|观看|预览|$)/;
  var DATE_RANGE_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:~(\d{4})[-/.](\d{1,2})[-/.](\d{1,2}))?$/;
  var pad2 = (n) => String(n).padStart(2, "0");
  var ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
  function normalizeText(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  }
  function parseTitle(title) {
    const m = DATE_PERIOD_RE.exec(normalizeText(title));
    if (!m) return { ok: false, error: "无法解析日期/节次" };
    const periodStart = Number(m[4]);
    const periodEnd = m[5] ? Number(m[5]) : periodStart;
    if (periodEnd < periodStart) return { ok: false, error: "节次范围异常" };
    return { ok: true, date: ymd(m[1], m[2], m[3]), periodStart, periodEnd };
  }
  function formatDateTime(m) {
    return m ? `${ymd(m[1], m[2], m[3])} ${pad2(m[4])}:${m[5]}:${m[6] || "00"}` : null;
  }
  function parseStructuredRow({ title, startTime, teacher }) {
    const text = [title, startTime, teacher].map(normalizeText).join(" | ");
    const p = parseTitle(title);
    if (!p.ok) return { ok: false, error: p.error, text };
    return {
      ok: true,
      entry: {
        date: p.date,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        startTime: formatDateTime(DATETIME_RE.exec(normalizeText(startTime))),
        teacher: normalizeText(teacher)
      }
    };
  }
  function parseRowText(raw) {
    const text = normalizeText(raw);
    const p = parseTitle(text);
    if (!p.ok) return { ok: false, error: p.error, text };
    const tm = TEACHER_RE.exec(text);
    return {
      ok: true,
      entry: {
        date: p.date,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        startTime: formatDateTime(TIME_RE.exec(text)),
        teacher: tm ? tm[1].trim() : ""
      }
    };
  }
  function parseRows(rows) {
    const entries = [];
    const failures = [];
    for (const row of rows) {
      const r = row.cols ? parseStructuredRow(row.cols) : parseRowText(row.text);
      if (r.ok) entries.push({ ...r.entry, watchUrl: row.watchUrl || null, page: row.page });
      else failures.push({ error: r.error, text: r.text, page: row.page });
    }
    return { entries, failures };
  }
  function entryKey(e) {
    return `${e.date}|${e.periodStart}-${e.periodEnd}|${e.startTime || ""}`;
  }
  function compareEntries(a, b) {
    const ka = a.startTime || `${a.date} ~`;
    const kb = b.startTime || `${b.date} ~`;
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.periodStart - b.periodStart;
  }
  function dedupeAndSort(entries) {
    const seen = /* @__PURE__ */ new Map();
    const duplicates = [];
    for (const e of entries) {
      const k = entryKey(e);
      if (seen.has(k)) duplicates.push(e);
      else seen.set(k, e);
    }
    const sorted = [...seen.values()].sort(compareEntries).map((e, i) => ({ ...e, index: i + 1 }));
    return { entries: sorted, duplicates };
  }
  var EMPTY_SET = /* @__PURE__ */ new Set();
  function applyExclusions(entries, excludedKeys = EMPTY_SET) {
    let n = 0;
    return entries.map((e) => {
      const excluded = excludedKeys.has(entryKey(e));
      return { ...e, excluded, origIndex: e.origIndex ?? e.index, index: excluded ? null : ++n };
    });
  }
  function parseDateRanges(text) {
    const ranges = [];
    const invalid = [];
    const normalized = String(text == null ? "" : text).replace(/\s*(?:~|～|至|到|\.\.)\s*/g, "~");
    for (const token of normalized.split(/[,，、;；\s]+/).filter(Boolean)) {
      const m = DATE_RANGE_RE.exec(token);
      if (!m) {
        invalid.push(token);
        continue;
      }
      const from = ymd(m[1], m[2], m[3]);
      const to = m[4] ? ymd(m[4], m[5], m[6]) : from;
      if (to < from) {
        invalid.push(token);
        continue;
      }
      ranges.push({ from, to });
    }
    return { ranges, invalid };
  }
  function inRange(date, range) {
    return date >= range.from && date <= range.to;
  }
  function matchesDateRanges(date, ranges) {
    return ranges.some((r) => inRange(date, r));
  }
  function holidayRanges(holidays = []) {
    const out = [];
    for (const h of holidays) {
      if (!h || h.enabled === false) continue;
      for (const r of h.ranges || []) out.push({ from: r.from, to: r.to, name: h.name });
    }
    return out;
  }
  function collectExclusions(entries, manualKeys = EMPTY_SET, ranges = []) {
    const out = /* @__PURE__ */ new Map();
    for (const e of entries) {
      const key = entryKey(e);
      if (manualKeys.has(key)) out.set(key, "");
      else if (ranges.length) {
        const hit = ranges.find((r) => inRange(e.date, r));
        if (hit) out.set(key, hit.name || "");
      }
    }
    return out;
  }
  function sanitizeFilename(name) {
    const s = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
    return s || "untitled";
  }
  function parseCourseName(course) {
    const text = normalizeText(course);
    const m = /^(.*?)\s*[(（]\s*(\d{2}(?:\d{2})?)\s*[-－–—]\s*(\d{2}(?:\d{2})?)\s*学年\s*第\s*(\d+)\s*学期\s*[)）]$/.exec(text);
    if (!m) return { courseName: text, academicYear: "", semester: "" };
    return { courseName: m[1].trim(), academicYear: `${m[2]}-${m[3]}`, semester: m[4] };
  }
  function formatFilename(template, entry, ctx = {}) {
    const date = entry.date || "";
    const vars = {
      index: entry.index,
      date: entry.date,
      YYYY: date.slice(0, 4),
      YY: date.slice(2, 4),
      MM: date.slice(5, 7),
      DD: date.slice(8, 10),
      periodStart: entry.periodStart,
      periodEnd: entry.periodEnd,
      teacher: entry.teacher || "",
      course: ctx.course || "",
      ...parseCourseName(ctx.course),
      startTime: entry.startTime || "",
      time: entry.startTime ? entry.startTime.slice(11, 16).replace(":", "") : ""
    };
    const out = String(template || DEFAULT_TEMPLATE).replace(/\{(\w+)(?::0?(\d+)d)?\}/g, (all, name, width) => {
      if (!Object.prototype.hasOwnProperty.call(vars, name)) return all;
      const v = String(vars[name] == null ? "" : vars[name]);
      return width ? v.padStart(Number(width), "0") : v;
    });
    return sanitizeFilename(out);
  }
  var OUTPUT_FORMATS = ["mp4", "ts"];
  function withExtension(name, format) {
    return `${String(name).replace(/\.(mp4|ts|mkv|flv|mov)$/i, "")}.${format}`;
  }
  function parseCourseId(url) {
    const m = /[?&]course_id=([^&#]+)/.exec(String(url || ""));
    return m ? decodeURIComponent(m[1]) : "";
  }
  function buildManifest({ course, courseId, template, entries, generatedAt }) {
    const tpl = template || DEFAULT_TEMPLATE;
    return {
      schema: "course-fetch.manifest/v1",
      generatedAt: generatedAt || (/* @__PURE__ */ new Date()).toISOString(),
      course: { name: course || "", id: courseId || "" },
      template: tpl,
      count: entries.length,
      lectures: entries.map((e) => ({
        index: e.index,
        date: e.date,
        periodStart: e.periodStart,
        periodEnd: e.periodEnd,
        startTime: e.startTime,
        teacher: e.teacher,
        filename: formatFilename(tpl, e, { course })
      }))
    };
  }
  function buildListText({ course, template, entries }) {
    const lines = [`# ${course || "未命名课程"}（${entries.length} 条）`];
    for (const e of entries) {
      lines.push([formatFilename(template, e, { course }), e.startTime || e.date, e.teacher].join("	"));
    }
    return lines.join("\n");
  }
  function safeStringify(value) {
    const saved = Array.prototype.toJSON;
    if (saved) delete Array.prototype.toJSON;
    try {
      return JSON.stringify(value, null, 2);
    } finally {
      if (saved) Array.prototype.toJSON = saved;
    }
  }

  // src/hls.js
  var tagValue = (line) => line.slice(line.indexOf(":") + 1);
  function parseAttributes(str) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while (m = re.exec(str)) attrs[m[1]] = m[2].replace(/^"|"$/g, "");
    return attrs;
  }
  function parseHexIV(hex) {
    const h = String(hex).replace(/^0x/i, "");
    if (!/^[0-9a-f]{1,32}$/i.test(h)) throw new Error(`无效的 IV：${hex}`);
    const padded = h.padStart(32, "0");
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(padded.substr(i * 2, 2), 16);
    return out;
  }
  function ivForSequence(seq) {
    const out = new Uint8Array(16);
    let n = BigInt(seq);
    for (let i = 15; i >= 0 && n > 0n; i--) {
      out[i] = Number(n & 0xffn);
      n >>= 8n;
    }
    return out;
  }
  function parseM3U8(text, baseUrl) {
    const lines = String(text).replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines[0] !== "#EXTM3U") throw new Error("不是有效的 m3u8 播放列表（登录可能已失效）");
    let mediaSequence = 0;
    let key = null;
    let duration = null;
    let variant = null;
    let endList = false;
    const segments = [];
    const variants = [];
    for (const line of lines.slice(1)) {
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        mediaSequence = parseInt(tagValue(line), 10) || 0;
      } else if (line.startsWith("#EXT-X-KEY:")) {
        const a = parseAttributes(tagValue(line));
        const method = (a.METHOD || "NONE").toUpperCase();
        key = method === "NONE" ? null : {
          method,
          uri: a.URI ? new URL(a.URI, baseUrl).href : null,
          iv: a.IV ? parseHexIV(a.IV) : null,
          keyformat: a.KEYFORMAT || "identity"
        };
      } else if (line.startsWith("#EXTINF:")) {
        duration = parseFloat(tagValue(line));
      } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const a = parseAttributes(tagValue(line));
        variant = { bandwidth: Number(a.BANDWIDTH) || 0, resolution: a.RESOLUTION || "" };
      } else if (line.startsWith("#EXT-X-BYTERANGE") || line.startsWith("#EXT-X-MAP")) {
        throw new Error(`暂不支持 ${line.split(":")[0]}`);
      } else if (line === "#EXT-X-ENDLIST") {
        endList = true;
      } else if (!line.startsWith("#")) {
        const uri = new URL(line, baseUrl).href;
        if (variant) {
          variants.push({ ...variant, uri });
          variant = null;
        } else {
          segments.push({ uri, duration, seq: mediaSequence + segments.length, key });
          duration = null;
        }
      }
    }
    if (variants.length) return { type: "master", variants };
    return { type: "media", mediaSequence, endList, segments };
  }
  function pickVariant(variants) {
    return variants.reduce((best, v) => v.bandwidth > best.bandwidth ? v : best, variants[0]);
  }
  function assertSupported(segments) {
    for (const seg of segments) {
      const k = seg.key;
      if (!k) continue;
      if (k.method !== "AES-128" || String(k.keyformat).toLowerCase() !== "identity") {
        throw new Error(
          `不支持的加密方式 ${k.method}${k.keyformat !== "identity" ? ` / ${k.keyformat}` : ""}（可能是 DRM 保护，本工具不处理）`
        );
      }
      if (!k.uri) throw new Error("EXT-X-KEY 缺少 URI");
    }
  }

  // src/downloader.js
  var HttpError = class extends Error {
    constructor(status) {
      super(
        status === 401 || status === 403 ? `无权限访问（HTTP ${status}），请确认已登录且能在教学网正常播放该录像` : `HTTP ${status}`
      );
      this.status = status;
    }
  };
  function abortError() {
    const e = new Error("已取消");
    e.name = "AbortError";
    return e;
  }
  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortError();
  }
  function abortable(promise, signal) {
    promise = Promise.resolve(promise);
    if (!signal) return promise;
    if (signal.aborted) {
      promise.catch(() => {
      });
      return Promise.reject(abortError());
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        }
      );
    });
  }
  var sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  async function withRetry(fn, { attempts = 3, delayMs = 1e3, signal } = {}) {
    for (let i = 1; ; i++) {
      throwIfAborted(signal);
      try {
        return await fn();
      } catch (e) {
        if (e.name === "AbortError" || signal && signal.aborted) throw abortError();
        if (i >= attempts || e.fatal || e.status >= 400 && e.status < 500) throw e;
        await sleep(delayMs * i, signal);
      }
    }
  }
  function withTimeout(promise, ms) {
    let timer;
    return Promise.race([Promise.resolve(promise).catch(() => {
    }), new Promise((r) => {
      timer = setTimeout(r, ms);
    })]).finally(() => clearTimeout(timer));
  }
  async function fetchInOrder(count, { concurrency = 4, fetchOne, onData, signal }) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("分片并发数必须是正整数");
    throwIfAborted(signal);
    const pending = /* @__PURE__ */ new Map();
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let firstError = null;
    let next = 0;
    const start = () => {
      const i = next++;
      const p = Promise.resolve().then(() => {
        throwIfAborted(stop.signal);
        return fetchOne(i);
      });
      p.catch((error) => {
        if (!firstError) firstError = error;
        stop.abort();
      });
      pending.set(i, p);
    };
    while (next < count && pending.size < concurrency) start();
    try {
      for (let i = 0; i < count; i++) {
        const data = await abortable(pending.get(i), stop.signal);
        throwIfAborted(stop.signal);
        await abortable(Promise.resolve().then(() => {
          throwIfAborted(stop.signal);
          return onData(i, data);
        }), stop.signal);
        pending.delete(i);
        throwIfAborted(stop.signal);
        if (next < count) start();
      }
    } catch (error) {
      throw firstError || error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      pending.clear();
    }
  }
  function subtle() {
    const c = globalThis.crypto;
    if (!c || !c.subtle) throw new Error("当前环境不支持 WebCrypto（需要 HTTPS 页面）");
    return c.subtle;
  }
  function importAesKey(bytes2) {
    if (bytes2.byteLength !== 16) throw new Error(`AES-128 key 长度应为 16 字节，实际为 ${bytes2.byteLength} 字节`);
    return subtle().importKey("raw", bytes2, { name: "AES-CBC" }, false, ["decrypt"]);
  }
  async function decryptAes128(data, cryptoKey, iv) {
    return new Uint8Array(await subtle().decrypt({ name: "AES-CBC", iv }, cryptoKey, data));
  }
  function looksLikeTs(bytes2) {
    if (!bytes2 || bytes2.length < 1 || bytes2[0] !== 71) return false;
    return bytes2.length <= 188 || bytes2[188] === 71;
  }
  async function downloadHls({
    playlistUrl,
    request,
    write,
    onProgress = () => {
    },
    concurrency = 4,
    retryDelayMs = 1e3,
    signal
  }) {
    const req = (url, type, resource) => abortable(request(url, type, signal, resource), signal);
    let res = await req(playlistUrl, "text", { kind: "m3u8" });
    let playlist = parseM3U8(res.data, res.finalUrl || playlistUrl);
    if (playlist.type === "master") {
      const v = pickVariant(playlist.variants);
      res = await req(v.uri, "text", { kind: "m3u8-variant" });
      playlist = parseM3U8(res.data, res.finalUrl || v.uri);
      if (playlist.type !== "media") throw new Error("无法解析多级 master playlist");
    }
    const { segments } = playlist;
    if (!segments.length) throw new Error("播放列表中没有分片");
    assertSupported(segments);
    const keys = /* @__PURE__ */ new Map();
    const getKey = (uri) => {
      if (!keys.has(uri)) {
        const p = req(uri, "arraybuffer", { kind: "key" }).then((r) => importAesKey(new Uint8Array(r.data)));
        p.catch(() => keys.delete(uri));
        keys.set(uri, p);
      }
      return keys.get(uri);
    };
    const total = segments.length;
    const totalSeconds = segments.reduce((sum, seg) => sum + (seg.duration || 0), 0);
    const progress = { phase: "download", done: 0, total, bytes: 0, seconds: 0, totalSeconds, badTs: 0 };
    onProgress({ ...progress });
    await fetchInOrder(total, {
      concurrency,
      signal,
      fetchOne: (i) => withRetry(
        async () => {
          const seg = segments[i];
          const r = await req(seg.uri, "arraybuffer", { kind: "segment", index: i + 1, total });
          if (!seg.key) return new Uint8Array(r.data);
          const cryptoKey = await getKey(seg.key.uri);
          try {
            return await decryptAes128(r.data, cryptoKey, seg.key.iv || ivForSequence(seg.seq));
          } catch (e) {
            const err = new Error(`第 ${i + 1} 个分片解密失败（key 或 IV 不匹配）`);
            err.fatal = true;
            throw err;
          }
        },
        { delayMs: retryDelayMs, signal }
      ).catch((e) => {
        if (e.name !== "AbortError" && !e.resource && !e.message.startsWith("第 ")) {
          e.message = `第 ${i + 1} / ${total} 个分片：${e.message}`;
        }
        throw e;
      }),
      onData: async (i, data) => {
        await abortable(Promise.resolve(write(data)), signal);
        progress.done = i + 1;
        progress.bytes += data.byteLength;
        progress.seconds += segments[i].duration || 0;
        if (!looksLikeTs(data)) progress.badTs += 1;
        onProgress({ ...progress });
      }
    });
    return { segments: total, duration: totalSeconds, bytes: progress.bytes, badTs: progress.badTs };
  }
  function describeResource(resource) {
    const r = resource || {};
    switch (r.kind) {
      case "playVideo":
        return "playVideo 页面";
      case "frame":
        return "播放页 iframe";
      case "m3u8":
        return "m3u8 播放列表";
      case "m3u8-variant":
        return "m3u8 子播放列表";
      case "key":
        return "AES key";
      case "segment":
        return r.index ? `TS 分片 ${r.index}/${r.total}` : "TS 分片";
      default:
        return "资源";
    }
  }
  function hostnameOf(url) {
    try {
      return new URL(url).hostname;
    } catch (_) {
      return "(无效 URL)";
    }
  }
  function annotateRequestError(err, { url, type, resource, via, detail }) {
    const hostname = hostnameOf(url);
    const what = describeResource(resource);
    const sep = /[A-Za-z0-9]$/.test(what) ? " " : "";
    err.message = `请求 ${what}${sep}失败（${hostname}）：${err.message}`;
    err.resource = { ...resource || {}, name: what, url, hostname, type };
    console.warn(`[Course Fetch] request failed: ${url}`, {
      resource: what,
      hostname,
      type,
      via,
      status: err.status,
      message: err.message,
      detail
    });
    return err;
  }
  function networkErrorMessage(r, hostname) {
    const reason = r && (r.error || r.statusText);
    let msg = `网络错误（${reason ? `Tampermonkey: ${reason}` : "Tampermonkey 未返回详细原因"}）`;
    if (!/(^|\.)pku\.edu\.cn$/i.test(hostname)) {
      msg += `；${hostname} 不在 @connect 列表中，请在 Tampermonkey 弹窗中允许该域名，或在脚本头部添加 // @connect ${hostname}`;
    } else {
      msg += "；如果 Tampermonkey 拦截了跨域请求，请允许该域名";
    }
    return msg;
  }
  function gmRequest(url, type, signal, resource) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      const fail = (err, via, detail) => reject(annotateRequestError(err, { url, type, resource, via, detail }));
      if (typeof GM_xmlhttpRequest !== "function") {
        fetch(url, { credentials: "include", signal }).then(async (res) => {
          if (!res.ok) {
            const err = new HttpError(res.status);
            err.detail = { status: res.status, statusText: res.statusText, finalUrl: res.url };
            throw err;
          }
          resolve({ data: type === "text" ? await res.text() : await res.arrayBuffer(), finalUrl: res.url });
        }).catch((e) => {
          if (e && e.name === "AbortError") return reject(abortError());
          fail(e, "fetch", e.detail || e);
        });
        return;
      }
      const onAbort = () => {
        try {
          xhr && xhr.abort();
        } catch (_) {
        }
        reject(abortError());
      };
      const done = () => signal && signal.removeEventListener("abort", onAbort);
      const xhr = GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: type === "text" ? void 0 : "arraybuffer",
        timeout: 6e4,
        onload: (r) => {
          done();
          if (r.status < 200 || r.status >= 300) {
            return fail(new HttpError(r.status), "GM_xmlhttpRequest", {
              status: r.status,
              statusText: r.statusText,
              finalUrl: r.finalUrl,
              responseHeaders: r.responseHeaders
            });
          }
          resolve({ data: type === "text" ? r.responseText : r.response, finalUrl: r.finalUrl || url });
        },
        onerror: (r) => {
          done();
          fail(new Error(networkErrorMessage(r, hostnameOf(url))), "GM_xmlhttpRequest", r);
        },
        ontimeout: (r) => {
          done();
          fail(new Error("请求超时（60 秒）"), "GM_xmlhttpRequest", r);
        },
        onabort: () => {
          done();
          reject(abortError());
        }
      });
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  function saveBlob(blob, filename, onRelease) {
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    try {
      document.body.appendChild(a);
      a.click();
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    } finally {
      a.remove();
    }
    setTimeout(() => {
      URL.revokeObjectURL(url);
      if (onRelease) Promise.resolve().then(onRelease).catch(() => {
      });
    }, 6e4);
  }
  function memorySink(filename, save = saveBlob) {
    const mime = /\.mp4$/i.test(filename) ? "video/mp4" : "video/mp2t";
    let chunks = [];
    return {
      kind: "memory",
      write: (d) => {
        chunks.push(d);
      },
      writeAt: (position, data) => {
        let o = 0;
        for (const [i, c] of chunks.entries()) {
          if (position >= o && position + data.length <= o + c.length) {
            const copy = c.slice();
            copy.set(data, position - o);
            chunks[i] = copy;
            return;
          }
          o += c.length;
        }
        throw new Error("内存写入位置无效");
      },
      close: async () => {
        await save(new Blob(chunks, { type: mime }), filename);
        chunks = [];
      },
      abort: () => {
        chunks = [];
      }
    };
  }

  // src/storage.js
  var store = {
    get(k, d) {
      try {
        return typeof GM_getValue === "function" ? GM_getValue(k, d) : d;
      } catch (_) {
        return d;
      }
    },
    set(k, v) {
      try {
        if (typeof GM_setValue === "function") GM_setValue(k, v);
      } catch (_) {
      }
    },
    delete(k) {
      try {
        if (typeof GM_deleteValue === "function") GM_deleteValue(k);
      } catch (_) {
      }
    },
    /** 监听其它标签页 / frame 对 k 的修改，cb(newValue)。返回取消监听的函数。 */
    onChange(k, cb) {
      if (typeof GM_addValueChangeListener !== "function") return () => {
      };
      let id;
      try {
        id = GM_addValueChangeListener(k, (name, oldValue, newValue) => cb(newValue));
      } catch (_) {
        return () => {
        };
      }
      return () => {
        try {
          if (typeof GM_removeValueChangeListener === "function") GM_removeValueChangeListener(id);
        } catch (_) {
        }
      };
    }
  };

  // src/capture-context.js
  var PARAM = "course-fetch-capture";
  var REQUEST = "course-fetch:capture-context-request";
  var RESPONSE = "course-fetch:capture-context-response";
  function captureTabUrl(watchUrl, id) {
    const url = new URL(watchUrl);
    const fragment = url.hash.slice(1);
    url.hash = `${fragment ? `${fragment}&` : ""}${PARAM}=${encodeURIComponent(id)}`;
    return url.href;
  }
  function captureIdFromUrl(url) {
    try {
      return new URLSearchParams(new URL(url).hash.slice(1)).get(PARAM);
    } catch (_) {
      return null;
    }
  }
  function resolveCaptureId(win, timeoutMs = 3e3) {
    const ownId = captureIdFromUrl(win.location.href);
    if (ownId) return Promise.resolve(ownId);
    if (win.parent === win) return Promise.resolve(null);
    return new Promise((resolve) => {
      const finish = (id) => {
        clearTimeout(timeout);
        clearInterval(retry);
        win.removeEventListener("message", receive);
        win.removeEventListener("pagehide", leave);
        resolve(id);
      };
      const receive = (event) => {
        if (event.source === win.parent && event.data?.type === RESPONSE && typeof event.data.id === "string") finish(event.data.id);
      };
      const leave = () => finish(null);
      const ask = () => win.parent.postMessage({ type: REQUEST }, "*");
      win.addEventListener("message", receive);
      win.addEventListener("pagehide", leave, { once: true });
      const timeout = setTimeout(() => finish(null), timeoutMs);
      const retry = setInterval(ask, 100);
      ask();
    });
  }
  function bridgeCaptureId(win, id, valid) {
    const receive = (event) => {
      if (event.data?.type !== REQUEST || !valid()) return;
      for (let i = 0; i < win.frames.length; i++) {
        if (event.source === win.frames[i]) {
          event.source.postMessage({ type: RESPONSE, id }, event.origin === "null" ? "*" : event.origin);
          break;
        }
      }
    };
    win.addEventListener("message", receive);
    return () => win.removeEventListener("message", receive);
  }

  // src/capture.js
  var PENDING_KEY = "capture:pending";
  var RESULT_KEY = "capture:result";
  var CAPTURE_TIMEOUT_MS = 2e4;
  var pendingKey = (id) => `${PENDING_KEY}:${id}`;
  var resultKey = (id) => `${RESULT_KEY}:${id}`;
  function isM3u8Url(url) {
    return /^https?:\/\/\S+?\.m3u8(?:[?#]|$)/i.test(String(url || ""));
  }
  function watchM3u8Requests(onUrl, { perf = globalThis.performance, Observer = globalThis.PerformanceObserver, pollMs = 500 } = {}) {
    let stopped = false;
    const seen = /* @__PURE__ */ new Set();
    const check = (entries) => {
      for (let i = 0; entries && i < entries.length && !stopped; i++) {
        const name = entries[i] && entries[i].name;
        if (isM3u8Url(name) && !seen.has(name)) {
          seen.add(name);
          onUrl(name);
        }
      }
    };
    const scan = () => {
      try {
        check(perf.getEntriesByType("resource"));
      } catch (_) {
      }
    };
    try {
      if (perf && typeof perf.setResourceTimingBufferSize === "function") perf.setResourceTimingBufferSize(1e3);
    } catch (_) {
    }
    let observer = null;
    if (typeof Observer === "function") {
      try {
        observer = new Observer((list) => check(list.getEntries()));
        observer.observe({ type: "resource", buffered: true });
      } catch (_) {
        observer = null;
      }
    }
    scan();
    const timer = setInterval(scan, pollMs);
    return () => {
      stopped = true;
      clearInterval(timer);
      if (observer) observer.disconnect();
    };
  }
  function nudgePlayback(doc) {
    if (!doc || typeof doc.querySelectorAll !== "function") return;
    const videos = doc.querySelectorAll("video");
    for (let i = 0; i < videos.length; i++) {
      try {
        videos[i].muted = true;
        const p = videos[i].play();
        if (p && typeof p.catch === "function") p.catch(() => {
        });
      } catch (_) {
      }
    }
  }
  async function runPlayerCapture({
    kv = store,
    now = Date.now,
    watch = watchM3u8Requests,
    host = typeof location !== "undefined" ? location.hostname : "",
    doc = typeof document !== "undefined" ? document : null,
    maxWaitMs = CAPTURE_TIMEOUT_MS,
    nudgeAfterMs = 3e3,
    win = typeof window !== "undefined" ? window : null,
    captureId
  } = {}) {
    const id = captureId || win && await resolveCaptureId(win, maxWaitMs);
    if (!id) return false;
    const key = pendingKey(id);
    const valid = () => {
      const pending = kv.get(key, null);
      return pending?.id === id && pending.expires > now();
    };
    if (!valid()) return false;
    console.info(`[Course Fetch] 正在捕获播放列表（${host}）`);
    let done = false;
    let stop = () => {
    };
    let unlisten = () => {
    };
    const stopBridge = win ? bridgeCaptureId(win, id, valid) : () => {
    };
    const finish = () => {
      if (done) return;
      done = true;
      stop();
      unlisten();
      stopBridge();
      clearTimeout(giveUp);
      clearTimeout(nudge);
      clearInterval(poll);
      win?.removeEventListener("pagehide", finish);
    };
    const giveUp = setTimeout(finish, maxWaitMs);
    const nudge = setTimeout(() => nudgePlayback(doc), nudgeAfterMs);
    const poll = setInterval(() => {
      if (!valid()) finish();
    }, 500);
    unlisten = kv.onChange(key, () => {
      if (!valid()) finish();
    });
    win?.addEventListener("pagehide", finish, { once: true });
    stop = watch((url) => {
      if (done) return;
      finish();
      if (valid() && isM3u8Url(url)) kv.set(resultKey(id), { id, url, host });
    });
    if (done) stop();
    return true;
  }
  function openCaptureTab(url) {
    if (typeof GM_openInTab === "function") return GM_openInTab(url, { active: false, insert: true, setParent: true });
    return window.open(url, "_blank");
  }
  function captureTimeoutError(ms) {
    const e = new Error(`自动捕获播放列表超时（${Math.round(ms / 1e3)} 秒）`);
    e.name = "CaptureTimeout";
    return e;
  }
  function capturePlaylist({
    watchUrl,
    signal,
    timeoutMs = CAPTURE_TIMEOUT_MS,
    kv = store,
    openTab = openCaptureTab,
    newId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    pollMs = 500
  }) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      const id = newId();
      const pending = pendingKey(id);
      const result = resultKey(id);
      let tab = null;
      let done = false;
      let unlisten = () => {
      };
      let poll = null;
      let timer = null;
      const finish = (settle, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        unlisten();
        if (signal) signal.removeEventListener("abort", onAbort);
        kv.delete(pending);
        kv.delete(result);
        try {
          if (tab && typeof tab.close === "function") tab.close();
        } catch (_) {
        }
        settle(value);
      };
      const accept = (val) => {
        if (val && val.id === id && isM3u8Url(val.url)) {
          console.info(`[Course Fetch] 已捕获播放列表（来自 ${val.host || "播放页"}）`);
          finish(resolve, val.url);
        }
      };
      const onAbort = () => finish(reject, abortError());
      kv.set(pending, { id, expires: Date.now() + timeoutMs + 5e3 });
      unlisten = kv.onChange(result, accept);
      poll = setInterval(() => accept(kv.get(result, null)), pollMs);
      timer = setTimeout(() => finish(reject, captureTimeoutError(timeoutMs)), timeoutMs);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      try {
        tab = openTab(captureTabUrl(watchUrl, id));
        if (done && tab && typeof tab.close === "function") tab.close();
      } catch (e) {
        finish(reject, e);
      }
    });
  }

  // src/page.js
  function resolveUrl(href, base) {
    const h = String(href || "").trim();
    if (!h || h === "#" || /^javascript:/i.test(h)) return null;
    try {
      const u = new URL(h, base);
      return /^https?:$/.test(u.protocol) ? u.href : null;
    } catch (_) {
      return null;
    }
  }
  function linkTarget(a, base) {
    const href = a.getAttribute("href");
    const direct = resolveUrl(href, base);
    if (direct) return direct;
    const src = `${href || ""} ${a.getAttribute("onclick") || ""}`;
    const m = /['"]([^'"\s]+\.(?:action|do|jsp|php|html?)(?:\?[^'"\s]*)?)['"]/i.exec(src);
    return m ? resolveUrl(m[1], base) : null;
  }
  function toList(collection) {
    const out = [];
    if (collection) for (let i = 0; i < collection.length; i++) out.push(collection[i]);
    return out;
  }
  function textOf(node) {
    return node && typeof node.textContent === "string" ? normalizeText(node.textContent) : "";
  }
  function rowText(tr) {
    const cells = toList(tr.cells || tr.children);
    if (cells.length) return cells.map(textOf).join(" ");
    return textOf(tr);
  }
  function extractCols(tr) {
    if (typeof tr.querySelector !== "function") return null;
    const th = tr.querySelector('th[scope="row"]');
    const values = toList(tr.querySelectorAll("td .table-data-cell-value"));
    if (!th || values.length < 2) return null;
    return {
      title: textOf(th),
      startTime: textOf(values[0]),
      teacher: textOf(values[1])
    };
  }
  function isNextPage(a, label) {
    const id = a.getAttribute("id") || "";
    if (a.getAttribute("aria-disabled") === "true") return false;
    if (/(?:^|_)nextpage(?:_|$)/i.test(id)) return true;
    if ((a.getAttribute("rel") || "").toLowerCase().split(/\s+/).includes("next")) return true;
    const labels = [label, a.getAttribute("title"), a.getAttribute("aria-label")];
    if (typeof a.querySelectorAll === "function") {
      for (const img of toList(a.querySelectorAll("img"))) labels.push(img.getAttribute("alt"));
    }
    return labels.some((s) => /^(下一页|next(?:\s+page)?)$/i.test(normalizeText(s)));
  }
  function extractPage(doc, baseUrl) {
    const rows = [];
    const issues = [];
    let next = null;
    for (const a of toList(doc.querySelectorAll("a"))) {
      const label = textOf(a);
      if (label === "观看" || label === "预览") {
        const tr = a.closest ? a.closest("tr") : null;
        if (!tr) {
          issues.push(`有一个“${label}”链接不在表格行内，已跳过`);
          continue;
        }
        const cols = extractCols(tr);
        if (cols) rows.push({ cols, watchUrl: linkTarget(a, baseUrl) });
        else rows.push({ text: rowText(tr), watchUrl: linkTarget(a, baseUrl) });
      } else if ((!next || !next.url) && isNextPage(a, label)) {
        next = { url: linkTarget(a, baseUrl), hasHref: a.getAttribute("href") != null };
      }
    }
    return { rows, next, issues };
  }
  async function crawlCourse({ firstDoc, firstUrl, fetchDoc, maxPages = 50, onProgress = () => {
  } }) {
    const stripHash = (u) => String(u).split("#")[0];
    const warnings = [];
    const rows = [];
    const visited = /* @__PURE__ */ new Set([stripHash(firstUrl)]);
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
        break;
      }
      const url = stripHash(page.next.url);
      if (visited.has(url)) {
        warnings.push("翻页链接指向已读取过的页面，停止翻页");
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
    if (!rows.length) warnings.push("当前页面没有找到文本为“观看”或“预览”的链接");
    const status = `共 ${pageNo} 页，${sorted.length} 条录像` + (failures.length ? `，${failures.length} 行解析失败` : "");
    return { entries: sorted, duplicates, failures, warnings, pages: pageNo, status };
  }
  async function locatePlaylist(watchUrl, { signal, capture = capturePlaylist, ask = askPlaylistUrl, allowManual = true } = {}) {
    try {
      return await capture({ watchUrl, signal });
    } catch (e) {
      if (e.name !== "CaptureTimeout" || !allowManual) throw e;
      console.warn(`[Course Fetch] ${e.message}，改为手动输入`);
    }
    if (signal && signal.aborted) throw abortError();
    return ask();
  }
  function askPlaylistUrl() {
    const manual = prompt(
      "自动捕获播放列表超时。\n可以打开该录像的播放页，按 F12 → Network 搜索 “m3u8”，复制请求地址粘贴到这里："
    );
    if (manual && /^https?:\/\/\S+\.m3u8/i.test(manual.trim())) return manual.trim();
    if (manual === null) throw abortError();
    throw new Error("未找到 playlist.m3u8");
  }
  function detectCourseName() {
    const docs = [document];
    for (const w of [window.parent, window.top]) {
      try {
        if (w && w !== window && w.document && !docs.includes(w.document)) docs.push(w.document);
      } catch (_) {
      }
    }
    const selectors = [
      "#courseMenuPalette_paletteTitleHeading",
      "#courseMenu_link",
      ".courseName",
      ".course-name",
      "#crumb_1"
    ];
    for (const d of docs) {
      for (const sel of selectors) {
        const el = d.querySelector(sel);
        if (!el) continue;
        const txt = normalizeText(el.textContent) || normalizeText(el.getAttribute("title"));
        if (txt && txt.length <= 80) return txt;
      }
    }
    for (const d of docs) {
      const body = normalizeText(d.body && d.body.textContent).slice(0, 5e3);
      const m = /课程名称\s*[:：]\s*([^\s|]+)/.exec(body);
      if (m) return m[1];
    }
    for (const d of docs) {
      const title = normalizeText(d.title);
      if (title && !/^(课堂实录|教学网|Blackboard|北京大学)/i.test(title)) return title;
    }
    return "";
  }
  async function fetchDocument(url) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const headerCharset = (/charset=([\w-]+)/i.exec(res.headers.get("content-type") || "") || [])[1];
    const decode = (cs) => {
      try {
        return new TextDecoder(cs).decode(buf);
      } catch (_) {
        return null;
      }
    };
    let html = decode(headerCharset || document.characterSet || "utf-8") || decode("utf-8");
    if (!headerCharset) {
      const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(html.slice(0, 4096));
      if (meta && meta[1].toLowerCase() !== String(document.characterSet).toLowerCase()) {
        html = decode(meta[1]) || html;
      }
    }
    return new DOMParser().parseFromString(html, "text/html");
  }

  // src/scheduler.js
  function positiveInteger(value, name) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} 必须是正整数`);
    return value;
  }
  function createRequestLimiter(limit = 8) {
    positiveInteger(limit, "请求上限");
    let active = 0;
    const queue = [];
    function pump() {
      while (active < limit && queue.length) {
        const job = queue.shift();
        job.signal?.removeEventListener("abort", job.onAbort);
        if (job.signal?.aborted) {
          job.reject(abortError());
          continue;
        }
        active++;
        Promise.resolve().then(() => {
          if (job.signal?.aborted) throw abortError();
          return job.fn();
        }).then(job.resolve, job.reject).finally(() => {
          active--;
          pump();
        });
      }
    }
    return {
      get active() {
        return active;
      },
      get queued() {
        return queue.length;
      },
      run(fn, signal) {
        if (signal?.aborted) return Promise.reject(abortError());
        return new Promise((resolve, reject) => {
          const job = { fn, signal, resolve, reject, onAbort: null };
          job.onAbort = () => {
            const index = queue.indexOf(job);
            if (index !== -1) queue.splice(index, 1);
            reject(abortError());
          };
          signal?.addEventListener("abort", job.onAbort, { once: true });
          queue.push(job);
          pump();
        });
      },
      wrap(request) {
        return (url, type, signal, resource) => this.run(() => request(url, type, signal, resource), signal);
      }
    };
  }

  // src/ts-demux.js
  var PACKET = 188;
  var STREAM_TYPE_NAMES = {
    1: "MPEG-1 视频",
    2: "MPEG-2 视频",
    3: "MPEG-1 音频（MP3）",
    4: "MPEG-2 音频（MP3）",
    6: "私有 PES 数据（可能是 AC-3 或字幕）",
    15: "AAC（ADTS）",
    16: "MPEG-4 Part 2 视频",
    17: "AAC（LATM）",
    27: "H.264/AVC",
    36: "H.265/HEVC",
    66: "AVS 视频",
    129: "AC-3",
    135: "E-AC-3",
    234: "VC-1"
  };
  var SUPPORTED_STREAM_TYPES = { 27: "video", 15: "audio" };
  var IGNORED_STREAM_TYPES = /* @__PURE__ */ new Set([5, 21, 134]);
  var streamTypeName = (type) => STREAM_TYPE_NAMES[type] || `未知类型 0x${type.toString(16).padStart(2, "0")}`;
  function concat(parts, size) {
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(size);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
  function readTimestamp(b, o) {
    return (b[o] & 14) * 536870912 + b[o + 1] * 4194304 + (b[o + 2] & 254) * 16384 + b[o + 3] * 128 + (b[o + 4] >> 1);
  }
  var TsDemuxer = class {
    constructor() {
      this.carry = null;
      this.pmtPid = -1;
      this.streams = null;
      this.signature = "";
      this.kinds = /* @__PURE__ */ new Map();
      this.sections = /* @__PURE__ */ new Map();
      this.pes = /* @__PURE__ */ new Map();
      this.packets = 0;
      this.resyncs = 0;
      this.errors = 0;
    }
    /** 输入一块 TS 字节，返回在这块中结束的 PES：[{ pid, kind, pts, dts, data }]。 */
    push(chunk) {
      const out = [];
      let i = 0;
      if (this.carry) {
        const need = PACKET - this.carry.length;
        if (chunk.length < need) {
          this.carry = concat([this.carry, chunk], this.carry.length + chunk.length);
          return out;
        }
        const packet = concat([this.carry, chunk.subarray(0, need)], PACKET);
        this.carry = null;
        if (chunk.length === need || chunk[need] === 71) {
          this.packet(packet, 0, out);
          i = need;
        } else {
          this.resyncs++;
        }
      }
      const n = chunk.length;
      while (i < n) {
        if (chunk[i] !== 71) {
          const j = this.resync(chunk, i);
          if (j < 0) break;
          i = j;
        }
        if (i + PACKET > n) {
          this.carry = chunk.slice(i);
          break;
        }
        this.packet(chunk, i, out);
        i += PACKET;
      }
      return out;
    }
    /** 输入结束：输出所有未结束的 PES。 */
    flush() {
      const out = [];
      for (const [pid, s] of this.pes) this.emit(pid, s, out);
      this.pes.clear();
      this.carry = null;
      return out;
    }
    resync(chunk, i) {
      this.resyncs++;
      for (let j = i + 1; j < chunk.length; j++) {
        if (chunk[j] === 71 && (j + PACKET >= chunk.length || chunk[j + PACKET] === 71)) return j;
      }
      return -1;
    }
    packet(d, off, out) {
      this.packets++;
      if (d[off + 1] & 128) {
        this.errors++;
        return;
      }
      const pusi = (d[off + 1] & 64) !== 0;
      const pid = (d[off + 1] & 31) << 8 | d[off + 2];
      const afc = d[off + 3] >> 4 & 3;
      let p = off + 4;
      if (afc & 2) p += 1 + d[off + 4];
      if (!(afc & 1) || p >= off + PACKET) return;
      const payload = d.subarray(p, off + PACKET);
      if (pid === 0) this.section(pid, pusi, payload, (s) => this.parsePat(s));
      else if (pid === this.pmtPid) this.section(pid, pusi, payload, (s) => this.parsePmt(s));
      else if (this.kinds.has(pid)) this.pesPacket(pid, pusi, payload, out);
    }
    section(pid, pusi, payload, onSection) {
      let s = this.sections.get(pid);
      if (pusi) {
        const start = 1 + payload[0];
        if (start >= payload.length) return;
        s = { parts: [payload.subarray(start)], size: payload.length - start };
      } else if (s) {
        s.parts.push(payload);
        s.size += payload.length;
      } else {
        return;
      }
      const buf = concat(s.parts, s.size);
      if (buf.length >= 3) {
        const len = 3 + ((buf[1] & 15) << 8 | buf[2]);
        if (buf.length >= len) {
          this.sections.delete(pid);
          onSection(buf.subarray(0, len));
          return;
        }
      }
      this.sections.set(pid, { parts: [buf], size: buf.length });
    }
    parsePat(s) {
      if (s[0] !== 0) return;
      for (let o = 8; o + 4 <= s.length - 4; o += 4) {
        const program = s[o] << 8 | s[o + 1];
        if (program === 0) continue;
        this.pmtPid = (s[o + 2] & 31) << 8 | s[o + 3];
        return;
      }
    }
    parsePmt(s) {
      if (s[0] !== 2) return;
      const end = s.length - 4;
      const streams = [];
      for (let o = 12 + ((s[10] & 15) << 8 | s[11]); o + 5 <= end; ) {
        const type = s[o];
        const pid = (s[o + 1] & 31) << 8 | s[o + 2];
        const kind = SUPPORTED_STREAM_TYPES[type] || (IGNORED_STREAM_TYPES.has(type) ? "ignored" : "unsupported");
        streams.push({ pid, type, kind });
        o += 5 + ((s[o + 3] & 15) << 8 | s[o + 4]);
      }
      const signature = streams.map((x) => `${x.pid}:${x.type}`).join(",");
      if (this.streams) {
        if (signature !== this.signature) {
          const err = new Error("录像中途改变了音视频流结构（PMT），无法无损封装为单个 MP4");
          err.fatal = true;
          throw err;
        }
        return;
      }
      this.streams = streams;
      this.signature = signature;
      for (const x of streams) if (x.kind === "video" || x.kind === "audio") this.kinds.set(x.pid, x.kind);
    }
    pesPacket(pid, pusi, payload, out) {
      let s = this.pes.get(pid);
      if (pusi) {
        if (s) this.emit(pid, s, out);
        const len = payload.length >= 6 ? payload[4] << 8 | payload[5] : 0;
        s = { parts: [], size: 0, expected: len ? len + 6 : 0 };
        this.pes.set(pid, s);
      } else if (!s) {
        return;
      }
      s.parts.push(payload);
      s.size += payload.length;
      if (s.expected && s.size >= s.expected) {
        this.pes.delete(pid);
        this.emit(pid, s, out);
      }
    }
    emit(pid, s, out) {
      if (!s.size) return;
      const buf = concat(s.parts, s.size);
      if (buf.length < 9 || buf[0] !== 0 || buf[1] !== 0 || buf[2] !== 1) {
        this.errors++;
        return;
      }
      const flags = buf[7];
      const pts = flags & 128 ? readTimestamp(buf, 9) : null;
      const dts = flags & 64 ? readTimestamp(buf, 14) : pts;
      const end = s.expected ? Math.min(s.expected, buf.length) : buf.length;
      out.push({ pid, kind: this.kinds.get(pid), pts, dts, data: buf.subarray(9 + buf[8], end) });
    }
  };

  // src/codecs.js
  function splitAnnexB(data) {
    const nals = [];
    const n = data.length;
    let start = -1;
    let i = 0;
    while (i + 2 < n) {
      if (data[i + 2] > 1) {
        i += 3;
      } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
        if (start >= 0) pushNal(nals, data, start, i);
        start = i + 3;
        i += 3;
      } else {
        i++;
      }
    }
    if (start >= 0) pushNal(nals, data, start, n);
    return nals;
  }
  function pushNal(nals, data, start, end) {
    while (end > start && data[end - 1] === 0) end--;
    if (end > start) nals.push(data.subarray(start, end));
  }
  function unescapeRbsp(nal) {
    const out = new Uint8Array(nal.length);
    let n = 0;
    let zeros = 0;
    for (let i = 0; i < nal.length; i++) {
      const byte = nal[i];
      if (zeros >= 2 && byte === 3) {
        zeros = 0;
        continue;
      }
      out[n++] = byte;
      zeros = byte === 0 ? zeros + 1 : 0;
    }
    return out.subarray(0, n);
  }
  var BitReader = class {
    constructor(bytes2) {
      this.bytes = bytes2;
      this.pos = 0;
    }
    u(bits) {
      let v = 0;
      for (let i = 0; i < bits; i++) {
        const byte = this.bytes[this.pos >> 3];
        if (byte === void 0) throw new Error("SPS 数据不完整");
        v = v * 2 + (byte >> 7 - (this.pos & 7) & 1);
        this.pos++;
      }
      return v;
    }
    ue() {
      let zeros = 0;
      while (this.u(1) === 0) if (++zeros > 31) throw new Error("SPS 中的 Exp-Golomb 数值无效");
      return 2 ** zeros - 1 + this.u(zeros);
    }
    se() {
      const k = this.ue();
      return k & 1 ? (k + 1) / 2 : -k / 2;
    }
  };
  var HIGH_PROFILES = /* @__PURE__ */ new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);
  function parseSps(nal) {
    const r = new BitReader(unescapeRbsp(nal.subarray(1)));
    const profileIdc = r.u(8);
    const constraintFlags = r.u(8);
    const levelIdc = r.u(8);
    r.ue();
    let chromaFormatIdc = 1;
    let separateColourPlane = 0;
    let bitDepthLuma = 8;
    let bitDepthChroma = 8;
    if (HIGH_PROFILES.has(profileIdc)) {
      chromaFormatIdc = r.ue();
      if (chromaFormatIdc === 3) separateColourPlane = r.u(1);
      bitDepthLuma = r.ue() + 8;
      bitDepthChroma = r.ue() + 8;
      r.u(1);
      if (r.u(1)) {
        for (let i = 0; i < (chromaFormatIdc !== 3 ? 8 : 12); i++) {
          if (!r.u(1)) continue;
          const size = i < 6 ? 16 : 64;
          let last = 8;
          let next = 8;
          for (let j = 0; j < size; j++) {
            if (next !== 0) next = (last + r.se() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
      }
    }
    r.ue();
    const pocType = r.ue();
    if (pocType === 0) r.ue();
    else if (pocType === 1) {
      r.u(1);
      r.se();
      r.se();
      const n = r.ue();
      for (let i = 0; i < n; i++) r.se();
    }
    r.ue();
    r.u(1);
    const widthMbs = r.ue() + 1;
    const heightMapUnits = r.ue() + 1;
    const frameMbsOnly = r.u(1);
    if (!frameMbsOnly) r.u(1);
    r.u(1);
    let crop = [0, 0, 0, 0];
    if (r.u(1)) crop = [r.ue(), r.ue(), r.ue(), r.ue()];
    const chroma = separateColourPlane ? 0 : chromaFormatIdc;
    const cropX = chroma === 1 || chroma === 2 ? 2 : 1;
    const cropY = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
    return {
      profileIdc,
      constraintFlags,
      levelIdc,
      chromaFormatIdc,
      bitDepthLuma,
      bitDepthChroma,
      highProfile: HIGH_PROFILES.has(profileIdc),
      width: widthMbs * 16 - cropX * (crop[0] + crop[1]),
      height: (2 - frameMbsOnly) * heightMapUnits * 16 - cropY * (crop[2] + crop[3])
    };
  }
  function ppsId(nal) {
    return new BitReader(unescapeRbsp(nal.subarray(1, 8))).ue();
  }
  var AAC_SAMPLE_RATES = [96e3, 88200, 64e3, 48e3, 44100, 32e3, 24e3, 22050, 16e3, 12e3, 11025, 8e3, 7350];
  function parseAdtsHeader(b, o) {
    if (o + 7 > b.length || b[o] !== 255 || (b[o + 1] & 246) !== 240) return null;
    const sampleRateIndex = b[o + 2] >> 2 & 15;
    return {
      headerLength: b[o + 1] & 1 ? 7 : 9,
      frameLength: (b[o + 3] & 3) << 11 | b[o + 4] << 3 | b[o + 5] >> 5,
      objectType: (b[o + 2] >> 6) + 1,
      sampleRateIndex,
      sampleRate: AAC_SAMPLE_RATES[sampleRateIndex] || 0,
      channelConfig: (b[o + 2] & 1) << 2 | b[o + 3] >> 6,
      rawBlocks: b[o + 6] & 3
    };
  }
  function audioSpecificConfig({ objectType, sampleRateIndex, channelConfig }) {
    return new Uint8Array([objectType << 3 | sampleRateIndex >> 1, (sampleRateIndex & 1) << 7 | channelConfig << 3]);
  }

  // src/mp4-mux.js
  var UINT32 = 4294967296;
  var GrowU32 = class {
    constructor(capacity = 1024) {
      this.data = new Uint32Array(capacity);
      this.length = 0;
    }
    push(v) {
      if (this.length === this.data.length) {
        const next = new Uint32Array(this.data.length * 2);
        next.set(this.data);
        this.data = next;
      }
      this.data[this.length++] = v;
    }
    get last() {
      return this.data[this.length - 1];
    }
    set last(v) {
      this.data[this.length - 1] = v;
    }
  };
  var RunTable = class {
    constructor() {
      this.counts = new GrowU32(64);
      this.values = new GrowU32(64);
    }
    add(value, count = 1) {
      if (this.counts.length && this.values.last === value >>> 0) this.counts.last += count;
      else {
        this.counts.push(count);
        this.values.push(value >>> 0);
      }
    }
    get length() {
      return this.counts.length;
    }
  };
  var ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  function bytes(...fields) {
    const size = fields.reduce((n, [bits]) => n + bits / 8, 0);
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    let o = 0;
    for (const [bits, value] of fields) {
      if (bits === 8) view.setUint8(o, value);
      else if (bits === 16) view.setUint16(o, value);
      else if (bits === 24) {
        view.setUint8(o, value >>> 16 & 255);
        view.setUint16(o + 1, value & 65535);
      } else if (bits === 32) view.setUint32(o, value >>> 0);
      else {
        view.setUint32(o, Math.floor(value / UINT32));
        view.setUint32(o + 4, value % UINT32);
      }
      o += bits / 8;
    }
    return out;
  }
  var u32 = (...values) => bytes(...values.map((v) => [32, v]));
  function box(type, ...parts) {
    const size = parts.reduce((n, p) => n + p.length, 8);
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, size);
    out.set(ascii(type), 4);
    let o = 8;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
  var fullBox = (type, version, flags, ...parts) => box(type, bytes([8, version], [24, flags]), ...parts);
  function u32Array(...arrays) {
    const n = arrays[0].length;
    const out = new Uint8Array(n * 4 * arrays.length);
    const view = new DataView(out.buffer);
    let o = 0;
    for (let i = 0; i < n; i++) {
      for (const a of arrays) {
        view.setUint32(o, a.data[i]);
        o += 4;
      }
    }
    return out;
  }
  var MATRIX = u32(65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824);
  var FTYP = box("ftyp", ascii("isom"), u32(512), ascii("isomiso2avc1mp41"));
  var MDAT_HEADER_SIZE = 16;
  function mdatHeader(payloadSize) {
    return concatBytes(u32(1), ascii("mdat"), bytes([64, payloadSize + MDAT_HEADER_SIZE]));
  }
  function concatBytes(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
  var Track = class {
    constructor(kind, timescale) {
      this.kind = kind;
      this.timescale = timescale;
      this.sizes = new GrowU32();
      this.stts = new RunTable();
      this.ctts = new RunTable();
      this.hasCts = false;
      this.sync = new GrowU32(256);
      this.chunkOffsets = [];
      this.stsc = [];
      this.lastDts = null;
      this.lastDuration = 0;
      this.duration = 0;
    }
    get count() {
      return this.sizes.length;
    }
    addSample(size, dts, cts, key) {
      if (this.lastDts !== null) {
        const d = dts - this.lastDts;
        if (!(d > 0)) throw new Error("内部错误：样本时间戳必须递增");
        this.stts.add(d);
        this.duration += d;
        this.lastDuration = d;
      }
      this.lastDts = dts;
      this.sizes.push(size);
      if (this.kind === "video") {
        if (cts) this.hasCts = true;
        this.ctts.add(cts);
        if (key) this.sync.push(this.count);
      }
    }
    growLast(extra) {
      this.sizes.last += extra;
    }
    /** 一段连续写入的样本（本轨道上一次 addChunk 之后新增的样本）。 */
    addChunk(offset, samples) {
      if (!samples) return;
      this.chunkOffsets.push(offset);
      const last = this.stsc[this.stsc.length - 1];
      if (!last || last[1] !== samples) this.stsc.push([this.chunkOffsets.length, samples]);
    }
    /** 结束：最后一个样本沿用前一个时长（单样本时用 defaultDuration）。 */
    close(defaultDuration) {
      const d = this.lastDuration || defaultDuration;
      this.stts.add(d);
      this.duration += d;
    }
  };
  function sampleEntry(track) {
    if (track.kind === "video") {
      const { sps, pps, info } = track.codec;
      const avcCParts = [
        bytes([8, 1], [8, info.profileIdc], [8, info.constraintFlags], [8, info.levelIdc], [8, 255], [8, 224 | 1], [16, sps.length]),
        sps,
        bytes([8, pps.length])
      ];
      for (const p of pps) avcCParts.push(bytes([16, p.length]), p);
      if (info.highProfile) {
        avcCParts.push(bytes([8, 252 | info.chromaFormatIdc], [8, 248 | info.bitDepthLuma - 8], [8, 248 | info.bitDepthChroma - 8], [8, 0]));
      }
      return box(
        "avc1",
        new Uint8Array(6),
        bytes([16, 1], [16, 0], [16, 0], [32, 0], [32, 0], [32, 0], [16, info.width], [16, info.height]),
        u32(4718592, 4718592, 0),
        bytes([16, 1]),
        new Uint8Array(32),
        // compressorname
        bytes([16, 24], [16, 65535]),
        box("avcC", ...avcCParts)
      );
    }
    const { config, channels, sampleRate } = track.codec;
    const descriptor = (tag, ...parts) => {
      const body = concatBytes(...parts);
      return concatBytes(bytes([8, tag], [8, body.length]), body);
    };
    const esds = fullBox(
      "esds",
      0,
      0,
      descriptor(
        3,
        bytes([16, track.id], [8, 0]),
        descriptor(4, bytes([8, 64], [8, 21], [24, 0], [32, track.codec.bitrate], [32, track.codec.bitrate]), descriptor(5, config)),
        descriptor(6, bytes([8, 2]))
      )
    );
    return box(
      "mp4a",
      new Uint8Array(6),
      bytes([16, 1], [32, 0], [32, 0], [16, channels], [16, 16], [16, 0], [16, 0], [32, sampleRate <= 65535 ? sampleRate * 65536 : 0]),
      esds
    );
  }
  function sampleTable(track) {
    const parts = [fullBox("stsd", 0, 0, u32(1), sampleEntry(track)), fullBox("stts", 0, 0, u32(track.stts.length), u32Array(track.stts.counts, track.stts.values))];
    if (track.hasCts) parts.push(fullBox("ctts", 0, 0, u32(track.ctts.length), u32Array(track.ctts.counts, track.ctts.values)));
    if (track.kind === "video" && track.sync.length < track.count) {
      parts.push(fullBox("stss", 0, 0, u32(track.sync.length), u32Array(track.sync)));
    }
    parts.push(fullBox("stsz", 0, 0, u32(0, track.count), u32Array(track.sizes)));
    parts.push(fullBox("stsc", 0, 0, u32(track.stsc.length), ...track.stsc.map(([first, n]) => u32(first, n, 1))));
    const offsets = track.chunkOffsets;
    if (offsets.length && offsets[offsets.length - 1] >= UINT32) {
      parts.push(fullBox("co64", 0, 0, u32(offsets.length), bytes(...offsets.map((o) => [64, o]))));
    } else {
      parts.push(fullBox("stco", 0, 0, u32(offsets.length, ...offsets)));
    }
    return box("stbl", ...parts);
  }
  var timeFields = (duration) => duration >= UINT32 ? [1, [64, 0], [64, 0]] : [0, [32, 0], [32, 0]];
  var durationField = (version, d) => version ? [64, d] : [32, d];
  function trak(track, movieTimescale) {
    const movieDuration = Math.round((track.emptyEdit + track.duration) / track.timescale * movieTimescale);
    const [tv, ...tTimes] = timeFields(movieDuration);
    const tkhd = fullBox(
      "tkhd",
      tv,
      3,
      bytes(...tTimes, [32, track.id], [32, 0], durationField(tv, movieDuration), [32, 0], [32, 0], [16, 0], [16, 0], [16, track.kind === "audio" ? 256 : 0], [16, 0]),
      MATRIX,
      u32(track.kind === "video" ? track.codec.info.width * 65536 : 0, track.kind === "video" ? track.codec.info.height * 65536 : 0)
    );
    const edits = [];
    const empty = Math.round(track.emptyEdit / track.timescale * movieTimescale);
    if (empty > 0) edits.push(u32(empty, 4294967295, 65536));
    edits.push(u32(Math.round(track.duration / track.timescale * movieTimescale), track.mediaTime, 65536));
    const [mv, ...mTimes] = timeFields(track.duration);
    const mdhd = fullBox("mdhd", mv, 0, bytes(...mTimes, [32, track.timescale], durationField(mv, track.duration), [16, 21956], [16, 0]));
    const handler = track.kind === "video" ? ["vide", "VideoHandler"] : ["soun", "SoundHandler"];
    const hdlr = fullBox("hdlr", 0, 0, u32(0), ascii(handler[0]), u32(0, 0, 0), ascii(`${handler[1]}\0`));
    const mediaHeader = track.kind === "video" ? fullBox("vmhd", 0, 1, new Uint8Array(8)) : fullBox("smhd", 0, 0, new Uint8Array(4));
    const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
    return box(
      "trak",
      tkhd,
      box("edts", fullBox("elst", 0, 0, u32(edits.length), ...edits)),
      box("mdia", mdhd, hdlr, box("minf", mediaHeader, dinf, sampleTable(track)))
    );
  }
  function buildMoov(tracks, movieTimescale = 1e3) {
    const traks = tracks.map((t) => trak(t, movieTimescale));
    const duration = Math.max(...tracks.map((t) => Math.round((t.emptyEdit + t.duration) / t.timescale * movieTimescale)));
    const [v, ...times] = timeFields(duration);
    const mvhd = fullBox(
      "mvhd",
      v,
      0,
      bytes(...times, [32, movieTimescale], durationField(v, duration), [32, 65536], [16, 256], [16, 0], [32, 0], [32, 0]),
      MATRIX,
      new Uint8Array(24),
      u32(Math.max(...tracks.map((t) => t.id)) + 1)
    );
    return box("moov", mvhd, ...traks);
  }

  // src/remux.js
  var WRAP = 2 ** 33;
  var HALF_WRAP = 2 ** 32;
  var MAX_STEP = 10 * 9e4;
  var PMT_DEADLINE = PACKET * 1024;
  var CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8];
  var RemuxError = class extends Error {
    /** unsupported：编码无法无损放进 MP4，且尚未写出任何字节，调用方可以改存为 TS。 */
    constructor(message, { unsupported = false, reason = message } = {}) {
      super(message);
      this.name = "RemuxError";
      this.fatal = true;
      this.unsupported = unsupported;
      this.reason = reason;
    }
  };
  var unwrap = (ts, ref) => {
    if (ref === null) return ts;
    while (ts - ref > HALF_WRAP) ts -= WRAP;
    while (ref - ts > HALF_WRAP) ts += WRAP;
    return ts;
  };
  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function createMp4Remuxer({ write, writeAt }) {
    const demux = new TsDemuxer();
    const warnings = { timestamps: 0, droppedFrames: 0, corrupt: 0 };
    let started = false;
    let checked = false;
    let bytesIn = 0;
    let offset = FTYP.length + MDAT_HEADER_SIZE;
    let dataBytes = 0;
    const video = { track: null, sps: null, info: null, pps: /* @__PURE__ */ new Map(), keyed: false, lastRaw: null, lastT: null, shift: 0, firstPts: 0, firstCts: 0 };
    const audio = { track: null, codec: null, rest: null, lastRaw: null, lastT: null, base: 0, shift: 0, bytes: 0 };
    let chunk = { videoNals: [], videoSamples: 0, videoBytes: 0, audioFrames: [], audioBytes: 0 };
    const fail = (reason) => {
      throw new RemuxError(`${reason}，无法无损封装为 MP4`, { unsupported: !started, reason });
    };
    function checkStreams() {
      if (checked) return;
      if (!demux.streams) {
        if (bytesIn < PMT_DEADLINE) return;
        if (demux.packets * PACKET < bytesIn / 2) {
          throw new RemuxError("解密后的数据不是有效的 MPEG-TS（key 或 IV 可能不对），无法转封装");
        }
        fail("没有在录像开头找到 TS 节目表（PAT/PMT）");
      }
      const bad = demux.streams.filter((s) => s.kind === "unsupported");
      if (bad.length) fail(`录像包含 ${bad.map((s) => streamTypeName(s.type)).join("、")} 流`);
      const count = (kind) => demux.streams.filter((s) => s.kind === kind).length;
      if (count("video") > 1 || count("audio") > 1) fail("录像包含多条视频或音频流");
      if (!count("video") && !count("audio")) fail("录像中没有音视频流");
      checked = true;
    }
    function onParameterSet(nal, type) {
      if (type === 7) {
        if (!video.sps) {
          try {
            video.info = parseSps(nal);
          } catch (e) {
            fail(`无法解析 H.264 SPS（${e.message}）`);
          }
          video.sps = nal.slice();
        } else if (!sameBytes(video.sps, nal)) {
          fail("视频参数（分辨率或编码配置）在录像中途改变");
        }
      } else {
        const id = ppsId(nal);
        const prev = video.pps.get(id);
        if (!prev) video.pps.set(id, nal.slice());
        else if (!sameBytes(prev, nal)) fail("视频 PPS 参数在录像中途改变");
      }
    }
    function onVideo(unit) {
      const keep = [];
      let size = 0;
      let key = false;
      for (const nal of splitAnnexB(unit.data)) {
        const type = nal[0] & 31;
        if (type === 9) continue;
        if (type === 7 || type === 8) onParameterSet(nal, type);
        else if (type === 5) key = true;
        keep.push(nal);
        size += 4 + nal.length;
      }
      if (!keep.length) return;
      if (unit.pts === null) {
        if (chunk.videoSamples) {
          chunk.videoNals.push(...keep);
          chunk.videoBytes += size;
          video.track.growLast(size);
        } else warnings.droppedFrames++;
        return;
      }
      if (!video.keyed && !key) {
        warnings.droppedFrames++;
        return;
      }
      video.keyed = true;
      const dts = unwrap(unit.dts, video.lastRaw);
      const pts = unwrap(unit.pts, dts);
      let cts = pts - dts;
      if (cts < 0) {
        cts = 0;
        warnings.timestamps++;
      }
      let t;
      if (video.lastT === null) {
        video.track = new Track("video", 9e4);
        video.shift = dts;
        video.firstPts = pts;
        video.firstCts = cts;
        t = 0;
      } else {
        t = dts - video.shift;
        const step = t - video.lastT;
        if (step <= 0 || step > MAX_STEP) {
          const nominal = video.track.lastDuration || 3600;
          video.shift += step - nominal;
          t = video.lastT + nominal;
          warnings.timestamps++;
        }
      }
      video.lastRaw = dts;
      video.lastT = t;
      video.track.addSample(size, t, cts, key);
      chunk.videoNals.push(...keep);
      chunk.videoSamples++;
      chunk.videoBytes += size;
    }
    function onAudio(unit) {
      const restLength = audio.rest ? audio.rest.length : 0;
      let data = unit.data;
      if (audio.rest) {
        data = new Uint8Array(restLength + unit.data.length);
        data.set(audio.rest);
        data.set(unit.data, restLength);
        audio.rest = null;
      }
      const raw = unit.pts === null ? null : unwrap(unit.pts, audio.lastRaw);
      if (raw !== null) audio.lastRaw = raw;
      let o = 0;
      let index = 0;
      let lost = false;
      while (o + 7 <= data.length) {
        const h = parseAdtsHeader(data, o);
        if (!h) {
          if (!lost) warnings.corrupt++;
          lost = true;
          o++;
          continue;
        }
        lost = false;
        if (h.frameLength < h.headerLength) {
          warnings.corrupt++;
          o++;
          continue;
        }
        if (o + h.frameLength > data.length) break;
        if (!audio.codec) {
          if (!h.sampleRate || !h.channelConfig) fail("AAC 的采样率或声道配置无法写入 MP4");
          if (h.rawBlocks) fail("AAC ADTS 帧包含多个 raw data block");
          audio.codec = h;
          audio.track = new Track("audio", h.sampleRate);
        } else if (h.sampleRate !== audio.codec.sampleRate || h.channelConfig !== audio.codec.channelConfig || h.objectType !== audio.codec.objectType) {
          fail("音频参数（采样率、声道或 AAC 类型）在录像中途改变");
        } else if (h.rawBlocks) {
          fail("AAC ADTS 帧包含多个 raw data block");
        }
        const sr = audio.codec.sampleRate;
        const ownPts = o >= restLength && raw !== null;
        const framePts = ownPts ? raw + index * 1024 * 9e4 / sr : null;
        if (o >= restLength) index++;
        let t;
        if (audio.lastT === null) {
          if (framePts === null) {
            o += h.frameLength;
            warnings.droppedFrames++;
            continue;
          }
          audio.base = framePts;
          t = 0;
        } else {
          const expected = audio.lastT + 1024;
          t = expected;
          if (framePts !== null) {
            const gap = Math.round((framePts - audio.base) * sr / 9e4) - audio.shift - expected;
            if (gap > sr * 0.1 && gap <= sr * 10) {
              t = expected + gap;
              warnings.timestamps++;
            } else if (Math.abs(gap) > sr * 0.1) {
              audio.shift += gap;
              warnings.timestamps++;
            }
          }
        }
        audio.lastT = t;
        const frame = data.subarray(o + h.headerLength, o + h.frameLength);
        audio.track.addSample(frame.length, t, 0, true);
        chunk.audioFrames.push(frame);
        chunk.audioBytes += frame.length;
        audio.bytes += frame.length;
        o += h.frameLength;
      }
      if (o < data.length) audio.rest = data.slice(o);
    }
    function onUnits(units) {
      for (const unit of units) {
        if (unit.kind === "video") onVideo(unit);
        else onAudio(unit);
      }
    }
    async function flushChunk() {
      const c = chunk;
      if (!c.videoSamples && !c.audioFrames.length) return;
      chunk = { videoNals: [], videoSamples: 0, videoBytes: 0, audioFrames: [], audioBytes: 0 };
      const head = started ? 0 : FTYP.length + MDAT_HEADER_SIZE;
      const buf = new Uint8Array(head + c.videoBytes + c.audioBytes);
      const view = new DataView(buf.buffer);
      let o = 0;
      if (!started) {
        buf.set(FTYP, 0);
        buf.set(mdatHeader(0), FTYP.length);
        o = head;
        started = true;
      }
      for (const nal of c.videoNals) {
        view.setUint32(o, nal.length);
        buf.set(nal, o + 4);
        o += 4 + nal.length;
      }
      for (const frame of c.audioFrames) {
        buf.set(frame, o);
        o += frame.length;
      }
      if (c.videoSamples) video.track.addChunk(offset, c.videoSamples);
      if (c.audioFrames.length) audio.track.addChunk(offset + c.videoBytes, c.audioFrames.length);
      offset += c.videoBytes + c.audioBytes;
      dataBytes += c.videoBytes + c.audioBytes;
      await write(buf);
    }
    return {
      get started() {
        return started;
      },
      warnings,
      async push(data) {
        bytesIn += data.length;
        const units = demux.push(data);
        checkStreams();
        if (!checked) return;
        onUnits(units);
        await flushChunk();
      },
      async finish() {
        const units = demux.flush();
        bytesIn = Math.max(bytesIn, PMT_DEADLINE);
        checkStreams();
        onUnits(units);
        await flushChunk();
        if (!started) throw new RemuxError("没有解析到任何音视频帧，无法生成 MP4");
        warnings.corrupt += demux.errors + demux.resyncs;
        const tracks = [];
        if (video.track) {
          if (!video.sps || !video.pps.size) throw new RemuxError("视频流中没有 SPS/PPS 参数集，无法生成 MP4");
          video.track.close(3600);
          video.track.codec = { sps: video.sps, pps: [...video.pps.values()], info: video.info };
          video.track.mediaTime = video.firstCts;
          tracks.push({ track: video.track, start: video.firstPts });
        }
        if (audio.track) {
          audio.track.close(1024);
          const { sampleRate, channelConfig } = audio.codec;
          const seconds = audio.track.duration / sampleRate;
          audio.track.codec = {
            config: audioSpecificConfig(audio.codec),
            channels: CHANNELS[channelConfig],
            sampleRate,
            bitrate: seconds ? Math.round(audio.bytes * 8 / seconds) : 0
          };
          audio.track.mediaTime = 0;
          tracks.push({ track: audio.track, start: audio.base });
        }
        const t0 = Math.min(...tracks.map((t) => t.start));
        tracks.forEach(({ track, start }, i) => {
          track.id = i + 1;
          track.emptyEdit = Math.round((start - t0) * track.timescale / 9e4);
        });
        const moov = buildMoov(tracks.map((t) => t.track));
        await write(moov);
        await writeAt(FTYP.length, mdatHeader(dataBytes));
        const duration = Math.max(...tracks.map(({ track }) => (track.emptyEdit + track.duration) / track.timescale));
        return {
          format: "mp4",
          bytes: FTYP.length + MDAT_HEADER_SIZE + dataBytes + moov.length,
          duration,
          video: video.track ? { frames: video.track.count, width: video.info.width, height: video.info.height } : null,
          audio: audio.track ? { frames: audio.track.count, sampleRate: audio.codec.sampleRate, channels: CHANNELS[audio.codec.channelConfig] } : null,
          warnings: { ...warnings }
        };
      }
    };
  }
  var isMp4Filename = (name) => /\.mp4$/i.test(String(name));
  function createOutput({ filename, sink, onFallback }) {
    if (!isMp4Filename(filename)) {
      return { format: "ts", write: (data) => sink.write(data), finish: async () => ({ format: "ts" }) };
    }
    let target = sink;
    let fallback = null;
    let pending = [];
    const remuxer = createMp4Remuxer({ write: (d) => target.write(d), writeAt: (p, d) => target.writeAt(p, d) });
    return {
      get format() {
        return fallback ? "ts" : "mp4";
      },
      async write(data) {
        if (fallback) return target.write(data);
        try {
          await remuxer.push(data);
          if (remuxer.started) pending = null;
          else pending.push(data);
        } catch (error) {
          if (!error.unsupported || !onFallback) throw error;
          target = await onFallback(error);
          fallback = error;
          for (const d of [...pending, data]) await target.write(d);
          pending = null;
        }
      },
      async finish() {
        if (fallback) return { format: "ts", fallback };
        try {
          return await remuxer.finish();
        } catch (error) {
          if (!error.unsupported || !onFallback || !pending) throw error;
          target = await onFallback(error);
          fallback = error;
          for (const d of pending) await target.write(d);
          pending = null;
          return { format: "ts", fallback };
        }
      }
    };
  }

  // src/batch.js
  var BATCH_LIMITS = Object.freeze({ recordings: 3, segments: 4, requests: 8 });
  var isTaskFinished = (task) => ["completed", "failed", "cancelled"].includes(task.status);
  function batchProgress(batch) {
    const totals = { total: batch.tasks.length, settled: 0, completed: 0, failed: 0, cancelled: 0, active: 0, queued: 0, bytes: 0, badTs: 0, fallbacks: 0, percent: 0 };
    let units = 0;
    for (const task of batch.tasks) {
      if (isTaskFinished(task)) {
        totals.settled++;
        totals[task.status]++;
        units++;
      } else {
        totals[task.status === "queued" ? "queued" : "active"]++;
        units += task.total ? Math.min(0.99, task.done / task.total * 0.99) : 0;
      }
      totals.bytes += task.bytes;
      totals.badTs += task.badTs;
      if (task.fallback) totals.fallbacks++;
    }
    totals.percent = totals.total ? units / totals.total * 100 : 0;
    return totals;
  }
  function createBatch(entries) {
    return {
      tasks: entries.map((entry) => ({
        ...entry,
        controller: new AbortController(),
        status: "queued",
        phase: "queued",
        done: 0,
        total: 0,
        bytes: 0,
        seconds: 0,
        totalSeconds: 0,
        badTs: 0,
        error: "",
        notice: "",
        fallback: false,
        aborting: false
      })),
      running: true,
      phase: "pick",
      aborting: false,
      startedAt: Date.now()
    };
  }
  function cancelBatchTask(batch, key) {
    const task = batch.tasks.find((t) => t.key === key);
    if (!task || isTaskFinished(task) || task.aborting) return;
    task.aborting = true;
    task.controller.abort();
    if (task.status === "queued") task.status = "cancelled";
  }
  function cancelBatch(batch) {
    if (!batch.running || batch.aborting) return;
    batch.aborting = true;
    for (const task of batch.tasks) cancelBatchTask(batch, task.key);
  }
  async function runBatch(batch, {
    openSink,
    locate,
    request,
    onChange = () => {
    },
    recordingConcurrency = BATCH_LIMITS.recordings,
    sinkKind = "file",
    // 'file' | 'opfs' | 'memory'
    segmentConcurrency = BATCH_LIMITS.segments,
    limiter = createRequestLimiter(BATCH_LIMITS.requests),
    retryDelayMs = 1e3
  }) {
    positiveInteger(recordingConcurrency, "录像并发数");
    positiveInteger(segmentConcurrency, "分片并发数");
    const limitedRequest = limiter.wrap(request);
    batch.phase = "download";
    const workerCount = sinkKind === "memory" ? 1 : recordingConcurrency;
    const checkSink = (sink) => {
      const allowed = sinkKind === "file" ? ["file"] : ["file", "opfs", "memory"];
      if (!sink || !allowed.includes(sink.kind)) {
        throw new Error("批量下载必须直接写入磁盘，或使用浏览器保存模式");
      }
    };
    let next = 0;
    async function runTask(task) {
      const { signal } = task.controller;
      let sink = null;
      try {
        task.status = "running";
        task.phase = "file";
        onChange();
        if (!task.watchUrl) throw new Error("该条目没有可用的播放链接");
        sink = await openSink(task.filename, signal);
        if (signal.aborted) throw abortError();
        checkSink(sink);
        task.filename = sink.filename || task.filename;
        task.phase = "locate";
        onChange();
        const playlistUrl = await abortable(locate(task.watchUrl, { signal, allowManual: false }), signal);
        task.phase = "download";
        task.startedAt = Date.now();
        const output = createOutput({
          filename: task.filename,
          sink,
          onFallback: async (error) => {
            const old = sink;
            sink = null;
            await old.abort();
            sink = await openSink(withExtension(task.filename, "ts"), signal);
            if (signal.aborted) throw abortError();
            checkSink(sink);
            task.filename = sink.filename || withExtension(task.filename, "ts");
            task.fallback = true;
            task.notice = `${error.reason}，无法无损转为 MP4，已改存为 TS`;
            onChange();
            return sink;
          }
        });
        await downloadHls({
          playlistUrl,
          request: limitedRequest,
          write: (data) => output.write(data),
          signal,
          concurrency: segmentConcurrency,
          retryDelayMs,
          onProgress: (progress) => {
            Object.assign(task, progress);
            onChange();
          }
        });
        if (signal.aborted) throw abortError();
        task.phase = "finish";
        onChange();
        const result = await output.finish();
        if (signal.aborted) throw abortError();
        if (result.warnings?.timestamps) task.notice = `${result.warnings.timestamps} 处时间戳不连续，已自动接续`;
        await sink.close();
        sink = null;
        task.status = "completed";
      } catch (error) {
        task.status = signal.aborted || error.name === "AbortError" ? "cancelled" : "failed";
        task.error = task.status === "failed" ? error.message : "";
      } finally {
        task.controller.abort();
        if (sink) await withTimeout(Promise.resolve().then(() => sink.abort()), 3e3);
        onChange();
      }
    }
    async function worker() {
      while (next < batch.tasks.length) {
        const task = batch.tasks[next++];
        if (isTaskFinished(task)) continue;
        if (batch.aborting) {
          cancelBatchTask(batch, task.key);
          continue;
        }
        await runTask(task);
      }
    }
    try {
      const workers = [];
      for (let i = 0; i < Math.min(workerCount, batch.tasks.length); i++) workers.push(worker());
      await Promise.all(workers);
    } finally {
      batch.running = false;
      onChange();
    }
    return batchProgress(batch);
  }

  // src/theme.js
  var APPEARANCE_KEY = "appearance";
  var validTheme = (value) => value === "light" || value === "dark";
  var preferenceOf = (value) => validTheme(value) ? value : "system";
  function resolveAppearance({ preference, prismTheme, systemDark = false }) {
    if (validTheme(prismTheme)) return { theme: prismTheme, source: "prism" };
    if (validTheme(preference)) return { theme: preference, source: "manual" };
    return { theme: systemDark ? "dark" : "light", source: "system" };
  }
  function mountAppearance({ host, select, status, win = window, doc = document, storage = store }) {
    const roots = [];
    let cursor = win;
    while (cursor) {
      try {
        const root = (cursor === win ? doc : cursor.document)?.documentElement;
        if (root) roots.push(root);
        if (!cursor.parent || cursor.parent === cursor) break;
        cursor = cursor.parent;
      } catch {
        break;
      }
    }
    let preference = preferenceOf(storage.get(APPEARANCE_KEY, "system"));
    let destroyed = false;
    const media = typeof win.matchMedia === "function" ? win.matchMedia("(prefers-color-scheme: dark)") : null;
    const prismOption = select.querySelector('option[value="prism"]');
    const readPrism = () => {
      for (const root of roots) {
        const theme = root.getAttribute("data-pku-prism-theme");
        if (root.getAttribute("data-pku-prism") === "enabled" && validTheme(theme)) return theme;
      }
      return null;
    };
    function refresh() {
      if (destroyed) return;
      const { theme, source } = resolveAppearance({ preference, prismTheme: readPrism(), systemDark: media?.matches });
      host.setAttribute("data-theme", theme);
      host.setAttribute("data-theme-source", source);
      host.style.colorScheme = theme;
      const inherited = source === "prism";
      if (prismOption) prismOption.hidden = !inherited;
      select.value = inherited ? "prism" : preference;
      select.disabled = inherited;
      const label = theme === "dark" ? "深色" : "浅色";
      status.textContent = inherited ? `${label} · 由 Prism 管理` : source === "system" ? `当前${label} · 跟随系统` : `当前${label} · 已记住`;
      select.title = inherited ? "请在 PKU Prism 中切换主题；停用 Prism 后恢复独立偏好" : "没有启用 PKU Prism 时使用此偏好";
    }
    function change() {
      if (select.disabled) return;
      preference = preferenceOf(select.value);
      storage.set(APPEARANCE_KEY, preference);
      refresh();
    }
    const observer = typeof win.MutationObserver === "function" ? new win.MutationObserver(refresh) : null;
    for (const root of roots) observer?.observe(root, { attributes: true, attributeFilter: ["data-pku-prism", "data-pku-prism-theme"] });
    select.addEventListener("change", change);
    if (media?.addEventListener) media.addEventListener("change", refresh);
    else media?.addListener?.(refresh);
    win.addEventListener?.("pageshow", refresh);
    const stopStorage = storage.onChange(APPEARANCE_KEY, (value) => {
      preference = preferenceOf(value);
      refresh();
    });
    refresh();
    return {
      destroy() {
        if (destroyed) return;
        destroyed = true;
        observer?.disconnect();
        select.removeEventListener?.("change", change);
        if (media?.removeEventListener) media.removeEventListener("change", refresh);
        else media?.removeListener?.(refresh);
        win.removeEventListener?.("pageshow", refresh);
        stopStorage();
      }
    };
  }

  // src/ui.css
  var ui_default = ':host {\n  all: initial;\n  position: fixed;\n  right: 16px;\n  bottom: 16px;\n  z-index: 2147483000;\n  --cf-surface: #fff;\n  --cf-subtle: #f4f4f5;\n  --cf-border: #e4e4e7;\n  --cf-control-border: #71717a;\n  --cf-text: #18181b;\n  --cf-muted: #52525b;\n  --cf-accent: #9e2533;\n  --cf-selected: #faeef0;\n  --cf-brand: #9e2533;\n  --cf-brand-hover: #85202b;\n  --cf-on-brand: #fff;\n  --cf-success: #166534;\n  --cf-success-bg: #f0fdf4;\n  --cf-warning: #854d0e;\n  --cf-warning-bg: #fefce8;\n  --cf-danger: #b91c1c;\n  --cf-danger-bg: #fef2f2;\n}\n:host([data-theme="dark"]) {\n  --cf-surface: #202023;\n  --cf-subtle: #27272a;\n  --cf-border: #3f3f46;\n  --cf-control-border: #a1a1aa;\n  --cf-text: #f4f4f5;\n  --cf-muted: #a1a1aa;\n  --cf-accent: #f0a3ad;\n  --cf-selected: #38272d;\n  --cf-brand-hover: #b02a3a;\n  --cf-success: #86efac;\n  --cf-success-bg: #16271e;\n  --cf-warning: #fde68a;\n  --cf-warning-bg: #30291b;\n  --cf-danger: #fca5a5;\n  --cf-danger-bg: #331f23;\n}\n*, *::before, *::after { box-sizing: border-box; }\n[hidden] { display: none !important; }\n::selection { color: var(--cf-text); background: var(--cf-selected); }\n.cf {\n  width: 760px;\n  max-width: calc(100vw - 32px);\n  max-height: calc(100vh - 32px);\n  max-height: calc(100dvh - 32px);\n  display: flex;\n  flex-direction: column;\n  overflow: hidden;\n  font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;\n  font-variant-numeric: tabular-nums;\n  color: var(--cf-text);\n  background: var(--cf-surface);\n  border: 1px solid var(--cf-border);\n  border-radius: 8px;\n  color-scheme: inherit;\n  scrollbar-color: var(--cf-control-border) var(--cf-surface);\n  scrollbar-width: thin;\n}\n.cf.collapsed { width: auto; }\nbutton, input, select { font: inherit; color: var(--cf-text); }\nbutton, select, summary, input[type="checkbox"] { cursor: pointer; }\nbutton {\n  min-height: 32px;\n  padding: 4px 10px;\n  background: var(--cf-surface);\n  border: 1px solid var(--cf-border);\n  border-radius: 6px;\n  white-space: nowrap;\n}\nbutton:hover:not(:disabled) { background: var(--cf-subtle); }\nbutton:disabled, input:disabled, select:disabled { cursor: not-allowed; opacity: .6; }\nbutton.primary { color: var(--cf-on-brand); background: var(--cf-brand); border-color: var(--cf-brand); font-weight: 600; }\nbutton.primary:hover:not(:disabled) { background: var(--cf-brand-hover); border-color: var(--cf-brand-hover); }\n:is(button, input, select, summary):focus-visible { outline: 2px solid var(--cf-accent); outline-offset: 2px; }\ninput, select { min-height: 32px; padding: 4px 8px; border: 1px solid var(--cf-control-border); border-radius: 6px; background: var(--cf-surface); caret-color: var(--cf-accent); }\ninput[type="text"] { flex: 1; min-width: 0; width: 100%; }\ninput::placeholder { color: var(--cf-muted); opacity: 1; }\ninput[type="checkbox"] { min-height: 0; width: 16px; height: 16px; margin: 0; accent-color: var(--cf-accent); flex: none; }\nselect { min-width: 0; max-width: 100%; }\noption { color: var(--cf-text); background: var(--cf-surface); }\n.hd {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  width: 100%;\n  min-height: 44px;\n  padding: 8px 12px;\n  border: 0;\n  border-radius: 0;\n  text-align: left;\n  flex: none;\n}\n.hd b { font-size: 14px; font-weight: 600; }\n.hd .count { color: var(--cf-muted); overflow-wrap: anywhere; white-space: normal; }\n.hd .mark { color: var(--cf-accent); }\nsvg { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }\n.arrow { margin-left: auto; color: var(--cf-muted); display: flex; }\n.collapsed .arrow { transform: rotate(180deg); }\n.cf:not(.collapsed) .hd { border-bottom: 1px solid var(--cf-border); }\n.bd { padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow: auto; min-height: 0; }\n.collapsed .bd { display: none; }\nlabel { display: flex; align-items: center; gap: 8px; min-width: 0; }\nlabel > span:first-child { width: 64px; color: var(--cf-muted); flex: none; }\n.template-help { margin: -4px 0 0 72px; }\n.template-help summary { color: var(--cf-muted); }\n.hint { color: var(--cf-muted); font-size: 12px; overflow-wrap: anywhere; margin-top: 8px; }\n.preferences { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; padding-block: 12px; border-block: 1px solid var(--cf-border); }\n.preferences select { flex: 1; width: 100%; }\n.appearance { display: flex; flex-direction: column; gap: 4px; min-width: 0; }\n.theme-source { color: var(--cf-muted); font-size: 12px; padding-left: 72px; }\n.theme-source:empty { display: none; }\n.theme:disabled { opacity: 1; color: var(--cf-muted); background: var(--cf-subtle); border-color: var(--cf-border); }\n.bar { display: flex; flex-wrap: wrap; gap: 8px; }\n.bar .primary { margin-left: auto; }\nbutton.link { border: 0; background: transparent; color: var(--cf-accent); padding: 4px 6px; border-radius: 4px; }\nbutton.link:hover:not(:disabled) { color: var(--cf-accent); background: var(--cf-selected); text-decoration: none; }\n.status { color: var(--cf-muted); overflow-wrap: anywhere; }\n.status:empty { display: none; }\n.status.flash { color: var(--cf-success); }\ndetails summary { width: fit-content; border-radius: 4px; }\ndetails ul { margin: 8px 0 0; padding-left: 20px; max-height: 100px; overflow: auto; }\n.warn { color: var(--cf-warning); background: var(--cf-warning-bg); padding: 8px 12px; border-radius: 6px; }\n.tbl { max-height: 42vh; min-height: 64px; overflow: auto; border: 1px solid var(--cf-border); border-radius: 6px; scrollbar-gutter: stable; }\ntable { border-spacing: 0; width: 100%; min-width: 680px; font: inherit; }\nth, td { padding: 8px; border-bottom: 1px solid var(--cf-border); text-align: left; white-space: nowrap; vertical-align: top; }\nth { position: sticky; top: 0; z-index: 1; color: var(--cf-muted); background: var(--cf-subtle); font-size: 12px; font-weight: 600; }\nth:first-child, td:first-child { width: 32px; }\nth:last-child { min-width: 215px; }\ntbody tr:last-child td { border-bottom: 0; }\ntbody tr:hover { background: var(--cf-subtle); }\ntd.fn { min-width: 180px; font: 12px/1.65 ui-monospace, Menlo, Consolas, monospace; white-space: normal; overflow-wrap: anywhere; }\ntd:last-child { padding-block: 4px; }\n.muted, tr.excluded { color: var(--cf-muted); }\ntr.excluded .fn { text-decoration: line-through; }\n.excl-box { color: var(--cf-text); }\n.excl-bd { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }\n.excl-rows, .excl-item { display: flex; flex-direction: column; gap: 8px; }\n.excl-row, .excl-name { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }\n.excl-row input[type="text"] { flex: 1 1 200px; }\n.excl-add, .excl-del { width: 32px; padding: 4px; color: var(--cf-accent); }\n.excl-name { margin-left: 40px; }\n.excl-name input[type="text"] { flex: 1 1 160px; }\n.excl-acts { display: flex; gap: 4px; flex: none; }\n.holidays { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }\n.holidays:empty { display: none; }\n.hol { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 4px 8px; background: var(--cf-subtle); border-radius: 4px; max-width: 100%; overflow-wrap: anywhere; }\n.hol.off, .hol .dates, .hol-tag { color: var(--cf-muted); }\n.hol .dates, .hol-tag { font-size: 12px; }\n.dl { background: var(--cf-subtle); border-radius: 6px; padding: 12px; display: flex; flex-direction: column; gap: 8px; overflow-wrap: anywhere; }\n.dl-top { display: flex; align-items: center; gap: 8px; }\n.dl-name { flex: 1; min-width: 0; font: 12px/1.65 ui-monospace, Menlo, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.dl-bar { height: 6px; background: var(--cf-border); border-radius: 4px; overflow: hidden; }\n.dl-fill { height: 100%; width: 0; background: var(--cf-accent); }\n.dl-bar.indeterminate .dl-fill { width: 30%; }\n.dl-l1 { color: var(--cf-text); }\n.dl-l2 { color: var(--cf-muted); font-size: 12px; }\n.dl-warn { color: var(--cf-danger); background: var(--cf-danger-bg); padding: 8px; border-radius: 4px; font-size: 12px; }\n.dl-note { color: var(--cf-warning); background: var(--cf-warning-bg); padding: 8px; border-radius: 4px; font-size: 12px; }\n.dl.done { background: var(--cf-success-bg); }\n.dl.done .dl-l1 { color: var(--cf-success); }\n.dl.done .dl-cancel { font-weight: 600; }\n.task-state { display: block; color: var(--cf-muted); white-space: normal; max-width: 240px; font-size: 12px; }\n.task-state[data-status="failed"] { color: var(--cf-danger); }\n.task-state[data-status="completed"] { color: var(--cf-success); }\n.task-state .notice { color: var(--cf-warning); }\n@media (max-width: 600px) {\n  :host { right: 8px; bottom: 8px; }\n  .cf { max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); max-height: calc(100dvh - 16px); }\n  .bd { padding: 12px; }\n  .preferences { grid-template-columns: minmax(0, 1fr); }\n  .bar .primary { margin-left: 0; }\n  .excl-acts { margin-left: 40px; }\n  .excl-row input[type="text"] { flex-basis: calc(100% - 40px); }\n}\n@media (pointer: coarse) {\n  button, input:not([type="checkbox"]), select { min-height: 44px; }\n  summary { padding-block: 8px; }\n}\n';

  // src/ui.js
  var PANEL_HTML = `
  <style>${ui_default}</style>
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
  var PHASE_LABEL = {
    pick: "选择保存目录",
    locate: "打开播放页，自动捕获播放列表",
    download: "下载中",
    finish: "写入文件",
    file: "创建文件",
    queued: "排队中"
  };
  function formatBytes(n) {
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  function formatDuration(sec) {
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor(s % 3600 / 60);
    const pad = (x) => String(x).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }
  function createUI({ state, courseId, filenameOf, outputNameOf = filenameOf, actions }) {
    const host = document.createElement("div");
    host.id = "course-fetch-host";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = PANEL_HTML;
    document.body.appendChild(host);
    const $ = (sel) => root.querySelector(sel);
    const ui = {
      panel: $(".cf"),
      count: $(".count"),
      course: $(".course"),
      tpl: $(".tpl"),
      fmt: $(".fmt"),
      exclSummary: $(".excl-sum"),
      exclRows: $(".excl-rows"),
      holidays: $(".holidays"),
      status: $(".status"),
      warn: $(".warn"),
      tbody: $("tbody"),
      chkAll: $(".chk-all"),
      dl: {
        root: $(".dl"),
        name: $(".dl-name"),
        cancel: $(".dl-cancel"),
        bar: $(".dl-bar"),
        fill: $(".dl-fill"),
        l1: $(".dl-l1"),
        l2: $(".dl-l2"),
        warn: $(".dl-warn"),
        note: $(".dl-note")
      }
    };
    const appearance = mountAppearance({ host, select: $(".theme"), status: $(".theme-source") });
    const selectedEntries = () => state.entries.filter((e) => state.selected.has(entryKey(e)));
    const selectableEntries = () => state.entries.filter((e) => !e.excluded);
    const exclusionsOf = (entries) => collectExclusions(entries, state.excluded, holidayRanges(state.holidays));
    function applyExcluded() {
      const labels = exclusionsOf(state.entries);
      state.entries = applyExclusions(state.entries, new Set(labels.keys()));
      for (const e of state.entries) if (e.excluded) state.selected.delete(entryKey(e));
    }
    function setExcluded(next) {
      state.excluded = next;
      const keys = [...next];
      if (keys.length) store.set(`excluded:${courseId}`, keys);
      else store.delete(`excluded:${courseId}`);
      applyExcluded();
      render();
    }
    function setHolidays(next) {
      state.holidays = next;
      if (next.length) store.set("holidays", next);
      else store.delete("holidays");
      applyExcluded();
      render();
    }
    let exclLines = [""];
    let nameFor = null;
    let tagName = "";
    let flashTimer = null;
    function setStatus(msg) {
      state.status = msg;
      render();
    }
    function flash(msg) {
      ui.status.textContent = msg;
      ui.status.classList.add("flash");
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        ui.status.classList.remove("flash");
        ui.status.textContent = state.status;
      }, 2500);
    }
    async function copyText(text, okMsg) {
      try {
        if (typeof GM_setClipboard === "function") GM_setClipboard(text, "text");
        else await navigator.clipboard.writeText(text);
        flash(okMsg);
      } catch (e) {
        flash(`复制失败：${e.message}`);
      }
    }
    function headerCount() {
      const d = state.download;
      if (d) return d.total ? `下载 ${Math.floor(d.done / d.total * 100)}%` : "下载准备中…";
      if (state.batch) {
        const p = batchProgress(state.batch);
        if (!state.batch.running) return `批量结束 · 成功 ${p.completed}/${p.total}`;
        return `批量 ${Math.floor(p.percent)}% · ${p.settled}/${p.total}`;
      }
      if (state.scanning) return "扫描中…";
      const excluded = state.entries.length - selectableEntries().length;
      return excluded ? `${state.entries.length} 条（排除 ${excluded}）` : `${state.entries.length} 条`;
    }
    function summaryText() {
      const active = state.holidays.filter((h) => h.enabled !== false).map((h) => h.name);
      return active.length ? `排除日期 · ${active.join("、")}` : "排除日期";
    }
    function downloadButtonLabel(key) {
      const d = state.download;
      if (!d || d.key !== key) return "下载";
      if (d.aborting) return "取消中…";
      return d.total ? `${Math.floor(d.done / d.total * 100)}%` : "准备中…";
    }
    function updateDownloadUI() {
      const d = state.download;
      const box2 = ui.dl;
      box2.root.hidden = !d && !state.batch;
      box2.root.classList.toggle("done", !!state.batch && !state.batch.running);
      ui.count.textContent = headerCount();
      if (state.batch) {
        const batch = state.batch;
        const p = batchProgress(batch);
        box2.name.textContent = `批量下载 · ${p.total} 条录像`;
        box2.name.title = box2.name.textContent;
        box2.bar.classList.toggle("indeterminate", batch.phase === "pick" && batch.running);
        box2.fill.style.width = `${p.percent.toFixed(1)}%`;
        box2.note.hidden = true;
        if (!batch.running) {
          box2.cancel.disabled = false;
          box2.cancel.textContent = "确定";
          box2.l1.textContent = `批量下载已结束：成功 ${p.completed} · 失败 ${p.failed} · 取消 ${p.cancelled}`;
          box2.l2.textContent = `已写入 ${formatBytes(p.bytes)} · 每条结果见下表，点「确定」清除结果并恢复列表`;
        } else {
          box2.cancel.disabled = batch.aborting;
          box2.cancel.textContent = batch.aborting ? "取消中…" : "取消整个批次";
          box2.l1.textContent = batch.phase === "pick" ? "选择目标目录" : `已处理 ${p.settled} / ${p.total}（${p.percent.toFixed(0)}%）· 成功 ${p.completed} · 失败 ${p.failed} · 取消 ${p.cancelled}`;
          const batchSave = batch.sinkKind === "file" ? "直接写入磁盘" : batch.sinkKind === "opfs" ? "浏览器临时存储" : "内存合并，逐条保存";
          box2.l2.textContent = `正在处理 ${p.active} · 排队 ${p.queued} · 已写入 ${formatBytes(p.bytes)} · ${batchSave}（总进度按录像等权，含失败/取消）`;
        }
        const notes = [];
        if (p.fallbacks) notes.push(`注意：${p.fallbacks} 条录像编码无法无损转为 MP4，已改存为 TS`);
        if (batch.sinkKind === "opfs") notes.push(`注意：${batch.sinkNote || "当前浏览器不支持目录写入"}，使用浏览器临时存储，完成后保存`);
        else if (batch.sinkKind === "memory") notes.push(`注意：${batch.sinkNote || "当前浏览器不支持目录写入"}，内存合并，逐条保存`);
        box2.note.hidden = !notes.length;
        box2.note.textContent = notes.join("；");
        box2.warn.hidden = !p.badTs;
        box2.warn.textContent = p.badTs ? `注意：${p.badTs} 个分片不是有效的 TS 数据，请检查对应录像` : "";
        for (const task of batch.tasks) {
          const row = ui.tbody.querySelector(`tr[data-key="${CSS.escape(task.key)}"]`);
          if (!row) continue;
          const label = row.querySelector(".task-state");
          label.dataset.status = task.status;
          const progress = task.total ? ` · ${task.done}/${task.total} 分片 · ${formatBytes(task.bytes)}` : "";
          label.textContent = (task.status === "completed" ? "已完成" : task.status === "failed" ? `失败：${task.error}` : task.status === "cancelled" ? "已取消" : task.aborting ? "取消中…" : PHASE_LABEL[task.phase]) + progress + (task.badTs ? ` · 注意：${task.badTs} 个异常 TS 分片` : "");
          if (task.notice) label.appendChild(Object.assign(document.createElement("span"), { className: "notice", textContent: ` · 注意：${task.notice}` }));
          label.title = `${task.filename}${task.error ? `：${task.error}` : ""}${task.notice ? `：${task.notice}` : ""}`;
          const cancel = row.querySelector('[data-row="batch-cancel"]');
          cancel.hidden = !batch.running || isTaskFinished(task);
          cancel.disabled = task.aborting;
        }
        return;
      }
      if (!d) return;
      const pct = d.total ? d.done / d.total * 100 : 0;
      box2.name.textContent = d.filename;
      box2.name.title = d.filename;
      box2.bar.classList.toggle("indeterminate", !d.total);
      box2.fill.style.width = d.total ? `${pct.toFixed(1)}%` : "";
      box2.cancel.disabled = d.aborting;
      box2.cancel.textContent = d.aborting ? "取消中…" : "取消";
      let line1 = PHASE_LABEL[d.phase] || d.phase;
      if (d.total) line1 += ` · 分片 ${d.done} / ${d.total}（${pct.toFixed(0)}%）`;
      box2.l1.textContent = line1;
      const parts = [];
      if (d.total) {
        const elapsed = (Date.now() - d.startedAt) / 1e3;
        parts.push(`已下载 ${formatBytes(d.bytes)}`);
        if (d.totalSeconds) parts.push(`视频 ${formatDuration(d.seconds)} / ${formatDuration(d.totalSeconds)}`);
        if (elapsed > 1 && d.bytes) {
          parts.push(`${formatBytes(d.bytes / elapsed)}/s`);
          if (d.done > 0 && d.done < d.total) parts.push(`剩余约 ${formatDuration(elapsed / d.done * (d.total - d.done))}`);
        }
        parts.push(d.sinkKind === "file" ? "直接写入磁盘" : d.sinkKind === "opfs" ? "浏览器临时存储，完成后保存" : "内存中合并，完成后保存");
        if (/\.mp4$/i.test(d.filename)) parts.push("边下载边转封装 MP4");
      }
      box2.l2.textContent = parts.join(" · ");
      box2.warn.hidden = !d.badTs;
      box2.warn.textContent = d.badTs ? `注意：${d.badTs} 个分片解密后不是有效的 TS 数据（key/IV 可能不对），建议取消后检查` : "";
      const note = [
        d.sinkKind === "memory" && d.sinkNote ? `${d.sinkNote}，改为在内存中合并（占用内存约等于视频大小）` : "",
        d.sinkKind === "opfs" ? `${d.sinkNote || "当前浏览器不支持目录写入"}，使用浏览器临时存储，完成后保存` : "",
        d.notice
      ].filter(Boolean);
      box2.note.hidden = !note.length;
      box2.note.textContent = note.map((n) => `注意：${n}`).join("；");
      const btn = ui.tbody.querySelector(`tr[data-key="${CSS.escape(d.key)}"] button[data-row="download"]`);
      if (btn) btn.textContent = downloadButtonLabel(d.key);
    }
    function render() {
      ui.panel.classList.toggle("collapsed", state.collapsed);
      $(".hd").setAttribute("aria-expanded", String(!state.collapsed));
      ui.count.textContent = headerCount();
      if (root.activeElement !== ui.course) ui.course.value = state.course;
      if (root.activeElement !== ui.tpl) ui.tpl.value = state.template;
      ui.fmt.value = state.format;
      if (!ui.status.classList.contains("flash")) ui.status.textContent = state.status;
      const busy = !!state.download || !!state.batch?.running;
      root.querySelectorAll(".bar button").forEach((b) => b.disabled = state.scanning || busy && ["scan", "download"].includes(b.dataset.act));
      ui.fmt.disabled = busy;
      ui.exclSummary.textContent = summaryText();
      ui.exclRows.replaceChildren(...exclLines.map((line, i) => {
        const item = document.createElement("div");
        item.className = "excl-item";
        const row = document.createElement("div");
        row.className = "excl-row";
        const step = Object.assign(document.createElement("button"), {
          className: i ? "excl-del" : "excl-add",
          textContent: i ? "−" : "+",
          title: i ? "删掉这一行" : "再加一行日期",
          disabled: busy
        });
        step.dataset[i ? "exclDel" : "exclAdd"] = String(i);
        const input = Object.assign(document.createElement("input"), { type: "text", value: line, disabled: busy });
        input.className = "excl-line";
        input.dataset.exclLine = String(i);
        if (!i) input.placeholder = "2026-10-01 或 2026-10-01~2026-10-07";
        const acts = document.createElement("span");
        acts.className = "excl-acts";
        for (const [cls, key, label, title] of [
          ["excl-apply", "exclApply", "排除", "排除当前课程中落在这一行日期的录像"],
          ["excl-restore", "exclRestore", "恢复", "恢复这一行日期对应的条目（由标签排除的要停用或删除标签）"],
          ["excl-tag", "exclTag", "存为标签", "把这一行的日期存成标签，对所有课程自动生效"]
        ]) {
          const b = Object.assign(document.createElement("button"), { className: cls, textContent: label, title, disabled: busy });
          b.dataset[key] = String(i);
          acts.appendChild(b);
        }
        row.appendChild(step);
        row.appendChild(input);
        row.appendChild(acts);
        item.appendChild(row);
        if (nameFor === i) {
          const wrap = document.createElement("div");
          wrap.className = "excl-name";
          const name = Object.assign(document.createElement("input"), { type: "text", value: tagName, placeholder: "名称", disabled: busy });
          name.className = "tag-name";
          name.dataset.exclName = String(i);
          const save = Object.assign(document.createElement("button"), { className: "excl-save", textContent: "保存", disabled: busy });
          save.dataset.exclSave = String(i);
          wrap.appendChild(name);
          wrap.appendChild(save);
          item.appendChild(wrap);
        }
        return item;
      }));
      ui.warn.hidden = !state.warnings.length;
      ui.warn.querySelector("summary").textContent = `${state.warnings.length} 条提示`;
      ui.warn.querySelector("ul").replaceChildren(
        ...state.warnings.map((w) => Object.assign(document.createElement("li"), { textContent: w }))
      );
      ui.holidays.replaceChildren(...state.holidays.map((h, i) => {
        const chip = document.createElement("span");
        chip.className = h.enabled === false ? "hol off" : "hol";
        const box2 = Object.assign(document.createElement("input"), {
          type: "checkbox",
          checked: h.enabled !== false
        });
        box2.dataset.hol = String(i);
        box2.title = "停用后不再自动排除";
        box2.setAttribute("aria-label", `启用排除标签 ${h.name}`);
        const name = Object.assign(document.createElement("span"), { textContent: h.name });
        const dates = Object.assign(document.createElement("span"), {
          className: "dates",
          textContent: h.ranges.map((r) => r.from === r.to ? r.from : `${r.from}~${r.to}`).join(" ")
        });
        const del = Object.assign(document.createElement("button"), { className: "link", textContent: "删除" });
        del.dataset.holDel = String(i);
        for (const node of [box2, name, dates, del]) chip.appendChild(node);
        return chip;
      }));
      const labels = exclusionsOf(state.entries);
      const frag = document.createDocumentFragment();
      for (const e of state.entries) {
        const key = entryKey(e);
        const tr = document.createElement("tr");
        tr.dataset.key = key;
        if (e.excluded) tr.className = "excluded";
        const cells = [
          Object.assign(document.createElement("input"), {
            type: "checkbox",
            checked: !e.excluded && state.selected.has(key),
            disabled: e.excluded
          }),
          e.excluded ? "—" : String(e.index),
          outputNameOf(e),
          e.startTime ? e.startTime.slice(0, 16) : e.date,
          e.teacher
        ];
        cells.forEach((c, i) => {
          const td = document.createElement("td");
          if (i === 2) td.className = "fn";
          if (typeof c === "string") td.textContent = c;
          else {
            c.setAttribute("aria-label", `选择录像 ${e.index ?? e.origIndex}`);
            td.appendChild(c);
          }
          tr.appendChild(td);
        });
        const act = document.createElement("td");
        const otherDownload = state.download && state.download.key !== key || state.batch?.running;
        act.innerHTML = `<button class="link" data-row="open"${e.watchUrl ? "" : ' disabled title="无可用链接"'}>打开</button><button class="link" data-row="copy">复制名</button>`;
        const holiday = labels.get(key);
        const exclude = document.createElement(holiday ? "span" : "button");
        if (holiday) {
          exclude.className = "hol-tag";
          exclude.textContent = holiday;
          exclude.title = `由「${holiday}」标签自动排除；停用或删除该标签即可恢复`;
        } else {
          exclude.className = "link";
          exclude.dataset.row = "toggle-exclude";
          exclude.textContent = e.excluded ? "恢复" : "排除";
        }
        act.appendChild(exclude);
        const download = document.createElement("button");
        download.className = "link";
        download.dataset.row = "download";
        if (!e.watchUrl || otherDownload) download.disabled = true;
        if (state.download && !otherDownload) download.title = "点击取消";
        download.textContent = downloadButtonLabel(key);
        act.appendChild(download);
        const taskState = document.createElement("span");
        taskState.className = "task-state";
        const cancel = document.createElement("button");
        cancel.className = "link";
        cancel.dataset.row = "batch-cancel";
        cancel.textContent = "取消此条";
        cancel.hidden = true;
        act.appendChild(taskState);
        act.appendChild(cancel);
        tr.appendChild(act);
        frag.appendChild(tr);
      }
      if (!state.entries.length) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td colspan="6" class="muted">${state.scanning ? "扫描中…" : "暂无条目"}</td>`;
        frag.appendChild(tr);
      }
      ui.tbody.replaceChildren(frag);
      const selectable = selectableEntries().length;
      ui.chkAll.checked = selectable > 0 && state.selected.size === selectable;
      updateDownloadUI();
    }
    $(".hd").addEventListener("click", () => {
      state.collapsed = !state.collapsed;
      store.set("collapsed", state.collapsed);
      render();
    });
    ui.course.addEventListener("input", () => {
      state.course = ui.course.value.trim();
      store.set(`course:${courseId}`, state.course);
      render();
    });
    ui.tpl.addEventListener("input", () => {
      state.template = ui.tpl.value || DEFAULT_TEMPLATE;
      store.set("template", state.template);
      render();
    });
    ui.fmt.addEventListener("change", () => {
      state.format = ui.fmt.value === "ts" ? "ts" : "mp4";
      store.set("format", state.format);
      render();
    });
    $(".reset-tpl").addEventListener("click", () => {
      state.template = DEFAULT_TEMPLATE;
      store.set("template", state.template);
      ui.tpl.value = state.template;
      render();
    });
    const rowTag = (i) => exclLines.length > 1 ? `第 ${i + 1} 行：` : "";
    const invalidTail = (invalid) => invalid.length ? `（未识别：${invalid.join(" ")}）` : "";
    function parseLine(i) {
      const { ranges, invalid } = parseDateRanges(exclLines[i] || "");
      if (!ranges.length) {
        flash(invalid.length ? `${rowTag(i)}没识别出日期：${invalid.join(" ")}` : `${rowTag(i)}请先填写日期`);
        return null;
      }
      return { ranges, invalid };
    }
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
    function toggleTagName(i) {
      nameFor = nameFor === i ? null : i;
      tagName = "";
      render();
      if (nameFor === null) return;
      const input = ui.exclRows.children[i] && ui.exclRows.children[i].querySelector(".tag-name");
      if (input && typeof input.focus === "function") input.focus();
    }
    function saveTagLine(i) {
      const parsed = parseLine(i);
      if (!parsed) return;
      const name = nameFor === i && tagName.trim() || (exclLines[i] || "").trim();
      const holidays = [...state.holidays, { name, ranges: parsed.ranges, enabled: true }];
      nameFor = null;
      tagName = "";
      exclLines.splice(i, 1);
      if (!exclLines.length) exclLines = [""];
      setHolidays(holidays);
      flash(`已添加「${name}」，对所有课程生效${invalidTail(parsed.invalid)}`);
    }
    function addLine() {
      exclLines.push("");
      render();
      const item = ui.exclRows.children[exclLines.length - 1];
      const input = item && item.querySelector(".excl-line");
      if (input && typeof input.focus === "function") input.focus();
    }
    function delLine(i) {
      if (i < 1 || exclLines.length < 2) return;
      exclLines.splice(i, 1);
      if (nameFor === i) nameFor = null;
      else if (nameFor > i) nameFor -= 1;
      render();
    }
    ui.exclRows.addEventListener("input", (ev) => {
      const d = ev.target.dataset || {};
      if (d.exclLine !== void 0) exclLines[Number(d.exclLine)] = ev.target.value;
      else if (d.exclName !== void 0) tagName = ev.target.value;
    });
    ui.exclRows.addEventListener("click", (ev) => {
      const d = ev.target.dataset || {};
      if (d.exclAdd !== void 0) return addLine();
      if (d.exclDel !== void 0) return delLine(Number(d.exclDel));
      if (d.exclApply !== void 0) return applyLine(Number(d.exclApply));
      if (d.exclRestore !== void 0) return restoreLine(Number(d.exclRestore));
      if (d.exclTag !== void 0) return toggleTagName(Number(d.exclTag));
      if (d.exclSave !== void 0) return saveTagLine(Number(d.exclSave));
    });
    ui.exclRows.addEventListener("keydown", (ev) => {
      const d = ev.target.dataset || {};
      if (d.exclLine !== void 0 && ev.key === "Enter") applyLine(Number(d.exclLine));
      else if (d.exclName !== void 0 && ev.key === "Enter") saveTagLine(Number(d.exclName));
      else if (ev.key === "Escape" && nameFor !== null) {
        nameFor = null;
        tagName = "";
        render();
      }
    });
    ui.holidays.addEventListener("change", (ev) => {
      const i = Number(ev.target.dataset && ev.target.dataset.hol);
      if (!Number.isInteger(i) || !state.holidays[i]) return;
      const holidays = state.holidays.map((h, n) => n === i ? { ...h, enabled: !!ev.target.checked } : h);
      setHolidays(holidays);
      flash(ev.target.checked ? `已启用「${holidays[i].name}」` : `已停用「${holidays[i].name}」`);
    });
    ui.holidays.addEventListener("click", (ev) => {
      const i = Number(ev.target.dataset && ev.target.dataset.holDel);
      if (!Number.isInteger(i) || !state.holidays[i]) return;
      const name = state.holidays[i].name;
      setHolidays(state.holidays.filter((_, n) => n !== i));
      flash(`已删除「${name}」`);
    });
    ui.chkAll.addEventListener("change", () => {
      state.selected = ui.chkAll.checked ? new Set(selectableEntries().map(entryKey)) : /* @__PURE__ */ new Set();
      render();
    });
    $(".bar").addEventListener("click", (ev) => {
      const act = ev.target.dataset && ev.target.dataset.act;
      if (act === "scan") actions.scan();
      else if (act === "all") state.selected = new Set(selectableEntries().map(entryKey)), render();
      else if (act === "none") state.selected = /* @__PURE__ */ new Set(), render();
      else if (act === "open") actions.openEntries(selectedEntries());
      else if (act === "copy") {
        if (!state.entries.length) return flash("没有可复制的条目");
        const list = state.selected.size ? selectedEntries() : selectableEntries();
        copyText(
          buildListText({ course: state.course, template: state.template, entries: list }),
          `已复制 ${list.length} 条清单` + (state.selected.size ? "（仅选中）" : "")
        );
      } else if (act === "export") actions.exportManifest();
      else if (act === "download") actions.downloadSelected(selectedEntries());
    });
    ui.tbody.addEventListener("click", (ev) => {
      const tr = ev.target.closest("tr");
      const key = tr && tr.dataset.key;
      if (!key) return;
      const entry = state.entries.find((e) => entryKey(e) === key);
      if (ev.target.type === "checkbox") {
        if (entry.excluded) return;
        if (ev.target.checked) state.selected.add(key);
        else state.selected.delete(key);
        const selectable = selectableEntries().length;
        ui.chkAll.checked = selectable > 0 && state.selected.size === selectable;
      } else if (ev.target.dataset.row === "toggle-exclude") {
        const next = new Set(state.excluded);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        setExcluded(next);
        flash(entry.excluded ? "已恢复该条" : "已排除该条");
      } else if (ev.target.dataset.row === "open") {
        actions.openEntries([entry]);
      } else if (ev.target.dataset.row === "copy") {
        copyText(outputNameOf(entry), "已复制文件名");
      } else if (ev.target.dataset.row === "download") {
        const d = state.download;
        if (d && d.key === key) {
          if (confirm(`取消下载 ${d.filename}？`)) actions.cancelDownload();
        } else {
          actions.downloadEntry(entry);
        }
      } else if (ev.target.dataset.row === "batch-cancel") {
        actions.cancelTask(key);
      }
    });
    ui.dl.cancel.addEventListener("click", () => {
      if (state.batch?.running) return actions.cancelBatchDownload();
      if (state.batch) return actions.dismissBatch();
      const d = state.download;
      if (d && confirm(`取消下载 ${d.filename}？`)) actions.cancelDownload();
    });
    const onPageHide = (event) => {
      if (!event.persisted) appearance.destroy();
    };
    window.addEventListener("pagehide", onPageHide);
    function destroy() {
      clearTimeout(flashTimer);
      appearance.destroy();
      window.removeEventListener?.("pagehide", onPageHide);
      host.remove();
    }
    return { render, setStatus, flash, updateDownloadUI, destroy };
  }

  // src/directory.js
  async function pickDownloadDirectory(win = window) {
    if (typeof win.showDirectoryPicker !== "function") {
      throw new Error("当前浏览器不支持选择本地下载目录");
    }
    return win.showDirectoryPicker({ mode: "readwrite" });
  }
  function createDirectorySinkFactory(directory) {
    const reserved = /* @__PURE__ */ new Set();
    return async (filename, signal) => {
      const [, base, ext] = /^(.*?)(\.[^.]*)?$/.exec(filename);
      let name;
      for (let suffix = 0; ; suffix++) {
        if (signal?.aborted) throw abortError();
        name = suffix ? `${base} (${suffix + 1})${ext || ""}` : filename;
        const canonical = name.toLowerCase();
        if (reserved.has(canonical)) continue;
        reserved.add(canonical);
        try {
          await directory.getFileHandle(name);
        } catch (error) {
          if (error.name === "NotFoundError") break;
          if (error.name !== "TypeMismatchError") throw error;
        }
      }
      if (signal?.aborted) throw abortError();
      const handle = await directory.getFileHandle(name, { create: true });
      let writable;
      try {
        if (signal?.aborted) throw abortError();
        writable = await handle.createWritable();
        if (signal?.aborted) throw abortError();
      } catch (error) {
        if (writable) await writable.abort();
        await directory.removeEntry(name).catch(() => {
        });
        throw error;
      }
      return {
        kind: "file",
        filename: name,
        write: (data) => writable.write(data),
        writeAt: (position, data) => writable.write({ type: "write", position, data }),
        close: () => writable.close(),
        abort: async () => {
          try {
            await writable.abort();
          } finally {
            await directory.removeEntry(name);
          }
        }
      };
    };
  }
  function createOpfsSinkFactory(directory, save = saveBlob) {
    return async (filename, signal) => {
      if (signal?.aborted) throw abortError();
      const name = `${crypto.randomUUID()}.tmp`;
      const handle = await directory.getFileHandle(name, { create: true });
      const remove = () => directory.removeEntry(name);
      let writable, closed = false;
      try {
        if (signal?.aborted) throw abortError();
        writable = await handle.createWritable();
        if (signal?.aborted) throw abortError();
      } catch (error) {
        if (writable) await Promise.resolve().then(() => writable.abort()).catch(() => {
        });
        await remove().catch(() => {
        });
        throw error;
      }
      return {
        kind: "opfs",
        filename,
        write: (data) => writable.write(data),
        writeAt: (position, data) => writable.write({ type: "write", position, data }),
        close: async () => {
          if (signal?.aborted) throw abortError();
          await writable.close();
          closed = true;
          const file = await handle.getFile();
          if (signal?.aborted) throw abortError();
          await save(file, filename, remove);
        },
        abort: async () => {
          try {
            if (!closed) await writable.abort();
          } finally {
            await remove();
          }
        }
      };
    };
  }
  async function pickDownloadTarget(win = window, save = saveBlob) {
    let reason = "当前浏览器不支持目录写入";
    if (typeof win.showDirectoryPicker === "function") {
      try {
        const directory = await pickDownloadDirectory(win);
        return { kind: "file", reason: "", open: createDirectorySinkFactory(directory) };
      } catch (error) {
        if (error.name !== "SecurityError") throw error;
        reason = "当前页面不允许目录写入（可能在跨域 iframe 中，可右键「在新标签页中打开框架」）";
      }
    }
    const storage = win.navigator?.storage;
    if (typeof storage?.getDirectory === "function" && typeof win.FileSystemFileHandle?.prototype?.createWritable === "function") {
      try {
        const root = await storage.getDirectory();
        const directory = await root.getDirectoryHandle("course-fetch", { create: true });
        return { kind: "opfs", reason, open: createOpfsSinkFactory(directory, save) };
      } catch (error) {
        if (!["SecurityError", "NotAllowedError", "NotSupportedError"].includes(error.name)) throw error;
        reason += "，浏览器临时存储不可用";
      }
    }
    return { kind: "memory", reason, open: async (filename, signal) => {
      if (signal?.aborted) throw abortError();
      return Object.assign(memorySink(filename, save), { filename });
    } };
  }

  // src/main.js
  var MAX_PAGES = 50;
  var MAX_TABS_WITHOUT_CONFIRM = 8;
  var DOWNLOAD_CONCURRENCY = 4;
  function main() {
    if (typeof document === "undefined") return;
    if (/videoList\.action/i.test(location.href)) return listPage();
    if (window.__courseFetchCapture) return;
    window.__courseFetchCapture = true;
    runPlayerCapture().catch((e) => console.warn("[Course Fetch] 捕获失败", e));
  }
  function listPage() {
    if (window.__courseFetchLoaded) return;
    window.__courseFetchLoaded = true;
    const VERSION = typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version || "0.6.0";
    console.info(`[Course Fetch] v${VERSION} loaded`);
    const courseId = parseCourseId(location.href);
    const savedExcluded = store.get(`excluded:${courseId}`, []);
    const savedHolidays = store.get("holidays", []);
    const state = {
      course: store.get(`course:${courseId}`, "") || detectCourseName() || (courseId ? `course_${courseId}` : ""),
      template: store.get("template", DEFAULT_TEMPLATE),
      format: OUTPUT_FORMATS.includes(store.get("format", "mp4")) ? store.get("format", "mp4") : "mp4",
      // 输出格式：mp4（无损转封装）/ ts
      collapsed: store.get("collapsed", true),
      entries: [],
      // 含 watchUrl，仅内存
      duplicates: [],
      failures: [],
      warnings: [],
      pages: 0,
      selected: /* @__PURE__ */ new Set(),
      // entryKey
      // entryKey；本课程手动排除的条目（放假空回放等），按课程记住
      excluded: new Set(Array.isArray(savedExcluded) ? savedExcluded : []),
      // [{ name, ranges, enabled }]；全局节假日标签，跨课程自动生效
      holidays: Array.isArray(savedHolidays) ? savedHolidays : [],
      scanning: false,
      status: "",
      download: null,
      // { key, filename, controller, aborting, phase, done, total, bytes, ... }，仅内存
      batch: null
      // 仅内存；完成后保留每条录像结果，直到下次下载。
    };
    const requestLimiter = createRequestLimiter(BATCH_LIMITS.requests);
    const limitedRequest = requestLimiter.wrap(gmRequest);
    const numbered = (e) => e.excluded ? { ...e, index: e.origIndex } : e;
    const filenameOf = (e) => formatFilename(state.template, numbered(e), { course: state.course });
    const outputNameOf = (e) => withExtension(filenameOf(e), state.format);
    async function scan() {
      if (state.scanning || state.download || state.batch?.running) return;
      state.scanning = true;
      ui.setStatus("正在解析当前页…");
      const result = await crawlCourse({
        firstDoc: document,
        firstUrl: location.href,
        fetchDoc: fetchDocument,
        maxPages: MAX_PAGES,
        onProgress: ui.setStatus
      });
      const keys = new Set(result.entries.map(entryKey));
      state.selected = new Set([...state.selected].filter((k) => keys.has(k)));
      Object.assign(state, {
        entries: applyExclusions(
          result.entries,
          new Set(collectExclusions(result.entries, state.excluded, holidayRanges(state.holidays)).keys())
        ),
        duplicates: result.duplicates,
        failures: result.failures,
        warnings: result.warnings,
        pages: result.pages,
        scanning: false
      });
      ui.setStatus(result.status);
    }
    function openUrl(url) {
      if (typeof GM_openInTab === "function") GM_openInTab(url, { active: false, insert: true, setParent: true });
      else window.open(url, "_blank", "noopener");
    }
    function openEntries(list) {
      const ok = list.filter((e) => e.watchUrl);
      const missing = list.length - ok.length;
      if (!ok.length) return ui.flash(missing ? "选中的条目没有可打开的链接" : "请先勾选要打开的录像");
      if (ok.length > MAX_TABS_WITHOUT_CONFIRM && !confirm(`将打开 ${ok.length} 个标签页，确定吗？`)) return;
      ok.forEach((e) => openUrl(e.watchUrl));
      ui.flash(`已打开 ${ok.length} 个页面` + (missing ? `，${missing} 条无链接` : ""));
    }
    function exportManifest() {
      const entries = state.entries.filter((e) => !e.excluded);
      if (!entries.length) return ui.flash("没有可导出的条目");
      const manifest = buildManifest({
        course: state.course,
        courseId,
        template: state.template,
        entries
      });
      const blob = new Blob([safeStringify(manifest)], { type: "application/json" });
      saveBlob(blob, sanitizeFilename(`${state.course || courseId || "course"}-manifest.json`));
      ui.flash("已导出 manifest");
    }
    function cancelDownload() {
      const d = state.download;
      if (!d || d.aborting) return;
      d.aborting = true;
      d.controller.abort();
      ui.updateDownloadUI();
    }
    async function downloadEntry(entry) {
      if (state.download || state.batch?.running) return ui.flash("已有下载在进行中");
      if (!entry.watchUrl) return ui.flash("该条目没有可用的播放链接");
      const controller = new AbortController();
      const signal = controller.signal;
      const dl = {
        key: entryKey(entry),
        filename: outputNameOf(entry),
        controller,
        aborting: false,
        phase: "pick",
        sinkKind: "",
        sinkNote: "",
        // 使用浏览器保存模式的原因
        notice: "",
        done: 0,
        total: 0,
        bytes: 0,
        seconds: 0,
        totalSeconds: 0,
        badTs: 0,
        startedAt: Date.now()
      };
      state.download = dl;
      state.batch = null;
      state.collapsed = false;
      let sink = null;
      let outcome;
      try {
        ui.render();
        const target = await pickDownloadTarget();
        if (signal.aborted) throw abortError();
        dl.sinkKind = target.kind;
        dl.sinkNote = target.reason;
        sink = await target.open(dl.filename, signal);
        if (signal.aborted) throw abortError();
        dl.filename = sink.filename || dl.filename;
        dl.phase = "locate";
        ui.updateDownloadUI();
        const playlistUrl = await locatePlaylist(entry.watchUrl, { signal });
        dl.phase = "download";
        dl.startedAt = Date.now();
        ui.updateDownloadUI();
        const output = createOutput({
          filename: dl.filename,
          sink,
          onFallback: async (error) => {
            const old = sink;
            sink = null;
            await old.abort();
            sink = await target.open(withExtension(dl.filename, "ts"), signal);
            if (signal.aborted) throw abortError();
            dl.filename = sink.filename || withExtension(dl.filename, "ts");
            dl.notice = `${error.reason}，无法无损转为 MP4，已改存为 TS`;
            ui.updateDownloadUI();
            return sink;
          }
        });
        const result = await downloadHls({
          playlistUrl,
          request: limitedRequest,
          write: (d) => output.write(d),
          concurrency: DOWNLOAD_CONCURRENCY,
          signal,
          onProgress: (p) => {
            Object.assign(dl, {
              done: p.done,
              total: p.total,
              bytes: p.bytes,
              seconds: p.seconds,
              totalSeconds: p.totalSeconds,
              badTs: p.badTs
            });
            ui.updateDownloadUI();
          }
        });
        dl.phase = "finish";
        ui.updateDownloadUI();
        const remuxed = await output.finish();
        if (signal.aborted) throw abortError();
        await sink.close();
        sink = null;
        const size = remuxed.format === "mp4" ? remuxed.bytes : result.bytes;
        outcome = `已完成：${dl.filename}（${result.segments} 个分片，${formatBytes(size)}，时长 ${formatDuration(result.duration)}）`;
        if (result.badTs) outcome += `，但有 ${result.badTs} 个分片不是有效 TS，请检查文件`;
        if (dl.notice) outcome += `；${dl.notice}`;
        if (remuxed.warnings?.timestamps) outcome += `，${remuxed.warnings.timestamps} 处时间戳不连续已自动接续`;
        if (target.kind !== "file") outcome += "；已交给浏览器保存，请在下载列表确认结果";
      } catch (e) {
        const cancelled = signal.aborted || e && e.name === "AbortError";
        let message = e && e.message;
        if (!cancelled && e?.name === "RemuxError" && /无法无损封装/.test(message)) message += "。请把面板中的「输出格式」切换为 TS 后重新下载";
        outcome = cancelled ? `已取消下载：${dl.filename}` : `下载失败：${dl.filename}：${message}`;
        if (!cancelled) console.warn("[Course Fetch] 下载失败", e);
      } finally {
        controller.abort();
        if (sink) await withTimeout(Promise.resolve().then(() => sink.abort()), 3e3);
        state.download = null;
        state.status = outcome || "";
        ui.render();
        ui.updateDownloadUI();
      }
    }
    function dismissBatch() {
      const batch = state.batch;
      if (!batch || batch.running) return;
      state.batch = null;
      state.status = batch.statusBefore || "";
      ui.render();
    }
    function cancelBatchDownload() {
      if (!state.batch) return;
      cancelBatch(state.batch);
      ui.updateDownloadUI();
    }
    function cancelTask(key) {
      if (!state.batch?.running) return;
      cancelBatchTask(state.batch, key);
      ui.updateDownloadUI();
    }
    async function downloadSelected(entries) {
      if (state.download || state.batch?.running) return ui.flash("已有下载在进行中");
      if (!entries.length) return ui.flash("请先勾选要下载的录像");
      const batch = createBatch(entries.map((entry) => ({
        key: entryKey(entry),
        filename: outputNameOf(entry),
        watchUrl: entry.watchUrl
      })));
      batch.statusBefore = state.batch && !state.batch.running ? state.batch.statusBefore : state.status;
      state.batch = batch;
      state.collapsed = false;
      let pickCancelled = false;
      try {
        ui.render();
        let target;
        try {
          target = await pickDownloadTarget();
        } catch (error) {
          pickCancelled = error.name === "AbortError";
          throw error;
        }
        if (batch.aborting) return;
        batch.sinkKind = target.kind;
        batch.sinkNote = target.reason;
        await runBatch(batch, {
          openSink: target.open,
          sinkKind: target.kind,
          locate: locatePlaylist,
          request: gmRequest,
          limiter: requestLimiter,
          onChange: ui.updateDownloadUI
        });
      } catch (error) {
        if (error.name === "AbortError" || batch.aborting) cancelBatch(batch);
        else {
          for (const task of batch.tasks) {
            if (task.status === "queued") {
              task.status = "failed";
              task.error = error.message;
            }
          }
        }
      } finally {
        batch.running = false;
        const p = batchProgress(batch);
        if (pickCancelled) {
          state.batch = null;
          state.status = "已取消批量下载（未选择目录）";
        } else {
          state.status = `批次结束：成功 ${p.completed}，失败 ${p.failed}，取消 ${p.cancelled}`;
          if (p.fallbacks) state.status += `；其中 ${p.fallbacks} 条编码无法无损转为 MP4，已改存为 TS`;
          if (batch.sinkKind && batch.sinkKind !== "file" && p.completed) state.status += "；请在浏览器下载列表确认保存结果";
          state.collapsed = false;
        }
        ui.render();
      }
    }
    const ui = createUI({
      state,
      courseId,
      filenameOf,
      outputNameOf,
      actions: { scan, openEntries, exportManifest, downloadEntry, cancelDownload, downloadSelected, cancelBatchDownload, cancelTask, dismissBatch }
    });
    window.addEventListener("beforeunload", (ev) => {
      if (!state.download && !state.batch?.running) return;
      ev.preventDefault();
      ev.returnValue = "";
    });
    ui.render();
    scan().catch((e) => {
      state.scanning = false;
      state.warnings.push(`扫描出错：${e.message}`);
      ui.setStatus("扫描失败");
    });
  }
  main();
})();
