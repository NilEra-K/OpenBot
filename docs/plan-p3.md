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
- [x] 5. 后端探测与装配选择(WSL 部分;用户裁定「先基于 WSL 开工」):`boxes/probe`(wsl --status / docker version / podman --version,ProcRunner 注入可测)→ `coordinator/chooseBackend` 装配决策(偏好 × 探测 × 实现白名单,依赖铁律:吃 boxes probe + state 偏好,决策只能在装配根)→ 桌面 main 装配 WslBoxBackend;settings-store 沙箱偏好 + `v1.sandbox.status/set` 命令面;settings 视图后端区块(当前后端/降级警示/rootfs 引导/偏好选择重启生效/探测清单);E2E `OPENBOT_SANDBOX=mock` 确定性隔离
  - 三级诚实降级:未实现(白名单外)→ CLI 不可用 → WSL rootfs 未就绪,全部回 mock 带 reason;
    auto 择优链 wsl→docker→podman,全不可用落「无可用真实后端」汇总原因(mock 是地基而非错误)
  - rootfs 查找:env `OPENBOT_WSL_ROOTFS` > `userData/box-rootfs.tar.gz`;Box 目录 `userData/boxes`;
    偏好 env `OPENBOT_SANDBOX` 覆盖(枚举外值忽略,zod safeParse)供 E2E/演示
  - **backend-wsl create 跨重启幂等(实证必要)**:`assembleKernel.addAgent` 每次启动都 create,
    无条件 `--import` 会在桌面第二次启动同名冲突 → create 先 `--list --quiet` 查存在则复用(与 list() 同源判定);
    真实套件新增「重启语义」用例:新实例、同名发行版、跳过 import、/work 数据保留(8s 通过)
  - **真机首启实证又一条 wsl.exe 地雷**:`--import` 不自建父目录(userData/boxes 不存在 → exit
    4294967295 且 stderr 空)→ import 前递归建目录;元命令错误信息改取 stderr||stdout 兜底
    (platforms.md 地雷区已补记,与 --export 不自建目录并列)
  - chooseBackend 纯函数单测 12 用例(显式偏好/auto 链/白名单/缺项探测);docker/podman 在设置页
    只读呈现探测状态(disabled 选项「待实现 P3 Step 4」)——不放假选项
  - `packages/boxes` index 增 probe 导出;coordinator index 增 sandbox 导出;desktop package.json 补 boxes 依赖
- [ ] 6. 资源统计与磁盘压力告警:内核定时 stats 轮询 → WS 实况/事件;磁盘压力判定在内核(进协议的派生量归内核)→ 告警事件 → UI 角标;boxes 仪表接真数据(P2 降级项解锁)
- [x] 7. 流式双线:llm `openai-compat` stream:true(SSE 增量解析)+ exec 流式 → WS `/stream` 接 renderer;console 打字机与 ctx 三栏面板(P2 原型 #11 标注位)落地
  - llm:`ChatRequest.onText`(聚合语义不变)+ SSE 消费器(delta.content 增量、tool_calls 按 index
    累积拼装、`[DONE]` 终止、流中断=LLM_RESPONSE_INVALID)+ FetchLike 扩流式 body
    (AsyncIterable/ReadableStream 双兼容);mock 对称拆块(3 码元定长;留痕剥离回调再 clone)
  - runner:`RunStreamEvent`(open/chunk/end/abort × llm/exec)+ onStream 注入——chat 轮次与
    execTool 同型上报(exec 带 command/exitCode/stderr 通道;chatRound 与工具轮计数分离,
    预算语义不变);失败路径 abort 带原因
  - coordinator:`StreamHub`——gateway onStreamSession 登记会话,事件驱动流生命周期
    (同 run 多流按序号;无订阅者丢弃——turn 不受渲染层影响;中途接入只看新流:
    实况断线不补);桌面 main 接线 hub.attach
  - renderer:`lib/stream.ts` 手写 14 字节帧解码(零内核 import,与 P2 gateway 客户端同哲学;
    断线 3s 重连)+ store 流实况块(容量 80 优先淘汰已结束)+ `CtxPanel.vue`(原型 cs-bar/cs-term
    屏幕卡:LIVE 点/终端行/stderr t-bar 着色/打字机光标/无流状态屏)+ ConsoleView 三栏
    (246px 1fr 318px);**打字机取舍:token 增量进 ctx(实况),消息气泡仍等事件(事实)**
  - E2E:mock-openai 增 SSE 分支(runner 恒 onText → 恒 stream:true,端点必须支持);
    ctx 断言 exec 卡(命令+输出)与 llm 增量;176 测试全绿
  - **显示器语义裁定(2026-08-19 用户确认)**:「看进 Box」分三阶——一期=合格显示部分
    (命令与输出的实况,`$ ls`+结果按时间序;现有 exec 流管道模式即信号源,零内核改动,本轮完成);
    终端级远程控制(vim/top 画面+键鼠直送——PTY:ConPTY/node-pty 原生模块+xterm.js)P4 按需评估;
    GUI 画面(远程控制软件式像素流,Box 内跑 x11vnc 等)P4+ 按需评估——PTY 与 VNC 同属
    「远程控制」能力族的后续升级,一期把显示器语义与实况显示做对(心智模型:终端程序输出的是
    字符流+转义序列不是像素,PTY 的作用是骗过程序接了真显示器从而输出画面级字节流——没有它
    vim/top 直接拒绝工作,管道模式下逐行纯文本即全部事实)
  - 最终形态:ctx=思考条(llm 增量,agent 进程不在 Box 内不冒充屏幕内容——诚实分层)+一块屏幕
    (exec 流拼 `$ 命令`+输出行/stderr 着色/live 光标,点击进操作台大屏;实现类 .cs-screen-body);
    `BoxOps.vue` 操作台大屏(VMware 控制台式,按 Box 归属过滤,boxes 卡片亦可开;bo-hint 诚实标注
    键鼠接管与 GUI 属后续版本);`BoxScreen.vue` 为 ctx 预览与操作台共用的显示器组件;
    E2E 断言同步升级为显示器语义(屏幕命令行+输出、思考条文本、操作台开/返回闭环)
  - **实测地雷(drag 区吃点击,2026-08-20)**:BoxOps 返回按钮真机点不动、按住拖动整个窗口——
    bo-bar 落在壳 titlebar(app-region:drag,高 38px)矩形内,而 fixed overlay 盖住 titlebar
    不改变 Chromium drag 判定;修法=全屏 overlay 显式 no-drag(boxops 与审批 scrim 同修,与
    win-controls 同款模式);E2E 合成点击绕过 drag 判定测不出,地雷记录在 platforms.md
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
  **实测落点(2026-08-19)**:probe/chooseBackend/WslBoxBackend 都在内核包内(CLI 可用);
  本步只接了桌面装配——CLI 侧显式后端参数后补(Step 4/9 顺带),不构成壳不等价(probe 面未暴露命令)。
- 后端不可用时**诚实降级回 mock**(明确标注 mock 身份,UI 警示条)——永不静默假装真实。
- 决策归属:chooseBackend 在 coordinator(吃 boxes 的 BackendProbe + state 的 SandboxPreference——
  state 不许 import boxes 的依赖铁律决定了决策只能放装配根)。

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
