# Agent Ops · 调度大屏

把本机正在跑的 AI 智能体会话，画成一块**能用来判断问题**的调度大屏。

哪一个工作区在忙、哪里刚失败、哪个卡了 15 分钟没动静——不用翻日志，抬眼就能看到。

![纸面主题](docs/screenshot-light.png)

![夜间主题](docs/screenshot-dark.png)

> 两套主题，右上角一键切换（默认跟随系统深浅色）。
> 截图里的每一个数字、每一行代码、每一条谱线都来自真实的会话日志，没有任何随机假动画。

---

## 1. 这是一个什么项目

一个**纯前端 + 一个本地 Node 服务**的可视化大屏，不依赖框架、不需要构建：

- `index.html` 一个文件装下全部界面和动画（HTML + CSS + Canvas）
- `dsh-bridge.mjs` 一个只读的本地服务，把磁盘上的 agent 会话日志整理成接口
- 浏览器访问 `http://127.0.0.1:8778` 就能看

它想回答三个问题，而不是"看起来很酷"：

| 问题 | 在屏幕上的位置 |
|---|---|
| **哪个工作区正在忙？** | 右下角工作区状态表的「忙 N」，以及粒子面板里对应泳道的粒子密度 |
| **哪里失败了？** | 状态表里标红的工作区 + `↳ 工具 · 错误原因`，任务流里带 `✕` 的红色行 |
| **多久没有进展？** | 状态表里的「多久前」；超过 5 分钟没活动直接标成**停滞** |

同时区分三种运行状态：`实时数据`（绿）/ `演示数据`（黄，没连上数据源）/ `数据中断 Ns`（红，连过又断了）；
空闲回放时顶栏会多一个 `回放中` 标签。

---

## 2. 各个部分的介绍

![底部面板](docs/screenshot-panels.png)

### 顶部指标

| 区域 | 是什么 |
|---|---|
| TASKS / AGENTS / WORKFLOWS | 任务总数、在跑智能体数 / 上限、工作区数 |
| OUTPUTS / MATCHED / PENDING | 产出数、质检分达标的任务数、待复核数 |

### 左侧：工作流与智能体

| 区域 | 是什么 |
|---|---|
| 3 个工作流节点 | 一个工作区一个节点：工作区名 + 无报错率 + 该区智能体数 |
| 智能体节点 + 连线 | 一个会话一个点；`Lead → 子智能体` 的边来自会话里真实的父子关系 |
| 点击节点 | 弹出该智能体的详情（来源、工作目录、最近调用） |

### 中间：数据飞轮

| 区域 | 是什么 |
|---|---|
| 旋转环带 · 代码块 | 真实被写进文件的代码，表头就是文件名 |
| 旋转环带 · 表格块 | 真实工具调用的耗时，失败标 `chk` |
| 旋转环带 · 标签块 | 真实工作区名 |
| 外射谱线 | 每条 = 一个真实事件，长度 = 它与上一条之间的间隔 |
| 外圈字节标签 | 工具调用入参的真实字节数 |
| 扫光 / 齿环转速 | 每来一批新事件扫一次；转速 = 真实事件速率 |

### 底部：四个面板

| 面板 | 是什么 |
|---|---|
| **TASK FEED · 任务流** | 真实对话 + 工具调用，按会话分组，鼠标滚轮可往上翻历史；失败行带 `✕` 并标红 |
| **ADVECTION / PARTICLE SOLVER · 粒子回答** | **一个粒子 = 一条真实事件**；见下文 |
| **WORKSPACE · 执行代码** | 最近被写入的代码，带文件名和行号 |
| **DISPATCH · 调度** | 当前在跑的智能体，以及它此刻的任务 |

### 粒子面板怎么读

| 现象 | 含义 |
|---|---|
| 粒子从左往右游 | 工具调用正常推进（左 = 任务，右 = 产出） |
| 每条泳道标 `W01`/`W02`… | 一个工作区一条泳道；超过 4 个工作区时最后一条标 `W04+`，表示合并泳道 |
| 某一列在打转 | **同一个智能体的连续调用**——它在这个位置反复做事，形成漩涡 |
| 粒子往左倒流 | **这条调用失败了**（`ok:false`），反向回流 |
| 密度 | 该工作区的事件量；哪条流密，就是哪里在忙 |
| 右上角「回放 · 最近 N 条」 | 超过 3 秒没有新事件，就循环回放最近 200 条真实事件 |

> 粒子的**生成时机、泳道、流向、颜色、粗细、密度**全部来自真实事件；
> 唯一的视觉修饰是泳道内的轻微上下摆动和鼠标点击产生的涡流，它们不改变"往右流"这个主方向。

### 右下角：工作区状态

```
WORKFLOW / REVIEW STATE 工作区状态
W01  agent-displ…   忙 1 · 失败 25 · 5s 前
                    ↳ edit · Error: cannot edit "..."
W03  stall-wf       停滞 15m
```

- **忙 N**：该工作区里正在跑的会话数
- **失败 N**：累计失败调用数；10 分钟内有失败会标红，并显示最近一次的 `工具 · 错误原因`
- **多久前**：距最后一次活动的时间；超过 5 分钟判为**停滞**（即使还挂着未完成调用也不会显示成忙）

---

## 3. 接入了什么数据

从**本机磁盘上真实的 agent 会话日志**里读，不联网、不上传、不改原文件：

| 数据源 | 读取位置 | 说明 |
|---|---|---|
| **DSH**（DeepSeek Harness） | `~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd` | zstd 压缩，需要 Node 23.8+ |
| **Codex**（OpenAI Codex CLI / Desktop） | `~/.codex/sessions/**`、`~/.codex/archived_sessions/**` | Node 18+ |
| **Claude Code** | `~/.claude/projects/<工作区>/<sessionId>.jsonl` | Node 18+ |

从日志里解析出来的东西：

- **会话**：工作目录、开始时间、父会话（`Lead → 子智能体` 的层级）
- **工具调用**：工具名、入参、耗时、成功 / 失败、失败原因
- **对话**：用户消息、助手回复
- **写入的代码**：`write` / `edit` 类调用实际写进文件的内容
- **事件流**：每来一条新事件就推给前端，用来驱动环带、谱线和粒子

支持同时装多个源，右上角下拉切换，也可以 `?source=all` 合并上墙。

**一个源都没装也能看**：页面会自动进入演示模式（内置假数据 + 水印），用来先看效果。

---

## 4. 使用说明

### 4.1 装 Node.js

从 <https://nodejs.org> 装 **Node 18 或更高**。

> DSH 的会话是 zstd 压缩的，需要 **Node 23.8+**；
> 版本不够时 DSH 那个源会显示成不可用，另外两个照常工作。

### 4.2 拿到代码

```bash
git clone <仓库地址>
cd agent-display
```

或者直接下载 ZIP 解压。

### 4.3 启动

**Windows**：双击 `start.cmd`，它会起服务并自动打开浏览器。

**macOS / Linux**（或想手动控制）：

```bash
node dsh-bridge.mjs
```

然后打开 <http://127.0.0.1:8778>。

> ⚠️ **不要直接双击 `index.html`。**
> 浏览器在 `file://` 下禁止读取本地数据，双击只会看到一张提示卡片（卡片上有启动说明）。
> 必须通过本地服务打开。

### 4.4 停止

关掉那个黑窗口，或者双击 `stop.cmd`。

### 4.5 页面操作

| 操作 | 效果 |
|---|---|
| 右上角下拉框 | 切换数据源 |
| 右上角 `夜间` / `纸面` | 切换主题 |
| 右上角 `暂停` | 冻结画面（动画和刷新都停，方便截图） |
| 鼠标悬停 | 智能体节点 / 环带块 / 谱线的详情 |
| 在粒子面板上点击 | 在点击处加一个涡流（纯视觉） |
| 滚轮停在任务流上 | 往上翻历史，翻到顶可以继续拉取更早的记录 |

---

## 5. 用户自己切换数据源

### 5.1 三种切换方式

- **右上角下拉框**：会显示每个源有多少会话，例如 `Codex (3)`
- **URL 参数**：`?source=codex`、`?source=claude`、`?source=dsh`、`?source=all`
- **默认源**：`SOURCE=codex node dsh-bridge.mjs`

`?source=all` 会把三家合并上墙，智能体状态行前面带来源角标：`D·` / `C·` / `X·`。

### 5.2 指定读取位置

路径都能用环境变量覆盖（`~` 会展开成用户目录；`CODEX_SESSIONS` 支持多个目录，用系统分隔符隔开）：

| 变量 | 默认 | 多目录 |
|---|---|---|
| `DSH_SESSIONS` | `~/.dsh/sessions` | — |
| `CODEX_SESSIONS` | `~/.codex/sessions` + `~/.codex/archived_sessions` | ✅ `;` 分隔 |
| `CLAUDE_PROJECTS` | `~/.claude/projects` | — |

```bash
# 例：指向 D 盘上的备份，不动原来的日志
CODEX_SESSIONS='D:\backup\codex\sessions;D:\backup\codex\archived_sessions' \
DSH_SESSIONS='D:\backup\dsh\sessions' \
node dsh-bridge.mjs
```

启动日志会逐个列出每个源**实际读的路径**；一旦用了环境变量，还会多打一行
`路径由环境变量覆盖: ...`。

### 5.3 其它启动参数

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `8778` | 监听端口 |
| `ACTIVE_MIN` | `45` | 多少分钟内活动过的会话还留在墙上 |
| `MAX_AGENTS` | `12` | 一屏最多放几个智能体，多出来的显示成 `+N` |
| `SOURCE` | 自动 | 默认数据源 |
| `OPEN` | 关 | `OPEN=1` 时等服务就绪再自动打开浏览器（`start.cmd` 用的就是它） |
| `TOKEN` | 关 | 给 `/api/*` 和首页加访问令牌 |
| `ALLOW_ORIGIN` | 关 | 允许跨域读取的来源，逗号分隔。默认一个都不允许 |
| `DEBUG` | 关 | `DEBUG=1` 才开 `/api/agent-ops/debug`（会返回绝对路径） |

```bash
ACTIVE_MIN=900 MAX_AGENTS=8 node dsh-bridge.mjs   # 15 小时内的会话、一屏 8 个
```

---

## 6. 隐私与安全

设计前提：**这是给本机看的东西**。

- **只读**：只读取上面那三个目录里的日志，不写、不改、不删。
- **只监听本机**：绑在 `127.0.0.1`，外网连不上。
- **不返回 CORS 头**：默认任何网站都读不到这里的接口数据。只有用 `ALLOW_ORIGIN` 显式放行时才会回 CORS 头。
- **挡 DNS rebinding**：校验 `Host` 必须是本机回环，外部域名解析到 127.0.0.1 也读不到。
- **调试接口默认关闭**：`/api/agent-ops/debug` 平时返回 404；普通接口不返回绝对路径（代码片段只给文件名）。
- **令牌保护首页**：设了 `TOKEN` 之后，连首页本身都要令牌才能打开，不会出现"先拿页面再从 HTML 里抠出令牌"的绕过。
- **不联网**：不向外发送任何数据。页面唯一的外部请求是 Google Fonts（加载失败自动回退系统字体，不影响功能）。
- **不上传**：没有任何遥测。

> 如果你要把服务暴露到本机之外（端口转发、局域网共享），务必先设 `TOKEN`，
> 然后用 `http://127.0.0.1:8778/?token=<令牌>` 打开。

---

## 7. 自定义

### 7.1 改配置

所有可改的内容集中在 `index.html` 里 `<script>` 最前面的 `CONFIG`：

```js
const CONFIG = {
  matchThreshold: 0.8,     // 质检分 ≥ 该值算「已匹配」
  agents: [...],           // 演示模式下的智能体名
  taskNames: [...],        // 演示模式下的任务名
  workflows: [...],        // 演示模式下的工作流名
  codeSets: [...],         // 演示模式下的示例代码
};
```

> 接上真实数据后这些只在"演示模式"里生效——真实的智能体名、任务名、工作区名都来自日志本身。

### 7.2 改配色 / 节奏

- 配色：`<style>` 顶部的 CSS 变量，`:root`（纸面）、`[data-theme="dark"]`（夜间）
- 飞轮转速：`SPIN`（弧度/秒，默认 `0.16`）
- 刷新间隔：`CONFIG.pollMs`（默认 `1000`）
- 锁主题（看板场景推荐）：`?theme=dark` / `?theme=light`

### 7.3 加一个新数据源

在 `sources/` 下写一个 `create({ activeMs, live })`，返回：

```js
export function create({ activeMs, live }) {
  return {
    id: 'mysource', name: 'My Source', note: '...', path: '/where',
    scan,            // async，读磁盘、更新内部缓存；新事件用 live.push() 送进任务流
    sessions,        // () => 折叠好的会话数组（形状见 sources/dsh.mjs 顶部注释）
    available,       // () => boolean
    stats,           // () => ({ sessions, active, files })
  };
}
```

然后在 `dsh-bridge.mjs` 的 `entries` 里注册一行。前端下拉是从 `/api/agent-ops/state` 的
`sourceList` 自动生成的，**不用改前端**。

### 7.4 自己实现后端

只要满足这三组接口：

```
GET /api/agent-ops/state?source=<id>
GET /api/agent-ops/events?source=<id>&after=<seq>
GET /api/sources
```

返回结构直接看 `lib/core.mjs` 里 `buildState()` 的返回值和 `dsh-bridge.mjs` 的路由。

---

## 8. 目录结构

```
agent-display/
├── index.html          # 全部前端（HTML + CSS + Canvas 动画，单文件）
├── dsh-bridge.mjs      # 本地服务：入口 / HTTP / 安全校验 / 源路由
├── lib/
│   └── core.mjs        # 与数据源无关：工具函数、事件流、编号、聚合
├── sources/
│   ├── dsh.mjs         # DeepSeek Harness（zstd 会话）
│   ├── codex.mjs       # OpenAI Codex
│   └── claude.mjs      # Claude Code
├── server.mjs          # 零依赖假后端，纯前端调试用
├── smoke-test.mjs      # 冒烟测试（17 个模式，不需要浏览器）
├── start.cmd           # Windows 双击启动
├── stop.cmd            # Windows 双击停止
├── docs/               # 截图
├── CHANGELOG.md        # 逐版本改动记录
├── README.md
└── LICENSE             # MIT
```

仓库里只有源码、截图和文档；`node_modules/`、日志、本地临时截图都不会被提交。

---

## 9. 可能遇到的问题

**双击 `index.html` 只看到一张提示卡片？**

浏览器在 `file://` 下禁止读本地数据。用 `start.cmd` 或 `node dsh-bridge.mjs` 起服务，
然后访问 <http://127.0.0.1:8778>。

**页面上全是假数据、还有水印？**

说明没连上数据源。看启动日志里那一排 `✓ / · / ✗`，确认对应目录存在、里面有会话文件。

**某个源显示 0 个会话？**

默认只统计 **45 分钟内**活动过的会话。用 `ACTIVE_MIN=900` 放宽；
启动时每个源都会预热最近几个会话，所以一般不会完全空白。

**端口被占用？**

`PORT=8779 node dsh-bridge.mjs`，或者双击 `stop.cmd` 先停掉旧的。
`start.cmd` 检测到端口被占时会问你要不要接管。

**DSH 源显示不可用？**

DSH 的会话是 zstd 压缩的，需要 Node 23.8+。`node -v` 看一下版本；Codex / Claude 不受影响。

**粒子不动 / 面板是空的？**

- 面板右上角写「回放 · 最近 N 条」说明在空闲回放，正常现象
- 写「无事件」说明当前数据源一条事件都没有，切到有会话的源试试
- 顶栏是黄色 `演示数据` 说明根本没连上后端

**想先看效果，但一个 agent 都没装？**

```bash
node server.mjs        # 假后端，自带演示数据
# 打开 http://127.0.0.1:8777
```

**页面打开是空白的？**

确认地址栏端口和启动日志一致（默认 `8778`，假后端是 `8777`）；
浏览器控制台如果有报错，多半是 `index.html` 被改动后语法错误，先跑一遍 `MODE=core node smoke-test.mjs`。

---

## 10. 开发

### 10.1 冒烟测试

改完先跑测试，比开浏览器快。共 **17 个模式、127 项断言**：

```bash
# 不需要后端（合成数据）
MODE=dshsrc    node smoke-test.mjs      # DSH 合成会话（zstd）：失败事件的工具名
MODE=codex     node smoke-test.mjs      # Codex：坏行容错、退出码、失败原因
MODE=claude    node smoke-test.mjs      # Claude：消息形态、回合结束、失败原因
MODE=core      node smoke-test.mjs      # 聚合层：编号、事件分页、任务上限、工作区状态
MODE=codes     node smoke-test.mjs      # 多视图编号隔离（自己起临时实例）
MODE=cur       node smoke-test.mjs      # 乱序 run 任务不覆盖当前任务
MODE=particles node smoke-test.mjs      # 粒子：一事件一粒子、三种流向、重启与缩放回归
MODE=lanes     node smoke-test.mjs      # 6 个工作区 → 4 条泳道，合并泳道标 W04+
MODE=status    node smoke-test.mjs      # 工作区状态：忙 / 失败 / 停滞

# 需要后端在跑（ORIGIN=http://127.0.0.1:8778）
MODE=security  ORIGIN=... node smoke-test.mjs   # CORS / Host / 令牌 / 畸形 URL
MODE=ring      ORIGIN=... node smoke-test.mjs   # 环带内容签名
MODE=dsh       ORIGIN=... node smoke-test.mjs   # 真实数据上墙 + 工作区归属 + 当前任务
MODE=recover   ORIGIN=... node smoke-test.mjs   # 第一次拉取失败后能否自愈
MODE=pop       ORIGIN=... node smoke-test.mjs   # 新会话登场动画
MODE=evil      ORIGIN=... node smoke-test.mjs   # 注入 HTML 的转义

# 需要假后端：先 node server.mjs
MODE=demo  ORIGIN=http://127.0.0.1:8799 node smoke-test.mjs   # 拉不到接口时降级
MODE=live  ORIGIN=http://127.0.0.1:8777 node smoke-test.mjs   # 假后端数据渲染
```

`smoke-test.mjs` 用一个最小 DOM 垫片把 `index.html` 的脚本真跑一遍，因此能测到渲染逻辑，
不需要浏览器。

### 10.2 调试钩子

页面里留了一个只读调试钩子 `window.__AGENT_OPS__`（任务、智能体、工作区、粒子统计、环带签名），
测试和现场排查都能用，不影响渲染。控制台直接 `__AGENT_OPS__.particleStats()` 可以看粒子状态。

### 10.3 写测试的约定

这个项目里，"测试通过"的含义是**把修复改回去，这条断言必须红**。
新增断言时先做一次变异验证（故意改坏，确认失败），再提交。

### 10.4 改完提交前

```bash
MODE=core node smoke-test.mjs        # 至少跑一下不依赖后端的模式
git status --short                   # 确认没有把临时文件带进去
```

---

## 11. 致谢

本项目**由 [cyberdaddyleo/agent-display](https://github.com/cyberdaddyleo/agent-display) 的演示页面修改到连接真实数据**：
保留原来的视觉设计与动画，把原来内置的示例数据换成了本机真实的 agent 会话。

在此基础上新增的部分：

- 多数据源适配（DSH / Codex / Claude Code），右上角可切换
- 飞轮上的每一处文字和动画改成由真实事件驱动（环带、谱线、扫光、齿环、粒子）
- 粒子面板：一事件一粒子、三种流向（顺流 / 漩涡 / 回流）
- 工作区状态表：忙 / 失败 / 停滞，失败显示工具与原因
- 任务流按会话分组、可滚动翻历史
- 启动 / 停止脚本、演示后端、冒烟测试

视觉风格的灵感来自网上流传的 Claude Code「Paper Lab」演示视频（纸面工程图 / 夜间荧光两种风格）。

详细改动见 [CHANGELOG](CHANGELOG.md)。

---

## 12. 许可证

[MIT](LICENSE)
