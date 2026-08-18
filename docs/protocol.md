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

## 待填充（P1）

- 命令目录：POST /api/* 的请求 / 响应 schema（zod）
- 事件 payload schema（zod）与错误 code 枚举
- WS 二进制帧格式与背压语义
