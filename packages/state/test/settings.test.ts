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
    expect(await store.load()).toEqual({ version: 2, providers: [] })
    await store.upsert({ name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', models: [{ id: 'deepseek-chat' }], apiKey: 'sk-明文' })
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

  it('list 展示形状绝无 key 材料，只带 hasKey（v2 模型列表）', async () => {
    const { store } = makeStore()
    await store.upsert({ name: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'qwen3' }] })
    await store.upsert({ name: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: [{ id: 'glm-4' }, { id: 'glm-4-air' }], apiKey: 'sk-x' })
    const list = await store.list()
    expect(list).toEqual([
      { name: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'qwen3' }], hasKey: false },
      { name: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: [{ id: 'glm-4' }, { id: 'glm-4-air' }], hasKey: true },
    ])
    expect(JSON.stringify(list)).not.toContain('sk-x')
  })

  it('resolve：显式名 > 默认；两者皆无 → SETTINGS_NO_DEFAULT_PROVIDER', async () => {
    const { store } = makeStore()
    await expect(store.resolve()).rejects.toMatchObject({ code: 'SETTINGS_NO_DEFAULT_PROVIDER' })
    await store.upsert({ name: 'a', baseUrl: 'https://a/v1', models: [{ id: 'm' }] })
    await store.upsert({ name: 'b', baseUrl: 'https://b/v1', models: [{ id: 'm' }] })
    expect((await store.resolve('b')).baseUrl).toBe('https://b/v1')
    await store.setDefault('a')
    expect((await store.resolve()).name).toBe('a')
    await expect(store.resolve('ghost')).rejects.toMatchObject({ code: 'SETTINGS_PROVIDER_NOT_FOUND' })
    await expect(store.setDefault('ghost')).rejects.toMatchObject({ code: 'SETTINGS_PROVIDER_NOT_FOUND' })
  })

  it('v2 模型解析：resolve(name, model) 显式模型 > defaultModel（默认供应商时）> models[0]；视觉随模型条目', async () => {
    const { store } = makeStore()
    await store.upsert({
      name: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      models: [{ id: 'glm-5.3-flash' }, { id: 'glm-5.3', supportsImages: true }],
    })
    // 缺省 = models[0]（无视觉声明）
    expect((await store.resolve('glm')).model).toBe('glm-5.3-flash')
    expect((await store.resolve('glm')).supportsImages).toBeUndefined()
    // 显式模型 → 视觉随条目
    const vision = await store.resolve('glm', 'glm-5.3')
    expect(vision.model).toBe('glm-5.3')
    expect(vision.supportsImages).toBe(true)
    // 不存在的模型 → 显式拒绝
    await expect(store.resolve('glm', 'ghost-model')).rejects.toMatchObject({ code: 'SETTINGS_PROVIDER_NO_MODEL' })
    // setDefault(name, model) 落 defaultModel → 默认解析走它
    await store.setDefault('glm', 'glm-5.3')
    expect((await store.resolve('glm')).model).toBe('glm-5.3')
    expect(await store.load()).toMatchObject({ defaultModel: 'glm-5.3' })
    // 非默认供应商不受全局 defaultModel 影响：回其 models[0]
    await store.upsert({ name: 'other', baseUrl: 'https://other/v1', models: [{ id: 'o1' }, { id: 'o2' }] })
    expect((await store.resolve('other')).model).toBe('o1')
  })

  it('upsert 模型列表为空 → SETTINGS_PROVIDER_NO_MODEL（图例语义：供应商至少一个模型）', async () => {
    const { store } = makeStore()
    await expect(store.upsert({ name: 'x', baseUrl: 'https://x/v1', models: [] })).rejects.toMatchObject({
      code: 'SETTINGS_PROVIDER_NO_MODEL',
    })
    await expect(store.upsert({ name: 'x', baseUrl: 'https://x/v1', models: [{ id: '' }] })).rejects.toMatchObject({
      code: 'SETTINGS_PROVIDER_NO_MODEL',
    })
  })

  it('默认模型悬空自愈：默认供应商的模型被改掉时回落新列表首个', async () => {
    const { store } = makeStore()
    await store.upsert({ name: 'p', baseUrl: 'https://p/v1', models: [{ id: 'm1' }, { id: 'm2' }] })
    await store.setDefault('p', 'm2')
    expect((await store.resolve()).model).toBe('m2')
    // 同名 upsert 换掉模型列表：旧 defaultModel 悬空 → 回落新列表首个
    await store.upsert({ name: 'p', baseUrl: 'https://p/v1', models: [{ id: 'n1' }] })
    expect((await store.resolve()).model).toBe('n1')
  })

  it('同名 upsert 替换；省略 apiKey 保留既有密文；remove 清默认与 defaultModel 联动', async () => {
    const { store } = makeStore()
    await store.upsert({ name: 'p', baseUrl: 'https://old/v1', models: [{ id: 'm1' }], apiKey: 'sk-1' })
    const updated = await store.upsert({ name: 'p', baseUrl: 'https://new/v1', models: [{ id: 'm2' }] })
    expect(updated.baseUrl).toBe('https://new/v1')
    expect(updated.hasKey).toBe(true) // key 保留
    expect((await store.resolve('p')).model).toBe('m2')
    expect((await store.resolve('p')).apiKey).toBe('sk-1')
    await store.setDefault('p')
    await store.remove('p')
    await expect(store.resolve()).rejects.toMatchObject({ code: 'SETTINGS_NO_DEFAULT_PROVIDER' })
    expect(await store.load()).toMatchObject({ defaultModel: undefined })
    expect(await store.list()).toEqual([])
  })

  it('v1 → v2 读取端迁移：单模型 model → models[0]（supportsImages 随迁下沉）；写回即 v2', async () => {
    const fs = new InMemoryFs()
    // 用户真实 v1 形状（单模型 + 供应商级视觉声明 + 默认供应商）
    await fs.write(
      'data/settings.json',
      JSON.stringify({
        version: 1,
        defaultProvider: 'GLM',
        providers: [
          { name: 'DeepSeek', baseUrl: 'https://jkai/v1', model: 'deepseek-v4-flash' },
          { name: 'GLM', baseUrl: 'https://bigmodel/api/anthropic', model: 'glm-5.3-flash', supportsImages: true, apiKey: enc('sk-glm') },
        ],
        sandbox: 'wsl',
      }),
    )
    const store = new SettingsStore({ fs, root: 'data', encrypt: enc, decrypt: dec })
    const loaded = await store.load()
    expect(loaded.version).toBe(2)
    expect(loaded.providers).toEqual([
      { name: 'DeepSeek', baseUrl: 'https://jkai/v1', models: [{ id: 'deepseek-v4-flash' }] },
      {
        name: 'GLM',
        baseUrl: 'https://bigmodel/api/anthropic',
        models: [{ id: 'glm-5.3-flash', supportsImages: true }],
        apiKey: enc('sk-glm'),
      },
    ])
    expect(loaded.defaultProvider).toBe('GLM')
    expect(loaded.sandbox).toBe('wsl')
    // 迁移后解析语义不变；视觉声明已下沉到模型条目
    const resolved = await store.resolve()
    expect(resolved.model).toBe('glm-5.3-flash')
    expect(resolved.supportsImages).toBe(true)
    // 任意写操作落盘即 v2（旧 model 键消失）
    await store.setDefault('GLM')
    const raw = fs.snapshot()['data/settings.json'] ?? ''
    expect(raw).toContain('"version": 2')
    expect(raw).toContain('"models"')
    expect(raw).not.toContain('"model":')
  })

  it('reorder 拖拽排序：全量重排落盘；清单不一致显式拒绝（悬空/缺项/重复）', async () => {
    const { store } = makeStore()
    await store.upsert({ name: 'a', baseUrl: 'https://a/v1', models: [{ id: 'm' }] })
    await store.upsert({ name: 'b', baseUrl: 'https://b/v1', models: [{ id: 'm' }] })
    await store.upsert({ name: 'c', baseUrl: 'https://c/v1', models: [{ id: 'm' }] })
    await store.reorder(['c', 'a', 'b'])
    expect((await store.list()).map((p) => p.name)).toEqual(['c', 'a', 'b'])
    // 档案内容随位移动（同对象重排，非重建——key 等字段原样）
    expect((await store.resolve('c')).baseUrl).toBe('https://c/v1')
    await expect(store.reorder(['a', 'b'])).rejects.toMatchObject({ code: 'SETTINGS_PROVIDER_NOT_FOUND' })
    await expect(store.reorder(['a', 'b', 'b'])).rejects.toMatchObject({ code: 'SETTINGS_PROVIDER_NOT_FOUND' })
    await expect(store.reorder(['a', 'b', 'ghost'])).rejects.toMatchObject({ code: 'SETTINGS_PROVIDER_NOT_FOUND' })
  })

  it('损坏/版本不识的 settings.json：回退默认空设置（设置可重建，不拒启）', async () => {
    const fs = new InMemoryFs()
    await fs.write('data/settings.json', '{oops')
    const s1 = new SettingsStore({ fs, root: 'data' })
    expect(await s1.load()).toEqual({ version: 2, providers: [] })
    await fs.write('data/settings.json', JSON.stringify({ version: 99, providers: [] }))
    const s2 = new SettingsStore({ fs, root: 'data' })
    expect(await s2.load()).toEqual({ version: 2, providers: [] })
  })

  it('protocol 字段（P4 Step 11）：upsert/resolve/list 透传；缺席 = openai-compat 兼容读取', async () => {
    const { store } = makeStore()
    await store.upsert({ name: 'claude', baseUrl: 'https://api.anthropic.com', models: [{ id: 'claude-sonnet-5' }], protocol: 'anthropic' })
    await store.upsert({ name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', models: [{ id: 'deepseek-chat' }] })
    expect((await store.resolve('claude')).protocol).toBe('anthropic')
    expect((await store.resolve('deepseek')).protocol).toBeUndefined() // 缺席不造默认值——装配层按缺省分支
    const list = await store.list()
    expect(list.find((p) => p.name === 'claude')?.protocol).toBe('anthropic')
    expect(list.find((p) => p.name === 'deepseek')?.protocol).toBeUndefined()
  })

  it('fallback 档案位（P4 Step 11）：引用校验 / set-get / 清除 / remove 联动清空', async () => {
    const { fs, store } = makeStore()
    await store.upsert({ name: 'main', baseUrl: 'https://main/v1', models: [{ id: 'm' }] })
    await store.upsert({ name: 'backup', baseUrl: 'https://backup/v1', models: [{ id: 'm' }] })
    // 引用不存在 → 显式拒绝（悬空引用属配置错误）
    await expect(store.setFallback('ghost')).rejects.toMatchObject({ code: 'SETTINGS_PROVIDER_NOT_FOUND' })
    await store.setFallback('backup')
    expect(await store.getFallback()).toBe('backup')
    // 清除：盘上不再有该键
    await store.setFallback(null)
    expect(await store.getFallback()).toBeNull()
    expect(fs.snapshot()['data/settings.json'] ?? '').not.toContain('fallbackProvider')
    // remove 档案时联动清空（不留悬空引用）
    await store.setFallback('backup')
    await store.remove('backup')
    expect(await store.getFallback()).toBeNull()
  })

  it('renameFrom 改名（v0.1.62）：密文随档迁移 + 默认/回退引用级联 + 冲突拒绝 + 幂等', async () => {
    const { store } = makeStore()
    await store.upsert({ name: '智谱中转', baseUrl: 'https://old/v1', models: [{ id: 'glm-5.3' }], apiKey: 'sk-旧' })
    await store.upsert({ name: 'other', baseUrl: 'https://other/v1', models: [{ id: 'm' }] })
    await store.setDefault('智谱中转', 'glm-5.3')
    await store.setFallback('智谱中转')
    // 改名（省略 apiKey）：密文随档迁移到新键、旧键不复存在
    await store.upsert({ name: '智谱主力', renameFrom: '智谱中转', baseUrl: 'https://new/v1', models: [{ id: 'glm-5.3' }] })
    expect((await store.resolve('智谱主力')).apiKey).toBe('sk-旧')
    expect((await store.resolve('智谱主力')).baseUrl).toBe('https://new/v1')
    await expect(store.resolve('智谱中转')).rejects.toMatchObject({ code: 'SETTINGS_PROVIDER_NOT_FOUND' })
    // 默认与回退引用级联到新名；defaultModel 不动（模型 id 未变）
    const settings = await store.load()
    expect(settings.defaultProvider).toBe('智谱主力')
    expect(settings.defaultModel).toBe('glm-5.3')
    expect(settings.fallbackProvider).toBe('智谱主力')
    // 目标名撞他档 → 显式拒绝（不隐式吞并）
    await expect(
      store.upsert({ name: 'other', renameFrom: '智谱主力', baseUrl: 'https://x/v1', models: [{ id: 'm' }] }),
    ).rejects.toMatchObject({ code: 'SETTINGS_PROVIDER_NAME_CONFLICT' })
    // 来源档不存在 → NOT_FOUND
    await expect(
      store.upsert({ name: '新档', renameFrom: 'ghost', baseUrl: 'https://x/v1', models: [{ id: 'm' }] }),
    ).rejects.toMatchObject({ code: 'SETTINGS_PROVIDER_NOT_FOUND' })
    // 幂等：renameFrom 与 name 相同 = 同名替换现行为（密文保留、档案数不变）
    const again = await store.upsert({ name: '智谱主力', renameFrom: '智谱主力', baseUrl: 'https://new/v1', models: [{ id: 'glm-5.3' }] })
    expect(again.hasKey).toBe(true)
    expect((await store.load()).providers).toHaveLength(2)
  })

  it('relays 多房间（P7 多房间轮）：全量写入与读回；旧 relay 单字段读取端回退；写入后旧键清除', async () => {
    const { store, fs } = makeStore()
    const relays = [
      { enabled: true, url: 'ws://a:1', roomId: 'ra', inviteCode: 'ia', displayName: '甲' },
      { enabled: false, url: 'ws://b:2', roomId: 'rb', inviteCode: 'ib', displayName: '乙', roomName: '备注' },
    ]
    await store.setRelays(relays)
    expect(await store.getRelays()).toEqual(relays)
    // 写入走 relays——旧 relay 键随之清除（单一真相）
    expect(fs.snapshot()['data/settings.json'] ?? '').not.toContain('"relay"')

    // 旧文件只有 relay 单字段（P7 早期）：读取回退为单元素数组（读取端兼容，不破坏性迁移）
    const legacy = makeStore()
    await legacy.fs.write(
      'data/settings.json',
      JSON.stringify({ version: 1, providers: [], relay: { enabled: true, url: 'ws://x', roomId: 'rx', inviteCode: 'ix', displayName: '旧' } }),
    )
    expect(await legacy.store.getRelays()).toEqual([
      { enabled: true, url: 'ws://x', roomId: 'rx', inviteCode: 'ix', displayName: '旧' },
    ])

    // 无配置：空数组（未接入）
    expect(await makeStore().store.getRelays()).toEqual([])
  })
})

describe('自定义角色模板（2026-10-18：用户自建档位——小红书运维/微商运营等）', () => {
  it('upsert 同名覆盖、读取过滤坏条目、remove 幂等；旧文件（无字段）读取=空清单', async () => {
    const { fs, store } = makeStore()
    expect(await store.getRoleTemplates()).toEqual([])
    await store.upsertRoleTemplate({ name: '小红书运维', persona: '负责小红书笔记投放、数据复盘与评论区运营' })
    await store.upsertRoleTemplate({ name: '微商运营', persona: '负责私域朋友圈运营、客户跟进与转化' })
    // 同名覆盖（模板键=名）
    await store.upsertRoleTemplate({ name: '微商运营', persona: '私域运营（v2 文案）' })
    let list = await store.getRoleTemplates()
    expect(list.map((r) => r.name)).toEqual(['小红书运维', '微商运营'])
    expect(list[1]?.persona).toBe('私域运营（v2 文案）')
    // 删除幂等 + 不存在的名字不报错
    await store.removeRoleTemplate('微商运营')
    await store.removeRoleTemplate('不存在')
    list = await store.getRoleTemplates()
    expect(list.map((r) => r.name)).toEqual(['小红书运维'])
  })
})
