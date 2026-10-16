/**
 * paramGuide 单测 —— 上游 `tests/paramGuide.test.ts` 的 vitest 重写版。
 *
 * 上游那套是自写断言脚本，核心是**遍历所有表、逐条检查结构不变量**
 * （段数 ≥3、首段贴 min、末段贴 max、无空隙无重叠、恰好一个 recommended…）。
 * 这里保留同一套闸门 —— 表是纯数据，改一个数字不会让任何代码变红，
 * 只有这些不变量能拦住「手一抖把边界改错」。
 */
import { describe, it, expect } from 'vitest'
import {
  PARAM_GUIDES,
  GUIDE_SAMPLING,
  GUIDE_REPEAT_LAST_N,
  GUIDE_FREQUENCY_PENALTY,
  bandOf,
  dynamicGuide,
} from '../src/paramGuide.js'
import type { ParamGuide, DynamicGuideKey } from '../src/paramGuide.js'

/** 扁平化后的「全部表」，键名带 `sampling.` 前缀（与上游测试同一口径） */
const ALL: Array<[string, ParamGuide]> = [
  ...Object.entries(PARAM_GUIDES).map(([k, v]) => [k, v] as [string, ParamGuide]),
  ...Object.entries(GUIDE_SAMPLING).map(([k, v]) => [`sampling.${k}`, v] as [string, ParamGuide]),
]

/** 被 `dynamicGuide` 支持的 7 个键（上游那份数组是 module-private，这里显式抄一份） */
const DYNAMIC_KEYS: DynamicGuideKey[] = [
  'contextBudget', 'numCtx', 'fixedOverheadChars', 'softLimit', 'hardLimit', 'longTermLimit', 'diaryKeep',
]

/** 复刻 `dynamicGuide` 内部的 r 口径（对**静态表**的 min/step/max 取值） */
function snappedRec(key: DynamicGuideKey, rec: number): number {
  const g = PARAM_GUIDES[key]
  const snapped = g.step > 0 ? Math.round(rec / g.step) * g.step : Math.round(rec)
  return Math.min(g.max, Math.max(g.min, snapped))
}

describe('paramGuide · 表的形状（导出名与键集合）', () => {
  it('PARAM_GUIDES 恰好 14 个键，键名与顺序逐字固定', () => {
    expect(Object.keys(PARAM_GUIDES)).toEqual([
      'contextBudget', 'fixedOverheadChars', 'timeoutSec', 'numCtx',
      'plotSettingRatio',
      'softLimit', 'hardLimit', 'longTermLimit', 'diaryKeep', 'summaryLock', 'dailyAdvance', 'dailyKeep',
      'varMaxStep',
      'searchTopK',
    ])
  })

  it('GUIDE_SAMPLING 恰好 7 个键，且与两个具名采样表是同一对象', () => {
    expect(Object.keys(GUIDE_SAMPLING)).toEqual([
      'temperature', 'topP', 'topK', 'repeatPenalty', 'frequencyPenalty', 'repeatLastN', 'presencePenalty',
    ])
    expect(GUIDE_SAMPLING.repeatLastN).toBe(GUIDE_REPEAT_LAST_N)
    expect(GUIDE_SAMPLING.frequencyPenalty).toBe(GUIDE_FREQUENCY_PENALTY)
  })

  it('每个 guide 的 min/max/step 都是有限数且 step > 0', () => {
    for (const [name, g] of ALL) {
      expect(Number.isFinite(g.min), name).toBe(true)
      expect(Number.isFinite(g.max), name).toBe(true)
      expect(g.step, name).toBeGreaterThan(0)
      expect(g.max, name).toBeGreaterThan(g.min)
    }
  })
})

describe('paramGuide · 所有表的共有不变量（上游闸门逐条搬过来）', () => {
  it('每张表至少 3 段，首段贴 min、末段贴 max', () => {
    for (const [name, g] of ALL) {
      const bs = g.bands
      expect(bs.length, name).toBeGreaterThanOrEqual(3)
      expect(bs[0]!.from, name).toBe(g.min)
      expect(bs[bs.length - 1]!.to, name).toBe(g.max)
    }
  })

  it('段与段首尾相接：无空隙（最多让一个 step）、无重叠、from 严格递增', () => {
    for (const [name, g] of ALL) {
      const bs = g.bands
      for (let i = 0; i < bs.length; i++) {
        const b = bs[i]!
        expect(b.from, `${name}[${i}] from<=to`).toBeLessThanOrEqual(b.to)
        if (i === 0) continue
        const prev = bs[i - 1]!
        expect(b.from, `${name}[${i}] 重叠`).toBeGreaterThanOrEqual(prev.to)
        expect(b.from, `${name}[${i}] 有缝`).toBeLessThanOrEqual(prev.to + g.step)
        expect(b.from, `${name}[${i}] from 必须严格递增`).toBeGreaterThan(prev.from)
      }
    }
  })

  it('每段都有非空档名，且 effect 至少写满 12 个字', () => {
    for (const [name, g] of ALL) {
      g.bands.forEach((b, i) => {
        expect(b.name.trim(), `${name}[${i}].name`).not.toBe('')
        expect(b.effect.trim().length, `${name}[${i}].effect`).toBeGreaterThanOrEqual(12)
      })
    }
  })

  it('每张表恰好一个 recommended 段', () => {
    for (const [name, g] of ALL) {
      expect(g.bands.filter(b => b.recommended).length, name).toBe(1)
    }
  })

  it('unit 口径：只有 repeatLastN 与 numCtx 以词元为单位', () => {
    expect(ALL.filter(([, g]) => g.unit === '词元').map(([n]) => n)).toEqual(['numCtx', 'sampling.repeatLastN'])
    // 上游那条更窄的断言：采样七项里只有 repeatLastN 带单位
    const samplingUnits = Object.entries(GUIDE_SAMPLING)
      .filter(([, g]) => g.unit !== undefined)
      .map(([k]) => k)
    expect(samplingUnits).toEqual(['repeatLastN'])
  })
})

describe('paramGuide · 抽样逐字段核对（防止手抖改数字）', () => {
  it('GUIDE_SAMPLING.temperature 五段边界与档名逐字一致', () => {
    const g = GUIDE_SAMPLING.temperature
    expect({ min: g.min, max: g.max, step: g.step }).toEqual({ min: 0, max: 2, step: 0.05 })
    expect(g.unit).toBeUndefined()
    expect(g.bands.map(b => [b.from, b.to, b.name])).toEqual([
      [0, 0.4, '死板'], [0.4, 0.7, '保守'], [0.7, 1.1, '平衡'], [1.1, 1.5, '活跃'], [1.5, 2, '放飞'],
    ])
    expect(g.bands[2]!.recommended).toBe(true)
  })

  it('GUIDE_SAMPLING.topK 的「关闭」是一个单点段（from === to === 0）', () => {
    const g = GUIDE_SAMPLING.topK
    expect({ min: g.min, max: g.max, step: g.step }).toEqual({ min: 0, max: 200, step: 1 })
    expect(g.bands[0]).toMatchObject({ from: 0, to: 0, name: '关闭' })
    expect(g.bands[0]!.recommended).toBeUndefined()
    expect(g.bands[1]).toMatchObject({ from: 1, to: 20, name: '极窄' })
    expect(g.bands[2]).toMatchObject({ from: 20, to: 60, name: '平衡', recommended: true })
  })

  it('PARAM_GUIDES 的 min/max/step/unit 抽样（控制面板输入框的唯一真源）', () => {
    expect(PARAM_GUIDES.contextBudget).toMatchObject({ min: 1000, max: 2097152, step: 500, unit: '字' })
    expect(PARAM_GUIDES.fixedOverheadChars).toMatchObject({ min: 0, max: 20000, step: 100, unit: '字' })
    expect(PARAM_GUIDES.timeoutSec).toMatchObject({ min: 10, max: 900, step: 10, unit: '秒' })
    expect(PARAM_GUIDES.numCtx).toMatchObject({ min: 2048, max: 2097152, step: 1024, unit: '词元' })
    expect(PARAM_GUIDES.plotSettingRatio).toMatchObject({ min: 10, max: 95, step: 5, unit: '%' })
    expect(PARAM_GUIDES.searchTopK).toMatchObject({ min: 1, max: 10, step: 1, unit: '条' })
  })

  it('推荐段的名字里写着默认值，且默认值真的落在推荐段内', () => {
    const rec = (g: ParamGuide) => g.bands.find(b => b.recommended)!
    expect(rec(PARAM_GUIDES.contextBudget).name).toBe('长线（默认 24000）')
    expect(rec(PARAM_GUIDES.fixedOverheadChars).name).toBe('常规余量（默认 400）')
    expect(bandOf(PARAM_GUIDES.contextBudget, 24000).recommended).toBe(true)
    expect(bandOf(PARAM_GUIDES.fixedOverheadChars, 400).recommended).toBe(true)
    expect(bandOf(PARAM_GUIDES.timeoutSec, 180).recommended).toBe(true)
    expect(bandOf(PARAM_GUIDES.numCtx, 32768).recommended).toBe(true)
  })

  it('动态文案里的上下界必须是**算出来的**，不是写死的字面量', () => {
    const dyn = dynamicGuide('softLimit', 1400)
    expect(dyn.bands.map(b => [b.from, b.to])).toEqual([
      [200, 900], [900, 1200], [1200, 1800], [1800, 2500], [2500, 200000],
    ])
    expect(dyn.bands[2]!.name).toBe('推荐')
    expect(dyn.bands[2]!.effect).toContain('1200 ~ 1800')
    expect(dyn.bands[2]!.effect).toContain('按当前上下文预算同比推算')
    // 静态表里那一段的说明是另一句（不掺动态边界）
    expect(PARAM_GUIDES.softLimit.bands[1]).toMatchObject({ from: 800, to: 2000, name: '常规', recommended: true })
  })

  it('GUIDE_REPEAT_LAST_N / GUIDE_FREQUENCY_PENALTY 的取值', () => {
    expect(GUIDE_REPEAT_LAST_N).toMatchObject({ min: 0, max: 4096, step: 64, unit: '词元' })
    expect(GUIDE_REPEAT_LAST_N.bands.map(b => [b.from, b.to])).toEqual([[0, 0], [64, 256], [256, 1024], [1024, 4096]])
    expect(GUIDE_FREQUENCY_PENALTY).toMatchObject({ min: 0, max: 2, step: 0.05 })
    expect(GUIDE_FREQUENCY_PENALTY.unit).toBeUndefined()
    expect(GUIDE_FREQUENCY_PENALTY.bands[1]).toMatchObject({ from: 0.05, to: 0.3, name: '轻推', recommended: true })
  })
})

describe('paramGuide · bandOf 的边界归属（v <= to，边界归下面那段）', () => {
  const t = GUIDE_SAMPLING.temperature
  const k = GUIDE_SAMPLING.topK

  it('恰好踩在切点上的值归下面那一段', () => {
    expect(bandOf(t, 0.7).name).toBe('保守')
    expect(bandOf(t, 1.1).name).toBe('平衡')
    expect(bandOf(t, 0.4).name).toBe('死板')
  })

  it('段内部的普通取值', () => {
    expect(bandOf(t, 0).name).toBe('死板')
    expect(bandOf(t, 0.9).name).toBe('平衡')
    expect(bandOf(t, 2).name).toBe('放飞')
  })

  it('越界值被夹到首段 / 末段，不返回 undefined', () => {
    expect(bandOf(t, -5).name).toBe('死板')
    expect(bandOf(t, 99).name).toBe('放飞')
    expect(bandOf(k, -1).name).toBe('关闭')
    expect(bandOf(k, 1e9).name).toBe('几乎不限')
  })

  it('topK=0 与 topK=1 分属「关闭」与「极窄」两个不同的段', () => {
    expect(bandOf(k, 0).name).toBe('关闭')
    expect(bandOf(k, 1).name).toBe('极窄')
  })

  it('返回的就是表里的那个段对象（引用相等，界面靠它做高亮）', () => {
    expect(bandOf(t, 0.9)).toBe(t.bands[2])
    expect(bandOf(t, -5)).toBe(t.bands[0])
    expect(bandOf(t, 99)).toBe(t.bands[t.bands.length - 1])
  })
})

describe('paramGuide · dynamicGuide 的三条不变量', () => {
  it('首段 from === min、末段 to === max，且段段首尾相接', () => {
    for (const key of DYNAMIC_KEYS) {
      const g = dynamicGuide(key, 24000)
      expect(g.bands[0]!.from, key).toBe(g.min)
      expect(g.bands[g.bands.length - 1]!.to, key).toBe(g.max)
      for (let i = 1; i < g.bands.length; i++) {
        expect(g.bands[i]!.from, `${key}[${i}]`).toBe(g.bands[i - 1]!.to)
      }
    }
  })

  it('恰好一个 recommended 段，而且推荐值真的落在这一段里', () => {
    for (const key of DYNAMIC_KEYS) {
      for (const rec of [1200, 8000, 24000, 60000]) {
        const g = dynamicGuide(key, rec)
        const marked = g.bands.filter(b => b.recommended)
        expect(marked.length, `${key}@${rec}`).toBe(1)
        expect(bandOf(g, snappedRec(key, rec)).recommended, `${key}@${rec} 推荐是假的`).toBe(true)
      }
    }
  })

  it('min / step / unit 一律沿用静态表（只有上界与分段被重算）', () => {
    for (const key of DYNAMIC_KEYS) {
      const stat = PARAM_GUIDES[key]
      const dyn = dynamicGuide(key, 24000)
      expect(dyn.min, key).toBe(stat.min)
      expect(dyn.step, key).toBe(stat.step)
      expect(dyn.unit, key).toBe(stat.unit)
      expect(dyn.max, key).toBeGreaterThanOrEqual(stat.max)
    }
  })

  it('推荐值极大时上界会跟着抬高到静态上界之外', () => {
    const dyn = dynamicGuide('contextBudget', 1000000)
    expect(dyn).toMatchObject({ min: 1000, max: 2500000, step: 500, unit: '字' })
    expect(dyn.bands.map(b => [b.from, b.to, b.name])).toEqual([
      [1000, 625000, '偏小'],
      [625000, 875000, '略小'],
      [875000, 1250000, '推荐'],
      [1250000, 1750000, '略大'],
      [1750000, 2500000, '偏大'],
    ])
  })

  it('推荐值贴着 min 时自动降档，不硬凑出 from === to 的空段', () => {
    const dyn = dynamicGuide('diaryKeep', 1)
    expect(dyn.bands.map(b => [b.from, b.to])).toEqual([[1, 1], [1, 2], [2, 30]])
    expect(dyn.bands.length).toBe(3)
    expect(dyn.bands.filter(b => b.recommended).length).toBe(1)
    expect(dyn.bands[0]!.recommended).toBe(true)
    expect(bandOf(dyn, 1).recommended).toBe(true)
  })

  it('推荐值为 0 / 负数时被夹进 [min,max]，不产生 NaN 或倒挂边界', () => {
    for (const key of DYNAMIC_KEYS) {
      for (const rec of [0, -500]) {
        const g = dynamicGuide(key, rec)
        expect(g.bands[0]!.from, `${key}@${rec}`).toBe(g.min)
        expect(g.bands[g.bands.length - 1]!.to, `${key}@${rec}`).toBe(g.max)
        for (const b of g.bands) {
          expect(Number.isFinite(b.from), `${key}@${rec}`).toBe(true)
          expect(Number.isFinite(b.to), `${key}@${rec}`).toBe(true)
          expect(b.from).toBeLessThanOrEqual(b.to)
        }
        expect(bandOf(g, g.min).recommended, `${key}@${rec} min 处该是推荐段`).toBe(true)
      }
    }
  })
})
