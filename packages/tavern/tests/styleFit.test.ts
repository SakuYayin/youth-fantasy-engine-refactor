/**
 * `styleFit.ts` 契约测试 —— 「风格提示」↔ 角色卡「尺度」的**非阻断冲突自检**。
 *
 * 这是那条提醒的**唯一判定入口**，锁两个方向：
 *   · 该报时必报 —— 风格写死聊天体 + 卡文写「可拥抱 / 可哭」，正是 §13
 *     「十香折纸对士道演得像陌生人」的根因，漏了这次移植就白做；
 *   · 不该报时别报 —— 叙事向风格 / 卡文留空 / 尺度只写「保持社交距离」都不该弹，
 *     提醒太滥会被作者直接无视（上游注释原话）。
 *
 * 🔴 队友 A 的 `src/prompt.ts` **可能还没落盘**：`src/styleFit.ts` 静态 import 它，
 *    这时连 `styleFit.ts` 都加载不了。所以本文件**不静态 import 被测模块**，改为
 *    在文件顶部做一次受控的动态 import：
 *      · 加载成功 → 全部用例正常跑（这是常态）；
 *      · 加载失败 → 逐条 `ctx.skip(...)` 并说明原因（**队友迟到不是本文件的缺陷**），
 *        唯独「prompt.ts 已落盘却仍加载不了」那条会真红 —— 那才是移植代码的问题。
 *    这样队友一落盘，这些用例**自动**从 skip 变成真跑，不需要改测试。
 */

import { expect, it, type TestContext } from 'vitest'

// 注：这里**试过**用 `vi.mock` / `vi.doMock` 给缺席的 `../src/prompt.js` 塞替身，两种
// specifier 都拦不住 —— Vite 在解析依赖图时就因为文件不存在而报
// `Cannot find module './prompt.js' imported from .../src/styleFit.ts`，mock 注册表根本轮不上。
// 所以本文件按「动态 import + 缺模块兜底」设计：队友 A 一落盘，下面的用例自动从 skip 变真跑。

/** 被测模块的形状（本地声明，避免静态 import 拖垮加载） */
type StyleFitWarning = { kind: 'chat-vs-rich'; text: string }
type StyleFitInput = { styleHint: string; castRatings: string[] }
type StyleFitModule = {
  checkStyleFit: (input: StyleFitInput) => StyleFitWarning | null
  effectiveStyleHint: (handWritten: string | undefined, tone: 'narrative' | 'chat') => string
}

/**
 * 真模块 `src/prompt.ts`（队友 A 的文件）。它**落盘与否**决定了 `src/styleFit.ts` 能否加载，
 * 所以直接拿它的加载结果当探针 —— 不额外读文件系统（本仓测试只用 vitest，不引 `node:*`）。
 * 队友 A 未落盘时这里拿到 null，下面的用例整体走 `ctx.skip`；落盘后自动变真跑。
 */
const promptMod: { TONE_HINT: Record<'narrative' | 'chat', string> } | null = await import('../src/prompt.js')
  .then(m => m as unknown as { TONE_HINT: Record<'narrative' | 'chat', string> })
  .catch(() => null)

const promptLanded = promptMod !== null

const SKIP = '队友 A 的 src/prompt.ts 尚未落盘 → src/styleFit.ts 无法加载（并行移植时序问题，非本文件缺陷）'

/** 受控加载：拿到模块，或拿到失败原因 */
const load: { mod: StyleFitModule | null; err: unknown } = await import('../src/styleFit.js')
  .then(m => ({ mod: m as unknown as StyleFitModule, err: null as unknown }))
  .catch((e: unknown) => ({ mod: null, err: e }))

/** 取模块；模块不在就跳过本用例 */
function sf(ctx: TestContext): StyleFitModule {
  const m = load.mod
  if (!m) ctx.skip(SKIP)
  if (!m) throw new Error('unreachable：ctx.skip 应已抛出')
  return m
}

/**
 * 出厂 chat 档内置提示的**逐字抄本**（上游 `src/lib/tavern/prompt.ts:109-112`）。
 * 只当作「一个典型的聊天体风格提示」的输入用；真值回归由
 * 「effectiveStyleHint(undefined,'chat')」那条端到端用例负责（它读的是真模块）。
 */
const CHAT_HINT = '〖本场风格〗现代日常场景，以即时聊天的方式说话：短句为主，最多连发 2 条，不要长篇叙述。'

/** 入参整个给 null 这种脏值，只在「不炸」这一点上被断言 */
const asInput = (v: unknown): StyleFitInput => v as StyleFitInput

// ---------------------------------------------------------------- 加载前置

it('src/styleFit.ts 能加载（prompt.ts 已落盘时必须成功，否则是移植代码的问题）', () => {
  if (!promptLanded) {
    // 队友 A 未落盘：此刻加载失败**必须**是缺 prompt.js 造成的，不能被别的错误顶替
    expect(load.mod).toBeNull()
    expect(String(load.err)).toContain('prompt.js')
    return
  }
  expect(load.err).toBeNull()
  expect(load.mod).not.toBeNull()
})

it('出厂 chat 档提示确实是「聊天体」（夹具自检：抄错了下面的用例就没意义了）', () => {
  expect(CHAT_HINT).toContain('短句为主')
  expect(CHAT_HINT).toContain('最多连发')
})

// ---------------------------------------------------------------- 命中方向

it('命中：出厂聊天体 + 高密度尺度 → 报 chat-vs-rich', ctx => {
  const w = sf(ctx).checkStyleFit({ styleHint: CHAT_HINT, castRatings: ['可依偎、可哭，会攥袖口掰手指。'] })
  expect(w).not.toBeNull()
  expect(w!.kind).toBe('chat-vs-rich')
})

it('命中的提醒里带上风格原文摘要（含「连发」）', ctx => {
  const w = sf(ctx).checkStyleFit({ styleHint: CHAT_HINT, castRatings: ['可依偎、可哭，会攥袖口掰手指。'] })
  expect(w!.text).toContain('连发')
})

it('命中的提醒里带上尺度原文摘要（含「依偎」）', ctx => {
  const w = sf(ctx).checkStyleFit({ styleHint: CHAT_HINT, castRatings: ['可依偎、可哭，会攥袖口掰手指。'] })
  expect(w!.text).toContain('依偎')
})

it('命中的提醒明说「可改成叙事向」的出路', ctx => {
  const w = sf(ctx).checkStyleFit({ styleHint: CHAT_HINT, castRatings: ['可依偎、可哭。'] })
  expect(w!.text).toMatch(/叙事向/)
})

it('🔴 提醒文案里的「有距离感」是**带双引号**的（上游写 `\\"…\\"`，模板字符串里即普通双引号）', ctx => {
  const w = sf(ctx).checkStyleFit({ styleHint: CHAT_HINT, castRatings: ['可依偎、可哭。'] })
  // 上游源码是 `…\"有距离感\"`，但它在**模板字符串**里 —— 运行时值就是 "有距离感"，
  // 反斜杠不会出现在值里。照抄源码字面量来断言会红，这里按真实值钉。
  expect(w!.text).toContain('"有距离感"')
  expect(w!.text).not.toContain('\\"有距离感\\"')
})

it('摘要截断：风格提示超 24 字时以「…」收尾（原样嵌入会把提示撑成一大段）', ctx => {
  const long = '像聊天一样，不要长篇，短句为主，最多连发 2 条，别写长段落，保持日常口吻不要文绉绉。'
  expect(long.length).toBeGreaterThan(24)
  const w = sf(ctx).checkStyleFit({ styleHint: long, castRatings: ['可拥抱。'] })
  expect(w).not.toBeNull()
  expect(w!.text).toContain(`${long.slice(0, 24)}…`)
})

it('摘要不截断：风格提示不超过 24 字时原样嵌入、没有省略号', ctx => {
  const short = '短句为主。'
  const w = sf(ctx).checkStyleFit({ styleHint: short, castRatings: ['可拥抱。'] })
  expect(w!.text).toContain(`「${short}」`)
  expect(w!.text).not.toContain(`${short}…`)
})

it('正则覆盖的其余聊天体措辞：「聊天体 / 即时聊天 / 别长篇 / 短消息」都命中', ctx => {
  const { checkStyleFit } = sf(ctx)
  for (const hint of ['聊天体', '即时聊天', '别长篇', '短消息']) {
    expect(checkStyleFit({ styleHint: hint, castRatings: ['可拥抱。'] })).not.toBeNull()
  }
})

it('正则覆盖的其余高密度措辞：「肢体 / 细腻 / 情感外露 / 泪」都命中', ctx => {
  const { checkStyleFit } = sf(ctx)
  for (const rating of ['肢体接触自然', '描写细腻', '情感外露', '会流泪']) {
    expect(checkStyleFit({ styleHint: CHAT_HINT, castRatings: [rating] })).not.toBeNull()
  }
})

it('多张卡时取**第一个**命中高密度的卡做摘要', ctx => {
  const w = sf(ctx).checkStyleFit({ styleHint: CHAT_HINT, castRatings: ['日常向。', '可牵手。', '可拥抱。'] })
  expect(w!.text).toContain('牵手')
  expect(w!.text).not.toContain('拥抱')
})

// ---------------------------------------------------------------- 不该报的方向

it('反向：叙事向风格（空串）→ 不报（哪怕卡文写满高密度尺度）', ctx => {
  expect(sf(ctx).checkStyleFit({ styleHint: '', castRatings: ['可拥抱、可靠得很近。'] })).toBeNull()
})

it('反向：风格写「第三人称客观叙事，允许长段描写」→ 不报', ctx => {
  expect(
    sf(ctx).checkStyleFit({ styleHint: '第三人称客观叙事，允许长段描写。', castRatings: ['可拥抱。'] }),
  ).toBeNull()
})

it('反向：风格聊天体但本场没有卡文尺度 → 不报', ctx => {
  expect(sf(ctx).checkStyleFit({ styleHint: CHAT_HINT, castRatings: [] })).toBeNull()
})

it('反向：尺度全是空串／空白视同没填 → 不报', ctx => {
  expect(sf(ctx).checkStyleFit({ styleHint: CHAT_HINT, castRatings: ['', '  '] })).toBeNull()
})

it('反向：尺度只写「日常向，保持社交距离」→ 不报（提醒太滥会被作者直接无视）', ctx => {
  expect(sf(ctx).checkStyleFit({ styleHint: CHAT_HINT, castRatings: ['日常向，保持社交距离。'] })).toBeNull()
})

it('覆盖写法一：「像聊天 / 不要长篇」也算聊天体', ctx => {
  const w = sf(ctx).checkStyleFit({ styleHint: '像聊天一样，不要长篇。', castRatings: ['会哭，会攥紧衣角。'] })
  expect(w).not.toBeNull()
  expect(w!.kind).toBe('chat-vs-rich')
})

it('覆盖写法二：「消息体 / 最多连发 3 条」也算聊天体（连发条数是正则里的 \\d+）', ctx => {
  expect(sf(ctx).checkStyleFit({ styleHint: '消息体，最多连发 3 条。', castRatings: ['可牵手。'] })).not.toBeNull()
})

it('覆盖写法三：卡文写「第 4 章示例对话」也算高密度', ctx => {
  expect(
    sf(ctx).checkStyleFit({ styleHint: '短句为主。', castRatings: ['第 4 章示例对话里有拥抱。'] }),
  ).not.toBeNull()
})

it('繁简不通用：本模块只看这些简体措辞（「可擁抱」不命中）', ctx => {
  expect(sf(ctx).checkStyleFit({ styleHint: CHAT_HINT, castRatings: ['可擁抱。'] })).toBeNull()
})

// ---------------------------------------------------------------- 防御性输入

it('防御：styleHint 为 undefined → 不报、不炸', ctx => {
  expect(
    sf(ctx).checkStyleFit({ styleHint: undefined as unknown as string, castRatings: ['可拥抱。'] }),
  ).toBeNull()
})

it('防御：castRatings 为 undefined → 不报、不炸', ctx => {
  expect(
    sf(ctx).checkStyleFit({ styleHint: CHAT_HINT, castRatings: undefined as unknown as string[] }),
  ).toBeNull()
})

it('防御：入参整个为 null → 不炸、返回 null', ctx => {
  expect(sf(ctx).checkStyleFit(asInput(null))).toBeNull()
})

it('防御：castRatings 里混进 null 项 → 视同没填，其余照常判定', ctx => {
  const dirty = [null, '  ', '可拥抱。'] as unknown as string[]
  expect(sf(ctx).checkStyleFit({ styleHint: CHAT_HINT, castRatings: dirty })!.kind).toBe('chat-vs-rich')
})

// ---------------------------------------------------------------- 生效风格提示

it('effectiveStyleHint：手填非空 → 原样返回（首尾空白已裁）', ctx => {
  const { effectiveStyleHint } = sf(ctx)
  expect(effectiveStyleHint('作者自己写的风格', 'chat')).toBe('作者自己写的风格')
  expect(effectiveStyleHint('  作者自己写的风格  ', 'chat')).toBe('作者自己写的风格')
})

it('effectiveStyleHint：手填空串 → 回落 chat 档内置默认（非空）', ctx => {
  const eff = sf(ctx).effectiveStyleHint('', 'chat')
  expect(eff).not.toBe('')
  expect(eff).toContain('短句')
})

it('effectiveStyleHint：手填全是空格 → 视同没填、回落档位默认', ctx => {
  const { effectiveStyleHint } = sf(ctx)
  expect(effectiveStyleHint('   ', 'chat')).toBe(effectiveStyleHint('', 'chat'))
})

it('effectiveStyleHint：手填 undefined 与空串等价 → 都回落档位默认', ctx => {
  const { effectiveStyleHint } = sf(ctx)
  expect(effectiveStyleHint(undefined, 'chat')).toBe(effectiveStyleHint('', 'chat'))
})

it('🔴 叙事档默认是空串（与「作者清空」不可区分 —— 界面口径是宁可少报）', ctx => {
  const { effectiveStyleHint } = sf(ctx)
  expect(effectiveStyleHint('', 'narrative')).toBe('')
  expect(effectiveStyleHint(undefined, 'narrative')).toBe('')
})

it('effectiveStyleHint 回落值就是真模块的 TONE_HINT[tone]（prompt.ts 已落盘时逐字相等）', ctx => {
  if (!promptMod) ctx.skip('队友 A 的 src/prompt.ts 尚未落盘，无法比对真值')
  const { effectiveStyleHint } = sf(ctx)
  expect(effectiveStyleHint('', 'chat')).toBe(promptMod!.TONE_HINT.chat)
  expect(effectiveStyleHint(undefined, 'narrative')).toBe(promptMod!.TONE_HINT.narrative)
})

// ---------------------------------------------------------------- 端到端

it('端到端：作者没动过控制面板时也按出厂聊天体判定（不会因为「空」就漏报）', ctx => {
  const { checkStyleFit, effectiveStyleHint } = sf(ctx)
  const w = checkStyleFit({ styleHint: effectiveStyleHint(undefined, 'chat'), castRatings: ['可依偎、可哭。'] })
  expect(w).not.toBeNull()
  expect(w!.kind).toBe('chat-vs-rich')
})

it('端到端：作者把框清空 → 拿到的是 chat 档默认，于是照常判定（宁可少报的取舍）', ctx => {
  const { checkStyleFit, effectiveStyleHint } = sf(ctx)
  expect(checkStyleFit({ styleHint: effectiveStyleHint('', 'chat'), castRatings: ['可拥抱。'] })).not.toBeNull()
})

it('纯函数：同输入重复调用结果稳定（判定里没有随机 / 时间依赖）', ctx => {
  const { checkStyleFit } = sf(ctx)
  const input = { styleHint: CHAT_HINT, castRatings: ['可拥抱。'] }
  expect(checkStyleFit(input)).toEqual(checkStyleFit(input))
})

it('判定是纯的：文案跟着**卡文**走，不缓存上一场的结果（无共享可变状态）', ctx => {
  const { checkStyleFit } = sf(ctx)
  const a = checkStyleFit({ styleHint: CHAT_HINT, castRatings: ['可拥抱。'] })
  const b = checkStyleFit({ styleHint: CHAT_HINT, castRatings: ['可牵手。'] })
  expect(a!.kind).toBe(b!.kind) // 同类冲突
  expect(a!.text).not.toBe(b!.text) // 但摘要嵌的是各自的卡文
  expect(a!.text).toContain('拥抱')
  expect(b!.text).toContain('牵手')
  // 回过头再调一次，结果必须和第一次一模一样（没有被上一次调用污染）
  expect(checkStyleFit({ styleHint: CHAT_HINT, castRatings: ['可拥抱。'] })!.text).toBe(a!.text)
})
