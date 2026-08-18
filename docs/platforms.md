# 平台与沙箱矩阵

v1 只做 **WSL2 + Docker + mock** 三个后端；Windows Sandbox 降级为 Pro 用户可选（P4 后视需求）；
Linux / macOS 后端 P4 进。接口按 caps 设计，永不按「最强后端都能做什么」设计（ARCHITECTURE.md §6）。

## 后端能力矩阵

| 能力 | WSL2 | Docker | Windows Sandbox | nspawn (P4) | UTM (P4) | mock |
|---|---|---|---|---|---|---|
| 持久化 | ✓ | 需卷挂载 | ✗ 关闭即焚 | ✓ | ✓ | 假装 ✓ |
| 快照 | --export 整盘打包，GB 级、慢 | 镜像分层 | ✗ | ✓ | ✓ | ✓ |
| 资源上限 | 全局 .wslconfig，无法按 Box 限制 | ✓ 严格 | 粗粒度 | ✓ | ✓ | 假装 ✓ |
| 隔离强度 | 弱（/mnt/c 直通、9P 慢） | 中 | 强 | 中 | 强 | —— |
| 无人值守 | ✓ | ✓ | ✗ 无法 headless | ✓ | 部分 | ✓ |
| 可用性 | Win10/11 全版本 | 需 Docker Desktop（企业收费） | 仅 Pro/Enterprise（Home 没有） | Linux | macOS | 全平台 |

## 已知地雷（实现时对照）

- wsl.exe 输出为 UTF-16LE：解析 --list 须按 wide-char 解码
- Docker Windows 走命名管道，Linux 走 unix socket——端点差异在 boxes 层抽象
- /mnt/c 9P 慢：项目活在 Box 内或 clone 进去，不跨边界热编辑
- WSL2 全局性：所有 Box 共享一个 vmmem，wsl --shutdown 全杀
- Docker Desktop 企业授权：免费边界写进用户文档；P4 评估 podman socket 兼容
- 桌面壳 Windows 缩放迟滞（拖动窗口时内容滞后于窗口边缘、松手后追上）：Chromium 引擎级已知缺陷，
  electron/electron#36280（bug A，上游未修，VS Code / Linear 同样如此；撕裂/残影变体已在
  Electron 39.2.6+ 修复，我们用的 43 已含）。**不是我们 CSS/JS 的问题，勿再排查页面侧**；
  右缘锚定的大块元素（如 ctx 面板）最显眼。等上游修复随 Electron 升级自然获得。
