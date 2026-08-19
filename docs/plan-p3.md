# P3 实施计划(真实后端:沙箱落地 + 打包)

> 状态文档:随实施推进更新勾选与「设计要点」。架构依据 [ARCHITECTURE.md](../ARCHITECTURE.md) §6/§11(P3 行)与 [platforms.md](platforms.md) 能力矩阵;
> 与它冲突时以 ARCHITECTURE.md 为准。上阶段记录见 [plan-p2.md](plan-p2.md)。

## 目标与验收

把 Box 从 mock 变真:重活真正进本机沙箱执行(WSL2 / Docker / Podman 三真实后端),并以 Windows 安装包交付。
(Podman 提前进一期:2026-08-19 用户裁定;架构与 platforms.md 已同步。)

- **验收(路线图原文)**:真实 Box 内完成一次「改项目→构建」任务并产出 diff;
- `pnpm build && pnpm typecheck && pnpm test` 保持全绿(CI 零 WSL/Docker 依赖不动摇——mock 对称是地基);
- E2E 默认套件保持 mock 确定性;真实后端套件按 env 开关选择性跑;
- electron-builder 出 win nsis + portable 双包,安装后真内核可跑。

## 现状事实(2026-08-19 本机探测)

- 本机 **WSL2 功能已启用**(内核 5.10.16、默认版本 2),**无已安装发行版**——`wsl --install -d Ubuntu` 一步进入开发;
- 本机 **Docker 与 Podman 均未安装**(Docker Desktop 个人免费/企业收费;Podman 免费开源,Windows 经 podman machine 跑在 WSL2 上——免费边界与依赖关系写进用户文档);
- `wsl.exe` 输出 UTF-16LE 实证复现(platforms.md 地雷第一条,计划内做解码底座);
- P2 已备好的地基:`BoxBackend` 接口(P1 定型,含 caps/spec/exec/fs/snapshot/stats/teardown/list)、
  `assembleKernel({ backend })` 注入位、WS `/stream` 帧协议(回环自测过)、caps 驱动 UI(boxes 视图工具栏);
- P2 裁定待解锁的「等信号源」项:ctx 三栏面板、boxes 仪表、run 描述文本、流式打字机。

## 已裁定的范围(2026-08-19 起草建议,待用户确认)

| 项 | 建议 | 备选 |
|---|---|---|
| 后端范围 | **一期三后端:WSL + Docker + Podman**(用户裁定;WSL 本机一步就绪 + Windows 优先定位,docker/podman CLI 同构共用 OCI 底座) | — |
| 容器后端接入 | **CLI 子进程**(`docker`/`podman` 的 `run/exec/commit/stats --format json`)——零依赖、与 wsl.exe 同构复用子进程底座 | dockerode(依赖重,不取) |
| llm 流式输出(stream:true) | **进 P3**(打字机与 exec 实况同属流式体验,一起做) | 拆 P2.5 先行 |
| ctx 三栏/boxes 仪表/run 描述 | **进 P3**(信号源到位自然解锁,不单独立阶段) | — |
| 打包签名 | P3 先出**无签名** nsis+portable;正式证书(付费)是否购买后续定 | 自签名(无信任收益,不取) |
| Windows Sandbox | 不做(已裁定 P4 后视需求) | — |
| subagent/automations/memory/box-catalog | 继续 backlog,不进 P3 | — |

## TODOLIST

- [x] 1. 环境准备 + 子进程执行底座:本机 `wsl --install -d Ubuntu`(用户执行,涉及重启);`boxes` 增子进程执行底座(spawn/超时 kill/输出解码——wsl.exe UTF-16LE 解码在此层,实测驱动)
  - 本机 WSL2 就绪实证:家庭版支持 WSL2(用户原以为不支持——混淆了 Windows Sandbox);
    Store CDN 安装卡死 → 改离线方案:USTC 镜像下载 ubuntu-noble rootfs(SHA256 校验一致)→
    `wsl --import OpenBot-Ubuntu`——**import 通道即 backend-wsl 的创建机制,环境准备顺手验证了架构核心路径**
  - `boxes/src/procexec`:argv 直传零 shell、超时 kill(timedOut 置位)、流式 onChunk、
    TextDecoder stream 模式跨块多字节收敛、UTF-16LE 解码(WHATWG 标签是 'utf-16le' 带连字符——实测);
    spawn 失败抛 ProcSpawnError(probe 判「CLI 未安装」的依据);6 用例全用 node 自身做被测进程(确定性)
- [x] 2. 接口演进:`exec` 流式契约(方案见设计要点;`ExecResult` 聚合保留,mock 同步)+ lifecycle 事件族带 run 摘要(首条用户消息截断)——tasks run 卡描述与 E2E 断言升级
  - `ExecSpec.onChunk`(流是实况聚合是事实);mock 按行拆块回调(对称原则);zod 目录同步
  - `RunRequest.summary` → queued 事件(`LifecycleQueuedPayload.summary?`);messaging 三处提交点带
    `summarizeRun`(归一空白/80 码元截断);TasksView 描述行显示摘要(runId 退居 meta)
  - 实测修复:test:e2e 脚本的 `pnpm build` 在子包内解析不到根构建 → `pnpm -w build`
- [x] 3. `backend-wsl`:发行版即 Box(`--import` 创建 / `--export` 快照 / `--terminate` 休眠 / `-d <name>` 执行);fs 走 exec;caps 如实(snapshot ✓ 慢、resourceLimits ✅、isolation low);真实单测(需 WSL,env 开关)
  - exec:env 经 coreutils env 注入(argv 零拼接无注入面)、`--cd /work`;超时抛 BOX_EXEC_TIMEOUT
  - fsWrite 走 base64 中转 + POSIX 单引号包裹路径;fsRead cat 失败返回 null
  - 元命令(import/terminate/export/unregister/list)统一 utf16le(错误信息也是宽字符——实证);
    命令输出字节直传 UTF-8(platforms.md 地雷的实测分界确认)
  - **真实套件三实证**:裸 rootfs 无 /work → create 后 mkdir 初始化;export 不自建目录 → snapshot 前
    mkdir;断言失败残留孤儿发行版 → 下轮 import 冲突 → afterAll 兜底注销全部 openbot-box-*
  - 测试两层:替身套件(默认,断言 wsl.exe 参数序列/错误语义/前缀过滤)+ 真实套件
    (`OPENBOT_TEST_WSL=1 OPENBOT_TEST_ROOTFS=...`,18s 全链路:create→exec UTF-8→fs 双向→流式→快照→注销)
- [ ] 4. OCI 容器后端(底座共用,两薄壳):`backend-docker` + `backend-podman`——容器即 Box:`run -d --cpus --memory` / `exec` / `commit` 快照 / `stats --no-stream --format json`;caps 如实(persistent 需卷挂载、resourceLimits ✓、isolation medium);单测注入脚本化 CLI(mock 同构);真实验证分别依赖 Docker Desktop / podman machine
- [ ] 5. 后端探测与选择:`probe`(wsl --status / docker --version / podman --version + `podman machine inspect` 验 machine 运行态 → 可用性与 caps)→ 事件下发;settings-store 增沙箱后端偏好;桌面/CLI 同一命令面装配(壳等价);boxes 视图后端选择 UI(不可用如实灰显,标注原因)
- [ ] 6. 资源统计与磁盘压力告警:内核定时 stats 轮询 → WS 实况/事件;磁盘压力判定在内核(进协议的派生量归内核)→ 告警事件 → UI 角标;boxes 仪表接真数据(P2 降级项解锁)
- [ ] 7. 流式双线:llm `openai-compat` stream:true(SSE 增量解析)+ exec 流式 → WS `/stream` 接 renderer;console 打字机与 ctx 三栏面板(P2 原型 #11 标注位)落地
- [ ] 8. electron-builder:win nsis + portable(asar、图标、userData 迁移注意);打包产物真内核冒烟;`dist` 脚本替换占位
- [ ] 9. 验收:真实后端 E2E 套件(`OPENBOT_E2E_BACKEND=wsl|docker|podman` 选择性跑,默认 mock 不变);**真实 Box 内「改项目→构建」演示(fixture 项目:patch→build→diff 回读)产出 diff**;三命令全绿

## 设计要点(开工前逐条细化,先记已知决策)

### 流式契约(Step 2/7)——接口演进原则

- `BoxBackend.exec` 增可选流式回调(建议 `onChunk?: (stream: 'stdout' | 'stderr', text: string) => void`,
  侵入最小、ExecResult 聚合语义不变);llm 侧 `ChatProvider.chat` 同理加增量回调或 AsyncIterable。
- **接口是包内 TS 契约非持久化 schema**,直接演进;三个后端 + runner + mock 必须同步,编译期即锁死漂移。
- 流式数据走 transport WS `/stream`(帧协议 P2 已定型回环),**不进事件总线**——事件是事实,流是实况,两者语义不同(SSE 重放的是事实,流断了就断了)。
- run 摘要进 lifecycle 事件(事实,可重放);打字机 token 不进事件(实况,断线不补)。

### WSL2(Step 3)——发行版即 Box

- 每个 Box = 一个独立发行版目录(`wsl --import <name> <dir> <rootfs.tar>`):天然隔离 rootfs、快照即 `--export`、
  删除即 `--unregister`。共享内核与 vmmem(架构已接受:`wsl --shutdown` 全杀是全局地雷,UI 需如实告知)。
- rootfs 来源:预置基础 tar(最小 Linux)或首次从官方 tarball 导入——离线友好,不走 Store。
- 执行:`wsl.exe -d <name> --cd /work -- <cmd>`,UTF-16LE 仅影响 wsl.exe 自身输出(列表/状态);**命令输出走管道按
  字节直传**(Linux 侧进程输出是 UTF-8)——实现时实测分界,解码只在元信息解析处。
- caps.snapshot=true 但 GB 级慢:UI 标注耗时预期,不隐瞒。

### OCI 容器后端(Step 4)——CLI 即接口,docker/podman 同构

- 不引 dockerode/Engine API 客户端:`docker`/`podman` CLI 子进程与 wsl.exe 同构,复用 Step 1 底座;`--format json` 出稳定机器可读输出。
- **底座共用 + 两薄壳**:一套 OCI CLI 实现(构造注入命令名与探测函数),导出 `backend-docker` / `backend-podman` 两个薄壳——
  CLI 兼容度高但非 100%(stats 字段差异、podman machine 生命周期),分叉点集中在探测与 caps,实现体共享。
- 端点差异(命名管道 vs unix socket)被 CLI 屏蔽——platforms.md 地雷在 boxes 层抽象,CLI 方案直接消解。
- 容器即 Box:`run -d --cpus N --memory M`(严格资源上限,caps.resourceLimits=true 的依据)、`exec`、`commit` 快照、
  `stats --no-stream` 统计;持久化需卷挂载(`-v`),caps 如实标「需卷挂载」。
- **Podman 探测**:Windows 上 `podman machine` 必须处于运行态(`podman machine inspect` 判定)才可用;
  machine 本身占一个 WSL2 发行版,与 WSL 后端的 Box 共享 vmmem——资源统计全局视角算(platforms.md 地雷)。
- 单测:注入脚本化 CLI 替身(参数断言 + 固定 JSON 回放)——与 llm 注入 fetch、transport 注入内存管道同一测试哲学。

### 装配与壳等价(Step 5)

- `assembleKernel({ backend })` 注入位不变;新增 probe → 可用后端清单 → 偏好选择(设置页 + settings-store)。
- CLI 与 desktop 共用 probe/选择命令面(解耦纪律 #7:「只有 desktop 能用」即 bug)。
- 后端不可用时**诚实降级回 mock**(明确标注 mock 身份,UI 警示条)——永不静默假装真实。

### 打包(Step 8)

- electron-builder 仅进 apps/desktop devDeps;`dist` 脚本串联 build + build:renderer + builder;
- asar 内不得有内核数据写路径(userData 在 asar 外——P2 已走 app.getPath,无迁移);portable 包注意 userData 便携目录策略,写文档说明;
- 无签名包 SmartScreen 会告警——用户文档如实说明,不做绕过。

## 风险与地雷(对照 docs/platforms.md)

- wsl.exe UTF-16LE:仅元信息输出;命令输出字节直传(P3 实测分界后写死注释)。
- /mnt/c 9P 慢:项目活在 Box 内,不跨边界热编辑——fsRead/fsWrite 仅小文件工具用途,热编辑不做。
- WSL2 全局性:vmmem 共享、`--shutdown` 全杀——UI 全局告警,不按 Box 粒度承诺。
- Docker Desktop 授权:免费边界写进用户文档(250 人以下企业/个人免费);Podman 已按用户裁定提前一期(免费开源)。
- Podman on Windows:podman machine 自身占一个 WSL2 发行版,与 WSL 后端 Box 共享 vmmem——资源告警全局视角(platforms.md 地雷)。
- 真实后端测试不进默认 CI:env 开关选择性跑,`pnpm test` 永远零沙箱依赖(mock 对称,ARCHITECTURE.md §6)。
- 打包体积与下载(Electron 全量 ~100MB):P3 接受,P4+ 再评估按需裁剪。
- 桌面壳 Windows 缩放迟滞:上游 Chromium 缺陷已记录,等 Electron 升级,不在 P3 排查。
