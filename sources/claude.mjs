/**
 * 数据源：Claude Code
 *
 *   ~/.claude/projects/<工作区 slug>/<sessionId>.jsonl
 *
 * 行式 JSONL，每行是一个记录：
 *   type: user / assistant / attachment / system / custom-title / system ...
 *   assistant.content[] 里有 text / thinking / tool_use
 *   user.content[]      里有 tool_result（要按 tool_use_id 反查配对）
 *
 * 映射：
 *   智能体 = 一个 jsonl（一个 session）
 *   工作流 = 记录里的 cwd（或 attachment.environment.workingDirectory）
 *   任务   = 工具调用
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { trunc, toolLabel, verbFor, textOf, toMs } from '../lib/core.mjs';

/* ---------------- 解析 ---------------- */

function parseLines(buf) {
  const out = [];
  for (const line of buf.toString('utf8').split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* 半行 */ }
  }
  return out;
}

/** tool_result 的 content 可能是字符串，也可能是 [{type,text}]。 */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return textOf(content);
  return '';
}

function snippetOf(name, input) {
  if (!/^(write|edit|multiedit|notebookedit)$/i.test(String(name || ''))) return null;
  if (!input || typeof input !== 'object') return null;
  const code = input.content != null ? String(input.content)
    : input.new_string != null ? String(input.new_string) : '';
  const file = String(input.file_path || input.path || '');
  if (!code.trim()) return null;
  return { file: file || name, code };
}

/* ---------------- 折叠 ---------------- */

function foldSession(id, events, mtime) {
  const s = {
    src: 'claude', id, cwd: '', title: '', depth: 0, parent: '', mtime,
    turns: 0, openStep: null, lastTime: 0,
    todos: [], calls: [], msgs: [], snippets: [], gaps: [], current: null, lastFail: null,
    done: 0, failed: 0, seenSeq: 0,
  };
  const open = new Map();
  let prevT = 0;
  let titleFromUser = '';
  let customTitle = '';
  let turnOpen = false;      // 最近一条记录是不是「这一轮还没结束」

  for (const e of events) {
    const t = toMs(e.timestamp);
    if (t > s.lastTime) s.lastTime = t;
    if (prevT && t > prevT) s.gaps.push(Math.min(600_000, t - prevT));
    if (t) prevT = t;

    if (e.cwd && !s.cwd) s.cwd = String(e.cwd);
    if (e.isSidechain && !s.depth) s.depth = 1;

    if (e.type === 'attachment') {
      const snap = e.attachment && e.attachment.snapshot;
      if (snap && snap.workingDirectory && !s.cwd) s.cwd = String(snap.workingDirectory);
      continue;
    }
    if (e.type === 'custom-title') {
      if (e.customTitle) customTitle = String(e.customTitle);
      continue;
    }
    // 结束类记录：只认明确的结束信号，不能把所有 system 都当成回合结束
    // （system 里还有 init / compact_boundary / api_error 等，中途出现并不代表这一轮结束了）
    if (e.type === 'result' || e.type === 'last-prompt') {
      turnOpen = false;
      continue;
    }
    if (e.type === 'system') {
      const sub = String(e.subtype || '').toLowerCase();
      if (sub === 'stop_hook_summary' || sub === 'turn_complete' || sub === 'end_turn') turnOpen = false;
      continue;
    }
    if (e.type === 'mode') continue;

    // message 可能是字符串，也可能是对象；content 同样可能是字符串或数组
    const rawMsg = e.message;
    const msg = typeof rawMsg === 'string' ? { content: rawMsg } : rawMsg;
    if (!msg) continue;

    if (e.type === 'user') {
      // ① 真实用户输入（字符串 content）
      if (typeof msg.content === 'string') {
        const text = msg.content.trim();
        if (text) { s.msgs.push({ role: 'user', text }); if (!titleFromUser) titleFromUser = text; }
        continue;
      }
      if (!Array.isArray(msg.content)) continue;
      // ② tool_result（配对回 tool_use）
      for (const blk of msg.content) {
        if (!blk || blk.type !== 'tool_result') continue;
        const key = String(blk.tool_use_id || '');
        const c = open.get(key);
        if (!c) continue;
        c.done = true; c.end = t; c.error = !!blk.is_error;
        if (c.error) {
          c.reason = shortReason(textOf(blk.content));   // 例如 "EACCES: permission denied"
          s.failed++;
          s.lastFail = { name: c.name, label: c.label, reason: c.reason, at: c.end || t };
        } else s.done++;
        open.delete(key);
      }
      const text = textOf(msg.content);
      if (text) s.msgs.push({ role: 'user', text });
      continue;
    }

    if (e.type === 'assistant') {
      turnOpen = true;
      // 明确结束的信号：最终回复带 stop_reason = end_turn / stop_sequence / max_tokens
      // （stop_reason = tool_use 表示还要继续调工具，不算结束）
      const stop = String(msg.stop_reason || e.stop_reason || '').toLowerCase();
      const ended = stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens';
      // 纯字符串回复
      if (typeof msg.content === 'string') {
        const text = msg.content.trim();
        if (text) { s.msgs.push({ role: 'assistant', text }); s.turns++; }
        if (ended) turnOpen = false;
        continue;
      }
      if (!Array.isArray(msg.content)) { if (ended) turnOpen = false; continue; }
      for (const blk of msg.content) {
        if (!blk) continue;
        if (blk.type === 'tool_use') {
          const c = {
            callId: String(blk.id || ''),
            name: String(blk.name || 'tool'),
            label: toolLabel(blk.name, blk.input),
            start: t, end: 0, done: false, error: false,
            argBytes: Buffer.byteLength(JSON.stringify(blk.input || {}), 'utf8'),
          };
          s.calls.push(c);
          if (c.callId) open.set(c.callId, c);
          const sn = snippetOf(blk.name, blk.input);
          if (sn) s.snippets.push({ ...sn, at: t });
          if (/^todowrite$/i.test(c.name) && Array.isArray(blk.input && blk.input.todos)) {
            s.todos = blk.input.todos.map(x => ({ content: String(x.content || ''), status: String(x.status || 'pending') }));
          }
        }
      }
      if (msg.content.some(b => b && b.type === 'text')) {
        const text = textOf(msg.content);
        if (text) { s.msgs.push({ role: 'assistant', text }); s.turns++; }   // 纯文字回合也算「有内容」
      }
      if (ended) turnOpen = false;
      continue;
    }
  }

  s.current = [...open.values()].pop() || null;
  // 「推理中」只在「这一轮还开着、并且没有工具在跑」时成立。
  // 结束信号有三种：result / last-prompt 记录、system 的结束子类型、assistant 的 stop_reason。
  s.openStep = (turnOpen && !s.current) ? 1 : null;
  if (!s.title) {
    s.title = customTitle || (titleFromUser ? trunc(titleFromUser, 40) : (s.cwd ? basename(s.cwd) : id.slice(0, 8)));
  }
  if (s.calls.length > 400) s.calls = s.calls.slice(-400);
  if (s.gaps.length > 800) s.gaps = s.gaps.slice(-800);
  if (s.msgs.length > 40) s.msgs = s.msgs.slice(-40);
  if (s.snippets.length > 8) s.snippets = s.snippets.slice(-8);
  return s;
}

/* 失败事件要能说清「哪个工具、什么原因」 */
const claudeCallNames = new Map();
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

function eventsToFeed(e) {
  if (e.type === 'custom-title') return null;
  const raw = e.message;
  const msg = typeof raw === 'string' ? { content: raw } : raw;
  if (!msg) return null;

  if (e.type === 'assistant') {
    if (typeof msg.content === 'string') {
      const text = msg.content.trim();
      return text ? { verb: 'review', name: text, kind: 'msg' } : null;
    }
    if (!Array.isArray(msg.content)) return null;
    const tools = msg.content.filter(b => b && b.type === 'tool_use');
    if (tools.length) {
      for (const b of tools) {
        claudeCallNames.set(String(b.id || ''), String(b.name || '工具'));
        if (claudeCallNames.size > 800) claudeCallNames.clear();
      }
      const b = tools[0];
      return { verb: verbFor(b.name), name: toolLabel(b.name, b.input), kind: 'tool' };
    }
    const text = textOf(msg.content);
    return text ? { verb: 'review', name: text, kind: 'msg' } : null;
  }
  if (e.type === 'user') {
    if (typeof msg.content === 'string') {
      return { verb: 'read', name: msg.content, kind: 'msg' };
    }
    // 只有失败的 tool_result 才单独出一条事件；带上工具名和错误摘要
    if (Array.isArray(msg.content)) {
      const bad = msg.content.find(b => b && b.type === 'tool_result' && b.is_error);
      if (bad) {
        const tool = claudeCallNames.get(String(bad.tool_use_id || '')) || '工具';
        const reason = shortReason(textOf(bad.content));
        return { verb: 'check', name: reason ? `${tool} · ${reason}` : `${tool} 失败`, kind: 'tool', ok: false };
      }
    }
    return null;   // 成功的 tool_result 不进任务流（工具调用本身已经记过了）
  }
  return null;
}

/* ---------------- 扫描 ---------------- */

export function create({ root, activeMs, live }) {
  const cache = new Map();     // file -> {mtimeMs, size, session}
  let fileList = [];
  let listAt = 0;
  let reachable = false;

  async function refreshFileList() {
    const now = Date.now();
    if (now - listAt < 5_000) return;
    listAt = now;
    const out = [];
    let projects = [];
    try { projects = await readdir(root, { withFileTypes: true }); reachable = true; } catch { reachable = false; return; }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const dir = join(root, p.name);
      let entries = [];
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) out.push(join(dir, e.name));
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
    const events = parseLines(buf);
    if (!events.length) return;

    const sid = basename(file).replace(/\.jsonl$/, '');
    const s = foldSession(sid, events, st.mtimeMs);
    s.file = file;

    const prev = hit ? hit.session : null;
    const from = prev ? prev.seenSeq : Math.max(0, events.length - 40);
    const shortName = trunc(s.title, 8);
    if (prev) {
      for (let i = from; i < events.length; i++) {
        const it = eventsToFeed(events[i]);
        if (it) live.push(it, sid, shortName);
      }
    } else {
      for (const it of events.slice(-60).map(eventsToFeed).filter(Boolean).slice(-10)) live.push(it, sid, shortName);
    }
    s.seenSeq = events.length;

    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, session: s });
  }

  return {
    id: 'claude',
    name: 'Claude Code',
    note: 'Anthropic Claude Code 会话',
    path: root,
    scan,
    sessions: () => [...cache.values()].map(c => c.session),
    available: () => reachable,
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
