# 跨用户房间协议（CrossUserRelay · v1）

> 状态：P7 实现文档 + 自托管指南。架构依据 [ARCHITECTURE.md](../ARCHITECTURE.md) §3.5/§5；
> 协议层实现 `packages/messaging/src/xuser/`（信封/预算/幂等/退避纯函数），
> host 实现 `apps/relay/src/`，桌面接入 `packages/transport/src/relay-client/` + desktop 装配。

## 0. 本地优先（先读这一节）

**relay 是自托管软件，OpenBot 官方不运营任何公共服务。**

- 推荐形态：与好友共用一个 **Tailscale**（或任意 WireGuard/自组网）网络，其中一台机器自建
  relay host——流量全程在加密隧道内，host 自身无需 TLS；
- 公网裸跑不推荐：host 只带 invite 码认证与朴素限速（见 §5），**没有** TLS/WAF/防滥用治理；
  确需公网，请在 host 前加反代终结 TLS（Caddy/nginx 均可，websocket 透传即可）；
- 一切「远端内容」在呈现侧必过 DOMPurify（desktop 渲染链已内置，协议约束不靠自觉）。

## 1. 模型（mirror 一期，2026-09-01 裁定 B）

- **房间（room）**：host 上的临时命名空间。建房得 `roomId`（公开短码）+ `inviteCode`
  （256bit 熵凭据）。成员上限缺省 8；全员离线 10 分钟自动回收（公网面不留常驻状态）。
- **成员（member）**：一条 WS 连接即一个成员，host 分配 `m-N`。displayName 仅呈现用。
- **两条通道，一进一出**：
  - **mirror 出站**：本端对话事件（用户消息/agent 终答）只读镜像给房间其他成员；
  - **turn 入站**：远端成员对本端发起 turn-request（请求执行），本端执行完回 turn-result。
    **远端不能向本端投递任意消息**——这是安全模型的根（受控协作，非自由消息面）。
  - 本端主动向远端发 turn（协议对称、host 路由已支持）：一期无 UI 入口，记档后续版本。

## 2. 线上信封（zod strict——公网输入不可信的第一道防线）

WS 单帧 JSON，UTF-8 文本，**maxPayload 64KB**；单条 text ≤ 8000 字符；标识符
`[a-zA-Z0-9:_#-]{1,128}`。三种客户端信封 + 两种服务端下发：

| kind | 方向 | 关键字段 |
|---|---|---|
| `mirror-message` | client → host → 房间 | nonce / fromMemberId / speakerKind(user·agent) / speakerName / text / sentAt |
| `turn-request` | client A → host → client B | nonce / requestId / fromMemberId / toMemberId / prompt / agentHint? |
| `turn-result` | client B → host → client A | requestId / fromMemberId / status / text / remaining? |
| `hello` | host → client（入场回执） | memberId / room{roomId, createdAt, members[]} |
| `room-event` | host → client | event(member-joined·member-left) / memberId / displayName |

- `status`：`ok` / `rejected`（本端拒绝或 run 失败）/ `timeout` / `budget-exhausted` /
  `unreachable`（目标不在场——诚实状态，不冒充 rejected）；
- `sentAt` 仅呈现排序用——**预算判定一律 host 时钟**（客户端时钟不可信）；
- **身份以连接为准**：信封里的 fromMemberId 与 WS 连接身份不符 → host 直接断连（伪造面收敛）。

## 3. 预算、幂等与退避（§3.5 协议承诺的兑现）

- **预算**：每请求方向（`from→to`）10 分钟窗口 30 turn，**host 侧账本是单一事实源**
  （双端各自记账必双花）。拒绝不占预算；`remaining` 随 result 由 host 下发，客户端不本地推算。
  host 可经 `OPENBOT_RELAY_BUDGET_TURNS / OPENBOT_RELAY_BUDGET_WINDOW_MIN` 覆盖。
- **幂等**：turn-request 的 `nonce` 首见受理、重放回**缓存的同一应答**（网络重试拿同一结果，
  不重复执行不重复扣预算）。结算缓存保留窗口时长后清除。
- **退避**：客户端断连重连用指数退避 + 乘性 jitter（`min(base·2^(n-1), max)`，
  缺省 1s→5min，jitter 0.2）——多客户端同时断连不打挂 host。**attempt 只在真正入场
  （hello）后复位**：闪断循环（连上即掉）持续爬升档位，不反复以首档打 host。
- **turn 回程**：host 记 pending 表 `requestId → {from, to, nonce}`；result 到达校验
  执行端身份（防第三成员伪造应答）后转发发起端并落幂等缓存。

## 4. 本端受理语义（desktop 装配）

- turn-request 到达 → `agentHint` 按名册名匹配（无 hint/未匹配 → steward）→ 作为
  **用户消息入队**（user lane 同级，2026-09-01 裁定 D）——排队、审批闸门、watchdog、
  中止链路与本地消息完全一致，**零新特权路径**；
- 终答（`v1.message.agent`）→ turn-result `ok` 回程；run 失败/中止（`v1.lifecycle.finished`
  非 succeeded）→ `rejected`（带状态码）如实回程；
- 远端成员在本端名册是**易态投影**（`v1.system.remote-members` 事件，hello 重建、
  不持久化、不参与本地调度/建群——社交面成员而非执行面成员）。

## 5. 安全基线（一期朴素版，如实）

| 面 | 现状 | 记档 |
|---|---|---|
| 认证 | invite 码 256bit 熵（WS query 携带）；建房可选 `x-create-token` | 成员密钥对签名：后续版本 |
| 隔离 | fanout 严格按房间 membership（单测锁「房间间零泄漏」） | — |
| 限速 | 每成员 1 秒 10 条（超限断连 4429） | 令牌桶/WAF 级：不做（自托管边界） |
| 消息 | maxPayload 64KB + schema strict + 文本 8k 上限 | — |
| TLS | 不内建——反代终结或 Tailscale 隧道 | 内建证书管理：不做（运营面） |
| 净化 | 远端内容呈现侧 DOMPurify（E2E 锁 script 注入被清） | — |

## 6. 自托管

### node 进程

    pnpm build && pnpm --filter @openbot/relay start

env：`OPENBOT_RELAY_PORT`（显式端口，**被占即报错退出**——不自动改不杀进程；缺省随机端口
见启动日志）、`OPENBOT_RELAY_CREATE_TOKEN`（公网防刷房）、预算覆盖（§3）。

### Docker

    docker build -f apps/relay/Dockerfile -t openbot-relay .
    docker run -p 8080:8080 openbot-relay   # 缺省 OPENBOT_RELAY_PORT=8080

多阶段构建 + esbuild 单文件 bundle（镜像不带 node_modules）。**Docker 镜像构建真机未验收**
（本机无 Docker 环境——纸面配置就绪，环境可用后按同命令验证）。

### systemd（示例）

    [Unit]
    Description=OpenBot relay host
    After=network-online.target

    [Service]
    User=openbot
    ExecStart=/usr/bin/node /opt/openbot-relay/index.js
    Environment=OPENBOT_RELAY_PORT=8080
    Restart=on-failure

    [Install]
    WantedBy=multi-user.target

### 接入（desktop）

设置页路径已迁移：**「跨用户房间」视图**（rail 第六 tab）→「添加房间」/「房间设置」。
填 host WS 地址 / 房间码 / invite 码 / 本端呈现名（可按房不同）/ 房间备注名（可选），启用并
**重启**（连接是装配期决策，与沙箱偏好同语义）。**多房间并行接入**（P7 多房间轮）：配置列表
增删改，桌面同时连接多个房间——本端对话镜像广播到全部已连接房，远端成员按房分组呈现
（预算/幂等天然按房隔离——host 侧每房独立账本）。env `OPENBOT_RELAY_URL/ROOM/INVITE/NAME`
单组可作额外一路叠加（E2E/无头接入通道）。

## 7. 协议面 API 一览（host）

| 路径 | 方法 | 说明 |
|---|---|---|
| `/api/health` | GET | `{ok, rooms}` |
| `/api/rooms` | POST | 建房 → `201 {roomId, inviteCode}`（设 createToken 时须带 `x-create-token`） |
| `/ws?room&invite&name` | WS | 入场（鉴权失败断连 4404；满员 4409；脏信封 4400；超频 4429） |
