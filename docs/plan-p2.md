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
- [ ] 8. console 视图：对话流 + 执行卡 + steward 默认路由与空缺态提示 + markdown（markdown-it + DOMPurify）+ 乐观更新带 nonce
- [ ] 9. boxes / tasks / graph / settings 视图：caps 驱动按钮、三 lane 队列、委派边+消息边、provider 配置（key 密文）
- [ ] 10. 审批弹窗：approval 事件 → 弹窗 → `v1.approval.resolve` 回写（nonce 幂等不双弹窗）
- [ ] 11. Playwright `_electron` E2E：mock llm 脚本驱动 UI 全链路（chat → A2A → box exec + 审批弹窗）
- [ ] 12. 验收：三命令全绿 + E2E 绿 + 五视图对照原型走查 + 真实 provider 手动冒烟（用户 key）

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
