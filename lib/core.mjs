/**
 * 与数据源无关的公共层：
 *   - 小工具（截断、工具名 → 动作、文本提取、语言判定）
 *   - createLive  事件流 + 速率 + 动作分布（每个数据源一份）
 *   - createCodes 上墙编号分配（01..99，下墙回收）
 *   - buildState  把「折叠好的会话」聚合成大屏要的 state
 *
 * 所有数据源只要产出同样形状的 session，就能复用这一层。
 *
 * session 形状（sources/*.mjs 负责填）：
 *   { src, id, cwd, title, depth, parent, mtime, lastTime,
 *     turns, openStep, current,
 *     todos[], calls[], msgs[], snippets[], gaps[], done, failed, seenSeq }
 *   calls[]  : { callId, name, label, start, end, done, error, argBytes }
 *   snippets[]: { file, code, at }
 */

export const pad = (n, w = 2) => String(n).padStart(w, '0');

export const trunc = (s, n) => {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

export const cap = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

/* ---------------------------------------------------------------- 词表 */

const RE_READ = /^(read|grep|glob|ls|list|webfetch|websearch|notebookread|lsp.*)$/i;
const RE_BUILD = /^(write|edit|multiedit|notebookedit|apply_patch|create.*)$/i;
const RE_CHECK = /^(bash|pwsh|powershell|shell|exec|run|command|test|exec_command).*$/i;
const RE_REVIEW = /^(agent|task|todo|spawn.*|team.*|delegate|enterplanmode|exitplanmode|update_plan)$/i;

export function verbFor(toolName) {
  const n = String(toolName || '');
  if (RE_READ.test(n)) return 'read';
  if (RE_CHECK.test(n)) return 'check';
  if (RE_REVIEW.test(n)) return 'review';
  if (RE_BUILD.test(n)) return 'build';
  return 'build';
}

/** 工具调用的入参可能是 JSON 字符串，也可能已经是对象（Claude Code）。 */
export function toolLabel(name, args) {
  const clip = s => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > 34 ? t.slice(0, 33) + '…' : t;
  };
  let a = args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  if (a && typeof a === 'object') {
    const pick = a.description || a.command || a.cmd || a.file_path || a.path
      || a.pattern || a.query || a.prompt || a.url || a.skill || a.name;
    if (pick) return clip(pick);
  }
  // 不是 JSON：从 JS 片段里抠 cmd / command（Codex 的 exec 工具就是这样）
  const raw = typeof args === 'string' ? args : JSON.stringify(args || '');
  const m = /(?:cmd|command)\s*[:=]\s*(['"`])([\s\S]{1,120}?)\1/.exec(raw);
  if (m) return clip(m[2]);
  const arr = /(?:cmd|command)\s*[:=]\s*\[([\s\S]{1,160}?)\]/.exec(raw);
  if (arr) return clip(arr[1].replace(/["'\\]/g, '').replace(/,/g, ' '));
  return clip(name || 'tool');
}

/** 从各种 content 形状里取纯文本（字符串 / [{type,text}] / [{type,input_text}]…）。 */
export function textOf(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(c => c && c.text && /^(text|input_text|output_text)$/.test(String(c.type || 'text')))
    .map(c => String(c.text))
    .join(' ')
    .trim();
}

const LANG_BY_EXT = {
  py: 'py', js: 'js', mjs: 'js', cjs: 'js', ts: 'js', jsx: 'js', tsx: 'js', json: 'js',
  html: 'html', htm: 'html', css: 'html', md: 'text',
};
export function langOf(file) {
  const m = /\.([a-z0-9]+)$/i.exec(String(file || ''));
  return (m && LANG_BY_EXT[m[1].toLowerCase()]) || 'text';
}

/** 时间字段兼容：数字毫秒 / 秒 / ISO 字符串。 */
export function toMs(v) {
  if (typeof v === 'number' && isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : v;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

/* ---------------------------------------------------------------- 事件流 */

export function createLive() {
  const feed = [];
  const evtTimes = [];
  const verbWindow = [];
  let seq = 0;

  function push(item, sid, name) {
    evtTimes.push(Date.now());
    verbWindow.push(item.verb);
    if (verbWindow.length > 400) verbWindow.shift();
    if (evtTimes.length > 4000) evtTimes.shift();
    feed.push({
      seq: ++seq,
      verb: item.verb,
      task_name: trunc(item.name, 40),
      kind: item.kind || 'tool',
      ok: item.ok !== false,   // 失败事件会带 ok:false，前端据此让粒子回流
      sid: sid || '',
      name: name || '',
    });
    if (feed.length > 400) feed.splice(0, feed.length - 400);
  }

  return {
    push,
    // 返回**最早**的待取事件：如果积压超过上限，先给旧的，前端下次再来取剩下的，不会漏
    since: after => feed.filter(e => e.seq > after).slice(0, 200),
    rate() {
      const cut = Date.now() - 60_000;
      let n = 0;
      for (let i = evtTimes.length - 1; i >= 0 && evtTimes[i] > cut; i--) n++;
      return Number((n / 60).toFixed(2));
    },
    verbs() {
      const v = { read: 0, build: 0, check: 0, review: 0 };
      for (const x of verbWindow) if (x in v) v[x]++;
      return v;
    },
    get size() { return feed.length; },
  };
}

/* ---------------------------------------------------------------- 编号 */

/** 稳定的两位编号：按上墙顺序从 01 分配，下墙后回收。
 *  不用哈希 —— 12 个会话哈希到 90 个桶里撞车概率接近一半。 */
export function createCodes() {
  const map = new Map(), used = new Set();
  return {
    for(key) {
      const have = map.get(key);
      if (have) return have;
      for (let i = 1; i <= 99; i++) {
        const c = pad(i);
        if (!used.has(c)) { map.set(key, c); used.add(c); return c; }
      }
      return '99';
    },
    release(keepKeys) {
      for (const [k, c] of [...map]) if (!keepKeys.has(k)) { used.delete(c); map.delete(k); }
    },
    get(key) { return map.get(key) || ''; },
  };
}

/* ---------------------------------------------------------------- 聚合 */

/**
 * @param {object} o
 * @param {Array}  o.sessions   所有已折叠会话（含 src 字段）
 * @param {object} o.live       createLive() 的实例
 * @param {object} o.codes      createCodes() 的实例
 * @param {number} o.activeMs   超过这个时间没动过就不上墙（正在忙的例外）
 * @param {number} o.maxAgents
 * @param {number} o.maxTasks
 * @param {string} o.servedFrom
 * @param {string} o.source     当前数据源 id（"all" 表示合并）
 */
export function buildState(o) {
  const { sessions, live, codes, activeMs, maxAgents, maxTasks, servedFrom, source } = o;
  const now = Date.now();
  const keyOf = s => `${s.src || ''}:${s.id}`;
  const meaningful = s => s.calls.length > 0 || s.todos.length > 0 || s.turns > 0;
  /* 「正在跑」和「最近活跃」是两件事：前者看有没有没结束的调用/步骤，后者看 mtime */
  const isRunning = s => !!(s.current || s.openStep != null);
  const busyRank = s => (isRunning(s) ? 1 : 0);
  const order = (a, b) => (busyRank(b) - busyRank(a)) || (b.mtime - a.mtime);

  let list = sessions.filter(s => (now - s.mtime < activeMs || isRunning(s)) && meaningful(s)).sort(order);
  if (!list.length) list = sessions.filter(meaningful).sort(order).slice(0, 1);

  const shown = list.slice(0, maxAgents);

  const shownKeys = new Set(shown.map(keyOf));
  codes.release(shownKeys);
  for (const s of shown) s.code = codes.for(keyOf(s));

  // 工作流 = 工作区。id 和下标一起给，前端两边都能对得上。
  const wfIndex = new Map();
  const workflows = [];
  for (const s of shown) {
    const dir = s.cwd || 'unknown';
    if (!wfIndex.has(dir)) {
      const i = workflows.length;
      wfIndex.set(dir, i);
      workflows.push({
        i,                                  // 下标（和 agents[].wf / tasks[].wf 同一套编号）
        id: 'W' + pad(i + 1),               // 稳定 ID，画面上显示这个
        name: trunc(dir.split(/[\\/]/).filter(Boolean).pop() || dir, 12),
        q: 0,
      });
    }
  }

  const tasks = [];
  const agents = [];
  const wfStat = new Map();
  const currentTasks = [];   // 每个智能体一条「当前任务」，先占位
  const historyTasks = [];   // 其余历史任务，按剩余额度补

  shown.forEach(s => {
    const code = s.code;
    const wf = wfIndex.get(s.cwd || 'unknown') ?? 0;
    agents.push({
      code,
      name: trunc(s.title, 4) || code,
      title: trunc(s.title, 10) || code,
      depth: s.depth,
      wf,
      src: s.src || '',
      parent: s.parent ? (codes.get(`${s.src || ''}:${s.parent}`) || '') : '',
    });

    /* 工作区状态：谁在忙、失败多少、多久没进展 —— 大屏最重要的是让人一眼看出问题 */
    const st = wfStat.get(wf) || { ok: 0, fail: 0, agents: 0, busy: 0, last: 0, lastFail: null };
    st.ok += s.done; st.fail += s.failed;
    st.agents++;
    if (isRunning(s)) st.busy++;
    const lastAct = s.lastTime || s.lastFail && s.lastFail.at || s.mtime || 0;
    if (lastAct > st.last) st.last = lastAct;
    if (s.lastFail && (!st.lastFail || (s.lastFail.at || 0) > (st.lastFail.at || 0))) st.lastFail = s.lastFail;
    wfStat.set(wf, st);

    const k = keyOf(s);
    const mine = [];
    let cur = null;   // 显式指定：哪一条才是「当前任务」

    // ① todo：主任务
    s.todos.forEach((td, i) => {
      const state = (td.status === 'completed' || td.status === 'done') ? 'done'
        : td.status === 'in_progress' ? 'run' : 'queued';
      const prog = state === 'done' ? 1 : state === 'run' ? 0.55 : 0.02;
      mine.push({ id: tid(k + ':todo:' + i), name: trunc(td.content, 30), wf, state, prog, agent: code });
    });

    // ② 工具调用：子步骤。最后一个「还没结束」的才是当前任务（和 s.current 同义）
    for (const c of s.calls.slice(-24)) {
      const state = c.done ? 'done' : 'run';
      const t = { id: tid(k + ':call:' + c.callId), name: trunc(c.label, 30), wf, state, prog: c.done ? 1 : 0.8, agent: code };
      mine.push(t);
      if (!c.done) cur = t;
    }

    // ③ 没有在跑的工具调用、但 step / turn 还没结束 → 模型正在推理（真实状态）
    if (!s.current && s.openStep != null) {
      const t = { id: tid(k + ':step:' + s.openStep), name: `推理中 · step ${s.openStep % 1000}`, wf, state: 'run', prog: 0.62, agent: code };
      mine.push(t);
      cur = t;
    }

    // 显式打标，前端只认这个，不再靠「最后一个 run」猜
    if (cur) { cur.cur = true; currentTasks.push(cur); }
    for (const t of mine) if (t !== cur) historyTasks.push(t);
  });

  // 当前任务先全部入列，再用剩余额度补历史任务；总数严格不超过 maxTasks
  for (const t of currentTasks) { t.i = tasks.length; tasks.push(t); }
  for (const t of historyTasks) {
    if (tasks.length >= maxTasks) break;
    t.i = tasks.length;
    tasks.push(t);
  }

  // 工作区质检分 = 无报错率；同时补上「忙 / 失败 / 多久没进展」这些定位问题要用的字段
  const STALL_MS = 5 * 60_000;
  for (const [i, b] of wfStat) {
    const wf = workflows[i];
    if (!wf) continue;
    wf.q = Math.min(0.98, Math.max(0.5, 1 - b.fail / (b.ok + b.fail + 1)));
    wf.agents = b.agents;
    wf.busy = b.busy;
    wf.fails = b.fail;
    wf.idleMs = b.last ? Math.max(0, now - b.last) : null;
    wf.stalled = wf.idleMs != null && wf.idleMs > STALL_MS;
    wf.lastFail = b.lastFail
      ? {
        tool: trunc(b.lastFail.name, 10),                        // 哪个工具
        reason: trunc(b.lastFail.reason || '', 42),              // 真正的错误原因（优先展示）
        detail: trunc(b.lastFail.label || b.lastFail.name, 18),   // 兜底：失败目标 / 命令
        at: b.lastFail.at || null,
      }
      : null;
  }

  // Lead → 子智能体 的父子边
  const onWall = new Set(agents.map(a => a.code));
  const links = [];
  for (const a of agents) {
    if (a.parent && onWall.has(a.parent) && a.parent !== a.code) links.push({ from: a.parent, to: a.code });
  }

  // 真实代码片段（打字机面板）。只给文件名，不带绝对路径
  const snippets = [];
  for (const s of shown) {
    for (const sn of s.snippets) {
      const lines = sn.code.split('\n').slice(0, 40).map(l => (l.length > 120 ? l.slice(0, 119) + '…' : l));
      snippets.push({ at: sn.at, file: basenameOf(sn.file) || sn.file, lang: langOf(sn.file), start: 1, agent: s.code, lines });
    }
  }
  snippets.sort((a, b) => b.at - a.at);
  const recent = snippets.slice(0, 12);
  for (const sn of recent) delete sn.at;

  /* 旋转环带内容 */
  const ringGroups = [], ringOps = [], ringNums = [], ringSizes = [], ringStreaks = [];
  const junk = /^[`~_\-=*#>]{3,}$/;
  for (const s of shown) {
    for (const sn of s.snippets) {
      const lines = sn.code.split('\n').filter(l => l.trim() && !junk.test(l.trim())).map(l => cap(l, 34)).slice(0, 14);
      if (lines.length < 2) continue;
      ringGroups.push({ file: basenameOf(sn.file) || sn.file, lines });
      ringSizes.push(Buffer.byteLength(sn.code, 'utf8'));
    }
    for (const c of s.calls) {
      if (c.start && c.end) {
        const ms = Math.max(0, c.end - c.start);
        ringOps.push({ ms, ok: !c.error });
        ringNums.push(ms);
      }
      if (c.argBytes) ringSizes.push(c.argBytes);
    }
    for (const g of s.gaps) ringStreaks.push({ ms: g, ok: true });
  }
  if (!ringGroups.length) {
    const byTool = new Map();
    for (const s of shown) {
      for (const c of s.calls) {
        // 标签就是工具名的（比如 Codex 的 exec 抠不出命令）跳过，别把 "exec" 当内容
        if (!c.label || c.label === c.name) continue;
        if (!byTool.has(c.name)) byTool.set(c.name, []);
        byTool.get(c.name).push(cap(c.label, 34));
      }
    }
    for (const [name, arr] of byTool) if (arr.length >= 2) ringGroups.push({ file: name, lines: arr.slice(-14) });
  }

  return {
    tasks, agents, workflows, links, snippets: recent,
    overflow: Math.max(0, list.length - shown.length),
    active: list.length,
    rate: live ? live.rate() : 0,
    verbs: live ? live.verbs() : { read: 0, build: 0, check: 0, review: 0 },
    servedFrom,
    source,
    ring: {
      groups: ringGroups.slice(-24),
      ops: ringOps.slice(-40),
      nums: ringNums.slice(-160),
      sizes: ringSizes.slice(-160),
      streaks: ringStreaks.slice(-1400),
    },
  };
}

function basenameOf(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/* ---------------------------------------------------------------- 任务 id */

const taskIds = new Map();
let taskCounter = 0;
const TASK_ID_CAP = 20000;
const TASK_ID_PRUNE = 5000;

/** 稳定递增的任务编号。**绝不中途清空映射** —— 清了会让当次返回 undefined、之后又会重号。 */
export function tid(key) {
  // 超过容量时，从最老的开始淘汰（单次淘汰，不影响本次返回值的有效性）
  if (taskIds.size > TASK_ID_CAP) {
    let n = TASK_ID_PRUNE;
    for (const k of taskIds.keys()) { taskIds.delete(k); if (--n <= 0) break; }
  }
  let v = taskIds.get(key);
  if (!v) {
    taskCounter++;
    v = 'T-' + pad(taskCounter, 3);
    taskIds.set(key, v);
  }
  return v;
}
