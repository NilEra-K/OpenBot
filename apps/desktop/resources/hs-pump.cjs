// L2 帧泵极简 preload（plan-screen-firstclass P9-2）：只暴露帧字节与错误上报两个口——
// 不接主 renderer 桥（index.cjs 的 window.openbot 面与本文件无关）。
// 场景：hostscreen-pump.ts 创建的隐藏窗口（contextIsolation:false + 本仓自加载页面）。
// 频道固定 + 主进程按 event.sender 过滤（每个泵窗口只认自己的帧——多实例不串线）。
const { ipcRenderer } = require('electron')

window.__hsPump = {
  send: (bytes, width, height) => {
    ipcRenderer.send('hs-frame-pump', { bytes, width, height })
  },
  error: (msg) => {
    ipcRenderer.send('hs-frame-pump-err', String(msg))
  },
}
