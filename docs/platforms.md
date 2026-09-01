# 平台与沙箱矩阵

v1 做 **WSL2 + Docker + Podman + mock** 四个后端（Podman 提前进 v1：2026-08-19 用户裁定，消解 Docker Desktop 授权地雷；
Docker/Podman 双壳 2026-08-26 裁定随 P5 兑现）；**nspawn/UTM 随 P6 进（2026-09-01 兑现——六后端矩阵齐）**：
Linux（systemd-nspawn）与 macOS（UTM）为 CLI 底座 + 脚本化单测 + 探测呈现，真机链路未验收（P6 裁定 B——真机只验版本行为漂移）。
Windows Sandbox 降级为 Pro 用户可选（P4 后视需求）。
接口按 caps 设计，永不按「最强后端都能做什么」设计（ARCHITECTURE.md §6）。

## 后端能力矩阵

| 能力 | WSL2 | Docker | Podman | Windows Sandbox | nspawn (P6) | UTM (P6) | mock |
|---|---|---|---|---|---|---|---|
| 持久化 | ✓ | 需卷挂载 | 需卷挂载 | ✗ 关闭即焚 | ✓（/var/lib/machines） | ✓（VM 注册） | 假装 ✓ |
| 快照 | --export 整盘打包，GB 级、慢 | 镜像分层 | 镜像分层（commit） | ✗ | ✓（export-tar） | ✓（clone/delete 链——载体是 VM 克隆非 tar） | ✓ |
| 资源上限 | 全局 .wslconfig，无法按 Box 限制 | ✓ 严格 | ✓ cgroups v2（rootless 可用） | 粗粒度 | ✓（systemctl set-property 真落 cgroup） | ✗（utmctl 无配置入口——caps 如实） | 假装 ✓ |
| 隔离强度 | 弱（/mnt/c 直通、9P 慢） | 中 | 中（rootless 无 daemon） | 强 | 中 | 强（VM 级） | —— |
| 无人值守 | ✓ | ✓ | ✓（podman machine） | ✗ 无法 headless | 部分（写操作需 root/polkit） | 部分（exec 依赖 guest agent——模板预装） | ✓ |
| 交互终端 | ✓（Box 内 script PTY） | ✓ | ✓ | ✗ | 设计支持（machinectl shell 自带转发；宿主侧 PTY 边界真机待验） | ✗（utmctl attach 未实现——源码 TODO） | ✗ |
| 可用性 | Win10/11 全版本 | 需 Docker Desktop（企业收费） | 免费开源；Windows 经 podman machine | 仅 Pro/Enterprise（Home 没有） | Linux（systemd 自带零安装） | macOS（UTM app + GUI 会话） | 全平台 |

## 已知地雷（实现时对照）

- wsl.exe 输出为 UTF-16LE：解析 --list 须按 wide-char 解码
- **wsl.exe 不自建目录**：`--import` 与 `--export` 的目标目录必须预先存在，否则 exit 4294967295 且
  stderr 为空（错误细节可能落在 stdout——错误信息取 stderr||stdout 兜底）；backend-wsl 在 import/export
  前递归建目录（桌面首启 userData/boxes 不存在，实证）
- Docker Windows 走命名管道，Linux 走 unix socket——端点差异在 boxes 层抽象（我们走 CLI 子进程方案，CLI 直接屏蔽端点差异）
- **Podman on Windows 的 machine 本身占一个 WSL2 发行版**：与「发行版即 Box」共享同一 vmmem——资源告警按全局视角算，不按后端各自承诺
- /mnt/c 9P 慢：项目活在 Box 内或 clone 进去，不跨边界热编辑
- WSL2 全局性：所有 Box 共享一个 vmmem，wsl --shutdown 全杀
- Docker Desktop 企业授权：免费边界写进用户文档（个人/250 人以下企业免费）
- 桌面壳 Windows 缩放迟滞（拖动窗口时内容滞后于窗口边缘、松手后追上）：Chromium 引擎级已知缺陷，
  electron/electron#36280（bug A，上游未修，VS Code / Linear 同样如此；撕裂/残影变体已在
  Electron 39.2.6+ 修复，我们用的 43 已含）。**不是我们 CSS/JS 的问题，勿再排查页面侧**；
  右缘锚定的大块元素（如 ctx 面板）最显眼。等上游修复随 Electron 升级自然获得。
- **全屏 overlay 必须显式 `-webkit-app-region: no-drag`**：fixed/inset:0 元素视觉上盖住 titlebar
  （drag 区）不改变 Chromium 的 drag 判定——不声明 no-drag，落在 titlebar 矩形（顶部 38px）内的
  真实点击被当拖窗吃掉（BoxOps 返回按钮点不动、按住拖动整个窗口，2026-08-20 实证）；
  Playwright/CDP 合成点击绕过 drag 判定，**E2E 测不出此坑**，防回归靠本条记录与真机走查。

## nspawn（Linux，P6 Step 3——真机未验收记档）

- **machinectl 写操作需授权**：import-tar / remove / export-tar / poweroff / start / set-property
  走 polkit（默认要求 root）——无人值守部署要求 sudo NOPASSWD 或 polkit 规则；特权前缀经
  `NspawnBoxBackendOptions.privilegePrefix` 注入（默认无前缀，桌面装配暂不 sudo——真机调优后置）；
  读操作（list / shell / systemctl show）普通用户可
- **机器本体固定在 /var/lib/machines**（machinectl 约定）；快照 tar 导出到 userData 侧
  `boxes/nspawn-snapshots`（与 wsl 的 `boxes/snapshots` 分开）；rootfs 与 wsl 共用同一
  `box-rootfs.tar.gz`（env 分别覆盖：OPENBOT_WSL_ROOTFS / OPENBOT_NSPAWN_ROOTFS）
- **资源上限是 scope 单元属性**：`systemctl set-property machine-<name>.scope CPUQuota=200% MemoryMax=2048M`
  ——真落 cgroup 且持久（system.control）；`machinectl start` 对已运行机器报错，冷热判定先
  `systemctl is-active`（先查后动，幂等）
- **machinectl shell 的 PTY 分配边界真机待验**：exec 用 `--quiet` 无人值守形态（argv 直传）；
  cwd 无法 argv 化（无工作目录参数）——设了 cwd 走 sh -c 包裹（quote 保护）；openShell 的
  宿主侧 PTY 前提（node spawn 管道无 TTY）未实测——失败则 caps.interactive 届时如实降 false
- 快照前 poweroff 保一致性；已关机的机器 poweroff 报错不算失败（幂等分支认 `not active`）

## UTM（macOS，P6 Step 4——真机未验收记档；CLI 事实依据 UTMCtl.swift 源码）

- **utmctl 需 GUI 登录会话**：经 ScriptingBridge 驱动 UTM.app，SSH 会话报 errAEEventNotPermitted
  （源码注释明示）；UTM app 缺席报 Application not found——探测命令 `utmctl version` 双验
- **exec/file/ip-address 全线依赖 QEMU guest agent**：模板 VM 必须预装（headless 的前提——
  「无人值守：部分」的真义）；create = `utmctl clone <template> --name <box>`（UTM 无 rootfs
  导入模型，模板在 UTM GUI 预建；模板名经 OPENBOT_UTM_TEMPLATE 配，默认 openbot-template）
- **utmctl attach 未实现**（源码 WARNING TODO——只打印 PTTY 地址不接管终端）：caps.interactive
  如实 false；串口 PTTY 直连（默认 VM 无 display + 一个 PTTY 串口）记档后置
- **CLI 无资源配置入口**（update configuration 只在 AppleScript 面）：caps.resourceLimits 如实 false；
  无资源统计命令——stats 空报告（字段缺席，UI 不渲染）
- **exec 的 `--cmd` 是 parsing:.remaining**（其后所有 token 归命令，写在命令尾部）；exit code
  与 stdout/stderr 透传（源码 Darwin.exit 语义）；快照 = clone 出 `<name>-snap-N`（无 snapshot
  子命令）；restore = delete 原名 + clone 回原名；stop 已停机会报事件错误——先 `utmctl status`
  查后动（幂等）；`utmctl list` 列格式 `UUID(36) status(pad8) name(可含空格)`——parseUtmList
  纯函数锁死
