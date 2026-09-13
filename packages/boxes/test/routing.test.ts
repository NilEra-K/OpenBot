/**
 * RoutingBoxBackend 测试（plan-image-firstclass P8-3 D2）：按 spec.image 路由、'default'/未注册
 * 落 fallback、container 条目 spec 改写（路由 id → 实际镜像名）、boxId 所有权解析（create 记录 +
 * 跨重启惰性扫描）、list 聚合去重、单路由离线不炸清单。
 * 替身后端记录调用（与 backend-ssh/backend-oci 同一测试哲学）。
 */
import { describe, expect, it } from 'vitest'
import { RoutingBoxBackend } from '../src/routing/index.js'
import { BoxesErrorCodes } from '../src/types.js'
import type { BoxBackend, BoxCaps, BoxInstance, BoxSpec, ExecResult } from '../src/types.js'
import { KernelError } from '@openbot/core'

const OK: ExecResult = { exitCode: 0, stdout: '', stderr: '' }

/** 记录型替身后端：可编造 list 清单与 create 返回的 boxId */
function fakeBackend(id: string, opts?: { boxes?: string[]; caps?: BoxCaps }): {
  backend: BoxBackend
  created: BoxSpec[]
  tornDown: string[]
  execed: string[]
} {
  const created: BoxSpec[] = []
  const tornDown: string[] = []
  const execed: string[] = []
  const known = new Set(opts?.boxes ?? [])
  const backend: BoxBackend = {
    id,
    caps: () => opts?.caps ?? { persistent: true, snapshot: false, headless: true, resourceLimits: false, isolation: 'high', interactive: true, suspendable: false },
    create: async (spec) => {
      created.push(spec)
      const boxId = `${id}-box-${created.length}`
      known.add(boxId)
      return boxId
    },
    exec: async (boxId) => {
      execed.push(boxId)
      if (!known.has(boxId)) throw new KernelError(BoxesErrorCodes.BOX_NOT_FOUND, `no box ${boxId}`)
      return OK
    },
    fsRead: async () => null,
    fsWrite: async () => undefined,
    snapshot: async () => 'snap-1',
    stats: async () => ({}),
    teardown: async (boxId) => {
      tornDown.push(boxId)
      known.delete(boxId)
    },
    list: async () =>
      [...known].map(
        (boxId): BoxInstance => ({ boxId, spec: { image: 'default' }, state: 'active', createdAt: 0 }),
      ),
  }
  return { backend, created, tornDown, execed }
}

describe('RoutingBoxBackend', () => {
  it('create：路由 id → 对应后端；未注册 id / default 落 fallback', async () => {
    const fb = fakeBackend('fallback')
    const ssh = fakeBackend('ssh')
    const routing = new RoutingBoxBackend({ fallback: fb.backend })
    routing.registerRoute('img-1', { backend: ssh.backend })
    const boxA = await routing.create({ image: 'img-1' })
    expect(boxA).toBe('ssh-box-1')
    expect(ssh.created).toEqual([{ image: 'img-1' }]) // ssh 条目无改写
    const boxB = await routing.create({ image: 'default' })
    expect(boxB).toBe('fallback-box-1')
    const boxC = await routing.create({ image: 'img-unknown' })
    expect(boxC).toBe('fallback-box-2')
  })

  it('container 条目 translate：create 时把路由 id 改写为实际镜像名（复用全局 OCI 底座）', async () => {
    const fb = fakeBackend('oci')
    const routing = new RoutingBoxBackend({ fallback: fb.backend })
    routing.registerRoute('img-7', {
      backend: fb.backend,
      translate: (spec) => ({ ...spec, image: 'openbot-gui:24.04' }),
    })
    await routing.create({ image: 'img-7', cpus: 2 })
    expect(fb.created).toEqual([{ image: 'openbot-gui:24.04', cpus: 2 }])
  })

  it('exec/teardown 按所有权路由（create 记录）；teardown 后所有权清除', async () => {
    const fb = fakeBackend('fallback')
    const ssh = fakeBackend('ssh')
    const routing = new RoutingBoxBackend({ fallback: fb.backend })
    routing.registerRoute('img-1', { backend: ssh.backend })
    const box = await routing.create({ image: 'img-1' })
    await routing.exec(box, { command: ['true'] })
    expect(ssh.execed).toEqual([box])
    expect(fb.execed).toEqual([])
    await routing.teardown(box)
    expect(ssh.tornDown).toEqual([box])
    await expect(routing.exec(box, { command: ['x'] })).rejects.toMatchObject({ code: BoxesErrorCodes.BOX_NOT_FOUND })
  })

  it('跨重启所有权恢复：未知 boxId 按各路由 list 惰性扫描（一次，缓存）', async () => {
    const fb = fakeBackend('fallback')
    const ssh = fakeBackend('ssh', { boxes: ['ssh-vm.local'] })
    const routing = new RoutingBoxBackend({ fallback: fb.backend })
    routing.registerRoute('img-1', { backend: ssh.backend })
    await routing.exec('ssh-vm.local', { command: ['true'] })
    expect(ssh.execed).toEqual(['ssh-vm.local'])
    expect(fb.execed).toEqual([])
    // 缓存后不再扫描（exec 直达）
    await routing.exec('ssh-vm.local', { command: ['true'] })
    expect(ssh.execed).toHaveLength(2)
    // 两个路由都不知道的 boxId → BOX_NOT_FOUND
    await expect(routing.exec('ghost-box', { command: ['x'] })).rejects.toMatchObject({
      code: BoxesErrorCodes.BOX_NOT_FOUND,
    })
  })

  it('list：fallback + 路由聚合去重；单路由离线不炸清单', async () => {
    const fb = fakeBackend('fallback', { boxes: ['fallback-box-1'] })
    const ssh = fakeBackend('ssh', { boxes: ['ssh-vm.local'] })
    const routing = new RoutingBoxBackend({ fallback: fb.backend })
    routing.registerRoute('img-1', { backend: ssh.backend })
    const boxes = await routing.list()
    expect(boxes.map((b) => b.boxId).sort()).toEqual(['fallback-box-1', 'ssh-vm.local'])
    // 离线路由：list 抛错被吞——其余照常
    ssh.backend.list = async () => {
      throw new KernelError('BOX_BACKEND_NOT_FOUND', 'offline')
    }
    expect((await routing.list()).map((b) => b.boxId)).toEqual(['fallback-box-1'])
  })

  it('caps 落 fallback（后端级概念无 per-box 形态——P8-4 记档）；removeRoute 后回落 fallback', async () => {
    const fb = fakeBackend('fallback', {
      caps: { persistent: false, snapshot: true, headless: true, resourceLimits: true, isolation: 'medium', interactive: true, suspendable: true },
    })
    const ssh = fakeBackend('ssh')
    const routing = new RoutingBoxBackend({ fallback: fb.backend })
    routing.registerRoute('img-1', { backend: ssh.backend })
    expect(routing.caps().isolation).toBe('medium')
    routing.removeRoute('img-1')
    const box = await routing.create({ image: 'img-1' })
    expect(box).toBe('fallback-box-1')
    expect(routing.hasRoute('img-1')).toBe(false)
  })
})
