# P3 · ctx/操作台原型样式对齐 + 任意时刻接管

> 状态文档：实施于 2026-08-20（plan-p3.md Step 7 的后续收口）。
> 母版依据：`prototype.html`（ctx CSS 466–534 行、boxops CSS 562–631 行、ctxScreenFrame/renderCtx JS 1719–1793 行）。

## 目标与验收

1. **样式对齐**：ctx 面板与 Box 操作台与原型逐项对齐（调研确认 10 处实质差异，含 1 处完全缺失的结构 cs-hint）。
2. **任意时刻接管**：ctx-screen 不再依赖 exec 史推导 boxId——改用内核事实「注册 agent 即有专属 Box」（与原型 `AGENT_BOX` 静态映射语义一致），任何时刻可点开操作台。
3. `pnpm build && pnpm typecheck && pnpm test` + 桌面 `test:e2e` 全绿。

## 实现思路

### 工作包 A：协议最小扩展（任意接管的数据源）

- `v1.system.listAgents` 返回项加 `boxId`（agent 专属 Box——`addAgent` 里 `backend.create` 后
  `boxes.set(agentId, boxId)` 的既有事实；领域事实，协议纯度无问题；无 Box 时 `null`）。
- renderer `RosterEntry` 加 `boxId?: string | null`（可选：运行中注册的新 agent 走 roster 事件
  push 分支时归属未知，待下次快照刷新；一期 agent 均在 boot 前注册，无此路径）。
- `CtxPanel.screenBoxId` 改查当前会话 agent 的 roster `boxId`——exec 史只决定屏幕显示内容，
  不再决定可点性。IDLE 空缺文案保留（无 exec 时显示在屏幕内）。

### 工作包 B：ctx 面板样式对齐（ctx.css / CtxPanel.vue）

| # | 原型 | 对齐动作 |
|---|---|---|
| B1 | `.ctx` `padding: 0 16px 16px`（无 flex/gap，屏幕自补 `margin: 16px 0 0`） | 改齐；思考条 `margin-top: 12px`、屏幕 `margin-top: 16px` |
| B2 | `.ctx-screen` 自然高度（无 min-height） | 移除 `min-height: 220px`；`.ctx :deep(.box-term)` 加 `max-height: 340px` 内滚（原型静态演示无超长问题，实况输出需要上限防面板顶穿；贴底跟随保留——box-term 恢复滚动容器） |
| B3 | `.cs-bar` 无 gap | 移除 `gap: 8px` |
| B4 | `.cs-term` 9.5px / padding 9px 10px / `white-space: pre` | 类名 `cs-screen-body` → `cs-term` 对齐原型命名，数值对齐 |
| B5 | `.cs-hint` 屏幕底部提示条（原型 529–534 行）完全缺失 | 新增结构 + 样式（`rgba(26,24,21,0.85)` 底、上边线、10.5px、hover 随屏幕变 accent）+ 图标（原型 ICONS.terminal 同源 SVG）；文案按 caps 诚实分流：`interactive` → 「键盘直接接管」，否则 → 「查看实况」 |
| B6 | `.cs-term .t-ok` 绿色成功行类 | 补 CSS 定义（行级语义接线后续，本轮只备样式） |

### 工作包 C：操作台样式对齐（boxops-overlay.css / boxops.css）

| # | 原型 | 对齐动作 |
|---|---|---|
| C1 | `.boxops` 在 main 内（rail 侧栏保留可见可点） | `fixed inset: 0` 改 `top: 38px; left: 56px; right: 0; bottom: 0`（titlebar 38 / rail 56 为壳现值）；顺带 bo-bar 不再落 titlebar drag 矩形（no-drag 保留作防御） |
| C2 | `.bo-screen` 无 margin（贴边铺满） | 移除 `margin: 14px` |
| C3 | `.bo-screen` `overflow: auto` + `outline: none` + `white-space: pre` | 对齐；`.box-term` 同步改 `pre` 去 `word-break`（长行横向滚动，终端行为） |
| C4 | `.bo-hint` `min-height: 30px` / `padding: 4px 16px` / 11px / stat-dot working 前缀 | 数值对齐 + 加工作点（文案保留现有诚实分流） |
| C5 | `.t-cursor` 8×15 琥珀 `#EEB154` | `.caret` 从 7×13 灰绿对齐琥珀 |
| C6 | （顺带修既有 bug）`.approval-scrim` z-index 60 < `.boxops` 80——操作台开着时审批弹窗被盖 | scrim 提到 `z-index: 90`（审批是注意力捕获层，必须高于操作台） |

### 工作包 D：E2E + 文档

- E2E 新增「无 exec 史任意接管」断言：发消息前（steward 会话、IDLE 屏）点 ctx-screen 进操作台再返回——确定性时刻。
- `docs/plan-p3.md` Step 7 补记。

## 明确不做的（诚实降级记录）

- **BoxesView 的 runId 前缀推断**不替换：那是 exec→agent 归属，与 box→agent 归属语义不同
  （多 agent 共享 Box 时两者不同），留待 exec 事件补 agentId 字段时统一解决。
- **`.is-asleep` 灰化**不做：内核无 Box 休眠态信号源（WSL `--terminate` 尚未接 UI），等信号源就位再做。
- **t-ok 行级语义**不接线：本轮只备 CSS 类（成功行绿色），显示语义等 exec 结果行有明确「成功标记」需求时再接。

## TODOLIST

- [x] 1. coordinator：`v1.system.listAgents` 返回项加 `boxId`（agent 专属 Box 的领域事实）+ assemble 测试补断言
- [x] 2. renderer store：`RosterEntry` 加 `boxId`，boot 映射
- [x] 3. ctx.css 对齐（B1–B4/B6：padding、自然高度、cs-bar、cs-term 命名与数值、t-ok）
- [x] 4. CtxPanel：screenBoxId 改查 roster + 新增 cs-hint 提示条（caps 分流文案 + terminal 图标）
- [x] 5. boxops-overlay.css / boxops.css 对齐（C1–C5：定位留出 rail、去 margin、overflow/outline/pre、bo-hint、琥珀光标）
- [x] 6. ApprovalModal scrim z-index 60 → 90（顺带修被操作台盖住的既有 bug）
- [x] 7. E2E：新增「无 exec 史任意接管」断言 + 全量验证（`pnpm build && pnpm typecheck && pnpm test` + `test:e2e`）
- [x] 8. docs/plan-p3.md Step 7 补记

## 追加轮次：对话流聚合（2026-08-20 用户裁定）

**需求**：think 与 Box 操作都是「模型说的话/做的事」——聚合进对话流（m-text 位置），不要求塞进
单个气泡；思考过程、操作 Box 的过程、输出按序放在一起。**思考块显示全部轮次**（用户确认）。

### TODOLIST

- [x] 1. ConsoleView：`streamRows` 加 `think` 行（llm 流块按 at 混排）+ 流内思考块模板
- [x] 2. ConsoleView：task 卡内嵌输出区（同 runId 的 exec 流块，复用 BoxScreen；无实况退化现状）
- [x] 3. CtxPanel / ctx.css：移除思考条，ctx 纯化为屏幕
- [x] 4. console.css：思考块与输出区样式
- [x] 5. E2E 断言调整 + 全量验证（build / typecheck / test / test:e2e）
- [x] 6. 文档补记

### 落点

- **think 行**：`kernel.streams` 的 llm 块按 `agentId` 直配进流（比 runId 前缀推断更准），行 key 用
  块自身 key（`runId:llm:seq`——trim 淘汰重建数组时 key 不变，DOM 不闪）。全部轮次留痕：多轮
  工具循环时思考块与 exec 卡按 at 自然交错。live 态琥珀左边线 + `think-caret` 光标；完成静态留痕。
- **task 卡输出区**：`execStreamsOf(runId)` 取同 run 的 exec 流块喂 `BoxScreen`（$ 命令 + stdout/
  stderr 着色 + live 光标一体的终端语义）。`task-out` 深色终端底（与 ctx 屏幕同源）、max-height
  300 内滚贴底。有实况时卡头命令行让位（避免与 `$ cmd` 重复），无实况的历史卡（重启后——实况
  断线不补）退化为命令行 + 状态 chip 的现状形态，不造假。
- **CtxPanel 纯化**：删思考条，ctx = cs-bar + 屏幕 + cs-hint（与原型 is-single 单屏模式同构）。
- 验证：build/typecheck 过；184 单测 + E2E 全绿（新断言：流内 `.think`、`.task .bt-line` 的
  `$ ls /work` 与 mock 输出）。

## 追加轮次二：消息聚合单元 + 输出占位（2026-08-20 用户裁定）

**需求**：① think/task 放在 m-name 之下（归属 agent 消息结构），思考过程可展开/收起；
② 发送消息后 agent 尚无输出时三个点气泡占位，首 token 到达平滑过渡（占位不做时序断言——
mock 响应太快会 flaky，靠真机验收）。

### TODOLIST

- [x] 1. ConsoleView：streamUnits 聚合算法（agent 消息吸收前置 think/exec 块；user 前 flush
  残余成无文本块组——事实不丢；relay 不清空累积；末尾残余=进行中单元）
- [x] 2. 进行中单元 + 三个点占位（runs queued/running 且无任何流块时触发；run 终态即消失）
- [x] 3. 思考块折叠（完成后默认收起+首行摘要+chevron；live 强制展开；展开态是渲染局部态）
- [x] 4. console.css：聚合内去 38px 缩进、typing dots 跳动、fade-in-up 渐入 180ms
- [x] 5. 全量验证：build/typecheck 过、184 单测、E2E 过（选择器全兼容，无需改断言）
- [x] 6. 文档补记

### 落点

- **聚合单元结构**：`.m`(agent) → avatar → m-body → m-meta(m-name/工作中…) → 思考块们 →
  task 卡们 → m-text（最终文本 markdown）。user 消息独立模板（右对齐不变）。
- **吸收算法**：原始行（消息+exec 卡+think 块）按 at 排序后遍历——exec/think 进累积，
  agent 消息吸收累积输出聚合单元并清空，user 消息前先把累积 flush 成无文本块组（上一轮
  无最终消息也不丢事实），relay 只标记不清空。末尾残余+agentBusy（runs 有 queued/running）
  = 进行中单元。
- **占位语义**：busy 且无块 → `.m-text.typing` 三点跳动；首个流块到达即被实况块取代
  （占位条件不含块）。run 终态占位消失（成功被消息取代、失败如实消失不悬挂）。
- live→end 的思考块自动从强制展开切回收起（isThinkOpen 计算：live 或用户点开）。
- caret 尾随文本：think-body inline + 滚动容器在 think-body-wrap（max-height 200）。

## 实施补记（第一轮）

- **全量验证**：build/typecheck 过；Vitest 184 通过（+1：listAgents boxId 用例）；E2E 过（含新断言：
  IDLE 屏点开操作台→返回闭环）。
- **环境地雷（2026-08-20 实测）**：系统 commit charge 接近耗尽（80.1/81.8 GB——python/navicat/VSCode 等
  用户应用持有）时，Vitest 默认多 worker 直接 `ERR_IPC_CHANNEL_CLOSED` / V8 `Realloc` 断言崩溃，
  Grep/Glob 等工具 spawn 同源失败；`vitest run --no-file-parallelism`（单 worker 串行）在余量内正常
  ——资源紧张时先降并发再怀疑代码。
- cs-term 的实况上限用 `.ctx :deep(.box-term) { max-height: 340px }` 落地（scoped 穿透命中子组件根；
  BoxScreen 贴底跟随随之继续生效——box-term 恢复为滚动容器）。
- boxops 留出 titlebar/rail 后，bo-bar 不再与 drag 矩形重叠（no-drag 声明保留作防御）；审批 scrim
  提到 90 高于操作台，操作台开着时出 Box 审批也可见。
