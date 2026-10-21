/**
 * 冒烟测试：在 Node 里用最小 DOM 垫片把 index.html 的脚本真跑一遍，
 * 连上本地 mock 后端，检查面板有没有被真实数据填上。
 *
 *   node server.mjs &          # 先起后端
 *   node smoke-test.mjs
 *
 * 用途：换掉 /api/agent-ops/* 的实现后，先跑这个确认字段对得上、页面没崩。
 */
import { readFile, readdir, writeFile, mkdtemp, mkdir, rm, utimes } from 'node:fs/promises';
// zlib 在 MODE=dshsrc 里动态导入：静态 import 缺导出时会在加载阶段抛 SyntaxError
import { request } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ORIGIN = process.env.ORIGIN || 'http://127.0.0.1:8777';
const MODE = process.env.MODE || 'live';
/* 后端身份标记：/state 的 servedFrom 必须等于本目录名，避免把别的实例当成自己起的 */
const SERVED_NAME = ROOT.split(/[\\/]/).filter(Boolean).pop() || '';

/* ================================================================
 * 模块级测试：MODE=security / MODE=claude 不加载页面，直接查
 * ================================================================ */

function rawGet(path, headers = {}, port, method = 'GET') {
  const u = new URL(ORIGIN);
  return new Promise((resolve, reject) => {
    const req = request({
      host: u.hostname, port: port || u.port || 80, path, method,
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

/* ================================================================
 * E1 / E3：测试实例统一用动态端口，启动后核对实例身份，
 * 失败或超时也必须在 finally 里杀掉自己启动的子进程。
 * ================================================================ */

/** 尝试监听指定端口；成功返回实际端口，失败抛错。 */
function tryListen(port) {
  return new Promise((resolve, reject) => {
    const s = createTcpServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => {
      const got = s.address().port;
      s.close(() => resolve(got));
    });
  });
}

/** 优先使用 TEST_PORT_BASE 段（全量入口每次运行传自己的段），拿不到再让系统分配。 */
async function freePortNear(base, offset = 0) {
  const b = Number(base);
  if (Number.isInteger(b) && b > 0 && b <= 65000) {
    for (let i = offset; i < offset + 20 && b + i <= 65535; i++) {
      try { return await tryListen(b + i); } catch { /* 段内被占，看下一个 */ }
    }
  }
  return tryListen(0);
}

/** kill 之后等子进程真正退出，避免临时目录删不掉、端口仍被占。 */
function stopChild(child, ms = 5000) {
  return new Promise(resolve => {
    if (!child || child.exitCode != null || child.signalCode != null) return resolve(true);
    let settled = false;
    const done = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已经没了 */ } done(false); }, ms);
    child.once('exit', () => done(true));
    child.once('error', () => done(true));
    try { child.kill(); } catch { done(true); }
  });
}

function bridgeEnv(extra = {}) {
  return {
    ...process.env,
    OPEN: '0', SOURCE: '', TOKEN: '', ALLOW_ORIGIN: '', DEBUG: '0',
    ...extra,
  };
}

/** 等 bridge 就绪，并核对 servedFrom / epoch 是本次启动的实例（不是别的进程占着端口）。 */
async function waitBridge(port, opts = {}) {
  const timeoutMs = opts.timeoutMs || 15000;
  const token = opts.token || '';
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const q = token ? '?token=' + encodeURIComponent(token) : '';
      const r = await rawGet('/api/agent-ops/state' + q, {}, port);
      if (r.status === 200) {
        const j = JSON.parse(r.body);
        if (j && Array.isArray(j.agents) && Array.isArray(j.workflows)
          && typeof j.epoch === 'string' && j.epoch && j.servedFrom === SERVED_NAME) {
          return {ok: true, state: j};
        }
      }
    } catch { /* 还没起来，继续等 */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return {ok: false};
}

/** 跑一次 bridge 并等退出：非法配置必须快速非零退出，不能占着端口空跑。 */
function runBridgeExit(extra, timeoutMs = 3000) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['dsh-bridge.mjs'], {
      cwd: ROOT, env: bridgeEnv(extra), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { out += c; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }, timeoutMs);
    child.once('close', code => { clearTimeout(timer); resolve({code, out, timedOut}); });
    child.once('error', err => { clearTimeout(timer); resolve({code: -1, out: out + String(err), timedOut}); });
  });
}

/** 启动 bridge 并从日志里读实际监听端口（验证 PORT=0 的地址输出）。 */
function runBridgeCapturePort(extra, timeoutMs = 10000) {
  const child = spawn(process.execPath, ['dsh-bridge.mjs'], {
    cwd: ROOT, env: bridgeEnv(extra), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { out += c; });
  child.stderr.on('data', c => { out += c; });
  const portP = new Promise(resolve => {
    const start = Date.now();
    const timer = setInterval(() => {
      const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
      if (m) { clearInterval(timer); resolve(Number(m[1])); }
      else if (Date.now() - start > timeoutMs || child.exitCode != null) { clearInterval(timer); resolve(0); }
    }, 50);
  });
  return {child, getOutput: () => out, portP};
}

if (MODE === 'security') {
  const coreMod = await import('./lib/core.mjs');
  const coreNorm = coreMod.normDir || (d => String(d || 'unknown'));
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
  // E3：端口由系统分配（或测试入口给的段），不能再写死内部端口。
  const TP = await freePortNear(process.env.TEST_PORT_BASE, 0);
  let tokenChild = null;
  const t = {ready: false};
  try {
    tokenChild = spawn(process.execPath, ['dsh-bridge.mjs'], {
      cwd: ROOT, env: bridgeEnv({PORT: String(TP), TOKEN: 'smoke-token'}), stdio: 'ignore',
    });
    const readyT = await waitBridge(TP, {token: 'smoke-token'});
    t.ready = readyT.ok;
    if (readyT.ok) {
      t.pageNo = await rawGet('/', {}, TP);
      t.pageYes = await rawGet('/?token=smoke-token', {}, TP);
      t.apiNo = await rawGet('/api/agent-ops/state', {}, TP);
      t.apiYes = await rawGet('/api/agent-ops/state?token=smoke-token', {}, TP);
      t.epoch1 = await rawGet('/api/agent-ops/state?token=smoke-token', {}, TP);
      t.epoch2 = await rawGet('/api/agent-ops/state?token=smoke-token', {}, TP);
      t.served = JSON.parse(t.epoch1.body).servedFrom;
    }
  } catch (err) {
    t.error = err && err.message;
  } finally {
    await stopChild(tokenChild);
  }
  const ep1 = t.epoch1 && t.epoch1.status === 200 ? (JSON.parse(t.epoch1.body).epoch || '') : '';
  const ep2 = t.epoch2 && t.epoch2.status === 200 ? (JSON.parse(t.epoch2.body).epoch || '') : '';

  /* ---------- E3：实例身份 + 清理 ---------- */
  const identityChecks = [
    ['E3 测试实例启动后核对身份（servedFrom 是本目录、epoch 存在）',
      t.ready && t.served === SERVED_NAME && !!ep1, `ready=${t.ready} servedFrom=${t.served} ep=${ep1} ${t.error || ''}`],
  ];
  {
    // 停掉自己启动的实例后端口能立刻重新绑定：确认失败/结束时没有残留子进程占着端口
    const cp = await freePortNear(process.env.TEST_PORT_BASE, 15);
    const cc = spawn(process.execPath, ['dsh-bridge.mjs'], {
      cwd: ROOT, env: bridgeEnv({PORT: String(cp), MAX_AGENTS: '1'}), stdio: 'ignore',
    });
    const up = await waitBridge(cp);
    await stopChild(cc);
    let again = 0, detail = `port=${cp} ready=${up.ok}`;
    try { again = await tryListen(cp); } catch (err) { detail += ` rebind失败=${err && err.message}`; }
    identityChecks.push(['E3 停掉测试实例后端口可重新绑定（子进程清理干净）',
      up.ok && again === cp, `${detail} rebound=${again}`]);
  }

  /* ---------- E2：脚本端口 / 令牌约定（静态契约，不真正操作用户服务） ---------- */
  const startCmd = await readFile(join(ROOT, 'start.cmd'), 'utf8');
  const stopCmd = await readFile(join(ROOT, 'stop.cmd'), 'utf8');
  const e2Checks = [
    ['E2 start.cmd 只在 PORT 未设置时用默认 8778（支持环境变量）',
      /if\s+not\s+defined\s+PORT\s+set\s+"PORT=8778"/i.test(startCmd)
        && !/^\s*set\s+"PORT=8778"\s*$/im.test(startCmd), `start.cmd 端口行: ${(startCmd.match(/^\s*set\s+"PORT=.*$/im) || [''])[0]}`],
    ['E2 start.cmd 的「只开浏览器」和启动地址都用 %PORT% 且带 TOKEN',
      /set\s+"URL=http:\/\/127\.0\.0\.1:%PORT%/i.test(startCmd)
        && /if\s+defined\s+TOKEN/i.test(startCmd) && /token=%TOKEN_ENC%/i.test(startCmd)
        && /:openonly[\s\S]*?start\s+""\s+"%URL%"/i.test(startCmd),
      (startCmd.match(/^\s*set\s+"URL=.*$/im) || [''])[0]],
    ['E2 stop.cmd 用同一个 PORT 环境变量（未设置时默认 8778）',
      /if\s+not\s+defined\s+PORT\s+set\s+"PORT=8778"/i.test(stopCmd)
        && /http:\/\/127\.0\.0\.1:%PORT%/i.test(stopCmd), `stop.cmd 端口行: ${(stopCmd.match(/^\s*set\s+"PORT=.*$/im) || [''])[0]}`],
    ['E2 stop.cmd 查询时带上 TOKEN（与 start 的访问令牌一致）',
      /TOKEN/.test(stopCmd) && /EscapeDataString\(\$env:TOKEN\)/.test(stopCmd), 'stop.cmd 没处理 TOKEN'],
  ];

  /* ---------- #12：配置校验（非法值必须明确报错并非零退出） ---------- */
  const cfgChecks = [];
  const configBad = [
    ['MAX_AGENTS', '100', '99'],
    ['MAX_AGENTS', '0', 'MAX_AGENTS'],
    ['MAX_AGENTS', '-1', 'MAX_AGENTS'],
    ['MAX_AGENTS', '1.5', 'MAX_AGENTS'],
    ['MAX_AGENTS', 'NaN', 'MAX_AGENTS'],
    ['MAX_AGENTS', 'Infinity', 'MAX_AGENTS'],
    ['MAX_AGENTS', ' ', 'MAX_AGENTS'],
    ['PORT', '-1', 'PORT'],
    ['PORT', '1.5', 'PORT'],
    ['PORT', 'abc', 'PORT'],
    ['PORT', '70000', 'PORT'],
    ['ACTIVE_MIN', '-1', 'ACTIVE_MIN'],
    ['ACTIVE_MIN', '0', 'ACTIVE_MIN'],
    ['ACTIVE_MIN', 'NaN', 'ACTIVE_MIN'],
    ['ACTIVE_MIN', ' ', 'ACTIVE_MIN'],
  ];
  for (const [name, val, want] of configBad) {
    const extra = {[name]: val};
    if (name !== 'PORT') extra.PORT = '0';   // 旧实现会占用随机端口空跑，避免它撞到真实服务
    const r = await runBridgeExit(extra);
    cfgChecks.push([`#12 ${name}=${JSON.stringify(val)} 明确报错并非零退出`,
      !r.timedOut && r.code !== 0 && /配置错误/.test(r.out) && r.out.includes(want),
      `code=${r.code} timedOut=${r.timedOut} out=${r.out.trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 240)}`]);
  }

  // 边界合法值：MAX_AGENTS=1 / 99、ACTIVE_MIN=0.001 都要能启动
  const boundaryProbe = async extra => {
    const port = await freePortNear(process.env.TEST_PORT_BASE, 3);
    const child = spawn(process.execPath, ['dsh-bridge.mjs'], {
      cwd: ROOT, env: bridgeEnv({PORT: String(port), ...extra}), stdio: 'ignore',
    });
    try {
      const ready = await waitBridge(port);
      if (!ready.ok) return {ok: false, detail: '实例未就绪'};
      const s = JSON.parse((await rawGet('/api/agent-ops/state?source=all', {}, port)).body);
      const codes = (s.agents || []).map(a => a.code).filter(Boolean);
      return {ok: true, agents: s.agents.length, unique: new Set(codes).size === codes.length,
        detail: `agents=${s.agents.length} codes=${JSON.stringify(codes)}`};
    } finally {
      await stopChild(child);
    }
  };
  const b1 = await boundaryProbe({MAX_AGENTS: '1'});
  const b99 = await boundaryProbe({MAX_AGENTS: '99'});
  const bAct = await boundaryProbe({MAX_AGENTS: '1', ACTIVE_MIN: '0.001'});
  cfgChecks.push(['#12 边界值 MAX_AGENTS=1 可启动、编号唯一', b1.ok && b1.unique, b1.detail]);
  cfgChecks.push(['#12 边界值 MAX_AGENTS=99 可启动、编号唯一（容量内不重号）', b99.ok && b99.unique, b99.detail]);
  cfgChecks.push(['#12 小数 ACTIVE_MIN=0.001 是合法值', bAct.ok && bAct.unique, bAct.detail]);

  // PORT=0：日志里的地址必须用实际监听端口
  const p0 = runBridgeCapturePort({PORT: '0', MAX_AGENTS: '1'});
  const actualPort = await p0.portP;
  let port0Ok = false, port0Detail = '';
  try {
    if (actualPort > 0) {
      const ready0 = await waitBridge(actualPort, {timeoutMs: 6000});
      port0Ok = ready0.ok && !/http:\/\/127\.0\.0\.1:0\//.test(p0.getOutput());
      port0Detail = `actual=${actualPort} ready=${ready0.ok} out=${p0.getOutput().trim().split(/\r?\n/).slice(0, 3).join(' | ').slice(0, 240)}`;
    } else {
      port0Detail = `没从日志读到实际端口: ${p0.getOutput().slice(-240)}`;
    }
  } finally {
    await stopChild(p0.child);
  }
  cfgChecks.push(['#12 PORT=0 输出实际监听端口并用它组成访问地址', port0Ok, port0Detail]);

  /* ---------- #7：工作区不透明身份（独立临时 fixture，跨源合并 + 编号回收） ---------- */
  const wsChecks = [];
  const fxDir = await mkdtemp(join(tmpdir(), 'agent-ops-v243-http-'));
  const fxBase = fxDir.split(/[\\/]/).filter(Boolean).pop() || fxDir;
  let wsChild = null, wsChild99 = null;
  try {
    const dshRoot = join(fxDir, 'dsh');
    const wsA = join(dshRoot, 'ws-alpha');
    const wsB = join(dshRoot, 'ws-beta');
    const codexRoot = join(fxDir, 'codex');
    const wsC = join(fxDir, 'ws-codex');
    await mkdir(join(wsA, 'sess-a'), {recursive: true});
    await mkdir(join(wsB, 'sess-b'), {recursive: true});
    await mkdir(codexRoot, {recursive: true});
    const t0 = Date.now() - 60_000;
    const rec = (type, seq, time, data) => JSON.stringify({type, seq, time, data}) + '\n';
    const fileA = join(wsA, 'sess-a', 'session.v4.jsonl');
    await writeFile(fileA, [
      rec('session', 1, t0, {id: 'sess-a', cwd: wsA, delegationDepth: 0, origin: 'user'}),
      rec('session/title', 2, t0 + 100, {title: 'A 工作区会话'}),
      rec('turn/start', 3, t0 + 200, {turn: 1}),
      rec('tool/call', 4, t0 + 300, {callId: 'a-read', name: 'read', arguments: JSON.stringify({file_path: 'a.txt'})}),
      rec('tool/result', 5, t0 + 400, {toolCallId: 'a-read', message: {isError: false, content: [{type: 'text', text: 'ok'}]}}),
      rec('turn/end', 6, t0 + 500, {turn: 1}),
    ].join(''));
    await writeFile(join(wsB, 'sess-b', 'session.v4.jsonl'), [
      rec('session', 1, t0 + 1000, {id: 'sess-b', cwd: wsB, delegationDepth: 0, origin: 'user'}),
      rec('session/title', 2, t0 + 1100, {title: 'B 工作区会话'}),
      rec('turn/start', 3, t0 + 1200, {turn: 1}),
      // 故意不写 tool/result：B 处于“正在跑”，第一个上墙
      rec('tool/call', 4, t0 + 1300, {callId: 'b-busy', name: 'bash', arguments: JSON.stringify({command: 'sleep 1'})}),
    ].join(''));
    const crec = (type, payload, ts) => JSON.stringify({timestamp: ts, type, payload}) + '\n';
    await writeFile(join(codexRoot, 'rollout-cx.jsonl'), [
      crec('session_meta', {id: 'sess-c', cwd: wsC}, new Date(t0).toISOString()),
      crec('event_msg', {type: 'task_started'}, new Date(t0 + 100).toISOString()),
      crec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'c-cx'}, new Date(t0 + 200).toISOString()),
      crec('response_item', {type: 'function_call_output', call_id: 'c-cx', output: 'ok'}, new Date(t0 + 300).toISOString()),
      crec('event_msg', {type: 'task_complete'}, new Date(t0 + 400).toISOString()),
    ].join(''));
    /* 同一个规范目录换一个数据源：合并视图必须共享同一个工作区 ID（不是按源各发一个） */
    await writeFile(join(codexRoot, 'rollout-cx-same.jsonl'), [
      crec('session_meta', {id: 'sess-cx-same', cwd: wsA}, new Date(t0 + 10).toISOString()),
      crec('event_msg', {type: 'task_started'}, new Date(t0 + 110).toISOString()),
      crec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"pwd"}', call_id: 'cx-same'}, new Date(t0 + 210).toISOString()),
      crec('response_item', {type: 'function_call_output', call_id: 'cx-same', output: 'ok'}, new Date(t0 + 310).toISOString()),
      crec('event_msg', {type: 'task_complete'}, new Date(t0 + 410).toISOString()),
    ].join(''));

    const wsPort = await freePortNear(process.env.TEST_PORT_BASE, 6);
    const wsEnv = {
      PORT: String(wsPort), MAX_AGENTS: '1', ACTIVE_MIN: '45', SOURCE: 'all',
      DSH_SESSIONS: dshRoot, CODEX_SESSIONS: codexRoot,
      CODEX_STATE_DB: join(fxDir, 'no-state.sqlite'), CODEX_HISTORY_DB: join(fxDir, 'no-hist.sqlite'),
      CLAUDE_PROJECTS: join(fxDir, 'no-claude'),
    };
    wsChild = spawn(process.execPath, ['dsh-bridge.mjs'], {
      cwd: ROOT, env: bridgeEnv(wsEnv), stdio: 'ignore',
    });
    const readyWs = await waitBridge(wsPort);
    wsChecks.push(['#7 多工作区/合并源实例就绪且身份校验通过', readyWs.ok, `port=${wsPort}`]);
    if (readyWs.ok) {
      const j1body = (await rawGet('/api/agent-ops/state?source=all', {}, wsPort)).body;
      const j1 = JSON.parse(j1body);
      const ev1res = await rawGet('/api/agent-ops/events?source=all&after=0', {}, wsPort);
      const ev1 = JSON.parse(ev1res.body);
      const keys = (j1.workflows || []).map(w => w.key);
      const wfByName = new Map((j1.workflows || []).map(w => [String(w.name), w]));
      const keyA = wfByName.get('ws-alpha') && wfByName.get('ws-alpha').key;
      const keyB = wfByName.get('ws-beta') && wfByName.get('ws-beta').key;
      const keyC = wfByName.get('ws-codex') && wfByName.get('ws-codex').key;
      const opaque = /^ws:[0-9a-f]{16}$/;
      const absRe = /(?:[A-Za-z]:[\\/]|\\\\|\/home\/|\/Users\/|\/var\/|\/tmp\/)/;
      const rawKeys = [coreNorm(wsA), coreNorm(wsB), coreNorm(wsC)];

      wsChecks.push(['#7 state.workflows[].key 是进程级不透明 ID（不是规范化路径/绝对路径）',
        j1.workflows.length === 3 && keys.every(k => opaque.test(String(k)))
          && [keyA, keyB, keyC].every(k => typeof k === 'string' && opaque.test(k))
          && keys.every(k => !rawKeys.includes(k)) && !absRe.test(keys.join(' ')),
        `keys=${JSON.stringify(keys)}`]);
      wsChecks.push(['#7 不同目录 ID 不同；合并源同一规范目录共享同一 ID',
        new Set(keys).size === 3 && keyA !== keyB && keyB !== keyC && keyA !== keyC,
        JSON.stringify({A: keyA, B: keyB, C: keyC})]);
      wsChecks.push(['#7 state 元数据（workflows/sourceList/agents）不含绝对路径或临时目录名',
        !absRe.test(JSON.stringify({w: j1.workflows, s: j1.sourceList, a: j1.agents}))
          && !j1body.toLowerCase().includes(fxBase.toLowerCase()),
        `sourceList=${JSON.stringify(j1.sourceList)}`]);
      wsChecks.push(['#7 sourceList 不提供 path 字段（普通接口只给来源元数据）',
        Array.isArray(j1.sourceList) && j1.sourceList.length === 3
          && j1.sourceList.every(s => !('path' in s)),
        JSON.stringify(j1.sourceList)]);
      wsChecks.push(['#7 默认上限内只上墙 1 个，overflow 统计正确',
        j1.agents.length === 1 && j1.overflow === 3, `agents=${j1.agents.length} overflow=${j1.overflow}`]);
      const onWallKey = j1.workflows[j1.agents[0].wf] && j1.workflows[j1.agents[0].wf].key;
      wsChecks.push(['#7 编号只给当前上墙会话（BUSY 的 B，code=01）',
        j1.agents[0].code === '01' && onWallKey === keyB, `code=${j1.agents[0].code} key=${onWallKey}`]);

      const evOf = w => (Array.isArray(ev1) ? ev1 : []).filter(e => e.workspace === w);
      const aEv = evOf(keyA), bEv = evOf(keyB), cEv = evOf(keyC);
      wsChecks.push(['#7 state 与 events 共享同一映射实例（事件 workspace 全在同一批 ID 里）',
        Array.isArray(ev1) && ev1.length > 0 && ev1.every(e => keys.includes(e.workspace))
          && aEv.length > 0 && bEv.length > 0 && cEv.length > 0,
        JSON.stringify({keys, ev: (ev1 || []).slice(0, 6)})]);
      wsChecks.push(['#7 合并源同一目录的事件与 DSH 事件用同一个 ID',
        aEv.some(e => e.src === 'dsh') && aEv.some(e => e.src === 'codex')
          && cEv.every(e => e.src === 'codex'),
        JSON.stringify(aEv.map(e => `${e.src}:${e.workspace}`).slice(0, 8))]);
      wsChecks.push(['#7 未上墙工作区事件 agent 为空但 workspace 正确（不冒充 W01）',
        aEv.every(e => e.agent === '') && cEv.every(e => e.agent === '')
          && bEv.every(e => e.agent === '01'),
        JSON.stringify({A: aEv.slice(0, 2), B: bEv.slice(0, 2), C: cEv.slice(0, 2)})]);
      wsChecks.push(['#7 events 正文不出现绝对路径/临时目录名',
        !absRe.test(JSON.stringify(ev1.map(e => ({src: e.src, agent: e.agent, workspace: e.workspace}))))
          && !JSON.stringify(ev1).toLowerCase().includes(fxBase.toLowerCase()),
        JSON.stringify((ev1 || []).slice(0, 3))]);
      wsChecks.push(['#7 state 带 epoch/source/revision/dataKind/protocolVersion',
        !!j1.epoch && j1.source === 'all' && Number.isInteger(j1.revision)
          && j1.dataKind === 'live' && j1.protocolVersion === 2,
        `epoch=${j1.epoch} source=${j1.source} revision=${j1.revision} dataKind=${j1.dataKind}`]);
      const evH = ev1res.headers;
      wsChecks.push(['#7 events 保持旧数组响应，分页/代际信息走响应头（不破坏旧前端）',
        Array.isArray(ev1) && evH['x-agent-ops-epoch'] === j1.epoch
          && evH['x-agent-ops-source'] === 'all'
          && /^\d+$/.test(String(evH['x-agent-ops-next-cursor'] || ''))
          && /^[01]$/.test(String(evH['x-agent-ops-has-more'] || ''))
          && /^\d+$/.test(String(evH['x-agent-ops-backlog-oldest'] || '')),
        `headers=${JSON.stringify({epoch: evH['x-agent-ops-epoch'], cursor: evH['x-agent-ops-next-cursor'], more: evH['x-agent-ops-has-more']})}`]);
      const env2 = JSON.parse((await rawGet('/api/agent-ops/events?source=all&after=0&format=v2', {}, wsPort)).body);
      wsChecks.push(['#7 显式 format=v2 才返回事件外壳（epoch/backlog/nextCursor/hasMore）',
        !!env2 && env2.protocolVersion === 2 && env2.epoch === j1.epoch && env2.source === 'all'
          && Array.isArray(env2.events) && env2.events.length > 0
          && env2.nextCursor === env2.events[env2.events.length - 1].seq
          && typeof env2.hasMore === 'boolean'
          && !!env2.backlog && Number.isInteger(env2.backlog.oldest) && Number.isInteger(env2.backlog.newest),
        JSON.stringify({...env2, events: '(略)'})]);

      // 给 A 追加未结束调用：A 变忙、mtime 更新 → 下一轮上墙；B 下墙并回收编号
      const {appendFile} = await import('node:fs/promises');
      const nowB = Date.now();
      await appendFile(fileA, [
        rec('turn/start', 7, nowB, {turn: 2}),
        rec('tool/call', 8, nowB + 100, {callId: 'a-busy', name: 'bash', arguments: JSON.stringify({command: 'node -v'})}),
      ].join(''));
      await new Promise(r => setTimeout(r, 1800));
      const j2 = JSON.parse((await rawGet('/api/agent-ops/state?source=all', {}, wsPort)).body);
      const ev2 = JSON.parse((await rawGet('/api/agent-ops/events?source=all&after=0', {}, wsPort)).body);
      const aEv2 = (Array.isArray(ev2) ? ev2 : []).filter(e => e.workspace === keyA);
      const bEv2 = (Array.isArray(ev2) ? ev2 : []).filter(e => e.workspace === keyB);
      const onWall2 = j2.agents.length === 1 ? j2.workflows[j2.agents[0].wf].key : '';
      wsChecks.push(['#7 编号回收/换人后，历史事件仍按 workspace 归属（不按旧编号猜）',
        j2.agents.length === 1 && j2.agents[0].code === '01' && onWall2 === keyA
          && aEv2.filter(e => e.src === 'dsh').every(e => e.agent === '01')
          && aEv2.some(e => e.src === 'dsh')
          && bEv2.length > 0 && bEv2.every(e => e.agent === ''),
        JSON.stringify({agents: j2.agents.map(a => a.code), onWall: onWall2,
          A: aEv2.slice(0, 2), B: bEv2.slice(0, 2)})]);
      wsChecks.push(['#7 编号回收后仍唯一，ID 未变（重启才换代）',
        new Set(j2.agents.map(a => a.code)).size === j2.agents.length
          && j2.workflows.map(w => w.key).join(',') === keys.join(','),
        JSON.stringify(j2.workflows.map(w => w.key))]);

      // MAX_AGENTS=99 边界实例：仍能启动且编号唯一
      const p99 = await freePortNear(process.env.TEST_PORT_BASE, 8);
      wsChild99 = spawn(process.execPath, ['dsh-bridge.mjs'], {
        cwd: ROOT, env: bridgeEnv({...wsEnv, PORT: String(p99), MAX_AGENTS: '99'}), stdio: 'ignore',
      });
      const r99 = await waitBridge(p99);
      let ok99 = false, detail99 = '实例未就绪';
      if (r99.ok) {
        const s99 = JSON.parse((await rawGet('/api/agent-ops/state?source=all', {}, p99)).body);
        const codes99 = s99.agents.map(a => a.code);
        ok99 = s99.agents.length >= 3 && new Set(codes99).size === codes99.length
          && (s99.workflows || []).every(w => /^ws:[0-9a-f]{16}$/.test(String(w.key)));
        detail99 = `agents=${s99.agents.length} codes=${JSON.stringify(codes99)}`;
      }
      wsChecks.push(['#12 边界值 MAX_AGENTS=99 在真实实例上启动且编号唯一（工作区 ID 仍不透明）', ok99, detail99]);
    }
  } catch (err) {
    wsChecks.push(['#7/#12 HTTP 边界测试执行完成', false, String(err && err.message)]);
  } finally {
    await stopChild(wsChild99);
    await stopChild(wsChild);
    await rm(fxDir, {recursive: true, force: true});
  }

  /* ---------- E1：CORS 预检与实际请求同一策略 ---------- */
  const corsChecks = [];
  let wildChild = null, exactChild = null;
  try {
    // 通配来源：预检回 *，实际请求也回 *，且不带凭证
    const wildPort = await freePortNear(process.env.TEST_PORT_BASE, 12);
    wildChild = spawn(process.execPath, ['dsh-bridge.mjs'], {
      cwd: ROOT, env: bridgeEnv({PORT: String(wildPort), ALLOW_ORIGIN: '*'}), stdio: 'ignore',
    });
    const wOk = await waitBridge(wildPort);
    if (wOk.ok) {
      const pre = await rawGet('/api/agent-ops/state',
        {Origin: 'https://any.example', 'Access-Control-Request-Method': 'GET'}, wildPort, 'OPTIONS');
      const act = await rawGet('/api/agent-ops/state', {Origin: 'https://any.example'}, wildPort);
      const acao = String(act.headers['access-control-allow-origin'] || '');
      corsChecks.push(['E1 ALLOW_ORIGIN=* 预检与实际请求同一策略（都放行、都回 *）',
        pre.status === 204 && pre.headers['access-control-allow-origin'] === '*'
          && act.status === 200 && acao === '*',
        `pre=${pre.status}/${pre.headers['access-control-allow-origin']} act=${act.status}/${acao}`]);
      corsChecks.push(['E1 通配来源不带凭证（不回声来源、无 allow-credentials）',
        acao === '*' && !act.headers['access-control-allow-credentials']
          && !pre.headers['access-control-allow-credentials'],
        `acao=${acao} cred=${act.headers['access-control-allow-credentials']}`]);
    } else {
      corsChecks.push(['E1 ALLOW_ORIGIN=* 实例就绪', false, '未就绪']);
    }

    // 精确来源：白名单放行，白名单外预检和实际请求都拒绝
    const exactPort = await freePortNear(process.env.TEST_PORT_BASE, 13);
    exactChild = spawn(process.execPath, ['dsh-bridge.mjs'], {
      cwd: ROOT, env: bridgeEnv({PORT: String(exactPort), ALLOW_ORIGIN: 'https://ok.example'}), stdio: 'ignore',
    });
    const eOk = await waitBridge(exactPort);
    if (eOk.ok) {
      const preOk = await rawGet('/api/agent-ops/state',
        {Origin: 'https://ok.example', 'Access-Control-Request-Method': 'GET'}, exactPort, 'OPTIONS');
      const actOk = await rawGet('/api/agent-ops/state', {Origin: 'https://ok.example'}, exactPort);
      const preBad = await rawGet('/api/agent-ops/state',
        {Origin: 'https://bad.example', 'Access-Control-Request-Method': 'GET'}, exactPort, 'OPTIONS');
      const actBad = await rawGet('/api/agent-ops/state', {Origin: 'https://bad.example'}, exactPort);
      corsChecks.push(['E1 精确来源仍只放行白名单，非法来源预检/实际都拒绝',
        preOk.status === 204 && preOk.headers['access-control-allow-origin'] === 'https://ok.example'
          && actOk.status === 200 && actOk.headers['access-control-allow-origin'] === 'https://ok.example'
          && preBad.status === 403 && actBad.status === 403,
        `ok=${preOk.status}/${actOk.status} bad=${preBad.status}/${actBad.status}`]);
    } else {
      corsChecks.push(['E1 精确来源实例就绪', false, '未就绪']);
    }
  } catch (err) {
    corsChecks.push(['E1 CORS 边界测试执行完成', false, String(err && err.message)]);
  } finally {
    await stopChild(wildChild);
    await stopChild(exactChild);
  }

  /* ---------- R11：bridge.runScan 顶层兜底不再是"静默吞错仍显示健康" ---------- */
  const r11Checks = [];
  const r11Dir = await mkdtemp(join(tmpdir(), 'agent-ops-v243-scan-'));
  let r11Child = null;
  try {
    const r11Dsh = join(r11Dir, 'dsh');
    const r11Codex = join(r11Dir, 'codex');
    const r11A = join(r11Dsh, 'ws-a');
    await mkdir(join(r11A, 's1'), {recursive: true});
    await mkdir(r11Codex, {recursive: true});
    const t0 = Date.now() - 30_000;
    const r11line = (type, seq, time, data) => JSON.stringify({type, seq, time, data}) + '\n';
    await writeFile(join(r11A, 's1', 'session.v4.jsonl'), [
      r11line('session', 1, t0, {id: 'r11-a', cwd: r11A, delegationDepth: 0, origin: 'user'}),
      r11line('session/title', 2, t0 + 100, {title: 'R11 会话'}),
      r11line('turn/start', 3, t0 + 200, {turn: 1}),
      r11line('tool/call', 4, t0 + 300, {callId: 'r11-c', name: 'read', arguments: JSON.stringify({file_path: 'x.txt'})}),
    ].join(''));
    const r11cx = (type, payload, ts) => JSON.stringify({timestamp: ts, type, payload}) + '\n';
    await writeFile(join(r11Codex, 'rollout-r11.jsonl'), [
      r11cx('session_meta', {id: 'r11-cx', cwd: r11Codex}, new Date(t0).toISOString()),
      r11cx('event_msg', {type: 'task_started'}, new Date(t0 + 100).toISOString()),
      r11cx('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'r11-cx-1'}, new Date(t0 + 200).toISOString()),
    ].join(''));

    const r11Port = await freePortNear(process.env.TEST_PORT_BASE, 18);
    r11Child = spawn(process.execPath, ['dsh-bridge.mjs'], {
      cwd: ROOT,
      env: bridgeEnv({
        PORT: String(r11Port), SOURCE: 'all', MAX_AGENTS: '4',
        /* 仅测试用的注入钩子：让 dsh 源前 6 次 scan 抛错，随后恢复正常（未设置时生产路径不读它） */
        BRIDGE_TEST_SCAN_FAULT: 'dsh:6',
        DSH_SESSIONS: r11Dsh, CODEX_SESSIONS: r11Codex, CLAUDE_PROJECTS: join(r11Dir, 'no-claude'),
        CODEX_STATE_DB: join(r11Dir, 'no-state.sqlite'), CODEX_HISTORY_DB: join(r11Dir, 'no-hist.sqlite'),
      }),
      stdio: 'ignore',
    });
    const r11Ready = await waitBridge(r11Port);
    r11Checks.push(['R11 注入 scan 故障后实例仍能启动（顶层兜底不带走进程）', r11Ready.ok, `port=${r11Port}`]);
    if (r11Ready.ok) {
      let sawDegraded = null, sawCodex = null;
      const wait1 = Date.now();
      while (Date.now() - wait1 < 5000) {
        const s = JSON.parse((await rawGet('/api/agent-ops/state?source=all', {}, r11Port)).body);
        const dshS = (s.sourceList || []).find(x => x.id === 'dsh');
        const cxS = (s.sourceList || []).find(x => x.id === 'codex');
        if (dshS && dshS.degraded === true) { sawDegraded = dshS; sawCodex = cxS; break; }
        await new Promise(r => setTimeout(r, 200));
      }
      r11Checks.push(['R11 顶层兜底记录 unexpectedScanFailure（时间/来源/错误类别）并降级源健康',
        !!sawDegraded && !!sawDegraded.unexpectedScanFailure
          && sawDegraded.unexpectedScanFailure.source === 'dsh'
          && Number.isFinite(sawDegraded.unexpectedScanFailure.at)
          && typeof sawDegraded.unexpectedScanFailure.category === 'string'
          && sawDegraded.unexpectedScanFailure.category.length > 0
          && !/[A-Za-z]:[\\/]/.test(JSON.stringify(sawDegraded.unexpectedScanFailure)),
        JSON.stringify(sawDegraded)]);
      r11Checks.push(['R11 一源失败时其他源继续扫描（codex 读到会话且未降级）',
        !!sawCodex && sawCodex.degraded === false && Number(sawCodex.sessions) >= 1,
        JSON.stringify(sawCodex)]);
      let recovered = null;
      const wait2 = Date.now();
      while (Date.now() - wait2 < 15000) {
        const s = JSON.parse((await rawGet('/api/agent-ops/state?source=all', {}, r11Port)).body);
        const dshS = (s.sourceList || []).find(x => x.id === 'dsh');
        if (dshS && dshS.degraded === false && Number(dshS.sessions) >= 1) { recovered = dshS; break; }
        await new Promise(r => setTimeout(r, 250));
      }
      r11Checks.push(['R11 下一轮扫描成功后降级标记清除、会话读回（可自愈）',
        !!recovered && recovered.degraded === false && Number(recovered.sessions) >= 1,
        JSON.stringify(recovered)]);
    }
  } catch (err) {
    r11Checks.push(['R11 顶层扫描兜底测试执行完成', false, String(err && err.message)]);
  } finally {
    await stopChild(r11Child);
    await rm(r11Dir, {recursive: true, force: true});
  }

  /* ---------- R01–R05：响应头、错误输出、令牌日志 ---------- */
  const secChecks = [];
  const hdr = (h, name) => String((h && h[name]) || '').toLowerCase();
  const securityHeaderOk = h => hdr(h, 'x-content-type-options') === 'nosniff'
    && hdr(h, 'referrer-policy') === 'no-referrer'
    && /frame-ancestors\s+'none'/.test(hdr(h, 'content-security-policy'));
  const secEvents = await rawGet('/api/agent-ops/events');
  const secPage = t.pageYes;
  const sec404 = await rawGet('/api/agent-ops/no-such-route');
  secChecks.push(['R05 state/events/页面响应带 nosniff + no-referrer + CSP frame-ancestors',
    securityHeaderOk(ok.headers) && securityHeaderOk(secEvents.headers)
      && securityHeaderOk(secPage && secPage.headers),
    `state=${JSON.stringify(ok.headers)}`]);
  secChecks.push(['R05 CSP 只限制 frame-ancestors，不碰内联脚本/样式与 Canvas',
    (() => {
      const csp = hdr(secPage && secPage.headers, 'content-security-policy');
      return /frame-ancestors\s+'none'/.test(csp) && !/script-src|style-src|default-src|img-src/.test(csp);
    })(),
    hdr(secPage && secPage.headers, 'content-security-policy')]);
  const errBodies = [t.pageNo && t.pageNo.body, debug.body, weird.body, sec404.body];
  secChecks.push(['R05 普通错误响应不回声绝对路径或异常堆栈',
    errBodies.every(b => typeof b === 'string' && b.length < 200
      && !/[A-Za-z]:[\\/]/.test(b) && !/^\s+at\s/m.test(b) && !/\bENOENT\b|\bEACCES\b/.test(b)),
    JSON.stringify(errBodies)]);

  const postState = await rawGet('/api/agent-ops/state', {}, undefined, 'POST');
  secChecks.push(['R02 路由方法显式：非 GET/HEAD 返回 405 且给 Allow',
    postState.status === 405 && /get/i.test(String(postState.headers.allow || '')),
    `status=${postState.status} allow=${postState.headers.allow}`]);
  const optNoCors = await rawGet('/api/agent-ops/state', {}, undefined, 'OPTIONS');
  secChecks.push(['R02 未允许来源的预检不返回数据（403 + 空正文）',
    optNoCors.status === 403 && String(optNoCors.body) === '',
    `status=${optNoCors.status} body=${JSON.stringify(optNoCors.body)}`]);

  let tokChild = null, tokOut = '';
  try {
    const pr = runBridgeCapturePort({PORT: '0', TOKEN: 'log-secret-XYZ', MAX_AGENTS: '1'});
    tokChild = pr.child;
    const tp = await pr.portP;
    if (tp > 0) await waitBridge(tp, {token: 'log-secret-XYZ', timeoutMs: 6000});
    tokOut = pr.getOutput();
  } finally {
    await stopChild(tokChild);
  }
  secChecks.push(['R04 启动日志默认不打印完整令牌（只说明已启用）',
    !/log-secret-XYZ/i.test(tokOut) && /令牌/.test(tokOut),
    `log=${tokOut.split(/\r?\n/).filter(l => /token|令牌/i.test(l)).join(' | ').slice(0, 240)}`]);

  let dbgChild = null, dbgBody = null, dbgState = null;
  try {
    const dp = await freePortNear(process.env.TEST_PORT_BASE, 20);
    dbgChild = spawn(process.execPath, ['dsh-bridge.mjs'], {
      cwd: ROOT, env: bridgeEnv({PORT: String(dp), DEBUG: '1'}), stdio: 'ignore',
    });
    const dReady = await waitBridge(dp);
    if (dReady.ok) {
      const rawD = await rawGet('/api/agent-ops/debug', {}, dp);
      const rawS = await rawGet('/api/agent-ops/state', {}, dp);
      if (rawD.status === 200) dbgBody = JSON.parse(rawD.body);
      if (rawS.status === 200) dbgState = JSON.parse(rawS.body);
    }
  } finally {
    await stopChild(dbgChild);
  }
  secChecks.push(['R05 DEBUG=1 的受控 debug 仍可给路径（DEBUG=0 时 404）',
    !!dbgBody && typeof dbgBody.servedDir === 'string' && dbgBody.servedDir.length > 0
      && Array.isArray(dbgBody.sources) && dbgBody.sources.every(s => typeof s.path === 'string')
      && debug.status === 404,
    JSON.stringify(dbgBody && {servedDir: dbgBody.servedDir, sources: dbgBody.sources.length})]);
  secChecks.push(['#7 DEBUG=1 时普通 state 仍用不透明工作区 ID（开关只放行 debug 接口）',
    !!dbgState && (dbgState.workflows || []).every(w => /^ws:[0-9a-f]{16}$/.test(String(w.key))),
    JSON.stringify(dbgState && dbgState.workflows && dbgState.workflows.map(w => w.key))]);

  /* ---- R23/R24：脚本参数与实例身份（静态契约 + 独立 cmd 片段，不碰用户服务） ---- */
  const cmdDir = await mkdtemp(join(tmpdir(), 'agent-ops-v243-cmd-'));
  const runCmd = (file, extra = {}) => new Promise(resolve => {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', file], {
      cwd: ROOT, env: bridgeEnv(extra), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { out += c; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, 20000);
    child.once('close', code => { clearTimeout(timer); resolve({code: code == null ? -1 : code, out}); });
    child.once('error', err => { clearTimeout(timer); resolve({code: -1, out: out + String(err)}); });
  });
  const portMark = src => /rem \[PORT-CHECK-BEGIN\][^\r\n]*\r?\n([\s\S]*?)rem \[PORT-CHECK-END\]/.exec(src);
  let foreignChild = null, foreignStart = null, stopForeign = null, foreignAlive = false;
  let ownChild = null, stopOwn = null, ownExited = false;
  const fragCases = [['8778', 0], ['1', 0], ['65535', 0], ['0', 2], ['abc', 1], ['-1', 1],
    ['70000', 4], ['65536', 4], ['08778', 3], [' 8778', 1], ['1&echo HACKED', 1]];
  let fragBad = [], startBad = [], fragLen = 0;
  try {
    const startPort = portMark(startCmd);
    const stopPort = portMark(stopCmd);
    secChecks.push(['R23 start.cmd 在使用 PORT 前验证十进制 1..65535（检查块在 URL/连接之前）',
      !!startPort && /\^\[0-9\]\+\$/.test(startPort[1]) && /65535/.test(startPort[1])
        && /-lt 1|-le 0/.test(startPort[1])
        && startCmd.indexOf('rem [PORT-CHECK-END]') < startCmd.indexOf('set "URL=')
        && startCmd.indexOf('rem [PORT-CHECK-END]') < startCmd.indexOf("Connect('127.0.0.1',%PORT%)"),
      startPort ? startPort[1].trim().slice(0, 200) : '没有找到 PORT 检查块']);
    secChecks.push(['R23/R24 stop.cmd 同样先验证 PORT，再查询实例身份',
      !!stopPort && /65535/.test(stopPort[1])
        && stopCmd.indexOf('rem [PORT-CHECK-END]') < stopCmd.indexOf('/api/agent-ops/state'),
      stopPort ? stopPort[1].trim().slice(0, 160) : '没有找到 PORT 检查块']);
    secChecks.push(['R23 stop.cmd 停止前用 HTTP state 校验 servedFrom/epoch，而非只靠 PID/命令行',
      /\/api\/agent-ops\/state/.test(stopCmd) && /\$d\.servedFrom/.test(stopCmd)
        && /\$d\.epoch/.test(stopCmd) && /:notours/.test(stopCmd),
      'stop.cmd 缺少实例身份校验']);
    secChecks.push(['R23 stop.cmd 身份不一致时明确报错且不杀',
      /NOT killing it/.test(stopCmd) && /NOT stopping anything/.test(stopCmd)
        && /exit \/b 2/.test(stopCmd),
      'stop.cmd 没有明确的拒绝分支']);
    secChecks.push(['R23 start.cmd 接管前也验证实例身份，认不出就不停',
      /\/api\/agent-ops\/state/.test(startCmd) && /\$d\.servedFrom/.test(startCmd)
        && /:already_other/.test(startCmd) && /Not stopping it/.test(startCmd),
      'start.cmd 仍按"命令行包含 dsh-bridge.mjs"直接停']);
    secChecks.push(['R23 停止动作在身份校验之后（PID/命令行只作佐证）',
      startCmd.indexOf('$d.servedFrom') >= 0 && startCmd.indexOf('$d.servedFrom') < startCmd.indexOf('Stop-Process')
        && stopCmd.indexOf('$d.servedFrom') >= 0 && stopCmd.indexOf('$d.servedFrom') < stopCmd.indexOf('Stop-Process'),
      `start=${startCmd.indexOf('$d.servedFrom')}/${startCmd.indexOf('Stop-Process')} stop=${stopCmd.indexOf('$d.servedFrom')}/${stopCmd.indexOf('Stop-Process')}`]);

    const frag = startPort ? startPort[1] : '';
    fragLen = frag.length;
    const fragFile = join(cmdDir, 'portcheck.cmd');
    await writeFile(fragFile, '@echo off\r\n' + frag + '\r\n');
    for (const [val, want] of fragCases) {
      const r = await runCmd(fragFile, {PORT: val});
      if (r.code !== want || /HACKED/.test(r.out)) {
        fragBad.push(`${JSON.stringify(val)}→${r.code}(期望${want})${/HACKED/.test(r.out) ? ' 输出含HACKED' : ''}`);
      }
    }
    secChecks.push(['R23 start.cmd 端口校验片段：合法值通过、0/非法/越界/前导零/注入明确非零退出',
      fragLen > 0 && fragBad.length === 0, fragBad.join('; ')]);

    for (const [val, want] of [['0', 2], ['abc', 1], ['70000', 4], ['08778', 3]]) {
      const r = await runCmd(join(ROOT, 'start.cmd'), {PORT: val});
      if (r.code !== want) startBad.push(`${JSON.stringify(val)}→${r.code}(期望${want}) ${r.out.trim().split(/\r?\n/).pop()}`);
    }
    secChecks.push(['R24 start.cmd 入口对 PORT=0/非法/越界/前导零明确报错退出（不启动服务）',
      startBad.length === 0, startBad.join('; ')]);

    const fp = await freePortNear(process.env.TEST_PORT_BASE, 26);
    foreignChild = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT, env: bridgeEnv({PORT: String(fp), EVIL: '0'}), stdio: 'ignore',
    });
    const waitForeign = async () => {
      const t0f = Date.now();
      while (Date.now() - t0f < 8000) {
        try {
          const r = await rawGet('/api/agent-ops/state', {}, fp);
          if (r.status === 200) return true;
        } catch { /* 还没起 */ }
        await new Promise(r => setTimeout(r, 150));
      }
      return false;
    };
    if (await waitForeign()) {
      stopForeign = await runCmd(join(ROOT, 'stop.cmd'), {PORT: String(fp)});
      foreignAlive = !!(await rawGet('/api/agent-ops/state', {}, fp).catch(() => null));
      foreignStart = await runCmd(join(ROOT, 'start.cmd'), {PORT: String(fp)});
      foreignAlive = foreignAlive && !!(await rawGet('/api/agent-ops/state', {}, fp).catch(() => null));
    }
    secChecks.push(['R23 stop.cmd 对"别的服务"拒绝停止并保留其进程（servedFrom 不一致）',
      !!stopForeign && stopForeign.code === 2 && /NOT stopping anything/i.test(stopForeign.out) && foreignAlive,
      stopForeign ? `code=${stopForeign.code} alive=${foreignAlive} out=${stopForeign.out.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ')}` : '没有拿到停止结果']);
    secChecks.push(['R23 start.cmd 对"别的服务"不接管（不按命令行/端口盲杀）',
      !!foreignStart && foreignStart.code === 2 && /Not stopping it/i.test(foreignStart.out) && foreignAlive,
      foreignStart ? `code=${foreignStart.code} out=${foreignStart.out.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ')}` : '没有拿到启动结果']);

    const op = await freePortNear(process.env.TEST_PORT_BASE, 28);
    ownChild = spawn(process.execPath, ['dsh-bridge.mjs'], {
      cwd: ROOT, env: bridgeEnv({PORT: String(op), MAX_AGENTS: '1'}), stdio: 'ignore',
    });
    const ownReady = await waitBridge(op);
    if (ownReady.ok) {
      stopOwn = await runCmd(join(ROOT, 'stop.cmd'), {PORT: String(op)});
      ownExited = await stopChild(ownChild);
    }
    secChecks.push(['R23 stop.cmd 对已验证的本目录实例能正常停止',
      !!stopOwn && stopOwn.code === 0 && /stopped our bridge/.test(stopOwn.out) && ownExited,
      stopOwn ? `code=${stopOwn.code} exited=${ownExited}` : '实例未就绪']);
  } catch (err) {
    secChecks.push(['R23/R24 脚本参数与实例身份测试执行完成', false, String(err && err.message)]);
  } finally {
    await stopChild(foreignChild);
    await stopChild(ownChild);
    await rm(cmdDir, {recursive: true, force: true});
  }

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
    ...identityChecks, ...e2Checks, ...cfgChecks, ...wsChecks, ...corsChecks,
    ...r11Checks, ...secChecks,
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
  // 首行故意放个 null：坏记录不能把整份会话拖垮
  await writeFile(join(dir, 'projA', 'fff.jsonl'), [
    'null\n',
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

  // 会话 H：一条消息里两个工具调用、两条失败结果 —— 都不能只取第一条
  await writeFile(join(dir, 'projA', 'hhh.jsonl'), [
    line({type: 'user', cwd: 'D:\\projA', timestamp: '2026-01-01T00:01:00Z', message: {content: '并行改两个文件'}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:01:02Z',
      message: {content: [
        {type: 'tool_use', id: 'tuA', name: 'Read', input: {file_path: '/a'}},
        {type: 'tool_use', id: 'tuB', name: 'Write', input: {file_path: '/b'}},
      ]}}),
    line({type: 'user', timestamp: '2026-01-01T00:01:03Z',
      message: {content: [
        {type: 'tool_result', tool_use_id: 'tuA', is_error: true, content: 'ENOENT: /a'},
        {type: 'tool_result', tool_use_id: 'tuB', is_error: true, content: 'EACCES: /b'},
      ]}}),
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
    ['运行中与近活跃分开统计', stats.running === 4 && stats.active === 8, `stats = ${JSON.stringify(stats)}`],
    ['工作目录解析正确', !!a && a.cwd === 'D:\\projA' && !!b && b.cwd === 'D:\\projB', `${a && a.cwd} / ${b && b.cwd}`],
    ['失败调用记录了工具名和原因', !!g && !!g.lastFail && g.lastFail.name === 'Edit' && /EACCES/.test(g.lastFail.reason), JSON.stringify(g && g.lastFail)],
    ['失败事件带工具名和原因', !!failEvt && /Edit/.test(failEvt.name) && /EACCES/.test(failEvt.name), JSON.stringify(failEvt)],
    // 复核：一条消息里多个工具调用/多个失败结果只取第一个
    ['一条消息里的两个工具调用都进事件', pushed.filter(p => /Read|Write/.test(p.name || '')).length >= 2,
      '工具事件=' + pushed.filter(p => /Read|Write/.test(p.name || '')).length],
    ['一条消息里的两条失败结果都进事件', pushed.filter(p => p.ok === false).length >= 3,
      '失败事件=' + pushed.filter(p => p.ok === false).length],
    ['纯文字会话（日志含 null 行）也算有内容', !!f && f.turns > 0 && f.calls.length === 0, `turns = ${f && f.turns}, calls = ${f && f.calls && f.calls.length}`],
  ];
  await rm(dir, {recursive: true, force: true});

  /* 复核 v2.33 第 4 条 P2：项目子目录 readdir 失败不能被当成「那个目录的会话被删了」。
     Windows 上造 EACCES 不可靠，用 create() 的 io 注入：只对指定目录抛 EACCES，其余走真实 readdir。 */
  const {readdir: realReaddir, readFile: realReadFile, stat: realStat} = await import('node:fs/promises');
  const dir2 = await mkdtemp(join(tmpdir(), 'claude-stale-'));
  const projX = join(dir2, 'projX'), projY = join(dir2, 'projY');
  await mkdir(projX, {recursive: true});
  await mkdir(projY, {recursive: true});
  const oneTurn = (cwd) => [
    line({type: 'user', cwd, timestamp: '2026-01-01T00:00:00Z', message: {content: '干活'}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:02Z',
      message: {content: [{type: 'text', text: '完成'}], stop_reason: 'end_turn'}}),
  ].join('');
  await writeFile(join(projX, 'xxx.jsonl'), oneTurn('D:\\projX'));
  await writeFile(join(projY, 'yyy.jsonl'), oneTurn('D:\\projY'));
  let failPath = null;
  const ioWithEacces = (p, opts) => {
    if (failPath && String(p).replace(/[\\/]+$/, '') === failPath) {
      throw Object.assign(new Error('EACCES: permission denied, scandir ' + p), {code: 'EACCES'});
    }
    return realReaddir(p, opts);
  };
  const srcStale = claude.create({root: dir2, activeMs: 999999999, live: {push() {}},
    io: {readdir: ioWithEacces, readFile: realReadFile, stat: realStat}, listIntervalMs: 0});
  await srcStale.scan(true);                                   // ① 正常：两个项目各一个会话
  const nBase = srcStale.sessions().length;
  failPath = projY;                                            // ② projY 暂时不可读
  await srcStale.scan(false);
  const nBad = srcStale.sessions().length, stBad = srcStale.stats();
  failPath = null;                                             // ③ 恢复可读
  await srcStale.scan(false);
  const nOk = srcStale.sessions().length, stOk = srcStale.stats();
  failPath = dir2.replace(/[\\/]+$/, '');                      // ④ 根目录不可读
  await srcStale.scan(false);
  const nRoot = srcStale.sessions().length, stRoot = srcStale.stats();
  await rm(dir2, {recursive: true, force: true});

  checks.push(['两个项目目录各一个会话，首次 scan 得到 2 个', nBase === 2, `会话数=${nBase}`]);
  checks.push(['项目子目录读失败不会把缓存会话当成删除', nBad === 2, `会话数=${nBad}`]);
  checks.push(['项目子目录读失败时 stats().stale 为真', stBad.stale === true, `stale=${stBad.stale}`]);
  checks.push(['目录恢复可读后缓存会话仍在', nOk === 2, `会话数=${nOk}`]);
  checks.push(['目录恢复可读后 stats().stale 归假', stOk.stale === false, `stale=${stOk.stale}`]);
  checks.push(['根目录读失败时保留缓存会话', nRoot === 2, `会话数=${nRoot}`]);
  checks.push(['根目录读失败时 stats().stale 为真', stRoot.stale === true, `stale=${stRoot.stale}`]);

  /* 复核 v2.34 第 1/8 条：整个项目目录被删除后旧缓存必须退出；单文件 readFile 失败要保留缓存并标 stale。
     用 create() 的 io 注入只让目标文件读取失败，目录枚举与 stat 保持真实。 */
  const dir4 = await mkdtemp(join(tmpdir(), 'claude-v234-'));
  const pjA = join(dir4, 'projA'), pjB = join(dir4, 'projB');
  await mkdir(pjA, {recursive: true});
  await mkdir(pjB, {recursive: true});
  // 未闭合的工具调用 → 这个会话算「正在运行」，删除后不能还挂在墙上
  const busyTurn = cwd => [
    line({type: 'user', cwd, timestamp: '2026-01-01T00:00:00Z', message: {content: '干活'}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:02Z',
      message: {content: [{type: 'tool_use', id: 'tuB1', name: 'Bash', input: {command: 'sleep 1'}}]}}),
  ].join('');
  await writeFile(join(pjA, 'p1.jsonl'), busyTurn('D:\\pA'));
  await writeFile(join(pjA, 'p2.jsonl'), busyTurn('D:\\pA'));
  await writeFile(join(pjB, 'q1.jsonl'), busyTurn('D:\\pB'));

  let readFail = null;
  const ioV234 = {
    readdir: (p, o) => realReaddir(p, o),
    stat: (p, o) => realStat(p, o),
    readFile: (p, o) => {
      if (readFail && String(p) === readFail) {
        throw Object.assign(new Error('EACCES: permission denied, open ' + p), {code: 'EACCES'});
      }
      return realReadFile(p, o);
    },
  };
  const srcV234 = claude.create({root: dir4, activeMs: 999999999, live: {push() {}},
    io: ioV234, listIntervalMs: 0});
  await srcV234.scan(true);                                    // ① 三个会话都读入
  const stBase = srcV234.stats();
  await rm(pjB, {recursive: true, force: true});               // ② 删除整个项目目录
  await srcV234.scan(false);
  await srcV234.scan(false);
  const idsDelWs = srcV234.sessions().map(s => s.id).sort();
  const stDelWs = srcV234.stats();
  await rm(join(pjA, 'p2.jsonl'), {force: true});              // ③ 单日志删除（项目目录仍在）
  await srcV234.scan(false);
  await srcV234.scan(false);
  const idsDelFile = srcV234.sessions().map(s => s.id).sort();
  const stDelFile = srcV234.stats();
  const p1 = join(pjA, 'p1.jsonl');
  readFail = p1;                                               // ④ 单文件读取失败（文件已更新触发重读）
  await writeFile(p1, busyTurn('D:\\pA') + line({type: 'user', cwd: 'D:\\pA',
    timestamp: '2026-01-01T00:00:05Z', message: {content: '读取失败后的追加'}}));
  await srcV234.scan(false);
  const sFail = srcV234.sessions().find(s => s.id === 'p1');
  const stFail = srcV234.stats();
  readFail = null;                                             // ⑤ 恢复读取
  await srcV234.scan(false);
  const sRecover = srcV234.sessions().find(s => s.id === 'p1');
  const stRecover = srcV234.stats();
  await rm(dir4, {recursive: true, force: true});

  checks.push(['v2.34 边界基线：3 个会话 / 3 个文件', stBase.sessions === 3 && stBase.files === 3, JSON.stringify(stBase)]);
  checks.push(['整个项目目录删除后旧会话退出（不再显示运行）',
    stDelWs.sessions === 2 && stDelWs.files === 2 && !idsDelWs.includes('q1') && stDelWs.stale === false,
    JSON.stringify({...stDelWs, ids: idsDelWs})]);
  checks.push(['单个日志删除后对应会话退出（项目目录仍在）',
    stDelFile.sessions === 1 && idsDelFile.join(',') === 'p1' && stDelFile.files === 1 && stDelFile.stale === false,
    JSON.stringify({...stDelFile, ids: idsDelFile})]);
  checks.push(['单文件读取失败：旧会话保留且仍在运行', !!sFail && !!sFail.current,
    `current = ${!!(sFail && sFail.current)}`]);
  checks.push(['单文件读取失败：stats().stale 为真', stFail.stale === true, `stale=${stFail.stale}`]);
  checks.push(['恢复读取后：stale 归假且内容更新',
    stRecover.stale === false && !!sRecover && sRecover.msgs.some(m => m.text.includes('读取失败后的追加')),
    `stale=${stRecover.stale} msgs=${JSON.stringify(sRecover && sRecover.msgs)}`]);

  /* 复核 v2.36 第 4 条（Claude 侧）：stat 的 EACCES/EPERM 不能当成「文件已删除」，
     也不能当成正常缓存；保留旧状态并标 stale，恢复后能重读，确认删除（ENOENT/真删）才退出。 */
  const dir5 = await mkdtemp(join(tmpdir(), 'claude-badstat-'));
  const pjS = join(dir5, 'projS');
  await mkdir(pjS, {recursive: true});
  const statFileC = join(pjS, 's1.jsonl');
  const busyLinesC = extra => [
    line({type: 'user', cwd: 'D:\\pS', timestamp: '2026-01-01T00:00:00Z', message: {content: '干活'}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:02Z',
      message: {content: [{type: 'tool_use', id: 'tuS', name: 'Bash', input: {command: 'sleep 1'}}]}}),
  ].join('') + (extra || '');
  await writeFile(statFileC, busyLinesC(''));
  let statFailC = null;
  let statCodeC = 'EACCES';
  const ioStatC = {
    readdir: (p, o) => realReaddir(p, o),
    readFile: (p, o) => realReadFile(p, o),
    stat: (p, o) => {
      if (statFailC && String(p) === statFailC) {
        throw Object.assign(new Error(statCodeC + ': stat ' + p), {code: statCodeC});
      }
      return realStat(p, o);
    },
  };
  const srcStatC = claude.create({root: dir5, activeMs: 999999999, live: {push() {}},
    io: ioStatC, listIntervalMs: 0});
  await srcStatC.scan(true);                                   // ① 正常读入运行中的会话
  statFailC = statFileC;                                       // ② 单文件 stat EACCES（目录枚举正常）
  await srcStatC.scan(false);
  const stCBad = srcStatC.stats();
  const sCBad = srcStatC.sessions().find(x => x.id === 's1');
  statFailC = null;                                            // ③ 恢复 stat，同时更新内容
  await writeFile(statFileC, busyLinesC(line({type: 'user', cwd: 'D:\\pS',
    timestamp: '2026-01-01T00:00:05Z', message: {content: 'stat 恢复后的追加'}})));
  await srcStatC.scan(false);
  const stCOk = srcStatC.stats();
  const sCOk = srcStatC.sessions().find(x => x.id === 's1');
  statCodeC = 'ENOENT';                                        // ④ stat 确认不存在（ENOENT）→ 允许退出缓存
  statFailC = statFileC;
  await srcStatC.scan(false);
  const stCDel = srcStatC.stats();
  statFailC = null;                                            // ⑤ 真实删除后也不能重新挂住
  await rm(statFileC, {force: true});
  await srcStatC.scan(false);
  const stCDel2 = srcStatC.stats();
  await rm(dir5, {recursive: true, force: true});

  checks.push(['stat EACCES：缓存会话保留且仍在运行',
    stCBad.sessions === 1 && stCBad.running === 1 && !!sCBad && !!sCBad.current,
    JSON.stringify({...stCBad, current: !!(sCBad && sCBad.current)})]);
  checks.push(['stat EACCES：stats().stale 为真（不能当成正常缓存）', stCBad.stale === true, `stale=${stCBad.stale}`]);
  checks.push(['stat 恢复：stale 归假且能重读更新',
    stCOk.stale === false && stCOk.sessions === 1 && !!sCOk && sCOk.msgs.some(m => m.text.includes('stat 恢复后的追加')),
    JSON.stringify({...stCOk, msgs: sCOk && sCOk.msgs})]);
  checks.push(['stat ENOENT（确认不存在）：退出缓存，stale 不因此挂住',
    stCDel.sessions === 0 && stCDel.stale === false, JSON.stringify(stCDel)]);
  checks.push(['真实删除日志后：缓存退出且 stale 仍为假',
    stCDel2.sessions === 0 && stCDel2.files === 0 && stCDel2.stale === false, JSON.stringify(stCDel2)]);

  /* 复核 v2.37 第 3 条：Claude 回合终态要贯通工具与 todo。
     三种结束信号（result / system/stop_hook_summary / assistant stop_reason=end_turn）各自带一个
     没有结果的 Write 调用，另有「先结束、迟到 tool_result」样本；迟到结果不能把作废调用翻成成功。
     修复前：结束信号只改 foldSession 局部 turnOpen，open 集合不清 → current=old、running=1、busy=1。 */
  const { buildState, createLive, createCodes } = await import('./lib/core.mjs');
  const dir6 = await mkdtemp(join(tmpdir(), 'claude-terminal-'));
  const pjT = join(dir6, 'projT');
  await mkdir(pjT, {recursive: true});
  const termLines = ending => {
    const evs = [
      line({type: 'user', cwd: 'D:\\pTerm', timestamp: '2026-01-01T00:00:00Z', message: {content: '干活'}}),
      line({type: 'assistant', timestamp: '2026-01-01T00:00:02Z',
        message: {content: [{type: 'tool_use', id: 'tu-' + ending, name: 'Write',
          input: {file_path: 'x-' + ending + '.js', content: '未确认的写入不该入列'}}]}}),
    ];
    if (ending === 'result') {
      evs.push(line({type: 'result', timestamp: '2026-01-01T00:00:03Z'}));
    } else if (ending === 'system') {
      evs.push(line({type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-01-01T00:00:03Z'}));
    } else if (ending === 'endturn') {
      evs.push(line({type: 'assistant', timestamp: '2026-01-01T00:00:03Z',
        message: {content: [{type: 'text', text: '收工'}], stop_reason: 'end_turn'}}));
    } else {
      // late：先出现结束信号，再迟到一条成功的 tool_result
      evs.push(line({type: 'result', timestamp: '2026-01-01T00:00:03Z'}));
      evs.push(line({type: 'user', timestamp: '2026-01-01T00:00:04Z',
        message: {content: [{type: 'tool_result', tool_use_id: 'tu-late', content: '写入成功'}]}}));
    }
    return evs.join('');
  };
  for (const ending of ['result', 'system', 'endturn', 'late']) {
    await writeFile(join(pjT, ending + '.jsonl'), termLines(ending));
  }
  // 场景 B：TodoWrite 完整成功 + end_turn（没有遗漏工具结果），todo 快照仍是 in_progress
  await writeFile(join(pjT, 'todo.jsonl'), [
    line({type: 'user', cwd: 'D:\\pTodo', timestamp: '2026-01-01T00:00:00Z', message: {content: '整理任务'}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:02Z',
      message: {content: [{type: 'tool_use', id: 'tuTodo', name: 'TodoWrite',
        input: {todos: [{content: '进行中的任务', status: 'in_progress'}]}}]}}),
    line({type: 'user', timestamp: '2026-01-01T00:00:03Z',
      message: {content: [{type: 'tool_result', tool_use_id: 'tuTodo', content: 'ok'}]}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:04Z',
      message: {content: [{type: 'text', text: '任务已整理'}], stop_reason: 'end_turn'}}),
  ].join(''));

  const srcTermC = claude.create({root: dir6, activeMs: 999999999, live: {push() {}}});
  await srcTermC.scan(true);
  const cS = id => srcTermC.sessions().find(x => x.id === id);
  const stTermC = buildState({sessions: srcTermC.sessions(), live: createLive(), codes: createCodes(),
    activeMs: 999999999, maxAgents: 12, maxTasks: 60, servedFrom: 'test', source: 'claude'});
  const runTermC = stTermC.tasks.filter(t => t.state === 'run');
  const busyTermC = stTermC.workflows.filter(w => w.busy > 0);

  for (const ending of ['result', 'system', 'endturn', 'late']) {
    const s = cS(ending);
    const c0 = s && s.calls[0];
    checks.push([`结束信号 ${ending}：残留工具收尾（current/openStep 清空、done+aborted、不计成功、无 run 任务）`,
      !!s && s.turnOpen === false && s.current === null && s.openStep === null
        && !!c0 && c0.done === true && c0.aborted === true
        && s.done === 0 && s.failed === 0 && s.snippets.length === 0
        && !runTermC.some(t => String(t.name) === 'x-' + ending + '.js'),
      JSON.stringify(s && {turnOpen: s.turnOpen, current: s.current, openStep: s.openStep,
        call: c0 && [c0.done, !!c0.aborted], done: s.done, failed: s.failed,
        snippets: s.snippets.length, run: runTermC.map(t => t.name)})]);
  }
  checks.push(['三类结束信号 + 迟到结果之后：整体无 run 任务、工作区不忙',
    runTermC.length === 0 && busyTermC.length === 0,
    JSON.stringify({run: runTermC.map(t => t.name), busy: busyTermC.map(w => [w.name, w.busy])})]);
  const sTodo = cS('todo');
  checks.push(['TodoWrite in_progress + 完整成功 + end_turn：turnOpen=false、无 run 任务',
    !!sTodo && sTodo.turnOpen === false && sTodo.current === null && sTodo.openStep === null
      && sTodo.done === 1 && sTodo.todos.some(t => t.status === 'in_progress')
      && !runTermC.some(t => /进行中的任务/.test(String(t.name))),
    JSON.stringify(sTodo && {turnOpen: sTodo.turnOpen, current: sTodo.current, openStep: sTodo.openStep,
      done: sTodo.done, todos: sTodo.todos, run: runTermC.map(t => t.name)})]);
  await rm(dir6, {recursive: true, force: true});

  // 场景 C：结束一回合后，新回合真实 tool_use 仍显示运行（turnOpen 不能被永久钉死）
  const dir7 = await mkdtemp(join(tmpdir(), 'claude-newturn-'));
  await mkdir(join(dir7, 'projN'), {recursive: true});
  await writeFile(join(dir7, 'projN', 'next.jsonl'), [
    line({type: 'user', cwd: 'D:\\pNext', timestamp: '2026-01-01T00:00:00Z', message: {content: '第一轮'}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:02Z',
      message: {content: [{type: 'text', text: '第一轮结束'}], stop_reason: 'end_turn'}}),
    line({type: 'user', timestamp: '2026-01-01T00:00:03Z', message: {content: '第二轮'}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:04Z',
      message: {content: [{type: 'tool_use', id: 'tuNext', name: 'Read', input: {file_path: 'a.js'}}]}}),
  ].join(''));
  const srcNext = claude.create({root: dir7, activeMs: 999999999, live: {push() {}}});
  await srcNext.scan(true);
  const sNext = srcNext.sessions().find(x => x.id === 'next');
  const stNext = buildState({sessions: srcNext.sessions(), live: createLive(), codes: createCodes(),
    activeMs: 999999999, maxAgents: 12, maxTasks: 60, servedFrom: 'test', source: 'claude'});
  const runNext = stNext.tasks.filter(t => t.state === 'run');
  await rm(dir7, {recursive: true, force: true});
  checks.push(['新回合真实 tool_use 仍显示运行（current 指向它、turnOpen=true）',
    !!sNext && sNext.turnOpen === true && !!sNext.current && sNext.current.name === 'Read'
      && sNext.openStep === null && runNext.some(t => t.name === 'a.js'),
    JSON.stringify(sNext && {turnOpen: sNext.turnOpen, current: sNext.current && sNext.current.name,
      openStep: sNext.openStep, run: runNext.map(t => t.name)})]);

  /* 复核 v2.39 第 2 条：todo 数组成员损坏（null / 非对象）不能让整份 foldSession 抛错。
     先缓存「工具运行中」的旧快照，再追加含坏成员的 TodoWrite 与助手 end_turn；
     修复后结束信号仍生效、合法 todo 保留、最终回复不丢、其它会话不受影响、stale 不被误标。 */
  const dirTodo = await mkdtemp(join(tmpdir(), 'claude-todos-'));
  const pjTodo = join(dirTodo, 'projTodo');
  await mkdir(pjTodo, {recursive: true});
  const todoBusy = (id) => [
    line({type: 'user', cwd: 'D:\\projTodo', timestamp: '2026-01-01T00:00:00Z', message: {content: '开始-' + id}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:01Z',
      message: {content: [{type: 'tool_use', id: 'tu-' + id, name: 'Bash', input: {command: 'sleep 1'}}]}}),
  ].join('');
  const todoFinish = (id, todos) => [
    line({type: 'assistant', timestamp: '2026-01-01T00:00:02Z',
      message: {content: [{type: 'tool_use', id: 'tuTodo-' + id, name: 'TodoWrite', input: {todos}}]}}),
    line({type: 'user', timestamp: '2026-01-01T00:00:03Z',
      message: {content: [{type: 'tool_result', tool_use_id: 'tuTodo-' + id, content: 'ok'}]}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:04Z',
      message: {content: [{type: 'text', text: '收尾-' + id}], stop_reason: 'end_turn'}}),
  ].join('');
  const todoCases = [
    ['todoNull', [null, {content: '合法任务-null', status: 'completed'}], '合法任务-null'],
    ['todoNonObj', [{content: '合法任务-非对象', status: 'completed'}, 42, 'bad', null, ['x']], '合法任务-非对象'],
    ['todoNormal', [{content: '合法任务-正常', status: 'completed'}], '合法任务-正常'],
  ];
  for (const [id] of todoCases) await writeFile(join(pjTodo, id + '.jsonl'), todoBusy(id));
  await writeFile(join(pjTodo, 'todoOtherBusy.jsonl'), todoBusy('todoOtherBusy'));
  const srcTodo = claude.create({root: dirTodo, activeMs: 999999999, live: {push() {}}});
  await srcTodo.scan(true);                                   // ① 旧快照：四个会话都在运行
  const stTodoBase = srcTodo.stats();
  for (const [id, items] of todoCases) {
    await writeFile(join(pjTodo, id + '.jsonl'), todoBusy(id) + todoFinish(id, items));   // ② 追加坏 todo + end_turn
  }
  await srcTodo.scan(false);                                  // ③ 修复后整份日志应能折叠完成
  const stTodo = srcTodo.stats();
  const sTodoOf = id => srcTodo.sessions().find(x => x.id === id);
  const sTodoOther = sTodoOf('todoOtherBusy');
  const todoResults = todoCases.map(([id, , valid]) => {
    const s0 = sTodoOf(id);
    return {id, s: s0, valid,
      ok: !!s0 && s0.turnOpen === false && s0.current === null && s0.openStep === null
        && s0.todos.length === 1 && s0.todos[0].content === valid
        && s0.msgs.some(m => m.text.includes('收尾-' + id))};
  });
  await rm(dirTodo, {recursive: true, force: true});

  checks.push(['Claude 坏 todo 基线：四个会话都在运行',
    stTodoBase.sessions === 4 && stTodoBase.running === 4, JSON.stringify(stTodoBase)]);
  for (const r of todoResults) {
    checks.push([`Claude todo 数组含坏成员（${r.id}）：fold 继续、end_turn 收尾、合法项保留、最终回复不丢`,
      r.ok, JSON.stringify(r.s && {turnOpen: r.s.turnOpen, current: !!(r.s && r.s.current),
        openStep: r.s.openStep, todos: r.s.todos, last: r.s.msgs.slice(-1)})]);
  }
  checks.push(['Claude todo 坏成员不影响其它会话',
    !!sTodoOther && !!sTodoOther.current && sTodoOther.id === 'todoOtherBusy',
    JSON.stringify(sTodoOther && {id: sTodoOther.id, current: !!sTodoOther.current})]);
  checks.push(['Claude todo 坏成员不误标 stale、只统计真正在跑的会话',
    stTodo.sessions === 4 && stTodo.running === 1 && stTodo.stale === false, JSON.stringify(stTodo)]);

  /* 复核 v2.40 第 4、5 条（Claude 侧）：
     · [4] 文件变小后读取失败（stat 正常、readFile EACCES）时旧快照必须保留并标 stale；
           读取成功才提交变化：有效较小内容替换、确认空文件作废。
     · [5] 读取成功但整份内容解析不到记录 / foldSession 抛错：保留旧快照但标解析失败（stale=true）；
           末尾半行而其余有效仍按现有容错；恢复有效内容或删除故障文件后清除提示。
     每组独立临时目录 + 独立源，io 注入只影响目标文件的 readFile，目录枚举与 stat 保持真实。 */
  const v240BusyLog = (mark, id) => [
    line({type: 'user', cwd: 'D:\\pV240', timestamp: '2026-01-01T00:00:00Z', message: {content: mark}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:02Z',
      message: {content: [{type: 'tool_use', id: 'tu-' + id, name: 'Bash', input: {command: 'sleep 100'}}]}}),
  ].join('');
  const v240ReadFailIo = () => {
    const box = {fail: null};
    box.io = {
      readdir: (p, o) => realReaddir(p, o),
      stat: (p, o) => realStat(p, o),
      readFile: (p, o) => {
        if (box.fail && String(p) === box.fail) {
          throw Object.assign(new Error('EACCES: permission denied, open ' + p), {code: 'EACCES'});
        }
        return realReadFile(p, o);
      },
    };
    return box;
  };

  // ① 变小 + EACCES：读取前不能因 size 变小丢掉唯一旧快照
  const dir8 = await mkdtemp(join(tmpdir(), 'claude-v240-shrink-eacces-'));
  const pj8 = join(dir8, 'proj8');
  await mkdir(pj8, {recursive: true});
  const file8 = join(pj8, 'shrink.jsonl');
  await writeFile(file8, v240BusyLog('变小+EACCES 基线', 'eacces'));
  const box8 = v240ReadFailIo();
  const src8 = claude.create({root: dir8, activeMs: 999999999, live: {push() {}},
    io: box8.io, listIntervalMs: 0});
  await src8.scan(true);
  const st8a = src8.stats();
  const size8a = (await realStat(file8)).size;
  const short8 = line({type: 'user', cwd: 'D:\\pV240', timestamp: '2026-01-01T00:00:00Z',
    message: {content: '变小后的短内容（不应被采用）'}});
  await writeFile(file8, short8);
  const size8b = (await realStat(file8)).size;
  box8.fail = file8;                                          // stat 正常，读取 EACCES
  await src8.scan(false);
  const st8b = src8.stats();
  const s8b = src8.sessions().find(x => x.id === 'shrink');
  box8.fail = null;                                           // 权限恢复并补回运行中的日志
  await writeFile(file8, v240BusyLog('变小+EACCES 基线', 'eacces') +
    line({type: 'user', cwd: 'D:\\pV240', timestamp: '2026-01-01T00:00:03Z',
      message: {content: '权限恢复后的追加'}}));
  await src8.scan(false);
  const st8c = src8.stats();
  const s8c = src8.sessions().find(x => x.id === 'shrink');
  await rm(dir8, {recursive: true, force: true});

  checks.push(['v2.40 变小+EACCES 前置：基线运行中且重写后文件确实更短',
    st8a.sessions === 1 && st8a.running === 1 && size8b < size8a,
    JSON.stringify({stats: st8a, size: [size8a, size8b]})]);
  checks.push(['v2.40 变小+EACCES：读取失败时旧快照保留（sessions=1、running=1、不采用短内容）',
    st8b.sessions === 1 && st8b.running === 1 && st8b.files === 1
      && !!s8b && !!s8b.current
      && s8b.msgs.some(m => m.text.includes('变小+EACCES 基线'))
      && !s8b.msgs.some(m => m.text.includes('变小后的短内容')),
    JSON.stringify({...st8b, current: !!(s8b && s8b.current), msgs: s8b && s8b.msgs.map(m => m.text)})]);
  checks.push(['v2.40 变小+EACCES：stats().stale 为真', st8b.stale === true, `stale=${st8b.stale}`]);
  checks.push(['v2.40 变小+EACCES 恢复：stale 归假、内容更新、仍在运行',
    st8c.sessions === 1 && st8c.running === 1 && st8c.stale === false
      && !!s8c && !!s8c.current && s8c.msgs.some(m => m.text.includes('权限恢复后的追加')),
    JSON.stringify({...st8c, current: !!(s8c && s8c.current), msgs: s8c && s8c.msgs.map(m => m.text)})]);

  // ② 变小 + 有效内容：读取成功后提交新快照（旧运行状态退出）
  const dir9 = await mkdtemp(join(tmpdir(), 'claude-v240-shrink-valid-'));
  const pj9 = join(dir9, 'proj9');
  await mkdir(pj9, {recursive: true});
  const file9 = join(pj9, 'shrinkok.jsonl');
  const log9a = v240BusyLog('较小有效内容前的旧运行日志', 'valid');
  await writeFile(file9, log9a);
  const src9 = claude.create({root: dir9, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
  await src9.scan(true);
  const st9a = src9.stats();
  const short9 = [
    line({type: 'user', cwd: 'D:\\pV240v', timestamp: '2026-01-01T00:00:00Z',
      message: {content: '较小但有效的新内容'}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:02Z',
      message: {content: [{type: 'text', text: '已完成'}], stop_reason: 'end_turn'}}),
  ].join('');
  await writeFile(file9, short9);
  await src9.scan(false);
  const st9b = src9.stats();
  const s9b = src9.sessions().find(x => x.id === 'shrinkok');
  await rm(dir9, {recursive: true, force: true});

  checks.push(['v2.40 变小+有效内容：读取成功后替换快照（running=0、旧运行状态退出、stale=false）',
    st9a.sessions === 1 && st9a.running === 1
      && st9b.sessions === 1 && st9b.running === 0 && st9b.files === 1 && st9b.stale === false
      && short9.length < log9a.length
      && !!s9b && s9b.msgs.some(m => m.text.includes('较小但有效的新内容'))
      && !s9b.msgs.some(m => m.text.includes('较小有效内容前的旧运行日志'))
      && s9b.title.includes('较小但有效的新内容'),
    JSON.stringify({...st9b, msgs: s9b && s9b.msgs.map(m => m.text), title: s9b && s9b.title})]);

  // ③ 确认空文件：旧状态作废，不能被「保留旧快照」的修复挡住
  const dir10 = await mkdtemp(join(tmpdir(), 'claude-v240-empty-'));
  const pj10 = join(dir10, 'proj10');
  await mkdir(pj10, {recursive: true});
  const file10 = join(pj10, 'empty.jsonl');
  await writeFile(file10, v240BusyLog('清空前仍在运行', 'empty'));
  const src10 = claude.create({root: dir10, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
  await src10.scan(true);
  const st10a = src10.stats();
  await writeFile(file10, '');
  await src10.scan(false);
  const st10b = src10.stats();
  await src10.scan(false);
  const st10c = src10.stats();
  await rm(dir10, {recursive: true, force: true});

  checks.push(['v2.40 确认空文件：旧状态作废（sessions=0、running=0、stale=false）',
    st10a.sessions === 1 && st10a.running === 1
      && st10b.sessions === 0 && st10b.running === 0 && st10b.files === 1 && st10b.stale === false
      && st10c.sessions === 0 && st10c.running === 0 && st10c.stale === false,
    JSON.stringify({a: st10a, b: st10b, c: st10c})]);

  // ④ 整文件损坏（变长）+ 恢复有效内容
  const dir11 = await mkdtemp(join(tmpdir(), 'claude-v240-corrupt-'));
  const pj11 = join(dir11, 'proj11');
  await mkdir(pj11, {recursive: true});
  const file11 = join(pj11, 'corrupt.jsonl');
  await writeFile(file11, v240BusyLog('损坏前运行日志内容', 'corrupt'));
  const src11 = claude.create({root: dir11, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
  await src11.scan(true);
  const st11a = src11.stats();
  const size11a = (await realStat(file11)).size;
  await writeFile(file11, ('@@@ not-json line @@@\n').repeat(30));   // 变长，确保不走缩小路径
  const size11b = (await realStat(file11)).size;
  await src11.scan(false);
  const st11b = src11.stats();
  const s11b = src11.sessions().find(x => x.id === 'corrupt');
  await writeFile(file11, [
    line({type: 'user', cwd: 'D:\\pV240c', timestamp: '2026-01-01T00:00:00Z',
      message: {content: '损坏恢复后的新内容'}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:02Z',
      message: {content: [{type: 'text', text: '恢复完成'}], stop_reason: 'end_turn'}}),
  ].join(''));
  await src11.scan(false);
  const st11c = src11.stats();
  const s11c = src11.sessions().find(x => x.id === 'corrupt');
  const size11c = (await realStat(file11)).size;
  await writeFile(file11, ('@@@ short corrupt @@@\n').repeat(4));   // 变小 + 损坏：读取成功但无可折叠记录
  const size11d = (await realStat(file11)).size;
  await src11.scan(false);
  const st11d = src11.stats();
  const s11d = src11.sessions().find(x => x.id === 'corrupt');
  await rm(dir11, {recursive: true, force: true});

  checks.push(['v2.40 整文件损坏（变长）前置：基线运行中且损坏内容更长',
    st11a.sessions === 1 && st11a.running === 1 && size11b > size11a,
    JSON.stringify({stats: st11a, size: [size11a, size11b]})]);
  checks.push(['v2.40 整文件损坏（变长）：保留旧运行快照但 stale=true，不能报健康',
    st11b.sessions === 1 && st11b.running === 1 && st11b.stale === true
      && !!s11b && !!s11b.current
      && s11b.msgs.some(m => m.text.includes('损坏前运行日志内容')),
    JSON.stringify({...st11b, current: !!(s11b && s11b.current), msgs: s11b && s11b.msgs.map(m => m.text)})]);
  checks.push(['v2.40 损坏后恢复有效内容：stale 归假、快照替换为新内容',
    st11c.sessions === 1 && st11c.running === 0 && st11c.stale === false
      && !!s11c && s11c.msgs.some(m => m.text.includes('损坏恢复后的新内容'))
      && !s11c.msgs.some(m => m.text.includes('损坏前运行日志内容')),
    JSON.stringify({...st11c, msgs: s11c && s11c.msgs.map(m => m.text)})]);
  checks.push(['v2.40 变小+损坏内容：读取成功但无可折叠记录时保留旧快照并 stale=true',
    size11d < size11c
      && st11d.sessions === 1 && st11d.stale === true
      && !!s11d && s11d.msgs.some(m => m.text.includes('损坏恢复后的新内容')),
    JSON.stringify({...st11d, size: [size11c, size11d], msgs: s11d && s11d.msgs.map(m => m.text)})]);

  // ⑤ 仅末尾半行：其余内容有效 → 维持现有容错，不算整源故障
  const dir12 = await mkdtemp(join(tmpdir(), 'claude-v240-half-'));
  const pj12 = join(dir12, 'proj12');
  await mkdir(pj12, {recursive: true});
  const file12 = join(pj12, 'half.jsonl');
  const halfLineC = '{"type":"assistant","timestamp":"2026-01-01T00:00:09Z","message":{"content":[{"type":"text","text"';
  await writeFile(file12, v240BusyLog('末尾半行前的有效内容', 'half') + halfLineC);   // 末行无换行、未闭合
  const src12 = claude.create({root: dir12, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
  await src12.scan(true);
  const st12a = src12.stats();
  const s12a = src12.sessions().find(x => x.id === 'half');
  await src12.scan(false);
  const st12b = src12.stats();
  await rm(dir12, {recursive: true, force: true});

  checks.push(['v2.40 仅末尾半行：其余内容有效时不算整源故障（运行状态保留、stale=false）',
    st12a.sessions === 1 && st12a.running === 1 && st12a.stale === false
      && !!s12a && !!s12a.current && s12a.calls.length === 1
      && s12a.msgs.some(m => m.text.includes('末尾半行前的有效内容'))
      && st12b.sessions === 1 && st12b.stale === false,
    JSON.stringify({...st12a, current: !!(s12a && s12a.current), msgs: s12a && s12a.msgs.map(m => m.text)})]);

  // ⑥ 折叠结构异常：JSON 可解析、但记录内部序列化抛错。
  // v2.42 起改为「单条记录边界隔离」：不再让整份 foldSession 抛错，快照仍提交但 stale=true
  //（旧版本这里是保留旧快照；新语义在下方 v2.42 #2 超深嵌套组里还验证了后续结束记录会生效）。
  const dir13 = await mkdtemp(join(tmpdir(), 'claude-v240-foldthrow-'));
  const pj13 = join(dir13, 'proj13');
  await mkdir(pj13, {recursive: true});
  const file13 = join(pj13, 'foldthrow.jsonl');
  await writeFile(file13, v240BusyLog('折叠异常前运行日志', 'foldthrow'));
  const src13 = claude.create({root: dir13, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
  await src13.scan(true);
  const st13a = src13.stats();
  // 超深嵌套的 tool_use input：JSON.parse 能成功，但 fold 内部 JSON.stringify 会抛 RangeError
  let deepJson = '1';
  for (let i = 0; i < 20000; i++) deepJson = '{"a":' + deepJson + '}';
  const deepLine = '{"type":"assistant","timestamp":"2026-01-01T00:00:02Z","message":{"content":[{"type":"tool_use","id":"tuDeep","name":"Bash","input":' + deepJson + '}]}}\n';
  let deepParseOk = false, deepFoldThrows = false;
  try {
    const parsedDeep = JSON.parse(deepLine);
    deepParseOk = true;
    try { JSON.stringify(parsedDeep.message.content[0].input); } catch { deepFoldThrows = true; }
  } catch { /* 解析失败时下面前置断言会明确失败 */ }
  await writeFile(file13, deepLine);
  await src13.scan(false);
  const st13b = src13.stats();
  const s13b = src13.sessions().find(x => x.id === 'foldthrow');
  await writeFile(file13, [
    line({type: 'user', cwd: 'D:\\pV240f', timestamp: '2026-01-01T00:00:00Z',
      message: {content: '折叠恢复后的新内容'}}),
    line({type: 'assistant', timestamp: '2026-01-01T00:00:02Z',
      message: {content: [{type: 'text', text: '恢复完成'}], stop_reason: 'end_turn'}}),
  ].join(''));
  await src13.scan(false);
  const st13c = src13.stats();
  await rm(dir13, {recursive: true, force: true});

  checks.push(['v2.40 折叠结构异常前置：超深嵌套行可解析、但折叠内部序列化确实抛错',
    deepParseOk && deepFoldThrows, JSON.stringify({deepParseOk, deepFoldThrows})]);
  checks.push(['v2.40 折叠结构异常（单条隔离）：快照提交、stale=true、不再整份日志失联',
    st13a.sessions === 1 && st13a.running === 1
      && st13b.sessions === 1 && st13b.running === 1 && st13b.stale === true
      && !!s13b && !!s13b.current && s13b.current.name === 'Bash'
      && s13b.calls.length === 1 && s13b.calls[0].argBytes <= 2,
    JSON.stringify({...st13b, current: s13b && s13b.current && s13b.current.name,
      calls: s13b && s13b.calls.map(c => [c.name, c.argBytes])})]);
  checks.push(['v2.40 折叠异常恢复：stale 归假、快照替换为新内容',
    st13c.sessions === 1 && st13c.running === 0 && st13c.stale === false,
    JSON.stringify(st13c)]);

  // ⑦ 删除解析故障文件：缓存与解析失败提示一起退出，stale 不能永远挂住
  const dir14 = await mkdtemp(join(tmpdir(), 'claude-v240-delparse-'));
  const pj14 = join(dir14, 'proj14');
  await mkdir(pj14, {recursive: true});
  const file14 = join(pj14, 'del.jsonl');
  await writeFile(file14, v240BusyLog('删除故障文件前的运行日志', 'del'));
  const src14 = claude.create({root: dir14, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
  await src14.scan(true);
  await writeFile(file14, ('%%% bad content %%%\n').repeat(20));
  await src14.scan(false);
  const st14a = src14.stats();
  await rm(file14, {force: true});
  await src14.scan(false);
  const st14b = src14.stats();
  await src14.scan(false);
  const st14c = src14.stats();
  await rm(dir14, {recursive: true, force: true});

  checks.push(['v2.40 删除解析故障文件：缓存与解析失败提示一起退出、stale=false',
    st14a.sessions === 1 && st14a.running === 1 && st14a.stale === true
      && st14b.sessions === 0 && st14b.running === 0 && st14b.files === 0 && st14b.stale === false
      && st14c.sessions === 0 && st14c.stale === false,
    JSON.stringify({a: st14a, b: st14b, c: st14c})]);

  /* 复核 v2.41 第 4 条（Claude 侧）：事件进度不能再用「行号」当游标。
     旧实现把 prev.seenSeq 当起点；文件被更短的全新历史替换后，旧游标大于新行数，
     事件循环一次都不执行，新快照虽然提交，新消息/工具/失败事件却整段漏发。
     修复后进度改为按「记录身份」维护，下面每组同时断言快照和实际发布的事件：
       · 全新历史替换：新内容必须发布，旧事件不能重推
       · 相同行数改写：改写的记录按新身份发布
       · 同代前缀截断/压缩：保留记录的身份命中已发布集合，只能发真正新增的
       · 正常追加：只发新记录，重复扫描不重复发
       · 替换后读取失败再恢复：恢复时补发且只发一次
     io 注入只影响目标文件的 readFile，目录枚举与 stat 保持真实。 */
  const v241PushBox = () => {
    const arr = [];
    return {arr, live: {push(it) { arr.push(it); }}};
  };
  const v241File = async (name, lines) => {
    const d = await mkdtemp(join(tmpdir(), name + '-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    const f = join(pj, 'sess.jsonl');
    await writeFile(f, lines.join(''));
    return {d, f};
  };
  const v241User = (text, at) => line({type: 'user', cwd: 'D:\\pV241', timestamp: at,
    message: {content: text}});
  const v241Tool = (id, name, at, input) => line({type: 'assistant', timestamp: at,
    message: {content: [{type: 'tool_use', id, name, input}]}});
  const v241Fail = (id, at, text) => line({type: 'user', timestamp: at,
    message: {content: [{type: 'tool_result', tool_use_id: id, is_error: true, content: text}]}});
  const v241Reply = (text, at) => line({type: 'assistant', timestamp: at,
    message: {content: [{type: 'text', text}], stop_reason: 'end_turn'}});

  // ① 短文件替换为全新历史：旧 4 条（含失败）→ 新 3 条（用户消息 + 新工具 + 新失败）
  const g1 = await v241File('claude-v241-replace-new', [
    v241User('旧历史消息 old-msg-A', '2026-01-01T00:00:00Z'),
    v241Tool('tu-old-A', 'Read', '2026-01-01T00:00:01Z', {file_path: 'old-a.js'}),
    v241Fail('tu-old-A', '2026-01-01T00:00:02Z', 'EACCES: permission denied, open old-a.js'),
    v241Reply('旧回复 A', '2026-01-01T00:00:03Z'),
  ]);
  const ev1 = v241PushBox();
  const srcR = claude.create({root: g1.d, activeMs: 999999999, live: ev1.live, listIntervalMs: 0});
  await srcR.scan(true);
  const s1a = srcR.sessions().find(x => x.id === 'sess');
  const st1a = srcR.stats();
  const ev1a = ev1.arr.slice();
  await writeFile(g1.f, [
    v241User('新消息 new-A', '2026-02-01T00:00:00Z'),
    v241Tool('tu-new-A', 'Write', '2026-02-01T00:00:01Z', {file_path: 'new-a.js'}),
    v241Fail('tu-new-A', '2026-02-01T00:00:02Z',
      'Process exited with code 7: EACCES: permission denied, open new-a.js'),
  ].join(''));
  await srcR.scan(false);
  const ev1b = ev1.arr.slice(ev1a.length);
  const s1b = srcR.sessions().find(x => x.id === 'sess');
  const st1b = srcR.stats();
  const ev1cFrom = ev1.arr.length;
  await srcR.scan(false);
  const ev1c = ev1.arr.slice(ev1cFrom);
  await rm(g1.d, {recursive: true, force: true});

  checks.push(['v2.41 短文件替换前置：旧 4 条记录、旧失败事件已发布',
    st1a.sessions === 1 && st1a.stale === false && !!s1a && s1a.seenSeq === 4
      && ev1a.some(x => x.ok === false && /Read/.test(x.name || '') && /EACCES/.test(x.name || '')),
    JSON.stringify({seenSeq: s1a && s1a.seenSeq, events: ev1a.map(x => [x.name, x.ok])})]);
  checks.push(['v2.41 短文件替换为全新历史：快照换成新内容（msgs/failed/seenSeq）',
    st1b.sessions === 1 && st1b.stale === false
      && !!s1b && s1b.seenSeq === 3 && s1b.failed === 1
      && s1b.msgs.length === 1 && s1b.msgs[0].text === '新消息 new-A'
      && !s1b.msgs.some(m => /old-msg-A/.test(m.text)),
    JSON.stringify({seenSeq: s1b && s1b.seenSeq, failed: s1b && s1b.failed,
      msgs: s1b && s1b.msgs.map(m => m.text)})]);
  checks.push(['v2.41 短文件替换为全新历史：新消息/新工具/新失败事件都发布',
    ev1b.length === 3
      && ev1b.some(x => x.kind === 'msg' && x.name === '新消息 new-A')
      && ev1b.some(x => x.name === 'new-a.js')
      && ev1b.some(x => x.ok === false && /Write/.test(x.name || '') && /exit 7/.test(x.name || '')),
    JSON.stringify(ev1b.map(x => [x.verb, x.name, x.ok]))]);
  checks.push(['v2.41 短文件替换为全新历史：旧事件不重推、重复扫描不再发',
    !ev1b.some(x => /old-msg-A|old-a\.js/.test(x.name || ''))
      && !ev1b.some(x => x.ok === false && /Read/.test(x.name || ''))
      && ev1c.length === 0,
    JSON.stringify({replacement: ev1b.map(x => x.name), rescan: ev1c.length})]);

  // ② 相同行数改写：3 条旧记录原地换成 3 条新记录，新内容必须可见
  const g2 = await v241File('claude-v241-rewrite-same-len', [
    v241User('旧内容 B', '2026-01-01T00:00:00Z'),
    v241Tool('tu-old-B', 'Bash', '2026-01-01T00:00:01Z', {command: 'echo old-b'}),
    v241Fail('tu-old-B', '2026-01-01T00:00:02Z', 'exit code 1: old-b failed'),
  ]);
  const p2 = v241PushBox();
  const srcB = claude.create({root: g2.d, activeMs: 999999999, live: p2.live, listIntervalMs: 0});
  await srcB.scan(true);
  const p2a = p2.arr.slice();
  await writeFile(g2.f, [
    v241User('新内容 B', '2026-01-02T00:00:00Z'),
    v241Tool('tu-new-B', 'Bash', '2026-01-02T00:00:01Z', {command: 'echo new-b'}),
    v241Fail('tu-new-B', '2026-01-02T00:00:02Z', 'exit code 2: new-b failed'),
  ].join(''));
  await srcB.scan(false);
  const p2b = p2.arr.slice(p2a.length);
  const s2b = srcB.sessions().find(x => x.id === 'sess');
  const st2b = srcB.stats();
  await rm(g2.d, {recursive: true, force: true});

  checks.push(['v2.41 相同行数改写：快照与事件都换成新内容、旧内容不重复',
    st2b.sessions === 1 && st2b.stale === false
      && !!s2b && s2b.seenSeq === 3 && s2b.failed === 1
      && s2b.msgs.length === 1 && s2b.msgs[0].text === '新内容 B'
      && p2b.length === 3
      && p2b.some(x => x.name === '新内容 B')
      && p2b.some(x => x.name === 'echo new-b')
      && p2b.some(x => x.ok === false && /exit 2/.test(x.name || ''))
      && !p2b.some(x => /旧内容 B|old-b|echo old-b/.test(x.name || ''))
      && !p2b.some(x => x.ok === false && /old-b failed/.test(x.name || '')),
    JSON.stringify({seenSeq: s2b && s2b.seenSeq, failed: s2b && s2b.failed,
      msgs: s2b && s2b.msgs.map(m => m.text), events: p2b.map(x => [x.name, x.ok])})]);

  // ③ 同代前缀截断/历史压缩：保留记录的身份已在已发布集合里，不能重复；追加仍要发
  const cLines = [
    v241User('第一条 C', '2026-01-03T00:00:00Z'),
    v241Tool('tu-c1', 'Read', '2026-01-03T00:00:01Z', {file_path: 'c1.js'}),
    v241Fail('tu-c1', '2026-01-03T00:00:02Z', 'EACCES: c1 失败'),
    v241User('第二条 C', '2026-01-03T00:00:03Z'),
    v241Reply('完成 C', '2026-01-03T00:00:04Z'),
  ];
  const g3 = await v241File('claude-v241-prefix-truncate', cLines);
  const p3 = v241PushBox();
  const srcC = claude.create({root: g3.d, activeMs: 999999999, live: p3.live, listIntervalMs: 0});
  await srcC.scan(true);
  const p3a = p3.arr.slice();
  await writeFile(g3.f, cLines.slice(3).join(''));       // 只保留最后两条：同代前缀截断
  await srcC.scan(false);
  const p3b = p3.arr.slice(p3a.length);
  const s3b = srcC.sessions().find(x => x.id === 'sess');
  const st3b = srcC.stats();
  const p3cFrom = p3.arr.length;
  await writeFile(g3.f, cLines.slice(3).join('') +
    v241User('追加 C', '2026-01-03T00:00:05Z'));         // 截断后再追加
  await srcC.scan(false);
  const p3c = p3.arr.slice(p3cFrom);
  const s3c = srcC.sessions().find(x => x.id === 'sess');
  await rm(g3.d, {recursive: true, force: true});

  checks.push(['v2.41 同代前缀截断：保留的已发布记录不重推',
    st3b.sessions === 1 && st3b.stale === false && !!s3b
      && s3b.seenSeq === 2 && s3b.failed === 0
      && s3b.msgs.map(m => m.text).join('|') === '第二条 C|完成 C'
      && p3b.length === 0,
    JSON.stringify({seenSeq: s3b && s3b.seenSeq, failed: s3b && s3b.failed,
      msgs: s3b && s3b.msgs.map(m => m.text), events: p3b.map(x => x.name)})]);
  checks.push(['v2.41 同代前缀截断后追加：只发新增记录，旧记录不重复',
    p3c.length === 1 && p3c[0].name === '追加 C'
      && !!s3c && s3c.msgs.map(m => m.text).join('|') === '第二条 C|完成 C|追加 C'
      && !p3c.some(x => /第二条 C|完成 C/.test(x.name || '')),
    JSON.stringify({events: p3c.map(x => x.name), msgs: s3c && s3c.msgs.map(m => m.text)})]);

  // ④ 正常追加：只发新增，重复扫描不重复发
  const dLines = [
    v241User('追加前 D', '2026-01-04T00:00:00Z'),
    v241Reply('完成 D', '2026-01-04T00:00:01Z'),
  ];
  const g4 = await v241File('claude-v241-normal-append', dLines);
  const p4 = v241PushBox();
  const srcD = claude.create({root: g4.d, activeMs: 999999999, live: p4.live, listIntervalMs: 0});
  await srcD.scan(true);
  const p4a = p4.arr.slice();
  await writeFile(g4.f, dLines.concat([
    v241User('追加后 D', '2026-01-04T00:00:02Z'),
    v241Reply('完成2 D', '2026-01-04T00:00:03Z'),
  ]).join(''));
  await srcD.scan(false);
  const p4b = p4.arr.slice(p4a.length);
  const s4b = srcD.sessions().find(x => x.id === 'sess');
  const p4cFrom = p4.arr.length;
  await srcD.scan(false);
  const p4c = p4.arr.slice(p4cFrom);
  await rm(g4.d, {recursive: true, force: true});

  checks.push(['v2.41 正常追加：只发新增记录、旧记录不重推、重复扫描不再发',
    p4a.length === 2
      && p4b.length === 2
      && p4b.some(x => x.name === '追加后 D') && p4b.some(x => x.name === '完成2 D')
      && !p4b.some(x => /追加前 D|完成 D/.test(x.name || ''))
      && !!s4b && s4b.seenSeq === 4 && s4b.msgs.map(m => m.text).join('|') === '追加前 D|完成 D|追加后 D|完成2 D'
      && p4c.length === 0,
    JSON.stringify({append: p4b.map(x => x.name), rescan: p4c.length,
      msgs: s4b && s4b.msgs.map(m => m.text)})]);

  // ⑤ 替换后读取失败 → 恢复：失败期间保留旧快照并标 stale，恢复时补发新内容且只发一次
  const g5 = await v241File('claude-v241-replace-recover', [
    v241User('恢复前旧消息 E', '2026-01-05T00:00:00Z'),
    v241Tool('tu-old-E', 'Read', '2026-01-05T00:00:01Z', {file_path: 'old-e.js'}),
    v241Fail('tu-old-E', '2026-01-05T00:00:02Z', 'EACCES: old-e 失败'),
    v241Reply('旧回复 E', '2026-01-05T00:00:03Z'),
  ]);
  const box5 = v240ReadFailIo();
  const p5 = v241PushBox();
  const srcE = claude.create({root: g5.d, activeMs: 999999999, live: p5.live,
    io: box5.io, listIntervalMs: 0});
  await srcE.scan(true);
  const p5a = p5.arr.slice();
  const s5a = srcE.sessions().find(x => x.id === 'sess');
  await writeFile(g5.f, [
    v241User('恢复后新消息 E', '2026-01-06T00:00:00Z'),
    v241Tool('tu-new-E', 'Write', '2026-01-06T00:00:01Z', {file_path: 'new-e.js'}),
    v241Fail('tu-new-E', '2026-01-06T00:00:02Z', 'exit code 9: EACCES new-e 失败'),
  ].join(''));
  box5.fail = g5.f;                                       // 替换后读取失败
  await srcE.scan(false);
  const st5b = srcE.stats();
  const s5b = srcE.sessions().find(x => x.id === 'sess');
  const p5b = p5.arr.slice(p5a.length);
  box5.fail = null;                                       // 权限恢复
  await srcE.scan(false);
  const st5c = srcE.stats();
  const s5c = srcE.sessions().find(x => x.id === 'sess');
  const p5c = p5.arr.slice(p5a.length + p5b.length);
  const p5dFrom = p5.arr.length;
  await srcE.scan(false);
  const p5d = p5.arr.slice(p5dFrom);
  await rm(g5.d, {recursive: true, force: true});

  checks.push(['v2.41 替换后读取失败：保留旧快照并标 stale，不发布新事件',
    st5b.sessions === 1 && st5b.stale === true
      && !!s5b && s5b.seenSeq === 4 && s5b.msgs.some(m => /恢复前旧消息 E/.test(m.text))
      && p5b.length === 0,
    JSON.stringify({...st5b, seenSeq: s5b && s5b.seenSeq, events: p5b.map(x => x.name)})]);
  checks.push(['v2.41 替换后恢复：新快照生效、新事件补发且旧事件不重推',
    st5c.sessions === 1 && st5c.stale === false
      && !!s5c && s5c.seenSeq === 3 && s5c.failed === 1
      && s5c.msgs.length === 1 && s5c.msgs[0].text === '恢复后新消息 E'
      && p5c.length === 3
      && p5c.some(x => x.name === '恢复后新消息 E')
      && p5c.some(x => x.name === 'new-e.js')
      && p5c.some(x => x.ok === false && /Write/.test(x.name || '') && /exit 9/.test(x.name || ''))
      && !p5c.some(x => /恢复前旧消息 E|old-e/.test(x.name || ''))
      && p5d.length === 0,
    JSON.stringify({...st5c, seenSeq: s5c && s5c.seenSeq, failed: s5c && s5c.failed,
      msgs: s5c && s5c.msgs.map(m => m.text), events: p5c.map(x => [x.name, x.ok]),
      rescan: p5d.length})]);

  // ⑥ 有稳定 uuid 时按标识维护进度：同一记录只改时间戳（复制/恢复）不应重复发布
  const v241UuidUser = (uuid, at, text) => line({type: 'user', cwd: 'D:\\pV241u', uuid,
    timestamp: at, message: {content: text}});
  const v241UuidTool = (uuid, at) => line({type: 'assistant', uuid, timestamp: at,
    message: {content: [{type: 'tool_use', id: 'tu-uu', name: 'Read', input: {file_path: 'u.js'}}]}});
  const g6 = await v241File('claude-v241-uuid-stable', [
    v241UuidUser('uuid-uu-1', '2026-01-07T00:00:00Z', '稳定标识消息 U1'),
    v241UuidTool('uuid-uu-2', '2026-01-07T00:00:01Z'),
  ]);
  const p6 = v241PushBox();
  const srcU = claude.create({root: g6.d, activeMs: 999999999, live: p6.live, listIntervalMs: 0});
  await srcU.scan(true);
  const p6a = p6.arr.slice();
  await writeFile(g6.f, [
    v241UuidUser('uuid-uu-1', '2026-01-07T01:00:00Z', '稳定标识消息 U1'),   // 同标识/同内容，只改时间戳
    v241UuidTool('uuid-uu-2', '2026-01-07T01:00:01Z'),
  ].join(''));
  await srcU.scan(false);
  const p6b = p6.arr.slice(p6a.length);
  const s6b = srcU.sessions().find(x => x.id === 'sess');
  await rm(g6.d, {recursive: true, force: true});

  checks.push(['v2.41 稳定 uuid：同一记录只改时间戳不重推',
    p6a.length === 2 && p6b.length === 0
      && !!s6b && s6b.seenSeq === 2 && s6b.msgs.length === 1 && s6b.msgs[0].text === '稳定标识消息 U1',
    JSON.stringify({before: p6a.map(x => x.name), after: p6b.map(x => x.name),
      msgs: s6b && s6b.msgs.map(m => m.text)})]);

  /* ============================================================
   * 复核 v2.42 #1 / #2 / #4 / #8（Claude 侧）
   * 四组各自独立临时目录 + 独立源；断言同时检查快照、健康状态与实际发布的事件。
   * ============================================================ */

  /* #1 长历史全量重读不能遗忘仍会读到的已发布身份（旧实现 published>6000 裁到 ~4500，
     下一次普通追加会把被裁掉的历史全部当新事件重推）。覆盖旧阈值前后的 5999/6000/6001/8000。 */
  const v242LongRun = async n => {
    const d = await mkdtemp(join(tmpdir(), 'claude-v242-long-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    const f = join(pj, 'long.jsonl');
    const baseT = Date.parse('2026-03-01T00:00:00Z');
    const hist = Array.from({length: n}, (_, i) => line({type: 'user', uuid: `long-${n}-${i}`,
      cwd: 'D:\\pLong', timestamp: new Date(baseT + i * 1000).toISOString(),
      message: {content: `history-${i}`}}));
    await writeFile(f, hist.join(''));
    const arr = [];
    const src = claude.create({root: d, activeMs: 999999999, live: {push(it) { arr.push(it); }}, listIntervalMs: 0});
    await src.scan(true);
    const initial = arr.map(x => x.name);
    const addOne = async i => {
      hist.push(line({type: 'user', uuid: `long-${n}-${i}`, cwd: 'D:\\pLong',
        timestamp: new Date(baseT + i * 1000).toISOString(), message: {content: `new-${i - n + 1}`}}));
      await writeFile(f, hist.join(''));
      const from = arr.length;
      await src.scan(false);
      return arr.slice(from).map(x => x.name);
    };
    const ev1 = await addOne(n);
    const ev2 = await addOne(n + 1);
    const from3 = arr.length;
    await src.scan(false);
    const ev3 = arr.slice(from3).map(x => x.name);
    await rm(d, {recursive: true, force: true});
    return {initial, ev1, ev2, ev3};
  };
  for (const n of [5999, 6000, 6001, 8000]) {
    const r = await v242LongRun(n);
    checks.push([`v2.42 #1 ${n} 条历史：首次只发布最近 60 条事件`,
      r.initial.length === 60 && r.initial[0] === `history-${n - 60}`,
      JSON.stringify({count: r.initial.length, first: r.initial[0]})]);
    checks.push([`v2.42 #1 ${n} 条历史：普通追加每次只 +1、空扫不再发`,
      r.ev1.length === 1 && r.ev1[0] === 'new-1'
        && r.ev2.length === 1 && r.ev2[0] === 'new-2'
        && r.ev3.length === 0,
      JSON.stringify({firstAppend: r.ev1.length, firstHead: r.ev1.slice(0, 2),
        secondAppend: r.ev2.length, rescan: r.ev3.length})]);
  }

  /* #1 同长度改写 / 同代裁剪后补齐 / 全新替换：只发「应发」的记录。 */
  {
    const n = 6001;
    const baseT = Date.parse('2026-03-01T00:00:00Z');
    const rwRec = (i, text) => line({type: 'user', uuid: `rw-${i}`, cwd: 'D:\\pRw',
      timestamp: new Date(baseT + i * 1000).toISOString(), message: {content: text}});
    const d = await mkdtemp(join(tmpdir(), 'claude-v242-rewrite-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    const f = join(pj, 'long.jsonl');
    const hist = Array.from({length: n}, (_, i) => rwRec(i, `history-${i}`));
    await writeFile(f, hist.join(''));
    const arr = [];
    const src = claude.create({root: d, activeMs: 999999999, live: {push(it) { arr.push(it); }}, listIntervalMs: 0});
    await src.scan(true);
    const sizeBefore = (await realStat(f)).size;
    hist[0] = rwRec(0, 'HISTORY-0');                 // 与 history-0 等长，只有内容变了
    await writeFile(f, hist.join(''));
    const sizeAfter = (await realStat(f)).size;
    const from = arr.length;
    await src.scan(false);
    const rewritten = arr.slice(from).map(x => x.name);
    const from2 = arr.length;
    await src.scan(false);
    const again = arr.slice(from2).map(x => x.name);
    const title = (src.sessions().find(x => x.id === 'long') || {}).title;
    await rm(d, {recursive: true, force: true});
    checks.push(['v2.42 #1 同长度改写：只发布被改写记录，其余历史不重推',
      sizeBefore === sizeAfter && rewritten.length === 1 && rewritten[0] === 'HISTORY-0'
        && again.length === 0 && title === 'HISTORY-0',
      JSON.stringify({size: [sizeBefore, sizeAfter], rewritten: rewritten.length,
        rewrittenHead: rewritten.slice(0, 3), rescan: again.length, title})]);
  }
  {
    const n = 6001;
    const baseT = Date.parse('2026-03-01T00:00:00Z');
    const rfRec = (i, text) => line({type: 'user', uuid: `rf-${i}`, cwd: 'D:\\pRefill',
      timestamp: new Date(baseT + i * 1000).toISOString(), message: {content: text}});
    const d = await mkdtemp(join(tmpdir(), 'claude-v242-refill-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    const f = join(pj, 'long.jsonl');
    const hist = Array.from({length: n}, (_, i) => rfRec(i, `history-${i}`));
    await writeFile(f, hist.join(''));
    const arr = [];
    const src = claude.create({root: d, activeMs: 999999999, live: {push(it) { arr.push(it); }}, listIntervalMs: 0});
    await src.scan(true);
    await writeFile(f, hist.slice(3000).join(''));   // 同代前缀裁剪
    const fromTrim = arr.length;
    await src.scan(false);
    const trimmed = arr.slice(fromTrim);
    await writeFile(f, hist.join(''));               // 同代补齐（补回被裁掉的旧身份）
    const fromFill = arr.length;
    await src.scan(false);
    const refilled = arr.slice(fromFill);
    hist.push(rfRec(n, 'append-after-refill'));
    await writeFile(f, hist.join(''));
    const fromApp = arr.length;
    await src.scan(false);
    const appended = arr.slice(fromApp).map(x => x.name);
    await rm(d, {recursive: true, force: true});
    checks.push(['v2.42 #1 同代裁剪后补齐：裁剪与补齐都不重推，之后追加只 +1',
      trimmed.length === 0 && refilled.length === 0
        && appended.length === 1 && appended[0] === 'append-after-refill',
      JSON.stringify({trim: trimmed.length, refill: refilled.length,
        append: appended.length, appendHead: appended.slice(0, 3)})]);
  }
  {
    const n = 6001;
    const baseT = Date.parse('2026-03-01T00:00:00Z');
    const rpRec = (i, text) => line({type: 'user', uuid: `rp-${i}`, cwd: 'D:\\pReplace',
      timestamp: new Date(baseT + i * 1000).toISOString(), message: {content: text}});
    const d = await mkdtemp(join(tmpdir(), 'claude-v242-replace-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    const f = join(pj, 'long.jsonl');
    await writeFile(f, Array.from({length: n}, (_, i) => rpRec(i, `old-${i}`)).join(''));
    const arr = [];
    const src = claude.create({root: d, activeMs: 999999999, live: {push(it) { arr.push(it); }}, listIntervalMs: 0});
    await src.scan(true);
    const from = arr.length;
    await writeFile(f, [rpRec(10000, 'replacement-1'), rpRec(10001, 'replacement-2'),
      rpRec(10002, 'replacement-3')].join(''));
    await src.scan(false);
    const ev = arr.slice(from).map(x => x.name);
    await rm(d, {recursive: true, force: true});
    checks.push(['v2.42 #1 全新替换：只发新历史的 3 条记录，旧历史不重推',
      ev.length === 3 && ev.join('|') === 'replacement-1|replacement-2|replacement-3',
      JSON.stringify({events: ev})]);
  }
  {
    /* 同一条消息里的两个工具是独立事件身份：只改其中一个，不应把另一个也重发。 */
    const d = await mkdtemp(join(tmpdir(), 'claude-v242-unit-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    const f = join(pj, 'unit.jsonl');
    const multi = (aPath, bPath) => line({type: 'assistant', uuid: 'multi-tool-1',
      timestamp: '2026-03-05T00:00:02Z', cwd: 'D:\\pUnit',
      message: {content: [
        {type: 'tool_use', id: 'mt-a', name: 'Read', input: {file_path: aPath}},
        {type: 'tool_use', id: 'mt-b', name: 'Read', input: {file_path: bPath}},
      ]}});
    const arr = [];
    const src = claude.create({root: d, activeMs: 999999999, live: {push(it) { arr.push(it); }}, listIntervalMs: 0});
    await writeFile(f, line({type: 'user', uuid: 'multi-user', timestamp: '2026-03-05T00:00:00Z',
      cwd: 'D:\\pUnit', message: {content: '一条消息两个工具'}}) + multi('a.js', 'b.js'));
    await src.scan(true);
    const from = arr.length;
    await writeFile(f, line({type: 'user', uuid: 'multi-user', timestamp: '2026-03-05T00:00:00Z',
      cwd: 'D:\\pUnit', message: {content: '一条消息两个工具'}}) + multi('a.js', 'c.js'));
    await src.scan(false);
    const ev = arr.slice(from).map(x => x.name);
    const s = src.sessions().find(x => x.id === 'unit');
    await rm(d, {recursive: true, force: true});
    checks.push(['v2.42 #1 一条消息内多工具：只重发内容变化的那个工具',
      ev.length === 1 && ev[0] === 'c.js'
        && !!s && s.calls.map(c => c.label).join('|') === 'a.js|c.js',
      JSON.stringify({events: ev, labels: s && s.calls.map(c => c.label)})]);
  }

  /* #2 内部完整坏行 ≠ 末尾半行：坏行要标 stale，但可解析记录与后续合法结束记录继续生效；
     成功 readFile 不能把还没恢复的解析故障洗掉。 */
  {
    const d = await mkdtemp(join(tmpdir(), 'claude-v242-badline-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    const f = join(pj, 'bad.jsonl');
    const head = line({type: 'assistant', uuid: 'bi-1', timestamp: '2026-04-01T00:00:01Z',
      cwd: 'D:\\pBad', message: {content: [{type: 'tool_use', id: 'bi-tool', name: 'Bash',
        input: {command: 'sleep 1'}}]}});
    const tail = line({type: 'user', uuid: 'bi-2', timestamp: '2026-04-01T00:00:02Z',
      message: {content: 'after damage'}})
      + line({type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-04-01T00:00:03Z'});
    await writeFile(f, head + '{MALFORMED_COMPLETE_INTERIOR_LINE}\n' + tail);
    const arr = [];
    const src = claude.create({root: d, activeMs: 999999999, live: {push(it) { arr.push(it); }}, listIntervalMs: 0});
    await src.scan(true);
    const stBad = src.stats();
    const sBad = src.sessions().find(x => x.id === 'bad');
    await src.scan(false);                          // 读取成功但坏行还在：不能洗成健康
    const stStill = src.stats();
    const from = arr.length;
    await writeFile(f, head + tail);                // 修掉坏行
    await src.scan(false);
    const stFixed = src.stats();
    const fixedEv = arr.slice(from);
    await rm(d, {recursive: true, force: true});
    checks.push(['v2.42 #2 内部完整坏行：继续用可解析记录、后续结束记录生效，但 stale=true',
      stBad.sessions === 1 && stBad.stale === true
        && !!sBad && sBad.current === null && sBad.openStep === null && sBad.turnOpen === false
        && sBad.msgs.some(m => m.text.includes('after damage')),
      JSON.stringify({...stBad, current: !!(sBad && sBad.current), openStep: sBad && sBad.openStep,
        msgs: sBad && sBad.msgs.map(m => m.text)})]);
    checks.push(['v2.42 #2 成功 readFile 不清未恢复的解析故障：坏行仍在时下一轮仍然 stale',
      stStill.stale === true, JSON.stringify(stStill)]);
    checks.push(['v2.42 #2 坏行修复后：stale 归假，已发布记录不重推',
      stFixed.stale === false && fixedEv.length === 0,
      JSON.stringify({...stFixed, events: fixedEv.map(x => x.name)})]);
  }
  {
    /* 已知事件类型的字段结构校验：Write/Edit 的入参无论是 JSON 字符串还是原始值，
       解析后必须是对象；null/数组/数字不能抛穿，也不能把损坏当健康。 */
    const d = await mkdtemp(join(tmpdir(), 'claude-v242-fields-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    const f = join(pj, 'fields.jsonl');
    const tool = (id, name, input) => line({type: 'assistant', uuid: 'fi-' + id,
      timestamp: '2026-04-02T00:00:02Z', cwd: 'D:\\pFields',
      message: {content: [{type: 'tool_use', id, name, input}]}});
    await writeFile(f, [
      line({type: 'user', uuid: 'fi-user', timestamp: '2026-04-02T00:00:00Z',
        cwd: 'D:\\pFields', message: {content: '结构化载荷'}}),
      tool('wi-null', 'Write', 'null'),                                   // 字符串 → 解析成 null
      tool('wi-arr', 'Edit', '[1,2]'),                                    // 字符串 → 解析成数组
      tool('wi-num', 'Write', 42),                                        // 原始值
      tool('rd-null', 'Read', null),                                      // 非写文件类：不抛穿即可
      tool('wi-valid', 'Write', '{"file_path":"ok.js","content":"const ok = 1;"}'),   // 合法 JSON 字符串
      line({type: 'assistant', uuid: 'fi-end', timestamp: '2026-04-02T00:00:03Z',
        message: {content: [{type: 'text', text: '结构化载荷收尾'}], stop_reason: 'end_turn'}}),
    ].join(''));
    const src = claude.create({root: d, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
    await src.scan(true);
    const st = src.stats();
    const s = src.sessions().find(x => x.id === 'fields');
    const valid = s && s.calls.find(c => c.callId === 'wi-valid');
    await rm(d, {recursive: true, force: true});
    checks.push(['v2.42 #2 已知类型字段校验：null/数组/原始值不抛穿、结束记录生效、stale=true',
      st.sessions === 1 && st.stale === true
        && !!s && s.calls.length === 5 && s.current === null && s.turnOpen === false
        && s.snippets.length === 0
        && !!valid && valid.label === 'ok.js'
        && s.msgs.some(m => m.text.includes('结构化载荷收尾')),
      JSON.stringify({...st, calls: s && s.calls.map(c => [c.callId, c.label]),
        current: !!(s && s.current), turnOpen: s && s.turnOpen,
        msgs: s && s.msgs.map(m => m.text)})]);
  }
  {
    /* 超深嵌套入参：JSON.parse 能成功、序列化必抛。旧实现让整份 foldSession 抛错，
       后面的结束记录被跳过（running 一直挂着）。修复后单条隔离 → 结束记录生效 + stale=true。 */
    const d = await mkdtemp(join(tmpdir(), 'claude-v242-deep-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    const f = join(pj, 'deep.jsonl');
    let deepJson = '1';
    for (let i = 0; i < 20000; i++) deepJson = '{"a":' + deepJson + '}';
    const deepLine = '{"type":"assistant","uuid":"deep-1","cwd":"D:\\\\pDeep","timestamp":"2026-04-03T00:00:02Z",'
      + '"message":{"content":[{"type":"tool_use","id":"deep-tool","name":"Write","input":' + deepJson + '}]}}\n';
    const endLine = line({type: 'assistant', uuid: 'deep-end', timestamp: '2026-04-03T00:00:03Z',
      message: {content: [{type: 'text', text: '深嵌套收尾'}], stop_reason: 'end_turn'}});
    let deepParseOk = false, deepStringifyThrows = false;
    try {
      const parsedDeep = JSON.parse(deepLine);
      deepParseOk = true;
      try { JSON.stringify(parsedDeep.message.content[0].input); } catch { deepStringifyThrows = true; }
    } catch { /* 解析失败时下面前置断言会明确失败 */ }
    await writeFile(f, deepLine + endLine);
    const src = claude.create({root: d, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
    await src.scan(true);
    const st = src.stats();
    const s = src.sessions().find(x => x.id === 'deep');
    await rm(d, {recursive: true, force: true});
    checks.push(['v2.42 #2 超深嵌套序列化前置：该行可解析、但直接序列化确实抛错',
      deepParseOk && deepStringifyThrows, JSON.stringify({deepParseOk, deepStringifyThrows})]);
    checks.push(['v2.42 #2 超深嵌套序列化：单条记录隔离（结束记录生效、快照提交）且 stale=true',
      st.sessions === 1 && st.stale === true && st.running === 0
        && !!s && s.current === null && s.turnOpen === false
        && s.calls.length === 1 && s.calls[0].name === 'Write' && s.calls[0].argBytes <= 2
        && s.msgs.some(m => m.text.includes('深嵌套收尾')),
      JSON.stringify({...st, current: !!(s && s.current), turnOpen: s && s.turnOpen,
        calls: s && s.calls.map(c => [c.name, c.argBytes]), msgs: s && s.msgs.map(m => m.text)})]);
  }

  /* #4 空闲会话超出活跃窗口后，读取故障恢复时必须能重试（外层调度 + 内层缓存命中两处），
     恢复为缓存版本的内容/size/mtime 后普通扫描要清除 stale。 */
  {
    const d = await mkdtemp(join(tmpdir(), 'claude-v242-recover-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    const f = join(pj, 'idle.jsonl');
    const body = line({type: 'user', uuid: 'idle-1', cwd: 'D:\\pIdle',
      timestamp: '2026-05-01T00:00:00Z', message: {content: '空闲会话'}})
      + line({type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-05-01T00:00:01Z'});
    await writeFile(f, body);
    const old = new Date(Date.now() - 7_200_000);
    await utimes(f, old, old);
    let fail = false, reads = 0;
    const io = {
      readdir: (p, o) => realReaddir(p, o),
      stat: (p, o) => realStat(p, o),
      readFile: (p, o) => {
        if (String(p) === f) {
          reads++;
          if (fail) throw Object.assign(new Error('EACCES: permission denied, open ' + p), {code: 'EACCES'});
        }
        return realReadFile(p, o);
      },
    };
    const arr = [];
    const src = claude.create({root: d, activeMs: 3_600_000, io, listIntervalMs: 0,
      live: {push(it) { arr.push(it); }}});
    await src.scan(true);
    const st0 = src.stats();
    await writeFile(f, body + ' ');                    // 内容变动触发一次读取
    fail = true;
    await src.scan(false);
    const stBad = src.stats();
    await writeFile(f, body);                          // 恢复为缓存版本的内容
    await utimes(f, old, old);                         // 与缓存版本同 size/mtime
    fail = false;
    const readsBefore = reads;
    await src.scan(false);
    const stRec = src.stats();
    const sRec = src.sessions().find(x => x.id === 'idle');
    await src.scan(false);
    const stAgain = src.stats();
    await rm(d, {recursive: true, force: true});
    checks.push(['v2.42 #4 空闲会话读故障恢复：外层活跃过滤放行重试，stale 归假',
      st0.stale === false && stBad.stale === true
        && stRec.stale === false && stAgain.stale === false
        && !!sRec && sRec.msgs.some(m => m.text.includes('空闲会话'))
        && reads > readsBefore,
      JSON.stringify({base: st0, bad: stBad, recovered: stRec, again: stAgain,
        reads: [readsBefore, reads]})]);
  }
  {
    /* 解析故障恢复且 size/mtime 与缓存版本完全一致：外层 retrying 例外 + 内层缓存命中重试都要放行。 */
    const d = await mkdtemp(join(tmpdir(), 'claude-v242-parserecover-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    const f = join(pj, 'parse.jsonl');
    const clean = line({type: 'user', uuid: 'pr-1', cwd: 'D:\\pParse',
      timestamp: '2026-05-02T00:00:00Z', message: {content: '解析恢复'}})
      + line({type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-05-02T00:00:01Z'});
    await writeFile(f, clean);
    const old = new Date(Date.now() - 7_200_000);
    await utimes(f, old, old);
    let reads = 0;
    const io = {
      readdir: (p, o) => realReaddir(p, o),
      stat: (p, o) => realStat(p, o),
      readFile: (p, o) => { if (String(p) === f) reads++; return realReadFile(p, o); },
    };
    const arr = [];
    const src = claude.create({root: d, activeMs: 1, io, listIntervalMs: 0,
      live: {push(it) { arr.push(it); }}});
    await src.scan(true);
    const st0 = src.stats();
    const corrupt = '@' + clean.slice(1);              // 等长；首行不再是合法 JSON（不是末行）
    const t2 = new Date(old.getTime() + 60_000);       // 既与缓存版本不同（能被发现），又超出活跃窗口
    await writeFile(f, corrupt);
    await utimes(f, t2, t2);
    await src.scan(false);
    const stBad = src.stats();
    await src.scan(false);                             // 读取成功但故障未恢复：不能洗掉
    const stStill = src.stats();
    await writeFile(f, clean);                         // 等长恢复
    await utimes(f, t2, t2);                           // 与缓存版本同 size/mtime
    const readsBefore = reads;
    await src.scan(false);
    const stRec = src.stats();
    await rm(d, {recursive: true, force: true});
    checks.push(['v2.42 #4 解析故障恢复（size/mtime 未变）：内层缓存命中仍重试，stale 归假',
      st0.stale === false && stBad.stale === true && stStill.stale === true
        && stRec.stale === false && reads > readsBefore,
      JSON.stringify({base: st0, bad: stBad, still: stStill, recovered: stRec,
        reads: [readsBefore, reads]})]);
  }

  /* #8 工具名索引必须按会话作用域，并从权威调用记录维护（不依赖这一轮是否发事件）；
     超阈值按单会话 FIFO 回收而不是整表 clear。 */
  {
    const d = await mkdtemp(join(tmpdir(), 'claude-v242-names-'));
    const pa = join(d, 'projA'), pb = join(d, 'projB');
    await mkdir(pa, {recursive: true});
    await mkdir(pb, {recursive: true});
    const fa = join(pa, 'a.jsonl'), fb = join(pb, 'b.jsonl');
    const call = (id, name, at) => line({type: 'assistant', uuid: 'call-' + id,
      timestamp: at, cwd: 'D:\\pName',
      message: {content: [{type: 'tool_use', id, name, input: {}}]}});
    const fail = (id, at, text, uuid) => line({type: 'user', uuid,
      timestamp: at, message: {content: [{type: 'tool_result', tool_use_id: id, is_error: true, content: text}]}});
    await writeFile(fa, call('shared-name', 'Read', '2026-04-01T00:00:01Z'));
    await writeFile(fb, call('shared-name', 'Write', '2026-04-01T00:00:01Z'));
    const arr = [];
    const src = claude.create({root: d, activeMs: 999999999, live: {push(it) { arr.push(it); }}, listIntervalMs: 0});
    await src.scan(true);
    const from = arr.length;
    await writeFile(fa, call('shared-name', 'Read', '2026-04-01T00:00:01Z')
      + fail('shared-name', '2026-04-01T00:00:02Z', 'EACCES: denied', 'fail-a'));
    await src.scan(false);
    const ev = arr.slice(from);
    const sa = src.sessions().find(x => x.id === 'a');
    const sb = src.sessions().find(x => x.id === 'b');
    checks.push(['v2.42 #8 跨会话同 call_id：失败事件用本会话工具名（a=Read，b=Write）',
      ev.length === 1 && /Read/.test(ev[0].name) && !/Write/.test(ev[0].name)
        && !!sa && !!sa.lastFail && sa.lastFail.name === 'Read'
        && !!sb && sb.lastFail === null,
      JSON.stringify({event: ev, aFail: sa && sa.lastFail, bFail: sb && sb.lastFail})]);
    await rm(fb, {force: true});                       // 删除会话 b，索引不能残留它的 Write
    await src.scan(false);
    const from2 = arr.length;
    await writeFile(fa, call('shared-name', 'Read', '2026-04-01T00:00:01Z')
      + fail('shared-name', '2026-04-01T00:00:02Z', 'EACCES: denied', 'fail-a')
      + fail('shared-name', '2026-04-01T00:00:03Z', 'ENOENT: gone', 'fail-a2'));
    await src.scan(false);
    const ev2 = arr.slice(from2);
    checks.push(['v2.42 #8 会话删除后：同 ID 失败仍用存活会话工具名，不残留已删会话索引',
      ev2.length === 1 && /Read/.test(ev2[0].name) && !/Write/.test(ev2[0].name),
      JSON.stringify({event: ev2})]);
    await rm(d, {recursive: true, force: true});
  }
  {
    /* 只追加结果：调用记录在最开始、首次预热根本没发过它的事件，索引仍必须从权威调用数据建立。 */
    const d = await mkdtemp(join(tmpdir(), 'claude-v242-onlyresult-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    const f = join(pj, 'late.jsonl');
    const earlyCall = line({type: 'assistant', uuid: 'early-call', timestamp: '2026-04-02T00:00:01Z',
      cwd: 'D:\\pOnly', message: {content: [{type: 'tool_use', id: 'early-name', name: 'Bash',
        input: {command: 'ls'}}]}});
    const filler = Array.from({length: 70}, (_, i) => line({type: 'user', uuid: 'early-u-' + i,
      timestamp: new Date(Date.parse('2026-04-02T00:00:02Z') + i * 1000).toISOString(),
      message: {content: 'filler-' + i}}));
    await writeFile(f, line({type: 'user', uuid: 'early-start', timestamp: '2026-04-02T00:00:00Z',
      cwd: 'D:\\pOnly', message: {content: '开始'}}) + earlyCall + filler.join(''));
    const arr = [];
    const src = claude.create({root: d, activeMs: 999999999, live: {push(it) { arr.push(it); }}, listIntervalMs: 0});
    await src.scan(true);
    const from = arr.length;
    await writeFile(f, line({type: 'user', uuid: 'early-start', timestamp: '2026-04-02T00:00:00Z',
      cwd: 'D:\\pOnly', message: {content: '开始'}}) + earlyCall + filler.join('')
      + line({type: 'user', uuid: 'early-fail', timestamp: '2026-04-02T00:02:00Z',
        message: {content: [{type: 'tool_result', tool_use_id: 'early-name', is_error: true,
          content: 'EACCES: denied'}]}}));
    await src.scan(false);
    const ev = arr.slice(from);
    await rm(d, {recursive: true, force: true});
    checks.push(['v2.42 #8 只追加结果：未发布事件的早期调用也能给出正确工具名',
      ev.length === 1 && /Bash/.test(ev[0].name) && /EACCES/.test(ev[0].name),
      JSON.stringify({event: ev})]);
  }
  {
    /* 超阈值：805 个调用、单会话 FIFO 保留最近 800；失败结果仍能查到近期工具名，不能整表 clear。 */
    const d = await mkdtemp(join(tmpdir(), 'claude-v242-namecap-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    const f = join(pj, 'cap.jsonl');
    const calls = Array.from({length: 805}, (_, i) => ({type: 'tool_use', id: 'cap-' + (i + 1),
      name: 'Tool-' + (i + 1), input: {}}));
    const head = line({type: 'user', uuid: 'cap-u', timestamp: '2026-04-03T00:00:00Z',
      cwd: 'D:\\pCap', message: {content: '阈值前'}})
      + line({type: 'assistant', uuid: 'cap-calls', timestamp: '2026-04-03T00:00:01Z',
        message: {content: calls}});
    await writeFile(f, head);
    const arr = [];
    const src = claude.create({root: d, activeMs: 999999999, live: {push(it) { arr.push(it); }}, listIntervalMs: 0});
    await src.scan(true);
    const from = arr.length;
    await writeFile(f, head + line({type: 'user', uuid: 'cap-fails', timestamp: '2026-04-03T00:00:02Z',
      message: {content: [
        {type: 'tool_result', tool_use_id: 'cap-700', is_error: true, content: 'EACCES: denied'},
        {type: 'tool_result', tool_use_id: 'cap-805', is_error: true, content: 'EIO: broken'},
      ]}}));
    await src.scan(false);
    const ev = arr.slice(from);
    await rm(d, {recursive: true, force: true});
    checks.push(['v2.42 #8 索引超阈值：按单会话 FIFO 保留近期调用，失败事件仍带正确工具名',
      ev.length === 2
        && ev.some(x => /Tool-700/.test(x.name) && /EACCES/.test(x.name))
        && ev.some(x => /Tool-805/.test(x.name) && /EIO/.test(x.name)),
      JSON.stringify({events: ev.map(x => x.name)})]);
  }
  {
    /* 工具改名：快照与失败事件都用权威调用记录里的新名字。 */
    const d = await mkdtemp(join(tmpdir(), 'claude-v242-rename-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    const f = join(pj, 'rename.jsonl');
    const call = name => line({type: 'assistant', uuid: 'rn-call', timestamp: '2026-04-04T00:00:01Z',
      cwd: 'D:\\pRename', message: {content: [{type: 'tool_use', id: 'rn-id', name, input: {}}]}});
    const fail = line({type: 'user', uuid: 'rn-fail', timestamp: '2026-04-04T00:00:02Z',
      message: {content: [{type: 'tool_result', tool_use_id: 'rn-id', is_error: true, content: 'EACCES: denied'}]}});
    await writeFile(f, call('Read'));
    const arr = [];
    const src = claude.create({root: d, activeMs: 999999999, live: {push(it) { arr.push(it); }}, listIntervalMs: 0});
    await src.scan(true);
    const from = arr.length;
    await writeFile(f, call('Write') + fail);
    await src.scan(false);
    const ev = arr.slice(from);
    const s = src.sessions().find(x => x.id === 'rename');
    await rm(d, {recursive: true, force: true});
    checks.push(['v2.42 #8 工具改名：失败事件与会话 lastFail 都使用新工具名',
      ev.some(x => x.ok === false && /Write/.test(x.name) && /EACCES/.test(x.name))
        && !!s && !!s.lastFail && s.lastFail.name === 'Write'
        && !ev.some(x => x.ok === false && /Read/.test(x.name)),
      JSON.stringify({events: ev, lastFail: s && s.lastFail})]);
  }

  {
    /* 用户实测：Claude Code 输入 /exit 退出后，日志只有 command-name/local-command-stdout 标记，
       没有 result/end_turn；适配器必须收尾并输出 ended，core 才会把会话撤下墙。 */
    const d = await mkdtemp(join(tmpdir(), 'claude-exit-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    const fExit = join(pj, 'exit.jsonl');
    const fLive = join(pj, 'live.jsonl');
    const start = (sid, cwd, at) => line({type: 'user', uuid: sid + '-u0', timestamp: at, cwd, message: {content: '开始'}});
    const toolUse = (sid, at) => line({type: 'assistant', uuid: sid + '-a1', timestamp: at,
      message: {content: [{type: 'tool_use', id: sid + '-call', name: 'Bash', input: {command: 'sleep 5'}}]}});
    const exitCmd = line({type: 'user', uuid: 'exit-u1', isMeta: true, timestamp: '2026-05-01T00:00:03Z',
      message: {content: '<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>'}});
    const exitBye = line({type: 'user', uuid: 'exit-u2', isMeta: true, timestamp: '2026-05-01T00:00:04Z',
      message: {content: '<local-command-stdout>Goodbye!</local-command-stdout>'}});
    const cost = line({type: 'cost-state', uuid: 'exit-cost', timestamp: '2026-05-01T00:00:05Z'});
    await writeFile(fExit, start('exit', 'D:\\wExit', '2026-05-01T00:00:00Z') + toolUse('exit', '2026-05-01T00:00:02Z') + exitCmd + exitBye + cost);
    await writeFile(fLive, start('live', 'D:\\wLive', '2026-05-01T00:00:00Z') + toolUse('live', '2026-05-01T00:00:02Z'));
    // 普通用户消息里出现 Goodbye! 不能被误判为退出
    const fWord = join(pj, 'word.jsonl');
    await writeFile(fWord, start('word', 'D:\\wWord', '2026-05-01T00:00:00Z')
      + line({type: 'user', uuid: 'word-u1', timestamp: '2026-05-01T00:00:02Z', message: {content: 'say Goodbye! to them'}})
      + toolUse('word', '2026-05-01T00:00:03Z'));
    const src = claude.create({root: d, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
    await src.scan(true);
    const sExit = src.sessions().find(x => x.id === 'exit');
    const sLive = src.sessions().find(x => x.id === 'live');
    const sWord = src.sessions().find(x => x.id === 'word');
    checks.push(['v2.42 用户实测 /exit：回合收尾、运行态清空、标记 ended',
      !!sExit && sExit.turnOpen === false && sExit.current === null && sExit.ended === true,
      JSON.stringify(sExit && {turnOpen: sExit.turnOpen, current: sExit.current, ended: sExit.ended})]);
    checks.push(['v2.42 用户实测 /exit：退出命令不进用户消息与标题',
      !!sExit && !sExit.msgs.some(m => /\/exit|Goodbye!/.test(m.text)),
      JSON.stringify(sExit && sExit.msgs.map(m => m.text))]);
    checks.push(['v2.42 用户实测 /exit：未退出的会话仍正常运行（ended 不误伤）',
      !!sLive && !!sLive.current && !sLive.ended && sLive.turnOpen !== false,
      JSON.stringify(sLive && {cur: !!sLive.current, ended: sLive.ended, turnOpen: sLive.turnOpen})]);
    checks.push(['v2.42 用户实测 /exit：普通消息里的 Goodbye! 不误判退出',
      !!sWord && !sWord.ended && !!sWord.current, JSON.stringify(sWord && {ended: sWord.ended, cur: !!sWord.current})]);
    await rm(d, {recursive: true, force: true});
  }

  /* ============================================================
   * 复核 v2.43 #1 / #2 / #3 / #9（Claude 侧）
   * 每组独立临时目录 + 独立源；断言同时检查快照、健康状态与实际发布的事件。
   * ============================================================ */

  /* #1 根目录确认删除：ENOENT/ENOTDIR 与 EACCES/父链不可用分开处理；
     确认删除后 sessions/running/files 同时归零、stale 不残留；同路径重建能识别新会话。 */
  {
    const busyLog = (sid, cwd) => [
      line({type: 'user', cwd, uuid: sid + '-u0', timestamp: '2026-06-01T00:00:00Z', message: {content: '开始-' + sid}}),
      line({type: 'assistant', uuid: sid + '-a1', timestamp: '2026-06-01T00:00:02Z',
        message: {content: [{type: 'tool_use', id: sid + '-call', name: 'Bash', input: {command: 'sleep 5'}}]}}),
    ].join('');
    const d = await mkdtemp(join(tmpdir(), 'claude-v243-rootdel-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    await writeFile(join(pj, 's1.jsonl'), busyLog('s1', 'D:\\wRoot'));
    let failDir = null;
    const ioRoot = {
      readdir: (p, o) => {
        if (failDir && String(p).replace(/[\\/]+$/, '') === failDir) {
          throw Object.assign(new Error('EACCES: permission denied, scandir ' + p), {code: 'EACCES'});
        }
        return realReaddir(p, o);
      },
      readFile: realReadFile,
      stat: realStat,
    };
    const src = claude.create({root: d, activeMs: 999999999, live: {push() {}}, io: ioRoot, listIntervalMs: 0});
    await src.scan(true);
    const stRootBase = src.stats();
    failDir = pj;                                         // ① 项目子目录 readdir EACCES
    await src.scan(false);
    const stRootChild = src.stats();
    failDir = null;
    await rm(d, {recursive: true, force: true});          // ② 删除整个源根（父链仍在）
    await src.scan(false);
    const stRootGone = src.stats();
    await src.scan(false);                                // ③ 连续再扫一轮
    const stRootGone2 = src.stats();
    await mkdir(join(d, 'proj2'), {recursive: true});     // ④ 同路径重建
    await writeFile(join(d, 'proj2', 's2.jsonl'), busyLog('s2', 'D:\\wRoot2'));
    await src.scan(false);
    const stRootNew = src.stats();
    const idsRootNew = src.sessions().map(s => s.id);
    await rm(d, {recursive: true, force: true});
    checks.push(['v2.43 #1 根删除前置：运行中会话被缓存（sessions=1/running=1）',
      stRootBase.sessions === 1 && stRootBase.running === 1, JSON.stringify(stRootBase)]);
    checks.push(['v2.43 #1 项目子目录 EACCES：保留缓存并标 stale（files=0）',
      stRootChild.sessions === 1 && stRootChild.running === 1 && stRootChild.files === 0 && stRootChild.stale === true,
      JSON.stringify(stRootChild)]);
    checks.push(['v2.43 #1 删除整个源根：确认删除后 sessions/running/files 归零、stale 不残留',
      stRootGone.sessions === 0 && stRootGone.running === 0 && stRootGone.files === 0 && stRootGone.stale === false,
      JSON.stringify(stRootGone)]);
    checks.push(['v2.43 #1 删除后连续第二轮仍为零、stale=false（旧会话不上墙）',
      stRootGone2.sessions === 0 && stRootGone2.running === 0 && stRootGone2.files === 0 && stRootGone2.stale === false,
      JSON.stringify(stRootGone2)]);
    checks.push(['v2.43 #1 同路径重建：识别新会话，旧会话不残留',
      stRootNew.sessions === 1 && stRootNew.running === 1 && stRootNew.stale === false
        && idsRootNew.length === 1 && idsRootNew[0] === 's2',
      JSON.stringify({...stRootNew, ids: idsRootNew})]);
  }
  {
    /* 根 readdir 不是 ENOENT（EACCES/设备不可用）→ 不能猜删除，旧快照与 stale 保留。 */
    const d = await mkdtemp(join(tmpdir(), 'claude-v243-rooteacces-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    await writeFile(join(pj, 's1.jsonl'), [
      line({type: 'user', cwd: 'D:\\wRE', uuid: 're-u0', timestamp: '2026-06-02T00:00:00Z', message: {content: '开始'}}),
      line({type: 'assistant', uuid: 're-a1', timestamp: '2026-06-02T00:00:02Z',
        message: {content: [{type: 'tool_use', id: 're-call', name: 'Bash', input: {command: 'sleep 5'}}]}}),
    ].join(''));
    let rootFail = false;
    const io = {
      readdir: (p, o) => {
        if (rootFail && String(p).replace(/[\\/]+$/, '') === d.replace(/[\\/]+$/, '')) {
          throw Object.assign(new Error('EACCES: permission denied, scandir ' + p), {code: 'EACCES'});
        }
        return realReaddir(p, o);
      },
      readFile: realReadFile,
      stat: realStat,
    };
    const src = claude.create({root: d, activeMs: 999999999, live: {push() {}}, io, listIntervalMs: 0});
    await src.scan(true);
    rootFail = true;
    await src.scan(false);
    const st = src.stats();
    await rm(d, {recursive: true, force: true});
    checks.push(['v2.43 #1 根 readdir EACCES（无法确认删除）：缓存保留、running 不变、stale=true',
      st.sessions === 1 && st.running === 1 && st.stale === true, JSON.stringify(st)]);
  }
  {
    /* 根 readdir ENOENT 但父链整体不可访问（stat 全部 EACCES）→ 不能确认删除，保留旧快照。 */
    const d = await mkdtemp(join(tmpdir(), 'claude-v243-chain-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    await writeFile(join(pj, 's1.jsonl'), [
      line({type: 'user', cwd: 'D:\\wChain', uuid: 'ch-u0', timestamp: '2026-06-03T00:00:00Z', message: {content: '开始'}}),
      line({type: 'assistant', uuid: 'ch-a1', timestamp: '2026-06-03T00:00:02Z',
        message: {content: [{type: 'tool_use', id: 'ch-call', name: 'Bash', input: {command: 'sleep 5'}}]}}),
    ].join(''));
    let chainDown = false, rootGone = false;
    const io = {
      readdir: (p, o) => {
        if (rootGone && String(p).replace(/[\\/]+$/, '') === d.replace(/[\\/]+$/, '')) {
          throw Object.assign(new Error('ENOENT: gone, scandir ' + p), {code: 'ENOENT'});
        }
        return realReaddir(p, o);
      },
      readFile: realReadFile,
      stat: (p, o) => {
        if (chainDown) throw Object.assign(new Error('EACCES: permission denied, stat ' + p), {code: 'EACCES'});
        return realStat(p, o);
      },
    };
    const src = claude.create({root: d, activeMs: 999999999, live: {push() {}}, io, listIntervalMs: 0});
    await src.scan(true);
    chainDown = true; rootGone = true;
    await src.scan(false);
    const stEacces = src.stats();
    // 父链恢复可 stat：能确认根已删除 → 清空
    chainDown = false;
    await src.scan(false);
    const stConfirmed = src.stats();
    await rm(d, {recursive: true, force: true});
    checks.push(['v2.43 #1 根 ENOENT 但父链 stat EACCES：无法确认删除，缓存与 stale 保留',
      stEacces.sessions === 1 && stEacces.running === 1 && stEacces.stale === true, JSON.stringify(stEacces)]);
    checks.push(['v2.43 #1 根 ENOENT 且父链可 stat：确认删除，缓存清空且 stale=false',
      stConfirmed.sessions === 0 && stConfirmed.running === 0 && stConfirmed.stale === false,
      JSON.stringify(stConfirmed)]);
  }
  {
    /* ENOTDIR（原目录变成文件）也属于确认消失。 */
    const d = await mkdtemp(join(tmpdir(), 'claude-v243-notdir-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    await writeFile(join(pj, 's1.jsonl'), [
      line({type: 'user', cwd: 'D:\\wND', uuid: 'nd-u0', timestamp: '2026-06-04T00:00:00Z', message: {content: '开始'}}),
      line({type: 'assistant', uuid: 'nd-a1', timestamp: '2026-06-04T00:00:02Z',
        message: {content: [{type: 'tool_use', id: 'nd-call', name: 'Bash', input: {command: 'sleep 5'}}]}}),
    ].join(''));
    const src = claude.create({root: d, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
    await src.scan(true);
    await rm(d, {recursive: true, force: true});
    await writeFile(d, 'not a directory');               // 同路径变成文件 → readdir ENOTDIR
    await src.scan(false);
    const stNotDir = src.stats();
    await rm(d, {force: true});
    checks.push(['v2.43 #1 根变成文件（ENOTDIR）：确认删除，缓存清空、stale=false',
      stNotDir.sessions === 0 && stNotDir.running === 0 && stNotDir.stale === false, JSON.stringify(stNotDir)]);
  }

  /* #2 退出生命周期：只认真实控制记录形状；ended/exitedAt 是当前位置的状态，
     真实新交互/助手活动可恢复；迟到结果与控制输出不恢复；控制 XML 不进 msgs/标题/事件流。 */
  {
    const d = await mkdtemp(join(tmpdir(), 'claude-v243-exitlife-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    const U = (uuid, at, content, extra = {}) => line({type: 'user', uuid, timestamp: at, ...extra, message: {content}});
    const A = (uuid, at, content) => line({type: 'assistant', uuid, timestamp: at, message: {content}});
    const EXIT_CMD = (uuid, at) => U(uuid, at,
      '<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>',
      {isMeta: true});
    const EXIT_OUT = (uuid, at) => U(uuid, at, '<local-command-stdout>Goodbye!</local-command-stdout>', {isMeta: true});
    const busyTool = (id, at) => A('a-' + id, at, [{type: 'tool_use', id, name: 'Bash', input: {command: 'sleep 5'}}]);
    const lateResult = (id, at) => line({type: 'user', uuid: 'late-' + id, timestamp: at,
      message: {content: [{type: 'tool_result', tool_use_id: id, content: '迟到的成功结果'}]}});
    const mkState = sessions => buildState({sessions, live: createLive(), codes: createCodes(),
      activeMs: 999999999, maxAgents: 12, maxTasks: 60, servedFrom: 'test', source: 'claude'});

    const fLife = join(pj, 'lifecycle.jsonl');
    const lifeHead = U('l-u0', '2026-07-01T00:00:00Z', '开始-退出生命周期', {cwd: 'D:\\wExitLife'})
      + busyTool('tu-life', '2026-07-01T00:00:02Z') + EXIT_CMD('l-u1', '2026-07-01T00:00:03Z')
      + EXIT_OUT('l-u2', '2026-07-01T00:00:04Z');
    await writeFile(fLife, lifeHead);
    const pushBox = [];
    const src = claude.create({root: d, activeMs: 999999999, live: {push(it) { pushBox.push(it); }}, listIntervalMs: 0});
    await src.scan(true);
    const sExit = src.sessions().find(x => x.id === 'lifecycle');
    const stExit = src.stats();
    const stStateExit = mkState(src.sessions());
    // 迟到 tool_result + 再次控制输出：都不能把已退出的会话拉回来
    await writeFile(fLife, lifeHead + lateResult('tu-life', '2026-07-01T00:00:05Z')
      + EXIT_OUT('l-u4', '2026-07-01T00:00:06Z'));
    await src.scan(false);
    const sLate = src.sessions().find(x => x.id === 'lifecycle');
    const stLate = src.stats();
    // 同 session 真实恢复：新用户消息 + 新 tool_use
    const lifeResume = lifeHead + lateResult('tu-life', '2026-07-01T00:00:05Z')
      + EXIT_OUT('l-u4', '2026-07-01T00:00:06Z')
      + U('l-u5', '2026-07-01T00:00:07Z', '继续-恢复工作')
      + A('l-a6', '2026-07-01T00:00:08Z', [{type: 'tool_use', id: 'tu-resume', name: 'Read', input: {file_path: 'resume.js'}}]);
    await writeFile(fLife, lifeResume);
    await src.scan(false);
    const sResume = src.sessions().find(x => x.id === 'lifecycle');
    const stResume = src.stats();
    const stStateResume = mkState(src.sessions());
    // 恢复后再次真实退出：可以再次收尾
    const lifeExit2 = lifeResume + EXIT_CMD('l-u7', '2026-07-01T00:00:09Z') + EXIT_OUT('l-u8', '2026-07-01T00:00:10Z');
    await writeFile(fLife, lifeExit2);
    await src.scan(false);
    const sExit2 = src.sessions().find(x => x.id === 'lifecycle');
    const stExit2 = src.stats();
    const stStateExit2 = mkState(src.sessions());

    const runNames = st => st.tasks.filter(t => t.state === 'run').map(t => t.name);
    checks.push(['v2.43 #2 真实 /exit 控制记录：ended=true、运行态清空、节点保留但空闲',
      !!sExit && sExit.ended === true && sExit.exitedAt === Date.parse('2026-07-01T00:00:03Z')
        && sExit.current === null && sExit.openStep === null && sExit.turnOpen === false
        && stExit.running === 0 && stStateExit.agents.length === 1
        && stStateExit.agents[0].running === false && runNames(stStateExit).length === 0,
      JSON.stringify({s: sExit && {ended: sExit.ended, exitedAt: sExit.exitedAt, current: sExit.current,
        openStep: sExit.openStep, turnOpen: sExit.turnOpen}, stats: stExit, agents: stStateExit.agents,
        run: runNames(stStateExit)})]);
    checks.push(['v2.43 #2 退出命令/控制输出不进 msgs 与标题',
      !!sExit && !sExit.msgs.some(m => /command-name|local-command-stdout|Goodbye!/.test(m.text))
        && sExit.title === '开始-退出生命周期',
      JSON.stringify(sExit && {msgs: sExit.msgs.map(m => m.text), title: sExit.title})]);
    checks.push(['v2.43 #2 控制 XML 不进事件流',
      !pushBox.some(e => /command-name|local-command-stdout|Goodbye!/.test(String(e.name || ''))),
      JSON.stringify(pushBox.map(e => e.name))]);
    checks.push(['v2.43 #2 退出后迟到 tool_result / 控制输出都不恢复：ended 仍 true、无 current、running=0',
      !!sLate && sLate.ended === true && sLate.current === null && sLate.openStep === null
        && stLate.running === 0,
      JSON.stringify({s: sLate && {ended: sLate.ended, current: sLate.current, openStep: sLate.openStep}, stats: stLate})]);
    checks.push(['v2.43 #2 同 session 恢复：ended=false、exitedAt 清除、新 tool_use 成为 current、running=1',
      !!sResume && sResume.ended === false && !sResume.exitedAt && !!sResume.current
        && sResume.current.name === 'Read' && sResume.turnOpen === true
        && stResume.running === 1,
      JSON.stringify({s: sResume && {ended: sResume.ended, exitedAt: sResume.exitedAt,
        current: sResume.current && sResume.current.name, turnOpen: sResume.turnOpen}, stats: stResume})]);
    checks.push(['v2.43 #2 恢复后重新上墙、产生运行任务',
      stStateResume.agents.length === 1 && runNames(stStateResume).length > 0,
      JSON.stringify({agents: stStateResume.agents, run: runNames(stStateResume)})]);
    checks.push(['v2.43 #2 恢复后再次 /exit：再次收尾（ended=true、exitedAt 更新、running=0、节点保留但空闲）',
      !!sExit2 && sExit2.ended === true && sExit2.exitedAt === Date.parse('2026-07-01T00:00:09Z')
        && sExit2.current === null && stExit2.running === 0
        && stStateExit2.agents.length === 1 && stStateExit2.agents[0].running === false
        && runNames(stStateExit2).length === 0,
      JSON.stringify({s: sExit2 && {ended: sExit2.ended, exitedAt: sExit2.exitedAt, current: sExit2.current},
        stats: stExit2, agents: stStateExit2.agents, run: runNames(stStateExit2)})]);

    /* 普通文字/代码块引用控制 XML：不是控制记录，必须保留为普通消息，且不触发退出。 */
    const fQuote = join(pj, 'quote.jsonl');
    await writeFile(fQuote, U('q-u0', '2026-07-02T00:00:00Z',
      'Please explain this log fragment: <command-name>/exit</command-name>. Do not exit.', {cwd: 'D:\\wQuote'})
      + busyTool('tu-q', '2026-07-02T00:00:02Z'));
    const fCode = join(pj, 'codeblock.jsonl');
    await writeFile(fCode, U('cb-u0', '2026-07-02T00:00:00Z',
      '看这段日志：\n```\n<command-name>/exit</command-name>\n<local-command-stdout>Goodbye!</local-command-stdout>\n```',
      {cwd: 'D:\\wCode'})
      + busyTool('tu-cb', '2026-07-02T00:00:02Z'));
    const fWord = join(pj, 'goodbye.jsonl');
    await writeFile(fWord, U('gb-u0', '2026-07-02T00:00:00Z', 'Goodbye!', {cwd: 'D:\\wWord2'})
      + busyTool('tu-gb', '2026-07-02T00:00:02Z'));
    const fMeta = join(pj, 'metaref.jsonl');
    await writeFile(fMeta, U('im-u0', '2026-07-02T00:00:00Z',
      '<command-name>/exit</command-name> 只是日志引用，不要退出', {cwd: 'D:\\wMeta', isMeta: true})
      + busyTool('tu-im', '2026-07-02T00:00:02Z'));
    const fNoMeta = join(pj, 'nometa.jsonl');
    await writeFile(fNoMeta, U('nm-u0', '2026-07-02T00:00:00Z',
      '<command-name>/exit</command-name>', {cwd: 'D:\\wNoMeta'})
      + busyTool('tu-nm', '2026-07-02T00:00:02Z'));
    const fOtherCmd = join(pj, 'othercmd.jsonl');
    await writeFile(fOtherCmd, U('oc-u0', '2026-07-02T00:00:00Z',
      '<command-name>/help</command-name>\n<command-message>help</command-message>\n<command-args></command-args>',
      {cwd: 'D:\\wOther', isMeta: true})
      + busyTool('tu-oc', '2026-07-02T00:00:02Z'));
    const fOutOnly = join(pj, 'outonly.jsonl');
    await writeFile(fOutOnly, U('oo-u0', '2026-07-02T00:00:00Z', '开始-仅控制输出', {cwd: 'D:\\wOut'})
      + busyTool('tu-oo', '2026-07-02T00:00:02Z')
      + EXIT_OUT('oo-u1', '2026-07-02T00:00:03Z'));
    const fAsst = join(pj, 'assist.jsonl');
    await writeFile(fAsst, U('as-u0', '2026-07-02T00:00:00Z', '开始-助手恢复', {cwd: 'D:\\wAsst'})
      + EXIT_CMD('as-u1', '2026-07-02T00:00:02Z') + EXIT_OUT('as-u2', '2026-07-02T00:00:03Z')
      + A('as-a3', '2026-07-02T00:00:04Z', [{type: 'text', text: '助手活动恢复'}, {type: 'tool_use', id: 'tu-as', name: 'Read', input: {file_path: 'as.js'}}]));
    const src2 = claude.create({root: d, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
    await src2.scan(true);
    const q = src2.sessions().find(x => x.id === 'quote');
    const cb = src2.sessions().find(x => x.id === 'codeblock');
    const gb = src2.sessions().find(x => x.id === 'goodbye');
    const im = src2.sessions().find(x => x.id === 'metaref');
    const nm = src2.sessions().find(x => x.id === 'nometa');
    const oc = src2.sessions().find(x => x.id === 'othercmd');
    const oo = src2.sessions().find(x => x.id === 'outonly');
    const asst = src2.sessions().find(x => x.id === 'assist');
    await rm(d, {recursive: true, force: true});
    checks.push(['v2.43 #2 普通消息引用 /exit XML：不触发退出、保留为普通消息、标题取该消息',
      !!q && !q.ended && !!q.current && q.current.name === 'Bash'
        && q.msgs.some(m => /Do not exit/.test(m.text)) && q.title.includes('Please explain'),
      JSON.stringify(q && {ended: q.ended, current: !!q.current, msgs: q.msgs.map(m => m.text), title: q.title})]);
    checks.push(['v2.43 #2 代码块里引用 /exit 与 Goodbye：不触发退出、保留消息',
      !!cb && !cb.ended && !!cb.current && cb.msgs.some(m => /Goodbye!/.test(m.text)),
      JSON.stringify(cb && {ended: cb.ended, current: !!cb.current, msgs: cb.msgs.map(m => m.text)})]);
    checks.push(['v2.43 #2 普通文字 Goodbye! 不触发退出',
      !!gb && !gb.ended && !!gb.current, JSON.stringify(gb && {ended: gb.ended, current: !!gb.current})]);
    checks.push(['v2.43 #2 isMeta 但非真实控制形状：不触发退出（照常运行）',
      !!im && !im.ended && !!im.current, JSON.stringify(im && {ended: im.ended, current: !!im.current})]);
    checks.push(['v2.43 #2 缺 isMeta 的命令形状文本：不触发退出',
      !!nm && !nm.ended && !!nm.current, JSON.stringify(nm && {ended: nm.ended, current: !!nm.current})]);
    checks.push(['v2.43 #2 非 exit 的真实控制命令：不触发退出，也不作为普通消息展示',
      !!oc && !oc.ended && !!oc.current && !oc.msgs.some(m => /command-name/.test(m.text)),
      JSON.stringify(oc && {ended: oc.ended, current: !!oc.current, msgs: oc.msgs.map(m => m.text)})]);
    checks.push(['v2.43 #2 仅控制输出（无 command-name）不判断为退出',
      !!oo && !oo.ended && !!oo.current && !oo.msgs.some(m => /local-command-stdout|Goodbye!/.test(m.text)),
      JSON.stringify(oo && {ended: oo.ended, current: !!oo.current, msgs: oo.msgs.map(m => m.text)})]);
    checks.push(['v2.43 #2 退出后助手活动（文本/tool_use）能恢复：ended=false、current 生效',
      !!asst && asst.ended === false && !!asst.current && asst.current.name === 'Read'
        && asst.msgs.some(m => /助手活动恢复/.test(m.text)),
      JSON.stringify(asst && {ended: asst.ended, current: asst.current && asst.current.name,
        msgs: asst.msgs.map(m => m.text)})]);
  }

  /* #3 单记录隔离从归一化/身份开始：非法 ID/name/type/payload 不能抛穿 scan，
     要显式诊断并降级该条，后续合法消息与终态继续处理，其他会话不受影响。 */
  {
    const d = await mkdtemp(join(tmpdir(), 'claude-v243-isolate-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    const U = (uuid, at, text, extra = {}) => line({type: 'user', uuid, timestamp: at, ...extra, message: {content: text}});
    const rec = (uuid, at, content) => line({type: 'assistant', uuid, timestamp: at, message: {content}});
    const busy = (id, at, name = 'Bash') => rec('busy-' + id, at, [{type: 'tool_use', id, name, input: {command: 'sleep 5'}}]);

    // ① 原始复现：缓存运行中会话 → 追加非法 ID 的 tool_use → 追加合法 end_turn
    const fBad = join(pj, 'repro.jsonl');
    const headBad = U('rp-u0', '2026-08-01T00:00:00Z', '开始-非法ID', {cwd: 'D:\\wIso'})
      + busy('tu-repro', '2026-08-01T00:00:01Z');
    await writeFile(fBad, headBad);
    const pushBox = [];
    const srcRepro = claude.create({root: d, activeMs: 999999999, live: {push(it) { pushBox.push(it); }}, listIntervalMs: 0});
    await srcRepro.scan(true);
    const stReproBase = srcRepro.stats();
    const invalidIdRec = '{"type":"assistant","uuid":"rp-bad","timestamp":"2026-08-01T00:00:02Z","message":{"content":[{"type":"tool_use","id":{"toString":null},"name":"Read","input":{"file_path":"bad.js"}}]}}\n';
    const endRepro = rec('rp-end', '2026-08-01T00:00:03Z', [{type: 'text', text: '后续合法消息'}]);
    const endReproTerm = rec('rp-term', '2026-08-01T00:00:04Z', [{type: 'text', text: '终态收尾'}]);
    await writeFile(fBad, headBad + invalidIdRec + endRepro + endReproTerm
      + U('rp-tail', '2026-08-01T00:00:06Z', '终态后的尾消息')
      + '{"type":"assistant","uuid":"rp-term2","timestamp":"2026-08-01T00:00:05Z","message":{"content":[{"type":"text","text":"end"}],"stop_reason":"end_turn"}}\n');
    let reproErr = null;
    const fromRepro = pushBox.length;
    try { await srcRepro.scan(false); } catch (err) { reproErr = err; }
    const sRepro = srcRepro.sessions().find(x => x.id === 'repro');
    const stRepro = srcRepro.stats();
    const reproEv = pushBox.slice(fromRepro);
    checks.push(['v2.43 #3 前置：运行中会话已缓存',
      stReproBase.sessions === 1 && stReproBase.running === 1, JSON.stringify(stReproBase)]);
    checks.push(['v2.43 #3 非法 ID {"toString":null}：scan 不抛错',
      reproErr === null, String(reproErr && reproErr.message)]);
    checks.push(['v2.43 #3 非法 ID：后续合法终态生效（无 current/openStep、turnOpen=false）',
      !!sRepro && sRepro.current === null && sRepro.openStep === null && sRepro.turnOpen === false,
      JSON.stringify(sRepro && {current: sRepro.current, openStep: sRepro.openStep, turnOpen: sRepro.turnOpen})]);
    checks.push(['v2.43 #3 非法 ID：降级标 stale、诊断可见、后续合法消息保留',
      stRepro.stale === true && !!sRepro && !!sRepro.parseIssues
        && Number(sRepro.parseIssues.fieldFaults) >= 1
        && Array.isArray(sRepro.parseIssues.diagnostics) && sRepro.parseIssues.diagnostics.length >= 1
        && sRepro.msgs.some(m => m.text.includes('后续合法消息'))
        && sRepro.msgs.some(m => m.text.includes('终态后的尾消息')),
      JSON.stringify({stats: stRepro, issues: sRepro && sRepro.parseIssues,
        msgs: sRepro && sRepro.msgs.map(m => m.text)})]);
    checks.push(['v2.43 #3 非法 ID：不为损坏块生成事件',
      !reproEv.some(e => /bad\.js/.test(String(e.name || ''))),
      JSON.stringify(reproEv.map(e => e.name))]);

    // ② 形状矩阵：ID/name/type/payload 的 null/数组/对象/含 toString-valueOf/超深 JSON
    let deepJson = '1';
    for (let i = 0; i < 20000; i++) deepJson = '{"a":' + deepJson + '}';
    const deepPayload = JSON.parse(deepJson);
    const variants = [
      ['id-null', {type: 'tool_use', id: null, name: 'Read', input: {file_path: 'v.js'}}, true],
      ['id-arr', {type: 'tool_use', id: ['tu'], name: 'Read', input: {file_path: 'v.js'}}, true],
      ['id-obj', {type: 'tool_use', id: {a: 1}, name: 'Read', input: {file_path: 'v.js'}}, true],
      ['id-tostring', {type: 'tool_use', id: {toString: null}, name: 'Read', input: {file_path: 'v.js'}}, true],
      ['id-valueof', {type: 'tool_use', id: {toString: null, valueOf: null}, name: 'Read', input: {file_path: 'v.js'}}, true],
      ['name-null', {type: 'tool_use', id: 'tu-name-null', name: null, input: {file_path: 'v.js'}}, true],
      ['name-arr', {type: 'tool_use', id: 'tu-name-arr', name: ['Read'], input: {file_path: 'v.js'}}, true],
      ['name-obj', {type: 'tool_use', id: 'tu-name-obj', name: {a: 1}, input: {file_path: 'v.js'}}, true],
      ['name-tostring', {type: 'tool_use', id: 'tu-name-ts', name: {toString: null}, input: {file_path: 'v.js'}}, true],
      ['type-null', {id: 'tu-type-null', name: 'Read', type: null, input: {}}, true],
      ['type-arr', {id: 'tu-type-arr', name: 'Read', type: ['tool_use'], input: {}}, true],
      ['type-obj', {id: 'tu-type-obj', name: 'Read', type: {x: 1}, input: {}}, true],
      ['payload-null-write', {type: 'tool_use', id: 'tu-payload-null', name: 'Write', input: null}, true],
      ['payload-arr-write', {type: 'tool_use', id: 'tu-payload-arr', name: 'Write', input: [1, 2]}, true],
      ['payload-tostring', {type: 'tool_use', id: 'tu-payload-ts', name: 'Read', input: {toString: null}}, false],
      ['payload-deep', {type: 'tool_use', id: 'tu-payload-deep', name: 'Read', input: deepPayload}, true],
    ];
    for (const [id, block] of variants) {
      const f = join(pj, 'v-' + id + '.jsonl');
      // 超深 JSON 不能用 JSON.stringify 生成夹具（会把测试自己的栈压爆），直接拼原始行
      const badRec = id === 'payload-deep'
        ? '{"type":"assistant","uuid":"v-payload-deep-bad","timestamp":"2026-08-02T00:00:02Z",'
          + '"message":{"content":[{"type":"tool_use","id":"tu-payload-deep","name":"Read","input":'
          + deepJson + '}]}}\n'
        : rec('v-' + id + '-bad', '2026-08-02T00:00:02Z', [block]);
      const body = U('v-' + id + '-u0', '2026-08-02T00:00:00Z', '前-' + id, {cwd: 'D:\\wV-' + id})
        + rec('v-' + id + '-ok', '2026-08-02T00:00:01Z', [{type: 'tool_use', id: 'tu-ok-' + id, name: 'Read', input: {file_path: 'ok.js'}}])
        + badRec
        + rec('v-' + id + '-after', '2026-08-02T00:00:03Z', [{type: 'text', text: '后-' + id}])
        + rec('v-' + id + '-end', '2026-08-02T00:00:04Z', [{type: 'text', text: '尾-' + id + '-终态'}])
        + U('v-' + id + '-tail', '2026-08-02T00:00:06Z', '末-' + id)
        + '{"type":"assistant","uuid":"v-' + id + '-endturn","timestamp":"2026-08-02T00:00:05Z","message":{"content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}}\n';
      await writeFile(f, body);
    }
    /* 额外：记录身份字段（uuid/message.id）与 tool_result.tool_use_id、cwd 也可能是非法对象，
       同样不能靠 String() 抛穿；诊断后该条降级，消息与后续终态保留。 */
    const fExtra = join(pj, 'extra.jsonl');
    await writeFile(fExtra,
      '{"type":"user","cwd":{"toString":null},"uuid":{"toString":null},"timestamp":"2026-08-02T01:00:00Z",'
      + '"message":{"id":{"toString":null},"content":"前-extra"}}\n'
      + rec('extra-ok', '2026-08-02T01:00:01Z', [{type: 'tool_use', id: 'tu-extra', name: 'Read', input: {file_path: 'extra.js'}}])
      + '{"type":"user","uuid":"extra-u2","timestamp":"2026-08-02T01:00:02Z","message":{"content":['
      + '{"type":"tool_result","tool_use_id":{"toString":null},"is_error":true,"content":{"toString":null}}]}}\n'
      + rec('extra-after', '2026-08-02T01:00:03Z', [{type: 'text', text: '后-extra'}])
      + '{"type":"assistant","uuid":"extra-end","timestamp":"2026-08-02T01:00:04Z","message":{"content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}}\n');
    const srcX = claude.create({root: d, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
    let xErr = null;
    try { await srcX.scan(false); } catch (err) { xErr = err; }
    const stX = srcX.stats();
    const sExtra = srcX.sessions().find(x => x.id === 'extra');
    checks.push(['v2.43 #3 身份/结果字段非法对象：scan 不抛错、诊断降级、消息与终态保留',
      xErr === null && !!sExtra && stX.stale === true
        && Number(sExtra.parseIssues && sExtra.parseIssues.fieldFaults) >= 2
        && (sExtra.parseIssues.diagnostics || []).some(d => d.stage === 'tool_result.id')
        && (sExtra.parseIssues.diagnostics || []).some(d => d.stage === 'record.uuid')
        && sExtra.msgs.some(m => m.text.includes('前-extra'))
        && sExtra.msgs.some(m => m.text.includes('后-extra'))
        && sExtra.current === null && sExtra.turnOpen === false,
      JSON.stringify({err: xErr && xErr.message, stats: stX,
        issues: sExtra && sExtra.parseIssues, msgs: sExtra && sExtra.msgs.map(m => m.text)})]);
    await rm(fExtra, {force: true});

    const srcV = claude.create({root: d, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
    let vErr = null;
    try { await srcV.scan(true); } catch (err) { vErr = err; }
    const stV = srcV.stats();
    const variantResults = variants.map(([id, , degraded]) => {
      const s = srcV.sessions().find(x => x.id === 'v-' + id);
      return {id, degraded, s};
    });
    await rm(d, {recursive: true, force: true});
    checks.push(['v2.43 #3 形状矩阵：整批 scan 不抛错', vErr === null, String(vErr && vErr.message)]);
    checks.push(['v2.43 #3 形状矩阵：所有会话都被保留（单条降级不丢会话）',
      stV.sessions === variants.length + 1, JSON.stringify(stV)]);
    for (const r of variantResults) {
      const s = r.s;
      const baseOk = !!s && s.current === null && s.openStep === null && s.turnOpen === false
        && s.msgs.some(m => m.text.includes('后-' + r.id))
        && s.msgs.some(m => m.text.includes('尾-' + r.id + '-终态'))
        && s.msgs.some(m => m.text.includes('末-' + r.id));
      const diagOk = !r.degraded || (!!s && !!s.parseIssues && Number(s.parseIssues.fieldFaults) >= 1
        && Array.isArray(s.parseIssues.diagnostics) && s.parseIssues.diagnostics.length >= 1);
      checks.push([`v2.43 #3 形状矩阵 ${r.id}：非法字段降级诊断、前后消息与终态保留`,
        baseOk && diagOk,
        JSON.stringify(s && {fieldFaults: s.parseIssues && s.parseIssues.fieldFaults,
          diagnostics: s.parseIssues && s.parseIssues.diagnostics,
          current: s.current, turnOpen: s.turnOpen, msgs: s.msgs.map(m => m.text)})]);
    }

    // ③ 其他会话不受影响 + 下次恢复：故障文件修好后 stale 清除、不保留坏记录
    const d2 = await mkdtemp(join(tmpdir(), 'claude-v243-recover-'));
    const pj2 = join(d2, 'proj');
    await mkdir(pj2, {recursive: true});
    const d2bad = join(pj2, 'bad.jsonl'), d2good = join(pj2, 'good.jsonl');
    const badCore = U('rc-u0', '2026-08-03T00:00:00Z', '开始-恢复', {cwd: 'D:\\wRec'})
      + busy('tu-rc', '2026-08-03T00:00:01Z', 'Bash');
    await writeFile(d2bad, badCore);
    await writeFile(d2good, U('gd-u0', '2026-08-03T00:00:00Z', '开始-好会话', {cwd: 'D:\\wGood'})
      + busy('tu-gd', '2026-08-03T00:00:01Z', 'Bash'));
    let reads = 0;
    const io = {
      readdir: (p, o) => realReaddir(p, o),
      stat: (p, o) => realStat(p, o),
      readFile: (p, o) => { if (String(p) === d2bad) reads++; return realReadFile(p, o); },
    };
    const srcR = claude.create({root: d2, activeMs: 999999999, live: {push() {}}, io, listIntervalMs: 0});
    await srcR.scan(true);
    const badLine = '{"type":"assistant","uuid":"rc-bad","timestamp":"2026-08-03T00:00:02Z","message":{"content":[{"type":"tool_use","id":{"valueOf":null,"toString":null},"name":"Edit","input":{}}]}}\n';
    const badFull = badCore + badLine
      + U('rc-u1', '2026-08-03T00:00:03Z', '恢复前的合法消息')
      + '{"type":"assistant","uuid":"rc-end","timestamp":"2026-08-03T00:00:04Z","message":{"content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}}\n';
    await writeFile(d2bad, badFull);
    try { await srcR.scan(false); } catch { /* 旧实现会抛穿；修复后必须不抛 */ }
    const stDeg = srcR.stats();
    const readsAfterDeg = reads;
    try { await srcR.scan(false); } catch { /* 已知故障必须继续重读 */ }
    const stRetry = srcR.stats();
    const readsAfterRetry = reads;
    const cleanFull = badCore + U('rc-u1', '2026-08-03T00:00:03Z', '恢复后的合法消息')
      + '{"type":"assistant","uuid":"rc-end2","timestamp":"2026-08-03T00:00:04Z","message":{"content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}}\n';
    await writeFile(d2bad, cleanFull);
    await srcR.scan(false);
    const stRec = srcR.stats();
    const sBadRec = srcR.sessions().find(x => x.id === 'bad');
    const sGood = srcR.sessions().find(x => x.id === 'good');
    await rm(d2, {recursive: true, force: true});
    checks.push(['v2.43 #3 故障记录隔离：其他会话仍正常运行、坏会话降级但提交可用终态',
      stDeg.sessions === 2 && stDeg.stale === true
        && !!sGood && !!sGood.current && sGood.id === 'good',
      JSON.stringify({stats: stDeg, good: sGood && sGood.id})]);
    checks.push(['v2.43 #3 已知故障登记重试：无变更的下一轮仍会重读',
      readsAfterRetry > readsAfterDeg && stRetry.stale === true,
      JSON.stringify({before: readsAfterDeg, after: readsAfterRetry, stats: stRetry})]);
    checks.push(['v2.43 #3 修复后恢复：stale 归假、坏记录消失、终态与合法消息保留',
      stRec.stale === false && stRec.sessions === 2
        && !!sBadRec && sBadRec.msgs.some(m => m.text.includes('恢复后的合法消息'))
        && !sBadRec.msgs.some(m => m.text.includes('恢复前的合法消息'))
        && !sBadRec.calls.some(c => c.name === 'Edit')
        && sBadRec.current === null && sBadRec.turnOpen === false,
      JSON.stringify({stats: stRec, msgs: sBadRec && sBadRec.msgs.map(m => m.text),
        calls: sBadRec && sBadRec.calls.map(c => c.name)})]);
  }

  /* #9 工具名索引：发布本轮事件/未完成关联之前不能裁剪掉迟到结果需要的工具名；
     799/800/801/更长历史都要 lastFail 与 feed 事件名一致。 */
  {
    const mkCapSession = async (n, extraUnfinished = 0) => {
      const d = await mkdtemp(join(tmpdir(), 'claude-v243-namecap-'));
      const pj = join(d, 'proj');
      await mkdir(pj, {recursive: true});
      const f = join(pj, 'cap.jsonl');
      const T0 = Date.parse('2026-09-01T00:00:00Z');
      const at = i => new Date(T0 + i * 1000).toISOString();
      const lines = [
        line({type: 'user', uuid: 'cap-u', timestamp: at(0), cwd: 'D:\\wCap', message: {content: '开始-索引裁剪'}}),
        line({type: 'assistant', uuid: 'cap-un0', timestamp: at(1),
          message: {content: [{type: 'tool_use', id: 'c0', name: 'Read', input: {file_path: 'target.txt'}}]}}),
      ];
      for (let k = 1; k <= extraUnfinished; k++) {
        lines.push(line({type: 'assistant', uuid: 'cap-un' + k, timestamp: at(1 + k),
          message: {content: [{type: 'tool_use', id: 'c' + k, name: 'Edit', input: {file_path: 'early-' + k + '.txt'}}]}}));
      }
      let idx = 2 + extraUnfinished;
      for (let i = 1; i <= n; i++) {
        lines.push(line({type: 'assistant', uuid: 'cap-a' + i, timestamp: at(idx++),
          message: {content: [{type: 'tool_use', id: 'b' + i, name: 'Bash', input: {command: 'echo ' + i}}]}}));
        lines.push(line({type: 'user', uuid: 'cap-r' + i, timestamp: at(idx++),
          message: {content: [{type: 'tool_result', tool_use_id: 'b' + i, content: 'ok'}]}}));
      }
      await writeFile(f, lines.join(''));
      return {d, f, lines};
    };
    const capFail = (id, at, text, uuid) => line({type: 'user', uuid, timestamp: at,
      message: {content: [{type: 'tool_result', tool_use_id: id, is_error: true, content: text}]}});
    for (const n of [799, 800, 801, 1200]) {
      const s = await mkCapSession(n);
      const pushed = [];
      const src = claude.create({root: s.d, activeMs: 999999999, live: {push(it) { pushed.push(it); }}, listIntervalMs: 0});
      await src.scan(true);
      const from = pushed.length;
      const failAt = new Date(Date.parse('2026-09-01T00:00:00Z') + (n * 2 + 5) * 1000).toISOString();
      await writeFile(s.f, s.lines.join('')
        + capFail('c0', failAt, 'EACCES: permission denied, open target.txt', 'cap-f0'));
      await src.scan(false);
      const ev = pushed.slice(from);
      const sess = src.sessions().find(x => x.id === 'cap');
      await rm(s.d, {recursive: true, force: true});
      checks.push([`v2.43 #9 ${n} 个已完成调用后迟到失败：事件仍带未完成 Read，且与 lastFail 一致`,
        ev.length === 1 && /Read/.test(String(ev[0].name)) && /EACCES/.test(String(ev[0].name))
          && !!sess && !!sess.lastFail && sess.lastFail.name === 'Read',
        JSON.stringify({events: ev.map(x => x.name), lastFail: sess && sess.lastFail})]);
    }
    {
      // 最旧的两个未完成调用 + 多条迟到失败（含最新已完成调用）：每条事件的工具名都要对
      const s = await mkCapSession(801, 2);
      const pushed = [];
      const src = claude.create({root: s.d, activeMs: 999999999, live: {push(it) { pushed.push(it); }}, listIntervalMs: 0});
      await src.scan(true);
      const from = pushed.length;
      const failAt = i => new Date(Date.parse('2026-09-01T00:00:00Z') + (1800 + i) * 1000).toISOString();
      await writeFile(s.f, s.lines.join('')
        + capFail('c0', failAt(1), 'EACCES: target', 'cap-m0')
        + capFail('c1', failAt(2), 'ENOENT: early-1', 'cap-m1')
        + capFail('b1', failAt(3), 'EIO: echo 1', 'cap-m2'));
      await src.scan(false);
      const ev = pushed.slice(from);
      const sess = src.sessions().find(x => x.id === 'cap');
      await rm(s.d, {recursive: true, force: true});
      checks.push(['v2.43 #9 多迟到失败：最旧两个未完成调用都保留工具名（Read/Edit），已完成调用也对',
        ev.length === 3
          && ev.some(x => /Read/.test(x.name) && /EACCES/.test(x.name))
          && ev.some(x => /Edit/.test(x.name) && /ENOENT/.test(x.name))
          && ev.some(x => /Bash/.test(x.name) && /EIO/.test(x.name)),
        JSON.stringify({events: ev.map(x => x.name), lastFail: sess && sess.lastFail})]);
    }
  }

  {
    /* v2.43 #10：Claude 侧 calls 超 400 时保护未完成/当前调用，不能只保留尾部历史。 */
    const d = await mkdtemp(join(tmpdir(), 'claude-trim-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    const f = join(pj, 'trim.jsonl');
    const parts = [line({type: 'user', uuid: 't0', timestamp: '2026-06-01T00:00:00Z', cwd: 'D:\\wTrim', message: {content: '开始'}})];
    parts.push(line({type: 'assistant', uuid: 'tc0', timestamp: '2026-06-01T00:00:01Z',
      message: {content: [{type: 'tool_use', id: 'c0', name: 'Bash', input: {command: 'sleep'}}]}}));
    for (let i = 1; i <= 405; i++) {
      const ts = new Date(Date.parse('2026-06-01T00:00:02Z') + i * 1000).toISOString();
      parts.push(line({type: 'assistant', uuid: 'tc' + i, timestamp: ts,
        message: {content: [{type: 'tool_use', id: 'c' + i, name: 'Read', input: {file_path: 'x'}}]}}));
      parts.push(line({type: 'user', uuid: 'tr' + i, timestamp: ts,
        message: {content: [{type: 'tool_result', tool_use_id: 'c' + i, content: 'ok'}]}}));
    }
    await writeFile(f, parts.join(''));
    const src = claude.create({root: d, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
    await src.scan(true);
    const s = src.sessions()[0];
    checks.push(['v2.43 #10 Claude：历史裁剪保护未完成当前调用',
      !!s && !!s.current && s.current.callId === 'c0' && s.calls.some(c => c.callId === 'c0') && s.calls.length <= 400,
      JSON.stringify(s && {cur: s.current && s.current.callId, n: s.calls.length})]);
    await rm(d, {recursive: true, force: true});
  }

  {
    /* 用户实测：真实 Claude Code 的 /exit 记录没有 isMeta（2.1.x），旧实现因此不结束会话，
       21 小时前的会话仍被显示成「推理中 step 1」并持续流入。这里锁定真实记录形状。 */
    const d = await mkdtemp(join(tmpdir(), 'claude-exit-real-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    const f = join(pj, 'realexit.jsonl');
    await writeFile(f, [
      line({type: 'user', uuid: 're-u1', isMeta: true, timestamp: '2026-08-01T00:00:00Z', cwd: 'D:\\wRealExit',
        message: {content: '<local-command-caveat>The command below was run directly in Claude Code</local-command-caveat>'}}),
      line({type: 'assistant', uuid: 're-a1', timestamp: '2026-08-01T00:00:01Z',
        message: {content: [{type: 'tool_use', id: 're-c1', name: 'Bash', input: {command: 'ls'}}]}}),
      // 关键：真实 /exit 记录没有 isMeta，只有严格的命令记录形状
      line({type: 'user', uuid: 're-u2', timestamp: '2026-08-01T00:00:02Z',
        message: {content: '<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>'}}),
      line({type: 'user', uuid: 're-u3', timestamp: '2026-08-01T00:00:03Z',
        message: {content: '<local-command-stdout>Goodbye!</local-command-stdout>'}}),
      line({type: 'cost-state', uuid: 're-cs', timestamp: '2026-08-01T00:00:04Z'}),
    ].join(''));
    const src = claude.create({root: d, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
    await src.scan(true);
    const s = src.sessions().find(x => x.id === 'realexit');
    checks.push(['v3.0.2 真实无 isMeta 的 /exit：识别为退出并清空运行态',
      !!s && s.ended === true && s.turnOpen === false && s.openStep === null
        && s.exitedAt === Date.parse('2026-08-01T00:00:02Z') && src.stats().running === 0,
      JSON.stringify(s && {ended: s.ended, turnOpen: s.turnOpen, openStep: s.openStep, exitedAt: s.exitedAt, running: src.stats().running})]);
    checks.push(['v3.0.2 控制记录不进标题与消息',
      !!s && !/<local-command|<command-name/.test(String(s.title || ''))
        && !s.msgs.some(m => /<local-command|<command-name/.test(String(m.text || ''))),
      JSON.stringify(s && {title: s.title, msgs: s.msgs.map(m => m.text)})]);
    await rm(d, {recursive: true, force: true});
  }

  {
    /* 用户实测：Claude 目录里最新的几个文件可能只是 /exit 控制记录，真正有内容的会话更旧。
       预热只取 3 个会让面板全空；这里要求预热最近 8 个，覆盖到有内容的会话。 */
    const d = await mkdtemp(join(tmpdir(), 'claude-warmup-'));
    const pj = join(d, 'proj');
    await mkdir(pj, {recursive: true});
    for (let i = 1; i <= 3; i++) {
      await writeFile(join(pj, `real-${i}.jsonl`), [
        line({type: 'user', uuid: `rw-u${i}`, timestamp: `2026-09-0${i}T00:00:00Z`, cwd: 'D:\\wWarm',
          message: {content: `写点内容 ${i}`}}),
        line({type: 'assistant', uuid: `rw-a${i}`, timestamp: `2026-09-0${i}T00:00:01Z`,
          message: {content: [{type: 'text', text: `真实回复 ${i}`}], stop_reason: 'end_turn'}}),
      ].join(''));
    }
    for (let i = 1; i <= 3; i++) {
      await writeFile(join(pj, `exit-${i}.jsonl`), [
        line({type: 'user', uuid: `ex-u${i}`, timestamp: `2026-09-1${i}T00:00:00Z`,
          message: {content: '<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>'}}),
      ].join(''));
    }
    const src = claude.create({root: d, activeMs: 45 * 60 * 1000, live: {push() {}}, listIntervalMs: 0});
    await src.scan(true);
    const all = src.sessions();
    checks.push(['v3.0.3 预热覆盖更旧的有内容会话（最新几个只是 /exit 也不让面板全空）',
      all.length === 6 && all.some(x => x.turns > 0 && x.msgs.some(m => /真实回复/.test(m.text))),
      JSON.stringify(all.map(x => ({id: x.id, turns: x.turns, ended: x.ended})))]);
    await rm(d, {recursive: true, force: true});
  }

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

  /* 工作区编号必须由工作区身份决定，不能随活跃顺序变 —— 否则 W01/W02 会互换 */
  const mkW = (id, cwd) => ({
    src: 'test', id, cwd, title: id, depth: 0, parent: '', mtime: now2 - 1000,
    turns: 1, calls: [{callId: 'x1', name: 'Read', label: 'r', start: now2 - 2000, end: now2 - 1500, done: true, error: false}],
    todos: [], snippets: [], gaps: [], current: null, done: 1, failed: 0, lastTime: now2 - 1000, lastFail: null,
  });
  const order1 = core.buildState({sessions: [mkW('a', 'C:\\proj\\zzz'), mkW('b', 'C:\\proj\\aaa')],
    live: null, codes: core.createCodes(), activeMs: 60000, maxAgents: 12, maxTasks: 240, servedFrom: 't', source: 't'});
  const order2 = core.buildState({sessions: [mkW('b', 'C:\\proj\\aaa'), mkW('a', 'C:\\proj\\zzz')],
    live: null, codes: core.createCodes(), activeMs: 60000, maxAgents: 12, maxTasks: 240, servedFrom: 't', source: 't'});
  const mapOf = st => JSON.stringify(Object.fromEntries(st.workflows.map(w => [w.name, w.id]).sort()));
  /* Linux 是大小写敏感的：/home/dev/Project 与 /home/dev/project 必须算两个工作区 */
  const stCase = core.buildState({sessions: [
    mkW('p1', '/home/dev/Project'), mkW('p2', '/home/dev/project'),
  ], live: null, codes: core.createCodes(), activeMs: 60000, maxAgents: 12, maxTasks: 240, servedFrom: 't', source: 't'});
  checks.push(['大小写不同的 Linux 路径不会被合并成一个工作区', stCase.workflows.length === 2,
    `工作区=${stCase.workflows.map(w => w.name).join(',')}`]);

  /* UNC 是 Windows 语义：\\srv\Share\X 与 \\SRV\share\x 是同一个工作区 */
  const stUnc = core.buildState({sessions: [
    mkW('u1', '\\\\srv\\Share\\X'), mkW('u2', '\\\\SRV\\share\\x'),
  ], live: null, codes: core.createCodes(), activeMs: 60000, maxAgents: 12, maxTasks: 240, servedFrom: 't', source: 't'});
  checks.push(['UNC 路径大小写不同仍是同一个工作区', stUnc.workflows.length === 1,
    `工作区=${stUnc.workflows.map(w => w.name).join(',')}`]);

  /* 显示上限只该限制「上墙的智能体」，工作区统计必须覆盖所有活跃会话 */
  const many = Array.from({length: 13}, (_, i) => mkW('m' + i, 'C:\\ws\\w' + i));
  many[12].failed = 4;   // 第 13 个会被 maxAgents 挡住，但它的失败仍要计入工作区状态
  const stCap = core.buildState({sessions: many, live: null, codes: core.createCodes(),
    activeMs: 60000, maxAgents: 12, maxTasks: 240, servedFrom: 't', source: 't'});
  const allFails = stCap.workflows.reduce((n, w) => n + (w.fails || 0), 0);
  /* 上限只限制上墙的智能体；工作区要按全部活跃会话建，否则第 13 个工作区直接消失 */
  const stWf = core.buildState({sessions: Array.from({length: 13}, (_, i) => mkW('w' + i, 'C:\\\\ws2\\\\d' + i)),
    live: null, codes: core.createCodes(), activeMs: 60000, maxAgents: 12, maxTasks: 240, servedFrom: 't', source: 't'});
  checks.push(['工作区按全部活跃会话建立（上限只限制智能体）',
    stWf.workflows.length === 13 && stWf.agents.length === 12,
    '工作区=' + stWf.workflows.length + ' 智能体=' + stWf.agents.length]);

  checks.push(['显示上限不截断工作区统计（被隐藏会话的失败也算）',
    stCap.agents.length === 12 && allFails >= 4, `智能体=${stCap.agents.length} 失败合计=${allFails}`]);

  /* 事件要带来源：合并视图靠它归属编号，不靠"遍历所有源找同 id" */
  const liveT = core.createLive();
  liveT.push({verb: 'read', name: 'x', kind: 'tool', src: 'claude'}, 'sid1', 'n');
  const evT = liveT.since(0)[0];
  checks.push(['事件里保留来源 src', !!evT && evT.src === 'claude', JSON.stringify(evT)]);

  /* 旧版 Node 兼容：zlib 必须是动态导入，静态 import 缺导出会在加载阶段抛 SyntaxError */
  const selfSrc = await readFile(new URL('./smoke-test.mjs', import.meta.url), 'utf8');
  checks.push(['zlib 用动态导入（静态导入会让旧 Node 连测试都起不来）',
    !/^import\s*\{[^}]*zstdCompressSync/m.test(selfSrc),
    '检测到静态 import { zstdCompressSync }']);

  /* 悬浮提示要能显示完整目录名：name 截断，full 不截断 */
  const stLong = core.buildState({sessions: [mkW('L1', 'C:\\\\proj\\\\agent-display-v2-work')],
    live: null, codes: core.createCodes(), activeMs: 60000, maxAgents: 12, maxTasks: 240, servedFrom: 't', source: 't'});
  checks.push(['工作区保留未截断的完整名（供悬浮提示）',
    stLong.workflows.length === 1 && stLong.workflows[0].full === 'agent-display-v2-work'
      && stLong.workflows[0].name !== stLong.workflows[0].full,
    JSON.stringify(stLong.workflows[0])]);

  checks.push(['工作区编号与活跃顺序无关（不会 W01/W02 互换）',
    mapOf(order1) === mapOf(order2) && new Set(order1.workflows.map(w => w.id)).size === order1.workflows.length,
    `${mapOf(order1)} vs ${mapOf(order2)}`]);

  /* 用户实测修正：Claude Code 退出/空闲时，右侧节点与父子连线要保留（静态线），
     只停止「流入效果」；不能因为 ended 就把整条线删掉。 */
  {
    const mkE = (id, ended, parent = '') => ({
      src: 'claude', id, cwd: 'C:\\wcE', title: id, depth: 0, parent,
      mtime: now, turns: 1, openStep: 1,
      calls: [{callId: 'x' + id, name: 'Read', label: 'read x', start: now - 1000, end: 0, done: false, error: false, argBytes: 1}],
      todos: [], snippets: [], gaps: [], current: null, done: 0, failed: 0, ended,
    });
    const stE = core.buildState({
      sessions: [mkE('gone', true), mkE('child', true, 'gone'), mkE('live1', false)],
      live: null, codes: core.createCodes(), activeMs: 60000, maxAgents: 12, maxTasks: 240, servedFrom: 't', source: 'claude',
    });
    const byTitle = t => stE.agents.find(a => a.title === t);
    checks.push(['已退出会话仍保留节点与父子连线（右侧线不删）',
      stE.agents.length === 3 && !!byTitle('gone') && !!byTitle('child')
        && stE.links.some(l => l.from === byTitle('gone').code && l.to === byTitle('child').code),
      JSON.stringify({agents: stE.agents.map(a => a.title), links: stE.links})]);
    checks.push(['已退出会话保持空闲：不算忙碌、不产生运行任务',
      !!byTitle('gone') && byTitle('gone').running === false
        && byTitle('child').running === false
        && !stE.tasks.some(t => t.state === 'run' && t.agent === byTitle('gone').code)
        && !stE.tasks.some(t => t.state === 'run' && t.agent === byTitle('child').code)
        && stE.workflows.reduce((n, w) => n + (w.busy || 0), 0) === 1,
      JSON.stringify({busy: stE.workflows.map(w => w.busy), tasks: stE.tasks.filter(t => t.state === 'run')})]);
    const stE2 = core.buildState({
      sessions: [mkE('gone2', true)], live: null, codes: core.createCodes(),
      activeMs: 60000, maxAgents: 12, maxTasks: 240, servedFrom: 't', source: 'claude',
    });
    checks.push(['全部会话已退出时仍显示最近空闲节点，但没有运行任务',
      stE2.agents.length === 1 && stE2.agents[0].running === false
        && !stE2.tasks.some(t => t.state === 'run'),
      JSON.stringify({agents: stE2.agents.map(a => a.title), running: stE2.agents.map(a => a.running)})]);
    /* 用户实测：21 小时前退出的 Claude 会话仍要显示空闲节点（有线段、无流入），
       不能因为超出 45 分钟活跃窗口就消失（那就等于又把线删了）。
       同时放一个活跃会话：确认不是靠「一个会话都没有」的兜底才显示。 */
    const oldEnded = Object.assign(mkE('oldEnded', true), {mtime: now - 21 * 3600 * 1000});
    const activeOne = Object.assign(mkE('activeOne', false), {mtime: now});
    const stOld = core.buildState({
      sessions: [oldEnded, activeOne], live: null, codes: core.createCodes(),
      activeMs: 45 * 60 * 1000, maxAgents: 12, maxTasks: 240, servedFrom: 't', source: 'claude',
    });
    const oldAgent = stOld.agents.find(a => a.title === 'oldEnded');
    const bareEnded = {src: 'claude', id: 'bareEnded', cwd: 'C:\\wBare', title: 'bare', depth: 0, parent: '',
      mtime: now - 21 * 3600 * 1000, turns: 0, calls: [], todos: [], snippets: [], gaps: [],
      current: null, openStep: null, done: 0, failed: 0, ended: true};
    const stBare = core.buildState({
      sessions: [bareEnded, activeOne], live: null, codes: core.createCodes(),
      activeMs: 45 * 60 * 1000, maxAgents: 12, maxTasks: 240, servedFrom: 't', source: 'claude',
    });
    checks.push(['只有控制记录的已退出会话也保留空闲节点（无内容也不算「无会话」）',
      stBare.agents.length === 2 && stBare.agents.some(a => a.title === 'bare' && a.running === false),
      JSON.stringify({agents: stBare.agents.map(a => ({t: a.title, r: a.running}))})]);
    /* 用户实测：墙上只有空节点时，用最近的有内容历史会话补位，TASK FEED / 粒子 / 代码面板
       不能全空；补位会话按空闲处理（无 run 任务、无流入）。 */
    const oldReal = {
      src: 'claude', id: 'oldReal', cwd: 'C:\\wOldReal', title: 'oldReal', depth: 0, parent: '',
      mtime: now - 20 * 3600 * 1000, turns: 2,
      calls: [{callId: 'or1', name: 'Write', label: 'write a.js', start: now - 20 * 3600 * 1000, end: now - 20 * 3600 * 1000 + 1000, done: true, error: false, argBytes: 5}],
      todos: [], msgs: [{role: 'user', text: '写个文件'}, {role: 'assistant', text: '好'}],
      snippets: [{file: 'a.js', code: 'const x = 1;', at: now - 20 * 3600 * 1000 + 1000}],
      gaps: [], current: null, openStep: null, done: 1, failed: 0, ended: false,
    };
    const stFill = core.buildState({
      sessions: [stBare.sessions ? null : null, bareEnded, oldReal].filter(Boolean), live: null,
      codes: core.createCodes(), activeMs: 45 * 60 * 1000, maxAgents: 12, maxTasks: 240,
      servedFrom: 't', source: 'claude',
    });
    const fillAgent = stFill.agents.find(a => a.title === 'oldReal');
    checks.push(['墙上只有空节点时用历史会话补位（面板有内容、但不产生运行任务）',
      !!fillAgent && fillAgent.running === false
        && stFill.snippets.some(sn => /a\.js/.test(sn.file))
        && !stFill.tasks.some(t => t.state === 'run' && t.agent === fillAgent.code),
      JSON.stringify({agents: stFill.agents.map(a => ({t: a.title, r: a.running})), snippets: stFill.snippets.length,
        run: stFill.tasks.filter(t => t.state === 'run').length})]);
    checks.push(['超出活跃窗口的已退出会话仍显示空闲节点（有活跃会话时也不消失）',
      stOld.agents.length === 2 && !!oldAgent && oldAgent.running === false
        && !stOld.tasks.some(t => t.state === 'run' && t.agent === oldAgent.code)
        && stOld.workflows.reduce((n, w) => n + (w.busy || 0), 0) === 1,
      JSON.stringify({agents: stOld.agents.map(a => ({t: a.title, r: a.running})), busy: stOld.workflows.map(w => w.busy)})]);
  }

  /* ================= 复核 v2.38 #7 / #12 / E2 / E3（后端契约） ================= */

  /* #7 工作区 key：前端用 workflows[].key 映射事件里的 workspace，必须和 core 的规范化一致 */
  const coreNorm = core.normDir;
  const stKey = core.buildState({sessions: [
    mkW('k1', 'C:\\Proj\\Alpha\\'),
    mkW('k2', 'c:/proj/alpha'),
    mkW('k3', '/home/dev/Project/'),
  ], live: null, codes: core.createCodes(), activeMs: 60000, maxAgents: 12, maxTasks: 240, servedFrom: 't', source: 't'});
  const wfKeys = stKey.workflows.map(w => w.key);
  checks.push(['#7 workflows 带 key，且是 normDir 规范化后的工作区 key',
    typeof coreNorm === 'function'
      && wfKeys.every(k => typeof k === 'string' && k === coreNorm(k))
      && wfKeys.includes('c:/proj/alpha') && wfKeys.includes('/home/dev/Project'),
    `keys = ${JSON.stringify(wfKeys)}`]);
  checks.push(['#7 同一工作区的不同大小写/分隔符/末尾斜杠只会得到一个 key',
    stKey.workflows.length === 2 && new Set(wfKeys).size === 2,
    `工作区=${JSON.stringify(stKey.workflows.map(w => [w.id, w.key]))}`]);

  /* #12 编号容量：接受范围内的编号必须唯一；旧实现超过 99 会重复返回 "99" */
  const uniqueCodes = core.createCodes();
  const allocated = Array.from({length: 120}, (_, i) => uniqueCodes.for('key-' + i));
  checks.push(['#12 编号器在容量内绝不重复（120 个 key 全唯一且非空）',
    allocated.every(Boolean) && new Set(allocated).size === 120,
    `唯一=${new Set(allocated).size} 示例=${JSON.stringify(allocated.slice(0, 3))}…${JSON.stringify(allocated.slice(-2))}`]);

  const many99 = Array.from({length: 120}, (_, i) => mkW('u99-' + i, 'C:\\ws99\\d' + i));
  const st99 = core.buildState({sessions: many99, live: null, codes: core.createCodes(),
    activeMs: 60000, maxAgents: 99, maxTasks: 240, servedFrom: 't', source: 't'});
  checks.push(['#12 MAX_AGENTS=99 时 99 个上墙编号唯一',
    st99.agents.length === 99 && new Set(st99.agents.map(a => a.code)).size === 99,
    `智能体=${st99.agents.length} 唯一=${new Set(st99.agents.map(a => a.code)).size}`]);

  /* E2 start.cmd / stop.cmd 的端口与令牌约定（用真实脚本做静态契约检查） */
  const startCmdSrc = await readFile(join(ROOT, 'start.cmd'), 'utf8');
  const stopCmdSrc = await readFile(join(ROOT, 'stop.cmd'), 'utf8');
  checks.push(['E2 start.cmd 只在 PORT 未设置时才用默认 8778',
    /if\s+not\s+defined\s+PORT\s+set\s+"PORT=8778"/i.test(startCmdSrc)
      && !/^\s*set\s+"PORT=8778"\s*$/im.test(startCmdSrc),
    `端口行=${(startCmdSrc.match(/^\s*set\s+"PORT=.*$/im) || [''])[0]}`]);
  checks.push(['E2 start.cmd 的地址统一用 %PORT%，设置 TOKEN 时带令牌',
    /set\s+"URL=http:\/\/127\.0\.0\.1:%PORT%/i.test(startCmdSrc)
      && /if\s+defined\s+TOKEN/i.test(startCmdSrc)
      && /token=%TOKEN_ENC%/i.test(startCmdSrc),
    (startCmdSrc.match(/^\s*set\s+"URL=.*$/im) || [''])[0]]);
  checks.push(['E2 stop.cmd 使用同一个 PORT 并带 TOKEN 查询',
    /if\s+not\s+defined\s+PORT\s+set\s+"PORT=8778"/i.test(stopCmdSrc)
      && /http:\/\/127\.0\.0\.1:%PORT%/i.test(stopCmdSrc)
      && /EscapeDataString\(\$env:TOKEN\)/.test(stopCmdSrc),
    `端口行=${(stopCmdSrc.match(/^\s*set\s+"PORT=.*$/im) || [''])[0]}`]);

  /* E3 端口动态化：测试脚本里不能再写死内部端口；全量入口要传独立端口段 */
  const runnerSrc = await readFile(join(ROOT, 'run-all-tests.mjs'), 'utf8');
  checks.push(['E3 内部测试实例不再写死固定端口',
    !/\b879[01]\b/.test(selfSrc) && /function freePortNear/.test(selfSrc),
    `fixed=${/\b879[01]\b/.test(selfSrc)}`]);
  checks.push(['E3 全量入口给每个模式传独立 TEST_PORT_BASE 端口段',
    /TEST_PORT_BASE/.test(runnerSrc) && /freePort\(\)/.test(runnerSrc),
    'run-all-tests.mjs 没有传 TEST_PORT_BASE']);

  /* E1 / #12 文档同步：README 至少要写清通配来源、编号范围与脚本端口约定 */
  const readmeSrc = await readFile(join(ROOT, 'README.md'), 'utf8');
  checks.push(['E1 README 写明 ALLOW_ORIGIN=* 的通配行为与无凭证',
    /ALLOW_ORIGIN[\s\S]{0,240}\*/.test(readmeSrc) && /凭证/.test(readmeSrc),
    'README 没有说明通配 CORS']);
  checks.push(['#12 README 写明 MAX_AGENTS 范围是 1–99、非法值会退出',
    /MAX_AGENTS[\s\S]{0,120}1[–-]99/.test(readmeSrc) && /退出/.test(readmeSrc),
    'README 没有说明编号容量与非法配置']);
  checks.push(['E2 README 写明 start.cmd/stop.cmd 读取 PORT 与 TOKEN',
    /start\.cmd[\s\S]{0,400}PORT/.test(readmeSrc) && /stop\.cmd[\s\S]{0,200}PORT/.test(readmeSrc),
    'README 没有说明脚本端口约定']);

  /* ================= 复核 v2.43 #10：活动任务不能被历史预算挤掉 ================= */
  const nowC = Date.now();
  const mkCall = (id, o = {}) => ({callId: id, name: 'Read', label: 'read ' + id,
    start: nowC - 9000, end: 0, done: false, error: false, argBytes: 10, ...o});
  const mkSess = (id, calls, current = null, extra = {}) => ({
    src: 'test', id, cwd: 'C:\\ws\\' + id, title: id, depth: 0, parent: '', mtime: nowC,
    turns: 1, calls, todos: [], snippets: [], gaps: [], current, done: 0, failed: 0, ...extra,
  });
  const build = (sessions, opts = {}) => core.buildState({
    sessions, live: null, codes: core.createCodes(), activeMs: 60000,
    maxAgents: 12, maxTasks: 60, servedFrom: 't', source: 'test', ...opts});

  // 原始复现：31 个调用，最旧 c0 仍未完成且就是 s.current，其后 30 个都已完成
  const c31 = [mkCall('c0', {start: nowC - 90000})];
  for (let i = 1; i <= 30; i++) c31.push(mkCall('c' + i, {start: nowC - 5000 + i, end: nowC - 4000 + i, done: true}));
  const st31 = build([mkSess('repro31', c31, c31[0])]);
  const curId31 = core.tid('test:repro31:call:c0');
  const cur31 = st31.tasks.filter(t => t.id === curId31);
  const curAll31 = st31.tasks.filter(t => t.cur);
  checks.push(['#10 最旧调用仍是 s.current 时不会被历史尾部裁剪排除',
    st31.tasks.length <= 60 && cur31.length === 1 && cur31[0].cur === true && cur31[0].state === 'run'
      && curAll31.length === 1 && curAll31[0].agent === (st31.agents[0] && st31.agents[0].code)
      && st31.workflows[0].busy === 1
      && st31.tasks.every(t => t.state === 'run' || t.state === 'done'),
    `tasks=${st31.tasks.length} cur=${JSON.stringify(curAll31.map(t => t.name))} agent=${curAll31[0] && curAll31[0].agent} busy=${st31.workflows[0] && st31.workflows[0].busy}`]);
  checks.push(['#10 current 与历史引用去重（同一调用只入列一次）',
    new Set(st31.tasks.map(t => t.id)).size === st31.tasks.length && st31.tasks.length === 31,
    `tasks=${st31.tasks.length} 唯一=${new Set(st31.tasks.map(t => t.id)).size}`]);

  // 24/25 两侧边界：第 25 条时切片边界正好越过最旧的当前调用
  const boundary = [];
  for (const n of [24, 25]) {
    const calls = [mkCall('old', {start: nowC - 90000})];
    for (let i = 1; i < n; i++) calls.push(mkCall('h' + i, {start: nowC - 1000 + i, end: nowC - 900 + i, done: true}));
    const stb = build([mkSess('b' + n, calls, calls[0])]);
    boundary.push({n, has: stb.tasks.some(t => t.id === core.tid('test:b' + n + ':call:old') && t.cur), tasks: stb.tasks.length});
  }
  checks.push(['#10 24/25 两侧边界都保留当前代表任务', boundary.every(b => b.has), JSON.stringify(boundary)]);

  // 多工具并行：按「开始时间最早、callId 字典序」稳定选代表，不靠数组最后一项
  const pOrder = [mkCall('late', {start: nowC - 1000}), mkCall('early', {start: nowC - 5000})];
  const stP1 = build([mkSess('par1', pOrder.slice(), null)]);
  const stP2 = build([mkSess('par1', pOrder.slice().reverse(), null)]);
  const repOf = st => st.tasks.filter(t => t.cur).map(t => t.name).sort().join(',');
  checks.push(['#10 多工具并行时按稳定规则选代表（不靠数组最后一项）',
    repOf(stP1) === 'read early' && repOf(stP2) === 'read early'
      && stP1.tasks.some(t => t.name === 'read late' && t.state === 'run' && !t.cur)
      && stP1.tasks.length === 2,
    `rep1=${repOf(stP1)} rep2=${repOf(stP2)} tasks=${JSON.stringify(stP1.tasks.map(t => [t.name, t.state, !!t.cur]))}`]);

  // 并行一项完成、旧项仍运行：c1 完成后 c0 仍 run 并接替代表任务
  const stParDone = build([mkSess('par2', [
    mkCall('c0', {start: nowC - 8000}),
    mkCall('c1', {start: nowC - 4000, done: true, end: nowC - 1000}),
  ], null)]);
  const curPar = stParDone.tasks.filter(t => t.cur);
  checks.push(['#10 并行一项结束后旧项仍运行并接替代表任务',
    curPar.length === 1 && curPar[0].name === 'read c0' && curPar[0].state === 'run'
      && stParDone.tasks.some(t => t.name === 'read c1' && t.state === 'done' && t.outcome === 'success'),
    JSON.stringify(stParDone.tasks.map(t => [t.name, t.state, t.outcome, !!t.cur]))]);

  // maxTasks 预算：2 个智能体各 1 条当前 + 1 条历史；上限 3 必须装下两条当前任务
  const sA = mkSess('mA', [mkCall('a0', {}), mkCall('a1', {done: true, end: nowC - 1, start: nowC - 100})], null);
  const sB = mkSess('mB', [mkCall('b0', {}), mkCall('b1', {done: true, end: nowC - 1, start: nowC - 100})], null);
  const stLim = build([sA, sB], {maxTasks: 3});
  const curLim = stLim.tasks.filter(t => t.cur);
  checks.push(['#10 maxTasks 预算先满足当前代表任务，溢出用省略计数说明',
    stLim.tasks.length <= 3 && curLim.length === 2
      && stLim.tasksOmitted === 1 && stLim.tasksOmittedHistory === 1 && stLim.tasksOmittedActive === 0
      && stLim.currentOmitted === 0,
    `tasks=${stLim.tasks.length} cur=${curLim.length} omitted=${stLim.tasksOmitted} history=${stLim.tasksOmittedHistory} current=${stLim.currentOmitted}`]);
  const stTiny = build([sA, sB], {maxTasks: 1});
  checks.push(['#10 maxTasks 极小时 tasks 不越界，放不下的当前任务明确报数',
    stTiny.tasks.length === 1 && stTiny.tasks.filter(t => t.cur).length === 1 && stTiny.currentOmitted === 1,
    `tasks=${stTiny.tasks.length} cur=${stTiny.tasks.filter(t => t.cur).length} currentOmitted=${stTiny.currentOmitted}`]);

  /* ================= 复核 v2.43 #11：取消调用不能被成功环带当成功 ================= */
  const callOut = (id, o = {}) => ({callId: id, name: 'Bash', label: 'bash ' + id,
    start: 1000, end: 3000, done: true, error: false, ...o});
  const stOut = build([mkSess('out', [
    callOut('ok', {start: 1000, end: 3000}),
    callOut('bad', {start: 1000, end: 2000, error: true}),
    callOut('cancel', {start: 1000, end: 8777, aborted: true}),
  ], null)]);
  const byName = name => stOut.tasks.find(t => t.name === 'bash ' + name);
  checks.push(['#11 outcome 区分 running/success/failed/cancelled，取消不显示成功',
    !!byName('ok') && byName('ok').outcome === 'success' && byName('ok').state === 'done'
      && !!byName('bad') && byName('bad').outcome === 'failed' && byName('bad').state === 'failed'
      && !!byName('cancel') && byName('cancel').outcome === 'cancelled' && byName('cancel').state === 'cancelled'
      && byName('cancel').state !== 'done',
    JSON.stringify(stOut.tasks.map(t => [t.name, t.state, t.outcome]))]);
  checks.push(['#11 成功/失败环带排除取消样本',
    stOut.ring.ops.length === 2
      && !stOut.ring.ops.some(o => o.ms === 7777)
      && stOut.ring.ops.some(o => o.ms === 2000 && o.ok === true)
      && stOut.ring.ops.some(o => o.ms === 1000 && o.ok === false)
      && stOut.ring.nums.every(n => Number.isFinite(n) && n >= 0),
    JSON.stringify(stOut.ring.ops)]);

  // 独立复现样本：done=true / aborted=true / error=false，会话 done=0 / failed=0
  const stCancelOnly = build([mkSess('cancelOnly', [callOut('c0', {start: 1000, end: 3000, aborted: true})], null)]);
  checks.push(['#11 独立复现：done+aborted 的调用 ringOps 为空、任务不标 done、不计成功/失败',
    stCancelOnly.ring.ops.length === 0 && stCancelOnly.tasks.length === 1
      && stCancelOnly.tasks[0].state === 'cancelled' && stCancelOnly.tasks[0].outcome === 'cancelled'
      && stCancelOnly.tasks.filter(t => t.state === 'done').length === 0
      && stCancelOnly.workflows[0].fails === 0,
    `ops=${JSON.stringify(stCancelOnly.ring.ops)} task=${JSON.stringify(stCancelOnly.tasks[0])} fails=${stCancelOnly.workflows[0].fails}`]);

  // duration 校验：负值 / NaN / Infinity / 无起点都不能生成环带样本
  const stBadMs = build([mkSess('badms', [
    callOut('neg', {start: 5000, end: 1000}),
    callOut('nan', {start: 1000, end: NaN}),
    callOut('inf', {start: 1000, end: Infinity}),
    callOut('zero', {start: 0, end: 3000}),
  ], null)]);
  checks.push(['#11 非有限/负/无起点的 duration 不生成环带样本',
    stBadMs.ring.ops.length === 0 && stBadMs.ring.nums.length === 0,
    `ops=${JSON.stringify(stBadMs.ring.ops)} nums=${JSON.stringify(stBadMs.ring.nums)}`]);

  // 取消后迟到成功/失败：已确定的取消不被回滚；迟到失败仍可独立成为失败环带
  const stLate = build([mkSess('late', [
    callOut('c', {start: 1000, end: 3000, aborted: true, error: true}),
    callOut('c2', {start: 1000, end: 3000, aborted: true, error: false}),
    callOut('fail2', {start: 1000, end: 2000, error: true, aborted: false}),
  ], null)]);
  checks.push(['#11 迟到成功/失败都不回滚已确定的取消，迟到的失败仍独立成环带',
    stLate.tasks.filter(t => t.name === 'bash c' || t.name === 'bash c2').every(t => t.state === 'cancelled')
      && stLate.ring.ops.length === 1 && stLate.ring.ops[0].ok === false && stLate.ring.ops[0].ms === 1000,
    `tasks=${JSON.stringify(stLate.tasks.map(t => [t.name, t.state, t.outcome]))} ops=${JSON.stringify(stLate.ring.ops)}`]);

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
  /* 动态导入 zlib：静态 import 在缺该导出的 Node（< 23.8）上会在模块加载阶段直接
     抛 SyntaxError，连"跳过"都执行不到，还会连累其它测试模式。 */
  const zlib = await import('node:zlib');
  if (typeof zlib.zstdCompressSync !== 'function') {
    console.log('MODE=dshsrc 需要 Node 23.8+（zlib.zstdCompressSync），当前 Node ' + process.version + ' 不支持，跳过');
    process.exit(0);
  }
  const dsh = await import('./sources/dsh.mjs');
  const root = await mkdtemp(join(tmpdir(), 'dsh-smoke-'));
  const ws = join(root, 'wsA'), sid = join(ws, 'sid1');
  await mkdir(sid, {recursive: true});
  // 真实 DSH 记录带 seq，事件流按 seq 递增才能送进任务流
  const rec = (type, seq, time, data) => JSON.stringify({type, seq, time, data}) + '\n';
  const lines = [
    'null\n',                                          // 坏记录：不能把整份会话拖垮
    rec('session', 1, 1000, {id: 'sid1', cwd: 'D:\\dshW'}),
    rec('tool/call', 2, 2000, {callId: 'c1', name: 'read', arguments: '{"file_path":"/etc/x"}'}),
    rec('tool/result', 3, 3000, {toolCallId: 'c1', message: {isError: true, content: 'EACCES: permission denied, open /etc/x'}}),
  ].join('');
  await writeFile(join(sid, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines, 'utf8')));

  const pushed = [];
  const src = dsh.create({root, activeMs: 999999999, live: {push(it) { pushed.push(it); }}});
  await src.scan(true);
  const s = src.sessions().find(x => x.id === 'sid1');
  const failEvt = pushed.find(p => p.ok === false);

  const checks = [
    ['合成 DSH 会话能解析（日志里混了 null 行）', !!s && s.calls.length === 1 && s.cwd === 'D:\\dshW', `calls=${s && s.calls.length} cwd=${s && s.cwd}`],
    ['失败结果配上调用（failed=1）', !!s && s.failed === 1, `failed=${s && s.failed}`],
    ['折叠结果里带工具名和原因', !!s && !!s.lastFail && s.lastFail.name === 'read' && /EACCES/.test(s.lastFail.reason),
      JSON.stringify(s && s.lastFail)],
    // 复核意见：DSH 失败事件的工具名曾经查不到（映射用错字段），这条专门盯它
    ['DSH 失败事件带工具名（不是「工具 ·」）', !!failEvt && /^read · /.test(failEvt.name) && /EACCES/.test(failEvt.name),
      JSON.stringify(failEvt)],
  ];
  await rm(root, {recursive: true, force: true});

  /* 复核 v2.33 第 4 条 P2：工作区子目录 readdir 失败不能被当成「那个目录的会话被删了」。
     Windows 上造 EACCES 不可靠，用 create() 的 io 注入：只对指定目录抛 EACCES，其余走真实 readdir。 */
  const {readdir: realReaddir, readFile: realReadFile, stat: realStat} = await import('node:fs/promises');
  const root2 = await mkdtemp(join(tmpdir(), 'dsh-stale-'));
  const wsA2 = join(root2, 'wsA'), wsB2 = join(root2, 'wsB');
  await mkdir(join(wsA2, 'sa'), {recursive: true});
  await mkdir(join(wsB2, 'sb'), {recursive: true});
  const oneLog = (id, cwd) => zlib.zstdCompressSync(Buffer.from([
    rec('session', 1, 1000, {id, cwd}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '干活'}),
  ].join(''), 'utf8'));
  await writeFile(join(wsA2, 'sa', 'session.v4.jsonl.zstd'), oneLog('sa', 'D:\\wsA'));
  await writeFile(join(wsB2, 'sb', 'session.v4.jsonl.zstd'), oneLog('sb', 'D:\\wsB'));
  let failPath = null;
  const ioWithEacces = (p, opts) => {
    if (failPath && String(p).replace(/[\\/]+$/, '') === failPath) {
      throw Object.assign(new Error('EACCES: permission denied, scandir ' + p), {code: 'EACCES'});
    }
    return realReaddir(p, opts);
  };
  const srcStale = dsh.create({root: root2, activeMs: 999999999, live: {push() {}},
    io: {readdir: ioWithEacces, readFile: realReadFile, stat: realStat}, listIntervalMs: 0});
  await srcStale.scan(true);                                   // ① 正常：两个工作区各一个会话
  const nBase = srcStale.sessions().length;
  failPath = wsB2;                                             // ② wsB 暂时不可读
  await srcStale.scan(false);
  const nBad = srcStale.sessions().length, stBad = srcStale.stats();
  failPath = null;                                             // ③ 恢复可读
  await srcStale.scan(false);
  const nOk = srcStale.sessions().length, stOk = srcStale.stats();
  failPath = root2.replace(/[\\/]+$/, '');                     // ④ 根目录不可读
  await srcStale.scan(false);
  const nRoot = srcStale.sessions().length, stRoot = srcStale.stats();
  await rm(root2, {recursive: true, force: true});

  checks.push(['两个工作区各一个会话，首次 scan 得到 2 个', nBase === 2, `会话数=${nBase}`]);
  checks.push(['工作区子目录读失败不会把缓存会话当成删除', nBad === 2, `会话数=${nBad}`]);
  checks.push(['工作区子目录读失败时 stats().stale 为真', stBad.stale === true, `stale=${stBad.stale}`]);
  checks.push(['目录恢复可读后缓存会话仍在', nOk === 2, `会话数=${nOk}`]);
  checks.push(['目录恢复可读后 stats().stale 归假', stOk.stale === false, `stale=${stOk.stale}`]);
  checks.push(['根目录读失败时保留缓存会话', nRoot === 2, `会话数=${nRoot}`]);
  checks.push(['根目录读失败时 stats().stale 为真', stRoot.stale === true, `stale=${stRoot.stale}`]);

  /* 用户实测发现：会话回合已结束（turn/end）后，历史 todo 里的 in_progress 仍被大屏当成「运行中」，
     导致空闲会话的智能体一直绑着 run 任务、汇聚节点持续流光。
     修复：DSH 折叠记录 turnOpen；core 只有回合未结束（或有未闭合调用/step）时才把 in_progress 映射为 run。 */
  const root3 = await mkdtemp(join(tmpdir(), 'dsh-turn-'));
  const mkSess = (ws, sid, cwd, withEnd) => {
    const dir = join(root3, ws, sid);
    return mkdir(dir, {recursive: true}).then(() => writeFile(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from([
      rec('session', 1, 1000, {id: sid, cwd}),
      rec('turn/start', 2, 2000, {turn: 1}),
      rec('todo/write', 3, 3000, {todos: [{content: cwd === 'D:\\wIdle' ? '空闲会话的进行中任务' : '运行中会话的进行中任务', status: 'in_progress'}]}),
      ...(withEnd ? [rec('turn/end', 4, 4000, {turn: 1})] : []),
    ].join(''), 'utf8'))));
  };
  await mkSess('wsIdle', 'sidIdle', 'D:\\wIdle', true);
  await mkSess('wsBusy', 'sidBusy', 'D:\\wBusy', false);
  const srcTurn = dsh.create({root: root3, activeMs: 999999999, live: {push() {}}});
  await srcTurn.scan(true);
  const sIdle = srcTurn.sessions().find(x => x.id === 'sidIdle');
  const sBusy = srcTurn.sessions().find(x => x.id === 'sidBusy');
  const { buildState, createLive, createCodes } = await import('./lib/core.mjs');
  const stTurn = buildState({
    sessions: srcTurn.sessions(), live: createLive(), codes: createCodes(),
    activeMs: 999999999, maxAgents: 12, maxTasks: 60, servedFrom: 'test', source: 'dsh',
  });
  const runNames = stTurn.tasks.filter(t => t.state === 'run').map(t => String(t.name));
  await rm(root3, {recursive: true, force: true});
  checks.push(['回合状态：turn/end 后 turnOpen=false、进行中为 true',
    !!sIdle && sIdle.turnOpen === false && !!sBusy && sBusy.turnOpen === true,
    `idle=${sIdle && sIdle.turnOpen} busy=${sBusy && sBusy.turnOpen}`]);
  checks.push(['回合结束后：历史 todo 的 in_progress 不再显示为运行中',
    !runNames.some(n => /空闲会话的进行中任务/.test(n)), `run=${JSON.stringify(runNames)}`]);
  checks.push(['回合进行中：in_progress todo 仍显示为运行中',
    runNames.some(n => /运行中会话的进行中任务/.test(n)), `run=${JSON.stringify(runNames)}`]);

  /* 复核 v2.34 第 1/8 条：与 claude 同构的边界，外加「单会话目录删除」。
     io 注入只让目标文件读取失败，目录枚举与 stat 保持真实。 */
  const root4 = await mkdtemp(join(tmpdir(), 'dsh-v234-'));
  const mkRun = (ws, sid, cwd) => {
    const d = join(root4, ws, sid);
    return mkdir(d, {recursive: true}).then(() => writeFile(join(d, 'session.v4.jsonl.zstd'),
      zlib.zstdCompressSync(Buffer.from([
        rec('session', 1, 1000, {id: sid, cwd}),
        rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '干活'}),
        // 未闭合的调用 → running，删掉后不能还挂在墙上
        rec('tool/call', 3, 3000, {callId: 'c-' + sid, name: 'bash', arguments: '{"command":"sleep 1"}'}),
      ].join(''), 'utf8'))));
  };
  await mkRun('wsA', 'sa1', 'D:\\wA');
  await mkRun('wsA', 'sa2', 'D:\\wA');
  await mkRun('wsB', 'sb1', 'D:\\wB');
  await mkRun('wsC', 'sc1', 'D:\\wC');
  await mkRun('wsC', 'sc2', 'D:\\wC');
  let readFailD = null;
  const ioD = {
    readdir: (p, o) => realReaddir(p, o),
    stat: (p, o) => realStat(p, o),
    readFile: (p, o) => {
      if (readFailD && String(p) === readFailD) {
        throw Object.assign(new Error('EACCES: permission denied, open ' + p), {code: 'EACCES'});
      }
      return realReadFile(p, o);
    },
  };
  const srcD = dsh.create({root: root4, activeMs: 999999999, live: {push() {}}, io: ioD, listIntervalMs: 0});
  await srcD.scan(true);                                       // ① 五个会话都读入
  const stDBase = srcD.stats();
  await rm(join(root4, 'wsB'), {recursive: true, force: true}); // ② 删除整个工作区目录
  await srcD.scan(false);
  await srcD.scan(false);
  const idsDDelWs = srcD.sessions().map(s => s.id).sort();
  const stDDelWs = srcD.stats();
  await rm(join(root4, 'wsA', 'sa2', 'session.v4.jsonl.zstd'), {force: true}); // ③ 单日志删除（会话目录仍在）
  await srcD.scan(false);
  await srcD.scan(false);
  const idsDDelFile = srcD.sessions().map(s => s.id).sort();
  const stDDelFile = srcD.stats();
  await rm(join(root4, 'wsC', 'sc2'), {recursive: true, force: true});  // ④ 单个会话目录删除
  await srcD.scan(false);
  await srcD.scan(false);
  const idsDDelDir = srcD.sessions().map(s => s.id).sort();
  const stDDelDir = srcD.stats();
  const sa1File = join(root4, 'wsA', 'sa1', 'session.v4.jsonl.zstd');
  readFailD = sa1File;                                         // ⑤ 单文件读取失败（文件已更新触发重读）
  await writeFile(sa1File, zlib.zstdCompressSync(Buffer.from([
    rec('session', 1, 1000, {id: 'sa1', cwd: 'D:\\wA'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '干活'}),
    rec('tool/call', 3, 3000, {callId: 'c-sa1', name: 'bash', arguments: '{"command":"sleep 1"}'}),
    rec('user/message', 4, 4000, {source: {kind: 'user'}, content: '读取失败后的追加'}),
  ].join(''), 'utf8')));
  await srcD.scan(false);
  const sDFail = srcD.sessions().find(x => x.id === 'sa1');
  const stDFail = srcD.stats();
  readFailD = null;                                            // ⑥ 恢复读取
  await srcD.scan(false);
  const sDRecover = srcD.sessions().find(x => x.id === 'sa1');
  const stDRecover = srcD.stats();
  await rm(root4, {recursive: true, force: true});

  checks.push(['v2.34 边界基线：5 个会话 / 5 个文件', stDBase.sessions === 5 && stDBase.files === 5, JSON.stringify(stDBase)]);
  checks.push(['整个工作区目录删除后旧会话退出（不再显示运行）',
    stDDelWs.sessions === 4 && stDDelWs.files === 4 && !idsDDelWs.includes('sb1') && stDDelWs.stale === false,
    JSON.stringify({...stDDelWs, ids: idsDDelWs})]);
  checks.push(['单个日志删除后对应会话退出（会话目录仍在）',
    stDDelFile.sessions === 3 && !idsDDelFile.includes('sa2') && idsDDelFile.includes('sa1')
      && stDDelFile.files === 3 && stDDelFile.stale === false,
    JSON.stringify({...stDDelFile, ids: idsDDelFile})]);
  checks.push(['单个会话目录删除后对应会话退出（工作区仍在）',
    stDDelDir.sessions === 2 && idsDDelDir.join(',') === 'sa1,sc1' && stDDelDir.files === 2 && stDDelDir.stale === false,
    JSON.stringify({...stDDelDir, ids: idsDDelDir})]);
  checks.push(['单文件读取失败：旧会话保留且仍在运行', !!sDFail && !!sDFail.current,
    `current = ${!!(sDFail && sDFail.current)}`]);
  checks.push(['单文件读取失败：stats().stale 为真', stDFail.stale === true, `stale=${stDFail.stale}`]);
  checks.push(['恢复读取后：stale 归假且内容更新',
    stDRecover.stale === false && !!sDRecover && sDRecover.msgs.some(m => m.text.includes('读取失败后的追加')),
    `stale=${stDRecover.stale} msgs=${JSON.stringify(sDRecover && sDRecover.msgs)}`]);

  /* 复核 v2.36 第 3 条：回合终态（turn/end / turn/aborted）必须收尾本回合残留调用与 step，
     否则 turnOpen=false 但 current/openStep 还在，core 的 todo 降级条件永远不成立。
     覆盖：取消缺 tool/result、正常结束缺 tool/result、正常完整回合、迟到 tool/result。 */
  const root5 = await mkdtemp(join(tmpdir(), 'dsh-terminal-'));
  const termLog = (sid, ending) => {
    const evs = [
      rec('session', 1, 1000, {id: sid, cwd: 'D:\\w' + sid}),
      rec('turn/start', 2, 2000, {turn: 1}),
      rec('step/start', 3, 2100, {turn: 1, step: 1}),
      rec('tool/call', 4, 2200, {callId: 'c-' + sid, name: 'write',
        arguments: JSON.stringify({file_path: 'a.js', content: '未完成的写入'})}),
      rec('todo/write', 5, 2300, {todos: [{content: '残留进行中任务-' + sid, status: 'in_progress'}]}),
    ];
    if (ending === 'turn/aborted') evs.push(rec('turn/aborted', 6, 2400, {turn: 1}));
    else if (ending === 'turn/end') evs.push(rec('turn/end', 6, 2400, {turn: 1}));
    else if (ending === 'late') {
      // 回合先结束，tool/result 迟到：作废调用不能翻成成功
      evs.push(rec('turn/end', 6, 2400, {turn: 1}));
      evs.push(rec('tool/result', 7, 2500, {toolCallId: 'c-' + sid, message: {content: '写入成功'}}));
    } else {
      // 正常完整收尾：tool/result → step/end → turn/end
      evs.push(rec('tool/result', 6, 2350, {toolCallId: 'c-' + sid, message: {content: '写入成功'}}));
      evs.push(rec('step/end', 7, 2400, {turn: 1, step: 1}));
      evs.push(rec('turn/end', 8, 2500, {turn: 1}));
    }
    return evs.join('');
  };
  const writeTerm = (sid, ending) => mkdir(join(root5, 'ws' + sid, sid), {recursive: true})
    .then(() => writeFile(join(root5, 'ws' + sid, sid, 'session.v4.jsonl.zstd'),
      zlib.zstdCompressSync(Buffer.from(termLog(sid, ending), 'utf8'))));
  await writeTerm('sidAbort', 'turn/aborted');
  await writeTerm('sidEnd', 'turn/end');
  await writeTerm('sidLate', 'late');
  await writeTerm('sidFull', 'full');
  const srcTerm = dsh.create({root: root5, activeMs: 999999999, live: {push() {}}});
  await srcTerm.scan(true);
  const termS = id => srcTerm.sessions().find(x => x.id === id);
  const sAbort = termS('sidAbort'), sEnd = termS('sidEnd');
  const sLate = termS('sidLate'), sFull = termS('sidFull');
  const stTerm = buildState({sessions: srcTerm.sessions(), live: createLive(), codes: createCodes(),
    activeMs: 999999999, maxAgents: 12, maxTasks: 60, servedFrom: 'test', source: 'dsh'});
  const runTerm = stTerm.tasks.filter(t => t.state === 'run');
  await rm(root5, {recursive: true, force: true});

  checks.push(['回合取消（turn/aborted）：turnOpen=false、current/openStep 都为空',
    !!sAbort && sAbort.turnOpen === false && sAbort.current === null && sAbort.openStep === null,
    JSON.stringify(sAbort && {turnOpen: sAbort.turnOpen, current: sAbort.current, openStep: sAbort.openStep})]);
  checks.push(['回合取消：作废调用标记 done+aborted，且不计成功/失败、不进代码片段',
    !!sAbort && sAbort.calls.length === 1 && sAbort.calls[0].done === true && sAbort.calls[0].aborted === true
      && sAbort.done === 0 && sAbort.failed === 0 && sAbort.snippets.length === 0 && sAbort.aborted === 1,
    JSON.stringify(sAbort && {calls: sAbort.calls.map(c => [c.done, !!c.aborted]), done: sAbort.done,
      failed: sAbort.failed, snippets: sAbort.snippets.length, aborted: sAbort.aborted})]);
  checks.push(['回合正常结束（turn/end）同样收尾残留调用与 step',
    !!sEnd && sEnd.turnOpen === false && sEnd.current === null && sEnd.openStep === null
      && !!sEnd.calls[0] && sEnd.calls[0].done === true && sEnd.calls[0].aborted === true
      && sEnd.done === 0 && sEnd.snippets.length === 0,
    JSON.stringify(sEnd && {turnOpen: sEnd.turnOpen, current: sEnd.current, openStep: sEnd.openStep,
      calls: sEnd.calls.map(c => [c.done, !!c.aborted]), done: sEnd.done, snippets: sEnd.snippets.length})]);
  checks.push(['正常完整回合（tool/call→tool/result→turn/end）仍计 done=1、不算失败',
    !!sFull && sFull.done === 1 && sFull.failed === 0 && !!sFull.calls[0]
      && sFull.calls[0].done === true && !sFull.calls[0].aborted && sFull.snippets.length === 1,
    JSON.stringify(sFull && {done: sFull.done, failed: sFull.failed, call: sFull.calls[0],
      snippets: sFull.snippets.length})]);
  checks.push(['迟到 tool/result：已作废调用不会翻成成功，done 不增加、片段不入列',
    !!sLate && sLate.turnOpen === false && sLate.current === null && !!sLate.calls[0]
      && sLate.calls[0].done === true && sLate.calls[0].aborted === true && sLate.calls[0].error === false
      && sLate.done === 0 && sLate.snippets.length === 0,
    JSON.stringify(sLate && {done: sLate.done, call: sLate.calls[0], snippets: sLate.snippets.length})]);
  checks.push(['回合终态后 buildState 里没有残留 run 任务、工作区不忙',
    runTerm.length === 0 && stTerm.workflows.every(w => w.busy === 0),
    JSON.stringify({run: runTerm.map(t => t.name), busy: stTerm.workflows.map(w => [w.name, w.busy])})]);

  /* 复核 v2.36 第 4 条（DSH 侧）：stat 的 EACCES 不能让缓存被当成已删除，也不能当成正常；
     目录枚举正常、单日志 stat 失败 → 保留缓存 + stale；恢复后重读；确认 ENOENT 才退出。
     两个候选格式（session.v4.jsonl.zstd / session.v4.jsonl）都要覆盖。 */
  const root6 = await mkdtemp(join(tmpdir(), 'dsh-badstat-'));
  const wsStat = join(root6, 'wsStat');
  await mkdir(join(wsStat, 'sa'), {recursive: true});
  await mkdir(join(wsStat, 'sb'), {recursive: true});
  const statZ = join(wsStat, 'sa', 'session.v4.jsonl.zstd');
  const statJ = join(wsStat, 'sb', 'session.v4.jsonl');
  const statLog = (id, cwd, extra = '') => [
    rec('session', 1, 1000, {id, cwd}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: 'stat 测试-' + id}),
    rec('tool/call', 3, 3000, {callId: 'c-' + id, name: 'bash', arguments: '{"command":"sleep 1"}'}),
  ].join('') + extra;
  // sa 用 zstd、sb 用纯 JSONL：两个候选路径都走一遍
  await writeFile(statZ, zlib.zstdCompressSync(Buffer.from(statLog('sa', 'D:\\wStatA'), 'utf8')));
  await writeFile(statJ, statLog('sb', 'D:\\wStatB'));
  let statFail = new Set();
  const ioStatD = {
    readdir: (p, o) => realReaddir(p, o),
    readFile: (p, o) => realReadFile(p, o),
    stat: (p, o) => {
      if (statFail.has(String(p))) {
        throw Object.assign(new Error('EACCES: permission denied, stat ' + p), {code: 'EACCES'});
      }
      return realStat(p, o);
    },
  };
  const srcStatD = dsh.create({root: root6, activeMs: 999999999, live: {push() {}},
    io: ioStatD, listIntervalMs: 0});
  await srcStatD.scan(true);                                   // ① 正常读入两个运行中的会话
  const stSBase = srcStatD.stats();
  statFail = new Set([statZ, statJ]);                          // ② 两个候选文件 stat 都 EACCES
  await srcStatD.scan(false);
  const stSBad = srcStatD.stats();
  const idsSBad = srcStatD.sessions().map(x => x.id).sort();
  statFail = new Set();                                        // ③ 恢复 stat，同时更新内容
  await writeFile(statZ, zlib.zstdCompressSync(Buffer.from(statLog('sa', 'D:\\wStatA',
    rec('user/message', 4, 4000, {source: {kind: 'user'}, content: 'stat 恢复后的追加山'})), 'utf8')));
  await writeFile(statJ, statLog('sb', 'D:\\wStatB',
    rec('user/message', 4, 4000, {source: {kind: 'user'}, content: 'stat 恢复后的追加海'})));
  await srcStatD.scan(false);
  const stSOk = srcStatD.stats();
  const ssSOk = srcStatD.sessions();
  await rm(statZ, {force: true});                              // ④ 文件确实删除 → 允许退出缓存
  await rm(statJ, {force: true});
  await srcStatD.scan(false);
  const stSDel = srcStatD.stats();
  await rm(root6, {recursive: true, force: true});

  checks.push(['stat 错误基线：两个会话正常读入、未标 stale',
    stSBase.sessions === 2 && stSBase.running === 2 && stSBase.stale === false, JSON.stringify(stSBase)]);
  checks.push(['stat EACCES：两个候选格式的会话都保留且仍在运行',
    stSBad.sessions === 2 && stSBad.running === 2 && idsSBad.join(',') === 'sa,sb',
    JSON.stringify({...stSBad, ids: idsSBad})]);
  checks.push(['stat EACCES：stats().stale 为真（不能当成正常缓存）', stSBad.stale === true, `stale=${stSBad.stale}`]);
  checks.push(['stat 恢复：stale 归假且两个会话都能重读更新',
    stSOk.stale === false && stSOk.sessions === 2
      && ['追加山', '追加海'].every(t => ssSOk.some(x => x.msgs.some(m => m.text.includes(t)))),
    JSON.stringify({...stSOk, msgs: ssSOk.map(x => x.msgs.map(m => m.text))})]);
  checks.push(['stat ENOENT（文件确实没了）：退出缓存，stale 不因此挂住',
    stSDel.sessions === 0 && stSDel.files === 0 && stSDel.stale === false, JSON.stringify(stSDel)]);

  /* 复核 v2.37 第 6 条：组合读取故障。已缓存文件先 readFile EACCES，下一轮同一文件 stat 也 EACCES。
     缓存要保留，badReads/badStats 的清理必须和缓存删除共用「确认删除」判定，否则 stale 会短暂变 false。
     修复前：缓存清理分支保护了 statUnknown，但随后的 badReads 清理仍按 confirmedGone 把记录删掉。 */
  const root7 = await mkdtemp(join(tmpdir(), 'dsh-mixed-'));
  const wsMix = join(root7, 'wsMix'), sidMix = join(wsMix, 'sx');
  await mkdir(sidMix, {recursive: true});
  const mixFile = join(sidMix, 'session.v4.jsonl.zstd');
  const mixLog = extra => [
    rec('session', 1, 1000, {id: 'sx', cwd: 'D:\\wMix'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '组合故障基线'}),
    rec('tool/call', 3, 3000, {callId: 'c-sx', name: 'bash', arguments: '{"command":"sleep 1"}'}),
  ].join('') + (extra || '');
  await writeFile(mixFile, zlib.zstdCompressSync(Buffer.from(mixLog(''), 'utf8')));
  let mixReadFail = null, mixStatFail = null;
  const ioMix = {
    readdir: (p, o) => realReaddir(p, o),
    stat: (p, o) => {
      if (mixStatFail && String(p) === mixStatFail) {
        throw Object.assign(new Error('EACCES: permission denied, stat ' + p), {code: 'EACCES'});
      }
      return realStat(p, o);
    },
    readFile: (p, o) => {
      if (mixReadFail && String(p) === mixReadFail) {
        throw Object.assign(new Error('EACCES: permission denied, open ' + p), {code: 'EACCES'});
      }
      return realReadFile(p, o);
    },
  };
  const srcMix = dsh.create({root: root7, activeMs: 999999999, live: {push() {}}, io: ioMix, listIntervalMs: 0});
  await srcMix.scan(true);                                     // ① 基线：1 会话、1 文件、不 stale
  const stMixBase = srcMix.stats();
  mixReadFail = mixFile;                                       // ② readFile EACCES（文件已更新触发重读）
  await writeFile(mixFile, zlib.zstdCompressSync(Buffer.from(mixLog(
    rec('user/message', 4, 4000, {source: {kind: 'user'}, content: '读取失败后的追加'})), 'utf8')));
  await srcMix.scan(false);
  const stMixRead = srcMix.stats();
  mixStatFail = mixFile;                                       // ③ 同一文件 stat 也 EACCES
  await srcMix.scan(false);
  const stMixBoth1 = srcMix.stats();
  const nMixBoth1 = srcMix.sessions().length;
  await srcMix.scan(false);                                    // ④ 两者持续失败：仍然 stale
  const stMixBoth2 = srcMix.stats();
  const nMixBoth2 = srcMix.sessions().length;
  mixReadFail = null; mixStatFail = null;                      // ⑤ 权限恢复：stale 归假并能重读
  await writeFile(mixFile, zlib.zstdCompressSync(Buffer.from(mixLog(
    rec('user/message', 4, 4000, {source: {kind: 'user'}, content: '读取失败后的追加'})
    + rec('user/message', 5, 5000, {source: {kind: 'user'}, content: '权限恢复后的追加'})), 'utf8')));
  await srcMix.scan(false);
  const stMixOk = srcMix.stats();
  const sMixOk = srcMix.sessions().find(x => x.id === 'sx');
  await rm(mixFile, {force: true});                            // ⑥ 真实删除：缓存退出、stale 归假
  await srcMix.scan(false);
  const stMixDel = srcMix.stats();
  await rm(root7, {recursive: true, force: true});

  checks.push(['组合故障基线：1 会话 / 1 文件 / 不 stale',
    stMixBase.sessions === 1 && stMixBase.files === 1 && stMixBase.stale === false, JSON.stringify(stMixBase)]);
  checks.push(['readFile EACCES：缓存保留且 stale=true',
    stMixRead.sessions === 1 && stMixRead.running === 1 && stMixRead.stale === true, JSON.stringify(stMixRead)]);
  checks.push(['readFile 失败后紧接 stat 失败：stale 仍为 true（不能短暂误报正常）',
    nMixBoth1 === 1 && stMixBoth1.stale === true, JSON.stringify({...stMixBoth1, n: nMixBoth1})]);
  checks.push(['readFile 与 stat 持续失败：stale 一直为 true、会话不丢',
    nMixBoth2 === 1 && stMixBoth2.stale === true, JSON.stringify({...stMixBoth2, n: nMixBoth2})]);
  checks.push(['权限恢复：stale 归假且能读到新内容',
    stMixOk.stale === false && !!sMixOk && sMixOk.msgs.some(m => m.text.includes('权限恢复后的追加')),
    JSON.stringify({...stMixOk, msgs: sMixOk && sMixOk.msgs})]);
  checks.push(['真实删除：缓存退出、stale 不挂住',
    stMixDel.sessions === 0 && stMixDel.files === 0 && stMixDel.stale === false, JSON.stringify(stMixDel)]);

  /* 复核 v2.38 第 3 条：双格式回退。zstd 优先；高优先级 stat 失败（EACCES/EPERM/IO）
     = 无法确认存在与否，即使普通格式可读也必须 stale；已缓存高优先级快照时不能被普通版覆盖；
     ENOENT（确认不存在）才允许正常降级；格式切换要清掉另一格式缓存，sessions 不能重复。 */
  const dualIo = (failBox) => ({
    readdir: (p, o) => realReaddir(p, o),
    readFile: (p, o) => realReadFile(p, o),
    stat: (p, o) => {
      if (failBox.path && String(p) === failBox.path) {
        throw Object.assign(new Error('EACCES: permission denied, stat ' + p), {code: 'EACCES'});
      }
      return realStat(p, o);
    },
  });

  const root8 = await mkdtemp(join(tmpdir(), 'dsh-dual-'));
  const sid8 = join(root8, 'ws8', 'sd');
  await mkdir(sid8, {recursive: true});
  const zstd8 = join(sid8, 'session.v4.jsonl.zstd');
  const plain8 = join(sid8, 'session.v4.jsonl');
  // 两份内容不同：zstd 里调用 c-z 未闭合（current=c-z），普通版已收尾（current=null）。
  // 只有 current 跟着 zstd 走，才能证明优先格式被采用、没被普通版覆盖。
  await writeFile(zstd8, zlib.zstdCompressSync(Buffer.from([
    rec('session', 1, 1000, {id: 'sd', cwd: 'D:\\wDual'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '压缩版内容'}),
    rec('turn/start', 3, 2100, {turn: 1}),
    rec('tool/call', 4, 2200, {callId: 'c-z', name: 'bash', arguments: '{"command":"sleep 1"}'}),
  ].join(''), 'utf8')));
  const plain8Log = extra => [
    rec('session', 1, 1000, {id: 'sd', cwd: 'D:\\wDual'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '普通版内容'}),
    rec('turn/start', 3, 2100, {turn: 1}),
    rec('tool/call', 4, 2200, {callId: 'c-p', name: 'bash', arguments: '{"command":"sleep 1"}'}),
    rec('tool/result', 5, 2300, {toolCallId: 'c-p', message: {content: 'ok'}}),
    rec('turn/end', 6, 2400, {turn: 1}),
  ].join('') + (extra || '');
  await writeFile(plain8, plain8Log());
  const fail8 = {path: null};
  const src8 = dsh.create({root: root8, activeMs: 999999999, live: {push() {}}, io: dualIo(fail8), listIntervalMs: 0});
  await src8.scan(true);                                       // ① 两文件都在：zstd 优先
  const s8a = src8.sessions().find(x => x.id === 'sd');
  const st8a = src8.stats();
  const msgs8a = s8a ? s8a.msgs.map(m => m.text) : [];
  fail8.path = zstd8;                                          // ② zstd stat EACCES、普通可读
  await writeFile(plain8, plain8Log(rec('user/message', 7, 3000, {source: {kind: 'user'}, content: '回退后的普通版追加'})));
  await src8.scan(false);
  const s8b = src8.sessions().find(x => x.id === 'sd');
  const st8b = src8.stats();
  const msgs8b = s8b ? s8b.msgs.map(m => m.text) : [];
  await rm(root8, {recursive: true, force: true});

  checks.push(['双格式：zstd 存在时优先用 zstd（current/内容都来自 zstd）',
    !!s8a && !!s8a.current && s8a.current.callId === 'c-z' && msgs8a.some(t => t.includes('压缩版内容'))
      && !msgs8a.some(t => t.includes('普通版内容')),
    JSON.stringify({current: s8a && s8a.current && s8a.current.callId, msgs: msgs8a})]);
  checks.push(['双格式：zstd 优先时 stale=false、sessions/files 各 1',
    st8a.sessions === 1 && st8a.files === 1 && st8a.stale === false, JSON.stringify(st8a)]);
  checks.push(['已缓存 zstd 快照后 zstd stat EACCES：保留 zstd 快照、不被普通版覆盖',
    !!s8b && !!s8b.current && s8b.current.callId === 'c-z' && !msgs8b.some(t => t.includes('回退后的普通版追加')),
    JSON.stringify({current: s8b && s8b.current && s8b.current.callId, msgs: msgs8b})]);
  checks.push(['已缓存 zstd 快照后 zstd stat EACCES：stale=true、running=1、sessions 仍 1',
    st8b.sessions === 1 && st8b.files === 1 && st8b.running === 1 && st8b.stale === true, JSON.stringify(st8b)]);

  /* 没有高优先级缓存时允许用普通版，但 zstd 的故障不能被普通版「治好」 */
  const root9 = await mkdtemp(join(tmpdir(), 'dsh-dual-fb-'));
  const sid9 = join(root9, 'ws9', 'sf');
  await mkdir(sid9, {recursive: true});
  const zstd9 = join(sid9, 'session.v4.jsonl.zstd');
  const plain9 = join(sid9, 'session.v4.jsonl');
  await writeFile(plain9, [
    rec('session', 1, 1000, {id: 'sf', cwd: 'D:\\wFallback'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '普通格式内容'}),
    rec('turn/start', 3, 2100, {turn: 1}),
    rec('tool/call', 4, 2200, {callId: 'c-p9', name: 'bash', arguments: '{"command":"sleep 1"}'}),
  ].join(''));
  await writeFile(zstd9, zlib.zstdCompressSync(Buffer.from([
    rec('session', 1, 1000, {id: 'sf', cwd: 'D:\\wFallback'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '压缩版完整历史'}),
    rec('turn/start', 3, 2100, {turn: 1}),
    rec('tool/call', 4, 2200, {callId: 'c-z9', name: 'bash', arguments: '{"command":"echo hi"}'}),
    rec('tool/result', 5, 2300, {toolCallId: 'c-z9', message: {content: 'ok'}}),
    rec('turn/end', 6, 2400, {turn: 1}),
  ].join(''), 'utf8')));
  const fail9 = {path: zstd9};
  const src9 = dsh.create({root: root9, activeMs: 999999999, live: {push() {}}, io: dualIo(fail9), listIntervalMs: 0});
  await src9.scan(true);                                       // ① zstd 不可确认、无缓存 → 回退普通
  const s9a = src9.sessions().find(x => x.id === 'sf');
  const st9a = src9.stats();
  const msgs9a = s9a ? s9a.msgs.map(m => m.text) : [];
  fail9.path = null;                                           // ② zstd 恢复可读
  await src9.scan(false);
  const sess9b = src9.sessions();
  const s9b = sess9b.find(x => x.id === 'sf');
  const st9b = src9.stats();
  const msgs9b = s9b ? s9b.msgs.map(m => m.text) : [];
  await rm(root9, {recursive: true, force: true});

  checks.push(['无 zstd 缓存且 zstd stat EACCES：用普通版内容（但 stale）',
    !!s9a && !!s9a.current && s9a.current.callId === 'c-p9' && msgs9a.some(t => t.includes('普通格式内容')),
    JSON.stringify({current: s9a && s9a.current && s9a.current.callId, msgs: msgs9a})]);
  checks.push(['无 zstd 缓存且 zstd stat EACCES：stale=true、sessions 仍 1',
    st9a.sessions === 1 && st9a.stale === true, JSON.stringify(st9a)]);
  checks.push(['zstd 恢复后：改用 zstd 内容（current 空、running=0）且 sessions 不重复',
    sess9b.length === 1 && !!s9b && s9b.current === null && st9b.running === 0 && st9b.sessions === 1
      && msgs9b.some(t => t.includes('压缩版完整历史')) && !msgs9b.some(t => t.includes('普通格式内容')),
    JSON.stringify({n: sess9b.length, ...st9b, current: s9b && s9b.current, msgs: msgs9b})]);
  checks.push(['zstd 恢复后：stale=false、files=1', st9b.stale === false && st9b.files === 1, JSON.stringify(st9b)]);

  /* zstd 确认不存在（ENOENT）不是故障：正常用普通格式 */
  const root10 = await mkdtemp(join(tmpdir(), 'dsh-dual-enoent-'));
  const sid10 = join(root10, 'ws10', 'se');
  await mkdir(sid10, {recursive: true});
  await writeFile(join(sid10, 'session.v4.jsonl'), [
    rec('session', 1, 1000, {id: 'se', cwd: 'D:\\wEn'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '普通格式内容'}),
    rec('turn/start', 3, 2100, {turn: 1}),
    rec('tool/call', 4, 2200, {callId: 'c-e', name: 'bash', arguments: '{"command":"sleep 1"}'}),
  ].join(''));
  const src10 = dsh.create({root: root10, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
  await src10.scan(true);
  const s10 = src10.sessions().find(x => x.id === 'se');
  const st10 = src10.stats();
  await rm(root10, {recursive: true, force: true});
  checks.push(['zstd ENOENT（确认不存在）：正常用普通版、stale=false',
    !!s10 && !!s10.current && s10.current.callId === 'c-e' && st10.sessions === 1
      && st10.files === 1 && st10.stale === false,
    JSON.stringify({...st10, current: s10 && s10.current && s10.current.callId})]);

  /* 复核 v2.39 第 1 条：普通格式已缓存、stat 故障后，同目录出现可读的压缩版并成功折叠 ——
     同一会话目录必须只剩一个当前快照，旧格式的缓存/故障记录要迁移退出，恢复权限后也不能回退。 */
  const root11 = await mkdtemp(join(tmpdir(), 'dsh-switch-'));
  const sid11 = join(root11, 'ws11', 'smu');
  await mkdir(sid11, {recursive: true});
  const plain11 = join(sid11, 'session.v4.jsonl');
  const zstd11 = join(sid11, 'session.v4.jsonl.zstd');
  const plain11Log = [
    rec('session', 1, 1000, {id: 'smu', cwd: 'D:\\wSwitch'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '普通版历史'}),
    rec('tool/call', 3, 3000, {callId: 'c-plain', name: 'bash', arguments: '{"command":"sleep 1"}'}),
  ].join('');
  await writeFile(plain11, plain11Log);
  let statFail11 = null;
  const io11 = {
    readdir: (p, o) => realReaddir(p, o),
    readFile: (p, o) => realReadFile(p, o),
    stat: (p, o) => {
      if (statFail11 && String(p) === statFail11) {
        throw Object.assign(new Error('EACCES: permission denied, stat ' + p), {code: 'EACCES'});
      }
      return realStat(p, o);
    },
  };
  const src11 = dsh.create({root: root11, activeMs: 999999999, live: {push() {}}, io: io11, listIntervalMs: 0});
  await src11.scan(true);                                     // ① 只有普通版：调用未结束
  const st11a = src11.stats();
  statFail11 = plain11;                                       // ② 普通版 stat EACCES：旧快照保留
  await src11.scan(false);
  const st11b = src11.stats();
  await writeFile(zstd11, zlib.zstdCompressSync(Buffer.from([
    rec('session', 1, 1000, {id: 'smu', cwd: 'D:\\wSwitch'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '压缩版完整历史'}),
    rec('tool/call', 3, 3000, {callId: 'c-zstd', name: 'bash', arguments: '{"command":"sleep 1"}'}),
    rec('turn/end', 4, 4000, {turn: 1}),
  ].join(''), 'utf8')));
  await src11.scan(false);                                    // ③ 压缩版成功：迁移为唯一快照
  const st11c = src11.stats();
  const ss11c = src11.sessions();
  statFail11 = null;                                          // ④ 权限恢复后连续扫描三轮
  await src11.scan(false);
  await src11.scan(false);
  await src11.scan(false);
  const st11d = src11.stats();
  const ss11d = src11.sessions();
  const stWf11 = buildState({sessions: ss11d, live: createLive(), codes: createCodes(),
    activeMs: 999999999, maxAgents: 12, maxTasks: 60, servedFrom: 'test', source: 'dsh'});
  const uniq11 = arr => new Set(arr).size === arr.length;
  await rm(root11, {recursive: true, force: true});

  checks.push(['v2.39 格式切换基线：普通版 1 会话 / 1 文件 / 仍在运行 / 不 stale',
    st11a.sessions === 1 && st11a.files === 1 && st11a.running === 1 && st11a.stale === false, JSON.stringify(st11a)]);
  checks.push(['普通版 stat EACCES：快照保留、仍在运行、stale=true',
    st11b.sessions === 1 && st11b.running === 1 && st11b.stale === true, JSON.stringify(st11b)]);
  checks.push(['压缩版成功折叠后：同目录只剩一个快照、运行状态退出、stale=false（不等旧格式再成为候选）',
    st11c.sessions === 1 && st11c.files === 1 && st11c.running === 0 && st11c.stale === false
      && ss11c.length === 1 && !ss11c[0].current,
    JSON.stringify({...st11c, n: ss11c.length, current: !!(ss11c[0] && ss11c[0].current)})]);
  checks.push(['权限恢复后连续三轮：sessions=1、files=1、running=0、stale=false、编号唯一',
    st11d.sessions === 1 && st11d.files === 1 && st11d.running === 0 && st11d.stale === false
      && ss11d.length === 1 && !!ss11d[0] && ss11d[0].id === 'smu' && uniq11(ss11d.map(s => s.id))
      && stWf11.agents.length === 1 && uniq11(stWf11.agents.map(a => a.code)),
    JSON.stringify({...st11d, ids: ss11d.map(s => s.id), agents: stWf11.agents.map(a => a.code)})]);

  /* 复核 v2.39 第 1 条补测：新格式读取/解析失败时必须保护旧完整快照；两种格式都失败也不能误删。 */
  const root12 = await mkdtemp(join(tmpdir(), 'dsh-switch-keep-'));
  const sid12 = join(root12, 'ws12', 'skp');
  await mkdir(sid12, {recursive: true});
  const plain12 = join(sid12, 'session.v4.jsonl');
  const zstd12 = join(sid12, 'session.v4.jsonl.zstd');
  await writeFile(plain12, [
    rec('session', 1, 1000, {id: 'skp', cwd: 'D:\\wKeep'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '旧完整快照'}),
    rec('tool/call', 3, 3000, {callId: 'c-keep', name: 'bash', arguments: '{"command":"sleep 1"}'}),
  ].join(''));
  const zstd12Log = [
    rec('session', 1, 1000, {id: 'skp', cwd: 'D:\\wKeep'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '压缩版新内容'}),
    rec('turn/end', 3, 3000, {turn: 1}),
  ].join('');
  const readFail12 = new Set();
  const io12 = {
    readdir: (p, o) => realReaddir(p, o),
    stat: (p, o) => realStat(p, o),
    readFile: (p, o) => {
      if (readFail12.has(String(p))) {
        throw Object.assign(new Error('EACCES: permission denied, open ' + p), {code: 'EACCES'});
      }
      return realReadFile(p, o);
    },
  };
  const src12 = dsh.create({root: root12, activeMs: 999999999, live: {push() {}}, io: io12, listIntervalMs: 0});
  await src12.scan(true);                                     // ① 普通版完整快照
  await writeFile(zstd12, zlib.zstdCompressSync(Buffer.from(zstd12Log, 'utf8')));
  readFail12.add(zstd12);                                     // ② 高优先级读取失败 → 保留旧快照
  await src12.scan(false);
  const st12a = src12.stats();
  const s12a = src12.sessions().find(x => x.id === 'skp');
  readFail12.clear();
  await writeFile(zstd12, zlib.zstdCompressSync(Buffer.from('not-json\n{broken\n', 'utf8')));
  await src12.scan(false);                                    // ③ 新格式解析失败 → 仍保留旧快照
  const st12b = src12.stats();
  const s12b = src12.sessions().find(x => x.id === 'skp');
  readFail12.add(plain12); readFail12.add(zstd12);            // ④ 两种格式都读不到
  await src12.scan(false);
  const st12c = src12.stats();
  const s12c = src12.sessions().find(x => x.id === 'skp');
  readFail12.clear();                                         // ⑤ 压缩版恢复可读且带结束信号
  await writeFile(zstd12, zlib.zstdCompressSync(Buffer.from(zstd12Log, 'utf8')));
  await src12.scan(false);
  const st12d = src12.stats();
  const s12d = src12.sessions().find(x => x.id === 'skp');
  await rm(root12, {recursive: true, force: true});

  checks.push(['新格式读取失败：旧完整快照保留、仍在运行、stale=true',
    st12a.sessions === 1 && st12a.running === 1 && st12a.stale === true
      && !!s12a && s12a.msgs.some(m => m.text.includes('旧完整快照'))
      && !s12a.msgs.some(m => m.text.includes('压缩版新内容')),
    JSON.stringify({...st12a, msgs: s12a && s12a.msgs.map(m => m.text)})]);
  checks.push(['新格式解析失败：旧完整快照仍保留、sessions=1、stale=true（显式标记解析失败）',
    st12b.sessions === 1 && st12b.running === 1 && st12b.stale === true
      && !!s12b && s12b.msgs.some(m => m.text.includes('旧完整快照')),
    JSON.stringify({...st12b, msgs: s12b && s12b.msgs.map(m => m.text)})]);
  checks.push(['两种格式都读取失败：旧完整快照保留、stale=true',
    st12c.sessions === 1 && st12c.running === 1 && st12c.stale === true
      && !!s12c && s12c.msgs.some(m => m.text.includes('旧完整快照')),
    JSON.stringify({...st12c, msgs: s12c && s12c.msgs.map(m => m.text)})]);
  checks.push(['压缩版恢复后：改用新快照、旧快照退出、running=0、stale=false',
    st12d.sessions === 1 && st12d.files === 1 && st12d.running === 0 && st12d.stale === false
      && !!s12d && s12d.msgs.some(m => m.text.includes('压缩版新内容'))
      && !s12d.msgs.some(m => m.text.includes('旧完整快照')),
    JSON.stringify({...st12d, msgs: s12d && s12d.msgs.map(m => m.text)})]);

  /* 复核 v2.39 第 2 条（DSH）：todo/write 的 todos 数组含 null/非对象成员时，
     fold 必须过滤坏成员并继续处理后续 turn/end；不能靠最外层整份 catch 静默保留旧运行状态。 */
  const root13 = await mkdtemp(join(tmpdir(), 'dsh-todos-'));
  const wsTodoD = join(root13, 'wsTodo');
  const dTodoBase = id => [
    rec('session', 1, 1000, {id, cwd: 'D:\\wTodo'}),
    rec('turn/start', 2, 2000, {turn: 1}),
    rec('tool/call', 3, 2100, {callId: 'c-' + id, name: 'bash', arguments: '{"command":"sleep 1"}'}),
  ].join('');
  const dTodoCases = [
    ['tdNull', [null, {content: '合法任务-dsh-null', status: 'completed'}], '合法任务-dsh-null'],
    ['tdNonObj', [{content: '合法任务-dsh-非对象', status: 'completed'}, 7, 'bad', null], '合法任务-dsh-非对象'],
    ['tdNormal', [{content: '合法任务-dsh-正常', status: 'completed'}], '合法任务-dsh-正常'],
  ];
  const writeDTodo = (id, content) => mkdir(join(wsTodoD, id), {recursive: true})
    .then(() => writeFile(join(wsTodoD, id, 'session.v4.jsonl.zstd'),
      zlib.zstdCompressSync(Buffer.from(content, 'utf8'))));
  for (const [id] of dTodoCases) await writeDTodo(id, dTodoBase(id));
  await writeDTodo('tdOtherBusy', dTodoBase('tdOtherBusy'));
  const srcTodoD = dsh.create({root: root13, activeMs: 999999999, live: {push() {}}});
  await srcTodoD.scan(true);                                  // ① 旧快照：四个会话都在运行
  const stTodoDBase = srcTodoD.stats();
  for (const [id, todos] of dTodoCases) {
    await writeDTodo(id, dTodoBase(id) + [
      rec('todo/write', 4, 2200, {todos}),
      rec('user/message', 5, 2300, {source: {kind: 'user'}, content: '结束前的消息-' + id}),
      rec('turn/end', 6, 2400, {turn: 1}),
    ].join(''));                                               // ② 追加坏 todo + turn/end
  }
  await srcTodoD.scan(false);                                 // ③ 修复后整份日志应能折叠完成
  const stTodoD = srcTodoD.stats();
  const sTodoDOf = id => srcTodoD.sessions().find(x => x.id === id);
  const sTodoDOther = sTodoDOf('tdOtherBusy');
  const dTodoResults = dTodoCases.map(([id, , valid]) => {
    const s0 = sTodoDOf(id);
    return {id, s: s0, valid,
      ok: !!s0 && s0.turnOpen === false && s0.current === null && s0.openStep === null
        && s0.todos.length === 1 && s0.todos[0].content === valid
        && s0.msgs.some(m => m.text.includes('结束前的消息-' + id))};
  });
  await rm(root13, {recursive: true, force: true});

  checks.push(['DSH 坏 todo 基线：四个会话都在运行',
    stTodoDBase.sessions === 4 && stTodoDBase.running === 4, JSON.stringify(stTodoDBase)]);
  for (const r of dTodoResults) {
    checks.push([`DSH todo 数组含坏成员（${r.id}）：fold 继续、turn/end 收尾、合法项保留、后续消息不丢`,
      r.ok, JSON.stringify(r.s && {turnOpen: r.s.turnOpen, current: !!(r.s && r.s.current),
        openStep: r.s.openStep, todos: r.s.todos, msgs: r.s.msgs.map(m => m.text)})]);
  }
  checks.push(['DSH todo 坏成员不影响其它会话',
    !!sTodoDOther && !!sTodoDOther.current && sTodoDOther.id === 'tdOtherBusy',
    JSON.stringify(sTodoDOther && {id: sTodoDOther.id, current: !!sTodoDOther.current})]);
  checks.push(['DSH todo 坏成员不误标 stale、只统计真正在跑的会话',
    stTodoD.sessions === 4 && stTodoD.running === 1 && stTodoD.stale === false, JSON.stringify(stTodoD)]);

  /* 复核 v2.39 第 4 条：同一会话在普通/压缩两种格式间切换时，事件进度按逻辑会话迁移；
     相同历史不重推、新追加事件仍发出；两格式反复出现/消失也不重推。 */
  const root14 = await mkdtemp(join(tmpdir(), 'dsh-migrate-'));
  const sid14 = join(root14, 'ws14', 'smg');
  await mkdir(sid14, {recursive: true});
  const plain14 = join(sid14, 'session.v4.jsonl');
  const zstd14 = join(sid14, 'session.v4.jsonl.zstd');
  const migBase = [
    rec('session', 1, 1000, {id: 'smg', cwd: 'D:\\wMig'}),
    rec('tool/call', 2, 2000, {callId: 'c-m1', name: 'bash', arguments: '{"command":"echo old"}'}),
  ].join('');
  const migEnding = rec('turn/end', 3, 3000, {turn: 1});
  const migPlain = (extra = '') => migBase + (extra || '');
  const migZstd = (extra = '') => migBase + migEnding + (extra || '');
  const pushed14 = [];
  const src14 = dsh.create({root: root14, activeMs: 999999999,
    live: {push(it) { pushed14.push(it); }}, listIntervalMs: 0});
  await writeFile(plain14, migPlain());
  await src14.scan(true);                                     // ① 普通版首次：1 条调用事件
  const n14a = pushed14.length;
  await writeFile(zstd14, zlib.zstdCompressSync(Buffer.from(migZstd(), 'utf8')));
  await src14.scan(false);                                    // ② 普通 → 压缩：相同历史 + turn/end
  const n14b = pushed14.length;
  const st14b = src14.stats();
  await writeFile(zstd14, zlib.zstdCompressSync(Buffer.from(migZstd(
    rec('user/message', 4, 4000, {source: {kind: 'user'}, content: '普通转压缩后的新消息'})), 'utf8')));
  await src14.scan(false);                                    // ③ 新追加事件仍要发出
  const n14c = pushed14.length;
  await rm(zstd14, {force: true});
  await writeFile(plain14, migPlain(migEnding
    + rec('user/message', 4, 4000, {source: {kind: 'user'}, content: '普通转压缩后的新消息'})
    + rec('user/message', 5, 5000, {source: {kind: 'user'}, content: '压缩转普通后的新消息'})));
  await src14.scan(false);                                    // ④ 压缩 → 普通：进度沿用
  const n14d = pushed14.length;
  await writeFile(zstd14, zlib.zstdCompressSync(Buffer.from(migZstd(
    rec('user/message', 4, 4000, {source: {kind: 'user'}, content: '普通转压缩后的新消息'})
    + rec('user/message', 5, 5000, {source: {kind: 'user'}, content: '压缩转普通后的新消息'})
    + rec('user/message', 6, 6000, {source: {kind: 'user'}, content: '反复切换后的新消息'})), 'utf8')));
  await src14.scan(false);                                    // ⑤ 普通 → 再次压缩
  const n14e = pushed14.length;
  await rm(zstd14, {force: true});
  await writeFile(plain14, migPlain(migEnding
    + rec('user/message', 4, 4000, {source: {kind: 'user'}, content: '普通转压缩后的新消息'})
    + rec('user/message', 5, 5000, {source: {kind: 'user'}, content: '压缩转普通后的新消息'})
    + rec('user/message', 6, 6000, {source: {kind: 'user'}, content: '反复切换后的新消息'})
    + rec('user/message', 7, 7000, {source: {kind: 'user'}, content: '回到普通后的新消息'})));
  await src14.scan(false);                                    // ⑥ 再次压缩 → 普通
  const n14f = pushed14.length;
  const st14f = src14.stats();
  const ss14f = src14.sessions();
  const names14 = pushed14.map(it => String(it.name || ''));
  const oldCall14 = names14.filter(n => /echo old/.test(n)).length;
  await rm(root14, {recursive: true, force: true});

  checks.push(['事件迁移基线：普通版首次 1 条事件', n14a === 1, `事件数=${n14a} names=${JSON.stringify(names14)}`]);
  checks.push(['普通 → 压缩：相同历史不重推（事件数仍 1、会话 1、running=0、stale=false）',
    n14b === 1 && st14b.sessions === 1 && st14b.running === 0 && st14b.stale === false,
    JSON.stringify({n: n14b, ...st14b, names: names14})]);
  checks.push(['迁移后新追加事件仍发出（+1）', n14c === 2, `事件数=${n14c} names=${JSON.stringify(names14)}`]);
  checks.push(['压缩 → 普通：进度沿用、不重推旧调用（+1）', n14d === 3, `事件数=${n14d} names=${JSON.stringify(names14)}`]);
  checks.push(['两格式反复出现：压缩版回来不重推（+1）', n14e === 4, `事件数=${n14e} names=${JSON.stringify(names14)}`]);
  checks.push(['两格式反复出现：普通版回来不重推（+1）', n14f === 5, `事件数=${n14f} names=${JSON.stringify(names14)}`]);
  checks.push(['迁移全程：旧调用事件只发一次、sessions=1、编号唯一、stale=false',
    oldCall14 === 1 && ss14f.length === 1 && uniq11(ss14f.map(s => s.id))
      && st14f.sessions === 1 && st14f.stale === false,
    JSON.stringify({oldCall: oldCall14, n: ss14f.length, ...st14f, ids: ss14f.map(s => s.id)})]);

  /* ---- 复核 v2.40 第 2/3/4 条（DSH）----
     zframes/zjoin 构造「拼接的 zstd 帧」，每个 JSON 行一帧，跟真实 DSH 的追加写法一致。 */
  const zframes = ls => ls.map(l => zlib.zstdCompressSync(Buffer.from(l, 'utf8')));
  const zjoin = ls => Buffer.concat(zframes(ls));

  /* 复核 v2.40 第 2 条：迁移保护要覆盖「选择 → stat → 读取 → 解析 → 提交」全阶段。
     普通版已缓存并在运行，出现有效压缩版；候选枚举的第一次 stat 成功、扫描解码前的第二次 stat EACCES。
     修复前：第二次 stat 直接 continue，清理把未入列表的普通版当删除，唯一完整快照被清掉（sessions=0）。 */
  const root15 = await mkdtemp(join(tmpdir(), 'dsh-mig-stat2-'));
  const sid15 = join(root15, 'ws15', 'sst');
  await mkdir(sid15, {recursive: true});
  const plain15 = join(sid15, 'session.v4.jsonl');
  const zstd15 = join(sid15, 'session.v4.jsonl.zstd');
  const log15 = extra => [
    rec('session', 1, 1000, {id: 'sst', cwd: 'D:\\wStatMig'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '迁移 stat 历史'}),
    rec('tool/call', 3, 3000, {callId: 'c-sst', name: 'bash', arguments: '{"command":"sleep 1"}'}),
  ].join('') + (extra || '');
  await writeFile(plain15, log15(''));
  let stat15First = false;          // 让「枚举那次 stat」成功
  let stat15FailSecond = false;     // 紧接着「扫描解码前那次 stat」失败
  const io15 = {
    readdir: (p, o) => realReaddir(p, o),
    readFile: (p, o) => realReadFile(p, o),
    stat: (p, o) => {
      if (stat15FailSecond && String(p) === zstd15) {
        if (!stat15First) { stat15First = true; return realStat(p, o); }
        throw Object.assign(new Error('EACCES: permission denied, stat ' + p), {code: 'EACCES'});
      }
      return realStat(p, o);
    },
  };
  const pushed15 = [];
  const src15 = dsh.create({root: root15, activeMs: 999999999,
    live: {push(it) { pushed15.push(it); }}, io: io15, listIntervalMs: 0});
  await src15.scan(true);                                       // ① 只有普通版
  const st15a = src15.stats();
  const n15a = pushed15.length;
  await writeFile(zstd15, zlib.zstdCompressSync(Buffer.from(log15(rec('turn/end', 4, 4000, {turn: 1})), 'utf8')));
  stat15FailSecond = true; stat15First = false;
  await src15.scan(false);                                      // ② 枚举 stat 成功 + 扫描 stat EACCES
  const st15b = src15.stats();
  const s15b = src15.sessions().find(x => x.id === 'sst');
  const n15b = pushed15.length;
  stat15FailSecond = false;
  await src15.scan(false);                                      // ③ 恢复：压缩版成功提交
  const st15c = src15.stats();
  const s15c = src15.sessions().find(x => x.id === 'sst');
  const n15c = pushed15.length;
  await rm(root15, {recursive: true, force: true});

  checks.push(['v2.40 迁移第二次 stat 失败基线：普通版 1 会话 / 1 文件 / 运行中 / 2 条事件',
    st15a.sessions === 1 && st15a.files === 1 && st15a.running === 1 && st15a.stale === false && n15a === 2,
    JSON.stringify({...st15a, n: n15a})]);
  checks.push(['枚举 stat 成功、扫描前 stat EACCES：保留旧普通版快照、仍在运行、sessions=1、stale=true',
    st15b.sessions === 1 && st15b.files === 1 && st15b.running === 1 && st15b.stale === true
      && !!s15b && s15b.file === plain15 && s15b.msgs.some(m => m.text.includes('迁移 stat 历史'))
      && n15b === n15a,
    JSON.stringify({...st15b, n: n15b, file: s15b && s15b.file, msgs: s15b && s15b.msgs.map(m => m.text)})]);
  checks.push(['stat 恢复后：压缩版成唯一快照、运行结束、stale=false、旧调用不重推、files=1',
    st15c.sessions === 1 && st15c.files === 1 && st15c.running === 0 && st15c.stale === false
      && !!s15c && s15c.file === zstd15 && n15c === n15a,
    JSON.stringify({...st15c, n: n15c, file: s15c && s15c.file, current: !!(s15c && s15c.current)})]);

  /* 复核 v2.40 第 3 条：新压缩格式只写了一半（完整帧 + 半个尾帧）时不能被当成完整快照。
     sp1 普通版调用未结束（运行中），sp2 普通版已完成；压缩版分别把调用帧 / 结果帧写一半。
     修复前：半帧被静默忽略后仍算迁移成功，旧快照被删、进度重置，补齐后旧调用重推。 */
  const root16 = await mkdtemp(join(tmpdir(), 'dsh-partial-'));
  const sp1 = join(root16, 'ws16', 'sp1'), sp2 = join(root16, 'ws16', 'sp2');
  await mkdir(sp1, {recursive: true});
  await mkdir(sp2, {recursive: true});
  const p1Plain = join(sp1, 'session.v4.jsonl'), p1Zstd = join(sp1, 'session.v4.jsonl.zstd');
  const p2Plain = join(sp2, 'session.v4.jsonl'), p2Zstd = join(sp2, 'session.v4.jsonl.zstd');
  const p1Lines = [
    rec('session', 1, 1000, {id: 'sp1', cwd: 'D:\\wPartial'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '尾帧写一半的历史'}),
    rec('tool/call', 3, 3000, {callId: 'c-p1', name: 'bash', arguments: '{"command":"sleep 1"}'}),
  ];
  const p2Lines = [
    rec('session', 1, 1000, {id: 'sp2', cwd: 'D:\\wPartial2'}),
    rec('tool/call', 2, 2000, {callId: 'c-p2', name: 'bash', arguments: '{"command":"sleep 1"}'}),
    rec('tool/result', 3, 3000, {toolCallId: 'c-p2', message: {content: 'ok'}}),
    rec('turn/end', 4, 4000, {turn: 1}),
  ];
  await writeFile(p1Plain, p1Lines.join(''));
  await writeFile(p2Plain, p2Lines.join(''));
  const pushed16 = [];
  const src16 = dsh.create({root: root16, activeMs: 999999999,
    live: {push(it) { pushed16.push(it); }}, listIntervalMs: 0});
  await src16.scan(true);                                       // ① 两个普通版会话
  const st16a = src16.stats();
  const s16Of = id => src16.sessions().find(x => x.id === id);
  const n16a = pushed16.length;
  const p1Frames = zframes(p1Lines), p2Frames = zframes(p2Lines);
  const half = f => f.subarray(0, Math.max(1, f.length >> 1));
  await writeFile(p1Zstd, Buffer.concat([...p1Frames.slice(0, 2), half(p1Frames[2])]));
  await writeFile(p2Zstd, Buffer.concat([...p2Frames.slice(0, 2), half(p2Frames[2])]));
  await src16.scan(false);                                      // ② 压缩版尾帧只写一半
  const st16b = src16.stats();
  const s16b1 = s16Of('sp1'), s16b2 = s16Of('sp2');
  const n16b = pushed16.length;
  await writeFile(p1Zstd, zjoin(p1Lines));                      // ③ 补齐：与普通版同历史
  await writeFile(p2Zstd, zjoin(p2Lines));
  await src16.scan(false);
  const st16c = src16.stats();
  const s16c1 = s16Of('sp1'), s16c2 = s16Of('sp2');
  const n16c = pushed16.length;
  await writeFile(p1Zstd, zjoin([...p1Lines,                      // ④ 补齐后追加新记录
    rec('user/message', 4, 4000, {source: {kind: 'user'}, content: '补齐后的新消息'}),
    rec('tool/result', 5, 5000, {toolCallId: 'c-p1', message: {content: 'ok'}}),
  ]));
  await src16.scan(false);
  const st16d = src16.stats();
  const s16d1 = s16Of('sp1');
  const n16d = pushed16.length;
  await rm(root16, {recursive: true, force: true});

  checks.push(['v2.40 尾帧基线：两个普通版会话 / 两个文件 / 一个运行中 / 3 条事件',
    st16a.sessions === 2 && st16a.files === 2 && st16a.running === 1 && st16a.stale === false && n16a === 3,
    JSON.stringify({...st16a, n: n16a})]);
  checks.push(['压缩版尾帧只写一半：保留普通版旧快照与进度、sessions=2、running=1、stale=true、不重推',
    st16b.sessions === 2 && st16b.files === 2 && st16b.running === 1 && st16b.stale === true
      && n16b === n16a && !!s16b1 && s16b1.file === p1Plain && !!s16b1.current
      && !!s16b2 && s16b2.file === p2Plain && s16b2.done === 1,
    JSON.stringify({...st16b, n: n16b, f1: s16b1 && s16b1.file, cur1: !!(s16b1 && s16b1.current),
      f2: s16b2 && s16b2.file, done2: s16b2 && s16b2.done})]);
  checks.push(['尾帧补齐后：改用压缩版快照、相同历史不重推、运行状态不倒退、stale=false',
    st16c.sessions === 2 && st16c.running === 1 && st16c.stale === false && n16c === n16a
      && !!s16c1 && s16c1.file === p1Zstd && !!s16c1.current
      && !!s16c2 && s16c2.file === p2Zstd && s16c2.done === 1 && !s16c2.current,
    JSON.stringify({...st16c, n: n16c, f1: s16c1 && s16c1.file, f2: s16c2 && s16c2.file,
      done2: s16c2 && s16c2.done})]);
  checks.push(['尾帧补齐后新追加才发事件（+1）、旧调用不重推、运行结束',
    st16d.stale === false && st16d.running === 0 && n16d === n16a + 1
      && !!s16d1 && s16d1.msgs.some(m => m.text.includes('补齐后的新消息')),
    JSON.stringify({...st16d, n: n16d, msgs: s16d1 && s16d1.msgs.map(m => m.text)})]);

  /* 没有旧快照时读到半帧：不能把半份日志当成完整快照提交，先标 stale，补齐后再读入。 */
  const root17 = await mkdtemp(join(tmpdir(), 'dsh-partial-fresh-'));
  const sfr = join(root17, 'ws17', 'sfresh');
  await mkdir(sfr, {recursive: true});
  const sfrZstd = join(sfr, 'session.v4.jsonl.zstd');
  const sfrLines = [
    rec('session', 1, 1000, {id: 'sfresh', cwd: 'D:\\wFresh'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '首次就只剩半帧'}),
  ];
  const sfrFrames = zframes(sfrLines);
  await writeFile(sfrZstd, Buffer.concat([sfrFrames[0], half(sfrFrames[1])]));
  const pushed17 = [];
  const src17 = dsh.create({root: root17, activeMs: 999999999,
    live: {push(it) { pushed17.push(it); }}, listIntervalMs: 0});
  await src17.scan(true);
  const st17a = src17.stats();
  await writeFile(sfrZstd, zjoin(sfrLines));
  await src17.scan(false);
  const st17b = src17.stats();
  const s17b = src17.sessions().find(x => x.id === 'sfresh');
  await rm(root17, {recursive: true, force: true});

  checks.push(['没有旧快照时尾帧不完整：不提交半份快照、标 stale、sessions=0',
    st17a.sessions === 0 && st17a.stale === true, JSON.stringify(st17a)]);
  checks.push(['首次尾帧补齐后：正常读入会话、stale 归假',
    st17b.sessions === 1 && st17b.stale === false && !!s17b
      && s17b.msgs.some(m => m.text.includes('首次就只剩半帧')),
    JSON.stringify({...st17b, msgs: s17b && s17b.msgs.map(m => m.text)})]);

  /* 复核 v2.40 第 3 条补测：日志换代判定不能只看 maxSeq 变小。
     ① 事件身份无交集 + 会话 cwd 变了 → 真换代：改用新快照，新代记录进事件流；
     ② 事件身份有交集（maxSeq 更小的同代副本）→ 不重置进度、不重推，后续追加才发事件。 */
  const root18 = await mkdtemp(join(tmpdir(), 'dsh-gen-new-'));
  const sgn = join(root18, 'ws18', 'snew');
  await mkdir(sgn, {recursive: true});
  const sgnPlain = join(sgn, 'session.v4.jsonl'), sgnZstd = join(sgn, 'session.v4.jsonl.zstd');
  await writeFile(sgnPlain, [
    rec('session', 1, 1000, {id: 'snew', cwd: 'D:\\wGenOld'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '旧代历史'}),
    rec('tool/call', 3, 3000, {callId: 'c-old', name: 'bash', arguments: '{"command":"echo old"}'}),
  ].join(''));
  const pushed18 = [];
  const src18 = dsh.create({root: root18, activeMs: 999999999,
    live: {push(it) { pushed18.push(it); }}, listIntervalMs: 0});
  await src18.scan(true);
  const n18a = pushed18.length;
  await writeFile(sgnZstd, zjoin([
    rec('session', 1, 8000, {id: 'snew', cwd: 'D:\\wGenNew'}),
    rec('user/message', 2, 8100, {source: {kind: 'user'}, content: '新一代历史'}),
  ]));
  await src18.scan(false);
  const st18 = src18.stats();
  const s18 = src18.sessions().find(x => x.id === 'snew');
  const n18b = pushed18.length;
  const names18 = pushed18.map(it => String(it.name || ''));
  await rm(root18, {recursive: true, force: true});

  checks.push(['换代日志（事件身份无交集、maxSeq 变小）：改用新快照、不沿用旧进度',
    st18.sessions === 1 && st18.files === 1 && st18.running === 0 && st18.stale === false
      && !!s18 && s18.cwd === 'D:\\wGenNew' && s18.msgs.some(m => m.text.includes('新一代历史'))
      && !s18.msgs.some(m => m.text.includes('旧代历史')),
    JSON.stringify({...st18, cwd: s18 && s18.cwd, msgs: s18 && s18.msgs.map(m => m.text)})]);
  checks.push(['换代日志：新代记录进入事件流（不是静默吞掉）',
    n18b > n18a && names18.some(n => n.includes('新一代历史')),
    JSON.stringify({n: n18b, names: names18})]);

  const root19 = await mkdtemp(join(tmpdir(), 'dsh-gen-same-'));
  const sgs = join(root19, 'ws19', 'ssame');
  await mkdir(sgs, {recursive: true});
  const sgsPlain = join(sgs, 'session.v4.jsonl'), sgsZstd = join(sgs, 'session.v4.jsonl.zstd');
  const sgsLines = [
    rec('session', 1, 1000, {id: 'ssame', cwd: 'D:\\wGenSame'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '同代历史一'}),
    rec('tool/call', 3, 3000, {callId: 'c-same', name: 'bash', arguments: '{"command":"sleep 1"}'}),
    rec('user/message', 4, 4000, {source: {kind: 'user'}, content: '同代历史二'}),
    rec('tool/result', 5, 5000, {toolCallId: 'c-same', message: {content: 'ok'}}),
    rec('turn/end', 6, 6000, {turn: 1}),
  ];
  await writeFile(sgsPlain, sgsLines.join(''));
  const pushed19 = [];
  const src19 = dsh.create({root: root19, activeMs: 999999999,
    live: {push(it) { pushed19.push(it); }}, listIntervalMs: 0});
  await src19.scan(true);
  const n19a = pushed19.length;
  await writeFile(sgsZstd, zjoin(sgsLines.slice(0, 5)));        // maxSeq=5 < 旧 seenSeq=6，但历史有交集
  await src19.scan(false);
  const st19 = src19.stats();
  const s19 = src19.sessions().find(x => x.id === 'ssame');
  const n19b = pushed19.length;
  await writeFile(sgsZstd, zjoin([...sgsLines,
    rec('user/message', 7, 7000, {source: {kind: 'user'}, content: '同代新追加'})]));
  await src19.scan(false);
  const st19c = src19.stats();
  const s19c = src19.sessions().find(x => x.id === 'ssame');
  const n19c = pushed19.length;
  await rm(root19, {recursive: true, force: true});

  checks.push(['同一代短副本（maxSeq 变小但有事件身份交集）：不重置进度、不重推、不误判换代',
    st19.sessions === 1 && st19.stale === false && n19b === n19a
      && !!s19 && s19.file === sgsZstd && !s19.current,
    JSON.stringify({...st19, n: n19b, file: s19 && s19.file, current: !!(s19 && s19.current)})]);
  checks.push(['同一代副本后续新追加：只发新事件（+1）',
    st19c.stale === false && n19c === n19a + 1
      && !!s19c && s19c.msgs.some(m => m.text.includes('同代新追加')),
    JSON.stringify({...st19c, n: n19c, msgs: s19c && s19c.msgs.map(m => m.text)})]);

  /* 复核 v2.40 第 4 条（DSH）：读取前不能因为 stat 体积变小就先删旧快照。
     变小 + readFile EACCES 要保留旧快照与运行状态、标 stale；只有读取成功后才提交变化：
     有效较小内容替换、损坏内容保留旧快照、确认空文件才作废。 */
  const root20 = await mkdtemp(join(tmpdir(), 'dsh-shrink-'));
  const sshr = join(root20, 'ws20', 'sshrink');
  await mkdir(sshr, {recursive: true});
  const shrFile = join(sshr, 'session.v4.jsonl');
  const shrLog = extra => [
    rec('session', 1, 1000, {id: 'sshrink', cwd: 'D:\\wShrink'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '变小前的初始消息'}),
    rec('tool/call', 3, 3000, {callId: 'c-shrink', name: 'bash', arguments: '{"command":"sleep 1"}'}),
  ].join('') + (extra || '');
  await writeFile(shrFile, shrLog(''));
  const shrShort = [
    rec('session', 1, 1000, {id: 'sshrink', cwd: 'D:\\wShrink'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '变小后的有效内容'}),
  ].join('');
  const shrCorrupt = '{"broken":\n';
  let shrReadFail = false;
  const io20 = {
    readdir: (p, o) => realReaddir(p, o),
    stat: (p, o) => realStat(p, o),
    readFile: (p, o) => {
      if (shrReadFail && String(p) === shrFile) {
        throw Object.assign(new Error('EACCES: permission denied, open ' + p), {code: 'EACCES'});
      }
      return realReadFile(p, o);
    },
  };
  const pushed20 = [];
  const src20 = dsh.create({root: root20, activeMs: 999999999,
    live: {push(it) { pushed20.push(it); }}, io: io20, listIntervalMs: 0});
  await src20.scan(true);                                       // ① 长日志：运行中
  const st20a = src20.stats();
  const n20a = pushed20.length;
  const shrSizeLong = (await realStat(shrFile)).size;
  await writeFile(shrFile, shrShort);                           // ② 变小 + 读取失败
  shrReadFail = true;
  await src20.scan(false);
  const st20b = src20.stats();
  const s20b = src20.sessions().find(x => x.id === 'sshrink');
  const n20b = pushed20.length;
  shrReadFail = false;                                          // ③ 恢复读取：有效较小内容才替换
  await src20.scan(false);
  const st20c = src20.stats();
  const s20c = src20.sessions().find(x => x.id === 'sshrink');
  const st20bc = await realStat(shrFile);
  await writeFile(shrFile, shrCorrupt);                         // ④ 变小 + 损坏内容（读取成功、无记录）
  await src20.scan(false);
  const st20d = src20.stats();
  const s20d = src20.sessions().find(x => x.id === 'sshrink');
  await writeFile(shrFile, shrShort);                           // ⑤ 恢复有效
  await src20.scan(false);
  const st20e = src20.stats();
  await writeFile(shrFile, '');                                 // ⑥ 确认空文件 → 作废
  await src20.scan(false);
  const st20f = src20.stats();
  await writeFile(shrFile, shrLog(
    rec('user/message', 4, 4000, {source: {kind: 'user'}, content: '清空后重建的消息'})));
  await src20.scan(false);                                      // ⑦ 重建后恢复
  const st20g = src20.stats();
  const s20g = src20.sessions().find(x => x.id === 'sshrink');
  await rm(root20, {recursive: true, force: true});

  checks.push(['v2.40 变小基线：运行中 1 会话、1 文件、不 stale，且缩短内容确实更小',
    st20a.sessions === 1 && st20a.files === 1 && st20a.running === 1 && st20a.stale === false
      && Buffer.byteLength(shrShort) < shrSizeLong,
    JSON.stringify({...st20a, long: shrSizeLong, short: Buffer.byteLength(shrShort)})]);
  checks.push(['文件变小 + readFile EACCES：保留旧快照与运行状态、stale=true、不重推',
    st20b.sessions === 1 && st20b.running === 1 && st20b.stale === true && n20b === n20a
      && !!s20b && s20b.msgs.some(m => m.text.includes('变小前的初始消息'))
      && !s20b.msgs.some(m => m.text.includes('变小后的有效内容')),
    JSON.stringify({...st20b, n: n20b, msgs: s20b && s20b.msgs.map(m => m.text)})]);
  checks.push(['读取恢复后：有效较小内容替换旧快照、运行状态退出、stale=false',
    st20c.sessions === 1 && st20c.running === 0 && st20c.stale === false && !!s20c
      && s20c.msgs.some(m => m.text.includes('变小后的有效内容'))
      && !s20c.msgs.some(m => m.text.includes('变小前的初始消息'))
      && st20bc.size === Buffer.byteLength(shrShort),
    JSON.stringify({...st20c, msgs: s20c && s20c.msgs.map(m => m.text)})]);
  checks.push(['文件变小 + 损坏内容：保留旧快照、sessions=1、stale=true',
    st20d.sessions === 1 && st20d.stale === true && !!s20d
      && s20d.msgs.some(m => m.text.includes('变小后的有效内容')),
    JSON.stringify({...st20d, msgs: s20d && s20d.msgs.map(m => m.text)})]);
  checks.push(['损坏内容恢复有效后：stale 归假、旧快照被替换',
    st20e.sessions === 1 && st20e.stale === false && st20e.files === 1, JSON.stringify(st20e)]);
  checks.push(['确认空文件（读取成功且 0 字节）：旧快照作废、sessions=0、stale=false',
    st20f.sessions === 0 && st20f.stale === false, JSON.stringify(st20f)]);
  checks.push(['清空后重建日志：会话恢复、能读到新内容、stale=false',
    st20g.sessions === 1 && st20g.stale === false && !!s20g
      && s20g.msgs.some(m => m.text.includes('清空后重建的消息')),
    JSON.stringify({...st20g, msgs: s20g && s20g.msgs.map(m => m.text)})]);

  /* ---- 复核 v2.41 第 3 条（P2）：换代判定不能以「maxSeq 变小」为启动前提 ----
     同一路径整份替换为另一代日志（cwd / time / callId 全不同），两份历史没有交集：
     新代 maxSeq 等于、大于、小于旧游标时都要按新代进度发布；同代短副本仍沿用高水位。 */

  /* ① 新代 maxSeq 与旧游标相同（旧逻辑根本不做代际判断） */
  const root21 = await mkdtemp(join(tmpdir(), 'dsh-gen-eq-'));
  const sge = join(root21, 'ws21', 'sgeq');
  await mkdir(sge, {recursive: true});
  const sgeFile = join(sge, 'session.v4.jsonl');
  await writeFile(sgeFile, [
    rec('session', 1, 1000, {id: 'sgeq', cwd: 'D:\\wGenEqOld'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '旧代消息甲'}),
    rec('tool/call', 3, 3000, {callId: 'c-eq-old', name: 'bash', arguments: '{"command":"echo old"}'}),
    rec('tool/result', 4, 4000, {toolCallId: 'c-eq-old', message: {isError: true, content: 'Process exited with code 7: 旧代失败甲'}}),
  ].join(''));
  const pushed21 = [];
  const src21 = dsh.create({root: root21, activeMs: 999999999,
    live: {push(it) { pushed21.push(it); }}, listIntervalMs: 0});
  await src21.scan(true);
  const n21a = pushed21.length;
  const s21a = src21.sessions().find(x => x.id === 'sgeq');
  await writeFile(sgeFile, [                                   // 同一路径替换：仍是 seq=1..4
    rec('session', 1, 8000, {id: 'sgeq', cwd: 'D:\\wGenEqNew'}),
    rec('user/message', 2, 8500, {source: {kind: 'user'}, content: '新代消息乙'}),
    rec('tool/call', 3, 8700, {callId: 'c-eq-new', name: 'read', arguments: '{"file_path":"/new/x"}'}),
    rec('tool/result', 4, 8900, {toolCallId: 'c-eq-new', message: {isError: true, content: 'EACCES: 新代失败乙'}}),
  ].join(''));
  await src21.scan(false);
  const st21 = src21.stats();
  const s21b = src21.sessions().find(x => x.id === 'sgeq');
  const n21b = pushed21.length;
  const names21 = pushed21.map(it => String(it.name || ''));
  await rm(root21, {recursive: true, force: true});

  checks.push(['换代基线（maxSeq 相同）：旧代 3 条事件、cwd 旧、failed=1',
    n21a === 3 && !!s21a && s21a.cwd === 'D:\\wGenEqOld' && s21a.failed === 1,
    JSON.stringify({n: n21a, cwd: s21a && s21a.cwd, failed: s21a && s21a.failed})]);
  checks.push(['换代（maxSeq 相同、历史无交集）：新代事件全部进入任务流（+3），旧代失败不重推',
    n21b === n21a + 3 && names21.filter(n => /旧代失败甲/.test(n)).length === 1
      && names21.some(n => /新代失败乙/.test(n)) && names21.some(n => /新代消息乙/.test(n)),
    JSON.stringify({n: n21b, names: names21})]);
  checks.push(['换代（maxSeq 相同）：快照换成新代 cwd/消息/失败，sessions=1、stale=false',
    st21.sessions === 1 && st21.files === 1 && st21.stale === false && !!s21b
      && s21b.cwd === 'D:\\wGenEqNew' && s21b.failed === 1
      && s21b.msgs.some(m => m.text.includes('新代消息乙'))
      && !s21b.msgs.some(m => m.text.includes('旧代消息甲')),
    JSON.stringify({...st21, cwd: s21b && s21b.cwd,
      msgs: s21b && s21b.msgs.map(m => m.text)})]);

  /* ② 新代 maxSeq 更大：失败在 seq=4、助手消息在 seq=5（旧逻辑只发 seq=5） */
  const root22 = await mkdtemp(join(tmpdir(), 'dsh-gen-big-'));
  const sgb = join(root22, 'ws22', 'sgeqbig');
  await mkdir(sgb, {recursive: true});
  const sgbFile = join(sgb, 'session.v4.jsonl');
  await writeFile(sgbFile, [
    rec('session', 1, 1000, {id: 'sgeqbig', cwd: 'D:\\wGenBigOld'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '旧代大消息'}),
    rec('tool/call', 3, 3000, {callId: 'c-big-old', name: 'bash', arguments: '{"command":"echo old"}'}),
    rec('tool/result', 4, 4000, {toolCallId: 'c-big-old', message: {isError: true, content: '旧代大失败'}}),
  ].join(''));
  const pushed22 = [];
  const src22 = dsh.create({root: root22, activeMs: 999999999,
    live: {push(it) { pushed22.push(it); }}, listIntervalMs: 0});
  await src22.scan(true);
  const n22a = pushed22.length;
  await writeFile(sgbFile, [                                   // 新代 seq=1..5
    rec('session', 1, 8000, {id: 'sgeqbig', cwd: 'D:\\wGenBigNew'}),
    rec('user/message', 2, 8100, {source: {kind: 'user'}, content: '新代大消息'}),
    rec('tool/call', 3, 8200, {callId: 'c-big-new', name: 'write', arguments: '{"file_path":"/new/y","content":"x"}'}),
    rec('tool/result', 4, 8300, {toolCallId: 'c-big-new', message: {isError: true, content: 'Process exited with code 3: 新代大失败'}}),
    rec('assistant/message', 5, 8400, {message: {content: [{type: 'text', text: '新代大收尾'}]}}),
  ].join(''));
  await src22.scan(false);
  const st22 = src22.stats();
  const s22b = src22.sessions().find(x => x.id === 'sgeqbig');
  const n22b = pushed22.length;
  const names22 = pushed22.map(it => String(it.name || ''));
  await rm(root22, {recursive: true, force: true});

  checks.push(['换代基线（maxSeq 更大）：旧代 3 条事件',
    n22a === 3, `事件数=${n22a} names=${JSON.stringify(names22)}`]);
  checks.push(['换代（maxSeq 更大、历史无交集）：新代失败（seq=4）与收尾消息（seq=5）都进任务流（+4）',
    n22b === n22a + 4 && names22.some(n => /新代大失败/.test(n))
      && names22.some(n => /新代大收尾/.test(n))
      && names22.filter(n => /旧代大失败/.test(n)).length === 1,
    JSON.stringify({n: n22b, names: names22})]);
  checks.push(['换代（maxSeq 更大）：快照换成新代 cwd/两条消息/失败，stale=false',
    st22.sessions === 1 && st22.stale === false && !!s22b
      && s22b.cwd === 'D:\\wGenBigNew' && s22b.failed === 1
      && s22b.msgs.some(m => m.text.includes('新代大消息'))
      && s22b.msgs.some(m => m.text.includes('新代大收尾'))
      && !s22b.msgs.some(m => m.text.includes('旧代大消息')),
    JSON.stringify({...st22, cwd: s22b && s22b.cwd,
      msgs: s22b && s22b.msgs.map(m => m.text)})]);

  /* ③ 新代 maxSeq 更小（对照：旧逻辑本来就能识别的方向） */
  const root23 = await mkdtemp(join(tmpdir(), 'dsh-gen-small-'));
  const sgm = join(root23, 'ws23', 'sgegsmall');
  await mkdir(sgm, {recursive: true});
  const sgmFile = join(sgm, 'session.v4.jsonl');
  await writeFile(sgmFile, [
    rec('session', 1, 1000, {id: 'sgegsmall', cwd: 'D:\\wGenSmallOld'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '旧代小消息'}),
    rec('tool/call', 3, 3000, {callId: 'c-small-old', name: 'bash', arguments: '{"command":"echo old"}'}),
    rec('tool/result', 4, 4000, {toolCallId: 'c-small-old', message: {isError: true, content: '旧代小失败'}}),
    rec('assistant/message', 5, 4500, {message: {content: [{type: 'text', text: '旧代收尾'}]}}),
  ].join(''));
  const pushed23 = [];
  const src23 = dsh.create({root: root23, activeMs: 999999999,
    live: {push(it) { pushed23.push(it); }}, listIntervalMs: 0});
  await src23.scan(true);
  const n23a = pushed23.length;
  await writeFile(sgmFile, [                                   // 新代 seq=1..2
    rec('session', 1, 8000, {id: 'sgegsmall', cwd: 'D:\\wGenSmallNew'}),
    rec('assistant/message', 2, 8100, {message: {content: [{type: 'text', text: '新代小消息'}]}}),
  ].join(''));
  await src23.scan(false);
  const st23 = src23.stats();
  const s23b = src23.sessions().find(x => x.id === 'sgegsmall');
  const n23b = pushed23.length;
  const names23 = pushed23.map(it => String(it.name || ''));
  await rm(root23, {recursive: true, force: true});

  checks.push(['换代（maxSeq 更小、历史无交集）：新代消息进入任务流（+1）、快照换代',
    st23.sessions === 1 && st23.stale === false && n23b === n23a + 1
      && names23.some(n => /新代小消息/.test(n)) && !!s23b
      && s23b.cwd === 'D:\\wGenSmallNew' && s23b.failed === 0
      && s23b.msgs.some(m => m.text.includes('新代小消息'))
      && !s23b.msgs.some(m => m.text.includes('旧代小消息')),
    JSON.stringify({n: n23b, ...st23, names: names23,
      cwd: s23b && s23b.cwd, msgs: s23b && s23b.msgs.map(m => m.text)})]);

  /* ④ cwd 相同但两份历史不相交：同样必须判定换代（不能靠 cwd 或 maxSeq 下降） */
  const root24 = await mkdtemp(join(tmpdir(), 'dsh-gen-samecwd-'));
  const sgc = join(root24, 'ws24', 'sgsamecwd');
  await mkdir(sgc, {recursive: true});
  const sgcFile = join(sgc, 'session.v4.jsonl');
  await writeFile(sgcFile, [
    rec('session', 1, 1000, {id: 'sgsamecwd', cwd: 'D:\\wGenSameCwd'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '同cwd旧消息'}),
    rec('tool/call', 3, 3000, {callId: 'c-sc-old', name: 'bash', arguments: '{"command":"echo old"}'}),
    rec('tool/result', 4, 4000, {toolCallId: 'c-sc-old', message: {isError: true, content: '同cwd旧失败'}}),
  ].join(''));
  const pushed24 = [];
  const src24 = dsh.create({root: root24, activeMs: 999999999,
    live: {push(it) { pushed24.push(it); }}, listIntervalMs: 0});
  await src24.scan(true);
  const n24a = pushed24.length;
  await writeFile(sgcFile, [
    rec('session', 1, 8000, {id: 'sgsamecwd', cwd: 'D:\\wGenSameCwd'}),
    rec('user/message', 2, 8500, {source: {kind: 'user'}, content: '同cwd新消息'}),
    rec('tool/call', 3, 8700, {callId: 'c-sc-new', name: 'read', arguments: '{"file_path":"/new/z"}'}),
    rec('tool/result', 4, 8900, {toolCallId: 'c-sc-new', message: {isError: true, content: 'EACCES: 同cwd新失败'}}),
  ].join(''));
  await src24.scan(false);
  const st24 = src24.stats();
  const s24b = src24.sessions().find(x => x.id === 'sgsamecwd');
  const n24b = pushed24.length;
  const names24 = pushed24.map(it => String(it.name || ''));
  await rm(root24, {recursive: true, force: true});

  checks.push(['换代（cwd 相同、历史无交集、maxSeq 相同）：新代事件进任务流（+3）、旧失败不重推',
    n24b === n24a + 3 && names24.some(n => /同cwd新失败/.test(n))
      && names24.some(n => /同cwd新消息/.test(n))
      && names24.filter(n => /同cwd旧失败/.test(n)).length === 1,
    JSON.stringify({n: n24b, names: names24})]);
  checks.push(['换代（cwd 相同）：快照换成新代消息/失败，sessions=1、stale=false',
    st24.sessions === 1 && st24.stale === false && !!s24b && s24b.failed === 1
      && s24b.msgs.some(m => m.text.includes('同cwd新消息'))
      && !s24b.msgs.some(m => m.text.includes('同cwd旧消息')),
    JSON.stringify({...st24, msgs: s24b && s24b.msgs.map(m => m.text)})]);

  /* ⑤ 普通 ↔ 压缩切换（同代）：已有历史身份交集，不能当成换代重推 */
  const root25 = await mkdtemp(join(tmpdir(), 'dsh-gen-format-'));
  const sgf = join(root25, 'ws25', 'sgfmt');
  await mkdir(sgf, {recursive: true});
  const sgfPlain = join(sgf, 'session.v4.jsonl');
  const sgfZstd = join(sgf, 'session.v4.jsonl.zstd');
  const sgfLines = [
    rec('session', 1, 1000, {id: 'sgfmt', cwd: 'D:\\wGenFmt'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '切换前历史'}),
    rec('tool/call', 3, 3000, {callId: 'c-fmt', name: 'bash', arguments: '{"command":"echo hi"}'}),
  ];
  await writeFile(sgfPlain, sgfLines.join(''));
  const pushed25 = [];
  const src25 = dsh.create({root: root25, activeMs: 999999999,
    live: {push(it) { pushed25.push(it); }}, listIntervalMs: 0});
  await src25.scan(true);
  const n25a = pushed25.length;
  await writeFile(sgfZstd, zjoin(sgfLines));                    // 同一历史换成压缩版
  await src25.scan(false);
  const st25b = src25.stats();
  const s25b = src25.sessions().find(x => x.id === 'sgfmt');
  const n25b = pushed25.length;
  await writeFile(sgfZstd, zjoin([...sgfLines,
    rec('user/message', 4, 4000, {source: {kind: 'user'}, content: '切换后追加'})]));
  await src25.scan(false);
  const st25c = src25.stats();
  const s25c = src25.sessions().find(x => x.id === 'sgfmt');
  const n25c = pushed25.length;
  await rm(root25, {recursive: true, force: true});

  checks.push(['换代判定补测·普通→压缩（同代）：同一历史不重推、快照切到压缩版',
    n25b === n25a && st25b.sessions === 1 && st25b.files === 1 && st25b.stale === false
      && !!s25b && s25b.file === sgfZstd,
    JSON.stringify({n: n25b, ...st25b, file: s25b && s25b.file})]);
  checks.push(['换代判定补测·普通→压缩后追加：只发新事件（+1）',
    n25c === n25a + 1 && st25c.stale === false && !!s25c
      && s25c.msgs.some(m => m.text.includes('切换后追加')),
    JSON.stringify({n: n25c, msgs: s25c && s25c.msgs.map(m => m.text)})]);

  /* ⑥ 同代短副本（同一路径，maxSeq 变小）：不重推；补齐后只发新记录 */
  const root26 = await mkdtemp(join(tmpdir(), 'dsh-gen-short-'));
  const sgs2 = join(root26, 'ws26', 'sgshort');
  await mkdir(sgs2, {recursive: true});
  const sgs2File = join(sgs2, 'session.v4.jsonl');
  const sgsOld = [
    rec('session', 1, 1000, {id: 'sgshort', cwd: 'D:\\wGenShort'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '短副本历史甲'}),
    rec('tool/call', 3, 3000, {callId: 'c-short', name: 'bash', arguments: '{"command":"echo short"}'}),
    rec('user/message', 4, 4000, {source: {kind: 'user'}, content: '短副本历史乙'}),
    rec('turn/end', 5, 5000, {turn: 1}),
  ];
  await writeFile(sgs2File, sgsOld.join(''));
  const pushed26 = [];
  const src26 = dsh.create({root: root26, activeMs: 999999999,
    live: {push(it) { pushed26.push(it); }}, listIntervalMs: 0});
  await src26.scan(true);
  const n26a = pushed26.length;
  await writeFile(sgs2File, sgsOld.slice(0, 3).join(''));       // 同代短副本：maxSeq 3 < 游标 5
  await src26.scan(false);
  const st26b = src26.stats();
  const s26b = src26.sessions().find(x => x.id === 'sgshort');
  const n26b = pushed26.length;
  await writeFile(sgs2File, [...sgsOld,
    rec('user/message', 6, 6000, {source: {kind: 'user'}, content: '短副本补齐消息'})].join(''));
  await src26.scan(false);
  const st26c = src26.stats();
  const s26c = src26.sessions().find(x => x.id === 'sgshort');
  const n26c = pushed26.length;
  const names26 = pushed26.map(it => String(it.name || ''));
  await rm(root26, {recursive: true, force: true});

  checks.push(['换代判定补测·同代短副本（同一路径，maxSeq 变小）：不重推、游标不倒退',
    n26b === n26a && st26b.stale === false && !!s26b && s26b.seenSeq === 5,
    JSON.stringify({n: n26b, ...st26b, seenSeq: s26b && s26b.seenSeq})]);
  checks.push(['换代判定补测·同代短副本补齐：只发补齐后的新事件（+1），旧历史不重推',
    n26c === n26a + 1 && st26c.stale === false && !!s26c
      && s26c.msgs.some(m => m.text.includes('短副本补齐消息'))
      && s26c.msgs.some(m => m.text.includes('短副本历史乙'))
      && names26.filter(n => /短副本历史甲/.test(n)).length === 1,
    JSON.stringify({n: n26c, names: names26, msgs: s26c && s26c.msgs.map(m => m.text)})]);

  /* ---- 复核 v2.41 第 7 条（P3）：活跃时间过滤不能挡住已有缓存的已知变化 ----
     保留「未知且久远的历史文件不主动读」。已有缓存只要 stat/size/mtime 证明变过，
     或有待恢复的读取/解析故障，就允许重读并在成功提交后按新 mtime 决定活跃度。 */
  const {utimes} = await import('node:fs/promises');
  const oldTime = new Date(Date.now() - 10 * 60_000);          // 远在活跃窗口外

  /* ⑦ 空闲缓存被清空，mtime 设到窗外：普通扫描应重读并确认清空 */
  const root27 = await mkdtemp(join(tmpdir(), 'dsh-active-clear-'));
  const sac = join(root27, 'ws27', 'sclr');
  await mkdir(sac, {recursive: true});
  const sacFile = join(sac, 'session.v4.jsonl');
  await writeFile(sacFile, [
    rec('session', 1, 1000, {id: 'sclr', cwd: 'D:\\wIdleClear'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '清空前消息'}),
    rec('tool/call', 3, 3000, {callId: 'c-idle', name: 'bash', arguments: '{"command":"echo hi"}'}),
    rec('tool/result', 4, 4000, {toolCallId: 'c-idle', message: {content: 'ok'}}),
    rec('turn/end', 5, 5000, {turn: 1}),
  ].join(''));
  const src27 = dsh.create({root: root27, activeMs: 60_000, live: {push() {}}, listIntervalMs: 0});
  await src27.scan(true);
  const st27a = src27.stats();
  await writeFile(sacFile, '');
  await utimes(sacFile, oldTime, oldTime);
  await src27.scan(false);
  const st27b = src27.stats();
  const ss27b = src27.sessions();
  await rm(root27, {recursive: true, force: true});

  checks.push(['活跃过滤基线（空闲、刚写过）：sessions=1、active=1',
    st27a.sessions === 1 && st27a.active === 1 && st27a.stale === false, JSON.stringify(st27a)]);
  checks.push(['已缓存空闲会话被清空、mtime 设到活跃窗外：普通扫描重读后 sessions=0、active=0',
    st27b.sessions === 0 && st27b.active === 0 && st27b.stale === false && ss27b.length === 0,
    JSON.stringify(st27b)]);

  /* ⑧ 空闲缓存被有效改写（mtime 窗外）：重读并提交，活跃度按新 mtime 归 0 */
  const root28 = await mkdtemp(join(tmpdir(), 'dsh-active-rewrite-'));
  const sar = join(root28, 'ws28', 'srew');
  await mkdir(sar, {recursive: true});
  const sarFile = join(sar, 'session.v4.jsonl');
  await writeFile(sarFile, [
    rec('session', 1, 1000, {id: 'srew', cwd: 'D:\\wIdleRewrite'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '超窗前旧消息'}),
    rec('tool/call', 3, 3000, {callId: 'c-rew', name: 'bash', arguments: '{"command":"echo old"}'}),
    rec('tool/result', 4, 4000, {toolCallId: 'c-rew', message: {content: 'ok'}}),
    rec('turn/end', 5, 5000, {turn: 1}),
  ].join(''));
  const src28 = dsh.create({root: root28, activeMs: 60_000, live: {push() {}}, listIntervalMs: 0});
  await src28.scan(true);
  const st28a = src28.stats();
  await writeFile(sarFile, [
    rec('session', 1, 1000, {id: 'srew', cwd: 'D:\\wIdleRewrite'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '超窗后新消息'}),
    rec('user/message', 3, 3000, {source: {kind: 'user'}, content: '超窗后新消息二'}),
  ].join(''));
  await utimes(sarFile, oldTime, oldTime);
  await src28.scan(false);
  const st28b = src28.stats();
  const s28b = src28.sessions().find(x => x.id === 'srew');
  await rm(root28, {recursive: true, force: true});

  checks.push(['活跃过滤基线（有效改写前）：sessions=1、active=1',
    st28a.sessions === 1 && st28a.active === 1 && st28a.stale === false, JSON.stringify(st28a)]);
  checks.push(['已缓存会话有效改写、mtime 超窗：重读并提交新内容，active 由新 mtime 决定（0）',
    st28b.sessions === 1 && st28b.active === 0 && st28b.stale === false && !!s28b
      && s28b.msgs.some(m => m.text.includes('超窗后新消息'))
      && !s28b.msgs.some(m => m.text.includes('超窗前旧消息')),
    JSON.stringify({...st28b, msgs: s28b && s28b.msgs.map(m => m.text)})]);

  /* ⑨ 已有缓存、内容已变但读取失败且 mtime 超窗；权限恢复后即使时间仍在窗外也要重读 */
  const root29 = await mkdtemp(join(tmpdir(), 'dsh-active-fault-'));
  const saf = join(root29, 'ws29', 'sfault');
  await mkdir(saf, {recursive: true});
  const safFile = join(saf, 'session.v4.jsonl');
  await writeFile(safFile, [
    rec('session', 1, 1000, {id: 'sfault', cwd: 'D:\\wFaultWin'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '超窗故障前消息'}),
    rec('tool/call', 3, 3000, {callId: 'c-fault', name: 'bash', arguments: '{"command":"echo old"}'}),
    rec('tool/result', 4, 4000, {toolCallId: 'c-fault', message: {content: 'ok'}}),
    rec('turn/end', 5, 5000, {turn: 1}),
  ].join(''));
  let faultReadFail = false;
  const ioF = {
    readdir: (p, o) => realReaddir(p, o),
    stat: (p, o) => realStat(p, o),
    readFile: (p, o) => {
      if (faultReadFail && String(p) === safFile) {
        throw Object.assign(new Error('EACCES: permission denied, open ' + p), {code: 'EACCES'});
      }
      return realReadFile(p, o);
    },
  };
  const src29 = dsh.create({root: root29, activeMs: 60_000, live: {push() {}},
    io: ioF, listIntervalMs: 0});
  await src29.scan(true);
  const st29a = src29.stats();
  await writeFile(safFile, [
    rec('session', 1, 1000, {id: 'sfault', cwd: 'D:\\wFaultWin'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '超窗故障前消息'}),
    rec('tool/call', 3, 3000, {callId: 'c-fault', name: 'bash', arguments: '{"command":"echo old"}'}),
    rec('tool/result', 4, 4000, {toolCallId: 'c-fault', message: {content: 'ok'}}),
    rec('turn/end', 5, 5000, {turn: 1}),
    rec('user/message', 6, 6000, {source: {kind: 'user'}, content: '超窗故障恢复消息'}),
  ].join(''));
  await utimes(safFile, oldTime, oldTime);
  faultReadFail = true;
  await src29.scan(false);                                      // ② 已变 + 读取失败：不能因久远而跳过
  const st29b = src29.stats();
  const s29b = src29.sessions().find(x => x.id === 'sfault');
  faultReadFail = false;
  await src29.scan(false);                                      // ③ 恢复但 mtime 仍超窗：必须重读
  const st29c = src29.stats();
  const s29c = src29.sessions().find(x => x.id === 'sfault');
  await rm(root29, {recursive: true, force: true});

  checks.push(['活跃过滤基线（故障前）：sessions=1、active=1、不 stale',
    st29a.sessions === 1 && st29a.active === 1 && st29a.stale === false, JSON.stringify(st29a)]);
  checks.push(['已缓存会话内容已变但读取失败、mtime 超窗：保留旧快照并标 stale（不能静默当成未变化）',
    st29b.sessions === 1 && st29b.stale === true && !!s29b
      && s29b.msgs.some(m => m.text.includes('超窗故障前消息'))
      && !s29b.msgs.some(m => m.text.includes('超窗故障恢复消息')),
    JSON.stringify({...st29b, msgs: s29b && s29b.msgs.map(m => m.text)})]);
  checks.push(['故障恢复、mtime 仍超窗：重读并提交新内容，stale=false、active 按新 mtime 为 0',
    st29c.sessions === 1 && st29c.stale === false && st29c.active === 0 && !!s29c
      && s29c.msgs.some(m => m.text.includes('超窗故障恢复消息')),
    JSON.stringify({...st29c, msgs: s29c && s29c.msgs.map(m => m.text)})]);

  /* ⑩ 未缓存的久远历史文件：普通扫描仍不主动读入（性能策略保留），预热仍可读 */
  const root30 = await mkdtemp(join(tmpdir(), 'dsh-active-unknown-'));
  const sau = join(root30, 'ws30', 'sunk');
  await mkdir(sau, {recursive: true});
  const sauFile = join(sau, 'session.v4.jsonl');
  await writeFile(sauFile, [
    rec('session', 1, 1000, {id: 'sunk', cwd: 'D:\\wOldUnknown'}),
    rec('user/message', 2, 2000, {source: {kind: 'user'}, content: '未缓存旧文件消息'}),
  ].join(''));
  await utimes(sauFile, oldTime, oldTime);
  const src30 = dsh.create({root: root30, activeMs: 60_000, live: {push() {}}, listIntervalMs: 0});
  await src30.scan(false);                                      // 普通扫描：不主动读未缓存的旧文件
  const st30a = src30.stats();
  await src30.scan(true);                                       // 启动预热：允许读最近的历史文件
  const st30b = src30.stats();
  const s30b = src30.sessions().find(x => x.id === 'sunk');
  await rm(root30, {recursive: true, force: true});

  checks.push(['未缓存的久远历史文件：普通扫描仍不主动读入（保留性能策略）',
    st30a.sessions === 0 && st30a.files === 1 && st30a.stale === false, JSON.stringify(st30a)]);
  checks.push(['未缓存旧文件在启动预热时仍可读入（预热策略保留），active 按旧 mtime 为 0',
    st30b.sessions === 1 && st30b.active === 0 && !!s30b
      && s30b.msgs.some(m => m.text.includes('未缓存旧文件消息')),
    JSON.stringify({...st30b, msgs: s30b && s30b.msgs.map(m => m.text)})]);

  let bad = 0;
  /* ================= 复核 v2.38 新增断言 ================= */

  /* ---- 第 3 条（P2）：源根目录 ENOENT 必须与 EACCES 区分 ----
     运行中会话已缓存 → 根目录 readdir EACCES（保留缓存）→ 真删根目录 → 连续两次扫描必须清空；
     删除后同路径重建，新目录要照常读入，旧运行会话不能复活。 */
  const dRootA = await mkdtemp(join(tmpdir(), 'dsh-v238-rootgone-'));
  const dNormV238 = p => String(p).replace(/[\\/]+$/, '');
  const dSidA = join(dRootA, 'wsRootA', 'sa');
  await mkdir(dSidA, {recursive: true});
  await writeFile(join(dSidA, 'session.v4.jsonl'), [
    rec('session', 1, 1000, {id: 'sa', cwd: 'D:\\wRootGone'}),
    rec('tool/call', 2, 2000, {callId: 'c-root-gone', name: 'bash', arguments: '{"command":"sleep 1"}'}),
  ].join(''));
  let dRootFail = false;
  const dIoA = {
    readdir: (p, o) => {
      if (dRootFail && dNormV238(p) === dNormV238(dRootA)) {
        throw Object.assign(new Error('EACCES: permission denied, scandir ' + p), {code: 'EACCES'});
      }
      return realReaddir(p, o);
    },
    readFile: (p, o) => realReadFile(p, o),
    stat: (p, o) => realStat(p, o),
  };
  const dSrcA = dsh.create({root: dRootA, activeMs: 999999999, live: {push() {}}, io: dIoA, listIntervalMs: 0});
  await dSrcA.scan(true);
  const dStA0 = dSrcA.stats();
  dRootFail = true;                                             // ① 根目录暂时读不到（EACCES）
  await dSrcA.scan(false);
  const dStA1 = dSrcA.stats();
  dRootFail = false;
  await rm(dRootA, {recursive: true, force: true});             // ② 真正删除整个源根目录
  await dSrcA.scan(false);
  const dStA2 = dSrcA.stats();
  await dSrcA.scan(false);                                      // ③ 删除后连续第二次扫描
  const dStA3 = dSrcA.stats();
  await mkdir(join(dRootA, 'wsRootA', 'sb'), {recursive: true}); // ④ 同路径重建
  await writeFile(join(dRootA, 'wsRootA', 'sb', 'session.v4.jsonl'), [
    rec('session', 1, 5000, {id: 'sb', cwd: 'D:\\wRootRebuild'}),
    rec('user/message', 2, 5100, {source: {kind: 'user'}, content: '重建后的新会话'}),
    rec('turn/end', 3, 5200, {turn: 1}),
  ].join(''));
  await dSrcA.scan(false);
  const dStA4 = dSrcA.stats();
  const dSsA4 = dSrcA.sessions();
  await rm(dRootA, {recursive: true, force: true});

  checks.push(['根目录 ENOENT 基线：运行中会话已缓存、不 stale',
    dStA0.sessions === 1 && dStA0.running === 1 && dStA0.stale === false, JSON.stringify(dStA0)]);
  checks.push(['根目录 readdir EACCES：保留缓存与运行状态、stale=true（不是确认删除）',
    dStA1.sessions === 1 && dStA1.running === 1 && dStA1.stale === true, JSON.stringify(dStA1)]);
  checks.push(['先读失败后真删根目录：第一次扫描就清空旧缓存（sessions=0、running=0、stale=false）',
    dStA2.sessions === 0 && dStA2.running === 0 && dStA2.files === 0 && dStA2.stale === false,
    JSON.stringify(dStA2)]);
  checks.push(['根目录确认删除后连续第二次扫描：仍为空、stale 不挂住',
    dStA3.sessions === 0 && dStA3.running === 0 && dStA3.files === 0 && dStA3.stale === false,
    JSON.stringify(dStA3)]);
  checks.push(['删除后同路径重建：新会话正常读入、旧运行会话不复活、stale=false',
    dStA4.sessions === 1 && dStA4.stale === false && dSsA4.length === 1 && dSsA4[0].id === 'sb'
      && dSsA4[0].msgs.some(m => m.text.includes('重建后的新会话')),
    JSON.stringify({...dStA4, ids: dSsA4.map(x => x.id)})]);

  /* 根路径整体不可用（例如临时卸载盘）不能当成「确认删除」：父链都无法确认时保留缓存并标 stale。 */
  const dRootB = await mkdtemp(join(tmpdir(), 'dsh-v238-rootunavail-'));
  const dSidB = join(dRootB, 'wsRootB', 'sb2');
  await mkdir(dSidB, {recursive: true});
  await writeFile(join(dSidB, 'session.v4.jsonl'), [
    rec('session', 1, 1000, {id: 'sb2', cwd: 'D:\\wRootUnavail'}),
    rec('tool/call', 2, 2000, {callId: 'c-root-unavail', name: 'bash', arguments: '{"command":"sleep 1"}'}),
  ].join(''));
  let dVanish = false;                                          // 模拟整条路径（盘符/挂载点）暂时消失
  const dIoB = {
    readdir: (p, o) => {
      if (dVanish && dNormV238(p) === dNormV238(dRootB)) {
        throw Object.assign(new Error('ENOENT: no such file or directory, scandir ' + p), {code: 'ENOENT'});
      }
      return realReaddir(p, o);
    },
    readFile: (p, o) => realReadFile(p, o),
    stat: (p, o) => {
      if (dVanish) throw Object.assign(new Error('ENOENT: no such file or directory, stat ' + p), {code: 'ENOENT'});
      return realStat(p, o);
    },
  };
  const dSrcB = dsh.create({root: dRootB, activeMs: 999999999, live: {push() {}}, io: dIoB, listIntervalMs: 0});
  await dSrcB.scan(true);
  const dStB0 = dSrcB.stats();
  dVanish = true;
  await dSrcB.scan(false);
  const dStB1 = dSrcB.stats();
  dVanish = false;
  await dSrcB.scan(false);
  const dStB2 = dSrcB.stats();
  await rm(dRootB, {recursive: true, force: true});
  await dSrcB.scan(false);
  const dStB3 = dSrcB.stats();
  await dSrcB.scan(false);
  const dStB4 = dSrcB.stats();

  checks.push(['根路径整体不可用基线：运行中会话已缓存',
    dStB0.sessions === 1 && dStB0.stale === false, JSON.stringify(dStB0)]);
  checks.push(['根路径整条暂时消失（父链无法确认）：保留缓存并标 stale，不按删除清空',
    dStB1.sessions === 1 && dStB1.running === 1 && dStB1.stale === true, JSON.stringify(dStB1)]);
  checks.push(['路径恢复可确认：缓存仍在、stale 归假',
    dStB2.sessions === 1 && dStB1.stale === true && dStB2.stale === false, JSON.stringify(dStB2)]);
  checks.push(['父目录可见但根目录真删除：确认删除并清空（连续两次）',
    dStB3.sessions === 0 && dStB3.stale === false && dStB4.sessions === 0 && dStB4.stale === false,
    JSON.stringify({b3: dStB3, b4: dStB4})]);

  /* ---- 第 2 条（P2）：解析健康贯穿 DSH 路径 ----
     ① 内部完整坏行（后面还有合法记录）→ stale，但继续折叠：后续 turn/end 必须生效；
     ② 末尾半行（追加写入的残行）可忽略；合法未知类型也不算故障；
     ③ Write/Edit 的 arguments 可解析但结构不可用（null/数组/原始值）→ 不抛穿、结束记录仍生效、标 stale。 */
  const dRoot33 = await mkdtemp(join(tmpdir(), 'dsh-v238-badline-'));
  const dFile33 = join(dRoot33, 'ws33', 'sbad', 'session.v4.jsonl');
  await mkdir(dirname(dFile33), {recursive: true});
  await writeFile(dFile33, [
    rec('session', 1, 1000, {id: 'sbad', cwd: 'D:\\wBadLine'}),
    rec('turn/start', 2, 2000, {turn: 1}),
    rec('tool/call', 3, 2100, {callId: 'c-badline', name: 'bash', arguments: '{"command":"sleep 1"}'}),
    '{"type":"tool/call","seq":4,\n',                            // 内部完整坏行：有换行、后面还有合法结束记录
    rec('turn/end', 5, 2400, {turn: 1}),
  ].join(''));
  const dSrc33 = dsh.create({root: dRoot33, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
  await dSrc33.scan(true);
  const dSt33 = dSrc33.stats();
  const dS33 = dSrc33.sessions().find(x => x.id === 'sbad');
  await rm(dRoot33, {recursive: true, force: true});

  checks.push(['内部完整坏行：快照仍提交（sessions=1）并标 stale=true',
    dSt33.sessions === 1 && dSt33.stale === true, JSON.stringify(dSt33)]);
  checks.push(['内部完整坏行：后续 turn/end 生效（turnOpen=false、current=null、running=0）',
    !!dS33 && dS33.turnOpen === false && dS33.current === null && dSt33.running === 0,
    JSON.stringify({st: dSt33, s: dS33 && {turnOpen: dS33.turnOpen, current: dS33.current}})]);

  const dRoot34 = await mkdtemp(join(tmpdir(), 'dsh-v238-tail-'));
  const dFile34 = join(dRoot34, 'ws34', 'stail', 'session.v4.jsonl');
  await mkdir(dirname(dFile34), {recursive: true});
  await writeFile(dFile34, [
    rec('session', 1, 1000, {id: 'stail', cwd: 'D:\\wTail'}),
    rec('turn/start', 2, 2000, {turn: 1}),
    rec('tool/call', 3, 2100, {callId: 'c-tail', name: 'write',
      arguments: JSON.stringify({file_path: 'a.js', content: 'let a = 1;'})}),
    rec('tool/result', 4, 2200, {toolCallId: 'c-tail', message: {content: 'ok'}}),
    '{"type":"mystery/unknown","seq":5,"time":2300,"data":{"x":1}}\n',   // 合法未知类型：忽略，不算故障
    rec('turn/end', 6, 2400, {turn: 1}),
    '{"type":"user/message","seq":7",',                          // 末尾半行（没有换行）：可忽略
  ].join(''));
  const dSrc34 = dsh.create({root: dRoot34, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
  await dSrc34.scan(true);
  const dSt34 = dSrc34.stats();
  const dS34 = dSrc34.sessions().find(x => x.id === 'stail');
  await rm(dRoot34, {recursive: true, force: true});

  checks.push(['末尾半行 + 未知类型：不标 stale、结束记录生效、合法写片段保留',
    dSt34.sessions === 1 && dSt34.stale === false && dSt34.running === 0
      && !!dS34 && dS34.turnOpen === false && dS34.current === null
      && dS34.done === 1 && dS34.snippets.length === 1,
    JSON.stringify({st: dSt34, s: dS34 && {turnOpen: dS34.turnOpen, current: dS34.current,
      done: dS34.done, snippets: dS34.snippets.length}})]);

  const dRoot35 = await mkdtemp(join(tmpdir(), 'dsh-v238-payload-'));
  const dPayloadCases = [['snull', 'null'], ['sarray', '[1,2]'], ['sprim', '42']];
  for (const [dId35, dArgs35] of dPayloadCases) {
    const dDir35 = join(dRoot35, 'ws35', dId35);
    await mkdir(dDir35, {recursive: true});
    await writeFile(join(dDir35, 'session.v4.jsonl'), [
      rec('session', 1, 1000, {id: dId35, cwd: 'D:\\wPayload'}),
      rec('turn/start', 2, 2000, {turn: 1}),
      rec('tool/call', 3, 2100, {callId: 'c-' + dId35, name: 'write', arguments: dArgs35}),
      rec('turn/end', 4, 2400, {turn: 1}),
    ].join(''));
  }
  const dSrc35 = dsh.create({root: dRoot35, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
  await dSrc35.scan(true);
  const dSt35 = dSrc35.stats();
  const dSs35 = dSrc35.sessions();
  await rm(dRoot35, {recursive: true, force: true});

  checks.push(['Write 的 arguments 为 null/数组/原始值：不抛穿、三个会话都提交、标 stale',
    dSt35.sessions === 3 && dSt35.running === 0 && dSt35.stale === true, JSON.stringify(dSt35)]);
  checks.push(['Write 坏载荷后 turn/end 仍生效（每会话 turnOpen=false、current=null、调用记录保留）',
    dSs35.length === 3 && dSs35.every(x => x.turnOpen === false && x.current === null && x.calls.length === 1),
    JSON.stringify(dSs35.map(x => ({id: x.id, turnOpen: x.turnOpen, current: x.current, calls: x.calls.length})))]);

  /* ④ 深嵌套有效 JSON 作为 arguments：JSON.stringify 会抛 RangeError，必须在单条记录边界隔离，
     后续 tool/result、消息与 turn/end 仍处理；不能整份折叠失败。 */
  const dDeepJson = '['.repeat(20000) + ']'.repeat(20000);
  const dRoot36 = await mkdtemp(join(tmpdir(), 'dsh-v238-deeparg-'));
  const dFile36 = join(dRoot36, 'ws36', 'sdeep', 'session.v4.jsonl');
  await mkdir(dirname(dFile36), {recursive: true});
  const dDeepCall36 = '{"type":"tool/call","seq":3,"time":3000,"data":{"callId":"c-deep36","name":"write","arguments":'
    + dDeepJson + '}}\n';
  await writeFile(dFile36, [
    rec('session', 1, 1000, {id: 'sdeep', cwd: 'D:\\wDeep'}),
    rec('turn/start', 2, 2000, {turn: 1}),
    dDeepCall36,
    rec('tool/result', 4, 3100, {toolCallId: 'c-deep36', message: {content: 'ok'}}),
    rec('user/message', 5, 3200, {source: {kind: 'user'}, content: '深嵌套之后的消息'}),
    rec('turn/end', 6, 3300, {turn: 1}),
  ].join(''));
  const dSrc36 = dsh.create({root: dRoot36, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
  await dSrc36.scan(true);
  const dSt36 = dSrc36.stats();
  const dS36 = dSrc36.sessions().find(x => x.id === 'sdeep');
  await rm(dRoot36, {recursive: true, force: true});

  checks.push(['深嵌套 arguments：单条记录隔离、会话照常提交、标 stale',
    dSt36.sessions === 1 && dSt36.running === 0 && dSt36.stale === true && !!dS36,
    JSON.stringify({st: dSt36, s: dS36 && {turnOpen: dS36.turnOpen}})]);
  checks.push(['深嵌套 arguments 之后的 tool/result、消息与 turn/end 都生效',
    !!dS36 && dS36.turnOpen === false && dS36.current === null && dS36.done === 1
      && dS36.msgs.some(m => m.text.includes('深嵌套之后的消息')),
    JSON.stringify(dS36 && {turnOpen: dS36.turnOpen, current: dS36.current, done: dS36.done,
      msgs: dS36.msgs.map(m => m.text)})]);

  /* ⑤ 深嵌套字段让单条 fold 记录抛 RangeError：该记录跳过，后续记录仍处理（不能整份丢弃）。 */
  const dRoot37 = await mkdtemp(join(tmpdir(), 'dsh-v238-deeprecord-'));
  const dFile37 = join(dRoot37, 'ws37', 'sdeepcwd', 'session.v4.jsonl');
  await mkdir(dirname(dFile37), {recursive: true});
  const dDeepSession37 = '{"type":"session","seq":1,"time":1000,"data":{"id":"sdeepcwd","cwd":'
    + dDeepJson + '}}\n';
  await writeFile(dFile37, [
    dDeepSession37,
    rec('turn/start', 2, 2000, {turn: 1}),
    rec('tool/call', 3, 2100, {callId: 'c-deepcwd', name: 'bash', arguments: '{"command":"sleep 1"}'}),
    rec('turn/end', 4, 2400, {turn: 1}),
    rec('user/message', 5, 2500, {source: {kind: 'user'}, content: '单条异常之后的合法消息'}),
  ].join(''));
  const dSrc37 = dsh.create({root: dRoot37, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
  await dSrc37.scan(true);
  const dSt37 = dSrc37.stats();
  const dS37 = dSrc37.sessions().find(x => x.id === 'sdeepcwd');
  await rm(dRoot37, {recursive: true, force: true});

  checks.push(['单条 fold 记录抛 RangeError：会话照常提交、标 stale（不是整份解析失败）',
    dSt37.sessions === 1 && dSt37.stale === true && !!dS37, JSON.stringify({st: dSt37,
      ids: dSrc37.sessions().map(x => x.id)})]);
  checks.push(['单条异常记录之后的 turn/end 与消息仍处理（记录边界隔离）',
    !!dS37 && dS37.turnOpen === false && dS37.current === null && dSt37.running === 0
      && dS37.msgs.some(m => m.text.includes('单条异常之后的合法消息')),
    JSON.stringify(dS37 && {turnOpen: dS37.turnOpen, current: dS37.current,
      msgs: dS37.msgs.map(m => m.text)})]);

  /* ⑥ 解析故障不能被后续成功的 readFile/stat 洗掉：内容不变时连续扫描仍 stale；修好内容后才恢复。 */
  const dRoot38 = await mkdtemp(join(tmpdir(), 'dsh-v238-health-'));
  const dFile38 = join(dRoot38, 'ws38', 'shealth', 'session.v4.jsonl');
  await mkdir(dirname(dFile38), {recursive: true});
  const dHealth38 = extra => [
    rec('session', 1, 1000, {id: 'shealth', cwd: 'D:\\wHealth'}),
    rec('tool/call', 2, 2000, {callId: 'c-health', name: 'bash', arguments: '{"command":"sleep 1"}'}),
    rec('tool/result', 3, 2100, {toolCallId: 'c-health', message: {content: 'ok'}}),
    rec('turn/end', 4, 2200, {turn: 1}),
  ].join('') + (extra || '');
  await writeFile(dFile38, dHealth38(''));
  const dSrc38 = dsh.create({root: dRoot38, activeMs: 999999999, live: {push() {}}, listIntervalMs: 0});
  await dSrc38.scan(true);
  const dSt38a = dSrc38.stats();
  await writeFile(dFile38, dHealth38('{"oops":\n'));            // 内部坏行
  await dSrc38.scan(false);
  const dSt38b = dSrc38.stats();
  const dS38b = dSrc38.sessions().find(x => x.id === 'shealth');
  await dSrc38.scan(false);                                     // 内容没变：成功 stat 不能洗掉故障
  const dSt38c = dSrc38.stats();
  await writeFile(dFile38, dHealth38(rec('user/message', 5, 3000, {source: {kind: 'user'}, content: '修复后的新消息'})));
  await dSrc38.scan(false);
  const dSt38d = dSrc38.stats();
  const dS38d = dSrc38.sessions().find(x => x.id === 'shealth');
  await rm(dRoot38, {recursive: true, force: true});

  checks.push(['解析健康基线：正常日志不 stale',
    dSt38a.sessions === 1 && dSt38a.stale === false, JSON.stringify(dSt38a)]);
  checks.push(['出现内部坏行：stale=true，但结束记录仍生效（turnOpen=false、running=0）',
    dSt38b.sessions === 1 && dSt38b.stale === true && dSt38b.running === 0
      && !!dS38b && dS38b.turnOpen === false,
    JSON.stringify({st: dSt38b, s: dS38b && {turnOpen: dS38b.turnOpen}})]);
  checks.push(['内容未变再扫描：成功 stat/read 不能把未恢复的解析故障洗成健康',
    dSt38c.sessions === 1 && dSt38c.stale === true, JSON.stringify(dSt38c)]);
  checks.push(['修好内容后：stale 归假、新消息可读（故障真恢复才清除）',
    dSt38d.sessions === 1 && dSt38d.stale === false && !!dS38d
      && dS38d.msgs.some(m => m.text.includes('修复后的新消息')),
    JSON.stringify({st: dSt38d, msgs: dS38d && dS38d.msgs.map(m => m.text)})]);

  /* ---- 第 8 条（P3）：工具名索引按会话作用域 ----
     跨工作区同会话 id、同 call_id：只给 a 追加失败结果，a 的 lastFail 与新失败事件都必须用自己的工具名。 */
  const dRoot40 = await mkdtemp(join(tmpdir(), 'dsh-v238-callscope-'));
  const dFile40a = join(dRoot40, 'ws40a', 'same', 'session.v4.jsonl');
  const dFile40b = join(dRoot40, 'ws40b', 'same', 'session.v4.jsonl');
  await mkdir(dirname(dFile40a), {recursive: true});
  await mkdir(dirname(dFile40b), {recursive: true});
  const dBase40 = (cwd, tool) => [
    rec('session', 1, 1000, {id: 'same', cwd}),
    rec('turn/start', 2, 1500, {turn: 1}),
    rec('tool/call', 3, 2000, {callId: 'c-share40', name: tool, arguments: '{"file_path":"/x"}'}),
  ].join('');
  await writeFile(dFile40a, dBase40('D:\\wScopeA', 'read'));
  await writeFile(dFile40b, dBase40('D:\\wScopeB', 'write'));
  const dPushed40 = [];
  const dSrc40 = dsh.create({root: dRoot40, activeMs: 999999999,
    live: {push(it) { dPushed40.push(it); }}, listIntervalMs: 0});
  await dSrc40.scan(true);
  const dSt40a = dSrc40.stats();
  const dN40 = dPushed40.length;
  const dSs40a = dSrc40.sessions();
  const dS40a = dSs40a.find(x => x.file === dFile40a);
  const dS40b = dSs40a.find(x => x.file === dFile40b);
  await writeFile(dFile40a, dBase40('D:\\wScopeA', 'read') + [
    rec('tool/result', 4, 3000, {toolCallId: 'c-share40', message: {isError: true, content: 'EACCES: a 侧失败'}}),
    rec('turn/end', 5, 3100, {turn: 1}),
  ].join(''));
  await dSrc40.scan(false);
  const dS40a2 = dSrc40.sessions().find(x => x.file === dFile40a);
  const dS40b2 = dSrc40.sessions().find(x => x.file === dFile40b);
  const dFail40 = dPushed40.slice(dN40).find(it => it.ok === false);
  await rm(dRoot40, {recursive: true, force: true});

  checks.push(['跨会话同 call_id 基线：两个工作区的同名会话都缓存、索引按会话分开（2 会话 / 2 条）',
    !!dS40a && !!dS40b && dSs40a.length === 2
      && dSt40a.callIndexSessions === 2 && dSt40a.callIndexNames === 2,
    JSON.stringify({files: dSs40a.map(x => x.file), index: dSt40a})]);
  checks.push(['跨会话同 call_id：a 的 lastFail 用自己的工具名 read',
    !!dS40a2 && !!dS40a2.lastFail && dS40a2.lastFail.name === 'read',
    JSON.stringify(dS40a2 && dS40a2.lastFail)]);
  checks.push(['跨会话同 call_id：仅给 a 追加失败结果，失败事件也用 a 的工具名（不是 write）',
    !!dFail40 && /^read · /.test(String(dFail40.name)) && /a 侧失败/.test(String(dFail40.name)),
    JSON.stringify(dFail40)]);

  /* 工具名索引必须从本份日志的权威调用记录维护，不能依赖「这次是否发布调用事件」：
     首轮只发布尾部事件，早先的 tool/call 没发事件；后续只追加失败结果时仍要认出工具名。 */
  const dRoot41 = await mkdtemp(join(tmpdir(), 'dsh-v238-callauth-'));
  const dFile41 = join(dRoot41, 'ws41', 'sauth', 'session.v4.jsonl');
  await mkdir(dirname(dFile41), {recursive: true});
  const dLines41 = [
    rec('session', 1, 1000, {id: 'sauth', cwd: 'D:\\wAuth'}),
    rec('tool/call', 2, 2000, {callId: 'c-auth41', name: 'read', arguments: '{"file_path":"/auth"}'}),
  ];
  for (let i = 0; i < 120; i++) {
    dLines41.push(rec('user/message', 3 + i, 2100 + i, {source: {kind: 'user'}, content: '填充消息-' + i}));
  }
  await writeFile(dFile41, dLines41.join(''));
  const dPushed41 = [];
  const dSrc41 = dsh.create({root: dRoot41, activeMs: 999999999,
    live: {push(it) { dPushed41.push(it); }}, listIntervalMs: 0});
  await dSrc41.scan(true);
  const dN41 = dPushed41.length;
  await writeFile(dFile41, dLines41.join('') + [
    rec('tool/result', 130, 4000, {toolCallId: 'c-auth41', message: {isError: true, content: 'EACCES: 权威侧失败'}}),
    rec('turn/end', 131, 4100, {turn: 1}),
  ].join(''));
  await dSrc41.scan(false);
  const dS41b = dSrc41.sessions().find(x => x.id === 'sauth');
  const dFail41 = dPushed41.slice(dN41).find(it => it.ok === false);
  await rm(dRoot41, {recursive: true, force: true});

  checks.push(['工具名索引来自权威调用数据：首轮未发布该调用，后续失败事件仍认出 Read',
    !!dFail41 && /^read · /.test(String(dFail41.name)) && /权威侧失败/.test(String(dFail41.name)),
    JSON.stringify(dFail41)]);
  checks.push(['权威调用索引：只追加结果也补全 lastFail 工具名',
    !!dS41b && !!dS41b.lastFail && dS41b.lastFail.name === 'read',
    JSON.stringify(dS41b && dS41b.lastFail)]);

  /* 索引阈值清理必须按会话，不能整表 clear：a 会话发布 800+ 个调用后，b 会话的旧调用名仍可用。 */
  const dRoot42 = await mkdtemp(join(tmpdir(), 'dsh-v238-calllimit-'));
  const dFile42a = join(dRoot42, 'ws42a', 'sa42', 'session.v4.jsonl');
  const dFile42b = join(dRoot42, 'ws42b', 'sb42', 'session.v4.jsonl');
  await mkdir(dirname(dFile42a), {recursive: true});
  await mkdir(dirname(dFile42b), {recursive: true});
  const dBase42 = [
    rec('session', 1, 1000, {id: 'sa42', cwd: 'D:\\wA42'}),
    rec('turn/start', 2, 1500, {turn: 1}),
    rec('tool/call', 3, 2000, {callId: 'c-a42-base', name: 'bash', arguments: '{"command":"echo 0"}'}),
  ].join('');
  await writeFile(dFile42a, dBase42);
  await writeFile(dFile42b, [
    rec('session', 1, 1000, {id: 'sb42', cwd: 'D:\\wB42'}),
    rec('turn/start', 2, 1500, {turn: 1}),
    rec('tool/call', 3, 2000, {callId: 'c-b42', name: 'read', arguments: '{"file_path":"/b"}'}),
  ].join(''));
  const dPushed42 = [];
  const dSrc42 = dsh.create({root: dRoot42, activeMs: 999999999,
    live: {push(it) { dPushed42.push(it); }}, listIntervalMs: 0});
  await dSrc42.scan(true);
  const dCalls42 = [];
  for (let i = 1; i <= 850; i++) {
    dCalls42.push(rec('tool/call', 3 + i, 2000 + i,
      {callId: 'c-a42-' + i, name: 'bash', arguments: '{"command":"echo ' + i + '"}'}));
  }
  await writeFile(dFile42a, dBase42 + dCalls42.join(''));
  await dSrc42.scan(false);                                    // a 一次发布 850 条调用（超过旧整表 clear 阈值）
  const dN42 = dPushed42.length;
  await writeFile(dFile42b, [
    rec('session', 1, 1000, {id: 'sb42', cwd: 'D:\\wB42'}),
    rec('turn/start', 2, 1500, {turn: 1}),
    rec('tool/call', 3, 2000, {callId: 'c-b42', name: 'read', arguments: '{"file_path":"/b"}'}),
    rec('tool/result', 4, 3000, {toolCallId: 'c-b42', message: {isError: true, content: 'EACCES: 阈值侧失败'}}),
    rec('turn/end', 5, 3100, {turn: 1}),
  ].join(''));
  await dSrc42.scan(false);
  const dS42b = dSrc42.sessions().find(x => x.id === 'sb42');
  const dFail42 = dPushed42.slice(dN42).find(it => it.ok === false);
  await rm(dRoot42, {recursive: true, force: true});

  checks.push(['索引阈值按会话清理：a 会话 850 个调用不能把 b 会话的工具名整表清掉',
    !!dFail42 && /^read · /.test(String(dFail42.name)) && /阈值侧失败/.test(String(dFail42.name)),
    JSON.stringify(dFail42)]);
  checks.push(['索引阈值后 b 的 lastFail 仍是 read',
    !!dS42b && !!dS42b.lastFail && dS42b.lastFail.name === 'read',
    JSON.stringify(dS42b && dS42b.lastFail)]);

  /* 会话确认删除后索引必须回收：同路径重建且只出现结果记录时，不能沿用已删会话的旧工具名。 */
  const dRoot43 = await mkdtemp(join(tmpdir(), 'dsh-v238-callclean-'));
  const dDir43 = join(dRoot43, 'ws43', 'sdel');
  const dFile43 = join(dDir43, 'session.v4.jsonl');
  await mkdir(dDir43, {recursive: true});
  await writeFile(dFile43, [
    rec('session', 1, 1000, {id: 'sdel', cwd: 'D:\\wDel'}),
    rec('turn/start', 2, 1500, {turn: 1}),
    rec('tool/call', 3, 2000, {callId: 'c-del43', name: 'read', arguments: '{"file_path":"/del"}'}),
  ].join(''));
  const dPushed43 = [];
  const dSrc43 = dsh.create({root: dRoot43, activeMs: 999999999,
    live: {push(it) { dPushed43.push(it); }}, listIntervalMs: 0});
  await dSrc43.scan(true);
  await rm(dDir43, {recursive: true, force: true});
  await dSrc43.scan(false);
  await dSrc43.scan(false);
  const dSt43a = dSrc43.stats();
  await mkdir(dDir43, {recursive: true});
  await writeFile(dFile43, [
    rec('session', 1, 6000, {id: 'sdel', cwd: 'D:\\wDel'}),
    rec('turn/start', 2, 6100, {turn: 1}),
    rec('tool/result', 3, 6200, {toolCallId: 'c-del43', message: {isError: true, content: 'EACCES: 删除后重建的失败'}}),
    rec('turn/end', 4, 6300, {turn: 1}),
  ].join(''));
  const dN43 = dPushed43.length;
  await dSrc43.scan(false);
  const dSt43b = dSrc43.stats();
  const dFail43 = dPushed43.slice(dN43).find(it => it.ok === false);
  await rm(dRoot43, {recursive: true, force: true});

  checks.push(['会话确认删除：缓存退出、stale 不挂住、工具名索引回收（会话数/条目都归 0）',
    dSt43a.sessions === 0 && dSt43a.stale === false
      && dSt43a.callIndexSessions === 0 && dSt43a.callIndexNames === 0,
    JSON.stringify(dSt43a)]);
  checks.push(['删除后重建只出现结果记录：不沿用已删会话的旧工具名（回退到「工具」）',
    dSt43b.sessions === 1 && dSt43b.stale === false && !!dFail43
      && /^工具/.test(String(dFail43.name)) && !/^read/.test(String(dFail43.name)),
    JSON.stringify({st: dSt43b, evt: dFail43})]);



  /* 长会话超过索引阈值后，迟到的失败结果仍要用自己的工具名：
     850 个未闭合调用、第 51 个是 read（首轮裁剪后它仍在索引最旧位置）；
     只追加它的失败结果。索引淘汰发生在发布之后，不能先把本批要用的关联清掉。 */
  const dRoot44 = await mkdtemp(join(tmpdir(), 'dsh-v238-call-long-'));
  const dFile44 = join(dRoot44, 'ws44', 'slong', 'session.v4.jsonl');
  await mkdir(dirname(dFile44), {recursive: true});
  const dLines44 = [
    rec('session', 1, 1000, {id: 'slong', cwd: 'D:\\wLong'}),
    rec('turn/start', 2, 1500, {turn: 1}),
    rec('tool/call', 3, 2000, {callId: 'c-long44-1', name: 'bash', arguments: '{"command":"echo 1"}'}),
  ];
  for (let i = 2; i <= 850; i++) {
    dLines44.push(rec('tool/call', 2 + i, 2000 + i,
      {callId: 'c-long44-' + i, name: i === 51 ? 'read' : 'bash', arguments: '{"command":"echo ' + i + '"}'}));
  }
  await writeFile(dFile44, dLines44.join(''));
  const dPushed44 = [];
  const dSrc44 = dsh.create({root: dRoot44, activeMs: 999999999,
    live: {push(it) { dPushed44.push(it); }}, listIntervalMs: 0});
  await dSrc44.scan(true);                                     // 首轮：850 个调用，索引超阈值
  const dSt44a = dSrc44.stats();
  const dN44 = dPushed44.length;
  await writeFile(dFile44, dLines44.join('') + [
    rec('tool/result', 853, 5000, {toolCallId: 'c-long44-51', message: {isError: true, content: 'EACCES: 迟到结果'}}),
    rec('turn/end', 854, 5100, {turn: 1}),
  ].join(''));
  await dSrc44.scan(false);
  const dS44 = dSrc44.sessions().find(x => x.id === 'slong');
  const dFail44 = dPushed44.slice(dN44).find(it => it.ok === false);
  await rm(dRoot44, {recursive: true, force: true});
  checks.push(['长会话超索引阈值：迟到的失败结果仍用自己的工具名（read，不是「工具」）',
    !!dS44 && !!dS44.lastFail && dS44.lastFail.name === 'read'
      && !!dFail44 && /^read · /.test(String(dFail44.name)),
    JSON.stringify({lastFail: dS44 && dS44.lastFail, evt: dFail44})]);
  checks.push(['长会话索引按会话上限保留 800 条（不整表 clear、不无限增长）',
    dSt44a.callIndexSessions === 1 && dSt44a.callIndexNames === 800,
    JSON.stringify(dSt44a)]);

  /* 解析诊断计数：区分「内部完整坏行」「末尾半行」「已知载荷结构不可用」「单条记录异常」。 */
  checks.push(['解析诊断计数：内部坏行=1、末尾半行不计坏行、Write 坏载荷每会话=1',
    !!dS33 && !!dS33.parseIssues && dS33.parseIssues.badLines === 1
      && dS33.parseIssues.badPayloads === 0 && dS33.parseIssues.recordErrors === 0
      && !!dS34 && !!dS34.parseIssues && dS34.parseIssues.badLines === 0
      && dSs35.length === 3 && dSs35.every(x => x.parseIssues && x.parseIssues.badPayloads === 1),
    JSON.stringify({bad: dS33 && dS33.parseIssues, tail: dS34 && dS34.parseIssues,
      payload: dSs35.map(x => x.parseIssues)})]);
  checks.push(['解析诊断计数：单条记录异常记 recordErrors、深嵌套载荷也算质量下降',
    !!dS36 && !!dS36.parseIssues && dS36.parseIssues.recordErrors >= 1
      && !!dS37 && !!dS37.parseIssues && dS37.parseIssues.recordErrors === 1
      && dS37.parseIssues.badLines === 0,
    JSON.stringify({deep: dS36 && dS36.parseIssues, rec: dS37 && dS37.parseIssues})]);
  checks.push(['解析故障持久：内部坏行在后续扫描仍计入诊断',
    !!dS38b && !!dS38b.parseIssues && dS38b.parseIssues.badLines === 1,
    JSON.stringify(dS38b && dS38b.parseIssues)]);

  /* v2.43 #3：不可信字段（含 {"toString":null}）不能抛穿；后续 turn/end 必须生效。 */
  {
    const d = await mkdtemp(join(tmpdir(), 'dsh-v243-badid-'));
    const s1 = join(d, 'ws', 'sidBad');
    await mkdir(s1, {recursive: true});
    const body = [
      rec('session', 1, 1000, {id: 'sidBad', cwd: 'D:\\dshBad'}),
      rec('turn/start', 2, 2000, {turn: 1}),
      rec('tool/call', 3, 3000, {callId: {toString: null}, name: 'read'}),
      rec('tool/call', 4, 3500, {callId: 'ok1', name: 'write', arguments: '{"file_path":"a.txt","content":"x"}'}),
      rec('tool/result', 5, 4000, {toolCallId: 'ok1'}),
      rec('turn/end', 6, 5000, {turn: 1}),
      rec('assistant/message', 7, 6000, {message: {content: '完成'}}),
    ].join('');
    await writeFile(join(s1, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(body, 'utf8')));
    const src = dsh.create({root: d, activeMs: 999999999, live: {push() {}}});
    await src.scan(true);
    const sb = src.sessions().find(x => x.id === 'sidBad');
    checks.push(['v2.43 #3：非法对象 ID 不抛穿，turn/end 生效',
      !!sb && sb.turnOpen === false && sb.current === null && sb.turns === 1,
      JSON.stringify(sb && {turnOpen: sb.turnOpen, cur: !!sb.current, turns: sb.turns})]);
    checks.push(['v2.43 #3：非法字段计诊断并标 stale',
      !!sb && !!sb.parseIssues && sb.parseIssues.recordErrors >= 1 && src.stats().stale === true,
      JSON.stringify({issues: sb && sb.parseIssues, stale: src.stats().stale})]);
    checks.push(['v2.43 #3：合法调用与会话内容仍保留',
      !!sb && sb.calls.some(c => c.callId === 'ok1') && sb.msgs.some(m => /完成/.test(m.text)),
      JSON.stringify(sb && {calls: sb.calls.map(c => c.callId), msgs: sb.msgs})]);
    await rm(d, {recursive: true, force: true});
  }
  /* v2.43 #10：calls 超 400 时保护未完成/当前调用 */
  {
    const d = await mkdtemp(join(tmpdir(), 'dsh-v243-trim-'));
    const s1 = join(d, 'ws', 'sidTrim');
    await mkdir(s1, {recursive: true});
    const parts = [
      rec('session', 1, 1000, {id: 'sidTrim', cwd: 'D:\\dshTrim'}),
      rec('turn/start', 2, 2000, {turn: 1}),
      rec('tool/call', 3, 3000, {callId: 'c0', name: 'bash', arguments: '{"cmd":"sleep"}'}),
    ];
    for (let i = 1; i <= 405; i++) {
      parts.push(rec('tool/call', 10 + i, 3000 + i, {callId: 'c' + i, name: 'read', arguments: '{}'}));
      parts.push(rec('tool/result', 1000 + i, 3000 + i, {toolCallId: 'c' + i}));
    }
    await writeFile(join(s1, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(parts.join(''), 'utf8')));
    const src = dsh.create({root: d, activeMs: 999999999, live: {push() {}}});
    await src.scan(true);
    const st = src.sessions().find(x => x.id === 'sidTrim');
    checks.push(['v2.43 #10：历史裁剪后当前未完成调用仍保留',
      !!st && !!st.current && st.current.callId === 'c0'
        && st.calls.some(c => c.callId === 'c0') && st.calls.length <= 400,
      JSON.stringify(st && {cur: st.current && st.current.callId, n: st.calls.length, first: st.calls.slice(0, 3).map(c => c.callId)})]);
    checks.push(['v2.43 #10：裁剪后已完成调用统计不回退',
      !!st && st.done >= 390 && st.calls.filter(c => c.done).length >= 390,
      JSON.stringify(st && {done: st.done, calls: st.calls.length})]);
    await rm(d, {recursive: true, force: true});
  }

  console.log('MODE=dshsrc  （DSH 合成会话，验证失败事件的工具名）\n');
  for (const [name, pass, detail] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : '   → ' + detail}`);
    if (!pass) bad++;
  }
  console.log(`\n${checks.length - bad}/${checks.length} 通过`);
  process.exit(bad ? 1 : 0);
}

/* ---------------- MODE=codexsql：新版 Codex 的 SQLite 实时库 ---------------- */
if (MODE === 'codexsql') {
  const { DatabaseSync } = await import('node:sqlite');
  const codex = await import('./sources/codex.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'codex-sql-'));
  const statePath = join(dir, 'state.db'), histPath = join(dir, 'history.db');

  const s1 = new DatabaseSync(statePath);
  s1.exec('create table threads (id text, cwd text, title text, name text, first_user_message text, updated_at integer, archived integer default 0)');
  s1.prepare('insert into threads values (?,?,?,?,?,?,0)').run('th1', 'D:\\work\\live', '直播会话', null, null, Math.floor(Date.now() / 1000));
  s1.close();

  const s2 = new DatabaseSync(histPath);
  s2.exec('create table thread_turns (thread_id text, turn_id text, status text)');
  s2.exec('create table thread_items (thread_id text, item_id text, item_type text, item_json text, created_at_ms integer, rollout_ordinal integer)');
  s2.prepare('insert into thread_turns values (?,?,?)').run('th1', 't1', 'inProgress');
  const put = (type, obj, at, ord) => s2.prepare('insert into thread_items values (?,?,?,?,?,?)')
    .run('th1', 'it' + ord, type, JSON.stringify(obj), at, ord);
  put('userMessage', {type: 'userMessage', content: [{type: 'text', text: '跑个命令'}]}, Date.now() - 5000, 1);
  put('commandExecution', {type: 'commandExecution', id: 'e1', command: 'echo hi', status: 'completed', exitCode: 0, durationMs: 30, aggregatedOutput: 'hi'}, Date.now() - 4000, 2);
  put('commandExecution', {type: 'commandExecution', id: 'e2', command: 'ls /nope', status: 'completed', exitCode: 7, durationMs: 20, aggregatedOutput: 'EACCES: permission denied'}, Date.now() - 3000, 3);
  put('agentMessage', {type: 'agentMessage', text: '搞定了'}, Date.now() - 2000, 4);
  s2.close();

  const pushed = [];
  const src = codex.create({ roots: [], activeMs: 45 * 60000, live: {push(it) { pushed.push(it); }},
    sqlitePaths: {state: statePath, history: histPath} });
  await src.scan(true);
  const ss = src.sessions();
  const one = ss.find(x => x.id === 'th1');
  const failEv = pushed.find(p => p.ok === false);

  const checks = [
    ['能从 SQLite 读出实时会话', !!one && one.cwd === 'D:\\work\\live', `cwd=${one && one.cwd}`],
    ['SQLite 里的工具调用被折叠', !!one && one.calls.length === 2 && one.done === 1 && one.failed === 1,
      `calls=${one && one.calls.length} done=${one && one.done} failed=${one && one.failed}`],
    ['失败的命令带退出码和原因', !!one && !!one.lastFail && /exit 7/.test(one.lastFail.reason) && /EACCES/.test(one.lastFail.reason),
      JSON.stringify(one && one.lastFail)],
    ['进行中的回合算「正在运行」', !!one && one.openStep != null, `openStep=${one && one.openStep}`],
    ['新 item 会推成任务流事件', pushed.length >= 3, `事件数=${pushed.length}`],
    ['失败事件带 ok:false', !!failEv && /exit 7/.test(failEv.name), JSON.stringify(failEv)],
  ];
  await rm(dir, {recursive: true, force: true});

  let bad2 = 0;
  console.log('MODE=codexsql  （Codex 新版 SQLite 存储）\n');
  for (const [name, pass, detail] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : '   → ' + detail}`);
    if (!pass) bad2++;
  }
  console.log(`\n${checks.length - bad2}/${checks.length} 通过`);
  process.exit(bad2 ? 1 : 0);
}

/* ---------------- MODE=codexreg：复核 v2.33 数据层回归 ----------------
   每条断言对应一个已复现缺陷，修复回退时必须变红：
   缓存退出 / 回合排序 / JSONL 去重 / 工具状态事件 / 双路事件去重 /
   日志清空 / 同长度内容更新 / 子目录读失败。 */
if (MODE === 'codexreg') {
  const { DatabaseSync } = await import('node:sqlite');
  const codex = await import('./sources/codex.mjs');
  const { buildState, createLive, createCodes } = await import('./lib/core.mjs');
  const checks = [];
  const ok = (name, pass, detail) => checks.push([name, !!pass, detail]);
  const rec = (type, payload, ts) => JSON.stringify({timestamp: ts, type, payload}) + '\n';
  const nowS = Math.floor(Date.now() / 1000);
  const mk = prefix => mkdtemp(join(tmpdir(), prefix));

  const openDb = (path, sql = []) => { const db = new DatabaseSync(path); for (const s of sql) db.exec(s); return db; };
  const mkState = dir => openDb(join(dir, 'state.db'), [
    'create table if not exists threads (id text, cwd text, title text, name text, first_user_message text, updated_at integer, archived integer default 0)',
  ]);
  const mkHist = dir => openDb(join(dir, 'history.db'), [
    'create table if not exists thread_turns (thread_id text, turn_id text, status text, rollout_ordinal integer, started_at integer)',
    'create table if not exists thread_items (thread_id text, turn_id text, item_id text, item_type text, item_json text, created_at_ms integer, rollout_ordinal integer)',
  ]);
  const putThread = (st, id, cwd, o = {}) => st.prepare('insert into threads values (?,?,?,?,?,?,?)')
    .run(id, cwd, id, null, null, o.updated_at != null ? o.updated_at : nowS, o.archived || 0);
  const putItem = (h, tid, itemId, type, obj, ord, turnId = '') => h.prepare('insert into thread_items values (?,?,?,?,?,?,?)')
    .run(tid, turnId, itemId, type, JSON.stringify(obj), Date.now() - 60000 + ord * 100, ord);
  const putTurn = (h, tid, turnId, status, ord) => h.prepare('insert into thread_turns values (?,?,?,?,?)')
    .run(tid, turnId, status, ord, nowS);

  /** 复核 v2.34 #4：给测试用的 SQLite 查询故障注入（生产不传） */
  function makeSrc({roots = [], sqlitePaths = null, sqlite = false, io = null, listIntervalMs = null, sqliteFault = null} = {}) {
    if (sqlite && !sqlitePaths) throw new Error('sqlite 场景必须给 sqlitePaths，避免读到真实 ~/.codex');
    const pushed = [];
    const src = codex.create({
      roots, activeMs: 45 * 60000, live: {push(it) { pushed.push(it); }}, sqlite,
      ...(sqlitePaths ? {sqlitePaths} : {}),
      ...(io ? {io} : {}),
      ...(listIntervalMs != null ? {listIntervalMs} : {}),
      ...(sqliteFault ? {sqliteFault} : {}),
    });
    return {src, pushed};
  }

  /* 1. SQLite 缓存退出：归档线程必须从缓存里删掉（旧代码用整个缓存建 alive 集合，永远删不掉） */
  {
    const dir = await mk('codexreg-cache-');
    const st = mkState(dir); putThread(st, 'thA', 'D:\\wA'); putThread(st, 'thB', 'D:\\wB'); st.close();
    const h = mkHist(dir);
    putItem(h, 'thA', 'a1', 'userMessage', {type: 'userMessage', content: [{type: 'text', text: 'A 消息'}]}, 1);
    putItem(h, 'thB', 'b1', 'userMessage', {type: 'userMessage', content: [{type: 'text', text: 'B 消息'}]}, 1);
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const {src} = makeSrc({sqlite: true, sqlitePaths: paths});
    await src.scan(true);
    ok('缓存退出：初始两个活跃线程都在', src.sessions().length === 2, `sessions=${JSON.stringify(src.sessions().map(s => s.id))}`);
    const st2 = mkState(dir); st2.prepare('update threads set archived=1 where id=?').run('thB'); st2.close();
    await src.scan();
    const ids = src.sessions().map(s => s.id);
    ok('缓存退出：归档线程不再上墙', !ids.includes('thB') && ids.includes('thA'), `sessions=${JSON.stringify(ids)}`);
    ok('缓存退出：stats().sessions 同步下降', src.stats().sessions === 1, `sessions=${src.stats().sessions}`);
    // 数据库打不开：保留已有缓存并标 stale，不能当成"全部删除"
    await rm(join(dir, 'history.db'), {force: true});
    await src.scan();
    ok('数据库读失败：缓存保留', src.sessions().some(s => s.id === 'thA'), `sessions=${JSON.stringify(src.sessions().map(s => s.id))}`);
    ok('数据库读失败：stats().stale 为 true', src.stats().stale === true, `stale=${src.stats().stale}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 2. 回合顺序：thread_turns 必须按 rollout_ordinal（真实语义顺序）排，不是插入顺序 rowid */
  {
    const dir = await mk('codexreg-order-');
    const st = mkState(dir); putThread(st, 'thT', 'D:\\wT'); st.close();
    const h = mkHist(dir);
    // 故意反过来插入：语义上最后一个是 inProgress（ord=2），却先插入拿到更小的 rowid
    putTurn(h, 'thT', 'turn-ord2', 'inProgress', 2);
    putTurn(h, 'thT', 'turn-ord1', 'completed', 1);
    putItem(h, 'thT', 't1', 'userMessage', {type: 'userMessage', content: [{type: 'text', text: '排序测试'}]}, 1);
    h.close();
    const {src} = makeSrc({sqlite: true, sqlitePaths: {state: join(dir, 'state.db'), history: join(dir, 'history.db')}});
    await src.scan(true);
    const one = src.sessions().find(s => s.id === 'thT');
    ok('回合排序：按 rollout_ordinal 取最后一个回合（inProgress → 正在运行）',
      !!one && one.openStep != null, `openStep=${one && one.openStep}（按 rowid 会取到 completed）`);
    ok('回合排序：已完成回合计数正确', !!one && one.turns === 1, `turns=${one && one.turns}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 3. JSONL 去重：同一时间戳的用户消息与助手回复都必须保留；重复副本要合并 */
  {
    const dir = await mk('codexreg-dup-');
    const T = '2026-01-01T00:00:10Z';
    const base = [
      rec('session_meta', {session_id: 'csD', cwd: 'D:\\wD'}, '2026-01-01T00:00:00Z'),
      rec('response_item', {type: 'message', role: 'user', content: [{type: 'text', text: '同一时间戳的用户消息'}]}, T),
      rec('response_item', {type: 'message', role: 'assistant', content: [{type: 'text', text: '同一时间戳的助手回复'}]}, T),
      rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'cD1'}, '2026-01-01T00:00:11Z'),
      rec('response_item', {type: 'function_call_output', call_id: 'cD1', output: 'done'}, '2026-01-01T00:00:12Z'),
    ].join('');
    await writeFile(join(dir, 'rollout-dup1.jsonl'), base);
    // 续聊文件：重叠记录 + 一条新消息（同一 session_id 合并成一条会话）
    await writeFile(join(dir, 'rollout-dup2.jsonl'), base +
      rec('response_item', {type: 'message', role: 'user', content: [{type: 'text', text: '续聊的新消息'}]}, '2026-01-01T00:00:20Z'));
    const {src} = makeSrc({roots: [dir]});
    await src.scan(true);
    const s = src.sessions().find(x => x.id === 'csD');
    ok('JSONL 去重：同一时间戳的用户消息和助手回复都保留',
      !!s && s.msgs.some(m => m.role === 'assistant') && s.msgs.some(m => m.role === 'user') && s.msgs.length === 3,
      JSON.stringify(s && s.msgs));
    ok('JSONL 去重：跨文件重叠记录被合并（不重复推）',
      !!s && s.msgs.filter(m => /用户消息/.test(m.text)).length === 1, JSON.stringify(s && s.msgs.map(m => m.text)));
    ok('JSONL 去重：跨文件同一个调用只留一份', !!s && s.calls.length === 1, `calls=${s && s.calls.length}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 4+5. fileChange / 协作 / subAgentActivity / webSearch 的状态与事件 */
  {
    const dir = await mk('codexreg-status-');
    const st = mkState(dir); putThread(st, 'thS', 'D:\\wS'); st.close();
    const h = mkHist(dir);
    const t0 = Date.now();
    putItem(h, 'thS', 's0', 'userMessage', {type: 'userMessage', content: [{type: 'text', text: '状态测试'}]}, 1);
    putItem(h, 'thS', 'fc1', 'fileChange', {type: 'fileChange', id: 'fc1', changes: [{path: 'D:\\wS\\x.txt', diff: '+x'}], status: 'failed', error: 'write denied'}, 2);
    putItem(h, 'thS', 'cb1', 'collabAgentToolCall', {type: 'collabAgentToolCall', id: 'cb1', tool: 'spawn', status: 'failed', agentsStates: {a: {status: 'failed'}}}, 3);
    putItem(h, 'thS', 'sa1', 'subAgentActivity', {type: 'subAgentActivity', id: 'sa1', kind: 'started', agentThreadId: 'ag1', agentPath: '/root/a'}, 4);
    putItem(h, 'thS', 'sa2', 'subAgentActivity', {type: 'subAgentActivity', id: 'sa2', kind: 'completed', agentThreadId: 'ag1', agentPath: '/root/a'}, 5);
    putItem(h, 'thS', 'ws1', 'webSearch', {type: 'webSearch', id: 'ws1', query: '进行中搜索', status: 'inProgress'}, 6);
    putItem(h, 'thS', 'ws2', 'webSearch', {type: 'webSearch', id: 'ws2', query: '失败搜索', status: 'failed'}, 7);
    putItem(h, 'thS', 'ws3', 'webSearch', {type: 'webSearch', id: 'ws3', query: '成功搜索', status: 'completed'}, 8);
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const {src, pushed} = makeSrc({sqlite: true, sqlitePaths: paths});
    await src.scan(true);
    const one = src.sessions().find(s => s.id === 'thS');
    const fails = pushed.filter(p => p.ok === false);
    ok('失败事件：fileChange 失败带 ok:false 和工具名', fails.some(e => /apply_patch/.test(e.name || '')), JSON.stringify(fails.map(e => e.name)));
    ok('失败事件：协作调用失败带 ok:false 和工具名', fails.some(e => /spawn/.test(e.name || '')), JSON.stringify(fails.map(e => e.name)));
    ok('subAgentActivity 有事件映射（started / completed）',
      pushed.some(e => /agent/.test(e.name || '') && /started/.test(e.name || '')) &&
      pushed.some(e => /agent/.test(e.name || '') && /completed/.test(e.name || '')),
      JSON.stringify(pushed.map(e => e.name)));
    ok('搜索进行中不计完成（未完成的调用 done=false）',
      !!one && one.calls.some(c => c.name === 'web_search' && /进行中搜索/.test(c.label || '') && c.done === false),
      JSON.stringify(one && one.calls.filter(c => c.name === 'web_search').map(c => [c.label, c.done])));
    ok('搜索进行中计入忙碌（current 指向该调用）',
      !!one && !!one.current && /进行中搜索/.test(one.current.label || ''), `current=${JSON.stringify(one && one.current)}`);
    ok('失败统计含 fileChange + 协作 + 失败搜索（3）', !!one && one.failed === 3, `failed=${one && one.failed}`);
    ok('完成统计：两个 subAgentActivity + 成功搜索 = 3', !!one && one.done === 3, `done=${one && one.done}`);
    // 进行中 → 完成后：完成数 +1、不再算运行中、推一条新事件
    const h2 = mkHist(dir);
    h2.prepare('update thread_items set item_json=? where thread_id=? and item_id=?')
      .run(JSON.stringify({type: 'webSearch', id: 'ws1', query: '进行中搜索', status: 'completed'}), 'thS', 'ws1');
    h2.close();
    await src.scan();
    const two = src.sessions().find(s => s.id === 'thS');
    ok('搜索完成后：完成数 +1 且不再是运行中',
      !!two && two.done === 4 && !(two.current && /进行中搜索/.test(two.current.label || '')),
      `done=${two && two.done} current=${JSON.stringify(two && two.current)}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 6. 双路事件去重：同一会话/调用同时出现在 SQLite 与 JSONL 时只推一条 */
  {
    const dir = await mk('codexreg-dual-');
    const root = join(dir, 'sessions');
    await mkdir(root, {recursive: true});
    await writeFile(join(root, 'rollout-p.jsonl'), [
      rec('session_meta', {session_id: 'thP', cwd: 'D:\\wP'}, '2026-01-01T00:00:00Z'),
      rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'eP'}, '2026-01-01T00:00:02Z'),
      rec('response_item', {type: 'function_call_output', call_id: 'eP', output: 'Process exited with code 7: EACCES: permission denied'}, '2026-01-01T00:00:03Z'),
    ].join(''));
    const st = mkState(dir); putThread(st, 'thP', 'D:\\wP'); st.close();
    const h = mkHist(dir);
    putItem(h, 'thP', 'eP', 'commandExecution', {type: 'commandExecution', id: 'eP', command: 'ls', status: 'completed', exitCode: 7, aggregatedOutput: 'Process exited with code 7: EACCES: permission denied'}, 1);
    h.close();
    const {src, pushed} = makeSrc({roots: [root], sqlite: true,
      sqlitePaths: {state: join(dir, 'state.db'), history: join(dir, 'history.db')}});
    await src.scan(true);
    const dup = pushed.filter(e => e.ok === false && /exit 7/.test(e.name || ''));
    ok('双路去重：同一失败命令只推一条事件', dup.length === 1, `${dup.length} 条：${JSON.stringify(dup.map(e => e.name))}`);
    ok('双路去重：合并会话只有一份', src.sessions().filter(s => s.id === 'thP').length === 1, `sessions=${JSON.stringify(src.sessions().map(s => s.id))}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 7. Codex 日志清空/截断后旧状态必须作废 */
  {
    const dir = await mk('codexreg-empty-');
    const f = join(dir, 'rollout-c.jsonl');
    const body = sid => rec('session_meta', {session_id: sid, cwd: 'D:\\wC'}, '2026-01-01T00:00:00Z') +
      rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"sleep 9"}', call_id: 'cC1'}, '2026-01-01T00:00:02Z');
    await writeFile(f, body('csC'));
    const {src} = makeSrc({roots: [dir]});
    await src.scan(true);
    ok('日志清空前：会话在运行', src.sessions().some(s => s.id === 'csC' && s.current), `sessions=${JSON.stringify(src.sessions().map(s => [s.id, !!s.current]))}`);
    await writeFile(f, '');
    await src.scan();
    ok('日志清空后：旧运行状态作废（会话不再挂着）', !src.sessions().some(s => s.id === 'csC'),
      `sessions=${JSON.stringify(src.sessions().map(s => s.id))}`);
    await writeFile(f, rec('session_meta', {session_id: 'csC', cwd: 'D:\\wC'}, '2026-01-01T00:01:00Z') +
      rec('response_item', {type: 'message', role: 'user', content: [{type: 'text', text: '重写后的新内容'}]}, '2026-01-01T00:01:01Z'));
    await src.scan();
    const back = src.sessions().find(s => s.id === 'csC');
    ok('日志重写后：能重新解析出新内容', !!back && back.msgs.some(m => /重写后的新内容/.test(m.text)), `sessions=${JSON.stringify(src.sessions().map(s => s.id))}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 8. sigOf：同长度内容更新（AAAA → BBBB）必须识别为新事件 */
  {
    const dir = await mk('codexreg-sig-');
    const st = mkState(dir); putThread(st, 'thH', 'D:\\wH'); st.close();
    const h = mkHist(dir);
    putItem(h, 'thH', 'm1', 'agentMessage', {type: 'agentMessage', text: 'AAAA'}, 1);
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const {src, pushed} = makeSrc({sqlite: true, sqlitePaths: paths});
    await src.scan(true);
    ok('签名：首轮推送 AAAA', pushed.some(e => /AAAA/.test(e.name || '')), JSON.stringify(pushed.map(e => e.name)));
    const h2 = mkHist(dir);
    h2.prepare('update thread_items set item_json=? where thread_id=? and item_id=?')
      .run(JSON.stringify({type: 'agentMessage', text: 'BBBB'}), 'thH', 'm1');
    h2.close();
    await src.scan();
    ok('签名：同长度内容更新（AAAA→BBBB）也要推事件', pushed.some(e => /BBBB/.test(e.name || '')),
      JSON.stringify(pushed.map(e => e.name)));
    await rm(dir, {recursive: true, force: true});
  }

  /* 9. 子目录读失败：保留缓存并标 stale，只清理成功扫描的范围 */
  {
    const root = await mk('codexreg-dirs-');
    const dayA = join(root, '2026', '01', '01'), dayB = join(root, '2026', '01', '02');
    await mkdir(dayA, {recursive: true}); await mkdir(dayB, {recursive: true});
    await writeFile(join(dayA, 'rollout-a.jsonl'),
      rec('session_meta', {session_id: 'csA', cwd: 'D:\\wA'}, '2026-01-01T00:00:00Z') +
      rec('response_item', {type: 'message', role: 'user', content: [{type: 'text', text: 'A'}]}, '2026-01-01T00:00:01Z'));
    await writeFile(join(dayB, 'rollout-b.jsonl'),
      rec('session_meta', {session_id: 'csB', cwd: 'D:\\wB'}, '2026-01-01T00:00:00Z') +
      rec('response_item', {type: 'message', role: 'user', content: [{type: 'text', text: 'B'}]}, '2026-01-01T00:00:01Z'));
    const {readdir: realReaddir} = await import('node:fs/promises');
    let failPath = '';
    const io = {readdir: async (p, o) => {
      if (failPath && String(p) === failPath) throw Object.assign(new Error('EACCES: permission denied'), {code: 'EACCES'});
      return realReaddir(p, o);
    }};
    const {src} = makeSrc({roots: [root], io, listIntervalMs: 0});
    await src.scan(true);
    ok('目录失败：初始读到两个子目录里的会话', src.sessions().length === 2, `sessions=${JSON.stringify(src.sessions().map(s => s.id))}`);
    failPath = dayB;
    await src.scan();
    ok('子目录读失败：会话保留（不当成删除）', src.sessions().length === 2, `sessions=${JSON.stringify(src.sessions().map(s => s.id))}`);
    ok('子目录读失败：stats().stale 为 true', src.stats().stale === true, `stale=${src.stats().stale}`);
    failPath = '';
    await src.scan();
    ok('目录恢复后：stale 归 false 且会话仍在', src.stats().stale === false && src.sessions().length === 2,
      `stale=${src.stats().stale} sessions=${JSON.stringify(src.sessions().map(s => s.id))}`);
    await rm(root, {recursive: true, force: true});
  }

  /* 2. 同一会话跨目录：部分目录读失败时不能丢掉完整历史（复核 v2.34 #2） */
  {
    const dir = await mk('codexreg-partial-');
    const dayA = join(dir, 'a', '2026', '01', '01'), dayB = join(dir, 'b', '2026', '01', '02');
    await mkdir(dayA, {recursive: true}); await mkdir(dayB, {recursive: true});
    await writeFile(join(dayA, 'rollout-1.jsonl'), [
      rec('session_meta', {session_id: 'csP', cwd: 'D:\\wP'}, '2026-01-01T00:00:00Z'),
      rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'cP'}, '2026-01-01T00:00:02Z'),
    ].join(''));
    await writeFile(join(dayB, 'rollout-2.jsonl'), [
      rec('session_meta', {session_id: 'csP', cwd: 'D:\\wP'}, '2026-01-01T00:00:00Z'),
      rec('response_item', {type: 'function_call_output', call_id: 'cP', output: 'done'}, '2026-01-01T00:00:03Z'),
      rec('response_item', {type: 'message', role: 'assistant', content: [{type: 'text', text: 'B 目录的回复'}]}, '2026-01-01T00:00:04Z'),
    ].join(''));
    const {readdir: realReaddirP} = await import('node:fs/promises');
    let failPathP = '';
    const ioP = {readdir: async (p, o) => {
      if (failPathP && String(p) === failPathP) throw Object.assign(new Error('EACCES: permission denied'), {code: 'EACCES'});
      return realReaddirP(p, o);
    }};
    const {src} = makeSrc({roots: [dir], io: ioP, listIntervalMs: 0});
    await src.scan(true);
    const baseP = src.sessions().find(s => s.id === 'csP');
    ok('跨目录会话：正常时完整折叠', !!baseP && baseP.calls.length === 1 && baseP.done === 1 && baseP.msgs.some(m => /B 目录的回复/.test(m.text)),
      `calls=${baseP && baseP.calls.length} done=${baseP && baseP.done} msgs=${baseP && baseP.msgs.length}`);
    failPathP = dayB;
    await src.scan();
    const partialP = src.sessions().find(s => s.id === 'csP');
    ok('跨目录会话：部分目录读失败时保留上次完整快照（完成不能变回运行中）',
      !!partialP && partialP.done === 1 && partialP.calls.length === 1 && !partialP.current && partialP.msgs.some(m => /B 目录的回复/.test(m.text)),
      `done=${partialP && partialP.done} current=${JSON.stringify(partialP && partialP.current)} msgs=${partialP && partialP.msgs.length}`);
    ok('跨目录会话：部分目录读失败时标 stale', src.stats().stale === true, `stale=${src.stats().stale}`);
    failPathP = '';
    await src.scan();
    const restoredP = src.sessions().find(s => s.id === 'csP');
    ok('跨目录会话：目录恢复后 stale 归 false 且状态完整', src.stats().stale === false && !!restoredP && restoredP.done === 1,
      `stale=${src.stats().stale} done=${restoredP && restoredP.done}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 3. 旧回合的未结束命令不能污染新回合（复核 v2.34 #3） */
  {
    const dir = await mk('codexreg-turns-');
    const st = mkState(dir); putThread(st, 'thOld', 'D:\\wOld'); putThread(st, 'thNew', 'D:\\wNew'); st.close();
    const h = mkHist(dir);
    putTurn(h, 'thOld', 't1', 'interrupted', 1); putTurn(h, 'thOld', 't2', 'completed', 2);
    putItem(h, 'thOld', 'o1', 'commandExecution', {type: 'commandExecution', id: 'old-cmd', command: 'sleep 9', status: 'inProgress'}, 1, 't1');
    putItem(h, 'thOld', 'o2', 'agentMessage', {type: 'agentMessage', text: '新回合已完成'}, 2, 't2');
    putTurn(h, 'thNew', 't1', 'interrupted', 1); putTurn(h, 'thNew', 't2', 'inProgress', 2);
    putItem(h, 'thNew', 'n1', 'commandExecution', {type: 'commandExecution', id: 'old-cmd2', command: 'sleep 8', status: 'inProgress'}, 1, 't1');
    putItem(h, 'thNew', 'n2', 'commandExecution', {type: 'commandExecution', id: 'new-cmd', command: 'npm test', status: 'inProgress'}, 2, 't2');
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const {src} = makeSrc({sqlite: true, sqlitePaths: paths});
    await src.scan(true);
    const oldS = src.sessions().find(s => s.id === 'thOld');
    const newS = src.sessions().find(s => s.id === 'thNew');
    const stBuild = buildState({sessions: src.sessions(), live: createLive(), codes: createCodes(),
      activeMs: 45 * 60000, maxAgents: 12, maxTasks: 80, servedFrom: 'test', source: 'codex'});
    const wfBusy = name => { const w = stBuild.workflows.find(x => x.name === name); return w ? w.busy : -1; };
    ok('旧回合残留命令：不再作为当前任务（current=null）', !!oldS && oldS.current === null, JSON.stringify(oldS && oldS.current));
    ok('旧回合残留命令：历史仍保留但标记结束', !!oldS && oldS.calls.some(c => c.callId === 'old-cmd' && c.done),
      JSON.stringify(oldS && oldS.calls.map(c => [c.callId, c.done])));
    ok('旧回合残留命令：工作区不再显示忙碌', wfBusy('wOld') === 0, `busy=${wfBusy('wOld')}`);
    ok('新回合仍有真实运行命令：current 指向新命令且忙碌',
      !!newS && !!newS.current && newS.current.callId === 'new-cmd' && wfBusy('wNew') === 1,
      `current=${JSON.stringify(newS && newS.current)} busy=${wfBusy('wNew')}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 4. 单线程查询失败不能当成空结果（复核 v2.34 #4） */
  {
    const dir = await mk('codexreg-queryfail-');
    const st = mkState(dir); putThread(st, 'thF', 'D:\\wF'); putThread(st, 'thG', 'D:\\wG'); st.close();
    const h = mkHist(dir);
    putItem(h, 'thF', 'f1', 'commandExecution', {type: 'commandExecution', id: 'fcmd', command: 'sleep 7', status: 'inProgress'}, 1);
    putItem(h, 'thG', 'g1', 'commandExecution', {type: 'commandExecution', id: 'gcmd', command: 'ls', status: 'completed', exitCode: 0, aggregatedOutput: 'ok'}, 1);
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const fault = {items: new Set()};
    const {src} = makeSrc({sqlite: true, sqlitePaths: paths, sqliteFault: fault});
    await src.scan(true);
    const beforeF = src.sessions().find(s => s.id === 'thF');
    ok('查询失败：初始运行中命令已折叠', !!beforeF && beforeF.calls.length === 1 && !!beforeF.current,
      `calls=${beforeF && beforeF.calls.length} current=${JSON.stringify(beforeF && beforeF.current)}`);
    fault.items.add('thF');
    const h2 = mkHist(dir);
    h2.prepare('insert into thread_items values (?,?,?,?,?,?,?)').run('thG', '', 'g2', 'agentMessage', JSON.stringify({type: 'agentMessage', text: 'G 新消息'}), Date.now(), 2);
    h2.close();
    await src.scan();
    const keptF = src.sessions().find(s => s.id === 'thF');
    const gAfter = src.sessions().find(s => s.id === 'thG');
    ok('查询失败：失败线程的缓存保留（calls 仍 1、仍在运行）',
      !!keptF && keptF.calls.length === 1 && !!keptF.current,
      `calls=${keptF && keptF.calls.length} current=${JSON.stringify(keptF && keptF.current)}`);
    ok('查询失败：另一个线程仍正常更新', !!gAfter && gAfter.msgs.some(m => /G 新消息/.test(m.text)),
      JSON.stringify(gAfter && gAfter.msgs.map(m => m.text)));
    ok('查询失败：源状态标 stale', src.stats().stale === true, `stale=${src.stats().stale}`);
    fault.items.clear();
    await src.scan();
    ok('查询恢复后：stale 归 false 且两线程都在', src.stats().stale === false && src.sessions().length === 2,
      `stale=${src.stats().stale} sessions=${JSON.stringify(src.sessions().map(s => s.id))}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 5. 命令失败但退出码为空时不能算成功（复核 v2.34 #5） */
  {
    const dir = await mk('codexreg-exitnull-');
    const st = mkState(dir); putThread(st, 'thX', 'D:\\wX'); st.close();
    const h = mkHist(dir);
    putItem(h, 'thX', 'x1', 'commandExecution', {type: 'commandExecution', id: 'x1', command: 'run', status: 'failed', exitCode: null, error: 'could not launch process'}, 1);
    putItem(h, 'thX', 'x2', 'commandExecution', {type: 'commandExecution', id: 'x2', command: 'okcmd', status: 'completed', exitCode: null, aggregatedOutput: 'fine'}, 2);
    putItem(h, 'thX', 'x3', 'commandExecution', {type: 'commandExecution', id: 'x3', command: 'pending', status: 'inProgress', exitCode: null}, 3);
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const {src, pushed} = makeSrc({sqlite: true, sqlitePaths: paths});
    await src.scan(true);
    const sx = src.sessions().find(s => s.id === 'thX');
    ok('命令失败（退出码为空）：计入失败而不是完成', !!sx && sx.failed === 1 && sx.done === 1,
      `failed=${sx && sx.failed} done=${sx && sx.done}`);
    ok('命令失败（退出码为空）：事件带 ok:false 和原因',
      pushed.some(e => e.ok === false && /could not launch|启动|失败/.test(e.name || '')), JSON.stringify(pushed.map(e => [e.name, e.ok])));
    ok('进行中命令（退出码为空）：仍然算运行中', !!sx && !!sx.current && sx.current.callId === 'x3',
      JSON.stringify(sx && sx.current));
    await rm(dir, {recursive: true, force: true});
  }

  /* 6. 内容哈希要覆盖所有展示字段：用户消息内容、文件路径/错误数组（复核 v2.34 #6） */
  {
    const dir = await mk('codexreg-hash2-');
    const st = mkState(dir); putThread(st, 'thH2', 'D:\\wH2'); st.close();
    const h = mkHist(dir);
    putItem(h, 'thH2', 'u1', 'userMessage', {type: 'userMessage', content: [{type: 'text', text: 'AAAA'}]}, 1);
    putItem(h, 'thH2', 'f1', 'fileChange', {type: 'fileChange', id: 'f1', changes: [{path: 'first.js', diff: ''}], errors: ['AAAA'], status: 'completed'}, 2);
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const {src, pushed} = makeSrc({sqlite: true, sqlitePaths: paths});
    await src.scan(true);
    ok('哈希2：首轮推送用户消息 AAAA 与文件 first.js',
      pushed.some(e => /AAAA/.test(e.name || '')) && pushed.some(e => /first\.js/.test(e.name || '')),
      JSON.stringify(pushed.map(e => e.name)));
    const h2 = mkHist(dir);
    h2.prepare('update thread_items set item_json=? where thread_id=? and item_id=?')
      .run(JSON.stringify({type: 'userMessage', content: [{type: 'text', text: 'BBBB'}]}), 'thH2', 'u1');
    h2.prepare('update thread_items set item_json=? where thread_id=? and item_id=?')
      .run(JSON.stringify({type: 'fileChange', id: 'f1', changes: [{path: 'second.js', diff: ''}], errors: ['BBBB'], status: 'completed'}), 'thH2', 'f1');
    h2.close();
    await src.scan();
    ok('哈希2：用户消息内容同长度更新（AAAA→BBBB）推新事件', pushed.some(e => /BBBB/.test(e.name || '')),
      JSON.stringify(pushed.map(e => e.name)));
    ok('哈希2：文件路径与错误数组更新推新事件', pushed.some(e => /second\.js/.test(e.name || '')),
      JSON.stringify(pushed.map(e => e.name)));
    await rm(dir, {recursive: true, force: true});
  }

  /* 7. 运行期间新增续聊 rollout 不能重推旧事件（复核 v2.34 #7） */
  {
    const dir = await mk('codexreg-newfile-');
    const linesA = [
      rec('session_meta', {session_id: 'csN', cwd: 'D:\\wN'}, '2026-01-01T00:00:00Z'),
      rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'cN'}, '2026-01-01T00:00:02Z'),
      rec('response_item', {type: 'function_call_output', call_id: 'cN', output: 'Process exited with code 7: EACCES: permission denied'}, '2026-01-01T00:00:03Z'),
    ].join('');
    await writeFile(join(dir, 'rollout-a.jsonl'), linesA);
    const {src, pushed} = makeSrc({roots: [dir], listIntervalMs: 0});
    await src.scan(true);
    const failBefore = pushed.filter(e => e.ok === false).length;
    ok('新增续聊文件前：失败事件 1 条', failBefore === 1, `${failBefore}`);
    const msgNew = rec('response_item', {type: 'message', role: 'assistant', content: [{type: 'text', text: '续聊新回复'}]}, '2026-01-01T00:00:10Z');
    await writeFile(join(dir, 'rollout-b.jsonl'), linesA + msgNew);
    await src.scan();
    ok('新增续聊文件后：旧失败事件不重推', pushed.filter(e => e.ok === false).length === 1,
      `${pushed.filter(e => e.ok === false).length}`);
    ok('新增续聊文件后：新消息推进事件流', pushed.some(e => /续聊新回复/.test(e.name || '')),
      JSON.stringify(pushed.map(e => e.name)));
    await rm(join(dir, 'rollout-b.jsonl'), {force: true});
    await src.scan();
    await writeFile(join(dir, 'rollout-b.jsonl'), linesA + msgNew);
    await src.scan();
    ok('移除并恢复续聊文件：不重复也不漏新事件',
      pushed.filter(e => e.ok === false).length === 1 && pushed.filter(e => /续聊新回复/.test(e.name || '')).length === 1,
      JSON.stringify(pushed.map(e => e.name)));
    await rm(dir, {recursive: true, force: true});
  }

  /* 8. 长历史：去重身份不能被裁剪，否则全量重读会把旧记录重推（复核 v2.36 #1，P1） */
  {
    const dir = await mk('codexreg-long-');
    const N = 8100;
    const lines = [rec('session_meta', {session_id: 'csLong', cwd: 'D:\\wLong'}, '2026-01-01T00:00:00Z')];
    for (let i = 1; i <= N; i++) {
      lines.push(rec('response_item', {type: 'message', role: 'assistant', content: [{type: 'text', text: 'history-' + i}]},
        new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()));
    }
    await writeFile(join(dir, 'rollout-long.jsonl'), lines.join(''));
    const {src, pushed} = makeSrc({roots: [dir], listIntervalMs: 0});
    await src.scan(true);
    ok('长历史：首轮只推末尾 10 条', pushed.length === 10, `pushed=${pushed.length}`);
    const append = i => rec('response_item', {type: 'message', role: 'assistant', content: [{type: 'text', text: 'fresh-' + i}]},
      new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString());
    await writeFile(join(dir, 'rollout-long.jsonl'), lines.concat([append(1)]).join(''));
    await src.scan();
    ok('长历史：追加第 1 条只推 1 条（旧记录不重推）', pushed.length === 11, `pushed=${pushed.length}`);
    const after1 = pushed.length;
    await writeFile(join(dir, 'rollout-long.jsonl'), lines.concat([append(1), append(2)]).join(''));
    await src.scan();
    await writeFile(join(dir, 'rollout-long.jsonl'), lines.concat([append(1), append(2), append(3)]).join(''));
    await src.scan();
    ok('长历史：连续追加三轮每轮只新增 1 条', pushed.length === after1 + 2, `pushed=${pushed.length}（期望 ${after1 + 2}）`);
    ok('长历史：事件里没有重复的旧 history',
      pushed.filter(e => /history-/.test(e.name || '')).length === 10,
      `history 事件=${pushed.filter(e => /history-/.test(e.name || '')).length}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 9. 最新回合已终止时，残留工具不能算运行中（复核 v2.36 #2） */
  {
    const dir = await mk('codexreg-terminal-');
    const st = mkState(dir);
    for (const id of ['thDone', 'thStop', 'thLive']) putThread(st, id, 'D:\\w' + id);
    st.close();
    const h = mkHist(dir);
    putTurn(h, 'thDone', 't1', 'completed', 1);
    putItem(h, 'thDone', 'd1', 'commandExecution', {type: 'commandExecution', id: 'c-done', command: 'sleep 9', status: 'inProgress'}, 1, 't1');
    putItem(h, 'thDone', 'd2', 'fileChange', {type: 'fileChange', id: 'f-done', changes: [{path: 'x.txt'}], status: 'inProgress'}, 2, 't1');
    putTurn(h, 'thStop', 't1', 'interrupted', 1);
    putItem(h, 'thStop', 's1', 'commandExecution', {type: 'commandExecution', id: 'c-stop', command: 'sleep 8', status: 'inProgress'}, 1, 't1');
    putTurn(h, 'thLive', 't1', 'inProgress', 1);
    putItem(h, 'thLive', 'l1', 'commandExecution', {type: 'commandExecution', id: 'c-live', command: 'sleep 7', status: 'inProgress'}, 1, 't1');
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const {src} = makeSrc({sqlite: true, sqlitePaths: paths});
    await src.scan(true);
    const doneS = src.sessions().find(s => s.id === 'thDone');
    const stopS = src.sessions().find(s => s.id === 'thStop');
    const liveS = src.sessions().find(s => s.id === 'thLive');
    const stB = buildState({sessions: src.sessions(), live: createLive(), codes: createCodes(),
      activeMs: 45 * 60000, maxAgents: 12, maxTasks: 80, servedFrom: 'test', source: 'codex'});
    const busyName = n => { const w = stB.workflows.find(x => x.name === n); return w ? w.busy : -1; };
    ok('回合终态：completed 回合的残留命令不再算当前任务', !!doneS && doneS.current === null && busyName('wthDone') === 0,
      `current=${JSON.stringify(doneS && doneS.current)} busy=${busyName('wthDone')}`);
    ok('回合终态：残留调用标记结束/作废，不计成功也不计失败',
      !!doneS && doneS.calls.every(c => c.done) && doneS.done === 0 && doneS.failed === 0,
      JSON.stringify(doneS && doneS.calls.map(c => [c.callId, c.done, !!c.aborted, c.error])) + ` done=${doneS && doneS.done} failed=${doneS && doneS.failed}`);
    ok('回合终态：interrupted 回合的残留命令同样不算运行中',
      !!stopS && stopS.current === null && busyName('wthStop') === 0,
      `current=${JSON.stringify(stopS && stopS.current)} busy=${busyName('wthStop')}`);
    ok('回合终态：最新回合仍在运行时，真实命令仍是当前任务',
      !!liveS && !!liveS.current && liveS.current.callId === 'c-live', JSON.stringify(liveS && liveS.current));
    await rm(dir, {recursive: true, force: true});
  }

  /* 10. JSONL 的 task_complete 必须收尾残留调用（复核 v2.36 #6） */
  {
    const dir = await mk('codexreg-taskcomplete-');
    await writeFile(join(dir, 'rollout-tc.jsonl'), [
      rec('session_meta', {session_id: 'csTC', cwd: 'D:\\wTC'}, '2026-01-01T00:00:00Z'),
      rec('event_msg', {type: 'task_started'}, '2026-01-01T00:00:01Z'),
      rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"sleep 9"}', call_id: 'tc1'}, '2026-01-01T00:00:02Z'),
      rec('event_msg', {type: 'task_complete'}, '2026-01-01T00:00:09Z'),
    ].join(''));
    const {src} = makeSrc({roots: [dir], listIntervalMs: 0});
    await src.scan(true);
    const s = src.sessions().find(x => x.id === 'csTC');
    ok('JSONL task_complete：残留调用不再算运行中', !!s && s.current === null && s.openStep == null,
      `current=${JSON.stringify(s && s.current)} openStep=${s && s.openStep}`);
    ok('JSONL task_complete：残留调用标记作废且不计成功',
      !!s && s.calls.some(c => c.callId === 'tc1' && c.done && c.aborted) && s.done === 0,
      JSON.stringify(s && s.calls.map(c => [c.callId, c.done, !!c.aborted])) + ` done=${s && s.done}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 10b. SQLite 归档后由 JSONL 展示历史：历史残留调用不能把会话显示成忙碌（复核 v2.36 #6） */
  {
    const dir = await mk('codexreg-archived-');
    const root = join(dir, 'sessions');
    await mkdir(root, {recursive: true});
    await writeFile(join(root, 'rollout-ar.jsonl'), [
      rec('session_meta', {session_id: 'thAr', cwd: 'D:\\wAr'}, '2026-01-01T00:00:00Z'),
      rec('event_msg', {type: 'task_started'}, '2026-01-01T00:00:01Z'),
      rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"sleep 6"}', call_id: 'ar1'}, '2026-01-01T00:00:02Z'),
      rec('event_msg', {type: 'task_complete'}, '2026-01-01T00:00:08Z'),
    ].join(''));
    const st = mkState(dir); putThread(st, 'thAr', 'D:\\wAr', {archived: 1}); st.close();
    const h = mkHist(dir);
    putTurn(h, 'thAr', 't1', 'completed', 1);
    putItem(h, 'thAr', 'a1', 'agentMessage', {type: 'agentMessage', text: 'SQLite 已归档'}, 1, 't1');
    h.close();
    const {src} = makeSrc({roots: [root], sqlite: true,
      sqlitePaths: {state: join(dir, 'state.db'), history: join(dir, 'history.db')}});
    await src.scan(true);
    const ar = src.sessions().find(s => s.id === 'thAr');
    ok('归档后 JSONL 历史：会话仍可展示但不再算运行中', !!ar && ar.current === null,
      `session=${!!ar} current=${JSON.stringify(ar && ar.current)}`);
    ok('归档后 JSONL 历史：工作区不显示忙碌', src.stats().running === 0, `running=${src.stats().running}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 11. Codex 单 rollout 读取失败：保留完整快照、标 stale、恢复后重试（复核 v2.36 #5） */
  {
    const dir = await mk('codexreg-readfail-');
    const fa = join(dir, 'rollout-a.jsonl'), fb = join(dir, 'rollout-b.jsonl');
    const bodyA = [
      rec('session_meta', {session_id: 'csRF', cwd: 'D:\\wRF'}, '2026-01-01T00:00:00Z'),
      rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'rf1'}, '2026-01-01T00:00:02Z'),
    ].join('');
    const bodyB = [
      rec('session_meta', {session_id: 'csRF', cwd: 'D:\\wRF'}, '2026-01-01T00:00:00Z'),
      rec('response_item', {type: 'function_call_output', call_id: 'rf1', output: 'done'}, '2026-01-01T00:00:03Z'),
      rec('response_item', {type: 'message', role: 'assistant', content: [{type: 'text', text: 'B 的回复'}]}, '2026-01-01T00:00:04Z'),
    ].join('');
    await writeFile(fa, bodyA); await writeFile(fb, bodyB);
    const {readFile: realReadFile, stat: realStat} = await import('node:fs/promises');
    let failRead = '', failStat = '';
    const io = {
      readFile: async (p) => {
        if (failRead && String(p) === failRead) throw Object.assign(new Error('EACCES: permission denied'), {code: 'EACCES'});
        return realReadFile(p);
      },
      stat: async (p) => {
        if (failStat && String(p) === failStat) throw Object.assign(new Error('EACCES: permission denied'), {code: 'EACCES'});
        return realStat(p);
      },
    };
    const {src} = makeSrc({roots: [dir], io, listIntervalMs: 0});
    await src.scan(true);
    const baseR = src.sessions().find(s => s.id === 'csRF');
    ok('读取失败：正常时完整折叠（done=1、不运行）',
      !!baseR && baseR.done === 1 && !baseR.current,
      `done=${baseR && baseR.done} current=${JSON.stringify(baseR && baseR.current)}`);
    await writeFile(fa, bodyA + '\n');   // 触发 A 重读
    failRead = fb;
    await src.scan();
    const failR = src.sessions().find(s => s.id === 'csRF');
    ok('读取失败：保留上次完整快照（不退回运行中）',
      !!failR && failR.done === 1 && !failR.current,
      `done=${failR && failR.done} current=${JSON.stringify(failR && failR.current)}`);
    ok('读取失败：源状态标 stale', src.stats().stale === true, `stale=${src.stats().stale}`);
    failRead = '';
    await src.scan();
    const recR = src.sessions().find(s => s.id === 'csRF');
    ok('读取失败恢复：无需改文件也能重试，stale 归 false 且状态完整',
      src.stats().stale === false && !!recR && recR.done === 1,
      `stale=${src.stats().stale} done=${recR && recR.done}`);
    // stat 失败走同一策略：保留缓存 + stale，恢复后重试
    failStat = fb;
    await src.scan();
    ok('stat 失败：缓存保留并标 stale', !!src.sessions().find(s => s.id === 'csRF') && src.stats().stale === true,
      `stale=${src.stats().stale}`);
    failStat = '';
    await src.scan();
    ok('stat 恢复：stale 归 false', src.stats().stale === false, `stale=${src.stats().stale}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 12. Codex 失败文件生命周期：失败 → 真实删除要退出；首次失败也要提示（复核 v2.37 #1） */
  {
    const dir = await mk('codexreg-faillife-');
    const fa = join(dir, 'rollout-a.jsonl');
    const body = [
      rec('session_meta', {session_id: 'csFA', cwd: 'D:\\wFA'}, '2026-01-01T00:00:00Z'),
      rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"sleep 5"}', call_id: 'fa1'}, '2026-01-01T00:00:02Z'),
    ].join('');
    await writeFile(fa, body);
    const {readFile: realReadFileA} = await import('node:fs/promises');
    let failReadA = '';
    const ioA = {readFile: async (p) => {
      if (failReadA && String(p) === failReadA) throw Object.assign(new Error('EACCES: permission denied'), {code: 'EACCES'});
      return realReadFileA(p);
    }};
    const {src} = makeSrc({roots: [dir], io: ioA, listIntervalMs: 0});
    await src.scan(true);
    ok('失败文件：初始 running=1', !!src.sessions().find(s => s.id === 'csFA' && s.current),
      JSON.stringify(src.sessions().map(s => [s.id, !!s.current])));
    await writeFile(fa, body + '\n');   // 触发重读
    failReadA = fa;
    await src.scan();
    ok('失败文件：失败时保留会话并标 stale', !!src.sessions().find(s => s.id === 'csFA' && s.current) && src.stats().stale === true,
      `sessions=${JSON.stringify(src.sessions().map(s => s.id))} stale=${src.stats().stale}`);
    failReadA = '';
    await rm(fa, {force: true});
    await src.scan();
    await src.scan();
    ok('失败文件：实际删除后会话退出、stale 归 false、files=0',
      src.sessions().length === 0 && src.stats().stale === false && src.stats().files === 0,
      `sessions=${JSON.stringify(src.sessions().map(s => s.id))} stale=${src.stats().stale} files=${src.stats().files}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 12b. 首次读取就失败的文件：不建半份会话，但要提示 stale，恢复后重试（复核 v2.37 #1） */
  {
    const dir = await mk('codexreg-firstfail-');
    const fb = join(dir, 'rollout-b.jsonl');
    await writeFile(fb, [
      rec('session_meta', {session_id: 'csFB', cwd: 'D:\\wFB'}, '2026-01-01T00:00:00Z'),
      rec('response_item', {type: 'message', role: 'user', content: [{type: 'text', text: '首次失败样本'}]}, '2026-01-01T00:00:01Z'),
    ].join(''));
    const {readFile: realReadFileB, stat: realStatB} = await import('node:fs/promises');
    let failReadB = fb, failStatB = '';
    const ioB = {
      readFile: async (p) => {
        if (failReadB && String(p) === failReadB) throw Object.assign(new Error('EACCES'), {code: 'EACCES'});
        return realReadFileB(p);
      },
      stat: async (p) => {
        if (failStatB && String(p) === failStatB) throw Object.assign(new Error('EACCES'), {code: 'EACCES'});
        return realStatB(p);
      },
    };
    const {src} = makeSrc({roots: [dir], io: ioB, listIntervalMs: 0});
    await src.scan(true);
    ok('首次读取失败：不建半份会话但标 stale', src.sessions().length === 0 && src.stats().stale === true,
      `sessions=${JSON.stringify(src.sessions().map(s => s.id))} stale=${src.stats().stale}`);
    failReadB = '';
    await src.scan();
    ok('首次读取恢复：能识别会话且 stale 归 false',
      !!src.sessions().find(s => s.id === 'csFB') && src.stats().stale === false,
      `sessions=${JSON.stringify(src.sessions().map(s => s.id))} stale=${src.stats().stale}`);
    // stat 首次失败也应提示 stale 并可恢复
    failStatB = fb;
    await src.scan();
    ok('首次 stat 失败：保留失败提示', src.stats().stale === true, `stale=${src.stats().stale}`);
    failStatB = '';
    await src.scan();
    ok('stat 恢复：stale 归 false', src.stats().stale === false, `stale=${src.stats().stale}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 13. 新 rollout 先为空时不能永久缓存错误 ID（复核 v2.37 #2） */
  {
    const dir = await mk('codexreg-identity-');
    const fc = join(dir, 'rollout-c.jsonl'), fd = join(dir, 'rollout-d.jsonl');
    await writeFile(fc, '');   // 先空文件
    const {src} = makeSrc({roots: [dir], listIntervalMs: 0});
    await src.scan(true);
    ok('空 rollout：不产生以文件名命名的假会话', src.sessions().length === 0,
      JSON.stringify(src.sessions().map(s => s.id)));
    const full = [
      rec('session_meta', {session_id: 'real-session', cwd: 'D:\\wReal'}, '2026-01-01T00:00:00Z'),
      rec('response_item', {type: 'message', role: 'user', content: [{type: 'text', text: '真实会话消息'}]}, '2026-01-01T00:00:01Z'),
    ].join('');
    await writeFile(fc, full);
    await src.scan();
    ok('写入 session_meta 后使用真实 ID（不再是文件名）',
      !!src.sessions().find(s => s.id === 'real-session') && !src.sessions().some(s => s.id === 'rollout-c'),
      JSON.stringify(src.sessions().map(s => s.id)));
    await writeFile(fd, full);   // 同会话续聊文件
    await src.scan();
    const ids = src.sessions().map(s => s.id);
    ok('新增续聊文件：会话不被拆成两个 ID', ids.length === 1 && ids[0] === 'real-session', JSON.stringify(ids));
    ok('新增续聊文件：同一条消息不重复',
      (src.sessions()[0]?.msgs || []).filter(m => /真实会话消息/.test(m.text)).length === 1,
      JSON.stringify(src.sessions()[0] && src.sessions()[0].msgs));
    // 同路径替换为另一会话
    await rm(fd, {force: true});
    await writeFile(fc, [
      rec('session_meta', {session_id: 'other-session', cwd: 'D:\\wOther'}, '2026-01-01T00:00:00Z'),
      rec('response_item', {type: 'message', role: 'user', content: [{type: 'text', text: '替换后的消息'}]}, '2026-01-01T00:00:02Z'),
    ].join(''));
    await src.scan();
    const ids2 = src.sessions().map(s => s.id);
    ok('同路径替换为另一会话：身份更新、不残留旧 ID', ids2.length === 1 && ids2[0] === 'other-session', JSON.stringify(ids2));
    await rm(dir, {recursive: true, force: true});
  }

  /* 14. MCP / 协作调用的失败判定要在事件与统计两侧一致（复核 v2.37 #4） */
  {
    const dir = await mk('codexreg-failrule-');
    const st = mkState(dir); putThread(st, 'thRule', 'D:\\wRule'); st.close();
    const h = mkHist(dir);
    putItem(h, 'thRule', 'm1', 'mcpToolCall', {type: 'mcpToolCall', id: 'm1', server: 'srv', tool: 'do', status: 'completed', errors: ['EACCES'], result: {content: []}}, 1);
    putItem(h, 'thRule', 'c1', 'collabAgentToolCall', {type: 'collabAgentToolCall', id: 'c1', tool: 'spawn', status: 'error'}, 2);
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const {src, pushed} = makeSrc({sqlite: true, sqlitePaths: paths});
    await src.scan(true);
    const s = src.sessions().find(x => x.id === 'thRule');
    ok('失败判定统一：mcp errors 数组与协作 status=error 都计入失败', !!s && s.failed === 2, `failed=${s && s.failed} done=${s && s.done}`);
    ok('失败判定统一：调用标记 error 且 lastFail 有值', !!s && s.calls.every(c => c.error) && !!s.lastFail,
      JSON.stringify(s && s.calls.map(c => [c.callId, c.error])) + ` lastFail=${JSON.stringify(s && s.lastFail)}`);
    ok('失败判定统一：两条事件都是 ok:false', pushed.filter(e => e.ok === false).length === 2,
      JSON.stringify(pushed.map(e => [e.name, e.ok])));
    await rm(dir, {recursive: true, force: true});
  }

  /* 15. 整个配置根目录删除后会话要退出；EACCES 则保留并提示（复核 v2.38 #1） */
  {
    const root = await mk('codexreg-rootgone-');
    const sub = join(root, '2026', '01');
    await mkdir(sub, {recursive: true});
    await writeFile(join(sub, 'rollout-r.jsonl'), [
      rec('session_meta', {session_id: 'csRG', cwd: 'D:\\wRG'}, '2026-01-01T00:00:00Z'),
      rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"sleep 5"}', call_id: 'rg1'}, '2026-01-01T00:00:02Z'),
    ].join(''));
    const {readdir: realReaddirG} = await import('node:fs/promises');
    let failRoot = '';
    const ioG = {readdir: async (p, o) => {
      if (failRoot && String(p) === failRoot) throw Object.assign(new Error('EACCES: permission denied'), {code: 'EACCES'});
      return realReaddirG(p, o);
    }};
    const {src} = makeSrc({roots: [root], io: ioG, listIntervalMs: 0});
    await src.scan(true);
    ok('根目录删除前：会话在运行', !!src.sessions().find(s => s.id === 'csRG' && s.current),
      JSON.stringify(src.sessions().map(s => [s.id, !!s.current])));
    // 根目录 EACCES：保留缓存并提示
    failRoot = root;
    await src.scan();
    ok('根目录 EACCES：缓存保留且 stale=true', !!src.sessions().find(s => s.id === 'csRG') && src.stats().stale === true,
      `sessions=${src.sessions().length} stale=${src.stats().stale}`);
    failRoot = '';
    // 真正删除整个根目录
    await rm(root, {recursive: true, force: true});
    await src.scan();
    await src.scan();
    ok('根目录删除：会话退出、files=0、stale=false',
      src.sessions().length === 0 && src.stats().files === 0 && src.stats().stale === false,
      `sessions=${JSON.stringify(src.sessions().map(s => s.id))} files=${src.stats().files} stale=${src.stats().stale}`);
    // 重建根目录后可重新识别
    await mkdir(sub, {recursive: true});
    await writeFile(join(sub, 'rollout-r2.jsonl'), [
      rec('session_meta', {session_id: 'csRG2', cwd: 'D:\\wRG'}, '2026-01-01T00:00:00Z'),
      rec('response_item', {type: 'message', role: 'user', content: [{type: 'text', text: '重建后的会话'}]}, '2026-01-01T00:00:03Z'),
    ].join(''));
    await src.scan();
    ok('根目录重建：可重新识别新会话', !!src.sessions().find(s => s.id === 'csRG2') && src.stats().stale === false,
      JSON.stringify(src.sessions().map(s => s.id)));
    await rm(root, {recursive: true, force: true});
  }

  /* 16. 多 rollout 聚合签名：较旧成员的等长修改也要重折叠（复核 v2.38 #2） */
  {
    const dir = await mk('codexreg-multisig-');
    const fa = join(dir, 'a.jsonl'), fb = join(dir, 'b.jsonl');
    const meta = rec('session_meta', {session_id: 'csMS', cwd: 'D:\\wMS'}, '2026-01-01T00:00:00Z');
    await writeFile(fa, meta + rec('response_item', {type: 'message', role: 'assistant', content: [{type: 'text', text: 'AAAA'}]}, '2026-01-01T00:00:01Z'));
    await writeFile(fb, meta + rec('response_item', {type: 'message', role: 'assistant', content: [{type: 'text', text: 'newest'}]}, '2026-01-01T00:00:09Z'));
    const {utimes} = await import('node:fs/promises');
    const t0 = Date.now() - 20000, t1 = Date.now() - 10000, t2 = Date.now();
    await utimes(fa, new Date(t0), new Date(t0));
    await utimes(fb, new Date(t2), new Date(t2));
    const {src, pushed} = makeSrc({roots: [dir], listIntervalMs: 0});
    await src.scan(true);
    const before = src.sessions().find(s => s.id === 'csMS');
    ok('多 rollout：初读两条消息都在', !!before && before.msgs.some(m => m.text === 'AAAA') && before.msgs.some(m => m.text === 'newest'),
      JSON.stringify(before && before.msgs.map(m => m.text)));
    // 较旧文件等长修改，但仍是"较旧"（mtime t1 < fb 的 t2）
    await writeFile(fa, meta + rec('response_item', {type: 'message', role: 'assistant', content: [{type: 'text', text: 'BBBB'}]}, '2026-01-01T00:00:01Z'));
    await utimes(fa, new Date(t1), new Date(t1));
    await src.scan();
    const after = src.sessions().find(s => s.id === 'csMS');
    ok('多 rollout：较旧成员等长修改也要重折叠', !!after && after.msgs.some(m => m.text === 'BBBB'),
      JSON.stringify(after && after.msgs.map(m => m.text)));
    ok('多 rollout：等长修改要推事件', pushed.some(e => /BBBB/.test(e.name || '')), JSON.stringify(pushed.map(e => e.name)));
    await rm(dir, {recursive: true, force: true});
  }

  /* 17. 读权限恢复为空文件后，旧 I/O 失败标记要清除（复核 v2.38 #6） */
  {
    const dir = await mk('codexreg-emptyrecover-');
    const f = join(dir, 'rollout-e.jsonl');
    await writeFile(f, '');
    const {readFile: realReadFileE} = await import('node:fs/promises');
    let failReadE = f;
    const ioE = {readFile: async (p) => {
      if (failReadE && String(p) === failReadE) throw Object.assign(new Error('EACCES'), {code: 'EACCES'});
      return realReadFileE(p);
    }};
    const {src} = makeSrc({roots: [dir], io: ioE, listIntervalMs: 0});
    await src.scan(true);
    ok('空文件读取失败：stale=true', src.stats().stale === true && src.sessions().length === 0,
      `stale=${src.stats().stale} sessions=${src.sessions().length}`);
    failReadE = '';
    await src.scan();
    await src.scan();
    ok('空文件恢复可读：stale 归 false（不保留旧权限错误）', src.stats().stale === false && src.sessions().length === 0,
      `stale=${src.stats().stale} sessions=${src.sessions().length}`);
    await writeFile(f, [
      rec('session_meta', {session_id: 'csER', cwd: 'D:\\wER'}, '2026-01-01T00:00:00Z'),
      rec('response_item', {type: 'message', role: 'user', content: [{type: 'text', text: '写完整后可识别'}]}, '2026-01-01T00:00:02Z'),
    ].join(''));
    await src.scan();
    ok('空文件写完整后：能识别会话且 stale=false', !!src.sessions().find(s => s.id === 'csER') && src.stats().stale === false,
      JSON.stringify(src.sessions().map(s => s.id)));
    await rm(dir, {recursive: true, force: true});
  }

  /* 18. subAgentActivity 的失败统计与事件统一（复核 v2.38 #4） */
  {
    const dir = await mk('codexreg-subfail-');
    const st = mkState(dir); putThread(st, 'thSub', 'D:\\wSub'); st.close();
    const h = mkHist(dir);
    putItem(h, 'thSub', 's1', 'subAgentActivity', {type: 'subAgentActivity', id: 's1', kind: 'completed', agentPath: 'worker', error: 'EACCES'}, 1);
    putItem(h, 'thSub', 's2', 'subAgentActivity', {type: 'subAgentActivity', id: 's2', kind: 'completed', agentPath: 'worker2'}, 2);
    putItem(h, 'thSub', 's3', 'subAgentActivity', {type: 'subAgentActivity', id: 's3', kind: 'failed', agentPath: 'worker3'}, 3);
    putItem(h, 'thSub', 's4', 'subAgentActivity', {type: 'subAgentActivity', id: 's4', kind: 'completed', agentPath: 'worker4', errors: ['EACCES']}, 4);
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const {src, pushed} = makeSrc({sqlite: true, sqlitePaths: paths});
    await src.scan(true);
    const s = src.sessions().find(x => x.id === 'thSub');
    ok('subAgentActivity：显式 error / errors / kind=failed 都计入失败', !!s && s.failed === 3 && s.done === 1,
      `failed=${s && s.failed} done=${s && s.done}`);
    const badNames = pushed.filter(e => e.ok === false).map(e => e.name || '');
    ok('subAgentActivity：三类失败事件都带 ok:false', badNames.length === 3 && badNames.some(n => /worker/.test(n)),
      JSON.stringify(pushed.map(e => [e.name, e.ok])));
    ok('subAgentActivity：正常完成的生命周期不标失败', pushed.some(e => /worker2/.test(e.name || '') && e.ok !== false),
      JSON.stringify(pushed.map(e => [e.name, e.ok])));
    await rm(dir, {recursive: true, force: true});
  }

  /* 19. Codex JSONL 已有工具输出被改写（成功→失败）要推失败事件（复核 v2.39 #3） */
  {
    const dir = await mk('codexreg-outedit-');
    const f = join(dir, 'rollout-o.jsonl');
    const head = [
      rec('session_meta', {session_id: 'csOE', cwd: 'D:\\wOE'}, '2026-01-01T00:00:00Z'),
      rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"run"}', call_id: 'oe1'}, '2026-01-01T00:00:02Z'),
    ].join('');
    await writeFile(f, head + rec('response_item', {type: 'function_call_output', call_id: 'oe1', output: 'Process exited with code 0'}, '2026-01-01T00:00:03Z'));
    const {src, pushed} = makeSrc({roots: [dir], listIntervalMs: 0});
    await src.scan(true);
    const okS = src.sessions().find(s => s.id === 'csOE');
    ok('输出改写：初读成功输出时 done=1、无失败', !!okS && okS.done === 1 && okS.failed === 0,
      `done=${okS && okS.done} failed=${okS && okS.failed}`);
    // 改写同一输出为失败（timestamp/type/call_id 不变）
    await writeFile(f, head + rec('response_item', {type: 'function_call_output', call_id: 'oe1', output: 'Process exited with code 7: EACCES'}, '2026-01-01T00:00:03Z'));
    await src.scan();
    const badS = src.sessions().find(s => s.id === 'csOE');
    ok('输出改写：统计应转为 failed=1、done=0', !!badS && badS.failed === 1 && badS.done === 0,
      `done=${badS && badS.done} failed=${badS && badS.failed}`);
    ok('输出改写：要推出一条新的 ok:false 失败事件',
      pushed.some(e => e.ok === false && /exit 7/.test(e.name || '')), JSON.stringify(pushed.map(e => [e.name, e.ok])));
    ok('输出改写：原有调用事件不重复推送',
      pushed.filter(e => /shell|run/.test(e.name || '') && e.ok !== false).length === 1,
      JSON.stringify(pushed.map(e => [e.name, e.ok])));
    await rm(dir, {recursive: true, force: true});
  }

  /* 20. 同一调用的两份 rollout 输出冲突时，统计与事件必须用同一个权威版本（复核 v2.40 #1） */
  {
    const {utimes} = await import('node:fs/promises');
    // 场景 A：失败副本更新，且文件名排在后面（验证按 mtime 而不是文件顺序选权威版本）
    const dirA = await mk('codexreg-conflictA-');
    const metaA = rec('session_meta', {session_id: 'csCF', cwd: 'D:\\wCF'}, '2026-01-01T00:00:00Z');
    const callA = rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"run"}', call_id: 'cf1'}, '2026-01-01T00:00:02Z');
    const failA = rec('response_item', {type: 'function_call_output', call_id: 'cf1', output: 'Process exited with code 7: EACCES'}, '2026-01-01T00:00:03Z');
    const okA = rec('response_item', {type: 'function_call_output', call_id: 'cf1', output: 'Process exited with code 0'}, '2026-01-01T00:00:03Z');
    await writeFile(join(dirA, 'a.jsonl'), metaA + callA + okA);     // 成功副本：文件名靠前、mtime 更旧
    await writeFile(join(dirA, 'b.jsonl'), metaA + callA + failA);   // 失败副本：文件名靠后、mtime 更新
    await utimes(join(dirA, 'a.jsonl'), new Date(Date.now() - 20000), new Date(Date.now() - 20000));
    await utimes(join(dirA, 'b.jsonl'), new Date(Date.now() - 10000), new Date(Date.now() - 10000));
    const {src: srcA, pushed: pushedA} = makeSrc({roots: [dirA], listIntervalMs: 0});
    await srcA.scan(true);
    const sA = srcA.sessions().find(s => s.id === 'csCF');
    ok('冲突副本 A：按较新副本统计（failed=1、done=0）', !!sA && sA.failed === 1 && sA.done === 0,
      `done=${sA && sA.done} failed=${sA && sA.failed}`);
    ok('冲突副本 A：事件也是失败事件（与统计一致）',
      pushedA.some(e => e.ok === false && /exit 7/.test(e.name || '')), JSON.stringify(pushedA.map(e => [e.name, e.ok])));
    await rm(dirA, {recursive: true, force: true});

    // 场景 B：成功副本更新 → 统计成功、不发失败事件
    const dirB = await mk('codexreg-conflictB-');
    await writeFile(join(dirB, 'a.jsonl'), metaA + callA + okA);
    await writeFile(join(dirB, 'b.jsonl'), metaA + callA + failA);
    await utimes(join(dirB, 'a.jsonl'), new Date(Date.now() - 10000), new Date(Date.now() - 10000));
    await utimes(join(dirB, 'b.jsonl'), new Date(Date.now() - 20000), new Date(Date.now() - 20000));
    const {src: srcB, pushed: pushedB} = makeSrc({roots: [dirB], listIntervalMs: 0});
    await srcB.scan(true);
    const sB = srcB.sessions().find(s => s.id === 'csCF');
    ok('冲突副本 B：按较新副本统计（done=1、failed=0）', !!sB && sB.done === 1 && sB.failed === 0,
      `done=${sB && sB.done} failed=${sB && sB.failed}`);
    ok('冲突副本 B：不发失败事件（与统计一致）', !pushedB.some(e => e.ok === false),
      JSON.stringify(pushedB.map(e => [e.name, e.ok])));
    await rm(dirB, {recursive: true, force: true});
  }

  /* 21. 带 ID 的消息改写后事件要更新（复核 v2.40 #6） */
  {
    const dir = await mk('codexreg-msgid-');
    const f = join(dir, 'rollout-m.jsonl');
    const head = rec('session_meta', {session_id: 'csMI', cwd: 'D:\\wMI'}, '2026-01-01T00:00:00Z');
    await writeFile(f, head + rec('response_item', {type: 'message', id: 'm1', role: 'assistant', content: [{type: 'text', text: 'AAAA'}]}, '2026-01-01T00:00:02Z'));
    const {src, pushed} = makeSrc({roots: [dir], listIntervalMs: 0});
    await src.scan(true);
    ok('消息改写：初读文本 AAAA', pushed.some(e => /AAAA/.test(e.name || '')),
      JSON.stringify(pushed.map(e => e.name)));
    await writeFile(f, head + rec('response_item', {type: 'message', id: 'm1', role: 'assistant', content: [{type: 'text', text: 'BBBB'}]}, '2026-01-01T00:00:02Z'));
    await src.scan();
    const s = src.sessions().find(x => x.id === 'csMI');
    ok('消息改写：会话文本更新为 BBBB', !!s && s.msgs.some(m => m.text === 'BBBB'), JSON.stringify(s && s.msgs));
    ok('消息改写：同长度带 ID 消息也补推事件', pushed.some(e => /BBBB/.test(e.name || '')),
      JSON.stringify(pushed.map(e => e.name)));
    await rm(dir, {recursive: true, force: true});
  }

  /* 22. 成员文件变化时，读取成功前不能丢旧快照（复核 v2.41 #1） */
  {
    const {readFile: realReadFileM} = await import('node:fs/promises');
    const dir = await mk('codexreg-member-');
    const fa = join(dir, 'a.jsonl'), fb = join(dir, 'b.jsonl');
    const meta = rec('session_meta', {session_id: 'csMB', cwd: 'D:\\wMB'}, '2026-01-01T00:00:00Z');
    const call = rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"run"}', call_id: 'mb1'}, '2026-01-01T00:00:02Z');
    await writeFile(fa, meta + call);
    let failB = false, readsB = 0;
    const ioM = {readFile: async (p) => {
      if (String(p) === fb) { readsB++; if (failB && readsB >= 2) throw Object.assign(new Error('EACCES'), {code: 'EACCES'}); }
      return realReadFileM(p);
    }};
    const {src} = makeSrc({roots: [dir], io: ioM, listIntervalMs: 0});
    await src.scan(true);
    ok('成员变化基线：1 会话运行中', !!src.sessions().find(s => s.id === 'csMB' && s.current),
      JSON.stringify(src.sessions().map(s => [s.id, !!s.current])));
    await writeFile(fb, meta + rec('response_item', {type: 'function_call_output', call_id: 'mb1', output: 'done'}, '2026-01-01T00:00:03Z'));
    failB = true;
    await src.scan();   // readOwner 第一次读成功；decodeGroup 第二次读失败
    ok('成员新增：读取失败时旧快照不断档、标 stale',
      !!src.sessions().find(s => s.id === 'csMB' && s.current) && src.stats().stale === true,
      `sessions=${JSON.stringify(src.sessions().map(s => s.id))} stale=${src.stats().stale}`);
    failB = false;
    await src.scan();
    const okS = src.sessions().find(s => s.id === 'csMB');
    ok('成员新增：恢复后合并新副本（done=1）且 stale=false', !!okS && okS.done === 1 && !okS.current && src.stats().stale === false,
      `done=${okS && okS.done} cur=${okS && !!okS.current} stale=${src.stats().stale}`);
    await rm(dir, {recursive: true, force: true});

    const dir2 = await mk('codexreg-member2-');
    const fa2 = join(dir2, 'a.jsonl');
    await writeFile(fa2, meta + call);
    await writeFile(join(dir2, 'b.jsonl'), meta + call);
    let failA = false;
    const ioM2 = {readFile: async (p) => {
      if (failA && String(p) === fa2) throw Object.assign(new Error('EACCES'), {code: 'EACCES'});
      return realReadFileM(p);
    }};
    const {src: src2} = makeSrc({roots: [dir2], io: ioM2, listIntervalMs: 0});
    await src2.scan(true);
    ok('成员删除基线：1 会话运行中', !!src2.sessions().find(s => s.id === 'csMB' && s.current), JSON.stringify(src2.sessions().map(s => s.id)));
    await rm(join(dir2, 'b.jsonl'), {force: true});
    failA = true;
    await src2.scan();
    ok('成员删除：剩余文件读取失败时旧快照保留且 stale=true',
      !!src2.sessions().find(s => s.id === 'csMB' && s.current) && src2.stats().stale === true,
      `sessions=${JSON.stringify(src2.sessions().map(s => s.id))} stale=${src2.stats().stale}`);
    failA = false;
    await src2.scan();
    ok('成员删除：恢复后仍只有一份会话', src2.sessions().filter(s => s.id === 'csMB').length === 1 && src2.stats().stale === false,
      JSON.stringify(src2.sessions().map(s => s.id)));
    await rm(dir2, {recursive: true, force: true});
  }

  /* 23. 同一 call_id 的副本时间戳不同也要进同一冲突桶（复核 v2.41 #2） */
  {
    const {utimes} = await import('node:fs/promises');
    const dir = await mk('codexreg-tsconf-');
    const meta = rec('session_meta', {session_id: 'csTC2', cwd: 'D:\\wTC2'}, '2026-01-01T00:00:00Z');
    const call = rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"run"}', call_id: 'tc2'}, '2026-01-01T00:00:01Z');
    await writeFile(join(dir, 'a.jsonl'), meta + call + rec('response_item', {type: 'function_call_output', call_id: 'tc2', output: 'Process exited with code 0'}, '2026-01-01T00:00:02Z'));
    await writeFile(join(dir, 'b.jsonl'), meta + call + rec('response_item', {type: 'function_call_output', call_id: 'tc2', output: 'Process exited with code 7: EACCES'}, '2026-01-01T00:00:03Z'));
    const tOld = new Date(Date.now() - 20000), tNew = new Date(Date.now() - 10000);
    await utimes(join(dir, 'a.jsonl'), tOld, tOld);
    await utimes(join(dir, 'b.jsonl'), tNew, tNew);
    const {src, pushed} = makeSrc({roots: [dir], listIntervalMs: 0});
    await src.scan(true);
    const s = src.sessions().find(x => x.id === 'csTC2');
    ok('时间戳不同的冲突副本：统计用较新副本（failed=1、done=0）', !!s && s.failed === 1 && s.done === 0,
      `done=${s && s.done} failed=${s && s.failed}`);
    ok('时间戳不同的冲突副本：事件同为失败', pushed.some(e => e.ok === false && /exit 7/.test(e.name || '')),
      JSON.stringify(pushed.map(e => [e.name, e.ok])));
    await utimes(join(dir, 'a.jsonl'), tNew, tNew);
    await utimes(join(dir, 'b.jsonl'), tOld, tOld);
    const {src: src2, pushed: pushed2} = makeSrc({roots: [dir], listIntervalMs: 0});
    await src2.scan(true);
    const s2 = src2.sessions().find(x => x.id === 'csTC2');
    ok('时间戳不同的冲突副本（对调新旧）：统计成功且不发失败事件',
      !!s2 && s2.done === 1 && s2.failed === 0 && !pushed2.some(e => e.ok === false),
      `done=${s2 && s2.done} failed=${s2 && s2.failed} events=${JSON.stringify(pushed2.map(e => [e.name, e.ok]))}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 24. Codex 整文件解析失败要计入健康状态（复核 v2.41 #5） */
  {
    const dir = await mk('codexreg-parse-');
    const f = join(dir, 'rollout-p.jsonl');
    const meta = rec('session_meta', {session_id: 'csPH', cwd: 'D:\\wPH'}, '2026-01-01T00:00:00Z');
    const call = rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"run"}', call_id: 'ph1'}, '2026-01-01T00:00:02Z');
    await writeFile(f, meta + call);
    const {src} = makeSrc({roots: [dir], listIntervalMs: 0});
    await src.scan(true);
    ok('解析健康基线：运行中且 stale=false', !!src.sessions().find(s => s.id === 'csPH' && s.current) && src.stats().stale === false,
      `stale=${src.stats().stale}`);
    await writeFile(f, 'x'.repeat(4000));   // 整文件不可解析，且比原文件更长
    await src.scan();
    ok('整文件损坏（变长）：保留旧运行快照但 stale=true',
      !!src.sessions().find(s => s.id === 'csPH' && s.current) && src.stats().stale === true,
      `sessions=${JSON.stringify(src.sessions().map(s => s.id))} stale=${src.stats().stale}`);
    await writeFile(f, meta + call + rec('response_item', {type: 'function_call_output', call_id: 'ph1', output: 'Process exited with code 0'}, '2026-01-01T00:00:03Z'));
    await src.scan();
    ok('恢复有效内容后 stale=false 且完成调用', src.stats().stale === false && (src.sessions().find(s => s.id === 'csPH') || {}).done === 1,
      `stale=${src.stats().stale} done=${(src.sessions().find(s => s.id === 'csPH') || {}).done}`);
    await writeFile(f, '');
    await src.scan();
    ok('确认空文件：会话退出且 stale=false', src.sessions().length === 0 && src.stats().stale === false,
      `sessions=${src.sessions().length} stale=${src.stats().stale}`);
    await writeFile(f, meta + call + '{"type":');
    await src.scan();
    ok('仅末尾半行：仍识别会话、不算整文件解析失败', !!src.sessions().find(s => s.id === 'csPH') && src.stats().stale === false,
      `sessions=${src.sessions().length} stale=${src.stats().stale}`);
    const dir2 = await mk('codexreg-parse2-');
    const fa2 = join(dir2, 'a.jsonl'), fb2 = join(dir2, 'b.jsonl');
    await writeFile(fa2, meta + call);
    await writeFile(fb2, meta + rec('response_item', {type: 'message', role: 'assistant', content: [{type: 'text', text: '可解析副本'}]}, '2026-01-01T00:00:04Z'));
    const {src: src2} = makeSrc({roots: [dir2], listIntervalMs: 0});
    await src2.scan(true);
    ok('多文件基线：两份文件都可解析且健康', !!src2.sessions().find(s => s.id === 'csPH') && src2.stats().stale === false,
      `stale=${src2.stats().stale}`);
    await writeFile(fb2, 'y'.repeat(4000));   // 已有身份缓存后整份文件损坏
    await src2.scan();
    ok('多文件组里一个文件整坏：保留旧快照并 stale=true',
      !!src2.sessions().find(s => s.id === 'csPH' && s.current) && src2.stats().stale === true,
      `sessions=${JSON.stringify(src2.sessions().map(s => s.id))} stale=${src2.stats().stale}`);
    await rm(fb2, {force: true});
    await src2.scan();
    ok('坏文件被删除后恢复健康', src2.stats().stale === false && !!src2.sessions().find(s => s.id === 'csPH'),
      `stale=${src2.stats().stale}`);
    await rm(dir, {recursive: true, force: true});
    await rm(dir2, {recursive: true, force: true});
  }

  /* 25. 工具改名后名称索引要更新（复核 v2.41 #6） */
  {
    const dir = await mk('codexreg-toolname-');
    const f = join(dir, 'rollout-t.jsonl');
    const meta = rec('session_meta', {session_id: 'csTN', cwd: 'D:\\wTN'}, '2026-01-01T00:00:00Z');
    const args = '{"path":"x"}';
    const callAt = '2026-01-01T00:00:02Z';
    await writeFile(f, meta + rec('response_item', {type: 'function_call', name: 'shell', arguments: args, call_id: 'tn1'}, callAt));
    const {src, pushed} = makeSrc({roots: [dir], listIntervalMs: 0});
    await src.scan(true);
    ok('工具名基线：调用记录为 shell', ((src.sessions()[0] || {}).calls || []).some(c => c.name === 'shell'),
      JSON.stringify(src.sessions()[0] && src.sessions()[0].calls.map(c => c.name)));
    const beforeRename = pushed.length;
    await writeFile(f, meta + rec('response_item', {type: 'function_call', name: 'read_file', arguments: args, call_id: 'tn1'}, callAt));
    await src.scan();
    ok('工具改名：快照中的调用名更新为 read_file', ((src.sessions()[0] || {}).calls || []).some(c => c.name === 'read_file'),
      JSON.stringify(src.sessions()[0] && src.sessions()[0].calls.map(c => c.name)));
    ok('工具改名：改名本身也要推一条新标签事件', pushed.length > beforeRename,
      `before=${beforeRename} after=${pushed.length} names=${JSON.stringify(pushed.map(e => e.name))}`);
    await writeFile(f, meta
      + rec('response_item', {type: 'function_call', name: 'read_file', arguments: args, call_id: 'tn1'}, callAt)
      + rec('response_item', {type: 'function_call_output', call_id: 'tn1', output: 'Process exited with code 7: EACCES'}, '2026-01-01T00:00:03Z'));
    await src.scan();
    ok('工具改名后再失败：失败事件使用新工具名',
      pushed.some(e => e.ok === false && /read_file/.test(e.name || ''))
      && src.sessions().find(s => s.id === 'csTN').failed === 1,
      JSON.stringify(pushed.map(e => [e.name, e.ok])));
    await rm(dir, {recursive: true, force: true});
  }

  /* 26. 已有缓存的已知变更不能被活跃窗口挡住（复核 v2.41 #7；用空闲会话，避免 running 走重读） */
  {
    const {utimes} = await import('node:fs/promises');
    const dir = await mk('codexreg-idle-');
    const f = join(dir, 'rollout-i.jsonl');
    const meta = rec('session_meta', {session_id: 'csID', cwd: 'D:\\wID'}, '2026-01-01T00:00:00Z');
    const oldMsg = rec('response_item', {type: 'message', role: 'assistant', content: [{type: 'text', text: '旧消息'}]}, '2026-01-01T00:00:02Z');
    await writeFile(f, meta + oldMsg);
    const {src} = makeSrc({roots: [dir], listIntervalMs: 0, activeMs: 60 * 1000});
    await src.scan(true);
    ok('空闲缓存基线：会话空闲但有旧消息', !!src.sessions().find(s => s.id === 'csID' && !s.current && s.msgs.some(m => m.text === '旧消息')),
      JSON.stringify(src.sessions().map(s => [s.id, s.msgs.map(m => m.text)])));
    // 有效改写且 mtime 被保留到活跃窗口之外：也要读到新内容
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    await writeFile(f, meta + rec('response_item', {type: 'message', role: 'assistant', content: [{type: 'text', text: '深夜改写'}]}, '2026-01-01T00:00:05Z'));
    await utimes(f, old, old);
    await src.scan();
    ok('空闲缓存被有效改写（mtime 超窗）：能读到新内容',
      !!src.sessions().find(s => s.id === 'csID' && s.msgs.some(m => m.text === '深夜改写')),
      JSON.stringify(src.sessions().map(s => [s.id, s.msgs.map(m => m.text)])));
    // 文件被清空且 mtime 仍在活跃窗口之外：仍要重读并确认清空
    await writeFile(f, '');
    await utimes(f, old, old);
    await src.scan();
    ok('空闲缓存被清空（mtime 超窗）：重读后会话退出', src.sessions().length === 0 && src.stats().stale === false,
      `sessions=${src.sessions().length} stale=${src.stats().stale}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 27. JSONL 内部完整坏行：标 stale 但继续消费可解析记录，后续终态仍生效（复核 v2.42 #2） */
  {
    const { utimes } = await import('node:fs/promises');
    const dir = await mk('codexreg-jsonlbad-');
    const f = join(dir, 'rollout-jb.jsonl');
    const meta = rec('session_meta', {session_id: 'csJB', cwd: 'D:\\wJB'}, '2026-01-01T00:00:00Z');
    const call = rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"sleep 5"}', call_id: 'jb1'}, '2026-01-01T00:00:02Z');
    await writeFile(f, meta + call);
    const {src} = makeSrc({roots: [dir], listIntervalMs: 0});
    await src.scan(true);
    ok('内部坏行基线：运行中且 stale=false',
      !!src.sessions().find(s => s.id === 'csJB' && s.current) && src.stats().stale === false,
      `stale=${src.stats().stale}`);
    await writeFile(f, [
      meta,
      call,
      'this is not a json record\n',   // 文件内部完整坏行（第 3 行）
      rec('response_item', {type: 'function_call_output', call_id: 'jb1', output: 'Process exited with code 0'}, '2026-01-01T00:00:03Z'),
      rec('event_msg', {type: 'task_complete'}, '2026-01-01T00:00:04Z'),
    ].join(''));
    await src.scan();
    const sJb = src.sessions().find(x => x.id === 'csJB');
    const stJb = src.stats();
    ok('内部坏行：仍继续使用可解析记录（终态生效、不再挂运行中）',
      !!sJb && sJb.current === null && sJb.done === 1 && sJb.openStep == null,
      `current=${JSON.stringify(sJb && sJb.current)} done=${sJb && sJb.done} openStep=${sJb && sJb.openStep}`);
    ok('内部坏行：源健康标 stale', stJb.stale === true, `stale=${stJb.stale}`);
    ok('内部坏行：每文件诊断带坏行数与行号',
      Array.isArray(stJb.parseFaults) && stJb.parseFaults.length === 1
      && stJb.parseFaults[0].badLines === 1 && Array.isArray(stJb.parseFaults[0].positions)
      && stJb.parseFaults[0].positions[0] === 3 && stJb.parseFaults[0].wholeFile === false,
      JSON.stringify(stJb.parseFaults));
    // 只改 mtime（读取成功但坏行仍在）不能清掉未恢复的解析故障
    const nowJb = new Date();
    await utimes(f, nowJb, nowJb);
    await src.scan();
    ok('内部坏行：成功 readFile 不清未恢复的解析故障',
      src.stats().stale === true && (src.stats().parseFaults || []).length === 1,
      `stale=${src.stats().stale} parse=${JSON.stringify(src.stats().parseFaults)}`);
    await writeFile(f, [
      meta, call,
      rec('response_item', {type: 'function_call_output', call_id: 'jb1', output: 'Process exited with code 0'}, '2026-01-01T00:00:03Z'),
      rec('event_msg', {type: 'task_complete'}, '2026-01-01T00:00:04Z'),
    ].join(''));
    await src.scan();
    ok('内部坏行恢复：stale 归 false 且诊断清空',
      src.stats().stale === false && (src.stats().parseFaults || []).length === 0
      && (src.sessions().find(x => x.id === 'csJB') || {}).done === 1,
      `stale=${src.stats().stale} parse=${JSON.stringify(src.stats().parseFaults)} done=${(src.sessions().find(x => x.id === 'csJB') || {}).done}`);
    // 末尾半行仍可忽略
    await writeFile(f, meta + call + '{"type":"response_item","payload":{"type":"func');
    await src.scan();
    ok('末尾半行：可忽略，不标 stale、诊断不新增',
      src.stats().stale === false && (src.stats().parseFaults || []).length === 0,
      `stale=${src.stats().stale} parse=${JSON.stringify(src.stats().parseFaults)}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 28. 全坏文件首次读取：不建半份会话但计入健康；恢复后识别身份（复核 v2.42 #2） */
  {
    const dir = await mk('codexreg-jsonlwhole-');
    const f = join(dir, 'rollout-jw.jsonl');
    await writeFile(f, 'garbage line without newline');
    const {src} = makeSrc({roots: [dir], listIntervalMs: 0});
    await src.scan(true);
    const stJw = src.stats();
    ok('全坏文件（首次）：不建半份会话但标 stale',
      src.sessions().length === 0 && stJw.stale === true,
      `sessions=${src.sessions().length} stale=${stJw.stale}`);
    ok('全坏文件（首次）：诊断标记整文件损坏与行号',
      Array.isArray(stJw.parseFaults) && stJw.parseFaults.length === 1
      && stJw.parseFaults[0].wholeFile === true && stJw.parseFaults[0].badLines >= 1
      && stJw.parseFaults[0].positions[0] === 1,
      JSON.stringify(stJw.parseFaults));
    await writeFile(f, [
      rec('session_meta', {session_id: 'csJW', cwd: 'D:\\wJW'}, '2026-01-01T00:00:00Z'),
      rec('response_item', {type: 'message', role: 'user', content: [{type: 'text', text: '恢复后的完整文件'}]}, '2026-01-01T00:00:02Z'),
    ].join(''));
    await src.scan();
    ok('全坏文件恢复：识别会话且 stale=false',
      !!src.sessions().find(s => s.id === 'csJW') && src.stats().stale === false,
      `sessions=${JSON.stringify(src.sessions().map(s => s.id))} stale=${src.stats().stale}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 29. 深嵌套合法入参导致序列化抛错：单条记录隔离，后续终态仍生效（复核 v2.42 #2） */
  {
    const dir = await mk('codexreg-deep-');
    const f = join(dir, 'rollout-deep.jsonl');
    const meta = rec('session_meta', {session_id: 'csDeep', cwd: 'D:\\wDeep'}, '2026-01-01T00:00:00Z');
    const call = rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"sleep 9"}', call_id: 'dp1'}, '2026-01-01T00:00:02Z');
    await writeFile(f, meta + call);
    const {src} = makeSrc({roots: [dir], listIntervalMs: 0});
    await src.scan(true);
    ok('深嵌套基线：运行中且 stale=false',
      !!src.sessions().find(s => s.id === 'csDeep' && s.current) && src.stats().stale === false,
      `stale=${src.stats().stale}`);
    let deep = '{"cmd":"ls"}';
    for (let i = 0; i < 6000; i++) deep = '{"a":' + deep + '}';
    const deepCall = '{"timestamp":"2026-01-01T00:00:03Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":'
      + deep + ',"call_id":"dp2"}}\n';
    await writeFile(f, meta + call + deepCall
      + rec('event_msg', {type: 'task_complete'}, '2026-01-01T00:00:04Z')
      + rec('response_item', {type: 'message', role: 'assistant', content: [{type: 'text', text: '深嵌套之后的合法消息'}]}, '2026-01-01T00:00:05Z'));
    await src.scan();
    const sDeep = src.sessions().find(x => x.id === 'csDeep');
    const stDeep = src.stats();
    ok('深嵌套入参：单条记录隔离后终态仍生效（不保留旧 running）',
      !!sDeep && sDeep.current === null && sDeep.openStep == null,
      `current=${JSON.stringify(sDeep && sDeep.current)} openStep=${sDeep && sDeep.openStep}`);
    ok('深嵌套入参：后续合法消息仍被处理',
      !!sDeep && sDeep.msgs.some(m => /深嵌套之后的合法消息/.test(m.text)),
      JSON.stringify(sDeep && sDeep.msgs.map(m => m.text)));
    ok('深嵌套入参：标脏（stale + 记录级诊断）',
      stDeep.stale === true && (stDeep.recordFaults || 0) >= 1,
      `stale=${stDeep.stale} faults=${stDeep.recordFaults}`);
    await writeFile(f, meta + call
      + rec('response_item', {type: 'function_call_output', call_id: 'dp1', output: 'Process exited with code 0'}, '2026-01-01T00:00:03Z')
      + rec('event_msg', {type: 'task_complete'}, '2026-01-01T00:00:04Z'));
    await src.scan();
    const sDeep2 = src.sessions().find(x => x.id === 'csDeep');
    ok('深嵌套恢复：stale 清空、完成计数正确',
      src.stats().stale === false && (src.stats().recordFaults || 0) === 0 && !!sDeep2 && sDeep2.done === 1,
      `stale=${src.stats().stale} faults=${src.stats().recordFaults} done=${sDeep2 && sDeep2.done}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 30. JSONL 已知类型字段结构校验：非法字段记录诊断但继续折叠（复核 v2.42 #2） */
  {
    const dir = await mk('codexreg-field-');
    const f = join(dir, 'rollout-fv.jsonl');
    const meta = rec('session_meta', {session_id: 'csFV', cwd: 'D:\\wFV'}, '2026-01-01T00:00:00Z');
    await writeFile(f, meta
      + '{"timestamp":"2026-01-01T00:00:02Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":42,"call_id":"fv1"}}\n'
      + rec('response_item', {type: 'function_call_output', call_id: 'fv1', output: 'Process exited with code 0'}, '2026-01-01T00:00:03Z'));
    const {src, pushed} = makeSrc({roots: [dir], listIntervalMs: 0});
    await src.scan(true);
    const sFv = src.sessions().find(x => x.id === 'csFV');
    ok('字段校验：工具入参类型非法时记录诊断并继续折叠',
      !!sFv && sFv.calls.length === 1 && sFv.done === 1
      && src.stats().stale === true && (src.stats().recordFaults || 0) >= 1,
      `calls=${sFv && sFv.calls.length} done=${sFv && sFv.done} stale=${src.stats().stale} faults=${src.stats().recordFaults}`);
    ok('字段校验：非法字段不阻断事件（工具调用事件仍发出）',
      pushed.some(e => /shell/.test(e.name || '')), JSON.stringify(pushed.map(e => e.name)));
    await writeFile(f, meta
      + rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'fv1'}, '2026-01-01T00:00:02Z')
      + rec('response_item', {type: 'function_call_output', call_id: 'fv1', output: 'Process exited with code 0'}, '2026-01-01T00:00:03Z'));
    await src.scan();
    ok('字段校验：修复后诊断清空、stale=false',
      src.stats().stale === false && (src.stats().recordFaults || 0) === 0,
      `stale=${src.stats().stale} faults=${src.stats().recordFaults}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 31. SQLite 单坏 item：保留上次成功快照、标 stale、恢复后重试清标记（复核 v2.42 #2） */
  {
    const dir = await mk('codexreg-sqlbad-');
    const st = mkState(dir); putThread(st, 'thBad', 'D:\\wBad'); st.close();
    const h = mkHist(dir);
    putItem(h, 'thBad', 'c1', 'commandExecution', {type: 'commandExecution', id: 'c1', command: 'ok1', status: 'completed', exitCode: 0, aggregatedOutput: 'fine'}, 1);
    putItem(h, 'thBad', 'c2', 'commandExecution', {type: 'commandExecution', id: 'c2', command: 'ok2', status: 'completed', exitCode: 0, aggregatedOutput: 'fine'}, 2);
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const {src, pushed} = makeSrc({sqlite: true, sqlitePaths: paths});
    await src.scan(true);
    const baseBad = src.sessions().find(s => s.id === 'thBad');
    ok('SQLite 单坏 item 基线：done=2、calls=2、stale=false',
      !!baseBad && baseBad.done === 2 && baseBad.calls.length === 2 && src.stats().stale === false,
      `done=${baseBad && baseBad.done} calls=${baseBad && baseBad.calls.length} stale=${src.stats().stale}`);
    const pushedBadBase = pushed.length;
    const h2 = mkHist(dir);
    h2.prepare('update thread_items set item_json=? where thread_id=? and item_id=?').run('{broken json', 'thBad', 'c1');
    h2.close();
    await src.scan();
    const badS = src.sessions().find(s => s.id === 'thBad');
    ok('SQLite 单坏 item：保留上次成功快照（done/calls 不塌陷）',
      !!badS && badS.done === 2 && badS.calls.length === 2,
      `done=${badS && badS.done} calls=${badS && badS.calls.length}`);
    ok('SQLite 单坏 item：计入健康（stale=true + 诊断）',
      src.stats().stale === true && (src.stats().sqliteFaults || 0) >= 1,
      `stale=${src.stats().stale} faults=${src.stats().sqliteFaults}`);
    ok('SQLite 单坏 item：坏版本不重复推历史事件', pushed.length === pushedBadBase,
      `before=${pushedBadBase} after=${pushed.length}`);
    const h3 = mkHist(dir);
    h3.prepare('update thread_items set item_json=? where thread_id=? and item_id=?')
      .run(JSON.stringify({type: 'commandExecution', id: 'c1', command: 'ok1', status: 'completed', exitCode: 0, aggregatedOutput: 'fine'}), 'thBad', 'c1');
    h3.close();
    await src.scan();
    const recBad = src.sessions().find(s => s.id === 'thBad');
    ok('SQLite 单坏 item 恢复：重试成功、stale 清空、快照完整',
      src.stats().stale === false && (src.stats().sqliteFaults || 0) === 0 && !!recBad && recBad.done === 2,
      `stale=${src.stats().stale} faults=${src.stats().sqliteFaults} done=${recBad && recBad.done}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 32. SQLite 坏 item（无旧快照）：不拖累同线程其它 item，恢复后补事件（复核 v2.42 #2） */
  {
    const dir = await mk('codexreg-sqlbadnew-');
    const st = mkState(dir); putThread(st, 'thBN', 'D:\\wBN'); st.close();
    const h = mkHist(dir);
    putItem(h, 'thBN', 'u1', 'userMessage', {type: 'userMessage', content: [{type: 'text', text: '同一线程的有效消息'}]}, 1);
    h.prepare('insert into thread_items values (?,?,?,?,?,?,?)').run('thBN', '', 'bad1', 'agentMessage', '{not json', Date.now(), 2);
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const {src, pushed} = makeSrc({sqlite: true, sqlitePaths: paths});
    await src.scan(true);
    const sBn = src.sessions().find(x => x.id === 'thBN');
    ok('SQLite 坏 item（无旧快照）：同线程其它 item 仍折叠展示',
      !!sBn && sBn.msgs.some(m => /同一线程的有效消息/.test(m.text)) && src.stats().stale === true,
      `msgs=${JSON.stringify(sBn && sBn.msgs)} stale=${src.stats().stale}`);
    ok('SQLite 坏 item（无旧快照）：有效 item 的事件仍推送',
      pushed.some(e => /同一线程的有效消息/.test(e.name || '')), JSON.stringify(pushed.map(e => e.name)));
    const h2 = mkHist(dir);
    h2.prepare('update thread_items set item_json=? where thread_id=? and item_id=?')
      .run(JSON.stringify({type: 'agentMessage', text: '恢复后的助手消息'}), 'thBN', 'bad1');
    h2.close();
    await src.scan();
    const sBn2 = src.sessions().find(x => x.id === 'thBN');
    ok('SQLite 坏 item 恢复：清 stale 且补齐新 item 事件',
      src.stats().stale === false && (src.stats().sqliteFaults || 0) === 0
      && !!sBn2 && sBn2.msgs.some(m => /恢复后的助手消息/.test(m.text))
      && pushed.some(e => /恢复后的助手消息/.test(e.name || '')),
      `stale=${src.stats().stale} faults=${src.stats().sqliteFaults} msgs=${JSON.stringify(sBn2 && sBn2.msgs.map(m => m.text))}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 32b. SQLite 字段结构非法：记录诊断、继续展示，修复后清标记（复核 v2.42 #2） */
  {
    const dir = await mk('codexreg-sqlfield-');
    const st = mkState(dir); putThread(st, 'thFd', 'D:\\wFd'); st.close();
    const h = mkHist(dir);
    putItem(h, 'thFd', 'm1', 'mcpToolCall', {type: 'mcpToolCall', id: 'm1', server: 'srv', tool: 'do', status: 'completed', arguments: 'not-an-object'}, 1);
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const {src} = makeSrc({sqlite: true, sqlitePaths: paths});
    await src.scan(true);
    const sFd = src.sessions().find(x => x.id === 'thFd');
    ok('SQLite 字段校验：入参对象类型非法时记录诊断并继续展示',
      !!sFd && sFd.calls.some(c => c.label === 'srv·do')
      && src.stats().stale === true && (src.stats().sqliteFaults || 0) >= 1,
      `calls=${JSON.stringify(sFd && sFd.calls.map(c => [c.name, c.label]))} stale=${src.stats().stale} faults=${src.stats().sqliteFaults}`);
    const h2 = mkHist(dir);
    h2.prepare('update thread_items set item_json=? where thread_id=? and item_id=?')
      .run(JSON.stringify({type: 'mcpToolCall', id: 'm1', server: 'srv', tool: 'do', status: 'completed', arguments: {}}), 'thFd', 'm1');
    h2.close();
    await src.scan();
    ok('SQLite 字段校验恢复：stale=false 且诊断清空',
      src.stats().stale === false && (src.stats().sqliteFaults || 0) === 0,
      `stale=${src.stats().stale} faults=${src.stats().sqliteFaults}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 33. SQLite foldThread 异常：不登记成功、保留旧快照、超出活跃窗口仍会重试（复核 v2.42 #2） */
  {
    const dir = await mk('codexreg-sqlfold-');
    const st = mkState(dir); putThread(st, 'thFold', 'D:\\wFold'); st.close();
    const h = mkHist(dir);
    putTurn(h, 'thFold', 't1', 'inProgress', 1);
    putItem(h, 'thFold', 'f1', 'commandExecution', {type: 'commandExecution', id: 'fc1', command: 'sleep 5', status: 'inProgress'}, 1, 't1');
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const fault = {fold: new Set()};
    const {src} = makeSrc({sqlite: true, sqlitePaths: paths, sqliteFault: fault});
    await src.scan(true);
    ok('SQLite fold 异常基线：运行中且 stale=false',
      !!src.sessions().find(s => s.id === 'thFold' && s.current) && src.stats().stale === false,
      `stale=${src.stats().stale}`);
    fault.fold.add('thFold');
    const h2 = mkHist(dir);
    h2.prepare('insert into thread_items values (?,?,?,?,?,?,?)')
      .run('thFold', 't1', 'f2', 'agentMessage', JSON.stringify({type: 'agentMessage', text: 'fold 恢复后可见'}), Date.now(), 2);
    h2.close();
    await src.scan();
    const keptFold = src.sessions().find(s => s.id === 'thFold');
    ok('SQLite fold 异常：保留旧快照并标 stale',
      !!keptFold && !!keptFold.current && !keptFold.msgs.some(m => /fold 恢复后可见/.test(m.text)) && src.stats().stale === true,
      `current=${!!(keptFold && keptFold.current)} msgs=${JSON.stringify(keptFold && keptFold.msgs.map(m => m.text))} stale=${src.stats().stale}`);
    // 线程超出活跃窗口后仍要重试，不能永久跳过
    const st2 = mkState(dir);
    st2.prepare('update threads set updated_at=? where id=?').run(Math.floor(Date.now() / 1000) - 3 * 3600, 'thFold');
    st2.close();
    fault.fold.clear();
    await src.scan();
    const backFold = src.sessions().find(s => s.id === 'thFold');
    ok('SQLite fold 异常恢复：超出活跃窗口也能重试成功、stale 清空',
      src.stats().stale === false && !!backFold && backFold.msgs.some(m => /fold 恢复后可见/.test(m.text)),
      `stale=${src.stats().stale} msgs=${JSON.stringify(backFold && backFold.msgs.map(m => m.text))}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 34. SQLite 展示签名覆盖完整投影：逐类型只改一个展示字段也要更新事件（复核 v2.42 #9） */
  {
    const dir = await mk('codexreg-sigproj-');
    const st = mkState(dir);
    for (const id of ['thSig', 'thSig2', 'thSig3']) putThread(st, id, 'D:\\' + id);
    st.close();
    const h = mkHist(dir);
    putItem(h, 'thSig', 'm1', 'mcpToolCall', {type: 'mcpToolCall', id: 'm1', server: 'srv', tool: 'old', status: 'completed'}, 1);
    putItem(h, 'thSig2', 's1', 'subAgentActivity', {type: 'subAgentActivity', id: 's1', kind: 'started', agentPath: '/root/a'}, 1);
    putItem(h, 'thSig3', 'c1', 'collabAgentToolCall', {type: 'collabAgentToolCall', id: 'c1', tool: 'spawn', status: 'completed'}, 1);
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const {src, pushed} = makeSrc({sqlite: true, sqlitePaths: paths});
    await src.scan(true);
    ok('签名投影基线：三类事件都带展示名',
      pushed.some(e => /srv·old/.test(e.name || '')) && pushed.some(e => /\/root\/a/.test(e.name || ''))
      && pushed.some(e => /spawn/.test(e.name || '')),
      JSON.stringify(pushed.map(e => e.name)));
    const h2 = mkHist(dir);
    h2.prepare('update thread_items set item_json=? where item_id=?')
      .run(JSON.stringify({type: 'mcpToolCall', id: 'm1', server: 'srv', tool: 'new', status: 'completed'}), 'm1');
    h2.prepare('update thread_items set item_json=? where item_id=?')
      .run(JSON.stringify({type: 'subAgentActivity', id: 's1', kind: 'started', agentPath: '/root/b'}), 's1');
    h2.prepare('update thread_items set item_json=? where item_id=?')
      .run(JSON.stringify({type: 'collabAgentToolCall', id: 'c1', tool: 'resume', status: 'completed'}), 'c1');
    h2.close();
    await src.scan();
    const sigS = src.sessions().find(s => s.id === 'thSig');
    ok('签名投影：mcpToolCall 只改 tool → 推事件且快照一致',
      pushed.some(e => /srv·new/.test(e.name || ''))
      && !!sigS && sigS.calls.some(c => c.callId === 'm1' && c.label === 'srv·new'),
      `events=${JSON.stringify(pushed.map(e => e.name))} calls=${JSON.stringify(sigS && sigS.calls.map(c => [c.callId, c.label]))}`);
    ok('签名投影：subAgentActivity 只改 agentPath → 推事件', pushed.some(e => /\/root\/b/.test(e.name || '')),
      JSON.stringify(pushed.map(e => e.name)));
    ok('签名投影：collabAgentToolCall 只改工具名 → 推事件', pushed.some(e => /agent · resume/.test(e.name || '')),
      JSON.stringify(pushed.map(e => e.name)));
    const h3 = mkHist(dir);
    h3.prepare('update thread_items set item_json=? where item_id=?')
      .run(JSON.stringify({type: 'mcpToolCall', id: 'm1', server: 'srv2', tool: 'new', status: 'completed'}), 'm1');
    h3.close();
    await src.scan();
    ok('签名投影：mcpToolCall 只改 server → 推事件', pushed.some(e => /srv2·new/.test(e.name || '')),
      JSON.stringify(pushed.map(e => e.name)));
    await rm(dir, {recursive: true, force: true});
  }

  /* 35. 工具名索引按会话隔离：跨会话同 call_id 不能互相污染（复核 v2.42 #8） */
  {
    const dir = await mk('codexreg-callscope-');
    const metaA = rec('session_meta', {session_id: 'csCA', cwd: 'D:\\wCA'}, '2026-01-01T00:00:00Z');
    const metaB = rec('session_meta', {session_id: 'csCB', cwd: 'D:\\wCB'}, '2026-01-01T00:00:00Z');
    const callA = rec('response_item', {type: 'function_call', name: 'Read', arguments: '{"path":"a"}', call_id: 'same-id'}, '2026-01-01T00:00:02Z');
    const callB = rec('response_item', {type: 'function_call', name: 'Write', arguments: '{"path":"b"}', call_id: 'same-id'}, '2026-01-01T00:00:02Z');
    const fa = join(dir, 'a.jsonl'), fb = join(dir, 'b.jsonl');
    await writeFile(fa, metaA + callA);
    await writeFile(fb, metaB + callB);
    const {src, pushed} = makeSrc({roots: [dir], listIntervalMs: 0});
    await src.scan(true);
    ok('跨会话同 call_id 基线：两个会话各自有调用',
      src.sessions().length === 2 && src.sessions().every(s => s.calls.length === 1),
      JSON.stringify(src.sessions().map(s => [s.id, s.calls.map(c => c.name)])));
    const failOut = rec('response_item', {type: 'function_call_output', call_id: 'same-id', output: 'Process exited with code 7: EACCES'}, '2026-01-01T00:00:03Z');
    await writeFile(fa, metaA + callA + failOut);
    await src.scan();
    const badScope = pushed.filter(e => e.ok === false);
    ok('工具名索引按会话隔离：A 的失败事件使用 Read 而不是 B 的 Write',
      badScope.length >= 1 && badScope.some(e => /Read/.test(e.name || '')) && !badScope.some(e => /Write/.test(e.name || '')),
      JSON.stringify(pushed.map(e => [e.name, e.ok])));
    ok('工具名索引：快照中的调用名不受另一会话影响',
      (src.sessions().find(s => s.id === 'csCA') || {calls: []}).calls.every(c => c.name === 'Read')
      && (src.sessions().find(s => s.id === 'csCB') || {calls: []}).calls.every(c => c.name === 'Write'),
      JSON.stringify(src.sessions().map(s => [s.id, s.calls.map(c => c.name)])));
    /* 决定性场景：先让 B 重新解码（旧全局表最后一次写入是 Write），
       再把 A 改成“只有输出、没有调用记录”的轮转日志 —— 裸全局表会把 B 的 Write 借给 A。 */
    await writeFile(fb, metaB + callB
      + rec('response_item', {type: 'message', role: 'assistant', content: [{type: 'text', text: 'B 的追加消息'}]}, '2026-01-01T00:00:04Z'));
    await src.scan();
    const failCountBeforeRotate = pushed.filter(e => e.ok === false).length;
    const failOut2 = rec('response_item', {type: 'function_call_output', call_id: 'same-id', output: 'Process exited with code 8: ENOENT'}, '2026-01-01T00:00:05Z');
    await writeFile(fa, metaA + failOut2);   // A 的调用行已被轮转掉
    await src.scan();
    const rotatedFail = pushed.slice(failCountBeforeRotate).filter(e => e.ok === false);
    ok('工具名索引按会话隔离：A 的输出-only 日志不借用 B 的工具名',
      rotatedFail.length >= 1 && !rotatedFail.some(e => /Write/.test(e.name || '')),
      JSON.stringify(pushed.map(e => [e.name, e.ok])));
    await rm(dir, {recursive: true, force: true});
  }

  /* 36. 长会话超过旧索引阈值：等待结果的调用名不能被整表清空（复核 v2.42 #8） */
  {
    const dir = await mk('codexreg-callcap-');
    const meta = rec('session_meta', {session_id: 'csCap', cwd: 'D:\\wCap'}, '2026-01-01T00:00:00Z');
    const capLines = [meta];
    for (let i = 0; i < 810; i++) {
      capLines.push(rec('response_item', {type: 'function_call', name: i === 0 ? 'earlyTool' : 'bulkTool', arguments: '{"cmd":"ls"}', call_id: 'cap-' + i},
        new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()));
    }
    // 结果必须排在全部调用之后，才在首轮“末尾 80 条”事件窗口内命中
    capLines.push(rec('response_item', {type: 'function_call_output', call_id: 'cap-0', output: 'Process exited with code 7: EACCES'},
      new Date(Date.UTC(2026, 0, 1, 0, 20, 0)).toISOString()));
    await writeFile(join(dir, 'rollout-cap.jsonl'), capLines.join(''));
    const {src, pushed} = makeSrc({roots: [dir], listIntervalMs: 0});
    await src.scan(true);
    ok('长会话超过旧索引阈值：等待结果的调用名仍能解析（不整表清空）',
      pushed.some(e => e.ok === false && /earlyTool/.test(e.name || '')),
      JSON.stringify(pushed.filter(e => e.ok === false).map(e => e.name)));
    await rm(dir, {recursive: true, force: true});
  }

  /* 37. 自动发现的可选 SQLite 从未存在 ≠ 故障；曾成功后才失效才算 stale（复核 v2.42 #10） */
  {
    const { stat: realStatS } = await import('node:fs/promises');
    const home = await mk('codexreg-sqlhome-');
    const codexDir = join(home, '.codex');
    const jsonlDir = await mk('codexreg-sqljsonl-');
    await writeFile(join(jsonlDir, 'rollout-x.jsonl'),
      rec('session_meta', {session_id: 'csJ', cwd: 'D:\\wJ'}, '2026-01-01T00:00:00Z')
      + rec('response_item', {type: 'message', role: 'user', content: [{type: 'text', text: '纯 JSONL 会话'}]}, '2026-01-01T00:00:01Z'));
    const savedHome = process.env.HOME, savedProfile = process.env.USERPROFILE;
    const savedStateDb = process.env.CODEX_STATE_DB, savedHistDb = process.env.CODEX_HISTORY_DB;
    process.env.HOME = home; process.env.USERPROFILE = home;
    delete process.env.CODEX_STATE_DB; delete process.env.CODEX_HISTORY_DB;
    let failStatS = '';
    const ioS = {stat: async (p) => {
      if (failStatS && String(p) === failStatS) throw Object.assign(new Error('EACCES: permission denied'), {code: 'EACCES'});
      return realStatS(p);
    }};
    try {
      const src = codex.create({roots: [jsonlDir], activeMs: 45 * 60000, listIntervalMs: 0, io: ioS,
        live: {push() {}}, sqlite: true});
      await src.scan(true);
      ok('SQLite 可选库从未存在（纯 JSONL）：健康、stale=false、状态 absent',
        src.stats().stale === false && src.stats().sqlite === 'absent' && !!src.sessions().find(s => s.id === 'csJ'),
        `stale=${src.stats().stale} sqlite=${src.stats().sqlite} sessions=${JSON.stringify(src.sessions().map(s => s.id))}`);
      await mkdir(codexDir, {recursive: true});
      const stateDbPath = join(codexDir, 'state_5.sqlite');
      const stS = new DatabaseSync(stateDbPath);
      stS.exec('create table threads (id text, cwd text, title text, name text, first_user_message text, updated_at integer, archived integer default 0)');
      stS.prepare('insert into threads values (?,?,?,?,?,?,0)').run('thS1', 'D:\\wS1', 'SQLite 会话', null, null, Math.floor(Date.now() / 1000));
      stS.close();
      await src.scan();
      ok('SQLite 只有一个库存在：仍健康、不误报 stale',
        src.stats().stale === false && src.stats().sqlite === 'absent' && !!src.sessions().find(s => s.id === 'csJ'),
        `stale=${src.stats().stale} sqlite=${src.stats().sqlite} sessions=${JSON.stringify(src.sessions().map(s => s.id))}`);
      const histDbPath = join(codexDir, 'thread_history_1.sqlite');
      const hS = new DatabaseSync(histDbPath);
      hS.exec('create table thread_turns (thread_id text, turn_id text, status text, rollout_ordinal integer, started_at integer)');
      hS.exec('create table thread_items (thread_id text, turn_id text, item_id text, item_type text, item_json text, created_at_ms integer, rollout_ordinal integer)');
      hS.prepare('insert into thread_turns values (?,?,?,?,?)').run('thS1', 't1', 'inProgress', 1, Math.floor(Date.now() / 1000));
      hS.prepare('insert into thread_items values (?,?,?,?,?,?,?)')
        .run('thS1', 't1', 'i1', 'agentMessage', JSON.stringify({type: 'agentMessage', text: 'SQLite 实时消息'}), Date.now(), 1);
      hS.close();
      await src.scan();
      ok('SQLite 两个库就绪：状态 ok、能读到线程',
        src.stats().stale === false && src.stats().sqlite === 'ok'
        && !!src.sessions().find(s => s.id === 'thS1' && s.msgs.some(m => /SQLite 实时消息/.test(m.text))),
        `stale=${src.stats().stale} sqlite=${src.stats().sqlite} sessions=${JSON.stringify(src.sessions().map(s => s.id))}`);
      failStatS = histDbPath;
      await src.scan();
      ok('SQLite 曾成功读取后失效：stale=true、状态 stale、缓存保留',
        src.stats().stale === true && src.stats().sqlite === 'stale'
        && !!src.sessions().find(s => s.id === 'thS1') && !!src.sessions().find(s => s.id === 'csJ'),
        `stale=${src.stats().stale} sqlite=${src.stats().sqlite} sessions=${JSON.stringify(src.sessions().map(s => s.id))}`);
      failStatS = '';
      await src.scan();
      ok('SQLite 权限恢复：stale 清空、状态 ok、两个会话都在',
        src.stats().stale === false && src.stats().sqlite === 'ok' && src.sessions().length === 2,
        `stale=${src.stats().stale} sqlite=${src.stats().sqlite} sessions=${JSON.stringify(src.sessions().map(s => s.id))}`);
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
      if (savedStateDb === undefined) delete process.env.CODEX_STATE_DB; else process.env.CODEX_STATE_DB = savedStateDb;
      if (savedHistDb === undefined) delete process.env.CODEX_HISTORY_DB; else process.env.CODEX_HISTORY_DB = savedHistDb;
    }
    await rm(home, {recursive: true, force: true});
    await rm(jsonlDir, {recursive: true, force: true});
  }

  /* 38. 显式配置的 SQLite 路径错误仍是故障；Node 不支持 SQLite 不算故障（复核 v2.42 #10） */
  {
    const dir = await mk('codexreg-sqlcfg-');
    const paths = {state: join(dir, 'missing-state.db'), history: join(dir, 'missing-hist.db')};
    const {src} = makeSrc({sqlite: true, sqlitePaths: paths});
    await src.scan();
    ok('SQLite 显式配置路径不存在：算故障（stale=true、状态 error）',
      src.stats().stale === true && src.stats().sqlite === 'error',
      `stale=${src.stats().stale} sqlite=${src.stats().sqlite}`);
    // 必须在“显式配置的路径”上创建库（mkState/mkHist 建的是默认文件名）
    const stCfg = openDb(paths.state, [
      'create table if not exists threads (id text, cwd text, title text, name text, first_user_message text, updated_at integer, archived integer default 0)',
    ]);
    putThread(stCfg, 'thCfg', 'D:\\wCfg'); stCfg.close();
    const hCfg = openDb(paths.history, [
      'create table if not exists thread_turns (thread_id text, turn_id text, status text, rollout_ordinal integer, started_at integer)',
      'create table if not exists thread_items (thread_id text, turn_id text, item_id text, item_type text, item_json text, created_at_ms integer, rollout_ordinal integer)',
    ]);
    putItem(hCfg, 'thCfg', 'u1', 'userMessage', {type: 'userMessage', content: [{type: 'text', text: '显式库恢复'}]}, 1);
    hCfg.close();
    await src.scan();
    ok('SQLite 显式配置路径恢复后可读',
      src.stats().stale === false && src.stats().sqlite === 'ok' && !!src.sessions().find(s => s.id === 'thCfg'),
      `stale=${src.stats().stale} sqlite=${src.stats().sqlite} sessions=${JSON.stringify(src.sessions().map(s => s.id))}`);
    await rm(dir, {recursive: true, force: true});

    const dirU = await mk('codexreg-sqlunsup-');
    const jsonlU = join(dirU, 'sessions');
    await mkdir(jsonlU, {recursive: true});
    await writeFile(join(jsonlU, 'rollout-u.jsonl'),
      rec('session_meta', {session_id: 'csU', cwd: 'D:\\wU'}, '2026-01-01T00:00:00Z')
      + rec('response_item', {type: 'message', role: 'user', content: [{type: 'text', text: '无 SQLite 环境'}]}, '2026-01-01T00:00:01Z'));
    const {src: srcU} = makeSrc({roots: [jsonlU], sqlite: true, listIntervalMs: 0,
      sqlitePaths: {state: join(dirU, 's.db'), history: join(dirU, 'h.db')},
      io: {sqlite: async () => null}});
    await srcU.scan(true);
    ok('Node 不支持 SQLite：不算故障（stale=false、状态 unsupported）且 JSONL 正常',
      srcU.stats().stale === false && srcU.stats().sqlite === 'unsupported' && !!srcU.sessions().find(s => s.id === 'csU'),
      `stale=${srcU.stats().stale} sqlite=${srcU.stats().sqlite} sessions=${JSON.stringify(srcU.sessions().map(s => s.id))}`);
    await rm(dirU, {recursive: true, force: true});
  }

  /* 39. 记录身份/归一化异常边界：非法 ID/name/type/payload 不抛穿，后续终态继续（复核 v2.43 #3）
     复现核心：call_id 为 {"toString":null} 的合法 JSON 夹在未结束调用与 task_complete 之间。
     修复前 eventIdentity 在权威副本选择前抛错，被 scan 外层 catch 吞掉：旧调用仍 running、stale=false。 */
  {
    const dir = await mk('codexreg-identbad-');
    const otherDir = await mk('codexreg-identbad-other-');
    const f = join(dir, 'rollout-ib.jsonl');
    const fOther = join(otherDir, 'rollout-other.jsonl');
    const meta = rec('session_meta', {session_id: 'csIB', cwd: 'D:\\wIB'}, '2026-01-01T00:00:00Z');
    const call = rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"sleep 5"}', call_id: 'ib1'}, '2026-01-01T00:00:02Z');
    const done = rec('response_item', {type: 'function_call_output', call_id: 'ib1', output: 'Process exited with code 0'}, '2026-01-01T00:00:09Z');
    const tc = rec('event_msg', {type: 'task_complete'}, '2026-01-01T00:00:10Z');
    await writeFile(f, meta + call);
    await writeFile(fOther, rec('session_meta', {session_id: 'csOther', cwd: 'D:\\wOther'}, '2026-01-01T00:00:00Z')
      + rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"sleep 6"}', call_id: 'ob1'}, '2026-01-01T00:00:02Z'));
    const {src} = makeSrc({roots: [dir, otherDir], listIntervalMs: 0});
    await src.scan(true);
    ok('#3 基线：两个会话都在运行',
      !!src.sessions().find(s => s.id === 'csIB' && s.current) && !!src.sessions().find(s => s.id === 'csOther' && s.current),
      JSON.stringify(src.sessions().map(s => [s.id, !!s.current])));

    // 各种形状都来自合法 JSON：ID 的 null/数组/对象（含不可调用的 toString/valueOf）、name 对象、
    // type/payload 异型、payload 为 null、超深 JSON —— 逐条可控降级，不能抛穿到身份计算之前。
    let deep = '{"cmd":"x"}';
    for (let i = 0; i < 6000; i++) deep = '{"a":' + deep + '}';
    const badRecords = [
      JSON.stringify({timestamp: '2026-01-01T00:00:03Z', type: 'response_item',
        payload: {type: 'function_call', name: 'shell', arguments: '{"cmd":"bad"}', call_id: {toString: null}}}) + '\n',
      JSON.stringify({timestamp: '2026-01-01T00:00:03.1Z', type: 'response_item',
        payload: {type: 'function_call', name: 'shell', arguments: '{"cmd":"bad2"}', call_id: [1, 2]}}) + '\n',
      JSON.stringify({timestamp: '2026-01-01T00:00:03.2Z', type: 'response_item',
        payload: {type: 'function_call', name: 'shell', arguments: '{"cmd":"bad3"}', call_id: {toString: 'x', valueOf: null}}}) + '\n',
      JSON.stringify({timestamp: '2026-01-01T00:00:03.3Z', type: 'response_item',
        payload: {type: 'function_call', name: {toString: null}, arguments: '{"cmd":"named"}', call_id: 'ibName'}}) + '\n',
      JSON.stringify({timestamp: '2026-01-01T00:00:03.4Z', type: 'response_item', payload: []}) + '\n',
      JSON.stringify({timestamp: '2026-01-01T00:00:03.5Z', type: 'response_item', payload: 'nope'}) + '\n',
      JSON.stringify({timestamp: '2026-01-01T00:00:03.6Z', type: 'response_item', payload: {type: 42, call_id: 'ibType'}}) + '\n',
      JSON.stringify({timestamp: '2026-01-01T00:00:03.7Z', type: 42,
        payload: {type: 'function_call', name: 'shell', arguments: '{"cmd":"evttype"}', call_id: 'ibEvtType'}}) + '\n',
      JSON.stringify({timestamp: '2026-01-01T00:00:03.8Z', type: 'response_item',
        payload: {type: 'function_call', name: 'shell', arguments: '{"cmd":"nullid"}', call_id: null}}) + '\n',
      JSON.stringify({timestamp: '2026-01-01T00:00:03.9Z', type: 'response_item', payload: null}) + '\n',
      '{"timestamp":"2026-01-01T00:00:03.95Z","type":"response_item","payload":{"type":"function_call",'
        + '"name":"shell","arguments":' + deep + ',"call_id":"ibDeep"}}\n',
    ];
    await writeFile(f, [meta, call, ...badRecords, tc].join(''));
    await src.scan();
    const sIB = src.sessions().find(s => s.id === 'csIB');
    const stIB = src.stats();
    const ibCalls = (sIB && sIB.calls) || [];
    ok('#3 非法记录：后续 task_complete 仍生效（不保留旧 running）',
      !!sIB && sIB.current === null && sIB.openStep == null,
      `current=${JSON.stringify(sIB && sIB.current)} openStep=${sIB && sIB.openStep}`);
    ok('#3 非法记录：原调用被终态收尾且不计成功',
      ibCalls.some(c => c.callId === 'ib1' && c.done && c.aborted) && sIB.done === 0,
      JSON.stringify(ibCalls.map(c => [c.callId, c.done, !!c.aborted])) + ` done=${sIB && sIB.done}`);
    ok('#3 非法 name：降级为安全工具名（不伪造/不串名）',
      ibCalls.some(c => c.callId === 'ibName' && c.name === 'tool') && !ibCalls.some(c => c.name === '[object Object]'),
      JSON.stringify(ibCalls.map(c => [c.callId, c.name])));
    ok('#3 非法 ID：不生成伪造调用身份、不影响合法记录',
      ibCalls.every(c => typeof c.callId === 'string') && !ibCalls.some(c => /bad/.test(c.label || ''))
      && !ibCalls.some(c => c.callId === 'ibType' || c.callId === 'ibEvtType'),
      JSON.stringify(ibCalls.map(c => [c.callId, c.label])));
    ok('#3 非法记录：诊断可见且源标降级（不被兜底 catch 洗成健康）',
      stIB.stale === true && (stIB.recordFaults || 0) >= 5,
      `stale=${stIB.stale} recordFaults=${stIB.recordFaults} reasons=${JSON.stringify(stIB)}`);
    ok('#3 非法记录：其他会话不受影响',
      !!src.sessions().find(s => s.id === 'csOther' && s.current),
      JSON.stringify(src.sessions().map(s => [s.id, !!s.current])));
    // 恢复：移除坏记录后诊断清空、终态正确
    await writeFile(f, meta + call + done + tc);
    await src.scan();
    const recIB = src.sessions().find(s => s.id === 'csIB');
    ok('#3 非法记录恢复：stale/记录诊断清空且完成计数正确',
      src.stats().stale === false && (src.stats().recordFaults || 0) === 0 && !!recIB && recIB.done === 1,
      `stale=${src.stats().stale} faults=${src.stats().recordFaults} done=${recIB && recIB.done}`);
    await rm(dir, {recursive: true, force: true});
    await rm(otherDir, {recursive: true, force: true});
  }

  /* 40. 已知坏行必须绕过签名缓存真正重读；等字节清理后即使 size/mtime 不变也能恢复（复核 v2.43 #4） */
  {
    const {readFile: realReadFileR, stat: realStatR} = await import('node:fs/promises');
    const dir = await mk('codexreg-badretry-');
    const f = join(dir, 'rollout-br.jsonl');
    const meta = rec('session_meta', {session_id: 'csBR', cwd: 'D:\\wBR'}, '2026-01-01T00:00:00Z');
    const call = rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"sleep 4"}', call_id: 'br1'}, '2026-01-01T00:00:02Z');
    const tail = rec('response_item', {type: 'function_call_output', call_id: 'br1', output: 'Process exited with code 0'}, '2026-01-01T00:00:03Z')
      + rec('event_msg', {type: 'task_complete'}, '2026-01-01T00:00:04Z');
    const badLine = 'this is not json but same bytes\n';
    const fixedLine = ' '.repeat(badLine.length - 1) + '\n';   // 等字节空白行（修掉坏行但 stat 签名不变）
    let reads = 0;
    const io = {readFile: async (p) => { if (String(p) === f) reads++; return realReadFileR(p); }};
    const fixedTime = new Date(Date.now() - 5000);
    await writeFile(f, meta + call + badLine + tail);
    await utimes(f, fixedTime, fixedTime);
    const {src, pushed} = makeSrc({roots: [dir], io, listIntervalMs: 0});
    await src.scan(true);
    const reads1 = reads;
    ok('坏行重试基线：首次 stale=true 且诊断带坏行',
      src.stats().stale === true && (src.stats().parseFaults || []).length === 1,
      `stale=${src.stats().stale} parse=${JSON.stringify(src.stats().parseFaults)} reads=${reads1}`);
    // 保持 stat 签名连续扫描：已知故障不能被 g._sig 短路，必须真的重读文件
    await src.scan();
    ok('坏行未修：签名没变仍要真正重读', reads > reads1, `reads ${reads1} → ${reads}`);
    ok('坏行未修：持续 stale', src.stats().stale === true, `stale=${src.stats().stale}`);
    const stBefore = await realStatR(f);
    const pushedBefore = pushed.length;
    await writeFile(f, meta + call + fixedLine + tail);
    await utimes(f, fixedTime, fixedTime);
    const stAfter = await realStatR(f);
    ok('坏行清理样本：size/mtime 签名与修复前完全相同',
      stBefore.size === stAfter.size && stBefore.mtimeMs === stAfter.mtimeMs,
      `before=${stBefore.size}/${stBefore.mtimeMs} after=${stAfter.size}/${stAfter.mtimeMs}`);
    const reads2 = reads;
    await src.scan();
    ok('坏行清理（同签名）：恢复并清诊断', src.stats().stale === false && (src.stats().parseFaults || []).length === 0,
      `stale=${src.stats().stale} parse=${JSON.stringify(src.stats().parseFaults)}`);
    ok('坏行清理（同签名）：确实重新读取文件', reads > reads2, `reads ${reads2} → ${reads}`);
    ok('坏行清理（同签名）：不重推旧事件', pushed.length === pushedBefore,
      `pushed ${pushedBefore} → ${pushed.length} ${JSON.stringify(pushed.map(e => e.name))}`);
    const sBR = src.sessions().find(s => s.id === 'csBR');
    ok('坏行清理（同签名）：终态正确', !!sBR && sBR.current === null && sBR.done === 1,
      `current=${JSON.stringify(sBR && sBR.current)} done=${sBR && sBR.done}`);
    // 恢复健康后回到正常缓存：不改文件就不再重读
    const reads3 = reads;
    await src.scan();
    ok('坏行恢复健康后：健康缓存仍可正常跳过重读', reads === reads3, `reads ${reads3} → ${reads}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 41. SQLite items 查询故障：窗口内恢复补事件，健康后按活跃策略正常退出（复核 v2.43 #5） */
  {
    const dir = await mk('codexreg-sqlitems-');
    const st = mkState(dir); putThread(st, 'thIt', 'D:\\wIt'); st.close();
    const h = mkHist(dir);
    putTurn(h, 'thIt', 't1', 'inProgress', 1);
    putItem(h, 'thIt', 'i1', 'commandExecution', {type: 'commandExecution', id: 'i1', command: 'npm test', status: 'inProgress'}, 1, 't1');
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const fault = {items: new Set()};
    const {src, pushed} = makeSrc({sqlite: true, sqlitePaths: paths, sqliteFault: fault});
    await src.scan(true);
    ok('SQLite items 故障基线：线程运行中',
      !!src.sessions().find(s => s.id === 'thIt' && s.current), JSON.stringify(src.sessions().map(s => [s.id, !!s.current])));
    fault.items.add('thIt');
    const h2 = mkHist(dir);
    h2.prepare('update thread_items set item_json=? where thread_id=? and item_id=?')
      .run(JSON.stringify({type: 'commandExecution', id: 'i1', command: 'npm test', status: 'completed', exitCode: 0, aggregatedOutput: 'ok'}), 'thIt', 'i1');
    h2.close();
    const pushedBefore = pushed.length;
    await src.scan();
    ok('SQLite items 故障：保留运行中缓存并标 stale',
      !!src.sessions().find(s => s.id === 'thIt' && s.current) && src.stats().stale === true,
      `sessions=${JSON.stringify(src.sessions().map(s => s.id))} stale=${src.stats().stale}`);
    fault.items.clear();
    await src.scan();
    const recIt = src.sessions().find(s => s.id === 'thIt');
    const newEv = pushed.slice(pushedBefore);
    ok('SQLite items 窗口内恢复：读到完成快照并补事件',
      !!recIt && recIt.current === null && recIt.done === 1 && newEv.some(e => /npm test/.test(e.name || ''))
      && src.stats().stale === false,
      `current=${JSON.stringify(recIt && recIt.current)} done=${recIt && recIt.done} stale=${src.stats().stale} events=${JSON.stringify(newEv.map(e => [e.name, e.ok]))}`);
    // 健康线程越过活跃窗口：普通过期，不能残留 stale/重试
    const realNow = Date.now;
    const OFFSET = 46 * 60 * 1000;
    Date.now = () => realNow() + OFFSET;
    try { await src.scan(); } finally { Date.now = realNow; }
    ok('SQLite 健康线程越过活跃窗口后正常退出（不残留 stale/重试）',
      src.sessions().length === 0 && src.stats().stale === false,
      `sessions=${JSON.stringify(src.sessions().map(s => s.id))} stale=${src.stats().stale}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 42. SQLite turns 查询故障跨活跃窗口：重试集合与常规候选取并集，恢复后补一次终态（复核 v2.43 #5） */
  {
    const dir = await mk('codexreg-sqlturns-');
    const st = mkState(dir); putThread(st, 'thTf', 'D:\\wTf'); st.close();
    const h = mkHist(dir);
    putTurn(h, 'thTf', 't1', 'inProgress', 1);
    putItem(h, 'thTf', 'c1', 'commandExecution', {type: 'commandExecution', id: 'c1', command: 'run tests', status: 'inProgress'}, 1, 't1');
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const fault = {turns: new Set()};
    const {src, pushed} = makeSrc({sqlite: true, sqlitePaths: paths, sqliteFault: fault});
    await src.scan(true);
    ok('SQLite turns 故障基线：线程运行中', !!src.sessions().find(s => s.id === 'thTf' && s.current),
      JSON.stringify(src.sessions().map(s => [s.id, !!s.current])));
    fault.turns.add('thTf');
    const h2 = mkHist(dir);
    h2.prepare('update thread_turns set status=? where thread_id=?').run('completed', 'thTf');
    h2.prepare('update thread_items set item_json=? where thread_id=? and item_id=?')
      .run(JSON.stringify({type: 'commandExecution', id: 'c1', command: 'run tests', status: 'completed', exitCode: 0, aggregatedOutput: 'ok'}), 'thTf', 'c1');
    h2.close();
    const pushedBefore = pushed.length;
    await src.scan();
    ok('SQLite turns 故障：缓存保留、标 stale、线程进入待重试',
      !!src.sessions().find(s => s.id === 'thTf' && s.current) && src.stats().stale === true,
      `sessions=${JSON.stringify(src.sessions().map(s => s.id))} stale=${src.stats().stale}`);
    fault.turns.clear();
    const realNow = Date.now;
    const OFFSET = 46 * 60 * 1000;
    // 时间推进到 activeMs（45 分钟）之外，并且不改 updated_at：只靠待重试集合取并集
    Date.now = () => realNow() + OFFSET;
    try {
      await src.scan();
      const recTf = src.sessions().find(s => s.id === 'thTf');
      const newEv = pushed.slice(pushedBefore);
      ok('SQLite turns 跨窗口恢复：读到完成终态、补事件、清诊断',
        !!recTf && recTf.current === null && recTf.done === 1 && src.stats().stale === false
        && newEv.some(e => /run tests/.test(e.name || '')),
        `current=${JSON.stringify(recTf && recTf.current)} done=${recTf && recTf.done} stale=${src.stats().stale} events=${JSON.stringify(newEv.map(e => [e.name, e.ok]))}`);
      await src.scan();
      ok('SQLite turns 恢复后的普通轮次：按活跃策略退出、不永久保留',
        src.sessions().length === 0 && src.stats().stale === false,
        `sessions=${JSON.stringify(src.sessions().map(s => s.id))} stale=${src.stats().stale}`);
    } finally { Date.now = realNow; }
    await rm(dir, {recursive: true, force: true});
  }

  /* 42b. SQLite items 查询故障跨活跃窗口 + 恢复为失败：同样补一次失败事件（复核 v2.43 #5） */
  {
    const dir = await mk('codexreg-sqlitems-fail-');
    const st = mkState(dir); putThread(st, 'thIf', 'D:\\wIf'); st.close();
    const h = mkHist(dir);
    putTurn(h, 'thIf', 't1', 'inProgress', 1);
    putItem(h, 'thIf', 'f1', 'commandExecution', {type: 'commandExecution', id: 'f1', command: 'bad cmd', status: 'inProgress'}, 1, 't1');
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const fault = {items: new Set()};
    const {src, pushed} = makeSrc({sqlite: true, sqlitePaths: paths, sqliteFault: fault});
    await src.scan(true);
    ok('SQLite items 失败恢复基线：线程运行中', !!src.sessions().find(s => s.id === 'thIf' && s.current),
      JSON.stringify(src.sessions().map(s => [s.id, !!s.current])));
    fault.items.add('thIf');
    const h2 = mkHist(dir);
    h2.prepare('update thread_items set item_json=? where thread_id=? and item_id=?')
      .run(JSON.stringify({type: 'commandExecution', id: 'f1', command: 'bad cmd', status: 'failed', exitCode: 7, aggregatedOutput: 'EACCES: permission denied'}), 'thIf', 'f1');
    h2.close();
    await src.scan();
    ok('SQLite items 跨窗口故障：缓存保留且标 stale',
      !!src.sessions().find(s => s.id === 'thIf' && s.current) && src.stats().stale === true,
      `sessions=${JSON.stringify(src.sessions().map(s => s.id))} stale=${src.stats().stale}`);
    fault.items.clear();
    const pushedBefore = pushed.length;
    const realNow = Date.now;
    const OFFSET = 46 * 60 * 1000;
    Date.now = () => realNow() + OFFSET;
    try {
      await src.scan();
      const recIf = src.sessions().find(s => s.id === 'thIf');
      const newEv = pushed.slice(pushedBefore);
      ok('SQLite items 跨窗口恢复为失败：读回失败终态、补 ok:false 事件、清诊断',
        !!recIf && recIf.current === null && recIf.failed === 1 && src.stats().stale === false
        && newEv.some(e => e.ok === false && /exit 7/.test(e.name || '') && /bad cmd/.test(e.name || '')),
        `current=${JSON.stringify(recIf && recIf.current)} failed=${recIf && recIf.failed} stale=${src.stats().stale} events=${JSON.stringify(newEv.map(e => [e.name, e.ok]))}`);
    } finally { Date.now = realNow; }
    await rm(dir, {recursive: true, force: true});
  }

  /* 42c. 待重试线程滑出 top80 常规候选后仍要读回终态（复核 v2.43 #5） */
  {
    const dir = await mk('codexreg-sqltop80-');
    const st = mkState(dir); putThread(st, 'thOld80', 'D:\\wOld80'); st.close();
    const h = mkHist(dir);
    putTurn(h, 'thOld80', 't1', 'inProgress', 1);
    putItem(h, 'thOld80', 'o1', 'commandExecution', {type: 'commandExecution', id: 'o1', command: 'run old80', status: 'inProgress'}, 1, 't1');
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const fault = {turns: new Set()};
    const {src, pushed} = makeSrc({sqlite: true, sqlitePaths: paths, sqliteFault: fault});
    await src.scan(true);
    ok('SQLite top80 基线：旧线程运行中', !!src.sessions().find(s => s.id === 'thOld80' && s.current),
      JSON.stringify(src.sessions().map(s => [s.id, !!s.current])));
    fault.turns.add('thOld80');
    const h2 = mkHist(dir);
    h2.prepare('update thread_turns set status=? where thread_id=?').run('completed', 'thOld80');
    h2.prepare('update thread_items set item_json=? where thread_id=? and item_id=?')
      .run(JSON.stringify({type: 'commandExecution', id: 'o1', command: 'run old80', status: 'completed', exitCode: 0, aggregatedOutput: 'ok'}), 'thOld80', 'o1');
    h2.close();
    await src.scan();   // 故障扫描：thOld80 进入待重试
    ok('SQLite top80 故障：旧线程缓存保留并标 stale',
      !!src.sessions().find(s => s.id === 'thOld80' && s.current) && src.stats().stale === true,
      `sessions=${JSON.stringify(src.sessions().map(s => s.id))} stale=${src.stats().stale}`);
    // 不改 thOld80 的 updated_at，只新增 80 个更新的线程，把它挤出常规 top80 查询
    const st2 = mkState(dir);
    for (let i = 0; i < 80; i++) putThread(st2, 'thNew' + i, 'D:\\wNew' + i, {updated_at: nowS + 10 + i});
    st2.close();
    fault.turns.clear();
    const pushedBefore = pushed.length;
    await src.scan();
    const recOld = src.sessions().find(s => s.id === 'thOld80');
    const newEv = pushed.slice(pushedBefore);
    ok('SQLite 待重试线程滑出 top80：仍读回终态、补事件、清诊断',
      !!recOld && recOld.current === null && recOld.done === 1 && src.stats().stale === false
      && newEv.some(e => /run old80/.test(e.name || '')),
      `current=${JSON.stringify(recOld && recOld.current)} done=${recOld && recOld.done} stale=${src.stats().stale} events=${JSON.stringify(newEv.map(e => [e.name, e.ok]))}`);
    await rm(dir, {recursive: true, force: true});
  }

  /* 43. SQLite 故障期间归档/真实删除：仍按确认生命周期退出，不能被待重试集合复活（复核 v2.43 #5） */
  {
    const dir = await mk('codexreg-sqlgone-');
    const st = mkState(dir); putThread(st, 'thArch', 'D:\\wArch'); putThread(st, 'thDel', 'D:\\wDel'); st.close();
    const h = mkHist(dir);
    putItem(h, 'thArch', 'a1', 'commandExecution', {type: 'commandExecution', id: 'a1', command: 'a', status: 'inProgress'}, 1);
    putItem(h, 'thDel', 'd1', 'commandExecution', {type: 'commandExecution', id: 'd1', command: 'd', status: 'inProgress'}, 1);
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const fault = {turns: new Set()};
    const {src, pushed} = makeSrc({sqlite: true, sqlitePaths: paths, sqliteFault: fault});
    await src.scan(true);
    ok('SQLite 归档/删除基线：两个线程都在运行',
      src.sessions().length === 2 && src.sessions().every(s => s.current),
      JSON.stringify(src.sessions().map(s => [s.id, !!s.current])));
    fault.turns.add('thArch'); fault.turns.add('thDel');
    await src.scan();   // 故障扫描：两个线程进入待重试
    const pushedBefore = pushed.length;
    const st2 = mkState(dir);
    st2.prepare('update threads set archived=1 where id=?').run('thArch');
    st2.prepare('delete from threads where id=?').run('thDel');
    st2.close();
    fault.turns.clear();
    const realNow = Date.now;
    const OFFSET = 46 * 60 * 1000;
    Date.now = () => realNow() + OFFSET;
    try {
      await src.scan();
      ok('SQLite 故障期间归档/删除：确认生命周期退出、不复活',
        src.sessions().length === 0 && src.stats().stale === false && pushed.length === pushedBefore,
        `sessions=${JSON.stringify(src.sessions().map(s => s.id))} stale=${src.stats().stale} pushed=${pushedBefore}→${pushed.length}`);
    } finally { Date.now = realNow; }
    await rm(dir, {recursive: true, force: true});
  }

  /* 44. SQLite 记录字段非法（id/command/status 为对象）：签名/索引不能抛穿整库扫描（复核 v2.43 #3） */
  {
    const dir = await mk('codexreg-sqlinv-');
    const st = mkState(dir); putThread(st, 'thInv', 'D:\\wInv'); st.close();
    const h = mkHist(dir);
    putTurn(h, 'thInv', 't1', 'inProgress', 1);
    h.prepare('insert into thread_items values (?,?,?,?,?,?,?)').run('thInv', 't1', 'i1', 'commandExecution',
      JSON.stringify({type: 'commandExecution', id: {toString: null}, command: {toString: null}, status: {toString: null}}), Date.now(), 1);
    putItem(h, 'thInv', 'i2', 'userMessage', {type: 'userMessage', content: [{type: 'text', text: '坏字段旁的有效消息'}]}, 2, 't1');
    putItem(h, 'thInv', 'i3', 'commandExecution', {type: 'commandExecution', id: 'i3', command: 'ok3', status: 'completed', exitCode: 0, aggregatedOutput: 'ok'}, 3, 't1');
    h.close();
    const paths = {state: join(dir, 'state.db'), history: join(dir, 'history.db')};
    const {src, pushed} = makeSrc({sqlite: true, sqlitePaths: paths});
    await src.scan(true);
    const sInv = src.sessions().find(s => s.id === 'thInv');
    ok('SQLite 非法字段：单条隔离，同线程其它 item 仍折叠', !!sInv && sInv.msgs.some(m => /坏字段旁的有效消息/.test(m.text)) && sInv.done === 1,
      `msgs=${JSON.stringify(sInv && sInv.msgs)} done=${sInv && sInv.done}`);
    ok('SQLite 非法字段：计入健康且有效 item 事件仍推送',
      src.stats().stale === true && (src.stats().sqliteFaults || 0) >= 1 && pushed.some(e => /坏字段旁的有效消息/.test(e.name || '')),
      `stale=${src.stats().stale} faults=${src.stats().sqliteFaults} events=${JSON.stringify(pushed.map(e => e.name))}`);
    const h2 = mkHist(dir);
    h2.prepare('update thread_items set item_json=? where thread_id=? and item_id=?')
      .run(JSON.stringify({type: 'commandExecution', id: 'i1', command: 'ok1', status: 'completed', exitCode: 0, aggregatedOutput: 'ok'}), 'thInv', 'i1');
    h2.close();
    await src.scan();
    const recInv = src.sessions().find(s => s.id === 'thInv');
    ok('SQLite 非法字段恢复：清诊断、完成计数补齐、补事件',
      src.stats().stale === false && (src.stats().sqliteFaults || 0) === 0 && !!recInv && recInv.done === 2
      && pushed.some(e => /ok1/.test(e.name || '')),
      `stale=${src.stats().stale} faults=${src.stats().sqliteFaults} done=${recInv && recInv.done} events=${JSON.stringify(pushed.map(e => e.name))}`);
    await rm(dir, {recursive: true, force: true});
  }

  {
    /* v2.43 #10：Codex JSONL calls 超 400 时保护未完成/当前调用。 */
    const dir = await mk('codexreg-trim243-');
    const f = join(dir, 'rollout-trim.jsonl');
    const meta = rec('session_meta', {session_id: 'csTrim243', cwd: 'D:\\wTrim243'}, '2026-01-01T00:00:00Z');
    const parts = [meta, rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"sleep"}', call_id: 'c0'}, '2026-01-01T00:00:01Z')];
    for (let i = 1; i <= 405; i++) {
      const ts = new Date(Date.parse('2026-01-01T00:00:02Z') + i * 1000).toISOString();
      parts.push(rec('response_item', {type: 'function_call', name: 'read_file', arguments: '{}', call_id: 'c' + i}, ts));
      parts.push(rec('response_item', {type: 'function_call_output', call_id: 'c' + i, output: 'ok'}, ts));
    }
    await writeFile(f, parts.join(''));
    const {src} = makeSrc({roots: [dir], listIntervalMs: 0});
    await src.scan(true);
    const s = src.sessions().find(x => x.id === 'csTrim243');
    ok('v2.43 #10 Codex：历史裁剪保护未完成当前调用',
      !!s && !!s.current && s.current.callId === 'c0' && s.calls.some(c => c.callId === 'c0') && s.calls.length <= 400,
      JSON.stringify(s && {cur: s.current && s.current.callId, n: s.calls.length}));
    await rm(dir, {recursive: true, force: true});
  }

  let bad = 0;
  const quiet = process.env.QUIET === '1';   // 变异验证时只输出失败行
  console.log('MODE=codexreg  （复核 v2.33 数据层回归：缓存/去重/状态/清空/排序）\n');
  for (const [name, pass, detail] of checks) {
    if (quiet && pass) continue;
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
    // 第三轮：调用还没返回，会话就被中断了 —— 不能让它永远算「正在运行」
    rec('event_msg', {type: 'task_started'}, '2026-01-01T00:00:05.5Z'),
    rec('response_item', {type: 'function_call', name: 'shell', arguments: '{"cmd":"sleep 999"}', call_id: 'c3'}, '2026-01-01T00:00:06Z'),
    rec('event_msg', {type: 'turn_aborted'}, '2026-01-01T00:00:07Z'),
    // 第四轮：一次成功、一次失败的写文件 —— 只有成功的那个算"写进代码了"
    rec('response_item', {type: 'function_call', name: 'apply_patch',
      arguments: '{"input":"*** Begin Patch\\n*** Update File: FAILED_WRITE.txt\\n+boom\\n*** End Patch"}', call_id: 'c4'}, '2026-01-01T00:00:08Z'),
    rec('response_item', {type: 'function_call_output', call_id: 'c4', output: 'Process exited with code 1: permission denied'}, '2026-01-01T00:00:09Z'),
    rec('response_item', {type: 'function_call', name: 'apply_patch',
      arguments: '{"input":"*** Begin Patch\\n*** Update File: OK_WRITE.txt\\n+ok\\n*** End Patch"}', call_id: 'c5'}, '2026-01-01T00:00:10Z'),
    rec('response_item', {type: 'function_call_output', call_id: 'c5', output: 'Process exited with code 0'}, '2026-01-01T00:00:11Z'),
  ].join(''));

  const pushed = [];   // 收集送进任务流的事件，验证失败原因真的传出去了
  const src = codex.create({roots: [dir], activeMs: 999999999, sqlite: false, live: {push(it) { pushed.push(it); }}});
  await src.scan(true);
  const s = src.sessions().find(x => x.id === 'csA');
  const failEvt = pushed.find(p => p.ok === false);

  const checks = [
    ['坏行不影响整份会话解析', !!s && s.calls.length === 5, `calls = ${s && s.calls.length}`],
    ['会话元信息仍能读到', !!s && s.cwd === 'D:\\wA', `cwd = ${s && s.cwd}`],
    ['"Process exited with code 1" 判为失败', !!s && s.failed === 2, `failed = ${s && s.failed}, done = ${s && s.done}`],
    ['退出码 0 不算失败', !!s && s.done === 2, `done = ${s && s.done}`],
    // 复核意见 1：失败原因必须真的接通，不能只有工具名
    ['折叠结果里保留了失败原因（退出码 + EACCES）', !!s && s.calls.some(c => c.error && /exit 7/.test(c.reason || '') && /EACCES/.test(c.reason || '')),
      `lastFail=${JSON.stringify(s && s.lastFail)}`],
    ['失败事件里带工具名和原因', !!failEvt && /shell/.test(failEvt.name) && /EACCES/.test(failEvt.name) && /exit 7/.test(failEvt.name),
      `事件=${JSON.stringify(failEvt)}`],
    // 复核：turn_aborted 只清了推理状态，未完成调用会一直挂着
    ['回合被中断后不再有"正在运行"的调用', !!s && s.current === null,
      `current=${JSON.stringify(s && s.current)}`],
    ['被中断的调用标记为已取消', !!s && s.calls.some(c => c.callId === 'c3' && c.aborted && c.done),
      JSON.stringify(s && s.calls.map(c => ({id: c.callId, done: c.done, aborted: !!c.aborted})))],
    // 复核：失败的写文件调用被当成"实际写入代码"
    ['失败的写文件调用不会进代码块', !!s && !s.snippets.some(x => /FAILED_WRITE/.test(x.code || '')),
      `代码块=${JSON.stringify(s && s.snippets.map(x => x.file))}`],
    ['成功的写文件调用才会进代码块', !!s && s.snippets.some(x => /OK_WRITE/.test(x.code || '')),
      `代码块=${JSON.stringify(s && s.snippets.map(x => x.file))}`],
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

  // E3：动态端口 + 启动后核对实例身份；失败/超时在 finally 里清理自己的子进程
  const TP = await freePortNear(process.env.TEST_PORT_BASE, 1);
  const child = spawn(process.execPath, ['dsh-bridge.mjs'], {
    cwd: ROOT,
    env: bridgeEnv({
      PORT: String(TP),
      CODEX_SESSIONS: dir,
      CODEX_STATE_DB: join(dir, 'no-such-state.db'),       CODEX_HISTORY_DB: join(dir, 'no-such-hist.db'),
      DSH_SESSIONS: join(dir, 'no-such-dsh'),
      CLAUDE_PROJECTS: join(dir, 'no-such-claude'),
    }),
    stdio: 'ignore',
  });
  const res = {ready: false};
  try {
    const ready = await waitBridge(TP);
    res.ready = ready.ok;
    if (ready.ok) {
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
      res.epoch = a1.epoch || '';
      res.epoch2 = a2.epoch || '';
      res.servedFrom = a1.servedFrom || '';
    }
  } finally {
    await stopChild(child);
    await rm(dir, {recursive: true, force: true});
  }

  const checks = [
    ['E3 测试实例按动态端口启动并核对身份（servedFrom/epoch）',
      res.ready && res.servedFrom === SERVED_NAME && !!res.epoch && res.epoch === res.epoch2,
      `ready=${res.ready} servedFrom=${res.servedFrom} epoch=${res.epoch}/${res.epoch2}`],
    ['Codex 会话有编号', res.codes1 && res.codes1.length === 2, `codes = ${JSON.stringify(res.codes1)}`],
    ['查别的源不会清空本源的智能体编号', Array.isArray(res.eventAgents) && res.eventAgents.length > 0 && res.eventAgents.every(Boolean),
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
  'codeMeta', 'stepN', 'cfl', 'cflst', 'pc', 'pcBox', 'mode', 'srcSel', 'servedTag', 'wfStatus',
  'replayTag', 'pauseTag'];
for (const id of ids) byId.set('#' + id, mkEl(id));
byId.get('#pauseTag').hidden = true;   // HTML 里带 hidden，垫片不解析属性，手工对齐
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
let gapCalls = 0;   // MODE=gaplive：区分"连接前正常"与"连接期间窗口被挤掉"
let evdownCalls = 0;   // MODE=evdown：按次数模拟 200 + 多种事件协议错误
/* MODE=lanes / status：phase 由测试显式推进，不靠轮询次数猜阶段 */
let lanesPhase = 'base';     // base → overflow → removed → reappear
let statusPhase = 'good';    // good → bad → badEvents → empty → good
let statusBadServed = 0;     // 实际发出去的坏 state 条数（证明真的走了错误 schema 分支）
let statusEpochBad = false;  // 坏 state 里塞了 epoch/dataKind，校验失败时绝不能采纳
let evdownStateBad = false;  // MODE=evdown：state 转坏、events 仍正常，验证两条故障通道分开
/* MODE=demo 顺带验证 prefers-reduced-motion=true：减少动效只该关动画，不能冻结数据轮询 */
const REDUCE_MODE = MODE === 'demo';
const DEMO_START = Date.now();   // MODE=demo：模拟「服务晚启动」的时间基准
let demoDown = false;            // MODE=demo：连上之后再模拟一次断线，验证水印/数据性质不被洗成实时
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
  // 代码面板也走真实渲染路径：字符串里的关键词、注释、尖括号都要按结构包标签
  snippets: [{file: 'evil.js', start: 1, lang: 'js', agent: '01', lines: [
    'const s = "hello return";',
    '// const in comment',
    'const t = "<img src=x>";',
  ]}],
  links: [], overflow: 0, source: 'test', servedFrom: 'test',
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

/* MODE=lanes 用的手工状态：6 个工作区，验证「第 5 个起并进第 4 条合并泳道，并标 +」。
   工作区带稳定 key（后端契约 state.workflows[].key 与 events[].workspace 同值）。 */
const LANES_PAYLOAD = {
  tasks: [{id: 'T-1', name: 'x', wf: 0, state: 'run', prog: 0.5, agent: '01', cur: true}],
  agents: [0, 1, 2, 3, 4, 5].map(i => ({code: String(i + 1).padStart(2, '0'), name: 'a' + i, title: 'a' + i, depth: 0, wf: i})),
  workflows: [0, 1, 2, 3, 4, 5].map(i => ({i, id: 'W0' + (i + 1), key: 'keyW0' + (i + 1), name: 'w' + i, q: 0.9})),
  links: [], overflow: 0, snippets: [], source: 'test', servedFrom: 'test',
};
const LANES_EVENTS = [
  ... [0, 1, 2, 3, 4, 5].map(i => (
    {seq: i + 1, verb: 'read', task_name: 'e' + i, kind: 'tool', agent: String(i + 1).padStart(2, '0'), name: 'a' + i}
  )),
  // 未上墙/编号为空的会话靠 workspace 归位；未知 workspace 必须是「未归属」，不能默认 W01
  {seq: 7, verb: 'read', task_name: '溢出工作区', kind: 'tool', agent: '', name: '', workspace: 'keyW02'},
  {seq: 8, verb: 'read', task_name: '编号不在墙上', kind: 'tool', agent: '99', name: '', workspace: 'keyW05'},
  {seq: 9, verb: 'read', task_name: '未知工作区', kind: 'tool', agent: '99', name: '', workspace: 'no-such-key'},
  {seq: 10, verb: 'read', task_name: '既无编号也无工作区', kind: 'tool', agent: '', name: ''},
];

/* MODE=lanes 第二阶段：12 个上墙智能体 + 100 个工作区（overflow 88），
   验证默认上限外的会话事件仍按稳定工作区 key 落进正确泳道（含合并泳道）。 */
function overflowLanesState(){
  return {
    tasks: [{id: 'T-1', name: 'x', wf: 0, state: 'run', prog: 0.5, agent: '01', cur: true}],
    agents: Array.from({length: 12}, (_, i) => ({code: String(i + 1).padStart(2, '0'), name: 'a' + i, title: 'a' + i, depth: 0, wf: i})),
    workflows: Array.from({length: 100}, (_, i) => ({i, id: 'W' + String(i + 1).padStart(2, '0'), key: 'ow' + i, name: 'owf' + i, q: 0.9})),
    links: [], overflow: 88, snippets: [], source: 'all', servedFrom: 'test', dataKind: 'live',
  };
}
const OVERFLOW_LANES_EVENTS = [
  {seq: 101, verb: 'read', task_name: '墙外50', kind: 'tool', agent: '', name: '', workspace: 'ow50'},
  {seq: 102, verb: 'read', task_name: '未知工作区', kind: 'tool', agent: '', name: '', workspace: 'nope'},
  {seq: 103, verb: 'read', task_name: '墙内12', kind: 'tool', agent: '12', name: 'a11', workspace: 'ow99'},
];

/* MODE=lanes 第三阶段：旧工作区 keyW02 已从 state 消失，编号 02 被回收给 W01。
   旧事件仍带着 agent=02 / workspace=keyW02，回放时不能因为编号回收就落进 W01。 */
const LANES_REMOVED = {
  tasks: [{id: 'T-1', name: 'x', wf: 0, state: 'run', prog: 0.5, agent: '01', cur: true}],
  agents: [
    {code: '01', name: 'a0', title: 'a0', depth: 0, wf: 0},
    {code: '02', name: 'a1', title: 'a1', depth: 0, wf: 0},   // 编号 02 被回收 → 现在在 W01
    {code: '03', name: 'a2', title: 'a2', depth: 0, wf: 1},
    {code: '04', name: 'a3', title: 'a3', depth: 0, wf: 2},
    {code: '05', name: 'a4', title: 'a4', depth: 0, wf: 3},
    {code: '06', name: 'a5', title: 'a5', depth: 0, wf: 4},
  ],
  workflows: ['keyW01', 'keyW03', 'keyW04', 'keyW05', 'keyW06'].map((key, i) => (
    {i, id: 'W0' + (i + 1), key, name: 'w' + i, q: 0.9}
  )),
  links: [], overflow: 0, snippets: [], source: 'test', servedFrom: 'test',
};

/* 第四阶段：工作区重新出现（keyW02 回到 state），但编号 02 仍是回收后的工作区 W01。
   有稳定 key 且已知 → 按 key 归属；只有真正缺字段的旧协议才允许编号兜底。 */
const LANES_REAPPEAR = {
  tasks: [{id: 'T-1', name: 'x', wf: 0, state: 'run', prog: 0.5, agent: '01', cur: true}],
  agents: [
    {code: '01', name: 'a0', title: 'a0', depth: 0, wf: 0},
    {code: '02', name: 'a1', title: 'a1', depth: 0, wf: 0},   // 编号仍是回收后的 W01
    {code: '03', name: 'a2', title: 'a2', depth: 0, wf: 1},
    {code: '04', name: 'a3', title: 'a3', depth: 0, wf: 2},
    {code: '05', name: 'a4', title: 'a4', depth: 0, wf: 3},
    {code: '06', name: 'a5', title: 'a5', depth: 0, wf: 4},
  ],
  workflows: [0, 1, 2, 3, 4, 5].map(i => ({i, id: 'W0' + (i + 1), key: 'keyW0' + (i + 1), name: 'w' + i, q: 0.9})),
  links: [], overflow: 0, snippets: [], source: 'test', servedFrom: 'test',
};

/* MODE=hubs 用的手工状态：先给 2 个工作区（验证不重复），再变成 6 个（验证上限 5 + 轮换） */
function HUBS_PAYLOAD(n) {
  const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
  const ids = ['W01', 'W02', 'W03', 'W04', 'W05', 'W06'];
  return {
    tasks: Array.from({length: n}, (_, i) => (
      {id: 'T-' + (i + 1), name: '任务' + (i + 1), wf: i, state: i === 1 ? 'done' : 'run', prog: i === 1 ? 1 : 0.5, agent: String(i + 1).padStart(2, '0'), cur: i !== 1}
    )),
    // 每个工作区 1 个智能体；W06 额外多 2 个 → 轮换到 W06 时节点应显示 3 个
    agents: [
      ...Array.from({length: n}, (_, i) => (
        {code: String(i + 1).padStart(2, '0'), name: '智能体' + (i + 1), title: '智能体' + (i + 1), depth: 0, wf: i}
      )),
      ...(n >= 6 ? [
        {code: '91', name: '附加甲', title: '附加甲', depth: 0, wf: 5},
        {code: '92', name: '附加乙', title: '附加乙', depth: 0, wf: 5},
      ] : []),
    ],
    workflows: Array.from({length: n}, (_, i) => (
      {i, id: ids[i], key: 'hkey' + (i + 1), name: names[i], q: 0.9, busy: 1, fails: 0, idleMs: 1000 + i * 100, stalled: false, lastFail: null}
    )),
    links: [
      // 右侧父子连线：01 有运行任务、02 已空闲 —— 两条静态线都要保留，但只有流向 01 的有流入效果
      {from: '01', to: '02'},
      {from: '02', to: '01'},
    ], overflow: 0, snippets: [], source: 'test', servedFrom: 'test', epoch: 'e1',
    dataKind: 'live',   // 真实 bridge 的数据性质：连接健康与数据性质要分开显示
  };
}
let hubsCalls = 0;   // 前 2 次给 2 个工作区，之后给 6 个

/* MODE=status 用的手工状态：三种工作区状态各一个，验证大屏能一眼看出问题 */
const STATUS_PAYLOAD = () => ({
  tasks: [
    {id: 'T-1', name: 'a', wf: 0, state: 'run', prog: 0.5, agent: '01', cur: true},
    {id: 'T-2', name: 'b', wf: 1, state: 'done', prog: 1, agent: '02'},
    {id: 'T-3', name: 'c', wf: 2, state: 'done', prog: 1, agent: '03'},
    {id: 'T-4', name: 'd', wf: 3, state: 'run', prog: 0.5, agent: '04', cur: true},
    // #11：取消/失败的任务已经结束，但不能算成功，也不能被当成当前任务绑定
    {id: 'T-5', name: '取消的调用', wf: 1, state: 'cancelled', outcome: 'cancelled', prog: 1, agent: '02'},
    {id: 'T-6', name: '失败的调用', wf: 2, state: 'failed', outcome: 'failed', prog: 1, agent: '03'},
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
  epoch: 's1', dataKind: 'live',
  // #10：历史被任务预算省掉时的数量必须能在面板上看见（不是静默丢弃）
  tasksOmitted: 5, tasksOmittedActive: 0, tasksOmittedHistory: 5, currentOmitted: 0,
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
  if (MODE === 'hubs' || MODE === 'hubs6') {
    const n = MODE === 'hubs' ? 2 : 6;
    if (isState) { stateCalls++; return {ok: true, status: 200, json: async () => HUBS_PAYLOAD(n)}; }
    if (isEvents) return {ok: true, status: 200, json: async () => []};
  }
  // MODE=demo：先模拟"服务没起"，4.5 秒后重试时出现持续联网的演示后端（dataKind=demo）
  if (MODE === 'demo') {
    stateCalls++;
    if (Date.now() - DEMO_START < 4500) throw new Error('demo service not up');
    if (demoDown) throw new Error('demo service down');   // 连上后再断开：水印必须还在
    if (isState) return {ok: true, status: 200, json: async () => ({...HUBS_PAYLOAD(2), dataKind: 'demo', source: 'mock', servedFrom: 'mock'})};
    if (isEvents) return {ok: true, status: 200, json: async () => []};
  }
  // MODE=evdown：state 正常；events 依次模拟 网络失败 → 坏结构 → 非法/乱序 seq → 未知 verb → 恢复
  if (MODE === 'evdown') {
    if (isState) {
      stateCalls++;
      // 后半段：state 变成 200 错误对象；events 仍持续返回合法数组 → 两条故障通道必须分开
      if (evdownStateBad) return {ok: true, status: 200, json: async () => ({error: 'wrong schema'})};
      return {ok: true, status: 200, json: async () => HUBS_PAYLOAD(2)};
    }
    if (isEvents) {
      evdownCalls++;
      if (evdownCalls === 1) throw new Error('events down');
      if (evdownCalls === 2) return {ok: true, status: 200, json: async () => ({error: 'wrong schema'})};
      if (evdownCalls === 3) return {ok: true, status: 200, json: async () => null};
      if (evdownCalls === 4) return {ok: true, status: 200, json: async () => 5};                     // 非数组
      if (evdownCalls === 5) return {ok: true, status: 200, json: async () => [{seq: 0, verb: 'read'}]}; // 非法 seq
      if (evdownCalls === 6) return {ok: true, status: 200, json: async () => [{seq: -3, verb: 'read'}, null]};
      if (evdownCalls === 7) return {ok: true, status: 200, json: async () => [{seq: 7, verb: 'futureVerb', task_name: '未来动作'}]};
      if (evdownCalls === 8) return {ok: true, status: 200, json: async () => [{seq: 5, verb: 'read', task_name: '乱序旧事件'}]};
      if (evdownCalls === 9) return {ok: true, status: 200, json: async () => []};
      return {ok: true, status: 200, json: async () => [{seq: 9, verb: 'read', task_name: '恢复读取', kind: 'tool', agent: '01', name: '智能体1'}]};
    }
  }
  if (MODE === 'status') {
    /* #8 阶段由测试推进：good → bad（200 错误 schema，两轮以上）→ badEvents（state 坏、events 正常）
       → empty（合法空数组）→ good（恢复）。 */
    if (isState) {
      stateCalls++;
      if (statusPhase === 'bad' || statusPhase === 'badEvents') {
        statusBadServed++;
        if (statusBadServed === 2) statusEpochBad = true;
        // 第一条错误对象；第二条「外壳像合法 state，但元素/代际/protocol 坏」——不能采纳 epoch/dataKind
        const bad = statusBadServed % 2 === 1
          ? {error: 'wrong schema'}
          : {tasks: [null], workflows: [], agents: [], epoch: 'e-bad', source: 'bad', dataKind: 'demo'};
        return {ok: true, status: 200, json: async () => bad};
      }
      if (statusPhase === 'empty') {
        // 合法空数组必须真的可用（与缺字段/错误对象严格区分）
        return {ok: true, status: 200, json: async () => ({tasks: [], workflows: [], agents: [],
          epoch: 's1', source: 'test', servedFrom: 'test', dataKind: 'live'})};
      }
      return {ok: true, status: 200, json: async () => STATUS_PAYLOAD()};
    }
    if (isEvents) {
      // state 协议故障期间 events 仍可提交：事件流不能被 state 错误连带作废
      if (statusPhase === 'badEvents') {
        return {ok: true, status: 200, json: async () => ([
          {seq: 42, verb: 'read', task_name: '快照故障期间事件', kind: 'tool', agent: '01', name: 'a1'},
        ])};
      }
      return {ok: true, status: 200, json: async () => []};
    }
  }
  if (MODE === 'lanes') {
    /* #6 阶段由测试显式推进（不靠轮询次数猜）：
       base（6 工作区）→ overflow（100 工作区）→ removed（keyW02 消失 + 编号 02 回收）→ reappear（keyW02 重现）。 */
    if (isState) {
      stateCalls++;
      const payload = lanesPhase === 'overflow' ? overflowLanesState()
        : lanesPhase === 'removed' ? LANES_REMOVED
          : lanesPhase === 'reappear' ? LANES_REAPPEAR
            : LANES_PAYLOAD;
      return {ok: true, status: 200, json: async () => payload};
    }
    if (isEvents) {
      const list = lanesPhase === 'overflow' ? OVERFLOW_LANES_EVENTS
        : lanesPhase === 'base' ? LANES_EVENTS : [];
      return {ok: true, status: 200, json: async () => list};
    }
  }
  if (MODE === 'cur') {
    if (isState) return {ok: true, status: 200, json: async () => CUR_PAYLOAD};
    if (isEvents) return {ok: true, status: 200, json: async () => []};
  }
  if (MODE === 'evil') {
    if (isState) return {ok: true, status: 200, json: async () => EVIL_PAYLOAD};
    if (isEvents) return {ok: true, status: 200, json: async () => EVIL_EVENTS};
  }
  /* MODE=gapinit：首次连接（游标 0）时事件缓存最早序号已是 101 → 连接前历史已截断 */
  if (MODE === 'gapinit') {
    if (isState) return {ok: true, status: 200, json: async () => ({...HUBS_PAYLOAD(2), eventBacklog: {oldest: 101, newest: 400, count: 300}})};
    if (isEvents) return {ok: true, status: 200, json: async () => []};
  }
  /* MODE=gaplive：先正常拿到 seq=5，随后缓存窗口跳到 101 → 连接期间丢了事件 */
  if (MODE === 'gaplive') {
    if (isEvents) return {ok: true, status: 200, json: async () => (gapCalls === 1
      ? [{seq: 5, verb: 'read', task_name: '普通事件', kind: 'tool', agent: '01', name: '智能体1'}]
      : [])};
    if (isState) {
      gapCalls++;
      const bl = gapCalls === 1 ? {oldest: 1, newest: 5, count: 5} : {oldest: 101, newest: 500, count: 300};
      return {ok: true, status: 200, json: async () => ({...HUBS_PAYLOAD(2), eventBacklog: bl})};
    }
  }
  // MODE=recover：第一次拉 state 直接失败，验证"失败后还能自己接上"；接上后再断一次，
  // 验证真实数据不被丢成演示数据（第 5 次起断线）
  if (MODE === 'recover' && isState) {
    stateCalls++;
    if (stateCalls === 1) throw new Error('simulated network down');
    if (stateCalls >= 5) throw new Error('simulated live disconnect');
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
  matchMedia: q => ({ matches: REDUCE_MODE && String(q).includes('prefers-reduced-motion'), addEventListener() {} }),
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

const checks = MODE === 'demo' ? await (async () => {
  const mode0 = text('mode'), demo0 = body.dataset.demo, li0 = liCount(), feed0 = inner('feed');
  const base = [
    ['拉不到接口时降级为演示模式', mode0 === '演示数据 · 未连接', `mode = "${mode0}"`],
    ['演示模式打上水印标记', demo0 === '1', `data-demo = ${demo0}`],
    ['演示数据仍然渲染 12 个智能体', li0 === 12, `li 数 = ${li0}`],
    ['演示数据仍然填满任务流', /读取|生成|核验|复核/.test(feed0), `feed 前 80 字 = ${feed0.slice(0, 80)}`],
    ['降级时没有 console.error', errors.length === 0, errors.slice(0, 3).join(' | ')],
  ];
  const api = sandbox.window.__AGENT_OPS__;
  // 演示模式的重试间隔 5 秒：等到 mock 服务出现，验证「联网的演示后端」仍不等于真实数据
  await new Promise(r => setTimeout(r, 4200));
  const mode1 = text('mode'), demo1 = body.dataset.demo, calls1 = stateCalls;
  // matchMedia 对 prefers-reduced-motion 返回 true：只该关动画，轮询必须继续
  await new Promise(r => setTimeout(r, 1800));
  const calls2 = stateCalls;
  const liAfter = liCount(), s2After = text('s2');
  const reduced = !!api && api.reduced === true;
  const pausedAtPoll = api ? api.paused : undefined;
  const connected = !!api && api.live === true;
  // 用户主动暂停：轮询冻结并给出提示；继续后恢复
  if (api && typeof api.setPaused === 'function') api.setPaused(true);
  await new Promise(r => setTimeout(r, 120));
  const callsPause = stateCalls;
  await new Promise(r => setTimeout(r, 1300));
  const callsPaused = stateCalls;
  const tag = byId.get('#pauseTag');
  const tagShown = !!tag && tag.hidden === false && /暂停/.test(String(tag.textContent));
  const pauseLabel = text('pause');
  if (api && typeof api.setPaused === 'function') api.setPaused(false);
  await new Promise(r => setTimeout(r, 1400));
  const callsResumed = stateCalls;
  const tagHidden = !!tag && tag.hidden === true;
  const resumeLabel = text('pause');
  const demoPaused = body.dataset.demo, modePaused = text('mode');

  /* ---- mock 演示后端的真实 tick / 归属 / 积压分页 / 重启契约（独立进程，不看手工拼的响应） ---- */
  const mockChecks = await (async () => {
    const out = [];
    let child = null, child2 = null;
    try {
      const mkPort = await freePortNear(process.env.TEST_PORT_BASE, 22);
      child = spawn(process.execPath, ['server.mjs'], {
        cwd: ROOT, env: bridgeEnv({PORT: String(mkPort), EVIL: '0'}), stdio: 'ignore',
      });
      const getState = async port => {
        const r = await rawGet('/api/agent-ops/state', {}, port);
        return r.status === 200 ? JSON.parse(r.body) : null;
      };
      let st = null;
      const wait0 = Date.now();
      while (Date.now() - wait0 < 8000) {
        try { st = await getState(mkPort); if (st) break; } catch { /* 未就绪 */ }
        await new Promise(r => setTimeout(r, 150));
      }
      out.push(['demo mock 实例就绪', !!st, `port=${mkPort}`]);
      if (!st) return out;

      out.push(['demo mock 工作区 key 稳定为 demo:Wxx，dataKind 始终 demo',
        st.dataKind === 'demo' && !!st.epoch && st.protocolVersion === 2
          && (st.workflows || []).length === 11
          && (st.workflows || []).every(w => /^demo:W\d\d$/.test(String(w.key))),
        `dataKind=${st.dataKind} epoch=${st.epoch} keys=${JSON.stringify((st.workflows || []).map(w => w.key))}`]);
      const allRes = await rawGet('/api/agent-ops/state?source=all', {}, mkPort);
      const allSt = allRes.status === 200 ? JSON.parse(allRes.body) : null;
      const srcRes = await rawGet('/api/sources', {}, mkPort);
      out.push(['demo 来源切换/合并视图仍标 demo（不因请求参数变 live）',
        !!allSt && allSt.dataKind === 'demo' && allSt.source === 'mock'
          && srcRes.status === 200 && /"dataKind":"demo"/.test(srcRes.body),
        `all=${allSt && allSt.dataKind} sources=${srcRes.status}`]);
      const wfKeys = new Set((st.workflows || []).map(w => String(w.key)));
      const wfCount = (st.workflows || []).length;
      out.push(['demo agents.wf 由当前任务导出且在范围内',
        (st.agents || []).length === 12
          && (st.agents || []).every(a => Number.isInteger(a.wf) && a.wf >= 0 && a.wf < wfCount)
          && (st.tasks || []).some(t => t.state === 'run'
            && (st.agents || []).some(a => a.code === t.agent && a.wf === t.wf)),
        JSON.stringify((st.agents || []).map(a => `${a.code}:${a.wf}`))]);

      /* 等积压 > 40：验证「顺序分页」，不是 slice(-40) 从末尾截断 */
      let backlog = st.eventBacklog || {count: 0};
      const wait1 = Date.now();
      while (Date.now() - wait1 < 20000 && (!backlog || backlog.count <= 40)) {
        await new Promise(r => setTimeout(r, 300));
        const s = await getState(mkPort);
        if (s) backlog = s.eventBacklog || backlog;
      }
      out.push(['demo 事件积压超过 40（顺序分页的前提）', !!backlog && backlog.count > 40,
        JSON.stringify(backlog)]);

      const firstRes = await rawGet('/api/agent-ops/events?after=0', {}, mkPort);
      const firstArr = firstRes.status === 200 ? JSON.parse(firstRes.body) : null;
      /* 用**同一个响应**的 backlog 头判断起点：state 与 events 之间可能又落了新事件，
         只有「第一页第一条 == 该响应窗口的最早序号」才能证明不是从末尾截断。 */
      const firstOldest = Number(firstRes.headers['x-agent-ops-backlog-oldest']);
      const firstOk = Array.isArray(firstArr) && firstArr.length > 0 && firstArr.length <= 40
        && firstArr[0].seq === firstOldest
        && firstArr.every(e => e.workspace && wfKeys.has(String(e.workspace)) && e.agent && e.src === 'mock');
      out.push(['demo 旧数组响应从最早未读开始，每条事件带执行者/工作区',
        firstOk, `n=${firstArr && firstArr.length} first=${firstArr && firstArr[0] && firstArr[0].seq} oldest=${firstOldest}`]);
      out.push(['demo 事件响应头带 epoch/nextCursor/hasMore',
        firstRes.headers['x-agent-ops-epoch'] === st.epoch
          && /^\d+$/.test(String(firstRes.headers['x-agent-ops-next-cursor'] || ''))
          && /^[01]$/.test(String(firstRes.headers['x-agent-ops-has-more'] || ''))
          && firstRes.headers['x-agent-ops-backlog-count'] === String(backlog.count),
        JSON.stringify({epoch: firstRes.headers['x-agent-ops-epoch'], more: firstRes.headers['x-agent-ops-has-more']})]);

      const envRes = await rawGet('/api/agent-ops/events?after=0&format=v2', {}, mkPort);
      const env2 = JSON.parse(envRes.body);
      out.push(['demo format=v2 外壳带 epoch/backlog/nextCursor/hasMore',
        env2.protocolVersion === 2 && env2.epoch === st.epoch && env2.source === 'mock'
          && Array.isArray(env2.events) && env2.events.length > 0
          && env2.nextCursor === env2.events[env2.events.length - 1].seq
          && typeof env2.hasMore === 'boolean' && !!env2.backlog
          && env2.backlog.count === backlog.count,
        JSON.stringify({...env2, events: '(略)'})]);

      /* 顺序翻页：从 nextCursor 继续，seq 连续、不漏中间，能追到最新 */
      let cursor = 0, collected = [], pages = 0, gap = '';
      while (pages < 40) {
        const rr = await rawGet('/api/agent-ops/events?after=' + cursor + '&format=v2', {}, mkPort);
        const e = JSON.parse(rr.body);
        pages++;
        for (const ev of e.events) {
          if (collected.length && ev.seq !== collected[collected.length - 1] + 1) {
            gap = `seq ${collected[collected.length - 1]} → ${ev.seq}`;
          }
          collected.push(ev.seq);
        }
        cursor = e.nextCursor;
        if (!e.hasMore) break;
      }
      out.push(['demo 积压>40 时顺序分页不漏中间、能追到最新',
        collected.length > 40 && !gap
          && collected[0] === firstArr[0].seq
          && collected.every((v, i) => i === 0 || v === collected[i - 1] + 1),
        `pages=${pages} n=${collected.length} first=${collected[0]} last=${collected[collected.length - 1]} gap=${gap || '无'}`]);

      /* 旧事件归属不随后续解绑/改派变化：几秒后同 seq 的 agent/workspace 必须原样 */
      const snapOf = arr => new Map(arr.map(e => [e.seq, `${e.agent}|${e.workspace}`]));
      const before = snapOf(firstArr);
      await new Promise(r => setTimeout(r, 4000));
      const laterRes = await rawGet('/api/agent-ops/events?after=' + (firstArr[0].seq - 1), {}, mkPort);
      const later = JSON.parse(laterRes.body);
      const remained = [...before.entries()].filter(([sq]) => later.some(e => e.seq === sq));
      out.push(['demo 任务解绑后旧事件仍保留原执行者/工作区',
        remained.length > 0 && remained.every(([sq, sig]) => {
          const e = later.find(x => x.seq === sq);
          return `${e.agent}|${e.workspace}` === sig;
        }) && later.some(e => (e.verb === 'check' || e.verb === 'review') && e.agent && e.workspace),
        `kept=${remained.length}/${before.size}`]);

      /* 重启：新进程 epoch 变化、序号从 1 重来，工作区 ID 仍是同一演示命名空间 */
      const oldEpoch = st.epoch;
      await stopChild(child);
      const mk2Port = await freePortNear(process.env.TEST_PORT_BASE, 23);
      child2 = spawn(process.execPath, ['server.mjs'], {
        cwd: ROOT, env: bridgeEnv({PORT: String(mk2Port), EVIL: '0'}), stdio: 'ignore',
      });
      let st2 = null;
      const wait2 = Date.now();
      while (Date.now() - wait2 < 8000) {
        try {
          const r = await rawGet('/api/agent-ops/state', {}, mk2Port);
          if (r.status === 200) {
            st2 = JSON.parse(r.body);
            /* 新实例要等 tick 发出第一条事件，才能验证序号确实从 1 重来 */
            if (st2.eventBacklog && st2.eventBacklog.count > 0) break;
          }
        } catch { /* 未就绪 */ }
        await new Promise(r => setTimeout(r, 150));
      }
      out.push(['demo 重启后 epoch 变化、事件序号从 1 重来',
        !!st2 && st2.epoch !== oldEpoch && !!st2.eventBacklog
          && st2.eventBacklog.oldest === 1 && st2.eventBacklog.count < backlog.count
          && (st2.workflows || []).every(w => /^demo:W\d\d$/.test(String(w.key))),
        JSON.stringify({oldEpoch, newEpoch: st2 && st2.epoch, backlog: st2 && st2.eventBacklog})]);
    } catch (err) {
      out.push(['demo mock 真实 tick 契约测试执行完成', false, String(err && err.message)]);
    } finally {
      await stopChild(child);
      await stopChild(child2);
    }
    return out;
  })();

  /* 连上之后再断线：演示水印与 dataKind 不能被洗成实时数据 */
  demoDown = true;
  await new Promise(r => setTimeout(r, 2200));
  const modeDown = text('mode'), demoDownTag = body.dataset.demo;

  return [...base,
    ['减少动效不等于暂停（reduce=true 时 paused=false）', reduced && pausedAtPoll === false, `reduced=${reduced} paused=${pausedAtPoll}`],
    ['减少动效下持续轮询并拿到最新数据', connected && calls2 > calls1, `state 请求 ${calls1} → ${calls2}, live=${connected}`],
    ['减少动效下最新数据确实渲染到面板', liAfter === 2 && s2After === '2', `li=${liAfter} s2="${s2After}"`],
    ['联网的 mock 后端仍标成演示数据', connected && /^演示数据/.test(mode1) && !/^实时数据$/.test(mode1), `mode = "${mode1}" live=${connected}`],
    ['mock 持续联网时水印仍在（data-demo=1）', demo1 === '1', `data-demo = ${demo1}`],
    ['用户暂停后轮询冻结并给出提示', callsPaused === callsPause && tagShown && pauseLabel === '继续', `请求 ${callsPause} → ${callsPaused}, 提示=${tagShown}, 按钮=${pauseLabel}`],
    ['暂停时演示水印与数据性质不变', demoPaused === '1' && /^演示数据/.test(modePaused), `data-demo=${demoPaused} mode="${modePaused}"`],
    ['继续后轮询恢复、提示消失', callsResumed > callsPaused && tagHidden && resumeLabel === '暂停', `请求 ${callsPaused} → ${callsResumed}, 提示隐藏=${tagHidden}, 按钮=${resumeLabel}`],
    ['demo 断线后仍显示演示数据（不回落实时）', /^演示数据/.test(modeDown) && !/^实时数据$/.test(modeDown), `mode = "${modeDown}"`],
    ['demo 断线后水印仍在', demoDownTag === '1', `data-demo = ${demoDownTag}`],
    ...mockChecks,
  ];
})() : MODE === 'dsh' ? [
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
  // 复核：节点标签截断，悬浮提示必须给完整目录名
  ['悬浮提示能拿到完整工作区名', (() => {
    const info = sandbox.window.__AGENT_OPS__.hubInfo();
    return info.length > 0 && info.some(x => x.full && x.full.length > 0)
      && info.some(x => x.name && x.name !== x.full);
  })(), JSON.stringify(sandbox.window.__AGENT_OPS__.hubInfo())],
  ['没有演示水印', body.dataset.demo === '0', `data-demo = ${body.dataset.demo}`],
  ['没有离线标记', !body.dataset.offline, `data-offline = ${body.dataset.offline}`],
  ['运行期没有 console.error', errors.length === 0, errors.slice(0, 3).join(' | ')],
] : MODE === 'recover' ? await (async () => {
  const mode0 = text('mode'), s00 = text('s0'), li0 = liCount(), demo0 = body.dataset.demo;
  const api = sandbox.window.__AGENT_OPS__;
  const kind0 = api ? api.dataKind : undefined;
  const base = [
    ['首次失败后能自己接上后端', mode0 === '实时数据', `mode = "${mode0}"（第一次拉取是故意失败的）`],
    ['接上后数据是真的', Number(s00) > 0 && li0 >= 1, `s0 = "${s00}", li = ${li0}`],
    ['水印已经撤掉', demo0 !== '1', `data-demo = ${demo0}`],
    ['真实连接的数据性质是 live', kind0 === 'live', `dataKind = ${kind0}`],
    ['运行期没有 console.error', errors.length === 0, errors.slice(0, 3).join(' | ')],
  ];
  // 真实连接成功后后端再断线：保留真实数据 + 断线提示，绝不回落演示数据
  await new Promise(r => setTimeout(r, 2800));
  const mode1 = text('mode'), demo1 = body.dataset.demo, off1 = body.dataset.offline;
  const kind1 = api ? api.dataKind : undefined;
  const feed1 = api && api.feed ? api.feed.length : -1;
  return [...base,
    ['真实连接后断线时显示中断', /^数据中断 \d+s$/.test(mode1), `mode = "${mode1}"`],
    ['断线后保留真实数据（不清空、不回落演示）', Number(text('s0')) > 0 && liCount() >= 1 && feed1 > 0,
      `s0=${text('s0')} li=${liCount()} feed=${feed1}`],
    ['断线后数据性质仍是 live（不回落演示）', kind1 === 'live', `dataKind = ${kind1}`],
    ['断线只标记离线，不打演示水印', off1 === '1' && demo1 !== '1', `offline=${off1} data-demo=${demo1}`],
  ];
})() : MODE === 'pop' ? [
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
})() : MODE === 'hubs' ? await (async () => {
  await new Promise(r => setTimeout(r, 600));
  const api = sandbox.window.__AGENT_OPS__;
  const info = api.hubInfo();
  const ids = info.map(i => i.id);
  const m0 = text('mode'), demo0 = body.dataset.demo, li0 = liCount();
  const kind0 = api.dataKind;
  const base = [
    ['2 个工作区只画 2 个汇聚节点', info.length === 2, `节点=${JSON.stringify(ids)}`],
    // 复核：原来固定画 3 个节点再 clamp 取工作区，2 个工作区时后两个节点重复
    ['两个节点显示不同工作区，不再重复', ids.length === 2 && new Set(ids).size === 2 && ids.every(Boolean), JSON.stringify(ids)],
    ['节点标签与真实工作区一致', ids.includes('W01') && ids.includes('W02'), JSON.stringify(ids)],
    // 流入效果 = 这个工作区有没有在跑的任务（不是随机动画）
    ['有任务的工作区有流入光点', (() => {
      const f = sandbox.window.__AGENT_OPS__.hubFlow();
      return f.some(x => x.running && x.pulses > 0);
    })(), JSON.stringify(sandbox.window.__AGENT_OPS__.hubFlow())],
    ['没任务的工作区没有流入光点', (() => {
      const f = sandbox.window.__AGENT_OPS__.hubFlow();
      return f.some(x => !x.running) && f.filter(x => !x.running).every(x => x.pulses === 0);
    })(), JSON.stringify(sandbox.window.__AGENT_OPS__.hubFlow())],
    ['没任务也保留静态的线', (() => {
      const f = sandbox.window.__AGENT_OPS__.hubFlow();
      return f.every(x => x.lines > 0);
    })(), JSON.stringify(sandbox.window.__AGENT_OPS__.hubFlow())],
    // 用户实测修正：右侧父子连线保留静态线，只停止流入效果（不能把线删掉）
    ['空闲智能体仍保留右侧父子连线', (() => {
      const ls = sandbox.window.__AGENT_OPS__.agentLinks;
      return ls.length === 2 && ls.some(l => l.to === '02') && ls.some(l => l.to === '01');
    })(), JSON.stringify(sandbox.window.__AGENT_OPS__.agentLinks)],
    ['空闲智能体的连线只有静态线（没有流入效果）', (() => {
      const f = sandbox.window.__AGENT_OPS__.agentFlow();
      return f.some(x => x.to === '02' && x.flow === false) && f.some(x => x.to === '01' && x.flow === true);
    })(), JSON.stringify(sandbox.window.__AGENT_OPS__.agentFlow())],
  ];
  // 数据性质（dataKind=live）与连接健康分开：真实数据不能被打成演示数据
  // 暂停语义（reduce=false）：用户主动暂停才冻结轮询，并显示提示；继续后恢复
  api.setPaused(true);
  await new Promise(r => setTimeout(r, 120));
  const callsPause = stateCalls;
  await new Promise(r => setTimeout(r, 1300));
  const callsPaused = stateCalls;
  const tag = byId.get('#pauseTag');
  const tagShown = !!tag && tag.hidden === false && /暂停/.test(String(tag.textContent));
  api.setPaused(false);
  await new Promise(r => setTimeout(r, 1400));
  const callsResumed = stateCalls;
  return [...base,
    ['live 数据标为实时数据且没有演示水印', kind0 === 'live' && m0 === '实时数据' && demo0 !== '1', `dataKind=${kind0} mode="${m0}" data-demo=${demo0}`],
    ['暂停不改变数据性质与已有数据', Number(text('s0')) === info.length && li0 >= 1, `s0=${text('s0')} li=${li0}`],
    ['用户暂停后轮询冻结并显示提示', callsPaused === callsPause && tagShown, `请求 ${callsPause}→${callsPaused} 提示=${tagShown}`],
    ['继续后轮询恢复', callsResumed > callsPaused, `请求 ${callsPaused}→${callsResumed}`],
  ];
})() : MODE === 'hubs6' ? await (async () => {
  const api = sandbox.window.__AGENT_OPS__;
  const snap = () => { const i = api.hubInfo(); return {n: i.length, ids: i.map(x => x.id)}; };
  const isIdentity = wf => wf.length === 5 && wf.every((v, i) => v === i);   // 前 5 个工作区的恒等映射
  await new Promise(r => setTimeout(r, 700));
  const five = snap();

  // 轮换若干次，看第 6 个工作区会不会被轮到
  let sawW06 = false;
  for (let k = 0; k < 16 && !sawW06; k++) {
    api.switchHub();
    if (snap().ids.includes('W06')) sawW06 = true;
  }
  const rotated = !isIdentity(api.hubState().wf);

  // 跨轮询保留：等过至少一次轮询（1.5s，小于轮换间隔 2.4s），映射不能被重置成前 5 个
  await new Promise(r => setTimeout(r, 1500));
  const afterPoll = !isIdentity(api.hubState().wf);

  // 自动轮换：不手工调用，等一个轮换周期 + 余量，看轮换计数有没有自己往前走
  const turnBefore = api.hubState().turn;
  await new Promise(r => setTimeout(r, 3000));
  const turnAfter = api.hubState().turn;
  const afterAutoIds = snap();

  return [
    ['6 个工作区最多画 5 个节点（上限 5）', five.n === 5, `节点=${JSON.stringify(five.ids)}`],
    ['5 个节点显示 5 个不同工作区', five.n === 5 && new Set(five.ids).size === 5 && five.ids.every(Boolean), JSON.stringify(five.ids)],
    // 复核：真实模式下不轮换，第 6 个工作区永远看不到
    ['超过 5 个时能在轮换里看到第 6 个工作区', sawW06, `最后=${JSON.stringify(snap().ids)}`],
    // 复核：每次轮询把节点映射重置回前三个 —— 轮换结果必须跨轮询保留
    ['轮换结果跨轮询保留（不会被重置回前 5 个）', rotated && afterPoll, `轮换后=${JSON.stringify(api.hubState().wf)}`],
    // 复核：轮换只在手工调用时才发生 —— 定时器必须自己往前走
    ['定时器自动轮换（不依赖手工调用）', turnAfter > turnBefore, `turn ${turnBefore} → ${turnAfter}`],
    ['轮换后节点数与唯一性不变', afterAutoIds.n === 5 && new Set(afterAutoIds.ids).size === 5, JSON.stringify(afterAutoIds.ids)],
    // 复核：换了工作区却没重算 hubCounts，节点上还显示上一个工作区的智能体数。
    // 必须在 switchHub() 之后**立刻**读，等过一次轮询就会被 replaceAll 修好，测不出问题。
    ['轮换后节点上的智能体数量立刻跟着换（不等下一次轮询）', (() => {
      // 必须盯住"刚刚切到 W06 的那个节点"：如果 W06 本来就在显示，轮询早就把数字修好了，测不出问题
      for (let k = 0; k < 120; k++) {
        const before = api.hubInfo().map(x => x.id);
        api.switchHub();
        const after = api.hubInfo();
        const idx = after.findIndex((x, i) => x.id === 'W06' && before[i] !== 'W06');
        if (idx >= 0) return after[idx].agents === 3;   // W06 有 3 个智能体
      }
      return false;
    })(), `节点=${JSON.stringify(api.hubInfo())}`],
  ];
})() : MODE === 'evdown' ? await (async () => {
  await new Promise(r => setTimeout(r, 2600));
  const m0 = text('mode');
  const demo0 = body.dataset.demo;
  const api = sandbox.window.__AGENT_OPS__;
  const h0 = api && api.health ? api.health() : null;
  const base = [
    // 复核：evLastOk 初始为 0，中断时长会算成几亿秒 —— 从没连上过时说「尚未连接」
    ['首次连接就失败时显示「事件流尚未连接」而不是天文数字', /尚未连接/.test(m0) && !/\d{6,}s/.test(m0), `mode = "${m0}"`],
    ['中断时不再显示成绿色实时', !/^实时数据$/.test(m0), `mode = "${m0}"`],
    // 复核：新增的 ev 状态触发了 data-demo=1，把真实数据标成了演示数据
    ['事件流中断不会打出「演示数据」水印', demo0 !== '1', `data-demo = ${demo0}`],
  ];
  // 200 不代表协议正确：错误对象/null/非数组/非法 seq 之后健康告警必须还在，state 也不能丢
  const midBase = [
    ['200 错误对象/null/非数组/非法 seq 不当作实时（保持健康告警）',
      !!(h0 && h0.evFails >= 2) && h0.cursor === 0, `evFails=${h0 && h0.evFails} cursor=${h0 && h0.cursor}`],
    ['协议错误不丢弃已拿到的正常 state', !!h0 && text('s0') === '2' && text('s2') === '2', `s0="${text('s0')}" s2="${text('s2')}"`],
  ];
  // 未知 verb 但 seq 合法：游标要前进，不能反复读同一窗口
  await new Promise(r => setTimeout(r, 800));
  const h1 = api && api.health ? api.health() : null;
  const mid = [
    ['未知 verb + 合法 seq 时游标前进', !!h1 && h1.cursor === 7, `cursor=${h1 && h1.cursor} invalid=${h1 && h1.evInvalid} unknown=${h1 && h1.evUnknown}`],
    ['未知动作不冒充已知动作写入任务流', !inner('feed').includes('未来动作'), inner('feed').slice(-160)],
  ];
  // 之后恢复：合法数组要清健康告警、游标走到最新序号、事件真的进任务流
  await new Promise(r => setTimeout(r, 3400));
  const m2 = text('mode'), demo2 = body.dataset.demo;
  const h2 = api && api.health ? api.health() : null;
  const recCount = (inner('feed').match(/恢复读取/g) || []).length;
  const rec = [
    ['事件接口恢复后回到实时数据', m2 === '实时数据', `mode = "${m2}"`],
    ['恢复后游标走到最新序号', !!h2 && h2.cursor === 9 && h2.evFails === 0, `cursor=${h2 && h2.cursor} evFails=${h2 && h2.evFails}`],
    ['恢复后的事件真的进了任务流', recCount === 1, `恢复读取出现 ${recCount} 次`],
    ['重复/乱序的旧 seq 不会重复写事件', !inner('feed').includes('乱序旧事件'), inner('feed').slice(-200)],
    ['恢复后不误打演示水印', demo2 !== '1', `data-demo = ${demo2}`],
  ];
  /* T05：events 全部恢复后，再把 state 转成 200 错误对象 —— 两条故障通道必须分开：
     events 成功不能把 state 故障洗成绿色实时；state 协议错误也不能清掉最后可信画面。 */
  evdownStateBad = true;
  await new Promise(r => setTimeout(r, 2500));
  const mBad = text('mode'), demoBad = body.dataset.demo;
  const hBad = api && api.health ? api.health() : null;
  evdownStateBad = false;
  await new Promise(r => setTimeout(r, 1800));
  const hBack = api && api.health ? api.health() : null;
  const stateSep = [
    ['state 故障时提示「数据快照异常」（与事件流故障分开）',
      /数据快照异常/.test(mBad) && !!(hBad && hBad.stateFails >= 2), `mode = "${mBad}" stateFails=${hBad && hBad.stateFails}`],
    ['events 恢复后 state 故障仍然保留（一次 events 成功不清 state 错误）',
      !!hBad && hBad.evFails === 0 && hBad.cursor === 9, `evFails=${hBad && hBad.evFails} cursor=${hBad && hBad.cursor}`],
    ['state 协议故障不清掉最后可信画面', text('s0') === '2' && text('s2') === '2', `s0="${text('s0')}" s2="${text('s2')}"`],
    ['state 故障不打演示水印', demoBad !== '1', `data-demo = ${demoBad}`],
    ['state 恢复后回到实时数据', text('mode') === '实时数据' && !!(hBack && hBack.stateFails === 0),
      `mode = "${text('mode')}" stateFails=${hBack && hBack.stateFails}`],
  ];
  return [...base, ...midBase, ...mid, ...rec, ...stateSep];
})() : MODE === 'evil' ? (() => {
  const base = [
    ['智能体名里的 HTML 被转义', !inner('agents').includes('<img') && inner('agents').includes('&lt;img'),
      inner('agents').slice(0, 120)],
    ['任务流里没有可执行的 <script>', !inner('feed').includes('<script'), inner('feed').slice(0, 120)],
    ['仍然切到实时模式', text('mode') === '实时数据', `mode = "${text('mode')}"`],
  ];
  const api = sandbox.window.__AGENT_OPS__;
  if (!api || typeof api.renderSample !== 'function' || typeof api.hl !== 'function') {
    return [...base, ['页面暴露高亮渲染测试钩子', false, '没有 __AGENT_OPS__.hl / renderSample']];
  }
  // 高亮必须在原始代码上分词：字符串里的关键词、注释、引号、尖括号都不能被再次替换
  const jsSrc = ['const s = "hello return";', '// const in comment', 'const t = "a < b & c > d";'];
  const pySrc = ['def f(x):', '    s = "for <b>"  # if True', '# return None'];
  const htmlSrc = ['<div class="kw">hello</div>', '<!-- <span class="kw">x</span> -->'];
  const jsH = api.renderSample(jsSrc, 'js');
  const pyH = api.renderSample(pySrc, 'py');
  const htmlH = api.renderSample(htmlSrc, 'html');
  const domCode = inner('code');   // 最后一次 renderSample 写进真实代码面板的 HTML
  const jsKw = (jsH.match(/class="kw"/g) || []).length;
  const pyKw = (pyH.match(/class="kw"/g) || []).length;
  const strip = h => String(h).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const allH = [jsH, pyH, htmlH, domCode];
  return [...base,
    ['JS 字符串里的关键词不被当成关键字',
      jsKw === 2 && !jsH.includes('<span class="kw">return</span>')
      && jsH.includes('<span class="str">"hello return"</span>'), `kw 数=${jsKw} ${jsH}`],
    ['JS 注释整行按注释处理（注释里的关键词不变色）',
      jsH.includes('<span class="cm">// const in comment</span>') && !jsH.includes('<span class="kw">comment</span>'), jsH],
    ['JS 字符串里的尖括号/和号被转义', jsH.includes('a &lt; b &amp; c &gt; d'), jsH],
    ['Python 字符串和行内注释结构正确',
      pyKw === 1 && pyH.includes('<span class="kw">def</span>') && pyH.includes('&lt;b&gt;')
      && pyH.includes('<span class="cm"># if True</span>'), pyH],
    ['Python 整行注释不产生关键字', pyH.includes('<span class="cm"># return None</span>')
      && !pyH.includes('<span class="kw">return</span>'), pyH],
    ['HTML 只给标签名包关键字、属性值包字符串',
      htmlH.includes('<span class="kw">div</span>') && htmlH.includes('<span class="str">"kw"</span>')
      && !htmlH.includes('<span <span'), htmlH],
    ['高亮输出标签结构完整（无自嵌套/未闭合）',
      allH.every(h => !h.includes('<span <span') && (h.match(/<span\b/g) || []).length === (h.match(/<\/span>/g) || []).length),
      JSON.stringify(allH.map(h => [(h.match(/<span\b/g) || []).length, (h.match(/<\/span>/g) || []).length]))],
    ['真实代码面板里尖括号被转义、不产生可执行标签',
      domCode.includes('&lt;') && !domCode.includes('<div') && domCode.includes('<span class="kw">div</span>'),
      domCode.slice(0, 240)],
    ['真实 DOM 文本与原始代码一致（剥离标签后无残留）',
      strip(domCode).includes('hello') && strip(domCode).includes('<div class="kw">hello</div>'), strip(domCode).slice(0, 240)],
  ];
})() : MODE === 'gapinit' ? (() => {
  const g = sandbox.window.__AGENT_OPS__ && sandbox.window.__AGENT_OPS__.eventGap;
  return [
    ['首次连接即提示历史被截断（kind=init）', !!g && g.on && g.kind === 'init', JSON.stringify(g)],
    ['缺口文案区分「连接前已截断」', inner('feed').includes('class="gapnote"') && inner('feed').includes('连接前'),
      inner('feed').slice(0, 140)],
  ];
})() : MODE === 'gaplive' ? (() => {
  const d = sandbox.window.__AGENT_OPS__;
  const g = d && d.eventGap;
  return [
    ['连接期间丢事件提示（kind=live）', !!g && g.on && g.kind === 'live', JSON.stringify(g)],
    ['缺口文案区分「连接期间丢失」', inner('feed').includes('class="gapnote"') && inner('feed').includes('丢了事件'),
      inner('feed').slice(0, 140)],
    ['缺口提示不影响已收到的事件', !!d && d.feed.length > 0, `feed=${d && d.feed.length}`],
  ];
})() : MODE === 'status' ? await (async () => {
  const api = sandbox.window.__AGENT_OPS__;
  const html = inner('wfStatus');
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const snap = () => ({s0: text('s0'), s3: text('s3'),
    rows: (inner('wfStatus').match(/<li /g) || []).length, h: api.health()});
  const base = [
    ['忙碌的工作区标成 busy 并显示在忙数量', html.includes('class="busy"') && html.includes('忙 2'), html.slice(0, 200)],
    ['失败的工作区标成 fail 并显示失败数与原因',
      html.includes('class="fail"') && html.includes('失败 3') && html.includes('exit 1'), html.slice(0, 400)],
    ['长时间没进展的工作区标成 stall 并显示多久没动', html.includes('class="stall"') && html.includes('停滞 15m'), html.slice(0, 400)],
    ['状态列表按工作区逐行渲染', (html.match(/<li /g) || []).length === 4, '行数=' + (html.match(/<li /g) || []).length],
    // 停滞优先：卡了 20 分钟但还挂着一条未完成调用，必须显示停滞，同时保留「忙 1」
    ['停滞且仍有未完成调用时显示停滞而不是忙碌',
      /class="stall"[^>]*><span class="wid">W04<\/span>[\s\S]*?停滞 20m[\s\S]*?忙 1/.test(html), html.slice(0, 700)],
  ];
  /* #11 展示层：取消/失败任务已经结束，但不能被算成成功或被绑成当前任务 */
  const t5 = api.tasks.find(t => t.id === 'T-5');
  const t6 = api.tasks.find(t => t.id === 'T-6');
  const a2 = api.agents.find(a => a.code === '02');
  const a3 = api.agents.find(a => a.code === '03');
  const cancelled = [
    ['取消/失败任务保留 outcome，不显示成成功',
      !!t5 && t5.state === 'cancelled' && t5.outcome === 'cancelled'
        && !!t6 && t6.state === 'failed' && t6.outcome === 'failed',
      JSON.stringify([t5 && [t5.id, t5.state, t5.outcome], t6 && [t6.id, t6.state, t6.outcome]])],
    ['取消/失败任务不计入已完成统计', text('s3') === '2', `s3 = "${text('s3')}"`],
    ['已结束的取消/失败任务不会被绑成当前任务',
      (!a2 || a2.task < 0 || api.tasks[a2.task].id !== 'T-5')
        && (!a3 || a3.task < 0 || api.tasks[a3.task].id !== 'T-6'),
      `agent02=${a2 && a2.task} agent03=${a3 && a3.task}`],
    // #10 展示层：省略数量与当前任务绑定都必须来自同一份数据
    ['任务省略数量在面板上可见', /省略 5/.test(text('feedMeta')), `feedMeta = "${text('feedMeta')}"`],
    ['智能体绑定到 cur 标记的当前任务',
      (() => {
        const a1 = api.agents.find(a => a.code === '01');
        const a4 = api.agents.find(a => a.code === '04');
        return !!a1 && a1.task >= 0 && api.tasks[a1.task].id === 'T-1'
          && !!a4 && a4.task >= 0 && api.tasks[a4.task].id === 'T-4';
      })(),
      JSON.stringify(api.agents.map(a => [a.code, a.task >= 0 ? api.tasks[a.task].id : 'idle']))],
  ];
  /* #8 协议校验：外壳/数组/元素/ID/数值/引用/类型逐个拒绝；合法空与旧协议可选字段放行 */
  const invalidStates = [
    ['错误对象', {error: 'wrong schema'}],
    ['null', null],
    ['数组顶层', []],
    ['缺 workflows 数组', {tasks: [], agents: []}],
    ['tasks 类型错误', {tasks: {}, workflows: [], agents: []}],
    ['数组内 null', {tasks: [null], workflows: [], agents: []}],
    ['数组内数字', {tasks: [5], workflows: [], agents: []}],
    ['元素缺 id', {tasks: [{state: 'run'}], workflows: [], agents: []}],
    ['重复 ID', {tasks: [{id: 'T-1'}, {id: 'T-1'}], workflows: [], agents: []}],
    ['非有限数值', {tasks: [{id: 'T-1', prog: NaN}], workflows: [], agents: []}],
    ['悬空 agent 引用', {tasks: [{id: 'T-1', state: 'run', agent: '99'}], workflows: [], agents: [{code: '01'}]}],
    ['epoch 类型错误', {tasks: [], workflows: [], agents: [], epoch: {}}],
    ['dataKind 类型错误', {tasks: [], workflows: [], agents: [], dataKind: 5}],
    ['workflows 元素为 null', {tasks: [], workflows: [null], agents: []}],
    ['agents 元素为数字', {tasks: [], workflows: [], agents: [7]}],
  ];
  const badResults = invalidStates.map(([name, v]) => ({name, r: api.validateState(v)}));
  const schema = [
    ['错误 schema 全部被拒绝（不能当合法空快照）',
      badResults.every(x => x.r && x.r.ok === false),
      JSON.stringify(badResults.filter(x => !x.r || x.r.ok).map(x => x.name))],
    ['合法空数组 state 可用', api.validateState({tasks: [], workflows: [], agents: []}).ok === true,
      JSON.stringify(api.validateState({tasks: [], workflows: [], agents: []}))],
    ['旧协议可选字段缺失仍然合法',
      api.validateState({tasks: [], workflows: [], agents: [], source: 'test'}).ok === true,
      JSON.stringify(api.validateState({tasks: [], workflows: [], agents: [], source: 'test'}))],
  ];
  /* 集成：正常画面 → 200 错误结构两轮以上（含伪 epoch/dataKind）→ 合法空 → 恢复 */
  const before = snap();
  statusPhase = 'bad';
  await wait(2600);   // ≥2 次坏 state
  const during = snap();
  const preserved = [
    ['200 错误 schema 不清掉最后可信画面',
      during.s0 === before.s0 && during.s3 === before.s3 && during.rows === before.rows,
      `s0 ${before.s0}→${during.s0} s3 ${before.s3}→${during.s3} rows ${before.rows}→${during.rows}`],
    ['state 故障单独提示，不冒充实时数据',
      /数据快照异常/.test(text('mode')) && !/^实时数据$/.test(text('mode')), `mode = "${text('mode')}"`],
    ['state 故障不更新 epoch / dataKind / 最后成功时间',
      during.h.epoch === before.h.epoch && during.h.dataKind === before.h.dataKind
        && during.h.stateLastOk === before.h.stateLastOk && during.h.lastOk === before.h.lastOk,
      JSON.stringify({before: [before.h.epoch, before.h.dataKind, before.h.stateLastOk, before.h.lastOk],
        during: [during.h.epoch, during.h.dataKind, during.h.stateLastOk, during.h.lastOk]})],
    ['坏 state 连续两轮以上被计数，而不是静默清空',
      during.h.stateFails >= 2 && statusBadServed >= 2, `stateFails=${during.h.stateFails} served=${statusBadServed}`],
    ['坏 state 里的 epoch/dataKind 没有被采纳',
      during.h.epoch === 's1' && during.h.dataKind === 'live' && statusEpochBad,
      `epoch=${during.h.epoch} dataKind=${during.h.dataKind} epochProbe=${statusEpochBad}`],
    ['state 故障不重置事件游标', during.h.cursor === before.h.cursor, `cursor ${before.h.cursor}→${during.h.cursor}`],
  ];
  // state 继续坏、但 events 合法：事件仍要提交，且不能清掉 state 故障
  statusPhase = 'badEvents';
  await wait(1500);
  const duringEv = snap();
  const evDuring = [
    ['state 故障不阻断 events 提交',
      duringEv.h.cursor === 42 && inner('feed').includes('快照故障期间事件'),
      `cursor=${duringEv.h.cursor} feed=${inner('feed').slice(-120)}`],
    ['一次 events 成功不清 state 错误（两者分开计数）',
      duringEv.h.stateFails >= 2 && duringEv.h.evFails === 0,
      `stateFails=${duringEv.h.stateFails} evFails=${duringEv.h.evFails}`],
  ];
  // 合法空 state：必须真的提交（与错误对象/缺字段区分），并更新健康
  statusPhase = 'empty';
  await wait(1800);
  const empty = snap();
  const emptyChecks = [
    ['合法空 state 正常提交（不是当作错误）',
      empty.s0 === '0' && empty.rows === 0 && liCount() === 0 && empty.h.stateFails === 0,
      `s0=${empty.s0} rows=${empty.rows} agents=${liCount()} stateFails=${empty.h.stateFails}`],
    ['合法空 state 更新最后成功时间并回到实时',
      empty.h.stateLastOk > before.h.stateLastOk && empty.h.lastOk > before.h.lastOk && text('mode') === '实时数据',
      `lastOk ${before.h.lastOk}→${empty.h.lastOk} stateLastOk ${before.h.stateLastOk}→${empty.h.stateLastOk} mode="${text('mode')}"`],
  ];
  statusPhase = 'good';
  await wait(1800);
  const after = snap();
  const restored = [
    ['损坏后恢复：可信画面回来且故障清除',
      after.s0 === '6' && after.rows === 4 && after.h.stateFails === 0 && text('mode') === '实时数据',
      `s0=${after.s0} rows=${after.rows} mode="${text('mode')}"`],
    ['恢复后 epoch / 游标保持同一代际', after.h.epoch === 's1' && after.h.cursor === 42,
      `epoch=${after.h.epoch} cursor=${after.h.cursor}`],
  ];
  return [...base, ...cancelled, ...schema, ...preserved, ...evDuring, ...emptyChecks, ...restored];
})() : MODE === 'lanes' ? await (async () => {
  const d = sandbox.window.__AGENT_OPS__;
  const s = d && d.particleStats ? d.particleStats() : null;
  if (!s) return [['粒子统计可用', false, '没有 __AGENT_OPS__.particleStats']];
  const labels = s.laneLabels || [];
  const laneOf = (code, ws) => (d && typeof d.laneOfAgent === 'function') ? d.laneOfAgent(code, ws) : 'n/a';
  const laneOfEv = ev => (d && typeof d.laneOfEvent === 'function') ? d.laneOfEvent(ev) : 'n/a';
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await wait(100); }
    return false;
  };
  // 历史事件回放用的那条基础样本：编号为空、workspace=keyW02（已进 evtRing）
  const storedOld = () => (Array.isArray(d.evtRing) ? d.evtRing : []).find(e => e && e.seq === 7) || null;
  const base = [
    ['6 个工作区只开 4 条泳道', labels.length === 4, `泳道=${JSON.stringify(labels)}`],
    ['前三条按工作区命名', labels[0] === 'W01' && labels[1] === 'W02' && labels[2] === 'W03', JSON.stringify(labels)],
    // 第 5 个及以后的工作区并进最后一条，标签必须带 +，不能假装是 W04
    ['第 4 条是合并泳道并标了 +', labels[3] === 'W04+', `最后一条=${labels[3]}`],
    ['没有粒子落进不存在的泳道', s.lanes.every(l => l >= 0 && l < 4), `lanes=${JSON.stringify(s.lanes)}`],
    // 编号为空/不在墙上的事件靠稳定 workspace 归位；未知 workspace 不能默认 W01
    ['未上墙会话按 workspace 落到对应泳道', laneOf('', 'keyW02') === 1, `lane('',keyW02)=${laneOf('', 'keyW02')}`],
    ['未知 workspace 明确未归属（不是 W01）',
      laneOf('99', 'no-such-key') === -1 && laneOf('', '') === -1,
      `未知=${laneOf('99', 'no-such-key')} 空=${laneOf('', '')}`],
    // 编号被回收/复用：同一编号现在属于别的工作区，历史回放仍按稳定 key 归属
    ['编号回收后回放仍按稳定 key 归属', laneOf('02', 'keyW04') === 3, `lane('02',keyW04)=${laneOf('02', 'keyW04')}`],
    // #6 三态：字段缺失才允许编号兼容；字段存在（哪怕空）就按稳定身份，未知则未归属
    ['旧协议缺少 workspace 字段时才按上墙编号兜底', laneOf('03') === 2, `lane('03')=${laneOf('03')}`],
    ['workspace 字段存在但为空 → 未归属，不回退编号',
      laneOf('03', '') === -1 && laneOf('01', '') === -1 && laneOf('01', null) === -1,
      `空=${laneOf('03', '')} null=${laneOf('01', null)}`],
    ['有稳定 key 且已知时按 key 归属（编号冲突以 key 为准）',
      laneOf('01', 'keyW02') === 1 && laneOf('02', 'keyW01') === 0,
      `lane('01',keyW02)=${laneOf('01', 'keyW02')} lane('02',keyW01)=${laneOf('02', 'keyW01')}`],
    ['已知旧 key 已被移除 → 未归属，不落进同编号的当前工作区',
      laneOf('01', 'removed-old-key') === -1 && laneOf('99', 'removed-old-key') === -1,
      `lane('01',removed)=${laneOf('01', 'removed-old-key')}`],
    ['laneOfEvent 保留「缺失 / 空值 / 未知」三态',
      laneOfEv({agent: '01'}) === 0 && laneOfEv({agent: '01', workspace: ''}) === -1
        && laneOfEv({agent: '01', workspace: null}) === -1
        && laneOfEv({agent: '01', workspace: 'gone-key'}) === -1,
      `缺失=${laneOfEv({agent: '01'})} 空=${laneOfEv({agent: '01', workspace: ''})} 未知=${laneOfEv({agent: '01', workspace: 'gone-key'})}`],
    ['未归属事件不产生粒子、不占泳道',
      s.unattributed >= 2 && s.lanes.every(l => l >= 0 && l < 4), `unattributed=${s.unattributed} lanes=${JSON.stringify(s.lanes)}`],
  ];
  // 首次接收：带「已移除旧 key + 已被回收编号」的事件必须直接判未归属，不进回放缓冲
  const beforeFirst = d.particleStats();
  d.onLiveEvent({seq: 901, verb: 'read', task_name: '旧身份首次接收', kind: 'tool', agent: '02', workspace: 'removed-old-key'});
  const afterFirst = d.particleStats();
  base.push(['首次接收旧 key 事件不绘制、不进回放缓冲',
    afterFirst.ring === beforeFirst.ring && afterFirst.unattributed === beforeFirst.unattributed + 1,
    `ring ${beforeFirst.ring}→${afterFirst.ring} unattributed ${beforeFirst.unattributed}→${afterFirst.unattributed}`]);

  // 第二阶段：12 上墙 / 100 工作区（overflow 88），默认上限外的会话事件仍按稳定 key 落位
  lanesPhase = 'overflow';
  const gotOverflow = await waitFor(() => d.wfs.length === 100, 4000);
  const s2 = d.particleStats();
  const labels2 = s2.laneLabels || [];
  const overflow = [
    ['12 上墙 / 88 overflow：工作区总数 100', gotOverflow && d.wfs.length === 100 && d.overflow === 88, `wfs=${d.wfs.length} overflow=${d.overflow}`],
    ['overflow 会话按稳定 key 进入合并泳道', laneOf('', 'ow50') === 3, `lane('',ow50)=${laneOf('', 'ow50')}`],
    ['overflow 的未知 workspace 仍是未归属', laneOf('', 'nope') === -1, `lane('',nope)=${laneOf('', 'nope')}`],
    ['未归属事件没有增加粒子/泳道',
      s2.unattributed >= 3 && s2.lanes.every(l => l >= 0 && l < 4),
      `unattributed=${s2.unattributed} lanes=${JSON.stringify(s2.lanes)}`],
    ['100 个工作区仍是 4 条泳道、最后一条合并',
      labels2.length === 4 && labels2[3] === 'W04+', JSON.stringify(labels2)],
    ['大样本仍是 live 数据、没有演示水印',
      text('mode') === '实时数据' && body.dataset.demo !== '1', `mode="${text('mode')}" data-demo=${body.dataset.demo}`],
  ];

  // 第三阶段：keyW02 从 state 消失，编号 02 被回收给 W01；旧事件回放不能串到 W01
  lanesPhase = 'removed';
  const gotRemoved = await waitFor(() => d.wfs.length === 5 && !d.wfs.some(w => w.key === 'keyW02'), 4000);
  const removedLane = laneOf('02', 'keyW02');
  const replayOld = storedOld();
  const replayLaneRemoved = replayOld ? laneOfEv(replayOld) : 'n/a';
  const beforeRemovedRecv = d.particleStats();
  d.onLiveEvent({seq: 902, verb: 'read', task_name: '回收后旧身份', kind: 'tool', agent: '02', workspace: 'keyW02'});
  const afterRemovedRecv = d.particleStats();
  const removed = [
    ['旧 key 消失后 state 只剩回收到的工作区', gotRemoved && d.wfs.length === 5, `wfs=${JSON.stringify(d.wfs.map(w => w.key))}`],
    ['旧 key 已移除且编号被回收：未归属，绝不回退编号',
      removedLane === -1 && laneOf('', 'keyW02') === -1 && laneOf('02', 'keyW01') === 0,
      `lane('02',keyW02)=${removedLane} lane('',keyW02)=${laneOf('', 'keyW02')} lane('02',keyW01)=${laneOf('02', 'keyW01')}`],
    ['旧协议缺字段时仍按当前编号（编号已被回收 → 当前工作区）',
      laneOf('02') === 0, `lane('02')=${laneOf('02')}`],
    ['空闲回放旧事件：稳定 key 已移除 → 未归属', !!replayOld && replayLaneRemoved === -1,
      `回放事件=${JSON.stringify(replayOld && {seq: replayOld.seq, ws: replayOld.workspace})} lane=${replayLaneRemoved}`],
    ['回收编号后的旧 key 事件首次接收也不进回放缓冲',
      afterRemovedRecv.ring === beforeRemovedRecv.ring && afterRemovedRecv.unattributed === beforeRemovedRecv.unattributed + 1,
      `ring ${beforeRemovedRecv.ring}→${afterRemovedRecv.ring} unattributed ${beforeRemovedRecv.unattributed}→${afterRemovedRecv.unattributed}`],
  ];

  // 第四阶段：工作区重新出现，编号仍是回收后的 W01；事件按 key 恢复归属
  lanesPhase = 'reappear';
  const gotReappear = await waitFor(() => d.wfs.length === 6 && d.wfs.some(w => w.key === 'keyW02'), 4000);
  const replayLaneBack = storedOld() ? laneOfEv(storedOld()) : 'n/a';
  const reappear = [
    ['工作区重新出现后稳定 key 恢复可用', gotReappear && d.wfs.length === 6, `wfs=${JSON.stringify(d.wfs.map(w => w.key))}`],
    ['重新出现仍按 key 归属，不因编号回收改成 W01',
      laneOf('02', 'keyW02') === 1 && laneOf('', 'keyW02') === 1,
      `lane('02',keyW02)=${laneOf('02', 'keyW02')} lane('',keyW02)=${laneOf('', 'keyW02')}`],
    ['无 workspace 的旧协议事件仍按当前编号', laneOf('02') === 0, `lane('02')=${laneOf('02')}`],
    ['回放缓冲里的旧事件重新可归属', !!storedOld() && replayLaneBack === 1,
      `lane=${replayLaneBack}`],
  ];
  return [...base, ...overflow, ...removed, ...reappear];
})() : await (async () => {
  // server.mjs 是演示后端：一旦后端补上 dataKind=demo，前端必须标成演示数据而不是实时数据
  const liveRaw = MODE === 'live'
    ? await rawGet('/api/agent-ops/state').then(r => JSON.parse(r.body)).catch(() => null)
    : null;
  const wantDemo = !!(liveRaw && liveRaw.dataKind === 'demo');
  const liveRawEventsRes = MODE === 'live'
    ? await rawGet('/api/agent-ops/events?after=0').catch(() => null) : null;
  const liveRawEvents = liveRawEventsRes && liveRawEventsRes.status === 200
    ? JSON.parse(liveRawEventsRes.body) : null;
  const liveChecks = [];
  if (MODE === 'live' && liveRaw) {
    const lwKeys = new Set((liveRaw.workflows || []).map(w => String(w.key)));
    const bl = liveRaw.eventBacklog || {};
    liveChecks.push(
      ['live mock 带 epoch/protocolVersion/revision/dataKind=demo',
        !!liveRaw.epoch && liveRaw.protocolVersion === 2 && Number.isInteger(liveRaw.revision)
          && liveRaw.dataKind === 'demo' && Number.isInteger(bl.oldest) && Number.isInteger(bl.newest),
        `epoch=${liveRaw.epoch} revision=${liveRaw.revision} backlog=${JSON.stringify(bl)}`],
      ['live mock 工作区 key 是 demo:Wxx，事件 workspace 同集合',
        lwKeys.size === 11 && [...lwKeys].every(k => /^demo:W\d\d$/.test(k))
          && Array.isArray(liveRawEvents) && liveRawEvents.length > 0
          && liveRawEvents.every(e => lwKeys.has(String(e.workspace)) && e.agent && e.src === 'mock'),
        `keys=${lwKeys.size} events=${liveRawEvents && liveRawEvents.length}`],
      ['live mock 旧数组事件从最早未读开始（不是末尾 40 条）',
        Array.isArray(liveRawEvents) && liveRawEvents.length > 0 && liveRawEvents.length <= 40
          /* 与同一响应的 backlog 头比较：起点必须等于该窗口最早序号 */
          && liveRawEvents[0].seq === Number(liveRawEventsRes.headers['x-agent-ops-backlog-oldest'])
          && liveRawEvents[liveRawEvents.length - 1].seq
            <= Number(liveRawEventsRes.headers['x-agent-ops-backlog-newest']),
        `first=${liveRawEvents && liveRawEvents[0] && liveRawEvents[0].seq} oldest=${liveRawEventsRes.headers['x-agent-ops-backlog-oldest']} newest=${liveRawEventsRes.headers['x-agent-ops-backlog-newest']} n=${liveRawEvents && liveRawEvents.length}`],
      ['live mock 开始/完成事件都有执行者与工作区',
        liveRawEvents.some(e => e.verb === 'read' || e.verb === 'build')
          && liveRawEvents.some(e => e.verb === 'check' || e.verb === 'review')
          && liveRawEvents.every(e => e.agent && e.workspace && e.ok === true),
        JSON.stringify((liveRawEvents || []).slice(0, 2))],
      ['live mock 响应头带 epoch/nextCursor/hasMore',
        liveRawEventsRes.headers['x-agent-ops-epoch'] === liveRaw.epoch
          && /^\d+$/.test(String(liveRawEventsRes.headers['x-agent-ops-next-cursor'] || ''))
          && /^[01]$/.test(String(liveRawEventsRes.headers['x-agent-ops-has-more'] || '')),
        JSON.stringify({epoch: liveRawEventsRes.headers['x-agent-ops-epoch'], more: liveRawEventsRes.headers['x-agent-ops-has-more']})],
      ['live mock 真实 tick 事件能被前端按 workspace 归属到泳道', (() => {
        const api = sandbox.window.__AGENT_OPS__;
        return !!api && typeof api.laneOfAgent === 'function' && Array.isArray(liveRawEvents)
          && liveRawEvents.some(e => api.laneOfAgent(e.agent, e.workspace) >= 0);
      })(), JSON.stringify((liveRawEvents || []).slice(0, 3).map(e => [e.agent, e.workspace]))],
    );
  }
  return [...liveChecks,
    [wantDemo ? '模式标成演示数据（接口 dataKind=demo）' : '模式切到实时数据',
      wantDemo ? /^演示数据/.test(text('mode')) : text('mode') === '实时数据',
      `mode = "${text('mode')}" dataKind=${liveRaw && liveRaw.dataKind}`],
    ['TASKS 指标被真实数据刷新', text('s0') === '64', `s0 = "${text('s0')}"`],
    ['WORKFLOWS 指标被真实数据刷新', text('s2') === '11', `s2 = "${text('s2')}"`],
    ['AGENTS 指标显示 "/ 12"', inner('s1').includes('/ 12'), `s1 = "${inner('s1')}"`],
    ['任务流面板有中文事件', /读取|生成|核验|复核/.test(inner('feed')), `feed 前 80 字 = ${inner('feed').slice(0, 80)}`],
    ['调度面板渲染 12 个智能体', liCount() === 12, `li 数 = ${liCount()}`],
    ['数据性质与后端标记一致', wantDemo ? body.dataset.demo === '1' : body.dataset.demo !== '1',
      `data-demo = ${body.dataset.demo}`],
    ['没有离线标记', !body.dataset.offline, `data-offline = ${body.dataset.offline}`],
    ['运行期没有 console.error', errors.length === 0, errors.slice(0, 3).join(' | ')],
  ];
})();

let bad = 0;
console.log(`MODE=${MODE}  ORIGIN=${ORIGIN}\n`);
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   → ' + detail}`);
  if (!ok) bad++;
}
console.log(`\n${checks.length - bad}/${checks.length} 通过`);
process.exit(bad ? 1 : 0);
