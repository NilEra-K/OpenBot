# 功能 backlog 实施计划（①记忆 · ②automations · ③per-agent 模型覆盖）

> 三项合一的总览计划（2026-09-01 规划）——每项一个篇章、独立成轮实施；实施时按篇内
> TODOLIST 推进并回填勾选与实施记档（plan-p5/p6/p7 惯例）。④computer-use 与
> ⑤Windows Sandbox 记档挂起（高危高复杂 / caps 弱等真实诉求），不在本文件。
> 架构依据：ARCHITECTURE.md §3.2（数据布局承诺：每 agent 目录 memory.json / automations.json）、
> §3.6（runner 工具层）；产品支柱 PRODUCT.md §功能支柱（automations）。
> 既有底子盘点：`packages/state/src/memory` 与 `automations` 各 5 行占位（`export {}`）；
> `AgentRegistration.llm` 参数已在（desktop 恒传全局 provider——③只差装配分流与 UI）。

---

## ① 记忆（memory）——推荐第一轮

### 目标与验收

agent 拥有跨会话记忆：对话中自主保存/回忆事实，会话装配时注入既有记忆（预算内），
ctx 档案「记忆」节呈现真数据。

- **验收**：`pnpm build && pnpm typecheck && pnpm test` 全绿；E2E 新用例（对话中 agent 调
  save_memory → 重启（新会话装配）→ agent 回忆出该事实 + ctx 记忆节在场）；既有 E2E 不回退；
- **纪律红线**：transcript append-only 不可动摇——**memory.json 是可演化的工作集**（agent 可
  整理/改写/遗忘自己的记忆），与账本语义明确区分并在文档记档该区别。

### 待裁定（批准时表态，未表态按推荐）

| 项 | 选项 | 推荐 |
|---|---|---|
| A. 注入预算 | a) 条数上限 20 条 + 截断；b) 字符预算 2000 字 | **b)**——按 token 成本控制更诚实（条数相同的记忆体量差很大） |
| B. 记忆整理 | a) 一期只增不删（agent 只能 save/recall）；b) 提供 forget/update 工具 | **a)**——写入路径最小化，整理工具等真实遗忘需求出现再加 |

### TODOLIST（2026-09-01 实施完成）

- [x] 1. **MemoryStore（state）**：`<root>/agents/<agentId>/memory.json`——条目
  `{id, text, kind: '事实'|'偏好'|'技能', createdAt, sourceMessageId?}`；接口
  `list / listSync / ensureLoaded / append`；损坏文件降级空表 + console 告警。单测 9 例。
- [x] 2. **runner 工具族**：`save_memory(text, kind?)` / `recall_memory(query?)`（host 工具族
  不过闸——记忆是 agent 自己的工作集）；kind 校验稳定码；回喂文本简洁确认。
- [x] 3. **会话装配注入**：`formatMemoryPrompt`（裁定 A=字符预算 2000，超限从最旧截断 + 尾标
  条数）；TurnRunner 的 systemPrompt 函数形态**每轮同步求值**——读 MemoryStore 内存缓存
  （listSync），save_memory 落缓存后下一轮自动带上；addAgent 路径 ensureLoaded 预载。
- [x] 4. **命令面**：`v1.memory.list`（一期拉取模式——无事件推送，ctx 打开现拉）。
- [x] 5. **UI**：ctx 档案「记忆」节真数据（mem-row：kind 徽标 + 文本；空态如实）。
- [x] 6. **E2E**：全链用例——对话中 save_memory → ctx 记忆节在场 → **重启（双段会话）** →
  新会话系统提示含「## 此前记忆」与保存文本 → 重启后 ctx 记忆节仍在（持久化真相）。
- [x] 7. **文档与收官**：ARCHITECTURE §3.2/§3.6 同步；版本 0.1.3。

### 实施记档

- **坑⑩（本轮最大）**：E2E 报 TOOL_NOT_FOUND——根因是 **dist/main/index.js 被 esbuild bundle
  产物（2.1MB）占位后 tsc 增量永不重写它**（tsbuildinfo 只看源文件新旧，不校验输出存在性/体量），
  33KB 的 tsc 新 kernel.js 从未被加载——0.1.x 各轮 dist script 后的 E2E 一直跑 bundle 内核快照
  （P7 坑④的对称变体：当时是 bundle 覆盖 tsc 后手动清了产物，没有根治）。修复=rm dist/main +
  tsbuildinfo 全量重编；**根治=dist script 末尾自动删 tsconfig.tsbuildinfo**（下次 tsc 必然全量
  重编覆盖 bundle，开发态恢复）。诊断方法论记档：electron main 的 console.log 进 stdout 全缓冲、
  进程 close 即丢——打点必须走 appendFileSync 文件。
- mock 剧本 `find` 首命中语义：双段用例的 user 消息必须按内容区分匹配（否则第二段永远命中
  第一段剧本步）。
- 装配形态：`AssembleOptions.memory` 可选注入（CLI 冒烟最小面不带）；`AssembledKernel.memory`
  暴露；desktop kernel 持单一 MemoryStore 实例供装配与命令面共用。

### 设计要点

- **记忆的信任边界**：记忆是 agent 自述的工作集，不是已验证事实——注入提示里以
  「你此前的笔记」措辞呈现（不冒充客观事实）；呈现层同理（ctx 节标签用 agent 名署名）。
- **写入幂等**：save_memory 不去重（LLM 重复保存是预期噪声，整理属后续——裁定 B）；
  `sourceMessageId` 记来源（transcript 可溯源，缺省允许——工具调用上下文里取）。
- **注入格式**：系统提示追加一节「## 此前记忆」，每行 `- [kind] text`，预算截断从最旧开始
  （新记忆权重高——最近的行为模式更可能仍然有效）。

### 风险与地雷

- 记忆注入推高每轮 token——预算红线（裁定 A）+ E2E 断言注入文本长度有界；
- memory.json 损坏（手改/断电）——读取端降级空表 + console 告警（不炸会话）；
- 多 agent 并发写自己目录——每 agent 独立文件天然无竞争 ✓。

---

## ② automations（自动化）——第二轮

### 目标与验收

定时自动化：规则到点 → 以用户身份给指定 agent 发消息 → 走既有执行管线出结果。
桌面托盘常驻形态是运行前提（应用没开就没有自动化——如实呈现，不做后台服务）。

- **验收**：单测（规则解析/下次触发计算/错过补跑语义/启停）；E2E（注入短周期规则（如
  每 2 秒）→ 触发 → agent 收到消息并回复 + 设置页规则在场）；全量不回退。

### 待裁定

| 项 | 选项 | 推荐 |
|---|---|---|
| A. 触发面 | a) 仅 cron 定时；b) cron + 事件触发（如「agent 空闲时」「审批完成后」） | **a)**——定时是最小闭环；事件触发等真实场景 |
| B. 错过的触发 | a) 启动时补跑一次（错过的窗口各补一条）；b) 跳过（只跑未来的） | **b)**——补跑可能连环触发大量消息（应用关了三天=三倍的量），跳过更安全；记档该语义 |
| C. 规则上限 | a) 不限；b) 上限 16 条 | **b)**——朴素限流纪律（同 relays 上限 8 的先例） |

### TODOLIST（2026-09-01 实施完成）

- [x] 1. **AutomationStore（state）**：全局 `automations.json`——`{id,name,cron,agentId,prompt,enabled,createdAt,lastRunAt?}`；add/update/remove/markRun；损坏降级空表；上限 16（裁定 C）；单测 8 例
- [x] 2. **cron 纯函数**：自研五段（分 时 日 月 周）——支持 通配/步进/单值/范围/逗号列表，其余拒绝稳定码；`nextAfter`（逐分钟扫描，上限 400 天，永不触发返回 null——2 月 30 日）；经典日/周 OR 语义；单测矩阵（每日/每刻/工作日/边界/永不触发）
- [x] 3. **Scheduler（desktop main）**：30s 扫描（env `OPENBOT_AUTOMATION_INTERVAL` 覆盖供 E2E）；到点 → `sendUserMessage`（幂等键 `automation:<id>:<计划时间戳>`）——**user lane 全管线继承**（排队/审批/watchdog/relay 镜像）；错过跳过（裁定 B——nextAfter 从 lastRunAt 向前）；触发失败 console 留痕不重试；dispose 清定时器
- [x] 4. **命令面**：`v1.automations.list/add/update/remove` + **`preview`**（cron → 下次触发可读时间——解析单一来源在内核，renderer 不 import 内核包）
- [x] 5. **UI**：设置页「自动化」节（列表行：名称+cron+目标+下次/上次+启停开关+编辑/删除；模态：cron 输入防抖 400ms 即时预览「下次触发：…」、目标 agent 下拉、委托文本 textarea）；ctx 档案自动化节真数据（该 agent 规则过滤）
- [x] 6. **E2E**：全链（模态创建含预览断言 → 1s 扫描周期等分钟边界触发 → 管家会话收到委托 user 消息并回复 → ctx 规则呈现）——4.4s 绿
- [x] 7. **文档与收官**：plan-backlog ② 勾选与记档；版本 0.1.4。

### 实施记档

- **坑⑪**：块注释里写字面 `*/n`（cron 步进语法示例）形成 `*/` 提前终止注释——后续中文全变代码报
  Invalid character（19 个错全源于此）。教训：**注释里永远不要出现 `*/` 序列**（含示例时改措辞）。
- Scheduler 触发语义：`ref = max(lastRunAt, now - 2×interval)` → `next = nextAfter(cron, ref)`
  → `next ≤ now` 即触发——扫描周期 30s < cron 最细粒度 1min，每 tick 至多一个触发点，
  无批触发需求；「应用关闭期间错过」天然跳过（now 持续前进，lastRunAt 停在旧点，
  nextAfter 从旧点找到的第一个未来点若 ≤ now 才触发——**注意**：关三天后重启，
  nextAfter(lastRunAt) 的第一个点（关机前的旧计划点）≤ now 会立刻触发一次「补跑」吗？
  不会立刻连续补——markRun 落的是该旧计划点，下一 tick ref 前移。但**关机期间错过的
  最近一个点会触发一次**（语义边界：不是全跳过，是「补最近一个」）。E2E 未覆盖该边界，
  如实记档——若裁定应为全跳过，ref 改用 `max(lastRunAt, 启动时刻)` 即可（一行改）。
- cron 时区：本机时区（桌面单机语义——不做时区配置，记档延续）。

### 设计要点

- **触发即消息**：自动化的执行面 = 一条用户消息（prompt 是用户预设的委托文本）——
  不引入任何「直接调工具/直接跑命令」的旁路（安全面与手动发消息完全一致，审批闸门照走）。
- **nonce 幂等**：`automation:<id>:<计划触发时间戳>`——Scheduler 重启竞态下同一计划点
  不双发。
- **跳过错过窗口**（裁定 B）：`nextAfter(now)` 天然只算未来点；lastRunAt 供 UI 呈现
  「上次运行」。
- 时区：cron 按本机时区（桌面单机语义，不做时区配置——记档）。

### 风险与地雷

- cron 手写易错——预览「下次触发时间」是硬需求（写错立刻看见）；
- 定时消息撞上 agent 正忙——user lane 排队天然解决 ✓（如实排队）；
- Scheduler 定时器孤儿——dispose 清理（P7 relay 同款纪律）。

---

## ③ per-agent 模型覆盖——小轮（可并入 ①或② 尾巴）

### 目标与验收

每个 agent 可指定自己的模型端点（覆盖全局主力）；未指定继续继承。

### TODOLIST（2026-09-01 实施完成）

- [x] 1. **profile 扩展（state）**：`AgentProfile.modelProvider?`（引用档案名）；register 可选参数 +
  `setModelProvider`（null=清除回继承）；版本号+读取端兼容零迁移；单测 +1（落档/改写/清除/不存在）
- [x] 2. **装配分流（desktop kernel）**：`providerOfAgent`——指定档案 → `settings.resolve` 构造静态
  实例（运行中档案改 key 不热跟随，重启生效记档）；未指定 → 全局 SwitchableChatProvider（主力切换
  随动）。**双语义**：恢复路径悬空静默回继承 + console 告警（不炸装配）；命令路径悬空显式拒绝
  （SETTINGS_PROVIDER_NOT_FOUND——用户当下反馈）。重启恢复循环按 profile.modelProvider 分流。
- [x] 3. **命令面 + 向导 + ctx**：registerAgent schema 加可选 modelProvider；新增
  `v1.system.setModelProvider`（悬空校验，重启生效——UI 编辑入口记档后续，命令面已具备）；
  AgentWizard 第二步「模型」下拉（providers 档案列表 +「继承全局主力」缺省，选覆盖显示钉住
  说明；复核步 kv 反映覆盖）；ctx 档案模型 kv 真值（覆盖：名 / 继承全局主力（名））；
  RosterEntry.modelProvider 随 listAgents 透传。
- [x] 4. **E2E**：双 mock 端点断言分流——向导建 agent 选覆盖 B → 该 agent 对话走 B（**A 端点
  零请求**负向断言）→ ctx「覆盖：覆盖B」→ 管家对照走 A。3.5s 一次通过。

### 实施记档

- 覆盖引用档案**名**而非快照配置（端点改密码/换模型，agent 跟随档案更新）——但运行中的覆盖
  实例是 resolve 时静态构造（不热跟随），完整语义 = 「重启时跟随」——与全装配纪律一致，记档。
- 悬空双语义（恢复静默 / 命令显式）与沙箱 mock 回退同哲学——两路径的失败可见性需求不同。
- backlog ①②③ 全部收官；④computer-use ⑤Windows Sandbox 记档挂起。

### 设计要点

- 覆盖引用档案**名**而非快照配置——端点改密码/换模型，agent 跟随档案更新（不钉死旧配置）；
- 档案被删除时覆盖悬空——呈现「覆盖端点已删除（回退继承）」如实降级 + console 告警
  （不炸装配——降级语义与沙箱 mock 回退同哲学）。

---

## 排期

①（独立一轮）→ ②（独立一轮）→ ③（并入 ① 或 ② 收官尾巴；若单出则半天小轮）。
每轮开工前按惯例单独呈报该篇的实施确认。
