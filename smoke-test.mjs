/**
 * 冒烟测试：在 Node 里用最小 DOM 垫片把 index.html 的脚本真跑一遍，
 * 连上本地 mock 后端，检查面板有没有被真实数据填上。
 *
 *   node server.mjs &          # 先起后端
 *   node smoke-test.mjs
 *
 * 用途：换掉 /api/agent-ops/* 的实现后，先跑这个确认字段对得上、页面没崩。
 */
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ORIGIN = process.env.ORIGIN || 'http://127.0.0.1:8777';
const MODE = process.env.MODE || 'live';

/* ================================================================
 * 模块级测试：MODE=security / MODE=claude 不加载页面，直接查
 * ================================================================ */

function rawGet(path, headers = {}, port) {
  const u = new URL(ORIGIN);
  return new Promise((resolve, reject) => {
    const req = request({
      host: u.hostname, port: port || u.port || 80, path, method: 'GET',
      headers: {Host: port ? `127.0.0.1:${port}` : u.host, ...headers},
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body}));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

if (MODE === 'security') {
  const ok = await rawGet('/api/agent-ops/state');
  const badHost = await rawGet('/api/agent-ops/state', {Host: 'evil.example.com'});
  const badOrigin = await rawGet('/api/agent-ops/state', {Origin: 'http://evil.example.com'});
  const sameOrigin = await rawGet('/api/agent-ops/state', {Origin: ORIGIN});
  const debug = await rawGet('/api/agent-ops/debug');
  const weird = await rawGet('//');

  // 普通接口里不能有绝对路径字段（snippets[].path 之前漏了）
  const st = JSON.parse(ok.body);
  const absPathFields = [];
  (function walk(v, key) {
    if (typeof v === 'string') { if (key === 'path' && /^[A-Za-z]:[\\/]|^\//.test(v)) absPathFields.push(v); }
    else if (Array.isArray(v)) v.forEach(x => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) walk(val, k);
  })(st, '');
  const snippetHasPath = (st.snippets || []).some(s => 'path' in s);

  // 启一个带令牌的实例：验证「没令牌连首页都打不开」而不是「先拿页面再抠令牌」
  const TP = 8790;
  let tokenChild = null;
  const t = {};
  try {
    tokenChild = spawn(process.execPath, ['dsh-bridge.mjs'], {
      cwd: ROOT,
      env: {...process.env, PORT: String(TP), TOKEN: 'smoke-token', OPEN: '', SOURCE: ''},
      stdio: 'ignore',
    });
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      try { await rawGet('/', {}, TP); up = true; }
      catch { await new Promise(r => setTimeout(r, 300)); }
    }
    t.pageNo = await rawGet('/', {}, TP);
    t.pageYes = await rawGet('/?token=smoke-token', {}, TP);
    t.apiNo = await rawGet('/api/agent-ops/state', {}, TP);
    t.apiYes = await rawGet('/api/agent-ops/state?token=smoke-token', {}, TP);
    t.epoch1 = await rawGet('/api/agent-ops/state?token=smoke-token', {}, TP);
    t.epoch2 = await rawGet('/api/agent-ops/state?token=smoke-token', {}, TP);
  } finally {
    if (tokenChild) tokenChild.kill();
  }
  const ep1 = t.epoch1 && t.epoch1.status === 200 ? (JSON.parse(t.epoch1.body).epoch || '') : '';
  const ep2 = t.epoch2 && t.epoch2.status === 200 ? (JSON.parse(t.epoch2.body).epoch || '') : '';

  const checks = [
    ['正常请求返回 200', ok.status === 200, `status = ${ok.status}`],
    ['默认不返回 CORS 头', !ok.headers['access-control-allow-origin'], `acao = ${ok.headers['access-control-allow-origin']}`],
    ['伪造 Host（DNS rebinding）被拒', badHost.status === 403, `status = ${badHost.status}`],
    ['外部 Origin 读不到数据', badOrigin.status === 403, `status = ${badOrigin.status}`],
    ['同源 Origin 仍然可用', sameOrigin.status === 200, `status = ${sameOrigin.status}`],
    ['调试接口默认关闭', debug.status === 404, `status = ${debug.status}`],
    ['畸形 URL 返回 400 而不是崩掉', weird.status === 400, `status = ${weird.status}`],
    ['非法请求后服务还活着', (await rawGet('/api/sources')).status === 200, '后续请求失败'],
    ['接口里没有绝对路径字段', absPathFields.length === 0 && !snippetHasPath,
      `path 字段 ${absPathFields.length} 处，snippets 带 path = ${snippetHasPath}`],
    ['无令牌连首页都打不开（401）', t.pageNo && t.pageNo.status === 401, `status = ${t.pageNo && t.pageNo.status}`],
    ['页面里不再注入令牌', !!t.pageYes && !t.pageYes.body.includes('smoke-token'), 'HTML 里出现了令牌'],
    ['带令牌能打开首页', t.pageYes && t.pageYes.status === 200, `status = ${t.pageYes && t.pageYes.status}`],
    ['接口无令牌返回 401（不是 200）', t.apiNo && t.apiNo.status === 401, `status = ${t.apiNo && t.apiNo.status}`],
    ['接口带令牌正常', t.apiYes && t.apiYes.status === 200, `status = ${t.apiYes && t.apiYes.status}`],
    ['接口带 epoch（供前端识别后端重启）', !!ep1 && ep1 === ep2, `epoch = "${ep1}" / "${ep2}"`],
  ];
  let bad = 0;
  console.log(`MODE=security  ORIGIN=${ORIGIN}\n`);
  for (const [name, pass, detail] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : '   → ' + detail}`);
    if (!pass) bad++;
  }
  console.log(`\n${checks.length - bad}/${checks.length} 通过`);
  process.exit(bad ? 1 : 0);
}

if (MODE === 'claude') {
  const claude = await import('./sources/claude.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'claude-smoke-'));
  const line = o => JSON.stringify(o) + '\n';
  // 真实布局是 <projects>/<工作区slug>/<会话>.jsonl
  await mkdir(join(dir, 'projA'), {recursive: true});
  await mkdir(join(dir, 'projB'), {recursive: true});

  // 会话 A：字符串 message / 字符串 content / 完整回合（有结束记录）
  await writeFile(join(dir, 'projA', 'aaa.jsonl'), [
    line({type: 'user', cwd: 'D:\\projA', timestamp: '2026-01-01T00:00:00Z',
      message: {content: '纯字符串 content 的用户消息'}}),
    line({type: 'user', timestamp: '2026-01-01T00:00:01Z', message: '纯字符串 message 的用户消息'}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:02Z',
      message: {content: [{type: 'text', text: '好的，我看一下'}]}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:03Z',
      message: {content: [{type: 'tool_use', id: 'tu1', name: 'Read', input: {file_path: 'a.js'}}]}}),
    line({type: 'user', timestamp: '2026-01-01T00:00:04Z',
      message: {content: [{type: 'tool_result', tool_use_id: 'tu1', content: 'ok'}]}}),
    line({type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-01-01T00:00:05Z'}),
  ].join(''));

  // 会话 B：最后一条是没配对的 tool_use —— 应该算「正在运行」
  await writeFile(join(dir, 'projB', 'bbb.jsonl'), [
    line({type: 'user', cwd: 'D:\\projB', timestamp: '2026-01-01T00:00:00Z', message: {content: '干活'}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:02Z',
      message: {content: [{type: 'tool_use', id: 'tu9', name: 'Bash', input: {command: 'ls'}}]}}),
  ].join(''));

  // 会话 C：最终回复带 stop_reason=end_turn，但没有额外结束记录 —— 也应判定为结束
  await writeFile(join(dir, 'projA', 'ccc.jsonl'), [
    line({type: 'user', cwd: 'D:\\projA', timestamp: '2026-01-01T00:00:00Z', message: {content: '结束测试'}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:02Z', message: {content: [{type: 'text', text: '做完了'}], stop_reason: 'end_turn'}}),
  ].join(''));

  // 会话 D：system 是 compact_boundary（中途压缩），不是回合结束 —— 仍应算「推理中」
  await writeFile(join(dir, 'projA', 'ddd.jsonl'), [
    line({type: 'user', cwd: 'D:\\projA', timestamp: '2026-01-01T00:00:00Z', message: {content: '继续'}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:02Z', message: {content: [{type: 'text', text: '我看看'}]}}),
    line({type: 'system', subtype: 'compact_boundary', timestamp: '2026-01-01T00:00:03Z'}),
  ].join(''));

  // 会话 E：system 是 stop_hook_summary，回合确实结束了
  await writeFile(join(dir, 'projA', 'eee.jsonl'), [
    line({type: 'user', cwd: 'D:\\projA', timestamp: '2026-01-01T00:00:00Z', message: {content: '收尾'}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:02Z', message: {content: [{type: 'text', text: '好了'}]}}),
    line({type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-01-01T00:00:03Z'}),
  ].join(''));

  // 会话 F：只有文字、没有工具调用 —— 也要算「有内容」，否则会被过滤掉不上墙
  await writeFile(join(dir, 'projA', 'fff.jsonl'), [
    line({type: 'user', cwd: 'D:\\projA', timestamp: '2026-01-01T00:00:00Z', message: {content: '聊聊'}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:02Z',
      message: {content: [{type: 'text', text: '纯文字回复'}], stop_reason: 'end_turn'}}),
  ].join(''));

  // 会话 G：一个失败的工具调用 —— 验证「工具名 + 错误原因」能一路传到事件和折叠结果
  await writeFile(join(dir, 'projA', 'ggg.jsonl'), [
    line({type: 'user', cwd: 'D:\\projA', timestamp: '2026-01-01T00:00:00Z', message: {content: '改文件'}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:02Z',
      message: {content: [{type: 'tool_use', id: 'tuE', name: 'Edit', input: {file_path: '/etc/x'}}]}}),
    line({type: 'user', timestamp: '2026-01-01T00:00:03Z',
      message: {content: [{type: 'tool_result', tool_use_id: 'tuE', is_error: true, content: 'EACCES: permission denied, open /etc/x'}]}}),
  ].join(''));

  const pushed = [];   // 收集送进任务流的事件
  const src = claude.create({root: dir, activeMs: 999999999, live: {push(it) { pushed.push(it); }}});
  await src.scan(true);
  const ss = src.sessions();
  const a = ss.find(s => s.id === 'aaa');
  const b = ss.find(s => s.id === 'bbb');
  const c = ss.find(s => s.id === 'ccc');
  const d = ss.find(s => s.id === 'ddd');
  const e = ss.find(s => s.id === 'eee');
  const f = ss.find(s => s.id === 'fff');
  const g = ss.find(s => s.id === 'ggg');
  const failEvt = pushed.find(p => p.ok === false);
  const stats = src.stats();

  const checks = [
    ['字符串 content 的用户消息被解析', !!a && a.msgs.some(m => m.role === 'user' && m.text.includes('纯字符串 content')), JSON.stringify(a && a.msgs)],
    ['字符串 message 的用户消息被解析', !!a && a.msgs.some(m => m.role === 'user' && m.text.includes('纯字符串 message')), JSON.stringify(a && a.msgs)],
    ['标题取到用户第一句', !!a && a.title.includes('纯字符串 content'), `title = ${a && a.title}`],
    ['工具调用正确配对', !!a && a.calls.length === 1 && a.calls[0].done === true && a.done === 1, `calls = ${a && JSON.stringify(a.calls.map(c => [c.name, c.done]))}`],
    ['回合结束后不再「推理中」', !!a && a.openStep == null && !a.current, `openStep = ${a && a.openStep}`],
    ['stop_reason=end_turn 也算回合结束', !!c && c.openStep == null && !c.current, `openStep = ${c && c.openStep}`],
    ['system/compact_boundary 不算结束', !!d && d.openStep === 1 && !d.current, `openStep = ${d && d.openStep}`],
    ['system/stop_hook_summary 算结束', !!e && e.openStep == null, `openStep = ${e && e.openStep}`],
    ['未闭合的调用算正在运行', !!b && !!b.current && b.openStep == null, `current = ${b && !!b.current}`],
    ['运行中与近活跃分开统计', stats.running === 3 && stats.active === 7, `stats = ${JSON.stringify(stats)}`],
    ['工作目录解析正确', !!a && a.cwd === 'D:\\projA' && !!b && b.cwd === 'D:\\projB', `${a && a.cwd} / ${b && b.cwd}`],
    ['失败调用记录了工具名和原因', !!g && !!g.lastFail && g.lastFail.name === 'Edit' && /EACCES/.test(g.lastFail.reason), JSON.stringify(g && g.lastFail)],
    ['失败事件带工具名和原因', !!failEvt && /Edit/.test(failEvt.name) && /EACCES/.test(failEvt.name), JSON.stringify(failEvt)],
    ['纯文字会话也算有内容（能上墙）', !!f && f.turns > 0 && f.calls.length === 0, `turns = ${f && f.turns}, calls = ${f && f.calls && f.calls.length}`],
  ];
  await rm(dir, {recursive: true, force: true});

  let bad = 0;
  console.log('MODE=claude  （合成会话文件，不需要后端）\n');
  for (const [name, pass, detail] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : '   → ' + detail}`);
    if (!pass) bad++;
  }
  console.log(`\n${checks.length - bad}/${checks.length} 通过`);
  process.exit(bad ? 1 : 0);
}

/* ---------------- MODE=core：聚合层单元测试 ---------------- */
if (MODE === 'core') {
  const core = await import('./lib/core.mjs');
  const checks = [];

  // #4 任务编号：超过 4000 不能返回空、不能重号
  const seen = new Set();
  let undef = 0;
  for (let i = 0; i < 4500; i++) {
    const v = core.tid('k' + i);
    if (!v) undef++;
    seen.add(v);
  }
  checks.push(['任务编号超过 4000 后不返回空、不重号', undef === 0 && seen.size === 4500, `空=${undef} 唯一=${seen.size}`]);

  // #2 事件积压：60 条要一次取全
  const live = core.createLive();
  for (let i = 0; i < 60; i++) live.push({verb: 'read', name: 'e' + i}, 'sid1', 'nm');
  const batch1 = live.since(0);
  const batch2 = live.since(batch1.length ? batch1[batch1.length - 1].seq : 0);
  const seqs = [...batch1, ...batch2].map(e => e.seq);
  checks.push(['积压 60 条事件能全部取到', batch1.length === 60 && batch2.length === 0 && Math.min(...seqs) === 1 && Math.max(...seqs) === 60,
    `第一批=${batch1.length} 第二批=${batch2.length}`]);

  // 积压超过单次上限时按顺序分页，不能丢掉中间的
  const live2 = core.createLive();
  for (let i = 0; i < 300; i++) live2.push({verb: 'read', name: 'x' + i}, 's', 'n');
  const p1 = live2.since(0);
  const p2 = live2.since(p1[p1.length - 1].seq);
  checks.push(['积压超过上限时按顺序分页、不漏记录',
    p1.length === 200 && p2.length === 100 && p1[0].seq === 1 && p2[p2.length - 1].seq === 300,
    `p1=${p1.length} p2=${p2.length} 首=${p1[0] && p1[0].seq} 尾=${p2.length && p2[p2.length - 1].seq}`]);

  // #5 任务上限：12 个智能体各 25 条任务、上限 240，不能有智能体被挤成「没有任务」
  // 第 23、24 条都还没结束，用来验证「当前任务取最新的那条，不是被旧的覆盖」
  const now = Date.now();
  const sessions = [];
  for (let a = 0; a < 12; a++) {
    const calls = [];
    for (let c = 0; c < 25; c++) {
      calls.push({callId: `c${a}-${c}`, name: 'Read', label: 'read ' + c, start: now - 1000, end: c >= 23 ? 0 : now, done: c < 23, error: false, argBytes: 10});
    }
    sessions.push({
      src: 'test', id: 's' + a, cwd: 'C:\\w' + a, title: 's' + a, depth: 0, parent: '', mtime: now,
      turns: 0, calls, todos: [], snippets: [], gaps: [], current: calls[24], done: 0, failed: 0,
    });
  }
  const st = core.buildState({
    sessions, live: null, codes: core.createCodes(),
    activeMs: 60000, maxAgents: 12, maxTasks: 240, servedFrom: 't', source: 't',
  });
  const withTask = new Set(st.tasks.map(t => t.agent));
  checks.push(['任务上限不会把忙碌智能体挤成空闲', st.agents.length === 12 && withTask.size === 12,
    `智能体=${st.agents.length} 有任务的=${withTask.size} 任务数=${st.tasks.length}`]);
  checks.push(['任务总数不超过上限', st.tasks.length <= 240, `任务数=${st.tasks.length}`]);

  const curs = st.tasks.filter(t => t.cur);
  checks.push(['每个忙碌智能体只有一条「当前任务」', curs.length === 12, `cur 任务=${curs.length}`]);
  checks.push(['当前任务是最新那条，没被旧的未完成调用覆盖',
    curs.length === 12 && curs.every(t => t.name === 'read 24'),
    `示例 = ${curs.slice(0, 3).map(t => t.name).join(', ')}`]);

  /* 工作区状态：谁在忙 / 哪里失败 / 多久没进展 */
  const now2 = Date.now();
  const mkS = (id, cwd, lastTime, opts = {}) => ({
    src: 'test', id, cwd, title: id, depth: 0, parent: '', mtime: now2 - 1000,
    turns: 1, calls: [], todos: [], snippets: [], gaps: [],
    current: null, done: 0, failed: 0, lastTime, lastFail: null, ...opts,
  });
  const st2 = core.buildState({
    sessions: [
      mkS('busy1', 'C:\\wfBusy', now2 - 5000, {current: {callId: 'x', name: 'Read', label: 'read a'}}),
      mkS('busy2', 'C:\\wfBusy', now2 - 6000, {failed: 1, lastFail: {name: 'Bash', label: 'Bash · ls', reason: 'EACCES: permission denied', at: now2 - 60000}}),
      mkS('stall1', 'C:\\wfStall', now2 - 15 * 60000),   // 15 分钟没进展
    ],
    live: null, codes: core.createCodes(),
    activeMs: 45 * 60000, maxAgents: 12, maxTasks: 240, servedFrom: 't', source: 't',
  });
  const wfBusy = st2.workflows.find(w => w.name === 'wfBusy');
  const wfStall = st2.workflows.find(w => w.name === 'wfStall');
  checks.push(['工作区状态带上「忙 / 失败 / 最近失败」',
    !!wfBusy && wfBusy.busy >= 1 && wfBusy.fails >= 1 && !!wfBusy.lastFail && wfBusy.lastFail.tool === 'Bash' && /EACCES/.test(wfBusy.lastFail.reason),
    JSON.stringify(wfBusy)]);
  checks.push(['工作区状态带上「多久没进展」并判定停滞',
    !!wfStall && wfStall.stalled === true && wfStall.idleMs > 5 * 60000,
    JSON.stringify(wfStall)]);
  checks.push(['有活动的工作区不会被误判停滞', !!wfBusy && wfBusy.stalled === false && wfBusy.idleMs < 60000,
    `idleMs=${wfBusy && wfBusy.idleMs}`]);

  let bad = 0;
  console.log('MODE=core  （聚合层单元测试，不需要后端）\n');
  for (const [name, pass, detail] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : '   → ' + detail}`);
    if (!pass) bad++;
  }
  console.log(`\n${checks.length - bad}/${checks.length} 通过`);
  process.exit(bad ? 1 : 0);
}

/* ---------------- MODE=dshsrc：DSH 合成会话（失败事件要带工具名） ---------------- */
if (MODE === 'dshsrc') {
  const dsh = await import('./sources/dsh.mjs');
  const root = await mkdtemp(join(tmpdir(), 'dsh-smoke-'));
  const ws = join(root, 'wsA'), sid = join(ws, 'sid1');
  await mkdir(sid, {recursive: true});
  // 真实 DSH 记录带 seq，事件流按 seq 递增才能送进任务流
  const rec = (type, seq, time, data) => JSON.stringify({type, seq, time, data}) + '\n';
  const lines = [
    rec('session', 1, 1000, {id: 'sid1', cwd: 'D:\\dshW'}),
    rec('tool/call', 2, 2000, {callId: 'c1', name: 'read', arguments: '{"file_path":"/etc/x"}'}),
    rec('tool/result', 3, 3000, {toolCallId: 'c1', message: {isError: true, content: 'EACCES: permission denied, open /etc/x'}}),
  ].join('');
  await writeFile(join(sid, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines, 'utf8')));

  const pushed = [];
  const src = dsh.create({root, activeMs: 999999999, live: {push(it) { pushed.push(it); }}});
  await src.scan(true);
  const s = src.sessions().find(x => x.id === 'sid1');
  const failEvt = pushed.find(p => p.ok === false);

  const checks = [
    ['合成 DSH 会话能解析', !!s && s.calls.length === 1 && s.cwd === 'D:\\dshW', `calls=${s && s.calls.length} cwd=${s && s.cwd}`],
    ['失败结果配上调用（failed=1）', !!s && s.failed === 1, `failed=${s && s.failed}`],
    ['折叠结果里带工具名和原因', !!s && !!s.lastFail && s.lastFail.name === 'read' && /EACCES/.test(s.lastFail.reason),
      JSON.stringify(s && s.lastFail)],
    // 复核意见：DSH 失败事件的工具名曾经查不到（映射用错字段），这条专门盯它
    ['DSH 失败事件带工具名（不是「工具 ·」）', !!failEvt && /^read · /.test(failEvt.name) && /EACCES/.test(failEvt.name),
      JSON.stringify(failEvt)],
  ];
  await rm(root, {recursive: true, force: true});

  let bad = 0;
  console.log('MODE=dshsrc  （DSH 合成会话，验证失败事件的工具名）\n');
  for (const [name, pass, detail] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : '   → ' + detail}`);
    if (!pass) bad++;
  }
  console.log(`\n${checks.length - bad}/${checks.length} 通过`);
  process.exit(bad ? 1 : 0);
}

/* ---------------- MODE=codex：坏行 / 退出码 ---------------- */
if (MODE === 'codex') {
  const codex = await import('./sources/codex.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'codex-smoke-'));
  const rec = (type, payload, ts) => JSON.stringify({timestamp: ts, type, payload}) + '\n';

  // 中间故意插两条「能 JSON.parse 但不是对象」的坏行：不能拖垮整份会话
  await writeFile(join(dir, 'rollout-a.jsonl'), [
    rec('session_meta', {id: 'csA', cwd: 'D:\\wA'}, '2026-01-01T00:00:00Z'),
    'null\n',
    '"just a string"\n',
    rec('event_msg', {type: 'task_started'}, '2026-01-01T00:00:01Z'),
    rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'c1'}, '2026-01-01T00:00:02Z'),
    rec('response_item', {type: 'function_call_output', call_id: 'c1', output: 'Process exited with code 7: EACCES: permission denied, open /etc/x'}, '2026-01-01T00:00:03Z'),
    rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"pwd"}', call_id: 'c2'}, '2026-01-01T00:00:04Z'),
    rec('response_item', {type: 'function_call_output', call_id: 'c2', output: 'Process exited with code 0'}, '2026-01-01T00:00:05Z'),
  ].join(''));

  const pushed = [];   // 收集送进任务流的事件，验证失败原因真的传出去了
  const src = codex.create({roots: [dir], activeMs: 999999999, live: {push(it) { pushed.push(it); }}});
  await src.scan(true);
  const s = src.sessions().find(x => x.id === 'csA');
  const failEvt = pushed.find(p => p.ok === false);

  const checks = [
    ['坏行不影响整份会话解析', !!s && s.calls.length === 2, `calls = ${s && s.calls.length}`],
    ['会话元信息仍能读到', !!s && s.cwd === 'D:\\wA', `cwd = ${s && s.cwd}`],
    ['"Process exited with code 1" 判为失败', !!s && s.failed === 1, `failed = ${s && s.failed}, done = ${s && s.done}`],
    ['退出码 0 不算失败', !!s && s.done === 1, `done = ${s && s.done}`],
    // 复核意见 1：失败原因必须真的接通，不能只有工具名
    ['折叠结果里保留了失败原因（退出码 + EACCES）', !!s && !!s.lastFail && /exit 7/.test(s.lastFail.reason) && /EACCES: permission denied/.test(s.lastFail.reason),
      `lastFail=${JSON.stringify(s && s.lastFail)}`],
    ['失败事件里带工具名和原因', !!failEvt && /shell/.test(failEvt.name) && /EACCES/.test(failEvt.name) && /exit 7/.test(failEvt.name),
      `事件=${JSON.stringify(failEvt)}`],
  ];
  await rm(dir, {recursive: true, force: true});

  let bad = 0;
  console.log('MODE=codex  （坏行 + 退出码判断）\n');
  for (const [name, pass, detail] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : '   → ' + detail}`);
    if (!pass) bad++;
  }
  console.log(`\n${checks.length - bad}/${checks.length} 通过`);
  process.exit(bad ? 1 : 0);
}

/* ---------------- MODE=codes：多个视图的编号互不干扰 ---------------- */
if (MODE === 'codes') {
  const dir = await mkdtemp(join(tmpdir(), 'codes-smoke-'));
  const rec = (type, payload, ts) => JSON.stringify({timestamp: ts, type, payload}) + '\n';
  for (const sid of ['cs1', 'cs2']) {
    await writeFile(join(dir, `rollout-${sid}.jsonl`), [
      rec('session_meta', {id: sid, cwd: 'D:\\w1'}, '2026-01-01T00:00:00Z'),
      rec('event_msg', {type: 'task_started'}, '2026-01-01T00:00:01Z'),
      rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'c-' + sid}, '2026-01-01T00:00:02Z'),
      rec('response_item', {type: 'function_call_output', call_id: 'c-' + sid, output: 'ok'}, '2026-01-01T00:00:03Z'),
    ].join(''));
  }

  const TP = 8791;
  const child = spawn(process.execPath, ['dsh-bridge.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(TP), OPEN: '',
      CODEX_SESSIONS: dir,
      DSH_SESSIONS: join(dir, 'no-such-dsh'),
      CLAUDE_PROJECTS: join(dir, 'no-such-claude'),
    },
    stdio: 'ignore',
  });
  const res = {};
  try {
    for (let i = 0; i < 80; i++) {
      try { await rawGet('/', {}, TP); break; } catch { await new Promise(r => setTimeout(r, 300)); }
    }
    const fetchState = async q => JSON.parse((await rawGet(q, {}, TP)).body);
    const fetchEvents = async q => JSON.parse((await rawGet(q, {}, TP)).body);
    const a1 = await fetchState('/api/agent-ops/state?source=codex');
    // 查一个空源 —— 旧实现会在这里把别家的编号全释放掉
    await fetchState('/api/agent-ops/state?source=dsh');
    const ev = await fetchEvents('/api/agent-ops/events?source=codex&after=0');
    const a2 = await fetchState('/api/agent-ops/state?source=codex');
    res.codes1 = (a1.agents || []).map(a => a.code).filter(Boolean);
    res.codes2 = (a2.agents || []).map(a => a.code).filter(Boolean);
    res.eventAgents = (Array.isArray(ev) ? ev : []).map(e => e.agent);
  } finally {
    child.kill();
    await rm(dir, {recursive: true, force: true});
  }

  const checks = [
    ['Codex 会话有编号', res.codes1.length === 2, `codes = ${JSON.stringify(res.codes1)}`],
    ['查别的源不会清空本源的智能体编号', res.eventAgents.length > 0 && res.eventAgents.every(Boolean),
      `事件里的编号 = ${JSON.stringify(res.eventAgents)}`],
    ['同一源前后两次编号一致', JSON.stringify(res.codes1) === JSON.stringify(res.codes2),
      `${JSON.stringify(res.codes1)} vs ${JSON.stringify(res.codes2)}`],
  ];
  let bad = 0;
  console.log('MODE=codes  （多视图编号隔离）\n');
  for (const [name, pass, detail] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : '   → ' + detail}`);
    if (!pass) bad++;
  }
  console.log(`\n${checks.length - bad}/${checks.length} 通过`);
  process.exit(bad ? 1 : 0);
}

/* ---------------- 最小 DOM 垫片 ---------------- */
function mkCtx() {
  const base = {
    measureText: () => ({ width: 20 }),
    createConicGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
    filter: undefined,
  };
  return new Proxy(base, {
    get: (t, p) => (p in t ? t[p] : () => {}),
    set: (t, p, v) => { t[p] = v; return true; },
  });
}

function mkEl(id = '', cls = '') {
  const el = {
    id, className: cls, innerHTML: '', textContent: '', hidden: false,
    style: {}, dataset: {}, width: 800, height: 400,
    clientHeight: 300, clientWidth: 800, offsetWidth: 200, offsetHeight: 80,
    classList: {
      _s: new Set(),
      toggle(c, on) { on === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : on ? this._s.add(c) : this._s.delete(c); },
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); },
    },
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, appendChild() {}, querySelectorAll() { return []; },
    getBoundingClientRect() {
      return { width: this.clientWidth, height: this.clientHeight, left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight };
    },
    getContext() { return mkCtx(); },
  };
  return el;
}

const byId = new Map();
const ids = ['stage', 'sc', 'tip', 'theme', 'pause', 'feed', 'agents', 'code',
  'clock', 's0', 's1', 's2', 's3', 's4', 's5', 'noteMain', 'agMeta', 'agTitle', 'feedMeta',
  'codeMeta', 'stepN', 'cfl', 'cflst', 'pc', 'pcBox', 'mode', 'srcSel', 'servedTag', 'wfStatus', 'replayTag'];
for (const id of ids) byId.set('#' + id, mkEl(id));
byId.get('#stage').clientHeight = 700;
byId.get('#stage').clientWidth = 1600;
byId.get('#sc').clientHeight = 700;

const root = mkEl('root');
const body = mkEl('body');
const stats = Array.from({ length: 6 }, () => mkEl('', 'stat'));

const document = {
  documentElement: root,
  body,
  fonts: { ready: Promise.resolve() },
  querySelector: s => byId.get(s) || null,
  querySelectorAll: s => (s === '.stat' ? stats : []),
  createElement: () => mkEl(),
  addEventListener() {},
  getElementById: id => byId.get('#' + id) || null,
};

let stateCalls = 0;
/* MODE=cur 用的手工状态：同一个智能体有两条 run 任务，旧的**排在后面**。
   老前端「最后一个 run 算当前」会选到 T-102，新前端应该只认 cur 的 T-101。 */
const CUR_PAYLOAD = {
  tasks: [
    {id: 'T-101', name: '当前任务', wf: 0, state: 'run', prog: 0.8, agent: '01', cur: true},
    {id: 'T-102', name: '旧的未完成调用', wf: 0, state: 'run', prog: 0.8, agent: '01'},
  ],
  agents: [{code: '01', name: '智能体', title: '智能体', depth: 0, wf: 0}],
  workflows: [{i: 0, id: 'W01', name: 'w', q: 0.9}],
  links: [], overflow: 0, snippets: [], source: 'test', servedFrom: 'test',
};
/* MODE=evil 用的手工状态：后端返回带 HTML 的名字，验证前端转义 */
const EVIL_PAYLOAD = {
  tasks: [{id: 'T-1', name: '<img src=x onerror=alert(1)>', wf: 0, state: 'run', prog: 0.5, agent: '01', cur: true}],
  agents: [{code: '01', name: '<img src=x onerror=alert(1)>', title: '<img src=x onerror=alert(1)>', depth: 0, wf: 0}],
  workflows: [{i: 0, id: 'W01', name: '<b>x</b>', q: 0.9}],
  links: [], overflow: 0, snippets: [], source: 'test', servedFrom: 'test',
};
const EVIL_EVENTS = [{seq: 1, verb: 'read', task_name: '<script>alert(1)</script>', kind: 'msg', agent: '01', name: '<img>'}];

/* MODE=particles 用的手工状态 + 事件：验证「一粒子 = 一条真实事件」 */
const PARTICLE_PAYLOAD = {
  tasks: [
    {id: 'T-1', name: '读文件', wf: 0, state: 'run', prog: 0.5, agent: '01', cur: true},
    {id: 'T-2', name: '写代码', wf: 0, state: 'run', prog: 0.5, agent: '02', cur: true},
  ],
  agents: [
    {code: '01', name: '甲', title: '甲', depth: 0, wf: 0},
    {code: '02', name: '乙', title: '乙', depth: 0, wf: 0},
  ],
  workflows: [{i: 0, id: 'W01', name: 'w', q: 0.9}],
  links: [], overflow: 0, snippets: [], source: 'test', servedFrom: 'test',
};
const PARTICLE_EVENTS = [
  {seq: 1, verb: 'read', task_name: '读文件', kind: 'tool', agent: '01', name: '甲'},
  {seq: 2, verb: 'build', task_name: '写代码', kind: 'tool', agent: '01', name: '甲'},      // 与上一条同智能体连发 → 漩涡
  {seq: 3, verb: 'check', task_name: '核验', kind: 'tool', agent: '02', name: '乙'},
  {seq: 4, verb: 'review', task_name: '复核', kind: 'msg', agent: '02', name: '乙'},        // 同上 → 漩涡
  {seq: 5, verb: 'check', task_name: '命令失败', kind: 'tool', agent: '01', name: '甲', ok: false},   // 出问题 → 回流
];
/* 「后端重启」之后：序号从 1 重来，但内容不同 —— 如果旧去重集合没清空，这些会被当成重复全丢掉 */
const PARTICLE_EVENTS_RESTARTED = PARTICLE_EVENTS.map((e, i) => ({...e, task_name: '重启后-' + (i + 1)}));

/* MODE=lanes 用的手工状态：6 个工作区，验证「第 5 个起并进第 4 条合并泳道，并标 +」 */
const LANES_PAYLOAD = {
  tasks: [{id: 'T-1', name: 'x', wf: 0, state: 'run', prog: 0.5, agent: '01', cur: true}],
  agents: [0, 1, 2, 3, 4, 5].map(i => ({code: String(i + 1).padStart(2, '0'), name: 'a' + i, title: 'a' + i, depth: 0, wf: i})),
  workflows: [0, 1, 2, 3, 4, 5].map(i => ({i, id: 'W0' + (i + 1), name: 'w' + i, q: 0.9})),
  links: [], overflow: 0, snippets: [], source: 'test', servedFrom: 'test',
};
const LANES_EVENTS = [0, 1, 2, 3, 4, 5].map(i => (
  {seq: i + 1, verb: 'read', task_name: 'e' + i, kind: 'tool', agent: String(i + 1).padStart(2, '0'), name: 'a' + i}
));

/* MODE=status 用的手工状态：三种工作区状态各一个，验证大屏能一眼看出问题 */
const STATUS_PAYLOAD = () => ({
  tasks: [
    {id: 'T-1', name: 'a', wf: 0, state: 'run', prog: 0.5, agent: '01', cur: true},
    {id: 'T-2', name: 'b', wf: 1, state: 'done', prog: 1, agent: '02'},
    {id: 'T-3', name: 'c', wf: 2, state: 'done', prog: 1, agent: '03'},
    {id: 'T-4', name: 'd', wf: 3, state: 'run', prog: 0.5, agent: '04', cur: true},
  ],
  agents: [
    {code: '01', name: 'a1', title: 'a1', depth: 0, wf: 0},
    {code: '02', name: 'a2', title: 'a2', depth: 0, wf: 1},
    {code: '03', name: 'a3', title: 'a3', depth: 0, wf: 2},
    {code: '04', name: 'a4', title: 'a4', depth: 0, wf: 3},
  ],
  workflows: [
    {i: 0, id: 'W01', name: 'busy-wf', q: 0.9, busy: 2, fails: 0, idleMs: 3000, stalled: false, lastFail: null},
    {i: 1, id: 'W02', name: 'fail-wf', q: 0.6, busy: 0, fails: 3, idleMs: 60000, stalled: false,
      lastFail: {tool: 'Bash', reason: 'exit 1', detail: 'ls', at: Date.now() - 60000}},
    {i: 2, id: 'W03', name: 'stall-wf', q: 0.95, busy: 0, fails: 0, idleMs: 900000, stalled: true, lastFail: null},
    {i: 3, id: 'W04', name: 'stall-busy', q: 0.9, busy: 1, fails: 0, idleMs: 1200000, stalled: true, lastFail: null},
  ],
  links: [], overflow: 0, snippets: [], source: 'test', servedFrom: 'test',
});

async function fakeFetch(u, o) {
  const isState = String(u).startsWith('/api/agent-ops/state');
  const isEvents = String(u).startsWith('/api/agent-ops/events');
  if (MODE === 'particles') {
    // 第 6 次拉 state 起模拟「后端重启」：epoch 变了，事件序号从 1 重来
    if (isState) {
      stateCalls++;
      const restarted = stateCalls > 2;   // 第 3 次起模拟重启，留出时间让回放重新生效
      return {ok: true, status: 200, json: async () => restarted ? {...PARTICLE_PAYLOAD, epoch: 'e2'} : {...PARTICLE_PAYLOAD, epoch: 'e1'}};
    }
    if (isEvents) return {ok: true, status: 200, json: async () => (stateCalls > 2 ? PARTICLE_EVENTS_RESTARTED : PARTICLE_EVENTS)};
  }
  if (MODE === 'status') {
    if (isState) return {ok: true, status: 200, json: async () => STATUS_PAYLOAD()};
    if (isEvents) return {ok: true, status: 200, json: async () => []};
  }
  if (MODE === 'lanes') {
    if (isState) return {ok: true, status: 200, json: async () => LANES_PAYLOAD};
    if (isEvents) return {ok: true, status: 200, json: async () => LANES_EVENTS};
  }
  if (MODE === 'cur') {
    if (isState) return {ok: true, status: 200, json: async () => CUR_PAYLOAD};
    if (isEvents) return {ok: true, status: 200, json: async () => []};
  }
  if (MODE === 'evil') {
    if (isState) return {ok: true, status: 200, json: async () => EVIL_PAYLOAD};
    if (isEvents) return {ok: true, status: 200, json: async () => EVIL_EVENTS};
  }
  // MODE=recover：第一次拉 state 直接失败，验证"失败后还能自己接上"
  if (MODE === 'recover' && isState) {
    stateCalls++;
    if (stateCalls === 1) throw new Error('simulated network down');
  }
  const r = await fetch(ORIGIN + u, o);
  // MODE=pop：第 3 次拉 state 时凭空多出一个会话，用来验证"新会话放大"动画
  if (MODE !== 'pop' || !isState) return r;
  stateCalls++;
  if (stateCalls < 3) return r;
  const d = await r.json();
  d.agents = (d.agents || []).concat([{ code: '99', name: '新会话', title: '新会话', depth: 0, wf: 0, parent: '' }]);
  return { ok: true, status: 200, json: async () => d };
}

const errors = [];
const roInstances = [];   // 测试里可以再次触发 resize
const sandbox = {
  document,
  window: { devicePixelRatio: 2 },
  devicePixelRatio: 2,
  location: { protocol: 'http:' },
  performance: { now: () => Date.now() },
  console: { log() {}, warn() {}, error: (...a) => errors.push(a.map(String).join(' ')) },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '#123456' }),
  MutationObserver: class { observe() {} disconnect() {} },
  ResizeObserver: class { constructor(cb) { this.cb = cb; roInstances.push(this); } observe(el) { this.el = el; try { this.cb([{target: el}], this); } catch (e) { /* 首次布局失败忽略 */ } } },
  requestAnimationFrame: cb => setTimeout(() => cb(Date.now()), 16),
  cancelAnimationFrame: () => {},
  Path2D: class { moveTo() {} lineTo() {} arc() {} quadraticCurveTo() {} closePath() {} rect() {} },
  URLSearchParams, URL, AbortController,
  fetch: (u, o) => fakeFetch(u, o),
  setTimeout, setInterval, clearTimeout, clearInterval,
};

/* ---------------- 跑起来 ---------------- */
const html = await readFile(join(ROOT, 'index.html'), 'utf8');
const m = html.match(/^<script>([\s\S]*?)^<\/script>/m);
if (!m) { console.error('没找到 <script> 块'); process.exit(1); }

vm.createContext(sandbox);
try {
  vm.runInContext(m[1], sandbox, { filename: 'index.html<script>' });
} catch (err) {
  console.error('脚本执行抛错：', err);
  process.exit(1);
}

// particles 模式要多等一会儿：先来事件、再等超过 3 秒触发回放
await new Promise(r => setTimeout(r, MODE === 'particles' ? 6500 : 3000));

/* ---------------- 断言 ---------------- */
const text = id => String(byId.get('#' + id)?.textContent ?? '').trim();
const inner = id => String(byId.get('#' + id)?.innerHTML ?? '');
const liCount = () => (inner('agents').match(/<li/g) || []).length;

// dsh 模式额外拿一份接口原始数据：用来核对前端的选择，而不是拿前端自己的字段自证
const rawState = MODE === 'dsh'
  ? JSON.parse((await rawGet('/api/agent-ops/state')).body)
  : null;

const checks = MODE === 'demo' ? [
  ['拉不到接口时降级为演示模式', text('mode') === '演示数据 · 未连接', `mode = "${text('mode')}"`],
  ['演示模式打上水印标记', body.dataset.demo === '1', `data-demo = ${body.dataset.demo}`],
  ['演示数据仍然渲染 12 个智能体', liCount() === 12, `li 数 = ${liCount()}`],
  ['演示数据仍然填满任务流', /读取|生成|核验|复核/.test(inner('feed')), `feed 前 80 字 = ${inner('feed').slice(0, 80)}`],
  ['降级时没有 console.error', errors.length === 0, errors.slice(0, 3).join(' | ')],
] : MODE === 'dsh' ? [
  ['模式切到实时数据', text('mode') === '实时数据', `mode = "${text('mode')}"`],
  ['至少上墙 1 个 DSH 会话', liCount() >= 1, `li 数 = ${liCount()}`],
  ['任务数来自真实会话', Number(text('s0')) > 0, `s0 = "${text('s0')}"`],
  ['工作流数来自工作区', Number(text('s2')) >= 1, `s2 = "${text('s2')}"`],
  ['任务流有 DSH 事件', /读取|生成|核验|复核/.test(inner('feed')), `feed 前 100 字 = ${inner('feed').slice(0, 100)}`],
  ['任务流按会话分组', inner('feed').includes('class="grp"'), `feed 前 200 字 = ${inner('feed').slice(0, 200)}`],
  ['智能体绑到了真实任务（不是 idle）', /T-\d+ · /.test(inner('agents')), inner('agents').slice(0, 200)],
  ['WORKSPACE 显示真实文件', /\.(mjs|js|cjs|ts|tsx|md|json|html|css|py)\b/.test(text('codeMeta')) || text('codeMeta') === '无代码记录', `codeMeta = "${text('codeMeta')}"`],
  ['数据源下拉已填充', inner('srcSel').includes('Codex') && inner('srcSel').includes('Claude'), `srcSel = ${String(inner('srcSel')).slice(0, 160)}`],
  ['页面标出了服务目录', text('servedTag').length > 0, `servedTag = "${text('servedTag')}"`],
  ['工作区下标都在范围内', (() => {
    const d = sandbox.window.__AGENT_OPS__;
    if (!d || !d.wfs.length) return false;
    return d.tasks.every(t => t.wf >= 0 && t.wf < d.wfs.length)
      && d.agents.every(a => a.wf >= 0 && a.wf < d.wfs.length);
  })(), (() => {
    const d = sandbox.window.__AGENT_OPS__;
    return d ? `wfs=${d.wfs.length} taskWf=${[...new Set(d.tasks.map(t => t.wf))]} agentWf=${[...new Set(d.agents.map(a => a.wf))]}` : '没有调试钩子';
  })()],
  ['任务按工作区正确归属（没有全挤进 W01）', (() => {
    const d = sandbox.window.__AGENT_OPS__;
    if (!d || d.wfs.length < 2) return true;    // 只有一个工作区时这条不适用
    return d.tasks.some(t => t.wf > 0);
  })(), (() => {
    const d = sandbox.window.__AGENT_OPS__;
    return d ? `wfs=${d.wfs.length} taskWf=${[...new Set(d.tasks.map(t => t.wf))]}` : '没有调试钩子';
  })()],
  // 用接口**原始**的 cur 标记算出「预期任务 ID」，再核对前端实际选中的那条。
  // 不能拿前端内部的 cur 字段自证 —— 那个字段本身就是被测对象。
  ['智能体的当前任务与接口 cur 标记一致', (() => {
    const d = sandbox.window.__AGENT_OPS__;
    if (!d || !rawState) return false;
    const want = new Map();
    for (const t of rawState.tasks || []) if (t.cur) want.set(String(t.agent), String(t.id));
    if (!want.size) return true;                 // 后端没给 cur 才不适用
    for (const [code, id] of want) {
      const a = d.agents.find(x => x.code === code);
      if (!a) continue;                          // 这个智能体没上墙
      if (a.task < 0) return false;
      if (String(d.tasks[a.task].id) !== id) return false;
    }
    return true;
  })(), (() => {
    const d = sandbox.window.__AGENT_OPS__;
    if (!d || !rawState) return '缺少调试钩子或原始状态';
    const want = new Map();
    for (const t of rawState.tasks || []) if (t.cur) want.set(String(t.agent), String(t.id));
    return d.agents.map(a => {
      const got = a.task >= 0 ? String(d.tasks[a.task].id) : 'idle';
      return `${a.code}:期望${want.get(a.code) || '-'}/实际${got}`;
    }).join(' ');
  })()],
  ['没有演示水印', body.dataset.demo === '0', `data-demo = ${body.dataset.demo}`],
  ['没有离线标记', !body.dataset.offline, `data-offline = ${body.dataset.offline}`],
  ['运行期没有 console.error', errors.length === 0, errors.slice(0, 3).join(' | ')],
] : MODE === 'recover' ? [
  ['首次失败后能自己接上后端', text('mode') === '实时数据', `mode = "${text('mode')}"（第一次拉取是故意失败的）`],
  ['接上后数据是真的', Number(text('s0')) > 0 && liCount() >= 1, `s0 = "${text('s0')}", li = ${liCount()}`],
  ['水印已经撤掉', body.dataset.demo !== '1', `data-demo = ${body.dataset.demo}`],
  ['运行期没有 console.error', errors.length === 0, errors.slice(0, 3).join(' | ')],
] : MODE === 'pop' ? [
  ['新会话进了调度面板', inner('agents').includes('99'), inner('agents').slice(0, 180)],
  ['新会话打上 pop 放大动画类', inner('agents').includes(' pop'), inner('agents').slice(0, 180)],
  ['模式仍是实时数据', text('mode') === '实时数据', `mode = "${text('mode')}"`],
  ['运行期没有 console.error', errors.length === 0, errors.slice(0, 3).join(' | ')],
] : MODE === 'ring' ? (() => {
  const rs = sandbox.window.__AGENT_OPS__ ? sandbox.window.__AGENT_OPS__.ringSignature : null;
  if (!rs) return [['页面暴露了环带签名函数', false, '没有 __AGENT_OPS__.ringSignature']];
  const S0 = [{ms: 100, ok: true}, {ms: 100, ok: true}];
  const A = {groups: [{file: 'a.js', lines: ['x', 'y']}], ops: [{ms: 1, ok: true}], nums: [1], sizes: [10], streaks: S0};
  const B = {groups: [{file: 'a.js', lines: ['x', 'z']}], ops: [{ms: 1, ok: true}], nums: [1], sizes: [10], streaks: S0};   // 形状相同、内容不同
  const C = {groups: [{file: 'a.js', lines: ['x', 'y']}], ops: [{ms: 1, ok: true}], nums: [1], sizes: [10], streaks: S0};
  const D = {groups: [{file: 'a.js', lines: ['x', 'y']}], ops: [{ms: 999, ok: false}], nums: [1], sizes: [10], streaks: S0};  // 数量不变，耗时和状态变了
  const E = {groups: [{file: 'a.js', lines: ['x', 'y']}], ops: [{ms: 1, ok: true}], nums: [7], sizes: [10], streaks: S0};
  // 谱线数量不变、数值变了（日志间隔到上限后仍会变）
  const F = {groups: [{file: 'a.js', lines: ['x', 'y']}], ops: [{ms: 1, ok: true}], nums: [1], sizes: [10],
    streaks: [{ms: 5000, ok: true}, {ms: 100, ok: true}]};
  return [
    ['环带签名能察觉代码内容变化（形状不变）', rs(A) !== rs(B), `${rs(A)} vs ${rs(B)}`],
    ['相同内容签名一致', rs(A) === rs(C), `${rs(A)} vs ${rs(C)}`],
    ['组数变化签名也变', rs(A) !== rs({groups: [], ops: [{ms: 1, ok: true}], nums: [1], sizes: [10], streaks: S0}), `${rs(A)}`],
    ['行数变化签名也变', rs(A) !== rs({groups: [{file: 'a.js', lines: ['x']}], ops: [{ms: 1, ok: true}], nums: [1], sizes: [10], streaks: S0}), `${rs(A)}`],
    ['耗时/成功状态变化签名也变（数量不变）', rs(A) !== rs(D), `${rs(A)} vs ${rs(D)}`],
    ['数字块变化签名也变', rs(A) !== rs(E), `${rs(A)} vs ${rs(E)}`],
    ['谱线数值变化签名也变（数量不变）', rs(A) !== rs(F), `${rs(A)} vs ${rs(F)}`],
  ];
})() : MODE === 'cur' ? (() => {
  const d = sandbox.window.__AGENT_OPS__;
  if (!d) return [['调试钩子可用', false, '没有 __AGENT_OPS__']];
  const a = d.agents[0];
  const picked = a && a.task >= 0 ? d.tasks[a.task] : null;
  return [
    ['乱序的 run 任务不会覆盖 cur', !!picked && picked.id === 'T-101', `选中的是 ${picked && picked.id}（应为 T-101）`],
    ['前端保留了 cur 字段', d.tasks.some(t => t.cur === true), JSON.stringify(d.tasks.map(t => [t.id, !!t.cur]))],
  ];
})() : MODE === 'particles' ? await (async () => {
  const d = sandbox.window.__AGENT_OPS__;
  const s = d && d.particleStats ? d.particleStats() : null;
  if (!s) return [['粒子统计可用', false, '没有 __AGENT_OPS__.particleStats']];
  // 流向验证：隔一秒再采样，向右位移次数必须增长（粒子朝"产出"方向流）
  const before = s;
  await new Promise(r => setTimeout(r, 1200));
  const after = sandbox.window.__AGENT_OPS__.particleStats();
  return [
    ['粒子由真实事件生成', s.spawned > 0, JSON.stringify({spawned: s.spawned, ring: s.ring})],
    ['5 条事件都进了环形缓冲', s.ring === 5, `ring=${s.ring}`],
    ['面板上还有活着的粒子', s.parts > 0, `parts=${s.parts}`],
    ['粒子颜色只来自真实动词', s.verbs.length > 0 && s.verbs.every(v => ['read', 'build', 'check', 'review'].includes(v)),
      `verbs=${JSON.stringify(s.verbs)}`],
    ['有真实事件时没有背景粒子', s.ambient === 0, `ambient=${s.ambient}`],
    ['空闲超过 3 秒自动回放', s.replay === true, `replay=${s.replay}`],
    // 光有粒子数组不算数：得真的走过绘制循环（同时证明画布尺寸被正确算出来了）
    ['粒子真的被画出来了', s.steps > 0 && s.drawn > 0, `绘制次数=${s.steps} 上次画出=${s.drawn} 画布=${JSON.stringify(s.size)}`],
    // 流向必须朝"产出"方向：1.2 秒内要有实际向右的位移
    ['粒子整体向右流动（朝产出方向）', after.rightMoves > before.rightMoves,
      `向右位移次数 ${before.rightMoves} → ${after.rightMoves}`],
    ['粒子都在合法泳道里', after.lanes.every(l => l >= 0 && l < 4), `lanes=${JSON.stringify(after.lanes)}`],
    // 失败事件 → 回流（往左走）
    ['失败的调用会回流（粒子往左）', after.backflow > 0 && after.leftMoves > before.leftMoves,
      `回流粒子 ${before.backflow} → ${after.backflow}，向左位移 ${before.leftMoves} → ${after.leftMoves}`],
    // 同一智能体连续事件 → 漩涡
    ['同一智能体的连续调用会形成漩涡', s.orbits > 0 || after.orbits > 0, `orbits=${s.orbits}/${after.orbits}`],
    // 后端重启（epoch 变化）必须把粒子状态一起重置，否则新事件会被旧 seq 去重掉
    ['后端重启后粒子状态被重置', after.restarts >= 1, `restarts=${after.restarts}`],
    // 画布缩小：已有粒子要按比例缩放，不能被当成"流出边界"批量删掉
    // 重启后新序号的事件必须真的变成粒子（不是只把计数器 +1）
    ['重启后新序号事件确实生成了粒子', after.ringNames.some(n => n.includes('重启后')) && after.spawned > s.spawned,
      `ring=${JSON.stringify(after.ringNames)} spawned ${s.spawned}→${after.spawned}`],
    ['重启后旧的去重集合已清空', after.evtSeenSize <= after.ring, `evtSeen=${after.evtSeenSize} ring=${after.ring}`],
    // 走真实的 resize 回调（改元素尺寸 + 再触发 ResizeObserver），不是直接调缩放函数
    ['真实缩小时粒子按比例换算、不成批消失', (() => {
      const api = sandbox.window.__AGENT_OPS__;
      api.setPaused(true);   // 冻结，保证前后对比的是同一批粒子
      const b = api.particleStats();
      const box = byId.get('#pcBox');
      const cv = byId.get('#pc');
      if (!box || !cv) return false;
      // 页面 fitCv 读的是 canvas 自己的 getBoundingClientRect，所以画布尺寸要真的改小
      cv.clientWidth = Math.max(60, Math.round(cv.clientWidth * 0.6));
      cv.clientHeight = Math.max(40, Math.round(cv.clientHeight * 0.6));
      box.clientWidth = cv.clientWidth; box.clientHeight = cv.clientHeight;
      for (const ro of roInstances) if (ro.el === box) ro.observe(box);
      const a2 = api.particleStats();
      api.setPaused(false);
      // 画布确实变小了，才谈得上验证
      if (!(a2.size[0] < b.size[0])) return false;
      // 数量不变（没有被越界删掉），归一化坐标 u 一个都没变（不是被二次缩放）
      return a2.parts === b.parts && JSON.stringify(a2.sampleU) === JSON.stringify(b.sampleU)
        && Math.abs(a2.maxX - b.maxX) < 0.02;
    })(), (() => {
      const a = sandbox.window.__AGENT_OPS__.particleStats();
      return `parts=${a.parts} size=${JSON.stringify(a.size)} maxX=${a.maxX.toFixed(3)} u=${JSON.stringify(a.sampleU)}`;
    })()],
    // 回归：漩涡的切向力曾经过强，把粒子甩到上下边并"钉"在那里（看起来像往下沉）
    ['粒子竖向居中，没有沉到底边', after.avgY > 0.30 && after.avgY < 0.70, `平均竖向位置=${after.avgY.toFixed(3)}（0.5 为居中）`],
    ['没有粒子贴在上下边缘', after.atEdge < 0.15, `贴边比例=${(after.atEdge * 100).toFixed(1)}%`],
  ];
})() : MODE === 'evil' ? [
  ['智能体名里的 HTML 被转义', !inner('agents').includes('<img') && inner('agents').includes('&lt;img'),
    inner('agents').slice(0, 120)],
  ['任务流里没有可执行的 <script>', !inner('feed').includes('<script'), inner('feed').slice(0, 120)],
  ['仍然切到实时模式', text('mode') === '实时数据', `mode = "${text('mode')}"`],
] : MODE === 'status' ? (() => {
  const html = inner('wfStatus');
  return [
    ['忙碌的工作区标成 busy 并显示在忙数量', html.includes('class="busy"') && html.includes('忙 2'), html.slice(0, 200)],
    ['失败的工作区标成 fail 并显示失败数与原因',
      html.includes('class="fail"') && html.includes('失败 3') && html.includes('exit 1'), html.slice(0, 400)],
    ['长时间没进展的工作区标成 stall 并显示多久没动', html.includes('class="stall"') && html.includes('停滞 15m'), html.slice(0, 400)],
    ['状态列表按工作区逐行渲染', (html.match(/<li /g) || []).length === 4, '行数=' + (html.match(/<li /g) || []).length],
    // 停滞优先：卡了 20 分钟但还挂着一条未完成调用，必须显示停滞，同时保留「忙 1」
    ['停滞且仍有未完成调用时显示停滞而不是忙碌',
      /class="stall"[^>]*><span class="wid">W04<\/span>[\s\S]*?停滞 20m[\s\S]*?忙 1/.test(html), html.slice(0, 700)],
  ];
})() : MODE === 'lanes' ? (() => {
  const d = sandbox.window.__AGENT_OPS__;
  const s = d && d.particleStats ? d.particleStats() : null;
  if (!s) return [['粒子统计可用', false, '没有 __AGENT_OPS__.particleStats']];
  const labels = s.laneLabels || [];
  return [
    ['6 个工作区只开 4 条泳道', labels.length === 4, `泳道=${JSON.stringify(labels)}`],
    ['前三条按工作区命名', labels[0] === 'W01' && labels[1] === 'W02' && labels[2] === 'W03', JSON.stringify(labels)],
    // 第 5 个及以后的工作区并进最后一条，标签必须带 +，不能假装是 W04
    ['第 4 条是合并泳道并标了 +', labels[3] === 'W04+', `最后一条=${labels[3]}`],
    ['没有粒子落进不存在的泳道', s.lanes.every(l => l >= 0 && l < 4), `lanes=${JSON.stringify(s.lanes)}`],
  ];
})() : [
  ['模式切到实时数据', text('mode') === '实时数据', `mode = "${text('mode')}"`],
  ['TASKS 指标被真实数据刷新', text('s0') === '64', `s0 = "${text('s0')}"`],
  ['WORKFLOWS 指标被真实数据刷新', text('s2') === '11', `s2 = "${text('s2')}"`],
  ['AGENTS 指标显示 "/ 12"', inner('s1').includes('/ 12'), `s1 = "${inner('s1')}"`],
  ['任务流面板有中文事件', /读取|生成|核验|复核/.test(inner('feed')), `feed 前 80 字 = ${inner('feed').slice(0, 80)}`],
  ['调度面板渲染 12 个智能体', liCount() === 12, `li 数 = ${liCount()}`],
  ['没有离线标记', !body.dataset.offline, `data-offline = ${body.dataset.offline}`],
  ['运行期没有 console.error', errors.length === 0, errors.slice(0, 3).join(' | ')],
];

let bad = 0;
console.log(`MODE=${MODE}  ORIGIN=${ORIGIN}\n`);
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   → ' + detail}`);
  if (!ok) bad++;
}
console.log(`\n${checks.length - bad}/${checks.length} 通过`);
process.exit(bad ? 1 : 0);
