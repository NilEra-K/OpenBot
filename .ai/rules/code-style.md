# OpenBot 代码风格规范

## 通用原则

- **TypeScript strict 全栈**：不关闭 strict 开关；`any` 需要理由，优先精确类型 / `unknown` + 收窄。
- 以现有代码风格为准：2 空格缩进、单引号、分号、行宽 ~110（现有文件即基准，新文件向它看齐）。
- 注释与文档使用中文；每个包入口文件保留一句话职责注释，装配点（coordinator、壳 main）保留装配说明注释——现有文件的头部注释风格是模板。
- 命名：变量/函数 `camelCase`，类型/类 `PascalCase`，常量 `UPPER_SNAKE_CASE`，文件与目录 `kebab-case`；事件族前缀小写 `v1.xxx`。

## 目录与模块

- 包内模块结构统一：`src/<module>/index.ts`（如 `packages/core/src/sched/index.ts`），`src/index.ts` 只做 re-export。
- 包的对外表面只经 `exports` 暴露的入口；**禁止深路径 import**（如 `@openbot/core/lib/sched/internal`）。
- 严禁幽灵依赖：只能 import 自己 `package.json` 声明过的依赖（pnpm 严格隔离会直接报错——这是保护，不是障碍）。
- 跨包调用走依赖图（见 project-architecture.md）：向上 import = 构建失败。

## 协议与错误

- 内核代码里**不出现 UI 字符串**；错误与状态传稳定 code（`UPPER_SNAKE_CASE`，如 `BOX_SNAPSHOT_UNSUPPORTED`），文案与多语言归渲染层。
- 事件与命令带版本前缀（`v1.`）；新增字段必须向后兼容（可选或带默认），破坏性变更走 v2 前缀。
- 边界层（transport、boxes 子进程调用、llm fetch）统一捕获并转为带 code 的错误对象；内部用 `Error` 子类，不裸抛字符串。

## 异步与副作用

- 内核包（core/state/messaging 逻辑路径）不读系统时钟、不碰网络与文件系统之外的随机性——时间与随机由参数显式传入（可测试性根基）。
- Promise 必须有归宿（await / .catch / 上抛），禁止 fire-and-forget 无错误处理（A2A 显式 fire-and-forget 语义除外，须注释）。
- 子进程（wsl.exe / docker）调用必须带超时与 UTF-16LE 解码处理（wsl），见 docs/platforms.md。

## 测试

- Vitest；每包 `test/` 目录，内核测试**零 DOM、零 Electron**。
- 新后端/新 provider 必须配 mock 且接口对称（caps 完全一致）——mock 对称是 CI 确定性的前提。
- 涉及持久化格式的改动：跑 `pnpm test` 全量，并说明对既有数据文件的兼容策略。
- 命令速记：`pnpm build` / `pnpm typecheck` / `pnpm test`——三者全绿才算完成。

## 壳（apps/desktop）专项

- main 进程是装配点：业务面只经 transport，不绕过网关直连内核。
- **sandbox preload 必须是 CommonJS**：源文件用 `.cts`（编译出 `.cjs`），ESM preload 会被 sandbox 静默拒绝。
- renderer 无特权：sandbox + contextIsolation，不碰 Node；经 `contextBridge` 暴露的最小表面说话。
- 窗口最小宽（1080）与页面 `body min-width` 必须一致（右栏裁切事故的教训，见 docs/platforms.md）。

## 渲染层（P2 启用）

- Vue 3 `<script setup lang="ts">` + Composition API；样式默认 `scoped`。
- 组件不直接发 fetch：统一走内存版 transport 客户端（可被 mock 网关替换）。
- UI/逻辑边界硬规则见 [ui-logic-separation.md](ui-logic-separation.md)。
