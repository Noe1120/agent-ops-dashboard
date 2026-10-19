/**
 * 数据源：DSH（DeepSeek Harness）
 *
 *   ~/.dsh/sessions/<工作区>/<会话id>/session.v4.jsonl.zstd
 *
 * 文件是「拼接的 zstd 帧 + 每帧一行 JSON」，追加写入。只读，不改 DSH 任何东西。
 *
 * 映射：
 *   智能体 = 一个 DSH 会话（子智能体 delegationDepth > 0 也算一个）
 *   工作流 = 会话所在工作区
 *   任务   = todo 清单（主任务）+ 工具调用（子步骤）
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import * as zlib from 'node:zlib';
import { trunc, toolLabel, verbFor, textOf } from '../lib/core.mjs';

/* zstd 解压需要 Node ≥ 23.8；低版本上 DSH 源自动标记为不可用，另外两个源照常工作 */
const zstd = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null;
export const needsZstd = true;

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/* 失败事件要能说清「哪个工具、什么原因」：用 callId → 工具名，再截一段错误输出 */
const dshCallNames = new Map();
function shortReason(txt){
  let s = String(txt || '').replace(/\s+/g, ' ').trim();
  const m = /(?:process\s+)?exit(?:ed)?\s*(?:with\s*)?code[:\s]*(\d+)/i.exec(s);
  const code = m ? m[1] : '';
  // 去掉 "Process exited with code N:" 前缀，但把退出码保留下来
  s = s.replace(/^(?:process\s+)?exit(?:ed)?\s*(?:with\s*)?code[:\s]*\d+\s*[:：-]?\s*/i, '');
  if (s && code) s = 'exit ' + code + ' · ' + s;
  else if (!s && code) s = 'exit ' + code;
  if (!s) return '';
  return s.length > 46 ? s.slice(0, 45) + '…' : s;
}

/* ---------------- 解码 ---------------- */

/** 把「拼接的 zstd 帧」逐帧解开；遇到写了一半的尾帧就停下，下一轮再补。 */
function decodeFrames(buf) {
  if (!zstd) return '';
  const offs = [];
  for (let p = buf.indexOf(ZSTD_MAGIC); p >= 0; p = buf.indexOf(ZSTD_MAGIC, p + 4)) offs.push(p);
  const parts = [];
  let i = 0;
  while (i < offs.length) {
    let ok = false;
    for (let span = 1; span <= 3 && i + span <= offs.length; span++) {
      const end = i + span < offs.length ? offs[i + span] : buf.length;
      try {
        parts.push(zstd(buf.subarray(offs[i], end)).toString('utf8'));
        i += span; ok = true; break;
      } catch { /* 假位点或半帧，往外扩一帧再试 */ }
    }
    if (!ok) i++;
  }
  return parts.join('');
}

function parseSession(buf) {
  const text = buf.subarray(0, 4).equals(ZSTD_MAGIC) ? decodeFrames(buf) : buf.toString('utf8');
  const events = [];
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try { events.push(JSON.parse(l)); } catch { /* 半行，忽略 */ }
  }
  return events;
}

/* ---------------- 折叠 ---------------- */

function foldSession(id, events, mtime) {
  const s = {
    src: 'dsh', id, cwd: '', title: '', depth: 0, parent: '', origin: 'user', mtime,
    turns: 0, openStep: null, lastTime: 0,
    todos: [], calls: [], msgs: [], snippets: [], gaps: [], current: null, lastFail: null,
    done: 0, failed: 0, seenSeq: 0,
  };
  const open = new Map();
  let prevT = 0;

  for (const e of events) {
    const d = (e.data && typeof e.data === 'object') ? e.data : e;
    const t = Number(e.time) || 0;
    if (t > s.lastTime) s.lastTime = t;
    if (prevT && t > prevT) s.gaps.push(Math.min(600_000, t - prevT));
    if (t) prevT = t;
    switch (e.type) {
      case 'session':
        if (d.cwd) s.cwd = String(d.cwd);
        s.depth = Number(d.delegationDepth) || 0;
        if (d.parentSession) s.parent = String(d.parentSession);
        if (d.origin) s.origin = String(d.origin);
        break;
      case 'session/title':
        if (d.title) s.title = String(d.title);
        break;
      case 'turn/start': s.turns++; break;
      case 'step/start':
        s.openStep = (Number(d.turn) || 0) * 1000 + (Number(d.step) || 0);
        break;
      case 'step/end':
        if (s.openStep === (Number(d.turn) || 0) * 1000 + (Number(d.step) || 0)) s.openStep = null;
        break;
      case 'user/message': {
        if ((d.source && d.source.kind) === 'user') {
          const text = textOf(d.content);
          if (text) s.msgs.push({ role: 'user', text });
        }
        break;
      }
      case 'assistant/message': {
        const text = textOf(d.message && d.message.content);
        if (text) s.msgs.push({ role: 'assistant', text });
        break;
      }
      case 'todo/write':
        s.todos = (Array.isArray(d.todos) ? d.todos : [])
          .map(x => ({ content: String(x.content || ''), status: String(x.status || 'pending') }));
        break;
      case 'tool/call': {
        const c = {
          callId: String(d.callId || ''), name: String(d.name || 'tool'),
          label: toolLabel(d.name, d.arguments), start: t, end: 0, done: false, error: false,
          argBytes: Buffer.byteLength(String(d.arguments || ''), 'utf8'),
        };
        s.calls.push(c);
        if (c.callId) open.set(c.callId, c);
        if (/^(write|edit|multiedit)$/i.test(c.name)) {
          let a = {};
          try { a = JSON.parse(d.arguments); } catch { /* 不是 JSON */ }
          const code = a.content != null ? String(a.content) : a.new_string != null ? String(a.new_string) : '';
          const file = String(a.file_path || a.path || 'untitled');
          if (code.trim()) s.snippets.push({ file, code, at: t });
        }
        break;
      }
      case 'tool/result': {
        const key = String(d.toolCallId || (d.message && d.message.toolCallId) || '');
        const c = open.get(key);
        if (c) {
          c.done = true; c.end = t; c.error = !!(d.message && d.message.isError);
          if (c.error) {
            // 把错误输出本身抠成一句短原因，别只留个工具名
            c.reason = shortReason(textOf(d.message && d.message.content));
            s.failed++;
            s.lastFail = { name: c.name, label: c.label, reason: c.reason, at: c.end || t };
          } else s.done++;
          open.delete(key);
        }
        break;
      }
      default: break;
    }
  }
  s.current = [...open.values()].pop() || null;
  if (!s.title) s.title = s.cwd ? basename(s.cwd) : id.slice(-8);
  if (s.calls.length > 400) s.calls = s.calls.slice(-400);
  if (s.gaps.length > 800) s.gaps = s.gaps.slice(-800);
  if (s.msgs.length > 40) s.msgs = s.msgs.slice(-40);
  if (s.snippets.length > 8) s.snippets = s.snippets.slice(-8);
  return s;
}

/** 事件 → 任务流的一行。对话优先用真实消息文本，工具调用用真实入参。 */
function eventToFeed(e) {
  const d = (e.data && typeof e.data === 'object') ? e.data : e;
  switch (e.type) {
    case 'user/message':
      if ((d.source && d.source.kind) === 'user') {
        const text = textOf(d.content);
        if (text) return { verb: 'read', name: text, kind: 'msg' };
      }
      return null;
    case 'assistant/message': {
      const text = textOf(d.message && d.message.content);
      if (text) return { verb: 'review', name: text, kind: 'msg' };
      return null;
    }
    case 'tool/call':
      // 调用记录里用的字段是 callId（不是 toolCallId）；映射必须用同一个键，否则结果事件查不到工具名
      dshCallNames.set(String(d.callId || d.toolCallId || d.id || ''), String(d.name || 'tool'));
      if (dshCallNames.size > 800) dshCallNames.clear();
      return { verb: verbFor(d.name), name: toolLabel(d.name, d.arguments), kind: 'tool' };
    // 只有失败才单独产出一条事件：失败的调用要能在任务流和粒子里看出来
    case 'tool/result': {
      if (!(d.message && d.message.isError)) return null;
      const key = String(d.toolCallId || (d.message && d.message.toolCallId) || '');
      const tool = dshCallNames.get(key) || '工具';
      const reason = shortReason(textOf(d.message && d.message.content));
      return { verb: 'check', name: reason ? `${tool} · ${reason}` : `${tool} 失败`, kind: 'tool', ok: false };
    }
    case 'job/settled': return { verb: 'check', name: d.label || d.kind || 'job', kind: 'tool' };
    case 'todo/write': return { verb: 'review', name: '更新任务清单', kind: 'tool' };
    case 'agent/inbox/spliced': return { verb: 'read', name: '接收上游消息', kind: 'tool' };
    default: return null;
  }
}

/* ---------------- 扫描 ---------------- */

export function create({ root, activeMs, live }) {
  const cache = new Map();
  let fileList = [];
  let fileListAt = 0;
  let reachable = false;

  async function refreshFileList() {
    const now = Date.now();
    if (now - fileListAt < 5_000) return;
    fileListAt = now;
    const out = [];
    let wsDirs = [];
    try { wsDirs = await readdir(root, { withFileTypes: true }); reachable = true; } catch { reachable = false; return; }
    for (const ws of wsDirs) {
      if (!ws.isDirectory()) continue;
      const wsPath = join(root, ws.name);
      let sids = [];
      try { sids = await readdir(wsPath, { withFileTypes: true }); } catch { continue; }
      for (const sd of sids) {
        if (!sd.isDirectory()) continue;
        const dir = join(wsPath, sd.name);
        for (const fname of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
          try { await stat(join(dir, fname)); out.push(join(dir, fname)); break; } catch { /* 换下一个 */ }
        }
      }
    }
    fileList = out;
  }

  async function scan(warmup) {
    await refreshFileList();
    const now = Date.now();
    const stale = [];
    for (const file of fileList) {
      let st;
      try { st = await stat(file); } catch { continue; }
      const hit = cache.get(file);
      const wasBusy = !!(hit && hit.session && (hit.session.current || hit.session.openStep != null));
      if (now - st.mtimeMs > activeMs && !wasBusy) { stale.push({ file, st }); continue; }
      await decodeOne(file, st);
    }
    // 启动预热：一个活跃的都没有时，至少把最近 3 个会话读进来，别切过去是空白
    if (warmup && stale.length) {
      stale.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      for (const { file, st } of stale.slice(0, 3)) await decodeOne(file, st);
    }
  }

  async function decodeOne(file, st) {
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return;
    let buf;
    try { buf = await readFile(file); } catch { return; }
    if (!buf.length) return;
    const events = parseSession(buf);
    if (!events.length) return;

    const sid = basename(join(file, '..'));
    const s = foldSession(sid, events, st.mtimeMs);
    s.file = file;

    const prev = hit ? hit.session : null;
    const from = prev ? prev.seenSeq : 0;
    const batch = events.filter(e => (Number(e.seq) || 0) > from);
    const shortName = trunc(s.title, 8);
    if (prev) {
      for (const e of batch) { const it = eventToFeed(e); if (it) live.push(it, sid, shortName); }
    } else {
      for (const it of batch.slice(-80).map(eventToFeed).filter(Boolean).slice(-10)) live.push(it, sid, shortName);
    }
    s.seenSeq = batch.reduce((m, e) => Math.max(m, Number(e.seq) || 0), prev ? prev.seenSeq : 0);

    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, session: s });
  }

  return {
    id: 'dsh',
    name: 'DSH',
    note: zstd ? 'DeepSeek Harness 会话' : '需要 Node ≥ 23.8（zstd 解压）',
    path: root,
    scan,
    sessions: () => [...cache.values()].map(c => c.session),
    available: () => reachable && !!zstd,
    stats: () => {
      const ss = [...cache.values()].map(c => c.session);
      return {
        sessions: cache.size,
        // 近期活跃（按 mtime）和正在运行（有没结束的调用/回合）是两件事
        active: ss.filter(s => Date.now() - s.mtime < activeMs).length,
        running: ss.filter(s => s.current || s.openStep != null).length,
        files: fileList.length,
      };
    },
  };
}
