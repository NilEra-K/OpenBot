/**
 * renderer 入口：Vue 3 + Pinia；本层无特权，只经环回网关说话（ARCHITECTURE.md §8）。
 * 五大视图由 prototype.html 演化（Step 8–9 逐视图迁移）。
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
// 中文统一字体（2026-10-18 用户裁定：拉丁走系统 Consolas，中文捆绑 Noto Sans SC 三平台一致）
// fontsource 按 unicode-range 分片，运行时只加载用到的区段
import '@fontsource/noto-sans-sc/400.css'
// 全局通用基座（v0.1.100 按钮族单一事实源——各视图 scoped 副本已删，详见 common.css 头注）
import './common.css'
import App from './App.vue'

const app = createApp(App)
app.use(createPinia())
app.mount('#app')
