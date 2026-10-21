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
 * 演示后端和真实 bridge 共用同一套归属/分页协议：
 *   - workflows[].key 是稳定的演示工作区 ID（demo:W01…），events[].workspace 用同一批值
 *   - 开始/完成事件都带当时的执行者（agent）与工作区，任务解绑后旧事件仍保留原归属
 *   - state 带 epoch / protocolVersion / revision / eventBacklog；events 从最早未读开始分页
 *   - dataKind 永远是 demo：即使服务联网成功，也不会被当成实时数据
 * 旧前端仍拿裸事件数组（分页信息走响应头）；显式 ?format=v2 才返回带外壳的对象。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8777);
/* 进程代际：重启后 epoch 变化、事件序号从 1 重来；前端靠它重置游标/回放/去重集合 */
const EPOCH = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);

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
const pad = (n, w = 2) => String(n).padStart(w, '0');

/* 工作区 = 演示用的稳定 ID + 下标。key 与 events[].workspace 同值，重启才换代。 */
const workflows = WF.map((name, i) => ({
  i, id: 'W' + pad(i + 1), key: 'demo:W' + pad(i + 1), name, q: 0.62 + Math.random() * 0.33,
}));

const tasks = Array.from({ length: 64 }, (_, i) => ({
  id: 'T-' + pad(i + 1, 3),
  name: TASK_NAMES[rnd(TASK_NAMES.length)],
  wf: rnd(WF.length),        // 工作区下标（和 workflows[i] 同一套编号）
  state: 'queued',
  prog: 0,
  agent: null,
}));
const agents = AGENTS.map(([code, name]) => ({ code, name, wf: 0 }));

// EVIL=1 时故意返回带 HTML 的名字，用来验证前端有没有转义（smoke-test.mjs 用）
if (process.env.EVIL === '1') {
  agents[0].name = '<img src=x onerror="globalThis.__xss=1">';
  tasks[0].name = '<script>alert(1)</script>';
  workflows[0].name = '<b>bold</b>';
}

/* 事件缓存：seq 进程内单调递增；超过窗口从最旧端淘汰，backlog 会如实反映窗口起点。 */
const events = [];
let seq = 0;
const backlogInfo = () => ({
  oldest: events.length ? events[0].seq : 0,
  newest: events.length ? events[events.length - 1].seq : 0,
  count: events.length,
});

/** 发布一条事件：执行者/工作区在**发布时**固定下来，之后任务解绑也不改变旧事件归属。 */
const pushEvent = (verb, task, executor) => {
  const wf = workflows[task.wf] || workflows[0];
  events.push({
    seq: ++seq,
    verb,
    task_name: task.name,
    ts: Date.now(),
    kind: 'tool',
    ok: true,
    agent: executor || '',
    workspace: wf ? wf.key : '',
    src: 'mock',
  });
  if (events.length > 500) events.splice(0, events.length - 500);
};

/* 顺序分页：永远从最早未读开始；积压超过一页时用 nextCursor/hasMore 继续，不从末尾截断。 */
const EVENTS_PAGE = 40;
const eventsPage = after => {
  const n = Number.isFinite(after) ? Math.max(0, after) : 0;
  const all = events.filter(e => e.seq > n);
  const page = all.slice(0, EVENTS_PAGE);
  const nextCursor = page.length ? page[page.length - 1].seq : n;
  return { page, nextCursor, hasMore: all.length > page.length, backlog: backlogInfo() };
};

// 起手先跑起来一部分，避免首屏一片空白
tasks.slice(0, 22).forEach(t => { t.state = 'done'; t.prog = 1; });
tasks.slice(22, 32).forEach((t, k) => {
  t.state = 'run';
  t.prog = 0.1 + Math.random() * 0.8;
  t.agent = agents[k].code;
  agents[k].wf = t.wf;   // agents.wf 由当前任务导出（同一时刻只跑一个任务）
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
      /* 先捕获执行者再清空任务绑定：否则完成事件发布时已经读不到是谁做的（复核 #12）。 */
      const executor = t.agent;
      t.state = 'done';
      t.prog = 1;
      t.agent = null;
      pushEvent(Math.random() < 0.5 ? 'check' : 'review', t, executor);
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
    a.wf = t.wf;   // 当前任务换到别的工区时，节点归属跟着换
    pushEvent(Math.random() < 0.5 ? 'read' : 'build', t, a.code);
  }

  const done = tasks.filter(t => t.state === 'done');
  if (done.length > 54) done.slice(0, 12).forEach(t => { t.state = 'queued'; t.prog = 0; t.agent = null; });

  const w = workflows[rnd(workflows.length)];
  w.q = Math.max(0.55, Math.min(0.98, w.q + (Math.random() - 0.42) * 0.04));
}
setInterval(tick, 700);

/* 统一加固头：和 dsh-bridge 一致，live 模式可以一起验。CSP 只上 frame-ancestors。 */
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
};

const sendText = (res, code, text, extraHeaders) => {
  if (res.headersSent) { try { res.end(); } catch { /* 已断开 */ } return; }
  res.writeHead(code, {
    'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
    ...SECURITY_HEADERS, ...extraHeaders,
  });
  res.end(text);
};

const sendJSON = (res, obj, code = 200, extraHeaders) => {
  if (res.headersSent) { try { res.end(); } catch { /* 已断开 */ } return; }
  // 注意：这里不返回 access-control-allow-origin —— 只给同源的页面用
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
    ...extraHeaders,
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

/* 普通接口的元数据：不给 path（演示数据本来也没有磁盘路径） */
const sourceInfo = () => [{
  id: 'mock', name: '演示数据', note: '内置假数据，用来离线看效果',
  available: true, sessions: 64, active: 12, files: 0, stale: false, degraded: false,
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
    const bl = backlogInfo();
    /* agents.wf 每次由当前任务导出（不缓存任务绑定残留）；任务解绑不影响这里的历史。 */
    const agentList = agents.map(a => {
      const t = tasks.find(x => x.agent === a.code && x.state === 'run');
      const wf = t ? t.wf : a.wf;
      return { code: a.code, name: a.name, wf: Number.isInteger(wf) ? wf : 0 };
    });
    return sendJSON(res, {
      tasks, agents: agentList, workflows,
      links: [], overflow: 0, active: 12,
      snippets: DEMO_SNIPPETS,
      source: 'mock', servedFrom: 'server.mjs', sourceList: sourceInfo(),
      dataKind: 'demo',
      epoch: EPOCH,
      protocolVersion: 2,
      revision: bl.newest,
      eventBacklog: bl,
    }, 200, {
      'x-agent-ops-protocol-version': '2',
      'x-agent-ops-epoch': EPOCH,
      'x-agent-ops-source': 'mock',
    });
  }
  if (url.pathname === '/api/sources') {
    return sendJSON(res, { current: 'mock', sources: sourceInfo(), dataKind: 'demo', epoch: EPOCH });
  }
  if (url.pathname === '/api/agent-ops/events') {
    const after = Number(url.searchParams.get('after') || 0);
    const page = eventsPage(after);
    const bl = page.backlog;
    const meta = {
      'x-agent-ops-protocol-version': '2',
      'x-agent-ops-epoch': EPOCH,
      'x-agent-ops-source': 'mock',
      'x-agent-ops-revision': String(bl.newest),
      'x-agent-ops-next-cursor': String(page.nextCursor),
      'x-agent-ops-has-more': page.hasMore ? '1' : '0',
      'x-agent-ops-backlog-oldest': String(bl.oldest),
      'x-agent-ops-backlog-newest': String(bl.newest),
      'x-agent-ops-backlog-count': String(bl.count),
    };
    const wantsV2 = url.searchParams.get('format') === 'v2' || url.searchParams.get('v') === '2';
    if (!wantsV2) return sendJSON(res, page.page, 200, meta);
    return sendJSON(res, {
      protocolVersion: 2, epoch: EPOCH, source: 'mock', revision: bl.newest,
      backlog: bl, events: page.page, nextCursor: page.nextCursor, hasMore: page.hasMore,
    }, 200, meta);
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    let html;
    try {
      html = await readFile(join(ROOT, 'index.html'), 'utf8');
    } catch (err) {
      console.error('[mock] 读取页面失败:', (err && (err.code || err.name)) || 'error');
      return sendText(res, 500, 'internal error');
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS,
    });
    return res.end(html);
  }
  sendText(res, 404, 'not found');
}

const server = createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error('[mock] 请求处理失败:', (err && (err.code || err.name)) || 'error');
    sendText(res, 500, 'internal error');
  });
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, '127.0.0.1', () => {
  /* PORT=0 时日志必须写实际监听端口，不能用配置值 0 */
  const actualPort = server.address().port;
  console.log(`[mock] 大屏  http://127.0.0.1:${actualPort}/`);
  console.log(`[mock] 接口  http://127.0.0.1:${actualPort}/api/agent-ops/state`);
  if (PORT === 0) console.log(`[mock] 端口  PORT=0，系统实际分配 ${actualPort}`);
});
