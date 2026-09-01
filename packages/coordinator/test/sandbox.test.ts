/**
 * chooseBackend 单测（plan-p3 Step 5）：偏好 × 探测 × 实现白名单 → 后端选择。
 * 纯函数直测——降级必带 reason（诚实呈现契约）。
 */
import { describe, expect, it } from 'vitest'
import { chooseBackend } from '../src/index.js'
import type { BackendProbe } from '@openbot/boxes'

const probe = (id: BackendProbe['id'], available: boolean, reason?: string): BackendProbe => ({
  id,
  available,
  ...(reason !== undefined ? { reason } : {}),
})

const ALL_OK: BackendProbe[] = [probe('mock', true), probe('wsl', true), probe('docker', true), probe('podman', true)]
const NONE_OK: BackendProbe[] = [
  probe('mock', true),
  probe('wsl', false, 'wsl 未安装或不在 PATH'),
  probe('docker', false, 'docker 未安装或不在 PATH'),
  probe('podman', false, 'podman 未安装或不在 PATH'),
]

describe('chooseBackend：显式偏好', () => {
  it('mock 直选（无探测依赖）', () => {
    const r = chooseBackend('mock', NONE_OK, { wslRootfs: false })
    expect(r).toEqual({ backendId: 'mock', wanted: 'mock' })
  })

  it('wsl 全就绪 → 选中 wsl', () => {
    const r = chooseBackend('wsl', ALL_OK, { wslRootfs: true })
    expect(r).toEqual({ backendId: 'wsl', wanted: 'wsl' })
  })

  it('wsl 探测不可用 → 回退 mock 带 CLI 原因', () => {
    const r = chooseBackend('wsl', [probe('mock', true), probe('wsl', false, 'wsl --status 退出码 1')], { wslRootfs: true })
    expect(r.backendId).toBe('mock')
    expect(r.wanted).toBe('wsl')
    expect(r.reason).toContain('wsl 不可用')
    expect(r.reason).toContain('wsl --status 退出码 1')
  })

  it('wsl rootfs 缺失 → 回退 mock 并提示放置路径', () => {
    const r = chooseBackend('wsl', ALL_OK, { wslRootfs: false })
    expect(r.backendId).toBe('mock')
    expect(r.reason).toContain('rootfs')
    expect(r.reason).toContain('OPENBOT_WSL_ROOTFS')
  })

  it('实现白名单外（docker 属 Step 4）→ 回退 mock 注明未实现', () => {
    const r = chooseBackend('docker', ALL_OK, { wslRootfs: true, implemented: ['mock', 'wsl'] })
    expect(r.backendId).toBe('mock')
    expect(r.wanted).toBe('docker')
    expect(r.reason).toContain('尚未实现')
  })

  it('实现白名单省略 = 全部已实现（Step 4 落地后删除白名单参数）', () => {
    const r = chooseBackend('docker', ALL_OK, { wslRootfs: true })
    expect(r.backendId).toBe('docker')
  })

  it('探测清单缺项（装配方只传部分探测）→ 视为不可用', () => {
    const r = chooseBackend('wsl', [probe('mock', true)], { wslRootfs: true })
    expect(r.backendId).toBe('mock')
    expect(r.reason).toContain('未知')
  })
})

describe('chooseBackend：auto 择优链（wsl → docker → podman → mock）', () => {
  it('全就绪 → wsl（Windows 主力优先）', () => {
    const r = chooseBackend('auto', ALL_OK, { wslRootfs: true })
    expect(r.backendId).toBe('wsl')
    expect(r.wanted).toBe('wsl')
  })

  it('wsl 不可用、docker 可用且已实现 → docker', () => {
    const probes = [probe('mock', true), probe('wsl', false, '未安装'), probe('docker', true), probe('podman', true)]
    const r = chooseBackend('auto', probes, { wslRootfs: true })
    expect(r.backendId).toBe('docker')
  })

  it('wsl CLI 在但 rootfs 缺失 → 跳过取 docker（降级原因如实带出）', () => {
    const probes = [probe('mock', true), probe('wsl', true), probe('docker', true), probe('podman', false, '未安装')]
    const r = chooseBackend('auto', probes, { wslRootfs: false })
    expect(r.backendId).toBe('docker')
  })

  it('全链不可用 → mock 地基 + 汇总原因', () => {
    const r = chooseBackend('auto', NONE_OK, { wslRootfs: true })
    expect(r).toEqual({
      backendId: 'mock',
      wanted: 'auto',
      reason: '无可用真实后端——运行在 mock（命令返回模拟输出）',
    })
  })

  it('一期白名单（只 mock+wsl）：rootfs 缺失时 docker 探测可用也不选——落 mock 兜底（Step 4 前的桌面实况）', () => {
    const r = chooseBackend('auto', ALL_OK, { wslRootfs: false, implemented: ['mock', 'wsl'] })
    expect(r.backendId).toBe('mock')
    expect(r.wanted).toBe('auto')
    expect(r.reason).toContain('无可用真实后端')
  })
})

describe('chooseBackend：平台化（P6 Step 5——order 注入 + nspawn/utm）', () => {
  const LINUX_OK: BackendProbe[] = [
    probe('mock', true),
    probe('nspawn', true),
    probe('docker', true),
    probe('podman', true),
  ]
  const MAC_OK: BackendProbe[] = [probe('mock', true), probe('utm', true), probe('docker', true), probe('podman', true)]

  it('linux 序（nspawn 优先）：全就绪 → nspawn', () => {
    const r = chooseBackend('auto', LINUX_OK, {
      wslRootfs: false,
      nspawnRootfs: true,
      order: ['nspawn', 'docker', 'podman'],
    })
    expect(r.backendId).toBe('nspawn')
  })

  it('mac 序（utm 优先）：全就绪 → utm（UTM 是模板模型无 rootfs 前置）', () => {
    const r = chooseBackend('auto', MAC_OK, { wslRootfs: false, order: ['utm', 'docker', 'podman'] })
    expect(r.backendId).toBe('utm')
  })

  it('nspawn rootfs 缺失 → 回退 mock 提示放置路径（与 wsl 同一导入模型）', () => {
    const r = chooseBackend('nspawn', LINUX_OK, { wslRootfs: false, nspawnRootfs: false })
    expect(r.backendId).toBe('mock')
    expect(r.reason).toContain('rootfs')
    expect(r.reason).toContain('OPENBOT_NSPAWN_ROOTFS')
  })

  it('linux 序：nspawn rootfs 缺失时跳过取 docker（降级链如实）', () => {
    const r = chooseBackend('auto', LINUX_OK, {
      wslRootfs: false,
      nspawnRootfs: false,
      order: ['nspawn', 'docker', 'podman'],
    })
    expect(r.backendId).toBe('docker')
  })

  it('显式偏好 nspawn/utm：探测可用即选（不受平台序影响——序只管 auto）', () => {
    expect(chooseBackend('nspawn', LINUX_OK, { wslRootfs: false, nspawnRootfs: true }).backendId).toBe('nspawn')
    expect(chooseBackend('utm', MAC_OK, { wslRootfs: false }).backendId).toBe('utm')
  })

  it('win 序缺省不变（不传 order = wsl → docker → podman——向后兼容）', () => {
    const r = chooseBackend('auto', ALL_OK, { wslRootfs: true })
    expect(r.backendId).toBe('wsl')
  })
})
