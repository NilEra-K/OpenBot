# 屏幕一等公民实施计划（P9——「屏幕」成为 Agent 的操作对象）

> 状态文档：2026-09-26 立项规划（用户语义陈述：「一个屏幕（用于操作 SSH 或图形化界面），人类或
> LLM 通过屏幕获取内容或操作界面——界面可能是 Windows、Android、甚至 macOS；所有能接入的
> 图形化界面都可能成为操作对象，例如通过远程控制看到的一个屏幕」）。
> 上游记档 [plan-backlog.md](plan-backlog.md) ⑥（镜像一等公民 P8-1~P8-4 已实施完毕，本计划是
> 其语义升格：**镜像条目 = 可 exec 进入的机器 ⊂ 屏幕条目 = 可看可控的画面**）；架构依据
> ARCHITECTURE.md §3.4（boxes）/§6（后端矩阵与 caps）；既有底子 plan-image-firstclass.md
> P8-2（ScreenControl 接口化——本计划的第一消费红利）。
> 用户已裁定：首条非 X11 载体走**宿主侧屏幕**（路线 B）。

## 目标与终态

**终态**：任何可接入的图形界面（宿主上的远程控制窗口 / Android / Windows 云电脑 / VMWare 虚机）
成为注册表里的「屏幕条目」——agent 与人类经同一套 ScreenControl 接口看屏（capture/stream）与
操作（act/inputChannel），载体差异全部收敛进适配器。分轮落地：

- **P9-1**：宿主屏幕载体——零新依赖、本机即可验收，「任何远程控制窗口都能操作」的万能路线；
- **P9-2（按需）**：窗口区域绑定（GetWindowRect 跟踪）、L2 零依赖流式采集、move 合帧优化；
- **P9-3（远期）**：Android adb 载体、Windows 目标机内适配器（SSH + PowerShell——原 F1 裁定）、
  RDP/厂商 API 适配器随真机接入定形（准备原则 3 延续）。

## 核心分界线（立项语义基准）

**「看到」≠「能操作」**：操作的前提是存在输入注入通道；画面获取与输入注入是两条独立通道，
可各自落在不同位置（目标机内 / 宿主侧 / 专有协议）。问题从来不是「这个系统能不能」，而是
「这个屏幕的注入通道从哪里建立」。

### 三条注入通道路线

| 路线 | 原理 | 覆盖 | 代价 |
|---|---|---|---|
| A. 目标机内适配器 | 进入屏幕所在机器，机内跑截屏+注入（Windows = OpenSSH Server + PowerShell CopyFromScreen/SendInput，SshBoxBackend 现成；Android = adb screencap/input；macOS = screencapture + cliclick） | 可进入的机器 | 每载体一适配器 + 键名映射 |
| **B. 宿主侧屏幕载体（P9-1）** | OpenBot 跑在宿主上——宿主屏幕上的任何远程控制窗口（mstsc/scrcpy/noVNC/向日葵）最终都落在宿主屏幕接收键鼠；把「宿主屏幕」注册为载体：desktopCapturer 截屏 + PowerShell SendInput 注入 | **一切「通过远程控制看到的屏幕」** | 安全面质变/抢占/坐标跟踪（见风险） |
| C. 专有协议栈 | RDP/VNC(RFB)/VMware Tools 协议实现 | 理论最正规 | 依赖面大——记档后置 |

## 「接管」语义与流畅度分层（用户核心关切，2026-09-26 对齐）

宿主屏幕载体的独有红利：**屏幕即用户本机屏幕，人直接操作天然零延迟**（无中转层，结构性保证）。
有流畅度问题的是**经 GUI 视图的实况流链路**——价值 = ① 在 OpenBot 界面实时盯 agent 操作宿主屏幕
（安全/信任监控面，与审批加固 F 配套）；② 远程场景。如实分档：

| 档 | 技术 | 预估体验 | 依赖 |
|---|---|---|---|
| L0（一期兜底） | desktopCapturer 轮询快照 → mjpeg 帧序列 | 5–10fps、延迟 150–400ms——看清 agent 在干什么没问题，拖动跳帧。**不承诺丝滑** | 零（Electron 自带） |
| L1（探测自动升级） | ffmpeg gdigrab → h264（X11 适配器同构 argv 换采集源） | 30–60fps、延迟 <100ms——与 X11 载体同档丝滑 | 宿主 ffmpeg（探测缺席如实降级 + GUI 呈现档位与指引；开发机 2026-09-26 实测无 ffmpeg） |
| L2（P9-2 已实施） | 隐藏 BrowserWindow + getUserMedia 桌面采集（Chromium WGC 底层）→ canvas JPEG 帧泵 | 20–30fps（mjpeg 编码） | 零外部依赖 |

- **agent 侧（computer 截图/点击）无此顾虑**：agent 秒级节奏——单帧 100–200ms、动作 5–30ms 足够；
- 输入侧（GUI 内接管注入）：单击/按键 5–30ms 可接受；连续拖拽跟手性一期一般（逐动作注入），move
  合帧为 L2 期优化；
- 「保证」的正确形态是**能力协商**：L0+L1 双层探测 + GUI 呈现当前档位与升级指引（CLI 即接口哲学，
  wsl/docker 探测同惯例）。

### 流畅度记档纪律（2026-09-26 用户裁定：三档优化提升如实记档）

1. **预估 ≠ 事实，实测回填**：上表体验列为立项预估值——P9-1 验收时以门控套件实测回填三项硬数
   （实况流实际 fps / 端到端延迟 / 注入动作往返延迟），**实测与预估的差距如实记档**，不修数、
   不挑好看的轮次；
2. **档位提升路径与解锁条件在档**：L0 → L1 = 宿主装 ffmpeg（`winget install ffmpeg`——探测自动
   升级，零代码改动，CLI 即接口）；L1 → L2 = P9-2 工程轮（getUserMedia 流式采集 + move 合帧）；
   每档的解锁/降级对用户可见（GUI 档位呈现面），不静默切换；
3. **UI 如实呈现义务**：GUI 视图实况流面板呈现当前档位（L0 轮询 / L1 h264）、未达高档的原因与
   升级指引——与沙箱探测「可用性 chip + 如实原因」同惯例；
4. **实测方法一并入档**：门控套件（`OPENBOT_TEST_HOSTSCREEN=1`）内嵌测量——fps 取帧时间戳方差
   推算实际帧率；注入延迟取「act 发起 → 屏幕像素变化检出」往返；方法与数字同档，可复现。

## 现状盘点（2026-09-26 代码级）

- `packages/boxes/src/screen/`：ScreenControl 接口已中性化（geometry/capture/act/stream/inputChannel；
  ScreenAction 词表 move/down/up/click/key/type；键名 X keysym、按钮 X 编号——各适配器自行映射），
  唯一实现 X11ScreenControl——**本计划就是接口普适性的第二次验证**；
- `packages/boxes/src/routing/`：RoutingBackend 按 ImageEntry id 路由，`registerRoute(id, {backend,
  translate?})`——host-screen 条目与 ssh 条目同构接入；
- `apps/desktop/src/main/kernel.ts:1080`：GUI 生产注册门为**全局布尔**（probeX11Toolset 跑默认 Box）——
  host-screen 载体需加分支（条目在场即开注册，跳过 X11 工具集探测）；全局门 vs per-image 能力是
  既有局限，一期不重构；
- `packages/runner/src/tools/index.ts`：computer 工具族现行「Box 内自由，不过闸」——**host-screen
  载体上该假设被打破**（act = 操作用户本机），审批加固是硬需求（裁定 F）；
- `packages/boxes/src/types.ts:42`：BoxCaps.isolation 联合 `'low' | 'medium' | 'high'`（无 none）。

## 实施思路（P9-1 四层，全走既有槽位）

1. **state**：`ImageEntry.carrier` 加 `'host-screen'`，connection = `{ display?: number }`（一期恒
   主屏）；无凭据字段；版本号不动 + 读取端兼容（既有惯例）。
2. **boxes 新模块 `backend-hostscreen/`**：HostScreenBoxBackend implements BoxBackend——exec/
   fsRead/fsWrite/openShell/openPipe **稳定码拒绝**（纯屏幕载体无命令执行面，如实不造假）；
   create=attach 记账（零外部副作用，SshBoxBackend attach 语义同构）；caps 如实（persistent ✓ /
   snapshot ✗ / headless ✗ / resourceLimits ✗ / interactive ✗ / suspendable ✗ / isolation 见裁定 E）。
3. **boxes `screen/` 新适配器 HostScreenControl**：**截屏函数与几何由 desktop 装配层注入**（
   desktopCapturer 是 Electron API，boxes 零 electron 依赖——依赖只许向下铁律，ScreenControlHost
   窄面注入先例）；**注入走常驻 PowerShell 进程 + stdin 行协议**（X11 常驻 `sh -s` 通道同构），PS 内
   Add-Type + SendInput（一行一动作，click/move/key；type 文本走 KEYEVENTF_UNICODE——Windows 红利，
   任意 Unicode 直注）；键名映射表（X keysym → VK）；**坐标域校验**（动作限制在目标显示器矩形内）。
   stream = L0 mjpeg 轮询 + L1 ffmpeg gdigrab 探测升级（裁定 B）。
4. **desktop 装配**：registerImageRoute 注册 host-screen 路由；GUI 门加分支；`v1.images.test`
   host-screen 分支（desktopCapturer 可用性 + 几何 + ffmpeg 在场性报告）；设置页载体下拉
   「宿主屏幕」（显示器选择，无凭据）；审批加固（裁定 F）。

## 待裁定（批准时表态，未表态按推荐）

| 项 | 选项 | 推荐 |
|---|---|---|
| A. 一期画面范围 | a) 整屏；b) 窗口区域绑定 | **a)**——坐标语义清晰；窗口绑定 P9-2 |
| B. 实况流一期 | a) L0 mjpeg 轮询 + L1 ffmpeg 探测自动升级（双档能力协商，GUI 呈现档位）；b) 直接上 L2 getUserMedia 流式（零依赖丝滑，+1 轮）；c) stream 缺席（GUI 纯轮询帧） | **a)** |
| C. 注入通道 | a) 常驻 PowerShell 行协议；b) 每动作 spawn | **a)**——b 冷启 300ms+ 不可接受 |
| D. exec 缺席呈现 | a) 稳定码拒绝 + caps/UI 如实；b) 按载体裁剪工具注册面 | **a)**——b 动静大且工具面动态化违背单一注册惯例 |
| E. isolation 值 | a) `'low'` + UI/文档注明「零隔离（用户本机）」；b) 联合加 `'none'` | **a)**——不动 caps 联合（旧呈现端零波及） |
| F. 审批加固 | a) host-screen 载体上 computer 动作**恒过闸**（manual 弹确认 / auto 沿 auto 语义）；b) 沿用「Box 内不过闸」 | **a)**——b = agent 无闸操作用户本机，不可接受 |
| G. E2E 边界 | a) E2E 只测注册/表单/test/绑定 UI 链（**不真注入**），真注入进门控套件 `OPENBOT_TEST_HOSTSCREEN=1`（ssh-real 先例）；b) E2E 真注入 | **a)**——b 会在跑测试时真的动用户鼠标 |

## TODOLIST（P9-1 一轮交付）

- [x] 1. 计划文档落盘（本文档）+ plan-backlog ⑥ 记档升格链接
- [x] 2. state：carrier `'host-screen'` + connection 形状（零连接事实）+ controlProtocol `'host'` +
   按载体校验 + 单测（含切载体协议错配拒绝）
- [x] 3. boxes：HostScreenControl（bridge 注入面 / 常驻 PS 通道 + ok 确认行协议 / 键名映射 /
   坐标域校验 agent 拒 user 钳 / L0-L1 双档流）+ ScreenControlRouter + 单测 18 例
- [x] 4. boxes：HostScreenBoxBackend（BOX_UNSUPPORTED 稳定码拒绝 / attach 记账 / caps 如实）+ 单测
- [x] 5. desktop：路由注册（多条目共享一台屏幕设备）+ GUI 门 host-screen 分支 + `v1.images.test`
   分支（几何 + ffmpeg 档位报告）+ desktopCapturer/screen bridge 注入 + session.codec 真相源修正
- [x] 6. 设置页：载体单选「宿主屏幕」+ 协议固定 chip + 摘要/ctx/向导三处呈现 + 审批注记
- [x] 7. 审批加固（裁定 F）：runner `actionGate` 载体级动作闸（gated() 提取 requestToolApproval
   复用；截图不进闸——注册即「可看」授权，注入才是主权面）
- [x] 8. E2E：注册/真实测试报告/重启持久/删除（不真注入）+ 门控套件 `hostscreen-real.e2e.spec.ts`
   （`OPENBOT_TEST_HOSTSCREEN=1`——真实截帧/实况/接管注入，fps 实测打点）
- [ ] 9. 流畅度实测数据回填本文档分层表（跑门控套件后回填实测列——真机验收步骤）
- [ ] 10. 文档收官（ARCHITECTURE §3.2/§6 已同步）+ 全量验证与提交

### P9-1 实施记档（2026-09-26）

- **依赖方向铁律的兑现位**：desktopCapturer/screen API 是 Electron 面——收口在 kernel.ts 的
  `HostScreenBridge` 注入（geometry = 主屏 DIP × scaleFactor 物理像素；captureFrame =
  desktopCapturer thumbnailSize 直出目标宽，无需二次缩放）；boxes 零 electron 依赖保持纯 node 可测。
- **注入通道 = 常驻 PowerShell 行协议**（X11 常驻 `sh -s` 同构）：`powershell -NoProfile
  -NonInteractive -ExecutionPolicy Bypass -Command <脚本>`，stdin 一行一动作
  （m/c/w/kd/ku/kp/kdb/kub/t 协议，type 文本 base64 免转义——坑⑫哲学），stdout 只回
  ready/ok/pong。**ok 确认行是本期设计增量**：act 写入后等 ack 清零才返回——SendInput 真实执行完
  才算动作完成（错误可见：err 行 ack 照减放行、异常走 stderrTail；超时 SCREEN_ACT_FAILED），
  同时为流畅度实测提供「注入往返」天然测量点。Add-Type 首编译 ~1s 由常驻摊薄；ready 握手超时
  10s（actAckTimeoutMs 可注入供测试）。
- **坐标语义三段**：SendInput 用 0-65535 归一化绝对坐标（DPI 天然正确）；act() 收截图坐标按
  1280 契约换算（X11 #scaleOf 同构）后归一化；inputChannel 收真实屏幕坐标。域校验不对称：
  agent 路径越界**拒绝**（模型报错可见）、用户路径越界**钳制**（contain 换算天然在界内）。
- **多条目共享一台「屏幕设备」**：一期恒主屏 = 单实例单 boxId（`hostscreen-main`）——多个
  host-screen 条目在路由层多对一注册同一 HostScreenBoxBackend/HostScreenControl（多条目 =
  多个绑定入口，物理上同一块屏）。Phase 2 多显示器时按 display 拆实例。
- **ScreenControlRouter**（boxes/screen）：kernel.screen 单实例消费面不变，按 boxId 分发
  （hostscreen-main → HostScreenControl；其余 → X11 经 routedBackend）——RoutingBoxBackend 的
  对位件，工具族/GuiStreamService/gui 命令面零改动。coordinator `AssembleOptions.screen`
  可选注入（缺省 X11 既有行为；CLI 冒烟不受影响）。
- **session.codec 真相源修正**（顺手修的既有隐患）：GuiStreamService 此前用**请求的** codec 记
  entry.codec——适配器内部降级时 meta 说谎（renderer 按错管线解码）。改为 `session.codec`
  （接口声明的实际交付值）——HostScreenControl 无 ffmpeg 时 h264 请求降级 mjpeg，meta 如实。
- **GUI 门 host-screen 分支**：装配期布尔加一路 `hasHostScreenRoute`（条目在场即
  computerEnabled，跳过 X11 工具集探测——内置注入不需要 xdotool）；运行中新增条目重启后生效
  （与 X11 门同为装配期语义，记档）。
- **actionGate（裁定 F）落地形态**：`gated()` 提取 `requestToolApproval`（nonce 幂等键同构
  `originMessageId:toolCallId`），computerActionTool 在接管锁之前过闸；**截图不进闸**——注册
  条目本身即「可看」的授权（用户自己注册的屏幕），注入才是主权面；闸门实例 = SwitchableApprovalGate
  （manual 逐次弹窗 / auto 沿 auto 语义）。
- **E2E 边界（裁定 G）**：常规用例只测注册/真实测试报告/重启持久/删除（真实测试 = 几何报告 +
  ffmpeg 档位，零注入零副作用）；真注入只进 `hostscreen-real.e2e.spec.ts`（env 门控 + stdout
  打 fps 实测——真机验收时人在场跑）。
- **文档欠账如实记档**：protocol.md 从未记载 `v1.images.*` 命令族（P8-3/4 的 G4 项欠账）——
  本期不顺手扩面补写，立此存照（后续轮次补）。
- **坑（实施中）**：①`kdb/kub` 半程按钮助手初版走「const 再赋值注入 C# 片段」——非法，改
  HOST_INJECT_CS 单独常量拼接；②测试断言 argv 长度漏了 `-Command` 前的 Bypass；③registry
  execute 回传 string 时 `.text` 是 undefined（拒绝回喂是裸字符串）——测试断言形态对齐；
  ④两行动作需要两个 ok（逐行确认语义）——首版测试只发一个 ok 挂到超时。

## 风险与地雷

1. **SendInput 全局注入与真人抢占**：注入与用户的手共用键鼠队列；目标窗口失焦事件落他处——一期
   如实记档不自动置前窗口，动作粒度审批（F）兜底。
2. **DPI 缩放坐标换算**（125%/150% 物理像素 vs 逻辑像素）——coordScaleOf 先例，单测锁死。
3. **desktopCapturer 帧延迟**（50–150ms/帧，1080p 更甚）——降缩略图分辨率提帧率；轮询帧 gui.frame 先例。
4. **PowerShell Add-Type 首编译** ~1s（进程常驻摊薄）+ 杀软误报面（Add-Type 是常见误报源，如实记档）。
5. **E2E 误注入**：门控纪律（G）——E2E 不真注入，真注入只进门控套件。
6. **键名映射覆盖面**：X keysym 常用集 vs 全集——一期常用集（字母/数字/修饰键/方向/功能键/标点），
   缺名如实报错不猜。
7. **协议面扩张**：`v1.images.*` 既有命令族内扩展（carrier 新值），wire 版本纪律（可选字段向后
   兼容、稳定错误码）。

## 排期与验收

P9-1 一轮独立交付；P9-2/P9-3 按需。

| 轮 | 交付判据 |
|---|---|
| P9-1 | 宿主注册「宿主屏幕」条目 → agent 绑定 → 对话内 computer_screenshot 看到本机屏幕 → computer_click/type 真实生效（门控套件验收）→ GUI 视图实况流按 L0/L1 档位呈现（**档位 + 实测 fps/延迟如实可见，未达高档带原因与指引**）；既有 X11/SSH/容器链路零回退（已实施，v0.1.32） |
| P9-2 | L2 零依赖流式（getUserMedia 帧泵）+ 窗口区域绑定（EnumWindows/GetWindowRect）+ 通道侧 move 合帧（已实施，2026-09-26） |
| P9-3 | **A 轮（Windows 机内适配器）已实施**（2026-09-26）；Android adb / RDP 随真机接入定形（A/B 两路线待用户表态） |

## P9-2 实施记档（2026-09-26，用户批准后实施）

- [x] 1. PS 协议扩展：EnumWindows C#（wlist/rect + R/W 回包行 + DPI 感知）+ 单测
- [x] 2. state：`windowTitle?`（host-screen 专属校验 + 切载体清除 + 读取端兼容）+ 单测
- [x] 3. HostScreenControl 窗口模式：geometry/act/capture 窗口感知（原点换算/裁剪/rect TTL
   + 每动作现查）+ 未在场如实拒绝 + 单测
- [x] 4. L2 采集管线：hostscreen-pump.ts（隐藏窗口 + 专用 preload + getUserMedia 帧泵 +
   首帧就绪/出错 reject 语义）+ 探测序 L1>L2>L0 + 单测（fake 泵 + 降级自愈）
- [x] 5. kernel：`v1.hostscreen.windows` 窗口清单命令 + `v1.images.test` 三档如实报告
   （streamTier 单一事实源）+ bridge crop 扩展
- [x] 6. 设置页：绑定窗口下拉（⟳ 枚举按钮 + 可清空回整屏）+ 摘要呈现
- [x] 7. 通道侧 move 合帧（coalesceMoves——renderer 60Hz 合帧的第二级）+ 单测
- [x] 8. E2E：窗口绑定常规段（条件断言）+ 门控套件档位报告打点
- [ ] 9. 真机监督验收：门控套件跑一轮（三档 fps 实测回填本表 + L2/窗口模式真链验证）
- [x] 10. 文档：plan 记档 + ARCHITECTURE §3.2 语义同步 + backlog ⑥ 状态

## P9-3a 实施记档（2026-09-26，用户批准后实施——「Windows 机内适配器」轮）

- [x] 1. boxes：SshWindowsBoxBackend（EncodedCommand exec/env/cwd、fs PS 变体、openShell、
   attach/caps/probe）+ 单测（编码前脚本内容逐字断言——argv 锁死）
- [x] 2. boxes：win-protocol.ts 提炼（HOST_INJECT_SCRIPT/serialize/keyToVk/coalesceMoves/
   attachWinChannel 通道机制收口——HostScreenControl 行为等价迁移，26 测试锁死零回归）+
   SshWindowsScreenControl（注入通道 over ssh openPipe / PS CopyFromScreen 截屏 / b64 行帧流）+ 单测
- [x] 3. state：carrier `'windows'`（协议 'win'|'none'；ssh↔windows 同形组互切保留连接事实）+ 单测
- [x] 4. desktop：路由注册（per-entry 后端 + 同主机 boxId 收敛共享屏幕适配器）+ GUI 门
   windows 分支（mirror 宿主屏幕门）+ `v1.images.test` windows 分支（连通/几何如实报告）
- [x] 5. 设置页：载体「Windows 主机」+ 连接字段与 SSH 复用 + 协议段 Win 注入/无 + 目标机
   安装指引注记；摘要/ctx/向导三处呈现
- [x] 6. E2E：Windows 注册/真实测试不可达红 chip/重启持久/删除（mock 沙箱零真连）；门控
   套件 `ssh-windows-real.test.ts`（`OPENBOT_TEST_WINSSH=1` 基础链 + `OPENBOT_TEST_WINSSH_GUI=1`
   注入/截屏/帧流全链——注入往返与 fps 实测打点）
- [ ] 7. 真机监督验收（与 P9-1/P9-2 门控欠债合并一轮——用户裁定 P9-3 完成后跑）
- [x] 8. 文档：ARCHITECTURE §3.2/§6 同步 + platforms.md 目标机安装指引 + backlog ⑥ 状态

### P9-3a 实施要点

- **核心洞察兑现**：PS 协议传输无关——`attachWinChannel` 只要求一根到 powershell 的
  stdin/stdout 管道；本机 = 本地 spawn（PipeProcess 多回调面）、机内 = ssh openPipe
  （PipeSession 单回调面）——同一行协议/ack/回包解析逐字节复用（win-protocol.ts 收口）。
- **EncodedCommand（裁定 B）**：UTF-16LE base64 单 token——对 cmd/powershell 默认 shell 双
  透明，消灭 Windows 引号地狱；env/cwd 内联编码脚本（$env:/Set-Location——SendEnv 本就不可
  依赖）；`exit $LASTEXITCODE` 传导原生退出码。
- **DPI 前置**：截屏/几何脚本内联 `SetProcessDpiAwarenessContext(-4)`——远端 PS 物理像素与
  注入归一化同坐标系（真机缩放显示器实测归门控套件回填）。
- **b64 行帧流（裁定 D）**：每帧一行 base64（newline 定界——ssh 文本管线免二进制翻损，
  带宽 +33% 记档）；渲染端 mjpeg 管线零改动。
- **审批闸语义**：windows 载体 = 远端独立机器（isolation high）——**不经**宿主屏幕的
  actionGate（那是零隔离本机桌面的特权面）；agent 在目标机内 exec/注入 = Box 内自由。
- **每主机收敛**：同主机的多个 windows 条目共享同一 boxId（win-<host>）与屏幕适配器
  （同一桌面面）；条目删除按引用计数清理（孤儿纪律）。
- **坑（实施中）**：①公共 exec 曾把原始 PS 脚本再包一层 `& '<串>'`（& 对字符串是命令名
  调用非脚本执行）——拆 `#execRaw` 内部面，公共 exec 走 buildWindowsScript；
  ②bash 内嵌 node 重构遭反引号地狱（坑⑫第四变体——`\${` 在双引号 heredoc 中被命令替换
  展开损毁模板字面量）——改 Edit 工具手工修复，教训记档：**批量重构禁用 bash 内嵌脚本
  拼接 TS 模板串**；③测试替身路由键 `Bounds.Width` 与实际脚本子串不符（`Bounds; ...$b.Width`）
  ——单测首抓，路由键改 `PrimaryScreen.Bounds` 且 CopyFromScreen 判定前置；④**Vue watch 陷阱
  （E2E 首训）**：`watch(reactiveObj.prop, cb)` 传的是值不是源——联动静默失效，P9-2 宿主屏幕
  因 saveImage 强制 protocol 侥幸通过，P9-3a windows 无强制即炸（保存被 zod 拒、行不出现）——
  修复 = watch 源改 getter `() => obj.prop` + saveImage 对载体协议做同款强制（双保险）。

### P9-2 实施要点

- **L2 帧泵（核心工程量）**：`apps/desktop/src/main/hostscreen-pump.ts`——隐藏 BrowserWindow
  （show:false + skipTaskbar + **backgroundThrottling:false**——隐藏态不降速是本档位的全部意义）
  + 极简专用 preload（`resources/hs-pump.cjs`——不污染主 renderer 桥）+ `resources/hs-pump.html`
  （内联脚本 getUserMedia desktop → canvas 33ms 节拍 → JPEG 帧经 IPC 泵回主进程）。
  **就绪语义 = 首帧才 resolve、出错/10s 无帧即 reject**——HostScreenControl 据此在会话内
  自愈降级 L0（同会话换引擎，用户零感知）。固定 IPC 频道 + event.sender 过滤（多泵窗口不串线）。
- **档位优先序（裁定 A）**：L1 ffmpeg > L2 泵 > L0 轮询；`streamTier()` 是 v1.images.test
  三档报告的单一事实源（l1/l2/l0 如实——不再只报「有/无 ffmpeg」）。
- **窗口绑定（裁定 B/E）**：PS 脚本扩展 EnumWindows（C# `ListWindows`/`FindWindowRect`）+
  DPI 感知（`SetProcessDpiAwarenessContext(-4)`——GetWindowRect 物理像素与 desktopCapturer
  同坐标系，**这是窗口裁剪正确性的前提**）；行协议加 `wlist`（W|…回包 + W|end 收齐）与
  `rect|<b64>`（R|x|y|w|h / R|- 回包）；标题子串匹配，窗口重开同名即恢复；**未在场如实拒绝**
  （act/capture/test 三路径统一话术），不静默回整屏。
- **窗口模式坐标链**：截图 = 全屏缩略图 NativeImage.crop（rect 按缩放系数折算+钳界）；act =
  本地域校验（agent 拒/user 钳）→ 原点偏移 + 1280 契约缩放 → 屏幕绝对归一化（对全屏 span）；
  rect 每动作现查（注入不容陈旧），geometry/capture 走 250ms TTL 缓存。
- **每条目一 box（语义修正）**：P9-1 的「多条目共享 hostscreen-main」改为 `hostscreen-<entryId>`
  ——窗口绑定条目是**不同的桌面面**（几何/域各归窗口），记账/路由/适配器按条目区分；
  `HOST_SCREEN_BOX_ID` 常量退役（外部引用迁移期保留）；路由器 adapters 改函数形态
  （运行时可变清单——dispose 兜底遍历不漏 per-entry 适配器）。
- **通道侧 move 合帧**：`coalesceMoves` 批次内连续 move 只留最新（renderer 60Hz 合帧的第二级
  ——两级节流拖拽不洪泛）。
- **E2E 边界**：常规用例窗口绑定段为条件断言（枚举到窗口才断言绑定/摘要/改回整屏——环境无关
  纪律）；门控套件加档位报告打点（三档实测 fps 一并 stdout）。
- **坑（实施中）**：①初版重写引入 `serializeBatchAbs/__batch` 半成品设计（死代码 + 类型欺诈）
  ——立即收敛为 `serializeHostActionAbs` 单核心 + `serializeHostAction` 本地坐标薄包装；
  ②rect/wlist 只等回包没写请求行——单测首抓（「请求-回包成对」语义无测试锁不住）；
  ③user 钳制的 span 选错（窗口宽 vs 屏幕宽——abs 坐标按窗口宽钳会截掉屏边）——窗口模式
  统一对屏幕 span 钳制、本地域校验独立做；④pump 早期帧早于 onData 挂接——加 pending 缓冲
  挂接即回放。
