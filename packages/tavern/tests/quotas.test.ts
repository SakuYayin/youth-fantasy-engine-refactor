/**
 * quotas 单测 —— 上游 `tests/tavernQuota.test.ts` 的 vitest 重写版。
 *
 * 上游那份还顺带比对了 `modelCapacity.MIN_SANE_WINDOW` / `FALLBACK_WINDOW` 与
 * `world.WORLD_MAX_CHARS` 等**跨模块常量**。本批文件零外部依赖，那些跨模块比对
 * 落不了地（本包内模型容量/world 尚未移植），所以这里改成钉住**本模块自己的口径**：
 * 2000 这个可信下限、32768 这个兜底值，以及每一条预算换算的精确结果。
 */
import { describe, it, expect } from 'vitest'
import {
  FIXED_QUOTA_RATIO,
  FIXED_QUOTA_MIN,
  FIXED_QUOTA_MAX,
  DYNAMIC_QUOTA_RATIO,
  DYNAMIC_QUOTA_PCT,
  FALLBACK_WINDOW_TOKENS,
  effectiveWindowTokens,
  fixedQuotaOf,
  dynamicQuotaOf,
  quotaProfileOf,
  fmtWindow,
} from '../src/quotas.js'

describe('quotas · 常量（作者能看到的每个数都在这儿）', () => {
  it('固定层比例 8%、下限 2400、上限 12000', () => {
    expect(FIXED_QUOTA_RATIO).toBe(0.08)
    expect(FIXED_QUOTA_MIN).toBe(2400)
    expect(FIXED_QUOTA_MAX).toBe(12000)
  })

  it('动态层默认比例 15%，可调范围 5%~35% 步长 1', () => {
    expect(DYNAMIC_QUOTA_RATIO).toBe(0.15)
    expect(DYNAMIC_QUOTA_PCT).toEqual({ min: 5, max: 35, step: 1, default: 15 })
    // 默认比例与可调表里的 default 是同一个数（两处脱节的话界面会显示错）
    expect(DYNAMIC_QUOTA_RATIO * 100).toBe(DYNAMIC_QUOTA_PCT.default)
  })

  it('窗口缺失时的兜底是 32768', () => {
    expect(FALLBACK_WINDOW_TOKENS).toBe(32768)
  })
})

describe('quotas · effectiveWindowTokens 的可信下限（2000）', () => {
  it('null / undefined / NaN / 非数一律退回兜底值', () => {
    expect(effectiveWindowTokens(null)).toBe(FALLBACK_WINDOW_TOKENS)
    expect(effectiveWindowTokens(undefined)).toBe(FALLBACK_WINDOW_TOKENS)
    expect(effectiveWindowTokens(Number.NaN)).toBe(FALLBACK_WINDOW_TOKENS)
    expect(effectiveWindowTokens(Number.POSITIVE_INFINITY)).toBe(FALLBACK_WINDOW_TOKENS)
  })

  it('小于 2000 的「疑似把 K 当词元数填了」也退回兜底值', () => {
    expect(effectiveWindowTokens(-1)).toBe(FALLBACK_WINDOW_TOKENS)
    expect(effectiveWindowTokens(0)).toBe(FALLBACK_WINDOW_TOKENS)
    expect(effectiveWindowTokens(1000)).toBe(FALLBACK_WINDOW_TOKENS)
    expect(effectiveWindowTokens(1999)).toBe(FALLBACK_WINDOW_TOKENS)
  })

  it('恰好 2000 就算可信，不再兜底（边界归可信用那一侧）', () => {
    expect(effectiveWindowTokens(2000)).toBe(2000)
  })

  it('可信值原样通过，小数向下取整', () => {
    expect(effectiveWindowTokens(32768)).toBe(32768)
    expect(effectiveWindowTokens(32768.9)).toBe(32768)
    expect(effectiveWindowTokens(2000.7)).toBe(2000)
  })
})

describe('quotas · fixedQuotaOf（总纲 + 世界设定，每轮全量注入）', () => {
  it('窗口 × 8%，并夹在 [2400, 12000] 之内', () => {
    expect(fixedQuotaOf(32768)).toBe(2621)
    expect(fixedQuotaOf(65536)).toBe(5243)
    expect(fixedQuotaOf(131072)).toBe(10486)
  })

  it('小窗口吃下限：8192 与 2000 都给 2400', () => {
    expect(fixedQuotaOf(8192)).toBe(FIXED_QUOTA_MIN)
    expect(fixedQuotaOf(2000)).toBe(FIXED_QUOTA_MIN)
    expect(fixedQuotaOf(8192)).toBe(2400)
  })

  it('大窗口吃上限：20 万与 100 万都给 12000', () => {
    expect(fixedQuotaOf(200000)).toBe(FIXED_QUOTA_MAX)
    expect(fixedQuotaOf(1000000)).toBe(FIXED_QUOTA_MAX)
  })

  it('窗口拿不到时按兜底窗口算（与直接传 32768 一致）', () => {
    expect(fixedQuotaOf(null)).toBe(fixedQuotaOf(32768))
    expect(fixedQuotaOf(undefined)).toBe(fixedQuotaOf(32768))
    expect(fixedQuotaOf(1000)).toBe(fixedQuotaOf(32768))
  })
})

describe('quotas · dynamicQuotaOf（世界书按关键词筛出来的部分）', () => {
  it('默认 15%：32768 ⇒ 4915', () => {
    expect(dynamicQuotaOf(32768)).toBe(4915)
    expect(dynamicQuotaOf(32768, DYNAMIC_QUOTA_PCT.default)).toBe(4915)
  })

  it('百分比被夹在 5~35 之间', () => {
    expect(dynamicQuotaOf(32768, 5)).toBe(1638)
    expect(dynamicQuotaOf(32768, 25)).toBe(8192)
    expect(dynamicQuotaOf(32768, 35)).toBe(11469)
    expect(dynamicQuotaOf(32768, 80)).toBe(dynamicQuotaOf(32768, 35))
    expect(dynamicQuotaOf(32768, 1)).toBe(dynamicQuotaOf(32768, 5))
    expect(dynamicQuotaOf(32768, -10)).toBe(dynamicQuotaOf(32768, 5))
  })

  it('百分比非法时回落默认 15%', () => {
    expect(dynamicQuotaOf(32768, Number.NaN)).toBe(dynamicQuotaOf(32768, 15))
    expect(dynamicQuotaOf(32768, null)).toBe(dynamicQuotaOf(32768, 15))
    expect(dynamicQuotaOf(32768, undefined)).toBe(dynamicQuotaOf(32768, 15))
  })

  it('窗口拿不到时按兜底窗口算，百分比照常生效', () => {
    expect(dynamicQuotaOf(null, 20)).toBe(dynamicQuotaOf(32768, 20))
    expect(dynamicQuotaOf(null)).toBe(dynamicQuotaOf(32768))
  })
})

describe('quotas · 两层额度的总量纪律', () => {
  it('固定层 + 动态层之和不到窗口的 25%（别把上下文吃光）', () => {
    expect(fixedQuotaOf(32768) + dynamicQuotaOf(32768)).toBeLessThan(32768 * 0.25)
    expect(fixedQuotaOf(32768) + dynamicQuotaOf(32768)).toBe(7536)
  })

  it('即使动态层拉到最大 35%，两层之和仍不到窗口的一半', () => {
    expect(fixedQuotaOf(32768) + dynamicQuotaOf(32768, DYNAMIC_QUOTA_PCT.max)).toBeLessThan(32768 * 0.5)
  })

  it('两个额度都是正数，任何窗口下都不会算出 0 或负数', () => {
    for (const w of [null, undefined, 0, -1, 2000, 8192, 32768, 131072, 1000000]) {
      expect(fixedQuotaOf(w), `w=${String(w)}`).toBeGreaterThan(0)
      expect(dynamicQuotaOf(w), `w=${String(w)}`).toBeGreaterThan(0)
    }
  })
})

describe('quotas · quotaProfileOf（界面要同时显示两层，还要能解释数是怎么来的）', () => {
  it('窗口可信时五项齐全，且与两个单项函数逐一一致', () => {
    const p = quotaProfileOf(32768, 20)
    expect(p).toEqual({
      windowTokens: 32768,
      windowFallback: false,
      fixed: fixedQuotaOf(32768),
      dynamic: dynamicQuotaOf(32768, 20),
      dynamicPct: 20,
    })
    expect(Object.keys(p).length).toBe(5)
  })

  it('窗口拿不到时打上 windowFallback 标记，但两个额度仍是正数', () => {
    const p = quotaProfileOf(null)
    expect(p.windowFallback).toBe(true)
    expect(p.windowTokens).toBe(FALLBACK_WINDOW_TOKENS)
    expect(p.fixed).toBeGreaterThan(0)
    expect(p.dynamic).toBeGreaterThan(0)
    expect(p.dynamicPct).toBe(DYNAMIC_QUOTA_PCT.default)
  })

  it('小于可信下限的窗口也算兜底', () => {
    expect(quotaProfileOf(1999).windowFallback).toBe(true)
    expect(quotaProfileOf(2000).windowFallback).toBe(false)
    expect(quotaProfileOf(2000).windowTokens).toBe(2000)
  })

  it('dynamicPct 与 dynamic 用的是**同一个**夹取后的比例（显示的数不能骗人）', () => {
    expect(quotaProfileOf(32768, 80).dynamicPct).toBe(DYNAMIC_QUOTA_PCT.max)
    expect(quotaProfileOf(32768, 80).dynamic).toBe(dynamicQuotaOf(32768, DYNAMIC_QUOTA_PCT.max))
    expect(quotaProfileOf(32768, Number.NaN).dynamicPct).toBe(DYNAMIC_QUOTA_PCT.default)
    expect(quotaProfileOf(32768, null).dynamicPct).toBe(DYNAMIC_QUOTA_PCT.default)
  })
})

describe('quotas · fmtWindow（人类可读的窗口一串）', () => {
  it('常规窗口按 K 显示，小数点后一位但去掉多余的 0', () => {
    expect(fmtWindow(32768)).toBe('32K')
    expect(fmtWindow(8192)).toBe('8K')
    expect(fmtWindow(98304)).toBe('96K')
    expect(fmtWindow(131072)).toBe('128K')
  })

  it('100K 及以上改用整数（1024K 不写 1024.0K）', () => {
    expect(fmtWindow(1048576)).toBe('1024K')
    expect(fmtWindow(102400)).toBe('100K')
    expect(fmtWindow(102399)).toBe('100K')
  })

  it('非整数窗口不会吐出长串小数', () => {
    expect(fmtWindow(2000)).toBe('2K')
    expect(fmtWindow(2048)).toBe('2K')
    expect(fmtWindow(3072)).toBe('3K')
    expect(fmtWindow(1536)).toBe('1.5K')
  })
})
