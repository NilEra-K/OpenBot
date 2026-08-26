# 平台与沙箱矩阵

v1 做 **WSL2 + Docker + Podman + mock** 四个后端（Podman 提前进 v1：2026-08-19 用户裁定，消解 Docker Desktop 授权地雷；
Docker/Podman 双壳 2026-08-26 裁定随 P5 兑现）；
Windows Sandbox 降级为 Pro 用户可选（P4 后视需求）；
Linux / macOS 后端 P6 进（2026-08-26 裁定顺延）。接口按 caps 设计，永不按「最强后端都能做什么」设计（ARCHITECTURE.md §6）。

## 后端能力矩阵

| 能力 | WSL2 | Docker | Podman | Windows Sandbox | nspawn (P6) | UTM (P6) | mock |
|---|---|---|---|---|---|---|---|
| 持久化 | ✓ | 需卷挂载 | 需卷挂载 | ✗ 关闭即焚 | ✓ | ✓ | 假装 ✓ |
| 快照 | --export 整盘打包，GB 级、慢 | 镜像分层 | 镜像分层（commit） | ✗ | ✓ | ✓ | ✓ |
| 资源上限 | 全局 .wslconfig，无法按 Box 限制 | ✓ 严格 | ✓ cgroups v2（rootless 可用） | 粗粒度 | ✓ | ✓ | 假装 ✓ |
| 隔离强度 | 弱（/mnt/c 直通、9P 慢） | 中 | 中（rootless 无 daemon） | 强 | 中 | 强 | —— |
| 无人值守 | ✓ | ✓ | ✓（podman machine） | ✗ 无法 headless | ✓ | 部分 | ✓ |
| 可用性 | Win10/11 全版本 | 需 Docker Desktop（企业收费） | 免费开源；Windows 经 podman machine | 仅 Pro/Enterprise（Home 没有） | Linux | macOS | 全平台 |

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
