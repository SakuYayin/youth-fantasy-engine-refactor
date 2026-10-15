/**
 * 存储路径派生与校验：`src/storage/paths.ts` 的单测。
 *
 * 这一层是"用户输入 → 文件系统路径"的唯一通道，所以判据不是"正常键能过"，
 * 而是**坏键必须抛错**，而且抛错之后**根目录之外不能多出任何文件**——
 * 后面那条才是真正防住路径穿越的证据（只看抛异常，等于只信了一半）。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  MAX_PART_NUMBER,
  MAX_RELATIVE_KEY_LENGTH,
  MAX_SEGMENT_LENGTH,
  StoragePathError,
  assertStorageRoot,
  contentAddressedKey,
  isSha256Hex,
  isWithinRoot,
  joinKey,
  normalizeRelativeKey,
  objectRelativeKey,
  parsePartNumber,
  partFileName,
  requireIdSegment,
  resolveUnderRoot,
  stagingDirKey,
  stagingPartKey,
  storageRootFromDataDir,
} from '../src/storage/paths.js'

const SHA = 'a1b2c3d4'.repeat(8) // 64 位小写 hex

const scratch = mkdtempSync(join(tmpdir(), 'yfe-paths-test-'))
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('normalizeRelativeKey：正常相对键', () => {
  it('透传并规范化 `/` 分隔的相对键', () => {
    expect(normalizeRelativeKey('a/b/c.txt')).toBe('a/b/c.txt')
    expect(normalizeRelativeKey('staging/ws_1/upl_1/part-0000000000')).toBe(
      'staging/ws_1/upl_1/part-0000000000',
    )
    // Windows 客户端给的 `\` 一律规范化成 `/`，下游只处理一种分隔符。
    expect(normalizeRelativeKey('a\\b\\c.txt')).toBe('a/b/c.txt')
    expect(normalizeRelativeKey('objects/sha256/ab/cd/' + SHA)).toBe(
      'objects/sha256/ab/cd/' + SHA,
    )
  })

  it('拒绝一切会让路径跑出根目录、或落到别的卷/设备上的写法', () => {
    const hostile = [
      '..',
      '../escape.bin',
      'a/../../escape.bin',
      '/etc/passwd',
      '/',
      '\\\\server\\share\\evil.bin',
      '//server/share/evil.bin',
      'C:\\Windows\\System32\\evil.dll',
      'c:/windows/evil.dll',
      'bad\0name.bin',
      'a/\0/b',
      'a\tb',
      'a\nb',
      'a/b\ra',
      'objects/con',
      'objects/nul.bin',
      'objects/COM1',
      'a/b.',
      'a/b ',
      'a//b',
      './a/b',
      'a/./b',
      '',
    ]
    for (const key of hostile) {
      expect(() => normalizeRelativeKey(key), JSON.stringify(key)).toThrow(StoragePathError)
    }
  })

  it('非字符串、超长段、超长键都拒绝', () => {
    expect(() => normalizeRelativeKey(undefined as unknown as string)).toThrow(StoragePathError)
    expect(() => normalizeRelativeKey(42 as unknown as string)).toThrow(StoragePathError)
    expect(() => normalizeRelativeKey(`a/${'b'.repeat(MAX_SEGMENT_LENGTH + 1)}`)).toThrow(
      StoragePathError,
    )
    const tooLong = Array.from({ length: 12 }, () => 'x'.repeat(200)).join('/')
    expect(tooLong.length).toBeGreaterThan(MAX_RELATIVE_KEY_LENGTH)
    expect(() => normalizeRelativeKey(tooLong)).toThrow(StoragePathError)
    // 段长上限内的长键仍然合格（证明拒绝的是"超限"而不是"长"）。
    expect(normalizeRelativeKey('x'.repeat(MAX_SEGMENT_LENGTH))).toBe('x'.repeat(MAX_SEGMENT_LENGTH))
  })

  it('错误信息里不带原始输入、也不带绝对路径', () => {
    let thrown: unknown = null
    try {
      normalizeRelativeKey('../../etc/passwd', 'storage_key')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(StoragePathError)
    const error = thrown as StoragePathError
    expect(error.reason).toBe('parent_segment')
    expect(error.field).toBe('storage_key')
    // 原始输入与本地绝对路径都不能借错误信息外泄。
    expect(error.message).not.toContain('passwd')
    expect(error.message).not.toContain(scratch)
  })
})

describe('assertStorageRoot / storageRootFromDataDir', () => {
  it('只接受绝对路径的根', () => {
    const root = join(scratch, 'assets')
    expect(assertStorageRoot(root)).toBe(resolve(root))
    expect(() => assertStorageRoot('relative/assets')).toThrow(StoragePathError)
    expect(() => assertStorageRoot('')).toThrow(StoragePathError)
    expect(() => assertStorageRoot(`${root}\0`)).toThrow(StoragePathError)
  })

  it('存储根由 dataDir 派生（注入配置，不硬编码）', () => {
    expect(storageRootFromDataDir(join(scratch, 'data'))).toBe(resolve(join(scratch, 'data', 'assets')))
  })
})

describe('isWithinRoot', () => {
  it('前缀相同的兄弟目录不算"在根内"', () => {
    const root = join(scratch, 'assets')
    expect(isWithinRoot(root, join(root, 'objects', 'x'))).toBe(true)
    expect(isWithinRoot(root, root)).toBe(true)
    expect(isWithinRoot(root, resolve(root, '..', 'elsewhere'))).toBe(false)
    expect(isWithinRoot(root, resolve(root, '..', 'assets-evil', 'x'))).toBe(false)
  })
})

describe('resolveUnderRoot：唯一的"键 → 绝对路径"通道', () => {
  it('正常键落在根内', () => {
    const root = join(scratch, 'assets')
    mkdirSync(root, { recursive: true })
    const resolved = resolveUnderRoot(root, 'staging/ws_1/upl_1/part-0000000000')
    expect(resolved).toBe(join(root, 'staging', 'ws_1', 'upl_1', 'part-0000000000'))
    expect(isWithinRoot(root, resolved)).toBe(true)
  })

  it('根目录本身不是合法键', () => {
    const root = join(scratch, 'assets')
    expect(() => resolveUnderRoot(root, '')).toThrow(StoragePathError)
  })

  it('逃逸键全部被拒，且根目录之外不会创建任何文件', () => {
    const root = join(scratch, 'assets')
    const outside = resolve(root, '..', '..', '..', 'yfe-escape-probe')
    mkdirSync(root, { recursive: true })
    const before = readdirSync(resolve(root, '..')).sort()
    expect(existsSync(outside)).toBe(false)

    const hostileKeys = [
      '../yfe-escape-probe/evil.bin',
      '../../yfe-escape-probe/evil.bin',
      '../../../yfe-escape-probe/evil.bin',
      '..\\..\\..\\yfe-escape-probe\\evil.bin',
      'objects/../../../yfe-escape-probe/evil.bin',
      'staging/ws_1/upl_1/../../../../yfe-escape-probe/evil.bin',
      '/yfe-escape-probe/evil.bin',
      'C:\\yfe-escape-probe\\evil.bin',
      '\\\\server\\share\\evil.bin',
      'bad\0.bin',
    ]
    for (const key of hostileKeys) {
      expect(() => resolveUnderRoot(root, key), key).toThrow(StoragePathError)
    }

    expect(existsSync(outside)).toBe(false)
    // 根目录外一个文件都不许多：既没有探针目录，也没有任何新条目。
    expect(readdirSync(resolve(root, '..')).sort()).toEqual(before)
  })
})

describe('内容寻址键', () => {
  it('storage_key 形如 sha256/<前2>/<次2>/<hex>', () => {
    expect(isSha256Hex(SHA)).toBe(true)
    expect(contentAddressedKey(SHA)).toBe(`sha256/${SHA.slice(0, 2)}/${SHA.slice(2, 4)}/${SHA}`)
    // 对象目录是"根下 objects/ + storage_key"，不是另一套前缀。
    expect(objectRelativeKey(contentAddressedKey(SHA))).toBe(
      `objects/sha256/${SHA.slice(0, 2)}/${SHA.slice(2, 4)}/${SHA}`,
    )
  })

  it('不是 64 位小写 hex 的一律拒绝', () => {
    expect(isSha256Hex(SHA.toUpperCase())).toBe(false)
    expect(isSha256Hex(SHA.slice(0, 63))).toBe(false)
    expect(isSha256Hex(`${SHA}a`)).toBe(false)
    expect(isSha256Hex('z'.repeat(64))).toBe(false)
    for (const bad of [SHA.toUpperCase(), SHA.slice(0, 63), 'z'.repeat(64), '']) {
      expect(() => contentAddressedKey(bad), bad).toThrow(StoragePathError)
    }
  })
})

describe('暂存目录与分片文件名', () => {
  it('暂存键由 workspaceId / uploadId 派生并做 id 校验', () => {
    expect(stagingDirKey('ws_1', 'upl_1')).toBe('staging/ws_1/upl_1')
    expect(stagingPartKey(stagingDirKey('ws_1', 'upl_1'), 7)).toBe(
      'staging/ws_1/upl_1/part-0000000007',
    )
    expect(() => stagingDirKey('../etc', 'upl_1')).toThrow(StoragePathError)
    expect(() => stagingDirKey('ws_1', 'upl_1/../../x')).toThrow(StoragePathError)
    expect(() => requireIdSegment('bad id', 'workspaceId')).toThrow(StoragePathError)
  })

  it('分片文件名是定宽十进制，超出上限拒绝', () => {
    expect(partFileName(0)).toBe('part-0000000000')
    expect(partFileName(123)).toBe('part-0000000123')
    expect(() => partFileName(MAX_PART_NUMBER + 1)).toThrow(StoragePathError)
    expect(() => partFileName(-1)).toThrow(StoragePathError)
    expect(() => partFileName(1.5)).toThrow(StoragePathError)
  })

  it('parsePartNumber 只认十进制非负整数', () => {
    expect(parsePartNumber('0')).toBe(0)
    expect(parsePartNumber('10')).toBe(10)
    expect(parsePartNumber('007')).toBe(7)
    for (const bad of ['', '-1', '+1', '1.0', '1x', 'x1', ' 1', '1 ', '1'.repeat(11), '.', '..']) {
      expect(parsePartNumber(bad), JSON.stringify(bad)).toBeNull()
    }
    expect(parsePartNumber(1 as unknown)).toBeNull()
    expect(parsePartNumber(undefined)).toBeNull()
  })

  it('joinKey 逐段校验', () => {
    expect(joinKey('objects', 'a', 'b')).toBe('objects/a/b')
    expect(() => joinKey('objects', '..', 'b')).toThrow(StoragePathError)
  })
})
