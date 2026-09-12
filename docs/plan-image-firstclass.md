# 镜像一等公民实施计划（⑥——Agent 控制镜像而非容器后端）

> 状态文档：2026-09-12 立项规划（用户目标陈述「我的云电脑/VMWare 终极目标」提上日程）。
> 上游记档 [plan-backlog.md](plan-backlog.md) ⑥（三阶段路线与准备原则）；架构依据
> ARCHITECTURE.md §3.4（boxes）/§6（后端矩阵与 caps）。computer-use 既有底子见
> [plan-computer-use.md](plan-computer-use.md)。
> **术语约定**：本文「镜像」= 一个可被 agent 绑定与操控的机器载体（容器镜像 / VMWare 虚机 /
> 云主机 / 未来的云桌面），与既有 `BoxSpec.image`（模板名字符串）区分后者的升级形态叫
> **镜像条目（ImageEntry）**。

## 目标与终态

**终态**：Agent 绑定的是「镜像条目」而非「容器后端」——条目声明载体类型（容器/VM/云主机）、
连接信息、控制协议（x11/rdp/…）与凭据；云电脑、VMWare 虚机、本地容器在同一套工具族下
无差别操控。分阶段落地（每阶段独立可交付，承 backlog ⑥ 三阶段路线）：

- **阶段一（P8-1）**：SshBoxBackend——SSH 在虚机/云主机内执行，「exec 通道抽象普适性」的验证轮；
- **阶段二（P8-2）**：ScreenControl 接口化——桌面控制从 xdotool/scrot/ffmpeg 具体命令提升为适配器接口；
- **阶段三（P8-3/4）**：镜像注册表 + Agent 绑定——镜像获得一等公民地位；
- **按需（P8-5）**：vmrun 生命周期编排、Windows 云电脑（RDP）设计记档。

## 现状盘点（代码级，2026-09-12）

### 离目标比表面近——三样基础件已就位

GUI 能力的真实依赖链是 `Agent → 工具族 → BoxBackend.exec/openPipe → 镜像内执行`，
依赖的不是「容器」而是三样更基础的东西，全部在场：

1. **镜像内命令执行通道**：`BoxBackend`（`packages/boxes/src/types.ts`）——exec（流式+超时+
   abort 传导）/fsRead/fsWrite/openShell（PTY）/openPipe（原始字节管道）接口齐备，六后端实现；
2. **镜像内工具集**：gui-ubuntu 模板（xvfb+openbox+xdotool+scrot+ffmpeg，
   `apps/desktop/resources/gui-ubuntu/`）——工具集在镜像内而非后端内；
3. **能力协商**：caps 单一真相源驱动工具注册/UI 按钮（§6），probe 探测先例齐备。

装齐工具集的 VMWare Linux 虚机/云 Linux 主机，只需实现 BoxBackend（SSH），现有全部 GUI
能力零改动直接工作——这就是阶段一要验证的命题。

### 真耦合点清单（演进要解开的）

| # | 位置 | 耦合内容 |
|---|---|---|
| 1 | `packages/runner/src/tools/index.ts` | computerTools 族：captureScreen（scrot+convert）/actXdotool/screenGeometryOf（xdotool）+ `guiDisplay()` 读全局 env |
| 2 | `packages/coordinator/src/gui-stream/index.ts` | GuiStreamService：ffmpeg x11grab argv 构造、pidfile/pkill 清场、queryGeometry（xdotool）——argvOf 注入位已为适配器留口（backlog 准备原则 1 兑现位） |
| 3 | `apps/desktop/src/main/kernel.ts` | `v1.box.gui.frame`（scrot）/`v1.box.gui.input`（常驻 sh -s + xdotool）/ensureGuiInputChannel；`computerEnabled` 仍 env 门（生产门「GUI 镜像探测 ∩ provider supportsImages」记档未兑现） |
| 4 | `packages/coordinator/src/assemble/index.ts:506` | `addAgent` 硬编码 `backend.create({ image: 'default', … })`——**全局单一后端**（desktop 装配期 chooseBackend 三选一），镜像只是字符串无名分 |
| 5 | `packages/boxes/src/images/index.ts` | 5 行占位 `export {}`——镜像注册表空位，正是本计划的兑现位 |
| 6 | `packages/boxes/src/probe/index.ts` + state `SandboxPreference` | 后端 id 联合无 ssh/vmrun；平台裁剪逻辑硬编码 |

## 功能清单（总表）

按能力域组织；「阶段」列 = 一（P8-1）/ 二（P8-2）/ 三（P8-3/4）/ 按需（P8-5）。

### A. 执行通道（SSH 载体）

| # | 功能 | 阶段 |
|---|---|---|
| A1 | SshBoxBackend：exec（argv→远端 sh 包装、env 经 `VAR=v` 前缀注入）/fsRead/fsWrite/openShell（`ssh -tt`）/openPipe（stdout 原始字节——实况流与常驻注入通道直接可用）/list（attach 记账）/stats（可选缺席） | 一 |
| A2 | caps 如实：persistent ✓ / snapshot ✗ / headless ✓ / resourceLimits ✗ / isolation high / interactive ✓ / suspendable ✗ | 一 |
| A3 | create=attach 语义：机器预存在，create = 验证连通 + 记账；teardown = 断开通道清账，**绝不销毁远端机器**（裁定 C） | 一 |
| A4 | 远端进程善后：timeout/abort 杀本地 ssh 进程 + 远端孤儿按 pidfile 模式补刀（坑⑯ 泛化到 SSH 载体） | 一 |
| A5 | probeSsh + SandboxPreference 加 `'ssh'` + 装配接入（env `OPENBOT_SANDBOX=ssh` + `OPENBOT_SSH_HOST/PORT/USER/KEY/DISPLAY`） | 一 |
| A6 | VmwareBackend：vmrun 生命周期（start/stop/suspend/snapshot/revert——caps.snapshot/suspendable 兑现）+ SSH 数据面组合 | 按需 |

### B. 镜像内工具集（GUI 栈）

| # | 功能 | 阶段 |
|---|---|---|
| B1 | provision 脚本：任意 Linux 载体一键装 xvfb/openbox/xdotool/scrot/ffmpeg（从 gui-ubuntu Dockerfile 提炼共用，Dockerfile 改引它） | 一 |
| B2 | 工具集探测：`command -v xdotool scrot ffmpeg` 探测 → GUI 能力运行时事实 | 二 |
| B3 | DISPLAY 地址 per 载体配置化：全局 env → 装配参数 →（三）镜像条目字段 | 二/三 |

### C. 桌面控制协议接口化（ScreenControl）

| # | 功能 | 阶段 |
|---|---|---|
| C1 | ScreenControl 接口（boxes 新模块 `screen/`）：geometry / capture（含缩放与坐标系元数据）/ act（click/dblclick/type/key/scroll 统一输入动作）/ stream（实况采集常驻会话）/ inputChannel?（常驻低延迟注入，缺席回退逐动作） | 二 |
| C2 | X11ScreenControl 适配器：三处散布命令（耦合点 1/2/3）原样迁入，行为等价 | 二 |
| C3 | 三消费方接线：computerTools / GuiStreamService / desktop gui 命令面只认接口 | 二 |
| C4 | GUI 生产注册门兑现：镜像声明 ∩ 工具集探测（B2）∩ provider supportsImages → computer 工具注册（替代 env 门；env 保留为 E2E 强制门） | 二 |
| C5 | 适配器槽位：RDP / 厂商 API 记档不实施——接口按「真接入 VMWare 后的反馈」定形（准备原则 3） | 二留口 |

### D. 镜像注册表（一等公民）

| # | 功能 | 阶段 |
|---|---|---|
| D1 | ImageEntry 模型 + ImageStore（state）：`<root>/images.json`——`{id, name, carrier, connection, controlProtocol, gui?, display?}`；损坏降级空表；上限 16（裁定 F） | 三 |
| D2 | carrier→backend 工厂 + **RoutingBackend**：按 image 路由的多路 facade——services/工具族持单一 backend 引用零改动（设计要点 1） | 三 |
| D3 | 命令面：`v1.images.list/add/update/remove/test`（test = 连接探测 + 工具集探测报告） | 三 |
| D4 | 凭据：一期 SSH key 路径（引用宿主文件，零密码面）；密码/guest 凭据字段位预留 safeStorage 密文（裁定 D） | 三 |
| D5 | 设置页「镜像」节 UI：清单 + 载体分表单（容器镜像名 / SSH host+port+user+key 路径 / 显示地址）+ 连接测试按钮 | 三 |

### E. Agent ↔ 镜像绑定

| # | 功能 | 阶段 |
|---|---|---|
| E1 | `AgentProfile.imageId?`（state）+ 悬空双语义：恢复静默回默认镜像 / 命令显式拒绝（modelProvider 先例） | 三 |
| E2 | addAgent 装配分流：registration 引用镜像 → RoutingBackend 解析 per-image backend 实例（缓存 per imageId） | 三 |
| E3 | 命令面：registerAgent schema 加 imageId + `v1.system.setImage`（null=清除回默认，重启生效——与模型覆盖同语义） | 三 |
| E4 | UI：AgentWizard 镜像步（缺省「默认沙箱」）；ctx 档案 kv（镜像：名（载体））；boxes 视图按载体类型呈现 | 三 |

### F. Windows 云电脑（远期记档）

| # | 功能 | 阶段 |
|---|---|---|
| F1 | RDP ScreenControl 适配器设计记档：两条候选路线（宿主 RDP 客户端注入 / 镜像内探针 agent 经反向通道提供 exec+screen），真机接入时裁定——**不实施** | 记档 |

### G. 测试与文档

| # | 功能 | 阶段 |
|---|---|---|
| G1 | SshBackend 单测：ProcRunner 注入替身锁 argv（远端包装/env 注入/转义/超时杀进程——OCI 哲学） | 一 |
| G2 | 真机门控套件：`OPENBOT_TEST_SSH=1`（gui-stream-real 先例）——exec/fs/PTY/GUI 工具族/实况流 SSH 全链 | 一 |
| G3 | E2E：镜像 CRUD/绑定分流（双 mock 后端断言 create 分发）；既有 28 用例每轮零回退 | 三 |
| G4 | ARCHITECTURE §3.4/§6 同步（镜像注册表 + 后端矩阵 ssh 行）、platforms.md、protocol.md 新命令族 | 各轮 |

## 待裁定（批准时逐项表态，未表态按推荐）

| 项 | 选项 | 推荐 |
|---|---|---|
| A. SSH 通道实现 | a) ssh CLI 子进程（Windows 10+ 自带 OpenSSH 客户端——与 wsl.exe 完全同构的「CLI 即接口」）；b) ssh2 npm 包（纯 JS 但密码学面大、引第三方依赖） | **a)**——零依赖、procexec 既有管线直接复用；坏处是每次调用新连接（见风险 4，ControlMaster 可缓） |
| B. 阶段一装配入口 | a) env 覆盖全局后端（`OPENBOT_SANDBOX=ssh`），零持久化面；b) 直接上镜像注册表 | **a)**——先验证抽象再上注册表（准备原则 3：过早抽象绑定错误假设） |
| C. 远端 teardown 语义 | a) teardown=断开通道+清账，绝不销毁远端机器；b) 沿容器语义销毁 | **a)**——云电脑/虚机是用户资产，销毁不可接受；create 对应改「attach」语义并记档 |
| D. 凭据模型一期 | a) 仅 SSH key（宿主 ~/.ssh 引用路径）；b) + 密码（safeStorage 密文 + sshpass——Windows 宿主无原生支持） | **a)**——密码方式 Windows 工具链不成立，如实后置；vmrun guest 凭据随 P8-5 再议 |
| E. GUI 生产注册门兑现时机 | a) P8-1 顺带（探测函数+env 兜底）；b) P8-2 随 ScreenControl 归口 | **b)**——单一真相源（能力协商归接口层），探测逻辑不写两遍 |
| F. 镜像条目上限 | a) 8（relays 先例）；b) 16（automations 先例） | **b)**——载体种类天然多（本地容器 + 多虚机 + 云），8 偏紧 |

## 实施计划（分轮 TODOLIST）

> 轮次编号 P8-x（roadmap P0–P7 之后的下一个工作体，对应 backlog ⑥ 三阶段的落地轮次）。
> 每轮独立可交付、开工前单独呈报该轮实施确认（惯例）。

### P8-1（阶段一）：SshBoxBackend——「CLI 即接口」红利验证轮（2026-09-12 实施完成）

- [x] 1. **SshBoxBackend**（`packages/boxes/src/backend-ssh/`）：exec——argv 经单引号转义包
  `sh -c` 在远端执行、`env` 经 `VAR=v` 前缀注入（SSH SendEnv 受服务端 AcceptEnv 限制不可
  依赖）、timeoutMs/abort 杀本地 ssh 进程；fsRead（cat）/fsWrite（base64 解码写，绕远端
  引号地狱）；openShell（`ssh -tt`）；openPipe（stdout 原始字节——GuiStreamService 与常驻
  注入通道直接可用）；create=attach（连通验证+记账，裁定 C）；teardown=断开；list/stats 如实；
  caps（A2）；远端孤儿 pidfile 补刀（A4——ffmpeg 常驻先例模式泛化）
- [x] 2. **probeSsh + 装配接入**：`ssh -o BatchMode=yes -o ConnectTimeout=5` 探测；
  SandboxPreference 加 `'ssh'`；kernel.ts chooseBackend 分支 + `OPENBOT_SSH_*` env 族
  （HOST/PORT/USER/KEY/DISPLAY）；sandbox status 呈现
- [x] 3. **provision 脚本**（B1）：`tools/provision-gui.sh`——apt 装 xvfb/openbox/
  scrot/ffmpeg + Xvfb/openbox 启动脚本（对齐 gui-ubuntu start.sh 语义，含坑⑲ 幂等清理）；
  Dockerfile 改引共用
- [x] 4. **单测**（G1）：ProcRunner 注入替身——argv 包装形状、env 前缀注入、转义（shQuote
  先例）、timeout/abort 杀进程路径、attach/teardown 语义
- [x] 5. **真机门控套件**（G2）：`OPENBOT_TEST_SSH=1` + 镜像条目 env——exec/fs/PTY/computer
  工具族/实况流在 SSH 载体全链（gui-stream-real 先例）
- [x] 6. **文档**（G4）：ARCHITECTURE §6 矩阵 ssh 行、platforms.md、版本与 plan-backlog ⑥ 勾选

**验收**：VMWare Linux 虚机（或任意 SSH 可达 Linux 主机）provision 后，agent 对话内完成
「exec 跑命令 → computer_screenshot 看屏 → computer_click 点击 → 实况流开启」**零改动全链**
（GUI 工具族与 GuiStreamService 一行不改是本阶段的证明目标）；`pnpm build && pnpm typecheck
&& pnpm test` 全绿；既有 E2E 不回退。

### P8-1 实施记档（2026-09-12）

- **SshBoxBackend 形态**：单实例 = 单机器 = 单 boxId（`ssh-<host 净化>`，跨重启稳定；多 agent
  复用同一载体记账——create 幂等，二次调用零网络往返）；caps persistent ✓ / snapshot ✗ /
  resourceLimits ✗ / isolation high / interactive ✓ / suspendable ✗（vmrun 链随 P8-5）。
  **attach 语义落地（裁定 C）**：create = 连通 `true` + `mkdir -p` 工作目录 + 记账；
  teardown = 只清本侧记账零远端命令——「绝不触碰远端」由单测锁死（teardown 后 calls 计数不变）。
- **远端命令构造单一化**：`buildRemoteScript`（exec/openPipe 共用）——`cd 'cwd'` 前缀 + env
  `K='V'` 前缀 + 全元素 POSIX 单引号转义（顺带消灭 glob 展开，与容器 exec 的 argv 直传语义
  对齐）；远端串刻意不含双引号（Windows ssh.exe 对嵌入双引号 argv 的再切分怪癖）；
  选项全在 destination 之前（其后 token 进远端命令串——单测锁形状）。
- **procexec 新增 `input` 泵送**（fsWrite 地基）：stdin 写入后立即 end（EOF 语义）；子进程提前
  退出的 EPIPE 吞掉不算事实失败。fsWrite 的 base64 只走 stdin——绕 Windows 32K 命令行上限，
  大文件单次往返零分块（对照：wsl/oci 的 base64 走 argv，大体量写本来就受同款上限约束）。
- **probeSsh 两级**：`ssh -V`（版本在 stderr、exit 0——只看退出码）+ 配置 host 时 BatchMode
  试连；未配置 host 只验 CLI（连通性归 create/镜像 test），`chooseBackend` 新增 `sshReady`
  门禁（kernel 以 `OPENBOT_SSH_HOST` 非空喂入）——auto 序不含 ssh（远端机器显式 opt-in）+
  显式偏好 ssh 但未配置主机时如实回退 mock 带指引。
- **工具集提炼（B1）**：`tools/provision-gui.sh` 三子命令（packages / start-desktop / all）；
  容器 Dockerfile 改引（构建上下文换 tools/：`podman build -f apps/desktop/resources/
  gui-ubuntu/Dockerfile tools`）；gui-ubuntu/start.sh 退役（start-desktop 子命令即原语义，
  含坑⑲ X lock 幂等清理）。桌面栈以 xfce 为准（规划文本里 openbox 是 v0.1.6 旧栈笔误）。
- **坑①（本轮，E2E 首训抓到既有回归）**：「ctx 面板收起」用例在干净 HEAD（v0.1.21）即失败，
  与本轮改动无关——根因是 v0.1.20/21 收起动画把 `display:none` 改 `opacity:0`，而 Playwright
  toBeHidden 不认 opacity（0 宽 + 全透明仍可聚焦/可达辅助技术——既是测试语义也是真实无障碍
  缺陷）。修复 = `.console.no-ctx :deep(.ctx)` 补 `visibility:hidden`（过渡 `visibility 0s
  200ms` 等 opacity 收尾再藏——动画手感不变；展开侧 `0s 0s` 立即恢复不卡帧）。方法论记档：
  **stash 对照必须 `-u`（含未跟踪文件）且完整重建 dist/renderer**——首试没带 `-u`，未跟踪的
  backend-ssh 编译错把对照搞成无效实验。
- **测试替身坑**：SshBoxBackend 的 create 产生**两条**调用（true + mkdir）——定向失败替身
  必须 `at(-1)?.includes(...)` 精确命中目标命令，一刀切 exit 1 会先炸在 create；
  probeSsh 配置 host 时是两次 spawn（-V + 试连）——seen[1] 才是连通调用。
- **验证**：typecheck/构建零错；单测 451+16 skipped 全绿（+27：SshBoxBackend 18 / probeSsh 3 /
  chooseBackend ssh 门禁 4 / procexec input 2）；**E2E 28/28**（含修复既有 ctx 收起失败）。
  **真机链路如实记未验收**（待 VMWare/云主机设备）：`OPENBOT_TEST_SSH=1
  OPENBOT_TEST_SSH_HOST=<host> [OPENBOT_TEST_SSH_PORT/USER/KEY/DISPLAY]` 基础全链
  （attach/exec/env/大文件 fs 往返/超时杀连接后存活/abort 传导/PTY 回显/teardown 零远端）+
  `OPENBOT_TEST_SSH_GUI=1` GUI 全链（工具集在场/几何/scrot 截图 magic/ffmpeg 实况管道
  字节直出/pidfile 补刀后 `kill -0` gone）。版本 0.1.22（P8-1）。

### P8-2（阶段二）：ScreenControl 接口化——控制协议解耦

- [ ] 1. **ScreenControl 接口**（boxes `src/screen/`）：`geometry(boxId)` /
  `capture(boxId, opts)`（返回字节 + mime + 缩放/屏幕尺寸元数据——token 纪律与坐标系语义
  内聚适配器）/ `act(boxId, action)`（ScreenAction 联合：click/dblclick/type/key/scroll）/
  `stream(boxId, opts)`（返回已编码字节流常驻会话 + codec meta）/ `inputChannel?(boxId)`
- [ ] 2. **X11ScreenControl**：耦合点 1/2/3 的 xdotool/scrot/ffmpeg 命令与清场模式原样迁入
  （构造参数：exec 通道 + display 地址 + settleMs）——**行为等价重构**，argv 单测锁死
- [ ] 3. **三消费方接线**：ComputerToolDeps 换注入 ScreenControl；GuiStreamService 构造注入
  （argvOf 注入位即为此留）；desktop gui.frame/input 命令面换调适配器（常驻注入通道逻辑随迁）
- [ ] 4. **GUI 生产注册门兑现**（C4，裁定 E）：镜像 GUI 声明 ∩ 工具集探测（B2）∩ provider
  supportsImages → computerEnabled；`OPENBOT_COMPUTER=1` 保留为 E2E 强制门
- [ ] 5. **DISPLAY 配置化**（B3）：全局 env → 装配参数（backend 构造注入，P8-3 由镜像条目接管）
- [ ] 6. **回归**：28 E2E 零回退 + 真机双载体复验（本地容器 + SSH 载体各一轮 GUI 全链）；
  渲染层无类型检查盲区（v0.1.18/19 记档）——gui 命令面迁移真机目验补位

**验收**：行为等价（既有用例/真机交互零感知差异）；生产环境（无 env）GUI 容器在 OCI 后端
时 computer 工具自动注册；SSH 载体 GUI 复验绿。

### P8-3（阶段三 a）：镜像注册表

- [ ] 1. **ImageStore**（state，D1）：`<root>/images.json`；carrier 联合（一期
  `'container' | 'ssh'`，vmware 随 P8-5）；connection 按 carrier 分形状（zod 校验）；
  controlProtocol（'x11' | 'none'）；损坏降级空表 + 上限 16（裁定 F）；单测
- [ ] 2. **RoutingBackend + 工厂**（D2）：`implements BoxBackend` 的多路 facade——按
  `spec.image`（ImageEntry id）路由到对应 backend 实例（缓存 per imageId；'default' 落
  既有全局后端）；coordinator/desktop 装配改持 RoutingBackend，**services/工具族零改动**
- [ ] 3. **命令面 + UI**（D3/D5）：`v1.images.*` 五命令（test = ssh 探测/镜像在场 + 工具集
  探测报告）；设置页「镜像」节（清单 + 载体分表单 + 测试按钮 + 删除确认）
- [ ] 4. **凭据位**（D4）：key 路径一期明文引用；密码/guest 凭据字段 schema 预留 + safeStorage
  密文读写（encryptKey/decryptKey 先例）
- [ ] 5. **E2E**（G3）：镜像 CRUD + test（mock 对称）+ 多条目并存

**验收**：命令面全链 E2E 绿；本地容器镜像与 SSH 镜像条目并存，test 各自如实报告。

### P8-4（阶段三 b）：Agent 绑定与 UI

- [ ] 1. **AgentProfile.imageId?**（E1）：register 可选参数 + setImage（null=清除）；
  悬空双语义（恢复静默回默认 + 告警 / 命令显式拒绝——modelProvider 先例）；单测
- [ ] 2. **装配分流**（E2）：addAgent 的 `backend.create({ image: imageId ?? 'default' })` +
  恢复循环按 profile.imageId 分流（RoutingBackend 解析）
- [ ] 3. **命令面 + UI**（E3/E4）：registerAgent schema 加 imageId；`v1.system.setImage`
  （重启生效语义）；AgentWizard 镜像步；ctx 档案 kv；boxes 视图载体呈现
- [ ] 4. **E2E**（G3）：双 agent 各绑不同镜像条目 → 断言 create 分发到各自后端（A 的 box
  不出现在 B 的后端）+ 绑定悬空恢复路径

**验收**：agent A 绑 VMWare SSH 镜像、agent B 用本地容器——同一控制台并行操控互不串线；
E2E 分流断言绿。

### P8-5（按需）：vmrun 生命周期与 Windows 云电脑记档

- [ ] 1. **VmwareBackend**（A6）：vmrun start/stop/suspend/snapshot/revert 生命周期 +
  SSH 数据面组合；caps.snapshot/suspendable 兑现；vmrun 探测
- [ ] 2. **RDP 设计记档**（F1）：宿主 RDP 客户端注入 vs 镜像内探针 agent 两路线的取舍记录
  （连接模型/凭据/带宽/依赖面），真机接入时裁定——不实施

## 设计要点

1. **RoutingBackend 是改造面收敛的关键**：GuiStreamService/StatsService/ShellService/工具族
   全部持单一 `backend` 引用——多后端并存不逐服务改造，而是装配层一个按 image 路由的
   facade（BoxRegistry 已是 Map<id, backend> 的形，升格为运行时分发）。「Agent 控制镜像」
   的本质落点在此：**镜像条目成为 create 的第一参数，后端退为实现细节**。
2. **create=attach / teardown=断开**（裁定 C）：远端载体的生命周期归用户/云厂商，OpenBot
   只做「接入-操控-断开」；快照等破坏性/有副作用操作按 caps 门禁 + UI 确认（既有快照链
   语义沿用）。该语义扩展记入 ARCHITECTURE §6。
3. **常驻通道红利直接继承**：P0-1 的常驻 `sh -s` 注入通道（openPipe stdin 行式写）与实况
   采集管道（openPipe stdout 原始字节）在 SSH 上同构工作——GUI 输入低延迟与 60fps 流
   不因载体切换回退。
4. **零新 npm 依赖**（裁定 A）：ssh 用宿主 CLI（Windows 10+ 自带，probe 如实 + 指引）；
   vmrun 随 VMware 安装——与 wsl.exe/docker CLI 同「CLI 即接口」哲学，procexec 管线复用。
5. **安全语义**：远端镜像仍是「用户自己的机器」——agent 在其内 exec 维持「Box 内自由」，
   出 Box（宿主文件/网络）审批铁律不变；凭据密文落盘（safeStorage/DPAPI）；远端机器的
   网络不受本仓网络模板策略约束（如实记档——模板策略是容器概念，远端载体不适用）。
6. **能力三源合一不造假**（C4）：GUI 能力 = 镜像声明 ∩ 工具集探测 ∩ provider
   supportsImages——缺一不注册 computer 工具（caps 驱动 UI 惯例的 GUI 延伸）。
7. **兼容**：`BoxSpec.image` 字符串语义保留（'default' = 既有全局后端缺省路径）；新增
   ImageEntry id 进同一字段——wire 与存量数据零迁移。

## 风险与地雷

1. **argv→远端 shell 转义**：SshBackend 的包装层是注入面边界——shQuote 先例 + 单测锁死
   （computer_type 的用户文本路径已有两轮修复史：坑⑫/坑⑮）。
2. **Windows 宿主 ssh.exe 缺席**（可选功能）：probe 如实报不可用 + 设置页指引（OpenSSH
   客户端安装一条命令）——不静默降级。
3. **远端孤儿进程**（坑⑯ SSH 版）：杀本地 ssh 不传导远端——pidfile 补刀模式泛化到
   SshBackend 的所有常驻路径；exec 短命令远端 `timeout` 包裹兜底。
4. **每次 exec 新 SSH 连接延迟**（LAN ~100-300ms）：GUI 输入已由常驻通道解（数 ms）；exec
   工具循环的慢感用 ssh ControlMaster 多路复用缓解——**记档可选项**，实测痛了再开。
5. **阶段二重构回归面**：渲染层无类型检查的历史盲区（v0.1.18/19 两轮记档）——gui 命令面
   迁移必须真机目验补位；argv 断言单测先行的「行为等价」锚点。
6. **E2E 确定性**：SSH 真链路只进门控套件（env 门控 + 独立 Box id 不碰桌面实例——
   gui-stream-real 纪律）；常规 E2E 走 mock 对称（新后端必配 mock，code-style 铁律）。
7. **协议面扩张**：`v1.images.*` 新命令族——wire 版本纪律（v1 前缀、可选字段向后兼容、
   稳定错误码）；凭据字段**永不**进事件流（密文只在命令面读写）。
8. **镜像注册表与快照语义错位**：容器快照是镜像分层、VMWare 是 vmrun 链、SSH 无快照——
   UI 按 caps 呈现不统一承诺（§6 诚实版矩阵惯例的延伸）。

## 排期与验收汇总

P8-1 → P8-2 → P8-3 → P8-4 串行（每轮独立可交付）；P8-5 按需。总量级预估：P8-1 一轮
（后端+探测+脚本+单测+真机套件）、P8-2 一轮（重构为主）、P8-3 一轮、P8-4 一轮。

| 轮 | 交付判据 |
|---|---|
| P8-1 | SSH 载体上 GUI 全链零改动可用（抽象验证命题成立） |
| P8-2 | ScreenControl 接口化 + GUI 生产注册门兑现，行为等价零回退 |
| P8-3 | 镜像注册表 + 命令面 + 设置页，多镜像并存 |
| P8-4 | Agent ↔ 镜像绑定分流，云电脑/VMWare 与本地容器同台操控 |
