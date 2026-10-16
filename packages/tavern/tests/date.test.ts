/**
 * `date.ts` 契约测试 —— `formatDate` 是「日期 → `YYYY-MM-DD`」的唯一口径。
 *
 * 上游对应测试：**无**（`_upstream_tmp/youth-fantasy-engine-main/tests/` 下不存在 date 相关
 * 测试文件；`glob **\/*date*` 只命中 `updateDownload.test.ts`，是文件名里含 "pdate" 的误配）。
 * 故本文件为本仓自写。
 *
 * 断言纪律：**一律用本地时区构造**（`new Date(2026, 0, 5)`），
 * 绝不用 `'2026-01-05T00:00:00Z'` —— 后者在东八区会被解析成 1 月 5 日 08:00 之外的口径，
 * 一旦换时区（或 CI 跑在 UTC）就漂到别的日子，那时测的是时区而不是 `formatDate`。
 * 缺省参数用例同样只断言**格式**与**自洽**，不断言具体日期（否则跨零点会假红）。
 */
import { describe, expect, it } from 'vitest'

import { formatDate } from '../src/date.js'

describe('formatDate', () => {
  it('本地时区构造 → 补零成 YYYY-MM-DD', () => {
    expect(formatDate(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
  it('月 / 日 < 10 一律补零', () => {
    expect(formatDate(new Date(2026, 8, 9))).toBe('2026-09-09')
  })
  it('月 / 日 >= 10 不补零（两位数原样）', () => {
    expect(formatDate(new Date(2026, 11, 31))).toBe('2026-12-31')
  })
  it('跨年边界：12 月 31 日与 1 月 1 日各自归年', () => {
    expect(formatDate(new Date(2025, 11, 31))).toBe('2025-12-31')
    expect(formatDate(new Date(2026, 0, 1))).toBe('2026-01-01')
  })
  it('number 时间戳入参（与同一时刻的 Date 实例结果一致，不重解析成 UTC）', () => {
    const d = new Date(2026, 0, 5)
    expect(formatDate(d.getTime())).toBe('2026-01-05')
    expect(formatDate(d.getTime())).toBe(formatDate(d))
  })
  it('缺省参数返回当天（只校验格式与自洽，不断言具体日期）', () => {
    expect(formatDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(formatDate()).toBe(formatDate(new Date()))
  })
})