/**
 * Podman 薄壳（P5 Step 6）：与 Docker 同构共用 OCI 底座（全部实现在 backend-oci）——差异只在
 * 命令名（docker → podman）与探测函数（machine 运行态，见 probe/index.ts）。
 * 地雷对照 docs/platforms.md：podman machine 占一个 WSL2 发行版（资源告警全局视角）；
 * stats 输出字段差异（CPU 无 Perc 后缀、JSON 数组）在底座 parseOciStats 容错——注入单测锁样本。
 */
import { OciBoxBackend } from '../backend-oci/index.js'
import type { OciShellOptions } from '../backend-oci/index.js'

export class PodmanBoxBackend extends OciBoxBackend {
  constructor(options: OciShellOptions = {}) {
    super({ ...options, id: 'podman', cli: 'podman' })
  }
}
