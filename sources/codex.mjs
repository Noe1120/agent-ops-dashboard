/**
 * 数据源：Codex（OpenAI Codex CLI / Desktop）
 *
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *   ~/.codex/archived_sessions/rollout-*.jsonl
 *
 * 行式 JSONL，每行 { timestamp, ordinal, type, payload }。
 * 同一个 session_id 可能对应多个 rollout 文件（续聊/恢复），这里把它们合并成一条会话。
 *
 * 映射：
 *   智能体 = 一个 session_id（有 parent_thread_id 的算子智能体）
 *   工作流 = session_meta.cwd
 *   任务   = 工具调用（function_call / custom_tool_call）
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { trunc, toolLabel, verbFor, textOf, toMs } from '../lib/core.mjs';

/* ---------------- 解析 ---------------- */

async function walkJsonl(dir, out) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkJsonl(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
}

/* 失败事件要能说清「哪个工具、什么原因」 */
const codexCallNames = new Map();
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

function parseLines(buf) {
  const out = [];
  for (const line of buf.toString('utf8').split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try {
      const v = JSON.parse(l);
      // 能 JSON.parse 不等于结构有效：null / 数字 / 字符串 / 数组都要挡掉，
      // 否则一条坏行会让后面的折叠抛错，整个源都刷不动
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v);
    } catch { /* 半行 */ }
  }
  return out;
}

/** 输出算不算失败。优先看 exit_code，其次看 Codex 原生的 "Process exited with code N"。 */
function outIsError(txt) {
  const s = String(txt || '');
  const m = /"exit_code":\s*(-?\d+)/.exec(s);
  if (m) return Number(m[1]) !== 0;
  const m2 = /(?:process\s+)?exit(?:ed)?\s*(?:with\s*)?code[:\s]\s*(-?\d+)/i.exec(s);
  if (m2) return Number(m2[1]) !== 0;
  if (/^\s*(failed|error)\b/i.test(s)) return true;
  if (/\b(failed to|error:|exception|traceback)\b/i.test(s.slice(0, 300))) return true;
  return false;
}

/** 从 apply_patch / write 类入参里抠出「文件 + 代码」。 */
function snippetOf(name, raw) {
  if (!/patch|write|edit|create/i.test(String(name || ''))) return null;
  let body = typeof raw === 'string' ? raw : JSON.stringify(raw || '');
  if (!body || body.length < 20) return null;

  // apply_patch：*** Begin Patch / *** Update File: path / *** Add File: path
  const fm = /\*\*\* (?:Add|Update) File:\s*(.+)/.exec(body);
  if (fm) return { file: fm[1].trim(), code: body.slice(0, 8000) };

  // 普通 write：JSON 里带 file_path + content
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const code = a && (a.content != null ? String(a.content) : a.new_string != null ? String(a.new_string) : '');
    const file = a && (a.file_path || a.path || '');
    if (code && code.trim()) return { file: String(file || name), code: String(code) };
  } catch { /* 不是 JSON */ }
  return null;
}

/** Codex 的 user 消息常被 <environment_context> 之类包一层，剥掉再判断是不是人说的。 */
function isRealUserText(t) {
  const s = String(t || '').trim();
  if (!s) return false;
  if (/^<environment_context>[\s\S]*<\/environment_context>$/i.test(s)) return false;
  if (/^<user_instructions>/i.test(s)) return false;
  if (/^<[a-z_]+>[\s\S]*<\/[a-z_]+>$/i.test(s) && s.length < 2000) return false;
  return true;
}

/* ---------------- 折叠 ---------------- */

function foldSession(sid, events, mtime) {
  const s = {
    src: 'codex', id: sid, cwd: '', title: '', depth: 0, parent: '', mtime,
    turns: 0, openStep: null, lastTime: 0,
    todos: [], calls: [], msgs: [], snippets: [], gaps: [], current: null, lastFail: null,
    done: 0, failed: 0, seenSeq: 0,
  };
  const open = new Map();
  let prevT = 0;
  let titleFromUser = '';

  for (const e of events) {
    const p = e.payload || {};
    const t = toMs(e.timestamp);
    if (t > s.lastTime) s.lastTime = t;
    if (prevT && t > prevT) s.gaps.push(Math.min(600_000, t - prevT));
    if (t) prevT = t;

    if (e.type === 'session_meta') {
      if (p.cwd) s.cwd = String(p.cwd);
      if (p.parent_thread_id) { s.parent = String(p.parent_thread_id); s.depth = 1; }
      continue;
    }

    if (e.type === 'event_msg') {
      if (p.type === 'task_started') { s.turns++; s.openStep = s.turns; }
      else if (p.type === 'task_complete' || p.type === 'turn_aborted') s.openStep = null;
      continue;
    }

    if (e.type !== 'response_item') continue;

    switch (p.type) {
      case 'message': {
        const text = textOf(p.content);
        if (!text) break;
        if (p.role === 'user') {
          if (isRealUserText(text)) {
            s.msgs.push({ role: 'user', text });
            if (!titleFromUser) titleFromUser = text;
          }
        } else if (p.role === 'assistant') {
          s.msgs.push({ role: 'assistant', text });
        }
        break;
      }
      case 'agent_message': {
        const text = textOf(p.message) || textOf(p.content) || String(p.text || '');
        if (text) s.msgs.push({ role: 'assistant', text });
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        const raw = p.arguments != null ? p.arguments : p.input;
        const c = {
          callId: String(p.call_id || ''),
          name: String(p.name || 'tool'),
          label: toolLabel(p.name, raw),
          start: t, end: 0, done: false, error: false,
          argBytes: Buffer.byteLength(typeof raw === 'string' ? raw : JSON.stringify(raw || ''), 'utf8'),
        };
        s.calls.push(c);
        if (c.callId) open.set(c.callId, c);
        const sn = snippetOf(p.name, raw);
        if (sn) s.snippets.push({ ...sn, at: t });
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const txt = typeof p.output === 'string' ? p.output : textOf(p.output);
        const c = open.get(String(p.call_id || ''));
        if (c) {
          c.done = true; c.end = t; c.error = outIsError(txt);
          if (c.error) {
            c.reason = shortReason(txt);   // 例如 "Process exited with code 7"
            s.failed++;
            s.lastFail = { name: c.name, label: c.label, reason: c.reason, at: c.end || t };
          } else s.done++;
          open.delete(String(p.call_id || ''));
        }
        break;
      }
      default: break;
    }
  }

  s.current = [...open.values()].pop() || null;
  if (!s.title) {
    s.title = titleFromUser
      ? trunc(titleFromUser, 40)
      : (s.cwd ? basename(s.cwd) : sid.slice(0, 8));
  }
  if (s.calls.length > 400) s.calls = s.calls.slice(-400);
  if (s.gaps.length > 800) s.gaps = s.gaps.slice(-800);
  if (s.msgs.length > 40) s.msgs = s.msgs.slice(-40);
  if (s.snippets.length > 8) s.snippets = s.snippets.slice(-8);
  return s;
}

function eventsToFeed(e) {
  const p = e.payload || {};
  if (e.type === 'response_item') {
    if (p.type === 'message') {
      const text = textOf(p.content);
      if (!text) return null;
      if (p.role === 'user') return isRealUserText(text) ? { verb: 'read', name: text, kind: 'msg' } : null;
      if (p.role === 'assistant') return { verb: 'review', name: text, kind: 'msg' };
      return null;
    }
    if (p.type === 'agent_message') {
      const text = textOf(p.message) || textOf(p.content) || String(p.text || '');
      return text ? { verb: 'review', name: text, kind: 'msg' } : null;
    }
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      codexCallNames.set(String(p.call_id || ''), String(p.name || '命令'));
      if (codexCallNames.size > 800) codexCallNames.clear();
      return { verb: verbFor(p.name), name: toolLabel(p.name, p.arguments != null ? p.arguments : p.input), kind: 'tool' };
    }
    // 只有失败的命令输出才单独出一条事件
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const txt = typeof p.output === 'string' ? p.output : textOf(p.output);
      if (!outIsError(txt)) return null;
      const tool = codexCallNames.get(String(p.call_id || '')) || '命令';
      const reason = shortReason(txt);
      return { verb: 'check', name: reason ? `${tool} · ${reason}` : `${tool} 失败`, kind: 'tool', ok: false };
    }
  }
  if (e.type === 'event_msg' && p.type === 'task_started') return { verb: 'read', name: '开始新一轮', kind: 'tool' };
  return null;
}

/* ---------------- 扫描 ---------------- */

export function create({ roots, activeMs, live }) {
  /** sessionId -> { files:[], mtime, size, session } */
  const groups = new Map();
  /** file -> sessionId（避免每轮都重读首行） */
  const fileOwner = new Map();
  let listed = false;
  let listAt = 0;
  let reachable = false;

  async function readOwner(file) {
    if (fileOwner.has(file)) return fileOwner.get(file);
    let buf;
    try { buf = await readFile(file); } catch { return null; }
    const first = buf.toString('utf8').split('\n').find(Boolean);
    let sid = basename(file).replace(/\.jsonl$/, '');
    try {
      const o = JSON.parse(first);
      if (o && o.payload && (o.payload.session_id || o.payload.id)) {
        sid = String(o.payload.session_id || o.payload.id);
      }
    } catch { /* 用文件名 */ }
    fileOwner.set(file, sid);
    return sid;
  }

  async function refreshGroups() {
    const now = Date.now();
    if (now - listAt < 5_000) return;
    listAt = now;
    const files = [];
    for (const r of roots) await walkJsonl(r, files);
    reachable = files.length > 0;
    const bySession = new Map();
    for (const f of files) {
      const sid = await readOwner(f);
      if (!sid) continue;
      if (!bySession.has(sid)) bySession.set(sid, []);
      bySession.get(sid).push(f);
    }
    const rebuilt = new Map();
    for (const [sid, fs] of bySession) {
      const old = groups.get(sid);
      // 文件列表没变就沿用上一轮的解析结果，避免每 5 秒重算
      rebuilt.set(sid, old && old.files.join('|') === fs.join('|')
        ? { ...old, files: fs }
        : { files: fs, mtime: 0, size: 0, session: null });
    }
    groups.clear();
    for (const [k, v] of rebuilt) groups.set(k, v);
    listed = true;
  }

  async function scan(warmup) {
    await refreshGroups();
    const now = Date.now();
    const stale = [];
    for (const [sid, g] of groups) {
      let mtime = 0, size = 0, ok = true;
      for (const f of g.files) {
        try { const st = await stat(f); if (st.mtimeMs > mtime) mtime = st.mtimeMs; size += st.size; }
        catch { ok = false; }
      }
      if (!ok || !mtime) continue;
      const prev = g.session;
      const wasBusy = !!(prev && (prev.current || prev.openStep != null));
      g.mtime = mtime; g.size = size;
      if (now - mtime > activeMs && !wasBusy) { stale.push({ sid, g, mtime, size }); continue; }
      // 单个会话出问题不影响同轮其它会话
      try { await decodeGroup(sid, g, mtime, size); } catch { /* 下一轮再说 */ }
    }
    // 启动预热：源里没有活跃会话时，至少读最近 3 个，别切过去是空白
    if (warmup && stale.length) {
      stale.sort((a, b) => b.mtime - a.mtime);
      for (const { sid, g, mtime, size } of stale.slice(0, 3)) {
        try { await decodeGroup(sid, g, mtime, size); } catch { /* 预热失败不影响主流程 */ }
      }
    }
  }

  async function decodeGroup(sid, g, mtime, size) {
    const prev = g.session;
    if (prev && g._mtime === mtime && g._size === size) return;

    const events = [];
    for (const f of g.files) {
      try { events.push(...parseLines(await readFile(f))); } catch { /* 跳过坏文件 */ }
    }
    if (!events.length) return;
    events.sort((a, b) => (toMs(a.timestamp) - toMs(b.timestamp)) || ((a.ordinal || 0) - (b.ordinal || 0)));

    let s;
    try {
      s = foldSession(sid, events, mtime);
    } catch {
      // 单条脏数据不能阻断整个源：记下这版已处理过，下一轮别反复卡在同一份坏内容上
      g._mtime = mtime; g._size = size;
      return;
    }
    const prevSeen = prev ? prev.seenSeq : 0;
    const shortName = trunc(s.title, 8);
    if (prev) {
      for (let i = prevSeen; i < events.length; i++) {
        const it = eventsToFeed(events[i]);
        if (it) live.push(it, sid, shortName);
      }
    } else {
      for (const it of events.slice(-80).map(eventsToFeed).filter(Boolean).slice(-10)) live.push(it, sid, shortName);
    }
    s.seenSeq = events.length;

    g.session = s; g._mtime = mtime; g._size = size;
    g.mtime = mtime; g.size = size;
  }

  return {
    id: 'codex',
    name: 'Codex',
    note: 'OpenAI Codex 会话',
    path: roots.join('  +  '),
    scan,
    sessions: () => [...groups.values()].map(g => g.session).filter(Boolean),
    available: () => reachable,
    stats: () => {
      const ss = [...groups.values()].map(g => g.session).filter(Boolean);
      return {
        sessions: ss.length,
        // 近期活跃（按 mtime）和正在运行（有没结束的调用/回合）是两件事
        active: ss.filter(s => Date.now() - s.mtime < activeMs).length,
        running: ss.filter(s => s.current || s.openStep != null).length,
        files: [...groups.values()].reduce((n, g) => n + g.files.length, 0),
      };
    },
  };
}
