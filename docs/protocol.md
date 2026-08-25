# 协议规范（v1 · 骨架）

壳与内核之间唯一的边界：环回网关。协议只含**领域事实与命令**，永远没有 UI 指令
（「打开弹窗 / 刷新视图」不进协议）；错误与状态传稳定 code，不传文案——文案与
多语言归渲染层（ARCHITECTURE.md §5、§8 解耦纪律）。

## 三通道

| 通道 | 方向 | 用途 |
|---|---|---|
| POST /api/* | 壳 → 内核 | 控制面：全部命令幂等可重试（nonce） |
| GET /events | 内核 → 壳 | SSE 事件流；Last-Event-ID 续传 |
| WS /stream | 双向 | 数据面：Box 实况帧、文件传输（二进制帧 + 背压） |

## 七族事件（v1.*）

| 族 | 内容 |
|---|---|
| v1.lifecycle | run 生命周期（排队 / 运行 / 退避 / 失败——状态永远诚实） |
| v1.message | 用户消息、agent 回复、A2A、群聊轮次 |
| v1.task | 任务与产物（diff / 文件） |
| v1.box | Box 状态与 caps 能力协商 |
| v1.approval | 出 Box 闸门审批（nonce 幂等） |
| v1.graph | 社交图谱（委派边 + 消息边并存） |
| v1.system | roster 与角色变更（含 steward 任命）等 |

## 环回安全

1. 只绑 127.0.0.1 随机端口；2. preload 注入 bearer token；3. Host 头校验防 DNS rebinding。

## WS /stream 帧协议（v1，P2 定案）

一个 WS binary message = 一个完整协议帧（WS 自带消息边界）。帧头 14 字节 big-endian：

```
u8 版本(=1) | u8 帧类型 | u32 流 ID | u32 帧序号 | u32 负载长度 | 负载…
```

| 帧类型 | 值 | 方向 | 说明 |
|---|---|---|---|
| OPEN | 0x01 | 双向 | 打开流；负载 JSON `{ kind: 'frames'\|'file', boxId?, meta? }` |
| DATA | 0x02 | 双向 | 数据块 ≤ 256KB；序号流内连续 |
| END | 0x03 | 双向 | 正常结束 |
| ABORT | 0x04 | 双向 | 异常中止；负载 JSON `{ reason? }` |
| PAUSE | 0x05 | 接收方→发送方 | 背压：暂停指定流（流 ID=0 表示全流） |
| RESUME | 0x06 | 接收方→发送方 | 恢复；发送方须补发暂停期间入队的块 |
| ACK | 0x07 | 接收方→发送方 | 确认；seq 字段=已连续收到的最高帧序号 |

- 流 ID 连接内单调分配不复用（0 保留连接级）；OPEN/DATA/END/ABORT 的 seq 从 0 起流内连续，接收方校验；PAUSE/RESUME/ACK 是带外信号不占序。
- 协议违规（坏帧/序号跳跃/未知流）→ 接收方断连。P2 只回环自测，真实信号源 P3 接入。

## wire 校验与错误 code

- 命令 payload：注册命令时可带 zod schema（`InProcessTransport.register` 第三参），不过 schema → envelope `TRANSPORT_PAYLOAD_INVALID`。
- 事件 payload：`@openbot/transport` 的 `EventPayloadSchemas`（16 类型，与 core `KernelEventMap` 编译期双向断言防漂移）。
- 错误 code 目录：命令领域失败按 KernelError code 原样透传；传输层见 `GatewayErrorCodes`/`TransportErrorCodes`/`StreamErrorCodes`（均在 `@openbot/transport` 导出）。

## 遥测与压力事件（plan-p3 Step 6）

- `v1.box.stats`：`{ boxId, cpuPercent?, memoryMb?, diskMb? }`——StatsService 定时轮询（默认 10s，开机先立即拍一轮）逐盒发出；**字段可选，缺席=后端不可测**（WSL 只有 diskMb=ext4.vhdx 体积；mock 三字段模拟值）。最新值语义：消费方每盒留最新，重放过期遥测幂等。
- `v1.system.pressure`：`{ dimension:'disk', level:'ok'|'warn'|'critical', freeBytes, totalBytes }`——宿主磁盘压力（**派生量归内核**：判定在 StatsService，探针由装配方注入——桌面用 fs.statfs userData 所在卷）。只在状态转移时发（ok→warn→critical→ok）；纯事实无文案（文案归渲染层）；阈值 warn 8GiB / critical 3GiB（env `OPENBOT_DISK_WARN_BYTES` 覆盖，critical 取其半——E2E 确定性）。

## 待填充（P3）

- WS /stream 真实信号源接入（Box 实况帧、文件传输路由）
- v1.task / v1.graph 事件族落地（P2 backlog）
