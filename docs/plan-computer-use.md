# 沙箱内 computer-use 实施计划（一期）

> 状态文档：随实施推进更新勾选与「设计要点」。方向裁定（2026-09-01 用户澄清）：computer-use
> 操作的是**沙箱内桌面**（如 podman 里装 GUI Ubuntu），不是宿主机桌面——爆炸半径被 Box 边界
> 约束，安全等级与 exec/fs 同级（**Box 内自由、出 Box 才审批**的既有铁律直接覆盖，零新审批面）；
> 登录/认证等人类身份操作经**操作台 GUI 接管**交还用户（交接走自然语言，无新协议）。
> 原 backlog ④「computer-use（宿主桌面）」的理解偏差就此修正归档。
> 上游计划 [plan-backlog.md](plan-backlog.md) ④ 行；架构依据 ARCHITECTURE.md §3.6（工具层）/§6（Box）。

## 目标与验收

agent 能看（截图→多模态 LLM）与操作（点击/键入/滚动）沙箱内的 GUI 桌面；用户能在操作台
接管 GUI 手动完成登录等认证操作后交还 agent 继续。

- **验收**：工具族单测（argv/回喂语义）；E2E 用**多模态 mock 端点**全链（收图断言→回坐标点击→
  容器内状态变化可断言）；操作台 GUI 视图（截图轮询 + 用户点击注入）人工冒烟 + E2E 断言在场；
  `pnpm build && pnpm typecheck && pnpm test` 全绿；既有 26 E2E 不回退；
- **不造假纪律**：主力模型不支持图像输入时 computer 工具**不注册**（能力驱动，不放假工具）；
  GUI 容器模板不在场（WSL 后端）时同样不注册——工具可用性 = 模板在场 ∩ 模型多模态。

## 待裁定的范围（批准时逐项表态，未表态按推荐）

| 项 | 选项 | 推荐 |
|---|---|---|
| A. GUI 栈 | a) 轻栈：xvfb + 轻窗口管理器（openbox）+ xdotool/scrot——无完整桌面，够「应用级 GUI 操作」；b) xfce 完整桌面（更像真机，镜像大、启动慢） | **a)**——一期目标是「操作 GUI 应用」不是「仿真桌面」；完整桌面记档后续按需加层 |
| B. 操作台 GUI 通道 | a) 截图轮询（exec 内 scrot→base64，1-2fps，零端口暴露）；b) VNC 直连（流畅但容器端口暴露 + 前端 VNC 客户端） | **a)**——不引入端口面（既有 OCI 后端无端口转发表）；登录等慢操作 1-2fps 够用；VNC 记档二期 |
| C. 图像 wire 格式 | a) 仅 openai-compat `image_url`（GLM-4V/Qwen-VL/Ollama 视觉模型兼容）；b) 双协议（+ anthropic image block） | **b)**——llm 层本就双协议，图像 part 两边各编一次成本小；anthropic 侧模型即支持 |
| D. 截图注入模型的时机 | a) 仅当 agent 主动调 computer_screenshot（模型自主决定何时看）；b) 每次动作工具结果自动附截图（动作后即见结果） | **b)**——click/type 等动作工具的回喂自动带「动作后截图」，模型免二次调用看结果（少一轮往返）；a 的显式截图工具仍保留（初次看屏） |

## TODOLIST

- [x] 1. **GUI 容器模板**：`apps/desktop/resources/gui-ubuntu/`——Dockerfile（ubuntu:24.04 +
  xvfb + openbox + xdotool + scrot + 常用 GUI 应用最小集如 firefox/文件管理器）+ 启动脚本
  （Xvfb :0 → openbox → 常驻）；`OPENBOT_GUI_IMAGE` env 或镜像名 `openbot-gui`；podman/docker
  build 脚本与文档（真机构建验收——本机 podman machine 未启则记「待设备」照旧）
- [x] 2. **llm 层多模态**：`ChatMessage.content: string | ContentPart[]`（`{type:'text'} |
  {type:'image', base64, mime}`——内部规范形）；openai-compat（image_url data URI）与
  anthropic（source: base64）各编 wire；`ToolSpec` 无涉；provider 能力声明
  `supportsImages?: boolean`（档案缺省 false——设置页「视觉」徽标呈现）；单测（两协议 wire
  形状 + 纯文本路径零变化）
- [x] 3. **工具回喂扩展**：`Tool.execute` 返回 `string | { text: string; image?: { base64,
  mime } }`；TurnRunner 组装 role=tool 消息时 image 在场→ content parts（含图）——
  纯文本工具零变化；单测（回喂图像进 messages 的形状）
- [x] 4. **computer 工具族（runner）**：`computer_screenshot`（scrot 全屏→png base64→回喂图）；
  `computer_click(x,y)` / `computer_double_click` / `computer_type(text)` /
  `computer_key(combo)` / `computer_scroll(dy)`——全部经 exec 调 xdotool（**CLI 即接口**，
  boxes 后端零改动；裁定 D：动作工具回喂自动附动作后截图）；工具 spec 描述写明坐标语义与
  「认证/登录场景请用户接管」指引；**注册门**：模板在场（env 探测或镜像存在）∩ 主力
  provider supportsImages——不满足不注册；单测（argv 与回喂语义——GUI 真机行为记未验收）
- [x] 5. **GUI 接管锁（desktop 壳层）**：接管互斥服务——GUI 视图首笔用户输入（`v1.box.gui.input`
  收到用户来源事件）置「接管中」；computer 工具执行前查锁（注入闭包），在场则挂起
  （形态同审批挂起：run 停留 working、流内呈现「用户接管中」卡；挂起 Promise race 既有
  AbortSignal——接管中点「中止 run」照常传导）；「交还 agent」按钮放行——不做无操作超时
  自动交还（不猜测用户）。粒度如实记档：挂起生效在**下一个工具调用边界**（当前原子动作
  毫秒级跑完——登录场景无争用）。锁是壳层内存态不进内核协议（computer 工具实现是 desktop
  装配注入——挂起逻辑在实现内，内核零改动）
- [x] 6. **操作台 GUI 视图**：BoxScreen 新增「GUI」视图——帧源 = 工具回喂的最新截图
  （**旁观即 agent 视角，零额外截屏**）+ 低频轮询兜底（1.5s，agent 空闲时画面也能动）；
  用户交互注入（点击/键盘转发命令面→xdotool，与 agent 同一条通路）；接管中视图态呈现
  （「你已接管——完成后点『交还 agent』」+ agent 挂起卡）；入口按钮 caps/模板在场才呈现
- [x] 7. **E2E**：多模态 mock 端点（断言请求含 image part → 回 computer_click 工具调用 →
  mock 容器断言 xdotool 收到？——GUI 容器不在 E2E 环境：**mock 后端伪造 computer 工具行为**
  （screenshot 返回 1x1 png、click 记录 argv），断言全链消息形状与工具门（无多模态 provider
  时工具不在 specs）；操作台 GUI 视图在场断言；**接管锁时序**（mock 工具 delayMs 挂起窗口
  内注入用户输入 → 断言「用户接管中」+ 工具未执行 → 点交还 → 断言继续完成）
- [x] 8. **文档与收官**：ARCHITECTURE §3.6 工具族补 computer 族 + §6 GUI 模板注记；
  relay-protocol 无涉；platforms.md 补 GUI 容器行；plan-backlog ④ 改「沙箱内一期已实现」；
  plan-computer-use 勾选记档；版本同步

## 设计要点

### 安全模型（本方案的核心红利）

- **零新审批面**：computer 工具族全部 Box 内执行（xdotool 打的是沙箱内 X server）——
  与 exec 同级「Box 内自由」。沙箱内 GUI 若经浏览器出网，属 Box 网络策略域（既有概念面），
  不是 computer-use 的新风险。
- **用户接管即交接（2026-09-01 用户补充裁定）**：computer-use 进行中用户点 ctx-screen 进
  GUI 视图 = **旁观者**（帧源即 agent 视角）；用户动手（鼠标/键盘经命令面注入——与 agent
  工具链天然分通道，首笔用户输入即接管）→ **接管锁**挂起下一个 computer 工具调用（run 呈
  「用户接管中」，形态同审批挂起）；用户完成点「交还 agent」→ 放行继续。交接语义走 UI
  状态 + 工具挂起，**无新协议**；挂起粒度 = 工具调用边界（当前原子动作毫秒级跑完——如实）。
  之所以不需要杀任何东西：agent 的 GUI 操作本就是逐工具调用循环，挂起下一个调用即暂停。

### 图像链路（本方案的核心工程）

```
scrot(容器内) --exec--> 工具回喂 {image base64} --TurnRunner--> tool content parts
  --openai-compat: image_url(data URI) / anthropic: source.base64 --> 多模态 LLM
```
- 内部规范形 `{type:'image', base64, mime}` 在 ChatMessage 层统一，wire 各编——与协议族
  分支（anthropic/openai-compat）同构。
- **token 纪律**：截图降采样（scrot --zoom 0.5 或 convert 缩放至宽 ≤1280）+ jpg（截图场景
  png→jpg 体量降一个量级）；provider 侧计费差异记档不处理。
- 能力声明 `supportsImages` 是**档案级配置**（用户在设置页勾选/自动识别——一期 env/手动配，
  自动探测 model 名（含 4v/vl/vision）启发式记档后续）。

### GUI 模板与后端

- 模板镜像名 `openbot-gui:<tag>`；装配探测 `docker/podman image inspect`（在 OCI 后端可用时）；
  探测不可用→工具不注册（如实）。
- WSL 后端（发行版即 Box）也能跑 GUI 栈（apt 装 xvfb/xdotool）——一期只做容器模板路径，
  WSL 路径记档（探测 wsl 发行版内 xdotool 在场即可注册——实现小但验收重，后置）。

### 操作台（Step 5）

- 既有 BoxScreen 是「PTY 文本流」；GUI 视图是并列第二种实况（截图帧轮询）——复用 box-screen
  容器形态，数据通道走命令面（`v1.box.gui.frame` 拉帧 + `v1.box.gui.input` 注入）而非 WS 流
  （帧率低、半双工，命令面够用——不扩 stream 协议）。
- 用户点击/键入 = 前端把坐标/键映射为 xdotool argv 经命令面注入——与 agent 走同一工具链
  （同一条 xdotool 通路，无第二套后门）。

## 风险与地雷

- **多模态模型可用性**（国内端点）：GLM-4V/Qwen-VL 的 openai-compat image_url 兼容度实测
  （ Vision 模型 wire 差异：content 数组 vs legacy 字段）；E2E 用 mock 锁**我们的 wire 形状**，
  真机模型行为漂移记档（与 OCI 后端同验收哲学）。
- **截图体量**：1280 宽 jpg ~100-300KB/帧——动作工具自动附图（裁定 D）时多轮工具循环的
  token 成本陡增；对策：附图尺寸再降一档（960 宽）+ 仅动作坐标局部截图（crop 坐标邻域）记档后续。
- **xdotool 坐标系**：scrot 截图分辨率与 Xvfb 屏幕一致（同源）——模型看到的即坐标空间，
  无换算；但缩放附图时**坐标要在回喂文本里换算标注**（附图时同时给实际分辨率，模型换算或
  我们预换算——一期预换算：注入时按原图坐标，附图仅视觉参考，text 部分带「分辨率 W×H」）。
- **GUI 容器真机验收**：本机 podman machine 未启（P5 既有状态）——模板 Dockerfile 纸面 +
  工具链单测 mock；真机链路记「未验收」（与 nspawn/UTM 同待设备池）。
- 坑⑫预警（继承坑④⑩教训）：本轮不动 dist/bundle 链——无新风险面。

## 实施记档（2026-09-02）

- **llm 多模态**：ChatMessage.content 扩 `string | ContentPart[]`（内部规范形 {type:'text'|'image',
  base64}）；openai-compat 编 image_url data URI / anthropic 编 source.base64（tool_result 含图时
  content 用块数组）；纯文本路径零变化（366 既有单测全绿）。ProviderCapabilities.supportsImages
  声明面就位（一期未接自动探测——env 门记档）。
- **工具回喂**：Tool.execute 返回扩 `ToolResult {text, image?}`；TurnRunner 含图时组装 content
  parts；ToolRegistry.lastImageOf 暴露最近含图结果（GUI 旁观视图帧源）。
- **computer 工具族**：6 件（screenshot/click/double_click/type/key/scroll）全经 boxes.exec 调
  xdotool/scrot（CLI 即接口，后端零改动）；动作工具前等接管锁、后附动作后截图（裁定 D）；
  截图 1280 宽 jpg、附图走命令面 960 宽（token 纪律）。**坑⑫**：JS 反引号字符串里 `'` 是
  转义（吃反斜杠）——shell 转义串 `'''` 必须逐字面写入（fromCharCode 绕行修复，单测锁定）。
- **接管锁**：desktop 壳层内存态（waiters 队列 + held 标志）；v1.box.gui.input 首笔用户输入
  置锁（事件 v1.box.gui-takeover 下发）、release 放行；computer 动作工具 waitTurn 挂起
  （形态同审批挂起）。注册门：env OPENBOT_COMPUTER=1（E2E/演示）——生产门（GUI 镜像探测 ∩
  provider supportsImages）待 GUI 容器真机链路记档。
- **GuiScreen 组件**：ctx 屏幕区「终端 ⇄ GUI」切换（computerEnabled 才呈现）；帧源 =
  1.5s 轮询 v1.box.gui.frame（agent 空闲兜底）+ 工具回喂帧天然刷新；用户点击坐标按
  naturalWidth/clientWidth 换算注入；键盘常用键映射 xdotool。**坑⑬**：视口点击冒泡到
  ctx-screen 的 openOps（打开操作台遮住 gui-bar——E2E 抓到）：`@click.stop` 修。
- **E2E**：全链（OPENBOT_COMPUTER=1 → 剧本 screenshot → mock 收到的 tool 消息含
  image_url data:image/jpeg ——wire 形状断言）+ 接管状态机走真实 UI（点视口 →「你已接管」→
  交还 → 回落旁观中）。单测 5 例（锁语义/argv/转义/校验/lastImageOf）。
- **真机验收（如实未验收）**：GUI 容器构建/启动（podman machine 未启——与 nspawn/UTM/Docker
  镜像同待设备池）；xdotool/scrot 实际行为由单测替身锁 argv。版本 0.1.6。

## 二期：30 FPS 实况流（2026-09-02 用户需求——2026-09-03 按推荐裁定实施）

一期截图轮询（1.5s）是裁定 B 的刻意最小面（零端口零新协议），不是架构天花板——**WS /stream
数据面在 ARCHITECTURE §5 第一天就按 10-30fps 设计**（二进制帧 + 背压，PTY 流已跑其上）。
二期把 GUI 画面搬上这条既有通道。

### 目标与验收

- GUI 视图 30 FPS 实况（用户接管操作时流畅反馈）；agent 旁观时段低频兜底（省资源）；
- 按需开流：**接管时才开高频流**（agent 桌面无动静时 30fps 是纯浪费——用户操作才需要流畅）；
- 背压生效（渲染端跟不上自动降速不堆积——WS /stream 既有语义）；
- 键入批量合并（一期单键一发 exec 往返 ~10-30ms，连续打字卡顿——50ms 窗口合并成一串 xdotool type）。

### 待裁定（批准时表态，未表态按推荐）

| 项 | 选项 | 推荐 |
|---|---|---|
| A. 采集引擎 | a) ffmpeg x11grab 常驻管道（`-f x11grab -r 30 ... -f mjpeg image2pipe`——spawn 拿 stdout 拆帧，GUI 栈加 ffmpeg 包；实现简单无新协议库）；b) x11vnc（RFB 增量更新，空闲近零流量——但要引 RFB 客户端库或自解析协议） | **a)**——mjpeg 管道零协议依赖拆帧即帧；环回带宽 mjpeg 30fps@1280x800 约 30-60MB/s 无压力；H.264+WebCodecs 压缩上限记档三期 |
| B. 开流策略 | a) 一直 30fps；b) 接管时 30fps / 旁观时 1.5s 轮询兜底 | **b)**——按需开流省资源；切流无缝（blob 帧与轮询帧同一 img 槽） |
| C. 流生命周期 | a) GUI 视图开即起流、关即杀 ffmpeg；b) 装配起常驻 | **a)**——随视图开关（孤儿进程纪律——dispose 杀干净，坑③教训） |

### TODOLIST

- [x] 1. **采集管道（backend pipe 语义）**：**实施定夺：不走 PTY**——`spawnShellProcess` 全链
  UTF-8 解码（procexec→ShellService→WS JSON `{t}`），jpeg 字节过解码必毁；规划倾向的
  「PTY 增量读」落点即规划自留的地雷。改为 `BoxBackend.openPipe?`（PipeSession：stdout
  **原始字节**直出零解码 + stderr 滚动诊断尾巴 4KB + 无界 close 收口），procexec 增
  `spawnPipeProcess`（stdin 'ignore'，与 spawnShellProcess 并列）；wsl（env 注入同款坑⑭）/
  oci（同款坑⑮）/mock 三后端实现。缺省采集 argv：`ffmpeg -nostdin -f x11grab -framerate 30
  -video_size WxH -i <display> -f mjpeg -q:v 5 pipe:1`——**-video_size 必填**（x11grab 缺省
  640x480 是 libavdevice 的 vga 默认，不传就是小窗），几何经 `xdotool getdisplaygeometry`
  现查（失败 1280x800 兜底放行）；拆帧器（SOI/EOI 标记扫描纯函数，跨块/超长自愈）单测锁定
- [x] 2. **WS /stream 扩帧型**：`StreamOpenMeta.kind` 加 `'gui'`；**GuiStreamService**
  （coordinator，与 streamHub/shellService 并联装配）——单屏纪律（换 Box 开流先杀旧 ffmpeg）、
  单帧 latest 槽位（内存有界）、晚接入会话补开流+立即回放 latest（无黑屏间隙）、
  **背压即降帧**（PAUSE 期不入队不排旧帧只更新 latest，RESUME 补发最新一帧——StreamSession
  缓冲语义对实况流会越积越陈，丢弃策略在此落地）；gateway 增 `onStreamPause` 对向信号转发；
  >256KB 帧发送方切块（协议契约）
- [x] 3. **GuiScreen 双态帧源**：接管/交还 watch 联动 start/stop 命令（裁定 B：接管才 30fps，
  旁观 1.5s 轮询兜底——轮询 timer 常驻 pull 门禁零动作）；同 img 槽（blob 帧与轮询 data URL
  同形，切流无黑屏）；渲染节流+背压（img load/error 为解码确认：赋值未确认帧数 >12 → PAUSE，
  确认即追帧/RESUME）；重进视图经 `v1.box.gui.state` 恢复接管态自动续流；store 侧孤儿纪律
  （gui OPEN 到达但零观看组件 → 立即 stop）；renderer lib/stream.ts 手写解码器同步 gui 帧型
  + PAUSE/RESUME 发送（对照镜像纪律）；mjpeg 拆帧器 renderer 侧手抄副本（lib/mjpeg.ts）
- [x] 4. **键入批量**：50ms 窗口合并单键为一串 `xdotool type --delay 0 -- '…'`（POSIX 单引号
  转义）；特殊键与点击前 flush 保序；50ms 窗口连击量级小、500 字符 script 上限实际触不到
- [x] 5. **E2E**：mock 假 ffmpeg（OPENBOT_COMPUTER=1 联动注入：1x1 JPEG 每 150ms 一帧的
  pipe 替身）——新用例「接管开流 → data-frames 递增 → 交还 data-stream 归零」走真实 UI 全链；
  既有 computer-use 用例零改动回归绿；单测 21 例（拆帧器 9 含逐字节切块遍历强性质 /
  GuiStreamService 10 / openPipe argv 2——wsl/oci 方言锁定）
- [x] 6. **文档收官**：ARCHITECTURE §5 三源并联注记；protocol.md 帧型表 + gui 流语义；
  Dockerfile 加 ffmpeg（包体 ~100MB）；plan-backlog ④ 无涉（一期已记）；版本同步

### 设计要点

- **帧源唯一化**：ffmpeg 管道与轮询截图共用「最近帧」槽位（接管切流时无黑屏间隙）。
- **背压即降速**：WS /stream 既有——渲染端 img 解码慢时 hub 自动暂停读取管道（不丢帧不堆积）。
- **token 纪律不变**：30fps 流只进 UI（用户眼睛看），**不进 LLM**——agent 的截图回喂仍走一期
  工具链（1280/960 宽单帧），两条通道互不干扰。
- **WSL 路径零端口**：ffmpeg 在发行版内跑（x11grab 直连 :0），帧经 PTY 管道出——不经 TCP，
  WSL localhost 转发都不需要；容器路径同构（exec/PTY 通道）。

### 风险与地雷

- **PTY 二进制安全**：box-term 通道若按 UTF-8 解码会毁 jpeg 字节——需二进制模式会话（实现时
  核 shellService 的解码层；必要时经 backend 新增 pipe 语义而非 PTY——实施第一步定夺）；
- **拆帧鲁棒性**：mjpeg 边界扫描要处理跨块帧（纯函数 + fuzz 单测）；
- **ffmpeg 包体**：GUI 栈 apt 增 ~100MB（镜像/发行版体积）——如实记档；
- Windows 侧无 ffmpeg 依赖（帧在 Box 内编码，宿主只搬运字节）。

### 工具参数面补齐（2026-09-05 用户报障——v0.1.14）

用户实测：agent 操作容器反复出现「传参格式有误，重新正确调用」（模型把自然语言当 command 传，
如「我用命令行方式打开新终端」）→ 反复错撞穿 8 轮工具预算（RUN_TOOL_BUDGET_EXCEEDED）→
watchdog zombie 逃逸——与 v0.1.8 computer_click 参数循环同族，但这次是 **exec**：v0.1.8 时
判定「exec 描述恰好可猜」而跳过 schema，弱模型面前该假设不成立。

- **修法**：全仓 8 个裸描述工具（exec/fs_write/fs_read/send_message/send_broadcast/
  host_fetch/save_memory/recall_memory）补齐 argsSchema（参数结构进 wire 的 parameters/
  input_schema——v0.1.8 起两协议 wire 层本就映射，零 wire 改动）；exec 校验错误自纠化
  （回显收到的东西 + 正确 argv 示例 + `["sh","-c",…]` 指路——对齐 save_memory 的
  「收到：xxx」先例，模型一轮自纠不再盲猜烧预算）。
- **预算语义不动**：8 轮是失控循环防护；schema 补齐后错参源头消失，预算压力自然消解。
  若弱模型仍撞预算，后续可议「错参轮不计预算/独立小预算」——记档不实施。
- **验证**：单测 411 全绿（+6：schema 全覆盖断言/exec schema 形状/wire 断言/自纠反馈文本
  ×3/合法 argv 不拦）。
- **工具选择指引（2026-09-05 用户问「模型怎么知道走终端还是 GUI」）**：工具描述是模型每轮
  都看的信号源——exec 与 computer_screenshot 描述互指（命令行能完成的优先 exec；必须看画面
  /点界面才用 computer 族），不污染全局提示词（computer 不在场时这些字不占上下文）；
  plan Step 4 的「认证/登录场景请用户接管」指引同期落地 computer_screenshot 描述（遇到登录
  /验证码引导用户 GUI 接管，不代输凭据）。

### 三期：60fps H.264 + WebCodecs（2026-09-05 用户需求——已实施）

用户需求「60+ FPS、不降画质、更跟手」——mjpeg 帧内编码路线三目标互斥（60fps 编码 CPU 爆 /
画质到顶），按规划记档走 H.264+WebCodecs：

- **采集**：`-c:v libx264 -preset ultrafast -tune zerolatency -crf 18 -g 30 -pix_fmt yuv420p
  -framerate 60`——帧间压缩编码 CPU 反低于 mjpeg、CRF 18 视觉无损、码率降一个量级（真机
  实测静止桌面 3s 152KB vs mjpeg 同场景 3.8MB）；`-pix_fmt yuv420p` 必带（x11grab 默认
  bgra 会落 4:4:4 profile，主流 GPU 硬解不支持）；`-f h264` Annex B 裸流。
- **帧语义反转**：H.264 帧间依赖不可丢帧——服务端无 latest 槽位/无跳帧（PAUSE 期
  StreamSession 原生缓冲兜底），晚接入等 IDR（keyint 上限 30 帧≈0.5s，真机实测 IDR 间隔
  有离散——keyint 是上限非周期，静止画面 x264 自适应延迟插入）；服务端纯字节搬运
  （Annex B 解析全在 renderer）。
- **renderer**：Annex B AU 解析器（first_mb_in_slice 判帧界）→ WebCodecs VideoDecoder
  **硬解** → VideoFrame 直绘 canvas（GPU 链路）；解码器错误自动重建（下个 IDR 重同步）；
  WebCodecs 缺席/配置失败如实降级提示。mousemove 合帧 33ms→16ms（60Hz）。
- **双引擎**：env `OPENBOT_GUI_CODEC=mjpeg` 回退一期路径（拆帧/latest/背压降帧全保留）；
  OPEN meta 协商 codec（renderer 按它选管线）；E2E 走 mjpeg 引擎（假流是 JPEG 字节）。
- **真机坑链（实施中首证）**：sliced-threads——ultrafast 默认切片并行，每帧多 slice NALU，
  「一 VCL 一 AU」简化实测 510 AU vs 预期 180 帧；AU 边界必须按 slice header 的
  **first_mb_in_slice**（ue(v) exp-Golomb 位读）判定，0=新帧首 slice。实施中踩的位级坑：
  ue 首位 1 参与数值（ue(0)='1'，漏算读成 -1）；first_mb 位流起点在 NALU 头后一字节
  （off-by-one 全流粘死 1 AU）。真机实证修正后 168 AU/6 key（3s@60fps ≈180 帧内合理）。
- **真机坑⑲（宿主环境）**：podman machine 重启硬停容器后文件系统残留 /tmp/.X0-lock——
  重启容器的 Xvfb 起不来、xfce 误判「X server already running」全链崩；start.sh 开头幂等
  清理根治（容器 /tmp 每次启动本该干净）。
- **验证**：单测 405 全绿（+12：解析器 10 含多 slice/EP3/逐块遍历、argv/meta 2）；E2E 28/28
  （mjpeg 引擎）；真机套件（OPENBOT_TEST_GUI_STREAM=1）真流 AU 切分实证；「AU→WebCodecs
  解码→canvas」半链 Node 无 WebCodecs 无法自动断言——重启客户端人工目验（帧率/画质/跟手）。

### 实施记档（2026-09-03）

- **采集引擎（裁定 A 按推荐）**：ffmpeg x11grab mjpeg 管道——零协议依赖拆帧即帧；x11vnc
  （RFB 增量）与 H.264+WebCodecs 维持记档不取。**PTY 二进制安全定夺落地为 pipe 语义**：
  规划倾向的「PTY 会话增量读」与自留地雷（UTF-8 解码毁字节）同点——实施改为
  `BoxBackend.openPipe?`/`PipeSession`（stdout 原始字节零解码 + stderr 诊断尾巴），与
  openShell 并列的可选实现（wsl/oci/mock 三后端兑现，nspawn/utm 未实现——如实缺省）。
- **帧协议（裁定 B/C 按推荐）**：接管才 30fps（GuiScreen watch takeover ↔ start/stop 命令）、
  随视图开关（unmount 必停 + dispose 兜底 + store 零观看者自动停——三层孤儿纪律）。
  服务端最新帧槽位同时服务两个场景：背压期丢弃与晚接入回放。
- **背压实测语义**：StreamSession 的 PAUSE 缓冲语义（buffer-and-resume 不丢帧）对文件流正确、
  对实况流错误（30fps×100KB 排队=看历史不是看现在）——GuiStreamService 在 PAUSE 期跳过
  sendChunk（不入队），RESUME 时经 gateway `onStreamPause` 转发补发 latest 一帧。
  renderer 侧以「img 赋值未确认帧数」为堆积信号（>12 帧 PAUSE / load-error 确认 RESUME），
  同槽只追最新帧（painting 期间候补帧只留一帧）。
- **坑（单测首抓）**：GuiStreamService.#kill 原实现先清 targets 再杀管道——同步替身下
  onExit 的收流路径（END→观看端）被自己切断；修为只杀、收流全权交 onExit（ShellService
  close 同款纪律）。测试侧坑：大帧禁用展开构造（30 万元素 spread 超 V8 参数上限）。
- **E2E**：mock 假 ffmpeg 与 OPENBOT_COMPUTER=1 门联动（pipe 替身 150ms/帧 1x1 JPEG）；
  断言锚点 `data-stream`（流开关）+ `data-frames`（拆帧重组计数）——不截图不灌帧，2s 跑完。
  全量 28 E2E + 398 单测（+21）零回退。
- **真机验收（podman 路径，2026-09-03 全链实证）**：gui-ubuntu 镜像 apt 层加 ffmpeg（tuna 源
  重构建）；真机套件 `gui-stream-real.test.ts`（门控 OPENBOT_TEST_GUI_STREAM=1 + 镜像在位，
  独立 Box id 不碰桌面实例容器）——容器内真 ffmpeg x11grab → openPipe 原始字节 → 拆帧 →
  WS 会话分发全链绿：**4s 窗口 107 帧（≈27fps）/ 3.8MB / 单帧中位 ≈36KB**（1920x1080 xfce
  桌面、-q:v 5——远低于规划 30-60MB/s 保守估计；静置桌面 mjpeg 同帧高度压缩）；
  停流后容器内 pgrep ffmpeg 清零 + END 收流；teardown 容器清理干净（hook 超时放宽 60s 记档）。
- **坑⑯（podman 真机首证）**：杀宿主侧 `podman exec`/`wsl.exe` CLI 客户端**不传导**容器/发行版
  内进程——pipe.close() 后容器内 ffmpeg 变孤儿继续编码（真机套件 pgrep 抓到）；修法 = start 时
  `sh -c 'echo $$ > /tmp/.openbot-gui-stream.pid; exec "$@"'` 包装记 pid（argv 走 exec 参数零
  引号地狱），stop/dispose 按 pidfile 精确补刀 kill（与一期 exec timeout kill 的「有界」契约
  不同——openPipe 的无界语义必须自带收口）。
- **坑⑰（真机首证）**：CSP `img-src` 补 `blob:`——实况帧是 createObjectURL 的 blob URL，
  旧 CSP `'self' data:` 全量拦截（日志 1126 次，画面黑屏帧在流）；E2E 的 data-frames 计数
  断言不覆盖渲染层放行，真机目验补位。
- **交互裁定（2026-09-04 用户）**：GUI 接管入口收进 BoxOps 大屏，对齐终端「点 ctx-screen 开
  操作台」语义——ctx 小屏纯旁观（点击冒泡开大屏、不绑键盘不开流），接管/键鼠注入/30fps 全在
  大屏（GuiScreen `interactive` prop 分野）；接管真值收 store 单源（`guiTakeover` +
  `v1.box.gui-takeover` 事件广播——大小屏两实例同源）；流随大屏开关（大屏关即停流，接管未
  交还时重开自动续流——裁定 C 的「视图」收窄为大屏）。坑记档：bo-screen 默认块容器令
  `flex:1` 塌缩（gui 态 `:has(> .gui-screen)` 转 flex 容器，终端态零变化）。

### 优化轮记档（2026-09-04 用户实测「没有 30fps、不跟手」——P0/P1 落地）

- **实测根因（podman 真机）**：注入链路每事件一次 `podman exec` 冷启 **410-550ms**（宿主起
  CLI → 穿 machine → 容器起 sh）——「不跟手」的主因；mousemove 一期根本未转发（只实现
  click），光标纹丝不动是观感叠加。「没有 30fps」观感：吞吐实测 27fps 在流内，渲染端
  img.src 逐帧整图解码（1080p JPEG × 30/s 主线程抖动）吃掉流畅度。
- **P0-1 常驻注入通道**：Box 内常驻 `sh -s`（openPipe stdin 行式写入——事件延迟从 ~500ms
  降到容器内 xdotool 执行 ~数 ms）；`PipeSession` 加 `write`、`spawnPipeProcess` stdin 保持
  打开（采集进程 -nostdin 自兜底）、mock 假 pipe 补空实现；kernel 惰性建立/随 Box 切换
  重建/退出自动除名回退逐事件 exec/dispose 兜底杀。
- **坑⑰（OCI 首证）**：`podman exec` 无 `-i` 时不接 stdin——常驻 `sh -s` 立即 EOF 退出、
  注入通道死路（采集无感，通道是命门）；openPipe 补 `-i`（与 openShell 同款）。
- **P0-2 全指针面**：mousemove 30Hz 合帧转发（固定节拍防通道洪泛）+ 点击拆 mousedown/up
  （拖拽真语义，setPointerCapture 出画布可收）+ 右键（button 3）+ 中键 + 滚轮（deltaY 折算
  `--repeat`）；接管语义收敛「点击捕获」（悬停不接管——防路过挂起 agent，VMware 同款）。
- **P1-1 canvas 渲染管线**：`createImageBitmap`（解码离主线程）+ rAF 对齐画帧替代 img.src
  逐帧换；解码忙时候补帧只留最新（实况不排队）；背压信号改为解码队列深度（unconfirmed>12
  → PAUSE / 画帧确认 → RESUME）；轮询帧同泵（坏 base64 静默跳过——mock 的 frame 回显非真
  图，img onerror 语义对齐，E2E 首训）。
- **坑⑱（podman 真机首证）**：应用硬杀（taskkill/崩溃）时 dispose/pidfile 补刀没跑——容器内
  ffmpeg 孤儿继续编码（实测 3 只）；修法 = 开流/建通道前按签名 pkill -9 清场。坑⑱b：模式串
  经 `sh -c` 传入时执行它的 sh 自身 cmdline 含完整模式——pkill 连自己杀（exit 143 自杀），
  模式拆半拼接绕开。坑⑱c：SIGTERM 下 ffmpeg 优雅收尾迟迟不退——清场与 pidfile 补刀一律
  `kill -9`/`pkill -9`（真机探针实证 0.5s+ 不退 vs 立即清零）。注入 sh 带 argv $0 标签
  （openbot-gui-input）供清场定位。
- **验证**：单测 393（+1 spawnPipeProcess stdin/stdout 二进制安全自指）+ E2E 28/28 全绿
  （接管链路选择器 canvas 化）；真机探针 `-i` 修复前后 `sh -s` EOF 退出 vs 行命令即执行。
