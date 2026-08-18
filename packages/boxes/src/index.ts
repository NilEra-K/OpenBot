/**
 * @openbot/boxes —— 沙箱抽象层：caps 能力协商 + wsl/docker/mock 后端
 * 参考：ARCHITECTURE.md §6。
 */
export * from './types.js'
export * from './registry/index.js'
export * from './backend-wsl/index.js'
export * from './backend-docker/index.js'
export * from './backend-mock/index.js'
export * from './images/index.js'
