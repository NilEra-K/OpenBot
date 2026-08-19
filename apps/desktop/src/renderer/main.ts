/**
 * renderer 入口：Vue 3 + Pinia；本层无特权，只经环回网关说话（ARCHITECTURE.md §8）。
 * 五大视图由 prototype.html 演化（Step 8–9 逐视图迁移）。
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'

const app = createApp(App)
app.use(createPinia())
app.mount('#app')
