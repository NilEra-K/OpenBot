/**
 * cron 表单生成器（2026-10-28 v0.1.96 用户报障「cron 对用户太困难」）：
 * 表单态 ↔ 五段 cron 的纯转换——存储与内核零变化（落盘仍是 cron 串，内核 v1.automations.*
 * 仍是解析/校验的唯一权威，renderer 不 import 内核包）。反解析只认本生成器能产出的形态；
 * 更复杂的表达式（范围/列表/月字段等）→ freq='custom' 原文展示（诚实降级不硬猜）。
 */

export type CronFreq = 'minutes' | 'hours' | 'daily' | 'weekly' | 'monthly' | 'custom'

export interface CronFormState {
  freq: CronFreq
  /** minutes 档：每隔 N 分钟（1-59）；hours 档：每隔 N 小时（1-23） */
  every: number
  /** hours 档：在每小时的第 M 分（0-59） */
  hourMinute: number
  /** daily/weekly/monthly 档：时刻——时（0-23） */
  atHour: number
  /** daily/weekly/monthly 档：时刻——分（0-59） */
  atMinute: number
  /** weekly 档：周几多选（cron dow 值：1=一 … 6=六、0=日；去重升序） */
  weekdays: number[]
  /** monthly 档：每月几号（1-31） */
  dayOfMonth: number
  /** custom 档：手输原文 */
  custom: string
}

export const DEFAULT_CRON_FORM: CronFormState = {
  freq: 'daily',
  every: 15,
  hourMinute: 0,
  atHour: 9,
  atMinute: 0,
  weekdays: [1],
  dayOfMonth: 1,
  custom: '',
}

/** 常用预设（点击填**表单态**而非塞字符串——后续仍可改字段微调） */
export const CRON_PRESETS: Array<{ label: string; form: Partial<CronFormState> }> = [
  { label: '每天 9:00', form: { freq: 'daily', atHour: 9, atMinute: 0 } },
  { label: '工作日 9:00', form: { freq: 'weekly', weekdays: [1, 2, 3, 4, 5], atHour: 9, atMinute: 0 } },
  { label: '每 15 分钟', form: { freq: 'minutes', every: 15 } },
  { label: '每小时整点', form: { freq: 'hours', every: 1, hourMinute: 0 } },
  { label: '每周一 9:00', form: { freq: 'weekly', weekdays: [1], atHour: 9, atMinute: 0 } },
  { label: '每月 1 号 9:00', form: { freq: 'monthly', dayOfMonth: 1, atHour: 9, atMinute: 0 } },
]

const clamp = (v: number, lo: number, hi: number): number => {
  const n = Math.round(Number.isFinite(v) ? v : lo)
  return Math.min(hi, Math.max(lo, n))
}

/** 表单 → cron（非法值收敛到最近合法值——输入框已限 min/max，此处双保险；内核保存时仍终审） */
export function cronOfForm(f: CronFormState): string {
  const mm = (v: number): string => String(clamp(v, 0, 59))
  const hh = (v: number): string => String(clamp(v, 0, 23))
  switch (f.freq) {
    case 'minutes':
      return `*/${clamp(f.every, 1, 59)} * * * *`
    case 'hours':
      return `${mm(f.hourMinute)} */${clamp(f.every, 1, 23)} * * *`
    case 'daily':
      return `${mm(f.atMinute)} ${hh(f.atHour)} * * *`
    case 'weekly': {
      const days = [...new Set(f.weekdays)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b)
      // 空选集时 dow 落 *（=每天）——表单校验拦截保存（automationValid），此处只保证产物可解析
      return `${mm(f.atMinute)} ${hh(f.atHour)} * * ${days.length > 0 ? days.join(',') : '*'}`
    }
    case 'monthly':
      return `${mm(f.atMinute)} ${hh(f.atHour)} ${clamp(f.dayOfMonth, 1, 31)} * *`
    default:
      return f.custom.trim()
  }
}

/**
 * cron → 表单（编辑既有规则的回填）。只认本生成器产出的形态（单值/单一步进/逗号列表的
 * 周几）；其余（范围、复杂列表、月字段、六段等）→ custom 原文——用户看到的是真值不是猜测。
 */
export function formOfCron(cron: string): CronFormState {
  const t = cron.trim()
  const base = { ...DEFAULT_CRON_FORM }
  const parts = t.split(/\s+/)
  if (parts.length !== 5) return { ...base, freq: 'custom', custom: t }
  const [mi, ho, dom, mon, dow] = parts as [string, string, string, string, string]
  if (mon !== '*') return { ...base, freq: 'custom', custom: t }
  if (/^\*\/(\d+)$/.test(mi) && ho === '*' && dom === '*' && dow === '*') {
    return { ...base, freq: 'minutes', every: Number.parseInt(mi.slice(2), 10) }
  }
  if (/^\d+$/.test(mi) && /^\*\/(\d+)$/.test(ho) && dom === '*' && dow === '*') {
    return { ...base, freq: 'hours', hourMinute: Number.parseInt(mi, 10), every: Number.parseInt(ho.slice(2), 10) }
  }
  if (/^\d+$/.test(mi) && /^\d+$/.test(ho) && dom === '*') {
    const atMinute = Number.parseInt(mi, 10)
    const atHour = Number.parseInt(ho, 10)
    if (dow === '*') return { ...base, freq: 'daily', atMinute, atHour }
    if (/^([0-6])(,[0-6])*$/.test(dow)) {
      const weekdays = dow.split(',').map((d) => Number.parseInt(d, 10))
      return { ...base, freq: 'weekly', atMinute, atHour, weekdays }
    }
  }
  if (/^\d+$/.test(mi) && /^\d+$/.test(ho) && /^\d+$/.test(dom) && dow === '*') {
    return {
      ...base,
      freq: 'monthly',
      atMinute: Number.parseInt(mi, 10),
      atHour: Number.parseInt(ho, 10),
      dayOfMonth: Number.parseInt(dom, 10),
    }
  }
  return { ...base, freq: 'custom', custom: t }
}
