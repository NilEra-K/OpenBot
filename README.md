# OpenBot

跑在你自己电脑上的多 agent 社交控制台——重活进本机沙箱（Box），云依赖降到最低（仅保留 LLM API）。

- 产品定位：[PRODUCT.md](PRODUCT.md)
- 架构唯一权威：[ARCHITECTURE.md](ARCHITECTURE.md)
- 视觉母版：prototype.html（渲染层 P2 迁移底稿）
- 协议 / 平台矩阵 / clean-room 声明：docs/

## 状态

**v0.1.0**——路线图（P0–P7）功能全齐的第一个可用里程碑。路线图与验收标准见 ARCHITECTURE.md §11。

## 安装与上手（Windows）

1. **安装**：`OpenBot-x.y.z-setup.exe`（安装向导）或 `OpenBot-x.y.z-portable.exe`（免安装单文件）。
   首次运行未签名安装器会触发 Windows SmartScreen 警告——点「更多信息 → 仍要运行」（无代码
   签名证书的如实预期，签名记档后续版本）。
2. **配模型**：设置 → 「＋ 添加模型」——填 OpenAI 兼容端点（DeepSeek/Kimi/本地 Ollama 均可）
   或 Anthropic 协议 → 保存 → 设为主力。
3. **开始对话**：控制台对管家发消息；「＋ 新建 agent」添加工人；重活自动进本机沙箱（Box）执行。
4. **沙箱后端**（设置页按本机探测自动呈现可选项）：Windows 默认 WSL2（需放置 rootfs，见
   [docs/platforms.md](docs/platforms.md)）；也可 Docker Desktop / podman machine。
5. **关窗不退出**：关闭窗口驻留托盘（托盘菜单退出）；设置 → 通用可开「开机自启动」。

**更新**：暂无在线更新通道（项目尚无远端分发渠道——如实记档），新版重新下载安装即可，
数据（对话/agent/设置）保留在用户数据目录不受影响。

## 跨用户房间（P7，自托管）

好友跨公网进房间协作（mirror 一期：本端对话镜像给房间 + 远端 turn 请求经审批闸门受控进入）。
**relay 是自托管软件，官方不运营服务**——推荐 Tailscale/自组网内自建：

    pnpm --filter @openbot/relay start          # node 进程（env 约定见文档）
    docker build -f apps/relay/Dockerfile -t openbot-relay .

接入：桌面设置页「跨用户房间」填 host 地址/房间码/invite 码，重启生效。
协议四件套（turn-request/result、10 分钟 30 turn 预算、不可达退避、nonce 幂等）与安全基线
见 [docs/relay-protocol.md](docs/relay-protocol.md)（§0 本地优先先读）。

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

## 致谢

- **[GrokBall](https://github.com/tycoding/grok-ball)**（MIT, © 2026 tycoding）——Agent 头像小球引擎（眼睛跟随、呼吸、32 表情）参考并源自该仓库。表情状态映射与后续扩展在 `emotions.openbot.ts` 自持维护。
