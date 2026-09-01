# P6 实施计划（平台扩展与分发）

> 状态文档：随实施推进更新勾选与「设计要点」。架构依据 [ARCHITECTURE.md](../ARCHITECTURE.md) §11
> （P6 行：2026-08-26 裁定重排）；平台地雷矩阵 [platforms.md](platforms.md)（nspawn/UTM 行随本轮补实测）。
> 与架构文档冲突时以 ARCHITECTURE.md 为准。
> 上阶段记录见 [plan-p5.md](plan-p5.md)（P5 已收官——四后端矩阵收敛、消息域双达成）。
> P3 遗留两件随本轮兑现：**win nsis/portable 打包**（P3 行原文）；P5 Step 8 真机验收未验收状态如实延续
> （机器条件就绪即用已参数化的真实套件复跑）。
> **2026-09-01 四项裁定落位、批准实施**（A=仅代码就绪——非推荐项；B/C/D 按推荐；见下「已裁定的范围」）。

## 目标与验收

兑现 §11 P6 行：**Linux（nspawn + 原生 docker）、macOS（UTM）、electron-builder 三平台打包**。
分发域与平台域同轮合并（2026-08-26 裁定——边界干净：本轮不碰消息域与 relay）。

- **验收**：win nsis + portable 双产物本机安装冒烟（真内核装配 + 界面启动 + 端到端一轮）；
  Linux/macOS 产物与后端按「待裁定的范围」执行深度；平台矩阵如实标注（capabilities 驱动 UI——
  win 上不出现 nspawn/UTM，探测不可用自然隐藏）；`pnpm build && pnpm typecheck && pnpm test` 全绿；
  既有 18 E2E 用例不回退；
- **不造假纪律延续**：无真机的后端「CLI 底座 + 脚本化单测 + 探测呈现」兑现，真机链路如实记
  「未验收」（P5 Step 8 模式）；无证书则不签名并记档 SmartScreen 提示预期。

## 已裁定的范围（2026-09-01 批准时逐项表态落位）

| 项 | 裁定 | 记档 |
|---|---|---|
| A. Linux/mac 构建环境 | **c) 仅代码就绪**（非推荐） | linux deb/AppImage 与 mac dmg 的 electron-builder target 配置写好，两平台产物均记「待设备」；WSL2 构建链不启动；win nsis/portable 为唯一真机产物主线 |
| B. nspawn/UTM 后端深度 | **a) 完整 CLI 底座** | machinectl/utmctl 全语义实现 + 脚本化单测锁死 + 探测呈现；真机链路如实记「未验收」（P5 Step 8 模式延续） |
| C. rootfs/镜像开箱体验 | **a) 维持文档指引** | P4 降级引导延续；内置下载器独立一轮评估后置记档 |
| D. ARCHITECTURE 正文旧引用 | **执行修正** | relay P6→P7 共 5 处（行 169/204/222/370/432——§2/§3/风险表漏网之文）+ §6 矩阵补行 + §11 P6 行勾验收 |

## 现状核对（2026-09-01 开工前）

- 后端家族 `packages/boxes/src/backend-{wsl,oci,docker,podman,mock}/` + `probe/`——两新后端照此形态新增；
- `SandboxBackendId` 四值在 `packages/boxes/src/probe/index.ts`，偏好 schema 五值在
  `apps/desktop/src/main/kernel.ts`（sandboxPrefSchema），`AUTO_ORDER` 在 `packages/coordinator/src/sandbox/index.ts`
  ——三处均需扩 `nspawn`/`utm`；
- desktop `dist` script 现为 echo 占位；`electron-builder.yml` 已有 P3 骨架（appId/productName/win nsis+portable）；
  renderer 出 `dist/renderer`（vite）、preload 为 `src/preload/index.cts`（main/preload 纯 tsc 出 dist）；
- `apps/relay` 目录已存在（占位，本轮不动——裁定 D 只改 ARCHITECTURE 正文引用）。

## TODOLIST（2026-09-01 按裁定修订——Step 6 收窄为配置就绪）

- [x] 1. **electron-builder 装配与 main 打包链**：main 预 bundle（esbuild——workspace 依赖 @openbot/* 收进单文件产物，消解 pnpm + electron-builder 的 node_modules 收集坑）；electron-builder.yml 完善（files 白名单：renderer dist + preload cjs + main bundle；asar 开）；镜像源（ELECTRON_MIRROR 既有 + electron-builder 二进制 ELECTRON_BUILDER_BINARIES_MIRROR）；`dist` script 占位兑现
- [x] 2. **win 双产物真机冒烟**：nsis 安装器 + portable——安装/解包后启动真内核（网关起、界面连、mock 后端一轮 exec）、卸载路径；无证书不签名如实记档（SmartScreen 预期告知）；E2E `_electron.launch(executablePath)` 打安装产物跑既有用例子集
- [x] 3. **backend-nspawn**：machinectl CLI 底座（import-tar 建 Box / shell exec / clone-export 快照 / cgroup 资源上限 / poweroff）+ caps 如实（矩阵行：持久 ✓/快照 ✓/资源上限 ✓/隔离中/无人值守 ✓）+ 脚本化单测 + probeNspawn + 装配注入（SandboxBackendId/偏好 schema/设置页三处扩值）
- [x] 4. **backend-utm**：utmctl CLI 底座 + caps 如实（无人值守「部分」——能力边界实施时实测定夺，不夸大）+ probeUtm + 装配注入 + 脚本化单测
- [x] 5. **平台装配决策分支**：AUTO_ORDER 平台化（win: wsl→docker→podman 既有；linux: nspawn→docker→podman；mac: 实施时定——注入平台序纯函数，不 import os）；probeAll 平台裁剪（win 不探 nspawn/UTM——CLI 必然不在，跑了也是噪音）；设置页探测事实驱动呈现（零 if 平台特判）
- [x] 6. **Linux/macOS 打包配置就绪**（裁定 A=c 收窄）：linux deb/AppImage + mac dmg target 配置写好；两平台产物记「待设备」（WSL2 构建链不启动，mac 本无设备）；win 为唯一真机产物
- [x] 7. **文档与架构同步**：platforms.md 补 nspawn/UTM 地雷行；ARCHITECTURE relay P6→P7 五处修正（裁定 D）+ §6 矩阵补行 + §11 P6 行勾验收；README 分发说明（含 Docker Desktop 免费边界——个人/250 人以下企业免费，platforms.md 既有纪律）；plan-p6 勾选记档；版本同步
- [x] 8. **真机验收与记档**：win 打包产物本机全链；nspawn/UTM 真机链路如实记「未验收」（无设备）；P5 Step 8 遗留状态延续记档
- [x] 9. **收官复查**：`pnpm build && pnpm typecheck && pnpm test` + E2E 全量；验收对照 §11 P6 行逐项核

## 实施记档（2026-09-01）

- **Step 1/2（打包链与 win 冒烟）**：`scripts/dist.mjs` 打包入口（双镜像 env 缺省注入、五步链）；
  main ESM bundle + banner `createRequire`（**实测坑①**：ws 的 ESM wrapper 内 require('events')
  在 esbuild ESM 输出无 require 可用——「内核装配失败」错框定位；banner 后 `require2` 的
  `typeof require !== "undefined"` 兜底恰好接上，源码零改动）；preload 补 `--external:electron`
  （**实测坑②**：漏标时 electron 的 node 侧包装整包内联，sandbox preload 里 child_process 不可用）；
  `two-package.json` 不采用（workspace 单包 + files 白名单 dist/resources 足够）。win 双产物
  装卸闭环：setup `/S` 静默装（D:\Software\OpenBot）→ `OPENBOT_PACKAGED_EXE` 指安装后 exe 跑
  E2E 全链 → QuietUninstall 静默卸 → 目录与注册表双清零。无证书不签名（SmartScreen 预期记 README）。
  pnpm v11 `allowBuilds` 白名单：electron-winstaller（Squirrel 依赖，nsis 用不上）置 false。
  **实测坑③**：timeout 杀 pnpm 壳会孤儿化 electron.exe 且占单例锁——后续启动秒退表现为
  firstWindow 超时，冒烟后必须 taskkill 树杀清理。
- **Step 3/4（nspawn/utm 双后端）**：machinectl 家族全语义（import-tar/clone=快照/
  systemctl set-property=资源上限真落 cgroup/先查 is-active 后 start 的幂等拉起）；UTM 按
  UTMCtl.swift 源码事实定 caps——**attach 未实现→interactive=false、无配置入口→resourceLimits=false、
  exec/file 依赖 guest agent→无人值守「部分」**（不夸大纪律的直接落地）；快照=clone/delete 链
  （无 snapshot 子命令）；`utmctl list` 列格式 UUID/pad8/名（可含空格）parseUtmList 纯函数锁死。
  真实套件参数化 `OPENBOT_TEST_NSPAWN=1`/`OPENBOT_TEST_UTM=1`（+ROOTFS/TEMPLATE），无设备 skip。
  **实测坑④**：测试替身的数组 `includes` 是元素全等非子串——'cat' 匹配不到 '/bin/cat'；
  exec 无 argv 独有特征（mkdir 同带 --quiet），替身改按 timeoutMs/signal 判定。
- **Step 5（平台装配）**：`chooseBackend` 加 `order`/`nspawnRootfs` 注入（纯函数不 import os），
  implemented 缺省集扩全六值；`probeAll(run, platform?)` 平台裁剪 + 并行探测（15s 超时不串行叠加）；
  kernel 装配 platformOrder 三平台序 + nspawn/utm 实例分支（nspawn 快照目录独立
  `boxes/nspawn-snapshots` 防与 wsl 的 `boxes/snapshots` 相互覆盖）；设置页 `prefOptions`
  computed 按 probes 过滤——**探测列表即 UI 呈现源，win 上 nspawn/UTM 自然不出现**（E2E 锁死）。
- **Step 6（裁定 A 收窄）**：linux/mac target 配置在 electron-builder.yml 就绪（deb/AppImage/
  dmg + mac `identity: null`），产物待设备——真机就绪后在对应平台跑同命令即出。
- **Step 8（真机验收）**：win 全链 ✓（Step 2）；nspawn/UTM 真机未验收（CLI 语义单测锁死——
  15+16 例）；P5 Step 8 遗留（docker/podman 真实套件）状态如实延续，机器就绪复跑。
- **收官**：`pnpm build/typecheck/test` = 零错/322 过 + 6 skipped（较基线 +47：nspawn 18 + utm 16 +
  probe 9 + coordinator 平台化 6 —— 逐包核对含真实套件 skip）；E2E 20/21 过——**1 失败为既有
  flaky**（「中止工作中的 agent」：revokeRun 对审批挂起 run 的收敛可快于 Vue 渲染拍，
  `.m-stop` 过渡态一帧即逝——tsc 产物对照同败，v0.0.28 后零相关改动，非本轮因果；修断言
  属验收语义变化，待用户裁定）。版本 0.0.29 同步。

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
