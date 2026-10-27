# 容器运行时一键安装（v0.2.0 第一批 · 已实施）

> **状态**：已实施（2026-10-20，含第二批 Box 目录参数化；2026-10-21 第三批位置旗标 + Podman MSI 资产修复，见 §5b）。真机实装验收（作者手动装一个运行时走完全链）待执行——**Podman 项升为必验**（修复的是真 bug）。范围裁定记录：只做**容器运行时**安装，镜像获取（rootfs 下载/OCI pull）不在本批；**推翻旧裁定**（v0.1.x「一键安装暂不提供——自动安装系统级软件风险高于收益」，作者 2026-10-20 重新裁定为提供，提权全程透明）。
> **关联**：[ARCHITECTURE.md](../ARCHITECTURE.md) §6 后端矩阵；[docs/platforms.md](platforms.md) 平台地雷。

## 0. 安装器矩阵（8 个，4 种运行时 × 三平台）

| 平台 | 运行时 | 方式 | 提权 | 位置可选 |
|---|---|---|---|---|
| Windows | WSL2 | `wsl --install --no-distribution`（内置组件，零下载） | UAC | 本体❌（系统组件随系统盘）；Box 数据目录✅（行级 ⚙，第二批） |
| Windows | Docker Desktop | 官方滚动直链下载 → 静默装（`install --quiet --accept-license`） | UAC | **安装位置✅（`--installation-dir`）+ 容器数据位置✅（`--wsl-default-data-root`）**——2026-10-21 位置旗标 |
| Windows | Podman | GitHub Releases **latest 解析**（API digest sha256 校验）→ **MSI 静默装**（`msiexec /package /quiet ALLUSERS=1 MACHINE_PROVIDER=wsl`） | UAC | **安装位置✅（MSI `INSTALLDIR` 公开属性）**；容器数据位置❌（machine 目录上游 bug） |
| Linux | docker | `pkexec <包管理器> install docker`（apt/dnf/pacman 按 /etc/os-release 分支） | polkit 图形框 | ❌（安装随包管理器；`--data-root` 属 daemon 配置） |
| Linux | Podman | 同上（多数发行版自带——装器只补缺席） | polkit | ❌ |
| macOS | Docker Desktop | `brew install --cask docker` | 免密 | ❌ |
| macOS | colima | `brew install colima docker`（Docker Desktop 免费替代） | 免密 | ❌（虚拟机磁盘属装后配置 `colima start --disk`——旧表「✅」系装后配置误标，2026-10-21 纠正） |
| macOS | Podman | `brew install podman` | 免密 | ❌ |

- **nspawn（Linux）零安装**：systemd 自带，探测可用即用。
- **UTM 后置**：VM 载体非容器，随 macOS GUI 沙箱路线后续批次。
- **Homebrew 前置依赖（macOS）**：brew 缺席 → 如实给出官方安装引导（复制执行），不静默装 brew。

## 1. 架构（壳层职责——装宿主系统软件不进内核域）

```
apps/desktop/src/main/installers/
├─ downloader.ts   流式下载 + 进度 + sha256（校验失败拒绝执行）
├─ strategies.ts   安装策略注册表（数据驱动：source 三型——builtin / direct / github-latest / package-manager）
└─ index.ts        执行器分派 + 进度事件发涌
```

- **Windows 提权**：`powershell Start-Process -Verb RunAs -Wait -PassThru`（UAC 由系统弹，用户取消 → 错误 1223 如实上报）；
- **Linux**：`pkexec`（polkit 图形框）→ 退出码 126/127（无 agent）或失败 → **回退命令生成**（UI 全文展示 + 复制，用户过目后自行执行）；
- **macOS**：brew 直接执行（用户态）；缺席 → 引导命令回退（同 Linux 兜底通道）。

## 2. 哈希校验的诚实分级

| 来源 | 校验 |
|---|---|
| GitHub Releases（Podman win） | **API digest sha256**（运行时解析 latest——无陈旧 pin，校验失败拒执行） |
| Docker Desktop 官方滚动直链 | **无预置哈希可用**（滚动 URL）——如实标注「TLS 传输、官方源直链」，记档后续版本 pin |
| 内置组件（WSL2）/ 包管理器（Linux/macOS） | 系统渠道自身完整性（不重复校验） |

## 3. 命令与事件面（additive）

- `v1.runtime.list`：当前平台的安装器清单 `{id, runtime, sourceKind, installDirSelectable, dataDirSelectable, locationNote, notes[], fallbackCommand?}`（2026-10-21 起 `locationSelectable` 拆为两个布尔——旗标字面量属执行器实现细节不进协议）；**2026-10-27 分层改造**：`available` 布尔退役 → `installState`（absent|installed|unknown，他平台 null）× `engineState`（running|stopped|unknown）+ `note` 稳定码（machine-missing）+ `launchSupported` 布尔（声明制），且改**调用时活探测**（去重并行；不再读构造期快照）；
- `v1.runtime.install {runtimeId, installDir?, dataDir?}`：单并发（进行中拒绝再启动）；位置参数须策略声明旗标（否则稳定码 `RUNTIME_LOCATION_NOT_SUPPORTED` 拒绝——不静默装到默认位置），进度走 `v1.runtime.progress` 事件 `{runtimeId, phase: download|verify|install|probe|done|failed|fallback, percent?, detail?, command?}`（**2026-10-27 增相位 `launch`/`ready`**——启动实况/就绪终态，与安装链同通道）；
- `v1.runtime.launch {runtimeId}`（2026-10-27 v0.1.89）：单飞（重复拒绝 `RUNTIME_LAUNCH_BUSY`）；策略须声明 `launch`（否则 `RUNTIME_LAUNCH_NOT_SUPPORTED`），拉起/等待失败 `RUNTIME_LAUNCH_FAILED`（detail 带上游 stderr/超时事实）；受理即返，实况走 progress 事件；
- `v1.runtime.cancel`（2026-10-27 扩可选 `runtimeId`）：在场 = 取消该运行时启动等待（停轮询）；缺席 = 取消在途安装（原语义，兼容既有调用）；
- E2E：`OPENBOT_E2E=1` 时注册 **mock-runtime** 策略（builtin + node 3s 进程执行 + `locationFlags.installDir` + `launch: mock`；台账：装完 installed / launch ready 后 running——模拟 DD 完整生命周期）——全链（下载跳过→执行→进度事件→done→立即启动→launch→ready）不触系统（mock 对称铁律），位置输入链（确认模态输入→命令面透传→执行 detail 含旗标值）与分层反转断言（装后不再现一键安装）可断言。

## 4. 安全红线

- 校验失败（digest 型）拒执行；下载走 TLS 官方源；
- 提权全程透明：执行前 UI 明示「将弹出系统授权框」；不绕过 UAC/polkit；用户取消如实收敛；
- 静默参数只用官方文档公开开关；兜底命令全文展示供过目。

## 5. 第二批（Box 目录参数化，随本批合并）

- settings 增 `sandboxDataDir?`（additive，全局默认——重启生效，构造期事实）；
- `WslBoxBackend.create({..., dir?})` 单盒覆盖（`wsl --import` 落盘位置）；
- 建 Agent 向导「模型与沙箱」步增可选数据目录输入 → 注册链透传。

## 5b. 第三批（2026-10-21：位置旗标三术语 + Podman v6 MSI 资产修复）

**位置语义三术语**（用户裁定，全链不再混称「数据目录」）：

| 术语 | 含义 | 在哪选 |
|---|---|---|
| 安装位置 | 运行时程序本体装哪 | 安装确认模态（策略声明 `locationFlags.installDir` 才呈现输入） |
| 容器数据位置 | 容器镜像/卷落盘哪（如 docker-desktop-data） | 同上（`locationFlags.dataDir`） |
| Box 数据目录 | OpenBot 自建 Box 发行版 VHDX 落盘哪 | 行级 ⚙ 模态（wsl2/nspawn；第二批语义，UI 改版同规格化） |

- 策略层 `locationFlags?: { installDir?, dataDir? }`（值为参数前缀，组装成单参 `<flag><值>`）；`locationSelectable` 布尔退役；只声明上游真实支持的旗标——Docker Desktop win 双旗标（官方安装器文档）、Podman win `INSTALLDIR`（WiX 公开属性，`contrib/win-installer/wix/podman-main.wxs`）；
- 执行器 `assembleLocationArgs`（未声明而传值 → 抛错，不静默装到默认位置）+ `buildLaunchPlan`（`launcher: 'msiexec'` → `msiexec.exe /package <文件>` 拉起形态）；
- **Podman v6 资产脱节修复（真 bug，v0.1.86 遗留）**：旧 assetPattern `podman-*-setup.exe` 在 v6 起必失配（官方只发 `podman-installer-windows-amd64.msi`，v6.1.4 核实）——真机一键安装 Podman 此前必失败（E2E mock 对称故未暴露）；随本批改 MSI + msiexec 静默式样（官方 build_windows.md）；
- ⚙ Box 数据目录模态改版（用户报障驱动）：补标签/「浏览…」/「恢复默认」/Esc/外点关闭/动作区右置——与同页「数据目录」「会话记录目录」模态同规格（此前为 approval-modal 半成品借壳）；
- 兜底命令与包管理器型不受位置旗标影响（无安装器参数可注入，如实）。

## 5c. 第四批（2026-10-27 v0.1.89：已装/未跑状态分层 + 启动引导）

**动机（真机报障）**：已装 Docker Desktop 而引擎未运行时，设置页矩阵行误显「一键安装」；且装完无启动引导（需手动去开始菜单找）。根因有二：探测链单布尔（引擎可达）压平了「装没装」×「跑没跑」；`v1.runtime.list` 读构造期探测快照（安装/启动后不更新——done 模态「重启应用后即可」文案即此产物）。win 先行（DD + Podman launch），linux/mac backlog；就绪超时 5 分钟。

- **探测分层**：`installState`（absent|installed；CLI 层 `--version` / 官方默认安装位在场）× `engineState`（running|stopped|unknown；`docker info` Server 段 / `podman machine list` Running——absent 不探测）。`v1.runtime.list` 改调用时活探测（目标去重并行），旧 `available` 布尔同提交退役。装配面 `probeAll` 快照语义不变（chooseBackend 是构造期事实）。
- **PATH 继承坑（win）**：进程 PATH 启动时继承——新装运行时 CLI 不在本进程 PATH（`where` 找不到）。CLI/exe 解析一律 where 优先 → 官方默认安装位回退（DD `C:\Program Files\Docker\Docker`、Podman `C:\Program Files\Podman\podman.exe`）——装完「立即启动」与分层状态免重启应用。
- **launch 声明制**（策略未声明即不显示启动钮）：DD/win = 拉起 `Docker Desktop.exe`（docker CLI 路径 **bin 上两级**推导 = 安装根——官方布局 `resources\bin`；detached 免提权）；Podman/win = `podman machine start`（用户级 VM 操作免提权）。
- **就绪轮询**（`installers/launcher.ts`，全依赖注入）：2.5s 间隔、5 分钟超时如实收敛（失败文案指向 DD 首启初始化事实，不静默假装就绪）；每轮上抛已等秒数（行内/模态实况）。取消 = 停轮询——DD detached 已拉起进程不杀（用户裁定）；machine-start 子进程随 abort 即杀（如实文案区分）。
- **UI 三态**：未安装→一键安装 / 已装·未跑→启动（钮旁 ⓘ 首启条款；DD stopped 行一行提示引导去官方设置勾开机自启——**不代改**）/ 运行中→已可用。启动中行内态（mini 可点回看 + 「取消等待」）；安装 done 模态加「立即启动」主钮。podman 无 machine（`note: machine-missing`）→「需初始化」chip + init 指引（start 必败不给假钮）；未声明 launch 的已装未跑行（linux/mac）→「已安装·未运行」如实标注。
- **补位稳定码**（裁定清单外必要项）：`RUNTIME_LAUNCH_BUSY`（单飞防双击）；`engineNote: 'machine-missing'`（podman init 前置事实）。
- **mock 对称**：mock-runtime 生命周期台账（装完 installed / launch ready 后 running——事件回调内同步置位防竞态）+ `launch: {kind:'mock'}`（内存等待 3s 不触真系统）；安装 builtin 停留 1.5s→3s（取消链断言窗口）。

## 5d. 第五批（2026-10-27 v0.1.90：状态面打磨——分节刷新/看门狗/启动全平台补齐）

**四件套（v0.1.89 余波收尾）+ linux docker 启动（作者当日裁定含本批）+ linux podman 语义修正：**

- **分节刷新**：设置页切到「容器与镜像」时重拉 `v1.runtime.list`（活探测幂等秒级）——外部启停引擎后旧态不残留。`v1.sandbox.status` 不刷（probes 是构造期快照，刷了也不动——探测卡一致性另议）。
- **done 模态文案两态**：launchSupported → 「点『立即启动』即可就绪」；其余 → 「状态已即时更新；用作沙箱后端需重启应用生效」（重启的真语义=装配是构造期事实——替换 v0.1.86「如探测未即时生效」错位文案）。
- **引擎看门狗**（`installers/watchdog.ts`，注入可测）：选定后端 docker/podman 时 60s 周期探测（launcher.engineReadyOf 同判据三态：ready/stopped/**unknown**），仅跃迁触发新事件 `v1.runtime.engine {engine, running}` → 渲染层 toast（掉线警示/恢复告知）+ 矩阵刷新；unknown（通道异常）不误报掉线；E2E mock 后端不装配；随应用退出 stop。ready 相位补 success toast（后台等待转就绪有感知）。
- **launch 全平台补齐**（作者裁定 linux docker 含本批；类型重构无协议影响——协议仍只传布尔+提权面）：
  - 型扩：`cli`（startArgs + readyCheck 枚举 + defaultCliPaths 多默认位回退 + elevation）替换 v0.1.89 machine-start；`open-app`（mac `open -a`——LaunchServices 寻径）；
  - 声明：win DD=app（不变）/ win·mac Podman=cli machine start / mac colima=cli start（colima status 判据）/ **mac DD=open-app + installState 探测（/Applications/Docker.app 在场）** / **linux docker=cli `systemctl start docker` + polkit**；
  - **提权透明（安装确认同款红线）**：协议加 `launchElevation: 'none'|'polkit'`；polkit 启动先弹启动确认模态（launchConfirm 段——polkit 告知 + 命令全文），免提权仍一键直启；pkexec 126/127（无 agent）→ 稳定失败带 `sudo` 手动指引；授权取消 → canceled 如实收敛；
  - resolveCli 泛化（PATH → 多默认位按序）：win PATH 继承坑 + **mac GUI 进程 PATH 不含 brew 位**（launchd PATH=/usr/bin:/bin——/opt/homebrew 与 /usr/local 双位回退）。
- **linux podman daemonless 修正（v0.1.89 遗留 bug）**：linux podman 无 machine 概念、CLI 在场即恒可用——machine list 探测会误报「需初始化」；`probePodmanLayered` 增平台参数（linux 短路 installed+running）。
- **如实记档**：mac/linux 启动链真机验收待作者手动（Windows 开发机不可验——单测 fake runner 覆盖形状与结算，与 v0.1.86 安装器同纪律）。

## 6. 验证策略

- 单测：策略表形状/发行版命令分支/下载器（本地 http 源：进度+sha256 通过与拒绝）/目录解析；2026-10-27 增：分层探测矩阵（docker/podman/wsl 装跑两维 + linux podman daemonless）、启动器（bin 上两级推导/exe 与 CLI 多默认位解析/engineReadyOf 三态/轮询 ready·timeout·canceled 收敛/app·open-app·cli·polkit·mock 拉起与结算形态）、launch 声明矩阵（全平台）、看门狗跃迁（掉线→恢复各一次、unknown 不误报）；
- E2E：mock-runtime 全生命周期（取消安装→正装→done 模态立即启动→取消等待→再启动→已可用）+ 分层反转断言（装后不再现一键安装）+ 未知 id 稳定码拒绝；
- **真机实装验收由作者手动执行一次**（自动化不碰真系统安装）；2026-10-27 起真机补验「已装 DD 引擎未跑 → 行显示启动而非一键安装」与「立即启动→等待就绪→已可用」两链。
