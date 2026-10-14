/**
 * 秘密文件读取（仅管理员可读的文件，如引导凭据与主密钥）。
 *
 * 设计依据（`04-后端与安全.md` / `09-部署与运维.md`）：
 * - "一次性引导凭据通过**仅管理员可读的秘密文件**提供，日志只提示文件位置，不打印秘密值"；
 * - "/run/secrets 只读、限制宿主权限、不进镜像"；
 * - "秘密优先文件引用，不通过日志或 Web 读接口返回"。
 *
 * ## 为什么这个文件不返回 `Error` 也不抛异常
 *
 * 调用方（启动装配、setup 端点）要做的是**降级**而不是崩溃：
 * 引导凭据文件缺失时服务仍然应该能起来（否则运维连登录页面都拿不到错误信息），
 * 只是 setup 返回 503。因此这里返回一个判别联合，把"为什么不可用"用一个
 * **不含秘密值**的短原因串带回给日志。
 *
 * ## 权限检查为什么跳过 Windows
 *
 * POSIX 上 `st_mode & 0o077` 能可靠表达"除所有者外无人可读"。Windows 的
 * ACL 无法用 `st_mode` 表达（Node 在 win32 上恒返回 0o666 或只读位），
 * 强行检查只会把每个 Windows 开发环境都判成不安全。因此 win32 上
 * `permissionsVerified: false`——**如实标注"没验证过"**，而不是假装验证通过。
 * 生产部署（Linux 容器）仍然走完整检查。
 */

import { readFileSync, statSync } from 'node:fs'

/** 秘密文件大小上限。一个 32 字节的 Base64 秘密是 44 个字符，4 KiB 已经极宽松。 */
export const SECRET_FILE_MAX_BYTES = 4096

export type SecretFileInspection =
  | {
      readonly ok: true
      readonly value: string
      /** 是否真的校验了文件权限。win32 上恒为 `false`（见文件头说明）。 */
      readonly permissionsVerified: boolean
    }
  | {
      readonly ok: false
      /** 面向运维日志的短原因。**绝不含秘密值、绝不含绝对路径之外的敏感信息**。 */
      readonly reason: string
    }

export interface InspectSecretFileOptions {
  /** 注入平台以便测试 POSIX 分支（默认 `process.platform`）。 */
  readonly platform?: NodeJS.Platform
  /** 内容最小长度。太短的秘密等于没有秘密，必须由调用方按用途给定。 */
  readonly minLength?: number
  /** 内容最大长度。 */
  readonly maxLength?: number
}

/**
 * 读取并校验一个秘密文件。
 *
 * 失败原因刻意区分到"可运维"的粒度（不存在 / 不是普通文件 / 权限过宽 / 太短），
 * 因为运维看到的原因直接决定他下一步做什么；但任何一条都不会回显文件内容。
 */
export function inspectSecretFile(
  path: string,
  options: InspectSecretFileOptions = {},
): SecretFileInspection {
  const platform = options.platform ?? process.platform
  const minLength = options.minLength ?? 1
  const maxLength = options.maxLength ?? SECRET_FILE_MAX_BYTES

  let stats
  try {
    stats = statSync(path)
  } catch {
    return { ok: false, reason: '文件不存在或不可访问' }
  }
  if (!stats.isFile()) {
    return { ok: false, reason: '不是普通文件（目录、符号链接目标或设备文件都不接受）' }
  }
  if (stats.size > SECRET_FILE_MAX_BYTES) {
    return { ok: false, reason: `文件超过 ${SECRET_FILE_MAX_BYTES} 字节上限` }
  }

  let permissionsVerified = false
  if (platform !== 'win32') {
    // 0o077 覆盖 group/other 的所有位：只要有任意一位可读/可写/可执行就不合格。
    // 这是刻意的"宁严勿宽"——秘密文件没有需要 group 读的合法场景。
    if ((stats.mode & 0o077) !== 0) {
      return { ok: false, reason: '文件权限过宽：要求仅所有者可读（chmod 600）' }
    }
    permissionsVerified = true
  }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { ok: false, reason: '文件存在但读取失败' }
  }

  // 文件末尾的换行是编辑器强加给用户的，不是秘密的一部分；内部的换行则是错误。
  const value = raw.trim()
  if (value.length === 0) return { ok: false, reason: '文件内容为空' }
  if (value.length < minLength) {
    return { ok: false, reason: `内容过短：要求至少 ${minLength} 个字符` }
  }
  if (value.length > maxLength) {
    return { ok: false, reason: `内容过长：上限 ${maxLength} 个字符` }
  }
  if (/[\r\n]/.test(value)) {
    return { ok: false, reason: '内容包含换行：秘密必须是单行值' }
  }
  return { ok: true, value, permissionsVerified }
}

/** 只读地取文件权限位，供运维日志展示（不含内容）。 */
export function secretFileMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777
  } catch {
    return null
  }
}
