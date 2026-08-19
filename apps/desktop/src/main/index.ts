/**
 * Electron 主进程 —— 桌面壳（P2）：真内核装配（kernel.ts）+ 托盘常驻 + 关窗驻留。
 * 加载 renderer（Vue 五视图，Step 7 起）；renderer 业务面只经环回网关（HTTP/SSE/WS），
 * 本文件是装配点（ARCHITECTURE.md §2 铁律 3 的装配例外）。
 */
import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DesktopKernel } from './kernel.js'

// 启动诊断（报障定位）：入口加载即打点；未捕获异常打到 stderr（Electron 默认不崩给用户看）
console.log('[openbot] main 入口加载')
process.on('uncaughtException', (err) => {
  console.error('[openbot] uncaughtException:', err)
})

const HERE = dirname(fileURLToPath(import.meta.url)) // apps/desktop/dist/main
const APP_ROOT = join(HERE, '..', '..') // apps/desktop
const REPO_ROOT = join(APP_ROOT, '..', '..') // 仓库根
const PROTOTYPE = join(REPO_ROOT, 'prototype.html') // Step 7 起替换为 renderer 产物
const PRELOAD = join(APP_ROOT, 'dist', 'preload', 'index.cjs') // sandbox 下 preload 必须是 CJS（.cts 编译产物）
const ICON = join(APP_ROOT, 'resources', 'icon.png')
console.log('[openbot] 路径就绪：APP_ROOT =', APP_ROOT, '；PRELOAD 存在性待装配时验证')

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let desktop: DesktopKernel | null = null

// 开发者工具：F12 / Ctrl+Shift+I / 托盘菜单 / 右键菜单（菜单栏已隐藏，入口自己接）
const toggleDevTools = (): void => {
  if (!win) return
  if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools()
  else win.webContents.openDevTools({ mode: 'detach' })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1380,
    height: 760,
    minWidth: 1080,
    minHeight: 640,
    backgroundColor: '#17181c',
    autoHideMenuBar: true,
    title: 'OpenBot',
    frame: false, // 去掉原生标题栏——原型的 titlebar 即唯一 chrome（窗口控制经 preload 桥回真实操作）
    webPreferences: { sandbox: true, contextIsolation: true, preload: PRELOAD },
  })
  // 产品形态：托盘常驻——关窗只是驻留，退出走托盘菜单
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) toggleDevTools()
  })
  // renderer 日志合并到主进程输出（桌面冒烟/报障定位——console-message 只在 verbose 级别以下也可用）
  win.webContents.on('console-message', (_e, _level, message) => {
    if (message.trim() !== '') console.log(`[renderer] ${message}`)
  })
  // 右键菜单：报障定位用（检查元素直接跳到 DOM 对应节点）
  win.webContents.on('context-menu', (_e, params) => {
    Menu.buildFromTemplate([
      { label: '检查元素', click: () => { win?.webContents.inspectElement(params.x, params.y) } },
      { type: 'separator' },
      { label: '重新加载', click: () => { win?.webContents.reload() } },
      { label: '开发者工具', click: toggleDevTools },
    ]).popup()
  })
  loadRenderer(win)
}

/** 加载 renderer 产物：dev 注入 OPENBOT_RENDERER_URL 走 dev server（HMR），否则文件协议加载构建产物 */
function loadRenderer(target: BrowserWindow): void {
  const devUrl = process.env.OPENBOT_RENDERER_URL
  if (devUrl) {
    void target.loadURL(devUrl)
    return
  }
  const built = join(APP_ROOT, 'dist', 'renderer', 'index.html')
  void target.loadFile(built).catch(() => {
    // 首次未构建 renderer 时回退视觉母版（pnpm build:renderer 后消失）
    console.warn(`[openbot] renderer 产物不存在（${built}），回退 prototype.html——先跑 pnpm build:renderer`)
    void target.loadFile(PROTOTYPE)
  })
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(ICON))
  tray.setToolTip('OpenBot —— 本地多 agent 控制台')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 OpenBot', click: () => { win?.show(); win?.focus() } },
      { label: '开发者工具', click: toggleDevTools },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit() } },
    ]),
  )
  tray.on('double-click', () => { win?.show(); win?.focus() })
}

// frameless 窗口控制（renderer 经 preload 桥转发；close 复用「驻留托盘」语义）
ipcMain.on('openbot:win', (_e, op: string) => {
  if (!win) return
  if (op === 'minimize') win.minimize()
  else if (op === 'toggleMaximize') win.isMaximized() ? win.unmaximize() : win.maximize()
  else if (op === 'close') win.close()
})

// 网关接入点：renderer 经 preload 异步拉取（port/token 只活在内存链路，不落盘）
ipcMain.handle('openbot:gateway', () =>
  desktop ? { port: desktop.gateway.port, token: desktop.gateway.token } : null,
)

const locked = app.requestSingleInstanceLock()
if (!locked) {
  app.quit()
} else {
  app.on('second-instance', () => { win?.show(); win?.focus() })
  void app.whenReady().then(async () => {
    try {
      console.log('[openbot] whenReady：动态加载内核装配模块')
      const { assembleDesktop } = await import('./kernel.js')
      desktop = await assembleDesktop()
    } catch (err) {
      console.error('[openbot] 内核装配失败：', err)
      dialog.showErrorBox('OpenBot 内核装配失败', err instanceof Error ? err.stack ?? err.message : String(err))
      app.quit()
      return
    }
    createWindow()
    createTray()
  })
  app.on('will-quit', () => {
    void desktop?.dispose()
  })
}
