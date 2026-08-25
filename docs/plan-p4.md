# P4 实施计划（原型对齐收敛）

> 状态文档：随实施推进更新勾选与「设计要点」。视觉母版 `prototype.html`（语义基准）；
> 架构依据 [ARCHITECTURE.md](../ARCHITECTURE.md) §11（P4 行，2026-08-25 重定位）；与它冲突时以 ARCHITECTURE.md 为准。
> 上阶段记录见 [plan-p3.md](plan-p3.md)；**P3 遗留三件（OCI 双壳 / electron-builder 打包 / 真实后端验收）维持暂缓，另行启动，不进本阶段**。

## 目标与验收

把 prototype.html 与实现的全量差距（2026-08-25 盘点，附录 A）清零：单机体验补齐——效率层（命令面板 / @提及 / toast / 状态栏）、
agent 生命周期（新建向导）、Box 生命周期（休眠 / 快照回滚）、呈现细节（ctx 档案 / 图谱状态点）与「不造假」纪律修复。
**不引入新功能域**——房间 / 群聊 / 广播 / subagent / 自动化维持 P5+/backlog 记档不动。

- **验收**：附录 A 逐项「已实现 / 已记档裁定不做」二态收敛，无第三态悬空；
- `pnpm build && pnpm typecheck && pnpm test` 保持全绿（mock 对称不动摇），新增交互全部有 E2E；
- 演示值清除：run-progress 假进度（固定 64%）、boxes gauge 假刻度基数（内存/4096、磁盘/65536）。

## 已裁定的范围（2026-08-25 用户裁定 A–F）

| 项 | 裁定 |
|---|---|
| A. P4 重定位 | P4=原型对齐收敛；**平台扩展顺延 P5、relay 顺延 P6**（ARCHITECTURE §11 已同步） |
| B. 新建 Box 侧滑 | **v1 不做手工建 Box**——「agent 注册即建专属 Box」语义（v0.0.10 裁定）维持；等 box-catalog 与多后端就绪再评估 |
| C. @全员广播 | P4 只做单提及路由 + 高亮；**@全员随广播协议进 P5**（UI 层循环发送是假广播——扇出调度是内核语义） |
| D. 后端一键配置 | **降级为引导文案 + 官网链接**，不自动装外部软件（静默装系统级软件风险高于收益） |
| E. 设置-数据区块 | 一期只做路径盒 + 「打开文件夹」；**导出全部 / 清空 transcript 记档后置**（破坏性与打包设计独立成轮） |
| F. per-agent 模型覆盖 | **后置记档**；档案页如实显示「继承全局主力」（装配层 per-agent provider 热切换牵动大，单独一轮做） |

范围外维持原记档：房间/群聊/广播/subagent/自动化（P5+/backlog）、GUI 像素流（P4+ 评估）、权限策略分级开关（后续版本）、
computer-use（后续版本）、task 卡步骤轨迹与产物 diff chips（内核无步骤/产物事实——不造假；产物 diff 展示随 P3 Step 9 验收再议）。

## TODOLIST

- [x] 1. **壳层收尾**：状态栏（内核连接·seq / 当前 LLM / 沙箱后端·N Box / 本地执行·0 云依赖——**全部真数据**，
  无原型「local-exec 守护」假叙事）+ 双击标题栏最大化 + rail-user「你」头像 + 面包屑 crumb +
  `prefers-reduced-motion` 全局降级 + About 版本号改 `app.getVersion()` 真值（现「P3 开发版 v0.0.6+」已过时）
  - 实施（2026-08-25）：版本真值链路 main `openbot:app-version`（app.getVersion）→ preload `app.version` →
    renderer 类型；**apps/desktop/package.json version 0.0.0→0.0.17 对齐出货提交（后续随 vX.Y.Z 同步——提交检查项）**；
    状态栏数据全为 store 投影（connected/lastSeq/providers×defaultProvider/sandbox.backendId/boxes.length），
    沙箱缺席项整条隐藏、LLM 未配置如实显示「未配置」；双击最大化排除表 .theme-toggle/.win-controls/.boot-error（原型同款）；
    About 版本 E2E 用正则 /v\d+\.\d+\.\d+/ 断言（版本随提交演进不腐烂测试）；4 用例 E2E 全绿
- [x] 2. **Toast 全局通道**：右下角轻提示组件（队列 / 2.8s 自动消退 / reduced-motion 兼容）+ 接入既有动作
  （快照成败 / provider 切换 / 设置保存 / 后续各步的动作反馈）；替代「操作成功无反馈」的静默现状
  - 实施（2026-08-25）：`stores/toast.ts`（队列堆叠不互顶、按 kind 定 ttl——danger 4.2s 多留阅读）+
    `ToastHost.vue`（右下角钉状态栏上方、aria-live 播报、点击即消）；接入四处——BoxesView/BoxOps 快照成败
    （操作台内联注记退役）、设置页保存/设主力/删除/沙箱偏好（失败仍走就地错误——有表单上下文）；
    reduced-motion 由 Step 1 全局媒体查询覆盖（toast-in 动画自动关）；E2E 快照触发→自动消退闭环
- [x] 3. **命令面板（Ctrl K）+ 标题栏 omnibox**：六组命令——快速派单（跳会话+聚焦输入框）/ 跳转 agent / 接管 Box /
  视图导航 / 动作（新建 agent、切换主题）；模糊过滤 + 键盘上下选择；**纯 renderer 消费现有 store，零内核改动**
  - 实施（2026-08-25）：`CommandPalette.vue`（空白分词全命中过滤、分组头、↑↓/Enter/Esc、hover 即选、Esc
    stopPropagation 不惊动图谱退出语义）+ ui store paletteOpen/composerFocus + App omnibox（titlebar-right 去
    margin-left:auto 让 omnibox 真居中，原型同款布局）+ 全局 Ctrl K 监听（**activeElement 在 .boxops 内即跳过——
    PTY 聚焦按键直送 Box**，E2E 断言该边界）；命令目录事实驱动（roster/boxes 空则组消失；「新建 agent」留待
    Step 5 向导接入不放假项）；**实测坑：从其他视图派单回 console 时 ConsoleView 重挂载、watcher 错过聚焦
    事件——标志位由 onMounted 兜底消费**；环境地雷复发：系统 commit 紧张时 Vitest 多 worker 崩
    （--no-file-parallelism 规避）与 E2E 偶发 GPU state 抖动（重跑即过）
- [x] 4. **@提及补全 + 消息高亮**：composer 输入 `@` 弹成员菜单（↑↓ 选择 / Enter·Tab 补全 / Esc 关闭 / 失焦收起）；
  消息文本 mentionify（@名字 高亮 chip 样式）；@全员按裁定 C 记档 P5（菜单不放假项）
  - 实施（2026-08-25）：`MentionMenu.vue`（listbox 语义、点击上报；挂 .composer 下向上弹出——left/right 18px
    对齐内容区，原型同款挂载点）+ `lib/mention.ts` mentionify（先转义再注入，名册外不误伤）+ markdown inline
    规则（token 层注入 span，backticks 后不误伤行内代码；DOMPurify 白名单放行 span/class）+ 用户消息与
    A2A 中继行走纯文本路径、agent 回复走 md 路径（renderMarkdown 传入名册命中面）；单提及路由：唯一提及
    且非当前会话对象 → 消息发该 agent 并跟随跳转（多提及=广播语义随 P5，裁定 C）
  - 实测坑×2：①原型 mmPick 拼接重复 @（slice 已含 @ 再拼 '@'+name → `@@名字`）——迁移时连 bug 一起搬了，
    E2E 前自查发现修正（原型演示脚本的 bug 不照搬，已记档）；②@ 前置字符判定「空白后才命中」挡掉中文高频
    写法「，@名字」（E2E 实测抓到）——触发/inline/mentionify/路由提取四处统一为「前一字符非
    [一-龥A-Za-z0-9] 即命中」（中文标点后命中、字母数字前不命中防邮箱 a@b.com）；E2E 七断言：
    弹菜单双名册（档案名/缺席回退 id）→ 前缀过滤 → Enter 补全（含尾随空格不重复 @）→ Esc/失焦收起 →
    路由跳转 sh-name → 用户消息 chip（mentionify 路径）→ agent 回复 chip（md inline 路径）
- [x] 5. **新建 agent 全链路**：命令面 `v1.system.registerAgent`（zod：name/role/color；注册事实经既有 `v1.system.roster`
  快照事件下发，零新事件族）→ 装配 `addAgent` 暴露 + agent-store 扩 `color?` 字段（读取端兼容：缺席回退哈希派生色，
  版本号+兼容读取，不做迁移）→ 名册「+ 新建 agent」入口 + 向导 UI（身份/身份色 → 角色分段 → 复核；模型/沙箱项按
  裁定 F 如实标注「继承全局」不放假选项）→ 身份色从哈希派生升级为档案事实（头像/署名/图谱节点同源生效）
  - 实施（2026-08-25）：agent-store `color?`（register 第三参；老 profile.json 无 color 兼容单测）+ assemble
    `AgentRegistration.color?` 透传 + **main 侧命令面**（register 支持 zod schema——settings/approval 同款先例）：
    `v1.system.registerAgent`（name 去空白 1-24 字 / color hex6 / role steward|worker 默认 worker）；agentId 服务端
    生成 `agent-N`（名册序号递增）；steward 前置检查（在位直接拒绝 STATE_STEWARD_EXISTS——不创建半成品；
    任命事务由 addAgent 兜底不变量）；llm 共享 SwitchableChatProvider（主力切换对全部 agent 生效，与启动装配同语义）
  - renderer：RosterEntry.color? + refreshRoster 抽取（boot 与注册共用——roster 事件只带 agentId/role，档案字段以
    快照为准）+ registerAgent action + **colorOf 统一取色 getter**（档案优先回退 lib 哈希——ConsoleView/Roster/
    Tasks/Graph/Boxes/MentionMenu 六处调用点同源迁移；MentionItem.color 由父级带入）；AgentWizard.vue 三步
    （身份：名字/角色分段四选一映射内核二值/身份色 swatches 六色 → 模型与沙箱：裁定 B/F 如实说明 → 复核 kv），
    成功 toast+跳新会话、失败就地错误（管家在位文案分流）；RosterPanel「＋ 新建 agent」虚线入口 + CommandPalette
    动作组接入（Step 3 预留位兑现）；单测 3 例（color 持久化/老档案兼容/角色变更保留色）+ E2E 全链 8 断言
    （三步向导/toast/名册档案色 rgb 断言/@提及中文前缀收录/Boxes 1→2 注册即建）
- [x] 6. **名册与 stream-head**：未读徽标（**renderer 会话-local 计数**——非读过语义属呈现关注点，不进内核；
  切换会话清零）+ ctx 面板收起开关（三栏 ⇄ 两栏，原型 `.console.no-ctx` 语义）+ stream-head 操作区
  （通知/会话信息图标一期裁剪或占位——**不放假按钮**，实现时按真实价值定）
  - 实施（2026-08-25）：未读计数归 ui store（`unread` + bump/clear——App 层 watch messages 长度差取新增段，
    agent 回复且 from≠当前会话 +1；activeAgentId watch 清零——跨视图派单/relay 点击/名册点击统一路径）；
    ctx 收起 = ui.ctxCollapsed + `.console.no-ctx`（grid 246px 1fr + `:deep(.ctx)` 隐藏 + streamcol 去分界线——
    CtxPanel 独立 scoped 须经 :deep 命中）；stream-head 操作区落 ctxToggle（原型 panelcol/panelexp 图标 +
    aria-pressed）；**通知/会话信息图标无真实动作源——按计划裁剪不放假**（chatSettings 随 Step 7）；
    E2E：收起/展开 class+可见性+aria 三断言 + worker1 回复徽标 +1 → 点击清零 → sh-name 切换
- [x] 7. **ctx Settings 档案模式**：ctx-top（返回 + Settings 标题栏，原型 48px sticky 语义）+ 档案 kv
  （角色 / 模型=继承全局主力·裁定 F / Box 归属 / 权限现状=Manual 闸门如实）+ 协作对象 edges（数据已有：kernel.edges，
  可点击跳会话）+ 记忆/自动化如实空缺态（「数据源属后续版本」——不放假条目）
  - 实施（2026-08-25）：ui.ctxSettings（会话局部态——activeAgentId watch 重置回屏幕）+ stream-head 档案按钮
    （原型 toggleCtxSettings 同款：面板收起时点击 = 展开并直接进档案；is-on 激活态）+ CtxPanel 双模式渲染
    （ctx-top 48px sticky 与 stream-head 底边线连成一条——原型同款）+ 档案 kv 四行全真值（模型=继承全局主力
    （provider 名）/ Box 归属=roster.boxId / 权限现状=新命令 `v1.approval.mode`（桌面装配 Manual 事实）——
    唯一内核改动是这条只读命令）；协作对象 = edges 里 agent↔agent 边聚合（user 端不属协作叙事），点击跳会话；
    记忆/自动化空缺态如实标注「数据源属后续版本」；E2E 十断言（kv 四行/协作行跳会话+模式重置/回边/返回/空缺态）
    ——实测坑：toContainText 正则锚定 ^$ 对整行文本（k+v 连写）不命中，去锚定改 /box-\d+/
- [x] 8. **Box 休眠/唤醒**：`BoxBackend` 增可选 `pause()/resume()`（wsl：`--terminate` 单发行版休眠——vmmem 共享但
  发行版独立，`--shutdown` 全杀地雷不碰；resume=轻量 exec `true` 触发发行版自启）+ caps 增 `suspendable` +
  `v1.boxes.pause/resume` 命令（zod）+ **状态转移复用既有 `v1.box.state` 事件族（零新事件）** + mock 对称 +
  boxes 卡按钮（caps 驱动；原型的「重启」= 休眠+唤醒组合覆盖，不单设按钮）+ ctx 屏 `is-asleep` 灰化
  （解锁 P3-ctx-ops-align 记档的「等信号源」项）
  - 实施（2026-08-25）：types 增 `caps.suspendable` + 可选 `pause/resume`（caps 与接口永不背离）+ 新码
    `BOX_NOT_SUSPENDABLE`（命令面协议层兜底——UI 按 caps 不渲染按钮）；wsl：`--terminate` 单发行版 / resume=
    `wsl -d <name> -- true` 自启 / **休眠中的 exec 自然唤醒（exec 成功即清休眠标志——与显式 resume 同机制）** /
    list() 叠加内存休眠态（重启后 create 拉起，语义自洽）；mock 状态机对称（sleeping/active）；
    assemble `v1.boxes.pause/resume`（boxId zod + suspendGate 门禁 + `v1.box.state` 事件下发——零新事件族）；
    BoxesView 卡按钮（caps.suspendable 驱动、sleeping↔active 文案翻转、toast 反馈）+ ctx 屏 `is-asleep`
    灰化 + cs-bar「休眠中」+ 空屏文案（rootfs 在磁盘随时可唤醒）；单测 4 例（wsl argv/自然唤醒/失败码、
    mock 状态机、命令面事件+门禁）；E2E 全闭环（chip 状态机/toast/ctx 同源灰化与恢复）
  - 实测坑：CtxPanel 加 `is-asleep` class 时留下重复 `:class` 属性——vite 构建失败但 tail -1 只见 warning
    尾行、E2E 一直跑旧 dist 产物（按钮「凭空消失」）；排查路径= grep dist 产物找 suspendable 零命中。
    **教训：E2E 排查先确认构建真成功（grep 关键标识符进产物），别信 exit 前 pipe 的 tail**
- [x] 9. **快照链与回滚**：`BoxBackend` 增可选 `listSnapshots()`（wsl：扫 snapshotDir 的 `snap-N.tar.gz`——已有命名
  约定，state 零新增）+ 可选 `restore(boxId, snapshotId)`（wsl：`--unregister` + `--import` 快照 tar，**破坏性**）+
  `v1.boxes.listSnapshots/restore` 命令 + UI 快照链 chips（最近 N 个，点击查看）+ 回滚**二段确认**
  （「当前 Box 内容将被快照内容替换」警示）+ mock 对称；E2E 只走 mock 链路
  - 实施（2026-08-25）：`SnapshotInfo { snapshotId, sizeBytes?, createdAt? }`（字段缺席=不可知，接口按最弱后端
    设计——wsl 快照 tar 无 Box 归属事实，恢复进哪个 Box 由 restore 参数定）；wsl listSnapshots 扫目录正则匹配
    + stat 大小（listDir/statFile 双注入可测）、restore=unregister+import（**失败窗口如实**：unregister 成功而
    import 失败时发行版已注销，message 指引「快照 tar 在，可重试恢复」）；mock 对称做真——快照深拷贝 files、
    回滚恢复快照点内容（单测断言「回滚到 snap-1 再前进到 snap-2」双向可走）；assemble `v1.boxes.listSnapshots/
    restore`（restore 前后 v1.box.state 转移：sleeping 档复用=回滚中不可用 → active；新码 BOX_UNSUPPORTED 做
    协议层兜底）；UI：快照链 chips（最近 5，全局事实就近回滚——卡上交互作用于该卡 Box）+ 点击展开详情
    （时间/大小）+ 二段确认条（警示文案 + 确认/取消）；kernel store snapshots 链 + boot/快照/回滚三处刷新；
    单测 3 例 + E2E 全闭环（链序/详情/取消路径/确认回滚 toast/链保持）
- [ ] 10. **演示值清扫（不造假纪律修复）**：run-progress 去固定 64%（改 indeterminate 流光——run 无进度事实，如实）；
  boxes gauge 假刻度基数清除——**无上限事实的维度（内存/磁盘）只留数值+label 不画比例条**，CPU 百分比保留真比例条；
  仪表 warn 色档只对有真上限的维度生效（一期无——等资源限额后端）
- [ ] 11. **设置补齐**：数据区块（transcript 路径盒 + 「打开文件夹」经 desktop bridge `shell.openPath`，裁定 E）+
  断网回退端点（settings 增全局 fallback 档案位；llm 装配层请求失败→本轮切回退端点、下轮自动回切主力——回退是
  per-request 行为不做粘滞；状态栏如实显示当轮生效端点）+ Anthropic 协议 provider（llm 包增 messages API 适配，
  fetch 注入同构可测；SSE 事件流与 tool_calls 映射对齐 openai-compat 的注入测试哲学）+ 一键配置降级引导（裁定 D）
- [ ] 12. **Boxes/图谱小项 + 收官**：Box 卡「某某工作中」归属 chip（roster.boxId × runs 投影推导）+ box-claim
  安全叙事条（shield·「Box 即本机云电脑…」）+ 图谱节点状态点（runs 投影：working/idle）/ hover 退隐 / 节点详情 kv
  补状态与模型（模型=继承全局，如实）+ **原型逐视图复查表**（附录 A 全项核对归档进本文档）+ 文档同步
  （ARCHITECTURE §11 已随裁定 A 更新；plan-p4 勾选与实测教训补记）

## 设计要点（开工前逐条细化，先记已知决策）

### 键盘路由（Step 3/4）

- **Ctrl K 与 PTY 抢键**：操作台 xterm 聚焦时按键全部直送 Box（原型同款边界「接管模式下不绑定 Esc」）——
  命令面板的快捷键监听按焦点分流：`.boxops` 挂载且 xterm 聚焦时不拦截；Esc 同理（不抢操作台的退出语义）。
- @提及菜单的键盘处理在 composer input 的 keydown 里先行消费（Enter/Tab/Esc），不冒泡到发送逻辑——原型同款。

### agent 注册与身份色（Step 5）

- 命令面注册后装配层走既有 `addAgent`（重启幂等分支已备：名册已有则只重建内存态）——命令面只是把装配 API
  暴露给壳；CLI 与 desktop 同面（解耦纪律 #7）。
- 身份色三处同源：agent-store `color?` → renderer `agentColor()` 优先读档案、缺席回退哈希派生——
  既有 agent 零迁移（兼容读取），图谱/头像/署名/提及菜单同一函数取色。

### Box 休眠与快照（Step 8/9）

- 休眠语义边界：pause 只对发行版（`--terminate <name>`），**永不** `--shutdown`（全局地雷，platforms.md）；
  休眠中 exec 自然唤醒（发行版自启），resume 按钮只是显式触发同一机制——「暂停不占 CPU，唤醒恢复会话」
  与原型语义一致，/rootfs 数据始终在磁盘。
- restore 的破坏性防护：UI 二段确认 + 警示文案；内核层 restore 前先对该 Box 发 `v1.box.state` 转移
  （restoring 态可复用 sleeping 档或扩展 state 枚举——实现时定，读取端兼容）；失败时原发行版已被注销的风险
  在文档如实标注（wsl 后端无原子 restore，快照 tar 在即数据可恢复）。
- 快照链 UI 的「从快照回滚」= restore；快照 chips 点击先看详情（时间/大小）再决定——不直接触发。

### 设置回退与多协议（Step 11）

- fallback 是**装配层的 per-request 降级**：主力 provider 请求失败（网络/5xx/超时）→ 本轮 chat 重试一次回退端点；
  主力恢复无需显式切回（下轮自然回主力）。不做健康探针轮询——事件驱动，零定时开销。
- Anthropic 适配与 openai-compat 同一 `ChatProvider` 接口、同一 fetch 注入位；provider 档案增协议字段
  （'openai-compat' | 'anthropic'，默认前者——读取端兼容）。

### 状态栏（Step 1）

- 全部数据来自既有 store 投影（connected/lastSeq/defaultProvider/sandbox/boxes.length）——零新增事件、零内核改动；
  「本地执行 · 0 云依赖」是叙事行（产品定位陈述），与 LLM API 事实不冲突（云依赖只剩 LLM 是架构原文）。

## 风险与地雷

- **restore 破坏性**（wsl unregister+import 丢当前内容）：mock 先行验证状态机；E2E 只测 mock；真机验证单独做。
- **wsl `--terminate` 波及面**：单发行版独立（vmmem 共享不波及其他 Box 数据）；`--shutdown` 全杀地雷永不触碰。
- **Ctrl K 抢键**：焦点分流失手会让操作台无法输入 Ctrl+K 字面量——E2E 补操作台聚焦时按 Ctrl K 不弹面板的断言。
- **身份色迁移**：缺席回退哈希派生，既有 agent 观感零变化（兼容验证点写进单测）。
- **coordinator/runner 测试链接 dist 产物**（P3 实测教训沿袭）：改 boxes/llm 源码后必须先 `pnpm build` 再跑下游测试；
  E2E 先 `build:renderer`。
- 系统近 commit 上限时 Vitest 多 worker 崩溃（P3 记档）：复现时 `--no-file-parallelism` 单 worker。

## 附录 A：原型差距盘点与处置对照（2026-08-25 盘点，随实施勾销）

> 「已实现」随各 Step 勾选时在此标记；「记档」项注明去向。本表是 P4 验收的核对底单。

### 一、整块缺失

| 差距项 | 处置 |
|---|---|
| 跨用户房间视图（roomcard/预算/退避/mirror） | 记档：P6（裁定 A 顺延；协议占位不动） |
| 群聊 / 广播 / subagent（名册群组节/群聊流/sysnote/background lane 数据源） | 记档：P5+/backlog |
| omnibox + Ctrl K 命令面板 | ✅ 已实现（Step 3） |
| 状态栏 statusbar | ✅ 已实现（Step 1） |
| 新建 agent 向导 | ✅ 已实现（Step 5） |
| 新建 Box 侧滑 | 记档：裁定 B 不做（等 box-catalog/多后端） |
| Toast 轻提示 | ✅ 已实现（Step 2） |

### 二、控制台

| 差距项 | 处置 |
|---|---|
| @提及补全菜单 + 消息内 @高亮 | ✅ 已实现（Step 4；@全员→记档 P5，裁定 C） |
| ctx Settings 档案模式（档案/记忆/协作/自动化） | ✅ 已实现（Step 7；记忆/自动化=空缺态如实标注） |
| stream-head 操作区（通知/会话信息/ctx 开关/设置入口） | ✅ 已实现（Step 6：ctx 开关 + 裁剪无源图标；设置入口随 Step 7） |
| 名册未读徽标 | ✅ 已实现（Step 6） |
| task 卡步骤轨迹 + 产物 diff chips + 已运行时长 | 记档：后置（内核无步骤/产物事实，不造假；随 P3 Step 9 再议） |
| 群聊 sysnote / 自动化条 | 记档：P5+/backlog |
| typing 三点占位 | 已对齐（v0.0.10） |

### 三、Boxes 视图

| 差距项 | 处置 |
|---|---|
| 快照链 chips + 从快照回滚 | ✅ 已实现（Step 9） |
| 暂停/重启/唤醒（休眠语义） | ✅ 已实现（Step 8；重启=休眠+唤醒组合） |
| per-Box 磁盘配额/资源限额 | 记档：随 OCI 后端与 box-catalog（与裁定 B 同族） |
| Box 卡归属 chip「某某工作中」 | Step 12 |
| box-claim 安全叙事条 | Step 12 |
| 仪表形态（三列 meters/warn 色档） | Step 10（无真上限只留数值；色档等资源限额后端） |
| ctx 屏 is-asleep 灰化 | ✅ 已实现（Step 8） |

### 四、图谱视图

| 差距项 | 处置 |
|---|---|
| 节点状态点（working/idle） | Step 12 |
| hover 退隐（悬停淡出） | Step 12 |
| 节点详情状态/模型 kv | Step 12（模型=继承全局，如实） |
| 群组菱形节点 / 远端蓝虚线 | 记档：P5+/P6（数据无来源） |

### 五、排程视图

| 差距项 | 处置 |
|---|---|
| run-progress 固定 64% 假进度 | Step 10 |
| background lane 数据源 | 记档：automations/subagent backlog |

### 六、设置视图

| 差距项 | 处置 |
|---|---|
| 数据区块（路径/打开文件夹/导出/清空） | Step 11（导出/清空→记档后置，裁定 E） |
| 断网回退端点 | Step 11 |
| Anthropic 协议 | Step 11 |
| 后端一键配置 | Step 11（降级引导，裁定 D） |
| computer-use 屏幕操控 | 记档：后续版本 |
| 权限策略分级开关 | 记档：后续版本（已有记档） |
| About 版本号过时 | ✅ 已实现（Step 1） |

### 七、壳层小项

| 差距项 | 处置 |
|---|---|
| 双击标题栏最大化 | ✅ 已实现（Step 1） |
| rail-user「你」头像 / 面包屑 crumb | ✅ 已实现（Step 1） |
| prefers-reduced-motion | ✅ 已实现（Step 1） |

### 盘点时的已超出项（非差距，备忘）

审批全局弹窗+流内 gate 双呈现、消息失败重试（nonce 幂等）、思考块折叠与过程持久化、PTY 真终端、
provider CRUD+safeStorage+代理、沙箱三级探测降级、磁盘压力角标/警示条、stats 真数据仪表、流式打字机+贴底跟随。
