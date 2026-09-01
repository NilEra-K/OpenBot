# OpenBot

跑在你自己电脑上的多 agent 社交控制台——重活进本机沙箱（Box），云依赖降到最低（仅保留 LLM API）。

- 产品定位：[PRODUCT.md](PRODUCT.md)
- 架构唯一权威：[ARCHITECTURE.md](ARCHITECTURE.md)
- 视觉母版：prototype.html（渲染层 P2 迁移底稿）
- 协议 / 平台矩阵 / clean-room 声明：docs/

## 状态

P6 平台扩展与分发进行中（六后端矩阵齐 + win 打包链落地）。路线图与各阶段验收标准见 ARCHITECTURE.md §11。

## 开发

要求：Node >= 22 + pnpm。

    pnpm install
    pnpm build        # tsc 项目引用全量构建
    pnpm typecheck    # 类型检查
    pnpm test         # vitest 全量单测
    pnpm desktop      # 启动 Electron 桌面壳（开发态）

## 打包与分发（P6）

    pnpm --filter @openbot/desktop dist

完整链：tsc → renderer（vite）→ main/preload esbuild 预 bundle（workspace 依赖收进单文件，
消解 pnpm + electron-builder 的 node_modules 收集坑）→ electron-builder。国内网络自动走
npmmirror 双镜像（electron 二进制 + builder 工具链，env 已设时不覆盖）。

- **win**：`OpenBot-x.y.z-setup.exe`（nsis 安装器）+ `OpenBot-x.y.z-portable.exe`（便携版）——
  本机已验证安装/启动/卸载闭环（静默参数 `/S`；E2E 直接打产物跑全链）
- **linux / mac**：deb/AppImage/dmg 的打包配置就绪，产物**待设备**（裁定 A：不在 WSL2 启动
  linux 构建链，mac dmg 须 mac 环境）——设备就绪后在对应平台跑同命令即出产物
- **签名**：无证书不签名——未签名安装器首次运行会触发 Windows SmartScreen 警告
  （「更多信息 → 仍要运行」），这是预期行为；代码签名/公证记档后续版本
- **沙箱后端可用性**（探测事实驱动，按平台自动裁剪呈现）：win = WSL2 / Docker Desktop /
  podman machine；linux = systemd-nspawn（写操作需 root/polkit 授权）/ docker / podman；
  mac = UTM（模板克隆模型，需预装 guest agent 的模板 VM）/ docker / podman。
  **Docker Desktop 授权边界**：个人与 250 人以下企业免费，更大规模需付费订阅
  （[docs/platforms.md](docs/platforms.md)）

## 结构

八个自研包 + 三个壳；依赖规则与三条铁律见 ARCHITECTURE.md §2。

许可证：Apache-2.0（clean-room 自研，声明见 docs/cleanroom.md）。
