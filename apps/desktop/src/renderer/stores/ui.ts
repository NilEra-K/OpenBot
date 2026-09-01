/**
 * 渲染局部态 store（解耦纪律 #1 的另一半）：视图/选中/草稿——只影响呈现，永不出 UI 层。
 * 主题（日间/夜间/跟随系统）同为呈现层关注点：localStorage 持久化，不进内核 settings
 * （协议纯度：内核只传领域事实，外观偏好归渲染层）。
 */
import { defineStore } from 'pinia'

export type ViewName = 'console' | 'boxes' | 'tasks' | 'graph' | 'rooms' | 'settings'
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
    /** console 视图当前对话的 agent（默认管家）；群会话时置空（activeGroupId 在场） */
    activeAgentId: 'steward' as string,
    /** 群会话（P5 Step 4）：非空=群聊流（与 activeAgentId 互斥——openGroup/openAgent 维护） */
    activeGroupId: null as string | null,
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
    /** 命令面板（P4 Step 3）：Ctrl K / 标题栏 omnibox 唤起 */
    paletteOpen: false,
    /** 新建 agent 向导（P4 Step 5）：名册「+ 新建 agent」与命令面板动作共用开合 */
    wizardOpen: false,
    /** 建群向导（P5 Step 4）：名册「+ 建群」与命令面板动作共用开合 */
    groupWizardOpen: false,
    /** ctx 实况面板收起（P4 Step 6，原型 .console.no-ctx 语义）：三栏 ⇄ 两栏 */
    ctxCollapsed: false,
    /** ctx 档案模式（P4 Step 7，原型 ctxMode='settings'）：false=屏幕实况 / true=该会话的档案；
     *  会话局部态——切会话回屏幕模式（App 层 activeAgentId watch 重置） */
    ctxSettings: false,
    /** 会话未读计数（P4 Step 6）：呈现关注点不进内核——非当前会话有 agent 回复 +1，切换会话清零 */
    unread: {} as Record<string, number>,
    /** composer 聚焦请求（「快速派单」跨组件聚焦没有句柄——标志位由 ConsoleView 消费：
     *  视图重挂载场景（从其他视图派单回 console）watcher 错过事件，挂载时兜底检查） */
    composerFocus: false,
  }),
  actions: {
    switchView(view: ViewName) {
      this.currentView = view
    },
    /** 进入 agent 会话（P5 Step 4：与群会话互斥） */
    openAgent(agentId: string) {
      this.activeAgentId = agentId
      this.activeGroupId = null
    },
    /** 进入群会话（P5 Step 4）：agent 会话清空；未读按群键清零；档案是会话局部态切群回屏幕 */
    openGroup(groupId: string) {
      this.activeGroupId = groupId
      this.activeAgentId = ''
      this.clearUnread(groupId)
      this.ctxSettings = false
    },
    openPalette() {
      this.paletteOpen = true
    },
    closePalette() {
      this.paletteOpen = false
    },
    togglePalette() {
      this.paletteOpen = !this.paletteOpen
    },
    openWizard() {
      this.wizardOpen = true
    },
    closeWizard() {
      this.wizardOpen = false
    },
    openGroupWizard() {
      this.groupWizardOpen = true
    },
    closeGroupWizard() {
      this.groupWizardOpen = false
    },
    toggleCtx() {
      this.ctxCollapsed = !this.ctxCollapsed
    },
    /** 进入/退出档案模式（原型 toggleCtxSettings 同款语义）：面板收起时点击 = 展开并直接进入档案 */
    toggleCtxSettings() {
      if (this.ctxCollapsed) {
        this.ctxCollapsed = false
        this.ctxSettings = true
      } else {
        this.ctxSettings = !this.ctxSettings
      }
    },
    /** 非当前会话收到 agent 回复（App 层 watch 消息流驱动） */
    bumpUnread(agentId: string) {
      this.unread[agentId] = (this.unread[agentId] ?? 0) + 1
    },
    /** 进入会话即清零（读过语义只存在于呈现层） */
    clearUnread(agentId: string) {
      if (this.unread[agentId] !== undefined) delete this.unread[agentId]
    },
    /** 快速派单落点：ConsoleView 消费标志并聚焦输入框（重挂载由 onMounted 兜底） */
    focusComposer() {
      this.composerFocus = true
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
