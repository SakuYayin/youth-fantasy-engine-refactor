/**
 * 面板：灵感启发（inspire-tools）—— 纯逻辑层（无框架依赖、无 node:* 导入、无网络）。
 *
 * 职责：三张工具卡的全部可测逻辑——
 * 1. 随机灵感：题材 × 主题 × 冲突 × 反差 四池抽取，套句式模板成一句灵感（纯本地，不调 AI）；
 * 2. 名字生成：人物名（姓氏 × 名字用字）/ 门派名 / 功法名 / 地名（前缀 × 后缀），纯本地；
 * 3. 点子组合：关键词解析 + AI 请求构造（只描述请求，绝不发请求）+ 响应解析 + 失败提示。
 *
 * 纪律（docs/接口冻结-面板层.md §2/§4）：
 * - 所有随机函数抽成 `pickRandom<T>(pool, rng?: () => number)`：rng 可注入，
 *   测试用固定种子断言；真实路径默认 Math.random。
 * - AI 请求由视图层走 `props.state.ai.complete(request)`（渲染层 CSP 禁网，
 *   实际请求由主进程发出）；本模块不 import 'node:*'、不 fetch、不直连模型服务商。
 * - AI 发散用默认 maxTokens（不传，由模型配置决定）与默认 temperature。
 * - 「抽中历史」只记录本地随机抽取（灵感 / 名字各按一次用户动作记一条），
 *   AI 点子不进历史；面板内存保留最近 HISTORY_LIMIT 条，不持久化。
 * - 所有面向用户的文案常量集中在此导出，视图层（inspire-tools.vue）只消费常量
 *   与 tab 元数据，保证「可见文本 ⊆ 页签文案 ∪ 常量」。
 *
 * 旧版参考（只读，仅学功能结构与文案，不照抄 React）：
 * `_upstream_tmp/youth-fantasy-engine-main/src/components/creative/InspireTools.tsx`
 * （随机取名生成器 + AI 辅助脑暴）、`lib/creative/creativeSeed.ts`（想法引导栏位）。
 * 本版按当前任务书收敛为「随机灵感 + 名字生成 + 点子组合」三张本地工具卡。
 */

import type { AiErrorCode, AiRequest } from '../ai/types.js'

/* ==========================================================================
 * 类型
 * ========================================================================== */

/** 「随机灵感」一次抽取的完整构成与成句结果。 */
export interface InspirationDraw {
  readonly genre: string
  readonly theme: string
  readonly conflict: string
  readonly contrast: string
  readonly text: string
}

/** 名字生成的四类目标。 */
export type NameKind = 'person' | 'sect' | 'technique' | 'place'

/** 名字类型下拉选项（label 面向用户）。 */
export interface NameKindOption {
  readonly kind: NameKind
  readonly label: string
}

/** 点子组合关键词校验失败的具体问题。 */
export type IdeaInputProblem = 'blank' | 'tooFew' | 'tooMany'

/** 点子组合：输入解析 + AI 请求构造的结果（判别联合，ok 字段区分）。 */
export type IdeaRequestPlan =
  | { readonly ok: true; readonly keywords: readonly string[]; readonly request: AiRequest }
  | { readonly ok: false; readonly keywords: readonly string[]; readonly problem: IdeaInputProblem }

/** 「AI 发散」按钮的状态机。 */
export type IdeaStatus = 'idle' | 'running' | 'done' | 'failed'

/** 「抽中历史」条目（source 是动作来源的卡片标题）。 */
export interface HistoryEntry {
  readonly source: string
  readonly text: string
}

/* ==========================================================================
 * 文案常量（视图层可见文本的唯一来源，与 tab 元数据一起构成全部可见文本）
 * ========================================================================== */

/** 三张工具卡与历史区标题。 */
export const CARD_INSPIRE_TITLE = '随机灵感'
export const CARD_NAME_TITLE = '名字生成'
export const CARD_IDEA_TITLE = '点子组合'
export const CARD_HISTORY_TITLE = '抽中历史'

/** 按钮文案。 */
export const BUTTON_ANOTHER = '换一个'
export const BUTTON_ROLL_NAMES = '生成名字'
export const BUTTON_IDEA_GO = 'AI 发散'
export const BUTTON_IDEA_RUNNING = 'AI 发散中…'
export const BUTTON_CLEAR_HISTORY = '清空历史'

/** 表单标签。 */
export const NAME_KIND_LABEL = '名字类型'
export const IDEA_INPUT_LABEL = '关键词'

/** 点子组合输入提示与占位。 */
export const IDEA_INPUT_PLACEHOLDER = '输入 2–3 个关键词，用空格、逗号或顿号分隔'
export const IDEA_INPUT_HINT = '在上方输入 2–3 个关键词，点击「AI 发散」让模型发散一组点子；未配置模型时会给出引导。'
export const IDEA_EMPTY_RESULT = '模型没有给出可显示的点子，请重试一次。'

/** 空态提示。 */
export const NAMES_EMPTY_HINT = '当前类型还没有名字，点击「生成名字」抽一批。'
export const INSPIRATION_EMPTY_HINT = '点「换一个」抽一句灵感。'
export const HISTORY_EMPTY_HINT = '暂无抽中记录：点「换一个」或「生成名字」后会出现在这里。'

/** 未配置模型时的引导（不发起请求；随机类本地能力不受影响）。 */
export const NO_MODEL_HINT =
  '尚未配置模型：AI 发散暂不可用。请到「模型设置」页签配置模型后重试；随机灵感与名字生成是本地能力，不受影响。'

/** 能力与持久化边界说明（如实展示）。 */
export const NO_PERSIST_NOTE =
  '随机灵感与名字生成全部在本地运行；点子组合走当前配置的模型。抽中历史只保留在当前页面（最近 10 条），不会被保存或上传。'

/** 关键词非法提示（blank=没输入 / tooFew=不足 2 个 / tooMany=超过 3 个）。 */
export const IDEA_KEYWORD_HINTS: Readonly<Record<IdeaInputProblem, string>> = {
  blank: '请先输入关键词，再点「AI 发散」。',
  tooFew: '关键词至少需要 2 个，请再补一个。',
  tooMany: '关键词最多 3 个，请删掉多余的。',
}

/** AI 抛异常（而非返回失败结果）时的失败前缀。 */
export const IDEA_FAILED = 'AI 发散失败'

/* ==========================================================================
 * 口径常量（测试逐字锁死）
 * ========================================================================== */

/** 名字每批抽几个。 */
export const NAME_BATCH_SIZE = 6

/** 人物名抽成两字名的概率阈值（rng() < 该值 → 两字名）。 */
export const PERSON_GIVEN_TWO_PROB = 0.6

/** 「抽中历史」保留条数上限。 */
export const HISTORY_LIMIT = 10

/** 「AI 发散」要求模型给出的点子条数。 */
export const IDEA_COUNT = 5

/** 关键词个数下限 / 上限。 */
export const IDEA_KEYWORD_MIN = 2
export const IDEA_KEYWORD_MAX = 3

/** 「AI 发散」的 system 提示（只约束角色与输出格式，不携带用户数据）。 */
export const IDEA_SYSTEM_PROMPT =
  '你是中文网文灵感助手。根据用户给出的关键词，发散一组创作点子。' +
  `输出恰好 ${IDEA_COUNT} 条，每条一行、不要编号，先给一个短点子名（不超过 8 字），` +
  '再用括号补一句展开说明，总长度控制在 200 字以内。'

/* ==========================================================================
 * 本地词库（自拟，风格贴合中文网文；测试断言长度下限 + 唯一 + 非空）
 * ========================================================================== */

/** 随机灵感：题材池。 */
export const INSPIRATION_GENRES: readonly string[] = [
  '修真仙侠',
  '东方玄幻',
  '西方奇幻',
  '都市异能',
  '星际科幻',
  '赛博朋克',
  '末日废土',
  '悬疑灵异',
  '历史架空',
  '宫廷权谋',
  '武侠江湖',
  '游戏异世',
  '无限流',
  '克苏鲁诡秘',
]

/** 随机灵感：主题池。 */
export const INSPIRATION_THEMES: readonly string[] = [
  '逆天改命',
  '复仇雪恨',
  '守护至亲',
  '寻道问心',
  '家国天下',
  '师徒羁绊',
  '废柴崛起',
  '宿命轮回',
  '真相追寻',
  '文明兴衰',
  '自由反抗',
  '爱恨两难',
  '信念坚守',
  '成长蜕变',
]

/** 随机灵感：冲突池。 */
export const INSPIRATION_CONFLICTS: readonly string[] = [
  '宗门倾轧',
  '皇位之争',
  '正邪大战',
  '种族存亡',
  '天道压制',
  '挚友反目',
  '家族覆灭',
  '强者垄断',
  '旧秩序崩塌',
  '两界入侵',
  '人心博弈',
  '师门恩怨',
  '秘宝争夺',
  '宿敌纠缠',
]

/** 随机灵感：反差池（人物设定的反差感）。 */
export const INSPIRATION_CONTRASTS: readonly string[] = [
  '弱小少年身怀绝世传承',
  '冷漠杀手心藏一丝柔情',
  '纨绔子弟暗中布局十年',
  '凡人少女竟能洞察天机',
  '落魄老者曾是巅峰剑仙',
  '人人畏惧的魔头实为护道人',
  '光风霁月的圣女背负血仇',
  '废柴一夜觉醒上古神格',
  '谦和书生执掌生死簿',
  '散漫浪子天生道体',
  '怯懦小吏一怒屠魔',
  '天之骄女偏要逆流而行',
  '独眼老仆看尽世间兴亡',
  '无名小卒背上刻着封神榜',
]

/** 随机灵感：句式模板（rng 决定选哪一条；字段顺序 = genre, theme, conflict, contrast）。 */
export type InspirationTemplate = (
  genre: string,
  theme: string,
  conflict: string,
  contrast: string,
) => string

export const INSPIRATION_TEMPLATES: readonly InspirationTemplate[] = [
  (genre, theme, conflict, contrast) => `一个${genre}故事：${contrast}，却卷入${conflict}，只为${theme}。`,
  (genre, theme, conflict, contrast) => `【${genre}】${contrast}，而${conflict}——「${theme}」是这段命运的注脚。`,
  (genre, theme, conflict, contrast) => `${genre}之下，${contrast}；${theme}与${conflict}迎面相撞。`,
  (genre, theme, conflict, contrast) => `当${conflict}降临，${contrast}，依然选择${theme}——这就是${genre}的底色。`,
]

/** 名字生成：姓氏池（56 姓）。 */
export const SURNAMES: readonly string[] = [
  '李', '王', '张', '刘', '陈', '杨', '黄', '赵', '吴', '周',
  '徐', '孙', '马', '朱', '胡', '郭', '何', '林', '罗', '郑',
  '梁', '谢', '宋', '唐', '许', '韩', '冯', '邓', '曹', '彭',
  '曾', '萧', '田', '董', '潘', '袁', '蔡', '蒋', '余', '杜',
  '叶', '程', '苏', '魏', '吕', '丁', '任', '卢', '姚', '沈',
  '钟', '姜', '崔', '谭', '陆', '范',
]

/** 名字生成：名字用字池（66 个单字，人物名 1–2 字随机拼）。 */
export const GIVEN_CHARS: readonly string[] = [
  '云', '风', '雪', '月', '辰', '夜', '寒', '烟', '雨', '尘',
  '霜', '霄', '瑶', '瑾', '瑜', '澜', '渊', '曦', '晨', '溪',
  '川', '岳', '峰', '岚', '竹', '梅', '兰', '松', '柏', '鹤',
  '燕', '雁', '鸿', '鸢', '璃', '璧', '琼', '琳', '琅', '玄',
  '素', '青', '白', '墨', '清', '越', '鸣', '吟', '歌', '笛',
  '剑', '书', '棋', '画', '花', '灯', '舟', '星', '河', '山',
  '海', '天', '无', '极', '归', '遥',
]

/** 门派名：前缀池 / 后缀池。 */
export const SECT_PREFIXES: readonly string[] = [
  '青云', '天璇', '紫霄', '玄天', '太虚', '万剑', '落霞', '赤炎',
  '碧游', '凌霄', '苍梧', '北冥', '九幽', '丹鼎', '星宿', '听雪',
]
export const SECT_SUFFIXES: readonly string[] = [
  '宗', '门', '派', '阁', '谷', '山庄', '宫', '殿', '教', '盟', '楼', '坊',
]

/** 功法名：前缀池 / 后缀池。 */
export const TECHNIQUE_PREFIXES: readonly string[] = [
  '九转', '太上', '紫霞', '天罡', '混沌', '无极', '焚天', '御剑',
  '化神', '大衍', '周天', '造化', '镇岳', '赤霄', '噬月', '伏魔',
]
export const TECHNIQUE_SUFFIXES: readonly string[] = [
  '诀', '功', '心法', '真经', '剑典', '神通', '印', '术', '篇', '录', '拳', '步',
]

/** 地名：前缀池 / 后缀池。 */
export const PLACE_PREFIXES: readonly string[] = [
  '落霞', '苍澜', '北境', '南荒', '东海', '玄水', '幽州', '云梦',
  '九黎', '临渊', '栖霞', '平沙', '朔风', '青丘', '锁龙', '忘川',
]
export const PLACE_SUFFIXES: readonly string[] = [
  '城', '镇', '山', '谷', '湖', '海', '岛', '洲', '岭', '原', '关', '墟',
]

/** 名字类型下拉选项。 */
export const NAME_KIND_OPTIONS: readonly NameKindOption[] = [
  { kind: 'person', label: '人物名' },
  { kind: 'sect', label: '门派名' },
  { kind: 'technique', label: '功法名' },
  { kind: 'place', label: '地名' },
]

/* ==========================================================================
 * 随机核心（rng 可注入；真实路径默认 Math.random）
 * ========================================================================== */

/**
 * 从池中随机抽一条。rng 可注入（测试用固定种子断言）；真实路径默认 Math.random。
 * 空池直接抛 RangeError（词库常量非空，正常路径不会触发）。
 */
export function pickRandom<T>(pool: readonly T[], rng: () => number = Math.random): T {
  if (pool.length === 0) {
    throw new RangeError('随机池为空，无法抽取')
  }
  const index = Math.floor(rng() * pool.length)
  const picked = pool[index]
  if (picked === undefined) {
    throw new RangeError(`随机池索引越界：${index}`)
  }
  return picked
}

/* ==========================================================================
 * 随机灵感
 * ========================================================================== */

/** 抽一句灵感：四池各抽一条 + 随机选一个句式模板成句。 */
export function rollInspiration(rng: () => number = Math.random): InspirationDraw {
  const genre = pickRandom(INSPIRATION_GENRES, rng)
  const theme = pickRandom(INSPIRATION_THEMES, rng)
  const conflict = pickRandom(INSPIRATION_CONFLICTS, rng)
  const contrast = pickRandom(INSPIRATION_CONTRASTS, rng)
  const template = pickRandom(INSPIRATION_TEMPLATES, rng)
  return {
    genre,
    theme,
    conflict,
    contrast,
    text: template(genre, theme, conflict, contrast),
  }
}

/* ==========================================================================
 * 名字生成
 * ========================================================================== */

/** 按类型抽一个名字：人物名 = 姓氏 + 1~2 个名字用字；其余 = 前缀 + 后缀。 */
export function rollName(kind: NameKind, rng: () => number = Math.random): string {
  if (kind === 'person') {
    const surname = pickRandom(SURNAMES, rng)
    const twoChars = rng() < PERSON_GIVEN_TWO_PROB
    const first = pickRandom(GIVEN_CHARS, rng)
    const given = twoChars ? `${first}${pickRandom(GIVEN_CHARS, rng)}` : first
    return `${surname}${given}`
  }
  if (kind === 'sect') {
    return `${pickRandom(SECT_PREFIXES, rng)}${pickRandom(SECT_SUFFIXES, rng)}`
  }
  if (kind === 'technique') {
    return `${pickRandom(TECHNIQUE_PREFIXES, rng)}${pickRandom(TECHNIQUE_SUFFIXES, rng)}`
  }
  return `${pickRandom(PLACE_PREFIXES, rng)}${pickRandom(PLACE_SUFFIXES, rng)}`
}

/** 按类型抽一批名字（NAME_BATCH_SIZE 个，允许重复——随机池不查重）。 */
export function rollNames(kind: NameKind, rng: () => number = Math.random): readonly string[] {
  return Array.from({ length: NAME_BATCH_SIZE }, () => rollName(kind, rng))
}

/* ==========================================================================
 * 点子组合（关键词解析 + AI 请求构造 + 响应解析 + 失败提示）
 * ========================================================================== */

/**
 * 解析用户输入的关键词：按空白 / 半角逗号 / 顿号 / 分号 / 斜杠 / 竖线切分，
 * trim、去空、按出现顺序去重。空输入返回空数组。
 */
export function parseKeywords(input: string): readonly string[] {
  const parts = input.split(/[\s,，、;；/|]+/)
  const seen = new Set<string>()
  for (const part of parts) {
    const keyword = part.trim()
    if (keyword.length > 0) {
      seen.add(keyword)
    }
  }
  return [...seen]
}

/** 判定关键词个数问题（只看个数，不做其它校验）。 */
export function keywordProblem(count: number): IdeaInputProblem | null {
  if (count === 0) {
    return 'blank'
  }
  if (count < IDEA_KEYWORD_MIN) {
    return 'tooFew'
  }
  if (count > IDEA_KEYWORD_MAX) {
    return 'tooMany'
  }
  return null
}

/**
 * 由关键词输入构造「AI 发散」请求计划（判别联合）：
 * ok=true 时 request 只含 system + messages（用默认 maxTokens / temperature，不传）；
 * ok=false 时给出问题类别，视图据此显示 IDEA_KEYWORD_HINTS。
 */
export function buildIdeaRequest(input: string): IdeaRequestPlan {
  const keywords = parseKeywords(input)
  const problem = keywordProblem(keywords.length)
  if (problem !== null) {
    return { ok: false, keywords, problem }
  }
  const request: AiRequest = {
    system: IDEA_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `关键词：${keywords.join('、')}\n请围绕这些关键词发散 ${IDEA_COUNT} 条创作点子。`,
      },
    ],
  }
  return { ok: true, keywords, request }
}

/**
 * 解析模型回复的点子列表：按行剥掉「1. / 1、 / 1） / - / * / • / · / 一、」等
 * 列表前缀，trim、去空行。非列表行原样保留。
 */
export function parseIdeaList(text: string): readonly string[] {
  const lines = text.split(/\r?\n/)
  const ideas: string[] = []
  for (const raw of lines) {
    const line = raw.replace(/^\s*(?:[-*•·‣]|\d{1,2}\s*[.、)）]|[一二三四五六七八九十]{1,3}[、.])\s*/, '').trim()
    if (line.length > 0) {
      ideas.push(line)
    }
  }
  return ideas
}

/** 每个错误码一句中文提示（视图的失败文案由 failureNotice 拼装）。 */
export const AI_ERROR_HINT: Readonly<Record<AiErrorCode, string>> = {
  AI_NOT_CONFIGURED: '尚未配置模型，无法 AI 发散',
  AI_AUTH_FAILED: '模型鉴权失败，请到「模型设置」页签检查凭证',
  AI_RATE_LIMITED: '模型调用触发限流，请稍后再试',
  AI_TIMEOUT: '模型响应超时',
  AI_UPSTREAM_ERROR: '模型服务异常',
  AI_RESPONSE_MALFORMED: '模型返回了无法解析的内容',
  AI_CANCELLED: '模型请求已取消',
}

/**
 * AI 失败（返回 ok=false 结果）时的提示文案：错误码提示 + 原始信息 +
 * 引导先用本地工具（随机灵感与名字生成不受影响）。
 */
export function failureNotice(code: AiErrorCode, message: string): string {
  return `${AI_ERROR_HINT[code]}（${code}：${message}）。随机灵感与名字生成不受影响，可先用本地工具。`
}

/** 「AI 发散」成功后回显的关键词行。 */
export function formatIdeaKeywords(keywords: readonly string[]): string {
  return `关键词：${keywords.join('、')}`
}

/* ==========================================================================
 * 抽中历史（面板内存，不持久化；只记录本地随机抽取）
 * ========================================================================== */

/** 新条目插到最前，超出 HISTORY_LIMIT 截断（保留最近 10 条）。 */
export function pushHistory(prev: readonly HistoryEntry[], entry: HistoryEntry): readonly HistoryEntry[] {
  return [entry, ...prev].slice(0, HISTORY_LIMIT)
}
