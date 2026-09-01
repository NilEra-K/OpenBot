/**
 * @openbot/state —— 持久化：JSONL transcript、幂等账本、agent 目录
 * 参考：ARCHITECTURE.md §3.2。memory 已随 backlog ① 实现；automations / box-catalog 按需填充。
 */
export * from './fs/index.js'
export * from './transcript/index.js'
export * from './ledger/index.js'
export * from './agent-store/index.js'
export * from './settings/index.js'
export * from './memory/index.js'
export * from './automations/index.js'
