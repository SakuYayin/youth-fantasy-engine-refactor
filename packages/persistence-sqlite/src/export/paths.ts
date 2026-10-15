import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** Resolve existing parents as well, so aliases through a directory junction are caught. */
function canonicalPath(path: string): string {
  const absolute = resolve(path)
  const canonical = existsSync(absolute)
    ? realpathSync(absolute)
    : dirname(absolute) === absolute
      ? absolute
      : join(canonicalPath(dirname(absolute)), basename(absolute))
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

/** Includes relative paths, Windows case aliases, junctions and existing hard links. */
export function sameFilePath(left: string, right: string): boolean {
  if (canonicalPath(left) === canonicalPath(right)) return true
  if (!existsSync(left) || !existsSync(right)) return false
  const a = statSync(left)
  const b = statSync(right)
  return a.ino !== 0 && a.dev === b.dev && a.ino === b.ino
}
