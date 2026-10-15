import { describe, expect, it } from 'vitest'
import {
  PLUGIN_CAPABILITIES,
  PLUGIN_GRANTABLE_CAPABILITIES,
  PLUGIN_KINDS,
  PLUGIN_MANIFEST_VERSION,
  PLUGIN_PLATFORMS,
  PLUGIN_UNGRANTABLE_CAPABILITIES,
  isGrantableCapability,
  isPluginCapability,
  isPluginKind,
  isPluginPlatform,
  parseSemver,
  isValidRange,
  satisfiesRange,
  summarizeManifestIssues,
  validatePluginManifest,
} from '../src/manifest/index.js'
import type { ManifestIssue, ManifestIssueCode, PluginManifest } from '../src/manifest/index.js'

/** 一份合法的基线 manifest；各用例在其上做单点破坏。 */
function baseline(): Record<string, unknown> {
  return {
    id: 'yfe.builtin.outline',
    name: '大纲面板',
    version: '1.2.3',
    manifestVersion: PLUGIN_MANIFEST_VERSION,
    hostApiRange: '^1.0.0',
    kind: 'trusted-builtin',
    platforms: ['win32', 'darwin', 'linux'],
    entries: { service: 'dist/service.js' },
    dependencies: [],
    requiredServices: ['documentService'],
    permissions: ['plugin.ui.panel'],
    contributes: { panels: ['outline-panel'] },
    dataSchemaVersion: 1,
  }
}

/** 期望校验失败，并返回 issue 列表（顺带断言 ok 判别位）。 */
function expectInvalid(input: unknown): readonly ManifestIssue[] {
  const result = validatePluginManifest(input)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.issues.length).toBeGreaterThan(0)
  return result.issues
}

function expectCodes(input: unknown, codes: readonly ManifestIssueCode[]): readonly ManifestIssue[] {
  const issues = expectInvalid(input)
  const actual = issues.map((issue) => issue.code)
  for (const code of codes) expect(actual).toContain(code)
  return issues
}

function expectValid(input: unknown): PluginManifest {
  const result = validatePluginManifest(input)
  if (!result.ok) {
    throw new Error(`期望合法但失败：${JSON.stringify(result.issues)}`)
  }
  expect(result.ok).toBe(true)
  return result.value
}

describe('manifest 常量表', () => {
  it('kind / platform 表与判定函数一致', () => {
    expect([...PLUGIN_KINDS]).toEqual(['trusted-builtin', 'declarative-theme'])
    for (const kind of PLUGIN_KINDS) expect(isPluginKind(kind)).toBe(true)
    expect(isPluginKind('third-party')).toBe(false)
    expect(isPluginKind(1)).toBe(false)

    expect([...PLUGIN_PLATFORMS]).toEqual(['win32', 'darwin', 'linux', 'web', 'mobile'])
    for (const platform of PLUGIN_PLATFORMS) expect(isPluginPlatform(platform)).toBe(true)
    expect(isPluginPlatform('android')).toBe(false)
  })

  it('能力表：可授予 + 不可授予 = 全集，且两段不重叠', () => {
    expect(PLUGIN_CAPABILITIES.length).toBe(
      PLUGIN_GRANTABLE_CAPABILITIES.length + PLUGIN_UNGRANTABLE_CAPABILITIES.length,
    )
    const grantable = new Set<string>(PLUGIN_GRANTABLE_CAPABILITIES)
    for (const capability of PLUGIN_UNGRANTABLE_CAPABILITIES) {
      expect(grantable.has(capability)).toBe(false)
    }
    for (const capability of PLUGIN_CAPABILITIES) expect(isPluginCapability(capability)).toBe(true)
    expect(isPluginCapability('host.process.spawn')).toBe(true)
    expect(isPluginCapability('host.eval.arbitrary')).toBe(false)
  })

  it('🔴 ADR 008：需要真实隔离的能力一律不可授予', () => {
    for (const capability of PLUGIN_UNGRANTABLE_CAPABILITIES) {
      expect(isGrantableCapability(capability)).toBe(false)
    }
    for (const capability of PLUGIN_GRANTABLE_CAPABILITIES) {
      expect(isGrantableCapability(capability)).toBe(true)
    }
  })
})

describe('validatePluginManifest —— 合法输入', () => {
  it('基线 manifest 通过并规范化可选字段', () => {
    const manifest = expectValid(baseline())
    expect(manifest.id).toBe('yfe.builtin.outline')
    expect(manifest.manifestVersion).toBe(PLUGIN_MANIFEST_VERSION)
    expect(manifest.platforms).toEqual(['win32', 'darwin', 'linux'])
    expect(manifest.permissions).toEqual(['plugin.ui.panel'])
    expect(manifest.contributes.panels).toEqual(['outline-panel'])
    expect(manifest.configSchema).toBeUndefined()
  })

  it('最小输入：省略全部可选项仍然合法', () => {
    const minimal = {
      id: 'yfe.builtin.min',
      name: 'Min',
      version: '0.0.1',
      manifestVersion: 1,
      hostApiRange: '*',
      kind: 'trusted-builtin',
      platforms: ['web'],
      entries: { ui: 'dist/ui.js' },
      permissions: [],
      dataSchemaVersion: 1,
    }
    const manifest = expectValid(minimal)
    expect(manifest.dependencies).toEqual([])
    expect(manifest.requiredServices).toEqual([])
    expect(manifest.contributes).toEqual({})
  })

  it('configSchema 为对象时原样保留', () => {
    const manifest = expectValid({
      ...baseline(),
      configSchema: { type: 'object', properties: { width: { type: 'number' } } },
    })
    expect(manifest.configSchema).toEqual({
      type: 'object',
      properties: { width: { type: 'number' } },
    })
  })
})

describe('validatePluginManifest —— 非对象与缺字段', () => {
  it('非对象输入', () => {
    for (const input of [null, undefined, 42, 'manifest', true, []] as unknown[]) {
      expectCodes(input, ['not-an-object'])
    }
  })

  it('空对象：报出全部缺字段（收集而非遇错即返）', () => {
    const issues = expectCodes({}, ['missing-field'])
    // 所有必填字段都缺失时逐项报告，而不是遇错即返。
    const missing = issues.filter((issue) => issue.code === 'missing-field').map((issue) => issue.path)
    expect(missing).toContain('id')
    expect(missing).toContain('name')
    expect(missing).toContain('version')
    expect(missing).toContain('hostApiRange')
    expect(missing).toContain('permissions')
    expect(missing).toContain('dataSchemaVersion')
    // 下面是「缺键」而非「值非法」：kind/platforms/entries 的键压根不存在，
    // 因此报 missing-field，不会报 unknown-kind / empty-list。
    expect(missing).toContain('kind')
    expect(missing).toContain('platforms')
    expect(missing).toContain('entries')
    // manifestVersion 缺失时报 missing-field（而不是版本不支持——它压根没给值）
    expect(missing).toContain('manifestVersion')
    expect(issues.map((issue) => issue.code)).not.toContain('unknown-kind')
    expect(issues.map((issue) => issue.code)).not.toContain('empty-list')
  })

  it('逐项缺字段都能被单独定位', () => {
    for (const field of ['id', 'name', 'version', 'manifestVersion', 'hostApiRange', 'kind'] as const) {
      const broken = baseline()
      delete broken[field]
      const issues = expectInvalid(broken)
      expect(issues.some((issue) => issue.path === field)).toBe(true)
    }
  })
})

describe('validatePluginManifest —— 字段类型与格式', () => {
  it('空字符串与空白字符串按类型错误处理', () => {
    expectCodes({ ...baseline(), id: '' }, ['wrong-type'])
    expectCodes({ ...baseline(), name: '   ' }, ['wrong-type'])
  })

  it('id 必须是合法反向域名', () => {
    const bad = [
      'Outline', // 大写
      'yfe', // 只有一段
      'yfe..builtin', // 空段
      'yfe.builtin.', // 尾点
      '-yfe.builtin', // 以连字符开头
      'yfe.builtin.-x', // 段以连字符开头
      'yfe/builtin', // 路径分隔符
      '../yfe.builtin', // 路径逃逸
      'yfe.builtin outline', // 空格
    ]
    for (const id of bad) {
      expectCodes({ ...baseline(), id }, ['malformed-id'])
    }
    // 合法边界：单段中的数字、连字符中缀
    expectValid({ ...baseline(), id: 'yfe.builtin.outline-2' })
    expectValid({ ...baseline(), id: 'a1.b2' })
  })

  it('version 必须是 semver', () => {
    for (const version of ['1.0', 'v1.0.0', '1.0.0.0', 'latest', '1.x.0']) {
      expectCodes({ ...baseline(), version }, ['malformed-version'])
    }
    // 空字符串走 readString 的 wrong-type 分支（值与格式两类错误都算拒绝）
    expectCodes({ ...baseline(), version: '' }, ['wrong-type'])
    expectValid({ ...baseline(), version: '1.0.0-rc.11' })
    expectValid({ ...baseline(), version: '1.0.0+build.5' })
  })

  it('manifestVersion 必须等于当前版本', () => {
    expectCodes({ ...baseline(), manifestVersion: 2 }, ['manifest-version-unsupported'])
    expectCodes({ ...baseline(), manifestVersion: '1' }, ['manifest-version-unsupported'])
  })

  it('hostApiRange 必须是合法范围', () => {
    for (const range of ['not-a-range', '^^1.0.0', '>=1.0.0 <', '~']) {
      expectCodes({ ...baseline(), hostApiRange: range }, ['malformed-range'])
    }
    // 空字符串走 readString 的 wrong-type
    expectCodes({ ...baseline(), hostApiRange: '' }, ['wrong-type'])
    for (const range of ['*', '^1.0.0', '~1.2.0', '>=1.0.0 <2.0.0', '1.x', '1.0.0 || >=2.0.0']) {
      const manifest = validatePluginManifest({ ...baseline(), hostApiRange: range })
      expect(manifest.ok).toBe(true)
    }
  })

  it('kind 必须在表内', () => {
    expectCodes({ ...baseline(), kind: 'third-party' }, ['unknown-kind'])
    expectCodes({ ...baseline(), kind: 3 }, ['unknown-kind'])
    expectValid({ ...baseline(), kind: 'declarative-theme' })
  })

  it('name 长度与控制字符', () => {
    expectCodes({ ...baseline(), name: 'x'.repeat(81) }, ['too-long'])
    expectCodes({ ...baseline(), name: 'bad\u0000name' }, ['wrong-type'])
    expectValid({ ...baseline(), name: 'x'.repeat(80) })
  })

  it('platforms 非空、去重、表内', () => {
    expectCodes({ ...baseline(), platforms: [] }, ['empty-list'])
    expectCodes({ ...baseline(), platforms: ['win32', 'win32'] }, ['duplicate-entry'])
    expectCodes({ ...baseline(), platforms: ['solaris'] }, ['unknown-platform'])
    expectCodes({ ...baseline(), platforms: 'win32' }, ['empty-list'])
  })

  it('entries 路径禁止逃逸与绝对路径', () => {
    const escapes = [
      '../outside.js',
      '/etc/passwd.js',
      'a/../../b.js',
      'C:/win.js',
      'dir\\file.js',
      'dist/service.ts',
      'dist/service',
      './service.js',
      'a//b.js',
      '%2e%2e/escape.js',
    ]
    for (const entry of escapes) {
      expectCodes({ ...baseline(), entries: { service: entry } }, ['path-escape'])
    }
    expectValid({ ...baseline(), entries: { service: 'dist/service.mjs' } })
    expectValid({ ...baseline(), entries: { ui: 'dist/nested/ui.cjs' } })
  })

  it('entries 至少要有一项，且不能两项都缺', () => {
    expectCodes({ ...baseline(), entries: {} }, ['empty-list'])
    expectCodes({ ...baseline(), entries: { other: 'x.js' } }, ['empty-list'])
    expectValid({ ...baseline(), entries: { service: 'a.js', ui: 'b.js' } })
  })

  it('dependencies 结构、自依赖与去重', () => {
    const bad = [
      [{ id: 'yfe.other', range: 'nope' }],
      [{ id: 'Bad.Id', range: '^1.0.0' }],
      [{ id: 'yfe.other' }],
      ['yfe.other'],
      [{ id: 'yfe.builtin.outline', range: '^1.0.0' }], // 自依赖
      [
        { id: 'yfe.other', range: '^1.0.0' },
        { id: 'yfe.other', range: '^1.0.0' },
      ],
    ]
    expectCodes({ ...baseline(), dependencies: bad[0] }, ['malformed-range'])
    expectCodes({ ...baseline(), dependencies: bad[1] }, ['malformed-id'])
    expectCodes({ ...baseline(), dependencies: bad[2] }, ['malformed-range'])
    expectCodes({ ...baseline(), dependencies: bad[3] }, ['wrong-type'])
    expectCodes({ ...baseline(), dependencies: bad[4] }, ['self-dependency'])
    expectCodes({ ...baseline(), dependencies: bad[5] }, ['duplicate-entry'])
    expectCodes({ ...baseline(), dependencies: {} }, ['wrong-type'])
  })

  it('requiredServices 必须是标识符且去重', () => {
    expectCodes({ ...baseline(), requiredServices: ['1bad'] }, ['wrong-type'])
    expectCodes({ ...baseline(), requiredServices: ['ok', 'ok'] }, ['duplicate-entry'])
    expectCodes({ ...baseline(), requiredServices: ['has space'] }, ['wrong-type'])
    expectCodes({ ...baseline(), requiredServices: 'x' }, ['wrong-type'])
    expectValid({ ...baseline(), requiredServices: ['a', 'bC1'] })
  })

  it('permissions 必须显式给出且能力已知、去重', () => {
    // 显式 undefined 等价于缺字段（JSON 里也不会出现），报 missing-field
    expectCodes({ ...baseline(), permissions: undefined }, ['missing-field'])
    expectCodes({ ...baseline(), permissions: ['plugin.nope'] }, ['unknown-capability'])
    expectCodes(
      { ...baseline(), permissions: ['plugin.data.read', 'plugin.data.read'] },
      ['duplicate-entry'],
    )
    expectCodes({ ...baseline(), permissions: 'plugin.data.read' }, ['wrong-type'])
    expectValid({ ...baseline(), permissions: ['host.process.spawn'] })
  })

  it('contributes 必须是数组、id 合法、去重', () => {
    expectCodes({ ...baseline(), contributes: { panels: 'x' } }, ['wrong-type'])
    expectCodes({ ...baseline(), contributes: { panels: ['ok', 'ok'] } }, ['duplicate-entry'])
    expectCodes({ ...baseline(), contributes: { commands: ['has space'] } }, ['malformed-id'])
    expectCodes({ ...baseline(), contributes: [] }, ['wrong-type'])
  })

  it('dataSchemaVersion 必须是 ≥1 的整数', () => {
    for (const value of [0, -1, 1.5, '1', null]) {
      expectCodes({ ...baseline(), dataSchemaVersion: value }, ['out-of-range'])
    }
    expectValid({ ...baseline(), dataSchemaVersion: 7 })
  })

  it('configSchema 必须是对象', () => {
    expectCodes({ ...baseline(), configSchema: 'nope' }, ['wrong-type'])
    expectCodes({ ...baseline(), configSchema: [] }, ['wrong-type'])
    expectCodes({ ...baseline(), configSchema: null }, ['wrong-type'])
  })
})

describe('validatePluginManifest —— 收集全部问题', () => {
  it('多处错误一次性全部报出，且 path 可定位', () => {
    const issues = expectInvalid({
      id: 'BAD',
      name: '',
      version: 'x',
      manifestVersion: 99,
      hostApiRange: '???',
      kind: 'nope',
      platforms: ['solaris'],
      entries: { service: '../x.js' },
      permissions: ['plugin.nope'],
      dataSchemaVersion: 0,
    })
    const codes = new Set(issues.map((issue) => issue.code))
    expect(codes.has('malformed-id')).toBe(true)
    expect(codes.has('malformed-version')).toBe(true)
    expect(codes.has('manifest-version-unsupported')).toBe(true)
    expect(codes.has('malformed-range')).toBe(true)
    expect(codes.has('unknown-kind')).toBe(true)
    expect(codes.has('unknown-platform')).toBe(true)
    expect(codes.has('path-escape')).toBe(true)
    expect(codes.has('unknown-capability')).toBe(true)
    expect(codes.has('out-of-range')).toBe(true)
    expect(issues.length).toBeGreaterThanOrEqual(9)
    expect(issues.every((issue) => issue.message.length > 0)).toBe(true)
  })

  it('summarizeManifestIssues 只产出标量（ErrorPayload.detail 约束）', () => {
    const issues = expectInvalid({ id: 'BAD' })
    const summary = summarizeManifestIssues(issues)
    for (const value of Object.values(summary)) {
      expect(['string', 'number', 'boolean'].includes(typeof value) || value === null).toBe(true)
    }
    expect(summary['reason']).toBe('manifest-invalid')
    expect(summary['issueCount']).toBe(issues.length)
    expect(String(summary['issueCodes'])).toContain('malformed-id')
  })

  it('空 issue 列表也不炸（防御性）', () => {
    const summary = summarizeManifestIssues([])
    expect(summary['issueCount']).toBe(0)
    expect(summary['firstPath']).toBeUndefined()
  })
})

describe('semver 子集', () => {
  it('parseSemver', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: '' })
    expect(parseSemver('1.2.3-rc.1')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: 'rc.1' })
    expect(parseSemver('1.2.3+build')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: '' })
    expect(parseSemver('1.2')).toBeNull()
    expect(parseSemver('1.2.3.4')).toBeNull()
    expect(parseSemver(123)).toBeNull()
    expect(parseSemver(undefined)).toBeNull()
  })

  it('satisfiesRange：caret', () => {
    expect(satisfiesRange('1.0.0', '^1.0.0')).toBe(true)
    expect(satisfiesRange('1.9.9', '^1.0.0')).toBe(true)
    expect(satisfiesRange('2.0.0', '^1.0.0')).toBe(false)
    expect(satisfiesRange('0.2.3', '^0.2.0')).toBe(true)
    expect(satisfiesRange('0.3.0', '^0.2.0')).toBe(false)
    expect(satisfiesRange('0.0.4', '^0.0.3')).toBe(false)
  })

  it('satisfiesRange：tilde / 比较符 / 合取 / 析取', () => {
    expect(satisfiesRange('1.2.5', '~1.2.0')).toBe(true)
    expect(satisfiesRange('1.3.0', '~1.2.0')).toBe(false)
    expect(satisfiesRange('1.2.9', '~1.2')).toBe(true)
    expect(satisfiesRange('1.5.0', '>=1.0.0 <2.0.0')).toBe(true)
    expect(satisfiesRange('2.0.0', '>=1.0.0 <2.0.0')).toBe(false)
    expect(satisfiesRange('3.0.0', '1.0.0 || >=3.0.0')).toBe(true)
    expect(satisfiesRange('2.0.0', '1.0.0 || >=3.0.0')).toBe(false)
    expect(satisfiesRange('1.0.0', '*')).toBe(true)
    expect(satisfiesRange('9.9.9', '')).toBe(false)
  })

  it('satisfiesRange：通配段 1.x / 1.2.x', () => {
    expect(satisfiesRange('1.0.0', '1.x')).toBe(true)
    expect(satisfiesRange('1.9.9', '1.x')).toBe(true)
    expect(satisfiesRange('2.0.0', '1.x')).toBe(false)
    expect(satisfiesRange('1.2.5', '1.2.x')).toBe(true)
    expect(satisfiesRange('1.3.0', '1.2.x')).toBe(false)
    expect(satisfiesRange('4.0.0', 'x')).toBe(true)
    expect(satisfiesRange('4.0.0', '*')).toBe(true)
  })

  it('satisfiesRange：预发布版小于同号正式版', () => {
    expect(satisfiesRange('1.0.0-rc.11', '<1.0.0')).toBe(true)
    expect(satisfiesRange('1.0.0-rc.11', '^1.0.0')).toBe(false)
    expect(satisfiesRange('1.0.0-rc.11', '>=1.0.0-rc.1')).toBe(true)
  })

  it('satisfiesRange：非法输入一律 false，不抛错', () => {
    expect(satisfiesRange('nope', '^1.0.0')).toBe(false)
    expect(satisfiesRange('1.0.0', 'nope')).toBe(false)
    expect(satisfiesRange('1.0.0', '^^1.0.0')).toBe(false)
  })

  it('空或非法 OR 分支不能绕过宿主版本检查', () => {
    for (const range of ['^1.0.0 ||', '|| ^1.0.0', '^1.0.0 || || ^2.0.0', '^1.0.0 || nope']) {
      expect(isValidRange(range)).toBe(false)
      expect(satisfiesRange('9.9.9', range)).toBe(false)
      expect(satisfiesRange('1.0.0', range)).toBe(false)
      expectInvalid({ ...baseline(), hostApiRange: range })
    }
  })

  it('预发布数字段按数值、长度及数字优先规则比较', () => {
    expect(satisfiesRange('1.0.0-rc.10', '>1.0.0-rc.2')).toBe(true)
    expect(satisfiesRange('1.0.0-rc.2', '>1.0.0-rc.10')).toBe(false)
    expect(satisfiesRange('1.0.0-rc.1', '<1.0.0-rc.1.0')).toBe(true)
    expect(satisfiesRange('1.0.0-1', '<1.0.0-alpha')).toBe(true)
    expect(satisfiesRange('1.0.0-rc.100000000000000000001', '>1.0.0-rc.100000000000000000000')).toBe(true)
  })

  it('isValidRange', () => {
    expect(isValidRange('^1.0.0')).toBe(true)
    expect(isValidRange('1.x')).toBe(true)
    expect(isValidRange('')).toBe(false)
    expect(isValidRange('   ')).toBe(false)
    expect(isValidRange(1)).toBe(false)
    expect(isValidRange('not-a-range')).toBe(false)
    expect(isValidRange('^1.0.0 || nope')).toBe(false)
  })
})
