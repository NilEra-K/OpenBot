import { describe, expect, it } from 'vitest'
import { InMemoryFs, SettingsStore } from '../src/index.js'

/** 简单可逆"加密"：base64，验证密文链路（真实为 safeStorage） */
const enc = (plain: string): string => Buffer.from(plain, 'utf8').toString('base64')
const dec = (cipher: string): string => Buffer.from(cipher, 'base64').toString('utf8')

function makeStore() {
  const fs = new InMemoryFs()
  const store = new SettingsStore({ fs, root: 'data', encrypt: enc, decrypt: dec })
  return { fs, store }
}

describe('SettingsStore', () => {
  it('空启动给默认设置；upsert 落盘密文；重启恢复', async () => {
    const { fs, store } = makeStore()
    expect(await store.load()).toEqual({ version: 1, providers: [] })
    await store.upsert({ name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-明文' })
    // 落盘的是密文
    const raw = fs.snapshot()['data/settings.json'] ?? ''
    expect(raw).not.toContain('sk-明文')
    expect(raw).toContain(enc('sk-明文'))
    // 重启恢复
    const reopened = new SettingsStore({ fs, root: 'data', encrypt: enc, decrypt: dec })
    const resolved = await reopened.resolve('deepseek')
    expect(resolved).toEqual({
      name: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: 'sk-明文',
    })
  })

  it('list 展示形状绝无 key 材料，只带 hasKey', async () => {
    const { store } = makeStore()
    await store.upsert({ name: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3' })
    await store.upsert({ name: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4', apiKey: 'sk-x' })
    const list = await store.list()
    expect(list).toEqual([
      { name: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3', hasKey: false },
      { name: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4', hasKey: true },
    ])
    expect(JSON.stringify(list)).not.toContain('sk-x')
  })

  it('resolve：显式名 > 默认；两者皆无 → SETTINGS_NO_DEFAULT_PROVIDER', async () => {
    const { store } = makeStore()
    await expect(store.resolve()).rejects.toMatchObject({ code: 'SETTINGS_NO_DEFAULT_PROVIDER' })
    await store.upsert({ name: 'a', baseUrl: 'https://a/v1', model: 'm' })
    await store.upsert({ name: 'b', baseUrl: 'https://b/v1', model: 'm' })
    expect((await store.resolve('b')).baseUrl).toBe('https://b/v1')
    await store.setDefault('a')
    expect((await store.resolve()).name).toBe('a')
    await expect(store.resolve('ghost')).rejects.toMatchObject({ code: 'SETTINGS_PROVIDER_NOT_FOUND' })
    await expect(store.setDefault('ghost')).rejects.toMatchObject({ code: 'SETTINGS_PROVIDER_NOT_FOUND' })
  })

  it('同名 upsert 替换；省略 apiKey 保留既有密文；remove 清默认', async () => {
    const { store } = makeStore()
    await store.upsert({ name: 'p', baseUrl: 'https://old/v1', model: 'm1', apiKey: 'sk-1' })
    const updated = await store.upsert({ name: 'p', baseUrl: 'https://new/v1', model: 'm2' })
    expect(updated.baseUrl).toBe('https://new/v1')
    expect(updated.hasKey).toBe(true) // key 保留
    expect((await store.resolve('p')).model).toBe('m2')
    expect((await store.resolve('p')).apiKey).toBe('sk-1')
    await store.setDefault('p')
    await store.remove('p')
    await expect(store.resolve()).rejects.toMatchObject({ code: 'SETTINGS_NO_DEFAULT_PROVIDER' })
    expect(await store.list()).toEqual([])
  })

  it('损坏/版本不识的 settings.json：回退默认空设置（设置可重建，不拒启）', async () => {
    const fs = new InMemoryFs()
    await fs.write('data/settings.json', '{oops')
    const s1 = new SettingsStore({ fs, root: 'data' })
    expect(await s1.load()).toEqual({ version: 1, providers: [] })
    await fs.write('data/settings.json', JSON.stringify({ version: 99, providers: [] }))
    const s2 = new SettingsStore({ fs, root: 'data' })
    expect(await s2.load()).toEqual({ version: 1, providers: [] })
  })
})
