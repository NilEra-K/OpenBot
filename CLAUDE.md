# OpenBot 开发规范（Claude 工作指南）

## 项目一览

**OpenBot**：跑在用户自己电脑上的多 agent 社交控制台——重活进本机沙箱（Box），云依赖降到最低。
本地优先、Windows 优先的 Electron 桌面应用，Linux/macOS 后续支持。TypeScript 全栈，Apache-2.0（净室自研）。

- **架构单一事实源**：[ARCHITECTURE.md](ARCHITECTURE.md)（v1.4）——架构疑问先查它，冲突时以它为准；修改架构须经用户确认并同步更新该文档。
- **视觉母版**：`prototype.html`（五视图高保真原型，P2 Vue 重建的底稿）。
- **平台地雷**：[docs/platforms.md](docs/platforms.md)——实现 WSL2/Docker 相关功能前必须对照。
- 当前阶段：桌面应用已演进至 P9（多载体沙箱：WSL/Docker/podman/宿主屏/Windows/Android），版本 v0.1.79（2026-10-18）——群聊身份体系（persona）+ 发言模式体系（#讨论/#汇总/#点名）刚落地；近期重心为真实使用反馈打磨（会话列表、群聊语义、输入体验）。

## 语言与角色

- **语言要求**：请始终使用中文进行回复。代码注释、界面文案、提交日志同样使用中文。
- 默认状态下，你是一个严谨的高级开发工程师。
- 触发条件：当我的指令中包含"架构设计"或"代码评审（Code Review）"等字眼时，你必须立即读取并切换为 `.ai/roles/code-reviewer.md` 中定义的专家角色，以此视角的标准来审视当前任务。

## 运行环境与常用命令

- **Node ≥ 22 + pnpm 11 workspace**（Windows 11 本机）。无 Conda / Python 环境。
- 常用命令（仓库根执行）：

| 命令 | 用途 |
|---|---|
| `pnpm build` | tsc 项目引用全量构建 |
| `pnpm typecheck` | 类型检查（改完代码必跑） |
| `pnpm test` | Vitest 全量测试 |
| `pnpm desktop` | 启动 Electron 桌面壳（纯净观感） |
| `pnpm desktop:debug` | 调试模式启动（CDP 9333，支持远程体检） |

- Electron 二进制安装失败（国内网络）时设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 重装。
- 桌面壳要点：sandbox preload 必须是 CommonJS（`index.cts` → 编译 `.cjs`）；窗口最小宽 1080 必须与页面 `body min-width` 一致（详见 docs/platforms.md 地雷区）。

## 项目规范

核心规则存放在 `.ai/rules/` 目录下，进行相关开发前请参考：

- 项目概述：[.ai/rules/project-overview.md](.ai/rules/project-overview.md)
- 项目架构设计：[.ai/rules/project-architecture.md](.ai/rules/project-architecture.md)
- 代码风格规范：[.ai/rules/code-style.md](.ai/rules/code-style.md)
- UI 与逻辑分离硬性约束：[.ai/rules/ui-logic-separation.md](.ai/rules/ui-logic-separation.md)

## 架构铁律（摘要，全文见 rules 与 ARCHITECTURE.md）

- 依赖只许向下；`coordinator` 是唯一装配根；壳只许 import transport 客户端。
- 内核协议只传领域事实与命令，永不传 UI 指令；错误用稳定 code，文案归渲染层。
- transcript 永远 JSONL append-only；禁止原生依赖进 state。
- 净室纪律：不参考、不复刻 GPL 参考实现的代码结构（Apache-2.0 的前提，见 ARCHITECTURE.md §12）。

## 代码修改与执行约束

1. **谨慎修改**：在修改、重构或删除现有代码时，请保持极度谨慎。在未完全理解上下文之前，严禁破坏性修改。
2. **先规划，后执行**：在实施任何代码修改或开发新功能之前，**绝对禁止直接输出代码**。你必须先向我提供一份具体的规划实施清单，包含：
   - **实施文档 (Implementation Plan)**：简述修改目的、实现思路、可能的影响面以及涉及的文件列表。
   - **TODOLIST/CHECKLIST (任务清单)**：将开发任务拆解为具体的、可校验的步骤（Step-by-Step）。
3. **等待授权**：输出上述【实施文档】和【TODOLIST】后，请**停止输出**并等待我的确认。只有在我明确回复（如"同意"、"继续"、"开始实施"或"按计划执行"）后，你才能开始实际编写和修改代码。（用户报障类任务：定位与无痕验证可先行，涉及改文件仍走本条。）
4. **状态同步与完善 (Progress Tracking)**：在获得授权进入开发阶段后：
   - 你需要按照 TODOLIST 逐步推进。
   - **每次回复时，必须展示更新后的 TODOLIST**，将已完成的步骤打勾（使用 `- [x]`）。
   - 如果在执行中发现需要新增步骤，必须主动完善并添加到 TODOLIST 中，确保任务清单始终与实际代码状态同步。
5. **端口占用处理**：启动或重启任何显式指定端口的服务前必须先检查目标端口。若端口已被占用，必须暂停操作并先询问用户如何处理；未经用户明确授权，严禁停止占用进程、自动改用其他端口、重复启动或重启服务。（transport 环回网关默认随机端口，不受本条约束。）
6. **状态数据与持久化变更**：
   - transcript 为 append-only JSONL：只追加、不就地改写历史记录。
   - 持久化 schema 演进采用「版本号 + 读取端兼容」，不做破坏性迁移；改动后必须跑 `pnpm test` 全量验证，并向我说明对既有数据文件的兼容策略。
   - 本项目不使用数据库迁移工具（无 Alembic/ORM）。若未来引入任何数据库迁移机制，必须先经我明确授权。

## Git 工作流

- **提交流程**（固定）：`git add`（显式展示暂存清单）→ `git diff --cached` 总结 → 按格式起草提交日志 → **等待我审核** → 我明确同意后才执行 `git commit`。署名为仓库配置的作者（即用户本人）。
- **提交日志格式**：

```
vX.Y.Z 一段简短的总结
- 详细修改点1（只一级，不嵌套）
- 详细修改点2
- 详细修改点n
```

- 提交前安全检查：`.npmrc`、配置类文件不得携带密钥/token；`*.tsbuildinfo`、`dist/`、`node_modules/` 永不入库（已在 .gitignore）。
- `CLAUDE.md` 随仓库版本化（2026-11-09 裁定入库，推翻此前「保持未跟踪」旧规则）。
