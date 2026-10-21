#!/usr/bin/env node
/**
 * 全模式测试入口（随仓库/核查包分发，不依赖 NEXT-TASKS.md 和正在运行的服务）。
 *
 *   node run-all-tests.mjs             # 跑全部 24 个模式
 *   node run-all-tests.mjs --list      # 只列模式
 *   node run-all-tests.mjs --fixture   # 只造隔离样本并打印路径（加 --keep 保留，手工验证用）
 *
 * 自带隔离数据：入口在系统临时目录创建 DSH 会话样本（普通 session.v4.jsonl，不需要 zstd），
 * 并把 DSH / Codex / Claude 三个源的路径以及 Codex 的两个 SQLite 路径全部显式指向
 * 临时目录或"不存在的文件"，因此不读取本机 ~/.dsh、~/.codex、~/.claude 的任何数据，
 * 清理后结果可复现。样本设计成同时满足 MODE=security/ring/dsh/recover/pop 的需求：
 *   - 2 个工作区，其中一个目录名超过标签截断长度（hubInfo 要求 name != full）
 *   - 用户消息 / 工具调用（成功 + 失败带原因）/ todo/write / assistant 消息 / turn、step
 *   - 一个会话保留未结束的调用（用于 agent 绑定当前任务、pop 等实时行为）
 *   - 一个会话正常结束回合但含失败调用与成功写文件（用于代码面板与失败统计）
 *
 * 自己起两个临时端口：
 *   - dsh-bridge.mjs  → 后端类模式（security / ring / dsh / recover / pop）
 *   - server.mjs      → live 模式用的假后端
 * demo 模式需要一个"连不上"的端口。
 * 结束后关闭子进程、等它们真正退出，并删除临时目录；任一模式失败、没有执行断言、
 * 或断言汇总解析不到时退出码为 1（零断言的跳过不算 PASS）。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

const LOCAL_MODES = ['core', 'dshsrc', 'codex', 'codexsql', 'claude', 'codes', 'cur',
  'particles', 'lanes', 'status', 'hubs', 'hubs6', 'evdown', 'evil', 'codexreg', 'gapinit', 'gaplive'];
const BACKEND_MODES = ['security', 'ring', 'dsh', 'recover', 'pop'];
const ALL_MODES = [...LOCAL_MODES, 'demo', ...BACKEND_MODES, 'live'];

if (process.argv.includes('--list')) {
  console.log(ALL_MODES.join('\n'));
  process.exit(0);
}

/* ---------------- 临时空闲端口 ---------------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function waitPort(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise(resolve => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
      sock.once('error', () => resolve(false));
      sock.setTimeout(500, () => { sock.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

/* 只确认「端口可连」不够：等到状态接口真的返回带 agents/workflows 的 JSON，
   避免把「已监听」当成「数据已就绪」（复核 v2.39 建议）。
   每次 fetch/读响应都在单请求超时内完成，避免单次请求挂住拖垮整体 15 秒期限。 */
async function waitHttp(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2500);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/agent-ops/state`, {
        headers: { Host: `127.0.0.1:${port}` }, signal: ac.signal,
      });
      if (res.ok) {
        const j = await res.json();
        if (j && Array.isArray(j.agents) && Array.isArray(j.workflows)) return true;
      }
    } catch { /* 未就绪或单请求超时，继续等 */ }
    finally { clearTimeout(timer); }
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

/* ---------------- 隔离样本（只在系统临时目录） ---------------- */

const WS_LONG = 'agent-ops-fixture-workspace-alpha-long-name';   // > 12 字符，标签会被截断
const WS_SHORT = 'ws-beta';

/** DSH 会话事件：每行一条 {type, seq, time, data}。 */
const rec = (type, seq, time, data) => JSON.stringify({ type, seq, time, data }) + '\n';

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-run-all-'));
  const dshRoot = join(root, 'dsh');
  const wsLong = join(dshRoot, WS_LONG);
  const wsShort = join(dshRoot, WS_SHORT);
  const alpha = join(wsLong, 'sess-alpha-01');
  const beta = join(wsShort, 'sess-beta-01');
  await mkdir(alpha, { recursive: true });
  await mkdir(beta, { recursive: true });
  // Codex / Claude 源指向空目录；Codex 的 SQLite 指向不存在的文件。
  const codexRoot = join(root, 'codex-empty');
  const claudeRoot = join(root, 'claude-empty');
  await mkdir(codexRoot, { recursive: true });
  await mkdir(claudeRoot, { recursive: true });

  const t0 = Date.now() - 90_000;   // 近 45 分钟窗口内，保证"活跃"

  // 会话 A（工作区长名、仍在跑）：用户消息、成功读取、todo、assistant、未结束的 bash 调用。
  // 未结束调用 → current/openStep 非空 → 前端智能体绑到当前任务（断言 /T-\d+ · /）。
  const alphaLines = [
    rec('session', 1, t0, { id: 'sess-alpha-01', cwd: wsLong, delegationDepth: 0, origin: 'user' }),
    rec('session/title', 2, t0 + 100, { title: '隔离样本 · 调度大屏渲染' }),
    rec('turn/start', 3, t0 + 200, { turn: 1 }),
    rec('step/start', 4, t0 + 300, { turn: 1, step: 1 }),
    rec('user/message', 5, t0 + 400, { source: { kind: 'user' }, content: [{ type: 'text', text: '复核调度大屏任务流与工作区归属' }] }),
    rec('tool/call', 6, t0 + 500, { callId: 'a-read', name: 'read', arguments: JSON.stringify({ file_path: 'index.html' }) }),
    rec('tool/result', 7, t0 + 900, { toolCallId: 'a-read', message: { isError: false, content: [{ type: 'text', text: '已读取 index.html' }] } }),
    rec('todo/write', 8, t0 + 1000, { todos: [
      { content: '复核任务流分组', status: 'in_progress' },
      { content: '生成隔离样本', status: 'completed' },
    ] }),
    rec('step/end', 9, t0 + 1100, { turn: 1, step: 1 }),
    rec('assistant/message', 10, t0 + 1200, { message: { content: [{ type: 'text', text: '开始核验渲染逻辑' }] } }),
    rec('turn/start', 11, t0 + 1300, { turn: 2 }),
    rec('step/start', 12, t0 + 1400, { turn: 2, step: 1 }),
    rec('tool/call', 13, t0 + 1500, { callId: 'a-check', name: 'bash', arguments: JSON.stringify({ command: 'node --check index.html' }) }),
  ];

  // 会话 B（工作区 B、回合已结束）：失败调用带工具名/原因、成功写文件（代码面板）、
  // todo、assistant、turn/end 收尾 → 不再算运行中，但任务/事件/失败统计都还在。
  const betaLines = [
    rec('session', 1, t0 + 2000, { id: 'sess-beta-01', cwd: wsShort, delegationDepth: 0, origin: 'user' }),
    rec('session/title', 2, t0 + 2100, { title: 'Codex 日志生命周期复核' }),
    rec('turn/start', 3, t0 + 2200, { turn: 1 }),
    rec('step/start', 4, t0 + 2300, { turn: 1, step: 1 }),
    rec('user/message', 5, t0 + 2400, { source: { kind: 'user' }, content: [{ type: 'text', text: '读取 Codex 失败文件，核验缓存与生命周期' }] }),
    rec('tool/call', 6, t0 + 2500, { callId: 'b-edit', name: 'edit', arguments: JSON.stringify({
      file_path: 'sources/codex.mjs',
      old_string: 'export const patched = false;',
      new_string: 'export const patched = true;\nexport function fixed(){\n  return 1;\n}\n',
    }) }),
    rec('tool/result', 7, t0 + 2600, { toolCallId: 'b-edit', message: {
      isError: true,
      content: [{ type: 'text', text: 'Process exited with code 7: EACCES: permission denied, open sources/codex.mjs' }],
    } }),
    rec('tool/call', 8, t0 + 2700, { callId: 'b-write', name: 'write', arguments: JSON.stringify({
      file_path: 'recovered/notes.mjs',
      content: 'export const recovered = true;\nexport function note(){\n  return "ok";\n}\n',
    }) }),
    rec('tool/result', 9, t0 + 2800, { toolCallId: 'b-write', message: { isError: false, content: [{ type: 'text', text: 'ok' }] } }),
    rec('todo/write', 10, t0 + 2900, { todos: [
      { content: '核验 Codex 失败文件', status: 'completed' },
      { content: '清理过期缓存', status: 'completed' },
    ] }),
    rec('step/end', 11, t0 + 3000, { turn: 1, step: 1 }),
    rec('assistant/message', 12, t0 + 3100, { message: { content: [{ type: 'text', text: 'Codex 失败文件核验完成' }] } }),
    rec('turn/end', 13, t0 + 3200, { turn: 1 }),
  ];

  await writeFile(join(alpha, 'session.v4.jsonl'), alphaLines.join(''), 'utf8');
  await writeFile(join(beta, 'session.v4.jsonl'), betaLines.join(''), 'utf8');

  return {
    root,
    dshRoot,
    codexRoot,
    claudeRoot,
    codexState: join(root, 'nonexistent-state_5.sqlite'),
    codexHistory: join(root, 'nonexistent-thread_history_1.sqlite'),
  };
}

/**
 * 默认回归固定的产品配置：显式覆盖所有影响行为的变量，父进程预置的非默认值
 * （DEBUG=1 / MAX_AGENTS=1 / ACTIVE_MIN=0.001 / ALLOW_ORIGIN=... 等）一律不继承。
 * 数据源路径在 isolationEnv 里单独指向临时 fixture。
 *
 * 清单来自 dsh-bridge.mjs / server.mjs / smoke-test.mjs 的 process.env 读取：
 * 新增行为配置时必须同步加到这里，否则又会随启动环境漂移。
 */
const FIXED_PRODUCT_ENV = {
  // dsh-bridge.mjs：窗口/容量/访问控制/默认源/开浏览器
  DEBUG: '0',
  MAX_AGENTS: '12',
  ACTIVE_MIN: '45',
  ALLOW_ORIGIN: '',
  TOKEN: '',
  SOURCE: 'dsh',
  OPEN: '0',
  // 端口从不继承：每个实例都由入口用临时端口显式传入（startServer / smoke-test 内部）。
  PORT: '',
  // smoke-test.mjs：变异验证用的静默开关，默认回归必须完整输出才解析得到汇总
  QUIET: '0',
  // server.mjs（live 模式的假后端）：EVIL=1 会故意返回坏数据
  EVIL: '0',
};

/**
 * 子进程环境：固定全部行为配置 + 显式覆盖全部数据源路径，绝不回落到本机 ~/.dsh 等默认值。
 * 只从 process.env 继承 PATH / SystemRoot 这类与行为无关的系统变量。
 * 这里返回的 env 会传给每个 smoke-test 子进程；smoke-test 内部再 spawn 的实例
 * （security 的带令牌实例、codes 的独立实例）用 {...process.env} 继承的正是这份固定环境。
 */
function isolationEnv(fx, testPortBase) {
  return {
    ...process.env,
    ...FIXED_PRODUCT_ENV,
    /* 每个模式进程内部的临时实例都从这个独立端口段里取端口，避免并发跑两套入口时互撞 */
    TEST_PORT_BASE: String(testPortBase),
    DSH_SESSIONS: fx.dshRoot,
    CODEX_SESSIONS: fx.codexRoot,
    CODEX_STATE_DB: fx.codexState,
    CODEX_HISTORY_DB: fx.codexHistory,
    CLAUDE_PROJECTS: fx.claudeRoot,
  };
}

async function removeFixture(root) {
  // Windows 上文件句柄偶尔晚一点释放：重试几次，避免留下临时垃圾。
  for (let i = 0; i < 5; i++) {
    try { await rm(root, { recursive: true, force: true }); return true; }
    catch { await new Promise(r => setTimeout(r, 200)); }
  }
  return false;
}

/* ---------------- 模式执行与汇总 ---------------- */

function runMode(mode, origin, env) {
  return new Promise(resolve => {
    const child = spawn(NODE, ['smoke-test.mjs'], {
      cwd: ROOT,
      env: { ...env, MODE: mode, ORIGIN: origin },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', c => { out += c; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', c => { out += c; });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 180_000);
    child.on('close', code => {
      clearTimeout(timer);
      const fails = out.match(/^FAIL\b.*$/gm) || [];
      // 只认最后一条 "N/M 通过"：M 为 0 或解析不到都算没有真正执行断言。
      const summary = [...out.matchAll(/^(\d+)\/(\d+) 通过$/gm)].pop();
      // 旧 Node 上 MODE=dshsrc 会打印"跳过"并 exit 0：显式标 SKIP，不能让零断言混成 PASS。
      const skipped = !summary && /跳过|需要 Node 23\.8/.test(out);
      const tail = out.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
      resolve({
        mode,
        code: code == null ? -1 : code,
        fails,
        skipped,
        tail,
        summary: summary ? `${summary[1]}/${summary[2]}` : '?',
        assertionPassed: summary ? Number(summary[1]) : 0,
        assertionTotal: summary ? Number(summary[2]) : 0,
      });
    });
  });
}

const servers = [];
function startServer(script, port, env) {
  const child = spawn(NODE, [script], {
    cwd: ROOT,
    env: { ...env, PORT: String(port), OPEN: '0', TOKEN: '', SOURCE: 'dsh' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  servers.push(child);
  return child;
}

/** 等子进程真正退出（kill 只是发信号，不等待会让临时目录删不掉）。 */
function waitExit(child, ms = 5000) {
  return new Promise(resolve => {
    if (child.exitCode != null || child.signalCode != null) return resolve(true);
    let settled = false;
    const done = ok => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      done(false);
    }, ms);
    child.once('exit', () => done(true));
    child.once('error', () => done(true));
  });
}

async function stopServers() {
  await Promise.all(servers.map(s => {
    try { s.kill(); } catch {}
    return waitExit(s);
  }));
}

/* ---------------- 手工验证辅助：只造样本 ---------------- */

if (process.argv.includes('--fixture')) {
  const fx = await makeFixture();
  console.log(JSON.stringify(fx, null, 2));
  if (process.argv.includes('--keep')) console.log('\n(--keep: 临时目录保留，验证完请手工删除)');
  else {
    const gone = await removeFixture(fx.root);
    if (!gone) console.log('临时目录删除失败：' + fx.root);
  }
  process.exit(0);
}

/* ---------------- 跑全部模式 ---------------- */

let fixture = null;
let fatal = null;
let cleanupError = '';
const results = [];
try {
  fixture = await makeFixture();
  const bridgePort = await freePort();
  const mockPort = await freePort();
  const deadPort = await freePort();   // 不监听：demo 需要"连不上"
  /* smoke-test 内部还会再起实例（令牌 / 工作区 / CORS / codes），给它们一个独立端口段。 */
  const testPortBase = await freePort();
  const env = isolationEnv(fixture, testPortBase);
  startServer('dsh-bridge.mjs', bridgePort, env);
  startServer('server.mjs', mockPort, env);
  const [bridgeOk, mockOk] = await Promise.all([waitHttp(bridgePort), waitHttp(mockPort)]);
  if (!bridgeOk || !mockOk) throw new Error(`临时服务未就绪（状态接口未返回预期数据）：bridge=${bridgeOk} mock=${mockOk}`);
  const bridgeOrigin = `http://127.0.0.1:${bridgePort}`;
  const mockOrigin = `http://127.0.0.1:${mockPort}`;
  const deadOrigin = `http://127.0.0.1:${deadPort}`;

  for (const mode of LOCAL_MODES) results.push(await runMode(mode, bridgeOrigin, env));
  results.push(await runMode('demo', deadOrigin, env));
  for (const mode of BACKEND_MODES) results.push(await runMode(mode, bridgeOrigin, env));
  results.push(await runMode('live', mockOrigin, env));
} catch (err) {
  fatal = err;
} finally {
  await stopServers();
  if (fixture) {
    const gone = await removeFixture(fixture.root);
    if (!gone) cleanupError = fixture.root;
  }
}

if (fatal) {
  console.error('测试入口启动失败：' + ((fatal && fatal.message) || fatal));
  if (cleanupError) console.error('临时目录删除失败：' + cleanupError);
  process.exit(1);
}
if (cleanupError) console.log('临时目录删除失败：' + cleanupError);

let bad = 0, skipped = 0, passedModes = 0, aPass = 0, aTotal = 0, unparsed = 0;
for (const r of results) {
  const hasSummary = r.assertionTotal > 0;
  let tag;
  if (r.skipped && !hasSummary) {
    tag = 'SKIP';
    skipped++;
  } else if (!hasSummary) {
    // 解析不到汇总，或汇总里 M=0：没有真正执行断言，不能算 PASS。
    tag = 'FAIL';
    bad++;
    unparsed++;
  } else if (r.code !== 0) {
    tag = 'FAIL';
    bad++;
  } else if (r.assertionPassed !== r.assertionTotal) {
    // 退出码 0 但有断言失败：说明冒烟脚本自己的退出码不可信，同样不能算过。
    tag = 'FAIL';
    bad++;
  } else {
    tag = 'PASS';
    passedModes++;
  }
  if (hasSummary) { aPass += r.assertionPassed; aTotal += r.assertionTotal; }
  const note = tag === 'SKIP' ? `   零断言：${r.tail || '该模式已跳过'}` : (tag === 'FAIL' && !hasSummary ? `   未解析到 "N/M 通过"${r.tail ? '：' + r.tail : ''}` : '');
  console.log(`${tag.padEnd(4)} ${r.mode.padEnd(10)} ${r.summary}${note}`);
  for (const f of r.fails) console.log('      ' + f);
}

const incomplete = skipped > 0 || unparsed > 0;
console.log(`\n${results.length} 个模式，${passedModes}/${results.length} 通过；断言 ${aPass}/${aTotal}`
  + (skipped ? `；SKIP ${skipped}` : '') + (unparsed ? `；未执行断言 ${unparsed}` : ''));
if (incomplete) {
  console.log('结果不完整：' + [
    skipped ? `${skipped} 个模式因环境跳过（旧 Node 的 dshsrc 会这样，须在 Node ≥ 23.8 上重跑）` : '',
    unparsed ? `${unparsed} 个模式没有解析到断言汇总` : '',
  ].filter(Boolean).join('；') + ' —— 不能算全部通过。');
}
if (results.length !== ALL_MODES.length) {
  console.log(`模式数不完整：只跑了 ${results.length}/${ALL_MODES.length} 个。`);
  bad++;
}
process.exitCode = (bad || skipped) ? 1 : 0;
