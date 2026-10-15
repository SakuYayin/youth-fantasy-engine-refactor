import { mkdirSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'

import { errorCodeOfReadFailure } from '../../src/inventory.js'
import {
  defaultLocation,
  existsAsDirectory,
  existsAsFile,
  failMissingStore,
  fileStamp,
  kindOfFsError,
  readJsonFileStrict,
  readTextFileStrict,
  recordsOfContainer,
  rowsOfRecordMap,
  sortNames,
} from '../../src/readers/internal.js'
import {
  catchReadError,
  makeTmpDir,
  removeTmpDir,
  snapshotTree,
  writeJsonFile,
  writeRawFile,
} from './_support.js'

const dirs: string[] = []
function tmp(prefix: string): string {
  const dir = makeTmpDir(prefix)
  dirs.push(dir)
  return dir
}
afterEach(() => {
  let dir = dirs.pop()
  while (dir !== undefined) {
    removeTmpDir(dir)
    dir = dirs.pop()
  }
})

function fsError(code: string): Error {
  return Object.assign(new Error(`模拟 ${code}`), { code })
}

describe('readers/internal（读取器底座）', () => {
  it('kindOfFsError：Node errno → 本包失败形态（不自造码）', () => {
    expect(kindOfFsError(fsError('ENOENT'))).toBe('not-found')
    expect(kindOfFsError(fsError('ENOTDIR'))).toBe('not-found')
    expect(kindOfFsError(fsError('EACCES'))).toBe('permission-denied')
    expect(kindOfFsError(fsError('EPERM'))).toBe('permission-denied')
    expect(kindOfFsError(fsError('EISDIR'))).toBe('decode-failed')
    expect(kindOfFsError(fsError('EMFILE'))).toBe('unknown')
    expect(kindOfFsError(new Error('没有 code'))).toBe('unknown')
    expect(kindOfFsError('字符串')).toBe('unknown')
    expect(kindOfFsError(null)).toBe('unknown')
    // 形态 → 契约码（本地通道）
    expect(errorCodeOfReadFailure('permission-denied', 'local')).toBe('PERMISSION_DENIED')
    expect(errorCodeOfReadFailure('decode-failed', 'local')).toBe('STORAGE_CORRUPT')
  })

  it('sortNames 用 localeCompare；rowsOfRecordMap 稳定排序（整数键不靠插入序）', () => {
    expect(sortNames(['b', 'a', 'a'])).toEqual(['a', 'a', 'b'])
    // 跨文字的先后由 ICU 排序规则决定（zh 里中文排在拉丁字母前），所以这里只钉「确定性」：
    const names = ['项目', 'a', 'b', '中文', 'z', '10', '2']
    expect(sortNames(names)).toEqual(sortNames([...names].reverse()))
    // JS 对象的整数键本来就保不住插入序，所以统一按主键排序：
    const map = { '10': { id: '10' }, '2': { id: '2' }, 'a': { id: 'a' } }
    expect(rowsOfRecordMap(map)).toEqual([{ id: '10' }, { id: '2' }, { id: 'a' }])
    expect(rowsOfRecordMap(map)).toEqual(rowsOfRecordMap(map))
  })

  it('recordsOfContainer：null/undefined → 0 条；数组原样；对象排序；标量 → decode-failed', () => {
    expect(recordsOfContainer(null, 'x')).toEqual([])
    expect(recordsOfContainer(undefined, 'x')).toEqual([])
    const array = [{ id: 'b' }, { id: 'a' }]
    expect(recordsOfContainer(array, 'x')).toBe(array)
    expect(recordsOfContainer({ b: { id: 'b' }, a: { id: 'a' } }, 'x')).toEqual([{ id: 'a' }, { id: 'b' }])
    const error = catchReadError(() => recordsOfContainer('oops', 'x'))
    expect(error.kind).toBe('decode-failed')
    expect(error.location).toBe('x')
  })

  it('failMissingStore → store-missing，location 拼上 store 名', () => {
    const error = catchReadError(() => failMissingStore('projects', '可用数据/blobs'))
    expect(error.kind).toBe('store-missing')
    expect(error.location).toBe('可用数据/blobs/projects')
    expect(errorCodeOfReadFailure(error.kind, error.origin)).toBe('NOT_FOUND')
  })

  it('defaultLocation 只取 basename（R-03：绝不写绝对路径）', () => {
    expect(defaultLocation('C:\\Users\\me\\青春幻想引擎-data.json')).toBe('青春幻想引擎-data.json')
    expect(defaultLocation('/home/me/blobs/')).toBe('blobs')
    expect(defaultLocation('plain.json')).toBe('plain.json')
  })

  it('readTextFileStrict：剥 BOM、缺文件 → not-found、目录 → decode-failed', () => {
    const dir = tmp('internal')
    const bom = writeRawFile(`${dir}/bom.json`, '\uFEFF{"a": 1}')
    expect(readTextFileStrict(bom, 'bom.json')).toBe('{"a": 1}')

    const missing = catchReadError(() => readTextFileStrict(`${dir}/nope.json`, 'nope.json'))
    expect(missing.kind).toBe('not-found')

    mkdirSync(`${dir}/as-dir.json`, { recursive: true })
    const dirError = catchReadError(() => readTextFileStrict(`${dir}/as-dir.json`, 'as-dir.json'))
    expect(dirError.kind).toBe('decode-failed')
    expect(dirError.causeText).toContain('EISDIR')
  })

  it('readJsonFileStrict：空文件 → decode-failed；合法空容器 → 解析成功', () => {
    const dir = tmp('internal')
    expect(catchReadError(() => readJsonFileStrict(writeRawFile(`${dir}/zero.json`, ''), 'zero.json')).kind).toBe(
      'decode-failed',
    )
    expect(catchReadError(() => readJsonFileStrict(writeRawFile(`${dir}/blank.json`, '  \n\t '), 'blank.json')).kind).toBe(
      'decode-failed',
    )
    expect(readJsonFileStrict(writeJsonFile(`${dir}/ok.json`, {}), 'ok.json')).toEqual({})
  })

  it('existsAsFile / existsAsDirectory / fileStamp 的存在性语义', () => {
    const dir = tmp('internal')
    const file = writeJsonFile(`${dir}/a.json`, { a: 1 })
    mkdirSync(`${dir}/store`, { recursive: true })
    expect(existsAsFile(file)).toBe(true)
    expect(existsAsFile(`${dir}/store`)).toBe(false)
    expect(existsAsFile(`${dir}/nope.json`)).toBe(false)
    expect(existsAsDirectory(`${dir}/store`)).toBe(true)
    expect(existsAsDirectory(file)).toBe(false)
    expect(existsAsDirectory(`${dir}/nope`)).toBe(false)

    const stamp = fileStamp(file, 'a.json')
    expect(stamp.bytes).toBeGreaterThan(0)
    expect(Number.isFinite(Date.parse(stamp.modifiedAt))).toBe(true)
    expect(catchReadError(() => fileStamp(`${dir}/nope.json`, 'nope.json')).kind).toBe('not-found')
  })

  it('整个读取器底座不写任何文件（只读证明）', () => {
    const dir = tmp('internal')
    const file = writeJsonFile(`${dir}/a.json`, { a: '中文 🎴' })
    const before = snapshotTree(dir)
    readTextFileStrict(file, 'a.json')
    readJsonFileStrict(file, 'a.json')
    fileStamp(file, 'a.json')
    expect(snapshotTree(dir)).toEqual(before)
  })
})
