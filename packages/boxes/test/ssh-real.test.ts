/**
 * SshBoxBackend 真机套件（plan-image-firstclass P8-1 G2）：SSH 载体（VMWare 虚机/云主机）
 * exec/fs/PTY 全链 + GUI 工具集（xdotool/scrot/ffmpeg）实证。
 * 门控：OPENBOT_TEST_SSH=1 且 OPENBOT_TEST_SSH_HOST 在场（默认 CI 零依赖——gui-stream-real
 * 同哲学）；GUI 子套件另需 OPENBOT_TEST_SSH_GUI=1 且远端已跑 tools/provision-gui.sh。
 * 连接参数：OPENBOT_TEST_SSH_HOST/PORT/USER/KEY（独立命名空间，不复用桌面装配的 OPENBOT_SSH_*）。
 * 隔离纪律：工作目录 /tmp/openbot-ssh-real-*，用后清理；**teardown 语义=断开，绝不触碰远端机器**。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { BoxesErrorCodes, SshBoxBackend } from '../src/index.js'

const REAL = process.env.OPENBOT_TEST_SSH === '1' && !!process.env.OPENBOT_TEST_SSH_HOST
const GUI = REAL && process.env.OPENBOT_TEST_SSH_GUI === '1'
const HOST = process.env.OPENBOT_TEST_SSH_HOST ?? ''
const PORT = Number(process.env.OPENBOT_TEST_SSH_PORT) > 0 ? Number(process.env.OPENBOT_TEST_SSH_PORT) : 22
const USER = process.env.OPENBOT_TEST_SSH_USER
const KEY = process.env.OPENBOT_TEST_SSH_KEY
const DISPLAY = process.env.OPENBOT_TEST_SSH_DISPLAY ?? ':0'
const WORKDIR = '/tmp/openbot-ssh-real'
const PIDFILE = '/tmp/.openbot-ssh-real.pid'

const newBackend = (): SshBoxBackend =>
  new SshBoxBackend({
    host: HOST,
    port: PORT,
    ...(USER !== undefined && USER !== '' ? { user: USER } : {}),
    ...(KEY !== undefined && KEY !== '' ? { keyPath: KEY } : {}),
    workdir: WORKDIR,
  })

/** 远端测试目录清理（teardown 断开不动远端——清理是独立 exec，与后端语义分离） */
async function cleanupRemote(): Promise<void> {
  const b = newBackend()
  try {
    const boxId = await b.create({ image: 'default' })
    await b.exec(boxId, { command: ['rm', '-rf', WORKDIR, PIDFILE] })
  } catch {
    /* 远端不可达时无从清理——如实跳过 */
  }
}

describe.skipIf(!REAL)('SshBoxBackend（真机 SSH 载体）', () => {
  const backend = newBackend()
  let boxId = ''

  afterAll(async () => {
    await cleanupRemote()
  })

  it('create = attach：连通验证 + 工作目录初始化', async () => {
    boxId = await backend.create({ image: 'default' })
    expect(boxId).toBe(`ssh-${HOST.replaceAll(/[^a-zA-Z0-9.-]/g, '-')}`)
    await expect(backend.list()).resolves.toHaveLength(1)
  })

  it('exec：stdout/exitCode 事实回传；env 前缀注入生效（K=V 经远端 shell 展开）', async () => {
    const r = await backend.exec(boxId, { command: ['echo', 'hello-ssh'], timeoutMs: 15_000 })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('hello-ssh')
    const env = await backend.exec(boxId, {
      command: ['sh', '-c', 'echo "FOO=$OPENBOT_SSH_REAL_TEST"'],
      env: { OPENBOT_SSH_REAL_TEST: 'injected' },
      timeoutMs: 15_000,
    })
    expect(env.stdout.trim()).toBe('FOO=injected')
  })

  it('fsWrite/fsRead 往返：空格路径 + 单引号 + 大体量（200KB——远超 argv 上限，stdin 泵送）', async () => {
    const path = `${WORKDIR}/openbot 'quote test'.txt`
    const big = ('ssh 真机往返——'.repeat(4000) + '\n').slice(0, 200_000) // ~200KB UTF-8
    await backend.fsWrite(boxId, path, big)
    const back = await backend.fsRead(boxId, path)
    expect(back).toBe(big)
  })

  it('exec 超时：BOX_EXEC_TIMEOUT（本地 ssh 被杀——连接断开 sshd 回收会话内进程）', async () => {
    await expect(
      backend.exec(boxId, { command: ['sleep', '10'], timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: 'BOX_EXEC_TIMEOUT' })
    // 会话仍可用（超时只杀那一条命令的连接，不伤后端状态）
    const r = await backend.exec(boxId, { command: ['echo', 'alive'], timeoutMs: 15_000 })
    expect(r.stdout.trim()).toBe('alive')
  })

  it('exec 外部中止：BOX_EXEC_ABORTED（AbortSignal 传导——run 取消的信号终点）', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    await expect(
      backend.exec(boxId, { command: ['sleep', '10'], timeoutMs: 30_000, signal: controller.signal }),
    ).rejects.toMatchObject({ code: BoxesErrorCodes.BOX_EXEC_ABORTED })
  })

  it('openShell：ssh -tt 真 PTY——stty 尺寸生效、命令回显与输出经会话回流', async () => {
    const session = await backend.openShell(boxId, { cols: 100, rows: 30 })
    let text = ''
    let done: (() => void) | null = null
    const finished = new Promise<void>((resolve) => {
      done = resolve
    })
    session.onData((t) => {
      text += t
      if (text.includes('marker-42')) done?.()
    })
    session.write('echo marker-$((40+2))\n')
    await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error(`PTY 10s 无回显：${text.slice(-200)}`)), 10_000))])
    session.close()
    expect(text).toContain('marker-42')
  }, 20_000)

  it('teardown = 断开（裁定 C）：零远端命令、记账清空、其后操作 BOX_NOT_FOUND', async () => {
    await backend.teardown(boxId)
    await expect(backend.list()).resolves.toEqual([])
    await expect(backend.exec(boxId, { command: ['true'] })).rejects.toMatchObject({
      code: BoxesErrorCodes.BOX_NOT_FOUND,
    })
  })
})

describe.skipIf(!GUI)('SshBoxBackend 真机 GUI 工具集（远端已 provision）', () => {
  const backend = newBackend()
  let boxId = ''

  it('工具集在场（xdotool/scrot/ffmpeg——provision-gui.sh 产物）；几何/截图/实况全链', async () => {
    boxId = await backend.create({ image: 'default' })
    const tools = await backend.exec(boxId, {
      command: ['sh', '-c', 'command -v xdotool && command -v scrot && command -v ffmpeg'],
      timeoutMs: 15_000,
    })
    expect(tools.exitCode).toBe(0)

    // 几何（coordScaleOf/queryGeometry 同款命令）
    const geo = await backend.exec(boxId, {
      command: ['xdotool', 'getdisplaygeometry'],
      env: { DISPLAY },
      timeoutMs: 15_000,
    })
    expect(geo.stdout.trim()).toMatch(/^\d+\s+\d+$/)

    // 截图（computer_screenshot 同款管道：唯一临时文件 + scrot --pointer + convert 缩放 + base64）
    const shot = await backend.exec(boxId, {
      command: [
        'sh', '-c',
        "f=/tmp/.openbot-ssh-real-$$.png; g=/tmp/.openbot-ssh-real-$$.jpg; " +
          `scrot --pointer -o "$f" && convert "$f" -resize '1280x>' -quality 80 "$g" && base64 -w0 "$g"; rm -f "$f" "$g"`,
      ],
      env: { DISPLAY },
      timeoutMs: 20_000,
    })
    expect(shot.exitCode).toBe(0)
    expect(shot.stdout.trim().startsWith('/9j/')).toBe(true) // JPEG magic（base64）

    // 实况流（GuiStreamService 同款：pidfile 包装 + x11grab mjpeg 管道）——帧字节经 openPipe 直出
    const pipe = await backend.openPipe(boxId, {
      command: ['sh', '-c', `echo $$ > ${PIDFILE}; exec "$@"`, 'sh',
        'ffmpeg', '-nostdin', '-f', 'x11grab', '-draw_mouse', '1', '-framerate', '30',
        '-video_size', `${geo.stdout.trim().split(/\s+/).join('x')}`, '-i', DISPLAY,
        '-f', 'mjpeg', '-q:v', '5', 'pipe:1'],
      env: { DISPLAY },
    })
    let bytes = 0
    let done: (() => void) | null = null
    const enough = new Promise<void>((resolve) => {
      done = resolve
    })
    pipe.onData((chunk) => {
      bytes += chunk.length
      if (bytes > 100_000) done?.()
    })
    await Promise.race([enough, new Promise((_, reject) => setTimeout(() => reject(new Error(`实况 15s 仅 ${bytes} 字节；stderr：${pipe.stderrTail().slice(-200)}`)), 15_000))])
    pipe.close()
    // pidfile 精确补刀（坑⑯ SSH 版）+ 孤儿断言：杀后采集 pid 已不存在
    const pid = (await backend.exec(boxId, { command: ['cat', PIDFILE], timeoutMs: 10_000 })).stdout.trim()
    expect(pid).toMatch(/^\d+$/)
    await backend.exec(boxId, { command: ['sh', '-c', `kill -9 ${pid} 2>/dev/null; rm -f ${PIDFILE}`], timeoutMs: 10_000 })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const check = await backend.exec(boxId, {
      command: ['sh', '-c', `kill -0 ${pid} 2>/dev/null && echo alive || echo gone`],
      timeoutMs: 10_000,
    })
    expect(check.stdout.trim()).toBe('gone')
    await backend.teardown(boxId)
  }, 60_000)
})
