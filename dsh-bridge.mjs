/**
 * Agent Ops 调度大屏 —— 多数据源桥。
 *
 * 支持三种来源，页面右上角可切换（也支持 ?source=codex 这种锁死写法）：
 *   dsh    DeepSeek Harness   ~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd
 *   codex  OpenAI Codex       ~/.codex/sessions/**、~/.codex/archived_sessions/**
 *   claude Claude Code        ~/.claude/projects/<工作区>/<sessionId>.jsonl
 *   all    以上合并
 *
 * 全部只读，不改任何工具的数据。
 *
 *   node dsh-bridge.mjs                    # http://127.0.0.1:8778
 *   PORT=9000 ACTIVE_MIN=120 node dsh-bridge.mjs
 *   SOURCE=codex node dsh-bridge.mjs       # 默认打开 codex
 *   OPEN=1 node dsh-bridge.mjs             # 服务就绪后自动打开浏览器
 *   TOKEN=xxx node dsh-bridge.mjs          # 给接口加访问令牌
 *   ALLOW_ORIGIN=https://a.com node dsh-bridge.mjs   # 允许跨域读取（默认不允许）
 *   DEBUG=1 node dsh-bridge.mjs            # 开 /api/agent-ops/debug
 *
 * 安全默认值：只监听 127.0.0.1；校验 Host/Origin，挡 DNS rebinding；
 * 不返回任何 CORS 头；调试接口默认关闭且不返回绝对路径。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, basename, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createLive, createCodes, buildState, normDir } from './lib/core.mjs';
import * as srcDsh from './sources/dsh.mjs';
import * as srcCodex from './sources/codex.mjs';
import * as srcClaude from './sources/claude.mjs';

/* 服务是从哪个目录起的 —— 页面永远用这个目录里的 index.html，容易搞混，所以到处报一下 */
const SERVED_DIR = process.cwd();
const SERVED_NAME = basename(SERVED_DIR);

/* ---------------- 配置校验 ---------------- */
/* 所有会改变行为的数字配置在这里集中校验。非法值必须明确报错退出，
   不能以空面板、重号或 NaN 继续跑；空字符串视为未设置（用默认值）。 */
function configFail(msg) {
  console.error('[bridge] 配置错误：' + msg);
  process.exit(1);
}
function rawEnv(name) {
  const v = process.env[name];
  return v === undefined || v === '' ? null : v;
}
function noSpace(name, raw) {
  if (raw !== raw.trim()) configFail(`${name}=${JSON.stringify(raw)} 不能带首尾空白`);
}
function readInt(name, def, min, max, note) {
  const raw = rawEnv(name);
  if (raw === null) return def;
  noSpace(name, raw);
  if (!/^\d+$/.test(raw)) configFail(`${name}=${JSON.stringify(raw)} 必须是整数（范围 ${min}..${max}）`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    configFail(`${name}=${JSON.stringify(raw)} 超出范围（${min}..${max}）${note ? '；' + note : ''}`);
  }
  return n;
}
function readPositiveNumber(name, def, min, max, note) {
  const raw = rawEnv(name);
  if (raw === null) return def;
  noSpace(name, raw);
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) {
    configFail(`${name}=${JSON.stringify(raw)} 必须是有限正数（范围 ${min}..${max}）`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    configFail(`${name}=${JSON.stringify(raw)} 超出范围（${min}..${max}）${note ? '；' + note : ''}`);
  }
  return n;
}

/* PORT=0 表示让系统分配，日志里必须使用实际监听端口 */
const PORT = readInt('PORT', 8778, 0, 65535);
/* 分钟；允许小数（自动化验证会用到 0.001），0 会让所有空闲会话瞬间消失，不接受 */
const ACTIVE_MIN = readPositiveNumber('ACTIVE_MIN', 45, 0.001, 525600, '单位是分钟，必须大于 0');
const ACTIVE_MS = ACTIVE_MIN * 60_000;
/* 编号方案是 01..99，上墙容量必须和编号容量一致，否则会出现重复编号 */
const MAX_AGENTS = readInt('MAX_AGENTS', 12, 1, 99, '编号只有 01..99，超过 99 会重号');
const MAX_TASKS = 240;
const WANT_SOURCE = String(process.env.SOURCE || '').trim();
const OPEN_BROWSER = process.env.OPEN === '1';

/* ---------------- 数据源 ---------------- */

const globalLive = createLive();   // all 模式用的大池子
/* 每个视图（dsh / codex / claude / all）各用一本编号。
   共用一本的话，查 A 源时会把 B 源释放掉，切回去编号就变空了。 */
const codeBooks = new Map();
const codesFor = id => {
  if (!codeBooks.has(id)) codeBooks.set(id, createCodes());
  return codeBooks.get(id);
};
/* 进程实例标识：后端一重启序号就从 1 开始，前端靠它判断该不该重置游标 */
const EPOCH = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
let defaultSource = 'dsh';

/* ---------------- 对外工作区身份 ---------------- */
/* 服务端内部仍用 core.normDir 的规范化路径做合并/排序，但普通接口不能出现绝对路径。
   对外只给进程级不透明 ID：同进程同目录同 ID、不同目录不同 ID，重启由 epoch 换代。
   纯内存随机映射：不写磁盘，也不是路径的无密钥哈希 / Base64 / 截断，无法从 ID 反推目录。 */
const WORKSPACE_IDS = new Map();       // 规范化目录 → ws:xxxxxxxxxxxxxxxx
const WORKSPACE_IDS_USED = new Set();  // 防随机碰撞（64 位随机，正常不会命中）
function opaqueWorkspace(dir) {
  const k = normDir(dir);
  /* 没有 cwd 的会话是「未知工作区」，不是绝对路径，保留原语义（前端显示未归属） */
  if (k === 'unknown') return 'unknown';
  let id = WORKSPACE_IDS.get(k);
  if (!id) {
    do { id = 'ws:' + randomBytes(8).toString('hex'); } while (WORKSPACE_IDS_USED.has(id));
    WORKSPACE_IDS_USED.add(id);
    WORKSPACE_IDS.set(k, id);
  }
  return id;
}

function makeEntry(mod, opts) {
  const live = createLive();
  const base = { live };
  const src = mod.create({ ...opts, live: base });
  /* 事件里带上来源：合并视图（source=all）靠它归属编号，否则只能按会话 id 猜，
     两个源撞了同一个 id 就会把事件算到别人头上。 */
  const sid0 = src.id;
  base.push = (item, sid, name) => {
    const it = { ...item, src: sid0 };
    live.push(it, sid, name);
    globalLive.push(it, sid, name);
  };
  return { src, live };
}

/* 环境变量里给的目录：支持 ~ 开头，支持用系统分隔符（Windows 是 ;）给多个 */
function expandDir(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  if (t === '~') return homedir();
  if (t.startsWith('~')) return join(homedir(), t.slice(1).replace(/^[\\/]+/, ''));
  return t;
}
function envDirs(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const list = raw.split(delimiter).map(expandDir).filter(Boolean);
  return list.length ? list : fallback;
}
function envPath(name, fallback) { return envDirs(name, [fallback])[0]; }

/* 扫描互斥：定时器 800ms 一跳，但一轮扫描可能比 800ms 还慢（日志大 / 磁盘忙）。
   不排队就会两轮并发读同一份文件，把同一批新事件各推一次 —— 表现为任务流重复、
   粒子密度虚高、事件速率翻倍。 */
/* 仅测试注入：BRIDGE_TEST_SCAN_FAULT=<源id>[:次数]，让该源前 N 次 scan 抛错，
   用来验证「顶层兜底不静默吞错 + 下轮能恢复」。未设置时完全不改变生产行为。 */
const TEST_SCAN_FAULT = (() => {
  const raw = String(process.env.BRIDGE_TEST_SCAN_FAULT || '').trim();
  if (!raw) return null;
  const m = /^([a-z0-9_-]+)(?::(\d+))?$/i.exec(raw);
  if (!m) return null;
  return { id: m[1], left: m[2] === undefined ? Infinity : Number(m[2]) };
})();

/** 扫描失败只记录错误类别（code / name），不记录可能含绝对路径的 message。 */
function scanErrorCategory(err) {
  const code = err && err.code;
  if (typeof code === 'string' && code) return code.slice(0, 40);
  const name = err && err.name;
  if (typeof name === 'string' && name) return name.slice(0, 40);
  return 'error';
}

function runScan(src, warmup) {
  if (src.__scanning) return null;
  src.__scanning = true;
  return Promise.resolve()
    .then(() => {
      if (TEST_SCAN_FAULT && TEST_SCAN_FAULT.id === src.id && TEST_SCAN_FAULT.left > 0) {
        TEST_SCAN_FAULT.left--;
        const injected = new Error('injected scan failure');
        injected.code = 'EINJECTEDTEST';
        throw injected;
      }
      return src.scan(warmup);
    })
    /* 顶层兜底不再静默：失败记到该源，sourceList 标降级；下一轮成功会自动清除。 */
    .then(() => {
      src.__scanFailure = null;
      /* R01：只有「完整可信」扫描成功才更新源级采集时间。stale（目录读不到、文件/解析失败、
         局部缺失）说明缓存可能不完整，不能算完整成功；HTTP 每次 fetch 成功更不能当采集时间。 */
      let st = null;
      try { st = src.stats(); } catch { st = null; }
      if (st && st.stale !== true) src.__lastFullSuccessAt = Date.now();
    })
    .catch(err => {
      src.__scanFailure = { at: Date.now(), source: src.id, category: scanErrorCategory(err) };
      src.__scanFailureCount = (src.__scanFailureCount || 0) + 1;
    })
    .finally(() => { src.__scanning = false; });
}

const entries = [
  makeEntry(srcDsh, { root: envPath('DSH_SESSIONS', join(homedir(), '.dsh', 'sessions')), activeMs: ACTIVE_MS }),
  makeEntry(srcCodex, {
    roots: envDirs('CODEX_SESSIONS', [
      join(homedir(), '.codex', 'sessions'),
      join(homedir(), '.codex', 'archived_sessions'),
    ]),
    activeMs: ACTIVE_MS,
  }),
  makeEntry(srcClaude, { root: envPath('CLAUDE_PROJECTS', join(homedir(), '.claude', 'projects')), activeMs: ACTIVE_MS }),
];

const byId = new Map(entries.map(e => [e.src.id, e]));

/** @param {boolean} withPath 只有调试接口才给绝对路径 */
function sourceInfo(withPath) {
  return entries.map(({ src }) => {
    const available = src.available();
      let st;
      try { st = src.stats(); } catch { st = { sessions: 0, active: 0, files: 0 }; }
    const o = {
      id: src.id, name: src.name, note: src.note,
      available: st.sessions > 0 ? true : available,
      sessions: st.sessions, active: st.active, running: st.running || 0, files: st.files,
      stale: !!st.stale,   // 目录暂时读不到时缓存可能是旧的，前端可据此提示
      /* 本轮扫描在顶层抛错（不是源自己报告的 stale）：普通接口也要能看出"这不是健康"。
         只在内存里记错误类别/时间/来源，不含异常 message，避免把绝对路径带出去。 */
      degraded: !!src.__scanFailure,   // 下轮成功自动清除
      /* R01：该源最近一次「完整可信」扫描成功的时间（毫秒）。从未完整成功时为 null；
         前端据此算缓存年龄，不能用每次 HTTP state 的快照时间代替。 */
      lastFullSuccessAt: src.__lastFullSuccessAt || null,
    };
    if (src.__scanFailure) {
      o.unexpectedScanFailure = {
        at: src.__scanFailure.at, source: src.__scanFailure.source, category: src.__scanFailure.category,
      };
      o.scanFailureCount = src.__scanFailureCount || 1;
    }
    if (withPath) o.path = src.path;
    return o;
  });
}

function pickSource(requested) {
  const want = String(requested || '').trim();
  if (want === 'all') return 'all';
  if (want && byId.has(want)) return want;
  return defaultSource;
}

function stateFor(sourceId) {
  const list = sourceId === 'all' ? entries.map(e => e.src) : [byId.get(sourceId).src];
  const sessions = [];
  for (const s of list) sessions.push(...s.sessions());
  const live = sourceId === 'all' ? globalLive : byId.get(sourceId).live;
  const st = buildState({
    sessions, live, codes: codesFor(sourceId),
    activeMs: ACTIVE_MS, maxAgents: MAX_AGENTS, maxTasks: MAX_TASKS,
    servedFrom: SERVED_NAME, source: sourceId,
  });
  /* 对外工作区身份：core 给的 key 是规范化目录，只用于服务端合并/排序；
     普通接口一律换成进程级不透明 ID，绝对路径不出现在响应里（复核 #7）。 */
  for (const w of st.workflows) w.key = opaqueWorkspace(w.key);
  st.sourceList = sourceInfo(false);
  let backlog = null;
  try { backlog = live.backlog(); } catch { backlog = null; }   // 事件缓存窗口，前端据此提示缺口
  st.eventBacklog = backlog;
  st.epoch = EPOCH;
  st.protocolVersion = 2;
  /* revision = 该视图已发布事件序号水位（与 events 外壳的 revision 同义） */
  st.revision = backlog ? backlog.newest : 0;
  /* 数据性质：真实 bridge 明确标 live；前端把它和「连接健康」分开消费（复核 v2.42 #6） */
  st.dataKind = 'live';
  return st;
}

/** 当前会话身份 → 规范化工作区 key。
 *  事件只带来源 src 和会话 sid；workspace 每次读取时按当前 sessions() 还原，
 *  因此未上墙、编号回收、合并源、工作区重排都按同一身份规则处理。 */
function workspaceIndex(sourceId) {
  const list = sourceId === 'all' ? entries.map(e => e.src) : [byId.get(sourceId).src];
  const map = new Map();
  for (const s of list) {
    for (const sess of s.sessions()) map.set(`${s.id}:${sess.id}`, normDir(sess.cwd));
  }
  return map;
}

/** 取一页事件（从最早未读开始）和分页/代际元数据；对外 workspace 一律用不透明 ID。
 *  旧前端继续拿裸数组（兼容），分页游标/代际信息走响应头；显式 format=v2 才给外壳对象。 */
function eventsPage(sourceId, after) {
  const live = sourceId === 'all' ? globalLive : byId.get(sourceId).live;
  const book = codesFor(sourceId);
  const n = Number.isFinite(after) ? Math.max(0, after) : 0;
  const wsIndex = workspaceIndex(sourceId);
  const events = live.since(n).map(e => {
    /* 编号按事件自己的来源解析：e.src 是 push 时打上的，不靠"遍历所有源找同 id"，
       避免两个源会话 id 相同时把事件算到别人头上。老事件没有 src 时才退回旧逻辑。 */
    let agent = '';
    if (e.src) {
      agent = book.get(`${e.src}:${e.sid}`) || '';
    } else if (sourceId === 'all') {
      for (const k of byId.keys()) { const c = book.get(`${k}:${e.sid}`); if (c) { agent = c; break; } }
    } else {
      agent = book.get(`${sourceId}:${e.sid}`);
    }
    /* workspace 与 agent 解耦：agent 只表示「当前是否上墙、墙上几号」，
       workspace 来自会话当前 cwd，对外换成不透明 ID；找不到会话时明确留空（前端显示未归属）。 */
    let workspace;
    if (e.src) workspace = wsIndex.get(`${e.src}:${e.sid}`);
    else if (sourceId !== 'all') workspace = wsIndex.get(`${sourceId}:${e.sid}`);
    else {
      for (const k of byId.keys()) {
        const w = wsIndex.get(`${k}:${e.sid}`);
        if (w !== undefined) { workspace = w; break; }
      }
    }
    return { seq: e.seq, verb: e.verb, task_name: e.task_name, kind: e.kind, name: e.name,
      agent, src: e.src || '', ok: e.ok !== false,
      workspace: workspace ? opaqueWorkspace(workspace) : '' };
  });
  let backlog = null;
  try { backlog = live.backlog(); } catch { backlog = null; }
  const nextCursor = events.length ? events[events.length - 1].seq : n;
  return { events, backlog, nextCursor, hasMore: !!backlog && backlog.newest > nextCursor };
}

/** 旧数组接口的附加分页/代际信息：用响应头承载，不改响应体形状（兼容现有前端）。 */
function eventMeta(sourceId, page) {
  const backlog = page.backlog;
  const meta = {
    'x-agent-ops-protocol-version': '2',
    'x-agent-ops-epoch': EPOCH,
    'x-agent-ops-source': sourceId,
    'x-agent-ops-revision': String(backlog ? backlog.newest : 0),
    'x-agent-ops-next-cursor': String(page.nextCursor),
    'x-agent-ops-has-more': page.hasMore ? '1' : '0',
  };
  if (backlog) {
    meta['x-agent-ops-backlog-oldest'] = String(backlog.oldest);
    meta['x-agent-ops-backlog-newest'] = String(backlog.newest);
    meta['x-agent-ops-backlog-count'] = String(backlog.count);
  }
  return meta;
}

/* ---------------- 访问控制 ---------------- */

const TOKEN = String(process.env.TOKEN || '').trim();
const DEBUG = process.env.DEBUG === '1';
const ALLOW_ORIGINS = String(process.env.ALLOW_ORIGIN || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
/* ALLOW_ORIGIN=* 必须和精确来源一样贯穿「预检 + 实际请求」：
   预检回 *，实际请求也回 *（不带凭证），不能只放行预检。 */
const ALLOW_WILDCARD = ALLOW_ORIGINS.includes('*');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** 去掉端口，取主机名 */
function hostOnly(v) {
  let s = String(v || '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '');
  if (s.startsWith('[')) return s.slice(0, s.indexOf(']') + 1);
  return s.replace(/:\d+$/, '');
}

/**
 * Host 必须是本机回环（挡 DNS rebinding：攻击者域名解析到 127.0.0.1 时 Host 会是他的域名）。
 * 带了 Origin 的，必须是回环本身或显式允许的来源。
 */
function checkRequest(req) {
  const host = hostOnly(req.headers.host);
  if (!LOOPBACK_HOSTS.has(host)) return 'bad host';
  const origin = req.headers.origin;
  if (origin) {
    const o = String(origin).trim().toLowerCase();
    if (ALLOW_WILDCARD) return null;                       // 通配允许任意来源（仍只监听回环、仍要令牌）
    if (ALLOW_ORIGINS.includes(o)) return null;
    if (!LOOPBACK_HOSTS.has(hostOnly(o))) return 'bad origin';
  }
  return null;
}

/** 只有显式允许的来源（或 * 通配）才回 CORS 头；通配不回声来源、不带凭证。 */
function corsHeaders(req) {
  const origin = String(req.headers.origin || '').trim();
  if (ALLOW_WILDCARD) {
    return {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'x-dsh-token, content-type',
    };
  }
  if (origin && ALLOW_ORIGINS.includes(origin.toLowerCase())) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'x-dsh-token, content-type',
      'vary': 'Origin',
    };
  }
  return {};
}

function tokenOk(req, url) {
  if (!TOKEN) return true;
  const got = url.searchParams.get('token') || String(req.headers['x-dsh-token'] || '');
  return got === TOKEN;
}

/* ---------------- HTTP ---------------- */

/* 统一加固头：nosniff 挡内容嗅探；no-referrer 避免地址栏里的 ?token= 被 Referer 带出去；
   CSP 只上 frame-ancestors（不限制 script-src / style-src），内联脚本、内联样式和 Canvas 都不受影响。 */
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
};

function sendText(res, code, text, extraHeaders) {
  if (res.headersSent) { try { res.end(); } catch { /* 已经断了 */ } return; }
  res.writeHead(code, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...SECURITY_HEADERS, ...extraHeaders,
  });
  res.end(text);
}

const sendJSON = (req, res, obj, code = 200, extraHeaders) => {
  if (res.headersSent) { try { res.end(); } catch { /* 已经断了 */ } return; }
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
    ...corsHeaders(req),
    ...extraHeaders,
  });
  res.end(JSON.stringify(obj));
};

async function handle(req, res) {
  // ① URL 解析：坏的请求直接 400，不让它把进程带走
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    return sendText(res, 400, 'bad request');
  }

  // ② Host / Origin 校验
  const bad = checkRequest(req);
  if (bad) return sendText(res, 403, bad);

  // ②.5 路由方法显式定义：只允许 GET / HEAD，其他方法不落到业务处理里
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return sendText(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
  }

  // ③ 访问令牌：**页面本身也要令牌**。
  //    如果只在接口上校验、却把令牌注入到不设防的首页里，任何人打开首页就能抠出令牌再调接口 —— 等于没防护。
  if (TOKEN && !tokenOk(req, url)) {
    if (url.pathname.startsWith('/api/')) return sendJSON(req, res, { error: 'unauthorized' }, 401);
    return sendText(res, 401, '需要访问令牌：请在地址后面加 ?token=<你的令牌>');
  }

  if (url.pathname === '/api/sources') {
    return sendJSON(req, res, { current: pickSource(url.searchParams.get('source')), sources: sourceInfo(false) });
  }
  if (url.pathname === '/api/agent-ops/state') {
    const sourceId = pickSource(url.searchParams.get('source'));
    return sendJSON(req, res, stateFor(sourceId), 200, {
      'x-agent-ops-protocol-version': '2',
      'x-agent-ops-epoch': EPOCH,
      'x-agent-ops-source': sourceId,
    });
  }
  if (url.pathname === '/api/agent-ops/events') {
    const sourceId = pickSource(url.searchParams.get('source'));
    const after = Number(url.searchParams.get('after') || 0);
    const page = eventsPage(sourceId, after);
    const meta = eventMeta(sourceId, page);
    /* 默认保持旧数组响应（现有前端不用改）；显式 format=v2 / v=2 才返回带外壳的对象。 */
    const wantsV2 = url.searchParams.get('format') === 'v2' || url.searchParams.get('v') === '2';
    if (!wantsV2) return sendJSON(req, res, page.events, 200, meta);
    return sendJSON(req, res, {
      protocolVersion: 2,
      epoch: EPOCH,
      source: sourceId,
      revision: page.backlog ? page.backlog.newest : 0,
      backlog: page.backlog,
      events: page.events,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    }, 200, meta);
  }
  if (url.pathname === '/api/agent-ops/debug') {
    // 调试接口默认关闭；开着的时候才给绝对路径
    if (!DEBUG) return sendText(res, 404, 'not found');
    const src = pickSource(url.searchParams.get('source'));
    const list = src === 'all' ? entries.map(e => e.src) : [byId.get(src).src];
    return sendJSON(req, res, {
      servedFrom: SERVED_NAME,
      servedDir: SERVED_DIR,
      source: src,
      defaultSource,
      activeMin: ACTIVE_MIN,
      sources: sourceInfo(true),
      sessions: list.flatMap(s => s.sessions()).map(s => ({
        src: s.src, id: s.id, title: s.title, depth: s.depth,
        running: !!(s.current || s.openStep != null),
        ageMin: Math.round((Date.now() - s.mtime) / 60000),
        calls: s.calls.length, todos: s.todos.length,
      })).sort((a, b) => a.ageMin - b.ageMin).slice(0, 20),
    });
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    let html;
    try {
      html = await readFile(join(process.cwd(), 'index.html'), 'utf8');
    } catch (err) {
      /* 响应里只给稳定错误码；路径/异常细节只留在本机控制台，且不打印 message。 */
      console.error('[bridge] 读取页面失败:', (err && (err.code || err.name)) || 'error');
      return sendText(res, 500, 'internal error');
    }
    // 注意：不把令牌注入到页面里。页面靠 URL 上的 ?token= 自己带上，
    // 这样没令牌的人连页面都拿不到，也就抠不出令牌。
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      ...SECURITY_HEADERS, ...corsHeaders(req),
    });
    return res.end(html);
  }
  sendText(res, 404, 'not found');
}

const server = createServer((req, res) => {
  /* 跨域预检：浏览器发 OPTIONS 时不带令牌，必须在鉴权之前回 204 + CORS 头，
     否则 ALLOW_ORIGIN + TOKEN 组合下预检永远是 401，实际请求根本发不出去。 */
  if (req.method === 'OPTIONS') {
    /* 先校 Host（和实际请求一致），再看来源是否是白名单 / 通配。
       通配时回 *（不回显来源），精确来源时回显该来源。 */
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (!LOOPBACK_HOSTS.has(hostOnly(req.headers.host))) {
      res.writeHead(403); res.end(); return;
    }
    const origin = String(req.headers.origin || '').trim();
    const ok = ALLOW_WILDCARD || (!!origin && ALLOW_ORIGINS.includes(origin.toLowerCase()));
    if (ok) {
      res.setHeader('Access-Control-Allow-Origin', ALLOW_WILDCARD ? '*' : origin);
      if (!ALLOW_WILDCARD) res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-dsh-token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    res.writeHead(ok ? 204 : 403);
    res.end();
    return;
  }
  // 任何异常都不能让服务退出；普通响应只给稳定错误码，不含异常 message/堆栈
  handle(req, res).catch(err => {
    console.error('[bridge] 请求处理失败:', (err && (err.code || err.name)) || 'error');
    sendText(res, 500, 'internal error');
  });
});

// 畸形请求（比如篡改的 HTTP 报文）不要抛到进程层
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

/* ---------------- 启动 ---------------- */

for (const e of entries) await runScan(e.src, true);
setInterval(() => {
  for (const e of entries) runScan(e.src, false);
}, 800);

const avail = sourceInfo(false).filter(s => s.sessions > 0);
defaultSource = (WANT_SOURCE === 'all') ? 'all' : ((WANT_SOURCE && byId.has(WANT_SOURCE)) ? WANT_SOURCE
  : (avail.find(s => s.id === 'dsh') ? 'dsh'
    : (avail.slice().sort((a, b) => b.active - a.active)[0] || { id: 'dsh' }).id));

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' });
    // 异步错误一定要接住，否则没有 xdg-open 的机器会直接把进程带走
    child.on('error', () => console.log('  （自动打开浏览器失败，请手动访问上面地址）'));
    child.unref();
  } catch {
    console.log('  （自动打开浏览器失败，请手动访问上面地址）');
  }
}

server.listen(PORT, '127.0.0.1', () => {
  /* PORT=0 时系统会分配端口：地址、自检、自动打开浏览器都必须用实际端口 */
  const actualPort = server.address().port;
  /* 启动日志默认不打印完整令牌：地址里不带 token，避免终端/日志/截图泄露。 */
  const pageUrl = `http://127.0.0.1:${actualPort}/`;
  console.log('');
  console.log(`  当前目录  ${SERVED_DIR}`);
  console.log(`  提供页面  this dir / index.html   ← 页面永远来自这个目录`);
  console.log('  ' + '─'.repeat(62));
  console.log(`[bridge] 大屏  ${pageUrl}`);
  if (TOKEN) console.log('[bridge] 令牌  已启用（日志不打印完整令牌；访问时自行附加 ?token=…）');
  console.log(`[bridge] 接口  http://127.0.0.1:${actualPort}/api/agent-ops/state?source=codex`);
  if (DEBUG) console.log(`[bridge] 自检  http://127.0.0.1:${actualPort}/api/agent-ops/debug`);
  if (PORT === 0) console.log(`[bridge] 端口  PORT=0，系统实际分配 ${actualPort}`);
  console.log(`[bridge] 窗口  近 ${ACTIVE_MIN} 分钟 · 一屏最多 ${MAX_AGENTS} 个 · 默认源 ${defaultSource}`);
  console.log(`[bridge] 访问  仅回环 · CORS ${ALLOW_ORIGINS.length ? ALLOW_ORIGINS.join(',') : '关闭'}${TOKEN ? ' · 已启用令牌' : ''}${DEBUG ? ' · 调试开启' : ''}`);
  console.log('  ' + '─'.repeat(62));
  for (const s of sourceInfo(true)) {
    const mark = s.sessions > 0 ? '✓' : (s.available ? '·' : '✗');
    console.log(`  ${mark} ${s.name.padEnd(12)} 会话 ${String(s.sessions).padStart(3)} · 近活跃 ${String(s.active).padStart(2)} · 运行中 ${String(s.running).padStart(2)}   ${s.path}`);
  }
  const over = ['DSH_SESSIONS', 'CODEX_SESSIONS', 'CLAUDE_PROJECTS'].filter(k => process.env[k]);
  if (over.length) console.log(`  路径由环境变量覆盖: ${over.join(' / ')}`);
  console.log('  ' + '─'.repeat(62));
  console.log('  切换数据源：浏览器右上角下拉，或 URL 加 ?source=codex / ?source=all');
  console.log('');
  if (OPEN_BROWSER) openBrowser(pageUrl);
});
