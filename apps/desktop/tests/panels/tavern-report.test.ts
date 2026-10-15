/**
 * tavern-report-model 纯逻辑单测（node 环境，无 DOM / 无 store / 无 vue）。
 *
 * 覆盖：常量、默认 values、记录增删改（不改传入数组）、表单校验、
 * 概览行、保存状态推导、列表摘要、时间格式化、文案模板、
 * AI 请求组装与结果解析（解析失败 → null，调用方不落库）、
 * 失败文案（未配置给引导）、复制编排（剪贴板 → execCommand 兜底）。
 *
 * copyViaExecCommand 需要 DOM（document），在 tavern-report.view.test.ts（happy-dom）覆盖。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  AI_REPORT_MAX_TOKENS,
  BRIEF_MAX_CHARS,
  TAVERN_REPORT_PANEL_TEXT,
  briefBody,
  buildAiReportRequest,
  copyReportText,
  createDefaultPanelValues,
  failureNotice,
  fillTemplate,
  findReportById,
  formatCreatedAt,
  makeReport,
  overviewLine,
  panelSaveStatus,
  parseAiReport,
  removeReport,
  upsertReport,
  validateAiSource,
  validateReportForm,
} from '../../src/renderer/panels/tavern-report-model.js'
import type { TavernReportRecord } from '../../src/renderer/tavern/types.js'

/** TavernReportRecord 夹具。 */
function reportRecord(input: Partial<TavernReportRecord> = {}): TavernReportRecord {
  return {
    id: input.id ?? 'report_fixture1',
    title: input.title ?? '第一章对话摘要',
    body: input.body ?? '林晚与苏橙在图书馆发现了怀表的秘密。',
    createdAt: input.createdAt ?? '2026-06-01T00:00:00.000Z',
  }
}

describe('tavern-report-model：常量与默认值', () => {
  it('AI 输出上限为 2048（任务书约定）', () => {
    expect(AI_REPORT_MAX_TOKENS).toBe(2048)
  })

  it('列表摘要截断长度为正数', () => {
    expect(BRIEF_MAX_CHARS).toBeGreaterThan(0)
  })

  it('面板文案全部是非空中文字符串（可见文本 ⊆ 页签文案 ∪ 常量）', () => {
    for (const [key, value] of Object.entries(TAVERN_REPORT_PANEL_TEXT)) {
      expect(value.length, `文案 ${key} 不应为空`).toBeGreaterThan(0)
      expect(typeof value).toBe('string')
    }
  })

  it('手动生成入口说明使用任务书指定的文案', () => {
    expect(TAVERN_REPORT_PANEL_TEXT.manualEntry).toBe(
      '在『酒馆对话』页签产生对话后，可在此粘贴对话内容生成报告',
    )
  })

  it('默认 values：items 为空数组', () => {
    expect(createDefaultPanelValues()).toEqual({ items: [] })
  })
})

describe('tavern-report-model：记录增删改', () => {
  it('makeReport 新建：生成 report_ 前缀 id 与可解析时间戳，文本字段 trim', () => {
    const report = makeReport({ title: '  第一幕  ', body: '  关键剧情  ' })
    expect(report.id.startsWith('report_')).toBe(true)
    expect(report.id.length).toBeGreaterThan('report_'.length)
    expect(report.title).toBe('第一幕')
    expect(report.body).toBe('关键剧情')
    expect(Number.isNaN(new Date(report.createdAt).getTime())).toBe(false)
  })

  it('makeReport 编辑：保留原 id 与 createdAt', () => {
    const existing = reportRecord()
    const report = makeReport({ title: '新标题', body: '新正文' }, existing)
    expect(report.id).toBe(existing.id)
    expect(report.createdAt).toBe(existing.createdAt)
    expect(report.title).toBe('新标题')
    expect(report.body).toBe('新正文')
  })

  it('findReportById：按 id 命中，未命中返回 null', () => {
    const a = reportRecord()
    const b = reportRecord({ id: 'report_two' })
    const items = [a, b]
    expect(findReportById(items, 'report_two')).toBe(b)
    expect(findReportById(items, 'report_missing')).toBeNull()
  })

  it('upsertReport 新报告追加到末尾，不改传入数组', () => {
    const a = reportRecord()
    const items = [a]
    const next = reportRecord({ id: 'report_two' })
    const result = upsertReport(items, next)
    expect(result).toHaveLength(2)
    expect(result[1]).toBe(next)
    expect(items).toHaveLength(1)
  })

  it('upsertReport 已有报告原位替换（同长度同位置）', () => {
    const a = reportRecord()
    const b = reportRecord({ id: 'report_two' })
    const items = [a, b]
    const edited = reportRecord({ id: 'report_two', title: '改名' })
    const result = upsertReport(items, edited)
    expect(result).toHaveLength(2)
    expect(result[1]).toBe(edited)
    expect(result[0]).toBe(a)
  })

  it('removeReport 按 id 删除、保留其余，不改传入数组', () => {
    const a = reportRecord()
    const b = reportRecord({ id: 'report_two' })
    const c = reportRecord({ id: 'report_three' })
    const items = [a, b, c]
    const result = removeReport(items, b.id)
    expect(result).toEqual([a, c])
    expect(items).toHaveLength(3)
  })
})

describe('tavern-report-model：表单校验与展示辅助', () => {
  it('validateReportForm：标题为空或纯空白 → 标题必填文案；合法 → null', () => {
    expect(validateReportForm({ title: '' })).toBe(TAVERN_REPORT_PANEL_TEXT.titleRequired)
    expect(validateReportForm({ title: '   ' })).toBe(TAVERN_REPORT_PANEL_TEXT.titleRequired)
    expect(validateReportForm({ title: '第一幕' })).toBeNull()
  })

  it('overviewLine：共 N 篇报告', () => {
    expect(overviewLine(0)).toBe('共 0 篇报告')
    expect(overviewLine(3)).toBe('共 3 篇报告')
  })

  it('panelSaveStatus：saving 优先，其次 error，再次 dirty，否则 saved', () => {
    expect(panelSaveStatus(true, true, true)).toBe('saving')
    expect(panelSaveStatus(false, true, true)).toBe('error')
    expect(panelSaveStatus(false, true, false)).toBe('dirty')
    expect(panelSaveStatus(false, false, false)).toBe('saved')
  })

  it('briefBody：短文 trim 后原样；长文按码点截断加省略号', () => {
    expect(briefBody('  短摘要  ')).toBe('短摘要')
    const long = '林'.repeat(BRIEF_MAX_CHARS + 10)
    expect(briefBody(long)).toBe(`${'林'.repeat(BRIEF_MAX_CHARS)}…`)
    // 表情符号是代理对：按码点计数，不产生半个字符。
    const emoji = '😀'.repeat(BRIEF_MAX_CHARS + 5)
    expect(briefBody(emoji)).toBe(`${'😀'.repeat(BRIEF_MAX_CHARS)}…`)
  })

  it('formatCreatedAt：输出「YYYY-MM-DD HH:mm」本地时间形状；解析失败原样返回', () => {
    const formatted = formatCreatedAt('2026-06-01T08:09:00.000Z')
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    // 与 Date 的本地时间字段一致（不依赖测试机时区断言具体值）。
    const parsed = new Date('2026-06-01T08:09:00.000Z')
    expect(formatted).toBe(
      `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-` +
        `${String(parsed.getDate()).padStart(2, '0')} ` +
        `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`,
    )
    expect(formatCreatedAt('不是时间')).toBe('不是时间')
  })

  it('fillTemplate：替换 {key}；没有对应值的占位符原样保留', () => {
    expect(fillTemplate('确定删除「{title}」吗？', { title: '第一幕' })).toBe('确定删除「第一幕」吗？')
    expect(fillTemplate('生成失败：{message}', { message: '超时' })).toBe('生成失败：超时')
    expect(fillTemplate('缺少 {missing} 占位符', {})).toBe('缺少 {missing} 占位符')
  })
})

describe('tavern-report-model：AI 请求组装与解析', () => {
  it('validateAiSource：空白 → null（不发请求）；否则返回 trim 后文本', () => {
    expect(validateAiSource('')).toBeNull()
    expect(validateAiSource('   \n\t ')).toBeNull()
    expect(validateAiSource('  林晚：你醒了？  ')).toBe('林晚：你醒了？')
  })

  it('buildAiReportRequest：单条 user 消息带对话原文，maxTokens 固定 2048', () => {
    const request = buildAiReportRequest('林晚：你醒了？\n苏橙：怀表在响。')
    expect(request.system.length).toBeGreaterThan(0)
    expect(request.system).toContain('JSON')
    expect(request.messages).toHaveLength(1)
    expect(request.messages[0]?.role).toBe('user')
    expect(request.messages[0]?.content).toContain('林晚：你醒了？')
    expect(request.messages[0]?.content).toContain('【对话原文】')
    expect(request.maxTokens).toBe(AI_REPORT_MAX_TOKENS)
    expect(request.maxTokens).toBe(2048)
  })

  it('parseAiReport：纯 JSON 对象 → { title, body }', () => {
    expect(parseAiReport('{"title":"第一幕","body":"摘要正文"}')).toEqual({
      title: '第一幕',
      body: '摘要正文',
    })
  })

  it('parseAiReport：容忍代码块标记与前后缀文字', () => {
    const fenced = '```json\n{"title":"第一幕","body":"摘要"}\n```'
    expect(parseAiReport(fenced)).toEqual({ title: '第一幕', body: '摘要' })
    const padded = '好的，报告如下：{"title":"第一幕","body":"摘要"} 请查收。'
    expect(parseAiReport(padded)).toEqual({ title: '第一幕', body: '摘要' })
  })

  it('parseAiReport：title 缺失 / 空白 / 整体不是 JSON / 数组 → null（不落库）', () => {
    expect(parseAiReport('{"body":"没有标题"}')).toBeNull()
    expect(parseAiReport('{"title":"","body":"空标题"}')).toBeNull()
    expect(parseAiReport('{"title":"   ","body":"空白标题"}')).toBeNull()
    expect(parseAiReport('完全不是 JSON 的回复')).toBeNull()
    expect(parseAiReport('{}')).toBeNull()
    expect(parseAiReport('[]')).toBeNull()
    expect(parseAiReport('"只是一个字符串"')).toBeNull()
  })

  it('parseAiReport：body 缺失兜底空串；数字字段宽松转字符串', () => {
    expect(parseAiReport('{"title":"第一幕"}')).toEqual({ title: '第一幕', body: '' })
    expect(parseAiReport('{"title":42,"body":123}')).toEqual({ title: '42', body: '123' })
  })

  it('failureNotice：未配置给引导文案，其余统一「生成失败：…」', () => {
    expect(failureNotice('AI_NOT_CONFIGURED', '配置被清空')).toBe(TAVERN_REPORT_PANEL_TEXT.notConfigured)
    expect(failureNotice('AI_TIMEOUT', '请求超时')).toBe('生成失败：请求超时')
  })
})

describe('tavern-report-model：复制编排（剪贴板 → execCommand 兜底）', () => {
  it('剪贴板可用：writeText 成功 → null（无错误提示）', async () => {
    const writeText = vi.fn(async () => {})
    const error = await copyReportText('正文', { writeText }, () => false)
    expect(error).toBeNull()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('正文')
  })

  it('剪贴板写入失败：走 execCommand 兜底成功 → null', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('NotAllowedError')
    })
    const fallback = vi.fn(() => true)
    const error = await copyReportText('正文', { writeText }, fallback)
    expect(error).toBeNull()
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('剪贴板与 execCommand 都失败 → 返回如实的失败文案', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('NotAllowedError')
    })
    const fallback = vi.fn(() => false)
    const error = await copyReportText('正文', { writeText }, fallback)
    expect(error).toBe(TAVERN_REPORT_PANEL_TEXT.copyFailed)
  })

  it('没有剪贴板对象（node 环境）→ 只走 fallback', async () => {
    const fallback = vi.fn(() => true)
    expect(await copyReportText('正文', undefined, fallback)).toBeNull()
    expect(await copyReportText('正文', null, () => false)).toBe(TAVERN_REPORT_PANEL_TEXT.copyFailed)
  })
})
