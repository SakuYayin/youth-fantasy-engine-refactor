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
 *
 * 启动失败兜底（A-04）：`startRenderer()` 里的异常不再让窗口停在白屏上，
 * 而是挂 `BootError` 整屏页（上游 `src/App.tsx:460-476` 的 `if (bootError)` 分支）。
 * ⚠️ 只覆盖**渲染层同步启动**这一段；启动之后的异步失败（数据库打不开、
 * 服务被放弃重启）不走这里，它们从 IPC 回来，由 `AppState` 折算成
 * `SERVICE_UNAVAILABLE`/诊断文本进 footer（架构差异见台账 R-92）。
 */

import { createClient, type ClientTransport } from '@yfe/client-sdk'
import { createApp, h } from 'vue'

import App from './App.vue'
import { createAppState, type ProjectStorePort } from './app-state.js'
import BootError from './features/boot-error.vue'
import { toBootErrorView } from './features/boot-error-model.js'
import { createDemoProject } from './features/demo-project-port.js'
import { createFeaturePorts } from './features/ports.js'
import type { SettingsStorage } from './features/settings-store.js'
import { LOCAL_WORKSPACE_ID } from '../shared/local-workspace.js'

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

/**
 * 启动失败整屏页：白屏永远比一个有字的错误页更难排查。
 *
 * `onReload` 必须传 —— `BootError` 的「重新加载」按钮只在拿到回调时渲染
 * （组件不自己调 `location.reload()`，否则这条路径没法测）。
 */
function mountBootError(caught: unknown): void {
  const error = toBootErrorView(caught, {
    backupEntryAvailable: true,
    reloadAvailable: true,
  })
  const root = {
    render: () => h(BootError, { error, onReload: () => window.location.reload() }),
  }
  createApp(root).mount('#app')
}

/**
 * 设置存储：与作品记忆共用 localStorage。
 *
 * 与 `projectStore` 同样包 try/catch —— `file://` 源在隐私模式/配额异常时
 * 一读就抛 `SecurityError`，绝不能因此让界面起不来。
 */
function createSettingsStorage(): SettingsStorage {
  return {
    getItem(key: string): string | null {
      try {
        return window.localStorage.getItem(key)
      } catch {
        return null
      }
    },
    setItem(key: string, value: string): void {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        // 存不下就算了：本会话内设置仍生效（面板拿的是返回值），只是下次启动会回默认。
      }
    },
    removeItem(key: string): void {
      try {
        window.localStorage.removeItem(key)
      } catch {
        // 同上。
      }
    },
  }
}

function startRenderer(): void {
  const client = createClient(bridgeTransport())

  const state = createAppState({
    client,
    projectStore,
    newRequestId: () => crypto.randomUUID(),
    newSessionId: () => `ui_${crypto.randomUUID()}`,
  })

  const ports = createFeaturePorts({
    state,
    invoke: client,
    storage: createSettingsStorage(),
    newRequestId: () => crypto.randomUUID(),
    windowWidth: () => window.innerWidth,
    // 示范项目《吞天神脉》：45 次串行 IPC（1 作品 + 2 卷 + 21 章 + 21 正文），
    // 由向导的忙碌态兜住延迟。`client` 结构上同时满足 `DemoProjectInvoke`。
    createDemoProject: createDemoProject({
      invoke: client,
      workspaceId: LOCAL_WORKSPACE_ID,
      newRequestId: () => crypto.randomUUID(),
    }),
  })

  const app = createApp(App, { state, ports })
  app.mount('#app')

  // main 等待明确的保存结果，超时/失败由宿主提示继续编辑或放弃退出。
  window.yfe?.onBeforeClose(() => state.flush())

  /**
   * 卸载/关闭时**先冲刷**而不是 `dispose()`：dispose 会作废在途保存，
   * 那样防抖窗口里刚敲的字就真的没了。
   *
   * 关窗的主通道是上面那条 `onBeforeClose`（设计文档 02「关窗先询问未提交草稿并等待有限时间」）：
   * `main` 进程的 `close-guard.mjs` 拦住 `close` 事件 → 发 `yfe:before-close` 带 token →
   * 渲染层就是这条 `state.flush()` 的返回值 → `saved` 回给 main；**16s 内没拿到 `true`
   * 才弹原生「放弃草稿？」确认**。所以正常路径不会打扰用户（保存成功即静默退出），
   * 只有保存失败/超时才会问。
   *
   * 这里的 `beforeunload` 是**兜底**：它覆盖 `close` 拦截之外的离开路径
   * （开发者重载、崩溃恢复前的最后一次机会）。浏览器不允许在 `beforeunload` 里等异步结果，
   * 所以只能"尽力冲刷"，不能指望它一定是最后一次保存。
   */
  window.addEventListener('beforeunload', () => {
    void state.flush()
  })
}

try {
  startRenderer()
} catch (caught) {
  mountBootError(caught)
}