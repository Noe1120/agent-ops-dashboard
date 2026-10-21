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
import { createHash } from 'node:crypto';
import { join, basename, dirname } from 'node:path';
import { trunc, toolLabel, verbFor, textOf, toMs } from '../lib/core.mjs';

/* ---------------- 解析 ---------------- */

function isRecordObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/* JSONL 解码结果要带上诊断，不能只返回「解析成功的记录」（复核 v2.42 #2）：
     · 合法 JSON、但不是对象（null / 数字 / 数组）：可忽略的未知载荷，不算故障；
     · 文件末尾没有换行、且解析不出来的最后一行：正在追加的半行，可忽略；
     · 文件内部完整的坏行（后面还有换行/其它行）：解析质量下降，调用方必须标 stale，
       但已经解析出来的记录仍要参与折叠，后面的合法结束记录也必须生效。 */
function parseLines(buf) {
  const text = buf.toString('utf8');
  const endsWithNewline = text.endsWith('\n');
  const lines = text.split('\n');
  const records = [];
  let badLines = 0;
  let trailingPartial = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    try {
      const v = JSON.parse(l);
      if (isRecordObject(v)) records.push(v);   // null / 数字 / 数组不算记录
    } catch {
      if (i === lines.length - 1 && !endsWithNewline) trailingPartial = true;   // 末尾半行：可忽略
      else badLines++;                                                          // 文件内部坏行：质量下降
    }
  }
  return { records, badLines, trailingPartial };
}

/* 已知需要对象入参的写文件类工具：入参解析后必须是普通对象 */
const OBJECT_INPUT_TOOLS = /^(write|edit|multiedit|notebookedit)$/i;

/* 工具入参归一化：Claude 一般直接给对象，但外部日志可能给 JSON 字符串。
   null / 数组 / 原始值 / 超深嵌套都只影响这一条记录，不能抛穿整份折叠（复核 v2.42 #2）：
     · 可解析成对象的字符串 → 用解析后的对象；
     · 写文件类工具拿到非对象 → 记一次质量故障（调用保留，入参降级为空对象）；
     · 其它工具的非对象入参 → 静默降级，不把无害差异当损坏。 */
function normalizeToolInput(name, input) {
  const known = () => OBJECT_INPUT_TOOLS.test(String(name || ''));
  let v = input;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return { value: {}, invalid: known() }; }
  }
  if (v === undefined) return { value: {}, invalid: false };
  if (!isRecordObject(v)) return { value: {}, invalid: known() };
  try { JSON.stringify(v); } catch { return { value: {}, invalid: true }; }   // 超深嵌套：单条隔离并记故障
  return { value: v, invalid: false };
}

/* 不可信字段的字符串归一化：只接受基本类型，绝不对任意对象调用 String()。
   {"toString":null} 这类完全合法的 JSON 会让 String() 抛 TypeError，而且发生在
   foldSession 的 try 之外，整份日志的扫描会变成 reject（复核 v2.43 #3）。 */
function primitiveString(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return null;
}
function safeFieldString(v, fallback = '') {
  const out = primitiveString(v);
  return out == null ? fallback : out;
}

/* 本地控制记录：Claude Code 的 /exit 等斜杠命令不写 result/end_turn，而是
   <command-name>…</command-name> 记录（可能跟一条配对的 <local-command-stdout>）。
   真实日志里的 /exit 记录**不一定带 isMeta**（实测 2.1.x），所以不能把 isMeta 当硬条件；
   但必须匹配整条记录形状（从 <command-name> 开始、命令参数结构完整），
   不能在任意用户文字里搜标签，否则普通消息引用日志片段会被误判成退出（复核 v2.43 #2）。
   本地命令的 caveat/stdout 同样整条跳过，不能进 msgs/标题。 */
function controlRecord(e, msg) {
  if (!isRecordObject(e) || e.type !== 'user') return null;
  const raw = msg && msg.content;
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  const m = /^<command-name>([^<]*)<\/command-name>/.exec(text);
  if (m) {
    const rest = text.slice(m[0].length);
    if (!/^(?:\s*<command-message>[\s\S]*?<\/command-message>)?\s*(?:<command-args>[\s\S]*?<\/command-args>)?\s*$/.test(rest)) return null;
    return { kind: 'command', name: m[1].trim() };
  }
  // <local-command-stdout> / <local-command-caveat> 等整条本地命令记录：只做控制信息
  const lm = /^<local-command-([a-z-]+)>[\s\S]*<\/local-command-[a-z-]+>$/.exec(text);
  if (lm) return { kind: 'local', name: lm[1] };
  return null;
}

/* 已知事件类型的最小字段结构校验：只做降级/计数，不抛错。
   返回 { faults, diagnostics }；记录本身仍进入折叠，后续合法记录照常处理。
   归一化阶段就拒绝对象/数组 ID/name/type：不把非法对象转成同一个字符串身份，
   否则去重、索引与事件映射会把不同损坏记录混成一条（复核 v2.43 #3）。 */
function normalizeEvents(events) {
  let faults = 0;
  const diagnostics = [];
  const diag = (stage, detail) => {
    faults++;
    if (diagnostics.length < 12) diagnostics.push({ stage, ...detail });
  };
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!isRecordObject(e)) continue;
    if (typeof e.type !== 'string' || !e.type) { diag('record.type', { record: i }); continue; }
    if (e.uuid != null && typeof e.uuid !== 'string') { diag('record.uuid', { record: i }); e.uuid = ''; }
    const msg = e.message;
    if (isRecordObject(msg) && msg.id != null && typeof msg.id !== 'string') {
      diag('message.id', { record: i });
      msg.id = '';
    }
    if (e.type === 'user') {
      /* tool_result 的 tool_use_id 也参与索引/配对：非基本类型先诊断并清空，
         不让 String({toString:null}) 在 fold 里抛穿（单条记录边界之外也会破坏配对）。 */
      if (isRecordObject(msg) && Array.isArray(msg.content)) {
        for (let j = 0; j < msg.content.length; j++) {
          const b = msg.content[j];
          if (!isRecordObject(b) || b.type !== 'tool_result') continue;
          const id = primitiveString(b.tool_use_id);
          if (!id) { diag('tool_result.id', { record: i, block: j, kind: typeof b.tool_use_id }); b.tool_use_id = ''; }
        }
      }
      continue;
    }
    if (e.type !== 'assistant' || !isRecordObject(msg) || !Array.isArray(msg.content)) continue;
    for (let j = 0; j < msg.content.length; j++) {
      const b = msg.content[j];
      if (!isRecordObject(b)) continue;
      if (typeof b.type !== 'string' || !b.type) { diag('block.type', { record: i, block: j }); b.type = 'invalid_block'; continue; }
      if (b.type !== 'tool_use') continue;
      const id = primitiveString(b.id);
      if (!id) { diag('tool_use.id', { record: i, block: j, kind: typeof b.id }); b.type = 'invalid_tool_use'; continue; }
      const name = primitiveString(b.name);
      if (!name) { diag('tool_use.name', { record: i, block: j, kind: typeof b.name }); b.type = 'invalid_tool_use'; continue; }
      b.id = id;
      b.name = name;
      const r = normalizeToolInput(name, b.input);
      if (r.invalid) diag('tool_use.input', { record: i, block: j, tool: name });
      b.input = r.value;
    }
  }
  return { faults, diagnostics };
}

/** tool_result 的 content 可能是字符串，也可能是 [{type,text}]。 */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return textOf(content);
  return '';
}

function snippetOf(name, input) {
  if (!/^(write|edit|multiedit|notebookedit)$/i.test(safeFieldString(name))) return null;
  if (!input || typeof input !== 'object') return null;
  const code = input.content != null ? safeFieldString(input.content)
    : input.new_string != null ? safeFieldString(input.new_string) : '';
  const file = safeFieldString(input.file_path) || safeFieldString(input.path);
  if (!code.trim()) return null;
  return { file: file || safeFieldString(name), code };
}

/* 工具入参可能超深嵌套：单条记录的序列化失败不能把整份日志折叠/发布拖垮（复核 v2.42 #2）。
   这些包装只做降级，真正「质量下降」的判定在解析诊断和结构校验里。 */
function safeToolLabel(name, input) {
  try { return toolLabel(name, input); } catch { return trunc(String(name || 'tool'), 34); }
}
/* content 里也可能塞进含 toString/valueOf 非函数属性的对象：文本提取不能抛穿单条记录边界。 */
function safeText(content) {
  try { return textOf(content); } catch { return ''; }
}
function safeArgBytes(input) {
  try { return Buffer.byteLength(JSON.stringify(input === undefined ? {} : input), 'utf8'); }
  catch { return 0; }
}

/* ---------------- 折叠 ---------------- */

function foldSession(id, events, mtime) {
  const s = {
    src: 'claude', id, cwd: '', title: '', depth: 0, parent: '', mtime,
    turns: 0, openStep: null, lastTime: 0, turnOpen: null,
    todos: [], calls: [], msgs: [], snippets: [], gaps: [], current: null, lastFail: null,
    done: 0, failed: 0, seenSeq: 0, ended: false, exitedAt: null,
  };
  const open = new Map();
  let prevT = 0;
  let titleFromUser = '';
  let customTitle = '';
  let turnOpen = null;       // 回合是否还开着：null = 未出现回合记录，false = 已确认结束

  /* 回合终态（result / last-prompt 记录、system 结束子类型、assistant stop_reason）：
     本回合还没收到结果的调用一律作废 —— 标 done+aborted，但**不计**成功/失败，
     也不把未确认的写入放进代码片段；清空 open 与 openStep，否则残留调用会被当成「仍在运行」，
     还会挡住 core 的 todo 降级。迟到的 tool_result 找不到 open 里的调用，也就不会翻成成功。 */
  function closeTurn(t) {
    for (const c of open.values()) { c.done = true; c.end = t; c.aborted = true; }
    open.clear();
    s.openStep = null;
    turnOpen = false;
  }

  /* 生命周期是「截至当前记录位置」的状态：真正的新用户消息或助手活动会让已退出会话恢复；
     迟到的 tool_result、控制命令输出、result/system 收尾记录都不能恢复。 */
  function restoreLifecycle() {
    if (s.ended) { s.ended = false; s.exitedAt = null; }
  }

  let recordFaults = 0;      // 单条记录折叠异常的条数：隔离后继续处理同一文件的后续记录
  for (const e of events) {
    try {
    const t = toMs(e.timestamp);
    if (t > s.lastTime) s.lastTime = t;
    if (prevT && t > prevT) s.gaps.push(Math.min(600_000, t - prevT));
    if (t) prevT = t;

    if (e.cwd && !s.cwd) s.cwd = safeFieldString(e.cwd);
    if (e.isSidechain && !s.depth) s.depth = 1;

    if (e.type === 'attachment') {
      const snap = e.attachment && e.attachment.snapshot;
      if (snap && snap.workingDirectory && !s.cwd) s.cwd = safeFieldString(snap.workingDirectory);
      continue;
    }
    if (e.type === 'custom-title') {
      if (e.customTitle) customTitle = safeFieldString(e.customTitle);
      continue;
    }
    // 结束类记录：只认明确的结束信号，不能把所有 system 都当成回合结束
    // （system 里还有 init / compact_boundary / api_error 等，中途出现并不代表这一轮结束了）
    if (e.type === 'result' || e.type === 'last-prompt') {
      closeTurn(t);
      continue;
    }
    if (e.type === 'system') {
      const sub = safeFieldString(e.subtype).toLowerCase();
      if (sub === 'stop_hook_summary' || sub === 'turn_complete' || sub === 'end_turn') closeTurn(t);
      continue;
    }
    if (e.type === 'mode') continue;

    // message 可能是字符串，也可能是对象；content 同样可能是字符串或数组
    const rawMsg = e.message;
    const msg = typeof rawMsg === 'string' ? { content: rawMsg } : rawMsg;
    if (!msg) continue;

    /* 本地控制记录：只认 isMeta + 完整记录形状，不扫整段用户文字。
       /exit 命令进入「已退出」生命周期并收尾；命令输出不触发也不恢复。
       控制记录本身不进 msgs/标题/事件流（复核 v2.43 #2）。 */
    const ctrl = controlRecord(e, msg);
    if (ctrl) {
      if (ctrl.kind === 'command' && ctrl.name === '/exit') {
        closeTurn(t);
        s.ended = true;
        s.exitedAt = t;
      }
      continue;
    }

    if (e.type === 'user') {
      // ① 真实用户输入（字符串 content）
      if (typeof msg.content === 'string') {
        const text = msg.content.trim();
        if (text) {
          restoreLifecycle();
          s.msgs.push({ role: 'user', text });
          if (!titleFromUser) titleFromUser = text;
          turnOpen = true;
        }
        continue;
      }
      if (!Array.isArray(msg.content)) continue;
      // ② tool_result（配对回 tool_use）
      let hadResult = false;
      for (const blk of msg.content) {
        if (!blk || blk.type !== 'tool_result') continue;
        hadResult = true;
        const key = safeFieldString(blk.tool_use_id);
        const c = open.get(key);
        if (!c) continue;   // 迟到/未知的结果：已作废的调用不能因此翻成成功
        c.done = true; c.end = t; c.error = !!blk.is_error;
        if (c.error) {
          c.reason = shortReason(safeText(blk.content));   // 例如 "EACCES: permission denied"
          s.failed++;
          s.lastFail = { name: c.name, label: c.label, reason: c.reason, at: c.end || t };
        } else { s.done++; if (c.snippet) s.snippets.push(c.snippet); }
        open.delete(key);
      }
      const text = safeText(msg.content);
      if (text) s.msgs.push({ role: 'user', text });
      // ③ 不是工具结果、带文本的 user 记录 = 用户新消息 → 新回合开始（并恢复生命周期）
      if (!hadResult && text) { restoreLifecycle(); turnOpen = true; }
      continue;
    }

    if (e.type === 'assistant') {
      turnOpen = true;
      restoreLifecycle();   // 助手真实活动 = 会话重新活跃（迟到结果做不到这一点）
      // 明确结束的信号：最终回复带 stop_reason = end_turn / stop_sequence / max_tokens
      // （stop_reason = tool_use 表示还要继续调工具，不算结束）
      const stop = safeFieldString(msg.stop_reason ?? e.stop_reason).toLowerCase();
      const ended = stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens';
      // 纯字符串回复
      if (typeof msg.content === 'string') {
        const text = msg.content.trim();
        if (text) { s.msgs.push({ role: 'assistant', text }); s.turns++; }
        if (ended) closeTurn(t);
        continue;
      }
      if (!Array.isArray(msg.content)) { if (ended) closeTurn(t); continue; }
      for (const blk of msg.content) {
        if (!blk) continue;
        if (blk.type === 'tool_use') {
          const c = {
            callId: safeFieldString(blk.id),
            name: safeFieldString(blk.name, 'tool'),
            label: safeToolLabel(blk.name, blk.input),
            start: t, end: 0, done: false, error: false,
            argBytes: safeArgBytes(blk.input),
          };
          s.calls.push(c);
          if (c.callId) open.set(c.callId, c);
          const sn = snippetOf(blk.name, blk.input);
          // 片段先挂在调用上，成功结束才入列（失败的写文件不算写入）
          if (sn) c.snippet = { ...sn, at: t };
          if (/^todowrite$/i.test(c.name) && Array.isArray(blk.input && blk.input.todos)) {
            /* 记录边界校验：todos 里的 null / 非对象成员只丢这一项，合法项保留。
               不能让它抛错把整份 fold 交给外层 catch —— 否则后面的结束记录被一起跳过，
               会话会一直显示为「运行中」（复核 v2.39 第 2 条）。 */
            s.todos = blk.input.todos
              .filter(x => x && typeof x === 'object' && !Array.isArray(x))
              .map(x => ({ content: safeFieldString(x.content), status: safeFieldString(x.status, 'pending') }));
          }
        }
      }
      if (msg.content.some(b => b && b.type === 'text')) {
        const text = safeText(msg.content);
        if (text) { s.msgs.push({ role: 'assistant', text }); s.turns++; }   // 纯文字回合也算「有内容」
      }
      if (ended) closeTurn(t);
      continue;
    }
    } catch { recordFaults++; }   // 单条记录异常不挡住同文件后续记录（复核 v2.42 #2）
  }
  s.faults = recordFaults;

  s.current = [...open.values()].pop() || null;
  // 「推理中」只在「这一轮还开着、并且没有工具在跑」时成立。
  // 结束信号有三种：result / last-prompt 记录、system 的结束子类型、assistant 的 stop_reason。
  s.turnOpen = turnOpen;
  s.openStep = (turnOpen && !s.current) ? 1 : null;
  if (!s.title) {
    s.title = customTitle || (titleFromUser ? trunc(titleFromUser, 40) : (s.cwd ? basename(s.cwd) : id.slice(0, 8)));
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

/* ---------------- 事件单元：稳定身份 + 内容版本 ---------------- */

/* 一条记录里可能派生多个事件（多个工具调用 / 多条失败结果），身份必须按「事件单元」定义：
     · 基础身份只含记录的稳定标识（uuid / message.id / 无标识时的时间戳与类型），
       保证同一条记录在重读、压缩、同代裁剪后仍认得出；
     · 单元键再拼该单元自己的内容摘要（消息文本 / 工具名与入参 / 失败文本）。
   这样改写一条消息里的某个工具，不会把同一条消息里没变化的其它工具再发一遍（复核 v2.42 #1）。 */
const ID_SEP = '\u0000';

function baseIdentity(e) {
  const type = safeFieldString(e.type);
  const raw = e.message;
  const msg = isRecordObject(raw) ? raw : null;
  const stable = safeFieldString(e.uuid) || (msg ? safeFieldString(msg.id) : '');
  const parts = [type, stable];
  /* 有稳定标识时时间戳不参与身份：同一记录被复制/恢复后重写时间戳不应重复发布；
     没有标识时只能靠时间戳 + 内容区分不同记录。 */
  if (!stable) parts.push(safeFieldString(e.timestamp));
  const subtype = safeFieldString(e.subtype);
  if (subtype) parts.push(subtype);
  const customTitle = safeFieldString(e.customTitle);
  if (customTitle) parts.push(customTitle);
  return createHash('sha1').update(parts.join(ID_SEP)).digest('hex');
}

/* 内容摘要：超深嵌套序列化失败只退化这一条单元，绝不抛穿整次扫描（复核 v2.42 #2）。 */
function contentDigest(v) {
  try {
    if (typeof v === 'string') return createHash('sha1').update('s' + ID_SEP + v).digest('hex');
    const j = JSON.stringify(v);
    return createHash('sha1').update('j' + ID_SEP + (j === undefined ? 'undefined' : j)).digest('hex');
  } catch {
    return '[unserializable]';
  }
}

/* 工具名索引按「本文件 / 本会话」作用域维护，并且从整份权威调用记录重建，
   不依赖「这一轮是否恰好要发事件」：只追加失败结果时，旧调用记录不会重发，
   但它的工具名仍必须能查到（复核 v2.42 #8）。
   每个文件每次解码各自一份 Map，会话删除后随缓存一起回收。
   裁剪时机（复核 v2.43 #9）：**先服务本轮待发布事件需要的结果关联和所有未完成调用**，
   再淘汰「已完成且没有待发布失败引用」的最旧关联；不能在全量建立后立刻按 800 FIFO
   把仍等结果的 c0 删掉，否则 feed 事件会退化成「工具 · EACCES」，与 lastFail 不一致。
   临时全量索引只在本次 decodeOne 内存在，事件处理结束即随函数返回释放。 */
const CALL_NAME_CAP = 800;
function sessionCallNames(events) {
  const names = new Map();       // callId -> {name, done, order}
  const pending = new Set();     // 还没有 tool_result 的调用：本轮之后仍可能发布迟到失败
  const failedRefs = new Set();  // 出现过失败结果的调用：本轮可能发布该失败事件
  let order = 0;
  for (const e of events) {
    if (!isRecordObject(e)) continue;
    const msg = e.message;
    if (!isRecordObject(msg) || !Array.isArray(msg.content)) continue;
    if (e.type === 'assistant') {
      for (const b of msg.content) {
        if (!isRecordObject(b) || b.type !== 'tool_use') continue;
        const id = safeFieldString(b.id);
        if (!id) continue;
        names.delete(id);   // 重新插入 → 最近一次调用排在后面
        names.set(id, { name: safeFieldString(b.name, '工具'), done: false, order: ++order });
        pending.add(id);
      }
    } else if (e.type === 'user') {
      for (const b of msg.content) {
        if (!isRecordObject(b) || b.type !== 'tool_result') continue;
        const id = safeFieldString(b.tool_use_id);
        if (!id) continue;
        const rec = names.get(id);
        if (rec) { rec.done = true; pending.delete(id); }
        if (b.is_error) failedRefs.add(id);
      }
    }
  }
  if (names.size > CALL_NAME_CAP) {
    const protect = id => pending.has(id) || failedRefs.has(id);
    const victims = [];
    for (const [id, rec] of names) if (!protect(id)) victims.push([id, rec.order]);
    victims.sort((a, b) => a[1] - b[1]);
    let overflow = names.size - CALL_NAME_CAP;
    for (const [id] of victims) {
      if (overflow <= 0) break;
      names.delete(id);
      overflow--;
    }
    /* 全部关联都被保护时宁可暂时超过常数，也不能丢掉仍等结果的工具名；
       这是单次解码的临时索引，函数返回后释放，不构成常驻内存增长。 */
  }
  const out = new Map();
  for (const [id, rec] of names) out.set(id, rec.name);
  return out;
}

/* 记录 → 待发布事件单元 [{key, item}]。key 含内容摘要，item 与 createLive().push 的形状一致。 */
function feedUnits(e, callNames) {
  if (!isRecordObject(e) || e.type === 'custom-title') return [];
  const raw = e.message;
  const msg = typeof raw === 'string' ? { content: raw } : raw;
  if (!isRecordObject(msg)) return [];
  /* 本地控制记录（/exit 命令与配对 stdout）不进事件流：不能一边隐藏会话，
     一边把控制 XML 当成普通任务/消息显示（复核 v2.43 #2）。 */
  if (controlRecord(e, msg)) return [];
  const base = baseIdentity(e);

  if (e.type === 'assistant') {
    if (typeof msg.content === 'string') {
      const text = msg.content.trim();
      return text ? [{ key: base + '|msg|' + contentDigest(text), item: { verb: 'review', name: text, kind: 'msg' } }] : [];
    }
    if (!Array.isArray(msg.content)) return [];
    const tools = [];
    let hasText = false;
    for (const b of msg.content) {
      if (!isRecordObject(b)) continue;
      if (b.type === 'tool_use') {
        const id = safeFieldString(b.id);
        const name = safeFieldString(b.name, '工具');
        if (!id || !name) continue;   // 归一化已诊断并降级；这里再兜一层，不生成坏身份事件
        // 一条消息里可能有多个工具调用：每个都是独立事件、独立内容版本
        tools.push({
          key: base + '|tool|' + contentDigest([id, name, b.input]),
          item: { verb: verbFor(name), name: safeToolLabel(name, b.input), kind: 'tool' },
        });
      } else if (b.type === 'text') hasText = true;
    }
    if (tools.length) return tools;
    if (!hasText) return [];
    const text = safeText(msg.content);
    return text ? [{ key: base + '|msg|' + contentDigest(text), item: { verb: 'review', name: text, kind: 'msg' } }] : [];
  }

  if (e.type === 'user') {
    if (typeof msg.content === 'string') {
      return [{ key: base + '|msg|' + contentDigest(msg.content), item: { verb: 'read', name: msg.content, kind: 'msg' } }];
    }
    // 同一条消息里可能有多条失败结果，每条独立内容版本；成功的 tool_result 不进任务流
    if (!Array.isArray(msg.content)) return [];
    const out = [];
    for (const b of msg.content) {
      if (!isRecordObject(b) || b.type !== 'tool_result' || !b.is_error) continue;
      const id = safeFieldString(b.tool_use_id);
      if (!id) continue;
      const tool = (callNames && callNames.get(id)) || '工具';
      const reason = shortReason(safeText(b.content));
      out.push({
        key: base + '|fail|' + contentDigest([id, b.content]),
        item: { verb: 'check', name: reason ? `${tool} · ${reason}` : `${tool} 失败`, kind: 'tool', ok: false },
      });
    }
    return out;
  }
  return [];
}

/* ---------------- 扫描 ---------------- */

export function create({ root, activeMs, live, io = { readdir, readFile, stat }, listIntervalMs = 5_000 }) {
  const cache = new Map();     // file -> {mtimeMs, size, session}
  let fileList = [];
  let listAt = 0;
  let reachable = false;
  let listStale = false;   // 目录暂时读不到时保留缓存，但标明数据可能已过期
  /* 本轮 readdir 的结果：清理缓存只允许动「成功读过的目录」，读失败目录下的缓存必须保留 */
  let okDirs = [];
  let badDirs = [];
  /* 本轮根目录成功列出的「确认存在的项目目录」：整个项目目录被删后它不会进 okDirs，得靠这份集合识别 */
  let presentDirs = [];
  /* 单文件读取失败（如 EACCES）：缓存保留，但整源要标为过期，直到成功重读或确认删除 */
  const badReads = new Set();
  /* stat 失败但无法确认「文件不存在」（EACCES/EPERM/IO）：既不能当删除，也不能当正常；
     成功 stat 或确认删除（ENOENT / 真删）后才清除 */
  const badStats = new Set();
  /* 解析质量下降（整份无可解析记录 / 文件内部完整坏行 / 已知载荷结构非法 / 单条折叠异常）：
     旧快照可用可解析记录更新，但整源必须标脏；只有读到干净快照、确认空文件或确认删除才清除
     （复核 v2.40 第 5 条 / v2.42 第 2 条） */
  const badParses = new Set();
  /* 本轮根目录 readdir 是否失败：失败时上一轮的 fileList 已不可信，不能拿它去 stat/清理 */
  let rootListFailed = false;

  /** 确认根目录本身被删除后，清掉该范围的全部缓存、故障记录、已发布进度与文件列表。 */
  function clearRootState() {
    cache.clear();
    badReads.clear(); badStats.clear(); badParses.clear();
    fileList = []; okDirs = []; badDirs = []; presentDirs = [];
    listStale = false;
  }
  /* 根目录 readdir 报 ENOENT/ENOTDIR 时不能一律当「确认删除」：盘符/挂载点整条消失、
     或父目录权限问题也会是同样错误。只有沿父链能 stat 到存在的目录（父目录还在、
     根本身没了）才算确认删除；父链不可用/不可读时按「暂时无法确认」保留缓存并标 stale。
     与 dsh.mjs 的 rootConfirmedGone 策略保持一致（复核 v2.43 #1）。 */
  async function rootConfirmedGone() {
    let p = dirname(root);
    for (let i = 0; i < 64; i++) {
      try { await io.stat(p); return true; }
      catch (err) {
        if (!err || err.code !== 'ENOENT') return false;   // EACCES/EPERM/IO：无法确认
        const up = dirname(p);
        if (up === p) return false;                        // 走到卷/文件系统根仍不存在：按整体不可用
        p = up;
      }
    }
    return false;
  }

  async function refreshFileList() {
    const now = Date.now();
    if (now - listAt < listIntervalMs) return false;   // 节流中：这轮不算"确知文件列表"
    listAt = now;
    const out = [];
    let projects = [];
    okDirs = []; badDirs = [];
    try { projects = await io.readdir(root, { withFileTypes: true }); reachable = true; rootListFailed = false; }
    catch (err) {
      reachable = false;
      rootListFailed = true;
      /* 确认删除才清缓存；无法确认（EACCES/设备不可用/父链不可读）保留旧快照并标脏。 */
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR') && await rootConfirmedGone()) {
        clearRootState();
        return false;
      }
      listStale = true;
      return false;
    }
    presentDirs = [];
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const dir = join(root, p.name);
      presentDirs.push(dir);
      let entries = [];
      try { entries = await io.readdir(dir, { withFileTypes: true }); okDirs.push(dir); }
      catch { badDirs.push(dir); continue; }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) out.push(join(dir, e.name));
      }
    }
    fileList = out;
    /* 只要有一个项目目录没读成，这份列表就不完整：整体标脏，等下一次全部读成才恢复 */
    listStale = badDirs.length > 0;
    return true;
  }

  /** 缓存文件属于哪个项目目录。Claude 布局是 <projects>/<工作区slug>/<会话>.jsonl，父目录即项目 */
  function workspaceOf(file) { return dirname(file); }

  async function scan(warmup) {
    const refreshed = await refreshFileList();
    /* 根本轮读不到时，上一轮 fileList 已不可信：不能拿旧列表逐个 stat/清理。
       实现在 refreshFileList 里已区分「确认删除」（清空）与「暂时不可用」（保留 + stale）；
       这里直接结束本轮，避免旧文件的 ENOENT 误删缓存（复核 v2.43 #1）。 */
    if (rootListFailed) return;
    const now = Date.now();
    const stale = [];
    for (const file of fileList) {
      let st;
      try { st = await io.stat(file); badStats.delete(file); }
      catch (err) {
        // 目录枚举成功、但单个文件 stat 失败：只有 ENOENT 才算确认删除，其它错误保留缓存并记脏
        if (err && err.code === 'ENOENT') {   // 确认删除：缓存与读取/解析失败记录一起退出
          cache.delete(file); badStats.delete(file); badReads.delete(file); badParses.delete(file);
        } else badStats.add(file);
        continue;
      }
      const hit = cache.get(file);
      const wasBusy = !!(hit && hit.session && (hit.session.current || hit.session.openStep != null));
      /* 文件被清空/重写后，不能只看 size 变小就在读取前把旧快照删掉：
         读取可能失败（EACCES 等），那时旧快照是页面上唯一可用的数据。
         变化与否只用来决定「要不要重读」；真正的缓存提交放在 decodeOne 读取/解析成功之后
         （复核 v2.40 第 4 条）。 */
      const changed = !!hit && (hit.size !== st.size || hit.mtimeMs !== st.mtimeMs);
      /* 已有读取/解析故障还在等恢复时，活跃过滤不能挡住重试（复核 v2.42 #4）。
         否则权限恢复、日志修好后，普通扫描会一直假定缓存仍健康，stale 永远挂着。 */
      const retrying = badReads.has(file) || badParses.has(file);
      if (now - st.mtimeMs > activeMs && !wasBusy && !changed && !retrying) { stale.push({ file, st }); continue; }
      await decodeOne(file, st);
    }
    if (warmup && stale.length) {
      stale.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      /* 预热最近 8 个：Claude 目录里常有「只有控制记录的 /exit 会话」占据最新几位，
         只预热 3 个会让真正有内容的会话读不到，大屏三个面板全空。 */
      for (const { file, st } of stale.slice(0, 8)) await decodeOne(file, st);
    }
    /* 文件被删掉后必须从缓存里清出去，否则那个会话会永远挂在墙上（还在"运行中"时更明显）。
       清理只在"确实成功列过目录"时进行，并按「缓存文件所属项目目录」判断：
         · 项目不在本轮 presentDirs → 整个项目目录已确认被删，删缓存（它不会出现在 okDirs 里）
         · 项目存在且 readdir 成功（okDirs）→ 没出现在本轮列表，就是单日志被删，删缓存
         · 项目存在但 readdir 失败（badDirs）→ 保留缓存，listStale 已标脏 */
    if (refreshed) {
      const seen = new Set(fileList);
      const present = new Set(presentDirs);
      const ok = new Set(okDirs);
      const confirmedGone = f => {
        const dir = workspaceOf(f);
        return !present.has(dir) || ok.has(dir);
      };
      /* 「确认删除」是缓存、读取故障、属性故障、解析故障共用的唯一清理判定：
         文件/项目目录已确认消失时一起清，否则 stale 会一直挂着；无法确认删除时全部保留。 */
      const forget = f => { cache.delete(f); badReads.delete(f); badStats.delete(f); badParses.delete(f); };
      for (const f of [...cache.keys()]) {
        if (seen.has(f) || !confirmedGone(f)) continue;
        forget(f);
      }
      // 读文件失败但还没进缓存的项也要在确认删除后清掉，否则 stale 会永远挂住
      for (const f of [...badReads]) {
        if (seen.has(f) || !confirmedGone(f)) continue;
        forget(f);
      }
      // 解析失败（读取成功但无可折叠记录 / foldSession 抛错）的项同样在确认删除后清掉
      for (const f of [...badParses]) {
        if (seen.has(f) || !confirmedGone(f)) continue;
        forget(f);
      }
      // stat 失败、但文件已确认被删（目录枚举成功且不再列出）→ 清掉，否则 stale 永远挂住
      for (const f of [...badStats]) {
        if (seen.has(f) || !confirmedGone(f)) continue;
        forget(f);
      }
    }
  }

  async function decodeOne(file, st) {
    const hit = cache.get(file);
    // 上次读取/解析失败的项要继续重试（否则权限恢复后永远等不到成功重读）
    if (hit && !badReads.has(file) && !badParses.has(file)
      && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return;

    let buf;
    try { buf = await io.readFile(file); badReads.delete(file); }
    /* 读取失败：保留旧快照和仍未恢复的解析故障（成功 readFile 也不能洗掉解析故障） */
    catch { badReads.add(file); return; }
    if (!buf.length) {   // 空文件 = 旧状态作废（只有确认清空才删，不能因为「变小」就删）
      cache.delete(file);
      badParses.delete(file);
      return;
    }

    const { records: events, badLines } = parseLines(buf);
    if (!events.length) {   // 读取成功但没有一条完整记录：显式标解析失败，保留旧快照
      badParses.add(file);
      return;
    }
    /* 已知类型的字段结构校验：null/数组/原始值/超深嵌套只降级单条记录并计故障；
       归一化本身失败视为整份不可继续 → 保留旧快照、标解析失败并登记重试（复核 v2.43 #3）。 */
    let fieldFaults = 0;
    let diagnostics = [];
    try {
      const norm = normalizeEvents(events);
      fieldFaults = norm.faults;
      diagnostics = norm.diagnostics;
    } catch { badParses.add(file); return; }

    const sid = basename(file).replace(/\.jsonl$/, '');
    let s;
    let foldFaults = 0;
    try {
      s = foldSession(sid, events, st.mtimeMs);
      foldFaults = Number(s.faults) || 0;
      delete s.faults;
    } catch { badParses.add(file); return; }   // 最后兜底：整份折叠失败标脏并保留旧快照，不影响其它会话
    /* 内部完整坏行 / 已知载荷结构非法 / 单条折叠或序列化失败 → 质量下降：
       可解析记录（含后续合法结束记录）照常折叠并提交快照，但必须标 stale；
       只有读到一份干净快照后才清除故障（复核 v2.42 #2）。 */
    const degraded = badLines > 0 || fieldFaults > 0 || foldFaults > 0;
    if (degraded) badParses.add(file); else badParses.delete(file);
    s.file = file;
    if (degraded) s.parseIssues = { badLines, fieldFaults, foldFaults, diagnostics };

    const prev = hit ? hit.session : null;
    /* 已发布进度按「事件单元身份 → 已发布次数」保存，不再用 seenSeq 当游标。
       行号在文件被替换/压缩后会整体错位：旧游标可能比新行数还大，事件循环整段跳过
       （复核 v2.41 第 4 条）。身份多重集只关心「这个事件单元以前发过没有」：
         · 普通追加：旧单元命中已发布集合 → 跳过；新单元 → 发布。
         · 全新替换：新历史与旧历史没有身份交集 → 按新记录发布，旧事件不会重推。
         · 同代前缀截断/压缩：留下的单元命中 → 跳过；真正新增的才发布。
         · 同一条消息里的多个工具/多条失败结果分别计数，改一个不会重发其它单元。 */
    const prevPublished = (hit && hit.published instanceof Map) ? hit.published : null;
    const shortName = trunc(s.title, 8);
    /* 工具名索引从整份权威调用记录重建（不依赖事件发布），且只作用于本文件/本会话。
       索引建立失败属于「无法继续」：保留旧快照并登记重试，不能把健康状态洗白。 */
    let callNames;
    try { callNames = sessionCallNames(events); } catch { badParses.add(file); return; }
    /* 首次读入（含缓存存在但没有已发布进度的情况）：只取最近 60 条记录发事件，
       不把整份旧历史当新事件；但所有事件单元都记为已发布，之后追加时旧内容不会重发。 */
    const initial = !prev || !prevPublished || prevPublished.size === 0;
    const emittedFrom = initial ? new Set(events.slice(-60)) : null;
    const occurrence = new Map();
    for (const e of events) {
      let units = [];
      try { units = feedUnits(e, callNames); } catch { continue; }   // 单条记录不能打断整轮
      for (const u of units) {
        const n = (occurrence.get(u.key) || 0) + 1;
        occurrence.set(u.key, n);
        if (!initial && n <= (prevPublished.get(u.key) || 0)) continue;
        if (initial && !emittedFrom.has(e)) continue;
        live.push(u.item, sid, shortName);
      }
    }
    /* 进度取「旧已发布 ∪ 本轮事件单元」每个身份的最大次数。
       不能裁剪：全量重读模式下文件里的历史仍会被再次读到，遗忘身份会把旧记录当新事件重推
       （复核 v2.42 #1）。内存上界≈该会话历史里的事件单元数，会话退出缓存时随 published 一起回收。 */
    const nextPublished = new Map(prevPublished || []);
    for (const [key, n] of occurrence) {
      if (n > (nextPublished.get(key) || 0)) nextPublished.set(key, n);
    }
    s.seenSeq = events.length;   // 保留行号供展示/兼容；不再作为事件游标

    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, session: s, published: nextPublished });
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
        // 已退出会话保留历史但不算运行中，避免「ended 与 running」矛盾
        running: ss.filter(s => !s.ended && (s.current || s.openStep != null)).length,
        files: fileList.length,
        stale: listStale || badReads.size > 0 || badParses.size > 0 || badStats.size > 0,   // 目录读不到 / 文件读、解析或 stat 失败时，缓存可能是旧的
      };
    },
  };
}
