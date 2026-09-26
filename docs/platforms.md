# 平台与沙箱矩阵

v1 做 **WSL2 + Docker + Podman + mock** 四个后端（Podman 提前进 v1：2026-08-19 用户裁定，消解 Docker Desktop 授权地雷；
Docker/Podman 双壳 2026-08-26 裁定随 P5 兑现）；**nspawn/UTM 随 P6 进（2026-09-01 兑现）**：
Linux（systemd-nspawn）与 macOS（UTM）为 CLI 底座 + 脚本化单测 + 探测呈现，真机链路未验收（P6 裁定 B——真机只验版本行为漂移）。
**SSH 主机随 plan-image-firstclass P8-1 进（2026-09-12 兑现——七后端矩阵齐）**：机器即 Box 的首个非容器载体，
「镜像一等公民」阶段一（[plan-image-firstclass.md](plan-image-firstclass.md)）。
Windows Sandbox 降级为 Pro 用户可选（P4 后视需求）。
接口按 caps 设计，永不按「最强后端都能做什么」设计（ARCHITECTURE.md §6）。

## 后端能力矩阵

| 能力 | WSL2 | Docker | Podman | Windows Sandbox | nspawn (P6) | UTM (P6) | SSH 主机 (P8-1) | mock |
|---|---|---|---|---|---|---|---|---|
| 持久化 | ✓ | 需卷挂载 | 需卷挂载 | ✗ 关闭即焚 | ✓（/var/lib/machines） | ✓（VM 注册） | ✓（用户资产——attach 语义） | 假装 ✓ |
| 快照 | --export 整盘打包，GB 级、慢 | 镜像分层 | 镜像分层（commit） | ✗ | ✓（export-tar） | ✓（clone/delete 链——载体是 VM 克隆非 tar） | ✗（vmrun 链随 P8-5） | ✓ |
| 资源上限 | 全局 .wslconfig，无法按 Box 限制 | ✓ 严格 | ✓ cgroups v2（rootless 可用） | 粗粒度 | ✓（systemctl set-property 真落 cgroup） | ✗（utmctl 无配置入口——caps 如实） | ✗（远端资源归用户/云厂商） | 假装 ✓ |
| 隔离强度 | 弱（/mnt/c 直通、9P 慢） | 中 | 中（rootless 无 daemon） | 强 | 中 | 强（VM 级） | 强（整机载体） | —— |
| 无人值守 | ✓ | ✓ | ✓（podman machine） | ✗ 无法 headless | 部分（写操作需 root/polkit） | 部分（exec 依赖 guest agent——模板预装） | ✓（密钥免密 + BatchMode） | ✓ |
| 交互终端 | ✓（Box 内 script PTY） | ✓ | ✓ | ✗ | 设计支持（machinectl shell 自带转发；宿主侧 PTY 边界真机待验） | ✗（utmctl attach 未实现——源码 TODO） | ✓（ssh -tt 真 PTY） | ✗ |
| 可用性 | Win10/11 全版本 | 需 Docker Desktop（企业收费） | 免费开源；Windows 经 podman machine | 仅 Pro/Enterprise（Home 没有） | Linux（systemd 自带零安装） | macOS（UTM app + GUI 会话） | 全平台（OpenSSH 客户端；显式偏好 opt-in） | 全平台 |

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

## SSH 主机（P8-1——VMWare Linux 虚机 / 云 Linux 主机；真机链路经 OPENBOT_TEST_SSH 门控套件）

- **接入是 env 接入 + 显式偏好 opt-in**：`OPENBOT_SSH_HOST/PORT/USER/KEY`（KEY=私钥路径）+
  偏好设 `ssh`（设置页「SSH 主机」或 env `OPENBOT_SANDBOX=ssh`）；**auto 择优序永不含 ssh**——
  远端机器不是本地沙箱，误选等于把 agent 的重活丢到用户资产上；主机未配置时 chooseBackend
  按 `sshReady=false` 如实回退 mock 带指引
- **密钥免密是无人值守前提（裁定 D key-only）**：`BatchMode=yes` 下密码/口令提示一律快速失败
  （Permission denied 如实回传，不悬挂等输入）；带口令的私钥不受支持——ssh-agent 解锁记档后续
- **argv → 远端命令串是单一构造点**（`buildRemoteScript`）：POSIX 单引号全元素转义（消灭词切分
  与 glob——与容器 exec 的 argv 直传语义对齐）+ env `K='V'` 前缀注入（**SSH SendEnv 受服务端
  AcceptEnv 限制，不可依赖**）；远端串只含单引号不含双引号（Windows ssh.exe 对嵌入双引号的
  argv 再切分有历史怪癖）；远端登录 shell 需 POSIX（bash/zsh/sh；fish 不支持 `VAR=v cmd` 前缀）
- **超时/中止杀的是本地 ssh 进程**：连接断开时 sshd 回收会话内进程（短命令天然收口）；
  常驻采集（ffmpeg/注入 sh）的孤儿补刀走 pidfile 模式（坑⑯ 的 SSH 版，GuiStreamService 既有
  exec 通道完成）——真机套件含「杀后 kill -0 gone」断言
- **每次 exec 新连接**（LAN ~100-300ms 握手）：GUI 输入已由常驻 `sh -s` 通道解（数 ms）；
  exec 工具循环的慢感用 ssh ControlMaster 多路复用缓解——**记档可选项**，实测痛了再开
- **openPipe 显式 `-T` 禁 PTY**：PTY 的 \r\n 翻转会毁 jpeg 帧（二进制纯净与容器路径同款纪律）；
  **openShell 用 `ssh -tt`**：远端 sshd 分配真 PTY，stty 注入尺寸后 exec bash 接管会话
- **fsWrite 走 stdin 泵送**（procexec `input`）：base64 只进 stdin 不进 argv——绕 Windows 32K
  命令行上限；远端 `base64 -d > path` 读到 EOF 落盘（单次往返零分块）
- **GUI 工具集预置**：`tools/provision-gui.sh`（与容器模板 Dockerfile 共用同一份包清单与桌面
  会话启动——镜像内工具集单一真相源）；虚机上 `bash provision-gui.sh` 一键装栈 + 启动
  Xvfb+xfce 会话；OpenBot 侧另需 `OPENBOT_GUI_DISPLAY=:0`（远端虚拟显示地址，:2 是 WSLg 缺省）
- 探测两级：`ssh -V`（CLI 在场；版本号打印在 stderr、exit 0）+ 配置了 host 时 BatchMode 试连
  （5s ConnectTimeout，主机不可达/密钥被拒是最常见不可用态——docker info 同哲学）；
  Windows 的 OpenSSH 客户端是可选功能（设置页探测项缺席时按指引一条命令安装）

## Windows 机内（P9-3a——VMware Windows 虚机 / 云电脑 / 云 Windows 主机；真机链路经 OPENBOT_TEST_WINSSH 门控套件）

目标机一次性准备（管理员 PowerShell）：

```powershell
# 1) OpenSSH Server（Capability 方式——Win10 1809+ / Win11 通用）
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
# 2) 防火墙放行 22（OpenSSH-Server.Install 默认规则已建——手工兜底）
New-NetFirewallRule -Name 'OpenSSH-Server-Manual' -DisplayName 'OpenSSH Server' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
# 3) 密钥免密（裁定 D key-only——BatchMode 下密码提示快速失败）
#    把客户端公钥写入目标机 <用户_profile>\.ssh\administrators_authorized_keys（管理员组用户）
#    或 authorized_keys（普通用户），并修正 ACL：
icacls "$env:ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "SYSTEM:F" /grant "BUILTIN\Administrators:F"
```

- **默认 shell 无关紧要**：所有命令经 `powershell -EncodedCommand <UTF-16LE b64>` 单 token
  传输——cmd/powershell 默认 shell 双透明，零引号地狱（P9-3a 裁定 B）。
- **GUI 面前提**：目标机桌面保持**登录态**（锁屏/注销后 CopyFromScreen 截屏失效——如实报错）；
  注入 = SendInput（与宿主屏幕同一份脚本），远端整机 isolation high——不经本机审批闸。
- **PTY**：`ssh -tt` + powershell 交互；Windows 无 stty——终端尺寸 80×24 缺省（记档）。
- **已知限制记档**：快照无原语（vmrun 链随 P8-5）；PS 5.1 为基线（脚本不用 -AsByteStream
  等 PS7 专属）；缩放显示器的物理像素坐标实测归门控套件回填。
- **门控套件**：`OPENBOT_TEST_WINSSH=1 OPENBOT_TEST_WINSSH_HOST=<host> [PORT/USER/KEY]`
  基础链（attach/exec/env/fs/PTY 路径）；`OPENBOT_TEST_WINSSH_GUI=1` 注入/截屏/帧流全链
  （会真实注入目标机键鼠——需人在目标机旁监督）。
