/**
 * `cardFields.ts` 契约测试 —— 角色卡细字段的「标记文本 ⇄ 小格」往返。
 *
 * 这一层是字段化的地基：`FreeCharacter` 存的是**一段标记文本**，界面把它拆成若干小格给作者填。
 * 往返做错了就是**静默丢字** —— 既可能吞掉作者手打的内容，也可能把 AI 更新设定时写的散文丢掉，
 * 而这类丢法在界面上看不出来。所以这里钉死四条：
 *
 *   ① 认得出的标签 → 各归各位（`key` / `label` / **历史旧长名**三路都认）；
 *   ② **认不出来的行一律进「其他」**（老数据是散文，AI 也常写散文）；
 *   ③ 空值不进输出，别把一堆空标签写进库里；
 *   ④ 写入侧只规范化**认得出的标签**的冒号，散文本一个字符都不动。
 *
 * 上游对应断言：`_upstream_tmp/youth-fantasy-engine-main/tests/tavernCardFields.test.ts`
 * （自写断言脚本，本文件按 vitest 形态重写，并补了「模板生成物 / 提示词片段」的空缺覆盖）。
 */

import { describe, expect, it } from 'vitest'

import {
  CONDUCT_SPECS,
  OTHER_KEY,
  PROFILE_SPECS,
  filledCount,
  normalizeStructMarkup,
  packField,
  structFieldLines,
  structHintFor,
  structSpecOf,
  unpackField,
} from '../src/cardFields.js'
import { CARD_FIELDS } from '../src/types.js'

/** 2.1 外在：整份测试里最常用的那一栏 */
const EXT = PROFILE_SPECS[0]!
/** 2.2 内核 */
const CORE = PROFILE_SPECS[1]!
/** 取某栏（含第 3 章），顺便把「模板确实存在」这件事变成测试失败而不是 `!` */
function specOf(path: string) {
  const s = structSpecOf(path)
  if (!s) throw new Error(`模板缺失：${path}`)
  return s
}

describe('unpackField · 标签识别', () => {
  it('已知的标签进对应的格，没提到的格是空串', () => {
    const v = unpackField('性别与年龄：女，27 岁\n外貌：短发\n随身物件：掉漆的打火机', EXT)
    expect(v['性别与年龄']).toBe('女，27 岁')
    expect(v['外貌']).toBe('短发')
    expect(v['随身物件']).toBe('掉漆的打火机')
    expect(v['穿着']).toBe('')
  })

  it('空文本 / 纯空白解包不炸，且每一格都是空串（含「其他」）', () => {
    for (const empty of ['', '   \n  \n ', '\r\n']) {
      const v = unpackField(empty, EXT)
      expect(Object.values(v).every(x => x === '')).toBe(true)
      expect(Object.keys(v)).toContain(OTHER_KEY)
    }
  })

  it('整段散文落「其他」，一个字不丢', () => {
    const prose = '短发，总穿同一件洗旧的灰色围裙，左手腕有道旧疤。'
    expect(unpackField(prose, EXT)[OTHER_KEY]).toBe(prose)
  })

  it('混合文本：有标签的归位、没标签的进「其他」', () => {
    const m = unpackField('外貌：短发\n习惯把手插进围裙口袋。', EXT)
    expect(m['外貌']).toBe('短发')
    expect(m[OTHER_KEY]).toBe('习惯把手插进围裙口袋。')
  })

  it('同一标签出现两次要拼接，不许第二行把第一行顶掉', () => {
    expect(unpackField('外貌：短发\n外貌：还有一道旧疤', EXT)['外貌']).toBe('短发\n还有一道旧疤')
  })

  it('多行散文按原顺序合并进「其他」', () => {
    const v = unpackField('第一句。\n外貌：短发\n第二句。', EXT)
    expect(v[OTHER_KEY]).toBe('第一句。\n第二句。')
    expect(v['外貌']).toBe('短发')
  })

  it('🔴 半角冒号那一行认不出标签 —— 所以写入侧必须 normalizeStructMarkup', () => {
    // 这是「写入侧规范化」存在的唯一理由：读入侧只认全角冒号。
    const v = unpackField('外貌: 短发', EXT)
    expect(v['外貌']).toBe('')
    expect(v[OTHER_KEY]).toBe('外貌: 短发')
  })

  it('行首就是全角冒号的行不算标签，整行进「其他」', () => {
    expect(unpackField('：空标签', EXT)[OTHER_KEY]).toBe('：空标签')
  })

  it('「其他」自己也能被显式写出（值与散文本合并）', () => {
    const v = unpackField(`外貌：短发\n${OTHER_KEY}：口袋里总有一把糖`, EXT)
    expect(v[OTHER_KEY]).toBe('口袋里总有一把糖')
  })
})

describe('packField · 打包', () => {
  it('空值的格不写进文本，只写非空的格', () => {
    const packed = packField({ 外貌: '短发', 穿着: '' }, EXT)
    expect(packed).toBe('外貌：短发')
    expect(packed).not.toContain('穿着')
  })

  it('「其他」有值时保留，且永远排在最后', () => {
    const packed = packField({ 外貌: '短发', 性别与年龄: '女，27 岁', [OTHER_KEY]: '口袋里有糖' }, EXT)
    const lines = packed.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[2]).toBe(`${OTHER_KEY}：口袋里有糖`)
  })

  it('按模板顺序排列，不按传入对象的键序', () => {
    const packed = packField({ 随身物件: '打火机', 称呼: '小满', 外貌: '短发' }, EXT)
    expect(packed.split('\n').map(l => l.split('：')[0])).toEqual(['称呼', '外貌', '随身物件'])
  })

  it('值两端的空白被 trim，全空 → 打包成空串', () => {
    expect(packField({ 外貌: '  短发  ' }, EXT)).toBe('外貌：短发')
    expect(packField(unpackField('', EXT), EXT)).toBe('')
    expect(packField({}, EXT)).toBe('')
  })
})

describe('round-trip · 文本 → 小格 → 文本', () => {
  it('往返内容无损', () => {
    const original = `外貌：短发\n穿着：灰色围裙\n${OTHER_KEY}：左手腕有旧疤`
    const back = packField(unpackField(original, EXT), EXT)
    expect(back).toBe(original)
  })

  it('幂等：再打一次包不再变化', () => {
    const once = packField(unpackField(`外貌：短发\n${OTHER_KEY}：左手腕有旧疤`, EXT), EXT)
    expect(packField(unpackField(once, EXT), EXT)).toBe(once)
  })
})

describe('模板完整性（界面与提示词共用同一份源头）', () => {
  const ALL = [...PROFILE_SPECS, ...CONDUCT_SPECS]

  it('第 2 章 6 栏 + 第 3 章 4 栏', () => {
    expect(PROFILE_SPECS).toHaveLength(6)
    expect(CONDUCT_SPECS).toHaveLength(4)
  })

  it('每栏都有界面名称、至少 2 个小格，且都留了「其他」兜底', () => {
    for (const s of ALL) {
      expect(s.label.trim().length).toBeGreaterThan(0)
      expect(s.items.length).toBeGreaterThanOrEqual(2)
      expect(s.other).toBe(true)
    }
  })

  it('每个 path 都能反查到**同一个** spec 引用', () => {
    for (const s of ALL) expect(structSpecOf(s.path)).toBe(s)
  })

  it('未知 path 返回 null（不是抛错、不是兜底造一个）', () => {
    expect(structSpecOf('nope.nope')).toBeNull()
    expect(structSpecOf('')).toBeNull()
  })

  it('每栏小格的 key 不重复', () => {
    for (const s of ALL) {
      expect(new Set(s.items.map(i => i.key)).size).toBe(s.items.length)
    }
  })

  it('每个 path 都是合法的 CardFieldPath（写错就是整栏失效）', () => {
    const valid = new Set(CARD_FIELDS.map(f => f.path as string))
    for (const s of ALL) expect(valid.has(s.path)).toBe(true)
  })

  it('🔴 全部细字段 label === key（2026-10-11 统一后不再有落差）', () => {
    const mismatched = ALL.flatMap(s => s.items).filter(i => i.label !== i.key)
    expect(mismatched.map(i => `${i.key}/${i.label}`)).toEqual([])
  })
})

describe('filledCount · 已填几格', () => {
  it('数出填了几格（空白不算）', () => {
    const v = unpackField('性格：外冷内热\n怕什么：欠债被知道\n喜好/爱好：   ', CORE)
    expect(filledCount(v, CORE)).toBe(2)
  })

  it('全空是 0 格；「其他」也算一格', () => {
    expect(filledCount(unpackField('', CORE), CORE)).toBe(0)
    expect(filledCount({ 外貌: '短发', [OTHER_KEY]: '口袋里有糖' }, EXT)).toBe(2)
  })

  it('模板里没有的键不计入', () => {
    expect(filledCount({ 外貌: '短发', 不存在的格: 'x' }, EXT)).toBe(1)
  })
})

describe('normalizeStructMarkup · 写入侧把半角冒号归位', () => {
  it('半角冒号被归位（全角），且归位后能被解包认出来', () => {
    expect(normalizeStructMarkup('外貌: 短发', EXT)).toBe('外貌：短发')
    expect(unpackField(normalizeStructMarkup('外貌: 短发', EXT), EXT)['外貌']).toBe('短发')
  })

  it('全角本来就对 → 原样放过（不做无意义加工）', () => {
    expect(normalizeStructMarkup('外貌：短发', EXT)).toBe('外貌：短发')
  })

  it('幂等：跑第二遍不再变化', () => {
    const once = normalizeStructMarkup('外貌: 短发', EXT)
    expect(normalizeStructMarkup(once, EXT)).toBe(once)
  })

  it('「其他」小项也认半角', () => {
    const fixed = normalizeStructMarkup(`${OTHER_KEY}: 口袋里总有一把糖`, EXT)
    expect(fixed).toBe(`${OTHER_KEY}：口袋里总有一把糖`)
    expect(unpackField(fixed, EXT)[OTHER_KEY]).toBe('口袋里总有一把糖')
  })

  it('多行混排：只动认得出的那一行', () => {
    expect(normalizeStructMarkup('外貌: 短发\n他习惯: 把手插进口袋', EXT))
      .toBe('外貌：短发\n他习惯: 把手插进口袋')
  })

  it('🔴 散文本的冒号绝不改（「他说: 我不去」不是标签）', () => {
    expect(normalizeStructMarkup('他说: 我不去', EXT)).toBe('他说: 我不去')
  })

  it('🔴 别的栏的小项名不认（性格 属 2.2，不在 2.1）', () => {
    expect(normalizeStructMarkup('性格: 温和', EXT)).toBe('性格: 温和')
  })

  it('整行无冒号 → 原样；行首就是冒号 → 原样；已有全角冒号在前 → 原样', () => {
    expect(normalizeStructMarkup('短发，眼下有颗小痣', EXT)).toBe('短发，眼下有颗小痣')
    expect(normalizeStructMarkup(': 空标签', EXT)).toBe(': 空标签')
    expect(normalizeStructMarkup('外貌：短发: 补充', EXT)).toBe('外貌：短发: 补充')
  })

  it('保留行首缩进，冒号后的前导空格归零（与 packField 产出对齐）', () => {
    expect(normalizeStructMarkup('  外貌:  短发', EXT)).toBe('  外貌：短发')
  })

  it('空串 / 纯空白不炸，原样返回', () => {
    expect(normalizeStructMarkup('', EXT)).toBe('')
    expect(normalizeStructMarkup('   ', EXT)).toBe('   ')
  })
})

describe('🔴 历史旧长名仍要认（统一 label 之后）', () => {
  it('2.3 语言特征：旧长名归到 key，且不落「其他」', () => {
    const v = unpackField('怎么称呼别人：叫「喂」，熟了才叫名字\n情绪外露程度：不太外露，气到极点反而笑', specOf('profile.speech'))
    expect(v['称呼别人']).toBe('叫「喂」，熟了才叫名字')
    expect(v['情绪外露']).toBe('不太外露，气到极点反而笑')
    expect(v[OTHER_KEY]).toBe('')
  })

  it('2.6 知识边界：Ta / 她 / 他 三种人称的旧长名都必须认（实测三种都出现过）', () => {
    for (const who of ['Ta', '她', '他']) {
      const v = unpackField(`哪些事${who}不知道：不知道顾客的过去\n${who}的消息来源：只从街坊闲话听说`, specOf('profile.knowledge'))
      expect(v['不知道的']).toBe('不知道顾客的过去')
      expect(v['知道的范围']).toBe('只从街坊闲话听说')
      expect(v[OTHER_KEY]).toBe('')
    }
  })

  it('2.6 旧长名带空格照样认（归一化去空白）', () => {
    expect(unpackField('哪些事 Ta 不知道：不知道顾客的过去', specOf('profile.knowledge'))['不知道的'])
      .toBe('不知道顾客的过去')
  })

  it('2.4 关系：三个旧长名全部归位', () => {
    const v = unpackField('与用户的关系：老同学\n与其他角色的关系：同事\n当前关系状态：正常', specOf('profile.relations'))
    expect(v['与用户']).toBe('老同学')
    expect(v['与其他角色']).toBe('同事')
    expect(v['当前状态']).toBe('正常')
    expect(v[OTHER_KEY]).toBe('')
  })

  it('进度锁：两个旧长名全部归位', () => {
    const v = unpackField('当前关系阶段：点头之交\n什么时候能往前走：她主动开口', specOf('conduct.paceLock'))
    expect(v['当前阶段']).toBe('点头之交')
    expect(v['解锁条件']).toBe('她主动开口')
    expect(v[OTHER_KEY]).toBe('')
  })

  it('新写法（key，与界面一致）照旧认', () => {
    const v = unpackField('称呼别人：叫喂\n情绪外露：藏着', specOf('profile.speech'))
    expect(v['称呼别人']).toBe('叫喂')
    expect(v['情绪外露']).toBe('藏着')
  })

  it('normalize：key / 旧长名 的半角与全角都收成「key + 全角」一种形态', () => {
    const SPEECH = specOf('profile.speech')
    expect(normalizeStructMarkup('称呼别人: 叫喂', SPEECH)).toBe('称呼别人：叫喂')
    expect(normalizeStructMarkup('怎么称呼别人: 叫喂', SPEECH)).toBe('称呼别人：叫喂')
    expect(normalizeStructMarkup('情绪外露程度：藏着', SPEECH)).toBe('情绪外露：藏着')
  })

  it('normalize：认不出的行原样（不篡改散文）', () => {
    expect(normalizeStructMarkup('他习惯: 把手插进口袋', specOf('profile.speech')))
      .toBe('他习惯: 把手插进口袋')
  })

  it('往返后库里只剩 key 一种写法，且再解包仍归位', () => {
    const SPEECH = specOf('profile.speech')
    const packed = packField(unpackField('怎么称呼别人：叫喂', SPEECH), SPEECH)
    expect(packed).toBe('称呼别人：叫喂')
    expect(unpackField(packed, SPEECH)['称呼别人']).toBe('叫喂')
  })

  it('旧长名表只增不删：每一条旧长名都仍映射到一个**存在**的小项 key', () => {
    // 表是模块私有的，所以从行为侧证：对每一栏，把「旧长名 = 占位值」解包后都必须落在模板的格子里。
    const aliases: [string, string, string][] = [
      ['profile.speech', '口癖 / 说话习惯', '口癖'],
      ['profile.speech', '怎么称呼别人', '称呼别人'],
      ['profile.speech', '情绪外露程度', '情绪外露'],
      ['profile.relations', '与用户的关系', '与用户'],
      ['profile.relations', '与其他角色的关系', '与其他角色'],
      ['profile.relations', '当前关系状态', '当前状态'],
      ['profile.knowledge', '哪些事Ta不知道', '不知道的'],
      ['profile.knowledge', 'Ta的消息来源', '知道的范围'],
      ['conduct.paceLock', '当前关系阶段', '当前阶段'],
      ['conduct.paceLock', '什么时候能往前走', '解锁条件'],
    ]
    for (const [path, alias, key] of aliases) {
      const spec = specOf(path)
      expect(spec.items.some(i => i.key === key)).toBe(true)
      const v = unpackField(`${alias}：占位值`, spec)
      expect(v[key]).toBe('占位值')
      expect(v[OTHER_KEY]).toBe('')
    }
  })
})

describe('structFieldLines / structHintFor · 由模板生成的提示词片段', () => {
  it('十栏各一行，含 path 末段、栏名与小项清单（带 hint 的写成括号形式）', () => {
    const lines = structFieldLines()
    expect(lines).toHaveLength(10)
    expect(lines[0]).toBe(
      '  · externals（2.1 外在）：可用小项 称呼（别人怎么叫Ta，不是Ta怎么叫别人） / 性别与年龄 / 外貌 / 穿着 / 随身物件 / 其他',
    )
    expect(lines[9]).toBe('  · rating（尺度）：可用小项 尺度 / 语言界限 / 其他')
  })

  it('小项清单与模板同源：每栏的小项 key 都能在那一行里找到', () => {
    const lines = structFieldLines()
    const ALL = [...PROFILE_SPECS, ...CONDUCT_SPECS]
    ALL.forEach((s, i) => {
      for (const item of s.items) expect(lines[i]).toContain(item.key)
      expect(lines[i]).toContain(s.label)
    })
  })

  it('structHintFor：未知 path → 空串；已知 path → 含首个小项与「其他」的写法说明', () => {
    expect(structHintFor('nope.nope')).toBe('')
    expect(structHintFor('profile.externals')).toBe(
      '可按小项输出，一行一项，形如「称呼：…」；小项只有：称呼 / 性别与年龄 / 外貌 / 穿着 / 随身物件（其余写进「其他」）。',
    )
  })

  it('structHintFor 的说明产出的是**能被解包认回**的形态', () => {
    const hint = structHintFor('conduct.rating')
    expect(hint).toContain('尺度：…')
    const sample = `尺度：日常向\n语言界限：可以有粗口`
    expect(unpackField(sample, specOf('conduct.rating'))['尺度']).toBe('日常向')
  })
})
