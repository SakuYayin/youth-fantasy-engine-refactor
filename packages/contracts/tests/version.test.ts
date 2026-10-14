import { describe, expect, it } from 'vitest'

import {
  APP_VERSION,
  DB_SCHEMA_VERSION,
  PLUGIN_API_VERSION,
  SYNC_PROTOCOL_VERSION,
  checkSchemaCompat,
  isProtocolCompatible,
} from '../src/version.js'

describe('版本常量', () => {
  it('应用版本与数据库 Schema 版本彼此独立', () => {
    // 二者含义不同：前者决定功能，后者决定能否打开库。不允许把二者混用。
    expect(typeof APP_VERSION).toBe('string')
    expect(Number.isInteger(DB_SCHEMA_VERSION)).toBe(true)
    expect(DB_SCHEMA_VERSION).toBeGreaterThanOrEqual(1)
  })

  it('插件 API 版本为 semver 形态', () => {
    expect(PLUGIN_API_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('同步协议版本有独立主次版本', () => {
    expect(SYNC_PROTOCOL_VERSION.major).toBeGreaterThanOrEqual(1)
    expect(SYNC_PROTOCOL_VERSION.minor).toBeGreaterThanOrEqual(0)
  })
})

describe('checkSchemaCompat', () => {
  it('相同版本为 ok', () => {
    expect(checkSchemaCompat(3, 3)).toBe('ok')
  })

  it('库比程序旧需要迁移', () => {
    expect(checkSchemaCompat(1, 3)).toBe('needs-migration')
  })

  it('库比程序新必须拒绝，绝不"尽力打开"', () => {
    // 关键安全语义：新版写入的字段会被旧版静默丢弃，造成不可逆数据损失。
    expect(checkSchemaCompat(4, 3)).toBe('too-new')
  })

  it('默认使用当前 DB_SCHEMA_VERSION 作为期望值', () => {
    expect(checkSchemaCompat(DB_SCHEMA_VERSION)).toBe('ok')
    expect(checkSchemaCompat(DB_SCHEMA_VERSION + 1)).toBe('too-new')
  })
})

describe('isProtocolCompatible', () => {
  it('主版本相同则兼容（次版本可不同）', () => {
    expect(isProtocolCompatible({ major: SYNC_PROTOCOL_VERSION.major, minor: 0 })).toBe(true)
    expect(isProtocolCompatible({ major: SYNC_PROTOCOL_VERSION.major, minor: 99 })).toBe(true)
  })

  it('主版本不同则拒绝同步', () => {
    expect(isProtocolCompatible({ major: SYNC_PROTOCOL_VERSION.major + 1, minor: 0 })).toBe(false)
    expect(isProtocolCompatible({ major: 0, minor: 9 })).toBe(false)
  })
})
