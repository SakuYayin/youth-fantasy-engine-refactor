import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareElectronRuntime } from '../bin/electron-runtime.mjs'

const temporary: string[] = []
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'yfe-runtime-test-'))
  temporary.push(root)
  const source = join(root, 'source')
  mkdirSync(join(source, 'locales'), { recursive: true })
  writeFileSync(join(source, 'electron.exe'), 'fake-executable')
  writeFileSync(join(source, 'locales', 'zh-CN.pak'), '中文资源')
  return { source, binary: join(source, 'electron.exe'), cacheRoot: join(root, 'cache') }
}
describe('Windows Electron 内容缓存', () => {
  it('完整复制中文路径资源，重复启动复用已校验内容', () => {
    const { source, binary, cacheRoot } = fixture()
    const prepared = prepareElectronRuntime(binary, { platform: 'win32', cacheRoot })
    expect(prepared).not.toBe(binary)
    expect(readFileSync(prepared, 'utf8')).toBe('fake-executable')
    expect(readFileSync(join(prepared, '..', 'locales', 'zh-CN.pak'), 'utf8')).toBe('中文资源')
    expect(prepareElectronRuntime(binary, { platform: 'win32', cacheRoot })).toBe(prepared)
    expect(readdirSync(cacheRoot)).toHaveLength(1)
    writeFileSync(join(source, 'locales', 'zh-CN.pak'), '已升级的资源')
    expect(prepareElectronRuntime(binary, { platform: 'win32', cacheRoot })).not.toBe(prepared)
    expect(readFileSync(join(prepared, '..', 'locales', 'zh-CN.pak'), 'utf8')).toBe('中文资源')
  })
  it('拒绝损坏缓存，不静默启动不一致的运行时', () => {
    const { binary, cacheRoot } = fixture()
    const prepared = prepareElectronRuntime(binary, { platform: 'win32', cacheRoot })
    writeFileSync(prepared, 'corrupt')
    expect(() => prepareElectronRuntime(binary, { platform: 'win32', cacheRoot })).toThrow('缓存校验失败')
  })
  it('其他平台直接使用已安装 Electron', () => {
    expect(prepareElectronRuntime('/not-needed/electron', { platform: 'linux' })).toBe('/not-needed/electron')
  })
})
