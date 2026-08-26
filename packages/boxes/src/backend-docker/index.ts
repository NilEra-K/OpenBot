/**
 * Docker 薄壳（P5 Step 5）：底座注入命令名导出——全部实现在 backend-oci（CLI 即接口，
 * docker/podman 同构 OCI 标准）。probeDocker 收紧为 Engine 运行态校验（docker info Server 段）。
 * 参考：ARCHITECTURE.md §6、docs/platforms.md（Docker Desktop 命名管道——CLI 子进程天然屏蔽）。
 */
import { OciBoxBackend } from '../backend-oci/index.js'
import type { OciShellOptions } from '../backend-oci/index.js'

export class DockerBoxBackend extends OciBoxBackend {
  constructor(options: OciShellOptions = {}) {
    super({ ...options, id: 'docker', cli: 'docker' })
  }
}
