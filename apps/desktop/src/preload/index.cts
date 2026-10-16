/**
 * preload —— 壳与 renderer 之间的唯一特权通道：
 * - 窗口 chrome 操作（frameless 三键）
 * - 网关接入点（port/token 经 ipc 异步拉取，只活在内存链路——不落盘、不进 URL 历史）
 * renderer 业务面依旧无特权（sandbox + contextIsolation）走环回网关（ARCHITECTURE.md §5、§8）。
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('openbot', {
  desktop: true,
  window: {
    minimize: () => ipcRenderer.send('openbot:win', 'minimize'),
    toggleMaximize: () => ipcRenderer.send('openbot:win', 'toggleMaximize'),
    close: () => ipcRenderer.send('openbot:win', 'close'),
    /** 当前最大化状态（renderer 加载/重载后的初始同步） */
    isMaximized: () => ipcRenderer.invoke('openbot:win-is-maximized') as Promise<boolean>,
    /** 订阅最大化状态变化（main 的 maximize/unmaximize 广播）；返回退订函数 */
    onMaximizeChange: (cb: (maximized: boolean) => void) => {
      const listener = (_e: unknown, maximized: boolean): void => cb(maximized)
      ipcRenderer.on('openbot:win-maximized', listener)
      return () => ipcRenderer.removeListener('openbot:win-maximized', listener)
    },
  },
  gateway: {
    /** 拉取网关接入点（main 装配完成后才有值；装配失败返回 null） */
    info: () => ipcRenderer.invoke('openbot:gateway') as Promise<{ port: number; token: string } | null>,
  },
  menu: {
    /** 订阅右键菜单请求（main 转发 context-menu 上下文，坐标已换算页面坐标）；返回退订函数 */
    onContextMenu: (cb: (payload: {
      x: number; y: number; isEditable: boolean
      canUndo: boolean; canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean
      selectionText: string; linkURL: string
    }) => void) => {
      const listener = (_e: unknown, payload: unknown): void => cb(payload as never)
      ipcRenderer.on('openbot:context-menu', listener)
      return () => ipcRenderer.removeListener('openbot:context-menu', listener)
    },
    /** 菜单动作回传 main 执行（编辑动作须由 webContents 施于焦点元素——renderer 无特权面） */
    action: (action: string, payload?: { url?: string; x?: number; y?: number }) => {
      ipcRenderer.send('openbot:menu-action', action, payload)
    },
  },
  app: {
    /** 应用版本（package.json version；About 页真值——不手写不过时） */
    version: () => ipcRenderer.invoke('openbot:app-version') as Promise<string>,
    /** 数据路径（设置页数据区块）：userData / data / transcript 目录 + 会话记录标记原值（null = 随数据目录） */
    paths: () => ipcRenderer.invoke('openbot:paths') as Promise<{ userData: string; data: string; transcript: string; transcriptRoot: string | null }>,
    /** 打开数据文件夹（白名单限定 userData 内；返回错误消息，空串 = 成功） */
    openPath: (path: string) => ipcRenderer.invoke('openbot:open-path', path) as Promise<string>,
    /** 目录选择对话框（v0.1.63）：系统原生选目录；取消返回 null——只回传字符串，无 fs 访问面 */
    pickDirectory: (title: string) => ipcRenderer.invoke('openbot:pick-directory', title) as Promise<string | null>,
  },
  autoLaunch: {
    /** 系统自启动现状（注册表 Run 键即真相——用户在系统侧改动如实反映） */
    get: () => ipcRenderer.invoke('openbot:auto-launch:get') as Promise<boolean>,
    /** 开关自启动（即时写系统；返回写后的实际态） */
    set: (enabled: boolean) => ipcRenderer.invoke('openbot:auto-launch:set', enabled) as Promise<boolean>,
  },
})
