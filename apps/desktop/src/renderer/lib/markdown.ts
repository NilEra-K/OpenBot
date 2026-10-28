/**
 * markdown 安全渲染：agent 回复按 markdown 渲染（markdown-it）+ DOMPurify 清洗。
 * 内核与模型输出都是不可信输入——XSS 面收敛在此（CSP 是第二道防线）。
 * @提及高亮（P4 Step 4）：经 inline 规则在 token 层注入（放在 link 前、backticks 后——
 * 行内代码已被 backticks 消费，@ 不会在 code 内误高亮）；span/class 进 DOMPurify 白名单。
 */
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

const md = new MarkdownIt({
  html: false, // 不允许内嵌 HTML（DOMPurify 再兜一层）
  linkify: true,
  breaks: true,
})

/** 本轮渲染的名册命中面（renderMarkdown 入参注入；同步渲染无并发问题） */
let currentMentions: ReadonlySet<string> = new Set()

md.inline.ruler.before('link', 'ob_mention', (state, silent) => {
  if (state.src[state.pos] !== '@') return false
  // 前一字符须为行首或非名字字符（中文标点后命中——「，@名字」高频写法；字母数字前不命中防邮箱）
  if (state.pos > 0 && /[一-龥A-Za-z0-9]/.test(state.src[state.pos - 1] ?? '')) return false
  const m = /^@([一-龥A-Za-z0-9]+)/.exec(state.src.slice(state.pos))
  if (!m || !currentMentions.has(m[1]!)) return false
  if (!silent) {
    const token = state.push('html_inline', '', 0)
    token.content = `<span class="mention">@${m[1]}</span>`
  }
  state.pos += m[0].length
  return true
})

/** 渲染为可直接 v-html 的安全 HTML；mentionNames=名册命中面（缺席则不高亮） */
export function renderMarkdown(text: string, mentionNames?: ReadonlySet<string>): string {
  currentMentions = mentionNames ?? new Set()
  return DOMPurify.sanitize(md.render(text), {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li',
      'blockquote', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'del',
      'span',
    ],
    ALLOWED_ATTR: ['href', 'title', 'class'],
  })
}

/** 浮层 inline 渲染器（2026-10-28 v0.1.95 HelpTip 用）：只开行内强调/代码——链接与图片禁用
 *  （300px hover 浮层里链接点不到、块级是反模式）；独立实例（不碰消息链的 mention/linkify 配置） */
const tipMd = new MarkdownIt({ html: false, linkify: false, breaks: false })
tipMd.disable(['link', 'image', 'autolink'])

/** 单段文案 → inline 级安全 HTML（粗体/行内代码；供 HelpTip v-html——DOMPurify 清洗，
 *  浏览器 DOM 环境；node 单测用 renderInlineMarkdownRaw 覆盖规则面） */
export function renderInlineMarkdown(text: string): string {
  return DOMPurify.sanitize(tipMd.renderInline(text), {
    ALLOWED_TAGS: ['strong', 'em', 'code'],
    ALLOWED_ATTR: [],
  })
}

/** 同上但未清洗（node 单测用——vitest 无 DOM 环境，DOMPurify 绑定缺席；html:false 已转义
 *  裸 HTML，清洗面由 E2E 真渲染链覆盖） */
export function renderInlineMarkdownRaw(text: string): string {
  return tipMd.renderInline(text)
}
