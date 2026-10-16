/**
 * `status.ts` 契约测试 —— 把六栏记忆 + 在场调度**只读地**提取成一张状态一览。
 *
 * 这一层不写库、不让 AI 输出增量，它唯一的风险是「**数错**」与「**越界**」：
 *
 *  · 数错：状态栏是作者判断「AI 到底记住了什么」的唯一窗口。把「暂无」「-」这类占位
 *    数成真内容（`isPlaceholder` 的整段判定），作者就会以为「未爆的雷 1」；
 *    把列表符号算进条目数同理。`countEntries` / `memoryCounts` / `memoryEntryTotal`
 *    的每一类列表前缀都有用例。
 *  · 越界：本层**只读**，且**不做记忆水位判定**（水位归 `memory.ts` / 上层收尾编排）。
 *    与水位最接近的三处阈值是 `agoText` 的 60_000 / 3_600_000 / 86_400_000 ——
 *    这里把它们**逐个钉在边界值本身**（边界两侧各一条），日后谁改了数就有红灯。
 *
 * 上游对应断言：`_upstream_tmp/youth-fantasy-engine-main/tests/tavernStatus.test.ts`
 * （共 137 行，`countEntries` / `firstEntries` / `memoryCounts` / `memoryEntryTotal` /
 * `buildStatusModel` / `agoText` 六节），已逐条翻译成 vitest 并补齐边界两侧。
 */

import { describe, expect, it } from 'vitest'

import {
  agoText,
  buildStatusModel,
  countEntries,
  firstEntries,
  memoryCounts,
  memoryEntryTotal,
  type StatusModel,
} from '../src/status.js'
import { DEFAULT_TALKATIVITY, type FreeMemory } from '../src/types.js'

/** 造一份六栏记忆：只传需要的栏，其余为空串（与上游测试同口径） */
function mem(charId: string, patch: Partial<FreeMemory> = {}): FreeMemory {
  return {
    charId,
    longTerm: '',
    facts: '',
    relation: '',
    mines: '',
    anniversaries: '',
    diaries: '',
    updatedAt: 0,
    ...patch,
  }
}

const T0 = 1_700_000_000_000

describe('countEntries · 条目计数', () => {
  it('空串与纯空白都是 0 条', () => {
    expect(countEntries('')).toBe(0)
    expect(countEntries('   ')).toBe(0)
  })

  it('只有换行也是 0 条（空行不计）', () => {
    expect(countEntries('\n\n\n')).toBe(0)
  })

  it('两行两件事 = 2 条', () => {
    expect(countEntries('甲\n乙')).toBe(2)
  })

  it('末尾多余的换行不算一条（尾空行被过滤）', () => {
    expect(countEntries('甲\n乙\n')).toBe(2)
  })

  it('「- 」前缀不计入正文，仍按条目数', () => {
    expect(countEntries('- 甲\n- 乙')).toBe(2)
  })

  it('三种无序列表符号 `*` `•` `·` 都被剥掉', () => {
    expect(countEntries('* 甲\n• 乙\n· 丙')).toBe(3)
  })

  it('三种有序列表写法 `1.` `2、` `(3)` 都被剥掉', () => {
    expect(countEntries('1. 甲\n2、乙\n(3) 丙')).toBe(3)
  })

  it('行首行尾空白被裁掉后仍按非空行计数', () => {
    expect(countEntries('  甲  \n  乙  ')).toBe(2)
  })

  it('🔴 占位行不算内容：整行只有「暂无」时是 0 条', () => {
    expect(countEntries('暂无')).toBe(0)
  })

  it('🔴 占位行与真内容混排时，只数真内容', () => {
    expect(countEntries('暂无\n真的发生了')).toBe(1)
  })
})

describe('firstEntries · 取前 N 条做摘要', () => {
  it('空串 → 空串', () => {
    expect(firstEntries('')).toBe('')
  })

  it('默认取前 2 条，用「；」连接', () => {
    expect(firstEntries('甲\n乙\n丙')).toBe('甲；乙')
  })

  it('超过 max 时按 max 截断并补省略号（length === max + 1）', () => {
    const s = firstEntries('甲'.repeat(50), 1, 10)
    expect(s.endsWith('…')).toBe(true)
    expect(s.length).toBe(11)
  })

  it('正好等于 max 时**不**加省略号（边界：`>` 而非 `>=`）', () => {
    expect(firstEntries('甲'.repeat(10), 1, 10)).toBe('甲'.repeat(10))
  })

  it('max 减一就加省略号（边界另一侧）', () => {
    expect(firstEntries('甲'.repeat(10), 1, 9)).toBe('甲'.repeat(9) + '…')
  })

  it('默认 max 是 60：40 字原样、100 字截成 61', () => {
    expect(firstEntries('乙'.repeat(40), 1)).toBe('乙'.repeat(40))
    expect(firstEntries('乙'.repeat(100), 1)).toHaveLength(61)
  })

  it('摘要会剥掉列表前缀（不把「- 」带进状态栏）', () => {
    expect(firstEntries('- 还没说破', 1)).toBe('还没说破')
  })

  it('条目不足 N 条时全取，不补空', () => {
    expect(firstEntries('甲', 5)).toBe('甲')
  })

  it('🔴 占位行不进摘要：占位在前时取到的是后面的真内容', () => {
    expect(firstEntries('暂无\nA\nB', 2)).toBe('A；B')
  })
})

describe('memoryCounts / memoryEntryTotal · 六栏计数', () => {
  const m = mem('c1', {
    longTerm: '她最近话少了。',
    facts: '甲\n乙\n丙',
    relation: '还没说破',
    mines: '她不提苏念',
    anniversaries: '第一次见面：3 月 7 日\n答应过的旅行',
    diaries: '周一：去了书店\n周二：加班',
  })

  it('六栏逐栏计数与上游一致（1 / 3 / 1 / 1 / 2 / 2）', () => {
    const c = memoryCounts(m)
    expect(c.longTerm).toBe(1)
    expect(c.facts).toBe(3)
    expect(c.relation).toBe(1)
    expect(c.mines).toBe(1)
    expect(c.anniversaries).toBe(2)
    expect(c.diaries).toBe(2)
  })

  it('合计等于各栏之和', () => {
    expect(memoryEntryTotal(m)).toBe(10)
    const c = memoryCounts(m)
    expect(memoryEntryTotal(m)).toBe(c.longTerm + c.facts + c.relation + c.mines + c.anniversaries + c.diaries)
  })

  it('记忆为 null（从没整理过）→ 六栏全 0，且不抛错', () => {
    const c = memoryCounts(null)
    expect(Object.values(c).every(n => n === 0)).toBe(true)
    expect(memoryEntryTotal(null)).toBe(0)
  })

  it('记忆为 undefined → 六栏全 0', () => {
    expect(memoryEntryTotal(undefined)).toBe(0)
  })

  it('六栏键名齐全（漏一栏界面上就会少一行）', () => {
    expect(Object.keys(memoryCounts(null)).sort()).toEqual([
      'anniversaries',
      'diaries',
      'facts',
      'longTerm',
      'mines',
      'relation',
    ])
  })

  it('🔴 全占位／全空白视同没内容：合计 0（别把「暂无」数成记忆）', () => {
    expect(memoryEntryTotal(mem('c1', { longTerm: '暂无', facts: '   \n  ', mines: '——' }))).toBe(0)
  })
})

describe('agoText · 时间文案（阈值钉在边界值本身）', () => {
  it('时间戳为 0（未整理过）→ 默认文案「还没有记忆」', () => {
    expect(agoText(0, T0)).toBe('还没有记忆')
  })

  it('空态文案可替换（界面传「未整理」）', () => {
    expect(agoText(0, T0, '未整理')).toBe('未整理')
  })

  it('30 秒前 → 「刚刚」', () => {
    expect(agoText(T0 - 30_000, T0)).toBe('刚刚')
  })

  it('🔴 边界 60_000 − 1 仍是「刚刚」（`< 60_000`）', () => {
    expect(agoText(T0 - 59_999, T0)).toBe('刚刚')
  })

  it('🔴 边界 60_000 整 → 「1 分钟前」（不再走「刚刚」）', () => {
    expect(agoText(T0 - 60_000, T0)).toBe('1 分钟前')
  })

  it('59 分钟 → 「59 分钟前」', () => {
    expect(agoText(T0 - 59 * 60_000, T0)).toBe('59 分钟前')
  })

  it('🔴 边界 3_600_000 整 → 「1 小时前」（分钟档到此为止）', () => {
    expect(agoText(T0 - 3_600_000, T0)).toBe('1 小时前')
  })

  it('🔴 边界 3_600_000 − 1 还是分钟档', () => {
    expect(agoText(T0 - 3_599_999, T0)).toBe('59 分钟前')
  })

  it('2 小时 → 「2 小时前」', () => {
    expect(agoText(T0 - 2 * 3_600_000, T0)).toBe('2 小时前')
  })

  it('23 小时仍是小时档', () => {
    expect(agoText(T0 - 23 * 3_600_000, T0)).toBe('23 小时前')
  })

  it('🔴 边界 86_400_000 整 → 落到日期档（不再是「24 小时前」）', () => {
    const s = agoText(T0 - 86_400_000, T0)
    expect(s).not.toBe('24 小时前')
    expect(s).toMatch(/[/月]|\d{4}/)
  })

  it('未来时间戳（时钟漂移）不抛错，仍是字符串', () => {
    expect(typeof agoText(T0 + 10_000, T0)).toBe('string')
  })
})

describe('buildStatusModel · 状态一览组装', () => {
  const chars = [
    { id: 'c1', name: '洛汐', avatar: 'data:image/webp;base64,AAA' },
    { id: 'c2', name: '苏念' },
  ]
  const memories: Record<string, FreeMemory> = {
    c1: mem('c1', { relation: '朋友（她还没说破）', facts: '甲\n乙', mines: '丙', updatedAt: 1000 }),
    c2: mem('c2', { updatedAt: 5000 }),
  }

  function model(patch: Partial<Parameters<typeof buildStatusModel>[0]> = {}): StatusModel {
    return buildStatusModel({
      chars,
      memories,
      direction: { muted: ['c2'], talkativity: { c1: 85 } },
      userCharId: 'c1',
      ...patch,
    })
  }

  it('每个角色一行，顺序与 chars 一致', () => {
    const s = model()
    expect(s.rows).toHaveLength(2)
    expect(s.rows.map(r => r.charId)).toEqual(['c1', 'c2'])
    expect(s.rows.map(r => r.name)).toEqual(['洛汐', '苏念'])
  })

  it('头像原样带出；没填的卡没有 avatar 字段（不是空串）', () => {
    const s = model()
    expect(s.rows[0]!.avatar).toBe('data:image/webp;base64,AAA')
    expect(s.rows[1]!.avatar).toBeUndefined()
  })

  it('isUser 只在「本人那一行」为 true，其余为 undefined', () => {
    const s = model()
    expect(s.rows[0]!.isUser).toBe(true)
    expect(s.rows[1]!.isUser).toBeUndefined()
  })

  it('muted 只在被静音的卡上为 true', () => {
    const s = model()
    expect(s.rows[1]!.muted).toBe(true)
    expect(s.rows[0]!.muted).toBeUndefined()
  })

  it('talkBand 取话痨档名（85 → 话很多）', () => {
    expect(model().rows[0]!.talkBand).toBe('话很多')
  })

  it('🔴「均衡」档不显示档名（undefined，而不是字符串「均衡」）', () => {
    const s = model({ direction: { talkativity: { c1: DEFAULT_TALKATIVITY } } })
    expect(s.rows[0]!.talkBand).toBeUndefined()
  })

  it('没有 direction（本场没调过在场调度）→ 全部 talkBand 为 undefined', () => {
    const s = model({ direction: null })
    expect(s.rows.every(r => r.talkBand === undefined)).toBe(true)
  })

  it('relation 是摘要（前 2 条），relationFull 是原文整段', () => {
    const s = model({ memories: { c1: mem('c1', { relation: '甲\n乙\n丙' }) } })
    expect(s.rows[0]!.relation).toBe('甲；乙')
    expect(s.rows[0]!.relationFull).toBe('甲\n乙\n丙')
  })

  it('没整理过记忆的卡：relation / relationFull 都是空串', () => {
    const s = model()
    expect(s.rows[1]!.relation).toBe('')
    expect(s.rows[1]!.relationFull).toBe('')
  })

  it('每行带自己的三栏计数（facts / mines / anniversaries）', () => {
    const s = model()
    expect(s.rows[0]!.facts).toBe(2)
    expect(s.rows[0]!.mines).toBe(1)
    expect(s.rows[0]!.anniversaries).toBe(0)
  })

  it('🔴 empty 判定看「六栏合计是否为 0」：有内容的卡 false，没内容的卡 true', () => {
    const s = model()
    expect(s.rows[0]!.empty).toBe(false)
    expect(s.rows[1]!.empty).toBe(true)
  })

  it('汇总栏是各行之和（不是只算第一行）', () => {
    const s = model({
      memories: {
        c1: mem('c1', { facts: '甲\n乙', mines: '丙' }),
        c2: mem('c2', { facts: '丁' }),
      },
    })
    expect(s.facts).toBe(3)
    expect(s.mines).toBe(1)
    expect(s.anniversaries).toBe(0)
  })

  it('🔴 memoryUpdatedAt 取所有卡的**最新**时间（max，不是第一份）', () => {
    expect(model().memoryUpdatedAt).toBe(5000)
  })

  it('没有任何记忆时 memoryUpdatedAt 为 0', () => {
    expect(model({ memories: {} }).memoryUpdatedAt).toBe(0)
  })

  it('chars 为空 → 空模型（不该抛错）', () => {
    const s = buildStatusModel({ chars: [], memories: {} })
    expect(s.rows).toEqual([])
    expect(s.facts).toBe(0)
    expect(s.memoryUpdatedAt).toBe(0)
  })

  it('不传 memories（只想知道在场名单）→ 每行都 empty', () => {
    const s = buildStatusModel({ chars })
    expect(s.rows).toHaveLength(2)
    expect(s.rows.every(r => r.empty)).toBe(true)
  })

  it('没名字的卡显示「（未命名）」而不是空白', () => {
    const s = buildStatusModel({ chars: [{ id: 'x', name: '' }] })
    expect(s.rows[0]!.name).toBe('（未命名）')
  })

  it('更新设定时不会顺手改本场状态：buildStatusModel 是只读的（原对象未被改）', () => {
    const memories2: Record<string, FreeMemory> = { c1: mem('c1', { relation: '甲' }) }
    const snapshot = JSON.stringify(memories2)
    buildStatusModel({ chars, memories: memories2, userCharId: 'c1' })
    expect(JSON.stringify(memories2)).toBe(snapshot)
  })
})
