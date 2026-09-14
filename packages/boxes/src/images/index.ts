/**
 * 可用镜像探测（环境镜像发现，2026-09-14）：设置页「扫描可用镜像」的事实源。
 * 解决「用户无从得知本机有哪些镜像」：镜像注册表只含手动注册条目，唯一验证手段是
 * 逐条目 v1.images.test——须先知道镜像名才能添加条目，鸡生蛋。本模块按需（用户点按钮）
 * 扫描环境里实际在场的镜像清单，只报告事实、不自动入库（注册仍走 v1.images.add 全链）。
 *
 * 三来源（并行、独立如实报告、单源失败不拖累他源）：
 * - docker / podman：宿主 CLI（Windows 上 Docker Desktop 的引擎跑在 WSL2 内——宿主 docker
 *   images 即「WSL2 中的镜像」；引擎未运行是最常见不可用态，如实带指引）；
 * - wsl-docker：WSL 默认发行版内独立安装的 docker（`wsl -- docker images`；与 Docker Desktop
 *   是不同 daemon，清单天然不重复）。仅 win32 追查——异平台没有 wsl.exe，跑了也是噪音。
 *
 * 格式：`images --format '{{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}'`（docker/podman
 * 同款模板，\t 分列与 OCI 底座 ps --format 同一既有模式）；解析层容错（坏行跳过、悬空层
 * <none> 过滤——无 tag 的引用不可 run/注册，报了也无法用）。ProcRunner 注入可测（probe 同哲学）。
 */
import { isSpawnFailure } from '../procexec/index.js'
import type { ProcRunner } from '../procexec/index.js'

/** 扫描来源标识（UI 据此映射显示名） */
export type ImageSourceId = 'docker' | 'podman' | 'wsl-docker'

/** 扫描到的镜像（images 清单的行事实；ref 是可直接注册/运行的引用形态） */
export interface ScannedImage {
  /** 完整引用 repository:tag（悬空层已过滤——两者必有） */
  ref: string
  repository: string
  tag: string
  /** 人类可读体积（CLI 原样呈现，如 "78.1MB"——不换算不造假） */
  size?: string
  /** 人类可读创建时间（CLI 的 CreatedSince，如 "2 weeks ago"） */
  created?: string
}

/** 单来源扫描结果（如实报告：不可用必带 reason，可用但无镜像 images=[]） */
export interface ImageScanSource {
  source: ImageSourceId
  ok: boolean
  /** ok=true 时在场镜像清单（引擎在跑但没拉过镜像 = 空数组） */
  images?: ScannedImage[]
  /** ok=false 的不可用原因（拼 CLI 原始输出 + 行动指引） */
  reason?: string
}

/** images 清单格式模板（四事实 TSV——docker/podman 共用） */
export const OCI_IMAGES_FORMAT = '{{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}'

/**
 * images 输出解析（纯函数可测）：TSV 逐行 → ScannedImage[]。
 * 容错规则：空行跳过；仓库为空/<none>（悬空层）跳过；无 tag（引用不可用）跳过；
 * 坏行（列数不足）跳过——单行损坏不影响其余行（与 parseOciStats 的容错同哲学）。
 */
export function parseOciImageLines(stdout: string): ScannedImage[] {
  const out: ScannedImage[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.replace(/\u0000/g, '').trim()
    if (t === '') continue
    const cols = t.split('\t').map((c) => c.trim())
    const repository = cols[0]
    const tag = cols[1]
    if (repository === undefined || repository === '' || repository === '<none>') continue
    if (tag === undefined || tag === '' || tag === '<none>') continue
    out.push({
      ref: `${repository}:${tag}`,
      repository,
      tag,
      ...(cols[2] !== undefined && cols[2] !== '' ? { size: cols[2] } : {}),
      ...(cols[3] !== undefined && cols[3] !== '' ? { created: cols[3] } : {}),
    })
  }
  return out
}

/** images 清单查询（docker/podman 同构——CLI 名与不可用指引是仅有的差异，薄壳注入） */
const scanOciImages = async (
  source: ImageSourceId,
  cli: string,
  run: ProcRunner,
  unavailableNote: string,
): Promise<ImageScanSource> => {
  try {
    const r = await run({ command: [cli, 'images', '--format', OCI_IMAGES_FORMAT], timeoutMs: 30_000 })
    if (r.exitCode === 0) return { source, ok: true, images: parseOciImageLines(r.stdout) }
    const detail = `${cli} images 退出码 ${r.exitCode}：${(r.stderr || r.stdout).trim().slice(0, 160)}`
    return { source, ok: false, reason: `${detail}（${unavailableNote}）` }
  } catch (err) {
    const reason = isSpawnFailure(err)
      ? `${cli} 未安装或不在 PATH`
      : err instanceof Error
        ? err.message
        : String(err)
    return { source, ok: false, reason }
  }
}

/** WSL 默认发行版内的 docker（wsl -- 直传——Linux 侧输出 UTF-8；发行版冷启动放宽容忍 45s） */
const scanWslDockerImages = async (run: ProcRunner): Promise<ImageScanSource> => {
  try {
    const r = await run({
      command: ['wsl', '--', 'docker', 'images', '--format', OCI_IMAGES_FORMAT],
      timeoutMs: 45_000,
    })
    if (r.exitCode === 0) {
      return { source: 'wsl-docker', ok: true, images: parseOciImageLines(r.stdout) }
    }
    // wsl.exe 自身报错（无发行版/未启用）是 UTF-16LE，utf8 解码会出现乱码——截断呈现，
    // 行动指引由 note 承担（退出码 + 指引是锚，原始输出只是参考）
    const detail = `${(r.stderr || r.stdout).replace(/\u0000/g, '').trim().slice(0, 100)}`
    return {
      source: 'wsl-docker',
      ok: false,
      reason: `wsl docker 退出码 ${r.exitCode}：${detail}（WSL 默认发行版内未检出可用 docker——发行版内安装并启动后重试）`,
    }
  } catch (err) {
    const reason = isSpawnFailure(err)
      ? 'wsl 未安装或不在 PATH'
      : err instanceof Error
        ? err.message
        : String(err)
    return { source: 'wsl-docker', ok: false, reason }
  }
}

export interface EnvImageScanOptions {
  run: ProcRunner
  /** 宿主平台（win32 才追查 WSL 发行版内的 docker；undefined = 测试全开，probeAll 同约定） */
  platform?: string
}

/**
 * 环境镜像扫描编排：三来源并行，各自如实结算（可用带清单/不可用带原因）。
 * 顺序呈现 docker → podman → wsl-docker（Promise.all 保序——UI 稳定不跳动）。
 */
export const scanEnvImages = async (options: EnvImageScanOptions): Promise<ImageScanSource[]> => {
  const jobs: Array<Promise<ImageScanSource>> = [
    scanOciImages('docker', 'docker', options.run, 'Docker Engine 未运行——启动 Docker Desktop 后重试'),
    scanOciImages('podman', 'podman', options.run, 'podman machine 未运行或未初始化——podman machine start 后重试'),
  ]
  if (options.platform === undefined || options.platform === 'win32') {
    jobs.push(scanWslDockerImages(options.run))
  }
  return Promise.all(jobs)
}
