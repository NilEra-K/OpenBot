# OpenBot 项目架构（工作摘要）

> 本文是 [ARCHITECTURE.md](../../ARCHITECTURE.md) 的速查版：只收录日常开发必须随身携带的规则与结论。
> 与 ARCHITECTURE.md 冲突时，以 ARCHITECTURE.md 为准；架构变更须先更新 ARCHITECTURE.md 再同步本文。

## 八包依赖图（只许向下）

```
core        ← 谁都不依赖（纯逻辑，无 I/O）
llm         ← 谁都不依赖
state       ← core（只借事件类型）
boxes       ← core（只借事件类型）
transport   ← core（事件族定义）
messaging   ← core, state
runner      ← core, state, messaging, llm, boxes   ← 唯一同时认识「消息」和「执行」的包
coordinator ← 以上全部（全项目唯一被允许全知的装配根）
```

**三条铁律（构建期强制，review 一票否决）：**

1. **依赖只许向下**；循环依赖 = 构建失败。
2. **coordinator 是唯一装配根**——只有它 import 全家；业务代码之间不横向装配。
3. **壳只许 import transport 的客户端**——desktop/cli 不直接 import 内核任何包。

## 各包一句话职责

| 包 | 职责 | 关键约束 |
|---|---|---|
| `core` | 三 lane 排他调度、watchdog/zombie 逃逸、事件族定义 | 纯逻辑零 I/O，不 import 任何包 |
| `state` | JSONL transcript、幂等账本（nonce+digest）、agent 档案（含 role）、box 目录 | append-only；原生依赖禁止入内 |
| `llm` | provider 抽象：openai-compat（fetch+SSE 零 SDK）/ anthropic / mock | 薄客户端；base_url+代理是国内刚需 |
| `boxes` | BoxBackend + caps 能力协商；wsl/docker/mock 三后端 | 接口按 caps 设计，不按「最强后端」设计 |
| `messaging` | A2A/群聊(有界轮转)/广播/subagent + 一主多从组织模型 | steward 唯一性由 state 层排他事务强制；群聊 leaderless |
| `runner` | turn 执行、in-box 工具族、出 Box 闸门（gate/approval） | 闸门审批复用幂等账本，重试不双弹窗 |
| `transport` | in-proc bus + 环回网关（POST /api + SSE /events + WS /stream） | 壳与内核之间唯一边界；loopback+token |
| `coordinator` | 装配根：把上面全部装成系统，经 Carrier 暴露给 transport | 全项目唯一 import 全家的地方 |

## 进程拓扑

- **v1（当前）**：内核单进程运行在 Electron main（InProcessCarrier）——utility process 拆分是预留缝（Carrier 接口），不是现状。
- **拆分触发条件**（明确后才做）：内核崩溃拖垮壳 / 长任务 GC 卡 UI。拆分时补退出码契约 + 指数退避重启。
- 渲染层 sandbox、无 Node、无特权，只经环回网关说话。

## 传输协议速记

- 三通道：`POST /api/*`（控制面，全部幂等可重试）、`GET /events`（SSE 七族事件）、`WS /stream`（Box 实况帧等数据面）。
- 七族事件：`v1.lifecycle / v1.message / v1.task / v1.box / v1.approval / v1.graph / v1.system`。
- **协议纯度**：只有领域事实与命令，永远没有 UI 指令；错误传稳定 code（如 `BOX_SNAPSHOT_UNSUPPORTED`），不传文案。
- 环回安全：仅监听 127.0.0.1 随机端口 + bearer token + Host 校验——本机网关是真实攻击面。

## boxes 三态与能力协商

- 三态：`active`（在跑）/ `sleeping`（暂停保留）/ `snapshot`（冻结可回滚）。
- `caps` 是能力单一真相源：`persistent / snapshot / headless / resourceLimits / isolation`；上层 UI 据此禁用不可用操作，永不假设后端能力。
- mock 后端与真实后端接口完全对称——测试与 CI 的确定性地基。

## 状态与持久化

- transcript = JSONL append-only = 源头真相（崩溃安全、可 grep、可人工检查）。
- 每 agent 一目录：`transcript.jsonl / memory.json / automations.json / profile.json / settings.json / group.json`。
- 幂等账本贯穿三条链路：消息发送、任务提交、闸门审批。
- API key 走 Electron safeStorage（DPAPI）加密落盘，永不明文。
- 后继：规模瓶颈时迁 `node:sqlite`（Electron 内置，无原生编译）；JSONL 地位不变。

## 渲染层（P2）

- Vue 3 `<script setup lang="ts">` + Pinia + Vite；五视图对齐 prototype：console / boxes / tasks / graph / settings。
- 解耦硬规则见 [ui-logic-separation.md](ui-logic-separation.md)（七铁律，review 一票否决）。
- 渲染 markdown 一律 markdown-it + DOMPurify。

## ADR

11 条决策记录（语言、许可证、Electron、pnpm、纯 tsc、Vue3、三通道、JSONL、自研 LLM 客户端、boxes 抽象、Carrier）全文见 ARCHITECTURE.md §14。推翻任何一条须走新 ADR，不许静默变更。
