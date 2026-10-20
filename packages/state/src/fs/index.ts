/**
 * 文件系统适配层：state 唯一的 I/O 出口——注入以便测试（内存）与装配（node）
 * 路径约定：posix 风格相对路径（'agents/a1/transcript.jsonl'），NodeFs 在 Windows 同样接受 '/'
 */
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface FsAdapter {
  /** 读全文；不存在返回 null */
  read(path: string): Promise<string | null>
  /** 覆写（自动建目录）：JSON 状态文件用 */
  write(path: string, content: string): Promise<void>
  /** 追加：JSONL 唯一合法写入方式 */
  append(path: string, content: string): Promise<void>
  /** 删除文件（不存在不报错） */
  remove(path: string): Promise<void>
  /** 列目录条目名；目录不存在返回空数组 */
  list(path: string): Promise<string[]>
}

/** 内存实现：测试与 CLI 确定性冒烟用 */
export class InMemoryFs implements FsAdapter {
  readonly #files = new Map<string, string>()

  async read(path: string): Promise<string | null> {
    return this.#files.get(path) ?? null
  }

  async write(path: string, content: string): Promise<void> {
    this.#files.set(path, content)
  }

  async append(path: string, content: string): Promise<void> {
    this.#files.set(path, (this.#files.get(path) ?? '') + content)
  }

  async remove(path: string): Promise<void> {
    this.#files.delete(path)
  }

  async list(path: string): Promise<string[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`
    const names = new Set<string>()
    for (const key of this.#files.keys()) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const first = rest.split('/')[0] ?? ''
      if (first) names.add(first)
    }
    return [...names].sort()
  }

  /** 测试辅助：导出全部文件快照 */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.#files)
  }
}

/** node:fs 实现：装配用（生产与真实落盘） */
export class NodeFs implements FsAdapter {
  async read(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8')
    } catch (err) {
      if (isENOENT(err)) return null
      throw err
    }
  }

  async write(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  }

  async append(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, content, 'utf8')
  }

  async remove(path: string): Promise<void> {
    // recursive（2026-10-20 插件卸载）：目录整体删除（文件场景 recursive 无副作用）
    await rm(path, { force: true, recursive: true })
  }

  async list(path: string): Promise<string[]> {
    try {
      return (await readdir(path)).sort()
    } catch (err) {
      if (isENOENT(err)) return []
      throw err
    }
  }
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT'
}
