/**
 * @openbot/cli —— 无壳冒烟（P1）：mock llm + mock box 跑通 chat → A2A → box exec 全链路。
 * 壳规则（ARCHITECTURE.md §2 铁律 3）：本文件是装配点——装配时 import coordinator 构造内核、
 * import llm 造 mock provider（与 desktop main 将来读配置造真实 provider 同位）；
 * 业务面只走 transport 客户端：命令进、事件出。
 * 确定性：时钟恒 0、id 顺序派生、内存持久化——重复执行输出逐字节一致（P1 验收证据）。
 */
import { assembleKernel } from '@openbot/coordinator'
import type { AssembledKernel } from '@openbot/coordinator'
import { MockChatProvider } from '@openbot/llm'
import type { KernelEvent } from '@openbot/transport'
import { pathToFileURL } from 'node:url'

function printEvent(event: KernelEvent): void {
  console.log(`[事件] #${event.seq} ${event.type} ${JSON.stringify(event.payload)}`)
}

async function waitIdle(kernel: AssembledKernel): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ([...kernel.schedulers.values()].every((s) => s.isIdle)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待调度器空闲超时')
}

export async function main(): Promise<void> {
  console.log('=== OpenBot P1 无壳冒烟：chat → A2A → box exec(mock) ===')

  // ---- 装配（确定性：时钟恒 0，内存持久化）----
  const kernel = assembleKernel({ now: () => 0, systemPrompt: '你是 OpenBot 冒烟 agent' })
  const client = kernel.transport.createClient()
  client.subscribe(printEvent)

  // ---- 名册：a1 管家 + a2 工人，脚本化 mock 模型 ----
  await kernel.addAgent({
    agentId: 'a1',
    name: '管家',
    steward: true,
    llm: new MockChatProvider({
      steps: [
        {
          toolCalls: [
            { id: 'c1', name: 'send_message', args: { toAgentId: 'a2', text: '查一下 /work 目录' } },
          ],
        },
        { text: '已让 a2 去查目录' },
      ],
    }),
  })
  await kernel.addAgent({
    agentId: 'a2',
    name: '工人',
    llm: new MockChatProvider({
      steps: [
        { toolCalls: [{ id: 'c1', name: 'exec', args: { command: ['ls', '/work'] } }] },
        { text: '查完了：/work 目录是空的' },
      ],
    }),
  })

  // ---- 业务面：只经 transport 客户端说话 ----
  console.log('--- 用户消息 → a1（默认收件人 = 管家）---')
  const acceptance = await client.call<{ messageId: string; runId: string; first: boolean }>(
    'v1.message.sendUser',
    { toAgentId: 'a1', text: '帮我查一下 /work 目录', nonce: 'smoke-1' },
  )
  console.log(`受理回执: ${JSON.stringify(acceptance)}`)

  console.log('--- 同 nonce 重试（幂等零双发）---')
  const retry = await client.call<{ messageId: string; runId: string | null; first: boolean }>(
    'v1.message.sendUser',
    { toAgentId: 'a1', text: '帮我查一下 /work 目录', nonce: 'smoke-1' },
  )
  console.log(`重试回执: ${JSON.stringify(retry)}`)

  await waitIdle(kernel)

  console.log('--- 双侧 transcript ---')
  for (const agentId of ['a1', 'a2']) {
    const records = await client.call<{ seq: number; kind: string; payload: unknown }[]>(
      'v1.transcript.read',
      { agentId },
    )
    for (const record of records) {
      console.log(`[transcript ${agentId}] #${record.seq} ${record.kind} ${JSON.stringify(record.payload)}`)
    }
  }

  console.log('--- Box 清单 ---')
  const boxes = await client.call<{ boxId: string; state: string; spec: { image: string } }[]>(
    'v1.boxes.list',
  )
  for (const box of boxes) {
    console.log(`[box] ${box.boxId} ${box.state} image=${box.spec.image}`)
  }

  console.log('--- 名册 ---')
  const roster = await client.call<{ agentId: string; role: string }[]>('v1.system.listAgents')
  for (const agent of roster) {
    console.log(`[agent] ${agent.agentId} role=${agent.role}`)
  }

  console.log('=== 冒烟通过（全链路确定性执行）===')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err: unknown) => {
    console.error('冒烟失败:', err)
    process.exitCode = 1
  })
}
