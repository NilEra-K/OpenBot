/**
 * markdown 安全渲染：agent 回复按 markdown 渲染（markdown-it）+ DOMPurify 清洗。
 * 内核与模型输出都是不可信输入——XSS 面收敛在此（CSP 是第二道防线）。
 */
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

const md = new MarkdownIt({
  html: false, // 不允许内嵌 HTML（DOMPurify 再兜一层）
  linkify: true,
  breaks: true,
})

/** 渲染为可直接 v-html 的安全 HTML */
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(md.render(text), {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li',
      'blockquote', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'del',
    ],
    ALLOWED_ATTR: ['href', 'title'],
  })
}
