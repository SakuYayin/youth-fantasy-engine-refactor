/**
 * 面板：检查工具（check-tools）—— 纯逻辑层（无框架依赖、无 node:* 导入、预览版不调 AI）。
 *
 * 职责：对粘贴/输入的正文做本地规则检查，产出结构化问题列表（CheckIssue）与汇总（CheckSummary）。
 * 纪律：本文件是纯函数模块，不订阅 state、不做持久化；所有面向用户的文案常量集中在此导出，
 *       视图层（check-tools.vue）只消费这些常量，保证「可见文本 ⊆ 常量」。
 *
 * 口径说明：
 * - 字符数按 Unicode 码点计（Array.from(text).length），包含换行与空白字符。
 *   编辑页正文的字数统计使用字素簇口径（@yfe/domain 的 countChars），两者对组合字符/emoji
 *   可能略有差异；本面板无法依赖该包（面板层依赖清单不含 @yfe/domain），如实注明。
 * - 行：按 \r\n | \n | \r 切分；文本末尾若以换行结束，切分产生的末尾空串不算一行。
 * - 空行：trim() 后为空的行（全角空格 U+3000 亦被 trim 掉）。
 * - 段：连续非空行构成一段；段索引与行号均为 1-based（行号跨全文）。
 */

/** 问题严重度：warn=文字层错病（黄），info=统计与排版建议（灰）。 */
export type CheckSeverity = 'warn' | 'info';

/** 单条检查问题。id 为确定性标识（同一文本重复检查结果一致），供视图层做 key。 */
export interface CheckIssue {
  readonly id: string;
  readonly severity: CheckSeverity;
  readonly title: string;
  readonly detail: string;
}

/** 检查结果汇总：总数与分严重度计数。 */
export interface CheckSummary {
  readonly total: number;
  readonly warn: number;
  readonly info: number;
}

/* ==========================================================================
 * 文案常量（视图层可见文本的唯一来源）
 * ========================================================================== */

/** 规则标题。 */
export const WORD_COUNT_TITLE = '字数统计';
export const MIXED_WIDTH_TITLE = '全角与半角标点混用';
export const REPEAT_PUNCT_TITLE = '连续重复标点';
export const REPEAT_WORD_TITLE = '连续重复词';
export const LONG_PARAGRAPH_TITLE = '段落过长';
export const TRAILING_SPACE_TITLE = '行尾空白字符';
export const BLANK_LINES_TITLE = '连续空行';

/** 严重度显示名。 */
export const SEVERITY_LABEL: Readonly<Record<CheckSeverity, string>> = {
  warn: '警告',
  info: '提示',
};

/** 阈值常量。 */
export const LONG_PARAGRAPH_CHARS = 800;
export const MIN_REPEAT_PUNCT = 3;
export const MIN_BLANK_LINES = 3;

/** 视图结构与按钮文案。 */
export const PANEL_INPUT_TITLE = '正文输入';
export const PANEL_RESULT_TITLE = '检查结果';
export const BUTTON_RUN = '开始检查';
export const BUTTON_CLEAR = '清空';
export const TEXTAREA_PLACEHOLDER = '把正文粘贴到这里，或直接输入…';
export const INITIAL_HINT = '在上方粘贴或输入正文，点击「开始检查」。';
export const EMPTY_RESULT_LABEL = '未发现问题';

/** 预览版能力边界说明（如实展示，不夸大）。 */
export const DISCLAIMER =
  '预览版仅提供正文检查：全部规则在本地运行，不调用 AI；敏感词检测与 AI 一致性深度自查暂未接入。';

/** 持久化边界说明（预览版不保存检查输入，无历史记录）。 */
export const NO_PERSIST_NOTE = '检查输入只保留在当前页面，不会被保存或上传，也没有历史记录。';

/* ==========================================================================
 * 内部工具
 * ========================================================================== */

/** 按统一换行符切行；末尾元素为空串时丢弃（行尾换行不产生额外空行）。 */
export function splitLines(text: string): readonly string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

interface TextStats {
  readonly charCount: number;
  readonly paragraphCount: number;
}

interface Paragraph {
  /** 1-based 段索引。 */
  readonly index: number;
  /** 1-based 起始行号（含）。 */
  readonly startLine: number;
  /** 1-based 结束行号（含）。 */
  readonly endLine: number;
  /** 段内各行以 \n 连接（供字符统计与混用检查）。 */
  readonly text: string;
}

/** 字符数（Unicode 码点，含换行与空白）。 */
function countCodePoints(text: string): number {
  return Array.from(text).length;
}

function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

/** 统计全文：字符数与段落数（段=连续非空行）。 */
export function getTextStats(text: string): TextStats {
  const lines = splitLines(text);
  let paragraphCount = 0;
  let prevBlank = true;
  for (const line of lines) {
    const blank = isBlankLine(line);
    if (!blank && prevBlank) {
      paragraphCount += 1;
    }
    prevBlank = blank;
  }
  return { charCount: countCodePoints(text), paragraphCount };
}

/** 把行列表聚合为段落（连续非空行）。 */
function collectParagraphs(lines: readonly string[]): readonly Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let current: string[] = [];
  let currentStart = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (isBlankLine(lines[i]!)) {
      if (current.length > 0) {
        paragraphs.push({
          index: paragraphs.length + 1,
          startLine: currentStart + 1,
          endLine: i,
          text: current.join('\n'),
        });
        current = [];
      }
    } else {
      if (current.length === 0) {
        currentStart = i;
      }
      current.push(lines[i]!);
    }
  }
  if (current.length > 0) {
    paragraphs.push({
      index: paragraphs.length + 1,
      startLine: currentStart + 1,
      endLine: lines.length,
      text: current.join('\n'),
    });
  }
  return paragraphs;
}

/** 千分位格式化（用于字符数展示）。 */
export function formatCharCount(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* ==========================================================================
 * 规则一：字数统计（info）
 * ========================================================================== */

/**
 * 字数统计问题：报告全文字符数与段落数。
 * 仅当文本存在至少一个段落（非纯空白）时产出；字符数含换行与空白字符。
 */
function checkWordCount(text: string, paragraphs: readonly Paragraph[]): CheckIssue | null {
  if (paragraphs.length === 0) {
    return null;
  }
  return {
    id: 'word-count',
    severity: 'info',
    title: WORD_COUNT_TITLE,
    detail: `全文共 ${formatCharCount(countCodePoints(text))} 字符、${paragraphs.length} 个段落`,
  };
}

/* ==========================================================================
 * 规则二：全角/半角标点混用（warn，按段检查）
 * ========================================================================== */

interface WidthClass {
  readonly key: string;
  readonly label: string;
  readonly fullExample: string;
  readonly halfExample: string;
  readonly fullChars: readonly string[];
  readonly halfChars: readonly string[];
}

/** 同类标点的全角/半角两种形态；一类的任一全角字符与任一半角字符同段出现即视为混用。 */
const WIDTH_CLASSES: readonly WidthClass[] = [
  { key: 'period', label: '句号', fullExample: '。', halfExample: '.', fullChars: ['。'], halfChars: ['.'] },
  { key: 'comma', label: '逗号', fullExample: '，', halfExample: ',', fullChars: ['，'], halfChars: [','] },
  { key: 'question', label: '问号', fullExample: '？', halfExample: '?', fullChars: ['？'], halfChars: ['?'] },
  { key: 'exclamation', label: '叹号', fullExample: '！', halfExample: '!', fullChars: ['！'], halfChars: ['!'] },
  { key: 'colon', label: '冒号', fullExample: '：', halfExample: ':', fullChars: ['：'], halfChars: [':'] },
  { key: 'semicolon', label: '分号', fullExample: '；', halfExample: ';', fullChars: ['；'], halfChars: [';'] },
  { key: 'paren', label: '括号', fullExample: '（）', halfExample: '()', fullChars: ['（', '）'], halfChars: ['(', ')'] },
  { key: 'quote', label: '引号', fullExample: '“”‘’', halfExample: '"\'', fullChars: ['“', '”', '‘', '’'], halfChars: ['"', '\''] },
];

function checkMixedWidth(paragraphs: readonly Paragraph[]): readonly CheckIssue[] {
  const issues: CheckIssue[] = [];
  for (const paragraph of paragraphs) {
    for (const widthClass of WIDTH_CLASSES) {
      const hasFull = widthClass.fullChars.some((char) => paragraph.text.includes(char));
      const hasHalf = widthClass.halfChars.some((char) => paragraph.text.includes(char));
      if (hasFull && hasHalf) {
        issues.push({
          id: `mixed-p${paragraph.index}-${widthClass.key}`,
          severity: 'warn',
          title: MIXED_WIDTH_TITLE,
          detail: `第 ${paragraph.index} 段同时出现全角与半角${widthClass.label}（${widthClass.fullExample} 与 ${widthClass.halfExample}）`,
        });
      }
    }
  }
  return issues;
}

/* ==========================================================================
 * 规则三：连续重复标点（warn，按行检查）
 * ========================================================================== */

/**
 * 参与重复标点检查的标点集合。刻意排除省略号（…）与破折号（—）：
 * 中文省略号「……」与破折号「——」本身就是两字符以上的规范用法（网文场景分隔线亦常用长破折号），
 * 纳入检查会产生大量误报。
 */
const PUNCT_SOURCE = '。，、；：？！～~.,;:!?()（）「」『』《》〈〉【】〔〕“”‘’"\'／\\｜|';
const PUNCT_CHARS: ReadonlySet<string> = new Set(Array.from(PUNCT_SOURCE));

function checkRepeatPunctuation(lines: readonly string[]): readonly CheckIssue[] {
  const issues: CheckIssue[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    let i = 0;
    while (i < line.length) {
      const char = line[i]!;
      if (!PUNCT_CHARS.has(char)) {
        i += 1;
        continue;
      }
      let runEnd = i;
      while (runEnd < line.length && line[runEnd] === char) {
        runEnd += 1;
      }
      const runLength = runEnd - i;
      if (runLength >= MIN_REPEAT_PUNCT) {
        const run = line.slice(i, runEnd);
        const excerpt = run.slice(0, 6) + (run.length > 6 ? '…' : '');
        issues.push({
          id: `repeat-punct-${issues.length + 1}`,
          severity: 'warn',
          title: REPEAT_PUNCT_TITLE,
          detail: `第 ${lineIndex + 1} 行连续出现 ${runLength} 个「${excerpt}」`,
        });
      }
      i = runEnd;
    }
  }
  return issues;
}

/* ==========================================================================
 * 规则四：连续重复词（warn，按行检查）
 * ========================================================================== */

/**
 * 参与重复词检查时要求单元不含空白与标点。
 * 注意此处使用比重复标点更全的字符集：重复词的「词」单元里出现任何标点（含 … — ·）都应视为非词。
 */
const WORD_EXCLUDE_SOURCE = PUNCT_SOURCE + '…—·';
const WORD_EXCLUDE_CHARS: ReadonlySet<string> = new Set(Array.from(WORD_EXCLUDE_SOURCE));

/** 单元必须含 CJK 统一表意文字（\u4e00-\u9fff）：预览版面向中文正文，英文重复（如 the the）不在范围。 */
function containsCJK(unit: string): boolean {
  return /[\u4e00-\u9fff]/.test(unit);
}

function isWordUnit(unit: string): boolean {
  for (const char of unit) {
    if (/\s/.test(char) || WORD_EXCLUDE_CHARS.has(char)) {
      return false;
    }
  }
  return unit.length > 0;
}

/**
 * 语气/拟声叠词白名单：相邻重复单元命中白名单时不报（避免把「哈哈哈哈」「嗯嗯」当语病）。
 */
const LEGIT_REPEAT_UNITS_SOURCE =
  '哈哈 嘿嘿 嘻嘻 呵呵 嗯嗯 哦哦 呜呜 咯咯 哗哗 轰轰 隆隆 呼呼 咚咚 滴滴 叮叮 汪汪 喵喵 嗖嗖 咻咻 噗噗 沙沙 吱吱 嗷嗷 哼哼';
const LEGIT_REPEAT_UNITS: ReadonlySet<string> = new Set(LEGIT_REPEAT_UNITS_SOURCE.split(' '));

/**
 * 单字重复检查白名单外的封闭集合（虚词/代词）：只有这些字相邻重复才按语病报告。
 * 「看看/慢慢」等动词/形容词叠词、「是是是/对对」等应答、「一一对应」均不在集合内，避免误报。
 */
const SINGLE_REPEATABLE_SOURCE = '的地得了你我他她它在和就都很被把才还又着';
const SINGLE_REPEATABLE: ReadonlySet<string> = new Set(Array.from(SINGLE_REPEATABLE_SOURCE));

function checkRepeatWords(lines: readonly string[]): readonly CheckIssue[] {
  const issues: CheckIssue[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    let i = 0;
    while (i < line.length) {
      let matched = false;
      // 多字单元：优先尝试最长（4/3/2 字）的相邻完全重复。
      for (const unitLength of [4, 3, 2]) {
        const unit = line.slice(i, i + unitLength);
        const next = line.slice(i + unitLength, i + unitLength * 2);
        if (
          unit.length === unitLength &&
          next === unit &&
          isWordUnit(unit) &&
          containsCJK(unit) &&
          !LEGIT_REPEAT_UNITS.has(unit)
        ) {
          issues.push({
            id: `repeat-word-${issues.length + 1}`,
            severity: 'warn',
            title: REPEAT_WORD_TITLE,
            detail: `第 ${lineIndex + 1} 行出现连续重复词「${unit}${unit}」`,
          });
          i += unitLength * 2;
          matched = true;
          break;
        }
      }
      if (matched) {
        continue;
      }
      // 单字单元：仅封闭集合内的虚词/代词按语病报告。
      const char = line[i]!;
      const nextChar = i + 1 < line.length ? line[i + 1]! : '';
      if (nextChar !== '' && char === nextChar && SINGLE_REPEATABLE.has(char)) {
        issues.push({
          id: `repeat-word-${issues.length + 1}`,
          severity: 'warn',
          title: REPEAT_WORD_TITLE,
          detail: `第 ${lineIndex + 1} 行出现连续重复词「${char}${char}」`,
        });
        i += 2;
        continue;
      }
      i += 1;
    }
  }
  return issues;
}

/* ==========================================================================
 * 规则五：段落过长（info）
 * ========================================================================== */

function checkLongParagraphs(paragraphs: readonly Paragraph[]): readonly CheckIssue[] {
  const issues: CheckIssue[] = [];
  for (const paragraph of paragraphs) {
    const charCount = countCodePoints(paragraph.text);
    if (charCount > LONG_PARAGRAPH_CHARS) {
      issues.push({
        id: `long-p${paragraph.index}`,
        severity: 'info',
        title: LONG_PARAGRAPH_TITLE,
        detail: `第 ${paragraph.index} 段共 ${formatCharCount(charCount)} 字符，超过 ${LONG_PARAGRAPH_CHARS} 字，建议拆段`,
      });
    }
  }
  return issues;
}

/* ==========================================================================
 * 规则六：行尾空白字符（info）
 * ========================================================================== */

function checkTrailingSpaces(lines: readonly string[]): readonly CheckIssue[] {
  const issues: CheckIssue[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const trimmed = line.trimEnd();
    // 纯空白行不报（交给空行规则），只有「有内容且行尾带空白」才提示。
    if (trimmed.length > 0 && trimmed.length < line.length) {
      issues.push({
        id: `trailing-l${lineIndex + 1}`,
        severity: 'info',
        title: TRAILING_SPACE_TITLE,
        detail: `第 ${lineIndex + 1} 行行尾有 ${line.length - trimmed.length} 个空白字符`,
      });
    }
  }
  return issues;
}

/* ==========================================================================
 * 规则七：连续空行 ≥ 3（info）
 * ========================================================================== */

function checkBlankLineRuns(lines: readonly string[]): readonly CheckIssue[] {
  const issues: CheckIssue[] = [];
  let runStart = -1;
  for (let i = 0; i <= lines.length; i += 1) {
    const blank = i < lines.length && isBlankLine(lines[i]!);
    if (blank && runStart < 0) {
      runStart = i;
    }
    if (!blank && runStart >= 0) {
      const runLength = i - runStart;
      if (runLength >= MIN_BLANK_LINES) {
        issues.push({
          id: `blank-l${runStart + 1}`,
          severity: 'info',
          title: BLANK_LINES_TITLE,
          detail: `第 ${runStart + 1}–${i} 行连续空行 ${runLength} 行，建议精简`,
        });
      }
      runStart = -1;
    }
  }
  return issues;
}

/* ==========================================================================
 * 总入口
 * ========================================================================== */

/**
 * 对正文执行全部本地检查规则，返回问题列表。
 * 顺序固定：字数统计 → 全角/半角混用 → 连续重复标点 → 连续重复词 → 段落过长 → 行尾空白 → 连续空行；
 * 同一文本多次调用结果完全一致（id 确定性、无随机、无时间因子）。
 * 纯空白文本返回空数组（界面显示「未发现问题」）；但含 ≥3 连空行的纯空白文本仍会报空行问题。
 */
export function checkText(text: string): readonly CheckIssue[] {
  const lines = splitLines(text);
  const paragraphs = collectParagraphs(lines);
  const issues: CheckIssue[] = [];

  const wordCount = checkWordCount(text, paragraphs);
  if (wordCount !== null) {
    issues.push(wordCount);
  }
  issues.push(...checkMixedWidth(paragraphs));
  issues.push(...checkRepeatPunctuation(lines));
  issues.push(...checkRepeatWords(lines));
  issues.push(...checkLongParagraphs(paragraphs));
  issues.push(...checkTrailingSpaces(lines));
  issues.push(...checkBlankLineRuns(lines));
  return issues;
}

/* ==========================================================================
 * 汇总与格式化
 * ========================================================================== */

/** 按严重度计数汇总。 */
export function buildCheckSummary(issues: readonly CheckIssue[]): CheckSummary {
  let warn = 0;
  let info = 0;
  for (const issue of issues) {
    if (issue.severity === 'warn') {
      warn += 1;
    } else {
      info += 1;
    }
  }
  return { total: issues.length, warn, info };
}

/** 顶部汇总文案，如「共 5 个问题（警告 3、提示 2）」。 */
export function formatIssueSummary(total: number, warn: number, info: number): string {
  return `共 ${total} 个问题（警告 ${warn}、提示 ${info}）`;
}

/** 分组标题文案，如「警告（3）」。 */
export function formatSeverityHeader(severity: CheckSeverity, count: number): string {
  return `${SEVERITY_LABEL[severity]}（${count}）`;
}
