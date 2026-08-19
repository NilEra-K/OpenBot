# P2 实施计划（桌面：Electron 壳接真内核）

> 状态文档：随实施推进更新勾选与「设计要点」。架构依据 [ARCHITECTURE.md](../ARCHITECTURE.md) §11（P2 行）；
> 与它冲突时以它为准。上阶段记录见 [plan-p1.md](plan-p1.md)。

## 目标与验收

把 P1 验证过的内核装进 Electron：环回网关（HTTP/SSE）+ Vue renderer 五视图接真数据 + 审批闸门 UI + caps 驱动 UI。

- **验收（路线图原文）**：原型视觉对齐（prototype.html 为底稿）；Playwright `_electron` E2E 绿；
- `pnpm build && pnpm typecheck && pnpm test` 保持全绿（内核测试零 Electron 不动摇）；
- 真实 LLM（openai-compat）接入：配置 base_url/key 后可对话（用户自有 key 手动冒烟）。

## 已裁定的范围（2026-08-19 用户确认）

| 项 | 决定 |
|---|---|
| 真实 LLM | **进 P2**：`llm/openai-compat`（fetch+SSE 零 SDK）+ settings 视图配置（key 走 safeStorage） |
| WS `/stream` 数据面 | **只定帧协议 + 回环自测**；真实 Box 实况帧等 P3 有信号源再启用 |
| P1 遗留（群聊/广播/subagent、automations、memory、box-catalog） | backlog，不阻塞 P2，后续按需插入 |
| 流式输出（token 级打字机） | 不进 P2（chat 非流式先行）；流式作为 P2.5/P3 增强 |
| electron-builder 打包 | P3（win nsis+portable+签名）；P2 开发态运行即可 |

## TODOLIST

- [x] 1. `llm/openai-compat`：fetch + SSE 解析（零 SDK），base_url/model/key/代理可配，tools↔toolCalls 协议映射，超时与 signal；注入 fetch 的确定性单测
- [x] 2. `state/settings-store`：应用级设置持久化（providers/model 默认值），密文注入式加解密回调（桌面侧接 safeStorage/DPAPI，测试注入恒等）
- [x] 3. `runner` ManualApprovalGate：挂起式审批（pending promise + 账本 pending 重放 + `v1.approval.resolve` 命令）；AutoApprovalGate 保留给 CLI/测试
- [x] 4. `transport/gateway`：`POST /api/*` 控制面 + `GET /events` SSE（Last-Event-ID 续传）+ 环回鉴权三件套（127.0.0.1 随机端口 / bearer token / Host 校验）；zod wire 校验（命令目录 + 事件 payload，docs/protocol.md 待填充项落地）
- [x] 5. `transport/stream-protocol`：WS `/stream` 帧协议定义（二进制帧头 + 背压语义）+ 回环自测（不接真实信号源）
  - 附带完成 Step 4 遗留：事件 payload zod 目录（`EventPayloadSchemas`，与 core 双向编译期断言）+ docs/protocol.md 待填充项落地
  - 实测发现并修复状态机缺陷：RESUME 须驱动补发（内存管道测试抓到，真实 WS 测试被 endStream 掩盖）
- [x] 6. Electron main 装配真内核：`assembleKernel`（NodeFs → userData、真实时钟、watchdog 定时驱动）+ 网关启动 + token/port 经 contextBridge 注入；保留托盘/关窗驻留/单实例/三键/frameless
  - 内核三处小扩展：ledger `listPending(prefix)`、ManualApprovalGate `replayPending()`（账本 pending 重发 requested，UI 重弹窗）、
    assembleKernel `approvalGateFactory`（Manual 闸门需要内核构件构造）+ 产物暴露 `ledger`/`approvalGate`
  - `apps/desktop/src/main/kernel.ts`：SwitchableChatProvider（settings 热切换）、safeStorage 密文回调（`v1:` 加密 / `b64:` 降级前缀分派）、
    settings×4 + approval×2 命令注册（zod wire 校验）、崩溃恢复重放、启动日志（端口/provider 状态/恢复数）
  - preload：`gateway.info()` 异步拉取 port/token（内存链路）；冒烟：Electron 真进程网关 401 鉴权验证通过
- [x] 7. renderer 脚手架：Vue3 `<script setup>` + Pinia + Vite + 内存版 transport 客户端（fetch + EventSource，可被 mock 网关替换——测试对称）
  - 网关补 CORS（file:// / dev-server 跨源必须；环回安全靠 token 不靠 origin，无 token 跨源一律 401 无泄露面）
  - renderer CSP：connect-src 仅 127.0.0.1 任意端口（ws 为 P3 数据面与 dev HMR 预留）
  - main 加 `addAgent` 重启幂等（名册已有则只重建内存态——首次冒烟即抓到 STATE_AGENT_EXISTS）
  - 冒烟验证：内核就绪 + renderer EventSource ESTABLISHED（file:// → 环回网关全链路通）
  - 遗留：renderer 无 tsc 类型检查（vite esbuild 只转译；IDE 可用，CI 不查——记入风险，P2.5/P3 引 vue-tsc）
- [x] 8. console 视图：对话流 + 执行卡 + steward 默认路由与空缺态提示 + markdown（markdown-it + DOMPurify）+ 乐观更新带 nonce
  - 两栏布局（roster + streamcol；ctx 面板待 P3 WS 实况——原型 #11 标注位）；流内条目：日期分隔/消息气泡
    （user 右对齐、agent markdown 渲染）/A2A 中继行（点击跳会话）/Box 执行卡（started/finished 聚合）/审批 gate 卡（流内批准——
    覆盖 Step 10 的交互面，Step 10 只余弹窗化验证）
  - 乐观更新：本地占位（~nonce）→ 受理回执升级 messageId → 事件镜像去重；失败标记 + 同 nonce 重试（账本零双发）
  - 会话历史懒加载：切换会话/连接就绪时拉 transcript（内核重启后的持久真相；与事件流按 messageId 去重幂等）
  - 实测修复两个真实缺陷：loadHistory 失败后标记未回滚（boot 竞态下永不重试）；**内核 id 重启重复**（msg/run/appr id
    从零重数 → 历史去重误判。修：assembleKernel 加 bootPrefix（默认随机，CLI/测试注入固定保确定性——CLI 三次运行哈希一致已验证））
  - CDP 冒烟全过：名册/管家徽标/空缺态提示/输入发送/乐观收敛/历史恢复
- [x] 9. boxes / tasks / graph / settings 视图：caps 驱动按钮、三 lane 队列、委派边+消息边、provider 配置（key 密文）
  - tasks：三 lane 队列（user/agent/background，`v1.lifecycle.*` 事件累积；escaped/reaped 状态永远诚实呈现）
  - boxes：Box 卡 + caps 工具栏 + 快照闭环（coordinator 新增 `v1.boxes.snapshot`，按钮仅 caps.snapshot=true 渲染——
    caps 驱动的真实演示）；CPU/内存/磁盘仪表与终端接管诚实降级不做（mock 后端无真实信号，P3 接入）；
    卡内展示近期执行（runId 前缀推断归属 agent）
  - graph：SVG 图谱（user 居中 + roster 环形均布、贝塞尔弧同原型算法、边宽 ∝ √消息量）；
    消息边（灰）与 A2A 委派边（accent）视觉区分；侧栏图例/排行/节点与边聚焦详情（Esc/点空白退出）；
    「进入会话」写 activeAgentId 跳 console；端点已移出名册的历史边不画
  - settings：provider 档案 CRUD（upsert 留空 key=保留密文、设为主力、删除二段确认）真实命令面全链路；
    沙箱后端区块呈现 caps 事实；权限策略区块呈现 Manual 闸门现状——不放假开关（内核无对应存储）
  - store：+providers/defaultProvider 状态与 refreshSettings（boot 复用）；+snapshotBox action；
    App.vue 侧栏顺序对齐原型（console→tasks→boxes→graph→settings）
  - CDP 冒烟 21 项全过：三视图渲染/快照闭环/图谱聚焦与跳转/provider 保存设主力/空缺警告联动/冒烟数据清理
- [x] 10. 审批弹窗：approval 事件 → 弹窗 → `v1.approval.resolve` 回写（nonce 幂等不双弹窗）
  - `ApprovalModal` 全局层挂 App 壳（流内 gate 卡保留对话流上下文，弹窗管注意力捕获）；队列多审批逐条推进
  - 「稍后处理」只藏弹窗（ui store 局部态，内核挂起不受影响；流内卡与角标仍可见）；终结后回收稍后标记防缓涨
  - 决议分流：成功/领域失败（已决议/不存在）本地立即移除（与 SSE resolved 事件幂等双保险）；
    传输失败（网关不可达）保留条目供重试
  - CDP 冒烟 12 项全过：出现/内容/nonce 重放不双弹/队列推进/稍后/批准与拒绝回写真实到达网关
    （未知 nonce → APPROVAL_NOT_FOUND 领域错误收敛）/resolved 事件收敛/ dismissed 回收
- [x] 11. Playwright `_electron` E2E：mock llm 脚本驱动 UI 全链路（chat → A2A → box exec + 审批弹窗）
  - 基建：`e2e/mock-openai.ts`（按 messages 特征分派脚本——`[A2A from]` 前缀区分 worker 请求，
    规避 A2A 并行时按序号消费的竞态）；根 `vitest.config.ts` 排除 `apps/desktop/e2e/**`
    （playwright 的 test() 语义与 vitest 不兼容，vitest 收集即炸——131 内核测试恢复全绿）；
    playwright workers=1
  - 场景：`OPENBOT_USER_DATA` 隔离 userData + `OPENBOT_EXTRA_AGENTS` 附加 worker1（两 agent 共享
    SwitchableChatProvider——mock 端点请求数 ≥5 即两 agent 都走真链路的证据）；
    settings 表单配 provider → console 发消息 → relay 出现 → **先批准弹窗再点 relay**
    （approval-scrim 全局遮罩会拦截中栏点击——顺序反了点不到）→ worker1 会话验证回复+exec 卡 →
    回管家看最终回复 → tasks 2 runs → graph 3 边（无向聚合）→ 五视图截图（`OPENBOT_SHOT_DIR` 控制，默认跳过）
  - 实测修复 Electron「关窗驻留」与自动化退出冲突：close 事件 preventDefault 拦 quit →
    `before-quit` 置 quitting 标志，`app.close()` 不再挂起（probe spec 定位，4.3s 收敛）
- [x] 12. 验收：三命令全绿 + E2E 绿 + 五视图对照原型走查 + 真实 provider 手动冒烟（用户 key）
  - `pnpm build && pnpm typecheck && pnpm test`（131 绿）+ `test:e2e`（全链路绿）+ 五视图截图对照
  - **走查方法论**：AI 视觉 diff 报告 + 源码级甄别（AI 色值报告会幻觉——#1E1E1E 等不存在的值；
    结构性观察逐条回查 prototype.html 源码裁定）
  - 本轮修正：侧栏改图标 rail（56px 条 / 40×40 r9 / hover bg2 / active accent-weak+accent /
    角标右上 accent 底 accent-ink 字——对齐原型 .rail/.rail-tab/.rail-badge；导航按钮文字只在
    aria-label，E2E 定位改 getByRole）；roster 补「成员」头 +「本地 AGENTS」分节 + 头像 26px/r7 +
    状态角标（runs running 投影 working 点脉冲——真实状态机，非装饰）；run 卡对齐原型
    （bg2/r10、is-active accent-weak 渐变、is-done 0.72、zombie danger-weak 底、progress 3px/64%）；
    lane 点语义（user=accent 脉冲 / agent=ink2 / background=半透明，原型同源）；tasks 统计行
    四指标（今日/平均/成功率/队列中——全部由真实 runs 推导，无数据的指标隐藏不造假）；
    console 气泡不对称指向圆角 + composer focus 光晕 + `--ink3` #747474；`:root` 补
    `--accent-rgb`/`--danger-weak` 与原型同源
  - **已裁定不改的差异**（原型是全功能展望，实现遵循诚实降级）：console ctx 三栏面板（P3 WS 实况
    信号源）；标题栏搜索框/Ctrl K/评审标注按钮（评审工具是原型专用，搜索未列 P2 计划）；
    boxes CPU/内存/磁盘仪表（P3）；roster「＋ 新成员」按钮与远端/休眠分节（P2 无对应命令面/事实，
    不造假日入口）；run 卡描述文本（lifecycle 事件无 run 摘要事实，P3 事件族扩展再补）；
    进度条动画保留滑动（原型静态 64% 是 mock；真实运行无进度可报，不确定态动画更诚实）
  - 真实 provider 手动冒烟：移交用户（自有 key，配 base_url 后对话验证）

## 设计要点（开工前逐条细化，先记已知决策）

### 网关（Step 4）——已完成，实测补记两条 undici 地雷

- 实现用 `node:http`（零新依赖）；路由表从 InProcessTransport 的命令目录生成，handler 复用（HTTP 层只做编解码+鉴权）。
- SSE 续传：连接时带 `Last-Event-ID` → `bus.since(seq)` 补发 → 转入实时订阅；seq 由 core EventBus 保证全局单调。
- **token 传递**：EventSource 无法自定义 header——SSE 用 `?token=` 查询参数校验；POST 走 `Authorization: Bearer`。
  token 为一次性生成（每次启动新随机），仅存在于 main→preload→renderer 内存链路，不落盘。
- zod 引入为 transport 运行时依赖；schema 与 core 的 `KernelEventMap` 单一来源对齐（schema 从类型生成或双向断言，防止两处漂移）。
- **地雷 A（SSE 初始字节）**：undici fetch 若 SSE 连接建立时 body 零字节，后续实时数据无法流入 reader（纯 node 脚本不复现、vitest 环境 100% 复现）。已修：网关连接时立即写 SSE 注释行 `:ok\n\n` 冲出首字节（规范允许、客户端忽略，同时防中间层缓冲）。
- **地雷 B（Host 头伪造测试）**：undici fetch 把 `Host` 列为 forbidden header 静默丢弃——测 DNS rebinding 防护必须用 `node:http` 原生请求伪造 Host。

### stream-protocol（Step 5）——细化定案

- **帧模型**：一个 WS binary message = 一个完整协议帧（WS 自带消息边界，无 TCP 粘包问题）。
  帧头 14 字节：`u8 版本(=1) | u8 帧类型 | u32 流 ID(BE) | u32 流内序号(BE) | u32 负载长度(BE)` + 负载。
- **帧类型**：OPEN(1，负载 JSON 元信息) / DATA(2) / END(3) / ABORT(4) / PAUSE(5) / RESUME(6) / ACK(7，负载 u32=已连续收到的最高序号)。
- **多路复用**：连接内流 ID 单调分配不复用（0 保留连接级）；大文件由发送方切成 ≤256KB 的 DATA 块，序号流内连续。
- **背压语义**：接收方处理不过来 → PAUSE（流 ID 或 0=全流）→ 发送方停发该流 DATA → RESUME 恢复；
  发送方本地另有 WS 缓冲水位流控（实现细节，协议无关）。ACK 让端到端丢帧可见。
- **状态机校验**：DATA 前必须 OPEN；END/ABORT 后该流关闭，再收即协议违规（断连级错误）。
- **实现**：`ws` 库进 transport（Node 无原生 WS 服务端；MIT，与 Apache-2.0 兼容）；gateway 挂 `upgrade` 事件，
  `/stream` + `?token=` 鉴权（同 SSE），鉴权失败直接销毁 socket。P3 有真实信号源再接 openStream 的真实调用方。

### openai-compat（Step 1）

- 覆盖 OpenAI/DeepSeek/豆包/Moonshot/GLM/Grok/Ollama/vLLM（chat completions 兼容面）；`stream: false` 先行。
- tools 映射：我们的 `ToolSpec/ToolCall` ↔ OpenAI `tools/tool_calls` 字段；role=tool 消息带 tool_call_id。
- 错误转 `LlmError`（code：`LLM_REQUEST_FAILED` / `LLM_HTTP_xxx` / `LLM_TIMEOUT`），沿用 llm 零依赖纪律。
- fetch 注入式（测试喂脚本化 fetch，真实性由用户手动冒烟）。

### 闸门（Step 3）

- `ManualApprovalGate.request()` 挂起至决议或 run deadline 兜底（审批挂起期间 run 未结束，deadline 到点 run 失败——语义自洽）。
- 进程重启恢复：账本里 `pending` 的审批在装配时重发 `v1.approval.requested` 事件（账本就是持久化真相）。
- 桌面装配默认 Manual；CLI/E2E 仍用 Auto（确定性）。

### renderer（Step 7–9）

- 构建链：renderer 单独 Vite（`dev:renderer` HMR 加载 dev server URL，`build:renderer` 出静态产物由 main 加载文件）；main/preload 维持纯 tsc——不引入 electron-vite 全家桶，保持主干零框架。
- **Vite dev 端口属显式指定端口**：启动前检查占用，遵守 CLAUDE.md 端口规则。
- 状态归属二分（解耦纪律 #1）：内核事实（roster/transcript/任务/Box/审批）全部来自事件流与命令响应；渲染局部态（视图/选中/草稿）不出 Pinia 的 UI store。
- 视觉以 prototype.html 为准逐视图迁移（共识点标注已在原型内）；标题栏/托盘/三键交互全部保留。

### 风险与地雷（对照 docs/platforms.md）

- sandbox preload 必须 CJS（`index.cts`，已验证）；Vue 重建不动 preload 通道。
- 窗口最小宽 1080 与 `body min-width` 继续对齐。
- Electron 主进程装配点 import coordinator/llm（装配例外，P1 已落地）；renderer 业务面只走网关客户端（fetch/SSE），零内核 import。
- 真实时钟进入后，transcript/事件的 `at` 不再恒 0——确定性断言只存在于内核测试与 CLI（注入时钟），桌面路径不参与逐字节比对。
