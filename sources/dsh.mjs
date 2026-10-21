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
import { join, basename, dirname } from 'node:path';
import * as zlib from 'node:zlib';
import { trunc, toolLabel, verbFor, textOf } from '../lib/core.mjs';

/* zstd 解压需要 Node ≥ 23.8；低版本上 DSH 源自动标记为不可用，另外两个源照常工作 */
const zstd = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null;
export const needsZstd = true;

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/* 失败事件要能说清「哪个工具、什么原因」：工具名索引按会话作用域维护（见 create() 里的 callNames），
   这里只负责把错误输出截成一句短原因。 */
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

/* 异常载荷的字符串化/序列化可能抛 RangeError（深嵌套）或 TypeError（null）：
   单条记录边界内兜住，不能因为它把整份折叠交给外层 catch。 */
function safeText(v, fallback = '') {
  try { return v == null ? fallback : String(v); }
  catch { return fallback; }
}
/* 记录字段的可信归一化：非法对象（如 {"toString":null}）不能让整份 fold 抛错，
   记入诊断并降级该字段；合法后续记录继续处理（复核 v2.43 #3）。 */
function safeField(v, diag, fallback = '') {
  try { return v == null ? fallback : String(v); }
  catch { if (diag) diag.recordErrors++; return fallback; }
}
function safeToolLabel(name, args, diag) {
  try { return toolLabel(name, args); }
  catch {
    if (diag) diag.recordErrors++;
    const n = typeof name === 'string' ? name.trim() : '';
    return (n || 'tool').slice(0, 34);
  }
}
function argsBytes(args) {
  if (typeof args === 'string') return Buffer.byteLength(args, 'utf8');
  if (args == null) return 0;
  try { return Buffer.byteLength(JSON.stringify(args), 'utf8'); } catch { return -1; }
}

/* ---------------- 解码 ---------------- */

/* 只找「一帧 zstd 在哪里结束」，不解压：用来识别写了一半的尾帧。
   帧格式（RFC 8878）：magic → frame header（FHD/窗口/字典/内容长度）→ 若干 block → 可选 4 字节校验和。
   返回帧结束位置；数据没写完（正在追加）返回 -1；不是合法帧返回 -2。 */
function zstdFrameEnd(buf, start) {
  let p = start + ZSTD_MAGIC.length;
  if (p >= buf.length) return -1;                 // 只有魔数，帧头还没写
  const fhd = buf[p++];
  const fcsFlag = fhd >> 6;
  const single = (fhd >> 5) & 1;
  if ((fhd >> 3) & 1) return -2;                  // reserved 位：不是合法帧
  const checksum = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;
  if (!single) { if (p >= buf.length) return -1; p += 1; }        // Window_Descriptor
  const dictSize = [0, 1, 2, 4][dictFlag];
  if (p + dictSize > buf.length) return -1;
  p += dictSize;
  const fcsSize = fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  if (p + fcsSize > buf.length) return -1;
  p += fcsSize;
  for (;;) {
    if (p + 3 > buf.length) return -1;            // Block_Header 没写完
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    p += 3;
    const last = h & 1, type = (h >> 1) & 3, size = h >>> 3;
    if (type === 3) return -2;                    // reserved block type
    const dataLen = type === 1 ? 1 : size;        // RLE 块只存 1 字节
    if (p + dataLen > buf.length) return -1;
    p += dataLen;
    if (last) break;
  }
  if (checksum) { if (p + 4 > buf.length) return -1; p += 4; }
  return p;
}

/** 把「拼接的 zstd 帧」逐帧解开，同时报告尾部是否还没写完。
 *  truncated=true 表示最后一段不是完整帧：这一轮的内容可能缺记录，不能当成完整快照替换缓存。 */
function decodeFrames(buf) {
  if (!zstd) return { text: '', truncated: false };   // 低版本 Node：整源已在 available() 里标记不可用
  const parts = [];
  let pos = 0, truncated = false;
  while (pos < buf.length) {
    const start = buf.indexOf(ZSTD_MAGIC, pos);
    if (start < 0) { truncated = true; break; }   // 尾部只剩没写完的魔数/半帧
    if (start > pos) pos = start;                 // 帧间杂质（正常日志没有）跳过
    const end = zstdFrameEnd(buf, start);
    if (end < 0) { truncated = true; break; }     // 帧头/块/校验和没写完，或帧损坏
    let piece;
    try { piece = zstd(buf.subarray(start, end)).toString('utf8'); }
    catch { truncated = true; break; }            // 边界合法却解不开：按不完整处理，保留旧快照
    parts.push(piece);
    pos = end;
  }
  return { text: parts.join(''), truncated };
}

/** 解码文本 → 记录 + 坏行诊断。
 *  truncated 只表示 zstd 帧不完整；badLines 是「文件内部完整坏行」数；
 *  tailIgnored 表示最后一段没有换行、还没写完（追加写入的残行）：可以忽略，不算故障。 */
function parseSession(buf) {
  const isZstd = buf.subarray(0, 4).equals(ZSTD_MAGIC);
  const decoded = isZstd ? decodeFrames(buf) : { text: buf.toString('utf8'), truncated: false };
  const events = [];
  let badLines = 0, tailIgnored = false;
  const lines = decoded.text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    /* 只有最后一段（文本不以换行结束）才可能是「写了一半的尾行」；其余都是完整行，
       解析失败说明文件内部已经损坏，必须计入诊断，不能再静默当健康。 */
    const isTail = i === lines.length - 1;
    try {
      const v = JSON.parse(l);
      if (v && typeof v === 'object' && !Array.isArray(v)) events.push(v);   // null/数字/数组不算记录
    } catch {
      if (isTail) tailIgnored = true;
      else badLines++;
    }
  }
  return { events, truncated: decoded.truncated, badLines, tailIgnored };
}

/* ---------------- 折叠 ---------------- */

function foldSession(id, events, mtime, diag) {
  diag = diag || { recordErrors: 0, badPayloads: 0 };
  const s = {
    src: 'dsh', id, cwd: '', title: '', depth: 0, parent: '', origin: 'user', mtime,
    turns: 0, openStep: null, lastTime: 0, turnOpen: null,
    todos: [], calls: [], msgs: [], snippets: [], gaps: [], current: null, lastFail: null,
    done: 0, failed: 0, seenSeq: 0,
  };
  const open = new Map();
  let prevT = 0;

  /* 回合终态（turn/end、turn/aborted）：本回合还没收到结果的调用作废。
     标记 done+aborted 但**不计**成功/失败，也不把未完成的写文件放进代码片段；
     清空 open 与 openStep，否则残留调用会被当成「仍在运行」，还会挡住 core 的 todo 降级。
     迟到的 tool/result 找不到 open 里的调用，因此不会把已作废调用翻成成功。 */
  function closeTurn(t, aborted) {
    for (const c of open.values()) { c.done = true; c.end = t; c.aborted = true; }
    open.clear();
    s.openStep = null;
    s.turnOpen = false;
    if (aborted) s.aborted = (s.aborted || 0) + 1;
  }

  for (const e of events) {
    /* 单条记录边界隔离：个别记录的字段/序列化异常只跳过这一条并记诊断，
       后续记录（尤其是 turn/end）仍要处理；不能把整份日志交给外层 catch 丢弃。 */
    try {
      const d = (e.data && typeof e.data === 'object') ? e.data : e;
      const t = Number(e.time) || 0;
      if (t > s.lastTime) s.lastTime = t;
      if (prevT && t > prevT) s.gaps.push(Math.min(600_000, t - prevT));
      if (t) prevT = t;
      switch (e.type) {
        case 'session':
          if (d.cwd) s.cwd = safeField(d.cwd, diag);
          s.depth = Number(d.delegationDepth) || 0;
          if (d.parentSession) s.parent = safeField(d.parentSession, diag);
          if (d.origin) s.origin = safeField(d.origin, diag);
          break;
        case 'session/title':
          if (d.title) s.title = safeField(d.title, diag);
          break;
        case 'turn/start': s.turns++; s.turnOpen = true; break;
        case 'turn/end': closeTurn(t, false); break;
        case 'turn/aborted': closeTurn(t, true); break;
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
        case 'todo/write': {
          /* 记录边界校验：todos 里的 null / 非对象成员只丢这一项，合法项保留。
             不能让它抛错把整份 fold 交给外层 catch —— 否则后面的 turn/end 被一起跳过，
             页面会一直显示旧的运行状态（复核 v2.39 第 2 条）。 */
          const list = Array.isArray(d.todos) ? d.todos : [];
          s.todos = list
            .filter(x => x && typeof x === 'object' && !Array.isArray(x))
            .map(x => ({ content: safeField(x.content, diag), status: safeField(x.status, diag, 'pending') || 'pending' }));
          break;
        }
        case 'tool/call': {
          const name = safeField(d.name, diag, '') || 'tool';
          const c = {
            callId: safeField(d.callId, diag), name,
            label: safeToolLabel(d.name, d.arguments, diag), start: t, end: 0, done: false, error: false,
            argBytes: argsBytes(d.arguments),
          };
          s.calls.push(c);
          if (c.callId) open.set(c.callId, c);
          if (/^(write|edit|multiedit)$/i.test(name)) {
            /* Write/Edit 的 arguments 解析成功后还必须是对象：null/数组/原始值（"null"、"[1]"、42）
               不能拿去访问字段，否则会抛 TypeError 把后面的 turn/end 一起丢掉。 */
            let a = {};
            if (typeof d.arguments === 'string') {
              try { a = JSON.parse(d.arguments); } catch { /* 不是 JSON：保持旧口径，不据此判坏 */ }
            } else if (d.arguments && typeof d.arguments === 'object') {
              a = d.arguments;
            }
            if (!a || typeof a !== 'object' || Array.isArray(a)) {
              diag.badPayloads++;   // 可解析但结构不可用：记质量下降，跳过展示派生后继续
              a = {};
            }
            const code = typeof a.content === 'string' ? a.content
              : typeof a.new_string === 'string' ? a.new_string : '';
            const file = typeof a.file_path === 'string' ? a.file_path
              : typeof a.path === 'string' ? a.path : 'untitled';
            // 先挂在调用上，调用成功后オ入列（失败的写文件不能算写入）
            if (code.trim()) c.snippet = { file, code, at: t };
          }
          break;
        }
        case 'tool/result': {
          const key = safeText(d.toolCallId || (d.message && d.message.toolCallId) || '');
          const c = open.get(key);
          if (c) {
            c.done = true; c.end = t; c.error = !!(d.message && d.message.isError);
            if (c.error) {
              // 把错误输出本身抠成一句短原因，别只留个工具名
              c.reason = shortReason(textOf(d.message && d.message.content));
              s.failed++;
              s.lastFail = { name: c.name, label: c.label, reason: c.reason, at: c.end || t };
            } else { s.done++; if (c.snippet) s.snippets.push(c.snippet); }
            open.delete(key);
          }
          break;
        }
        default: break;
      }
    } catch {
      /* 单条记录失败：记诊断并继续，不能把同一文件后面的合法结束记录一起丢掉 */
      diag.recordErrors++;
    }
  }
  s.current = [...open.values()].pop() || null;
  if (!s.title) s.title = s.cwd ? basename(s.cwd) : id.slice(-8);
  /* 裁剪历史调用时必须保护未结束活动和当前调用（复核 v2.43 #10）：
     只截断已完成的历史，不能把「正在跑」的 c0 从 400 条尾部里挤掉。 */
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

/* ---------------- 历史身份 ---------------- */

/* 同一份历史在普通/压缩两种格式间迁移时 seq/type/time 不变；日志换代后通常整体不同。
   只比这三个字段、不比 data 内容：内容修订不改变记录身份（身份用于判断进度能否沿用）。 */
function eventIdentity(e) {
  return `${Number(e.seq) || 0}|${safeText(e.type)}|${Number(e.time) || 0}`;
}

/* 身份集合只留首尾各 24 条：能认出前缀相同的短副本，也不把整份日志的字符串都留在内存里。 */
const IDS_KEEP = 24;
function eventIdentities(events) {
  const picked = events.length <= IDS_KEEP * 2
    ? events
    : [...events.slice(0, IDS_KEEP), ...events.slice(-IDS_KEEP)];
  return new Set(picked.map(eventIdentity));
}

/** 两份历史有没有交集：同代日志的短副本/完整副本会有相同的记录身份。 */
function sharesHistory(a, b) {
  if (!a || !b || !a.size || !b.size) return false;
  for (const id of b) if (a.has(id)) return true;
  return false;
}

/** 事件 → 任务流的一行。对话优先用真实消息文本，工具调用用真实入参。
 *  names：当前会话作用域的 callId → 工具名索引；失败结果的工具名只能来自同一会话的调用记录。 */
function eventToFeed(e, names) {
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
      // 工具名索引在 decodeOne 里按会话从全部 tool/call 记录维护，展示时只算标签，不再写全局表
      return { verb: verbFor(d.name), name: safeToolLabel(d.name, d.arguments, null), kind: 'tool' };
    // 只有失败才单独产出一条事件：失败的调用要能在任务流和粒子里看出来
    case 'tool/result': {
      if (!(d.message && d.message.isError)) return null;
      const key = safeText(d.toolCallId || (d.message && d.message.toolCallId) || '');
      const tool = (names && names.get(key)) || '工具';
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

export function create({ root, activeMs, live, io = { readdir, readFile, stat }, listIntervalMs = 5_000 }) {
  const cache = new Map();
  /* 同一会话目录的两种存储格式：逻辑上是同一份会话，永远只保留一个当前快照 */
  const CANDIDATES = ['session.v4.jsonl.zstd', 'session.v4.jsonl'];
  const siblingsOf = file => {
    const dir = dirname(file), name = basename(file);
    return CANDIDATES.filter(n => n !== name).map(n => join(dir, n));
  };
  /* 事件进度按「逻辑会话」（会话目录）保存：两种格式切换后新文件没有缓存命中时沿用，
     相同历史就不会被当成新会话再预热一遍（复核 v2.39 第 4 条）。 */
  const logicalSeen = new Map();   // 会话目录 -> 已发最大 seq
  /* 会话目录 -> 最近一次提交的事件身份集合：用来区分「更短的同一代副本」和「换代日志」 */
  const logicalIds = new Map();
  /* 本轮新格式读取/解析失败时，临时保护同目录的旧格式快照，别让本轮清理把它当成「已删除」 */
  let keepOld = new Set();
  let fileList = [];
  let fileListAt = 0;
  let reachable = false;
  let listStale = false;   // 目录暂时读不到时保留缓存，但标明数据可能已过期
  /* 本轮 readdir 的结果：清理缓存只允许动「成功读过的目录」，读失败目录下的缓存必须保留 */
  let okDirs = [];
  let badDirs = [];
  /* 本轮根目录成功列出的「确认存在的工作区目录」：整个工作区被删后它不会进 okDirs，得靠这份集合识别 */
  let presentDirs = [];
  /* 单文件读取失败（如 EACCES）：缓存保留，但整源要标为过期，直到成功重读或确认删除 */
  const badReads = new Set();
  /* 读取成功但没有可折叠记录（解析失败）：保留旧快照并标脏，直到读到完整记录 */
  const badParses = new Set();
  /* 尾帧还没写完（读取时正好半帧）：旧快照与事件进度都保留，标 stale，等补齐后重读 */
  const badPartial = new Set();
  /* stat 失败但无法确认「文件不存在」（EACCES/EPERM/IO）：既不能当删除，也不能当正常；
     成功 stat 或确认删除（ENOENT / 目录已删）后才清除 */
  const badStats = new Set();
  /* 解析/字段质量故障：内部完整坏行、已知载荷结构不可用、单条记录或序列化异常。
     与会阻塞提交的 badParses 不同，这里快照仍按可解析记录提交，但必须保持 stale，
     直到重新解析确认干净；成功的 readFile/stat 不能清除它（复核 v2.38 第 2 条）。 */
  const badRecords = new Set();
  /* 本轮 refresh 里 stat 失败、无法确认存在与否的候选：成功采用另一格式时不能顺手把它的故障洗掉 */
  let statFaultsRound = new Set();
  /* 本轮成功列出的会话目录：用来区分「stat 读不到」还是「会话目录已被删除」 */
  let listedSids = new Set();
  /* 本轮根目录 readdir 是否失败：失败时上一轮的 fileList 已不可信，不能拿它去 stat/读取 */
  let rootListFailed = false;
  /* 工具名索引按会话作用域维护：key = 会话目录（含工作区，避免跨会话同 callId 串名），
     value = callId → 工具名。只从本份日志的权威 tool/call 记录维护，不依赖事件是否发布；
     超过上限时只淘汰本会话最旧的项，不整表 clear（复核 v2.38 第 8 条）。 */
  const CALL_NAMES_KEEP = 800;
  const callNames = new Map();

  /** 该文件是否还有需要保留的会话状态（缓存或任一故障记录）。 */
  function trackedFile(f) {
    return cache.has(f) || badReads.has(f) || badStats.has(f)
      || badParses.has(f) || badPartial.has(f) || badRecords.has(f);
  }
  /** 会话目录已没有任何缓存/故障状态时才回收它的工具名索引（确认删除后的回收）。 */
  function releaseNamesIfGone(dir) {
    if (CANDIDATES.some(n => trackedFile(join(dir, n)))) return;
    callNames.delete(dir);
  }
  /** 确认根目录本身被删除后，清掉该范围的全部缓存、故障记录与事件进度。 */
  function clearRootState() {
    cache.clear();
    badReads.clear(); badStats.clear(); badParses.clear(); badPartial.clear(); badRecords.clear();
    logicalSeen.clear(); logicalIds.clear(); callNames.clear();
    keepOld = new Set();
    fileList = []; okDirs = []; badDirs = []; presentDirs = [];
    listedSids = new Set(); statFaultsRound = new Set();
  }
  /* 根目录 readdir 返回 ENOENT 时不能一律当「确认删除」：盘符/挂载点整条消失也会是 ENOENT。
     只有沿父链能 stat 到存在的目录（父目录还在、根本身没了）才算确认删除；
     父链也不存在或不可读时按「暂时无法确认」保留缓存并标 stale。
     已知限制：若挂载点父目录本身仍可见（常见 POSIX /mnt 场景），ENOENT 会被当成确认删除，
     缓存清空后在路径恢复时按全新目录重建（不会残留旧运行状态）。 */
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
    if (now - fileListAt < listIntervalMs) return false;   // 节流中：这轮不算"确知文件列表"
    fileListAt = now;
    const out = [];
    let wsDirs = [];
    okDirs = []; badDirs = []; listedSids = new Set();
    statFaultsRound = new Set();
    try {
      wsDirs = await io.readdir(root, { withFileTypes: true });
      reachable = true; rootListFailed = false;
    } catch (err) {
      reachable = false;
      rootListFailed = true;
      if (err && err.code === 'ENOENT' && await rootConfirmedGone()) {
        clearRootState();   // 明确 ENOENT 且父链可确认 → 清理该范围缓存、故障与事件进度
        listStale = false;
      } else {
        listStale = true;   // 暂时读不到 / 无法确认：保留缓存，等恢复
      }
      return false;
    }
    presentDirs = [];
    for (const ws of wsDirs) {
      if (!ws.isDirectory()) continue;
      const wsPath = join(root, ws.name);
      presentDirs.push(wsPath);
      let sids = [];
      try { sids = await io.readdir(wsPath, { withFileTypes: true }); okDirs.push(wsPath); }
      catch { badDirs.push(wsPath); continue; }
      for (const sd of sids) {
        if (!sd.isDirectory()) continue;
        const dir = join(wsPath, sd.name);
        listedSids.add(dir);
        const cands = CANDIDATES.map(f => join(dir, f));
        let found = '';
        for (const cand of cands) {
          try {
            await io.stat(cand);
            // 成功 stat 只证明「这个候选」可用：别的候选的失败记录不能被顺手清掉
            badStats.delete(cand);
            found = cand;
            break;
          } catch (err) {
            if (err && err.code === 'ENOENT') {
              // 确认不存在 → 清该候选的失败记录与缓存，格式切换后不留两个条目/重复会话
              badStats.delete(cand); cache.delete(cand); badReads.delete(cand); badParses.delete(cand);
              badPartial.delete(cand); badRecords.delete(cand);
              releaseNamesIfGone(dir);
              continue;
            }
            // EACCES/EPERM/IO：无法确认存在与否。记脏；低优先级候选可读也不能洗掉高优先级故障
            badStats.add(cand);
            statFaultsRound.add(cand);
            // 缓存里已有该优先格式的完整快照：本轮仍选它，让 scan/decodeOne 重试或失败，
            // 不要回退到低优先级文件、拿不完整内容覆盖快照
            if (cache.has(cand)) { found = cand; break; }
          }
        }
        if (found) out.push(found);
      }
    }
    /* 逻辑会话进度随目录生命周期作废：工作区已确认消失，或工作区可读但会话目录/日志已没了。
       工作区读失败时不能清（它的会话进度还要保留，等权限恢复后继续沿用）。 */
    const withFile = new Set(out.map(f => dirname(f)));
    const present = new Set(presentDirs), ok = new Set(okDirs);
    for (const d of [...logicalSeen.keys()]) {
      const ws = dirname(d);   // d 是会话目录：<root>/<ws>/<sid>
      if (!present.has(ws) || (ok.has(ws) && !withFile.has(d))) {
        logicalSeen.delete(d);
        logicalIds.delete(d);
      }
    }
    fileList = out;
    /* 只要有一个子目录没读成，这份列表就不完整：整体标脏，等下一次全部读成才恢复 */
    listStale = badDirs.length > 0;
    return true;
  }

  /** 缓存文件属于哪个工作区目录。DSH 布局是 <root>/<ws>/<sid>/session…，向上两层即工作区 */
  function workspaceOf(file) { return dirname(dirname(file)); }

  async function scan(warmup) {
    const refreshed = await refreshFileList();
    keepOld = new Set();   // 本轮新格式失败时临时保护旧快照，下一轮重新判定
    /* 根目录本轮列不出来时，上一轮的 fileList 已不可信：不能拿旧列表去 stat/读取，
       否则 ENOENT 会误删缓存（例如整条路径暂时不可用），EACCES 的保留策略也失去意义。 */
    if (rootListFailed) return;
    const now = Date.now();
    const stale = [];
    for (const file of fileList) {
      let st;
      try { st = await io.stat(file); badStats.delete(file); }
      catch (err) {
        // 列表里刚 stat 成功过、这里又失败：只有 ENOENT 才算确认删除，其它错误保留缓存并记脏
        if (err && err.code === 'ENOENT') { cache.delete(file); badStats.delete(file); }
        else {
          badStats.add(file);
          /* 新格式还没成功提交（枚举之后、解码之前 stat 就无法确认）：同目录旧格式的完整快照
             仍可能是页面唯一数据，本轮清理不能把它当成「已删除」（复核 v2.40 第 2 条）。 */
          for (const other of siblingsOf(file)) if (cache.has(other)) keepOld.add(other);
        }
        continue;
      }
      const hit = cache.get(file);
      /* 体积变小不在这里作废旧快照：读取成功后才知道是清空、有效截断还是读不到。
         读取失败时旧快照是唯一可用数据，必须留在缓存里（复核 v2.40 第 4 条）。 */
      const wasBusy = !!(hit && hit.session && (hit.session.current || hit.session.openStep != null));
      /* 活跃时间过滤只拦「从没读过、又确实很久没动」的文件，保留不主动读历史日志的性能策略；
         已有缓存只要 mtime/size 证明变过，或读取/解析/尾帧故障仍在等恢复，就必须重读，
         成功提交后再按新 mtime 决定活跃度（复核 v2.41 第 7 条）。
         限制：mtime 与 size 都没变的内容改写仅凭 stat 无法发现，不在本例外范围内。 */
      const changed = !!hit && (hit.mtimeMs !== st.mtimeMs || hit.size !== st.size);
      const retrying = badReads.has(file) || badParses.has(file) || badPartial.has(file)
        || badRecords.has(file);
      if (now - st.mtimeMs > activeMs && !wasBusy && !changed && !retrying) { stale.push({ file, st }); continue; }
      await decodeOne(file, st);
    }
    // 启动预热：一个活跃的都没有时，至少把最近 3 个会话读进来，别切过去是空白
    if (warmup && stale.length) {
      stale.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      for (const { file, st } of stale.slice(0, 3)) await decodeOne(file, st);
    }

    /* 文件被删掉后必须从缓存清出去，否则会话会永远挂在墙上。
       清理只在"确实成功列过目录"时进行，并按「缓存文件所属工作区」判断：
         · 工作区不在本轮 presentDirs → 整个工作区已确认被删，删缓存（它不会出现在 okDirs 里）
         · 工作区存在且 readdir 成功（okDirs）→ 没出现在本轮列表，就是单文件/单会话目录被删，删缓存
         · 工作区存在但 readdir 失败（badDirs）→ 保留缓存，listStale 已标脏 */
    if (refreshed) {
      const seen = new Set(fileList);
      const present = new Set(presentDirs);
      const ok = new Set(okDirs);
      const confirmedGone = f => {
        const ws = workspaceOf(f);
        return !present.has(ws) || ok.has(ws);
      };
      /* stat 失败但会话目录还在：文件可能仍在，只是读不到属性，不能按删除处理 */
      const statUnknown = f => badStats.has(f) && present.has(workspaceOf(f)) && listedSids.has(dirname(f));
      /* 「确认删除」是所有清理共用的唯一判定：缓存、badReads、badStats、badParses 一起清或一起留。
         stat 无法确认时（EACCES/EPERM/IO）即使本轮没列出该文件，也不代表它被删了；
         若只保护缓存却清掉读取/属性错误记录，组合故障（readFile 失败 → stat 失败）后 stale 会短暂误报为 false。
         本轮新格式失败时，keepOld 里的旧格式快照仍是唯一完整数据，也不能删。 */
      const forgettable = f => !keepOld.has(f) && !statUnknown(f) && confirmedGone(f);
      const forget = f => {
        cache.delete(f); badReads.delete(f); badStats.delete(f);
        badParses.delete(f); badPartial.delete(f); badRecords.delete(f);
        releaseNamesIfGone(dirname(f));
      };
      for (const f of [...cache.keys()]) {
        if (seen.has(f) || !forgettable(f)) continue;
        forget(f);
      }
      // 读文件失败但还没进缓存的项也要在确认删除后清掉，否则 stale 会永远挂住
      for (const f of [...badReads]) {
        if (seen.has(f) || !forgettable(f)) continue;
        forget(f);
      }
      // 解析失败（读取成功但无可折叠记录）的项同样在确认删除后清掉
      for (const f of [...badParses]) {
        if (seen.has(f) || !forgettable(f)) continue;
        forget(f);
      }
      // 质量故障（内部坏行/坏载荷/单条异常）同样只在确认删除后清，内容未恢复前保持 stale
      for (const f of [...badRecords]) {
        if (seen.has(f) || !forgettable(f)) continue;
        forget(f);
      }
      // 尾帧不完整的项也一样：补齐后由 decodeOne 重试，确认删除后才清
      for (const f of [...badPartial]) {
        if (seen.has(f) || !forgettable(f)) continue;
        forget(f);
      }
      // stat 无法确认、但会话目录（或整个工作区）已确认删除 → 不用再重试，否则 stale 永远挂住
      for (const f of [...badStats]) {
        if (seen.has(f) || !forgettable(f)) continue;
        forget(f);
      }
    }
  }

  async function decodeOne(file, st) {
    const hit = cache.get(file);
    // 上次读取/解析/尾帧/质量故障的项要继续重试（否则权限恢复或内容修好后永远等不到成功重读）
    if (hit && !badReads.has(file) && !badParses.has(file) && !badPartial.has(file)
      && !badRecords.has(file)
      && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return;

    /* 新格式读取/解析/尾帧不完整时，同目录旧格式的完整快照不能在本轮清理里被当成「已删除」。
       旧快照是页面上唯一可用的数据，必须留到新格式真正成功折叠为止。 */
    const protectOld = () => {
      for (const other of siblingsOf(file)) if (cache.has(other)) keepOld.add(other);
    };

    let buf;
    try { buf = await io.readFile(file); badReads.delete(file); }
    catch {
      badReads.add(file); badParses.delete(file);
      protectOld();
      return;
    }
    if (!buf.length) {   // 空文件 = 这份格式没有内容；旧格式快照仍可能是可用数据
      cache.delete(file);
      badParses.delete(file); badPartial.delete(file); badRecords.delete(file);
      protectOld();
      return;
    }
    const parsed = parseSession(buf);
    if (parsed.truncated) {
      /* 尾帧只写了一半：这份内容缺最后几条记录。提交会丢运行状态，还会把事件进度往前推，
         补齐后旧调用会被当成新事件重推（复核 v2.40 第 3 条）。
         旧快照和 seenSeq 原样保留，标 stale，等下一轮完整内容再提交。 */
      badPartial.add(file); badParses.delete(file);
      protectOld();
      return;
    }
    const events = parsed.events;
    if (!events.length) {   // 读取成功但没有完整记录：显式标为解析失败，保留旧快照
      badParses.add(file); badPartial.delete(file);
      protectOld();
      return;
    }
    badParses.delete(file); badPartial.delete(file);

    const sid = basename(join(file, '..'));
    const diag = { recordErrors: 0, badPayloads: 0 };
    let s;
    try { s = foldSession(sid, events, st.mtimeMs, diag); }
    catch { badParses.add(file); protectOld(); return; }   // 单份日志折叠失败不影响其它会话
    s.file = file;

    /* 工具名索引按会话作用域维护：key = 会话目录（工作区 + 会话 id），值 = callId → 工具名。
       从本份日志的全部 tool/call 记录建立，不依赖「这条调用这一轮是否需要发布事件」；
       跨会话同 callId 不会串名，超限只淘汰本会话最旧的项（复核 v2.38 第 8 条）。 */
    const ns = dirname(file);
    let names = callNames.get(ns);
    if (!names) { names = new Map(); callNames.set(ns, names); }
    for (const e of events) {
      try {
        if (e.type !== 'tool/call') continue;
        const d = (e.data && typeof e.data === 'object') ? e.data : e;
        const cid = safeText(d.callId || d.toolCallId || d.id || '');
        if (cid) names.set(cid, safeText(d.name, '') || 'tool');
      } catch { diag.recordErrors++; }
    }

    let ids;
    try { ids = eventIdentities(events); }
    catch { ids = new Set(); diag.recordErrors++; }

    /* 事件进度按逻辑会话迁移：同目录另一格式已折叠过时沿用它的 seenSeq（或上一轮记录），
       相同历史就不会重推；只有确认是换代日志才重置（复核 v2.39 第 4 条 / v2.40 第 3 条）。 */
    let base = hit ? hit.session : null;
    let baseIds = hit ? hit.ids : null;
    if (!base) for (const other of siblingsOf(file)) {
      const c = cache.get(other);
      if (c && c.session) { base = c.session; baseIds = c.ids; break; }
    }
    if (!base) {
      const seen = logicalSeen.get(dirname(file));
      if (seen) { base = { seenSeq: seen }; baseIds = logicalIds.get(dirname(file)); }
    }
    let from = base ? (Number(base.seenSeq) || 0) : 0;
    /* 先判代际、再算该代进度，不以「序号下降」作为启动前提（复核 v2.41 第 3 条）。
       同代：与上一份历史有共同事件身份（seq|type|time）——普通追加、同代更短副本、
       普通/压缩格式迁移都属于这一种，沿用高水位，短副本补齐前不倒退、不重推。
       换代：两份历史没有共同身份（cwd 相同也认），或缺少身份信息但会话 cwd 已经变了；
       新代进度从 0 重算，按新日志重新发布（与首次读入同一套尾部策略）。
       两端都没有身份信息时才保守沿用进度，宁可少发也不重推。
       限制：身份集合只保留首尾各 24 条，新副本若只剩旧日志的「中间段」且没有重叠会被
       当成换代（与上一版在 maxSeq 变小时的行为一致）；mtime/size 都不变的改写不会触发重读。 */
    let genChange = false;
    if (base) {
      const knownHistory = !!(baseIds && baseIds.size);
      if (knownHistory && sharesHistory(baseIds, ids)) {
        /* 同代：from 保持旧高水位；同代短副本（maxSeq 更小）也不会倒退 */
      } else if (knownHistory) {
        genChange = true;   // 历史无交集：换代（cwd 相同也认）
      } else if (base.cwd && s.cwd && base.cwd !== s.cwd) {
        genChange = true;   // 缺少身份信息时退回会话身份判断
      }
      /* 其余情况：没有身份信息、cwd 也没变 —— 保守沿用进度 */
    }
    if (genChange) { from = 0; base = null; }

    /* 同一会话目录只保留一个当前快照：新格式成功读取并完成折叠后，旧格式的缓存与
       读取/属性/解析/不完整故障记录直接退出，不要求旧格式再次成为候选（复核 v2.39 第 1 条）。
       本轮仍 stat 无法确认的另一格式例外：保留它的故障诊断，避免把 stale 洗掉。 */
    for (const other of siblingsOf(file)) {
      if (statFaultsRound.has(other)) continue;
      cache.delete(other); badReads.delete(other); badStats.delete(other);
      badParses.delete(other); badPartial.delete(other); badRecords.delete(other);
    }

    /* 发布：单条事件序列化失败只跳过这一条并记诊断，不能挡住同一批里其它事件与后续提交 */
    const batch = events.filter(e => (Number(e.seq) || 0) > from);
    const shortName = trunc(s.title, 8);
    const toFeed = e => {
      try { return eventToFeed(e, names); }
      catch { diag.recordErrors++; return null; }
    };
    if (base) {
      for (const e of batch) { const it = toFeed(e); if (it) live.push(it, sid, shortName); }
    } else {
      for (const it of batch.slice(-80).map(toFeed).filter(Boolean).slice(-10)) live.push(it, sid, shortName);
    }
    /* 索引超限只淘汰本会话最旧的项；放在发布之后，保证本批/迟到的结果事件先查到自己的工具名，
       再清理索引（不整表 clear，也不把正在等待结果的关联提前清掉）。 */
    while (names.size > CALL_NAMES_KEEP) names.delete(names.keys().next().value);
    s.seenSeq = batch.reduce((m, e) => Math.max(m, Number(e.seq) || 0), from);
    logicalSeen.set(dirname(file), s.seenSeq);
    logicalIds.set(dirname(file), ids);

    /* 解析健康：内部完整坏行、字段结构不可用、单条记录/序列化异常都算质量下降。
       快照仍按可解析记录提交，但必须保持 stale 直到重新解析确认干净；
       成功的 readFile/stat 不能清掉它（只有本函数走到这里且无诊断才清除）。 */
    const unhealthy = parsed.badLines > 0 || diag.recordErrors > 0 || diag.badPayloads > 0;
    if (unhealthy) badRecords.add(file); else badRecords.delete(file);
    s.parseIssues = {
      badLines: parsed.badLines, recordErrors: diag.recordErrors, badPayloads: diag.badPayloads,
    };

    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, session: s, ids });
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
        stale: listStale || badReads.size > 0 || badParses.size > 0 || badStats.size > 0
          || badPartial.size > 0 || badRecords.size > 0,
          // 目录读不到 / 文件读、解析、stat 失败、尾帧未完整或解析质量下降时，缓存/数据可能不完整
        // 诊断：内部完整坏行/坏载荷/单条记录异常的文件数；工具名索引按会话的规模（用于验证回收与阈值）
        parseFaults: badRecords.size,
        callIndexSessions: callNames.size,
        callIndexNames: [...callNames.values()].reduce((n, m) => n + m.size, 0),
      };
    },
  };
}
