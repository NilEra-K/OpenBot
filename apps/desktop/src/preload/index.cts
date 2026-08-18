/**
 * preload —— 壳预览阶段的唯一特权通道：frameless 窗口控制（最小化/最大化/关闭）。
 * renderer 依旧无特权（sandbox + contextIsolation）；P2 起数据面走 transport 环回网关，
 * 本通道仅保留窗口 chrome 操作（ARCHITECTURE.md §5、§8 解耦纪律）。
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('openbot', {
  desktop: true,
  window: {
    minimize: () => ipcRenderer.send('openbot:win', 'minimize'),
    toggleMaximize: () => ipcRenderer.send('openbot:win', 'toggleMaximize'),
    close: () => ipcRenderer.send('openbot:win', 'close'),
  },
})
