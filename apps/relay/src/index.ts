/**
 * relay host 入口（P7 Step 2/3）：node 进程自托管——`pnpm start`（systemd/进程守护见
 * docs/relay-protocol.md；Docker 形态见 Dockerfile）。
 * env：
 * - OPENBOT_RELAY_PORT：显式端口（**被占用即报错退出**——遵守端口规则：不自动改用、不杀占用进程）；
 *   缺省随机端口（启动日志打印实际端口）
 * - OPENBOT_RELAY_CREATE_TOKEN：设置后建房须带 x-create-token（公网防刷房；Tailscale/内网可省）
 * - OPENBOT_RELAY_BUDGET_TURNS / OPENBOT_RELAY_BUDGET_WINDOW_MIN：预算覆盖（自托管调参）
 */
import { createRelayServer } from './server.js'

const port = process.env.OPENBOT_RELAY_PORT
const turns = Number(process.env.OPENBOT_RELAY_BUDGET_TURNS)
const windowMin = Number(process.env.OPENBOT_RELAY_BUDGET_WINDOW_MIN)

const handle = await createRelayServer({
  ...(port !== undefined && Number.isFinite(Number(port)) ? { port: Number(port) } : {}),
  ...(process.env.OPENBOT_RELAY_CREATE_TOKEN !== undefined
    ? { createToken: process.env.OPENBOT_RELAY_CREATE_TOKEN }
    : {}),
  ...(Number.isFinite(turns) && Number.isFinite(windowMin)
    ? { budget: { maxTurns: turns, windowMs: windowMin * 60_000 } }
    : {}),
})

console.log(`[openbot-relay] 就绪：端口 ${handle.port}（健康检查 GET /api/health；建房 POST /api/rooms）`)
console.log('[openbot-relay] 本地优先纪律：自托管软件——Tailscale/自组网内自建优先，公网暴露请自配 TLS 反代（docs/relay-protocol.md）')
