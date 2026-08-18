/**
 * Electron 主进程 —— 壳预览（P1.5）：真窗口 + 托盘常驻 + 关窗驻留，加载视觉母版 prototype.html。
 * P2 起加载 renderer（Vue 五视图）并装配 coordinator（in-process Carrier）+ transport 环回网关
 * （ARCHITECTURE.md §1、§4）。壳规则（§2 铁律 3）：本文件是装配点，业务面只走 transport——
 * 当前尚无内核，纯壳。
 */
import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)) // apps/desktop/dist/main
const APP_ROOT = join(HERE, '..', '..') // apps/desktop
const REPO_ROOT = join(APP_ROOT, '..', '..') // 仓库根
const PROTOTYPE = join(REPO_ROOT, 'prototype.html')
const PRELOAD = join(APP_ROOT, 'dist', 'preload', 'index.cjs') // sandbox 下 preload 必须是 CJS（.cts 编译产物）
const ICON = join(APP_ROOT, 'resources', 'icon.png')

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

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
  // 右键菜单：报障定位用（检查元素直接跳到 DOM 对应节点）
  win.webContents.on('context-menu', (_e, params) => {
    Menu.buildFromTemplate([
      { label: '检查元素', click: () => { win?.webContents.inspectElement(params.x, params.y) } },
      { type: 'separator' },
      { label: '重新加载', click: () => { win?.webContents.reload() } },
      { label: '开发者工具', click: toggleDevTools },
    ]).popup()
  })
  void win.loadFile(PROTOTYPE)
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(ICON))
  tray.setToolTip('OpenBot —— 本地多 agent 控制台（壳预览）')
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

const locked = app.requestSingleInstanceLock()
if (!locked) {
  app.quit()
} else {
  app.on('second-instance', () => { win?.show(); win?.focus() })
  void app.whenReady().then(() => {
    createWindow()
    createTray()
  })
}
