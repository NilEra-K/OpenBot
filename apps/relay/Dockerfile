# OpenBot relay host 镜像（P7 裁定 A：node 进程 + Dockerfile 双形态）
# 多阶段：workspace 全量构建 → esbuild 单文件 bundle（ws/hono/zod 全内联——镜像不带 node_modules）
# 构建：docker build -f apps/relay/Dockerfile -t openbot-relay .
# 运行：docker run -p 8080:8080 -e OPENBOT_RELAY_PORT=8080 openbot-relay
#   （自托管建议跑在 Tailscale/自组网内——公网暴露请自配 TLS 反代，见 docs/relay-protocol.md）
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @openbot/relay run bundle

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/apps/relay/dist/index.js ./index.js
COPY --from=build /app/apps/relay/dist/index.js.map ./index.js.map
ENV NODE_ENV=production
# 缺省显式端口（容器形态约定；被占即报错退出——端口规则不自动改）
ENV OPENBOT_RELAY_PORT=8080
EXPOSE 8080
USER node
CMD ["node", "index.js"]
