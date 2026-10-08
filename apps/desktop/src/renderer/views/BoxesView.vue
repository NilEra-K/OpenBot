<script setup lang="ts">
/**
 * 执行载体视图（prototype.html 迁移，v0.1.49 叙事迁移：本机沙箱 → 执行载体）：Box 卡列表 + caps 驱动按钮。
 * caps 纪律：快照按钮仅 caps.snapshot=true 渲染——永不出现「UI 有按钮但后端不支持」。
 * 资源仪表（Step 6）：v1.box.stats 最新值驱动，按在场字段渲染——缺席=后端不可测，不造假仪表
 * （WSL 只有磁盘 vhdx 真值；CPU/内存属 OCI 后端接入项）。宿主磁盘压力条同理纯事实呈现。
 */
import { computed, ref } from 'vue'
import { useKernelStore } from '../stores/kernel'
import { useUiStore } from '../stores/ui'
import { useToastStore } from '../stores/toast'

const kernel = useKernelStore()
const ui = useUiStore()
const toast = useToastStore()

const stateChip = (state: string): { cls: string; label: string } => {
  switch (state) {
    case 'active':
      return { cls: 'chip-accent', label: '运行中' }
    case 'sleeping':
      return { cls: '', label: '休眠' }
    case 'snapshot':
      return { cls: 'chip-success', label: '快照态' }
    // 未知状态兜底（v0.1.36 修：后端引入联合外值时整页炸——渲染层如实显示原始值不崩溃）
    default:
      return { cls: '', label: state }
  }
}

const sum = computed(() => {
  const by = { active: 0, sleeping: 0, snapshot: 0 }
  for (const b of kernel.boxes) by[b.state] += 1
  return by
})

/** 宿主剩余空间的呈现文案（GB 一位小数；压力文案归视图层——内核只发事实） */
const fmtGb = (bytes: number): string => `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`

/** 磁盘占用展示档（GB/MB 分档——vhdx 动辄 GB 级） */
const fmtMb = (mb: number): string => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`)

/** 内存上限事实（Step 7 色档分母）：spec.memoryMb 在场且用量也在场才成立——
 *  resourceLimits=false 的后端（WSL）spec 不带限额 / stats 无内存值，均如实返回 null（只报数值） */
const memLimitOf = (box: { boxId: string; memoryMb?: number }): number | null =>
  box.memoryMb !== undefined && kernel.boxStats[box.boxId]?.memoryMb !== undefined ? box.memoryMb : null

/** 内存用量占限额百分比（仅在有上限事实时调用——渲染路径已被 memLimitOf 守门） */
const memPctOf = (box: { boxId: string; memoryMb?: number }): number =>
  ((kernel.boxStats[box.boxId]?.memoryMb ?? 0) / (box.memoryMb ?? 1)) * 100

/** runId 的 agent 前缀（P1 约定 `${agentId}-run-N`；ConsoleView 同款推断） */
const agentOfRun = (runId?: string): string | null =>
  runId !== undefined && runId.includes('-run-') ? (runId.split('-run-')[0] ?? null) : null

/** 每盒归属 chip 事实（P4 Step 12，原型「卡帕工作中」语义）：roster.boxId 反查归属 agent ×
 *  runs 投影（有 running run 即工作中）——只在工作中呈现；空闲不渲染
 *  （归属常量事实已在 ctx 档案「Box 归属」kv，不重复；图谱状态点同源 runs 投影）。 */
const ownerChips = computed(() => {
  const working = new Set(kernel.runs.filter((r) => r.state === 'running').map((r) => r.agentId))
  const by: Record<string, { agentId: string; label: string }> = {}
  for (const a of kernel.roster) {
    if (a.boxId && working.has(a.agentId)) by[a.boxId] = { agentId: a.agentId, label: `${a.name ?? a.agentId}工作中` }
  }
  return by
})

/** 该 Box 最近完成的执行（倒序最多 3 条；进行中的以 started 兜底展示） */
const execsOf = (boxId: string) =>
  kernel.execs
    .filter((e) => e.boxId === boxId && (e.phase === 'finished' || e.exitCode === undefined))
    .slice(-3)
    .reverse()

// ---- 快照（caps 驱动的真实闭环：成功显示快照 id，失败就地提示） ----

const snapping = ref(new Set<string>())
const lastSnap = ref<Record<string, string>>({})
const snapError = ref<Record<string, string>>({})

const snapshot = async (boxId: string): Promise<void> => {
  if (snapping.value.has(boxId)) return
  snapping.value = new Set(snapping.value).add(boxId)
  delete snapError.value[boxId]
  try {
    lastSnap.value[boxId] = await kernel.snapshotBox(boxId)
    toast.push(`已创建快照 ${lastSnap.value[boxId]}（${boxId}）`, 'success')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    snapError.value[boxId] = msg
    toast.push(`快照失败：${msg}`, 'danger')
  } finally {
    const next = new Set(snapping.value)
    next.delete(boxId)
    snapping.value = next
  }
}

// ---- 快照链与回滚（P4 Step 9）：链是全局快照目录事实（wsl 导出 tar 无 Box 归属），
//      chips 展示在各卡上、回滚作用于该卡 Box——就近交互；二段确认防破坏性误触 ----

const recentSnaps = computed(() => kernel.snapshots.slice(0, 5))
const openSnap = ref<string | null>(null)
const confirmSnap = ref<string | null>(null)
const restoring = ref(new Set<string>())

const toggleSnap = (snapshotId: string): void => {
  confirmSnap.value = null
  openSnap.value = openSnap.value === snapshotId ? null : snapshotId
}

const snapOf = (snapshotId: string) => kernel.snapshots.find((s) => s.snapshotId === snapshotId)

const fmtSize = (b?: number): string =>
  b === undefined ? '' : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`

const fmtSnapTime = (t?: number): string =>
  t === undefined ? '' : new Date(t).toLocaleString('zh-CN', { hour12: false })

const doRestore = async (boxId: string, snapshotId: string): Promise<void> => {
  if (restoring.value.has(snapshotId)) return
  restoring.value = new Set(restoring.value).add(snapshotId)
  try {
    await kernel.restoreBox(boxId, snapshotId)
    toast.push(`${boxId} 已回滚到 ${snapshotId}`, 'success')
    openSnap.value = null
    confirmSnap.value = null
  } catch (err) {
    toast.push(`回滚失败：${err instanceof Error ? err.message : String(err)}`, 'danger')
  } finally {
    const next = new Set(restoring.value)
    next.delete(snapshotId)
    restoring.value = next
  }
}

// ---- 休眠/唤醒（P4 Step 8）：caps.suspendable 驱动；状态转移经 v1.box.state 事件回放（卡 chip 同源刷新） ----

const suspending = ref(new Set<string>())

const toggleSleep = async (boxId: string, sleeping: boolean): Promise<void> => {
  if (suspending.value.has(boxId)) return
  suspending.value = new Set(suspending.value).add(boxId)
  try {
    if (sleeping) {
      await kernel.resumeBox(boxId)
      toast.push(`${boxId} 已唤醒`, 'success')
    } else {
      await kernel.pauseBox(boxId)
      toast.push(`${boxId} 已休眠——CPU/内存释放，rootfs 留在磁盘`, 'info')
    }
  } catch (err) {
    toast.push(`${sleeping ? '唤醒' : '休眠'}失败：${err instanceof Error ? err.message : String(err)}`, 'danger')
  } finally {
    const next = new Set(suspending.value)
    next.delete(boxId)
    suspending.value = next
  }
}

</script>

<template>
  <section class="view view-scroll">
    <div class="view-head">
      <div class="view-title">Box · 执行载体</div>
      <div class="view-sub">
        agent 的执行载体一览：本地容器、远程主机、宿主屏幕——按各自绑定呈现，未绑定的 agent 用默认沙箱（本地容器不可用时为模拟环境）。按钮按载体能力声明渲染，不支持的操作永不出现。
      </div>
      <div v-if="kernel.caps" class="view-toolbar mono">
        <span>默认沙箱 caps：</span>
        <span>快照 <b>{{ kernel.caps.snapshot ? '✓' : '✗' }}</b></span>
        <span>常驻 <b>{{ kernel.caps.persistent ? '✓' : '✗' }}</b></span>
        <span>无头 <b>{{ kernel.caps.headless ? '✓' : '✗' }}</b></span>
        <span>资源限额 <b>{{ kernel.caps.resourceLimits ? '✓' : '✗' }}</b></span>
        <span>隔离 <b>{{ kernel.caps.isolation }}</b></span>
      </div>
    </div>

    <div class="boxes">
      <!-- 宿主磁盘压力条（Step 6）：warn/critical 档才出现；纯事实（剩余/总量），文案在此组合 -->
      <div v-if="kernel.pressure" class="disk-banner" :class="kernel.pressure.level" role="alert">
        <span class="stat-dot err"></span>
        <b>{{ kernel.pressure.level === 'critical' ? '磁盘空间严重不足' : '磁盘空间偏低' }}</b>
        <span class="mono">剩余 {{ fmtGb(kernel.pressure.freeBytes) }} / {{ fmtGb(kernel.pressure.totalBytes) }}</span>
        <span class="disk-banner-note">本地容器的 vhdx、快照与 transcript 都写此卷——远程与屏幕载体不占此盘；请清理后再继续派活</span>
      </div>

      <div class="box-sum mono">
        <span>{{ kernel.boxes.length }} Box</span>
        <span>运行 {{ sum.active }}</span>
        <span>休眠 {{ sum.sleeping }}</span>
        <span>快照态 {{ sum.snapshot }}</span>
      </div>
      <!-- 说明文字独立次行（v0.1.42 UI 精雕：原挤在统计行内权重失衡） -->
      <div class="box-sum-note">仪表按各载体可测维度呈现（本地容器：磁盘；CPU/内存属容器后端；远程/屏幕载体无本地仪表）</div>

      <div class="box-grid">
        <div v-for="box in kernel.boxes" :key="box.boxId" class="boxcard">
          <div class="box-head">
            <div class="box-ico" aria-hidden="true"></div>
            <div class="box-id">
              <div class="box-name mono">{{ box.boxId }}</div>
              <div class="box-sub">image={{ box.image }} · {{ box.state }}</div>
            </div>
            <span class="chip" :class="stateChip(box.state).cls">{{ stateChip(box.state).label }}</span>
            <span v-if="ownerChips[box.boxId]" class="chip" title="归属 agent 正在此 Box 工作">
              <span class="stat-dot" :style="{ background: kernel.colorOf(ownerChips[box.boxId]!.agentId) }"></span>
              {{ ownerChips[box.boxId]!.label }}
            </span>
            <div class="box-actions">
              <button class="btn btn-secondary btn-sm" @click="ui.openBoxOps(box.boxId)">操作台</button>
              <button
                v-if="kernel.caps?.suspendable"
                class="btn btn-secondary btn-sm"
                :disabled="suspending.has(box.boxId)"
                @click="toggleSleep(box.boxId, box.state === 'sleeping')"
              >
                {{ suspending.has(box.boxId) ? '处理中…' : box.state === 'sleeping' ? '唤醒' : '休眠' }}
              </button>
              <button
                v-if="kernel.caps?.snapshot"
                class="btn btn-secondary btn-sm"
                :disabled="snapping.has(box.boxId)"
                @click="snapshot(box.boxId)"
              >
                {{ snapping.has(box.boxId) ? '快照中…' : '快照' }}
              </button>
            </div>
          </div>

          <!-- 资源仪表（Step 6）：字段在场才渲染（缺席=不可测，不造假）。CPU 百分比自带 0-100 真比例画条；
               内存比例条（Step 7 色档解锁）：用量 ∩ spec.memoryMb 真限额都在场才画（分母是 resourceLimits
               后端 --memory 落地值），≥80% 转 warn 色；上限缺席维持只报数值（Step 10 纪律：无上限事实不画
               假比例）。磁盘无上限事实不变。WSL 的 stats 无 cpu/mem 字段自然不渲染。 -->
          <div v-if="kernel.boxStats[box.boxId]" class="box-gauges">
            <div
              v-if="kernel.boxStats[box.boxId]!.cpuPercent !== undefined"
              class="gauge"
              :class="{ 'gauge-warn': kernel.boxStats[box.boxId]!.cpuPercent! >= 80 }"
            >
              <span class="gauge-k">CPU</span>
              <span class="gauge-bar"><span class="gauge-fill" :style="{ width: `${Math.min(100, kernel.boxStats[box.boxId]!.cpuPercent!)}%` }"></span></span>
              <span class="gauge-v mono">{{ Math.round(kernel.boxStats[box.boxId]!.cpuPercent!) }}%</span>
            </div>
            <div v-if="memLimitOf(box)" class="gauge" :class="{ 'gauge-warn': memPctOf(box) >= 80 }">
              <span class="gauge-k">内存</span>
              <span class="gauge-bar"><span class="gauge-fill" :style="{ width: `${Math.min(100, memPctOf(box))}%` }"></span></span>
              <span class="gauge-v mono">{{ fmtMb(kernel.boxStats[box.boxId]!.memoryMb!) }} / {{ fmtMb(memLimitOf(box)!) }}</span>
            </div>
            <div v-else-if="kernel.boxStats[box.boxId]!.memoryMb !== undefined" class="gauge gauge--plain">
              <span class="gauge-k">内存</span>
              <span class="gauge-v mono">{{ fmtMb(kernel.boxStats[box.boxId]!.memoryMb!) }}</span>
            </div>
            <div v-if="kernel.boxStats[box.boxId]!.diskMb !== undefined" class="gauge gauge--plain">
              <span class="gauge-k">磁盘</span>
              <span class="gauge-v mono">{{ fmtMb(kernel.boxStats[box.boxId]!.diskMb!) }}</span>
            </div>
          </div>

          <div class="box-snaps mono">
            <!-- 快照链 chips（全局事实、就近回滚）：点击展开详情，不直接触发回滚 -->
            <button
              v-for="s in recentSnaps"
              :key="s.snapshotId"
              class="snap-chip"
              :class="{ 'is-open': openSnap === s.snapshotId }"
              type="button"
              :title="`快照 ${s.snapshotId}${fmtSize(s.sizeBytes) ? ' · ' + fmtSize(s.sizeBytes) : ''}——点击查看`"
              @click="toggleSnap(s.snapshotId)"
            >{{ s.snapshotId }}</button>
            <span v-if="lastSnap[box.boxId]" class="chip chip-success">最近快照 {{ lastSnap[box.boxId] }}</span>
            <span v-if="snapError[box.boxId]" class="chip chip-danger">{{ snapError[box.boxId] }}</span>
          </div>

          <!-- 快照详情 + 回滚二段确认（破坏性防护：先看时间/大小再决定——确认条二次点击才执行） -->
          <div v-if="openSnap && snapOf(openSnap)" class="snap-detail">
            <div class="sd-meta mono">
              <b>{{ openSnap }}</b>
              <span>{{ fmtSnapTime(snapOf(openSnap)!.createdAt) || '时间未知' }}</span>
              <span>{{ fmtSize(snapOf(openSnap)!.sizeBytes) || '大小未知' }}</span>
            </div>
            <div v-if="confirmSnap === openSnap" class="sd-confirm" role="alert">
              <span>当前 {{ box.boxId }} 的内容将被快照内容替换（不可撤销）</span>
              <button class="btn btn-danger btn-sm" :disabled="restoring.has(openSnap)" @click="doRestore(box.boxId, openSnap)">
                {{ restoring.has(openSnap) ? '回滚中…' : '确认回滚' }}
              </button>
              <button class="btn btn-ghost btn-sm" @click="confirmSnap = null">取消</button>
            </div>
            <button v-else class="btn btn-danger-ghost btn-sm" @click="confirmSnap = openSnap">从快照回滚…</button>
          </div>

          <div v-if="execsOf(box.boxId).length" class="box-execs">
            <div class="box-execs-label">近期执行</div>
            <div v-for="e in execsOf(box.boxId)" :key="e.key" class="box-exec mono">
              <span class="stat-dot" :class="e.phase === 'finished' ? (e.exitCode === 0 ? 'ok' : 'err') : 'working'"></span>
              <span v-if="agentOfRun(e.runId)" class="box-exec-agent" :style="{ color: kernel.colorOf(agentOfRun(e.runId)!) }">
                {{ agentOfRun(e.runId) }}
              </span>
              <span class="box-exec-cmd">{{ e.command.join(' ') }}</span>
              <span v-if="e.phase === 'finished' && e.exitCode !== undefined" class="box-exec-exit">exit {{ e.exitCode }}</span>
            </div>
          </div>
        </div>
      </div>

      <p v-if="kernel.boxes.length === 0" class="placeholder">暂无 Box——注册 agent 时按其绑定的载体创建；未绑定则用默认沙箱（本地容器不可用时为模拟环境）</p>

      <div class="box-claim">
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linejoin="round"
          aria-hidden="true"
        ><path d="M12 3l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6l7-3z"></path></svg>
        <span>Box 是 agent 的执行载体（本地容器 / 远程主机 / 宿主屏幕）。容器与远程主机内 agent 自由执行，触碰宿主文件或出网经审批闸逐条批准（对话流内 gate 卡）；宿主屏幕载体零隔离——agent 的每次屏幕注入均逐条过闸。</span>
      </div>
    </div>
  </section>
</template>

<style scoped src="./boxes.css"></style>
