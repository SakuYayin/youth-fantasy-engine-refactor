/**
 * 请求级幂等。
 *
 * 为什么这一层必须在**应用用例层**：
 * - 契约与 `07-同步协议与API.md` 都要求「请求确认丢失后，重复提交相同 opId 返回原结果」；
 * - 但 `@yfe/persistence-sqlite` 的 `saveDraft` **完全没有读 `context.idempotencyKey`**
 *   （它只处理「同 `draftSequence` 重放」），所以请求级幂等没有别的落点；
 * - 幂等记录必须持久化才跨进程有效，于是它被建模为端口 {@link IdempotencyPort}，
 *   由适配器落库（`operations.op_id` 或一张专用表）。
 *
 * 失败处理口径（与「不得吞掉失败的持久化调用」一致）：
 * - `find` 抛异常 → 直接失败。宁可让调用方重试，也不在无法证明幂等时重复执行写用例。
 * - `save` 抛异常 → 也失败：数据虽然已提交，但幂等确认没落盘，调用方必须知道
 *   「重复提交可能被再次执行」，不能收到一个假装一切正常的成功。
 *   重试是安全的：同一 `draftSequence` 会被存储层判定为重放并返回已确认的 revision。
 * - **失败结果不缓存**：`compute` 返回 `Err` 时不写记录，调用方可以立刻换参重试。
 * - 记录内容损坏（JSON 解析失败/非对象）→ `INTERNAL_ERROR`，不猜测原结果。
 */

import {
  errOf,
  type Err,
  type IdempotencyKey,
  type RequestId,
  type Result,
} from '@yfe/contracts'

import { errFrom, fail } from './errors.js'
import type { IdempotencyPort, IdempotencyRecord } from './ports.js'

/** 幂等记录读取失败时的兜底文案（不泄漏底层异常文本）。 */
const READ_FAILED = '幂等记录读取失败，无法确认本次请求是否已经执行'
/** 幂等记录写入失败时的兜底文案。 */
const WRITE_FAILED = '幂等记录写入失败，重复提交可能被再次执行'
/** 幂等记录损坏时的兜底文案。 */
const CORRUPT = '幂等记录内容损坏，无法还原原始结果'

/** 同进程共享端口的请求按键串行；跨进程原子性仍由持久化适配器保证。 */
const queuesByPort = new WeakMap<IdempotencyPort, Map<IdempotencyKey, Promise<void>>>()

async function serializeKey<T>(port: IdempotencyPort, key: IdempotencyKey, run: () => Promise<T>): Promise<T> {
  let queues = queuesByPort.get(port)
  if (queues === undefined) {
    queues = new Map()
    queuesByPort.set(port, queues)
  }
  const previous = queues.get(key)
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  queues.set(key, current)

  // 队列节点只表示前一请求已结束，业务失败不会使后续请求永远等待或拒绝。
  await previous
  try {
    return await run()
  } finally {
    release()
    if (queues.get(key) === current) queues.delete(key)
  }
}

function parseRecordValue(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 幂等包装：命中记录直接返回原结果，未命中则执行 {@link compute} 并缓存**成功**结果。
 *
 * @param port  幂等端口；宿主未提供（`undefined`）或请求未带键时直接执行，不做缓存。
 * @param scope 用例名。同键跨用例 → `IDEMPOTENCY_KEY_REUSED`（绝不跨用例复用结果）。
 * @param key   `context.idempotencyKey`。
 */
export async function withIdempotency<T>(
  port: IdempotencyPort | undefined,
  scope: string,
  key: IdempotencyKey | undefined,
  requestId: RequestId,
  compute: () => Promise<Result<T>>,
  requestIdentity?: string,
): Promise<Result<T>> {
  if (port === undefined || key === undefined) return compute()

  return serializeKey<Result<T>>(port, key, async () => {
    let existing: IdempotencyRecord | null
    try {
      existing = await port.find(key)
    } catch (thrown) {
      return fail(thrown, requestId, READ_FAILED)
    }

    if (existing !== null) {
      if (existing.scope !== scope) {
        const reused: Err = errOf(
          'IDEMPOTENCY_KEY_REUSED',
          '同一幂等键已用于另一个请求，请更换幂等键后重试',
          requestId,
          { scope, existingScope: existing.scope },
        )
        return errFrom(reused.error, requestId)
      }
      const parsed = parseRecordValue(existing.value)
      if (parsed === undefined) return fail(new TypeError(CORRUPT), requestId, CORRUPT)
      if (requestIdentity !== undefined && existing.requestIdentity !== requestIdentity) {
        return errOf('IDEMPOTENCY_KEY_REUSED', '同一幂等键已用于不同请求', requestId)
      }
      return { ok: true, value: parsed as T }
    }

    const result = await compute()
    if (!result.ok) return result

    try {
      await port.save({ key, scope, value: JSON.stringify(result.value),
        ...(requestIdentity === undefined ? {} : { requestIdentity }) })
    } catch (thrown) {
      return fail(thrown, requestId, WRITE_FAILED)
    }
    return result
  })
}

/**
 * ⚠️ 仅供测试与单进程 CLI 使用的**内存**幂等账本。
 *
 * 它的确定性来自「同一个 Map 复用同一个端口实例」；进程退出即失效，
 * **不能**当桌面/后端的真实实现（那样只能覆盖单进程窗口）。真实实现由 Lead 接入
 * 适配器：写入 `operations` 或专用幂等表。
 */
export function createMemoryIdempotencyLedger(): {
  readonly port: IdempotencyPort
  /** 已记录条数（测试可断言写没写）。 */
  size(): number
} {
  const records = new Map<string, IdempotencyRecord>()
  return {
    port: {
      find: (key: IdempotencyKey): Promise<IdempotencyRecord | null> =>
        Promise.resolve(records.get(key) ?? null),
      save: (record: IdempotencyRecord): Promise<void> => {
        records.set(record.key, record)
        return Promise.resolve()
      },
    },
    size: () => records.size,
  }
}
