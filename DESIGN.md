# OpenBot — 设计规范

## 主题

深色。场景句：Windows 11 用户深夜在桌面常驻一个 agent 任务控制台，与编码会话并排，
环境光昏暗，需要长时间注视不疲劳，同时要在流里一眼分辨"谁在干活"。

非纯黑：OKLCH 中性色微微偏暖（hue 70±），避免 GitHub-dark 的冷灰和 hacker 黑。

## 色彩策略

Restrained（产品默认）：着色中性 + 单一强调色 ≤10% 面积。

### 语义色（OKLCH）

- bg-0 沉底：oklch(0.15 0.006 70) — 标题栏/侧栏
- bg-1 内容面：oklch(0.18 0.006 70)
- bg-2 浮起面：oklch(0.21 0.007 70) — 卡片/hover
- bg-3 输入/嵌入：oklch(0.24 0.008 70)
- 边线 border：oklch(0.30 0.008 70 / 60%)
- 文字 primary：oklch(0.93 0.005 80)
- 文字 secondary：oklch(0.72 0.008 80)
- 文字 muted：oklch(0.55 0.008 80)
- **accent（信号琥珀）**：oklch(0.80 0.13 75) — 主操作/选中/运行中。暖琥珀，机器工作灯的隐喻，
  刻意避开 AI 紫/科技蓝/终端绿三个反射区
- accent-weak：oklch(0.80 0.13 75 / 14%) — 选中底色
- success：oklch(0.78 0.12 155)
- warning：oklch(0.82 0.12 85)
- danger：oklch(0.68 0.16 25)
- info/远端：oklch(0.75 0.09 240) — 跨用户 mirror 成员专用

### Agent 身份色（分类色板，已过验证器）

固定顺序，不循环。经 dataviz 六项校验（dark · adjacent + all-pairs 双通过：
CVD ΔE 9.4 / 常视 16.0 / chroma≥0.1 / 对比度≥3:1）。
唯一记录在案的偏差：olive 亮度 0.732 超出暗面色带上限 0.67（带内黄无法通过 CVD 硬门，
olive 是最近的可通过色步；agent 色仅用于小面积头像/状态点/名字，非大面积标记）：

- alpha：#d95926 橙（参考板 slot2）
- beta：#aab137 橄榄（自校色步）
- kappa：#199e70 水（参考板 slot3）
- delta（远端）：#3987e5 蓝（参考板 slot1，远端成员专用蓝系 + mirror 徽标二级编码）
- 用户本人：中性亮灰
- 第 5 个本地 agent 起接入 magenta #d55181，再往后折叠进"其他"

用法：仅用于头像底、名册状态点、消息发送者名。不上大色块。任何场景都带名字文字（二级编码）。

## 字体

- UI：`"Segoe UI Variable", "Segoe UI", system-ui, sans-serif`（Windows 原生）
- Mono（命令/日志/ID）：`"Cascadia Code", Consolas, monospace`
- 单族。固定 rem 阶梯，比例 1.16：
  11px 标签 / 12px 次要 / 13px 正文基准 / 15px 强调 / 18px 视图标题 / 24px 大数字

## 布局

- 桌面 App 框架：自定义标题栏（Windows 右侧 caption 按钮）+ 左侧 56px 图标导航栏
- 控制台三栏：名册 240px | 流 1fr（max 860px 居中）| 上下文面板 320px（可折叠）
- 间距有节奏：流内消息间距 20px，卡片内 12px，面板分区 24px

## 组件词汇

- 按钮：8px 圆角；primary=accent 底深字；secondary=bg-2 底描边；ghost=透明
- 卡片：bg-2，1px 边线，10px 圆角。全边框，禁止左侧色条
- 状态点：6px 圆点 + 工作中呼吸动画（1.6s ease-in-out 透明度脉动）
- 任务卡：头部（agent·Box·时长）+ 步骤列表（mono）+ 产物区
- 表单：bg-3 底 1px 边线输入框，focus 时 accent 边线 + 2px 光环

## 动效

- 150–220ms ease-out（cubic-bezier(0.25, 1, 0.5, 1)），只表达状态变化
- 工作中呼吸脉动；任务完成一次短促确认；视图切换无编排动画
- 禁止：布局属性动画、弹跳、页面加载编排

## 禁止清单（本项目追加）

- 左侧色条卡片（用全边框或底色替代）
- 渐变文字、玻璃拟态默认化
- AI 紫/蓝渐变、终端绿黑客风
- 真人头像拟人化
