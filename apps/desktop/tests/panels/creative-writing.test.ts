/**
 * creative-writing-model（纯逻辑）单元测试：node 环境，不需要 DOM。
 *
 * 覆盖：模式常量、请求拼装（system 按模式切换 / maxTokens 默认 / 会话参数）、
 * 超长截断（绝不静默）、结果解析（失败显原文）、会话参数解析、章节来源过滤、保存状态。
 */

import { describe, expect, it } from 'vitest'

import type { DocumentSummary } from '@yfe/contracts'

import type { AppSnapshot } from '../../src/renderer/app-state.js'
import {
  CONTINUE_MAX_TOKENS,
  DEFAULT_WRITING_VALUES,
  MAX_SOURCE_CHARS,
  TEMPERATURE_MAX,
  WRITING_COPY,
  buildWritingRequest,
  isWritingModeId,
  panelSaveStatus,
  parseOptionalNumber,
  parseWritingResult,
  readChapters,
  resolveSessionParams,
  resultCharsLine,
  truncateSource,
  writingModeById,
  writingModes,
} from '../../src/renderer/panels/creative-writing-model.js'

/** readChapters 只读 projectId 与 documents：结构桩即可。 */
function snapshotOf(
  documents: readonly DocumentSummary[],
  projectId: string | null,
): AppSnapshot {
  return { projectId, documents } as unknown as AppSnapshot
}

/** readChapters 只读 kind/deleted/projectId：结构桩即可。 */
function doc(input: {
  id: string
  kind?: DocumentSummary['kind']
  deleted?: number
  projectId?: string
}): DocumentSummary {
  return {
    id: input.id,
    projectId: input.projectId ?? 'prj_1',
    kind: input.kind ?? 'chapter',
    deleted: input.deleted ?? 0,
  } as unknown as DocumentSummary
}

describe('creative-writing 常量', () => {
  it('来源上限 30000、续写 maxTokens 4096、温度上限 2', () => {
    expect(MAX_SOURCE_CHARS).toBe(30000)
    expect(CONTINUE_MAX_TOKENS).toBe(4096)
    expect(TEMPERATURE_MAX).toBe(2)
  })

  it('持久化默认值：mode=continue，其余为空串', () => {
    expect(DEFAULT_WRITING_VALUES).toEqual({
      mode: 'continue',
      instruction: '',
      temperature: '',
      maxTokens: '',
    })
  })
})

describe('writingModes（模式常量）', () => {
  it('三种模式：id 与 label 各不相同', () => {
    expect(writingModes.map((mode) => mode.id)).toEqual(['continue', 'rewrite', 'polish'])
    expect(writingModes.map((mode) => mode.label)).toEqual(['续写', '改写', '润色'])
    expect(new Set(writingModes.map((mode) => mode.system)).size).toBe(3)
  })

  it('isWritingModeId 守卫与未知 id 回退到续写', () => {
    expect(isWritingModeId('continue')).toBe(true)
    expect(isWritingModeId('rewrite')).toBe(true)
    expect(isWritingModeId('polish')).toBe(true)
    expect(isWritingModeId('summary')).toBe(false)
    expect(writingModeById('summary').id).toBe('continue')
    expect(writingModeById('rewrite').id).toBe('rewrite')
  })
})

describe('buildWritingRequest（请求拼装）', () => {
  it('续写：system 按模式切换，maxTokens 默认 4096，不传 temperature', () => {
    const built = buildWritingRequest('continue', '林晚推开门。', '打斗写细一点', {})
    const continueMode = writingModeById('continue')

    expect(built.request.system).toBe(continueMode.system)
    expect(built.usedMaxTokens).toBe(4096)
    expect(built.request.maxTokens).toBe(4096)
    expect('temperature' in built.request).toBe(false)
    expect(built.truncated).toBe(false)
    expect(built.sourceChars).toBe(6)

    const message = built.request.messages[0]
    expect(message?.role).toBe('user')
    expect(message?.content).toContain('【正文】\n林晚推开门。')
    expect(message?.content).toContain('【写作要求】\n打斗写细一点')
    expect(message?.content).toContain(continueMode.closing)
  })

  it('改写与润色：默认不传 maxTokens，system 各不相同且写明约束', () => {
    const rewrite = buildWritingRequest('rewrite', '原文', '', {})
    const polish = buildWritingRequest('polish', '原文', '', {})

    expect(rewrite.usedMaxTokens).toBeNull()
    expect('maxTokens' in rewrite.request).toBe(false)
    expect(polish.usedMaxTokens).toBeNull()
    expect('maxTokens' in polish.request).toBe(false)

    const rewriteMode = writingModeById('rewrite')
    const polishMode = writingModeById('polish')
    expect(rewrite.request.system).toBe(rewriteMode.system)
    expect(polish.request.system).toBe(polishMode.system)
    expect(rewrite.request.system).not.toBe(polish.request.system)
    expect(rewrite.request.system).toContain('保持原意')
    expect(polish.request.system).toContain('只修正')
    expect(polish.request.system).toContain('不改动情节')
  })

  it('空写要求不产生【写作要求】段', () => {
    const built = buildWritingRequest('continue', '原文', '   ', {})
    const message = built.request.messages[0]

    expect(message?.content).not.toContain('【写作要求】')
    expect(message?.content).toContain('【正文】\n原文')
    expect(message?.content).toContain(writingModeById('continue').closing)
  })

  it('会话参数显式给出时优先，并可覆盖续写默认', () => {
    const withParams = buildWritingRequest('continue', '原文', '', {
      temperature: 0.7,
      maxTokens: 2048,
    })
    expect(withParams.request.temperature).toBe(0.7)
    expect(withParams.request.maxTokens).toBe(2048)
    expect(withParams.usedMaxTokens).toBe(2048)

    const polish = buildWritingRequest('polish', '原文', '', { temperature: 0.2 })
    expect(polish.request.temperature).toBe(0.2)
    expect('maxTokens' in polish.request).toBe(false)
  })
})

describe('超长截断（绝不静默）', () => {
  it('truncateSource：短文本与恰好上限不截断，超长截取开头', () => {
    expect(truncateSource('abc')).toEqual({ text: 'abc', truncated: false })

    const exact = 'a'.repeat(MAX_SOURCE_CHARS)
    expect(truncateSource(exact)).toEqual({ text: exact, truncated: false })

    const over = truncateSource(`${exact}b`)
    expect(over.truncated).toBe(true)
    expect(over.text).toBe(exact)
  })

  it('buildWritingRequest：超长来源只发开头并标记 truncated', () => {
    const head = '首'.repeat(MAX_SOURCE_CHARS)
    const tail = '尾'.repeat(100)
    const built = buildWritingRequest('rewrite', head + tail, '', {})

    expect(built.truncated).toBe(true)
    expect(built.sourceChars).toBe(MAX_SOURCE_CHARS)
    const message = built.request.messages[0]
    expect(message?.content).toContain(head)
    expect(message?.content).not.toContain(tail)
  })
})

describe('parseWritingResult（结果解析）', () => {
  it('正常文本原样展示（去首尾空白）', () => {
    const parsed = parseWritingResult('  续写的内容。\n')
    expect(parsed).toEqual({ ok: true, text: '续写的内容。', message: null })
  })

  it('空结果判失败并显原文，不静默丢弃', () => {
    const blank = parseWritingResult('   ')
    expect(blank.ok).toBe(false)
    expect(blank.text).toBe('   ')
    expect(blank.message).toBe(WRITING_COPY.resultEmpty)

    const empty = parseWritingResult('')
    expect(empty.ok).toBe(false)
    expect(empty.text).toBe('')
    expect(empty.message).toBe(WRITING_COPY.resultEmpty)
  })
})

describe('resolveSessionParams（会话参数）', () => {
  it('留空 = 不传（按模式默认）', () => {
    const resolved = resolveSessionParams('', '')
    expect(resolved.error).toBeNull()
    expect('temperature' in resolved).toBe(false)
    expect('maxTokens' in resolved).toBe(false)
  })

  it('合法数值原样传出', () => {
    const resolved = resolveSessionParams('0.7', '2048')
    expect(resolved.error).toBeNull()
    expect(resolved.temperature).toBe(0.7)
    expect(resolved.maxTokens).toBe(2048)
  })

  it('非数字 / 温度越界 / 生成长度非正整数 → 中文错误且不传', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['abc', ''],
      ['3', ''],
      ['-1', ''],
      ['0.7', '0'],
      ['0.7', '40.5'],
      ['0.7', 'abc'],
      ['0.7', '-1'],
    ]
    for (const [temperature, maxTokens] of cases) {
      const resolved = resolveSessionParams(temperature, maxTokens)
      expect(resolved.error).toBe(WRITING_COPY.paramInvalid)
      expect('temperature' in resolved).toBe(false)
      expect('maxTokens' in resolved).toBe(false)
    }
  })
})

describe('parseOptionalNumber（可选数字输入）', () => {
  it('空 = undefined、合法 = 数值、其它 = null', () => {
    expect(parseOptionalNumber('')).toBeUndefined()
    expect(parseOptionalNumber('  ')).toBeUndefined()
    expect(parseOptionalNumber('0.7')).toBe(0.7)
    expect(parseOptionalNumber('4096')).toBe(4096)
    expect(parseOptionalNumber('abc')).toBeNull()
    expect(parseOptionalNumber('1e3')).toBeNull()
    expect(parseOptionalNumber('-1')).toBeNull()
  })
})

describe('readChapters（章节来源）', () => {
  it('只取当前作品未删章节，卷/已删/跨作品被排除', () => {
    const documents = [
      doc({ id: 'doc_1' }),
      doc({ id: 'doc_2', deleted: 1 }),
      doc({ id: 'doc_3', kind: 'volume' }),
      doc({ id: 'doc_4', projectId: 'prj_2' }),
    ]
    const chapters = readChapters(snapshotOf(documents, 'prj_1'))
    expect(chapters.map((chapter) => chapter.id)).toEqual(['doc_1'])
  })

  it('无作品（projectId null）时为空', () => {
    expect(readChapters(snapshotOf([doc({ id: 'doc_1' })], null))).toEqual([])
  })
})

describe('panelSaveStatus 与结果字数行', () => {
  it('保存状态：saving > error > dirty > saved', () => {
    expect(panelSaveStatus(true, false, false)).toBe('saving')
    expect(panelSaveStatus(true, true, true)).toBe('saving')
    expect(panelSaveStatus(false, false, true)).toBe('error')
    expect(panelSaveStatus(false, true, false)).toBe('dirty')
    expect(panelSaveStatus(false, false, false)).toBe('saved')
  })

  it('resultCharsLine：结果 N 字', () => {
    expect(resultCharsLine(1234)).toBe('结果 1234 字')
  })
})
