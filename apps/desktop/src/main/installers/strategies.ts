/**
 * 运行时安装策略注册表（docs/plan-v020-runtime-install.md §0/§1）：数据驱动——
 * 每运行时 × 平台一条策略；执行器按 source 型分派。哈希分级（§2 诚实）：
 * github-latest 强校验（API digest）；direct 滚动直链如实标注无预置哈希；
 * builtin/package-manager 走系统渠道完整性。
 */
/** 尾部 test 槽位：单测自造策略的类型出路（非注册表成员） */
export type RuntimeId = 'wsl2' | 'docker-desktop' | 'podman' | 'docker' | 'colima' | 'mock-runtime' | 'test'

export type InstallerSource =
  /** 内置系统组件（WSL2）——零下载，提权执行系统命令；env 供 mock 策略（ELECTRON_RUN_AS_NODE） */
  | { kind: 'builtin'; command: string[]; args: string[]; env?: Record<string, string> }
  /** 直链安装包下载（Windows）；sha256 缺席 = 滚动源如实披露 */
  | { kind: 'direct'; url: string; fileName: string; sha256?: string; installerArgs: string[] }
  /** GitHub Releases latest 解析（API digest sha256 强校验） */
  | { kind: 'github-latest'; repo: string; assetPattern: RegExp; fileNameFrom: (assetName: string) => string; installerArgs: string[] }
  /** 包管理器（Linux pkexec / macOS brew）——命令按发行版/包管理器在执行期解析 */
  | { kind: 'package-manager'; package: string; cask?: boolean }

export interface RuntimeStrategy {
  id: RuntimeId
  /** 运行时显示名 */
  runtime: string
  platform: NodeJS.Platform
  source: InstallerSource
  /** 提权方式（UI 告知用） */
  elevation: 'uac' | 'polkit' | 'none'
  locationSelectable: boolean
  locationNote: string
  /** 如实标注（许可/上游限制等） */
  notes: string[]
}

const DOCKER_DESKTOP_NOTE =
  '官方滚动直链（TLS）——无预置哈希可校验（如实披露）；安装后需启动一次 Docker Desktop'

export const STRATEGIES: RuntimeStrategy[] = [
  // ---- Windows ----
  {
    id: 'wsl2',
    runtime: 'WSL2',
    platform: 'win32',
    source: { kind: 'builtin', command: ['wsl', '--install', '--no-distribution'], args: [] },
    elevation: 'uac',
    locationSelectable: false,
    locationNote: 'WSL2 本体装系统盘不可选；发行版（Box）数据目录可在应用内另选（见沙箱数据目录）',
    notes: ['Windows 内置组件（零下载）', '安装后如提示重启属系统要求'],
  },
  {
    id: 'docker-desktop',
    runtime: 'Docker Desktop',
    platform: 'win32',
    source: {
      kind: 'direct',
      url: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
      fileName: 'DockerDesktopInstaller.exe',
      installerArgs: ['install', '--quiet', '--accept-license'],
    },
    elevation: 'uac',
    locationSelectable: false,
    locationNote: '程序与数据位置由 Docker Desktop 决定（不可选）',
    notes: [DOCKER_DESKTOP_NOTE, '许可注意：大企业（>250 人或年收入 >$10M）需付费订阅'],
  },
  {
    id: 'podman',
    runtime: 'Podman',
    platform: 'win32',
    source: {
      kind: 'github-latest',
      repo: 'containers/podman',
      assetPattern: /^podman-[\d.]+-setup\.exe$/,
      fileNameFrom: (name) => name,
      installerArgs: ['/quiet'],
    },
    elevation: 'uac',
    locationSelectable: false,
    locationNote: 'machine 数据目录受上游限制（C 盘真实目录 bug）——不可选',
    notes: ['GitHub Releases latest（API digest sha256 强校验）', '安装后需 `podman machine init`（应用探测会如实提示）'],
  },
  // ---- Linux（docker/Podman；nspawn 零安装不在表）----
  {
    id: 'docker',
    runtime: 'Docker Engine',
    platform: 'linux',
    source: { kind: 'package-manager', package: 'docker' },
    elevation: 'polkit',
    locationSelectable: false,
    locationNote: '数据根（--data-root）属 daemon 配置，安装时不可选',
    notes: ['按发行版经包管理器安装（apt/dnf/pacman）', 'polkit 缺席环境自动回退为命令生成'],
  },
  {
    id: 'podman',
    runtime: 'Podman',
    platform: 'linux',
    source: { kind: 'package-manager', package: 'podman' },
    elevation: 'polkit',
    locationSelectable: false,
    locationNote: 'rootless 数据在 ~/.local/share/containers（不可选）',
    notes: ['多数发行版自带——本安装器只补缺席场景'],
  },
  // ---- macOS ----
  {
    id: 'docker-desktop',
    runtime: 'Docker Desktop',
    platform: 'darwin',
    source: { kind: 'package-manager', package: 'docker', cask: true },
    elevation: 'none',
    locationSelectable: false,
    locationNote: '位置由 Docker Desktop 决定（不可选）',
    notes: ['经 Homebrew 安装（brew 缺席时给出官方安装引导）', '许可注意同 Windows 版'],
  },
  {
    id: 'colima',
    runtime: 'colima',
    platform: 'darwin',
    source: { kind: 'package-manager', package: 'colima docker' },
    elevation: 'none',
    locationSelectable: true,
    locationNote: '磁盘位置可配（colima start --disk）——装后配置',
    notes: ['Docker Desktop 的免费开源替代（容器后端 + docker CLI）'],
  },
  {
    id: 'podman',
    runtime: 'Podman',
    platform: 'darwin',
    source: { kind: 'package-manager', package: 'podman' },
    elevation: 'none',
    locationSelectable: false,
    locationNote: 'machine 目录不可选',
    notes: ['经 Homebrew 安装'],
  },
]

/** E2E mock 策略（OPENBOT_E2E=1 时注册——mock 对称铁律：全链不触系统安装） */
export function mockStrategies(enabled: boolean): RuntimeStrategy[] {
  if (!enabled) return []
  return [
    {
      id: 'mock-runtime',
      runtime: 'Mock 运行时（E2E）',
      platform: process.platform,
      // Electron 主进程 execPath 是 electron.exe——须 ELECTRON_RUN_AS_NODE=1（与 McpClient 同坑）
      source: { kind: 'builtin', command: [process.execPath, '-e', 'process.exit(0)'], args: [], env: { ELECTRON_RUN_AS_NODE: '1' } },
      elevation: 'none',
      locationSelectable: false,
      locationNote: '—',
      notes: ['仅 E2E 环境注册'],
    },
  ]
}

/** Linux 发行版 → 包管理器安装命令（/etc/os-release ID 分支；未知发行版 → null 走回退） */
export function linuxInstallCommand(
  pkg: string,
  osId: string,
): { command: string[] } | null {
  const families: Record<string, (p: string) => string[]> = {
    debian: (p) => ['apt-get', 'install', '-y', p === 'docker' ? 'docker.io' : p],
    ubuntu: (p) => ['apt-get', 'install', '-y', p === 'docker' ? 'docker.io' : p],
    pop: (p) => ['apt-get', 'install', '-y', p === 'docker' ? 'docker.io' : p],
    fedora: (p) => ['dnf', 'install', '-y', p],
    rhel: (p) => ['dnf', 'install', '-y', p],
    rocky: (p) => ['dnf', 'install', '-y', p],
    alma: (p) => ['dnf', 'install', '-y', p],
    centos: (p) => ['dnf', 'install', '-y', p],
    arch: (p) => ['pacman', '-S', '--noconfirm', p],
    manjaro: (p) => ['pacman', '-S', '--noconfirm', p],
    opensuse: (p) => ['zypper', '--non-interactive', 'install', p],
  }
  const family = families[osId]
  return family === undefined ? null : { command: family(pkg) }
}

/** 兜底命令全文（用户过目后复制执行——如实降级通道） */
export function fallbackCommandText(strategy: RuntimeStrategy, osId: string): string {
  if (strategy.platform === 'darwin') {
    const brew = strategy.source.kind === 'package-manager' ? strategy.source : null
    if (brew === null) return ''
    const brewCmd = `brew install ${brew.cask === true ? '--cask ' : ''}${brew.package}`
    return `# Homebrew 缺席时先装 brew（官方脚本，执行后按提示操作）：\n/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n\n# 然后安装：\n${brewCmd}`
  }
  if (strategy.platform === 'linux' && strategy.source.kind === 'package-manager') {
    const resolved = linuxInstallCommand(strategy.source.package, osId)
    const cmd = resolved !== null ? `sudo ${resolved.command.join(' ')}` : `# 未知发行版——请用你的包管理器安装 ${strategy.source.package}`
    const update = resolved?.command[0] === 'apt-get' ? 'sudo apt-get update && ' : ''
    return `${update}${cmd}`
  }
  return ''
}

export function strategiesFor(platform: NodeJS.Platform, includeMock: boolean): RuntimeStrategy[] {
  return [...STRATEGIES.filter((s) => s.platform === platform), ...mockStrategies(includeMock).filter((s) => s.platform === platform)]
}
