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

### TODOLIST

- [ ] 1. **AutomationStore（state）**：`<root>/automations.json`（全局文件非每 agent——
  规则跨 agent）——`{id, name, cron, agentId, prompt, enabled, createdAt, lastRunAt?}`；
  接口 list/upsert/remove；单测
- [ ] 2. **cron 解析与调度计算**：五段 cron 纯函数（解析 + `nextAfter(now)`）——不引库
  （语义可控可测；支持 `分 时 日 月 周` 基本语法 + `*`/`*/n`——复杂语法拒绝并给稳定码）；
  单测锁矩阵（每日 9 点/每 15 分钟/月底拒绝等）
- [ ] 3. **Scheduler（desktop main）**：装配时启动（setInterval 30s 扫 nextAfter 到点规则）；
  到点 → `messaging.sendUserMessage({toAgentId, text: prompt, nonce: automation:<id>:<ts>})`
  ——**复用 user lane 全管线**（排队/审批/watchdog/镜像 relay 全部继承，零新执行路径）；
  应用未连/agent 不在 → 规则如实标 `lastError`；dispose 清定时器
- [ ] 4. **命令面**：`v1.automations.list / upsert / remove`（zod；上限 16——裁定 C）
- [ ] 5. **UI**：设置页「自动化」节（列表：名称/周期/目标 agent/启停开关/删除 + 新建模态
  ——cron 输入 + 即时预览「下次触发：xx」防写错）；ctx「自动化」节真数据替换留位
- [ ] 6. **E2E**：短周期规则全链（注入 cron `*/1 * * * *` 每分钟太慢——支持测试时钟注入或
  env `OPENBOT_AUTOMATION_INTERVAL` 缩短扫描周期；断言 agent 收到 prompt 并回复）；
  全量回归
- [ ] 7. **文档与收官**：ARCHITECTURE §3.2/§4 desktop 职责补；PRODUCT 支柱兑现；版本同步

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

### TODOLIST

- [ ] 1. **profile 扩展（state）**：`AgentProfile` 加可选 `modelProvider?: string`（引用
  providers 档案名；upsert 时悬空名拒绝——同 fallbackProvider 的防悬空纪律）；单测
- [ ] 2. **装配分流（desktop kernel）**：`addAgent`/重启恢复路径按 profile 的
  modelProvider 解析对应 provider 实例（未指定 = 全局主力）；运行中切换主力不影响已覆盖
  agent（覆盖是钉死的——语义记档）；热切换不做（重启生效，与既有装配纪律一致）
- [ ] 3. **命令面 + 向导**：`v1.system.registerAgent` 加可选 modelProvider；
  AgentWizard 加可选「模型（缺省继承主力）」下拉；ctx 档案模型 kv 真值化
  （「覆盖：xxx」/「继承全局主力（xxx）」）
- [ ] 4. **E2E**：向导建 agent 选覆盖端点 → 对话走 mock 第二端点（双 mock 端口断言分流）；
  ctx kv 真值；回归

### 设计要点

- 覆盖引用档案**名**而非快照配置——端点改密码/换模型，agent 跟随档案更新（不钉死旧配置）；
- 档案被删除时覆盖悬空——呈现「覆盖端点已删除（回退继承）」如实降级 + console 告警
  （不炸装配——降级语义与沙箱 mock 回退同哲学）。

---

## 排期

①（独立一轮）→ ②（独立一轮）→ ③（并入 ① 或 ② 收官尾巴；若单出则半天小轮）。
每轮开工前按惯例单独呈报该篇的实施确认。
