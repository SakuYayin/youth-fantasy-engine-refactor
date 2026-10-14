/**
 * 引导凭据（bootstrap secret）的读取与校验。
 *
 * 设计依据（`04-后端与安全.md`）："首次启动未初始化；**一次性引导凭据通过仅管理员
 * 可读的秘密文件提供**，日志只提示文件位置，绝不打印秘密值；初始化仅可执行一次，
 * 创建所有者后立即禁用引导路径，公开部署在开放入口前完成初始化"。
 *
 * ## 为什么把它单独成一个模块，而不是散在 setup 路由里
 *
 * 有三个调用方需要它，且它们的失败语义不同：
 * 1. **启动装配**（`src/index.ts`）：文件缺失要打 warning 但不能阻止启动；
 * 2. **`POST /api/v1/setup`**：文件缺失要回 503，凭证错误要回 401；
 * 3. **测试与运维自检**：需要"只检查文件、不读内容"的能力。
 * 把读取逻辑写在路由里会导致启动路径去 import 一个路由模块（循环依赖），
 * 也会让"文件不可用"这件事在不同调用点被写出不同的措辞。
 *
 * ## 为什么用摘要比较而不是直接比字符串
 *
 * 文件里的秘密是**高熵随机值**（32 字节 → 43 个 Base64 字符），因此裸 SHA-256
 * 摘要比较就足够安全——低熵才需要 scrypt+pepper（见 `secrets.ts` 的分层说明）。
 * 但比较**必须恒定时间**：`secrets.ts` 的 `verifyToken` 已经处理了长度短路
 * 与 `timingSafeEqual`，这里直接复用，不再手写一次比较。
 */

import { hashToken, timingSafeEqualString, verifyToken } from './secrets.js'
import { inspectSecretFile } from './secretFile.js'
import type { SecretFileInspection } from './secretFile.js'

/**
 * 引导凭据的最小长度。
 *
 * 与主密钥一致取 32：引导凭据是**服务器被完全接管**的钥匙（它能创建第一个
 * 所有者账号），任何短于 32 字符的值都不该被接受——包括运维手写的"临时密码"。
 * 文档要求生成方式与主密钥相同（密码学随机 + Base64），这里用长度把不合格的
 * 文件挡在启动阶段。
 */
export const BOOTSTRAP_SECRET_MIN_LENGTH = 32

/** 只读地检查引导凭据文件是否可用（不返回内容，供启动路径打日志）。 */
export function inspectBootstrapSecretFile(path: string): SecretFileInspection {
  return inspectSecretFile(path, { minLength: BOOTSTRAP_SECRET_MIN_LENGTH })
}

/** 引导凭据文件位置被记录时的形态：**只有路径与可用性，没有值**。 */
export interface BootstrapSecretStatus {
  readonly path: string | null
  readonly available: boolean
  /** 不可用时的短原因（面向运维日志，不含秘密值）。 */
  readonly reason: string | null
}

export function bootstrapSecretStatus(path: string | null): BootstrapSecretStatus {
  if (path === null) return { path: null, available: false, reason: '未配置引导凭据文件' }
  const inspection = inspectBootstrapSecretFile(path)
  if (!inspection.ok) return { path, available: false, reason: inspection.reason }
  return { path, available: true, reason: null }
}

/**
 * 校验调用方提交的引导凭据。
 *
 * 返回的三态刻意区分"文件坏了"（503，运维修）与"凭据不对"（401，调用方修）：
 * 前者重试一万次也没用，后者才是需要限流与审计的事件。
 */
export type BootstrapVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly unavailable: true; readonly reason: string }
  | { readonly ok: false; readonly unavailable: false }

export function verifyBootstrapSecret(filePath: string | null, presented: string): BootstrapVerification {
  if (filePath === null) {
    return { ok: false, unavailable: true, reason: '未配置引导凭据文件' }
  }
  const inspection = inspectBootstrapSecretFile(filePath)
  if (!inspection.ok) {
    return { ok: false, unavailable: true, reason: inspection.reason }
  }
  const expected = hashToken(inspection.value)
  const actual = hashToken(presented)
  // `verifyToken` 内部用 `timingSafeEqual`；长度不同的情况已被摘要长度抹平。
  if (!verifyToken(presented, expected) || !timingSafeEqualString(actual, expected)) {
    return { ok: false, unavailable: false }
  }
  return { ok: true }
}
