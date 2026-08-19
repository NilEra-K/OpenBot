/**
 * @openbot/llm —— LLM 薄客户端：provider 抽象 + openai-compat / anthropic / mock
 * 参考：ARCHITECTURE.md §3.3。openai-compat 与 anthropic 随 P1 后接入（自定义 base_url + 代理是国内刚需）。
 */
export * from './provider/index.js'
export * from './openai-compat/index.js'
export * from './anthropic/index.js'
export * from './mock/index.js'
