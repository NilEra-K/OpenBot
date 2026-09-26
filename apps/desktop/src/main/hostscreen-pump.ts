/**
 * L2 零依赖帧泵（plan-screen-firstclass P9-2 裁定 D）：隐藏 BrowserWindow 内
 * getUserMedia 桌面采集（Chromium WGC 底层）→ canvas 逐帧 JPEG → IPC 字节泵回主进程——
 * 不依赖 ffmpeg 的 ~30fps 实况源（编码复用既有 mjpeg 拆帧/解码管线，零新 wire codec）。
 *
 * 安全面：隐藏窗口只加载本仓 resources/hs-pump.html（内联脚本 + 极简专用 preload），
 * 不接主 renderer 桥；帧监听按 event.sender 过滤——只有本窗口的帧进得了消费方。
 * 生命周期：stop() 停采集 + 销毁窗口 + 摘监听（三重清场——孤儿纪律）；
 * backgroundThrottling 关闭（隐藏态 rAF/interval 不降速——帧率是本档位的全部意义）。
 */
import { BrowserWindow, desktopCapturer, ipcMain } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HostScreenFrame } from '@openbot/boxes'

const HERE = dirname(fileURLToPath(import.meta.url)) // apps/desktop/dist/main
const APP_ROOT = join(HERE, '..', '..') // apps/desktop
const PUMP_PAGE = join(APP_ROOT, 'resources', 'hs-pump.html')
const PUMP_PRELOAD = join(APP_ROOT, 'resources', 'hs-pump.cjs')

export interface HostScreenFramePumpHandle {
  stop(): void
}

export interface HostScreenFramePumpOptions {
  maxWidth?: number
  onFrame: (f: HostScreenFrame) => void
}

let seq = 0

export async function startHostScreenFramePump(options: HostScreenFramePumpOptions): Promise<HostScreenFramePumpHandle> {
  const maxWidth = options.maxWidth ?? 1600
  seq += 1
  const win = new BrowserWindow({
    show: false,
    width: 2,
    height: 2,
    skipTaskbar: true,
    webPreferences: {
      preload: PUMP_PRELOAD,
      contextIsolation: false, // 页面内联脚本直接用 window.__hsPump（本仓自加载页面——无外来内容）
      sandbox: false, // 极简 preload 需要 require('electron')
      nodeIntegration: false,
      backgroundThrottling: false, // 隐藏态不降速——帧率是 L2 的存在意义
    },
  })
  let stopped = false
  // 固定频道 + event.sender 过滤（每个泵窗口只认自己的帧——多实例不串线）
  const isOwnSender = (event: unknown): boolean => {
    const sender = (event as { sender?: unknown }).sender
    return sender === win.webContents
  }
  const cleanup = (): void => {
    stopped = true
    ipcMain.removeListener('hs-frame-pump', onFrame)
    ipcMain.removeListener('hs-frame-pump-err', onError)
    if (!win.isDestroyed()) win.destroy()
  }
  let onFirst: (() => void) | null = null
  let fail: ((err: Error) => void) | null = null
  const firstFrame = new Promise<void>((resolve, reject) => {
    onFirst = resolve
    fail = reject
  })
  function onFrame(event: unknown, payload: { bytes: Uint8Array; width: number; height: number }): void {
    if (!isOwnSender(event)) return
    options.onFrame({ bytes: payload.bytes, width: payload.width, height: payload.height })
    onFirst?.()
    onFirst = null
    fail = null
  }
  function onError(event: unknown, msg: string): void {
    if (!isOwnSender(event)) return
    fail?.(new Error(msg))
    fail = null
  }
  ipcMain.on('hs-frame-pump', onFrame)
  ipcMain.on('hs-frame-pump-err', onError)
  try {
    await win.loadFile(PUMP_PAGE)
    // 主进程取 source id（desktopCapturer API 收口主进程——页面只管 getUserMedia/编码）
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
    const sourceId = sources[0]?.id
    if (sourceId === undefined) {
      throw new Error('无可用屏幕采集源')
    }
    await win.webContents.executeJavaScript(`window.__hsStart(${JSON.stringify({ sourceId, maxWidth })})`, false)
    // 首帧才算就绪（getUserMedia 失败/权限拒绝走 onError → reject——调用方 L2→L0 如实降级）
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('帧泵 10s 未出首帧')), 10_000)
    })
    await Promise.race([firstFrame, timeout])
    return {
      stop: () => {
        if (stopped) return
        if (!win.isDestroyed()) {
          void win.webContents.executeJavaScript('window.__hsStop()').catch(() => {})
        }
        cleanup()
      },
    }
  } catch (err) {
    cleanup()
    throw err
  }
}
