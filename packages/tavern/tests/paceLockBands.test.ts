/**
 * `paceLockBands.ts` 契约测试 —— 进度锁 ↔ 数值档位的起点推断与一致性提示。
 *
 * 这个模块存在的理由是 §13 的现场证据：卡文写着「已完全信任」，新会话数值却从 0（中立）起，
 * 模型看到裸 0 就把角色演得像刚认识的陌生人。所以两条纪律必须有失败用例守着：
 *
 *   ① **复用 `VAR_BANDS`** —— 档位名与区间都取自那张表，绝不另造一套刻度
 *      （否则界面显示、扮演侧注入、本模块推断会各说各话）；
 *   ② **推不出就不猜** —— 卡文为空 / 没命中任何措辞 ⇒ 返回 null，调用方保持原行为。
 *
 * 另外钉住一条容易被「顺手优化」掉的顺序语义：`PACE_HINTS` 里
 * **先匹配更具体的**（「完全信任」必须排在「信任」前面），否则前者会被后者先吃掉、落到低一档。
 */

import { describe, expect, it } from 'vitest'

import { bandAnchorOf, paceLockDrift, paceLockStartValues, paceLockTargets } from '../src/paceLockBands.js'
import { VAR_BANDS, bandOf, bandsOf, type VarKey, type VarValues } from '../src/types.js'

describe('bandAnchorOf · 取档位区间中点', () => {
  it('数值项：锚点就是区间中点（四舍五入）', () => {
    expect(bandAnchorOf('affection', '极度厌恶')).toBe(-80) // [-100, -60)
    expect(bandAnchorOf('affection', '反感')).toBe(-40)
    expect(bandAnchorOf('affection', '中立')).toBe(0)
    expect(bandAnchorOf('affection', '亲近')).toBe(40)
    expect(bandAnchorOf('affection', '亲密依赖')).toBe(80)
    expect(bandAnchorOf('trust', '全然信赖')).toBe(80)
    expect(bandAnchorOf('progress', '崩坏')).toBe(-80)
  })

  it('🔴 锚点永远落在该档自己的区间里（推断出的起点必须真的属于那一档）', () => {
    for (const key of ['affection', 'trust', 'progress'] as const) {
      for (const b of bandsOf(key)!) {
        const anchor = bandAnchorOf(key, b.name)
        expect(anchor, `${key}/${b.name}`).not.toBeNull()
        expect(bandOf(key, anchor!)?.name, `${key}/${b.name} → ${anchor}`).toBe(b.name)
      }
    }
  })

  it('档名对不上 / 文本项没有档位 → null（调用方保持现状）', () => {
    expect(bandAnchorOf('affection', '不存在的档')).toBeNull()
    expect(bandAnchorOf('mood', '亲密依赖')).toBeNull()
    expect(bandAnchorOf('place', '亲近')).toBeNull()
  })
})

describe('paceLockTargets · 卡文措辞 → 目标档', () => {
  it('空卡文 / 纯空白 → 空数组（推不出就不猜）', () => {
    expect(paceLockTargets('')).toEqual([])
    expect(paceLockTargets('   \n  ')).toEqual([])
  })

  it('信任侧：完全信任 → 全然信赖；建立信任 → 信任；提防 → 提防', () => {
    expect(paceLockTargets('已完全信任')).toEqual([{ key: 'trust', band: '全然信赖' }])
    expect(paceLockTargets('开始信任')).toEqual([{ key: 'trust', band: '信任' }])
    expect(paceLockTargets('还在提防')).toEqual([{ key: 'trust', band: '提防' }])
  })

  it('好感侧：亲密 → 亲密依赖；亲近 → 亲近；反感 → 反感', () => {
    expect(paceLockTargets('两人已是恋人')).toEqual([{ key: 'affection', band: '亲密依赖' }])
    expect(paceLockTargets('渐渐熟络')).toEqual([{ key: 'affection', band: '亲近' }])
    expect(paceLockTargets('彼此疏远')).toEqual([{ key: 'affection', band: '反感' }])
  })

  it('🔴 同一项只取第一条命中的（先具体后宽泛：「完全信任」不被「信任」吃掉）', () => {
    expect(paceLockTargets('完全信任')).toEqual([{ key: 'trust', band: '全然信赖' }])
    expect(paceLockTargets('已经无条件相信她了')).toEqual([{ key: 'trust', band: '全然信赖' }])
  })

  it('🔴 具体措辞与宽泛措辞同时出现时，仍取更具体的那一档', () => {
    // 「建立信任」也命中「信任」，但 PACE_HINTS 里「完全信任」那条更靠前。
    expect(paceLockTargets('已经建立信任，可以说是完全信任了')).toEqual([{ key: 'trust', band: '全然信赖' }])
  })

  it('信任与好感可各出一条（两项互不挤占）', () => {
    expect(paceLockTargets('已有信任，渐渐亲近')).toEqual([
      { key: 'trust', band: '信任' },
      { key: 'affection', band: '亲近' },
    ])
  })

  it('🔴 「按剧情节奏」「自然推进」这类故意不认（没有阶段，猜出来的起点比 0 更糟）', () => {
    expect(paceLockTargets('按剧情节奏自然推进')).toEqual([])
    expect(paceLockTargets('慢。至少十几次交谈才到熟络。')).not.toEqual([]) // 「熟络」是明确措辞 → 认
    expect(paceLockTargets('视情况而定')).toEqual([])
  })

  it('信任的方向不会误伤好感：只写「提防」时不出好感条', () => {
    expect(paceLockTargets('互相提防，戒心很重').map(t => t.key)).toEqual(['trust'])
  })

  it('措辞中的否定式（不信任）归到「提防」，不是「信任」', () => {
    expect(paceLockTargets('两人互不信任')).toEqual([{ key: 'trust', band: '提防' }])
  })
})

describe('paceLockStartValues · 从卡文推断起始数值', () => {
  it('推得出时只含命中的项，取该档区间中点', () => {
    expect(paceLockStartValues('已完全信任')).toEqual({ trust: 80 })
    expect(paceLockStartValues('已是恋人')).toEqual({ affection: 80 })
    expect(paceLockStartValues('已有信任，渐渐亲近')).toEqual({ trust: 40, affection: 40 })
  })

  it('🔴 推不出 → null（卡文空 / 无命中措辞 / 认不出的档名）', () => {
    expect(paceLockStartValues('')).toBeNull()
    expect(paceLockStartValues('   ')).toBeNull()
    expect(paceLockStartValues('按剧情节奏自然推进')).toBeNull()
  })

  it('推断出的起点必须真的落在目标档里（与 bandOf 同源，不另造刻度）', () => {
    const targets = paceLockTargets('完全信任又亲近')
    const start = paceLockStartValues('完全信任又亲近')
    expect(start).not.toBeNull()
    for (const t of targets) {
      expect(bandOf(t.key, start![t.key])?.name).toBe(t.band)
    }
  })

  it('锚点取自 VAR_BANDS 本身（改表就跟着变，不会两处对不上）', () => {
    for (const key of ['affection', 'trust', 'progress'] as const) {
      for (const b of VAR_BANDS[key]) {
        expect(bandAnchorOf(key, b.name)).toBe(Math.round((b.from + b.to) / 2))
      }
    }
  })
})

describe('paceLockDrift · 卡文档位 vs 当前数值档位', () => {
  it('卡文没提任何阶段 → 空数组（作者没表达意图，谈不上「不一致」）', () => {
    expect(paceLockDrift('', { affection: 0 })).toEqual([])
    expect(paceLockDrift('按剧情节奏', { affection: 0 })).toEqual([])
  })

  it('一致时不产出（卡文说亲近、数值也在亲近档）', () => {
    expect(paceLockDrift('渐渐亲近', { affection: 40 })).toEqual([])
    expect(paceLockDrift('已完全信任', { trust: 70 })).toEqual([])
  })

  it('不一致时产出，带 label / wantBand / nowBand', () => {
    const drift = paceLockDrift('已完全信任', { trust: 0 })
    expect(drift).toEqual([{ key: 'trust', label: '信任', wantBand: '全然信赖', nowBand: '一般' }])
  })

  it('值缺失（新会话还没有 vars 块）时 nowBand 为 null，但仍然报出「卡文说要 X」', () => {
    // 🔴 number 缺失 ⇒ Number(undefined)=NaN ⇒ bandOf 返回 null。界面此时只能说
    //    「卡文说要亲密依赖」，不能说「现在是中立」—— 那是在替引擎编一个它并不知道的数值。
    expect(paceLockDrift('已是恋人', {})).toEqual([
      { key: 'affection', label: '好感', wantBand: '亲密依赖', nowBand: null },
    ])
  })

  it('值算不出来（NaN / 非数）时 nowBand 为 null —— 界面据此只提示「卡文说要 X」', () => {
    expect(paceLockDrift('已是恋人', { affection: Number.NaN })[0]).toMatchObject({ nowBand: null })
    expect(paceLockDrift('已是恋人', { affection: '不是数' })[0]).toMatchObject({ nowBand: null })
  })

  it('只对**卡文明确提到**的项检查（没提的项不产出）', () => {
    const drift = paceLockDrift('已完全信任', { affection: -90, trust: 0 })
    expect(drift.map(d => d.key)).toEqual(['trust'])
  })

  it('越界的当前值由 bandOf 夹到端点档，一致就不报', () => {
    // 999 被夹到「亲密依赖」= 卡文要的档 → 一致 ⇒ 不产出（引擎不替作者纠偏）
    expect(paceLockDrift('已是恋人', { affection: 999 })).toEqual([])
    // -999 夹到「全不信任」≠「全然信赖」⇒ 报
    expect(paceLockDrift('已完全信任', { trust: -999 })).toEqual([
      { key: 'trust', label: '信任', wantBand: '全然信赖', nowBand: '全不信任' },
    ])
  })

  it('两项都不一致时按 PACE_HINTS 顺序产出（信任在前、好感在后）', () => {
    const drift = paceLockDrift('已完全信任，彼此疏远', { trust: 0, affection: 0 })
    expect(drift.map(d => `${d.key}:${d.wantBand}→${d.nowBand}`)).toEqual([
      'trust:全然信赖→一般',
      'affection:反感→中立',
    ])
  })

  it('values 传 undefined 不炸（新会话还没有 vars 块）', () => {
    expect(paceLockDrift('已是恋人', undefined)).toEqual([
      { key: 'affection', label: '好感', wantBand: '亲密依赖', nowBand: null },
    ])
  })

  it('label 取自 varDefOf（中文名，与界面/提示词同一份表）', () => {
    const values: VarValues = { trust: 80 }
    expect(paceLockDrift('还在提防', values)[0]!.label).toBe('信任')
    const keys: VarKey[] = ['affection', 'trust', 'progress']
    for (const k of keys) {
      expect(typeof paceLockDrift(k === 'trust' ? '提防' : '亲近', {})[0]?.label).toBe('string')
    }
  })
})
