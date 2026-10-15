import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCloseGuard } from '../src/main/close-guard.mjs'

afterEach(() => vi.useRealTimers())

describe('关窗保存握手', () => {
  it('等待保存成功后才关闭，重复关窗共享同一次请求', async () => {
    let resolveSave: (saved: boolean) => void = () => {}
    const flush = vi.fn(() => new Promise<boolean>((resolve) => { resolveSave = resolve }))
    const close = vi.fn()
    const confirmDiscard = vi.fn()
    const guard = createCloseGuard({ flush, close, confirmDiscard })
    const first = guard.request()
    const second = guard.request()
    await Promise.resolve()
    expect(close).not.toHaveBeenCalled()
    resolveSave(true)
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(confirmDiscard).not.toHaveBeenCalled()
  })

  it('失败且用户继续编辑时不关闭；重试成功可以退出', async () => {
    const flush = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const close = vi.fn()
    const guard = createCloseGuard({ flush, close, confirmDiscard: async () => false })
    expect(await guard.request()).toBe(false)
    expect(close).not.toHaveBeenCalled()
    expect(guard.allowed).toBe(false)
    expect(await guard.request()).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('冲刷挂起有期限，超时后仍以用户选择决定是否退出', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    const guard = createCloseGuard({ flush: () => new Promise(() => {}), close,
      confirmDiscard: async () => true, timeoutMs: 20 })
    const request = guard.request()
    await vi.advanceTimersByTimeAsync(20)
    expect(await request).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
