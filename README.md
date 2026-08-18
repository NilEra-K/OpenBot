# OpenBot

跑在你自己电脑上的多 agent 社交控制台——重活进本机沙箱（Box），云依赖降到最低（仅保留 LLM API）。

- 产品定位：[PRODUCT.md](PRODUCT.md)
- 架构唯一权威：[ARCHITECTURE.md](ARCHITECTURE.md)
- 视觉母版：prototype.html（渲染层 P2 迁移底稿）
- 协议 / 平台矩阵 / clean-room 声明：docs/

## 状态

P0 骨架（结构就绪，未实现逻辑）。路线图与各阶段验收标准见 ARCHITECTURE.md §11。

## 开发

要求：Node >= 22 + pnpm。

    pnpm install
    pnpm typecheck   # tsc -b 全量构建 + 类型检查
    pnpm test        # vitest（当前为各包骨架占位测试）

## 结构

八个自研包 + 三个壳；依赖规则与三条铁律见 ARCHITECTURE.md §2。

许可证：Apache-2.0（clean-room 自研，声明见 docs/cleanroom.md）。
