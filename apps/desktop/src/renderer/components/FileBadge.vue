<script setup lang="ts">
/**
 * 文件类型徽标（v0.1.104 三轮——用户 SVG 参照定稿）：圆角纸张 + 右上折角
 * （深色阴影面 + 半透明白翻折面）+ 白粗体扩展名居中（SVG text——随容器缩放）。
 * 类型主色鲜活色板（PDF 红/表格绿/文档蓝/幻灯橙/压缩琥珀/其余主题 accent）；
 * 折角阴影 = 主色叠 20% 黑（同款 #45B058→#349C42 的乘性关系）。
 */
import { computed } from 'vue'

const props = defineProps<{ name: string }>()

const ATT_TYPE_STYLES: Record<string, string> = {
  pdf: '#e5484d',
  xls: '#30a46c', xlsx: '#30a46c', csv: '#30a46c',
  doc: '#0090ff', docx: '#0090ff',
  ppt: '#f76b15', pptx: '#f76b15',
  zip: '#ffb224', rar: '#ffb224', '7z': '#ffb224',
}

const ext = computed(
  () => (props.name.includes('.') ? (props.name.split('.').pop() ?? '') : '').toLowerCase().slice(0, 4),
)
const bg = computed(() => ATT_TYPE_STYLES[ext.value] ?? 'var(--accent)')
const fontSize = computed(() => (ext.value.length >= 4 ? 205 : ext.value.length === 3 ? 250 : 290))
</script>

<template>
  <svg class="file-badge" viewBox="0 0 1024 1024" role="img" :aria-label="`文件类型 ${ext || 'FILE'}`">
    <!-- 纸体（圆角矩形，右上角被折角覆盖出斜边） -->
    <path
      d="M145.6 0C100.8 0 64 36.8 64 81.6v860.8C64 987.2 100.8 1024 145.6 1024h732.8c44.8 0 81.6-36.8 81.6-81.6V324.8L656 0H145.6z"
      :fill="bg"
    />
    <!-- 折角阴影面（主色加深——翻折下方的暗面） -->
    <path
      d="M960 326.4v16H755.2s-100.8-20.8-97.6-108.8c0 0 3.2 92.8 96 92.8H960z"
      fill="rgba(0,0,0,0.2)"
    />
    <!-- 翻折面（半透明白——纸背反光） -->
    <path d="M657.6 0v233.6c0 25.6 17.6 92.8 97.6 92.8H960L657.6 0z" fill="#FFFFFF" opacity=".5" />
    <!-- 扩展名（白粗体居中——长度自适应字号） -->
    <text
      x="512"
      y="742"
      text-anchor="middle"
      :font-size="fontSize"
      font-weight="700"
      fill="#FFFFFF"
      letter-spacing="8"
    >{{ (ext || 'file').toUpperCase() }}</text>
  </svg>
</template>

<style scoped>
.file-badge {
  display: block;
  width: 100%;
  height: 100%;
}

.file-badge text {
  font-family: inherit;
}
</style>
