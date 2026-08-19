/**
 * 渲染局部态 store（解耦纪律 #1 的另一半）：视图/选中/草稿——只影响呈现，永不出 UI 层。
 */
import { defineStore } from 'pinia'

export type ViewName = 'console' | 'boxes' | 'tasks' | 'graph' | 'settings'

export const useUiStore = defineStore('ui', {
  state: () => ({
    currentView: 'console' as ViewName,
    /** console 视图当前对话的 agent（默认管家） */
    activeAgentId: 'steward' as string,
    /** 输入草稿（视图切换不丢） */
    draft: '',
  }),
  actions: {
    switchView(view: ViewName) {
      this.currentView = view
    },
  },
})
