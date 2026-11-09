/**
 * 运行时安装策略注册表（docs/plan-v020-runtime-install.md §0/§1）：数据驱动——
 * 每运行时 × 平台一条策略；执行器按 source 型分派。哈希分级（§2 诚实）：
 * github-latest 强校验（API digest）；direct 滚动直链如实标注无预置哈希；
 * builtin/package-manager 走系统渠道完整性。
 *
 * 位置语义（2026-10-21 用户裁定三术语，全链不再混称「数据目录」）：
 * - 安装位置 = 运行时程序本体装哪（locationFlags.installDir）
 * - 容器数据位置 = 容器镜像/卷落盘哪（locationFlags.dataDir，如 docker-desktop-data）
 * - Box 数据目录 = OpenBot 自建 Box 发行版 VHDX 落盘哪（沙箱面行级 ⚙，与本表无关）
 * 只声明上游真实支持的旗标（不放假能力）；缺席 = 如实不可选。
 */
/** 尾部 test 槽位：单测自造策略的类型出路（非注册表成员）；mock-runtime-mm = E2E 专用
 *  machine-missing 形态（v0.1.130 vmnotfound 修复的 mock 对称演员——装完 installed + 无 machine） */
export type RuntimeId = 'wsl2' | 'docker-desktop' | 'podman' | 'docker' | 'colima' | 'mock-runtime' | 'mock-runtime-mm' | 'test'

export type InstallerSource =
  /** 内置系统组件（WSL2）——零下载，提权执行系统命令；env 供 mock 策略（ELECTRON_RUN_AS_NODE） */
  | { kind: 'builtin'; command: string[]; args: string[]; env?: Record<string, string> }
  /** 直链安装包下载（Windows）；sha256 缺席 = 滚动源如实披露 */
  | { kind: 'direct'; url: string; fileName: string; sha256?: string; installerArgs: string[]; launcher?: 'msiexec' }
  /** GitHub Releases latest 解析（API digest sha256 强校验） */
  | {
      kind: 'github-latest'
      repo: string
      assetPattern: RegExp
      fileNameFrom: (assetName: string) => string
      installerArgs: string[]
      /** 拉起形态（缺省 = 直接执行下载的安装包）：msiexec = msiexec.exe /package <文件> 静默装
       * （2026-10-21 Podman v6 起官方只发 MSI——旧 setup.exe 资产已不存在） */
      launcher?: 'msiexec'
    }
  /** 包管理器（Linux pkexec / macOS brew）——命令按发行版/包管理器在执行期解析 */
  | { kind: 'package-manager'; package: string; cask?: boolean }

/** 位置旗标：值为参数前缀（组装成单个参数 `<flag><值>`）——
 *  installer-flag 型如 `--installation-dir=`；msi-property 型如 `INSTALLDIR=`（WiX 公开属性，形态恰好同构） */
export interface LocationFlags {
  installDir?: string
  dataDir?: string
}

/** 启动策略（2026-10-27 v0.1.89 已装未跑分层；同日 v0.1.90 跨平台补齐）：声明制——
 *  未声明者不显示启动钮。提权透明（安装确认同款红线）：elevation=polkit 的启动 UI 先弹确认模态。
 *  - app：拉起桌面应用（win DD——detached；exe 定位 = CLI bin 上两级推导 → 官方默认位回退）
 *  - cli：CLI 子命令启动（podman machine start / colima start / systemctl start docker——
 *    polkit 经 pkexec 包裹；就绪探测通道 readyCheck，探测 CLI 的回退路径表属启动器实现细节不进声明）
 *  - open-app：macOS LaunchServices 拉起（open -a——GUI 进程 PATH 不含 brew 位时的可靠寻径）
 *  - mock：E2E 专用（内存等待不触真系统——mock 对称铁律） */
export type LaunchStrategy =
  | { kind: 'app'; exeName: string; defaultRoot: string; elevation?: 'none' | 'polkit' }
  | {
      kind: 'cli'
      /** 启动命令的 CLI（解析：PATH → defaultCliPaths 按序回退） */
      cli: string
      startArgs: string[]
      /** 默认安装位回退（win PATH 继承坑 / mac GUI PATH 不含 brew 位——同源坑） */
      defaultCliPaths?: string[]
      /** 就绪探测通道（docker info Server 段 / podman machine list Running / colima status） */
      readyCheck: 'docker-info' | 'podman-machine' | 'colima-status'
      elevation?: 'none' | 'polkit'
    }
  | { kind: 'open-app'; appName: string; readyCheck: 'docker-info'; elevation?: 'none' | 'polkit' }
  | { kind: 'mock'; elevation?: 'none' | 'polkit' }

/** 官方默认安装位（win，2026-10-27）：launch 声明与壳层 CLI/exe 解析回退共用——
 *  Windows 进程 PATH 启动时继承，新装运行时 CLI 不在本进程 PATH，默认位在场即判已装/可直接拉起 */
export const DOCKER_DESKTOP_WIN_ROOT = 'C:\\Program Files\\Docker\\Docker'
export const PODMAN_WIN_EXE = 'C:\\Program Files\\Podman\\podman.exe'
/** macOS Docker Desktop 应用位（brew cask 默认——darwin 行 installState 探测用） */
export const DOCKER_APP_MAC = '/Applications/Docker.app'

export interface RuntimeStrategy {
  id: RuntimeId
  /** 运行时显示名 */
  runtime: string
  platform: NodeJS.Platform
  source: InstallerSource
  /** 提权方式（UI 告知用） */
  elevation: 'uac' | 'polkit' | 'none'
  /** 位置旗标（缺席 = 安装位置/容器数据位置均不可选，locationNote 如实说明） */
  locationFlags?: LocationFlags
  /** 启动策略（2026-10-27 声明制）：缺席 = 不显示启动钮（应用外自行启动） */
  launch?: LaunchStrategy
  /** 位置事实（安装/数据位置各自可选与否的如实说明——UI 披露行） */
  locationNote: string
  /** 如实标注（许可/上游限制等） */
  notes: string[]
}

/** 官方直链如实事注（2026-10-26 拆两条——一行一事实，密度优化） */
const DOCKER_DESKTOP_NOTES = [
  '官方滚动直链（TLS），无预置哈希可校验（如实披露）',
  '安装后需启动一次 Docker Desktop',
]

export const STRATEGIES: RuntimeStrategy[] = [
  // ---- Windows ----
  {
    id: 'wsl2',
    runtime: 'WSL2',
    platform: 'win32',
    source: { kind: 'builtin', command: ['wsl', '--install', '--no-distribution'], args: [] },
    elevation: 'uac',
    locationNote: '安装位置：系统组件随系统盘（不可选）。Box 数据目录（发行版 VHDX 落盘）可用行级 ⚙ 另选',
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
    // 官方安装器旗标（docs.docker.com 命令行安装）：程序本体与 WSL 后端数据位置安装时均可自选
    locationFlags: { installDir: '--installation-dir=', dataDir: '--wsl-default-data-root=' },
    // 启动引导（2026-10-27 win 先行）：拉起 Docker Desktop.exe（detached 免提权）
    launch: { kind: 'app', exeName: 'Docker Desktop.exe', defaultRoot: DOCKER_DESKTOP_WIN_ROOT },
    locationNote:
      '安装位置与容器数据位置安装时可自选，留空均用官方默认——装后也可在 Docker Desktop 设置中调整',
    notes: [...DOCKER_DESKTOP_NOTES, '许可注意：大企业（>250 人或年收入 >$10M）需付费订阅'],
  },
  {
    id: 'podman',
    runtime: 'Podman',
    platform: 'win32',
    source: {
      kind: 'github-latest',
      repo: 'containers/podman',
      // v6 起 Windows 只发 MSI（旧 podman-*-setup.exe 资产已不存在——2026-10-21 核实 v6.1.4）
      assetPattern: /^podman-installer-windows-amd64\.msi$/,
      fileNameFrom: (name) => name,
      launcher: 'msiexec',
      // 官方 build_windows.md 静默安装式样：机器域 + WSL provider
      installerArgs: ['/quiet', 'ALLUSERS=1', 'MACHINE_PROVIDER=wsl'],
    },
    elevation: 'uac',
    // WiX INSTALLDIR 公开属性（contrib/win-installer/wix/podman-main.wxs Directory Id=INSTALLDIR）
    locationFlags: { installDir: 'INSTALLDIR=' },
    // 启动引导（v0.1.90 迁 cli 型）：podman machine start（用户级 VM 操作免提权）
    launch: {
      kind: 'cli',
      cli: 'podman',
      startArgs: ['machine', 'start'],
      defaultCliPaths: [PODMAN_WIN_EXE],
      readyCheck: 'podman-machine',
      elevation: 'none',
    },
    locationNote: '安装位置可自选（MSI INSTALLDIR 属性）。容器数据位置受上游限制（machine 目录 C 盘真实目录 bug）——不可选',
    notes: [
      'GitHub Releases latest（API digest sha256 强校验）',
      'MSI 静默安装（msiexec /quiet，官方 WiX v5 安装器）',
      '安装后需 `podman machine init`（应用探测会如实提示）',
    ],
  },
  // ---- Linux（docker/Podman；nspawn 零安装不在表）----
  {
    id: 'docker',
    runtime: 'Docker Engine',
    platform: 'linux',
    source: { kind: 'package-manager', package: 'docker' },
    elevation: 'polkit',
    // 启动引导（v0.1.90 作者裁定含本批）：systemctl start docker 经 pkexec（polkit 提权——UI 先弹确认模态）
    launch: {
      kind: 'cli',
      cli: 'systemctl',
      startArgs: ['start', 'docker'],
      defaultCliPaths: ['/usr/bin/systemctl'],
      readyCheck: 'docker-info',
      elevation: 'polkit',
    },
    locationNote: '安装位置由包管理器决定；容器数据位置（--data-root）属 daemon 配置——装后另行设置',
    notes: ['按发行版经包管理器安装（apt/dnf/pacman）', 'polkit 缺席环境自动回退为命令生成'],
  },
  {
    id: 'podman',
    runtime: 'Podman',
    platform: 'linux',
    source: { kind: 'package-manager', package: 'podman' },
    elevation: 'polkit',
    locationNote: '安装位置由包管理器决定；rootless 容器数据在 ~/.local/share/containers（不可选）',
    notes: ['多数发行版自带——本安装器只补缺席场景'],
  },
  // ---- macOS ----
  {
    id: 'docker-desktop',
    runtime: 'Docker Desktop',
    platform: 'darwin',
    source: { kind: 'package-manager', package: 'docker', cask: true },
    elevation: 'none',
    // 启动引导（v0.1.90）：open -a Docker（LaunchServices——GUI 进程 PATH 不含 brew 位）
    launch: { kind: 'open-app', appName: 'Docker', readyCheck: 'docker-info' },
    locationNote: '安装位置与容器数据位置由 Docker Desktop 决定（brew cask 不可选；装后应用内可调）',
    notes: ['经 Homebrew 安装（brew 缺席时给出官方安装引导）', '许可注意同 Windows 版'],
  },
  {
    id: 'colima',
    runtime: 'colima',
    platform: 'darwin',
    source: { kind: 'package-manager', package: 'colima docker' },
    elevation: 'none',
    // 启动引导（v0.1.90）：colima start（免提权；colima status 判就绪；brew 双位回退）
    launch: {
      kind: 'cli',
      cli: 'colima',
      startArgs: ['start'],
      defaultCliPaths: ['/opt/homebrew/bin/colima', '/usr/local/bin/colima'],
      readyCheck: 'colima-status',
      elevation: 'none',
    },
    locationNote: '安装位置由 brew 决定；虚拟机磁盘属装后配置（colima start --disk）——安装时不可选',
    notes: ['Docker Desktop 的免费开源替代（容器后端 + docker CLI）'],
  },
  {
    id: 'podman',
    runtime: 'Podman',
    platform: 'darwin',
    source: { kind: 'package-manager', package: 'podman' },
    elevation: 'none',
    // 启动引导（v0.1.90）：podman machine start（同 win 形；brew 双位回退）
    launch: {
      kind: 'cli',
      cli: 'podman',
      startArgs: ['machine', 'start'],
      defaultCliPaths: ['/opt/homebrew/bin/podman', '/usr/local/bin/podman'],
      readyCheck: 'podman-machine',
      elevation: 'none',
    },
    locationNote: '安装位置由 brew 决定；machine 数据目录不可选',
    notes: ['经 Homebrew 安装'],
  },
]

/** E2E mock 策略（OPENBOT_E2E=1 时注册——mock 对称铁律：全链不触系统安装）。
 *  locationFlags 供 E2E 验证位置输入链（确认模态输入 → 命令面透传 → 执行器组装） */
export function mockStrategies(enabled: boolean): RuntimeStrategy[] {
  if (!enabled) return []
  return [
    {
      id: 'mock-runtime',
      runtime: 'Mock 运行时（E2E）',
      platform: process.platform,
      // Electron 主进程 execPath 是 electron.exe——须 ELECTRON_RUN_AS_NODE=1（与 McpClient 同坑）；
      // 3s 停留（2026-10-27 由 1.5s 放宽）让 installing 窗口与安装取消链可断言（进度 detail 含组装后的位置参数）
      source: {
        kind: 'builtin',
        command: [process.execPath, '-e', 'setTimeout(()=>process.exit(0),3000)'],
        args: [],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
      elevation: 'none',
      locationFlags: { installDir: 'MOCK_INSTALL_DIR=' },
      // 启动引导（2026-10-27）：mock 对称——内存等待后 ready，不触真系统
      launch: { kind: 'mock' },
      locationNote: '安装位置可自选（E2E 演示链）；容器数据位置不可选',
      notes: ['仅 E2E 环境注册'],
    },
    {
      // machine-missing 形态（v0.1.130 vmnotfound 修复）：装完 installed + 尚无 machine——
      // done 模态/行状态均应分流「需初始化」（不给启动钮）；台账语义见 kernel.ts mm 分支
      id: 'mock-runtime-mm',
      // 显示名避开「Mock 运行时」前缀——既有 E2E 以该子串选行，严格模式不容两行命中
      runtime: 'Mock MM（E2E）',
      platform: process.platform,
      source: {
        kind: 'builtin',
        command: [process.execPath, '-e', 'setTimeout(()=>process.exit(0),3000)'],
        args: [],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
      elevation: 'none',
      launch: { kind: 'mock' },
      locationNote: 'E2E machine-missing 演示（无位置输入面）',
      notes: ['仅 E2E 环境注册（vmnotfound 修复用例）'],
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
