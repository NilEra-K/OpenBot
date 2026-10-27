<script setup lang="ts">
/**
 * HelpTip（0.1.2 设置页改版）：节级解释性文字的收纳位——标题行 ⓘ 图标，hover/键盘聚焦展开
 * 纯 CSS 浮层。实测修两处（2026-09-01 用户报障）：点击图标后 :focus 常驻致提示不消失——
 * 只留 :focus-visible（键盘 Tab 才触发，鼠标点击不算）；向上展开会伸进 titlebar 被遮——
 * 改为向下展开（节标题下方恒有内容空间）。
 * up prop（2026-10-13 用户报障）：模态卡场景（新建 Agent 向导）方向反向——wiz-card 的
 * overflow:hidden 裁掉向下伸出卡底的浮层，而上方空间充足；传 up 向上展开。
 * 缺省向下，设置页零变化。
 * lines prop（2026-10-26 安装确认模态）：多条逐行呈现（一行一事实）；text 单串用例零变化。
 */
withDefaults(defineProps<{ text?: string; lines?: string[]; up?: boolean }>(), {
  text: '',
  lines: () => [],
  up: false,
})
</script>

<template>
  <span class="help-tip" :class="{ up }" tabindex="0" :aria-label="`说明：${lines.length > 0 ? lines.join('；') : text}`" role="note">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9.2" />
      <path d="M12 10.6v6" />
      <circle cx="12" cy="7.4" r="0.4" fill="currentColor" stroke="none" />
    </svg>
    <span class="help-tip-body">
      <template v-if="lines.length > 0"><div v-for="l in lines" :key="l">· {{ l }}</div></template>
      <template v-else>{{ text }}</template>
    </span>
  </span>
</template>

<style scoped>
.help-tip {
  position: relative;
  display: inline-flex;
  align-items: center;
  color: var(--ink3);
  cursor: help;
  flex: none;
}

.help-tip:hover,
.help-tip:focus-visible {
  color: var(--accent);
  outline: none;
}

/* 浮层：向下展开（节标题下方恒有内容空间——向上会伸进 titlebar 被遮） */
.help-tip-body {
  position: absolute;
  left: 50%;
  transform: translateX(-50%) translateY(-6px);
  top: 100%;
  margin-top: 4px;
  width: max-content;
  max-width: 300px;
  padding: 9px 11px;
  border-radius: 9px;
  background: var(--bg3);
  border: 1px solid var(--line-strong);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.4);
  color: var(--ink2);
  font-size: 11.5px;
  line-height: 1.65;
  font-weight: 400;
  letter-spacing: normal;
  white-space: normal;
  text-align: left;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 140ms var(--ease), transform 140ms var(--ease);
  z-index: 40;
}

.help-tip:hover .help-tip-body,
.help-tip:focus-visible .help-tip-body {
  opacity: 1;
  visibility: visible;
  transform: translateX(-50%) translateY(0);
}

/* 向上展开（up，模态卡场景）：锚点翻转 + 入场位移反向——显式写全展开规则，
   不依赖与上方通用规则的级联顺序（同特异性时后者胜的隐式耦合不留给后人）。
   水平同步改左对齐（2026-10-13 目验实锤）：居中锚定时近 300px 浮层以 13px 图标为中点
   左伸越出 wiz-card 左缘，被 overflow:hidden 裁字——left:0 向右展开全程不出卡
   （图标居卡内 ~180px，300px 右缘 ~480px < 520 卡宽）；入场位移仅保留垂直分量 */
.help-tip.up .help-tip-body {
  top: auto;
  bottom: 100%;
  left: 0;
  margin-top: 0;
  margin-bottom: 4px;
  transform: translateY(6px);
}

.help-tip.up:hover .help-tip-body,
.help-tip.up:focus-visible .help-tip-body {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}
</style>
