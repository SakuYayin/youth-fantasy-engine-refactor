/**
 * tavern-script 面板纯逻辑单测（模型层，node 环境）。
 *
 * 覆盖：面板常量、默认 values、记录组装与校验、增删改不变性（不改传入数组）、
 * 启用开关、摘要与文案、保存状态推导、AI 请求组装与脚本草稿解析、失败文案。
 */
import { describe, expect, it } from 'vitest'

import type { TavernScriptRecord } from '../../src/renderer/tavern/types.js'

import {
  AI_SCRIPT_MAX_TOKENS,
  NOTE_MAX_CHARS,
  TAVERN_SCRIPT_PANEL_TEXT as TEXT,
  briefNote,
  buildAiScriptRequest,
  createDefaultPanelValues,
  failureNotice,
  fillTemplate,
  findScriptById,
  makeScript,
  overviewLine,
  panelSaveStatus,
  parseAiScript,
  removeScript,
  toggleScriptEnabled,
  upsertScript,
  validateScriptForm,
} from '../../src/renderer/panels/tavern-script-model.js'

/** 造一条测试脚本记录。 */
function makeRecord(overrides?: Partial<TavernScriptRecord>): TavernScriptRecord {
  return {
    id: 'script_test1',
    name: '开场脚本',
    code: '第一幕：主角进场',
    enabled: true,
    note: '用于开场',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('面板常量', () => {
  it('AI 输出上限固定 2048', () => {
    expect(AI_SCRIPT_MAX_TOKENS).toBe(2048)
  })

  it('备注摘要截断长度为 40', () => {
    expect(NOTE_MAX_CHARS).toBe(40)
  })

  it('预览版说明条写明只保存与查看、不执行', () => {
    expect(TEXT.previewNotice).toBe('预览版只保存与查看脚本，不会在任何时机执行脚本内容。')
  })

  it('全部文案都是非空中文字符串', () => {
    for (const value of Object.values(TEXT)) {
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    }
  })
})

describe('默认 values', () => {
  it('空脚本列表', () => {
    expect(createDefaultPanelValues()).toEqual({ items: [] })
  })
})

describe('makeScript 组装记录', () => {
  it('新建：id 以 script_ 开头、默认启用、时间戳为合法 ISO、文本 trim', () => {
    const script = makeScript({ name: '  开场脚本  ', code: ' 第一幕 \n', note: '  备注  ' })
    expect(script.id.startsWith('script_')).toBe(true)
    expect(script.id.length).toBeGreaterThan('script_'.length)
    expect(script.enabled).toBe(true)
    expect(script.name).toBe('开场脚本')
    expect(script.code).toBe('第一幕')
    expect(script.note).toBe('备注')
    expect(Number.isNaN(Date.parse(script.updatedAt))).toBe(false)
  })

  it('两次新建生成不同的 id', () => {
    const a = makeScript({ name: '甲', code: '', note: '' })
    const b = makeScript({ name: '乙', code: '', note: '' })
    expect(a.id).not.toBe(b.id)
  })

  it('编辑：保留 id 与 enabled、刷新 updatedAt', () => {
    const existing = makeRecord({ enabled: false })
    const script = makeScript({ name: '开场脚本改', code: '第一幕改', note: '' }, existing)
    expect(script.id).toBe(existing.id)
    expect(script.enabled).toBe(false)
    expect(script.name).toBe('开场脚本改')
    expect(script.code).toBe('第一幕改')
    expect(script.note).toBe('')
    expect(script.updatedAt).not.toBe(existing.updatedAt)
    expect(Number.isNaN(Date.parse(script.updatedAt))).toBe(false)
  })
})

describe('validateScriptForm 表单校验', () => {
  it('名称为空报「名称不能为空。」', () => {
    expect(validateScriptForm({ name: '', code: 'x', note: '' })).toBe(TEXT.nameRequired)
  })

  it('名称只有空白也算空', () => {
    expect(validateScriptForm({ name: '   ', code: '', note: '' })).toBe(TEXT.nameRequired)
  })

  it('有名即通过；代码与备注可以为空', () => {
    expect(validateScriptForm({ name: '开场脚本', code: '', note: '' })).toBeNull()
    expect(validateScriptForm({ name: ' 开场脚本 ', code: '第一幕', note: '备注' })).toBeNull()
  })
})

describe('增删改不变性（不改传入数组）', () => {
  it('upsertScript 新脚本追加到末尾', () => {
    const items = [makeRecord(), makeRecord({ id: 'script_test2', name: '第二场' })]
    const snapshot = [...items]
    const fresh = makeRecord({ id: 'script_new' })
    const next = upsertScript(items, fresh)
    expect(next).toHaveLength(3)
    expect(next[2]).toBe(fresh)
    expect(items).toEqual(snapshot)
  })

  it('upsertScript 已有脚本原位替换、长度不变', () => {
    const items = [makeRecord(), makeRecord({ id: 'script_test2', name: '第二场' })]
    const snapshot = [...items]
    const edited = makeRecord({ name: '开场脚本改' })
    const next = upsertScript(items, edited)
    expect(next).toHaveLength(2)
    expect(next[0]).toBe(edited)
    expect(next[1]?.id).toBe('script_test2')
    expect(items).toEqual(snapshot)
  })

  it('removeScript 按 id 过滤、不改传入数组', () => {
    const items = [makeRecord(), makeRecord({ id: 'script_test2' })]
    const snapshot = [...items]
    const next = removeScript(items, 'script_test1')
    expect(next).toHaveLength(1)
    expect(next[0]?.id).toBe('script_test2')
    expect(items).toEqual(snapshot)
    expect(removeScript(items, 'script_absent')).toHaveLength(2)
  })

  it('toggleScriptEnabled 只动目标条目并刷新 updatedAt', () => {
    const items = [makeRecord(), makeRecord({ id: 'script_test2', enabled: true })]
    const snapshot = [...items]
    const next = toggleScriptEnabled(items, 'script_test1', false)
    expect(next[0]?.enabled).toBe(false)
    expect(next[0]?.id).toBe('script_test1')
    expect(next[0]?.updatedAt).not.toBe('2024-01-01T00:00:00.000Z')
    expect(next[1]?.enabled).toBe(true)
    expect(items).toEqual(snapshot)
  })

  it('toggleScriptEnabled 命中不到 id 时原样返回', () => {
    const items = [makeRecord()]
    const next = toggleScriptEnabled(items, 'script_absent', true)
    expect(next).toHaveLength(1)
    expect(next[0]).toEqual(makeRecord())
  })

  it('findScriptById 命中返回记录、未命中返回 null', () => {
    const items = [makeRecord()]
    expect(findScriptById(items, 'script_test1')?.name).toBe('开场脚本')
    expect(findScriptById(items, 'script_absent')).toBeNull()
  })
})

describe('摘要与文案工具', () => {
  it('briefNote 短文本原样返回', () => {
    expect(briefNote('用于开场')).toBe('用于开场')
  })

  it('briefNote 长文本按码点截断加省略号', () => {
    const long = '一'.repeat(50)
    const brief = briefNote(long)
    expect(brief).toHaveLength(NOTE_MAX_CHARS + 1)
    expect(brief.endsWith('…')).toBe(true)
    expect(brief.startsWith('一'.repeat(NOTE_MAX_CHARS))).toBe(true)
  })

  it('briefNote 空备注返回空串', () => {
    expect(briefNote('')).toBe('')
    expect(briefNote('   ')).toBe('')
  })

  it('overviewLine 输出「共 N 条脚本」', () => {
    expect(overviewLine(0)).toBe('共 0 条脚本')
    expect(overviewLine(3)).toBe('共 3 条脚本')
  })

  it('fillTemplate 替换 {key}，未知名的占位符原样保留', () => {
    expect(fillTemplate('确定删除「{name}」吗？', { name: '开场脚本' })).toBe('确定删除「开场脚本」吗？')
    expect(fillTemplate('生成失败：{message}', {})).toBe('生成失败：{message}')
  })

  it('panelSaveStatus：saving 优先，其次 error，再次 dirty，否则 saved', () => {
    expect(panelSaveStatus(true, false, false)).toBe('saving')
    expect(panelSaveStatus(true, true, true)).toBe('saving')
    expect(panelSaveStatus(false, true, true)).toBe('error')
    expect(panelSaveStatus(false, true, false)).toBe('dirty')
    expect(panelSaveStatus(false, false, false)).toBe('saved')
  })
})

describe('buildAiScriptRequest AI 请求组装', () => {
  it('带需求描述：maxTokens 2048、单条 user 消息、system 要求只返回脚本正文', () => {
    const request = buildAiScriptRequest('主角捡起一把发光的剑', [])
    expect(request.maxTokens).toBe(AI_SCRIPT_MAX_TOKENS)
    expect(request.maxTokens).toBe(2048)
    expect(request.system).toContain('脚本正文')
    expect(request.system).toContain('不会执行')
    expect(request.messages).toHaveLength(1)
    expect(request.messages[0]?.role).toBe('user')
    expect(request.messages[0]?.content).toContain('主角捡起一把发光的剑')
  })

  it('已有脚本名作为避免重复的上下文传入', () => {
    const request = buildAiScriptRequest('第二场打斗', ['开场脚本', '第二场'])
    expect(request.messages[0]?.content).toContain('开场脚本、第二场')
  })

  it('没有已有脚本时不带避免重复上下文', () => {
    const request = buildAiScriptRequest('第一场', [])
    expect(request.messages[0]?.content).not.toContain('已有的脚本名')
  })

  it('需求描述 trim 后进请求', () => {
    const request = buildAiScriptRequest('  第一场相遇  ', [])
    expect(request.messages[0]?.content).toContain('第一场相遇')
    expect(request.messages[0]?.content).not.toContain('  第一场相遇  ')
  })
})

describe('parseAiScript 脚本草稿解析', () => {
  it('纯文本原样返回（trim）', () => {
    expect(parseAiScript('第一幕：主角进场')).toBe('第一幕：主角进场')
    expect(parseAiScript('  第一幕  ')).toBe('第一幕')
  })

  it('剥掉带语言标注的围栏', () => {
    expect(parseAiScript('```js\n第一幕\n第二幕\n```')).toBe('第一幕\n第二幕')
  })

  it('剥掉不带语言标注的围栏', () => {
    expect(parseAiScript('```\n第一幕\n```')).toBe('第一幕')
  })

  it('容忍前后缀文字 + 围栏', () => {
    expect(parseAiScript('好的，这是脚本：\n```\n第一幕\n```')).toBe('第一幕')
  })

  it('多段围栏取第一段', () => {
    expect(parseAiScript('```\n第一段\n```\n```\n第二段\n```')).toBe('第一段')
  })

  it('单行围栏剥掉标记', () => {
    expect(parseAiScript('```第一幕```')).toBe('第一幕')
  })

  it('空串 / 全空白 → null', () => {
    expect(parseAiScript('')).toBeNull()
    expect(parseAiScript('   \n  ')).toBeNull()
  })

  it('只有围栏没有正文 → null（解析失败不落库）', () => {
    expect(parseAiScript('```\n```')).toBeNull()
    expect(parseAiScript('```js\n```')).toBeNull()
  })
})

describe('failureNotice AI 失败文案', () => {
  it('未配置模型给引导文案', () => {
    expect(failureNotice('AI_NOT_CONFIGURED', '未配置')).toBe(TEXT.notConfigured)
  })

  it('其余错误码统一「生成失败：…」', () => {
    expect(failureNotice('AI_RATE_LIMITED', '请求太频繁')).toBe('生成失败：请求太频繁')
    expect(failureNotice('AI_TIMEOUT', '超时')).toBe('生成失败：超时')
  })
})
