/**
 * budget 单测 —— 上游 `tests/tavernPrompt.test.ts` §8/§9 与 `tests/tavernUsage.test.ts`
 * 前半段（纯函数部分）的 vitest 重写版。
 *
 * 上游后半段依赖 db / seedData 的落库断言本批搬不了，这里只覆盖纯函数契约：
 * 裁剪规则（**首条开场永不裁**）、历史额度算式（**只有 3 个形参**，记忆不再重复扣），
 * 以及用量明细的差额兜底（**Σparts 恒等于 systemChars**）。
 */
import { describe, it, expect } from 'vitest'
import {
  FIXED_OVERHEAD_CHARS,
  messagesLen,
  trimHistory,
  historyBudget,
  summarizeUsage,
} from '../src/budget.js'
import type { UsagePart } from '../src/budget.js'

type M = { id: string; role: 'user'; content: string; at: number }
const mk = (n: number, len: number): M => ({ id: String(n), role: 'user', content: 'x'.repeat(len), at: n })

describe('budget · FIXED_OVERHEAD_CHARS 与 messagesLen', () => {
  it('额外安全余量的出厂值是 400 字', () => {
    expect(FIXED_OVERHEAD_CHARS).toBe(400)
  })

  it('messagesLen 把各条 content 长度加起来', () => {
    expect(messagesLen([])).toBe(0)
    expect(messagesLen([mk(1, 10)])).toBe(10)
    expect(messagesLen([mk(1, 100), mk(2, 100), mk(3, 100), mk(4, 100)])).toBe(400)
  })

  it('content 是空串 / undefined 时按 0 算，不算出 NaN', () => {
    expect(messagesLen([{ content: '' }, { content: '' }])).toBe(0)
    expect(messagesLen([{ content: 'ab' }, { content: undefined as unknown as string }])).toBe(2)
  })
})

describe('budget · trimHistory 的裁剪规则', () => {
  const hist = [mk(1, 100), mk(2, 100), mk(3, 100), mk(4, 100)]

  it('超预算时从最早的开始丢，并报出丢了几条', () => {
    const r = trimHistory(hist, 250)
    expect(r.dropped).toBe(2)
    expect(r.kept.length).toBe(2)
    expect(r.kept[0]!.id).toBe('1')
    expect(r.kept[1]!.id).toBe('4')
  })

  it('额度够时一条都不丢', () => {
    const r = trimHistory(hist, 10000)
    expect(r.dropped).toBe(0)
    expect(r.kept.map(m => m.id)).toEqual(['1', '2', '3', '4'])
    expect(r.kept).not.toBe(hist) // 返回新数组，调用方改它不会动到原历史
  })

  it('首条开场**永不裁剪**，哪怕它自己就超预算', () => {
    const r = trimHistory([mk(1, 10)], 1)
    expect(r.kept.length).toBe(1)
    expect(r.kept[0]!.id).toBe('1')
    expect(r.dropped).toBe(0)

    const big = [mk(1, 9999), mk(2, 10)]
    const r2 = trimHistory(big, 5)
    expect(r2.kept.length).toBe(1)
    expect(r2.kept[0]!.id).toBe('1')
    expect(r2.dropped).toBe(1)
  })

  it('空历史返回空，dropped 为 0', () => {
    const r = trimHistory<M>([], 100)
    expect(r.kept.length).toBe(0)
    expect(r.dropped).toBe(0)
  })

  it('预算 <= 0 时只留开场一条，其余全丢', () => {
    const r = trimHistory(hist, 0)
    expect(r.kept.length).toBe(1)
    expect(r.kept[0]!.id).toBe('1')
    expect(r.dropped).toBe(3)
    expect(trimHistory(hist, -100).dropped).toBe(3)
  })

  it('裁剪是**从头部**成条丢，不会切半条消息', () => {
    const r = trimHistory([mk(1, 100), mk(2, 100), mk(3, 100), mk(4, 100)], 350)
    expect(r.kept.map(m => m.content.length)).toEqual([100, 100, 100])
    expect(r.kept.map(m => m.id)).toEqual(['1', '3', '4'])
    expect(r.dropped).toBe(1)
  })

  it('恰好等于预算时不动手（used > budgetChars 才裁）', () => {
    const r = trimHistory(hist, 400)
    expect(r.dropped).toBe(0)
    expect(r.kept.length).toBe(4)
  })
})

describe('budget · historyBudget（留给对话历史的额度）', () => {
  it('= 总预算 − 安全余量 − 整条 system 长度', () => {
    expect(historyBudget(8000, '')).toBe(8000 - FIXED_OVERHEAD_CHARS)
    expect(historyBudget(8000, 'a'.repeat(100) + 'b'.repeat(50))).toBe(8000 - FIXED_OVERHEAD_CHARS - 150)
  })

  it('余量参数可覆盖（控制面板可调）', () => {
    expect(historyBudget(8000, '', 1000)).toBe(7000)
    expect(historyBudget(8000, 'x'.repeat(500), 0)).toBe(7500)
  })

  it('system 太长时归零，不给负数', () => {
    expect(historyBudget(100, 'x'.repeat(500))).toBe(0)
    expect(historyBudget(8000, 'x'.repeat(99999))).toBe(0)
  })

  it('签名里只有三个形参 —— 记忆不再单独扣（上游删掉第三参就是为了防重复计入）', () => {
    expect(historyBudget.length).toBe(2) // 带默认值的形参不计入 .length
    const sys = 'a'.repeat(8237)
    expect(historyBudget(24000, sys, 400)).toBe(24000 - 400 - 8237)
    expect(historyBudget(24000, sys, 400)).toBeGreaterThan(0)
  })

  it('system 为空串时按 0 算（undefined 也不会算出 NaN）', () => {
    expect(historyBudget(8000, '')).toBe(7600)
    expect(historyBudget(8000, undefined as unknown as string)).toBe(7600)
  })
})

describe('budget · summarizeUsage 的用量明细', () => {
  const parts = (): UsagePart[] => [
    { key: 'setting', label: '设定层', chars: 6000 },
    { key: 'world', label: '背景设定', chars: 1800 },
    { key: 'memory', label: '记忆', chars: 1200 },
  ]

  it('差额被并进「其他固定部分」，Σparts 恰等于 systemChars', () => {
    const s = summarizeUsage({ total: 16000, systemChars: 10000, parts: parts() })
    expect(s.parts.reduce((n, p) => n + p.chars, 0)).toBe(10000)
    const other = s.parts.find(p => p.key === 'other')!
    expect(other).toMatchObject({ key: 'other', label: '其他固定部分', chars: 1000 })
    expect(other.note ?? '').not.toBe('')
  })

  it('历史额度与占比都算对', () => {
    const s = summarizeUsage({ total: 16000, systemChars: 10000, parts: parts() })
    expect(s.historyChars).toBe(historyBudget(16000, 'x'.repeat(10000), FIXED_OVERHEAD_CHARS))
    expect(s.historyChars).toBe(5600)
    expect(s.historyPct).toBe(35)
    expect(s.total).toBe(16000)
    expect(s.systemChars).toBe(10000)
    expect(s.overhead).toBe(FIXED_OVERHEAD_CHARS)
  })

  it('0 字的层被剔掉，它的额度转进差额行（不会凭空少算）', () => {
    const zero = parts()
    zero[1]!.chars = 0
    const s = summarizeUsage({ total: 16000, systemChars: 8200, parts: zero })
    expect(s.parts.some(p => p.key === 'world')).toBe(false)
    expect(s.parts.reduce((n, p) => n + p.chars, 0)).toBe(8200)
    expect(s.historyChars).toBe(7400) // system 少 1800 ⇒ 历史额度多 1800
  })

  it('各层加起来已经超过 systemChars 时不补负数行，也不崩', () => {
    const s = summarizeUsage({ total: 16000, systemChars: 500, parts: [{ key: 'setting', label: '设定层', chars: 900 }] })
    expect(s.parts.some(p => p.key === 'other')).toBe(false)
    expect(s.parts.length).toBe(1)
    for (const p of s.parts) expect(p.chars).toBeGreaterThan(0)
  })

  it('warnings 原样透传，不给就空数组', () => {
    expect(summarizeUsage({ total: 16000, systemChars: 0, parts: [], warnings: ['档位有坑'] }).warnings).toEqual(['档位有坑'])
    expect(summarizeUsage({ total: 16000, systemChars: 0, parts: [] }).warnings).toEqual([])
  })

  it('总额度为 0 时历史占比是 0，不是 NaN', () => {
    const s = summarizeUsage({ total: 0, systemChars: 0, parts: [] })
    expect(s.historyPct).toBe(0)
    expect(s.historyChars).toBe(0)
    expect(Number.isNaN(s.historyPct)).toBe(false)
  })

  it('overhead 可覆盖，缺省取 FIXED_OVERHEAD_CHARS', () => {
    expect(summarizeUsage({ total: 16000, systemChars: 0, parts: [], overhead: 1000 }).overhead).toBe(1000)
    expect(summarizeUsage({ total: 16000, systemChars: 0, parts: [], overhead: 1000 }).historyChars).toBe(15000)
    expect(summarizeUsage({ total: 16000, systemChars: 0, parts: [] }).overhead).toBe(FIXED_OVERHEAD_CHARS)
  })

  it('parts 为空时整份 system 都算「其他固定部分」', () => {
    const s = summarizeUsage({ total: 16000, systemChars: 10000, parts: [] })
    expect(s.parts).toEqual([{ key: 'other', label: '其他固定部分', chars: 10000, note: expect.any(String) }])
  })
})
