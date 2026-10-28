/** 浮层 inline 渲染器（2026-10-28 v0.1.95 HelpTip）：只开行内粗体/代码——链接禁用、
 *  裸 HTML 转义（html:false）。node 环境测规则面（renderInlineMarkdownRaw）；DOMPurify
 *  清洗面由 E2E 真渲染链覆盖（vitest 无 DOM——绑定缺席，与 renderMarkdown 从未单测同因） */
import { describe, expect, it } from 'vitest'
import { renderInlineMarkdownRaw } from '../markdown'

describe('renderInlineMarkdownRaw（HelpTip 浮层规则面）', () => {
  it('行内代码与粗体：`code` → <code>；**词** → <strong>——命令/旗标可读性的目标面', () => {
    expect(renderInlineMarkdownRaw('先执行 `podman machine init` 再启动')).toBe(
      '先执行 <code>podman machine init</code> 再启动',
    )
    expect(renderInlineMarkdownRaw('**注意**：旗标 `--installation-dir=` 可选')).toBe(
      '<strong>注意</strong>：旗标 <code>--installation-dir=</code> 可选',
    )
  })

  it('链接禁用（浮层里点不到——原样字面呈现）；裸 HTML 转义不穿透（html:false）', () => {
    expect(renderInlineMarkdownRaw('参见 [文档](https://example.com)')).toBe('参见 [文档](https://example.com)')
    expect(renderInlineMarkdownRaw('<script>alert(1)</script>')).not.toContain('<script>')
    expect(renderInlineMarkdownRaw('<img src=x onerror=alert(1)>')).not.toContain('<img')
  })

  it('纯文本零变化（既有 text/lines 内容全为散文——单星单反引号不成对即字面）', () => {
    expect(renderInlineMarkdownRaw('一行一事实的短句。')).toBe('一行一事实的短句。')
    expect(renderInlineMarkdownRaw('50% 的 * 号')).toBe('50% 的 * 号')
  })
})
