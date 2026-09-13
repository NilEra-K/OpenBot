/**
 * 工具 argsSchema 全覆盖测试（v0.1.14，与 v0.1.8 computer_* 同族修法）：
 * exec 等裸描述工具补 schema 后——参数结构进 wire（弱模型不再从描述猜 argv 形状）、
 * 错参反馈自纠化（回显收到的东西 + 正确示例 + sh -c 指路——模型一轮自纠不再烧工具轮预算）。
 * 背景：模型把自然语言当 command 传 → 反复错 → 撞穿 8 轮预算 → watchdog zombie 逃逸（用户实测报障）。
 */
import { describe, expect, it } from 'vitest'
import { computerTools, execTool, fsReadTool, fsWriteTool, ToolRegistry } from '../src/tools/index.js'
import type { BoxToolDeps, ToolContext } from '../src/tools/index.js'

const ctx = (boxId = 'box-1'): ToolContext => ({
  agentId: 'a1',
  runId: 'r1',
  originMessageId: 'm1',
  toolCallId: 'c1',
  boxId,
  signal: new AbortController().signal,
})

/** 替身后端：exec 留痕；其余最小面 */
const deps = (): BoxToolDeps => ({
  backend: {
    exec: async (_box, spec) => ({ exitCode: 0, stdout: `mock: ${spec.command.join(' ')}`, stderr: '' }),
    fsRead: async () => null,
    fsWrite: async () => {},
  } as unknown as BoxToolDeps['backend'],
  bus: { emit: () => {} } as never,
})

describe('工具 argsSchema 全覆盖（wire 参数结构）', () => {
  it('全部注册工具都带 argsSchema（弱模型面前不留裸描述工具）', () => {
    const registry = new ToolRegistry()
      .register(execTool(deps()))
      .register(fsWriteTool(deps()))
      .register(fsReadTool(deps()))
    for (const spec of registry.specs()) {
      const s = spec.argsSchema as { type?: string; properties?: Record<string, unknown>; required?: string[] } | undefined
      expect(s?.type, `${spec.name} 缺 argsSchema`).toBe('object')
      expect(s?.properties, `${spec.name} 缺 properties`).toBeTruthy()
    }
  })

  it('exec schema：command 是 string 数组 + 语义描述含 sh -c 指路', () => {
    const { spec } = execTool(deps())
    const cmd = (spec.argsSchema as { properties: { command: { type: string; items: { type: string }; description: string } } }).properties.command
    expect(cmd.type).toBe('array')
    expect(cmd.items.type).toBe('string')
    expect(cmd.description).toContain('sh')
    expect(cmd.description).toContain('不收自然语言')
  })

  it('wire 断言：specs() 导出的 argsSchema 形状即 provider 映射的 parameters/input_schema', () => {
    const { spec } = execTool(deps())
    const s = spec.argsSchema as { required: string[]; additionalProperties: boolean }
    expect(s.required).toEqual(['command'])
    expect(s.additionalProperties).toBe(false)
  })

  it('工具选择指引（2026-09-05）：exec 与 computer_screenshot 描述互指——命令行优先 + 登录引导接管', () => {
    const exec = execTool(deps()).spec.description
    expect(exec).toContain('优先用本工具')
    expect(exec).toContain('computer_*')
    const tools = computerTools({ backend: null as never, bus: null as never, screen: null as never })
    const shot = tools.find((t) => t.spec.name === 'computer_screenshot')!.spec.description
    expect(shot).toContain('优先用 exec')
    expect(shot).toContain('登录/认证')
    expect(shot).toContain('接管')
  })
})

describe('exec 错参反馈自纠化', () => {
  it('自然语言当 command：错误回显收到的东西 + 正确示例 + sh -c 指路（模型一轮自纠的依据）', async () => {
    const registry = new ToolRegistry().register(execTool(deps()))
    const feedback = (await registry.execute(ctx(), {
      id: 'c1',
      name: 'exec',
      args: { command: '用命令行方式打开新终端' },
    })) as string
    expect(feedback).toContain('TOOL_ARGS_INVALID')
    expect(feedback).toContain('用命令行方式打开新终端') // 回显收到的东西
    expect(feedback).toContain('["ls","-la","/work"]') // 正确示例
    expect(feedback).toContain('"sh","-c"') // sh -c 兜底指路
  })

  it('字符串数组之外的形状（null/缺参/混合类型）：同款自纠反馈', async () => {
    const registry = new ToolRegistry().register(execTool(deps()))
    for (const bad of [null, {}, { command: [] }, { command: ['ls', 42] }]) {
      const feedback = (await registry.execute(ctx(), { id: 'c1', name: 'exec', args: bad })) as string
      expect(feedback, JSON.stringify(bad)).toContain('TOOL_ARGS_INVALID')
      expect(feedback, JSON.stringify(bad)).toContain('收到：')
    }
  })

  it('合法 argv 照常执行（schema 不拦正确用法）', async () => {
    const registry = new ToolRegistry().register(execTool(deps()))
    const r = (await registry.execute(ctx(), { id: 'c1', name: 'exec', args: { command: ['ls', '-la', '/work'] } })) as string
    expect(r).toContain('exit=0')
    expect(r).toContain('mock: ls -la /work')
  })
})
