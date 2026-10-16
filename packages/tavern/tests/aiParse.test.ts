/**
 * `aiParse.ts` 契约测试 —— 「模型文本 → 结构化数据」的唯一入口，必须锁死行为。
 *
 * 上游对应断言：`_upstream_tmp/youth-fantasy-engine-main/tests/aiParse.test.ts`
 * （共 225 行，上游用自建 `ok()` 断言器，非 vitest）。已**逐条翻译**成 vitest：
 * 每条 `ok(...)` → 一个 `it(...)`，断言表达式逐字保留，只把 `x === 'y'` 这类比较
 * 搬进 `expect(x).toBe('y')`，并去掉上游自带的 `pass`/`fail` 计数器与 `extra` 字符串。
 * 另按本仓要求补齐：非对象输入、`asText`/`hasSubstance` 的空串 / 空白 / `0` / `false` /
 * `null` 边界、深度嵌套、超长输入、Unicode。
 *
 * 重点覆盖两件事（与上游同）：
 *   ① 2.0.1 修过的「单对象被丢成空数组」——绝不能回归（否则"改稿只剩标点"复现）；
 *   ② 剥代码块 / 切最外层 / 容忍前后夹带解释——旧实现三份行为不一致，现已统一。
 */
import { describe, expect, it } from 'vitest'

import {
  asText,
  hasSubstance,
  humanText,
  parseLooseObject,
  parseObjectArray,
  parsePlainObject,
  parseTruncatedJson,
  stripCodeFence,
  stripStrayPunct,
} from '../src/aiParse.js'

// ---------- stripCodeFence ----------
describe('stripCodeFence', () => {
  it('剥 ```json 围栏', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })
  it('剥裸 ``` 围栏', () => {
    expect(stripCodeFence('```\n[1]\n```')).toBe('[1]')
  })
  it('无围栏时原样返回（仅 trim）', () => {
    expect(stripCodeFence('  {"a":1}  ')).toBe('{"a":1}')
  })
})

// ---------- parseObjectArray ----------
describe('parseObjectArray', () => {
  it('标准对象数组', () => {
    expect(parseObjectArray('[{"a":1},{"a":2}]').length).toBe(2)
  })
  it('数组里的非对象被过滤', () => {
    expect(parseObjectArray('[{"a":1},3,"x",null]').length).toBe(1)
  })
  it('空数组返回空数组', () => {
    expect(parseObjectArray('[]').length).toBe(0)
  })

  // 🔴 核心回归：单个对象必须归一化成单元素数组，不得丢失（2.0.1 修复点）
  it('【回归】单个对象 → 归一化为 1 条（不得丢成空数组）', () => {
    const single = parseObjectArray('{"rewritten":"正文内容","level":"ok"}')
    expect(single.length, `实际长度=${single.length}`).toBe(1)
  })
  it('【回归】单对象内容完整保留', () => {
    const single = parseObjectArray('{"rewritten":"正文内容","level":"ok"}')
    expect(single.length === 1 && single[0]?.rewritten === '正文内容').toBe(true)
  })

  // {list:[…]} / {data:[…]} 形态
  it('{list:[…]} 取内部数组', () => {
    expect(parseObjectArray('{"list":[{"a":1},{"a":2}]}').length).toBe(2)
  })
  it('{data:[…]} 取内部数组', () => {
    expect(parseObjectArray('{"data":[{"a":1}]}').length).toBe(1)
  })
  it('{list:[]} 空内部数组仍可解析出对象本身以外的空', () => {
    expect(parseObjectArray('{"list":[]}').length).toBe(0)
  })

  // 夹带解释 / 代码块
  it('夹带前置解释仍能解析数组', () => {
    expect(parseObjectArray('好的，结果如下：\n[{"a":1}]').length).toBe(1)
  })
  it('夹带后置解释仍能解析数组', () => {
    expect(parseObjectArray('[{"a":1}]\n以上是结果。').length).toBe(1)
  })
  it('```json 围栏内数组可解析', () => {
    expect(parseObjectArray('```json\n[{"a":1},{"a":2}]\n```').length).toBe(2)
  })
  it('围栏 + 夹带解释的单个对象可解析', () => {
    expect(parseObjectArray('```json\n{"a":1}\n```\n希望有帮助').length).toBe(1)
  })

  // 垃圾输入
  it('纯文本返回空数组', () => {
    expect(parseObjectArray('抱歉我不能完成这个请求').length).toBe(0)
  })
  it('空串返回空数组', () => {
    expect(parseObjectArray('').length).toBe(0)
  })
  it('残缺 JSON 返回空数组', () => {
    expect(parseObjectArray('[{"a":').length).toBe(0)
  })
  it('不抛异常（残缺 JSON）', () => {
    expect((() => { try { parseObjectArray('{'); return true } catch { return false } })()).toBe(true)
  })
})

// ---------- parsePlainObject ----------
describe('parsePlainObject', () => {
  it('标准对象', () => {
    expect(parsePlainObject('{"1":"甲","2":"乙"}')?.['1']).toBe('甲')
  })
  it('围栏内对象', () => {
    expect(parsePlainObject('```json\n{"1":"甲"}\n```')?.['1']).toBe('甲')
  })
  it('夹带解释的对象', () => {
    expect(parsePlainObject('填空结果：{"1":"甲"} 完成')?.['1']).toBe('甲')
  })
  it('数组包裹时取首元素（容错）', () => {
    expect(parsePlainObject('[{"1":"甲"}]')?.['1']).toBe('甲')
  })
  it('纯文本返回 null', () => {
    expect(parsePlainObject('无法完成')).toBe(null)
  })
  it('空串返回 null', () => {
    expect(parsePlainObject('')).toBe(null)
  })
})

// ---------- hasSubstance（拦「只剩标点」的残骸） ----------
describe('hasSubstance', () => {
  it('纯标点/符号判定为无实质内容', () => {
    expect(hasSubstance('，。！？——【】（）…')).toBe(false)
  })
  it('仅数字与符号判定为无实质内容', () => {
    expect(hasSubstance('123 456 ，。')).toBe(false)
  })
  it('真实文字判定为有实质内容', () => {
    expect(hasSubstance('他推开那扇门')).toBe(true)
  })
  it('四字（边界值）判定为有实质内容', () => {
    expect(hasSubstance('推开了门')).toBe(true)
  })
  it('三字（低于阈值）判定为无实质内容', () => {
    expect(hasSubstance('推开门')).toBe(false)
  })

  // 以下为本仓补齐的空值 / 空白边界
  it('空串与纯空白判定为无实质内容', () => {
    expect(hasSubstance('')).toBe(false)
    expect(hasSubstance('   \n\t ')).toBe(false)
  })
  it('emoji（Unicode 符号类）被计为符号、真实文字照常计数', () => {
    expect(hasSubstance('🌑🌒🌓🌔')).toBe(false)
    expect(hasSubstance('🌑林烬推门🌒')).toBe(true)
  })
})

// ---------- asText ----------
describe('asText', () => {
  it('字符串原样（去首尾空白）', () => {
    expect(asText(' 甲 ')).toBe('甲')
  })
  it('数字转字符串', () => {
    expect(asText(12)).toBe('12')
  })
  it('布尔转字符串', () => {
    expect(asText(false)).toBe('false')
  })
  it('数组用顿号连接', () => {
    expect(asText(['甲', '乙'])).toBe('甲、乙')
  })
  it('嵌套数组递归连接', () => {
    expect(asText([['甲'], '乙'])).toBe('甲、乙')
  })
  it('对象返回空串（不可展示）', () => {
    expect(asText({ a: 1 })).toBe('')
  })
  it('null/undefined 返回空串', () => {
    expect(asText(null)).toBe('') 
    expect(asText(undefined)).toBe('')
  })

  // 以下为本仓补齐的标量 / 空值边界
  it('0 与空串 / 纯空白字符串的边界', () => {
    expect(asText(0)).toBe('0')
    expect(asText('')).toBe('')
    expect(asText('   ')).toBe('')
  })
  it('数组内的空串 / 空白 / null 被过滤掉', () => {
    expect(asText(['甲', '', '  ', null, '乙'])).toBe('甲、乙')
  })
})

// ---------- humanText（JSON 解析失败时的兜底清洗） ----------
describe('humanText', () => {
  // 含 JSON：只取「值」，不取键名
  it('从 JSON 中只提取值、不含键名', () => {
    const jsonish = '{"rewritten":"他推开了门。","level":"ok"}'
    const t1 = humanText(jsonish)
    expect(t1.includes('他推开了门。') && !t1.includes('rewritten')).toBe(true)
  })

  it('\\n 转义还原为真实换行', () => {
    expect(humanText('{"a":"第一行\\n第二行"}').includes('\n')).toBe(true)
  })

  // 🔴 bug 锁：旧实现的正则会从键的闭合引号处重新起步、把 `":"` 捕获成冒号，
  //    导致残缺 JSON 的兜底结果退化成 `:\n,\n:` 这类标点残渣（作者报的「只剩标点」成因之一）。
  it('【bug 锁】残缺 JSON 兜底取出正文，而非冒号逗号残渣', () => {
    const malformed = humanText('{"rewritten":"他推开了门。",}')
    expect(malformed.includes('他推开了门。') && !/^[\s:,[\]{}"'\\]*$/.test(malformed)).toBe(true)
  })

  // 不含 JSON：剥掉键名残余与 JSON 符号
  it('非 JSON 文本剥掉带引号的键名与括号', () => {
    const t2 = humanText('"rewritten": 正文内容 { ok }')
    expect(!t2.includes('{') && !t2.includes('}') && !t2.includes('rewritten') && t2.includes('正文内容')).toBe(true)
  })

  it('普通文本保持可读', () => {
    expect(humanText('  他推开了门。\n  风灌了进来。  ')).toBe('他推开了门。\n风灌了进来。')
  })
  it('剥代码块围栏', () => {
    expect(humanText('```\n{"a":"正文"}\n```').includes('正文')).toBe(true)
  })
})

// ---------- 三份旧实现行为一致性（收敛的意义） ----------
describe('三份旧实现行为一致性（收敛的意义）', () => {
  // 旧 autoContinue 用的是裸 JSON.parse：这两种输入它会整条丢弃，统一后应能解析
  it('【收敛验证】带围栏输入不再整条丢弃（旧裸 JSON.parse 会丢）', () => {
    const fenced = '```json\n[{"name":"青云门","note":"新增门派"}]\n```'
    expect(parseObjectArray(fenced).length).toBe(1)
  })
  it('【收敛验证】夹带散文输入不再整条丢弃', () => {
    const withProse = '以下是变化：\n[{"name":"李默","note":"修为提升"}]\n完毕。'
    expect(parseObjectArray(withProse).length).toBe(1)
  })
})

// ---------- parseLooseObject / stripStrayPunct（2026-09-18 新增：生成型入口的容错路径） ----------
describe('parseLooseObject / stripStrayPunct', () => {
  // 第一条样本是**实机抓到的原文**：小模型在 JSON 结构位塞了个中文顿号，
  // 严格解析整批丢弃 → 表现为"生成成功但 0 条"，作者完全无从下手（排查了一整轮才定位）。
  const REAL_BROKEN = `{
  "characters": [
    {
      "name": "林烬",
      "tier": "主要",
      "desc": "少年，靠吞噬他人修为续命",
      "realm": "碎境巅峰",
     、
      "faction": "夜渊会",
      "special": "可借他人修为短暂化形"
    }
  ]
}`

  it('【判别力】严格解析在实机样本上确实失败', () => {
    expect(parsePlainObject(REAL_BROKEN)).toBe(null)
  })
  it('🔴 宽松解析救回实机样本', () => {
    const fixed = parseLooseObject(REAL_BROKEN)
    expect(!!fixed && Array.isArray(fixed.characters)).toBe(true)
  })
  it('顿号之前的字段完好（realm）', () => {
    const fixed = parseLooseObject(REAL_BROKEN)
    const c = (fixed?.characters as Record<string, unknown>[] | undefined)?.[0]
    expect(c?.realm).toBe('碎境巅峰')
  })
  it('顿号之后的字段也在（faction）', () => {
    const fixed = parseLooseObject(REAL_BROKEN)
    const c = (fixed?.characters as Record<string, unknown>[] | undefined)?.[0]
    expect(c?.faction).toBe('夜渊会')
  })

  // 🔴 负面对照：字符串**内部**的顿号/句号是正常内容，绝不能删
  it('🔴 字符串内的顿号保持原样', () => {
    const withPunctInside = '{"desc":"江、河、湖、海，皆可吞。","name":"林烬"}'
    expect(stripStrayPunct(withPunctInside).includes('江、河、湖、海，皆可吞。')).toBe(true)
  })
  it('值读出来与原句一致（未被清洗）', () => {
    const withPunctInside = '{"desc":"江、河、湖、海，皆可吞。","name":"林烬"}'
    expect(parseLooseObject(withPunctInside)?.desc).toBe('江、河、湖、海，皆可吞。')
  })

  // 转义引号不应把"字符串外"判断搞错
  it('转义引号内的顿号未被删', () => {
    const escaped = '{"a":"他说：\\"江、河。\\"","b":"x、y"}'
    const cleanedEsc = stripStrayPunct(escaped)
    expect(cleanedEsc.includes('江、河。')).toBe(true)
  })
  it('末尾字符串的顿号未被删', () => {
    const escaped = '{"a":"他说：\\"江、河。\\"","b":"x、y"}'
    const cleanedEsc = stripStrayPunct(escaped)
    expect(cleanedEsc.includes('x、y')).toBe(true)
  })

  // 尾随逗号 / 连续逗号
  it('严格解析在尾随逗号上失败', () => {
    expect(parsePlainObject('{"a":"1","b":"2",}')).toBe(null)
  })
  it('宽松解析处理尾随逗号', () => {
    expect(parseLooseObject('{"a":"1","b":"2",}')?.b).toBe('2')
  })
  it('数组内尾随逗号也能处理', () => {
    expect(Array.isArray(parseLooseObject('{"list":["x","y",]}')?.list)).toBe(true)
  })
  it('连续逗号收敛为一个', () => {
    expect(parseLooseObject('{"a":"1",,"b":"2"}')?.b).toBe('2')
  })

  // 合法输入不被"清洗"（严格路径原样返回）
  it('合法输入两条路径结果一致', () => {
    const good = '{"characters":[{"name":"张三"}],"factions":[{"name":"青岚宗"}]}'
    expect(JSON.stringify(parsePlainObject(good))).toBe(JSON.stringify(parseLooseObject(good)))
  })
  it('合法输入里含顿号的值原样保留', () => {
    expect(parseLooseObject('{"a":"甲、乙"}')?.a).toBe('甲、乙')
  })

  // 真·坏输入仍返回 null（不硬造对象）
  it('空串 → null', () => {
    expect(parseLooseObject('')).toBe(null)
  })
  it('无 JSON 的纯文本 → null', () => {
    expect(parseLooseObject('今天天气不错')).toBe(null)
  })
  it('顶层是数组时取首元素（沿用 parsePlainObject 既有容错，非 null）', () => {
    expect(parseLooseObject('[{"a":1}]')?.a).toBe(1)
  })
})

// ============ 截断修复（parseTruncatedJson）：被测出来的真实场景 ============
// 2026-09-18 创意写作实机：本地 27B 产大纲时输出到一半停住，原始返回**少一个外层 `}`**：
//   {"volumes":[…],"chapters":[{…,"scenes":["…","…"]}]
// 旧实现要求结构完整 → 整批全丢 → 上游报"模型没有产出章节细纲"；重试同 prompt 又断在同一处。
describe('parseTruncatedJson', () => {
  const full = '{"volumes":[{"title":"风起云州"}],"chapters":[{"title":"废脉","scenes":["a","b"]}]}'
  const cutTail = full.slice(0, -1)

  it('① 完整 JSON 照常解析', () => {
    expect((parseTruncatedJson(full) as { chapters: unknown[] })?.chapters?.length).toBe(1)
  })

  // 少一个外层 }（实机抓到的原始形态）
  it('🔴 少一个收尾括号 → 补齐后仍能拿到全部内容（不再全丢）', () => {
    const r1 = parseTruncatedJson(cutTail) as { volumes: unknown[]; chapters: { title: string; scenes: string[] }[] }
    expect(r1?.chapters?.[0]?.title).toBe('废脉')
  })
  it('　· 场景数组内容一根不少', () => {
    const r1 = parseTruncatedJson(cutTail) as { volumes: unknown[]; chapters: { title: string; scenes: string[] }[] }
    expect(r1?.chapters?.[0]?.scenes?.join(',')).toBe('a,b')
  })

  // 截断在字符串中间（流式被掐断的典型形态）
  it('② 截断在字符串中间 → 补引号后保住已完整的部分', () => {
    const cutStr = '{"volumes":[{"title":"风起云州"}],"chapters":[{"title":"废'
    const r2 = parseTruncatedJson(cutStr) as { chapters: { title: string }[] }
    expect(r2?.chapters?.[0]?.title).toBe('废')
  })

  // 截断在数组元素中间：丢掉不完整的那条，保住前面
  it('③ 截断在数组元素中间 → 丢掉残条、保住前两条', () => {
    const cutMid = '{"chapters":[{"title":"A"},{"title":"B"},{"ti'
    const r3 = parseTruncatedJson(cutMid) as { chapters: { title: string }[] }
    expect(r3?.chapters?.length === 2 && r3?.chapters?.map(c => c.title).join('') === 'AB').toBe(true)
  })

  // 字符串内部的 } / ] 不能被当成结构闭合符（否则会切坏内容）
  it('④ 字符串内的 { } 不参与结构补全（内容不被切坏）', () => {
    const inner = '{"chapters":[{"note":"他说{别动}","title":"甲"}]'
    const r4 = parseTruncatedJson(inner) as { chapters: { note: string; title: string }[] }
    expect(r4?.chapters?.[0]?.note === '他说{别动}' && r4?.chapters?.[0]?.title === '甲').toBe(true)
  })

  // 绝不编造：救不回来就老实返回 null，让调用方走失败分支
  it('🔴 ⑤ 纯垃圾 → null（不猜、不造）', () => {
    expect(parseTruncatedJson('今天天气不错')).toBe(null)
  })
  it('🔴 ⑤ 空串 → null', () => {
    expect(parseTruncatedJson('')).toBe(null)
  })
  it('🔴 ⑤ 只有开头括号 → null', () => {
    expect(parseTruncatedJson('{')).toBe(null)
  })

  // 悬挂的逗号/冒号（"…"," 或 "…":）
  it('⑥ 悬挂的冒号 → 去掉后能解析出已有的键', () => {
    const dangling = '{"a":1,"b":'
    expect((parseTruncatedJson(dangling) as { a: number })?.a).toBe(1)
  })

  it('⑦ 代码块围栏内的截断 JSON 也能修', () => {
    expect((parseTruncatedJson('```json\n' + cutTail + '\n```') as { chapters: unknown[] })?.chapters?.length).toBe(1)
  })
})

// 两个入口的末级兜底真的接上了（否则上面修好了、调用方仍拿不到）
describe('parseLooseObject / parseObjectArray 的截断末级兜底', () => {
  // ⚠️ 样例刻意**含两个顶层键**：只用 `{"chapters":[{…}]` 这类会被 `parsePlainObject` 的
  //    "数组里取首元素"容错先接住（返回 `{title:…}`、丢掉外层 chapters），测不到本层兜底。
  it('🔴 parseLooseObject 走到截断兜底（外层键不丢）', () => {
    const cut = '{"volumes":[{"title":"甲"}],"chapters":[{"title":"乙"}]'
    expect((parseLooseObject(cut) as { chapters: unknown[] })?.chapters?.length).toBe(1)
  })
  it('🔴 parseObjectArray 走到截断兜底（保住前 N-1 条）', () => {
    const cutArr = '{"list":[{"n":"甲"},{"n":"乙"}]'
    expect(parseObjectArray(cutArr).length).toBe(2)
  })
})

// ---------- 本仓补齐：非对象输入 / 深度嵌套 / 超长输入 / Unicode ----------
describe('补充边界：非对象输入 / 深度嵌套 / 超长输入 / Unicode', () => {
  it('parsePlainObject 对非对象标量返回 null', () => {
    expect(parsePlainObject('123')).toBe(null)
    expect(parsePlainObject('"x"')).toBe(null)
    expect(parsePlainObject('true')).toBe(null)
    expect(parsePlainObject('null')).toBe(null)
  })
  it('parseObjectArray 对非对象输入返回空数组', () => {
    expect(parseObjectArray('123')).toEqual([])
    expect(parseObjectArray('"x"')).toEqual([])
    expect(parseObjectArray('null')).toEqual([])
  })
  it('parseLooseObject 对非对象输入返回 null（不硬造对象）', () => {
    expect(parseLooseObject('42')).toBe(null)
    expect(parseLooseObject('null')).toBe(null)
  })

  it('深度嵌套对象解析后逐层结构一致', () => {
    const deep = { a: { b: { c: { d: { e: [{ f: 'g' }] } } } } }
    expect(parsePlainObject(JSON.stringify(deep))).toEqual(deep)
  })
  it('深度嵌套对象数组被保留为一条、结构完整', () => {
    const arr = parseObjectArray('[{"a":{"b":{"c":[1,2,{"d":"x"}]}}}]')
    expect(arr.length).toBe(1)
    expect(arr[0]).toEqual({ a: { b: { c: [1, 2, { d: 'x' }] } } })
  })

  it('超长输入（5000 条对象）不丢条、不漏项', () => {
    const items = Array.from({ length: 5000 }, (_, i) => ({ i, n: `第${i}条` }))
    const arr = parseObjectArray(JSON.stringify(items))
    expect(arr.length).toBe(5000)
    expect(arr[4999]).toEqual({ i: 4999, n: '第4999条' })
  })
  it('超长输入被截断一个收尾方括号 → 补齐后条目数不减', () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ i }))
    const truncated = JSON.stringify(items).slice(0, -1)
    expect(parseObjectArray(truncated).length).toBe(1000)
    expect((parseTruncatedJson(truncated) as unknown[]).length).toBe(1000)
  })

  it('Unicode：中文键名 / 值 / emoji / 转义引号与换行都原样还原', () => {
    const raw = '{"名":"林烬","标记":"🌑🌒","句":"他说：\\"别动\\"\\n风灌了进来。"}'
    const o = parsePlainObject(raw)
    expect(o?.['名']).toBe('林烬')
    expect(o?.['标记']).toBe('🌑🌒')
    expect(o?.['句']).toBe('他说："别动"\n风灌了进来。')
  })
  it('Unicode 值里的顿号与句号不被 stripStrayPunct 清洗', () => {
    const raw = '{"名":"林烬","desc":"江、河、湖、海，皆可吞。"}'
    expect(parseLooseObject(raw)?.desc).toBe('江、河、湖、海，皆可吞。')
  })
  it('Unicode 围栏 + 夹带解释的单个对象可解析', () => {
    const raw = '好的，结果如下：\n```json\n{"名":"林烬"}\n```\n以上是结果。'
    expect(parsePlainObject(raw)?.['名']).toBe('林烬')
  })
})