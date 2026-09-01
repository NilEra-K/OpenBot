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
