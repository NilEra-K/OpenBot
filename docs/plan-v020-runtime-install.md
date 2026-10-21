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

- `v1.runtime.list`：当前平台的安装器清单 `{id, runtime, sourceKind, installDirSelectable, dataDirSelectable, locationNote, notes[], fallbackCommand?}`（2026-10-21 起 `locationSelectable` 拆为两个布尔——旗标字面量属执行器实现细节不进协议）；
- `v1.runtime.install {runtimeId, installDir?, dataDir?}`：单并发（进行中拒绝再启动）；位置参数须策略声明旗标（否则稳定码 `RUNTIME_LOCATION_NOT_SUPPORTED` 拒绝——不静默装到默认位置），进度走 `v1.runtime.progress` 事件 `{runtimeId, phase: download|verify|install|probe|done|failed|fallback, percent?, detail?, command?}`；
- E2E：`OPENBOT_E2E=1` 时注册 **mock-runtime** 策略（builtin + node 1.5s 进程执行 + `locationFlags.installDir`）——全链（下载跳过→执行→进度事件→done）不触系统（mock 对称铁律），位置输入链（确认模态输入→命令面透传→执行 detail 含旗标值）可断言。

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

## 6. 验证策略

- 单测：策略表形状/发行版命令分支/下载器（本地 http 源：进度+sha256 通过与拒绝）/目录解析；
- E2E：mock-runtime 全链 + list 断言 + 未知 id 稳定码拒绝；
- **真机实装验收由作者手动执行一次**（自动化不碰真系统安装）。
