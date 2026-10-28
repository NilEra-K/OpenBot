/** cron 表单生成器纯函数（2026-10-28 v0.1.96）：生成矩阵 / clamp 收敛 / 反解析往返 /
 *  非生成器形态诚实降级 custom（内核仍是解析权威——此处只测渲染层转换） */
import { describe, expect, it } from 'vitest'
import { cronOfForm, formOfCron, DEFAULT_CRON_FORM, type CronFormState } from '../cron-form'

const form = (over: Partial<CronFormState>): CronFormState => ({ ...DEFAULT_CRON_FORM, ...over })

describe('cronOfForm（表单 → cron）', () => {
  it('五档生成：分钟步进 / 小时步进（含分位）/ 每天 / 每周（周几列表升序去重）/ 每月', () => {
    expect(cronOfForm(form({ freq: 'minutes', every: 15 }))).toBe('*/15 * * * *')
    expect(cronOfForm(form({ freq: 'hours', every: 2, hourMinute: 30 }))).toBe('30 */2 * * *')
    expect(cronOfForm(form({ freq: 'daily', atHour: 9, atMinute: 0 }))).toBe('0 9 * * *')
    expect(cronOfForm(form({ freq: 'weekly', weekdays: [5, 1, 3, 1], atHour: 9, atMinute: 30 }))).toBe('30 9 * * 1,3,5')
    expect(cronOfForm(form({ freq: 'weekly', weekdays: [0], atHour: 20, atMinute: 0 }))).toBe('0 20 * * 0') // 周日=0
    expect(cronOfForm(form({ freq: 'monthly', dayOfMonth: 1, atHour: 9 }))).toBe('0 9 1 * *')
    expect(cronOfForm(form({ freq: 'custom', custom: ' 0 9 * * 1-5 ' }))).toBe('0 9 * * 1-5')
  })

  it('非法值 clamp 收敛（输入框 min/max 之外的双保险——内核保存时仍终审）', () => {
    expect(cronOfForm(form({ freq: 'minutes', every: 0 }))).toBe('*/1 * * * *')
    expect(cronOfForm(form({ freq: 'daily', atHour: 99, atMinute: -5 }))).toBe('0 23 * * *')
    expect(cronOfForm(form({ freq: 'monthly', dayOfMonth: 0 }))).toBe('0 9 1 * *')
    expect(cronOfForm(form({ freq: 'weekly', weekdays: [] }))).toBe('0 9 * * *') // 空选集 → 每天（表单校验拦截保存）
  })
})

describe('formOfCron（cron → 表单：编辑回填）', () => {
  it('生成器五档全部可往返（cronOfForm → formOfCron 还原同档同参）', () => {
    const cases: CronFormState[] = [
      form({ freq: 'minutes', every: 15 }),
      form({ freq: 'hours', every: 2, hourMinute: 30 }),
      form({ freq: 'daily', atHour: 9, atMinute: 5 }),
      form({ freq: 'weekly', weekdays: [1, 3, 5], atHour: 9, atMinute: 30 }),
      form({ freq: 'weekly', weekdays: [0], atHour: 20 }),
      form({ freq: 'monthly', dayOfMonth: 15, atHour: 8, atMinute: 45 }),
    ]
    for (const c of cases) {
      expect(formOfCron(cronOfForm(c))).toEqual(c)
    }
  })

  it('非生成器形态诚实降级 custom（原文保真——范围/越界周值/分钟列表/月字段/六段/垃圾）', () => {
    for (const cron of ['*/15 9-17 * * 1-5', '0 9 * * 1,7', '1,15 * * * *', '0 9 * 3 *', '0 9 * * * *', 'not a cron']) {
      const f = formOfCron(cron)
      expect(f.freq).toBe('custom')
      expect(f.custom).toBe(cron)
    }
  })

  it('周六+周日（0,6）是生成器可产形态——按 weekly 回填而非降级', () => {
    const f = formOfCron('30 4 * * 0,6')
    expect(f.freq).toBe('weekly')
    expect(f.weekdays).toEqual([0, 6])
    expect(f.atHour).toBe(4)
    expect(f.atMinute).toBe(30)
  })

  it('全周日 0,1,2,3,4,5,6 回填 weekly 全选（语义等同每天——如实按生成器形态呈现）', () => {
    expect(formOfCron('0 9 * * 0,1,2,3,4,5,6').freq).toBe('weekly')
    expect(formOfCron('0 9 * * 0,1,2,3,4,5,6').weekdays).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
})
