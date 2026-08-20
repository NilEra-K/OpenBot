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
    /** 审批弹窗「稍后处理」的 nonce（只影响弹窗呈现，不碰内核挂起；流内 gate 卡与角标仍可见） */
    dismissedApprovals: [] as string[],
    /** Box 操作台（VMware 控制台式大屏）：当前打开的 Box id；null = 关闭 */
    boxOps: null as string | null,
  }),
  actions: {
    switchView(view: ViewName) {
      this.currentView = view
    },
    openBoxOps(boxId: string) {
      this.boxOps = boxId
    },
    closeBoxOps() {
      this.boxOps = null
    },
    dismissApproval(nonce: string) {
      if (!this.dismissedApprovals.includes(nonce)) this.dismissedApprovals.push(nonce)
    },
    /** 审批终结（决议/消失）后清理稍后标记，防数组无限增长 */
    forgetApprovals(nonces: string[]) {
      this.dismissedApprovals = this.dismissedApprovals.filter((n) => !nonces.includes(n))
    },
  },
})
