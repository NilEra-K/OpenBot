/**
 * @openbot/state —— 持久化：JSONL transcript、幂等账本、agent 目录
 * 参考：ARCHITECTURE.md §3.2。memory / automations / box-catalog 按 P1 之后需要填充。
 */
export * from './fs/index.js'
export * from './transcript/index.js'
export * from './ledger/index.js'
export * from './agent-store/index.js'
