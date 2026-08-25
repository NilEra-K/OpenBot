/**
 * @提及高亮 util（P4 Step 4）：转义后的纯文本包一层高亮 span——只用于
 * 用户消息与 A2A 中继行（纯文本路径，先转义再注入，零 XSS 面）。
 * agent 消息的高亮走 lib/markdown 的 inline 规则（代码块内天然不误伤）。
 */

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 名册内 @名字 → 高亮；名册外保持原样（不误伤普通文本里的 @）。
 *  前置字符须为行首或非名字字符——与 lib/markdown 的 inline 规则同一判定（中文标点后命中，防邮箱）。 */
export const mentionify = (raw: string, names: ReadonlySet<string>): string =>
  escapeHtml(raw).replace(
    /(^|[^一-龥A-Za-z0-9])@([一-龥A-Za-z0-9]+)/g,
    (whole, pre: string, name: string) => (names.has(name) ? `${pre}<span class="mention">@${name}</span>` : whole),
  )
