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

/* R08：跨进程/换代稳定、不可逆的短标识（FNV-1a 双段），用于详情对象绑定；
   不使用显示编号（会被回收），也不用绝对路径。 */
function hashKey(str) {
  const s = String(str || '');
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 16777619);
    h2 ^= c + i; h2 = Math.imul(h2, 2246822519);
  }
  return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36));
}
export function stableSessionId(src, id) {
  return 's' + hashKey(String(src || '') + ':' + String(id || ''));
}

/** 工具调用的入参可能是 JSON 字符串，也可能已经是对象（Claude Code）。 */
function toolPick(name, args) {
  let a = args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  if (a && typeof a === 'object') {
    const pick = a.description || a.command || a.cmd || a.file_path || a.path
      || a.pattern || a.query || a.prompt || a.url || a.skill || a.name;
    if (pick) return String(pick);
  }
  // 不是 JSON：从 JS 片段里抠 cmd / command（Codex 的 exec 工具就是这样）
  const raw = typeof args === 'string' ? args : JSON.stringify(args || '');
  const m = /(?:cmd|command)\s*[:=]\s*(['"`])([\s\S]{1,120}?)\1/.exec(raw);
  if (m) return m[2];
  const arr = /(?:cmd|command)\s*[:=]\s*\[([\s\S]{1,160}?)\]/.exec(raw);
  if (arr) return arr[1].replace(/["'\\]/g, '').replace(/,/g, ' ');
  return name || 'tool';
}
/* R05：详情选择与列表摘要分离。Bash/shell 优先真实 command/cmd，文件工具优先目标路径，
   description 只作兜底，不能顶替实际命令。 */
function toolPickDetail(name, args) {
  let a = args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  const n = String(name || '').toLowerCase();
  const isFile = /^(read|write|edit|multiedit|notebookedit|apply_patch|str_replace|create_file)/.test(n);
  const isShell = /^(bash|shell|exec|command|terminal|run|zsh|sh|cmd|powershell)/.test(n);
  const cmdOf = o => (o.command != null ? o.command : o.cmd);
  const pathOf = o => (o.file_path != null ? o.file_path : o.path);
  if (a && typeof a === 'object') {
    if (isFile) { const p = pathOf(a); if (p != null) return String(p); }
    if (isShell) { const c = cmdOf(a); if (c != null) return typeof c === 'string' ? c : JSON.stringify(c); }
    const c = cmdOf(a); if (c != null) return typeof c === 'string' ? c : JSON.stringify(c);
    const p = pathOf(a); if (p != null) return String(p);
    const d = a.description; if (d != null) return String(d);
    const pick = a.pattern || a.query || a.prompt || a.url || a.skill || a.name;
    if (pick != null) return String(pick);
  }
  return toolPick(name, args);
}
const clipTo = (s, max) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};
export function toolLabel(name, args) {
  return clipTo(toolPick(name, args), 34);
}
/** R05：详情用完整命令/目标（受控上限），列表仍用 toolLabel 的 34 字摘要。 */
export function toolDetail(name, args, max = 240) {
  return clipTo(toolPickDetail(name, args), Math.max(40, Number(max) || 240));
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
      src: item.src || '',   // 事件来源：合并视图靠它归属编号，不再靠"遍历所有源找同 id"
    });
    if (feed.length > 400) feed.splice(0, feed.length - 400);
  }

  return {
    push,
    // 返回**最早**的待取事件：如果积压超过上限，先给旧的，前端下次再来取剩下的，不会漏
      since: after => feed.filter(e => e.seq > after).slice(0, 200),
      /* 缓存只留最近 400 条。前端从更老的游标来要数据时，这里能告诉它「中间断了一段」，
         避免界面把残缺的事件流当成完整流。 */
      backlog: () => ({
        oldest: feed.length ? feed[0].seq : 0,
        newest: feed.length ? feed[feed.length - 1].seq : 0,
        count: feed.length,
      }),
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
 *  不用哈希 —— 12 个会话哈希到 90 个桶里撞车概率接近一半。
 *  bridge 会校验 MAX_AGENTS ≤ 99；这里仍保留到 999 的兜底容量，
 *  超过容量直接报错，绝不返回一个已经用过的编号。 */
export function createCodes() {
  const map = new Map(), used = new Set();
  const CAP = 999;   // 两位编号用尽后自然扩展为三位，保证唯一；再满就明确失败
  return {
    for(key) {
      const have = map.get(key);
      if (have) return have;
      for (let i = 1; i <= CAP; i++) {
        const c = pad(i);
        if (!used.has(c)) { map.set(key, c); used.add(c); return c; }
      }
      throw new Error(`上墙编号容量耗尽（最多 ${CAP} 个）`);
    },
    release(keepKeys) {
      for (const [k, c] of [...map]) if (!keepKeys.has(k)) { used.delete(c); map.delete(k); }
    },
    get(key) { return map.get(key) || ''; },
  };
}

/* ---------------------------------------------------------------- 工作区 key */

/** 规范化工作区路径：分隔符统一、去掉末尾斜杠。
 *  大小写只在 Windows / UNC 路径上折叠 —— Linux 是大小写敏感的，
 *  /home/dev/Project 和 /home/dev/project 是两个不同工作区，不能合并。
 *  前端和 bridge 都用这个函数，保证 state.workflows[].key 与事件 workspace 同值。 */
export function normDir(d) {
  const raw = String(d || 'unknown');
  /* UNC 必须在合并分隔符之前判断：\\srv\share 的两条反斜杠会被合并成一个斜杠，
     先合并再判断 /^\/\// 永远不成立，UNC 路径就会被当成 Linux 处理（大小写不折叠）。 */
  const winLike = /^[a-zA-Z]:[\\/]/.test(raw)   // C:\ 或 C:/
    || /^\\\\/.test(raw)                         // \\server\\share
    || /^\/\//.test(raw);                        // //server/share
  const s = raw.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  if (!s) return 'unknown';
  return winLike ? s.toLowerCase() : s;
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
  // 刚发消息、还没工具调用的会话也算有内容（SQLite 里 turns 可能还是 0）；
  // 已退出会话即使只有控制记录、没有可展示内容，也要保留为空闲节点/静态连线。
  const meaningful = s => s.ended || s.calls.length > 0 || s.todos.length > 0 || s.turns > 0 || s.msgs.length > 0;
  // 「有可展示内容」：用于判断墙上是否全是空节点（只有控制记录的 /exit 会话）
  const contentful = s => (Array.isArray(s.calls) && s.calls.length > 0)
    || (Number(s.turns) || 0) > 0
    || (Array.isArray(s.msgs) && s.msgs.length > 0)
    || (Array.isArray(s.snippets) && s.snippets.length > 0);
  /* 「正在跑」和「最近活跃」是两件事：前者看有没有没结束的调用/步骤，后者看 mtime。
     未结束调用即使不是 s.current（并行工具、源层历史裁剪漏掉 current 引用）也算忙：
     busy、currentTasks、agent 绑定与 task.cur 必须来自同一套候选集合。 */
  const runningKeys = new Set();
  for (const s of sessions) {
    if (s.ended) continue;
    if (s.openStep != null
      || (s.current && s.current.done !== true)
      || (Array.isArray(s.calls) && s.calls.some(c => c && c.done !== true))) runningKeys.add(keyOf(s));
  }
  const isRunning = s => runningKeys.has(keyOf(s));
  const busyRank = s => (isRunning(s) ? 1 : 0);
  const order = (a, b) => (busyRank(b) - busyRank(a)) || (b.mtime - a.mtime);

  /* 已退出会话（Claude Code /exit 等）与空闲会话一样保留节点和父子连线（右侧静态线不能删），
     但强制按空闲处理：不算忙碌、不产生当前/运行任务、没有流入效果。
     已退出会话不受活跃窗口限制（否则刚退出/旧会话就消失，线也被删掉），
     按最近活跃排序，超出上屏上限由 overflow 挡住；日志被确认删除后自然消失。 */
  let list = sessions.filter(s => (now - s.mtime < activeMs || isRunning(s) || s.ended) && meaningful(s)).sort(order);
  if (!list.length) list = sessions.filter(meaningful).sort(order).slice(0, 1);

  /* 墙上只有「空节点」（例如 Claude 刚 /exit、文件里只剩控制记录）时，用最近的
     有内容历史会话补位：面板（TASK FEED / 粒子 / 代码）不至于全空。
     补位会话按空闲处理：保留节点/静态线，但不算 busy、不产生运行任务、没有流入。
     只在「一个可展示会话都没有」时补，不改变正常活跃视图。 */
  const historyOnly = new Set();
  if (!list.some(contentful)) {
    const extras = sessions
      .filter(s => !list.includes(s) && contentful(s))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, Math.max(0, maxAgents - list.length));
    for (const s of extras) {
      historyOnly.add(keyOf(s));
      runningKeys.delete(keyOf(s));   // 历史补位不算运行中
      list.push(s);
    }
    if (extras.length) list.sort(order);
  }

  const shown = list.slice(0, maxAgents);

  const shownKeys = new Set(shown.map(keyOf));
  codes.release(shownKeys);
  for (const s of shown) s.code = codes.for(keyOf(s));

  // 工作流 = 工作区。id 和下标一起给，前端两边都能对得上。
  /* 编号按「规范化后的工作区路径」排序分配，而不是按会话活跃度出现顺序。
     以前是谁先活跃谁排前面，活跃时间一变 W01/W02 就会互换，看起来像工作区错乱。 */
  /* 规范化工作区路径：实现见模块顶部的 normDir，前端/bridge 共用同一套 key。 */
  const dirKey = new Map();                        // 规范化 key → 原始 dir（显示用）
  // 用 list（全部活跃会话）而不是 shown（上墙的那 12 个），否则被上限挡住的工作区会消失
  for (const s of list) {
    const raw = s.cwd || 'unknown';
    const k = normDir(raw);
    if (!dirKey.has(k)) dirKey.set(k, raw);
  }
  const wfIndex = new Map();
  const workflows = [];
  [...dirKey.keys()].sort().forEach(k => {
    const i = workflows.length;
    const raw = dirKey.get(k);
    wfIndex.set(k, i);
    workflows.push({
      i,                                  // 下标（和 agents[].wf / tasks[].wf 同一套编号）
      id: 'W' + pad(i + 1),               // 稳定 ID，画面上显示这个
      key: k,                             // 规范化工作区 key：前端用它把事件 workspace 映射回工作区
      name: trunc(raw.split(/[\\/]/).filter(Boolean).pop() || raw, 12),
      // 悬浮提示用完整目录名（只给最后一段，不暴露绝对路径），节点标签仍然用截断的 name
      full: String(raw.split(/[\\/]/).filter(Boolean).pop() || raw),
      q: 0,
    });
  });

  const tasks = [];
  const agents = [];
  const wfStat = new Map();
  const currentTasks = [];   // 每个上墙智能体一条「当前代表任务」，先占位
  const activeTasks = [];    // 其余仍在运行的并行活动（不能被标成已结束）
  const historyTasks = [];   // 已结束历史，按剩余额度补
  const taskSeen = new Set(); // 同一条调用/同一条 todo 只入列一次
  let currentOmitted = 0;     // 预算连当前代表任务都放不下时，如实报数

  /* 调用的统一结果：结束 ≠ 成功。取消优先于迟到成功/失败 —— 已经确定的取消不能被迟到结果翻案。 */
  const outcomeOf = c => {
    if (!c || c.done !== true) return 'running';
    if (c.aborted === true) return 'cancelled';
    if (c.error === true) return 'failed';
    return 'success';
  };
  const STATE_OF = { running: 'run', success: 'done', failed: 'failed', cancelled: 'cancelled' };
  /* 任务进度来自阶段而不是完成百分比：对外给阶段标签 + indet 标记，前端只按标签展示 */
  const CALL_STAGE = { running: '工具调用中', success: '已完成', failed: '已失败', cancelled: '已取消' };
  const TODO_STAGE = { run: '待办进行中', done: '已完成', cancelled: '已取消', queued: '排队中' };
  const callKeyOf = (c, i) => String(c && c.callId != null ? c.callId : '#' + i);
  const startedAt = c => { const n = Number(c && c.start); return Number.isFinite(n) && n > 0 ? n : Infinity; };

  /* 工作区状态必须统计**所有活跃会话**，不能只统计上墙的那 maxAgents 个：
     否则被显示上限挡住的会话，它的失败/忙碌会从状态表里凭空消失。 */
  for (const s of list) {
    const wf = wfIndex.get(normDir(s.cwd)) ?? 0;
    const st = wfStat.get(wf) || { ok: 0, fail: 0, agents: 0, busy: 0, last: 0, lastFail: null };
    st.ok += s.done; st.fail += s.failed;
    st.agents++;
    if (isRunning(s)) st.busy++;
    const lastAct = s.lastTime || s.lastFail && s.lastFail.at || s.mtime || 0;
    if (lastAct > st.last) st.last = lastAct;
    if (s.lastFail && (!st.lastFail || (s.lastFail.at || 0) > (st.lastFail.at || 0))) st.lastFail = s.lastFail;
    wfStat.set(wf, st);
  }

  shown.forEach(s => {
    const code = s.code;
    /* 已退出会话 / 历史补位会话：保留节点/连线，但强制空闲，不产生运行任务 */
    const idleSession = !!s.ended || historyOnly.has(keyOf(s));
    const wf = wfIndex.get(normDir(s.cwd)) ?? 0;   // 用和编号时同一套规范化 key
    agents.push({
      code,
      name: trunc(s.title, 4) || code,
      title: trunc(s.title, 10) || code,
      // S03：详情用完整标题（受控上限），列表仍用截断名
      nameFull: trunc(s.title, 40) || code,
      titleFull: trunc(s.title, 120) || code,
      // R08：稳定会话身份（跨进程/换代不变），详情绑定不用可回收的显示编号
      sid: stableSessionId(s.src, s.id),
      depth: s.depth,
      wf,
      src: s.src || '',
      parent: s.parent ? (codes.get(`${s.src || ''}:${s.parent}`) || '') : '',
      // 是否有真实活动：预算极端时任务可能没展示，前端也不能把忙碌智能体画成空闲
      running: isRunning(s),
    });

    /* 工作区状态已经在上面按「所有活跃会话」统计过了，这里只负责上墙内容 */

    const k = keyOf(s);
    const calls = [];
    const seenCall = new Set();
    const addCall = (c, i) => {
      if (!c || typeof c !== 'object') return;
      const cid = callKeyOf(c, i);
      if (seenCall.has(cid)) return;
      seenCall.add(cid);
      calls.push({ c, cid });
    };
    if (Array.isArray(s.calls)) s.calls.forEach(addCall);
    /* s.current 可能指向被源层历史预算裁掉的调用（sources 的 calls.slice(-400)）：
       显式补回，保证「忙」一定有代表任务，不能只修展示层常数。 */
    if (s.current && typeof s.current === 'object') {
      const cid = callKeyOf(s.current, calls.length);
      if (!seenCall.has(cid)) { seenCall.add(cid); calls.push({ c: s.current, cid }); }
    }

    const mkCallTask = ({ c, cid }) => {
      let outcome = outcomeOf(c);
      /* 已退出的会话即使残留未闭合调用，也不能显示成运行中（没有流入效果）；
         统一按 cancelled 处理：节点/连线保留，但不产生 run 任务。 */
      if (idleSession && outcome === 'running') outcome = 'cancelled';
      const ended = outcome !== 'running';
      const since = Number(c.start);
      return {
        id: tid(k + ':call:' + cid),
        name: trunc(c.label || c.name || 'tool', 30),
        // S03：列表名保持截断，详情字段单独给完整名称；since 供「持续时间」计算
        nameFull: trunc(c.labelDetail || c.label || c.name || 'tool', 200),
        since: Number.isFinite(since) && since > 0 ? since : null,
        wf, state: STATE_OF[outcome], outcome,
        // 进度是阶段值，不是完成百分比：给阶段标签 + 不定进度标记，前端不得画成百分比
        stage: CALL_STAGE[outcome] || '调用中',
        indet: outcome === 'running',
        prog: ended ? 1 : 0.8, agent: code,
      };
    };
    const mineCur = [], mineActive = [], mineHistory = [];

    /* ① 当前代表任务：优先 s.current；否则在未结束的并行调用中按「开始时间最早、
          callId 字典序」稳定选一条 —— 不靠数组最后一项，也不因数组重排换代表。 */
    const active = idleSession ? [] : calls.filter(x => outcomeOf(x.c) === 'running');
    let rep = null;
    if (s.current && typeof s.current === 'object') {
      const curId = callKeyOf(s.current, 0);
      rep = active.find(x => x.cid === curId) || null;
    }
    if (!rep && active.length) {
      rep = active.slice().sort((a, b) =>
        (startedAt(a.c) - startedAt(b.c)) || (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0))[0];
    }
    if (rep) {
      const t = mkCallTask(rep);
      t.cur = true;   // 显式打标，前端只认这个，不再靠「最后一个 run」猜
      mineCur.push(t);
    }
    // 其他并行活动：仍然是运行中的子任务，保留 state=run，绝不混进历史被标结束
    for (const x of active) if (x !== rep) mineActive.push(mkCallTask(x));

    // 已结束的调用按结束时间倒序，历史预算优先保留最近的
    const endedCalls = calls.filter(x => outcomeOf(x.c) !== 'running')
      .sort((a, b) => (Number(b.c.end) || 0) - (Number(a.c.end) || 0));
    for (const x of endedCalls) mineHistory.push(mkCallTask(x));

    // ② 没有在跑的工具调用、但 step / turn 还没结束 → 模型正在推理（真实状态）
    if (!idleSession && !rep && s.openStep != null) {
      const label = `推理中 · step ${s.openStep % 1000}`;
      const t = { id: tid(k + ':step:' + s.openStep), name: label, nameFull: label, since: null, wf,
        state: 'run', outcome: 'running', stage: '推理中', indet: true,
        prog: 0.62, agent: code, cur: true };
      mineCur.push(t);
    }

    // ③ todo：主任务。会话已经结束回合（turnOpen === false 且没有未闭合调用/step）时，
    //    历史快照里的 in_progress 是过期状态，不能再显示成「运行中」。
    const turnClosed = s.turnOpen === false && !s.current && s.openStep == null;
    s.todos.forEach((td, i) => {
      const cancelled = td.status === 'cancelled' || td.status === 'aborted';
      const running = td.status === 'in_progress' && !turnClosed && !idleSession;
      const state = cancelled ? 'cancelled'
        : (td.status === 'completed' || td.status === 'done') ? 'done'
          : running ? 'run' : 'queued';
      const outcome = state === 'cancelled' ? 'cancelled'
        : state === 'done' ? 'success' : state === 'run' ? 'running' : 'queued';
      const t = { id: tid(k + ':todo:' + i), name: trunc(td.content, 30), nameFull: trunc(td.content, 200),
        since: null, wf, state, outcome,
        stage: TODO_STAGE[state] || '排队中', indet: state === 'run',
        prog: state === 'done' ? 1 : state === 'run' ? 0.55 : state === 'cancelled' ? 1 : 0.02, agent: code };
      // 未完成的 todo 属于并行活动，已结束/排队的进历史
      if (state === 'run') mineActive.push(t); else mineHistory.push(t);
    });

    const pushUnique = (dest, t) => {
      if (!t || taskSeen.has(t.id)) return;   // 去重 current 与历史引用，避免同调用重复入列
      taskSeen.add(t.id);
      dest.push(t);
    };
    for (const t of mineCur) pushUnique(currentTasks, t);
    for (const t of mineActive) pushUnique(activeTasks, t);
    for (const t of mineHistory) pushUnique(historyTasks, t);
  });

  /* 最终集合：先保每个上墙智能体的当前代表任务，再补并行活动，最后补历史。
     总数严格不超过 maxTasks；放不下的数量如实报出，不用越界输出「保护当前」，
     也不把没展示的活动项改标成已结束。 */
  const taskLimit = Number.isFinite(maxTasks) ? Math.max(0, Math.floor(maxTasks)) : 240;
  const picked = [];
  for (const t of currentTasks) {
    if (picked.length >= taskLimit) { currentOmitted++; continue; }
    picked.push(t);
  }
  let omittedActive = 0, omittedHistory = 0;
  for (const t of activeTasks) {
    if (picked.length >= taskLimit) { omittedActive++; continue; }
    picked.push(t);
  }
  for (const t of historyTasks) {
    if (picked.length >= taskLimit) { omittedHistory++; continue; }
    picked.push(t);
  }
  picked.forEach((t, i) => { t.i = i; tasks.push(t); });

  // 工作区成功率 = 原始工具调用无报错率；同时给出分子/分母，没有样本时明确为 null
  const STALL_MS = 5 * 60_000;
  for (const [i, b] of wfStat) {
    const wf = workflows[i];
    if (!wf) continue;
    const samples = b.ok + b.fail;
    wf.q = samples > 0 ? b.ok / samples : null;
    wf.ok = b.ok;
    wf.fail = b.fail;
    wf.samples = samples;
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
        // S03/R05：列表用适配器给的摘要，详情转发适配器保存的完整值（受控上限）
        toolFull: trunc(b.lastFail.name, 40),
        reasonFull: trunc(b.lastFail.reasonDetail || b.lastFail.reason || '', 240),
        detailFull: trunc(b.lastFail.labelDetail || b.lastFail.label || b.lastFail.name, 120),
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
      /* 成功/失败耗时环带只统计成功与失败：取消既不是成功也不是失败，不能画成成功耗时。
         duration 必须是有限非负值；异常时间不产生会骗人的 0ms / 负环带。 */
      const outcome = outcomeOf(c);
      const start = Number(c.start), end = Number(c.end);
      if (outcome !== 'running' && Number.isFinite(start) && Number.isFinite(end) && start > 0 && end >= start) {
        const ms = end - start;
        ringNums.push(ms);
        if (outcome === 'success' || outcome === 'failed') ringOps.push({ ms, ok: outcome === 'success' });
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
    /* 任务预算的省略情况：数量如实给出，供前端说明「还有多少没画」，
       不能把没展示的活动项混成已结束，也不能靠越界输出保当前任务。 */
    tasksOmitted: omittedActive + omittedHistory,
    tasksOmittedActive: omittedActive,
    tasksOmittedHistory: omittedHistory,
    currentOmitted,
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
