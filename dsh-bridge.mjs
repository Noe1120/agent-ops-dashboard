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
import { join, basename, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createLive, createCodes, buildState } from './lib/core.mjs';
import * as srcDsh from './sources/dsh.mjs';
import * as srcCodex from './sources/codex.mjs';
import * as srcClaude from './sources/claude.mjs';

/* 服务是从哪个目录起的 —— 页面永远用这个目录里的 index.html，容易搞混，所以到处报一下 */
const SERVED_DIR = process.cwd();
const SERVED_NAME = basename(SERVED_DIR);

const PORT = Number(process.env.PORT || 8778);
const ACTIVE_MIN = Number(process.env.ACTIVE_MIN || 45);
const ACTIVE_MS = ACTIVE_MIN * 60_000;
const MAX_AGENTS = Number(process.env.MAX_AGENTS || 12);
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

function makeEntry(mod, opts) {
  const live = createLive();
  const sink = {
    live,
    push: (item, sid, name) => { live.push(item, sid, name); globalLive.push(item, sid, name); },
  };
  const src = mod.create({ ...opts, live: sink });
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
    const st = available ? src.stats() : { sessions: 0, active: 0, files: 0 };
    const o = {
      id: src.id, name: src.name, note: src.note,
      available: st.sessions > 0 ? true : available,
      sessions: st.sessions, active: st.active, running: st.running || 0, files: st.files,
    };
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
  st.sourceList = sourceInfo(false);
  st.epoch = EPOCH;
  return st;
}

function eventsFor(sourceId, after) {
  const live = sourceId === 'all' ? globalLive : byId.get(sourceId).live;
  const book = codesFor(sourceId);
  const n = Number.isFinite(after) ? Math.max(0, after) : 0;
  return live.since(n).map(e => {
    // 会话编号按当前上墙结果实时解析。all 模式下 sid 可能重名，取不到就留空。
    let agent = '';
    if (sourceId === 'all') {
      for (const k of byId.keys()) { const c = book.get(`${k}:${e.sid}`); if (c) { agent = c; break; } }
    } else {
      agent = book.get(`${sourceId}:${e.sid}`);
    }
    return { seq: e.seq, verb: e.verb, task_name: e.task_name, kind: e.kind, name: e.name, agent, ok: e.ok !== false };
  });
}

/* ---------------- 访问控制 ---------------- */

const TOKEN = String(process.env.TOKEN || '').trim();
const DEBUG = process.env.DEBUG === '1';
const ALLOW_ORIGINS = String(process.env.ALLOW_ORIGIN || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

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
    if (ALLOW_ORIGINS.includes(o)) return null;
    if (!LOOPBACK_HOSTS.has(hostOnly(o))) return 'bad origin';
  }
  return null;
}

/** 只有显式允许的来源才回 CORS 头，默认一个都不回 */
function corsHeaders(req) {
  const origin = String(req.headers.origin || '').trim();
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

function sendText(res, code, text) {
  if (res.headersSent) { try { res.end(); } catch { /* 已经断了 */ } return; }
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

const sendJSON = (req, res, obj, code = 200) => {
  if (res.headersSent) { try { res.end(); } catch { /* 已经断了 */ } return; }
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...corsHeaders(req),
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
    return sendJSON(req, res, stateFor(pickSource(url.searchParams.get('source'))));
  }
  if (url.pathname === '/api/agent-ops/events') {
    const after = Number(url.searchParams.get('after') || 0);
    return sendJSON(req, res, eventsFor(pickSource(url.searchParams.get('source')), after));
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
      return sendText(res, 500, '读不到 index.html：' + err.message);
    }
    // 注意：不把令牌注入到页面里。页面靠 URL 上的 ?token= 自己带上，
    // 这样没令牌的人连页面都拿不到，也就抠不出令牌。
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }
  sendText(res, 404, 'not found');
}

const server = createServer((req, res) => {
  // 任何异常都不能让服务退出
  handle(req, res).catch(err => {
    console.error('[bridge] 请求处理失败:', err && err.message);
    sendText(res, 500, 'internal error');
  });
});

// 畸形请求（比如篡改的 HTTP 报文）不要抛到进程层
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

/* ---------------- 启动 ---------------- */

for (const e of entries) await e.src.scan(true).catch(() => {});
setInterval(() => {
  for (const e of entries) e.src.scan(false).catch(() => {});
}, 800);

const avail = sourceInfo(false).filter(s => s.sessions > 0);
defaultSource = (WANT_SOURCE && byId.has(WANT_SOURCE)) ? WANT_SOURCE
  : (avail.find(s => s.id === 'dsh') ? 'dsh'
    : (avail.slice().sort((a, b) => b.active - a.active)[0] || { id: 'dsh' }).id);

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
  const pageUrl = `http://127.0.0.1:${PORT}/${TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''}`;
  console.log('');
  console.log(`  当前目录  ${SERVED_DIR}`);
  console.log(`  提供页面  this dir / index.html   ← 页面永远来自这个目录`);
  console.log('  ' + '─'.repeat(62));
  console.log(`[bridge] 大屏  ${pageUrl}`);
  console.log(`[bridge] 接口  http://127.0.0.1:${PORT}/api/agent-ops/state?source=codex${TOKEN ? '&token=...' : ''}`);
  if (DEBUG) console.log(`[bridge] 自检  http://127.0.0.1:${PORT}/api/agent-ops/debug`);
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
