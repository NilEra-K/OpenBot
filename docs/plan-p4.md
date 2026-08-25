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
- [ ] 4. **@提及补全 + 消息高亮**：composer 输入 `@` 弹成员菜单（↑↓ 选择 / Enter·Tab 补全 / Esc 关闭 / 失焦收起）；
  消息文本 mentionify（@名字 高亮 chip 样式）；@全员按裁定 C 记档 P5（菜单不放假项）
- [ ] 5. **新建 agent 全链路**：命令面 `v1.system.registerAgent`（zod：name/role/color；注册事实经既有 `v1.system.roster`
  快照事件下发，零新事件族）→ 装配 `addAgent` 暴露 + agent-store 扩 `color?` 字段（读取端兼容：缺席回退哈希派生色，
  版本号+兼容读取，不做迁移）→ 名册「+ 新建 agent」入口 + 向导 UI（身份/身份色 → 角色分段 → 复核；模型/沙箱项按
  裁定 F 如实标注「继承全局」不放假选项）→ 身份色从哈希派生升级为档案事实（头像/署名/图谱节点同源生效）
- [ ] 6. **名册与 stream-head**：未读徽标（**renderer 会话-local 计数**——非读过语义属呈现关注点，不进内核；
  切换会话清零）+ ctx 面板收起开关（三栏 ⇄ 两栏，原型 `.console.no-ctx` 语义）+ stream-head 操作区
  （通知/会话信息图标一期裁剪或占位——**不放假按钮**，实现时按真实价值定）
- [ ] 7. **ctx Settings 档案模式**：ctx-top（返回 + Settings 标题栏，原型 48px sticky 语义）+ 档案 kv
  （角色 / 模型=继承全局主力·裁定 F / Box 归属 / 权限现状=Manual 闸门如实）+ 协作对象 edges（数据已有：kernel.edges，
  可点击跳会话）+ 记忆/自动化如实空缺态（「数据源属后续版本」——不放假条目）
- [ ] 8. **Box 休眠/唤醒**：`BoxBackend` 增可选 `pause()/resume()`（wsl：`--terminate` 单发行版休眠——vmmem 共享但
  发行版独立，`--shutdown` 全杀地雷不碰；resume=轻量 exec `true` 触发发行版自启）+ caps 增 `suspendable` +
  `v1.boxes.pause/resume` 命令（zod）+ **状态转移复用既有 `v1.box.state` 事件族（零新事件）** + mock 对称 +
  boxes 卡按钮（caps 驱动；原型的「重启」= 休眠+唤醒组合覆盖，不单设按钮）+ ctx 屏 `is-asleep` 灰化
  （解锁 P3-ctx-ops-align 记档的「等信号源」项）
- [ ] 9. **快照链与回滚**：`BoxBackend` 增可选 `listSnapshots()`（wsl：扫 snapshotDir 的 `snap-N.tar.gz`——已有命名
  约定，state 零新增）+ 可选 `restore(boxId, snapshotId)`（wsl：`--unregister` + `--import` 快照 tar，**破坏性**）+
  `v1.boxes.listSnapshots/restore` 命令 + UI 快照链 chips（最近 N 个，点击查看）+ 回滚**二段确认**
  （「当前 Box 内容将被快照内容替换」警示）+ mock 对称；E2E 只走 mock 链路
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
| 新建 agent 向导 | Step 5 |
| 新建 Box 侧滑 | 记档：裁定 B 不做（等 box-catalog/多后端） |
| Toast 轻提示 | ✅ 已实现（Step 2） |

### 二、控制台

| 差距项 | 处置 |
|---|---|
| @提及补全菜单 + 消息内 @高亮 | Step 4（@全员→记档 P5，裁定 C） |
| ctx Settings 档案模式（档案/记忆/协作/自动化） | Step 7（记忆/自动化=记档空缺态） |
| stream-head 操作区（通知/会话信息/ctx 开关/设置入口） | Step 6 |
| 名册未读徽标 | Step 6 |
| task 卡步骤轨迹 + 产物 diff chips + 已运行时长 | 记档：后置（内核无步骤/产物事实，不造假；随 P3 Step 9 再议） |
| 群聊 sysnote / 自动化条 | 记档：P5+/backlog |
| typing 三点占位 | 已对齐（v0.0.10） |

### 三、Boxes 视图

| 差距项 | 处置 |
|---|---|
| 快照链 chips + 从快照回滚 | Step 9 |
| 暂停/重启/唤醒（休眠语义） | Step 8（重启=休眠+唤醒组合） |
| per-Box 磁盘配额/资源限额 | 记档：随 OCI 后端与 box-catalog（与裁定 B 同族） |
| Box 卡归属 chip「某某工作中」 | Step 12 |
| box-claim 安全叙事条 | Step 12 |
| 仪表形态（三列 meters/warn 色档） | Step 10（无真上限只留数值；色档等资源限额后端） |
| ctx 屏 is-asleep 灰化 | Step 8（解锁 P3 记档项） |

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
