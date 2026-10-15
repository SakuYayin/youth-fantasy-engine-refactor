import { describe, expect, it } from 'vitest'
// 业界权威表：apps/desktop 的 IPC_METHODS（跨包 import 只出现在**测试**里，
// 包本身的运行时依赖仍然只有 @yfe/contracts）。
import { IPC_METHODS as DESKTOP_CHANNELS } from '../../../apps/desktop/src/shared/ipc/channels.js'
// 渲染层实际要过的那道闸：preload 启动时生成的 .cjs 运行时副本（带 .d.cts 类型）。
import preloadMethodsModule from '../../../apps/desktop/src/preload/ipc-methods.cjs'
import { IPC_METHODS as CLIENT_METHODS, isIpcMethod } from '../src/index.js'

describe('IPC 白名单一致性（防止副本漂移）', () => {
  it('客户端副本与 channels.ts 的 IPC_METHODS 逐字、按顺序完全相同', () => {
    expect([...CLIENT_METHODS]).toEqual([...DESKTOP_CHANNELS])
  })

  it('客户端副本与 preload 的运行时 CJS 副本完全相同（渲染层真正过的那道闸）', () => {
    expect([...CLIENT_METHODS]).toEqual([...preloadMethodsModule.IPC_METHODS])
  })

  it('与 ADR 0006 D2 的方法表逐字一致（含 W6 设定实体三方法、W7 的 aiComplete 与章节管理两方法），且副本被冻结、无重复', () => {
    expect([...CLIENT_METHODS]).toEqual([
      'saveDraft',
      'listDocumentTree',
      'getDocument',
      'createProject',
      'createDocument',
      'updateDocument',
      'deleteDocument',
      'systemStatus',
      'listSettingsEntities',
      'getSettingsEntity',
      'saveSettingsEntity',
      'aiComplete',
    ])
    expect(Object.isFrozen(CLIENT_METHODS)).toBe(true)
    expect(new Set(CLIENT_METHODS).size).toBe(CLIENT_METHODS.length)
  })

  it('isIpcMethod 只认逐字命中的字符串（含大小写/空格/原型链名字）', () => {
    for (const method of CLIENT_METHODS) {
      expect(isIpcMethod(method)).toBe(true)
    }
    for (const bad of [
      '',
      'invoke',
      'require',
      'saveDraft ',
      ' saveDraft',
      'SAVEDRAFT',
      'save-draft',
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      null,
      undefined,
      42,
      {},
      [],
      Symbol('saveDraft'),
    ]) {
      expect(isIpcMethod(bad)).toBe(false)
    }
  })
})
