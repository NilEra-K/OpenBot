# P7 实施计划（relay：跨用户房间公网 host）

> 状态文档：随实施推进更新勾选与「设计要点」。架构依据 [ARCHITECTURE.md](../ARCHITECTURE.md)
> §3.5（CrossUserRelay 协议保留行）、§4（apps/relay = Hono + WS）、§5（线上协议复用与净化约束）、
> §11 P7 行；产品叙事 [PRODUCT.md](../PRODUCT.md)（hosted/mirror、远端 mirror 成员、P2P 优先）。
> 与架构文档冲突时以 ARCHITECTURE.md 为准。
> 上阶段记录见 [plan-p6.md](plan-p6.md)（P6 已收官——六后端矩阵收敛、win 打包链落地）。
> 协议占位现状：`packages/messaging/src/xuser/` 仅 `export {}`（空壳）；`apps/relay/` 仅
> package.json + README（占位字样随本轮更新）——P7 从协议定义起步。

## 目标与验收

兑现 §11 P7 行：**跨用户房间公网 host + CrossUserRelay 实现**，P2P/Tailscale 优先叙事落地。

- **协议四件套兑现**（§3.5 原文承诺）：turn-request/result（跨用户请求-应答信封）、
  10 分钟窗口 30 turn 预算（host 侧账本单一事实源）、不可达退避（指数 + jitter）、
  nonce 幂等（重放不双花）；
- **hosted/mirror 双形态**（PRODUCT §范围）：host 房间 + 本端名册的「远端 mirror 成员」；
- **验收**：单测覆盖协议纯函数（预算/幂等/退避判定）与 host 内存态（房间隔离/fanout/认证）；
  E2E 起真 relay host + 桌面接入 + 脚本化对端走一轮跨用户 turn（request → 本地执行 → result
  回程 → 预算扣减可见）；`pnpm build && pnpm typecheck && pnpm test` 全绿；既有 E2E 不回退；
- **本地优先叙事纪律**（风险 #9 兑现）：relay 是**自托管软件**——官方不运营公共服务；
  协议文档第一节写明「优先 Tailscale/自组网内自建，公网暴露自担风险」；
- **不夸大纪律延续**：远端内容渲染必过 DOMPurify（§5 既有约束复核不绕过）；
  未做的安全面（TLS 终结/限速细节等）如实记档不假装。

## 已裁定的范围（2026-09-01 批准时表态落位——四项均按推荐执行）

| 项 | 裁定 | 记档 |
|---|---|---|
| A. host 部署形态 | **b) node 进程 + Dockerfile** | `pnpm start` 底座 + 多阶段 Docker 镜像（自托管分发面完整）；官方实例涉运营承诺不做 |
| B. 房间模型深度 | **a) mirror 一期** | 本端对话镜像给房间 + 远端 turn-request 受控进入；远端不自由发消息——完整双向待一期实测后评估 |
| C. 身份与认证 | **a) 预共享 invite 码** | 256bit 熵码即凭据（WS 握手携带）；成员密钥对记档后续版本 |
| D. 远端 turn 执行面 | **a) 进本地排他队列走审批** | 远端请求 = user lane 同级，steward 调度 + 审批闸门照走——复用既有链路，零新特权路径 |

## TODOLIST

- [x] 1. **协议定义（messaging/xuser）**：房间与成员模型（remote mirror 成员进 roster 的数据形状）、
  turn-request/result 信封（zod）、预算账本接口（窗口/上限纯函数）、nonce 幂等表接口、
  退避策略纯函数（指数 + jitter，可注入随机源）；单测锁语义（预算双花/重放/退避序列）
- [x] 2. **relay host（apps/relay）**：Hono HTTP 面（房间创建/加入/健康检查/invite 码生成）+
  WS 数据面（成员连接、房间内 fanout、turn-request/result 路由）；host 侧预算账本与 nonce 表
  （单一事实源）；房间隔离（房间间事件零泄漏）+ WS 消息大小上限 + 简单限速；单测（内存态 +
  假 WS 客户端脚本化替身）
- [x] 3. **部署形态（裁定 A）**：node 进程启动链（含 OPENBOT_RELAY_PORT 等 env 约定，遵守端口
  规则）+ Dockerfile（多阶段构建，镜像内仅 runtime 依赖）+ 自托管文档（systemd 单元示例/
  Tailscale 组网建议——P2P 优先措辞落点）
- [x] 4. **桌面接入（transport 或新 relay-client 模块）**：出站 WS 连接管理（重连=退避策略复用）、
  认证（房间码）、房间事件 → 本地事件总线的桥接（v1.* 族映射，不发明新族——新增
  v1.message.remote / v1.system.remote-members 两键）、远端成员镜像进 roster（remote 标记 +
  身份色中性档）；settings 增房间配置（host 地址/房间码/启停）
- [x] 5. **跨用户 turn 链路**：远端 turn-request → 本地排队（user lane 同级，裁定 D）→ 审批闸门
  照走 → 执行 → result 回程；预算扣减与耗尽呈现（退避中/预算尽如实状态）；不可达退避
  （host 断连时本地出站请求的队列与重试语义）
- [x] 6. **UI 呈现**：名册远端成员节（mirror 标记）、会话流远端消息署名与来源标识、图谱远端边
  （弱化样式区分本地社交）、设置页房间区块；**远端内容 DOMPurify 净化复核**（既有渲染链
  全覆盖断言——远端路径不绕过）
- [x] 7. **E2E**：playwright 编排真 relay host（随机端口）+ 桌面接入 + 脚本化对端 ws 客户端
  （第二成员）——建房/加入/mirror 到达/远端 turn-request 本地审批执行/result 对端收到/预算
  扣减与耗尽/断连退避重连；既有 21 用例不回退
- [x] 8. **文档与架构同步**：协议文档 docs/relay-protocol.md（第一节=本地优先与 P2P/Tailscale
  优先措辞——风险 #9 兑现；信封/预算/幂等/退避/安全基线如实）；ARCHITECTURE §3.5 协议保留行
  改「已实现」+ §5 补公网面安全条 + §11 P7 行勾验收；apps/relay 占位字样更新（README/package.json
  的 P5 字样）；README 分发说明补 relay 自托管节；plan-p7 勾选记档；版本同步
- [x] 9. **收官复查**：`pnpm build && pnpm typecheck && pnpm test` + E2E 全量（既有 21 + 新增）
  全绿确认；验收对照 §11 P7 行逐项核；安全自查（房间隔离/认证/限速/净化四项过一遍）

## 实施记档（2026-09-01）

- **Step 1（xuser 协议层）**：信封 zod strict（8k 文本上限/64KB 帧/标识符形状——公网输入
  第一道防线）、TurnBudgetLedger 滚动窗口（方向独立、拒绝不占预算）、TurnIdempotency
  （重放回缓存、悬空占位随窗口释放）、backoffDelay（指数封顶 + 对称乘性 jitter，随机源注入）。
  9 例单测（预算断言笔误一处：maxTurns=2 允许两次 admit——测试算错非实现错）。
- **Step 2（host）**：12 例真 server 随机端口全链。**实测坑①**：`@hono/node-server` 的
  serve() 立即返回但 listen 异步——address() 为 null，须等 listening 事件（显式端口被占时
  error 事件如实抛出——端口规则的实现面）。**坑②**：测试 URL 尾斜杠 `/ws/?x` 不匹配
  wss path `/ws`——ws 库直接 400，表象是全员连不上。**坑③**：服务端鉴权拒绝发生在握手后
  （open 先触发）——「被拒」断言要等 close 事件的 code（4404/4409），不能期望 connect
  reject。伪造面收敛：fromMemberId 与连接身份不符断连；伪造 result（非 pending.to 身份）
  不转发且消费 pending（防伪造优先于可用性——真应答同 requestId 到达时已无 pending，如实丢弃）。
- **Step 3（部署）**：esbuild 单文件 bundle + banner createRequire（P6 坑①同型复发同修）；
  **Docker 镜像构建真机未验收**（本机无 Docker 环境——纸面配置就绪记 relay-protocol §6）。
- **Step 4/5（接入与 turn）**：RelayClient（schema 客户端侧即拒/退避重连/孤儿定时器清理）；
  **attempt 复位点在 hello（入场）而非 open**——闪断循环不反复以首档退避打 host（单测锁
  100→200→400 爬升 + 入场复位）。事件族不新发明：只加 `v1.message.remote` 与
  `v1.system.remote-members` 两键（core map + transport schema 双侧，防漂移断言自动覆盖，
  schema 计数 16→18）。turn 入站 = sendUserMessage 入队（agentHint 名册名匹配、缺省 steward）
  + 终答（v1.message.agent）/非正常收敛（v1.lifecycle.finished 非 succeeded）双路配对回程。
  **实测坑④（P6 坑的变体）**：electron-builder 的 bundle 产物与 tsc 增量共存——tsbuildinfo
  认为已编译不重写 dist/main，E2E 打到无 relay 命令的 P6 旧产物（表象「未知命令
  v1.relay.status」）——rm dist 重建后即好；dist script 链此后每次都完整重建（bundle 覆盖
  tsc 产物的场景仅打包时存在，开发态注意即可）。
- **Step 6（UI）**：**实测坑⑤**：ConsoleView 流组装循环没有 msg-remote 分支——远端消息落进
  relay 跳转按钮（坏跳转 to:'user'），模板的 remote 卡永远不渲染（事件链全通但 DOM 不出现，
  诊断日志定位）。设置页状态行**事实优先**：env 通道接入时 settings.enabled=false 而连接
  为真——状态读 kernel.relay.connected 而非表单草稿值；连接态易变（boot 快照过期），进
  设置页现拉。
- **Step 7（E2E）**：真 host + 脚本化对端（ws 直连）全链 2.0s：入房/名册远端节/mirror 双向/
  DOMPurify（script 注入被清 + markdown 不误伤 + window 未被污染三层断言）/turn 受理回程/
  同 nonce 重放拿同一缓存/设置页自托管叙事在场。
- **Step 8/9（文档与收官）**：relay-protocol.md（§0 本地优先钉死——风险 #9 兑现；安全基线
  表如实含「不做」项）；ARCHITECTURE 五处同步。三命令零错/347 过 + 6 skipped（较 P6 基线
  +25：xuser 9 + relay 12 + relay-client 5 − 计数调整）；E2E 21/22（唯一失败仍为 P6 记档的
  「中止工作中的 agent」既有 flaky——修法待裁定延续）。本端主动向远端发 turn（协议对称、
  host 已支持）一期无 UI 入口，记档后续版本。版本 0.0.30 同步。

## 原型对齐轮（2026-09-01 · P7 收官后追加）

对照 prototype.html 全量复核，三主项差距收敛（P4 对齐时 rooms 视图记档为 P7 域——本轮兑现）：

- **rooms 视图**（原型视图 5 迁移）：rail 第六 tab（地球图标，graph/settings 间）+ RoomsView
  房间卡——成员链（mchip/mdot/mrole 原型样式迁移）、relay 事实 kv、动作行（复制邀请信息 =
  房间码+invite 码进剪贴板/房间设置模态/打开房间对话）。**演示值纪律**：原型「12/30 预算、
  04:12 倒计时、142ms 延迟」不照搬——本端是 mirror 执行端视角，预算余量 host 只下发发起端
  （协议事实），余量 kv 与 meter 本端不可见即不画；kv 呈现的是协议机制描述与连接/成员真值。
  「我托管/我是访客」双卡为一期后域（无建房 UI 与被托管语义）记档。设置页房间区块**迁入**
  rooms 视图模态（原型 settings 无 relay 段——恢复原型五节形态）；relay settings 加可选
  roomName（备注名，房间卡显示，缺省回退房间码）。
- **远端成员会话归属**：原型远端成员是名册正式成员（Delta）——远端节可点开自己的 mirror
  会话（activeAgentId 命名空间 `remote:<memberId>`）；远端消息撤出管家会话按 from 归属；
  composer 只读态（placeholder 注明——协议无本端自由发消息语义）；ctx 远端档案（在场/离场、
  无 Box 如实、执行通道=turn 经审批）。
- **图谱远端**：远端节点（info 蓝圆 + 在场/离场状态点）+ user↔远端 虚线 remote 边
  （gedge.remote 原型样式；store 的 v1.message.remote 投影 bumpEdge）+ 图例行 + 节点详情
  类型 kv；主题补 `--info/--info-rgb`（原型 :root 同值，日夜双份）。
- **实测坑⑥**：CtxPanel 插入 remotePeer 分支误用独立 `v-if`（把 agent 分支的 `v-else` 挂到
  它身上——群会话双档案渲染，群聊 E2E 抓到）；修为 `v-else-if` 链。
  **坑⑦**：RoomsView SFC 漏写 `<script setup>` 开标签（compiler-sfc 报「Element is missing
  end tag」在 script 行——表象有误导性）。
- 收官：三命令零错/347+6 skipped 不变；E2E 21/22（relay 用例扩断言：远端会话归属/只读态/
  rooms 视图/设置页收窄；群聊用例回归绿）；版本 0.0.31。

## rooms 视图 UI 修复轮（2026-09-01 · 用户实测反馈）

- **空态重做**：居中竖向节奏（大地球图标 info 弱色 → 标题 → 一句话 → primary 主按钮 →
  三步引导胶囊「建房/分享/配置重启」）+ 底部自托管注脚（两态恒在）——替换左侧孤悬素卡；
  view-sub 压成一句产品语义（协议四件套叙事撤出副标题——房间卡 kv 与注脚承载）。
- **三族公共控件样式补齐（根因修复）**：项目惯例是每视图 css 自带控件副本（boxes/console/
  graph/settings 四处皆有）——RoomsView 新建时漏带，模态 wiz-*、按钮 btn-*、输入框 field-*
  三族全部缺失，渲染为浏览器裸样式（用户实测「不是模态框」「按钮输入框丑」的根因——
  不是审美问题是样式没带上）。rooms.css 按惯例补齐副本；房间卡头补地球图标圆片
  （icon 语言呼应）、「协议预算」kv 缩短、成员空提示独立弱化行。
- E2E：补模态断言（点开 → wiz-overlay 在场 → 表单内 Esc 关闭——与既有模态用例同惯例
  先聚焦）；「自托管」断言迁 .rooms-note。坑⑧记档：新视图必须自查三族控件样式副本。
  版本 0.0.32。

## 多房间轮（2026-09-01 · 用户委托追加）

settings.relays 数组化（多 RelayClient 并行）——兑现原型多卡形态：

- **settings**：`relays: RelaySettings[]` 为真相（全量替换写入）；旧 `relay` 单字段读取端
  回退为单元素数组（不破坏性迁移）；写入时旧键清除。**坑⑨（本轮最大）**：`parseLoose`
  是显式字段白名单——P7 初版加 relay 字段时就漏了（env 通道撑着没暴露），本轮 relays 同样
  被静默丢弃（E2E 预写 settings.json 双房不生效定位）；白名单补 relays/relay 两键。
- **事件形状演进**（P7 新事件无历史包袱，内存流零迁移）：`v1.system.remote-members` 与
  `v1.message.remote` payload 加 `roomId`——host 的 memberId/requestId 是房内自增，跨房必撞。
- **kernel 装配**：多实例并行；键空间纪律 `remote:<roomId>:<memberId>` / turn 配对键与
  nonce `<roomId>:<id>` 前缀；出站 mirror 广播到全部已连接房（user 署名按各房 displayName——
  一端多房可不同名）；env 单组（OPENBOT_RELAY_*）作为额外一路叠加（E2E 通道不变）。
  命令面：v1.relay.status 返回数组（settings 全量 + env 路 + 各房 connected 实时）；
  v1.relay.set 全量替换（z.array 上限 8）。
- **UI**：RoomsView 多卡（每房一张：各自连接态/成员链/kv）+ 模态改「列表 ⇄ 表单」两态
  （添加/编辑/删除；卡上「房间设置」直开该房编辑；Esc 逐级返回、列表态「关闭」收模态）；
  有卡时底部虚线「＋ 添加房间」；名册房间成员按房分组（roster-group-sub 房名行）；
  Console/Ctx/Graph 的 remotePeer 解析新键空间。
- **E2E**：新增双房用例（同 host 两房、两对端——双卡/分组名册/房 A 消息归属与只读/
  **房 B 对端收不到房 A 消息（隔离）**/图谱两远端节点）；既有 env 单房用例回归（模态
  断言更新为两态语义）。单测 +1（relays 读写/回退/旧键清除）。
- 收官：三命令零错/348 过 + 6 skipped；E2E 22/23（唯一失败仍为「中止」既有 flaky）。
  版本 0.0.33。

## 设计要点（开工前逐条细化，先记已知决策）

### 协议与状态归属

- **host 是预算与幂等的单一事实源**：双端各自记账必然双花（时钟漂移 + 重放）；账本放 host
  内存（重启清零——房间是易态，持久化记档后续评估），窗口判定用 host 时钟（客户端时钟不可信）。
- **turn-request/result 是请求-应答而非自由消息**：远端不能向本端投递任意消息——只能发起
  turn-request（文本 + 期望 agent 可选），本端执行完回 result。mirror 方向是本端主动外流。
  这条边界是安全模型的根（裁定 B 一期的形态）。
- **nonce 语义与既有消息域同构**：`${senderId}:${seq}` 形状沿用；幂等表只记「已结算的
  turn-request」，窗口滚动清除。
- **事件族不新发明**：远端到达的事实映射进既有 v1.message/v1.system 族（带 `origin: 'remote'`
  之类领域事实字段），renderer 按事实呈现——协议里永不出现 UI 指令（铁律）。

### host（Step 2/3）

- **Hono 只做 HTTP 控制面**（建房/加入/健康——REST + invite 码），**WS 数据面用 ws 库直挂**
  （与 transport 环回网关同栈——`ws@8` 已在依赖树；不引 Hono WS 适配层，减一层抽象）。
- 房间生命周期：创建（生成房间码 + invite 码）→ 成员加入（码即凭据）→ 空转回收
  （无成员 N 分钟自动拆——公网面不留常驻状态）。
- 限速先做朴素版（每成员每秒消息数上限 + 消息字节上限），WAF 级防护记档不做。
- **公网安全基线如实**：TLS 终结交给反代（Caddy/nginx 文档示例）——host 自身只绑明文 +
  token 认证，「直接裸公网」在文档里明确不推荐（Tailscale 内则是加密隧道）。

### 桌面接入（Step 4/5）

- **RelayClient 装配在 coordinator**（装配根职责不变）：desktop main 侧持客户端实例，
  经 settings 热切换（房间配置变更重启生效——与沙箱偏好同语义：装配期决策）。
- 断连退避与「不可达退避」复用同一个纯函数（指数 + jitter，注入随机源可测）。
- 远端成员在本端 roster 的镜像：只读投影（remote 标记），不参与本地调度/建群——
  它是「社交面」成员不是「执行面」成员；turn-request 才是远端触达本地执行面的唯一通道。

### E2E（Step 7）

- 对端用脚本化 ws 客户端（node 脚本进程）而非第二个桌面实例——双 Electron 实例的资源与
  编排成本不值；对端协议行为由 host 单测 + 该脚本共同覆盖。
- relay host 在 E2E 里随机端口起（遵守端口规则），用例内健康检查就绪后再起桌面。

## 风险与地雷

- **本地优先叙事**（风险 #9）：所有面向用户的文案措辞过一遍——「自托管 / Tailscale 优先 /
  官方不运营服务」；协议文档第一节钉死，README/设置页文案同源。
- **公网攻击面**：房间隔离（ fanout 按房间 membership 严格过滤——单测锁「房间间零泄漏」）、
  认证（invite 码 256bit 熵 + 单次展示）、限速、消息大小上限；缺失项如实记档。
- **净化链**：远端消息走 DOMPurify 的路径复核（markdown-it 渲染前的入口统一）——
  E2E 加一条恶意 payload 用例（script 标签注入断言被清）。
- **重连风暴**：退避必须有 jitter + 上限（多客户端同时断连不打挂 host）；host 侧限速兜底。
- **时钟与窗口**：预算窗口判定全部 host 侧；客户端只呈现 host 下发的事实（预算余量随
  result 带回），不本地推算。
- **双实例 E2E 编排**：relay host 是 node 子进程（非 Electron）——playwright globalSetup/
  用例内 spawn 均可；退出清理要挂 finally（孤儿进程占端口的教训：P6 实测坑③同型）。
- 系统近 commit 上限时 Vitest 多 worker 崩溃（P3 记档）：复现时 `--no-file-parallelism`。
