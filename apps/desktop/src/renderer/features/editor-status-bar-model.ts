/**
 * 编辑器状态栏纯逻辑（W9-1 / A-13）—— 上游 `NovelEditor.tsx:616-664` 的底部状态栏。
 *
 * ## 真源纪律
 * - 结构/文案真源＝`_upstream_tmp/youth-fantasy-engine-main/src/components/editor/NovelEditor.tsx:616-664`
 *   （本章字数 620-622 / 今日码字 623-625 / 铺满·限宽 630-637 / 打字机 638-645 /
 *   字号 −＋ 646-660 / 说明气泡 661-663）。
 * - 字数口径真源＝上游 `src/lib/editor/textStats.ts` 与 `wordCountModeOf` —— 本仓已由
 *   **B-13** 落在 `@yfe/domain`（`packages/domain/src/text/count.ts`），这里只调用，**不重写算法**。
 * - 字号范围真源＝上游 `useNovelEditorModel.ts`：`fontSize >= 14 && fontSize <= 28`，默认 17。
 *
 * ## 三条边界
 * - **不碰 IO**：本模块只做「值 → 文案 / 补丁」的换算；不读 props、不碰 `localStorage`、
 *   不认识 DOM。「设置写在哪」由父层的 `SettingsPort` 决定（铁律 5）。
 * - **文案唯一来源**：`.vue` 模板里不出现中文字面量，一律走 `EDITOR_STATUS_BAR_COPY` 与
 *   `EDITOR_STATUS_BAR_HELP_LINES`，测试直接断言这张表。
 * - **口径纪律**：本章字数只在**显示层**切 `'cjk-punct'`；落库与硬约束一律用 `'cjk'`
 *   （`count.ts:13-17` 写得很硬：「写够 3000 字」这类约束不能跟着显示开关漂移）。
 *   因此本模块对外**只收布尔偏好、只吐显示文案**，不提供任何"把带标点字数存起来"的入口。
 *
 * ## 落盘项的补丁形状
 * `pageWide` / `typewriter` 是本仓**新增**的两个设置字段（上游散落在 localStorage 的
 * `'novel-page-wide'` / `'novel-typewriter'`，本仓没有这两个 key）。它们的真源在
 * `AppSettingsView`（`features/types.ts`），本文件只发补丁、不落盘。
 */

import { countWords, wordCountModeOf } from '@yfe/domain'

import type { AppSettingsView } from './types.js'

/**
 * 状态栏文案与标题的唯一来源。
 *
 * - 本章字数的可见文案就是「`1,234 字`」（上游 621 行：图标 + 数字 + ` 字`，**没有**「本章」前缀）
 *   —— 「本章字数」这份说明在上游是 `title`，见 `chapterTitlePlain`。
 * - `todayTitle` 逐字抄自上游 623 行（含破折号与全角引号，不要改标点）。
 */
export const EDITOR_STATUS_BAR_COPY = Object.freeze({
  /** 字数单位（上游 621/624 行两处都是 ` 字`）。 */
  unit: '字',
  /** 「今日」前缀（上游 624 行 `今日 {todayWords} 字`）。 */
  todayLabel: '今日',
  /** 读不到数据时的占位符：**绝不用 0** —— 0 是「今天没写」，`—` 是「读不到」。 */
  unknownValue: '—',
  /** 本章字数 title（上游 620 行原文去掉尾句，见 `chapterTitleWithPunct` 的注释）。 */
  chapterTitlePlain: '本章字数（只算汉字口径）',
  /** 汉字＋标点口径的本章字数 title。 */
  chapterTitleWithPunct: '本章字数（汉字＋标点口径）',
  /** 今日码字 title：逐字抄自上游 623 行。 */
  todayTitle:
    '今日码字量（按增删自动累计，固定「只算汉字」口径 —— 它记的是当天净增量，换口径也无法重算历史）',
  /** 读不到今日码字时的 title（上游没有这一态：它的每日净增量来自落库表，本仓 B-17/E-03 未做）。 */
  todayUnavailableTitle: '今日码字量：暂不可用（按日统计通道还没接入，读不到今天的净增量）',
  /** 铺满/限宽按钮的两个可见词（上游 636 行）。 */
  pageWideLabel: '铺满',
  narrowLabel: '限宽',
  /** 铺满态的 title：逐字抄自上游 634 行。 */
  pageWideTitle: '当前：码字区铺满窗口（点击改为限宽阅读）',
  /** 限宽态的 title：逐字抄自上游 634 行。 */
  narrowTitle: '当前：限宽阅读（点击改为铺满窗口）',
  /** 打字机按钮可见词与 title（上游 642/644 行）。 */
  typewriterLabel: '打字机',
  typewriterTitle: '打字机模式：输入行自动保持在屏幕中部',
  /** 字号 −/＋ 的无障碍名（上游 650/657 行只有 title）。 */
  fontDecreaseLabel: '减小字号',
  fontIncreaseLabel: '增大字号',
  /** 字号组的 role=group 名 + 范围说明（上游把范围写在说明气泡里：「正文字号 14–28px」）。 */
  fontGroupLabel: '正文字号',
  fontRangeTitle: '正文字号 14–28px',
  /** 说明气泡标题（上游 661 行 `HelpPopover title`）。 */
  helpTitle: '状态栏 · 码字体验设置',
  /** 说明触发键的 title：上游 HelpPopover.tsx:140 的 `${title}（点击查看说明）`。 */
  helpTriggerTitle: '状态栏 · 码字体验设置（点击查看说明）',
  /** 说明气泡内的小标题与正文的 aria 名。 */
  helpPanelLabel: '状态栏说明',
})

/**
 * 说明气泡正文（上游 662 行的 `\n` 分段文本，逐行拆开便于渲染与断言）。
 *
 * ⚠️ 与上游的三处刻意偏差（详见交付报告）：
 * 1. 上游说「左侧**三项**是实时状态」并含第三条「自动保存已开启」；本仓保存状态由
 *    `YfeStatusPill` 独占（ADR 0006 D5），状态栏里没有第三项 ⇒ 改成「左侧两项」。
 * 2. 上游写「可在写作面板切到「汉字＋标点」」—— 本仓该开关尚未还原（台账 R-91），
 *    留着会把用户指向一个不存在的入口 ⇒ 去掉指向，只留口径说明。
 * 3. 上游写「写作面板的码字日历用的就是它」—— 本仓码字日历（C-02）未做 ⇒ 去掉该句。
 * 保留「本机记忆，换章不重置」：`pageWide` / `typewriter` / `fontSize` 走 `SettingsPort`
 * 落盘后，这句话就成立（Lead 接线时须补齐这两个字段，见报告第 ⑦ 节）。
 */
export const EDITOR_STATUS_BAR_HELP_LINES: readonly string[] = Object.freeze([
  '左侧两项是实时状态：',
  '· 字数：本章当前字数（中文按字计）；跟随「字数口径」设置 —— 默认「只算汉字」，切到「汉字＋标点」可对齐平台计费口径；',
  '· 今日 xx 字：今天的净产出，按增删自动累计（固定「只算汉字」口径，历史增量无法换口径重算）。',
  '右侧三项是可调设置（本机记忆，换章不重置）：',
  '· 铺满 / 限宽：铺满 = 码字区宽度跟随窗口铺满；限宽 = 回到舒适阅读宽度居中显示；',
  '· 打字机：开启后当前输入行始终保持在屏幕中部，眼睛不用一直往下追；',
  '· 字号 −/＋：正文字号 14–28px。',
])

/** 正文字号下限（上游 `useNovelEditorModel.ts`：`>= 14`）。 */
export const EDITOR_FONT_SIZE_MIN = 14

/** 正文字号上限（上游 `useNovelEditorModel.ts`：`<= 28`）。 */
export const EDITOR_FONT_SIZE_MAX = 28

/** 正文字号默认值（上游读不到合法值时回落 17）。 */
export const EDITOR_FONT_SIZE_DEFAULT = 17

/** 字号 ± 的步长（上游 `changeFontSize(-1 | 1)`）。 */
export const EDITOR_FONT_SIZE_STEP = 1

/**
 * 状态栏发出的设置补丁。
 *
 * `Partial<AppSettingsView>` 覆盖已存在的字段（本模块只用 `fontSize`），
 * 另加 `pageWide` / `typewriter` —— 这两个字段**本仓 `AppSettingsView` 里还没有**，
 * 需要 Lead 在 `features/types.ts` 与 `settings-store.ts` 补齐（见报告 ⑦）。
 * 补上之后本类型仍与 `Partial<AppSettingsView>` 结构兼容（多出的可选字段不影响赋值）。
 */
export interface EditorStatusBarPatch extends Partial<AppSettingsView> {
  /** 铺满（true）／限宽（false）。上游 key：`'novel-page-wide'`。 */
  readonly pageWide?: boolean
  /** 打字机模式。上游 key：`'novel-typewriter'`。 */
  readonly typewriter?: boolean
}

/** 字号 ± 的一步结果：当前值 + 两个方向还能不能动。 */
export interface EditorFontStep {
  /** 当前正文字号（px，整数）。 */
  readonly value: number
  /** 还能不能再减（到 14 就停）。 */
  readonly canDecrease: boolean
  /** 还能不能再加（到 28 就停）。 */
  readonly canIncrease: boolean
}

/**
 * 千分位分组（自实现，避免运行环境 ICU 差异影响测试 —— 与 `panels/dashboard-model.ts:172`
 * 的 `formatChars` 同款理由）。
 *
 * 本仓**刻意**与上游状态栏不同：上游 621/624 行直接输出裸数字，本仓按同类面板的既有约定
 * 加千分位（A-13 任务书里的「千分位」一项即指此），偏差已记入交付报告。
 * 非有限值（NaN / ±Infinity）收敛成 `—`，渲染路径永不吐 `NaN`。
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return EDITOR_STATUS_BAR_COPY.unknownValue
  const rounded = Math.round(value)
  const sign = rounded < 0 ? '-' : ''
  const digits = Math.abs(rounded).toString()
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * 本章字数（双口径）。
 *
 * 非字符串输入收敛成 0 字：`countWords` 对非字符串**刻意抛 `TypeError`**（领域层与上游
 * 的隐式行为一致），但状态栏在渲染路径上，不能让「父层没接上正文」把整页带崩（铁律 3）。
 */
export function chapterWordCount(text: string, withPunct: boolean): number {
  if (typeof text !== 'string') return 0
  return countWords(text, wordCountModeOf(withPunct))
}

/** 本章字数的可见文案：`1,234 字`（上游 621 行的数字 + 空格 + `字`）。 */
export function chapterWordsText(text: string, withPunct: boolean): string {
  return `${formatCount(chapterWordCount(text, withPunct))} ${EDITOR_STATUS_BAR_COPY.unit}`
}

/** 本章字数的 title（口径随开关变，说明它现在按哪一档算）。 */
export function chapterWordsTitle(withPunct: boolean): string {
  return withPunct
    ? EDITOR_STATUS_BAR_COPY.chapterTitleWithPunct
    : EDITOR_STATUS_BAR_COPY.chapterTitlePlain
}

/**
 * 今日码字的可见文案：`今日 1,234 字`；读不到数据（`null` / `undefined` / 非有限值）时
 * 是 `今日 — 字` —— **绝不显示 0**（0 与 `—` 是两件事：前者是「今天没写」，后者是「读不到」）。
 *
 * 负数是合法输入（净增量可以被删成负的），照样显示 `今日 -5 字`。
 */
export function todayWordsText(todayChars: number | null | undefined): string {
  const value = normalizeTodayChars(todayChars)
  const shown = value === null ? EDITOR_STATUS_BAR_COPY.unknownValue : formatCount(value)
  return `${EDITOR_STATUS_BAR_COPY.todayLabel} ${shown} ${EDITOR_STATUS_BAR_COPY.unit}`
}

/** 今日码字的 title：有数据用上游原文，没数据说清「为什么没有」。 */
export function todayWordsTitle(todayChars: number | null | undefined): string {
  return normalizeTodayChars(todayChars) === null
    ? EDITOR_STATUS_BAR_COPY.todayUnavailableTitle
    : EDITOR_STATUS_BAR_COPY.todayTitle
}

/** 未知 / 非有限值一律归为「读不到」；其余原样（含负数、0）。 */
function normalizeTodayChars(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

/** 铺满/限宽按钮的可见词（上游 636 行 `pageWide ? '铺满' : '限宽'`）。 */
export function pageWideButtonLabel(pageWide: boolean): string {
  return pageWide ? EDITOR_STATUS_BAR_COPY.pageWideLabel : EDITOR_STATUS_BAR_COPY.narrowLabel
}

/** 铺满/限宽按钮的 title（上游 634 行三元）。 */
export function pageWideButtonTitle(pageWide: boolean): string {
  return pageWide ? EDITOR_STATUS_BAR_COPY.pageWideTitle : EDITOR_STATUS_BAR_COPY.narrowTitle
}

/**
 * 字号字符串 → px 整数。
 *
 * 兼容两种存量形态：本仓 `AppSettingsView.fontSize` 是 `'16px'`（`settings-store.ts` 的
 * `normalizeFontSize` 产物），上游 localStorage 里是裸数字 `'16'`。
 * 认不出来的（`null` / `''` / `'abc'` / `'0px'`）回落上游默认 17 —— 不抛，状态栏不能因为
 * 一条脏设置白屏。
 *
 * 注意：这里**不钳制范围**。存量值 12px / 32px（只有手改存储才可能出现，本仓 UI 两条路径
 * 都到不了）原样返回，避免「显示字号 ≠ 实际字号」；钳制只发生在 `stepEditorFontSize`。
 */
export function parseEditorFontSize(fontSize: string | null | undefined): number {
  if (typeof fontSize !== 'string') return EDITOR_FONT_SIZE_DEFAULT
  const matched = /^(\d+(?:\.\d+)?)px?$/.exec(fontSize.trim())
  if (matched === null) return EDITOR_FONT_SIZE_DEFAULT
  const raw = matched[1]
  if (raw === undefined) return EDITOR_FONT_SIZE_DEFAULT
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return EDITOR_FONT_SIZE_DEFAULT
  return Math.round(value)
}

/** px → 14–28 之间的整数（上游 `Math.max(14, Math.min(28, fontSize + delta))`）。 */
export function clampEditorFontSize(px: number): number {
  if (!Number.isFinite(px)) return EDITOR_FONT_SIZE_DEFAULT
  return Math.max(EDITOR_FONT_SIZE_MIN, Math.min(EDITOR_FONT_SIZE_MAX, Math.round(px)))
}

/** 字号 ± 一步：结果恒在 14–28 内（越界不越出，点到最后一步就是不动）。 */
export function stepEditorFontSize(fontSize: string | null | undefined, delta: number): number {
  const safeDelta = Number.isFinite(delta) ? delta : 0
  return clampEditorFontSize(parseEditorFontSize(fontSize) + safeDelta)
}

/** 字号 ± 的一步结果，供两个按钮的 `:disabled` 用（到边界就禁用，不是点了没反应）。 */
export function editorFontStep(fontSize: string | null | undefined): EditorFontStep {
  const value = parseEditorFontSize(fontSize)
  return Object.freeze({
    value,
    canDecrease: value > EDITOR_FONT_SIZE_MIN,
    canIncrease: value < EDITOR_FONT_SIZE_MAX,
  })
}

/** 字号读数的可见文案：上游 653 行只显示数字（`w-6 text-center` 里是 `{fontSize}`）。 */
export function fontSizeValueText(px: number): string {
  return String(px)
}

/** 字号读数的 title（上游没有，补齐无障碍与鼠标悬停的解释）。 */
export function fontSizeValueTitle(px: number): string {
  return `${EDITOR_STATUS_BAR_COPY.fontGroupLabel} ${px}px`
}

/** 铺满/限宽补丁（父层写回 `AppSettingsView.pageWide`）。 */
export function buildPageWidePatch(pageWide: boolean): EditorStatusBarPatch {
  return { pageWide }
}

/** 打字机补丁（父层写回 `AppSettingsView.typewriter`）。 */
export function buildTypewriterPatch(typewriter: boolean): EditorStatusBarPatch {
  return { typewriter }
}

/** 字号补丁（父层写回 `AppSettingsView.fontSize`，值形态与 `settings-store.ts` 一致：`'17px'`）。 */
export function buildFontSizePatch(px: number): EditorStatusBarPatch {
  return { fontSize: `${clampEditorFontSize(px)}px` }
}