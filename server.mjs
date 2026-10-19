/**
 * 本地联调用的假后端 —— 只为把 index.html 的真实数据通路跑通，不依赖任何 npm 包。
 *
 *   node server.mjs             # http://127.0.0.1:8777
 *   PORT=9000 node server.mjs
 *
 * 提供两个端点，外加静态服务（否则 fetch 会撞 file:// 的 CORS）：
 *   GET /api/agent-ops/state             任务 / 智能体 / 工作流 快照
 *   GET /api/agent-ops/events?after=<seq> 增量事件流（任务流的滚动日志）
 *
 * 接你自己的系统时，只要照着这两个端点的出参形状实现，剩下的一行都不用改。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8777);

const AGENTS = [
  ['01', '检索'], ['02', '拆解'], ['03', '文案'], ['04', '设计'], ['05', '代码'], ['06', '测试'],
  ['07', '审校'], ['08', '数据'], ['09', '剪辑'], ['10', '投放'], ['11', '客服'], ['12', '归档'],
];
const TASK_NAMES = [
  '竞品资料检索', '需求拆解', '短视频脚本', '封面图六版', '落地页改版', '接口联调', '合同条款审校', '周报数据汇总',
  '投标文件生成', '私域话术更新', '素材归档', '发版检查', '用户反馈聚类', '广告素材测试', '知识库更新', '直播切片',
];
const WF = ['资料检索', '需求拆解', '脚本生成', '视觉设计', '代码实现', '测试验证',
  '合规审校', '数据汇总', '视频剪辑', '投放优化', '知识归档'];

const rnd = n => Math.floor(Math.random() * n);
const pad = (n, w) => String(n).padStart(w, '0');

const tasks = Array.from({ length: 64 }, (_, i) => ({
  id: 'T-' + pad(i + 1, 3),
  name: TASK_NAMES[rnd(TASK_NAMES.length)],
  wf: 'W' + pad(rnd(WF.length) + 1, 2),
  state: 'queued',
  prog: 0,
  agent: null,
}));
const agents = AGENTS.map(([code, name]) => ({ code, name }));
const workflows = WF.map((name, i) => ({ id: 'W' + pad(i + 1, 2), name, q: 0.62 + Math.random() * 0.33 }));

// EVIL=1 时故意返回带 HTML 的名字，用来验证前端有没有转义（smoke-test.mjs 用）
if (process.env.EVIL === '1') {
  agents[0].name = '<img src=x onerror="globalThis.__xss=1">';
  tasks[0].name = '<script>alert(1)</script>';
  workflows[0].name = '<b>bold</b>';
}

const events = [];
let seq = 0;
const pushEvent = (verb, task) => {
  events.push({ seq: ++seq, verb, task_name: task.name, ts: Date.now() });
  if (events.length > 500) events.splice(0, events.length - 500);
};

// 起手先跑起来一部分，避免首屏一片空白
tasks.slice(0, 22).forEach(t => { t.state = 'done'; t.prog = 1; });
tasks.slice(22, 32).forEach((t, k) => {
  t.state = 'run';
  t.prog = 0.1 + Math.random() * 0.8;
  t.agent = agents[k].code;
});

let last = Date.now();
function tick() {
  const now = Date.now();
  const dt = Math.min(2, (now - last) / 1000);
  last = now;

  for (const a of agents) {
    const t = tasks.find(x => x.agent === a.code);
    if (!t) continue;
    t.prog = Math.min(1, t.prog + dt * (0.12 + Math.random() * 0.2));
    if (t.prog >= 1) {
      t.state = 'done';
      t.agent = null;
      pushEvent(Math.random() < 0.5 ? 'check' : 'review', t);
    }
  }

  for (const a of agents) {
    if (tasks.some(t => t.agent === a.code)) continue;
    if (Math.random() > 0.5) continue;
    const q = tasks.filter(t => t.state === 'queued');
    if (!q.length) break;
    const t = q[rnd(q.length)];
    t.state = 'run';
    t.agent = a.code;
    t.prog = 0.02;
    pushEvent(Math.random() < 0.5 ? 'read' : 'build', t);
  }

  const done = tasks.filter(t => t.state === 'done');
  if (done.length > 54) done.slice(0, 12).forEach(t => { t.state = 'queued'; t.prog = 0; t.agent = null; });

  const w = workflows[rnd(workflows.length)];
  w.q = Math.max(0.55, Math.min(0.98, w.q + (Math.random() - 0.42) * 0.04));
}
setInterval(tick, 700);

const sendText = (res, code, text) => {
  if (res.headersSent) { try { res.end(); } catch { /* 已断开 */ } return; }
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
};

const sendJSON = (res, obj) => {
  if (res.headersSent) { try { res.end(); } catch { /* 已断开 */ } return; }
  // 注意：这里不返回 access-control-allow-origin —— 只给同源的页面用
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(obj));
};

/* 演示用的代码片段：让「执行代码」面板有东西可打，纯假数据 */
const DEMO_SNIPPETS = [
  { file: 'dispatch.py', agent: '01', lang: 'py', start: 7, lines: [
    '# 每日调度：拆任务、派给智能体',
    "tasks = load_queue('today')",
    "plan = split(tasks, by='skill')",
    'for step in plan:',
    '    agent = dispatch(step.skill)',
    '    out = agent.run(step)',
    '    if review(out) < 0.8:',
    '        out = agent.revise(out)',
    '    board.attach(step.id, out)'] },
  { file: 'retrieve.py', agent: '02', lang: 'py', start: 18, lines: [
    '# 竞品资料检索',
    'def retrieve(topic, k=20):',
    '    hits = search.web(topic, top=k)',
    '    docs = [fetch(h.url) for h in hits]',
    "    docs = dedupe(docs, by='title')",
    '    notes = summarize(docs, lang=zh)',
    '    kb.save(topic, notes)',
    '    return notes'] },
  { file: 'preflight.py', agent: '05', lang: 'py', start: 77, lines: [
    '# 发版前检查',
    'def preflight(build):',
    '    tests = run_tests(build, fast=True)',
    '    if tests.failed:',
    '        return block(tests.failed)',
    '    diff = compare(build, last_release)',
    '    if diff.risk > 0.3:',
    '        return ask_review(diff)',
    '    return approve(build)'] },
];

const sourceInfo = () => [{
  id: 'mock', name: '演示数据', note: '内置假数据，用来离线看效果',
  path: '（无，全部在内存里生成）', available: true,
  sessions: 64, active: 12, files: 0,
}];

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function hostOnly(v) {
  let s = String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '');
  if (s.startsWith('[')) return s.slice(0, s.indexOf(']') + 1);
  return s.replace(/:\d+$/, '');
}

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    return sendText(res, 400, 'bad request');
  }
  // Host 必须是本机回环，挡 DNS rebinding
  if (!LOOPBACK_HOSTS.has(hostOnly(req.headers.host))) return sendText(res, 403, 'bad host');
  const origin = req.headers.origin;
  if (origin && !LOOPBACK_HOSTS.has(hostOnly(origin))) return sendText(res, 403, 'bad origin');

  if (url.pathname === '/api/agent-ops/state') {
    return sendJSON(res, {
      tasks, agents, workflows,
      links: [], overflow: 0, active: 12,
      snippets: DEMO_SNIPPETS,
      source: 'mock', servedFrom: 'server.mjs', sourceList: sourceInfo(),
    });
  }
  if (url.pathname === '/api/sources') {
    return sendJSON(res, { current: 'mock', sources: sourceInfo() });
  }
  if (url.pathname === '/api/agent-ops/events') {
    const after = Number(url.searchParams.get('after') || 0);
    return sendJSON(res, events.filter(e => e.seq > (Number.isFinite(after) ? after : 0)).slice(-40));
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    let html;
    try {
      html = await readFile(join(ROOT, 'index.html'));
    } catch (err) {
      return sendText(res, 500, String(err));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }
  sendText(res, 404, 'not found');
}

const server = createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error('[mock] 请求处理失败:', err && err.message);
    sendText(res, 500, 'internal error');
  });
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] 大屏  http://127.0.0.1:${PORT}`);
  console.log(`[mock] 接口  http://127.0.0.1:${PORT}/api/agent-ops/state`);
});
