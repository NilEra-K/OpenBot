# P6 实施计划（平台扩展与分发）

> 状态文档：随实施推进更新勾选与「设计要点」。架构依据 [ARCHITECTURE.md](../ARCHITECTURE.md) §11
> （P6 行：2026-08-26 裁定重排）；平台地雷矩阵 [platforms.md](platforms.md)（nspawn/UTM 行随本轮补实测）。
> 与架构文档冲突时以 ARCHITECTURE.md 为准。
> 上阶段记录见 [plan-p5.md](plan-p5.md)（P5 已收官——四后端矩阵收敛、消息域双达成）。
> P3 遗留两件随本轮兑现：**win nsis/portable 打包**（P3 行原文）；P5 Step 8 真机验收未验收状态如实延续
> （机器条件就绪即用已参数化的真实套件复跑）。

## 目标与验收

兑现 §11 P6 行：**Linux（nspawn + 原生 docker）、macOS（UTM）、electron-builder 三平台打包**。
分发域与平台域同轮合并（2026-08-26 裁定——边界干净：本轮不碰消息域与 relay）。

- **验收**：win nsis + portable 双产物本机安装冒烟（真内核装配 + 界面启动 + 端到端一轮）；
  Linux/macOS 产物与后端按「待裁定的范围」执行深度；平台矩阵如实标注（capabilities 驱动 UI——
  win 上不出现 nspawn/UTM，探测不可用自然隐藏）；`pnpm build && pnpm typecheck && pnpm test` 全绿；
  既有 18 E2E 用例不回退；
- **不造假纪律延续**：无真机的后端「CLI 底座 + 脚本化单测 + 探测呈现」兑现，真机链路如实记
  「未验收」（P5 Step 8 模式）；无证书则不签名并记档 SmartScreen 提示预期。

## 待裁定的范围（批准本计划时逐项表态，未表态按推荐执行）

| 项 | 选项 | 推荐 |
|---|---|---|
| A. Linux/mac 构建环境 | a) Linux 在本机 WSL2 内构建 deb/AppImage，mac 记「待设备」；b) GitHub Actions 三平台 matrix（需远端仓库与 CI 策略）；c) 仅代码就绪，两平台均记「待设备」 | **a)**——一轮闭环不依赖 Mac/Linux 设备（P5 裁定 A 精神延续），WSL2 构建链本机可验 |
| B. nspawn/UTM 后端深度 | a) 完整 CLI 底座 + 脚本化单测 + 探测呈现（真机链路如实记未验收）；b) 仅探测占位 + 记档 | **a)**——与 OCI 双壳同哲学（CLI 语义单测锁死，真机只验版本漂移） |
| C. rootfs/镜像开箱体验 | a) 维持文档指引（P4 降级引导延续）；b) 内置下载器（rootfs tar / OCI 镜像预拉） | **a)**——下载器涉及网络/镜像源/进度断点，独立一轮评估，后置记档 |
| D. ARCHITECTURE 正文旧引用 | §2/§3 尚存重排前「relay P6」旧文（BCS 同步、CrossUserRelay、apps/relay 占位）——随本轮同步改 P7 | **执行**——架构文档内部一致性（§11 表 2026-08-26 已改，正文漏网） |

## TODOLIST

- [ ] 1. **electron-builder 装配与 main 打包链**：main 侧预 bundle（workspace 依赖 @openbot/* 收进
  单文件产物——消解 pnpm + electron-builder 的 node_modules 收集坑）；files/asar 配置（renderer
  dist + preload cjs + main bundle + 平台资源）；镜像源（ELECTRON_MIRROR 既有 + electron-builder
  二进制 ELECTRON_BUILDER_BINARIES_MIRROR）；dist script 占位兑现
- [ ] 2. **win 双产物真机冒烟**：nsis 安装器 + portable——安装/解包后启动真内核（网关起、界面连、
  mock 后端一轮 exec）、卸载路径；无证书不签名如实记档；E2E `_electron.launch(executablePath)`
  打安装产物跑既有用例子集
- [ ] 3. **backend-nspawn（Linux）**：systemd-nspawn/machinectl CLI 底座（import-tar 建 Box、
  machinectl shell exec、clone/export 快照、cgroup 属性上限、poweroff 休眠）+ caps 如实
  （矩阵行：持久 ✓/快照 ✓/资源上限 ✓/隔离中/无人值守 ✓）+ 探测 + 装配注入
- [ ] 4. **backend-utm（macOS）**：utmctl CLI 底座 + caps 如实（**无人值守「部分」**——utmctl
  能力边界实施时实测定夺，不夸大）+ 探测 + 装配注入
- [ ] 5. **平台装配决策分支**：AUTO_ORDER 按平台（win: wsl→docker→podman 既有；linux:
  nspawn→docker→podman；mac: 实施时定——UTM 可用性优先于 docker desktop）；probeAll 平台差异
  （win 不探 nspawn/UTM）；设置页沙箱区块按平台实际探测呈现（矩阵如实标注验收项）
- [ ] 6. **Linux/macOS 打包**：按裁定 A 执行——WSL2 内构建 deb/AppImage（node/pnpm 环境装进
  发行版、electron-builder linux target）；mac dmg 按裁定记档或 CI；产物冒烟与三平台矩阵标注
- [ ] 7. **文档与架构同步**：platforms.md 补 nspawn/UTM 实测地雷；ARCHITECTURE 正文 relay P6→P7
  引用修正（裁定 D）+ §11 P6 行勾验收；README 分发说明（含 Docker Desktop 免费边界——个人/250 人
  以下企业免费，platforms.md 既有纪律）；版本同步
- [ ] 8. **真机验收与记档**：win 打包产物本机全链；linux 按 WSL2 构建链实测；nspawn/UTM 真机链路
  如实记未验收（无设备时）；P5 Step 8 遗留状态延续记档
- [ ] 9. **收官复查**：plan-p6 勾选与实施记档；三命令 + E2E 全绿确认；验收对照 §11 P6 行逐项核

## 设计要点（开工前逐条细化，先记已知决策）

### 打包（Step 1/2/6）

- **main 预 bundle 是最大工程决策**：pnpm workspace 内部包（@openbot/core 等）无 npm 产物，
  electron-builder 的 node_modules 收集对 workspace 链是已知雷区——main 侧 esbuild bundle 成
  单文件 dist/main/index.js（外置依赖只剩 electron 运行时与少量 native），启动更快且 files
  配置极简（renderer dist + preload cjs + main bundle）。
- two-package.json 结构不采用（workspace 单包 + files 白名单足够）。
- asar 开启；extraResources 只放确需外部读的（无——rootfs 不内置，裁定 C）。
- 冒烟不靠手点：`_electron.launch({ executablePath })` 直接打安装后 exe 跑既有 E2E 子集
  （mock provider + mock 沙箱环境变量注入与开发态同构）。

### nspawn / UTM（Step 3/4）

- **CLI 即接口延续**（ARCHITECTURE §6）：nspawn= machinectl 家族（import-tar/shell/clone/
  poweroff），与 wsl 同为「rootfs tar 导入」心智；UTM = utmctl——headless 边界实施时实测，
  caps 不夸大（矩阵「无人值守：部分」如实）。
- 单测全部脚本化替身（与 OCI 底座/procexec 同哲学）；真机差异靠注入层隔离。
- **平台守门在探测**：nspawn/UTM 探测在 win 上天然 unavailable（CLI 不存在），设置页与
  chooseBackend 零特判——探测事实驱动，不是 if 平台。

### 平台装配（Step 5）

- AUTO_ORDER 平台化是 coordinator 纯函数改动（注入平台序即可测——不 import os，装配层传参）；
  win 既有序不动（wsl 主力），Linux nspawn 优先候选（systemd 自带零安装），mac 实施时定。
- probeAll 按平台裁剪探测列表（win 不跑 nspawn/UTM 探测——CLI 必然不在，跑了也是噪音）。

## 风险与地雷

- **pnpm + electron-builder**：workspace 依赖收集坑由 main 预 bundle 消解（Step 1 第一件事验证）；
  electron-builder 对 pnpm 符号链接 node_modules 的处理实测确认（必要时 node-linker=hoisted 局部
  覆写，不动全局）。
- **国内网络**：electron 二进制与 builder 工具链双镜像（ELECTRON_MIRROR 经验已有；builder 二进制
  镜像实测）；`.npmrc` 永不带 token 入库（既有安全检查）。
- **WSL2 内打 linux 包**：electron-builder 在 Linux 容器内构建 AppImage/deb 需 FUSE/工具链——
  WSL2 可装；实测坑记档。**mac dmg 必须 mac 环境**（electron-builder 限制）——按裁定 A 记档。
- **签名**：无证书不签名（nsis 产物 SmartScreen 警告如实告知用户预期）；代码签名/公证记档后续版本。
- **E2E 不回退**：Step 5 改 coordinator 装配后先 `pnpm build` 再跑下游（既有教训）；renderer 侧
  平台呈现改动走 build:renderer + grep 产物（模板字面量——minify 混淆标识符）。
- 系统近 commit 上限时 Vitest 多 worker 崩溃（P3 记档）：复现时 `--no-file-parallelism`。
