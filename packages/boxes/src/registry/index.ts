/**
 * 后端注册表：coordinator 在装配时注册可用后端，按 id 路由。
 * 平台探测（wsl/docker 可用性检查）P3 接入真实后端时补——P1 只有 mock。
 */
import { KernelError } from '@openbot/core'
import { BoxesErrorCodes } from '../types.js'
import type { BoxBackend } from '../types.js'

export class BoxRegistry {
  readonly #backends = new Map<string, BoxBackend>()

  register(backend: BoxBackend): this {
    this.#backends.set(backend.id, backend)
    return this
  }

  get(id: string): BoxBackend {
    const backend = this.#backends.get(id)
    if (!backend) {
      throw new KernelError(BoxesErrorCodes.BOX_BACKEND_NOT_FOUND, `未注册的后端：${id}`)
    }
    return backend
  }

  list(): BoxBackend[] {
    return [...this.#backends.values()]
  }
}
