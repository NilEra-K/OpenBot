/**
 * Toast 轻提示 store（P4 Step 2）：全局动作反馈通道——「操作成功无反馈」的静默现状的补位。
 * 队列语义：多条共存堆叠（不互相顶掉），各自自动消退（danger 4.2s / warning 3.6s / 其余 2.8s）。
 * 渲染局部态（呈现关注点，解耦纪律 #1——不进内核）；reduced-motion 由 App 全局媒体查询降级（动画关）。
 * warning 位（v0.1.98 方案 C+ 图标徽章体系新增）：黄色三角叹号——非致命但需用户知悉的提示。
 */
import { defineStore } from 'pinia'

export interface ToastItem {
  id: number
  text: string
  kind: 'info' | 'success' | 'danger' | 'warning'
}

let seq = 0

export const useToastStore = defineStore('toast', {
  state: () => ({ items: [] as ToastItem[] }),
  actions: {
    /** 推入轻提示；ttl 缺省按 kind 取（danger 4.2s / warning 3.6s / info·success 2.8s） */
    push(text: string, kind: ToastItem['kind'] = 'info', ttl?: number) {
      const id = ++seq
      this.items.push({ id, text, kind })
      window.setTimeout(() => this.dismiss(id), ttl ?? (kind === 'danger' ? 4200 : kind === 'warning' ? 3600 : 2800))
    },
    dismiss(id: number) {
      this.items = this.items.filter((t) => t.id !== id)
    },
  },
})
