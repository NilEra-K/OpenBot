# OpenBot — 产品上下文

## Register

product（应用 UI：设计服务于产品，用户带着任务而来）

## 产品定位

不依赖云电脑的 GrokBot。原版桌面 agent 平台把重活丢给云端 VM（CloudAgentBridge → 云电脑）执行；
OpenBot 把这一层换成本机沙箱（"本机 Box"）：agent 群在本机沙箱里干活，云依赖降到最低（仅保留 LLM API）。

一句话：**跑在你自己电脑上的多 agent 社交控制台，重活进本机沙箱，好友可跨公网进房间协作。**

## 用户

- 中国开发者 / 高级玩家，Windows 11 桌面环境，常年挂着一个"agent 工作台"
- 熟悉 Discord/Slack 式多频道界面，也熟悉 VS Code 式工具面板；对 Claude Code / 云 agent 的体验有认知
- 痛点：云电脑按小时计费、排队、数据出境、断网即瘫痪

## 产品形态（已与作者对齐，2026-08）

1. **执行层**：本地沙箱（本机云电脑）。WSL2 / Docker / Windows Sandbox 等模板，持久 Box（forever-box），
   快照、磁盘压力治理。agent 的重任务（构建、改项目、跑脚本）全部在 Box 内执行。
2. **交互主轴**：多 agent 社交控制台。左侧 agent 名册 + 群组，右侧对话与任务混合流；
   A2A 私聊、群聊轮转、@提及、广播在同一个信息流里可见。执行卡片内嵌在流中。
3. **载体**：桌面应用（Electron/Tauri 壳）。架构已解耦（packages 只走 HTTP/SSE），原型按桌面 App 视觉标准绘制。
   托盘常驻。
4. **范围**：保留公网跨用户房间（hosted/mirror、turn-request/result、10 分钟 30 turn 预算、nonce 幂等）。
   云 agent 桥保留协议但默认不用（可后续接入第三方云作为弹性补充）。

## 功能支柱（原型必须表达）

- Agent 名册：状态（工作中/空闲/休眠）、身份色、群组、远端 mirror 成员
- 对话流：用户消息、agent 回复、A2A 消息（可见的 agent 社交）、群聊轮次、执行任务卡（Box 内跑）
- Box 管理：创建/快照/资源（CPU·内存·磁盘）/磁盘压力告警/模板
- 任务监控：排他队列三 lane（user > agent > background）、执行轨迹、产物（diff/文件）
- 社交图谱：agent 间对话边、消息计数
- 跨用户房间：远端成员、预算、幂等
- 设置：LLM provider（OpenAI 兼容/Anthropic）、沙箱后端、权限策略、自动化（automations）

## 基调与语气

- 工具感、克制、可信。像一台"本地任务控制台"，不像营销页
- 中文为主，技术名词保留英文（Box、lane、nonce、SSE）
- 状态永远诚实：运行中/排队/退避/失败 一目了然

## 反参照（不要像什么）

- 不要 AI 渐变紫/蓝的"SaaS AI 助手"脸（ChatGPT 套壳风）
- 不要终端极客风（黑底绿字 hacker aesthetic）：这是给日常使用的桌面应用，不是炫技终端
- 不要云服务控制台脸（AWS/Azure 那种密恐卡片海）
- 不要把 agent 画成真人头像拟人社交（这是工具，不是虚拟宠物）

## 战略原则

- 本地优先：一切核心能力断公网仍可用（LLM 可换本地 Ollama）
- agent 是同事不是宠物：界面呈现它们的协作与产出，而非"养成"
- 危险操作有闸门：Box 内自由，出 Box（宿主机文件/网络）需批准
