/**
 * Toast 轻提示 store（P4 Step 2）：全局动作反馈通道——「操作成功无反馈」的静默现状的补位。
 * 队列语义：多条共存堆叠（不互相顶掉），各自 2.8s 自动消退（danger 4.2s 多留阅读时间）。
 * 渲染局部态（呈现关注点，解耦纪律 #1——不进内核）；reduced-motion 由 App 全局媒体查询降级（动画关）。
 */
import { defineStore } from 'pinia'

export interface ToastItem {
  id: number
  text: string
  kind: 'info' | 'success' | 'danger'
}

let seq = 0

export const useToastStore = defineStore('toast', {
  state: () => ({ items: [] as ToastItem[] }),
  actions: {
    /** 推入轻提示；ttl 缺省按 kind 取（info/success 2.8s，danger 4.2s） */
    push(text: string, kind: ToastItem['kind'] = 'info', ttl?: number) {
      const id = ++seq
      this.items.push({ id, text, kind })
      window.setTimeout(() => this.dismiss(id), ttl ?? (kind === 'danger' ? 4200 : 2800))
    },
    dismiss(id: number) {
      this.items = this.items.filter((t) => t.id !== id)
    },
  },
})
