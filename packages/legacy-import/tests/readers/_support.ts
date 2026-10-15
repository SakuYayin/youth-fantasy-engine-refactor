/**
 * readers 测试的公共夹具。
 *
 * 为什么用**真实临时目录**而不是内存 fs 桩：这一层的全部风险都在「真文件系统的行为」
 * （ENOENT / EISDIR / BOM / 0 字节 / 目录混文件），用桩替换掉 fs 就等于把要测的东西测没了。
 * 目录一律建在 `tests/readers/.tmp/` 下（本机 `os.tmpdir()` EPERM，见 `tests/helpers.ts`），
 * 每个用例自己创建、`afterEach` 清干净——不能给 `git status` 留下任何东西。
 */

import { createCipheriv, pbkdf2Sync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LegacyReadError } from '../../src/index.js'

/** `tests/readers/` 的绝对路径（用 `fileURLToPath`，不用 `import.meta.dirname`）。 */
export const READERS_TESTS_DIR = fileURLToPath(new URL('.', import.meta.url))

/** 所有夹具的根（`.tmp`，每次用完删光）。 */
export const TMP_ROOT = join(READERS_TESTS_DIR, '.tmp')

/** 建一个唯一的临时目录（`<prefix>-XXXXXX`）。 */
export function makeTmpDir(prefix: string): string {
  mkdirSync(TMP_ROOT, { recursive: true })
  return mkdtempSync(join(TMP_ROOT, `${prefix}-`))
}

/** 删掉临时目录（幂等）。 */
export function removeTmpDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** 写一个文本文件（自动建父目录）。 */
export function writeRawFile(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return path
}

/** 写一个 JSON 文件（自动建父目录）。 */
export function writeJsonFile(path: string, value: unknown): string {
  return writeRawFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** 断言调用**抛** `LegacyReadError`，并把错误交回给断言。 */
export function catchReadError(body: () => unknown): LegacyReadError {
  try {
    body()
  } catch (error) {
    if (error instanceof LegacyReadError) return error
    throw error
  }
  throw new Error('预期读取失败（抛 LegacyReadError），但调用没有抛')
}

/** 目录树快照（相对路径 + 字节数 + mtime），用于「只读证明」。 */
export interface TreeEntry {
  readonly path: string
  readonly bytes: number
  readonly mtimeMs: number
}

function toRelative(root: string, full: string): string {
  return relative(root, full).split(sep).join('/')
}

function walkTree(root: string, dir: string, out: TreeEntry[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    const stat = statSync(full)
    out.push({
      path: entry.isDirectory() ? `${toRelative(root, full)}/` : toRelative(root, full),
      bytes: entry.isDirectory() ? -1 : stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
    })
    if (entry.isDirectory()) walkTree(root, full, out)
  }
}

/** 递归快照一个目录（按路径排序，含 mtime）。 */
export function snapshotTree(dir: string): readonly TreeEntry[] {
  const out: TreeEntry[] = []
  walkTree(dir, dir, out)
  return out
}

// ---------------------------------------------------------------------------
// `.yfe` 同步文件夹具：按 upstream 的算法**独立**封一份（不 import 被测代码）
// ---------------------------------------------------------------------------

/** 上游 PBKDF2 盐与迭代次数（`upstream/src/lib/sync/syncCore.ts:178`、`:201`）。 */
const SYNC_SALT = 'yfe-cloud-sync-v1'
const PBKDF2_ITERATIONS = 100_000

/** 上游 `x1:` XOR 混淆的 keystream（`syncCore.ts:210-219`）。 */
function xorKeystream(code: string): Uint8Array {
  const seed = Buffer.from(`${code}::yfe-sync`, 'utf8')
  const key = new Uint8Array(256)
  for (let i = 0; i < 256; i += 1) {
    const byte = seed[i % seed.length] ?? 0
    key[i] = (byte ^ ((i * 167) & 0xff) ^ ((i >>> 3) & 0xff)) & 0xff
  }
  return key
}

/** 封一份 `a1:` AES-GCM 载荷（IV 12 字节 + 密文 + 16 字节认证标签，再 base64）。 */
export function sealAesPayload(payload: unknown, code: string, ivByte = 7): string {
  const iv = Buffer.alloc(12, ivByte)
  const key = pbkdf2Sync(code, SYNC_SALT, PBKDF2_ITERATIONS, 32, 'sha256')
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return `a1:${Buffer.concat([iv, body, tag]).toString('base64')}`
}

/** 封一份 `x1:` XOR 混淆载荷。 */
export function sealXorPayload(payload: unknown, code: string): string {
  const data = Buffer.from(JSON.stringify(payload), 'utf8')
  const key = xorKeystream(code)
  const out = Buffer.alloc(data.length)
  for (let i = 0; i < data.length; i += 1) out[i] = (data[i] ?? 0) ^ (key[i & 0xff] ?? 0)
  return `x1:${out.toString('base64')}`
}

/** 写一个 `.yfe` 文件（外层 `{ rev, enc }`，`syncTransport.ts:377`）。 */
export function writeSyncFile(path: string, rev: number, enc: string | null): string {
  return writeRawFile(path, `${JSON.stringify({ rev, enc }, null, 2)}\n`)
}
