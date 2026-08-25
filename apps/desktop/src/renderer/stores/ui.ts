/**
 * 渲染局部态 store（解耦纪律 #1 的另一半）：视图/选中/草稿——只影响呈现，永不出 UI 层。
 * 主题（日间/夜间/跟随系统）同为呈现层关注点：localStorage 持久化，不进内核 settings
 * （协议纯度：内核只传领域事实，外观偏好归渲染层）。
 */
import { defineStore } from 'pinia'

export type ViewName = 'console' | 'boxes' | 'tasks' | 'graph' | 'settings'
export type ThemePref = 'auto' | 'dark' | 'light'

const THEME_KEY = 'openbot.theme'

/** 读偏好（localStorage 不可用/值非法时静默回退默认夜间） */
const readStoredTheme = (): ThemePref => {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'auto' || v === 'dark' || v === 'light' ? v : 'dark'
  } catch {
    return 'dark'
  }
}

const writeStoredTheme = (pref: ThemePref): void => {
  try {
    localStorage.setItem(THEME_KEY, pref)
  } catch {
    /* 存不进即进程内存态（本次会话内仍可切换） */
  }
}

/** 系统主题（matchMedia 不可用的环境一律按夜间） */
const systemPrefersDark = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches

/** 偏好 → 实效主题（auto 的解析点；系统变化时由 initThemeWatch 重析） */
const resolveTheme = (pref: ThemePref): 'dark' | 'light' =>
  pref === 'auto' ? (systemPrefersDark() ? 'dark' : 'light') : pref

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
    /** 主题偏好（持久化）；dark 默认——既有观感不变 */
    theme: readStoredTheme() as ThemePref,
    /** 实效主题（auto 的解析结果；驱动 <html data-theme> 与标题栏切换图标） */
    effectiveTheme: resolveTheme(readStoredTheme()) as 'dark' | 'light',
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
    /** 解析偏好并应用到 <html data-theme>（CSS 变量块的门控；夜间为无属性的默认态） */
    applyTheme() {
      this.effectiveTheme = resolveTheme(this.theme)
      document.documentElement.dataset.theme = this.effectiveTheme
    },
    setTheme(pref: ThemePref) {
      this.theme = pref
      writeStoredTheme(pref)
      this.applyTheme()
    },
    /** 标题栏快捷切换：切到当前实效的反向（auto 下点击即转显式偏好——标准行为） */
    toggleTheme() {
      this.setTheme(this.effectiveTheme === 'dark' ? 'light' : 'dark')
    },
  },
})

/** 跟随系统的监听（App 挂载时注册一次）：系统主题变化时，auto 偏好下即时重析 */
export const initThemeWatch = (): void => {
  if (typeof matchMedia !== 'function') return
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const ui = useUiStore()
    if (ui.theme === 'auto') ui.applyTheme()
  })
}
