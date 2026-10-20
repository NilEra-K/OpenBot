/**
 * MCP client（stdio）：插件进程的 JSON-RPC 2.0 通信层（docs/plan-plugins.md §2/§4）。
 * 只实现 OpenBot 用到的最小面：initialize 握手 → tools/list / tools/call，
 * 并接收服务端上行 notification（`openbot/event`——插件事件源的推模型通道）。
 * 协议为开放规范（Model Context Protocol）——净室：零参考实现代码，按 wire 形状自写。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'

export const MCP_PROTOCOL_VERSION = '2025-06-18'

/** MCP 工具描述（tools/list 返回项——OpenBot 只取用到的字段） */
export interface McpToolSpec {
  name: string
  description?: string
  inputSchema?: unknown
}

/** 上行事件（插件 → 内核）：notification `openbot/event` 的 params */
export interface McpPluginEvent {
  type: string
  payload?: unknown
}

export interface McpClientOptions {
  command: string
  args?: string[]
  cwd?: string
  /** 事件回调（openbot/event 上行） */
  onEvent?: (event: McpPluginEvent) => void
  /** 进程意外退出回调（主动 stop 不触发） */
  onExit?: (code: number | null) => void
  /** stderr 留痕（诊断） */
  onStderr?: (line: string) => void
  /** 单请求超时 ms（tools/call 挂起等待合法——长工具取宽；缺省 120s） */
  requestTimeoutMs?: number
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/** JSON-RPC 分帧：按行解析（MCP stdio 传输是 LSP 式换行分隔的 JSON） */
export class McpClient extends EventEmitter {
  readonly #options: McpClientOptions
  #proc: ChildProcessWithoutNullStreams | null = null
  #nextId = 1
  readonly #pending = new Map<number, PendingRequest>()
  #buffer = ''
  #stopped = false
  #exited = false

  constructor(options: McpClientOptions) {
    super()
    this.#options = options
  }

  get running(): boolean {
    return this.#proc !== null && !this.#exited
  }

  /** 拉起进程 + initialize 握手（调用前进程不得在场） */
  async start(): Promise<void> {
    if (this.#proc !== null) throw new Error('MCP client 已启动')
    this.#stopped = false
    this.#exited = false
    // 'node' 命令解析（两坑，2026-10-20 E2E 实锤）：
    // ① Windows spawn 无 shell 不解析 PATH 垫片（node → node.exe）——用当前解释器全路径；
    // ② Electron 主进程里 execPath 是 electron.exe——直接 spawn 会拉起新 Electron 实例
    //    （被单实例锁吃掉，stdio 无人应答）——须 ELECTRON_RUN_AS_NODE=1 令其以纯 node 行为执行
    //    （单测在 vitest 真 node 下不触发，E2E/真机才暴露）
    const isNode = this.#options.command === 'node'
    const command = isNode ? process.execPath : this.#options.command
    const proc = spawn(command, this.#options.args ?? [], {
      cwd: this.#options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(isNode ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } : {}),
    }) as ChildProcessWithoutNullStreams
    this.#proc = proc
    proc.stdout.setEncoding('utf-8')
    proc.stdout.on('data', (chunk: string) => this.#feed(chunk))
    proc.stderr.setEncoding('utf-8')
    proc.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const t = line.trim()
        if (t !== '') this.#options.onStderr?.(t)
      }
    })
    // spawn 同步失败（ENOENT：命令/cwd 不存在）走 error 事件而非 exit——不监听会静默挂死
    proc.on('error', (err) => {
      this.#exited = true
      for (const [, p] of this.#pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`插件进程启动失败：${err.message}`))
      }
      this.#pending.clear()
      if (!this.#stopped) this.#options.onExit?.(null)
    })
    proc.on('exit', (code) => {
      this.#exited = true
      // 挂起请求如实失败
      for (const [, p] of this.#pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`插件进程退出（code ${code}）`))
      }
      this.#pending.clear()
      if (!this.#stopped) this.#options.onExit?.(code)
    })
    // MCP 握手：initialize → initialized notification
    const result = (await this.#request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'openbot', version: '0.1.0' },
    })) as { protocolVersion?: string; serverInfo?: { name?: string } }
    this.#notify('notifications/initialized', {})
    void result
  }

  async stop(): Promise<void> {
    this.#stopped = true
    const proc = this.#proc
    if (proc === null) return
    this.#proc = null
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        proc.kill('SIGKILL')
      }, 3000)
      proc.once('exit', () => {
        clearTimeout(killTimer)
        resolve()
      })
      proc.kill()
    })
  }

  async listTools(): Promise<McpToolSpec[]> {
    const result = (await this.#request('tools/list', {})) as { tools?: McpToolSpec[] }
    return result.tools ?? []
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<string> {
    const result = (await this.#request('tools/call', { name, arguments: args ?? {} }, signal)) as {
      content?: Array<{ type: string; text?: string }>
      isError?: boolean
    }
    const text = (result.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
    if (result.isError === true) throw new Error(text !== '' ? text : `插件工具 ${name} 执行失败`)
    return text
  }

  /** stdout 分帧：按行切 JSON——请求响应与上行 notification 同线 */
  #feed(chunk: string): void {
    this.#buffer += chunk
    let nl = this.#buffer.indexOf('\n')
    while (nl >= 0) {
      const line = this.#buffer.slice(0, nl).replace(/\r$/, '').trim()
      this.#buffer = this.#buffer.slice(nl + 1)
      nl = this.#buffer.indexOf('\n')
      if (line === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        this.#options.onStderr?.(`非 JSON 行：${line.slice(0, 120)}`)
        continue
      }
      const msg = parsed as { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown }
      if (typeof msg.id === 'number' && this.#pending.has(msg.id)) {
        // 响应
        const p = this.#pending.get(msg.id)!
        this.#pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error !== undefined) p.reject(new Error(msg.error.message ?? '插件请求失败'))
        else p.resolve(msg.result)
        continue
      }
      if (msg.method === 'openbot/event' && typeof msg.params === 'object' && msg.params !== null) {
        const ev = msg.params as McpPluginEvent
        if (typeof ev.type === 'string' && ev.type !== '') this.#options.onEvent?.(ev)
      }
      // 其余 notification（日志等）忽略
    }
  }

  #request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const proc = this.#proc
    if (proc === null || this.#exited) return Promise.reject(new Error('插件进程未运行'))
    const id = this.#nextId++
    const timeoutMs = this.#options.requestTimeoutMs ?? 120_000
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`插件请求超时（${timeoutMs}ms）：${method}`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      const abort = (): void => {
        // 取消语义：JSON-RPC 标准取消通知 + 本端立即拒绝（进程侧响应到达时已无 pending）
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(new Error('PLUGIN_ABORTED'))
        this.#send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } })
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.#send({ jsonrpc: '2.0', id, method, params })
    })
  }

  #notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: '2.0', method, params })
  }

  #send(msg: unknown): void {
    const proc = this.#proc
    if (proc === null) return
    proc.stdin.write(`${JSON.stringify(msg)}\n`)
  }
}
