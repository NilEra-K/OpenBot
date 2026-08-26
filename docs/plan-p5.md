# P5 实施计划（消息域收敛 + OCI 双壳）

> 状态文档：随实施推进更新勾选与「设计要点」。群聊 UI 语义基准仍是 `prototype.html`（群聊流 / 群组节 /
> sysnote / 菱形节点）；架构依据 [ARCHITECTURE.md](../ARCHITECTURE.md) §11（P5 行，2026-08-26 裁定重排），
> 与它冲突时以 ARCHITECTURE.md 为准。
> 上阶段记录见 [plan-p4.md](plan-p4.md)（P4 已收官——附录 A 全项二态收敛）。
> P3 遗留三件中 **OCI 双壳本轮兑现**；electron-builder 打包与 WSL 真机验收随平台扩展进 P6。

## 目标与验收

兑现两条既有承诺：**裁定 C 的 @全员随广播协议进 P5**（扇出调度是内核语义——UI 层循环发送是假广播）与
**platforms.md 的 v1 四后端**（WSL + Docker + Podman + mock）。消息面（广播 / 群聊 / sysnote / 群组节点）
与沙箱矩阵（四后端 caps 如实）双收敛。

- **验收**：@全员与 @多提及扇出 E2E 全链路（N agent 收到 + 图谱边 + worker 发起拒绝）；
  群聊有界轮转收敛与 supersede E2E；OCI 双壳注入单测全绿（脚本化 CLI，mock 同构哲学）+
  真机人工验收结论记档；既有 15 E2E 用例不回退；
- `pnpm build && pnpm typecheck && pnpm test` 保持全绿；
- **不造假纪律延续**：caps 驱动 UI（OCI 的 persistent 弱点如实呈现）；subagent / 自动化数据源不放假条目。

## 已裁定的范围（2026-08-26 用户裁定）

| 项 | 裁定 |
|---|---|
| A. P5 范围 | **消息域收敛（广播 + 群聊）+ OCI 双壳**——平台扩展与全部打包（含 win nsis）→ P6、relay → P7、subagent/自动化 → backlog；本轮全部 Windows 可验收（一轮闭环，不依赖 Mac/Linux 设备） |
| B. 消息域深度 | **广播 + 群聊**；subagent 留 backlog（lineage / background lane 数据源牵动 scheduler，独立一轮评估——从零起工作量最大） |

范围外维持记档：subagent/自动化（backlog）、平台扩展 Linux/macOS 与 electron-builder 三平台打包（P6——
打包与平台扩展同轮合并，分发域边界干净）、relay（P7）、GUI 像素流（后续评估）、computer-use（后续版本）、
权限策略分级开关（后续版本）。

## TODOLIST

- [x] 1. **广播内核**：`messaging/broadcast` 真实现（现为空桩）——扇出调度：顺序入队（复用三 lane 排他）、
  并发执行、无环；**扇出权仅用户与 steward**（worker 发起稳定码拒绝）；命令面 `v1.message.fanout`
  （zod toAgentIds 非空 + 名册校验）；transcript 双侧镜像（A2A 同哲学）+ 图谱边计数；事件族
  （倾向逐成员复用 v1.message.a2a——renderer 零新事件族；实现时定）；nonce 幂等；
  单测（扇出 N / worker 拒绝 / 幂等 / 无环）
- [x] 2. **广播 UI**：MentionMenu「@全员」项（P4 预留位兑现——名册全量构造收件列表）+ 多提及扇出路由
  （提及者列表——与 @全员同一内核命令，UI 只构造 toAgentIds）+ 发起方广播注记行（sysnote 风格「已广播给
  N 人」）+ 图谱边同源；E2E（@全员到达 / 多提及扇出 / worker 会话内无全员项——菜单事实驱动）
- [x] 3. **群聊内核**：`messaging/group` 真实现 + `runner` GroupMemberRunner（均从零起）——有界轮转
  （消息上限 / 轮次上限 / 全员 pass 收敛 / 用户消息 supersede）、**leaderless**（steward 群内普通成员——
  §3.5）、每成员独立会话状态、@提及路由；群 transcript 归属（群作虚拟会话对象进键空间——新 kind、
  老档案无群记录零迁移）；命令面 `v1.group.*` 最小集（create/send/invite/leave——开工前细化）；
  单测（轮转收敛 / supersede 打断 / @提及路由 / leaderless 断言）
- [x] 4. **群聊 UI**：RosterPanel 群组节（名册独立分组——原型「群聊」节）+ 群聊流视图（sysnote 系统注记：
  建群 / 入群 / 轮转收敛）+ 图谱**菱形节点**（P4 记档数据源激活——群成员边聚合）+ ctx 群档案 +
  @提及菜单群对象；E2E（建群 → 消息轮转收敛 → supersede → sysnote / 菱形节点在场）
- [x] 5. **OCI 底座 + backend-docker**：底座共用一套 OCI CLI 实现（**构造注入命令名与探测函数**——
  plan-p3 Step 4 设计记档直接复用）导出薄壳；容器即 Box：`run -d --cpus --memory` / `exec` / `commit`
  快照 / `stats --no-stream --format json` / pause-unpause；caps 如实（persistent 需卷挂载弱呈现、
  resourceLimits ✓、isolation medium、suspendable ✓）；单测注入脚本化 CLI（mock 同构）
- [x] 6. **backend-podman 薄壳 + 装配接真后端**：podman 与 docker 同构共用底座（差异只在命令名与探测）；
  沙箱三级探测降级 P3 已就位（设置页选项在场）——本轮接真后端；装配偏好路径核验；
  地雷对照 platforms.md（CLI 子进程方案天然屏蔽命名管道/unix socket 端点差异；podman machine 占一个
  WSL2 发行版——资源告警全局视角）
- [x] 7. **仪表与色档解锁**：BoxStats cpuPercent/memoryMb 真值进 Box 卡（OCI 后端可测；**WSL 维持如实缺席**）+
  **warn 色档**（resourceLimits 真上限——P3 Step 6 记档「等资源限额后端」兑现，按 --memory/--cpus 限额档位）；
  E2E（mock 确定值路径既有——补色档断言）
- [x] 8. **真机验收（人工）**：Docker Desktop / podman machine 各走一遍「exec → stats → 快照 → 休眠唤醒」
  链路；结论与实测坑记档 plan-p5（机器条件不满足时如实标注「未验收」——不造假）
- [x] 9. **收官文档**：plan-p5 勾选与实测记档；ARCHITECTURE §11 重排核对（2026-08-26 已随本计划同步）；
  package.json 版本随出货提交同步

## 设计要点（开工前逐条细化，先记已知决策）

### 广播（Step 1/2）

- **扇出是内核调度语义**：UI 只构造 toAgentIds（@全员=名册全量、@多提及=提及者列表），内核一个
  `fanout` 命令做顺序入队与并发执行——「UI 层循环发送」的假广播防线写在协议层。
- 扇出权仅用户与 steward（§3.5：worker 不能广播）——worker 会话的 MentionMenu 不出「@全员」项
  （事实驱动），内核另有稳定码兜底（MSG_ 或 STATE_ 前缀，实现时定）。
- 无环：广播消息不触发接收方的再扇出（接收侧进普通 turn，不含扇出语义）。
- transcript：发起者出信 + 每接收者入信镜像；图谱边按成员 +1（bumpEdge 既有路径）。

### 群聊（Step 3/4）

- 有界轮转状态机是本轮最复杂件——mock 先行验证收敛与 supersede 语义，再接真 LLM 轮。
- 群 transcript：群作虚拟会话对象（groupId 键空间，新 kind 记录）——读取端兼容（老档案无群记录，
  零迁移）；群内 sysnote（建群/入群/收敛注记）随群流持久。
- leaderless 断言写进单测：steward 在群内无特权路径（不能打断他人轮转、非天然群主）。
- 图谱菱形节点=群成员边聚合（原型 ggroup 语义——P4 记档「数据无来源」至此激活）。

### OCI 双壳（Step 5–7）

- 底座一套、薄壳两个：CLI 即接口（docker/podman 同构），单测全部注入脚本化——与 backend-wsl 的
  procexec 注入哲学一致；真机行为差异靠注入层隔离。
- caps 永不背离：persistent 弱（需卷挂载）如实呈现——UI 按 caps 驱动，不出现「UI 有按钮后端不支持」。
- 仪表解锁后**反向不造假**：WSL 后端的 CPU/内存继续缺席（发行版共享 vmmem 无 per-distro API，
  P3 实证）——仪表按后端可测维度呈现的既有纪律不动摇。

### 事件与协议面（Step 1/3）

- 倾向零新事件族：广播接收侧逐成员复用 v1.message.a2a；群聊消息新 v1.group.message 事件（群是新的
  会话对象族，无法塞进 a2a——实现时按最小事件集定）。
- 命令面 zod 先例沿用（registerAgent/settings 同款）；错误稳定码族按既有前缀扩展。

### 实施记档（Step 1–9，2026-08-26）

- **Step 1 广播内核**：BroadcastService 薄层复用单发管线（a2a 两个受理方法）——事件/transcript 镜像/
  lane 入队语义同源，**零新事件族兑现**；子 nonce `${nonce}#${i}` 各自幂等（整体重试只回放不双发）；
  先全量校验后投递（未注册成员在投递前拒绝——零事件零 run）；发起者自排除=无环第一道；runner 侧
  send_broadcast 工具（worker 调用按 MSG_BROADCAST_FORBIDDEN 如实报错——steward 专用兜底）。
- **Step 2 广播 UI**：「@全员」保留字 token（判定先于名册同名命中，前后置非名字字符防误命中）；
  扇出回执 toast「已广播给 N 人」；群边同源走 renderer bumpEdge（消息事件自然驱动）。
  **偏差记档**：原计划 E2E 断言「worker 会话内无全员项——菜单事实驱动」未实现（2026-08-26 实施裁定，
  随 Step 4 授权默认接受）：
  桌面 UI 的 composer 发起者恒为用户（from='user'），不存在 worker 发起路径——「worker 不能扇出」
  由内核扇出权 + send_broadcast 稳定码兜底；在 worker 会话隐藏全员项反而让用户失去广播入口。
- **Step 3 群聊内核**：轮转态内存（gen 代际 supersede 唯一判据）、群档案 groups.json 持久（重启后空闲
  如实）；群 transcript 三 kind（group-user/agent/sys）；成员 turn 经 run.kind='group' 走 TurnRunner
  session 分流（历史读群流、终答写群流、`[pass]` 不落流；agent 私聊流零污染）；上限=群记录 200 条
  （transcript 长度判据，天然持久）；invite/leave 未实现（本轮无 UI 入口——记档后置，命令面最小集
  create/list/send 即收敛验收）。
- **Step 4 群聊 UI**：RosterPanel 群组节（avatar-group 中性底不取身份色）+ GroupWizard 一步建群
  （AgentWizard 容器同款；名册空/未选成员前置提示）+ CommandPalette「新建群聊」动作；图谱菱形节点
  混入环形均布（按真实 groups 计算——原型手工摆位不照搬）、群边=灰（非 accent——群内发言非委派）、
  nodeColor 统一取色（群 ink3）；ctx 群屏幕=轮转态（runs 投影）+ 最近 sysnote（群无 Box 如实）；
  ctx 群档案轮转边界按内核事实（记录上限 200/每员每轮 1 次/轮次随消息新开）——**原型「3 轮/10 条/
  每员 2 条/成员上限 6 人」是编造数值不照搬**（P4 演示值清扫纪律延续）；@提及菜单群对象（纯群提及
  发群跳转、混合时群照发 agent 部分照旧）；三处修正：群成员署名显示名、typing 结构对齐私聊
  （.m-text.typing .dot）、retry 群消息走 sendGroupMessage（原误走 agent 路径）。
- **E2E 记档**：mock-openai 加 delayMs（慢响应制造 supersede 时序——请求留痕不延迟）；群用例四剧本步
  按轮次标记匹配（`· 第N轮]`/「本轮已发言」区分成员位置）；旧轮延迟响应 settle 后断言**不在场**
  （supersede 代际丢弃的负向验证）。
- **supersede 缺陷修复（Step 4 E2E 实测抓到，内核三处）**：代际丢弃原只拦在 GroupService.#onSettled
  （编排层），但旧轮终答的 transcript/事件写入发生在 TurnRunner 深处且**先于** settle 回调——旧轮发言
  仍落群流。单测未抓到的原因：messaging 层 harness 直接 resolve outcome，绕过了 runner 写入层。
  修复=防线前移到写入点：GroupService.isStale 公开代际判定 → assemble 注入 TurnRunner.isGroupTurnStale
  → session.stale() 在终答写入前拦截（不写群 transcript 不发事件，turn 正常 finish）；与 #onSettled
  构成双层防线。turn.test.ts 补「旧代际在途 turn 终答丢弃」用例锁该路径。
- **Step 5 OCI 底座 + Docker 薄壳**：`OciBoxBackend` 一套全量实现，`DockerBoxBackend` 只注入
  `id/cli` 两字段（podman Step 6 同法）。容器即 Box：`run -d`（`--cpus/--memory` 原生上限 + `sleep
  infinity` 常驻）/ exec（`-w/-e/--` 注入）/ `commit` 镜像即快照（`openbot-snap:N`，CLI 默认自动
  pause 冻结文件系统——与 wsl terminate-再-export 同一致性语义）/ stats / pause-unpause / restore
  （**先校验快照镜像在场再删容器**——失败窗口比 wsl 版更小）/ openShell（容器内 `script` 分配
  PTY，与 WSL 同构——Windows 侧零原生模块）。caps 如实：persistent **false**（容器可写层随容器
  存活，真持久需卷挂载——一期未挂，UI 弱呈现）；interactive true 待 Step 8 真机验收，不通用如实降
  caps 记档。
- **Step 5 状态机要点**：`#ensureRunning` 先查后动（ps 查态再 unpause/start——podman 对运行中容器
  start 报错而 docker 是 no-op，不盲调组合）；create 跨重启幂等（容器已存在跳过 run，桌面重启复用
  ——名册 agent 重建 Box 不会同名冲突）；list 前缀精确过滤（`openbot-box-` 前缀，用户自建容器不碰）。
- **Step 5 probeDocker 收紧**：`docker version` Client 段（CLI 在即通过——太宽松）→ `docker info`
  Server 段（Engine 运行态校验），Docker Desktop 未启动时 available=false 带「启动后重试」指引。
  kernel 装配 implemented 白名单加 docker；默认镜像 `ubuntu:24.04`，`OPENBOT_DOCKER_IMAGE` env
  覆盖（国内网络/私有 registry 确定性）。E2E 走 `OPENBOT_SANDBOX=mock` env 覆盖，确定性不受影响。
- **Step 5 测试坑记档**：①定向失败替身必须放行 create 初始化链（ps + mkdir）——一刀切失败会先炸在
  `BOX_STATE_QUERY_FAILED`/create 的 mkdir，测不到目标错误码（收尾时修 3 例）；②create 存在路径是
  双重 ps 查询（create 查一次 + ensureRunning 再查）——与 exec 先查后动同构的防御式设计，断言用
  find 式不锁索引。真实套件 `OPENBOT_TEST_DOCKER=1` 门控（默认 CI 零 Docker 依赖）+ afterAll 兜底
  清理孤儿容器/快照镜像（防下轮同名冲突）——Step 8 真机验收直接复用。
- **Step 6 podman 薄壳**：`PodmanBoxBackend` 与 Docker 完全同构（底座差异只剩注入的 cli 命令名）；
  kernel 装配 implemented 加 podman（`OPENBOT_PODMAN_IMAGE` env 覆盖）——四后端矩阵齐。
  **probePodman 收紧与实测坑**：`podman info` 在 machine 停止时仍 exit 0 返回 client 侧信息（OS:
  windows/amd64）——探不出运行态；`podman machine list` 同样恒 exit 0（machine 停止时）——必须
  **解析内容**：`machine list --format json` 的 `Running` 字段（实测样本来自本机 podman 6.0.1，
  machine 从未启动：LastUp 零值、Running:false）。`parseMachineList` 纯函数导出，probe.test.ts 9 例
  锁样本（含损坏输出/非数组/字段异常 → null 如实不可用）。probeCli 补全一处：exit 非 0 分支同样拼
  unavailableNote（Step 5 注释宣称「带指引」与实现不符的修正——CLI 在但 Engine 停是最常见不可用态）。
- **Step 7 仪表与色档**：默认限额档 **cpus:2 / memoryMb:2048**（assemble addAgent——工程默认而非演示值：
  resourceLimits 后端真实落为 `--cpus/--memory`；WSL caps.resourceLimits=false 如实忽略；mock 忽略但
  spec 留档供呈现分母；后续可配化记 backlog）。内存比例条 = `stats.memoryMb`（用量）∩ `spec.memoryMb`
  （限额）双在场才画——分母是真实限额非编造刻度，任一缺席维持只报数值（P4 Step 10 纪律延续：磁盘无
  上限事实不变）；CPU/内存 ≥80% → `gauge-warn`（--warning 色，fill 与数值同变色）。WSL 反向不造假
  兑现：stats 无 cpu/mem 字段仪表自然不渲染。mock `options.stats` 整包覆盖 + kernel env
  `OPENBOT_MOCK_CPU/MEM/DISK`（数字合法才注入——E2E 高值档位的确定性来源）；renderer BoxCard 投影
  扩 cpus?/memoryMb?（v1.boxes.list 本就全量透传 spec，收窄在 renderer 投影层）。
- **Step 7 E2E**：新用例「warn 色档」（OPENBOT_MOCK_CPU=87 → CPU warn 类 + width 87%；
  OPENBOT_MOCK_MEM=1900 ÷ 2048 → 92.77% warn + 文案「1.9 GB / 2.0 GB」用量带真实上限）。P4 Step 10
  旧用例断言更新：内存 `.gauge-bar` 0→1 + `/ 2.0 GB` 文案——**预期内行为变更**（上限事实进场，P4
  「无上限不画条」的前提不再成立）；磁盘断言不动。实测坑：Vue style 绑定按**完整精度**下发 width
  （92.7734%）——正则断言要 `92\.77\d*%` 而非精确两位（首跑抓到）。
- **Step 8 真机验收（如实：未验收）**：Docker Desktop 本机未安装（`where docker` 无命中）；podman
  6.0.1 CLI 在、machine `podman-machine-default`（hyperv，配置 14C/2GiB）存在但**从未启动**——用户
  裁定不启动 machine（Hyper-V VM 资源占用 + 首次拉镜像网络成本），真机链路（exec → stats → 快照 →
  休眠唤醒）未验收。真实套件已参数化：`OPENBOT_TEST_OCI=1` + `OPENBOT_TEST_CLI=docker|podman`
  （afterAll 清理命令同步二态）——机器条件就绪时直接复跑。CLI 语义已由脚本化单测锁死（底座 18 例 +
  probe 9 例，含 docker/podman 双 stats 格式样本），真机验收剩余风险只在 CLI 版本行为漂移。
- **Step 9 收官**：单测 275 通过 + 4 skipped（真实套件门控）；E2E 18 用例全绿（P5 净增 1：色档）；
  package.json 版本 0.0.26。

## 风险与地雷

- **群聊轮转状态机复杂度最高**（多成员 × 上限 × supersede 交互）——先 mock 对称 + 单测全路径再上 E2E；
  状态机缺陷会表现为「群内消息丢失/重复」，transcript append-only 是对账底账。
- **OCI CLI 版本差异**（docker desktop / podman machine 的 stats 输出格式随版本漂移）——解析容错 +
  注入单测锁格式样本；真机验收步骤记档实测输出。
- **既有 15 E2E 用例不回退**：广播扇出会改图谱边计数——Step 2 落地后跑全量确认第一用例的图谱断言不受影响。
- coordinator/runner 测试链接 dist 产物（P3/P4 沿袭教训）：改 messaging/boxes 源码后必须先 `pnpm build`
  再跑下游测试；E2E 先 `build:renderer` 且 grep 产物确认构建真成功（用模板字面量——minify 混淆标识符）。
- 系统近 commit 上限时 Vitest 多 worker 崩溃（P3 记档）：复现时 `--no-file-parallelism` 单 worker。
