# 容器运行时一键安装（v0.2.0 第一批 · 已实施）

> **状态**：已实施（2026-10-20，含第二批 Box 目录参数化）。真机实装验收（作者手动装一个运行时走完全链）待执行。范围裁定记录：只做**容器运行时**安装，镜像获取（rootfs 下载/OCI pull）不在本批；**推翻旧裁定**（v0.1.x「一键安装暂不提供——自动安装系统级软件风险高于收益」，作者 2026-10-20 重新裁定为提供，提权全程透明）。
> **关联**：[ARCHITECTURE.md](../ARCHITECTURE.md) §6 后端矩阵；[docs/platforms.md](platforms.md) 平台地雷。

## 0. 安装器矩阵（8 个，4 种运行时 × 三平台）

| 平台 | 运行时 | 方式 | 提权 | 位置可选 |
|---|---|---|---|---|
| Windows | WSL2 | `wsl --install --no-distribution`（内置组件，零下载） | UAC | 本体❌；发行版目录✅（Box 目录参数化，第二批） |
| Windows | Docker Desktop | 官方滚动直链下载 → 静默装（`install --quiet --accept-license`） | UAC | ❌（如实标注） |
| Windows | Podman | GitHub Releases **latest 解析**（API digest sha256 校验）→ 安装包静默装 | UAC | ❌（machine 目录上游 bug，如实标注） |
| Linux | docker | `pkexec <包管理器> install docker`（apt/dnf/pacman 按 /etc/os-release 分支） | polkit 图形框 | ❌（`--data-root` 属 daemon 配置） |
| Linux | Podman | 同上（多数发行版自带——装器只补缺席） | polkit | ❌ |
| macOS | Docker Desktop | `brew install --cask docker` | 免密 | ❌ |
| macOS | colima | `brew install colima docker`（Docker Desktop 免费替代） | 免密 | ✅（`--disk` 可配——如实标注） |
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

- `v1.runtime.list`：当前平台的安装器清单 `{id, runtime, sourceKind, locationSelectable, locationNote, notes[], fallbackCommand?}`；
- `v1.runtime.install {runtimeId}`：单并发（进行中拒绝再启动），进度走 `v1.runtime.progress` 事件 `{runtimeId, phase: download|verify|install|probe|done|failed|fallback, percent?, detail?, command?}`；
- E2E：`OPENBOT_E2E=1` 时注册 **mock-runtime** 策略（builtin + node 空进程执行）——全链（下载跳过→执行→进度事件→done）不触系统（mock 对称铁律）。

## 4. 安全红线

- 校验失败（digest 型）拒执行；下载走 TLS 官方源；
- 提权全程透明：执行前 UI 明示「将弹出系统授权框」；不绕过 UAC/polkit；用户取消如实收敛；
- 静默参数只用官方文档公开开关；兜底命令全文展示供过目。

## 5. 第二批（Box 目录参数化，随本批合并）

- settings 增 `sandboxDataDir?`（additive，全局默认——重启生效，构造期事实）；
- `WslBoxBackend.create({..., dir?})` 单盒覆盖（`wsl --import` 落盘位置）；
- 建 Agent 向导「模型与沙箱」步增可选数据目录输入 → 注册链透传。

## 6. 验证策略

- 单测：策略表形状/发行版命令分支/下载器（本地 http 源：进度+sha256 通过与拒绝）/目录解析；
- E2E：mock-runtime 全链 + list 断言 + 未知 id 稳定码拒绝；
- **真机实装验收由作者手动执行一次**（自动化不碰真系统安装）。
