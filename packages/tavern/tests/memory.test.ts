/**
 * `memory.ts` 契约测试 —— 六栏记忆的**裁剪行为**、解析容错、退化保护与水位线。
 *
 * 这个模块最容易出的两类事故，本文件都从行为侧钉住：
 *
 *  ① **静默丢字 / 静默失忆**。「关键事实」「未爆的雷」只增不改，被整段丢掉就是失忆；
 *     「长期摘要」本来就会缩，缩过头同样是事故。这里把 `trimMemory` 的**牺牲顺序**
 *     和 `rollDiaries` 的**保留哪几条**逐条钉死。
 *  ② **串栏漂移**。记忆每轮整理都要反解析往返一次，正文里一句 `关系：…` 若被当成栏标题，
 *     其后所有内容都串进关系栏，一轮轮累积漂移。所以「只认行首、短别名必须独占一行」
 *     必须有失败用例守着。
 *
 * 上游对应断言：`_upstream_tmp/youth-fantasy-engine-main/tests/tavernMemory.test.ts`，
 * 已翻译其中与**本文件导出面**相关的部分（涉及 prompt/summarize/store 的断言不在本层范围，
 * 见报告「缺口」一节）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MEMORY_HARD_LIMIT,
  MEMORY_SECTIONS,
  MEMORY_SOFT_LIMIT,
  acquireSummaryLock,
  emptyMemory,
  isMemoryDegraded,
  isMemoryEmpty,
  isPlaceholder,
  limitsOf,
  memoryChars,
  memoryToText,
  messagesAfterWatermark,
  nextWatermark,
  parseMemoryText,
  releaseSummaryLock,
  rollDiaries,
  trimMemory,
  watermarkAfterRoundEnd,
} from '../src/memory.js'
import {
  FACTS_MAX_LINES,
  MEMORY_DIARY_DAYS,
  MEMORY_LONGTERM_LIMIT,
  SUMMARY_LOCK_TTL_MS,
  type FreeMemory,
  type TavernMessage,
} from '../src/types.js'

const NOW = 1_700_000_000_000

/**
 * `memory.ts` 的跨实例锁走宿主注入的 `localStorage`（上游同步前端，逐字保留）。
 * 本包**不内建任何桩**（源码里没有第二套实现），所以由测试提供一个最小的内存实现 ——
 * 这也是「零宿主依赖」的含义：宿主给什么就用什么，不给就走 catch 分支。
 */
function installLocalStorage(overrides: Partial<Record<'getItem' | 'setItem' | 'removeItem', () => never>> = {}): void {
  const store = new Map<string, string>()
  const ls = {
    get length(): number { return store.size },
    clear(): void { store.clear() },
    getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
    key: (i: number): string | null => [...store.keys()][i] ?? null,
    removeItem: (k: string): void => { store.delete(k) },
    setItem: (k: string, v: string): void => { store.set(k, String(v)) },
    ...overrides,
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true })
}

function msg(id: string, role: TavernMessage['role'], content = id, extra: Partial<TavernMessage> = {}): TavernMessage {
  return { id, role, content, at: NOW, ...extra }
}

/** 造一份有内容的记忆：只覆盖要测的栏，其余留空 */
function mem(parts: Partial<FreeMemory>): FreeMemory {
  return { ...emptyMemory('c1'), ...parts }
}

/** `- MM-DD` 形式的 N 条日记，第 1 条是最上面（最新）的 */
function diaryLines(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `- 03-${String(28 - i).padStart(2, '0')} 第 ${i + 1} 条`)
}

/** 重复 N 个汉字的长文本（用来精确跨越字数阈值） */
function chars(n: number, ch = '字'): string {
  return ch.repeat(n)
}

/** 每条 100 字的「事实行」，用来把 facts / mines 撑过硬上限 */
function factLine(n: number): string {
  return `第 ${n} 条`.padEnd(100, '实')
}

beforeEach(() => {
  installLocalStorage()
  releaseSummaryLock()
})

describe('常量与 limitsOf', () => {
  it('四个上限常量与上游一致（改这里等于改契约）', () => {
    expect(MEMORY_SOFT_LIMIT).toBe(2000)
    expect(MEMORY_HARD_LIMIT).toBe(3000)
    expect(MEMORY_LONGTERM_LIMIT).toBe(500)
    expect(MEMORY_DIARY_DAYS).toBe(7)
  })

  it('limitsOf 不传 opts 时全用内置默认；传了就逐项覆盖（未传的仍回落默认）', () => {
    expect(limitsOf()).toEqual({ hardLimit: 3000, longTermLimit: 500, diaryDays: 7 })
    expect(limitsOf(undefined)).toEqual(limitsOf())
    expect(limitsOf({ hardLimit: 100 })).toEqual({ hardLimit: 100, longTermLimit: 500, diaryDays: 7 })
    expect(limitsOf({ diaryDays: 2, longTermLimit: 10 })).toEqual({ hardLimit: 3000, longTermLimit: 10, diaryDays: 2 })
  })

  it('六栏的键与标题、以及顺序（顺序即展示顺序，序列化与解析共用）', () => {
    expect(MEMORY_SECTIONS.map(s => s.title)).toEqual([
      '一、长期摘要', '二、关键事实', '三、关系状态', '四、未爆的雷', '五、纪念日与待办', '六、最近日记',
    ])
  })
})

describe('空态与字数', () => {
  it('空记忆判定为白纸；null / undefined 也算白纸', () => {
    expect(isMemoryEmpty(emptyMemory('c1'))).toBe(true)
    expect(isMemoryEmpty(null)).toBe(true)
    expect(isMemoryEmpty(undefined)).toBe(true)
    expect(isMemoryEmpty(mem({ facts: '甲' }))).toBe(false)
  })

  it('memoryChars 只数六栏内容，不含栏目标题', () => {
    const m = mem({ longTerm: chars(10), facts: chars(5) })
    expect(memoryChars(m)).toBe(15)
    expect(memoryChars(m)).toBeLessThan(memoryToText(m).length)
  })

  it('序列化：六栏标题齐全（用输入侧 〖〗）、空栏显示为（暂无）', () => {
    const text = memoryToText(emptyMemory('c1'))
    for (const s of MEMORY_SECTIONS) expect(text).toContain(`〖${s.title}〗`)
    expect(text).toContain('（暂无）')
    expect(text.split('\n\n')).toHaveLength(6)
  })
})

describe('isPlaceholder · 占位写法（空层不占额度是红线）', () => {
  it('各种占位写法都算「什么都没写」', () => {
    for (const p of [
      '', '   ', '暂无', '（暂无）', '无', '没有', '略', '空', '无内容', '待补充', '待补', '未提及',
      '尚未发生', '还没有发生过任何事', '（还没有发生过任何事）', '还没有发生任何事', '什么都没有发生过',
      '未发生任何事', '尚未确定', '暂不确定', '尚不确定', '未确定',
      '-', '—', '–', '－', '_', '--', '....', '…', '……', '【暂无】', '《无》', '( 暂无 )', '没 有',
    ]) {
      expect(isPlaceholder(p), `占位「${p}」应被认出`).toBe(true)
    }
  })

  it('真内容里出现占位词不算占位（只匹配整段就是占位）', () => {
    for (const real of [
      '其实早定了', 'Ta 说「没有什么」', '长期摘要：暂无进展，但关系在回暖', '无事发生的那天',
    ]) {
      expect(isPlaceholder(real), `「${real}」是真内容`).toBe(false)
    }
  })
})

describe('rollDiaries · 日记滚动（硬性只留最近 N 条）', () => {
  it('占位行不算一条日记', () => {
    expect(rollDiaries('-')).toBe('')
    expect(rollDiaries('—')).toBe('')
    expect(rollDiaries('（暂无）')).toBe('')
    expect(rollDiaries('')).toBe('')
  })

  it(`只保留最近 ${MEMORY_DIARY_DAYS} 条，且保留的是**最上面（最新）**的几条`, () => {
    const rolled = rollDiaries(diaryLines(20).join('\n'))
    expect(rolled.split('\n')).toHaveLength(MEMORY_DIARY_DAYS)
    expect(rolled.startsWith('- 03-28')).toBe(true)
    expect(rolled).toContain('- 03-22')
    expect(rolled).not.toContain('- 03-21')
  })

  it('条数不足时原样保留（不补空行、不报错）', () => {
    const three = diaryLines(3).join('\n')
    expect(rollDiaries(three)).toBe(three)
    expect(rollDiaries('')).toBe('')
  })

  it('keep 可覆盖：把上限调到 2 就只留 2 条', () => {
    expect(rollDiaries(diaryLines(5).join('\n'), 2).split('\n')).toHaveLength(2)
  })

  it('占位行被丢掉后，空出来的名额由更早的真日记补上', () => {
    const text = ['- 03-28 甲', '-', '（暂无）', '- 03-27 乙', '- 03-26 丙'].join('\n')
    expect(rollDiaries(text, 3)).toBe(['- 03-28 甲', '- 03-27 乙', '- 03-26 丙'].join('\n'))
  })

  it('每行两端空白被 trim（模型的缩进不该变成内容）', () => {
    expect(rollDiaries('  - 03-28 甲  \n\t- 03-27 乙').split('\n')).toEqual(['- 03-28 甲', '- 03-27 乙'])
  })
})

describe('trimMemory · 裁剪行为（超限裁谁、保留谁、顺序如何）', () => {
  it('长期摘要超 longTermLimit 被截到上限内', () => {
    const t = trimMemory(mem({ longTerm: chars(MEMORY_LONGTERM_LIMIT * 3) }))
    expect(t.longTerm.length).toBeLessThanOrEqual(MEMORY_LONGTERM_LIMIT)
  })

  it('日记先滚动到 diaryDays 条（这一步与是否超硬上限无关）', () => {
    const t = trimMemory(mem({ diaries: diaryLines(30).join('\n') }))
    expect(t.diaries.split('\n')).toHaveLength(MEMORY_DIARY_DAYS)
  })

  it('未超硬上限时 **不动** facts / mines（不失忆的底线）', () => {
    const m = mem({ longTerm: chars(100), facts: '甲\n乙\n丙', mines: '埋着的那封信' })
    const t = trimMemory(m)
    expect(t.facts).toBe(m.facts)
    expect(t.mines).toBe(m.mines)
    expect(t.relation).toBe(m.relation)
    expect(t.anniversaries).toBe(m.anniversaries)
  })

  it('超硬上限时按顺序牺牲：长期摘要 → 纪念日 → 关系状态，且这一段仍**不动** facts / mines', () => {
    // 构造：longTerm 恰好 500（首轮截断不生效）＋纪念日 1200＋关系 3000 → 总量约 4700。
    // 依次：longTerm 砍到 0.6 倍(300) → 仍超 → 纪念日砍到 120 → 仍超 → 关系砍到 160。
    const m = mem({
      longTerm: chars(MEMORY_LONGTERM_LIMIT),
      anniversaries: chars(1200, '念'),
      relation: chars(3000, '关'),
      facts: '甲\n乙',
      mines: '埋着的雷',
    })
    expect(memoryChars(m)).toBeGreaterThan(MEMORY_HARD_LIMIT)
    const t = trimMemory(m)
    expect(t.longTerm.length).toBeLessThan(MEMORY_LONGTERM_LIMIT) // 被砍到 0.6 倍
    expect(t.longTerm.length).toBeLessThanOrEqual(Math.floor(MEMORY_LONGTERM_LIMIT * 0.6))
    expect(t.anniversaries.length).toBeLessThanOrEqual(120)
    expect(t.relation.length).toBeLessThanOrEqual(160)
    expect(memoryChars(t)).toBeLessThanOrEqual(MEMORY_HARD_LIMIT)
    expect(t.facts).toBe(m.facts)
    expect(t.mines).toBe(m.mines)
  })

  it('🔴 牺牲到总量落回硬上限以内就**停手**（不把可重建的四栏一次性砍光）', () => {
    // 同上，但关系只有 1800：longTerm→300、纪念日→120 之后总量已落回上限内，
    // 于是关系状态**原样保留**。若实现无条件砍满三栏，这条会失败。
    const m = mem({
      longTerm: chars(MEMORY_LONGTERM_LIMIT),
      anniversaries: chars(1200, '念'),
      relation: chars(1800, '关'),
      facts: '甲\n乙',
      mines: '埋着的雷',
    })
    expect(memoryChars(m)).toBeGreaterThan(MEMORY_HARD_LIMIT)
    const t = trimMemory(m)
    expect(t.anniversaries.length).toBeLessThanOrEqual(120)
    expect(t.relation).toBe(m.relation) // 停手：没被砍
    expect(memoryChars(t)).toBeLessThanOrEqual(MEMORY_HARD_LIMIT)
  })

  it('🔴 压完前四栏仍超硬上限时才动 facts / mines，且取**后** N 行（越靠后越新）', () => {
    const lines = Array.from({ length: FACTS_MAX_LINES + 8 }, (_, i) => factLine(i + 1))
    const m = mem({
      longTerm: chars(MEMORY_LONGTERM_LIMIT),
      anniversaries: chars(1200, '念'),
      relation: chars(1200, '关'),
      facts: lines.join('\n'),
      mines: lines.join('\n'),
    })
    // 前四栏压到底之后 500 + 120 + 160 = 780 字，facts/mines 各 2000 字 → 必然仍超 3000
    expect(memoryChars(m)).toBeGreaterThan(MEMORY_HARD_LIMIT)
    const t = trimMemory(m)
    expect(t.facts.split('\n')).toHaveLength(FACTS_MAX_LINES)
    expect(t.mines.split('\n')).toHaveLength(FACTS_MAX_LINES)
    // 取后 12 条：最上面 8 行被丢掉，第一条保留的是第 9 条，最后一条仍在
    expect(t.facts.startsWith('第 9 条')).toBe(true)
    expect(t.facts.endsWith(`第 ${FACTS_MAX_LINES + 8} 条`.padEnd(100, '实'))).toBe(true)
    expect(t.mines).toBe(t.facts)
  })

  it('facts / mines 行数不足 FACTS_MAX_LINES 时原样返回（不裁不补）', () => {
    const m = mem({
      longTerm: chars(MEMORY_LONGTERM_LIMIT * 4, '长'),
      anniversaries: chars(1200, '念'),
      relation: chars(1200, '关'),
      facts: '甲\n乙',
      mines: '丙',
    })
    const t = trimMemory(m)
    expect(t.facts).toBe('甲\n乙')
    expect(t.mines).toBe('丙')
  })

  it('硬上限可被 opts 覆盖（控制面板改小后立刻生效）', () => {
    const m = mem({ longTerm: chars(400), facts: '甲\n乙\n丙' })
    expect(memoryChars(m)).toBeLessThanOrEqual(MEMORY_HARD_LIMIT)
    const t = trimMemory(m, { hardLimit: 100 })
    expect(t.longTerm.length).toBeLessThanOrEqual(Math.floor(MEMORY_LONGTERM_LIMIT * 0.6))
  })

  it('裁剪不原地改传进来的对象（调用方还拿着旧档案）', () => {
    const m = mem({ longTerm: chars(MEMORY_LONGTERM_LIMIT * 2), diaries: diaryLines(20).join('\n') })
    const before = { ...m }
    trimMemory(m)
    expect(m.longTerm).toBe(before.longTerm)
    expect(m.diaries).toBe(before.diaries)
  })

  it('裁剪保留 charId / updatedAt 等非内容字段', () => {
    const m = { ...emptyMemory('char-9'), longTerm: chars(2000), updatedAt: 12345 }
    const t = trimMemory(m)
    expect(t.charId).toBe('char-9')
    expect(t.updatedAt).toBe(12345)
  })
})

describe('isMemoryDegraded · 整份退化判定', () => {
  it('没有旧档案 → 不算退化（第一次建档本来就短）', () => {
    expect(isMemoryDegraded(emptyMemory('c1'), undefined)).toBe(false)
    expect(isMemoryDegraded(emptyMemory('c1'), null)).toBe(false)
  })

  it('旧档案 ≤200 字时不套用（短档案的正常波动不该误报）', () => {
    expect(isMemoryDegraded(emptyMemory('c1'), mem({ longTerm: chars(200) }))).toBe(false)
    expect(isMemoryDegraded(emptyMemory('c1'), mem({ longTerm: chars(201) }))).toBe(true)
  })

  it('新档案不足旧档案的 40% → 退化；恰好 40% → 不退化（边界闭合）', () => {
    const prev = mem({ longTerm: chars(1000) })
    expect(isMemoryDegraded(mem({ longTerm: chars(400) }), prev)).toBe(false)
    expect(isMemoryDegraded(mem({ longTerm: chars(399) }), prev)).toBe(true)
    expect(isMemoryDegraded(emptyMemory('c1'), prev)).toBe(true)
  })
})

describe('parseMemoryText · 解析与容错', () => {
  it('六栏标题都解析出来（加粗 / 自带序号 / 无序号 都认）', () => {
    const text = [
      '**一、长期摘要**', '修东西的日子。',
      '二、关键事实', '苏念在便利店上夜班。',
      '3. 关系状态', '与小满：回暖',
      '〖四、未爆的雷〗', 'Ta 还压着那封信',
      '五、纪念日与待办', '03-15 她的生日',
      '六、最近日记', '- 03-15 下雨了',
    ].join('\n')
    const got = parseMemoryText(text, 'c1')
    expect(got.longTerm).toBe('修东西的日子。')
    expect(got.facts).toBe('苏念在便利店上夜班。')
    expect(got.relation).toBe('与小满：回暖')
    expect(got.mines).toBe('Ta 还压着那封信')
    expect(got.anniversaries).toBe('03-15 她的生日')
    expect(got.diaries).toBe('- 03-15 下雨了')
  })

  it('标题与内容同行（「长期摘要：甲」）→ 剩余部分当本栏首行，别丢', () => {
    expect(parseMemoryText('长期摘要：甲\n乙', 'c1').longTerm).toBe('甲\n乙')
    expect(parseMemoryText('三、关系状态：与小满回暖', 'c1').relation).toBe('与小满回暖')
  })

  it('标题之前的内容（模型先寒暄一句）被忽略，不当成档案正文', () => {
    const got = parseMemoryText('好的，我整理好了：\n一、长期摘要\n甲', 'c1')
    expect(got.longTerm).toBe('甲')
    expect(got.facts).toBe('')
  })

  it('🔴 正文里的「关系：…」不被当成栏标题（留在原栏，不串栏）', () => {
    const s = parseMemoryText(['一、长期摘要', '她最近在修东西。', '关系：与小满已冷淡', '继续修。'].join('\n'), 'c1')
    expect(s.longTerm).toBe('她最近在修东西。\n关系：与小满已冷淡\n继续修。')
    expect(s.relation).toBe('')
  })

  it('🔴 正文里的「日记：…」同样不切栏', () => {
    const s = parseMemoryText(['三、关系状态', '还行。', '日记：今天下雨了'].join('\n'), 'c1')
    expect(s.diaries).toBe('')
    expect(s.relation).toBe('还行。\n日记：今天下雨了')
  })

  it('🔴 正文里的「待办：…」不切栏，留在纪念日栏', () => {
    const s = parseMemoryText(['五、纪念日与待办', '记着一件事。', '待办：明天去买伞'].join('\n'), 'c1')
    expect(s.anniversaries).toBe('记着一件事。\n待办：明天去买伞')
  })

  it('「未爆」独占一行才认（真标题写法保留容错）', () => {
    expect(parseMemoryText('未爆\nTa还压着那封信', 'c1').mines).toBe('Ta还压着那封信')
    expect(parseMemoryText('未爆：Ta还压着那封信', 'c1').mines).toBe('')
  })

  it('全称标题不受「必须独占一行」限制（「三、关系状态：内容」仍认）', () => {
    expect(parseMemoryText('三、关系状态：与小满回暖', 'c1').relation).toBe('与小满回暖')
  })

  it('别名回退：模型写「长期记忆 / 重要事实 / 埋着的雷 / 待引爆 / 日记」都认', () => {
    expect(parseMemoryText('长期记忆\n甲', 'c1').longTerm).toBe('甲')
    expect(parseMemoryText('重要事实\n甲', 'c1').facts).toBe('甲')
    expect(parseMemoryText('关键事实\n甲', 'c1').facts).toBe('甲')
    expect(parseMemoryText('埋着的雷\n甲', 'c1').mines).toBe('甲')
    expect(parseMemoryText('待引爆\n甲', 'c1').mines).toBe('甲')
    expect(parseMemoryText('待办\n甲', 'c1').anniversaries).toBe('甲')
    expect(parseMemoryText('纪念日\n甲', 'c1').anniversaries).toBe('甲')
    expect(parseMemoryText('日记\n- 03-15 甲', 'c1').diaries).toBe('- 03-15 甲')
  })

  it('别名优先级：先命中「长期记忆」就不再落到「长期摘要」', () => {
    // 两个别名同在前缀里，「长期记忆」在回退链里更靠前 —— 行首只认一次。
    expect(parseMemoryText('长期记忆\n甲', 'c1').longTerm).toBe('甲')
  })

  it('占位行被丢掉；整栏只剩占位 → 空栏', () => {
    for (const c of ['暂无', '-', '（还没有发生过任何事）', '……', '待补充']) {
      expect(parseMemoryText(`四、未爆的雷\n${c}`, 'c1').mines, `占位「${c}」`).toBe('')
    }
    const mixed = parseMemoryText('四、未爆的雷\n暂无\nTa把信藏进了抽屉', 'c1')
    expect(mixed.mines).toBe('Ta把信藏进了抽屉')
    const real = parseMemoryText('四、未爆的雷\n其实早定了，只是她不肯说', 'c1')
    expect(real.mines).toBe('其实早定了，只是她不肯说')
  })

  it('CRLF 输入与 LF 等价（Windows 上的模型输出不炸）', () => {
    const crlf = parseMemoryText('一、长期摘要\r\n甲\r\n二、关键事实\r\n乙', 'c1')
    expect(crlf.longTerm).toBe('甲')
    expect(crlf.facts).toBe('乙')
  })

  it('空文本 / 全是废话 → 六栏全空，但 charId 保留', () => {
    const got = parseMemoryText('', 'c9')
    expect(got.charId).toBe('c9')
    expect(memoryChars(got)).toBe(0)
    expect(isMemoryEmpty(parseMemoryText('（她点头）\n好。', 'c9'))).toBe(true)
  })

  it('charId 与 updatedAt：解析出来的档案打上 charId 并刷新 updatedAt', () => {
    const got = parseMemoryText('一、长期摘要\n甲', 'char-7')
    expect(got.charId).toBe('char-7')
    expect(got.updatedAt).toBeGreaterThan(0)
  })

  it('解析结果同样受裁剪约束（模型写超长也不越硬上限）', () => {
    const got = parseMemoryText(`一、长期摘要\n${chars(5000)}`, 'c1')
    expect(got.longTerm.length).toBeLessThanOrEqual(MEMORY_LONGTERM_LIMIT)
  })
})

describe('parseMemoryText · 「只增不改」两栏的丢失保护', () => {
  const prev = mem({ facts: '苏念在便利店上夜班。\n她有个弟弟。', mines: 'Ta还压着那封信', longTerm: chars(300, '旧') })

  it('关键事实整段丢失时沿用旧值（失忆比重复更糟）', () => {
    const got = parseMemoryText(`一、长期摘要\n${chars(300, '新')}\n四、未爆的雷\nTa还压着那封信`, 'c1', prev)
    expect(got.facts).toBe(prev.facts)
  })

  it('未爆的雷整段丢失时沿用旧值', () => {
    const got = parseMemoryText(`一、长期摘要\n${chars(300, '新')}\n二、关键事实\n苏念在便利店上夜班。\n她有个弟弟。`, 'c1', prev)
    expect(got.mines).toBe(prev.mines)
  })

  it('长期摘要允许被改写（它本来就该缩）', () => {
    const got = parseMemoryText(`一、长期摘要\n${chars(300, '新')}\n二、关键事实\n苏念在便利店上夜班。\n她有个弟弟。\n四、未爆的雷\nTa还压着那封信`, 'c1', prev)
    expect(got.longTerm).toBe(chars(300, '新'))
  })

  it('模型给出新内容时以新为准', () => {
    // 用一份「短档案」：总字数 ≤ 200 时不做整份退化判定，专门看「两栏的丢失保护」这一层。
    const small = mem({ facts: '苏念在便利店上夜班。\n她有个弟弟。', mines: 'Ta还压着那封信' })
    const got = parseMemoryText('二、关键事实\n她换了工作。\n四、未爆的雷\nTa还压着那封信', 'c1', small)
    expect(got.facts).toContain('换了工作')
  })

  it('旧值为空时不回填（不伪造出内容）', () => {
    const got = parseMemoryText('一、长期摘要\n甲', 'c1', emptyMemory('c1'))
    expect(got.facts).toBe('')
    expect(got.mines).toBe('')
  })
})

describe('parseMemoryText · 整份退化保护', () => {
  const prev = mem({ longTerm: chars(600, '旧'), facts: chars(400, '事'), mines: chars(200, '雷') })

  it('🔴 模型把六栏写成散文（四栏一起空）→ 整份回退旧档案 + 如实上报', () => {
    const onDegraded = vi.fn()
    const got = parseMemoryText('好的，我整理好了，一切都好。', 'c1', prev, undefined, onDegraded)
    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(onDegraded).toHaveBeenCalledWith('模型输出比旧档案少太多，本次未覆盖旧档案（原样保留）')
    // 回退的是「旧档案」，且同样要过一遍 trimMemory（这里 prev.longTerm=600 超 500 会被截）
    const kept = trimMemory(prev)
    expect(got.longTerm).toBe(kept.longTerm)
    expect(got.facts).toBe(prev.facts)
    expect(got.mines).toBe(prev.mines)
    expect(got.updatedAt).toBeGreaterThan(0)
  })

  it('🔴 退化判定用**回填前**的档案：mines 能被回填回来，但照样必须判出退化', () => {
    // 只留 mines（会被 APPEND_ONLY 回填）——若实现拿回填后的 out 去算字数就会漏判。
    const onDegraded = vi.fn()
    const got = parseMemoryText(`四、未爆的雷\n${chars(200, '雷')}`, 'c1', prev, undefined, onDegraded)
    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(got.longTerm).toBe(trimMemory(prev).longTerm)
  })

  it('退化时保留旧档案内容，但 updatedAt 刷新（界面据此显示「原样保留」后的时间）', async () => {
    const before = { ...prev, updatedAt: 1 }
    const got = parseMemoryText('什么都没有。', 'c1', before)
    expect(got.updatedAt).toBeGreaterThan(1)
  })

  it('没有旧档案时不判退化（第一次建档再短也照收）', () => {
    const onDegraded = vi.fn()
    const got = parseMemoryText('一、长期摘要\n短', 'c1', undefined, undefined, onDegraded)
    expect(onDegraded).not.toHaveBeenCalled()
    expect(got.longTerm).toBe('短')
  })

  it('退化回退的旧档案同样受裁剪约束（不会把超长旧档案原样带回来）', () => {
    const huge = mem({ longTerm: chars(MEMORY_LONGTERM_LIMIT * 4, '旧'), diaries: diaryLines(30).join('\n') })
    const got = parseMemoryText('什么都没有。', 'c1', huge)
    expect(got.longTerm.length).toBeLessThanOrEqual(MEMORY_LONGTERM_LIMIT)
    expect(got.diaries.split('\n')).toHaveLength(MEMORY_DIARY_DAYS)
  })
})

describe('水位线 · nextWatermark / watermarkAfterRoundEnd', () => {
  it('水位线推进到最后一条（排除 system 与 hidden）', () => {
    const wm = nextWatermark({
      messages: [
        msg('a', 'user'), msg('b', 'assistant'), msg('c', 'system', '系统'),
        msg('d', 'assistant'), msg('e', 'user', '隐藏的', { hidden: true }),
      ],
    })
    expect(wm?.messageId).toBe('d')
    expect(typeof wm?.at).toBe('number')
  })

  it('空会话（或只剩 system / hidden）不产生水位线', () => {
    expect(nextWatermark({ messages: [] })).toBeNull()
    expect(nextWatermark({ messages: [msg('a', 'system', 's'), msg('b', 'user', 'x', { hidden: true })] })).toBeNull()
  })

  it('🔴 退化 ⇒ 保留旧水位（那段没被总结的对话下次还会被算进去）', () => {
    const w1 = { messageId: 'a', at: 1 }
    const w2 = { messageId: 'b', at: 2 }
    expect(watermarkAfterRoundEnd(w1, w2, true)).toBe(w1)
  })

  it('未退化 ⇒ 推进到新水位', () => {
    const w1 = { messageId: 'a', at: 1 }
    const w2 = { messageId: 'b', at: 2 }
    expect(watermarkAfterRoundEnd(w1, w2, false)).toBe(w2)
  })

  it('未退化但算不出新水位 ⇒ 退回旧值（不写成 undefined 把水位线擦掉）', () => {
    const w1 = { messageId: 'a', at: 1 }
    expect(watermarkAfterRoundEnd(w1, null, false)).toBe(w1)
  })

  it('退化 + 本来就没有旧水位 ⇒ 仍是 undefined；两边都没有 ⇒ undefined', () => {
    const w2 = { messageId: 'b', at: 2 }
    expect(watermarkAfterRoundEnd(undefined, w2, true)).toBeUndefined()
    expect(watermarkAfterRoundEnd(undefined, null, false)).toBeUndefined()
  })
})

describe('messagesAfterWatermark · 取出尚未总结的消息', () => {
  const messages = [
    msg('a', 'user'), msg('b', 'assistant'), msg('c', 'user'), msg('d', 'assistant'),
  ]

  it('无水位线 → 全部（宁可多总结一次，也别漏掉一大段）', () => {
    expect(messagesAfterWatermark(messages).map(m => m.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(messagesAfterWatermark(messages, null).map(m => m.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('命中水位线 → 只取它之后的消息', () => {
    expect(messagesAfterWatermark(messages, { messageId: 'b' }).map(m => m.id)).toEqual(['c', 'd'])
    expect(messagesAfterWatermark(messages, { messageId: 'd' })).toEqual([])
  })

  it('system 与 hidden 一律排除（隐藏的语义就是「别让 AI 看见」）', () => {
    const withNoise = [
      msg('a', 'user'), msg('s', 'system', 's'), msg('h', 'assistant', 'h', { hidden: true }), msg('b', 'assistant'),
    ]
    expect(messagesAfterWatermark(withNoise).map(m => m.id)).toEqual(['a', 'b'])
  })

  it('🔴 水位线消息被删 / 被隐藏时按时间戳兜底，不整场重喂', () => {
    const older = [
      msg('a', 'user', 'a', { at: 100 }),
      msg('b', 'assistant', 'b', { at: 200 }),
      msg('c', 'user', 'c', { at: 300 }),
    ]
    expect(messagesAfterWatermark(older, { messageId: 'b', at: 200 }).map(m => m.id)).toEqual(['c'])
  })

  it('连时间也没有（老数据）→ 只能按「全部未总结」处理', () => {
    const older = [msg('a', 'user'), msg('c', 'user')]
    expect(messagesAfterWatermark(older, { messageId: 'gone' }).map(m => m.id)).toEqual(['a', 'c'])
  })

  it('时间戳兜底没筛掉任何一条时也退回全部（不返回空数组）', () => {
    const all = [msg('a', 'user', 'a', { at: 1 }), msg('b', 'user', 'b', { at: 2 })]
    expect(messagesAfterWatermark(all, { messageId: 'gone', at: 0 }).map(m => m.id)).toEqual(['a', 'b'])
  })
})

describe('跨实例锁 · acquireSummaryLock / releaseSummaryLock', () => {
  it('无锁时可取；已被取走时取不到（挡住两个窗口同时跑）', () => {
    expect(acquireSummaryLock(NOW)).toBe(true)
    expect(acquireSummaryLock(NOW + 1000)).toBe(false)
  })

  it('释放后可再取', () => {
    expect(acquireSummaryLock(NOW)).toBe(true)
    releaseSummaryLock()
    expect(acquireSummaryLock(NOW + 1)).toBe(true)
  })

  it('陈旧锁超过 TTL 可被接管', () => {
    expect(acquireSummaryLock(NOW)).toBe(true)
    expect(acquireSummaryLock(NOW + SUMMARY_LOCK_TTL_MS - 1)).toBe(false)
    expect(acquireSummaryLock(NOW + SUMMARY_LOCK_TTL_MS)).toBe(true)
  })

  it('锁里存的是非数字脏值时按「可取」处理（不让坏数据永久锁死）', () => {
    localStorage.setItem('yfe-tavern-summary-lock', 'not-a-number')
    expect(acquireSummaryLock(NOW)).toBe(true)
  })

  it('localStorage 不可用时返回 true（不因此阻塞功能），释放也不抛', () => {
    installLocalStorage({
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
    })
    expect(acquireSummaryLock(NOW)).toBe(true)
    expect(() => releaseSummaryLock()).not.toThrow()
  })
})
