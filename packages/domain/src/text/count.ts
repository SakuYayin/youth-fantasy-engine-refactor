/**
 * 中英混排字数统计（**双口径**）—— B-13 还原项。
 *
 * ## 真源纪律
 * - 口径真源＝`_upstream_tmp/youth-fantasy-engine-main/src/lib/editor/textStats.ts`（全文 35 行）：
 *   `WordCountMode`（第 16 行）、`countWords`（第 29–35 行），以及 `CJK_RE`/`PUNCT_RE`（第 19/26 行）。
 * - 模式偏好真源＝同一上游仓库 `src/lib/editor/wordCountMode.ts`：
 *   `wordCountModeOf`（第 36–38 行）、key 字面量 `'word-count-with-punct'`（第 25 行）。
 * - 本文件是**副本**（领域层无 IO：不读 localStorage）。改口径必须**双向同步**上游 ↔ 本文件 ↔
 *   `packages/domain/tests/text/count.test.ts`（那份 oracle 逐字抄自上游）。
 *
 * ## 两种口径（与上游逐字一致）
 * - `'cjk'`（默认）：汉字逐字 ＋ 拉丁/数字按词。**所有逻辑判断必须用这一档**
 *   （上游注释第 10 行：「默认值，也是所有逻辑判断必须用的口径」）。标点**不计**。
 * - `'cjk-punct'`：汉字 ＋ 中文标点 ＋ 拉丁/数字词。**网文平台的计费口径，仅供展示**
 *   （上游注释第 11 行）。落库/校验若跟着用户的显示偏好漂移，属于行为退化
 *   （上游注释第 12–14 行：「写够 3000 字」这类硬约束会随开关漂移）。
 *
 * ## 举例（上游注释与上游测试钉住的口径）
 * `'第 1 章'` = 3（汉字 2 ＋ 数字词 1）；`'2026'` = 1（数字串算**一个词**，不是 4 个字）；
 * `'世界'` = 2；`'hello 世界！'` = 3（`cjk`）／4（`cjk-punct`，`！` 计 1）。
 *
 * ## 与现版 `countChars` 的关系（**并存，不要互相替代**）
 * `countChars`（`packages/domain/src/text/index.ts:234`）是**字素簇**口径：
 * emoji 记 1、组合字符记 1、换行按 UAX #29 切 —— 用于「正文长度」这类技术性统计。
 * `countWords` 是**上游业务口径**：汉字逐字、拉丁词、标点可选 —— 用于「本章字数」
 * 这类给作者看、与平台对得上的数字。两者数值**本来就不相等**，见交付报告第 6 节。
 */

import { isAsciiWordCodeUnit, isCjkCodeUnit, isCjkPunctCodeUnit } from './cjk.js'

/**
 * 字数口径。与上游 `textStats.ts:16` 逐字同名同义（上游原样：`'cjk' | 'cjk-punct'`）。
 */
export type WordCountMode = 'cjk' | 'cjk-punct'

/** 默认口径：与上游 `countWords(text, mode = 'cjk')` 的默认参数一致。 */
export const WORD_COUNT_MODE_DEFAULT: WordCountMode = 'cjk'

/**
 * 口径偏好的存储 key（localStorage）。
 *
 * 🔴 **本仓补充口径**：上游把这个字面量放在 `wordCountMode.ts:25`，并明确解释
 * 「偏好被 Dashboard 与编辑器两处读，各写一份 key 字符串必然漂移」（上游第 8–10 行）。
 * 领域层不碰 localStorage，因此这里**只提供字符串常量**，由 UI/持久层读取；
 * 目的同样是「全仓只有一份 key」。
 */
export const WORD_COUNT_WITH_PUNCT_STORAGE_KEY = 'word-count-with-punct'

/** 字数分解。各项恒为**实测值**（不随 `mode` 变化），只有 `total` 随 `mode` 变。 */
export interface WordCountBreakdown {
  /** 该口径下的最终字数，与 `countWords(text, mode)` 恒等。 */
  readonly total: number
  /** 汉字（上游 `CJK_RE` 命中数）：U+4E00–9FFF ＋ U+3400–4DBF，逐字计。 */
  readonly cjk: number
  /** 拉丁字母/数字的**词**数：连续 `[a-zA-Z0-9]` 算一个词。 */
  readonly latinWords: number
  /** 中文标点个数（上游 `PUNCT_RE` 命中数）。**两种 mode 下都是实测值**，便于诊断。 */
  readonly punctuation: number
}

function assertStringInput(value: unknown, fn: string): asserts value is string {
  if (typeof value !== 'string') {
    // 🔴 上游对非字符串是**隐式抛 `TypeError`**（`null.match` / `(1).match` 都不是函数），
    //    本仓保持「抛 TypeError」这一行为，文案与 `text/index.ts:643` 的 `assertString` 对齐。
    throw new TypeError(`${fn} 需要字符串，收到 ${value === null ? 'null' : typeof value}`)
  }
}

/**
 * 单次遍历统计（内部实现，`countWords` 与 `countWordsBreakdown` 共用，避免两处口径漂移）。
 *
 * 为什么不用上游那三次正则扫描：
 * - 上游 `text.match(CJK_RE)` + `text.replace(CJK_RE,' ')` + `.match(/[a-zA-Z0-9]+/g)`
 *   在最坏情况下要分配整段副本（大正文几十万字 × 每次输入都重算）。这里一次遍历、
 *   零中间字符串，1e6 字符量级无压力。
 * - **等价性**：上游三个正则都不带 `u` 标志，只可能匹配 BMP 区段与 ASCII；
 *   代理对的 code unit（0xD800–0xDFFF）不落在任何区段里 ⇒ 按 code unit 遍历与上游**逐值相等**。
 *   该等价性由 `count.test.ts` 的「穷举全部 BMP 码位」用例钉住（27587 / 27699）。
 */
function scanWords(text: string, mode: WordCountMode): WordCountBreakdown {
  let cjk = 0
  let latinWords = 0
  let punctuation = 0
  let inLatinRun = false

  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i)

    if (isAsciiWordCodeUnit(unit)) {
      if (!inLatinRun) {
        latinWords += 1
        inLatinRun = true
      }
      continue
    }

    // 上游把汉字 replace 成空格，等价于「汉字切断拉丁词」；而汉字本身就不是 [a-zA-Z0-9]，
    // 所以「任何非词字符都切断词」与上游完全等价。
    inLatinRun = false
    if (isCjkCodeUnit(unit)) cjk += 1
    else if (isCjkPunctCodeUnit(unit)) punctuation += 1
  }

  // 🔴 口径兜底与上游一致：上游写的是 `if (mode === 'cjk') return cjk + words`，
  //    也就是说**任何非 `'cjk'` 的值都按 `cjk-punct` 处理**（含脏字符串）。
  //    需要严格校验调用方请先用 `isWordCountMode`。这里刻意不复刻成「非法即默认」，
  //    以免与上游行为分叉。
  const withPunct = mode !== 'cjk'
  return {
    cjk,
    latinWords,
    punctuation,
    total: cjk + latinWords + (withPunct ? punctuation : 0),
  }
}

/**
 * 字数统计（上游 `textStats.ts:29` 的逐字同名副本）。
 *
 * @param text 正文字符串。非字符串抛 `TypeError`（与上游的隐式 TypeError 行为一致）。
 * @param mode `'cjk'`（默认，逻辑口径：汉字逐字 ＋ 拉丁/数字词，标点不计）或
 *             `'cjk-punct'`（展示口径：再加中文标点）。**落库与一切硬约束请用默认档。**
 * @returns 该口径下的字数。空串恒为 `0`（上游 `tests/adversarial.test.ts:87` 钉住）。
 */
export function countWords(text: string, mode: WordCountMode = WORD_COUNT_MODE_DEFAULT): number {
  assertStringInput(text, 'countWords')
  return scanWords(text, mode).total
}

/**
 * 字数分解：汉字 / 拉丁数字词 / 中文标点分别有多少，并给出该口径下的 `total`。
 *
 * 与 `countCharsBreakdown`（`text/index.ts:285`）同日而语但**口径完全不同**：
 * 那个按字素簇分类，这个按上游字数口径分类。
 *
 * 🔴 **本仓补充口径**（上游没有导出分解函数，只导出 `countWords`）：
 * 它存在的理由是「状态栏要能自证数字怎么来的」，且**不引入任何新口径** ——
 * `total` 恒等于 `countWords(text, mode)`，由测试钉死。
 *
 * @returns `punctuation` 是**实测值**，两种 mode 都填 —— 便于展示层解释
 *          「切到平台口径会多出多少字」。
 */
export function countWordsBreakdown(
  text: string,
  mode: WordCountMode = WORD_COUNT_MODE_DEFAULT,
): WordCountBreakdown {
  assertStringInput(text, 'countWordsBreakdown')
  return scanWords(text, mode)
}

/**
 * 布尔偏好 → 口径。（上游 `wordCountMode.ts:36` 的逐字同名副本。）
 *
 * 🔴 语义界限（照抄上游的用法）：**只用于显示层**。上游注释（第 5–7 行）写得很硬：
 * 落库 `wordCount`、`enforceWordRange` 的 ±300、AI 输出阈值**一律走默认口径**，
 * 含标点只在显示层实时重算 —— 这样开关随时可逆、历史数据不会被打脏。
 *
 * @param withPunct `false`＝只算汉字（默认/老口径）；`true`＝汉字＋标点（平台计费口径）。
 *                  上游用真值判断，非布尔输入原样透传（不抛）。
 */
export function wordCountModeOf(withPunct: boolean): WordCountMode {
  return withPunct ? 'cjk-punct' : 'cjk'
}

/**
 * 运行时校验一个未知值是不是合法口径（IPC / localStorage / 配置读回来的字符串）。
 *
 * 🔴 **本仓补充口径**：上游没有这个守卫，它的 `countWords` 对非法 mode 静默按
 * `cjk-punct` 处理（见 `scanWords` 注释）。本函数只做「要不要信任这个值」的判断，
 * **不改变 `countWords` 的兜底行为**，因此不会与上游分叉。
 */
export function isWordCountMode(value: unknown): value is WordCountMode {
  return value === 'cjk' || value === 'cjk-punct'
}