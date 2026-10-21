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
import { join, basename, sep } from 'node:path';
import { trunc, toolLabel, verbFor, textOf, toMs } from '../lib/core.mjs';

/* ---------------- 解析 ---------------- */

/** 递归收集 .jsonl；无法读取的目录记进 bad。
 *  ENOENT = 确认不存在（可由调用方按删除清理）；EACCES/EPERM/IO = 无法确认（保留缓存并标 stale）。
 *  以前这里直接写 listStale（create() 作用域内），错误路径会抛 ReferenceError。 */
async function walkJsonl(dir, out, bad = [], rd = readdir) {
  let entries;
  try { entries = await rd(dir, { withFileTypes: true }); }
  catch (e) {
    if (e && e.code !== 'ENOENT') bad.push(dir);
    return bad;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkJsonl(p, out, bad, rd);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return bad;
}

/* 失败事件要能说清「哪个工具、什么原因」 */
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

/** 有界序列化：深嵌套/循环引用时 JSON.stringify 会抛错，签名与日志用它兜底，
 *  保证单条记录的序列化失败不会拖垮整轮扫描（复核 v2.42 #2）。 */
function boundedStringify(v, maxDepth = 40) {
  let budget = 200000;
  const seen = new Set();
  const walk = (x, depth) => {
    if (budget-- <= 0) return '"…"';
    if (x === null) return 'null';
    if (typeof x === 'string') return JSON.stringify(x.length > 500 ? x.slice(0, 500) : x);
    if (typeof x === 'number' || typeof x === 'boolean') return String(x);
    if (typeof x === 'bigint') return JSON.stringify(String(x));
    if (typeof x === 'undefined' || typeof x === 'function' || typeof x === 'symbol') return 'null';
    if (depth >= maxDepth) return '"<deep>"';
    if (typeof x === 'object') {
      if (seen.has(x)) return '"<cycle>"';
      seen.add(x);
      let out;
      if (Array.isArray(x)) out = '[' + x.slice(0, 200).map(y => walk(y, depth + 1)).join(',') + ']';
      else {
        const ks = Object.keys(x).slice(0, 100);
        out = '{' + ks.map(k => JSON.stringify(k) + ':' + walk(x[k], depth + 1)).join(',') + '}';
      }
      seen.delete(x);
      return out;
    }
    return 'null';
  };
  try { return walk(v, 0); } catch { return '"[deep]"'; }
}

function safeStringify(v) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try { return JSON.stringify(v); } catch { return boundedStringify(v); }
}

/** 解码 JSONL，并区分三类结果：
 *  - records：可用的普通对象记录；
 *  - bad：文件内部「完整一行但解析失败/结构非法」的行号（1 起）；
 *  - 末尾没有换行、看起来还在写入的半行（以 { 开头）直接忽略，不算故障。
 *  以前只返回成功记录，无法知道内部坏行，也无法把「半行」与「坏行」分开（复核 v2.42 #2）。 */
function parseLines(buf) {
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  const records = [];
  const bad = [];
  const endsWithNl = text.endsWith('\n');
  const lastIdx = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const isTail = i === lastIdx && !endsWithNl;
    try {
      const v = JSON.parse(l);
      // 能 JSON.parse 不等于结构有效：null / 数字 / 字符串 / 数组都要挡掉
      if (v && typeof v === 'object' && !Array.isArray(v)) { records.push(v); continue; }
    } catch { /* 交给下面的半行/坏行判断 */ }
    // 末尾半行只在「像一条正在写入的 JSON 对象」时忽略；整行的垃圾内容仍算坏行
    if (isTail && /^\{/.test(l)) continue;
    bad.push(i + 1);
  }
  return { records, bad };
}

/** 已知 item 类型的字段结构校验：只拦“类型明显不对”的字段，最小化误报。
 *  与解析失败区分开：解析失败不可用；字段非法仍继续折叠，只记录诊断（复核 v2.42 #2）。 */
function validateItemFields(kind, d) {
  const issues = [];
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const wantStr = f => { const v = d[f]; if (v != null && typeof v !== 'string') issues.push(f + ' 应为字符串'); };
  const wantObj = f => { const v = d[f]; if (v != null && !isObj(v)) issues.push(f + ' 应为对象'); };
  const wantArr = f => { const v = d[f]; if (v != null && !Array.isArray(v)) issues.push(f + ' 应为数组'); };
  /* id 是 SQLite item 的稳定键：对象/数组不能靠 String() 变成可疑身份（复核 v2.43 #3） */
  if (d.id != null && typeof d.id !== 'string' && !(typeof d.id === 'number' && Number.isFinite(d.id))) {
    issues.push('id 应为字符串或数字');
  }
  switch (kind) {
    case 'userMessage':
      if (d.content != null && !Array.isArray(d.content) && typeof d.content !== 'string') issues.push('content 应为数组或字符串');
      break;
    case 'agentMessage': wantStr('text'); break;
    case 'commandExecution':
      wantStr('command'); wantStr('status'); wantStr('aggregatedOutput');
      if (d.exitCode != null && typeof d.exitCode !== 'number') issues.push('exitCode 应为数字');
      if (d.durationMs != null && typeof d.durationMs !== 'number') issues.push('durationMs 应为数字');
      break;
    case 'fileChange':
      wantArr('changes'); wantStr('status'); wantArr('errors');
      if (Array.isArray(d.changes) && d.changes.some(c => !isObj(c))) issues.push('changes 元素应为对象');
      break;
    case 'mcpToolCall':
      wantStr('server'); wantStr('tool'); wantStr('status'); wantObj('arguments'); wantArr('errors');
      break;
    case 'webSearch': wantStr('query'); wantStr('status'); break;
    case 'collabAgentToolCall':
      wantStr('tool'); wantStr('status'); wantObj('agentsStates'); wantArr('errors');
      break;
    case 'subAgentActivity':
      wantStr('kind'); wantStr('agentPath'); wantStr('status'); wantArr('errors');
      break;
    default: break;
  }
  return issues;
}

/** JSONL 记录的字段结构校验（同样只做“类型明显不对”的判断）。 */
function validateEventFields(e) {
  const issues = [];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return ['记录不是对象'];
  if (e.type != null && typeof e.type !== 'string') issues.push('type 应为字符串');
  const p = e.payload;
  if (p == null) return issues;
  if (typeof p !== 'object' || Array.isArray(p)) { issues.push('payload 应为对象'); return issues; }
  if (p.type != null && typeof p.type !== 'string') issues.push('payload.type 应为字符串');
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  if (e.type === 'response_item') {
    if (p.type === 'message') {
      if (p.role != null && typeof p.role !== 'string') issues.push('message.role 应为字符串');
      if (p.content != null && !Array.isArray(p.content) && typeof p.content !== 'string') issues.push('message.content 应为数组或字符串');
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      if (p.name != null && typeof p.name !== 'string') issues.push('工具 name 应为字符串');
      if (p.call_id != null && typeof p.call_id !== 'string') issues.push('call_id 应为字符串');
      const raw = p.arguments != null ? p.arguments : p.input;
      if (raw != null && typeof raw !== 'string' && !isObj(raw)) issues.push('工具入参应为字符串或对象');
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      if (p.call_id != null && typeof p.call_id !== 'string') issues.push('call_id 应为字符串');
      if (p.output != null && typeof p.output !== 'string' && typeof p.output !== 'object') issues.push('output 应为字符串或对象');
    }
  }
  return issues;
}

/** 字段类型的安全读取：ID/name 等只接受固定基本类型，绝不把未知对象交给 String()。
 *  `{[Symbol.toPrimitive]}`/`{toString:null}` 这类合法 JSON 会让强制转换抛 TypeError，
 *  以前会在生成身份/签名的阶段抛穿整轮扫描（复核 v2.43 #3）。 */
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const strField = v => (typeof v === 'string' ? v : '');
/** 文本/显示字段：字符串或有限数字才转字符串，其它类型按空值处理（不调用未知对象的 String）。 */
const scalarText = v => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return '';
};
const idField = v => scalarText(v);   // ID 接受 string / 有限 number，其余一律空
function textSafe(v) { try { return textOf(v); } catch { return ''; } }
function describeType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** 身份/结构关键字段的类型校验：fatal 返回原因，这条记录必须明确诊断并降级（跳过），
 *  不能带着未知对象进入 eventIdentity/eventSig/折叠/索引。空值（null/缺失）按缺失处理。 */
function fatalRecordIssue(e) {
  if (!isPlainObject(e)) return '记录不是对象';
  if (e.type != null && typeof e.type !== 'string') return 'type 应为字符串（实际 ' + describeType(e.type) + '）';
  const pl = e.payload;
  if (pl == null) return '';
  if (!isPlainObject(pl)) return 'payload 应为对象（实际 ' + describeType(pl) + '）';
  if (pl.type != null && typeof pl.type !== 'string') return 'payload.type 应为字符串（实际 ' + describeType(pl.type) + '）';
  if (e.type === 'response_item' && (pl.type === 'function_call' || pl.type === 'custom_tool_call'
    || pl.type === 'function_call_output' || pl.type === 'custom_tool_call_output')) {
    if (pl.call_id != null && typeof pl.call_id !== 'string') return 'call_id 应为字符串（实际 ' + describeType(pl.call_id) + '）';
  }
  return '';
}

/** 只影响展示的非法字段做安全降级：工具名不是字符串时换成 'tool'，
 *  既不丢这条记录，也不把非法对象强转成同一个可疑名称。 */
function sanitizeRecord(e) {
  const pl = e.payload;
  if (!isPlainObject(pl)) return e;
  const isCall = e.type === 'response_item' && (pl.type === 'function_call' || pl.type === 'custom_tool_call');
  if (!isCall || pl.name == null || typeof pl.name === 'string') return e;
  return Object.assign({}, e, {payload: Object.assign({}, pl, {name: 'tool'})});
}

/** 记录的稳定身份：有稳定 ID 的用「记录类型 + 载荷类型 + ID」识别（时间戳只用于排序/版本判断，
 *  否则同一调用的两份副本时间戳不同就不进同一个冲突桶）；没有 ID 的对话消息用「时间 + 角色 + 内容」，
 *  不同时间戳的同文消息仍是不同记录。身份计算只读安全类型，不抛错（复核 v2.43 #3）。 */
function eventIdentity(e) {
  const pl = isPlainObject(e && e.payload) ? e.payload : {};
  const rawId = pl.call_id != null ? pl.call_id
    : (pl.id != null ? pl.id : (isPlainObject(pl.message) ? pl.message.id : null));
  const id = idField(rawId);
  const at = [strField(e && e.type), strField(pl.type)];
  if (id) return at.concat('id:' + id).join('|');
  const msgText = textSafe(pl.message) || textSafe(pl.content) || strField(pl.text);
  const ts = typeof e.timestamp === 'string' ? e.timestamp
    : (typeof e.timestamp === 'number' && Number.isFinite(e.timestamp) ? String(e.timestamp) : '');
  return [ts].concat(at, 'msg:' + strField(pl.role) + ':' + msgText).join('|');
}

/** 记录里真正影响展示/统计的内容签名（工具名、角色、消息文本、工具输出、入参）。 */
function eventSig(e) {
  const pl = isPlainObject(e && e.payload) ? e.payload : {};
  const msgText = textSafe(pl.message) || textSafe(pl.content) || strField(pl.text);
  const outText = typeof pl.output === 'string' ? pl.output : textSafe(pl.output);
  const argText = typeof pl.arguments === 'string' ? pl.arguments
    : (pl.arguments != null ? safeStringify(pl.arguments) : strField(pl.input));
  return [strField(pl.name), strField(pl.role), msgText, outText, argText].join('|');
}

/** 冲突副本的权威版本：优先「来源文件 mtime 更新」，其次文件顺序/行序更靠后。
 *  只用于同一稳定身份的多份版本选择；完全相同内容的多份副本选谁结果都一样。 */
function pickAuthoritative(prev, cur) {
  if (!prev) return cur;
  const a = prev.__src || { t: 0, i: 0 }, b = cur.__src || { t: 0, i: 0 };
  if (a.t !== b.t) return b.t > a.t ? cur : prev;
  if (a.i !== b.i) return b.i > a.i ? cur : prev;
  return (cur.__ord || 0) > (prev.__ord || 0) ? cur : prev;
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
  let body = typeof raw === 'string' ? raw : safeStringify(raw || '');
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

function foldSession(sid, events, mtime, diag) {
  const s = {
    src: 'codex', id: sid, cwd: '', title: '', depth: 0, parent: '', mtime,
    turns: 0, openStep: null, lastTime: 0,
    todos: [], calls: [], msgs: [], snippets: [], gaps: [], current: null, lastFail: null,
    done: 0, failed: 0, seenSeq: 0,
  };
  const open = new Map();
  let prevT = 0;
  let titleFromUser = '';
  /* 回合终态统一收尾：未闭合调用标记作废（不计成功/失败），清空 open 与 step。
     迟到的 function_call_output 找不到调用，不会把作废翻成成功（复核 v2.36 #6）。 */
  function closeOpen(at) {
    let n = 0;
    for (const c of open.values()) { c.done = true; c.end = c.end || at; c.aborted = true; n++; }
    open.clear();
    s.openStep = null;
    if (n) s.aborted = (s.aborted || 0) + n;
  }

  for (const e of events) {
    try {
    /* 字段类型校验已前移到 decodeGroup 的逐条归一化边界：这里只折叠已归一化的记录。 */
    const p = isPlainObject(e.payload) ? e.payload : {};
    const t = toMs(e.timestamp);
    if (t > s.lastTime) s.lastTime = t;
    if (prevT && t > prevT) s.gaps.push(Math.min(600_000, t - prevT));
    if (t) prevT = t;

    if (e.type === 'session_meta') {
      if (typeof p.cwd === 'string' && p.cwd) s.cwd = p.cwd;
      if (typeof p.parent_thread_id === 'string' && p.parent_thread_id) {
        s.parent = p.parent_thread_id; s.depth = 1;
      }
      continue;
    }

    if (e.type === 'event_msg') {
      if (p.type === 'task_started') { s.turns++; s.openStep = s.turns; }
      else if (p.type === 'task_complete') { s.openStep = null; closeOpen(t); }
      else if (p.type === 'turn_aborted') { s.openStep = null; closeOpen(t); }
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
        const text = textSafe(p.message) || textSafe(p.content) || strField(p.text);
        if (text) s.msgs.push({ role: 'assistant', text });
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        const raw = p.arguments != null ? p.arguments : p.input;
        const name = strField(p.name) || 'tool';
        const c = {
          callId: strField(p.call_id),
          name,
          label: toolLabel(name, raw),
          start: t, end: 0, done: false, error: false,
          argBytes: Buffer.byteLength(typeof raw === 'string' ? raw : JSON.stringify(raw || ''), 'utf8'),
        };
        s.calls.push(c);
        if (c.callId) open.set(c.callId, c);
        const sn = snippetOf(name, raw);
        // 片段先挂在调用上，等调用**成功**结束才进 s.snippets（失败的写文件不能算"写进去了"）
        if (sn) c.snippet = { ...sn, at: t };
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const txt = typeof p.output === 'string' ? p.output : textSafe(p.output);
        const c = open.get(strField(p.call_id));
        if (c) {
          c.done = true; c.end = t; c.error = outIsError(txt);
          if (c.error) {
            c.reason = shortReason(txt);   // 例如 "Process exited with code 7"
            s.failed++;
            s.lastFail = { name: c.name, label: c.label, reason: c.reason, at: c.end || t };
          } else { s.done++; if (c.snippet) s.snippets.push(c.snippet); }
          open.delete(strField(p.call_id));
        }
        break;
      }
      default: break;
    }
    } catch (err) {
      /* 单条记录折叠失败在记录边界隔离：同文件后面的记录（含合法终态）继续处理，并标脏重试。
         以前整体 catch 会保留旧快照却把版本登记为已处理，stale 永远是 false（复核 v2.42 #2）。 */
      if (diag) {
        diag.hard++;
        if (diag.reasons.length < 6) diag.reasons.push('记录折叠异常：' + String((err && err.message) || err).slice(0, 80));
      }
    }
  }

  s.current = [...open.values()].pop() || null;
  if (!s.title) {
    s.title = titleFromUser
      ? trunc(titleFromUser, 40)
      : (s.cwd ? basename(s.cwd) : sid.slice(0, 8));
  }
  /* 裁剪历史调用时保护未结束/当前调用（复核 v2.43 #10）：只截断已完成历史，
     不能让仍在运行的调用被尾部 400 条挤掉，否则会「显示忙但没有当前任务」。 */
  if (s.calls.length > 400) {
    const keep = s.calls.filter(c => !c.done || c === s.current);
    const keepSet = new Set(keep);
    const room = Math.max(0, 400 - keep.length);
    const finished = s.calls.filter(c => !keepSet.has(c));
    const chosen = new Set([...keep, ...finished.slice(-room)]);
    s.calls = s.calls.filter(c => chosen.has(c));
  }
  if (s.gaps.length > 800) s.gaps = s.gaps.slice(-800);
  if (s.msgs.length > 40) s.msgs = s.msgs.slice(-40);
  if (s.snippets.length > 8) s.snippets = s.snippets.slice(-8);
  return s;
}

function eventsToFeed(e, names) {
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
      /* 名称索引由 indexCallNames 从权威调用记录维护；这里不再按“是否要发事件”顺手写全局表 */
      return { verb: verbFor(p.name), name: toolLabel(p.name, p.arguments != null ? p.arguments : p.input), kind: 'tool' };
    }
    // 只有失败的命令输出才单独出一条事件
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const txt = typeof p.output === 'string' ? p.output : textOf(p.output);
      if (!outIsError(txt)) return null;
      const tool = (names && names.get(String(p.call_id || ''))) || '命令';
      const reason = shortReason(txt);
      return { verb: 'check', name: reason ? `${tool} · ${reason}` : `${tool} 失败`, kind: 'tool', ok: false };
    }
  }
  if (e.type === 'event_msg' && p.type === 'task_started') return { verb: 'read', name: '开始新一轮', kind: 'tool' };
  return null;
}

/* ---------------- 扫描 ---------------- */

export function create({ roots, activeMs, live, sqlitePaths = {}, sqlite = true, io = {}, listIntervalMs = 5000, sqliteFault = null }) {
  /** 测试注入用：默认就是真实实现；用来确定性模拟目录/file 的 EACCES */
  const ioRd = typeof io.readdir === 'function' ? io.readdir : readdir;
  const ioRead = typeof io.readFile === 'function' ? io.readFile : readFile;
  const ioStat = typeof io.stat === 'function' ? io.stat : stat;
  /* 测试注入用：模拟 Node 不提供 node:sqlite（默认走真实动态导入） */
  const ioSqlite = typeof io.sqlite === 'function' ? io.sqlite : null;
  /** sessionId -> { files:[], mtime, size, session } */
  const groups = new Map();
  /* file -> {sid, mtimeMs, size}：只缓存「已确认」的 session_meta 身份。
     空文件/半行/没写 meta 的文件保持待识别，下一轮重试；用文件名当身份会造成双份会话（复核 v2.37 #2）。 */
  const fileOwner = new Map();
  /* 本轮身份补全/替换 [{file, oldSid, newSid}]：用于把旧 ID 已发出事件的去重身份迁到新 ID */
  let reassigned = [];
  /* 本轮暂时读不到/stat 不到的 rollout 文件：保留缓存快照并标 stale，恢复后重试 */
  const badFiles = new Set();
  /* 读取成功但整文件解析不出有效记录：保留最后有效快照并标 stale（复核 v2.41 #5） */
  const badParses = new Set();
  /* 每文件解析诊断：坏行数与行号（区分整文件损坏 / 内部坏行）；成功读取不会清除未恢复的故障 */
  const parseDiag = new Map();
  /* 会话级记录诊断：字段非法（soft）与折叠异常（hard）；hard 时不登记本版签名，下一轮重试 */
  const recordDiag = new Map();
  const retryGroups = new Set();
  /* 工具名索引按会话隔离：sid -> Map(call_id -> 名称)。
     模块级裸 Map 会被跨会话同 call_id 污染，超阈值整表 clear 还会清掉正在等待结果的关联（复核 v2.42 #8）。 */
  const callNames = new Map();

  function noteParseFile(file, wholeFile, bad) {
    if (!bad || !bad.length) return;
    parseDiag.set(file, {
      file, wholeFile: !!wholeFile, badLines: bad.length,
      positions: bad.slice(0, 20), at: Date.now(),
    });
  }

  let listed = false;
  let listAt = 0;
  let reachable = false;
  let listStale = false;   // 目录暂时读不到时缓存可能是旧的

  async function readOwner(file) {
    const prev = fileOwner.get(file);
    /* 已知解析/读取故障的恢复验证不能被身份缓存短路：坏行清理后 size/mtime 可能不变，
       必须真的重读内容才能确认恢复（复核 v2.43 #4）。 */
    const verify = badParses.has(file) || badFiles.has(file) || parseDiag.has(file);
    let st;
    try { st = await ioStat(file); }
    catch { badFiles.add(file); return prev ? prev.sid : null; }   // 无法确认：保留旧身份，下次重试
    if (!verify && prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return prev.sid;   // 文件没变，命中缓存
    let buf;
    try { buf = await ioRead(file); badFiles.delete(file); }   // 读取成功即恢复 I/O 健康，即使身份还没写全
    catch { badFiles.add(file); return prev ? prev.sid : null; }
    const first = buf.toString('utf8').split('\n').find(Boolean) || '';
    let sid = '';
    try {
      const o = JSON.parse(first);
      if (o && o.payload && (o.payload.session_id || o.payload.id)) {
        const raw = o.payload.session_id || o.payload.id;
        if (typeof raw === 'string' || (typeof raw === 'number' && Number.isFinite(raw))) sid = String(raw);
      }
    } catch { /* 半行/空文件：待识别 */ }
    if (!sid) {
      /* 身份还没写成（或整份都是坏行）也要计入解析健康：以前这类文件既不建会话、也不标 stale (#2) */
      if (buf.length > 0) {
        const parsed = parseLines(buf);
        if (!parsed.records.length && parsed.bad.length) {
          badParses.add(file);
          noteParseFile(file, true, parsed.bad);
        } else {
          badParses.delete(file); parseDiag.delete(file);
        }
      }
      return prev ? prev.sid : null;   // 身份未确认：不制造「文件名会话」，下次写入后再认
    }
    if (prev && prev.sid !== sid) reassigned.push([file, prev.sid, sid]);
    fileOwner.set(file, {sid, mtimeMs: st.mtimeMs, size: st.size});
    badFiles.delete(file);
    return sid;
  }

  async function refreshGroups() {
    const now = Date.now();
    if (now - listAt < listIntervalMs) return;
    listAt = now;
    const files = [];
    /* 读失败的目录 ≠ 文件被删：记下这些目录，保留其缓存，只清理本轮确实扫到的范围 */
    const badDirs = [];
    for (const r of roots) await walkJsonl(r, files, badDirs, ioRd);
    listStale = badDirs.length > 0;
    /* 不再因「files 为空 + 有 badDirs」提前返回：
       ENOENT 的根/子目录已被 walkJsonl 排除出 badDirs，确认删除的文件会在下面被清理；
       只有 EACCES 等无法确认的范围内缓存才通过 confirmedGone 保留。 */
    reachable = files.length > 0;
    const under = (f, d) => f === d || f.startsWith(d.endsWith(sep) ? d : d + sep);
    /* 确认删除：本轮成功扫描到其所在目录、且文件确实不在列表里。
       只有"确认删除"才能清失败记录/身份缓存；读不到/stat 不到的文件不能顺手清掉（复核 v2.37 #1）。 */
    const confirmedGone = f => !files.includes(f) && !badDirs.some(d => under(f, d));
    for (const f of [...badFiles]) if (confirmedGone(f)) badFiles.delete(f);
    for (const f of [...fileOwner.keys()]) if (confirmedGone(f)) fileOwner.delete(f);
    for (const f of [...badParses]) if (confirmedGone(f)) badParses.delete(f);
    reassigned = [];
    const prevGroups = new Map(groups);
    const bySession = new Map();
    for (const f of files) {
      const sid = await readOwner(f);
      if (!sid) continue;   // 身份未确认或暂时读不到：先不建半份会话
      if (!bySession.has(sid)) bySession.set(sid, []);
      bySession.get(sid).push(f);
    }
    const rebuilt = new Map();
    for (const [sid, fs2] of bySession) {
      const old = prevGroups.get(sid);
      /* 同一会话跨多个目录时，若它上次的文件落在本轮读失败/读不到的目录或文件上，本轮结果不完整：
         保留上次完整快照，否则完成记录会丢、已完成调用会倒退成「运行中」。 */
      const incomplete = old && old.files.some(f => !fs2.includes(f) && (badDirs.some(d => under(f, d)) || badFiles.has(f)));
      if (old && incomplete) { rebuilt.set(sid, old); continue; }
      // 文件列表没变就沿用上一轮的解析结果，避免每 5 秒重算
      if (old && old.files.join('|') === fs2.join('|')) rebuilt.set(sid, { ...old, files: fs2 });
      else {
        /* 成员文件发生变化：保留旧成功快照，等新文件集合读取/解析/折叠全部成功后再替换。
           否则新增/删除副本后的读取失败会让会话从墙上掉下来（复核 v2.41 #1）。 */
        rebuilt.set(sid, {
          files: fs2, mtime: 0, size: 0,
          session: old ? old.session : null,
          keys: old ? old.keys : null,
          _sig: null,   // 强制重新解码，不能用上一版签名短路
        });
      }
    }
    /* 身份补全/替换：旧 ID 的已发事件身份迁到新 ID，避免同一内容按两个会话重复推送 */
    for (const [, oldSid, newSid] of reassigned) {
      const srcG = prevGroups.get(oldSid), dstG = rebuilt.get(newSid);
      if (!srcG || !dstG || !srcG.keys) continue;
      if (!dstG.keys) dstG.keys = new Map();
      for (const [k, v] of srcG.keys) if (!dstG.keys.has(k)) dstG.keys.set(k, v);
    }
    /* 本轮没扫到的旧会话：位于读失败目录下或含暂时读不到的文件才保留，其余视为真删除 */
    for (const [sid, old] of prevGroups) {
      if (rebuilt.has(sid)) continue;
      if (badDirs.some(d => old.files.some(f => under(f, d))) || old.files.some(f => badFiles.has(f))) rebuilt.set(sid, old);
    }
    groups.clear();
    for (const [k, v] of rebuilt) groups.set(k, v);
    /* 会话退出缓存时，记录诊断与名称索引一起回收，避免 stale/内存残留（复核 v2.42 #2/#8） */
    for (const sid of [...recordDiag.keys()]) if (!groups.has(sid)) { recordDiag.delete(sid); retryGroups.delete(sid); }
    for (const sid of [...callNames.keys()]) if (!groups.has(sid)) callNames.delete(sid);
    for (const f of [...parseDiag.keys()]) {
      if (confirmedGone(f) && ![...groups.values()].some(g => g.files.includes(f))) parseDiag.delete(f);
    }
    listed = true;
  }

  /* ---------------- 新版 Codex Desktop 的 SQLite 存储 ----------------
     JSONL rollout 只在回合边界落盘，正在进行的对话看不到；
     实时状态在 ~/.codex/state_5.sqlite(threads) + thread_history_1.sqlite(thread_turns / thread_items)。
     这里用 node:sqlite 只读打开（老版本 Node 没有该模块 → 自动跳过）。 */
  let sqliteMod = null, sqliteTried = false;
  const sqliteSessions = new Map();   // threadId -> session
  const sqliteSeen = new Map();       // threadId -> Map(itemId -> 签名)，按身份+状态去重
  let sqliteStale = false;
  /* absent=自动发现的可选库从未存在（旧版/CLI 只有 JSONL，不是故障）；
     error=显式配置错误或首次打开/查询失败；stale=曾经成功读过、现在不可用；
     unsupported=Node 没有 node:sqlite；ok=正常；disabled=调用方关掉了 SQLite。 */
  let sqliteStatus = sqlite ? 'absent' : 'disabled';
  const sqliteDbOk = new Set();       // 曾经成功打开过的库路径
  const sqliteRetry = new Set();      // 本轮失败、下一轮必须重试的线程（即使已超出活跃窗口）
  const sqliteThreadDiag = new Map(); // threadId -> {badItems, badFields, foldError, reasons}

  async function loadSqlite() {
    if (sqliteTried) return sqliteMod;
    sqliteTried = true;
    try { sqliteMod = ioSqlite ? await ioSqlite() : await import('node:sqlite'); } catch { sqliteMod = null; }
    return sqliteMod;
  }

  const stripLongPath = p => String(p || '').replace(/^\\\\\?\\/, '');
  const clip2 = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

  /* 把一条 thread_item 映射成事件流条目（也是会话折叠的依据）。
     状态和事件必须用同一套判定：进行中 → 普通事件；失败 → ok:false + 工具名 + 原因。 */
  function itemFeed(kind, d) {
    switch (kind) {
      case 'userMessage': { const t = clip2(textOf(d.content), 80); return t ? { verb: 'read', name: t, kind: 'msg' } : null; }
      case 'agentMessage': { const t = clip2(d.text, 80); return t ? { verb: 'review', name: t, kind: 'msg' } : null; }
      case 'commandExecution': {
        const cmd = clip2(d.command, 48);
        if (d.status === 'inProgress') return { verb: 'build', name: `exec · ${cmd}`, kind: 'tool' };
        /* 退出码缺失不能单独当作成功证据：启动失败时 exitCode=null，失败写在 status / error 里 */
        const failed = isItemFailed(d) || (d.exitCode != null && Number(d.exitCode) !== 0);
        if (failed) {
          const bits = [];
          if (d.exitCode != null) bits.push('exit ' + d.exitCode);
          const reason = itemFailReason(d) || clip2(shortReason(d.aggregatedOutput || ''), 44);
          if (reason) bits.push(reason);
          return { verb: 'check', name: `exec · ${bits.join(' · ') || '失败'}${cmd ? ' · ' + cmd : ''}`, kind: 'tool', ok: false };
        }
        return { verb: 'build', name: `exec · ${cmd}`, kind: 'tool' };
      }
      case 'fileChange': {
        const changes = Array.isArray(d.changes) ? d.changes : [];
        const f = clip2(stripLongPath((changes[0] && changes[0].path) || 'file'), 40);
        if (d.status === 'inProgress') return { verb: 'build', name: `apply_patch · ${f}`, kind: 'tool' };
        if (isItemFailed(d)) return { verb: 'check', name: `apply_patch · ${f} · ${itemFailReason(d) || '写入失败'}`, kind: 'tool', ok: false };
        return { verb: 'build', name: `apply_patch · ${f}`, kind: 'tool' };
      }
      case 'mcpToolCall': {
        const n = `${d.server || 'mcp'}·${d.tool || 'call'}`;
        if (d.status === 'inProgress') return { verb: 'build', name: n, kind: 'tool' };
        if (isItemFailed(d)) return { verb: 'check', name: `${n} · ${itemFailReason(d) || '失败'}`, kind: 'tool', ok: false };
        return { verb: 'build', name: n, kind: 'tool' };
      }
      case 'webSearch': {
        const q = clip2(d.query, 50);
        if (d.status === 'inProgress') return { verb: 'read', name: `search · ${q}`, kind: 'tool' };
        if (isItemFailed(d)) return { verb: 'check', name: `search · ${q} · ${itemFailReason(d) || '失败'}`, kind: 'tool', ok: false };
        return { verb: 'read', name: q, kind: 'tool' };
      }
      case 'collabAgentToolCall': {
        const n = clip2(d.tool || 'agent', 40);
        if (d.status === 'inProgress') return { verb: 'build', name: `agent · ${n}`, kind: 'tool' };
        if (isItemFailed(d)) return { verb: 'check', name: `agent · ${n} · ${itemFailReason(d) || '失败'}`, kind: 'tool', ok: false };
        return { verb: 'build', name: `agent · ${n}`, kind: 'tool' };
      }
      case 'subAgentActivity': {
        /* 用 kind 表达生命周期（started / interacted / completed），没有 status；
           started 与 completed 是两条不同 item，不能当成同一个未闭合调用 */
        const k = String(d.kind || d.status || '');
        const path = clip2(stripLongPath(d.agentPath || ''), 30);
        /* 与折叠端共用失败规则：kind failed/errored，或显式 error / errors 数组（复核 v2.38 #4）。
           started/completed 仍是独立生命周期记录，正常完成不标失败。 */
        if (k === 'failed' || k === 'errored' || isItemFailed(d)) {
          return { verb: 'check', name: `agent · failed${path ? ' · ' + path : ''}${itemFailReason(d) ? ' · ' + itemFailReason(d) : ''}`, kind: 'tool', ok: false };
        }
        return { verb: k === 'started' ? 'build' : 'review', name: `agent · ${k || 'activity'}${path ? ' · ' + path : ''}`, kind: 'tool' };
      }
      default: return null;
    }
  }

  /* item 的稳定键：优先 item_id（库里确实有这一列，之前 SELECT 漏查了），退回 rollout_ordinal。
     只接受标量：字段被写成对象时不能靠 String() 抛穿签名/索引（复核 v2.43 #3）。 */
  function keyOfItem(row, d, idx) {
    return scalarText(row.item_id) || scalarText(d && d.id) || scalarText(row.rollout_ordinal)
      || (idx === 0 ? '' : scalarText(idx)) || '';
  }

  /* 内容哈希（FNV-1a）：只比长度会漏掉「同长度内容更新」（AAAA → BBBB）。
     深嵌套对象没有可用的 JSON 表示时退回有界序列化，保证签名计算本身不抛错。 */
  function hashOf(v) {
    const s = typeof v === 'string' ? v : (v == null ? '' : safeStringify(v));
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }
  /* 已发出事件身份的紧凑表示：双重 FNV 拼成 64 位串，避免把整条消息文本常驻内存 */
  const keyHash = k => hashOf(k) + ':' + hashOf('#' + k);
  /* 工具名索引：按会话维护，从当前权威调用记录重建，不依赖「这条是否恰好要发事件」（复核 v2.41 #6）。
     超阈值只淘汰“已经有结果”的最旧关联，不再整表 clear —— 正在等待结果的调用不能被清掉（复核 v2.42 #8）。 */
  const MAX_CALL_NAMES = 4000;
  function indexCallNames(list, names) {
    const answered = new Set();
    for (const e of list) {
      const p = isPlainObject(e.payload) ? e.payload : {};
      if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && p.call_id) {
        answered.add(strField(p.call_id));
      }
    }
    for (const e of list) {
      const p = isPlainObject(e.payload) ? e.payload : {};
      if ((p.type === 'function_call' || p.type === 'custom_tool_call') && p.call_id) {
        const id = strField(p.call_id);
        if (!id) continue;
        names.delete(id);   // 重新插入，保持“最近出现”在 Map 末尾
        names.set(id, strField(p.name) || '命令');
      }
    }
    while (names.size > MAX_CALL_NAMES) {
      let victim = null;
      for (const k of names.keys()) if (answered.has(k)) { victim = k; break; }
      if (victim == null) victim = names.keys().next().value;   // 全在等待：仍有硬上限，淘汰最旧
      if (victim == null) break;
      names.delete(victim);
    }
  }
  /* 失败判定：不同工具的失败写在不同字段（status / error / errors），统一在这里认 */
  function isItemFailed(d) {
    const st = String(d.status || '');
    return st === 'failed' || st === 'errored' || st === 'error' || !!(d.error) || (Array.isArray(d.errors) && d.errors.length > 0);
  }
  function itemFailReason(d) {
    const raw = d.error || d.errors || d.agentsStates || '';
    return clip2(shortReason(typeof raw === 'string' ? raw : safeStringify(raw)), 40);
  }

  /* 一条 SQLite item 的签名：直接对 itemFeed 映射结果 + 各类型影响展示/失败/标签/片段的字段做统一投影。
     不在发现漏字段时再补单个 hash：mcpToolCall 的 server/tool、subAgentActivity 的 agentPath、
     协作调用的 tool 等都改变展示名，必须算「新事件」（复核 v2.42 #9）。 */
  function sigOf(row, d) {
    const kind = strField(row.item_type) || strField(d.type);
    let feed = 'null';
    try {
      const f = itemFeed(kind, d);
      if (f) feed = [f.verb || '', f.name || '', f.kind || '', f.ok === false ? '0' : '1'].join('~');
    } catch { feed = '!'; }
    return [
      kind,
      /* 状态/退出码只接受标量：`{toString:null}` 之类的对象字段以前在这里 String() 抛穿整库扫描 */
      scalarText(d.status != null ? d.status : d.kind),
      d.exitCode == null ? '' : scalarText(d.exitCode),
      d.error ? '1' : '0',
      hashOf(d.error), hashOf(d.errors), hashOf(d.agentsStates), hashOf(d.result),
      hashOf(d.arguments), hashOf(d.server), hashOf(d.tool), hashOf(d.agentPath),
      hashOf(d.prompt), hashOf(d.changes), hashOf(d.content), hashOf(d.text),
      hashOf(d.command), hashOf(d.query), hashOf(d.aggregatedOutput),
      hashOf(d.durationMs), hashOf(d.role), hashOf(d.type),
      feed,
    ].join('|');
  }

  /** 解析一条 thread_items 行：解析失败=不可用（fatal），字段非法=可用但记诊断。 */
  function parseItemRow(row) {
    const out = { row, d: null, kind: strField(row.item_type), fatal: false, issues: [] };
    let d;
    try { d = JSON.parse(row.item_json); }
    catch { out.fatal = true; out.issues.push('item_json 解析失败'); return out; }
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      out.fatal = true; out.issues.push('item_json 不是对象'); return out;
    }
    out.d = d;
    out.kind = strField(row.item_type) || strField(d.type);
    out.issues = validateItemFields(out.kind, d);
    return out;
  }

  /* 折叠一个 SQLite 线程：parsed 由 scanSqlite 预先解析/校验，坏 item 在单条边界隔离，
     不能让一条坏记录连带同线程其它 item 一起失效（复核 v2.42 #2）。 */
  function foldThread(t, turns, parsed, diag) {
    const cwd = stripLongPath(t.cwd);
    const s = {
      src: 'codex', id: String(t.id), cwd,
      title: clip2(t.name || t.title || t.first_user_message || 'codex', 40),
      depth: 0, parent: '', origin: 'user', mtime: Number(t.updated_at) * 1000 || Date.now(),
      turns: turns.filter(x => x.status === 'completed').length, openStep: null, lastTime: 0,
      todos: [], calls: [], msgs: [], snippets: [], gaps: [], current: null, lastFail: null,
      done: 0, failed: 0, seenSeq: parsed.length,
    };
    const open = new Map();
    /* 未闭合调用能否算「当前任务」：①必须属于最新回合 ②最新回合必须仍在运行。
       旧回合的 inProgress 是崩溃/中断残留；最新回合已 completed/interrupted 时，
       它自己的残留同样是历史残留（复核 v2.36 #2）。旧库没有 turn_id 时无法归属，保持旧行为。 */
    const lastTurn = turns[turns.length - 1];
    const lastTurnId = lastTurn ? scalarText(lastTurn.turn_id) : '';
    const lastTurnOpen = !!(lastTurn && scalarText(lastTurn.status) === 'inProgress');
    const placement = row => {
      const tid = scalarText(row.turn_id);
      if (!tid || !lastTurnId) return 'unknown';
      if (tid !== lastTurnId) return 'old';
      return lastTurnOpen ? 'live' : 'terminal';
    };
    const canOpen = row => { const p = placement(row); return p === 'live' || p === 'unknown'; };
    /* 已终止回合的残留调用：保留历史展示，标记为作废，不计成功也不计失败 */
    const retire = c => { c.done = true; c.aborted = true; };
    for (const entry of parsed) {
      const row = entry.row;
      if (!entry.d) continue;   // item_json 解析失败：调用方已计入健康，这里跳过单条
      const d = entry.d;
      const at = Number(row.created_at_ms) || 0;
      if (at > s.lastTime) s.lastTime = at;
      const kind = entry.kind || strField(row.item_type) || strField(d.type);
      try {
      if (kind === 'userMessage' || kind === 'agentMessage') {
        const txt = kind === 'agentMessage' ? strField(d.text).trim() : textSafe(d.content);
        if (txt) s.msgs.push({ role: kind === 'agentMessage' ? 'assistant' : 'user', text: txt });
        continue;
      }
      if (kind === 'commandExecution') {
        const running = d.status === 'inProgress';
        /* 失败判定不能只看退出码：进程启动失败时 exitCode 为 null，但 status/error 已说明失败。
           未知/缺失退出码也不能单独当作成功证据；统计与事件共用这套判定。 */
        const failed = !running && (isItemFailed(d) || (d.exitCode != null && Number(d.exitCode) !== 0));
        const c = {
          callId: scalarText(d.id), name: 'exec', label: clip2(d.command, 60),
          start: at, end: running ? 0 : at + (Number(d.durationMs) || 0),
          done: !running, error: failed,
          argBytes: Buffer.byteLength(scalarText(d.command), 'utf8'),
        };
        s.calls.push(c);
        if (running) {
          if (canOpen(row)) { if (c.callId) open.set(c.callId, c); } else retire(c);
          continue;
        }
        if (failed) {
          const code = d.exitCode != null ? `exit ${d.exitCode}` : '';
          const detail = itemFailReason(d) || clip2(shortReason(d.aggregatedOutput || ''), 44);
          c.reason = [code, detail].filter(Boolean).join(' · ') || '命令失败';
          s.failed++;
          s.lastFail = { name: 'exec', label: c.label, reason: c.reason, at: c.end || at };
        } else s.done++;
        continue;
      }
      if (kind === 'fileChange') {
        /* 三种状态要分清：成功（有 diff 才进代码块并计 done）、进行中（算运行中）、失败（进 lastFail + 失败数）。
           以前：成功不计数、进行中反而计 done、失败没有原因。 */
        const changes = Array.isArray(d.changes) ? d.changes : [];
        const first = changes[0] || null;
        const file = stripLongPath((first && first.path) || 'file');
        const done = d.status !== 'inProgress';
        const failed = isItemFailed(d);
        const c = { callId: scalarText(d.id), name: 'apply_patch', label: clip2(file, 60), start: at, end: done ? at : 0, done, error: failed, argBytes: 0 };
        s.calls.push(c);
        if (!done) { if (canOpen(row)) { if (c.callId) open.set(c.callId, c); } else retire(c); continue; }
        if (failed) {
          c.reason = itemFailReason(d) || 'fileChange 失败';
          s.failed++;
          s.lastFail = { name: c.name, label: c.label, reason: c.reason, at };
          continue;
        }
        s.done++;
        for (const ch of changes) {
          const diff = String((ch && ch.diff) || '');
          if (diff.trim()) s.snippets.push({ file: stripLongPath(ch.path || file), code: diff, at });
        }
        continue;
      }
      if (kind === 'webSearch') {
        /* 搜索也有运行中 / 成功 / 失败三种状态，不能固定算完成：
           进行中要算「在跑」，失败要计失败数并带原因，只有结束且没失败才 +done */
        const done = d.status !== 'inProgress';
        const failed = done && isItemFailed(d);
        const c = { callId: scalarText(d.id), name: 'web_search', label: clip2(d.query, 50), start: at, end: done ? at : 0, done, error: failed, argBytes: 0 };
        s.calls.push(c);
        if (!done) { if (canOpen(row)) { if (c.callId) open.set(c.callId, c); } else retire(c); continue; }
        if (failed) {
          c.reason = itemFailReason(d) || '搜索失败';
          s.failed++;
          s.lastFail = { name: c.name, label: c.label, reason: c.reason, at };
          continue;
        }
        s.done++;
        continue;
      }
      if (kind === 'collabAgentToolCall' || kind === 'subAgentActivity') {
        const isSub = kind === 'subAgentActivity';
        /* subAgentActivity 没有 status，用 kind 表达生命周期，而且 started / completed 是两条
           不同 item（id 也不同）——把 started 当未闭合调用会永远挂着，所以只认失败。 */
        const st = String(isSub ? (d.kind || d.status || '') : (d.status || ''));
        const done = isSub ? true : st !== 'inProgress';
        /* 失败判定与事件侧共用 isItemFailed：status failed/errored/error、error、errors 数组都算失败 */
        const failed = isSub ? (st === 'failed' || st === 'errored' || isItemFailed(d)) : isItemFailed(d);
        const c = {
          callId: scalarText(d.id), name: scalarText(d.tool) || 'agent',
          label: clip2(isSub ? (d.agentPath || 'agent') : (d.prompt || d.tool || 'agent'), 40),
          start: at, end: done ? at : 0, done, error: failed, argBytes: 0,
        };
        s.calls.push(c);
        if (!done) { if (canOpen(row)) { if (c.callId) open.set(c.callId, c); } else retire(c); continue; }   // 进行中要进 open，才能算「在跑」
        if (failed) {
          c.reason = itemFailReason(d) || 'agent 调用失败';
          s.failed++;
          s.lastFail = { name: c.name, label: c.label, reason: c.reason, at };
          continue;
        }
        s.done++;
        continue;
      }
      if (kind === 'mcpToolCall') {
        /* 与事件侧共用 isItemFailed（含 status error/errored、error、errors 数组） */
        const failed = isItemFailed(d);
        const c = { callId: scalarText(d.id), name: 'mcp', label: `${scalarText(d.server) || 'mcp'}·${scalarText(d.tool)}`, start: at, end: at + (Number(d.durationMs) || 0), done: d.status !== 'inProgress', error: failed, argBytes: Buffer.byteLength(safeStringify(d.arguments || {}), 'utf8') };
        if (!c.done) { if (canOpen(row)) { if (c.callId) open.set(c.callId, c); } else retire(c); }
        else if (c.error) { c.reason = itemFailReason(d) || shortReason(safeStringify(d.error || d.result || '')); s.failed++; s.lastFail = { name: c.name, label: c.label, reason: c.reason, at: c.end || at }; }
        else s.done++;
        s.calls.push(c);
        continue;
      }
      } catch (err) {
        /* 单条 item 折叠失败：隔离到这一条，同线程其它 item 继续（复核 v2.42 #2） */
        if (diag) {
          diag.badItems++;
          if (diag.reasons.length < 5) diag.reasons.push('item ' + scalarText(kind) + ' 折叠异常：' + String((err && err.message) || err).slice(0, 60));
        }
      }
    }
    s.current = [...open.values()].pop() || null;
    // 只看**最新**那个回合：老回合的 inProgress 是崩溃残留，不能让它一直显示「推理中」
    if (lastTurn && lastTurn.status === 'inProgress') s.openStep = s.turns + 1;
    return s;
  }

  async function scanSqlite() {
    if (!sqlite) { sqliteStatus = 'disabled'; sqliteStale = false; return; }   // 测试可关掉，避免读到真实用户库
    const mod = await loadSqlite();
    if (!mod || !mod.DatabaseSync) {
      /* Node 没有 node:sqlite → 不是故障；老版本环境不应因为 SQLite 一直显示 stale */
      sqliteStatus = 'unsupported'; sqliteStale = false; return;
    }
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const stateEnv = process.env.CODEX_STATE_DB || '';
    const histEnv = process.env.CODEX_HISTORY_DB || '';
    const statePath = sqlitePaths.state || stateEnv || join(home, '.codex', 'state_5.sqlite');
    const histPath = sqlitePaths.history || histEnv || join(home, '.codex', 'thread_history_1.sqlite');
    const stateCfg = !!(sqlitePaths.state || stateEnv);   // 显式配置：路径错误仍算故障
    const histCfg = !!(sqlitePaths.history || histEnv);
    /* 可选库状态分类（复核 v2.42 #10）：
       absent=自动发现且从未存在 → 旧版/CLI 纯 JSONL 环境，健康；
       error=显式配置错误或首次不可用；stale=曾经成功读过、现在失效。 */
    const probe = async (p, configured) => {
      try { await ioStat(p); }
      catch (e) {
        if (e && e.code === 'ENOENT') return configured ? 'error' : (sqliteDbOk.has(p) ? 'stale' : 'absent');
        return 'error';
      }
      return 'ok';
    };
    const markCachedForRetry = () => { for (const id of sqliteSessions.keys()) sqliteRetry.add(id); };
    const stState = await probe(statePath, stateCfg);
    const stHist = await probe(histPath, histCfg);
    if (stState === 'error' || stState === 'stale' || stHist === 'error' || stHist === 'stale') {
      sqliteStale = true;
      sqliteStatus = (sqliteDbOk.has(statePath) || sqliteDbOk.has(histPath)) ? 'stale' : 'error';
      markCachedForRetry();   // 库暂时不可用：已有缓存保留为待恢复对象，恢复后必须验证（复核 v2.43 #5）
      return;   // 保留已有缓存，等恢复后重试
    }
    if (stState === 'absent' || stHist === 'absent') {
      /* 两个默认库（或其中一个）从未存在：SQLite 没有被启用，JSONL 保持健康 */
      sqliteStatus = 'absent'; sqliteStale = false; return;
    }
    let db1, db2;
    try { db1 = new mod.DatabaseSync(statePath, { readOnly: true }); }
    catch { sqliteStale = true; sqliteStatus = 'error'; markCachedForRetry(); return; }
    sqliteDbOk.add(statePath);
    try { db2 = new mod.DatabaseSync(histPath, { readOnly: true }); }
    catch { try { db1.close(); } catch {} sqliteStale = true; sqliteStatus = 'stale'; markCachedForRetry(); return; }
    sqliteDbOk.add(histPath);
    try {
      const now = Date.now();
      const threads = db1.prepare('select id, cwd, title, name, first_user_message, updated_at from threads where archived = 0 order by updated_at desc limit 80').all();
      /* 待重试线程必须与常规 top80 候选取并集：线程滑出前 80 名也要读回终态，
         不能因为常规查询没返回就被当成归档/删除清掉（复核 v2.43 #5）。 */
      const listedIds = new Set(threads.map(t => scalarText(t.id)));
      for (const id of [...sqliteRetry]) {
        if (listedIds.has(id)) continue;
        try {
          const row = db1.prepare('select id, cwd, title, name, first_user_message, updated_at from threads where archived = 0 and id = ?').get(id);
          if (row) { threads.push(row); listedIds.add(id); }
        } catch { /* 线程查询失败：保留待重试集合，下一轮再试 */ }
      }
      /* item 的回合归属：新库有 turn_id（用来判断残留命令属于哪个回合）；老库没有该列时退回旧查询。 */
      let itemsStmt;
      try { itemsStmt = db2.prepare('select turn_id, item_id, item_type, item_json, created_at_ms, rollout_ordinal from thread_items where thread_id = ? order by rollout_ordinal asc'); }
      catch { itemsStmt = db2.prepare('select item_id, item_type, item_json, created_at_ms, rollout_ordinal from thread_items where thread_id = ? order by rollout_ordinal asc'); }
      /* 回合顺序：rollout_ordinal 是 Codex 写入的显式序号（真实库 436 个回合里它与 rowid、
         started_at 的顺序完全一致）；rowid 只是插入顺序，历史导入/恢复不一定等于回合先后。
         老库没有该列时退回 rowid，避免整块折叠失败。 */
      let turnsStmt;
      try { turnsStmt = db2.prepare('select turn_id, status from thread_turns where thread_id = ? order by rollout_ordinal asc, started_at asc'); }
      catch { turnsStmt = db2.prepare('select turn_id, status from thread_turns where thread_id = ? order by rowid asc'); }
      const alive = new Set();   // 本轮真正读到的线程（已按活跃度过滤），扫描完据此清理缓存
      const failedReads = new Set();   // 本轮查询失败的线程：保留缓存，清理时不能删
      let roundStale = false;          // 本轮是否存在查询失败
      for (const t of threads) {
        const tid = String(t.id);
        // cwd 不像目录的线程（比如 https:// 开头的）跳过，它们不是工作区
        if (!/[\\\\/]/.test(String(t.cwd || '')) || /^https?:/i.test(String(t.cwd || ''))) continue;
        let turns;
        try {
          if (sqliteFault && sqliteFault.turns && sqliteFault.turns.has(tid)) throw new Error('injected: thread_turns query failed');
          turns = turnsStmt.all(t.id);
        } catch {
          /* 查询失败 = 线程级待恢复：下一轮必须重试，不能先被活跃窗口/常规候选排除（复核 v2.43 #5） */
          failedReads.add(tid); sqliteRetry.add(tid); roundStale = true; continue;
        }
        /* 只认「最近还在动」的线程；但失败过的线程必须重试，即使已经滑出活跃窗口（复核 v2.42 #2） */
        const age = now - Number(t.updated_at) * 1000;
        if (age > activeMs && !sqliteRetry.has(tid)) continue;
        let items;
        try {
          if (sqliteFault && sqliteFault.items && sqliteFault.items.has(tid)) throw new Error('injected: thread_items query failed');
          items = itemsStmt.all(t.id);
        } catch {
          /* 与 turns 一样进入线程级待重试：跨活跃窗口后仍要读回终态并补事件 */
          failedReads.add(tid); sqliteRetry.add(tid); roundStale = true; continue;
        }
        const parsed = items.map(parseItemRow);
        let badItems = 0, badFields = 0;
        const reasons = [];
        for (const pe of parsed) {
          if (!pe.d) { badItems++; if (reasons.length < 5) reasons.push(pe.issues[0] || 'item_json 无法解析'); }
          else if (pe.issues.length) { badFields += pe.issues.length; if (reasons.length < 5) reasons.push(pe.issues[0]); }
        }
        let s;
        const foldDiag = { badItems: 0, reasons: [] };
        try {
          if (sqliteFault && sqliteFault.fold && sqliteFault.fold.has(tid)) throw new Error('injected: fold failed');
          s = foldThread(t, turns, parsed, foldDiag);
        } catch {
          /* foldThread 整块异常：不能登记为已处理（旧代码直接 continue，线程老了就永久跳过） */
          sqliteThreadDiag.set(tid, { badItems: 0, badFields: 0, foldError: 1, reasons: ['fold 异常'] });
          sqliteRetry.add(tid); failedReads.add(tid); roundStale = true;
          continue;
        }
        badItems += foldDiag.badItems || 0;
        for (const r of foldDiag.reasons) if (reasons.length < 5) reasons.push(r);
        /* 全部 item 都解析失败且没有旧快照：不建空会话，标脏并下一轮重试 */
        if (!sqliteSessions.has(tid) && parsed.length > 0 && parsed.every(pe => !pe.d)) {
          sqliteThreadDiag.set(tid, { badItems, badFields, foldError: 0, reasons });
          sqliteRetry.add(tid); roundStale = true;
          continue;
        }
        const hasBad = badItems > 0 || badFields > 0;
        if (hasBad) sqliteThreadDiag.set(tid, { badItems, badFields, foldError: 0, reasons });
        else sqliteThreadDiag.delete(tid);
        /* item 解析失败会让 done/calls 塌陷：有旧快照时保留，等恢复后重试，且不登记 seen（恢复后还能补事件） */
        if (badItems > 0 && sqliteSessions.has(tid)) {
          sqliteRetry.add(tid); roundStale = true; alive.add(tid);
          continue;
        }
        if (badItems > 0) { sqliteRetry.add(tid); roundStale = true; }
        else sqliteRetry.delete(tid);
        if (badFields > 0) roundStale = true;
        sqliteSessions.set(s.id, s);
        alive.add(s.id);
        /* 按「item 身份 + 状态」去重：同一条命令 inProgress → completed 时也要再推一次，
           单纯比条数会漏掉状态变化；重复的 JSONL/SQLite 记录也不会推两遍。 */
        let seenMap = sqliteSeen.get(s.id);
        if (!seenMap) {
          seenMap = new Map();
          sqliteSeen.set(s.id, seenMap);
          /* 第一次遇到这个会话：把所有历史都登记为已知（否则下一轮会把它们当新事件再推一遍），
             只把最后 8 条推进任务流当作"当前上下文"。键用 item_id，缺失才退回 rollout_ordinal。 */
          for (let i = 0; i < parsed.length; i++) {
            const pe = parsed[i];
            if (!pe.d) continue;
            seenMap.set(keyOfItem(pe.row, pe.d, i), sigOf(pe.row, pe.d));
            if (i >= Math.max(0, parsed.length - 8)) {
              try {
                const it0 = itemFeed(pe.kind, pe.d);
                if (it0) live.push(it0, s.id, clip2(s.title, 8));
              } catch { /* 单条坏记录跳过 */ }
            }
          }
          continue;
        }
        for (const pe of parsed) {
          if (!pe.d) continue;
          const key = keyOfItem(pe.row, pe.d, 0);
          if (!key) continue;
          const sig = sigOf(pe.row, pe.d);
          if (seenMap.get(key) === sig) continue;
          seenMap.set(key, sig);
          try {
            const it = itemFeed(pe.kind, pe.d);
            if (it) live.push(it, s.id, clip2(s.title, 8));
          } catch { /* 单条坏记录不能打断整轮 */ }
        }
      }
      // 查询结果里没有的线程（归档/删除/超出范围）要从缓存里退出，否则会一直挂在墙上。
      // alive 只能登记「本轮真正读到且符合条件」的线程；拿整个缓存的键来建集合等于永远删不掉。
      for (const id of [...sqliteSessions.keys()]) if (!alive.has(id) && !failedReads.has(id)) { sqliteSessions.delete(id); sqliteSeen.delete(id); }
      for (const id of [...sqliteRetry]) if (!alive.has(id) && !failedReads.has(id)) sqliteRetry.delete(id);
      for (const id of [...sqliteThreadDiag.keys()]) if (!alive.has(id) && !failedReads.has(id)) sqliteThreadDiag.delete(id);
      /* 查询失败 / item 诊断 / 待重试线程都会让缓存可能过期，标 stale；全部成功才清除 */
      sqliteStale = roundStale || sqliteThreadDiag.size > 0 || sqliteRetry.size > 0;
      sqliteStatus = sqliteStale ? 'stale' : 'ok';
    } catch {
      sqliteStale = true; sqliteStatus = 'stale';
      markCachedForRetry();   // 库/线程查询整体失败：已有缓存统一登记待恢复（复核 v2.43 #5）
    }
    finally { try { db1.close(); } catch {} try { db2.close(); } catch {} }
  }

  async function scan(warmup) {
    await scanSqlite();
    await refreshGroups();
    const now = Date.now();
    const stale = [];
    for (const [sid, g] of groups) {
      let mtime = 0, size = 0, ok = true;
      /* 每个成员都参与签名：只比 max(mtime)+总 size 会漏掉「较旧成员的等长修改」（复核 v2.38 #2） */
      const metas = [];
      const fileStat = new Map();
      for (const f of g.files) {
        try {
          const st = await ioStat(f);
          metas.push(f + ':' + st.mtimeMs + ':' + st.size);
          fileStat.set(f, st.mtimeMs);
          if (st.mtimeMs > mtime) mtime = st.mtimeMs;
          size += st.size;
          badFiles.delete(f);
        } catch { ok = false; badFiles.add(f); }   // stat 失败 ≠ 文件被删：保留缓存并标 stale，恢复后重试
      }
      if (!ok || !mtime) continue;
      const sig = metas.join('|');
      const prev = g.session;
      const wasBusy = !!(prev && (prev.current || prev.openStep != null));
      /* 已有缓存但组签名变了（成员/内容变化）：即使已超出活跃窗口也要重读，
         否则文件被清空/改写且 mtime 被保留成旧值时，旧快照会一直当成健康数据（复核 v2.41 #7）。 */
      const changed = !!prev && g._sig !== sig;
      /* 有未恢复的解析故障/折叠异常/读失败要强制重试，不能因为滑出活跃窗口就永久跳过（复核 v2.42 #2） */
      const retry = retryGroups.has(sid)
        || g.files.some(f => badParses.has(f) || badFiles.has(f) || parseDiag.has(f));
      g.mtime = mtime; g.size = size;
      if (now - mtime > activeMs && !wasBusy && !changed && !retry) { stale.push({ sid, g, mtime, size, sig, fileStat }); continue; }
      // 单个会话出问题不影响同轮其它会话
      try { await decodeGroup(sid, g, mtime, size, sig, fileStat, retry); }
      catch (err) {
        /* 整组解码的意外异常不能只靠下一轮兜底：保留旧快照、标脏并登记重试，
           不能让 runScan 的外观把它洗成健康（复核 v2.43 #3）。 */
        recordDiag.set(sid, { soft: 0, hard: 1, reasons: ['扫描异常：' + String((err && err.message) || err).slice(0, 60)] });
        retryGroups.add(sid);
      }
    }
    // 启动预热：源里没有活跃会话时，至少读最近 3 个，别切过去是空白
    if (warmup && stale.length) {
      stale.sort((a, b) => b.mtime - a.mtime);
      for (const { sid, g, mtime, size, sig, fileStat } of stale.slice(0, 3)) {
        try { await decodeGroup(sid, g, mtime, size, sig, fileStat); }
        catch (err) {
          recordDiag.set(sid, { soft: 0, hard: 1, reasons: ['预热扫描异常：' + String((err && err.message) || err).slice(0, 60)] });
          retryGroups.add(sid);
        }
      }
    }
  }

  /** 已知故障（坏行 / 读失败 / 待重试 / 记录级失败）必须绕过缓存短路：
   *  坏行修复后 size/mtime 可能完全没变，只靠 stat 签名会永远读不到恢复（复核 v2.43 #4）。 */
  function groupPendingFault(sid, g) {
    return retryGroups.has(sid)
      || g.files.some(f => badParses.has(f) || badFiles.has(f) || parseDiag.has(f));
  }

  async function decodeGroup(sid, g, mtime, size, sig, fileStat, force = false) {
    const prev = g.session;
    /* 解码前短路必须同时确认没有待恢复故障；scan 判定 retry 时也会显式 force。
       以前先命中 `prev && g._sig === sig`，外层虽已把 badParses 当 retry，仍不会重读（复核 v2.43 #4）。 */
    if (prev && g._sig === sig && !force && !groupPendingFault(sid, g)) return;

    const events = [];
    let failedFiles = 0, parseFails = 0;
    for (let fi = 0; fi < g.files.length; fi++) {
      const f = g.files[fi];
      try {
        const buf = await ioRead(f);
        const parsed = parseLines(buf);
        /* 读取成功但解析不出记录 ≠ 日志清空：整文件解析失败要保留旧完整快照并标脏。
           文件内部坏行不同：仍继续用可解析记录（含后续合法终态），但同样计入健康（复核 v2.42 #2）。 */
        if (!parsed.records.length && buf.length > 0) {
          parseFails++; badParses.add(f);
          noteParseFile(f, true, parsed.bad);
        } else if (parsed.bad.length) {
          badParses.add(f);
          noteParseFile(f, false, parsed.bad);
        } else {
          badParses.delete(f); parseDiag.delete(f);
        }
        const t = (fileStat && fileStat.get(f)) || 0;
        for (const ev of parsed.records) events.push(Object.assign({}, ev, { __src: { t, i: fi } }));
        badFiles.delete(f);
      } catch { failedFiles++; badFiles.add(f); }
    }
    /* 读取不完整：不能把剩余记录折叠成「完整会话」覆盖上次快照，
       也不登记本版 _mtime/_size —— 权限恢复后 mtime/size 可能没变，必须强制重试（复核 v2.36 #5）。 */
    if (failedFiles) return;
    /* 有旧快照时，整文件解析失败要保留旧完整快照并标 stale（等恢复），不能拿残缺内容替换。 */
    if (parseFails && prev) return;
    if (!events.length) {
      /* 日志被清空或截断：旧解析状态必须作废，否则会一直保留「还在运行」。
         判据是文件变空/变小（截断）；只是暂时读不出有效行（写到一半）时保留旧状态、下轮重试。 */
      const prevSize = Number(g._size) || 0;
      if (prev && (size === 0 || size < prevSize)) {
        g.session = null;
        g._mtime = mtime; g._size = size; g._sig = sig;
        g.mtime = mtime; g.size = size;
        recordDiag.delete(sid); retryGroups.delete(sid);
      }
      return;
    }
    events.sort((a, b) => (toMs(a.timestamp) - toMs(b.timestamp)) || ((a.ordinal || 0) - (b.ordinal || 0)));

    /* 单记录的归一化 / 身份 / 签名 / 索引 / feed 映射全部放进可控失败边界（复核 v2.43 #3）：
       先校验形状与身份字段类型，再生成身份；非法记录跳过并诊断，合法后续终态继续处理。
       记录级硬失败不登记本版签名，下一轮继续重试。 */
    const diag = { soft: 0, hard: 0, reasons: [] };
    const noteIssue = (hard, msg) => {
      if (hard) diag.hard++; else diag.soft++;
      if (diag.reasons.length < 6) diag.reasons.push(String(msg).slice(0, 80));
    };
    const usable = [];
    events.forEach((e, idx) => {
      try {
        const fatal = fatalRecordIssue(e);
        if (fatal) { noteIssue(true, '记录降级：' + fatal); return; }
        for (const issue of validateEventFields(e)) noteIssue(false, issue);
        const safe = sanitizeRecord(e);
        safe.__ord = idx;
        usable.push(safe);
      } catch (err) {
        noteIssue(true, '记录归一化异常：' + String((err && err.message) || err));
      }
    });
    /* 同一稳定身份可能来自多份 rollout 副本，内容还可能互相冲突（复核 v2.40 #1）：
       先按「来源新、靠后」选权威版本，再折叠与发事件 —— 统计、lastFail 与事件必须用同一版本。
       无 ID 的消息身份已包含内容，多个同身份只可能是完全相同的副本。 */
    const byIdent = new Map();
    for (const e of usable) {
      try {
        const ident = eventIdentity(e);
        byIdent.set(ident, pickAuthoritative(byIdent.get(ident), e));
      } catch (err) {
        noteIssue(true, '记录身份异常：' + String((err && err.message) || err));
      }
    }
    const picked = [...byIdent.values()].sort((a, b) => (a.__ord || 0) - (b.__ord || 0));
    /* 工具名索引按会话维护，从当前权威调用记录重建，不依赖「这条是否恰好要发事件」——
       否则改名后如果没触发事件，后续失败事件的工具归属仍是旧名（复核 v2.41 #6 / v2.42 #8）。 */
    let names = callNames.get(sid);
    if (!names) { names = new Map(); callNames.set(sid, names); }
    try { indexCallNames(picked, names); }
    catch (err) {
      noteIssue(true, '工具名索引异常：' + String((err && err.message) || err));
      recordDiag.set(sid, { soft: diag.soft, hard: diag.hard, reasons: diag.reasons.slice(0, 6) });
      retryGroups.add(sid);
      return;
    }

    let s;
    try {
      s = foldSession(sid, picked, mtime, diag);
    } catch {
      /* 整块折叠异常：不能登记为本版已处理，标脏并下一轮重试（复核 v2.42 #2） */
      recordDiag.set(sid, { soft: 0, hard: 1, reasons: ['会话折叠异常'] });
      retryGroups.add(sid);
      return;
    }
    const shortName = trunc(s.title, 8);
    /* 同一 thread 同时存在于 SQLite 与 JSONL 时，SQLite 是实时权威（merged() 也以它为准），
       JSONL 只负责补 SQLite 里没有的会话 —— 否则同一条失败命令会推两条事件。 */
    const preferSqlite = sqliteSessions.has(sid);
    const emit = it => { if (it && !preferSqlite) live.push(it, sid, shortName); };
    /* 已发出事件按「稳定身份 → 内容签名」保存：文件集合变化、同一记录被改写时
       统计会重折叠，但只有内容真正变化才补发事件（复核 v2.39 #3 / v2.40 #1/#6）。 */
    const idHash = e => keyHash(eventIdentity(e));
    const sigHash = e => keyHash(eventSig(e));
    const feedOne = e => {
      try { emit(eventsToFeed(e, names)); }
      catch (err) {
        diag.soft++;
        if (diag.reasons.length < 6) diag.reasons.push('事件映射异常：' + String((err && err.message) || err).slice(0, 60));
      }
    };
    if (!g.keys) {
      g.keys = new Map();
      for (const e of picked) {
        try { g.keys.set(idHash(e), sigHash(e)); } catch { diag.soft++; }
      }
      const early = [];
      for (const e of picked.slice(-80)) {
        try { const it = eventsToFeed(e, names); if (it) early.push(it); } catch { diag.soft++; }
      }
      for (const it of early.slice(-10)) emit(it);
    } else {
      for (const e of picked) {
        let h, sg;
        try { h = idHash(e); sg = sigHash(e); } catch { diag.soft++; continue; }
        if (g.keys.get(h) === sg) continue;
        g.keys.set(h, sg);
        feedOne(e);
      }
      /* 不能裁剪：文件仍会被全量重读，忘记仍在文件里的身份会把历史当新事件重推
         （复核 v2.36 #1）。内存上界≈该会话历史条数，会话退出缓存时随 group 一起回收。 */
    }
    s.seenSeq = picked.length;

    if (diag.soft || diag.hard) {
      recordDiag.set(sid, { soft: diag.soft, hard: diag.hard, reasons: diag.reasons.slice(0, 6) });
    } else recordDiag.delete(sid);
    if (diag.hard) retryGroups.add(sid); else retryGroups.delete(sid);

    g.session = s; g._mtime = mtime; g._size = size;
    g.mtime = mtime; g.size = size;
    /* 记录级硬失败：这一版没有完整可信快照，不能登记签名，下一轮必须重试 */
    if (!diag.hard) g._sig = sig;
  }

  /* 合并两路数据：同一个 thread id 两边都有时，用 SQLite 的（实时、更新）
     JSONL 里的其它会话照常保留 */
  function merged() {
    const out = new Map();
    for (const g of groups.values()) if (g.session) out.set(g.session.id, g.session);
    for (const s of sqliteSessions.values()) out.set(s.id, s);
    return [...out.values()];
  }

  return {
    id: 'codex',
    name: 'Codex',
    note: 'OpenAI Codex 会话',
    path: roots.join('  +  '),
    scan,
    sessions: () => merged(),
    available: () => reachable || sqliteSessions.size > 0,   // SQLite 有数据也算可用
    stats: () => {
      const ss = merged();
      let recordFaults = 0, sqliteFaults = 0;
      for (const d of recordDiag.values()) recordFaults += (d.soft || 0) + (d.hard || 0);
      for (const d of sqliteThreadDiag.values()) sqliteFaults += (d.badItems || 0) + (d.badFields || 0) + (d.foldError || 0);
      return {
        sessions: ss.length,
        // 近期活跃（按 mtime）和正在运行（有没结束的调用/回合）是两件事
        active: ss.filter(s => Date.now() - s.mtime < activeMs).length,
        running: ss.filter(s => s.current || s.openStep != null).length,
        files: [...groups.values()].reduce((n, g) => n + g.files.length, 0),
        // 目录/库/文件/解析/单记录异常时缓存可能是旧的；成功读取不会清除尚未恢复的解析故障
        stale: listStale || sqliteStale || badFiles.size > 0 || badParses.size > 0 || recordDiag.size > 0,
        sqlite: sqliteStatus,
        sqliteFaults,
        recordFaults,
        parseFaults: [...parseDiag.values()].map(d => ({
          file: d.file, wholeFile: !!d.wholeFile, badLines: d.badLines, positions: d.positions.slice(),
        })),
      };
    },
  };
}
