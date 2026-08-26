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
- [ ] 5. **OCI 底座 + backend-docker**：底座共用一套 OCI CLI 实现（**构造注入命令名与探测函数**——
  plan-p3 Step 4 设计记档直接复用）导出薄壳；容器即 Box：`run -d --cpus --memory` / `exec` / `commit`
  快照 / `stats --no-stream --format json` / pause-unpause；caps 如实（persistent 需卷挂载弱呈现、
  resourceLimits ✓、isolation medium、suspendable ✓）；单测注入脚本化 CLI（mock 同构）
- [ ] 6. **backend-podman 薄壳 + 装配接真后端**：podman 与 docker 同构共用底座（差异只在命令名与探测）；
  沙箱三级探测降级 P3 已就位（设置页选项在场）——本轮接真后端；装配偏好路径核验；
  地雷对照 platforms.md（CLI 子进程方案天然屏蔽命名管道/unix socket 端点差异；podman machine 占一个
  WSL2 发行版——资源告警全局视角）
- [ ] 7. **仪表与色档解锁**：BoxStats cpuPercent/memoryMb 真值进 Box 卡（OCI 后端可测；**WSL 维持如实缺席**）+
  **warn 色档**（resourceLimits 真上限——P3 Step 6 记档「等资源限额后端」兑现，按 --memory/--cpus 限额档位）；
  E2E（mock 确定值路径既有——补色档断言）
- [ ] 8. **真机验收（人工）**：Docker Desktop / podman machine 各走一遍「exec → stats → 快照 → 休眠唤醒」
  链路；结论与实测坑记档 plan-p5（机器条件不满足时如实标注「未验收」——不造假）
- [ ] 9. **收官文档**：plan-p5 勾选与实测记档；ARCHITECTURE §11 重排核对（2026-08-26 已随本计划同步）；
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

### 实施记档（Step 1–4，2026-08-26）

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

## 风险与地雷

- **群聊轮转状态机复杂度最高**（多成员 × 上限 × supersede 交互）——先 mock 对称 + 单测全路径再上 E2E；
  状态机缺陷会表现为「群内消息丢失/重复」，transcript append-only 是对账底账。
- **OCI CLI 版本差异**（docker desktop / podman machine 的 stats 输出格式随版本漂移）——解析容错 +
  注入单测锁格式样本；真机验收步骤记档实测输出。
- **既有 15 E2E 用例不回退**：广播扇出会改图谱边计数——Step 2 落地后跑全量确认第一用例的图谱断言不受影响。
- coordinator/runner 测试链接 dist 产物（P3/P4 沿袭教训）：改 messaging/boxes 源码后必须先 `pnpm build`
  再跑下游测试；E2E 先 `build:renderer` 且 grep 产物确认构建真成功（用模板字面量——minify 混淆标识符）。
- 系统近 commit 上限时 Vitest 多 worker 崩溃（P3 记档）：复现时 `--no-file-parallelism` 单 worker。
