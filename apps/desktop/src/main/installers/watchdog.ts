/**
 * 沙箱引擎看门狗（v0.1.90）：选定后端是 docker/podman 时周期探测引擎态，跃迁（运行→停止 /
 * 停止→恢复）上抛事件——多 agent 长任务中引擎外部掉线用户无感知的报障面。仅跃迁触发（不刷屏）；
 * boot 基线 = 装配期探测事实（选定即说明当时可用）。探测异常（unknown）不触发跃迁——通道故障
 * ≠ 引擎掉线，不误报（下轮再试）。全依赖注入可测（探测走 launcher.engineReadyOf 同判据）。
 */
import type { ProcRunner } from '@openbot/boxes'
import { engineReadyOf } from './launcher.js'

/** 看门狗缺省节奏：60s 一探（引擎掉线感知延迟 ≤1 分钟——通知面足够，spawn 开销可忽略） */
export const ENGINE_WATCHDOG_INTERVAL_MS = 60_000

export interface EngineWatchdogHandle {
  stop(): void
}

export function createEngineWatchdog(opts: {
  engine: 'docker' | 'podman'
  run: ProcRunner
  exists: (p: string) => boolean
  /** 跃迁回调（running = 跃迁后的新态） */
  onTransition: (running: boolean) => void
  intervalMs?: number
  /** 起始基线（缺省 true——选定后端在装配期已可用） */
  initialRunning?: boolean
}): EngineWatchdogHandle {
  const intervalMs = opts.intervalMs ?? ENGINE_WATCHDOG_INTERVAL_MS
  const check = opts.engine === 'docker' ? 'docker-info' : 'podman-machine'
  let lastRunning = opts.initialRunning ?? true
  let stopped = false
  const tick = (): void => {
    if (stopped) return
    void (async () => {
      const state = await engineReadyOf(opts.run, check, opts.exists)
      if (stopped || state === 'unknown') return // 通道异常不误报跃迁
      const running = state === 'ready'
      if (running !== lastRunning) {
        lastRunning = running
        opts.onTransition(running)
      }
    })().catch(() => {}) // engineReadyOf 已内收异常——兜底不炸定时器
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.() // 不阻止进程退出（Electron 常驻下无感，测试/优雅退出不被拖住）
  return {
    stop(): void {
      stopped = true
      clearInterval(timer)
    },
  }
}
