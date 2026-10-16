/**
 * Electron 主进程 —— 桌面壳（P2）：真内核装配（kernel.ts）+ 托盘常驻 + 关窗驻留。
 * 加载 renderer（Vue 五视图，Step 7 起）；renderer 业务面只经环回网关（HTTP/SSE/WS），
 * 本文件是装配点（ARCHITECTURE.md §2 铁律 3 的装配例外）。
 */
import { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import { dirname, join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { DesktopKernel } from './kernel.js'

// 启动诊断（报障定位）：入口加载即打点；未捕获异常打到 stderr（Electron 默认不崩给用户看）
console.log('[openbot] main 入口加载')
process.on('uncaughtException', (err) => {
  console.error('[openbot] uncaughtException:', err)
})

// 装配配置（E2E 用）：隔离 userData 到临时目录——测试数据绝不写进用户真实数据区
const e2eUserData = process.env.OPENBOT_USER_DATA
if (e2eUserData) {
  app.setPath('userData', e2eUserData)
  console.log('[openbot] E2E userData 隔离：', e2eUserData)
}

const HERE = dirname(fileURLToPath(import.meta.url)) // apps/desktop/dist/main
const APP_ROOT = join(HERE, '..', '..') // apps/desktop
const REPO_ROOT = join(APP_ROOT, '..', '..') // 仓库根
const PROTOTYPE = join(REPO_ROOT, 'prototype.html') // Step 7 起替换为 renderer 产物
const PRELOAD = join(APP_ROOT, 'dist', 'preload', 'index.cjs') // sandbox 下 preload 必须是 CJS（.cts 编译产物）
const ICON = join(APP_ROOT, 'resources', 'icons', 'icon.png') // 图标集中维护（resources/icons/——src/ 为源套图，ico 由 scripts/make-ico.mjs 生成）
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
    icon: ICON, // 开发态任务栏/窗口图标（2026-10-14 接线；打包产物走 exe 资源——electron-builder icon）
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
  // 最大化状态广播（renderer 三键图标随状态切换：最大化/还原）
  win.on('maximize', () => win?.webContents.send('openbot:win-maximized', true))
  win.on('unmaximize', () => win?.webContents.send('openbot:win-maximized', false))
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) toggleDevTools()
  })
  // renderer 日志合并到主进程输出（桌面冒烟/报障定位——console-message 只在 verbose 级别以下也可用）
  win.webContents.on('console-message', (_e, _level, message) => {
    if (message.trim() !== '') console.log(`[renderer] ${message}`)
  })
  // 右键菜单（2026-10-16 用户裁定微信式紧凑）：转发 renderer 自绘（原生 Menu 上下留白无 API
  // 可调）——params.x/y 本就是页面坐标（view 坐标；旧版「检查元素」直接喂 inspectElement 定位
  // 精准可为佐证），直接透传；2026-10-16 修复：曾误当屏幕坐标减 contentBounds，致菜单整体
  // 偏左上、偏移量恒等于窗口屏幕位置（用户报障两现象的根因）
  win.webContents.on('context-menu', (_e, params) => {
    const w = win
    if (w === null) return
    w.webContents.send('openbot:context-menu', {
      x: params.x,
      y: params.y,
      isEditable: params.isEditable,
      canUndo: params.editFlags.canUndo,
      canCut: params.editFlags.canCut,
      canCopy: params.editFlags.canCopy,
      canPaste: params.editFlags.canPaste,
      canSelectAll: params.editFlags.canSelectAll,
      selectionText: params.selectionText,
      linkURL: params.linkURL,
    })
  })
  // 外链防御（P4 Step 11）：renderer 内 http(s) 链接一律转系统浏览器打开，永不嵌新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
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
  tray.setToolTip('OpenBot')
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

// 右键菜单动作分发（renderer 自绘菜单经 preload 回传；编辑动作施于 webContents 焦点元素——
// 菜单 DOM mousedown.prevent 保证焦点未被菜单抢走）
ipcMain.on('openbot:menu-action', (_e, action: string, payload?: { url?: string; x?: number; y?: number }) => {
  const wc = win?.webContents
  if (wc === undefined) return
  switch (action) {
    case 'undo': wc.undo(); break
    case 'cut': wc.cut(); break
    case 'copy': wc.copy(); break
    case 'paste': wc.paste(); break
    case 'selectAll': wc.selectAll(); break
    case 'copyLink': if (payload?.url !== undefined) clipboard.writeText(payload.url); break
    case 'openLink': if (payload?.url !== undefined) void shell.openExternal(payload.url); break
    case 'inspect': wc.inspectElement(payload?.x ?? 0, payload?.y ?? 0); break
    case 'reload': wc.reload(); break
    case 'devtools': toggleDevTools(); break
  }
})

// 最大化状态初始查询（广播之外补拉——renderer 加载/重载后自行同步）
ipcMain.handle('openbot:win-is-maximized', () => win?.isMaximized() ?? false)

// 应用版本（P4 Step 1 About 真值）：来自 apps/desktop/package.json 的 version 字段（随提交 vX.Y.Z 同步）
ipcMain.handle('openbot:app-version', () => app.getVersion())

// 系统自启动（0.1.0 产品化）：注册表 Run 键即真相——不另存偏好（用户在系统侧改动如实反映；
// setLoginItemSettings 打包态用可执行路径，开发态用 electron 二进制 + 环境变量——Electron 自管）
ipcMain.handle('openbot:auto-launch:get', () => app.getLoginItemSettings().openAtLogin)
ipcMain.handle('openbot:auto-launch:set', (_e, enabled: boolean) => {
  app.setLoginItemSettings({ openAtLogin: enabled })
  return app.getLoginItemSettings().openAtLogin
})

// 数据路径（P4 Step 11 设置页数据区块）：与 kernel 装配同源布局——<userData>/data（state root），
// transcript 落 <data>/agents/<agentId>/transcript.jsonl（state 包布局约定）；
// transcript 独立目录（v0.1.63）：transcript-root.txt 标记——与 kernel.ts 装配端同一真相
ipcMain.handle('openbot:paths', () => {
  const userData = app.getPath('userData')
  // 自定义数据目录（P8-4 后 UI 优化）：userData 根下 data-root.txt 标记——与 kernel.ts 装配端同一真相
  let dataDir = join(userData, 'data')
  try {
    const custom = readFileSync(join(userData, 'data-root.txt'), 'utf8').trim()
    if (custom !== '') dataDir = custom
  } catch {
    /* 无标记——默认目录 */
  }
  // 会话记录目录：缺省随数据目录（<data>/agents）；标记非空时独立（文件落 <标记>/agents/<agentId>/）
  let transcriptDir = join(dataDir, 'agents')
  let transcriptRoot: string | null = null
  try {
    const customT = readFileSync(join(userData, 'transcript-root.txt'), 'utf8').trim()
    if (customT !== '') {
      transcriptDir = join(customT, 'agents')
      transcriptRoot = customT
    }
  } catch {
    /* 无标记——随数据目录 */
  }
  return {
    userData,
    data: dataDir,
    transcript: transcriptDir,
    // 标记原值（v0.1.63 设置模态预填用；null = 未自定义、随数据目录）
    transcriptRoot,
  }
})

// 打开数据文件夹（P4 Step 11，裁定 E 一期只读）：白名单限定 userData 内——
// 桥面永不开放任意路径（shell.openPath 会以用户权限打开资源管理器）
ipcMain.handle('openbot:open-path', (_e, target: string) => {
  const root = resolve(app.getPath('userData'))
  const resolved = resolve(target)
  // Windows 卷大小写不敏感：统一小写比较（盘符大小写随来源漂移）
  if (!resolved.toLowerCase().startsWith(root.toLowerCase())) {
    return Promise.resolve(`拒绝打开数据目录之外的路径：${target}`)
  }
  return shell.openPath(resolved)
})

// 目录选择对话框（v0.1.63，用户需求）：系统原生选目录（Win 资源管理器 / mac 访达）——
// 对话框在 main 侧弹出，renderer 只收结果字符串（无文件系统访问面）；取消返回 null
ipcMain.handle('openbot:pick-directory', async (_e, title: string) => {
  if (!win) return null
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory'] })
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0] ?? null
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
  // 任何退出路径(托盘菜单/系统关机/playwright close 的 app.quit())先置 quitting——
  // before-quit 早于窗口 close 触发,否则「关窗驻留」的 preventDefault 会拦掉整个退出流程
  app.on('before-quit', () => {
    quitting = true
  })
  void app.whenReady().then(async () => {
    try {
      console.log('[openbot] whenReady：动态加载内核装配模块')
      const { assembleDesktop } = await import('./kernel.js')
      desktop = await assembleDesktop()
    } catch (err) {
      console.error('[openbot] 内核装配失败：', err)
      // v0.1.51 用户裁定：报错人类可读可复制——完整堆栈落日志文件（弹窗给路径），弹窗文案结构化
      const detail = err instanceof Error ? `${err.stack ?? err.message}\n\ncode: ${String((err as { code?: string }).code ?? '（无）')}` : String(err)
      let logPath = '（日志写入失败）'
      try {
        const { appendFileSync } = await import('node:fs')
        const target = join(app.getPath('userData'), 'kernel-error.log')
        appendFileSync(target, `\n==== ${new Date().toISOString()} ====\n${detail}\n`)
        logPath = target
      } catch {
        // 日志失败不掩盖原错误
      }
      dialog.showErrorBox(
        'OpenBot 内核装配失败',
        `应用无法完成启动装配。完整错误详情已写入日志（可直接把该文件发给调试）：\n${logPath}\n\n错误摘要：\n${detail.slice(0, 600)}`,
      )
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
