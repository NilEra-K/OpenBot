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
  app: {
    /** 应用版本（package.json version；About 页真值——不手写不过时） */
    version: () => ipcRenderer.invoke('openbot:app-version') as Promise<string>,
  },
})
