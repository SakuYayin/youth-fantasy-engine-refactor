/**
 * 渲染层入口（Vite 入口，被 `index.html` 引用）。
 *
 * 三件事：
 * 1. 把 preload 暴露的 `window.yfe.call` 包成 `ClientTransport`，交给
 *    `@yfe/client-sdk` 做信封校验/超时/白名单（渲染层不自己解析 IPC 信封）；
 * 2. 组装 `AppState`（当前作品记忆放 localStorage：Electron 下是 file:// 源）；
 * 3. 挂载 `App.vue`，并把 state 作为 prop 传入 —— 组件不 new 全局单例，
 *    这样组件测试可以塞一个假 state。
 *
 * 注意：**没有 window.yfe 时不能假装成功**。纯浏览器打开这个页面会走
 * `ClientTransport` 抛错路径，UI 会显示"连不上服务"，而不是空白页。
 */

import { createClient, type ClientTransport } from '@yfe/client-sdk'
import { createApp } from 'vue'

import App from './App.vue'
import { createAppState, type ProjectStorePort } from './app-state.js'

const PROJECT_KEY = 'yfe.currentProjectId'

/**
 * 当前作品的记忆位置。
 *
 * `localStorage` 在沙箱渲染进程里可用；取用异常（隐私模式/配额）一律降级成
 * "没记住"，绝不能因为存储异常让整个界面起不来。
 */
const projectStore: ProjectStorePort = {
  read(): string | null {
    try {
      return window.localStorage.getItem(PROJECT_KEY)
    } catch {
      return null
    }
  },
  write(projectId: string | null): void {
    try {
      if (projectId === null) window.localStorage.removeItem(PROJECT_KEY)
      else window.localStorage.setItem(PROJECT_KEY, projectId)
    } catch {
      // 记不住就算了：下次启动会回到空态，数据本身没问题。
    }
  },
}

function bridgeTransport(): ClientTransport {
  return {
    async call(method: string, payload: unknown): Promise<unknown> {
      const bridge = window.yfe
      if (bridge === undefined) {
        throw new Error('当前不在 Electron 宿主内：window.yfe 不存在')
      }
      return await bridge.call(method, payload)
    },
  }
}

const state = createAppState({
  client: createClient(bridgeTransport()),
  projectStore,
  newRequestId: () => crypto.randomUUID(),
  newSessionId: () => `ui_${crypto.randomUUID()}`,
})

const app = createApp(App, { state })
app.mount('#app')

/**
 * 卸载/关闭时**先冲刷**而不是 `dispose()`：dispose 会作废在途保存，
 * 那样防抖窗口里刚敲的字就真的没了。
 *
 * TODO(P1-B1)：设计文档 02 要求"关窗先询问未提交草稿并等待有限时间"，
 * 那需要 main 进程的 `close` 拦截 + 一条 flush 请求通道；
 * 现在只做到"尽力冲刷"（`beforeunload` 里无法可靠等待异步结果）。
 */
window.addEventListener('beforeunload', () => {
  void state.flush()
})
