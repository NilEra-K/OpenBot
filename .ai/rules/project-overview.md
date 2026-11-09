# OpenBot 项目概述

## 项目定位

OpenBot 是**跑在用户自己电脑上的多 agent 社交控制台**：多个 AI agent 在本机沙箱（Box）里干活、互相协作、与用户对话；重活进沙箱，云依赖降到最低。

- **本地优先**：数据、执行、密钥全在本机；唯一联网需求是 LLM API（可中转/可本地模型）。
- **Windows 优先**：v1 只做 Windows（WSL2 + Docker 沙箱），Linux/macOS 后续。
- **净室自研**：Apache-2.0，架构借鉴公开资料但代码全部自实现，不参考 GPL 实现的代码结构。

## 核心概念（领域术语）

| 术语 | 含义 |
|---|---|
| **Box** | 本机沙箱执行单元（WSL2 / Docker / mock 实例），agent 的"工作电脑"。三态：active / sleeping / snapshot |
| **agent** | 一个常驻的对话/工作主体，有独立 transcript 目录。`role ∈ { steward, worker }`，默认 worker |
| **steward（管家）** | 同一名册内**全局唯一**的主角色：用户未指定收件人时消息默认路由给它；它的权力是**委派**（唤起/steer/派生/广播），不是特权（无权限提升、调度同优先级） |
| **一主多从** | 组织模型：委派与路由分层级，通信不分——worker 仍是全功能节点，群聊 leaderless |
| **turn / run** | 一次 agent 执行单元；三 lane 排他（`user > agent > background`），同一 agent 同时只有一个活跃 turn |
| **闸门（gate）** | 出 Box 的宿主操作（文件/网络）一律拦截审批；审批复用幂等账本 |
| **transcript** | 每 agent 一个目录的 JSONL 会话记录，append-only，是源头真相 |
| **环回网关** | 内核对壳暴露的唯一边界：`POST /api/*` + `GET /events`(SSE) + `WS /stream`，127.0.0.1 随机端口 + token |

## 仓库组成

```
OpenBot/
├─ packages/    八个内核包（见 project-architecture.md）
│   core / state / llm / boxes / messaging / runner / transport / coordinator
├─ apps/        三个壳
│   desktop（Electron，第一交付）/ cli（P1 冒烟）/ relay（P5 占位）
├─ prototype.html   视觉母版：五视图高保真原型（控制台/Box 操作台/排程/图谱/设置）
├─ ARCHITECTURE.md  架构单一事实源（v1.2）
├─ docs/        architecture / protocol / platforms（平台地雷）/ cleanroom
├─ PRODUCT.md · DESIGN.md · README.md
└─ tools/       gen-icon.mjs 等零依赖脚本
```

## 当前状态与路线（摘要）

- **P0 ✅**（v0.0.1）：八包骨架 + 类型占位 + 冒烟测试 + Electron 壳预览（frameless + 托盘 + 调试设施）。
- **P1（下一步）**：内核走通——mock llm + mock box 全链路（chat → A2A → box exec），apps/cli 冒烟含「管家 + 2 工人」示例名册。
- **P2**：desktop 渲染层 Vue 3 重建（对齐 prototype 五视图），接环回网关。
- **P3**：真实 WSL2/Docker 后端 + electron-builder 打包签名。
- **P4**：Linux/macOS 平台。
- **P5**：跨用户 relay（协议已预留）。

完整路线与验收标准见 ARCHITECTURE.md §11。

## 文档地图

| 想了解 | 去哪 |
|---|---|
| 架构、依赖规则、ADR | `ARCHITECTURE.md`（单一事实源） |
| 传输协议、事件族 | `ARCHITECTURE.md` §5 + `docs/protocol.md` |
| 平台差异与已知地雷 | `docs/platforms.md` |
| 净室纪律与借鉴映射 | `ARCHITECTURE.md` §12 + `docs/cleanroom.md` |
| 产品定位与设计语言 | `PRODUCT.md` / `DESIGN.md` |
| 视觉规范与五视图 | `prototype.html`（评审模式含共识点标注） |
