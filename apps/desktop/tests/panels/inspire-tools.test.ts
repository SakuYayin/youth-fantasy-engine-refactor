/**
 * 面板：灵感启发（inspire-tools）—— 纯逻辑层单测（node 环境，无 DOM）。
 *
 * 口径：随机函数全部通过 `rng?: () => number` 注入伪随机（固定种子可复现），
 * 断言「实现渲染的 == 对同一输入模型给出的输出」或逐字锁死词库常量，
 * 不重复实现一遍随机逻辑。文案常量逐字锁死，防文案漂移。
 */

import { describe, expect, it } from 'vitest'

import {
  AI_ERROR_HINT,
  BUTTON_ANOTHER,
  BUTTON_CLEAR_HISTORY,
  BUTTON_IDEA_GO,
  BUTTON_IDEA_RUNNING,
  BUTTON_ROLL_NAMES,
  CARD_HISTORY_TITLE,
  CARD_IDEA_TITLE,
  CARD_INSPIRE_TITLE,
  CARD_NAME_TITLE,
  GIVEN_CHARS,
  HISTORY_EMPTY_HINT,
  HISTORY_LIMIT,
  IDEA_COUNT,
  IDEA_EMPTY_RESULT,
  IDEA_FAILED,
  IDEA_INPUT_HINT,
  IDEA_INPUT_LABEL,
  IDEA_INPUT_PLACEHOLDER,
  IDEA_KEYWORD_HINTS,
  IDEA_KEYWORD_MAX,
  IDEA_KEYWORD_MIN,
  IDEA_SYSTEM_PROMPT,
  INSPIRATION_CONFLICTS,
  INSPIRATION_CONTRASTS,
  INSPIRATION_EMPTY_HINT,
  INSPIRATION_GENRES,
  INSPIRATION_TEMPLATES,
  INSPIRATION_THEMES,
  NAME_BATCH_SIZE,
  NAME_KIND_LABEL,
  NAME_KIND_OPTIONS,
  NAMES_EMPTY_HINT,
  NO_MODEL_HINT,
  NO_PERSIST_NOTE,
  PERSON_GIVEN_TWO_PROB,
  PLACE_PREFIXES,
  PLACE_SUFFIXES,
  SECT_PREFIXES,
  SECT_SUFFIXES,
  SURNAMES,
  TECHNIQUE_PREFIXES,
  TECHNIQUE_SUFFIXES,
  buildIdeaRequest,
  failureNotice,
  formatIdeaKeywords,
  keywordProblem,
  parseIdeaList,
  parseKeywords,
  pickRandom,
  pushHistory,
  rollInspiration,
  rollName,
  rollNames,
} from '../../src/renderer/panels/inspire-tools-model.js'
import type { AiErrorCode } from '../../src/renderer/ai/types.js'
import type { HistoryEntry } from '../../src/renderer/panels/inspire-tools-model.js'

/** 取池末位（noUncheckedIndexedAccess 下守卫 undefined）。 */
function lastOf<T>(pool: readonly T[]): T {
  const last = pool[pool.length - 1]
  if (last === undefined) {
    throw new Error('测试词库池不应为空')
  }
  return last
}

/** 线性同余伪随机（有状态、可复现）：同一种子 → 同一序列。 */
function seededRng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

describe('词库常量：长度下限、唯一性、非空', () => {
  it('随机灵感四池各至少 12 条、无重复、全非空', () => {
    const pools: readonly (readonly string[])[] = [
      INSPIRATION_GENRES,
      INSPIRATION_THEMES,
      INSPIRATION_CONFLICTS,
      INSPIRATION_CONTRASTS,
    ]
    for (const pool of pools) {
      expect(pool.length).toBeGreaterThanOrEqual(12)
      expect(new Set(pool).size).toBe(pool.length)
      expect(pool.every((item) => item.length > 0)).toBe(true)
    }
  })

  it('姓氏池至少 40 姓、无重复', () => {
    expect(SURNAMES.length).toBeGreaterThanOrEqual(40)
    expect(new Set(SURNAMES).size).toBe(SURNAMES.length)
  })

  it('名字用字池至少 60 字、无重复、全为单字', () => {
    expect(GIVEN_CHARS.length).toBeGreaterThanOrEqual(60)
    expect(new Set(GIVEN_CHARS).size).toBe(GIVEN_CHARS.length)
    expect(GIVEN_CHARS.every((ch) => ch.length === 1)).toBe(true)
  })

  it('门派 / 功法 / 地名的前缀后缀池各至少 8 条、无重复、非空', () => {
    const pools: readonly (readonly string[])[] = [
      SECT_PREFIXES,
      SECT_SUFFIXES,
      TECHNIQUE_PREFIXES,
      TECHNIQUE_SUFFIXES,
      PLACE_PREFIXES,
      PLACE_SUFFIXES,
    ]
    for (const pool of pools) {
      expect(pool.length).toBeGreaterThanOrEqual(8)
      expect(new Set(pool).size).toBe(pool.length)
      expect(pool.every((item) => item.length > 0)).toBe(true)
    }
  })

  it('句式模板至少 2 条（保证「换一个」有变化空间）', () => {
    expect(INSPIRATION_TEMPLATES.length).toBeGreaterThanOrEqual(2)
  })
})

describe('pickRandom：rng 注入与边界', () => {
  it('rng 恒 0 → 抽中池首条', () => {
    expect(pickRandom(SURNAMES, () => 0)).toBe(SURNAMES[0])
  })

  it('rng 恒 0.9999 → 抽中池末条（不越界）', () => {
    expect(pickRandom(SURNAMES, () => 0.9999)).toBe(lastOf(SURNAMES))
  })

  it('空池抛 RangeError', () => {
    expect(() => pickRandom([], () => 0)).toThrow(RangeError)
  })

  it('任意种子结果都在池内（真实路径契约）', () => {
    for (const seed of [1, 42, 1337, 99991]) {
      expect(INSPIRATION_GENRES).toContain(pickRandom(INSPIRATION_GENRES, seededRng(seed)))
      expect(SURNAMES).toContain(pickRandom(SURNAMES, seededRng(seed)))
      expect(GIVEN_CHARS).toContain(pickRandom(GIVEN_CHARS, seededRng(seed)))
    }
  })

  it('默认参数走 Math.random（不传 rng 也在池内）', () => {
    expect(INSPIRATION_GENRES).toContain(pickRandom(INSPIRATION_GENRES))
  })
})

describe('rollInspiration：随机灵感', () => {
  it('rng 恒 0 → 首模板 + 各池首条（逐字锁死）', () => {
    const draw = rollInspiration(() => 0)
    expect(draw.genre).toBe(INSPIRATION_GENRES[0])
    expect(draw.theme).toBe(INSPIRATION_THEMES[0])
    expect(draw.conflict).toBe(INSPIRATION_CONFLICTS[0])
    expect(draw.contrast).toBe(INSPIRATION_CONTRASTS[0])
    expect(draw.text).toBe('一个修真仙侠故事：弱小少年身怀绝世传承，却卷入宗门倾轧，只为逆天改命。')
  })

  it('rng 恒 0.9999 → 末模板 + 各池末条（逐字锁死）', () => {
    const draw = rollInspiration(() => 0.9999)
    expect(draw.text).toBe('当宿敌纠缠降临，无名小卒背上刻着封神榜，依然选择成长蜕变——这就是克苏鲁诡秘的底色。')
  })

  it('字段与模板参数的对应关系（template[0] 以 draw 各字段成句）', () => {
    const draw = rollInspiration(() => 0)
    const first = INSPIRATION_TEMPLATES[0]
    if (first === undefined) {
      throw new Error('测试词库模板不应为空')
    }
    expect(draw.text).toBe(first(draw.genre, draw.theme, draw.conflict, draw.contrast))
  })

  it('同一种子两次抽取结果一致（可复现）', () => {
    expect(rollInspiration(seededRng(42))).toEqual(rollInspiration(seededRng(42)))
  })

  it('不同种子抽出不同构成（rng 真正参与）', () => {
    const a = rollInspiration(seededRng(42))
    const b = rollInspiration(seededRng(43))
    expect(b).not.toEqual(a)
  })

  it('text 由 genre/theme/conflict/contrast 拼成（结构完整）', () => {
    const draw = rollInspiration(() => 0.5)
    expect(draw.text.length).toBeGreaterThan(0)
    expect(draw.text).toContain(draw.genre)
    expect(draw.text).toContain(draw.theme)
    expect(draw.text).toContain(draw.conflict)
    expect(draw.text).toContain(draw.contrast)
  })
})

describe('rollName：四类名字', () => {
  it('rng 恒 0 → 人物名 = 姓氏首 + 两个名字用字首（两字名）', () => {
    expect(rollName('person', () => 0)).toBe('李云云')
  })

  it('rng 恒 0.9999 → 人物名 = 姓氏末 + 两字名（0.9999 < 0.6 不成立）', () => {
    expect(rollName('person', () => 0.9999)).toBe(`${lastOf(SURNAMES)}${lastOf(GIVEN_CHARS)}`)
  })

  it('rng 恒 0.7 → 人物名单字名（0.7 ≥ 0.6）', () => {
    const name = rollName('person', () => 0.7)
    expect(name.length).toBe(2)
    const surname = name[0]
    if (surname === undefined) {
      throw new Error('名字不应为空')
    }
    expect(SURNAMES).toContain(surname)
  })

  it('rng 恒 0 → 门派名 = 前缀首 + 后缀首', () => {
    expect(rollName('sect', () => 0)).toBe('青云宗')
  })

  it('rng 恒 0 → 功法名 = 前缀首 + 后缀首', () => {
    expect(rollName('technique', () => 0)).toBe('九转诀')
  })

  it('rng 恒 0 → 地名 = 前缀首 + 后缀首', () => {
    expect(rollName('place', () => 0)).toBe('落霞城')
  })

  it('任意种子：人物名 = 姓氏池成员 + 名字用字池成员', () => {
    for (const seed of [7, 99, 2024]) {
      const rng = seededRng(seed)
      const name = rollName('person', rng)
      const surname = name[0]
      if (surname === undefined) {
        throw new Error('名字不应为空')
      }
      expect(SURNAMES).toContain(surname)
      for (const ch of name.slice(1)) {
        expect(GIVEN_CHARS).toContain(ch)
      }
    }
  })

  it('任意种子：门派 / 功法 / 地名 = 前缀池 + 后缀池成员', () => {
    for (const seed of [7, 99, 2024]) {
      expect(SECT_PREFIXES.some((p) => rollName('sect', seededRng(seed)).startsWith(p))).toBe(true)
      expect(SECT_SUFFIXES.some((s) => rollName('sect', seededRng(seed)).endsWith(s))).toBe(true)
      expect(TECHNIQUE_PREFIXES.some((p) => rollName('technique', seededRng(seed)).startsWith(p))).toBe(true)
      expect(TECHNIQUE_SUFFIXES.some((s) => rollName('technique', seededRng(seed)).endsWith(s))).toBe(true)
      expect(PLACE_PREFIXES.some((p) => rollName('place', seededRng(seed)).startsWith(p))).toBe(true)
      expect(PLACE_SUFFIXES.some((s) => rollName('place', seededRng(seed)).endsWith(s))).toBe(true)
    }
  })

  it('同一种子两次抽取结果一致（可复现）', () => {
    expect(rollNames('person', seededRng(7))).toEqual(rollNames('person', seededRng(7)))
    expect(rollNames('sect', seededRng(11))).toEqual(rollNames('sect', seededRng(11)))
  })
})

describe('rollNames：一批名字', () => {
  it('每批固定 NAME_BATCH_SIZE 个', () => {
    expect(rollNames('person', () => 0).length).toBe(NAME_BATCH_SIZE)
    expect(rollNames('sect', () => 0).length).toBe(NAME_BATCH_SIZE)
    expect(rollNames('technique', () => 0).length).toBe(NAME_BATCH_SIZE)
    expect(rollNames('place', () => 0).length).toBe(NAME_BATCH_SIZE)
    expect(NAME_BATCH_SIZE).toBe(6)
  })

  it('四类都符合各自池的构成形状', () => {
    const person = rollNames('person', () => 0.3)
    for (const name of person) {
      expect(name.length).toBeGreaterThanOrEqual(2)
      expect(name.length).toBeLessThanOrEqual(3)
      expect(SURNAMES).toContain(name[0])
    }
    for (const name of rollNames('sect', () => 0.3)) {
      expect(SECT_PREFIXES.some((p) => name.startsWith(p))).toBe(true)
    }
  })
})

describe('NAME_KIND_OPTIONS：名字类型选项', () => {
  it('四类选项按人物名/门派名/功法名/地名排列（逐字锁死）', () => {
    expect(NAME_KIND_OPTIONS.map((option) => option.kind)).toEqual(['person', 'sect', 'technique', 'place'])
    expect(NAME_KIND_OPTIONS.map((option) => option.label)).toEqual(['人物名', '门派名', '功法名', '地名'])
  })

  it('标签常量（逐字锁死）', () => {
    expect(NAME_KIND_LABEL).toBe('名字类型')
  })
})

describe('parseKeywords：关键词解析', () => {
  it('空格分隔', () => {
    expect(parseKeywords('剑修 道心')).toEqual(['剑修', '道心'])
  })

  it('顿号 / 全角逗号 / 半角逗号 / 分号 / 斜杠 / 竖线分隔', () => {
    expect(parseKeywords('剑修、道心，天命,三重;四象/五雷|六爻')).toEqual([
      '剑修',
      '道心',
      '天命',
      '三重',
      '四象',
      '五雷',
      '六爻',
    ])
  })

  it('按出现顺序去重', () => {
    expect(parseKeywords('剑修 剑修 道心 剑修')).toEqual(['剑修', '道心'])
  })

  it('首尾空白与连续分隔符', () => {
    expect(parseKeywords('  剑修  ')).toEqual(['剑修'])
    expect(parseKeywords('剑修,,、  道心')).toEqual(['剑修', '道心'])
  })

  it('空输入 / 纯分隔符 → 空数组', () => {
    expect(parseKeywords('')).toEqual([])
    expect(parseKeywords('  ,,、')).toEqual([])
  })
})

describe('keywordProblem 与 buildIdeaRequest：AI 请求构造', () => {
  it('个数问题判定（0=blank / 1=tooFew / 4=tooMany / 2-3=null）', () => {
    expect(keywordProblem(0)).toBe('blank')
    expect(keywordProblem(1)).toBe('tooFew')
    expect(keywordProblem(4)).toBe('tooMany')
    expect(keywordProblem(2)).toBe(null)
    expect(keywordProblem(3)).toBe(null)
    expect(IDEA_KEYWORD_MIN).toBe(2)
    expect(IDEA_KEYWORD_MAX).toBe(3)
  })

  it('空输入 → ok=false + blank（不发请求）', () => {
    const plan = buildIdeaRequest('')
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.problem).toBe('blank')
      expect(plan.keywords).toEqual([])
    }
  })

  it('1 个关键词 → ok=false + tooFew', () => {
    const plan = buildIdeaRequest('剑修')
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.problem).toBe('tooFew')
      expect(plan.keywords).toEqual(['剑修'])
    }
  })

  it('4 个关键词 → ok=false + tooMany', () => {
    const plan = buildIdeaRequest('剑修 道心 天命 三重')
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.problem).toBe('tooMany')
      expect(plan.keywords).toEqual(['剑修', '道心', '天命', '三重'])
    }
  })

  it('2 个关键词 → ok=true，request 只含 system + messages（不传 maxTokens / temperature）', () => {
    const plan = buildIdeaRequest('剑修 道心')
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.keywords).toEqual(['剑修', '道心'])
      expect(plan.request.system).toBe(IDEA_SYSTEM_PROMPT)
      expect(plan.request.messages.length).toBe(1)
      expect(plan.request.messages[0]?.role).toBe('user')
      expect(plan.request.messages[0]?.content).toContain('剑修')
      expect(plan.request.messages[0]?.content).toContain('道心')
      expect('maxTokens' in plan.request).toBe(false)
      expect('temperature' in plan.request).toBe(false)
    }
  })

  it('3 个关键词（顿号分隔）→ ok=true，user 消息含全部关键词', () => {
    const plan = buildIdeaRequest('剑修、道心、天命')
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.keywords).toEqual(['剑修', '道心', '天命'])
      expect(plan.request.messages[0]?.content).toContain('剑修、道心、天命')
    }
  })

  it('IDEA_SYSTEM_PROMPT 含点子条数口径（逐字锁死）', () => {
    expect(IDEA_SYSTEM_PROMPT).toContain(`恰好 ${IDEA_COUNT} 条`)
    expect(IDEA_SYSTEM_PROMPT).toContain('不要编号')
    expect(IDEA_COUNT).toBe(5)
  })
})

describe('parseIdeaList：模型回复解析', () => {
  it('剥各种列表前缀并去空行', () => {
    const text = [
      '1. 废柴觉醒（神格来历成谜）',
      '- 宗门养猪流（主角是幕后黑手）',
      '',
      '一、双生花（善恶同体）',
      '· 天道有缺（规则可钻）',
      '2）棋盘之上（众生皆子）',
    ].join('\n')
    expect(parseIdeaList(text)).toEqual([
      '废柴觉醒（神格来历成谜）',
      '宗门养猪流（主角是幕后黑手）',
      '双生花（善恶同体）',
      '天道有缺（规则可钻）',
      '棋盘之上（众生皆子）',
    ])
  })

  it('缩进编号行同样剥前缀', () => {
    expect(parseIdeaList('  3. 缩进编号')).toEqual(['缩进编号'])
  })

  it('非列表行原样保留', () => {
    expect(parseIdeaList('直接一句话')).toEqual(['直接一句话'])
  })

  it('空文本 / 纯空行 → 空数组（空结果显式兜底）', () => {
    expect(parseIdeaList('')).toEqual([])
    expect(parseIdeaList('\n\n')).toEqual([])
  })

  it('CRLF 行尾同样按行解析', () => {
    expect(parseIdeaList('1. 甲\r\n2. 乙')).toEqual(['甲', '乙'])
  })
})

describe('failureNotice：失败提示', () => {
  it('逐字锁死（AI_TIMEOUT）', () => {
    expect(failureNotice('AI_TIMEOUT', '等了 30 秒')).toBe(
      '模型响应超时（AI_TIMEOUT：等了 30 秒）。随机灵感与名字生成不受影响，可先用本地工具。',
    )
  })

  it('七个错误码：提示含错误码与原始信息', () => {
    const codes: readonly AiErrorCode[] = [
      'AI_NOT_CONFIGURED',
      'AI_AUTH_FAILED',
      'AI_RATE_LIMITED',
      'AI_TIMEOUT',
      'AI_UPSTREAM_ERROR',
      'AI_RESPONSE_MALFORMED',
      'AI_CANCELLED',
    ]
    for (const code of codes) {
      const notice = failureNotice(code, '原因 X')
      expect(notice).toContain(code)
      expect(notice).toContain('原因 X')
      expect(notice).toBe(`${AI_ERROR_HINT[code]}（${code}：原因 X）。随机灵感与名字生成不受影响，可先用本地工具。`)
    }
  })
})

describe('formatIdeaKeywords：关键词回显', () => {
  it('顿号连接（逐字锁死）', () => {
    expect(formatIdeaKeywords(['剑修', '道心'])).toBe('关键词：剑修、道心')
    expect(formatIdeaKeywords(['剑修'])).toBe('关键词：剑修')
    expect(formatIdeaKeywords(['剑修', '道心', '天命'])).toBe('关键词：剑修、道心、天命')
  })
})

describe('pushHistory：抽中历史', () => {
  const first: HistoryEntry = { source: CARD_INSPIRE_TITLE, text: '第一句' }
  const second: HistoryEntry = { source: CARD_NAME_TITLE, text: '第二批' }

  it('新条目插到最前', () => {
    expect(pushHistory([first], second)).toEqual([second, first])
    expect(pushHistory([], first)).toEqual([first])
  })

  it('超出上限截断到最近 HISTORY_LIMIT 条', () => {
    let history: readonly HistoryEntry[] = []
    for (let i = 0; i < 12; i += 1) {
      history = pushHistory(history, { source: CARD_INSPIRE_TITLE, text: `第 ${i} 次` })
    }
    expect(history.length).toBe(HISTORY_LIMIT)
    expect(history[0]?.text).toBe('第 11 次')
    expect(HISTORY_LIMIT).toBe(10)
  })
})

describe('文案常量：逐字锁死', () => {
  it('卡片标题', () => {
    expect(CARD_INSPIRE_TITLE).toBe('随机灵感')
    expect(CARD_NAME_TITLE).toBe('名字生成')
    expect(CARD_IDEA_TITLE).toBe('点子组合')
    expect(CARD_HISTORY_TITLE).toBe('抽中历史')
  })

  it('按钮文案', () => {
    expect(BUTTON_ANOTHER).toBe('换一个')
    expect(BUTTON_ROLL_NAMES).toBe('生成名字')
    expect(BUTTON_IDEA_GO).toBe('AI 发散')
    expect(BUTTON_IDEA_RUNNING).toBe('AI 发散中…')
    expect(BUTTON_CLEAR_HISTORY).toBe('清空历史')
  })

  it('表单标签与占位', () => {
    expect(IDEA_INPUT_LABEL).toBe('关键词')
    expect(IDEA_INPUT_PLACEHOLDER).toBe('输入 2–3 个关键词，用空格、逗号或顿号分隔')
  })

  it('空态提示（含按钮引导）', () => {
    expect(IDEA_EMPTY_RESULT).toBe('模型没有给出可显示的点子，请重试一次。')
    expect(NAMES_EMPTY_HINT).toBe('当前类型还没有名字，点击「生成名字」抽一批。')
    expect(INSPIRATION_EMPTY_HINT).toBe('点「换一个」抽一句灵感。')
    expect(HISTORY_EMPTY_HINT).toBe('暂无抽中记录：点「换一个」或「生成名字」后会出现在这里。')
    expect(IDEA_INPUT_HINT).toContain('AI 发散')
  })

  it('未配置模型引导：含「模型设置」页签指引与本地能力说明', () => {
    expect(NO_MODEL_HINT).toContain('模型设置')
    expect(NO_MODEL_HINT).toContain('随机灵感与名字生成是本地能力，不受影响')
  })

  it('持久化边界说明：含最近 10 条与不上传口径', () => {
    expect(NO_PERSIST_NOTE).toContain('10')
    expect(NO_PERSIST_NOTE).toContain('不会被保存或上传')
  })

  it('关键词非法提示（逐字锁死）', () => {
    expect(IDEA_KEYWORD_HINTS.blank).toBe('请先输入关键词，再点「AI 发散」。')
    expect(IDEA_KEYWORD_HINTS.tooFew).toBe('关键词至少需要 2 个，请再补一个。')
    expect(IDEA_KEYWORD_HINTS.tooMany).toBe('关键词最多 3 个，请删掉多余的。')
  })

  it('口径常量数值', () => {
    expect(PERSON_GIVEN_TWO_PROB).toBe(0.6)
    expect(NAME_BATCH_SIZE).toBe(6)
    expect(HISTORY_LIMIT).toBe(10)
    expect(IDEA_COUNT).toBe(5)
    expect(IDEA_KEYWORD_MIN).toBe(2)
    expect(IDEA_KEYWORD_MAX).toBe(3)
  })
})
