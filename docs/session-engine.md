# 会话引擎 v2 设计（ContextComposer / Compactor / UsageLedger）

> 2026-10-31 用户裁定立项。背景：当轮图片在工具循环每轮重发被端点拒绝（`messages[35].image[0]` 400 报障）暴露会话供给缺 token 感知与分层管理；50 条硬滑窗是条数口径不感知内容体量。
> **用户裁定**：① 自动 compact **默认开** + 提供 `/compact` 命令；② P1 随本轮图片修复落地。
> 参照：Claude Code 的分层供给（常驻层/auto-compact 摘要层/活动层/大对象落盘按需重取/usage 驱动）。

## 设计原则

1. **transcript append-only 不动摇**——新机制都是「记录 + 读取端解释」（版本号+读取端兼容）；
2. **token 感知取代条数感知**——50 条滑窗退役，预算驱动；
3. **降级阶梯先于丢弃**——长内容逐级降质（截断→注记→摘要），整轮丢弃是最后手段；
4. **实测优于估算**——usage 反馈环校准密度（v0.1.113 backlog 并入本设计）；
5. **协议纯度**——引擎全在内核 runner 层；usage 是遥测不进事件总线（走落盘+只读命令面）。

## 分层架构

```
L0 事实层：transcript JSONL（append-only）——新增 kind:'compact'
L1 视图层：sessionView（revision/tombstone/clear 解释）+ compact 软标记（coveredSeq 切片）
L2 组装引擎 ContextComposer（runner）——预算分配/分层组装/降级阶梯/图片首轮消费
L3 摘要引擎 Compactor——手动 /compact + 自动触发（默认开）→ 摘要落 compact 记录
L4 反馈环 UsageLedger——usage.prompt_tokens 滚动密度 → 校准预算估算 + 水位呈现
```

## ContextComposer（P2 核心）

**总预算** = 窗口档位（128k/1M）× 85% − 常驻层实测（system+身份+工具定义，usage 反推）。

**组装序**：

```
[system + 身份/群成员表]      常驻层（恒在）
[compact 摘要（若有）]        摘要层（≤ 总预算 12%）
[sessionRef 引用注入]         引用层（现状 4000 字符，保留）
[近期轮次：新→旧逐轮纳入]     活动层（剩余预算装满为止）
[当轮消息 + 附件]             当轮层（附件预算制 v0.1.113）
```

**活动层纳入**：逐轮（user→…→agent）回溯，计入 estTokens（双计公式，L4 校准后替换系数）；预算不足时对最老待纳入轮走**降级阶梯**：

- 级① 工具输出截断：exec 结果 >4k 字符 → 头尾各 1k +「（中段 N 字符已存档）」；
- 级② 轮内瘦身：user 摘句 + agent 终答首段 +「（N 轮工具过程已省略）」；
- 级③ 整轮丢弃并计数（触发 compact 的信号）。

## Compactor（P2/P3）

**compact 记录**（append-only，读取端兼容）：

```jsonc
{ "seq": 123, "kind": "compact", "payload": {
  "summary": "结构化摘要（决定与约定 / 关键事实与文件 / 未完事项 / 有效附件清单）",
  "coveredSeq": 122, "keptRounds": 6,
  "trigger": "manual" | "auto", "focus": "可选焦点指令", "byRun": "…-run-…" } }
```

- 摘要 = 一次独立 llm 调用；组装时活动层从最后 compact 的 `coveredSeq` 之后取（同 `/clear` clearIdx 模式）；
- 原始记录全在 transcript（可追溯；undo 不在 v1 范围）；
- **触发**：手动 `/compact [焦点]`；**自动默认开**（裁定①）——级③发生即触发本轮后压缩（异步，不阻塞当前 run；下一 run 起生效）；
- 群聊按群流键独立 compact（成员共享摘要层）——P3。

## 附件与图片策略（统一表）

| 阶段 | 文本附件 | 图片 |
|---|---|---|
| 当轮首请求 | 全文/预览（预算制） | image part |
| 工具循环第 2 轮起 | 不变（已在 messages） | **降级注记**（P1） |
| 历史轮 | 文件名注记（现状） | 文件名注记（现状） |
| compact 后 | 摘要含关键附件清单 | 同左 |

## UsageLedger（P1 起步）

- 落盘：`data/agents/<id>/usage.jsonl`，append：`{ at, model, promptTokens, completionTokens, estChars, estBytes }`；
- 链路：provider（openai-compat 流式开 `stream_options.include_usage`；anthropic 天然带）→ `ChatResponse.usage?` → runner `deps.recordUsage` 注入（壳层实现落盘，runner 环境无关）；
- 密度系数 = promptTokens/est 滚动均值（衰减权重）——P3 替换静态双计系数；
- 只读命令面：`v1.usage.latest {agentId}`（水位条数据源；usage 不进事件总线）。

## UI（P1 水位 / P2 注记）

- **水位条**（P1）：composer 角落微型计量 `■■■□□ 62%`（最近 usage 实测 / 窗口档位），hover 明细；会话切换与每 30s 刷新；
- **compact 注记**（P2）：会话流系统行「已压缩：摘要 + 最近 N 轮（覆盖至 #seq）」。

## 分期

| 期 | 内容 | 状态 |
|---|---|---|
| **P1**（v0.1.115） | 图片首轮消费（工具循环第 2 轮降级注记）+ 400 文案细分（image 关键词）+ usage 采集落盘（三 provider 透传）+ 水位条（只读） | 本轮实施 |
| **P2**（下版本） | ContextComposer（token 窗口+降级阶梯，替代 50 条）+ compact 记录 + 手动 /compact + compact 注记 | 排期 |
| **P3** | 自动 compact 触发链（默认开）+ 密度自适应替换静态系数 + 群聊 compact | 排期 |

> 涉及：`packages/llm`（usage 透传）/ `packages/runner`（Composer+图片降级）/ `messaging`（/compact）/ `state`（读取端解释）/ 壳与渲染（落盘+水位）。架构变更同步 ARCHITECTURE.md（P2 落地时）。
