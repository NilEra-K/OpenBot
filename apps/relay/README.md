# @openbot/relay

跨用户房间公网 host（P7 已实现）：Hono 控制面（建房/健康）+ ws 数据面（mirror fanout /
turn 路由）；预算与幂等的单一事实源。**自托管软件——官方不运营服务**，本地优先与部署
指南见 [docs/relay-protocol.md](../../docs/relay-protocol.md)（§0 先读）。

- `pnpm start`：node 进程（tsc 产物 `dist/`；env 约定见协议文档 §6）
- `pnpm dist`：esbuild 单文件 bundle（Docker 镜像用；同命令本地亦可跑）
- 单测：`apps/relay/test/relay.test.ts`（真 server 随机端口全链——房间隔离/fanout/
  turn 路由/幂等/预算/伪造面）
