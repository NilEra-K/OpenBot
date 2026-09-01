/**
 * 沙箱后端装配决策（装配根职责）：settings 偏好（state）× CLI 探测（boxes）→ 后端选择。
 * 纯函数可单测；不可用必带降级原因（如实呈现，不静默假装真实）。
 * 参考：ARCHITECTURE.md §2 依赖铁律（boxes 不依赖 state，决策只能在 coordinator）。
 */
import type { BackendProbe, SandboxBackendId } from '@openbot/boxes'
import type { SandboxPreference } from '@openbot/state'

export interface ChooseOptions {
  /** WSL 基础镜像（rootfs tarball）是否就绪——装配方检查文件后传入 */
  wslRootfs: boolean
  /** nspawn 的 rootfs tarball 是否就绪（与 wsl 同一「rootfs 导入」模型——装配方检查文件后传入） */
  nspawnRootfs?: boolean
  /** 已实现的后端白名单（未实现的 CLI 即使在也不选——诚实降级） */
  implemented?: SandboxBackendId[]
  /**
   * auto 的择优序（P6 Step 5 平台化）：win wsl 主力 / linux nspawn 优先（systemd 自带零安装）/
   * mac utm 优先——装配层传参（纯函数不 import os，注入即可测）。缺省保持 win 序（向后兼容）。
   */
  order?: Exclude<SandboxBackendId, 'mock'>[]
}

export interface ChooseResult {
  backendId: SandboxBackendId
  /** 期望的后端（auto 全链不可用时为 'auto'；mock 是地基而非错误） */
  wanted: SandboxBackendId | 'auto'
  /** 降级原因（backendId 与 wanted 不一致时必有） */
  reason?: string
}

/** auto 的择优顺序缺省值（产品定位：Windows 优先，WSL 主力；容器类随后）——平台序经 options.order 注入 */
const DEFAULT_ORDER: Exclude<SandboxBackendId, 'mock'>[] = ['wsl', 'docker', 'podman']

export function chooseBackend(pref: SandboxPreference, probes: BackendProbe[], options: ChooseOptions): ChooseResult {
  // 缺省全六值（P6 后矩阵齐：wsl/docker/podman/nspawn/utm 全实现）；装配方显式收窄用于灰度
  const implemented = new Set<SandboxBackendId>(options.implemented ?? ['mock', 'wsl', 'docker', 'podman', 'nspawn', 'utm'])
  const probeOf = (id: SandboxBackendId): BackendProbe | undefined => probes.find((p) => p.id === id)

  const tryPick = (id: Exclude<SandboxBackendId, 'mock'>): ChooseResult => {
    if (!implemented.has(id)) {
      return { backendId: 'mock', wanted: id, reason: `${id} 后端尚未实现（规划 Step 4）——已回退 mock` }
    }
    const probe = probeOf(id)
    if (!probe || !probe.available) {
      return { backendId: 'mock', wanted: id, reason: `${id} 不可用：${probe?.reason ?? '未知'}——已回退 mock` }
    }
    if (id === 'wsl' && !options.wslRootfs) {
      return {
        backendId: 'mock',
        wanted: 'wsl',
        reason: 'WSL 基础镜像（rootfs）未就绪——请在用户数据目录放置 box-rootfs.tar.gz 或设 OPENBOT_WSL_ROOTFS',
      }
    }
    if (id === 'nspawn' && options.nspawnRootfs === false) {
      return {
        backendId: 'mock',
        wanted: 'nspawn',
        reason: 'nspawn 基础镜像（rootfs）未就绪——请在用户数据目录放置 box-rootfs.tar.gz 或设 OPENBOT_NSPAWN_ROOTFS',
      }
    }
    return { backendId: id, wanted: id }
  }

  if (pref === 'mock') return { backendId: 'mock', wanted: 'mock' }
  if (pref !== 'auto') return tryPick(pref)

  for (const id of options.order ?? DEFAULT_ORDER) {
    const picked = tryPick(id)
    if (picked.backendId !== 'mock') return picked
  }
  // 全链不可用：如实告知（auto 下 mock 是地基而非错误）
  return { backendId: 'mock', wanted: 'auto', reason: '无可用真实后端——运行在 mock（命令返回模拟输出）' }
}
