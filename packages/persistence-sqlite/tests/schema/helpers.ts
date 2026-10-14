/**
 * 测试辅助：临时目录与库文件。
 *
 * 🔴 本机用户临时目录（`os.tmpdir()`）**不可写**（EPERM），所以所有临时库都必须落在
 *    工作目录内。这里统一放在 `tests/schema/.tmp/` 下，并在 `afterAll` 里清理。
 *    不要改用 `os.tmpdir()`——那会让整个测试文件在启动阶段就失败。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 测试临时根目录（相对本文件）。 */
export const TMP_ROOT = fileURLToPath(new URL('./.tmp/', import.meta.url))

const created: string[] = []

/** 创建一个本次测试独占的临时目录。 */
export function makeTempDir(label: string): string {
  mkdirSync(TMP_ROOT, { recursive: true })
  const dir = mkdtempSync(join(TMP_ROOT, `${label}-`))
  created.push(dir)
  return dir
}

/** 在临时目录里造一个库文件路径（文件本身由 openDatabase 创建）。 */
export function dbPathIn(dir: string, name = 'app.db'): string {
  return join(dir, name)
}

/** 删除本次测试创建的全部临时目录。测试文件在 `afterAll` 里调用。 */
export function cleanupTempDirs(): void {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响断言结果（Windows 上偶发文件占用）。
    }
  }
}
