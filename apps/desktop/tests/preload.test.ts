import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { IPC_METHODS } from '../src/shared/ipc/channels.js'

function sandbox() {
  const invoke = vi.fn(async () => ({ ok: true }))
  const send = vi.fn()
  const listeners = new Map<string, (...args: unknown[]) => void>()
  let bridge: { call: (method: string, payload: unknown) => Promise<unknown>; methods: readonly string[];
    onBeforeClose: (handler: () => Promise<boolean>) => () => void } | undefined
  const source = readFileSync(new URL('../src/preload/preload.cjs', import.meta.url), 'utf8')
  runInNewContext(source, {
    require(name: string) {
      if (name !== 'electron') throw new Error(`沙箱不能加载 ${name}`)
      return {
        contextBridge: { exposeInMainWorld: (_key: string, value: typeof bridge) => { bridge = value } },
        ipcRenderer: { invoke, send,
          on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
          removeListener: (event: string) => listeners.delete(event) },
      }
    },
  })
  if (!bridge) throw new Error('preload 未注入桥')
  return { bridge, invoke, send, listeners }
}

describe('沙箱 preload 实际执行', () => {
  it('只依赖 electron 即可注入桥，白名单与 TS 权威定义一致', async () => {
    const { bridge, invoke } = sandbox()
    expect(Array.from(bridge.methods)).toEqual(Array.from(IPC_METHODS))
    await bridge.call('getDocument', { documentId: 'doc_1' })
    expect(invoke).toHaveBeenCalledWith('yfe:invoke', { method: 'getDocument', payload: { documentId: 'doc_1' } })
    await bridge.call('readFile', {})
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('关窗仅回传保存布尔结果与关联 token，移除监听后不再响应', async () => {
    const { bridge, send, listeners } = sandbox()
    const stop = bridge.onBeforeClose(async () => true)
    listeners.get('yfe:before-close')?.({}, 'token_1')
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('yfe:close-result', { token: 'token_1', saved: true }))
    stop()
    expect(listeners.has('yfe:before-close')).toBe(false)
  })
})
