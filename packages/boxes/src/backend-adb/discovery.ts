/**
 * adb 设备发现与配对（plan-screen-firstclass P9-3c）：配对/连接的产品化收口——
 * `adb devices -l` 在场清单解析、`adb pair`（配对码——mDNS 服务名 / ip:port 双形态）、
 * `adb connect`（wifi 地址）。全部经 ProcRunner 注入可测（argv 锁死惯例）。
 *
 * 智能恢复优先的依据（P9-3c 立项）：配对关系多数时候仍在——「每次都要重新配对」多为
 * L1 端口漂移 / L2 手机重启后无线调试被系统关闭（配对还在）的体验误判；只有 L3（撤销
 * 授权/ROM 清理）才真需要 pair。发现流程先 connect/mDNS，通则零配对感知。
 */
import type { ProcRunner } from '../procexec/index.js'
import { resolveAdbCommand } from './index.js'

/** 在场设备行（adb devices -l 解析产物） */
export interface AdbDevicePresence {
  /** serial（USB 序列号 / ip:port / mDNS 别名——条目 host 直接用它） */
  serial: string
  /** 状态（device=就绪；offline/unauthorized 如实呈现） */
  state: string
  /** 产品名（-l 的 product: 字段；缺席空串） */
  product: string
  /** 型号（model: 字段——扫描列表显示用；缺席空串） */
  model: string
}

/** `adb devices -l` 输出解析（纯函数——单测锁死；坏行跳过不拖累清单） */
export function parseAdbDevices(stdout: string): AdbDevicePresence[] {
  const out: AdbDevicePresence[] = []
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('List of devices')) continue
    const seg = line.split(/\s+/)
    const serial = seg[0] ?? ''
    const state = seg[1] ?? ''
    if (serial === '' || state === '') continue
    let product = ''
    let model = ''
    for (const kv of seg.slice(2)) {
      const m = /^(product|model):(.*)$/.exec(kv)
      if (m === null) continue
      if (m[1] === 'product') product = m[2] ?? ''
      if (m[1] === 'model') model = m[2] ?? ''
    }
    out.push({ serial, state, product, model })
  }
  return out
}

/**
 * 配对面板二维码内容解析（Android 13+ `WIFI:S:<服务名>;P:<码>;;`——服务名经 adb pair
 * 的 mDNS 解析，码即 6 位配对码）。非该格式返回 null（调用方回退手动表单）。
 */
export function parsePairingQr(text: string): { service: string; code: string } | null {
  const m = /^WIFI:S:([^;]+);P:([^;]+);;$/.exec(text.trim())
  if (m === null) return null
  return { service: m[1] ?? '', code: m[2] ?? '' }
}

export interface AdbDiscoveryOptions {
  /** ProcRunner 注入（缺省 runProcess；测试替身锁 argv） */
  run?: ProcRunner
}

export class AdbDiscovery {
  readonly #run: ProcRunner

  constructor(options: AdbDiscoveryOptions = {}) {
    this.#run = options.run ?? (async (spec) => {
      const { runProcess } = await import('../procexec/index.js')
      return runProcess(spec)
    }) as ProcRunner
  }

  /** 在场设备清单（`adb devices -l`——USB + 已 connect 的 wifi + mDNS 发现） */
  async listDevices(): Promise<AdbDevicePresence[]> {
    const r = await this.#run({ command: [resolveAdbCommand(), 'devices', '-l'], timeoutMs: 15_000 })
    return parseAdbDevices(r.stdout)
  }

  /**
   * 无线配对（`adb pair`）：target 双形态——配对码面板二维码的 mDNS 服务名
   * （`adb-xxx._adb-tls-pairing._tcp`，adb 自行 mDNS 解析）或手动形态 `ip:配对端口`。
   * 成功返回 null；失败返回可呈现原因（解析 stdout/stderr 的结论行）。
   */
  async pair(target: string, code: string): Promise<string | null> {
    const r = await this.#run({
      command: [resolveAdbCommand(), 'pair', target, code],
      timeoutMs: 30_000,
    })
    if (r.exitCode === 0 && /Successfully paired/i.test(r.stdout + r.stderr)) return null
    const lines = (r.stderr.trim() || r.stdout.trim())
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
    return lines.at(-1)?.slice(0, 200) ?? '配对失败'
  }

  /** wifi 连接（`adb connect`——幂等；成功 null / 失败原因） */
  async connect(host: string): Promise<string | null> {
    const r = await this.#run({ command: [resolveAdbCommand(), 'connect', host], timeoutMs: 15_000 })
    if (r.exitCode === 0 && /connected to/i.test(r.stdout)) return null
    const lines = (r.stderr.trim() || r.stdout.trim())
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
    return lines.at(-1)?.slice(0, 200) ?? '连接失败'
  }
}
