/**
 * ImageStore 测试（plan-image-firstclass P8-3 D1）：CRUD/上限/损坏降级/载体校验/id 自增跨重启。
 * InMemoryFs 直测（automations 同哲学——持久化格式即 JSON 快照断言）。
 */
import { describe, expect, it } from 'vitest'
import { InMemoryFs } from '../src/fs/index.js'
import { IMAGE_LIMIT, ImageStore } from '../src/images/index.js'

const make = () => {
  const fs = new InMemoryFs()
  let seq = 0
  const store = new ImageStore({
    fs,
    root: 'data',
    nextImageId: () => `img-${++seq}`,
    now: () => 1_000,
  })
  return { fs, store }
}

const SSH_ENTRY = {
  name: 'VMWare Ubuntu',
  carrier: 'ssh' as const,
  host: '192.168.1.20',
  port: 22,
  user: 'ops',
  keyPath: 'C:/keys/vm.pem',
  controlProtocol: 'x11' as const,
  display: ':0',
}

const CONTAINER_ENTRY = {
  name: 'GUI 容器',
  carrier: 'container' as const,
  image: 'openbot-gui:24.04',
  controlProtocol: 'x11' as const,
}

describe('ImageStore', () => {
  it('add/list 往返（ssh/container 双载体）+ 重启恢复（同根新实例）', async () => {
    const { fs, store } = make()
    const ssh = await store.add(SSH_ENTRY)
    expect(ssh.id).toBe('img-1')
    expect(ssh.createdAt).toBe(1_000)
    const container = await store.add(CONTAINER_ENTRY)
    expect(container.id).toBe('img-2')
    expect(await store.list()).toEqual([ssh, container])
    const raw = JSON.parse(fs.snapshot()['data/images.json'] as string)
    expect(raw.version).toBe(1)
    const reborn = new ImageStore({ fs, root: 'data' })
    expect(await reborn.list()).toEqual([ssh, container])
  })

  it('载体校验：container 缺镜像名 / ssh 缺主机 / 端口越界 → STATE_IMAGE_INVALID', async () => {
    const { store } = make()
    await expect(store.add({ name: 'x', carrier: 'container', controlProtocol: 'none' })).rejects.toMatchObject({
      code: 'STATE_IMAGE_INVALID',
    })
    await expect(store.add({ name: 'x', carrier: 'ssh', controlProtocol: 'none' })).rejects.toMatchObject({
      code: 'STATE_IMAGE_INVALID',
    })
    await expect(
      store.add({ ...SSH_ENTRY, host: 'h', port: 70_000 }),
    ).rejects.toMatchObject({ code: 'STATE_IMAGE_INVALID' })
    await expect(store.add({ ...SSH_ENTRY, name: '' })).rejects.toMatchObject({ code: 'STATE_IMAGE_INVALID' })
  })

  it('id 自增跨重启不撞号（懒播种：存量 img-N 最大值续接）', async () => {
    const fs = new InMemoryFs()
    const first = new ImageStore({ fs, root: 'data', now: () => 1 })
    await first.add(SSH_ENTRY) // img-1（缺省自增）
    await first.add(CONTAINER_ENTRY) // img-2
    const reborn = new ImageStore({ fs, root: 'data' }) // 不注入 nextImageId——缺省自增走播种
    const third = await reborn.add({ ...CONTAINER_ENTRY, name: '第三个' })
    expect(third.id).toBe('img-3')
  })

  it('update：字段替换 + 载体切换清他载体字段；get/remove 与 NOT_FOUND 稳定码', async () => {
    const { store } = make()
    const entry = await store.add(SSH_ENTRY)
    const updated = await store.update(entry.id, { controlProtocol: 'none', display: '' })
    expect(updated.controlProtocol).toBe('none')
    expect(updated.display).toBeUndefined() // 空串 = 清除
    expect(updated.host).toBe('192.168.1.20') // 载体未变——连接事实保留
    const switched = await store.update(entry.id, { carrier: 'container', image: 'ubuntu:24.04' })
    expect(switched.host).toBeUndefined() // 载体切换——ssh 连接事实清除
    expect(switched.image).toBe('ubuntu:24.04')
    expect((await store.list()).some((e) => e.host !== undefined)).toBe(false)
    await expect(store.get('img-99')).resolves.toBeNull()
    await expect(store.update('img-99', { name: 'x' })).rejects.toMatchObject({ code: 'STATE_IMAGE_NOT_FOUND' })
    await store.remove(entry.id)
    await expect(store.remove(entry.id)).rejects.toMatchObject({ code: 'STATE_IMAGE_NOT_FOUND' })
  })

  it('上限 16（裁定 F）如实拒绝', async () => {
    const { store } = make()
    for (let i = 0; i < IMAGE_LIMIT; i++) {
      await store.add({ ...SSH_ENTRY, name: `虚机 ${i}` })
    }
    await expect(store.add({ ...SSH_ENTRY, name: '第 17 台' })).rejects.toMatchObject({
      code: 'STATE_IMAGE_LIMIT',
    })
  })

  it('损坏文件降级空表 + 告警（原文件保留）', async () => {
    const fs = new InMemoryFs()
    await fs.write('data/images.json', '{ NOT JSON')
    const store = new ImageStore({ fs, root: 'data' })
    await expect(store.list()).resolves.toEqual([])
    // 读取端不回写——坏文件留盘待人工检查（不静默吞数据）
    expect(fs.snapshot()['data/images.json']).toBe('{ NOT JSON')
  })
})
