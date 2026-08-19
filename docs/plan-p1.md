# P1 实施计划（内核走通 · 无壳）

> 状态文档：随实施推进更新勾选与「设计要点」。架构依据 [ARCHITECTURE.md](../ARCHITECTURE.md) §11（P1 行）；
> 与 ARCHITECTURE.md 冲突时以它为准，架构级变更须先改 ARCHITECTURE.md 再同步本文。

## 目标与验收

在**无壳**环境下验证内核全链路 `chat → A2A → box exec(mock)`：

- 全程确定性——同输入同输出（时钟/随机/id 由参数注入，冒烟脚本可重复执行且逐字节一致）；
- `pnpm build && pnpm typecheck && pnpm test` 全绿；
- 不装 Electron 即可验证整个内核（八包边界的直接回报，ARCHITECTURE.md §11 注）。

## 范围裁定

| 项 | 进 | 不进（归属） |
|---|---|---|
| messaging | A2A 最小子集：fire-and-forget + 对称唤醒 + priority steer + 双侧 transcript 镜像 | 群聊/广播/subagent（P1 收尾再评估）、CrossUserRelay（P5）、云桥（桩） |
| transport | in-process bus：类型化事件 + 异步 RPC + sendPrompt 幂等 | 环回 HTTP/SSE/WS 网关、Last-Event-ID 续传（P2） |
| 闸门 | runner 拦截 + approval 事件 + 账本记录；CLI 模式**自动批准** | 审批弹窗 UI（P2） |
| llm | provider 抽象 + 确定性 mock | openai-compat / anthropic 真实 provider（P1 后） |
| boxes | BoxBackend 接口 + backend-mock | backend-wsl / backend-docker（P3） |
| 组织模型 | profile.role + steward 唯一性事务（state 层） | 默认路由/空缺态 UI 提示（P2） |

## TODOLIST

- [x] 1. `core`：三 lane 排他调度 + watchdog 逃逸/zombie 回收 + RunLifecycle + 七族事件总线
- [x] 2. `state`：agent 目录布局 + transcript JSONL（append-only）+ 幂等账本 + steward 排他事务
- [ ] 3. `llm`：provider 抽象 + 确定性 mock
- [x] 4. `boxes`：BoxBackend 接口 + caps + backend-mock
- [x] 5. `messaging`：A2A 最小子集
- [x] 6. `runner`：turn 执行 + in-box 工具族 + 闸门桩（CLI 自动批准）
- [x] 7. `transport`：in-process bus + 异步 RPC + 幂等 sendPrompt
- [x] 8. `coordinator`：InProcessCarrier 装配全家
- [x] 9. `apps/cli`：chat → A2A → box exec(mock) 全链路冒烟
- [x] 10. 验收：三命令全绿 + 冒烟确定性证据

每包落地真实测试后删除其 P0 占位 `smoke.test.ts`。（已全部删除）

## 验收记录（2026-08-19）

- `pnpm build && pnpm typecheck && pnpm test` 全绿；测试 84 项（14 个文件），覆盖八包。
- 冒烟命令：`pnpm build && node apps/cli/dist/index.js`（或 `pnpm --filter @openbot/cli start`）。
- 确定性证据：同一二进制连续三次运行，输出经 `diff` 逐字节一致（时钟恒 0、id 顺序派生、内存持久化）。
- 链路证据（事件流 seq 顺序）：`v1.message.user → lifecycle.queued/started → v1.message.a2a →
  v1.box.exec(started/finished) → v1.message.agent ×2 → lifecycle.finished/idle`；双侧 transcript
  `a1:[user, a2a-out, agent]`、`a2:[a2a-in, agent]`；幂等重试 `first:false` 零双发。

## 实施补记（与计划的偏差与决定）

- **core**：`Lane` 词汇表落位 `lifecycle`（与 RunPolicy 同源），`sched` 只留调度器本体；事件总线同步分发
  （顺序即订阅序，确定性），异步缓冲归 transport（P2 网关）。escape 后槽位保留至 zombie settle（排他
  不变量的代价，execute 实现方契约=必须有界）。
- **state**：`FsAdapter` 注入（内存/NodeFs 两实现）；账本 JSONL 同为 append-only（重放后行覆盖前行）；
  steward 转移的崩溃窗口：先落 from=worker 再落 to=steward，中途崩溃最多退化为空缺态、绝不双管家。
- **llm**：mock 深拷贝记录请求（turn 引擎会继续原数组，引用会让观察失真）；错误码自带（llm 零依赖），
  runner 边界转 `KernelError` 同 code。
- **messaging**：入站消息受理即落 transcript（durable acceptance），turn 组装历史时按 originMessageId
  去重防双计；重驱失败记录在 `service.failures`（fire-and-forget 分支不静默吞错）。
- **runner**：工具层「未知工具/执行错误」一律转回喂文本（模型可见、turn 不崩）；闸门幂等键派生自
  `originMessageId + toolCallId`（redrive 后稳定）；`host_fetch` 为出 Box 闸门的机制演示桩。
- **transport**：命令目录 P1 为 stringly（`client.call(command, payload)`），zod schema 与类型化表面归 P2
  （docs/protocol.md 待填充项）；`KernelEvent/KernelEventHandler` 类型经 transport 转出口，壳零内核 import。
- **coordinator**：装配点例外落地——CLI/desktop main 装配时 import coordinator 与 llm 造 provider，
  业务面仍只走 transport 客户端；watchdog 定时驱动默认不启动（生产经 `startWatchdog`，测试手动 `tick`）。

## 设计要点（随实施补记）

### Step 1 core（排他调度语义，本次敲定）

- **纯逻辑零 I/O**：不读系统时钟、不碰随机——`now: () => number` 与 `nextRunId: () => string` 由装配方注入；runId 用单调计数器（确定性 transcript 的前提）。
- **排他不变量**：每 `AgentScheduler` 实例（每 agent 一个，由 coordinator 创建）同一时刻至多一个活跃 run；lane 优先级 `user(0) > agent(1) > background(2)`，同 lane FIFO。
- **抢占规则**：仅「可 steer」的来客能抢占——`lane === 'user'`（隐含 steer）或显式 `steer: true`（priority A2A）；被抢占的活跃 run 若本身是 user lane 则**永不被抢占**（ARCHITECTURE.md §3.5「不能中断 user lane 任务」）。被抢占 run 以 `aborted / RUN_STEER` 结算，at-least-once 重驱归 messaging，core 只如实报结局。
- **watchdog 逃逸**：`tick()` 由装配方驱动（真实时钟=定时器，测试=手动推进）。活跃 run 超 `graceMs` → emit `escaped`、`settled` promise 立即以 `escaped / RUN_GRACE_EXCEEDED` 结算（**发送永不悬挂**）；底层 execute 仍在跑则标记 zombie，**槽位保留**（排他不变量不许破），其 promise 最终 settle 后 emit `reaped` 并释放槽位、继续排空队列。execute 实现方契约：必须有界（llm/box 调用带超时）。
- **期限**：超 `deadlineMs` → abort（`failed / RUN_DEADLINE`）。重试不归调度器：`RetryPolicy` 是数据 + `shouldRetry/nextRetryDelayMs` 帮助函数，重试循环归 runner。
- **事件总线**：七族目录（`v1.<family>.<name>`）以 `KernelEventMap`（type → payload）落在 core；seq 全局单调（将来 SSE Last-Event-ID 续传的钩子）、`since(seq)` 重放；同步分发（确定性），异步缓冲归 transport。
- **ack 义务**：`enqueue()` 同步返回 `{ runId, settled }`——受理即有票据；durable acceptance 由 state 账本在更上层落实。

### 后续步骤（开工前细化，先占位）

- Step 2 state：FS 经注入抽象（真实=fs/promises，测试=内存实现）；账本三链路共用（消息/任务/审批）。
- Step 3 llm：mock 按「对话前缀 → 脚本化响应」查表，未命中报错（不许悄悄兜底——确定性测试要的是显式失败）。
- Step 6 runner：工具调用循环 = llm 返回 SendMessage/exec 等命令 → runner 执行 → 结果回喂，直到无命令或预算耗尽。
