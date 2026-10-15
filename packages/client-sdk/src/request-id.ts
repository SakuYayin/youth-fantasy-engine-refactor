/**
 * 渲染层本地的请求关联 ID 生成器。
 *
 * 刻意不用 `crypto.randomUUID()`：那是 Web/DOM 能力（本包 `lib` 只有 ES2023，
 * 也明令不得依赖 DOM），而 `node:crypto` 更不允许。
 * 「时间戳 + 进程内计数器」足够唯一，且天然按时间排序，便于日志串联。
 */
import type { RequestId } from '@yfe/contracts'

let sequence = 0

/** 生成一个渲染层本地 requestId（形如 `r1a2b3c4-1f`）。 */
export function newRequestId(): RequestId {
  sequence += 1
  return `r${Date.now().toString(36)}-${sequence.toString(36)}` as RequestId
}
