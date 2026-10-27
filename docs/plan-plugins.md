# 插件运行时设计方案（讨论定稿 · 待作者终审）

> **状态**：设计已讨论收敛，三处作者裁定已记（见 §2）；本文档为实施前的终审稿。
> **日期**：2026-10-20 · **关联**：[ARCHITECTURE.md](../ARCHITECTURE.md) §3.9（入档随 P1 实施）、v0.1.82 插件视图一期（安装态壳已落地）
> **净室说明**：MCP 为开放规范（Model Context Protocol），本方案只做协议客户端，不复刻任何 GPL 实现代码结构。

---

## 0. 背景与目标

v0.1.82 已交付插件视图一期（拼图入口、双 Tab、安装态管理）——但那只是**壳**：安装的插件没有任何执行能力。本方案定义**插件运行时**：第三方能力安全进入 OpenBot 的机制。

**首要目标**：给 Agent 扩**工具**（「小红书运营」要能真的发笔记、查数据后台）——用户的真实场景是运营型 Agent，插件是能力的载体。
**次要目标**：声明式包（prompt/工作流模板）。
**反目标（红线，写死）**：

- 插件不可写 transcript（append-only 由内核独占）；
- 不可绕过审批闸门；
- 不可发 UI 指令（「协议只传领域事实」铁律）；
- 不可提升权限（steward 不量等既有不变量不受插件影响）。

---

## 1. 形态裁定

| 形态 | 说明 | 裁定 |
|---|---|---|
| **A 进程内 JS 模块** | `import` 进内核进程 | **永久否决**——供应链风险直通内核、ESM/ABI 版本地狱、崩溃连带、API 面野蛮生长（违反净室与 KISS） |
| **B 协议进程（主形态）** | 独立子进程，stdio JSON-RPC（MCP）说话；可进 Box 跑 | ✅——对齐「重活进沙箱」哲学：语言无关、崩溃隔离（插件挂了内核无感） |
| **C 声明式包（辅形态）** | 纯数据（prompt 片段/工具 schema），无可执行代码 | ✅——覆盖轻需求，零执行风险（P3 再做） |

**架构依据**：B 即 DIP——内核只依赖「工具协议」抽象，不依赖任何插件实现。

---

## 2. 作者裁定记录（2026-10-20）

1. **协议 = MCP**：内核做 MCP **client**，插件 = MCP server + OpenBot manifest 包装。两层各司其职：MCP 管通信（工具声明/调用/通知），manifest 管声明（身份/权限/事件/Agent 绑定/生命周期）。不自造协议——MCP 生态现成 server 海量（浏览器/文件/数据库/社媒），包一层 manifest 即成 OpenBot 插件；插件作者写一次处处能跑（兼容一切 MCP 客户端）。
2. **P1 含上行事件**（作者原话「P1 可以含上行事件」）：插件→内核事件通道与 tools 同期交付——「屏幕变化立即通知」类监控插件是已确认的真实场景。
3. **UI 扩展不进 roadmap**：插件只做能力不做界面；通知走系统通知/toast。

---

## 3. 开发者契约（统一协议的用户面）

插件 = **两个文件，任何语言**：

```
my-plugin/
├─ manifest.json   ← OpenBot 声明面
└─ server.py       ← 任意语言（Python/Node/Go/Rust…）的 MCP server（stdio）
```

```json
{
  "manifestVersion": 1,
  "id": "com.you.screen-watch",
  "name": "屏幕监控",
  "version": "0.1.0",
  "description": "监控屏幕区域变化，变化立即通知",
  "entry": { "command": "python", "args": ["server.py"] },
  "permissions": ["screen.read"],
  "tools": true,
  "events": [{ "type": "screen.changed" }],
  "agents": ["小红书运营"]
}
```

- `server.py` 只需说 MCP（stdio JSON-RPC）：声明工具（`tools/list`）、响应调用（`tools/call`）、发上行通知（notification）。
- manifest 各字段：`entry` 拉起命令；`permissions` 权限声明（`net`/`fs`/`box`/`screen.read`…）；`events` 本插件会发的事件类型；`agents` 事件唤醒的绑定 Agent（显示名，缺席=只通知用户）。
- **版本演进**：`manifestVersion` + 读取端兼容（项目持久化铁律同款）。
- **开发门槛**：会写任意语言的标准 MCP server + 填一个 JSON。P1 的官方示例插件即「最小可抄模板」（单文件、注释齐全）；脚手架 `openbot plugin init` 记 backlog。
- **Python 模板已实证（2026-10-27 v0.1.92）**：官方示例 `openbot.hello-python`（resources/plugins）——零依赖纯标准库单文件；Windows 裸命令 `python` 经 where 解析拉起（P2④ 落地面）；两个管道坑记档：stdout 须 `reconfigure(line_buffering=True)`（缺省全缓冲对端收不到行级应答）、管道编码缺省随 locale（中文 Windows 是 GBK）——中文 JSON 必须显式 UTF-8 `reconfigure(encoding='utf-8')`。单测引用**真实随包模板**验握手（非副本），E2E 全链（安装→运行→工具调用→上行事件）已过。

---

## 4. 能力面（P1 = tools + 上行事件）

### 4.1 tools（拉模型）

- manifest 声明的 MCP tools 经装配门注册进既有 `ToolRegistry`——Agent 的 LLM 工具面自动多出插件工具；
- **走既有审批闸门**（复用不新造）：宿主资源访问（net/fs/screen）过审批弹窗；插件进程若跑在 Box 内则 Box 内自由（与 exec 同级语义）；
- 长时工具（如 `screen_wait_change(region?, timeout)`）原生支持——MCP 有进度上报机制，Agent 调用挂起等待即可。

### 4.2 上行事件（推模型）——「变化立即通知」

```
插件进程检测到事实（屏幕区域 X 变了）
  → stdio JSON-RPC notification 上行
  → 内核发 v1.plugin.event { pluginId, type, payload }（稳定 code、领域事实）
  → 路由（按 manifest）：
      ├→ 通知用户：toast / 系统通知
      └→ 唤醒 Agent：按 agents 绑定走既有消息受理通道（幂等账本复用，防事件风暴双驱）
```

### 4.3 权限分级（ISP：细粒度最小面）

| 权限 | 语义 | 闸门 |
|---|---|---|
| `net` | 出网访问 | 过审批 |
| `fs.host` | 宿主文件 | 过审批 |
| `screen.read` | 屏幕快照 | 过审批 |
| `box` | 在 Box 内执行 | Box 内自由（与 exec 同级） |

---

## 5. 进程管理

- **懒启动**：首次工具调用 / 启用时才拉起进程；
- **空闲回收**：idle 超时（可配，缺省 5 分钟）优雅退出；
- **崩溃恢复**：限次重启（缺省 3 次/小时），超限标记插件故障态（UI 如实呈现）——**插件挂了内核无感**；
- **宿主位置**：一期宿主子进程（stdio）；二期可选「进 Box 跑」（载体已齐，更强隔离）。

---

## 6. 分发与安装（本地优先）

- **市场 = 静态索引**：URL 指向 JSON 清单文件（默认内置官方索引；任何人静态托管——GitHub Pages 即可——就能发插件）。**不建后端服务、无账号体系**（OpenBot 是纯客户端/本地优先架构，插件体系延续此底色：分发是文件级的事，不是平台级的事）；
- **安装**：下载解包到 `userData/plugins/<id>/` + manifest 校验；现有 `installedPlugins` 台账（settings.json，v0.1.82）直接续用为安装事实；
- **启停/卸载**：复用 v0.1.82 命令面（`v1.plugins.setEnabled/uninstall`）+ 运行态扩展；
- hash/签名校验记 P2（本地优先威胁模型下非第一天的事，记档不遗忘）。

---

## 7. 示例场景对账（作者提出的真实用例）

**「监控 GUI 屏幕变化、变了立即通知」**：

- ① Agent 等变化（拉）→ `screen_wait_change` 工具（P1 tools 面）；
- ② 无人等时主动通知（推）→ 上行事件（P1 已裁定含）→ 通知用户 / 唤醒绑定 Agent；
- 权限 `screen.read`；插件进程常驻 diff（复用 OpenBot 宿主屏快照能力或自带）；
- 佐证：不用插件可拼粗糙版（Box watch 脚本 + automations 定时扫），但「立即」（秒级事件驱动）做不到——插件运行时的存在价值。

---

## 8. CS 架构演进兼容性（记档）

OpenBot 当前是纯本地单机架构（transport 是进程间边界的实现方式，非网络服务）。本方案**不堵死任何演进路径**：

- 本地优先 + 同步层（Obsidian Sync 模式） / 混合（云端只做协调分发——市场静态索引天然此形态） / 内核上云——MCP 插件跟本地内核走，前两者零改动；内核上云需服务器侧插件宿主（届时另议）。
- 现在不为 CS 预建任何东西（YAGNI）：多用户/租户/并发控制在无真实需求前是负资产。

---

## 9. P1 实施清单

- [ ] 1. ARCHITECTURE.md §3.9 插件运行时入档（本方案精要）+ CLAUDE.md 引用同步
- [ ] 2. manifest 规范与加载：目录扫描、schema 校验（zod）、`v1.plugins.*` 扩展（install 从本地目录、运行态查询）
- [ ] 3. MCP client（stdio）：进程拉起/懒启动/空闲回收/崩溃限次重启；initialize 握手、tools/list、tools/call 转发（coordinator 服务模块——与 shell-service/gui-stream 同居）
- [ ] 4. 工具桥接：MCP tools → ToolRegistry 注册（经装配门）；权限映射既有闸门
- [ ] 5. 上行事件路由：notification → `v1.plugin.event` → 用户通知 / 唤醒绑定 Agent（既有消息通道与幂等账本）；renderer 插件视图补运行状态与事件呈现
- [ ] 6. 官方示例插件（最小可抄模板：echo 工具 + 定时事件，单文件注释齐全）+ 市场 UI 接真实安装流
- [ ] 7. 测试：MockMcpServer 桩（mock 对称铁律）+ 单测（握手/工具桥/事件路由/崩溃恢复）+ E2E（装示例插件 → Agent 调工具 → 事件上行通知全链）
- [ ] 8. typecheck + 全量回归 + 真机目验

**P2（2026-10-20 实施完成，③推迟——作者裁定远端索引待 v0.2.0 后）**：
- ✅ 权限审批整合：审批弹窗呈现插件身份 + manifest 权限 chips；插件工具批准后**会话内同工具不再询问**（渲染层记忆自动放行——内核账本照落，审计不缺）；installedPlugins 台账落 permissions。
- ✅ hooks：manifest 声明 `hooks: [{event}]`（白名单 v1.message.agent / v1.lifecycle.finished）→ `openbot/hook` notification 下行；hooks/事件源插件均常驻。
- ✅ Windows 非 node 命令 PATH 解析（where 式解析 + 缓存）。
- ⏸ 远端市场索引 + hash 校验（作者裁定 2026-10-20：v0.2.0 之后）。
**P3（记档）**：声明式技能包、`openbot plugin init` 脚手架、插件进 Box 跑。

---

## 10. 一票否决自检（资深架构师视角）

| 铁律 | 自检 |
|---|---|
| 依赖方向 | 插件加载/装配归 coordinator（装配根）✓；MCP client 是 coordinator 服务模块 ✓ |
| 协议纯度 | manifest/事件全稳定 code；`v1.plugin.event` 领域事实 ✅ |
| append-only | 插件对 transcript 只读（红线 §0）✓ |
| UI/逻辑解耦 | 插件无 UI 指令面；通知走事件由 renderer 呈现 ✓ |
| mock 对称 | MockMcpServer 测试桩入 P1 清单 ✓ |
| 净室 | MCP 开放规范、零 GPL 参考实现 ✅ |
| KISS/YAGNI | 单进程形态否决、协议不自造、CS 不预建 ✓ |
