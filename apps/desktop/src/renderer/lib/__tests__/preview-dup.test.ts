import { describe, expect, it } from 'vitest'
import { isPreviewDup } from '../preview-dup'

describe('正文预览幂等判据（v0.1.113 双气泡报障修复）', () => {
  it('全等 → 让位（v0.1.43 原语义保持）', () => {
    expect(isPreviewDup('目录是空的', '目录是空的')).toBe(true)
  })

  it('预览为终答前缀（WS 断线丢尾 chunk）→ 让位（报障核心场景）', () => {
    const final = '**画面主体**：一位年轻男性……顺带一提，这张应该就是你最初那条测试消息里附的那张照片。'
    expect(isPreviewDup(final, '**画面主体**：一位年轻男性……顺带一提，这')).toBe(true)
  })

  it('预览为终答超集（重连重放）→ 让位', () => {
    expect(isPreviewDup('终答全文', '终答全文（重放多收的尾部）')).toBe(true)
  })

  it('中间轮独立文本（非终答前缀）→ 不让位（过程事实保留，不误伤）', () => {
    expect(isPreviewDup('我来看一下目录。', '先检查环境：目录是空的，接下来读取配置')).toBe(false)
  })

  it('空/纯空白恒不让位（防空前缀 startsWith 恒真）', () => {
    expect(isPreviewDup('终答', '')).toBe(false)
    expect(isPreviewDup('', '预览')).toBe(false)
    expect(isPreviewDup('终答', '  \n ')).toBe(false)
  })

  it('trim 边界：首尾空白差异不影响前缀判定', () => {
    expect(isPreviewDup('终答全文\n', '  终答全文')).toBe(true)
  })

  it('收尾撞型恒不让位（v0.1.121 行为锚点）：拼接产源已由 seq 身份配对根除，后缀判据退休', () => {
    // 短终答撞中间轮收尾语——三形态判据本就不判
    expect(isPreviewDup('好的。', '我先检查目录，逐项核对后输出好的。')).toBe(false)
    // 长终答「恰为」中间轮收尾段——与拼接在文本上不可区分；身份配对根除产源后，
    // 宁可按「非重复」处理（中间轮是应保留的过程事实），不做后缀猜测
    const final = '这一轮的完整结论是：目录为空，没有任何可用的照片文件。'
    expect(isPreviewDup(final, '我先检查目录，最终发现这一轮的完整结论是：目录为空，没有任何可用的照片文件。')).toBe(false)
  })
})
