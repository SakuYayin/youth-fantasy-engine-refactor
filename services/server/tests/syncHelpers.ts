/**
 * 同步 / 工作区路由的测试脚手架。
 *
 * 与 `helpers.ts` 的分工：`helpers.ts` 只管"起装置、落用户、取 Cookie"，
 * 这里管"以某个身份发请求、造一条批次"这类**业务形状**的重复劳动。
 * 单独放一个文件而不是往 `helpers.ts` 里塞，是为了不动既有用例依赖的东西。
 *
 * 🔴 所有 Cookie 认证的写请求都必须带 `x-csrf-token`：`requireSession` 对
 * 非 GET/HEAD/OPTIONS 的 Cookie 请求强制校验（值就是 `yfe_csrf` Cookie 本身）。
 * `loginAs` 返回的头里已经带好了这两个东西，测试不该自己拼。
 */

import { encodeRevision, newIds } from '@yfe/contracts'
import type { DeviceId, Revision, UtcTimestamp, UserId, WorkspaceId } from '@yfe/contracts'
import type { FastifyInstance } from 'fastify'

import { insertDevice } from '../src/db/devices.js'
import type { ServerDb } from '../src/db/open.js'
import { makeHarness } from './helpers.js'
import { cookieHeader, cookieValue, LOGIN_URL, TEST_PASSWORD, TEST_USERNAME } from './helpers.js'
import type { TestHarness, TestHarnessOptions } from './helpers.js'

/**
 * 装置登记器。
 *
 * `openServerDatabase(':memory:')` 会在独占写连接表里按路径登记，漏关一个就会
 * 让后续用例全部撞上 `RESOURCE_LOCKED`——把真正的失败原因盖掉。所以统一登记、
 * 统一 `afterEach` 关闭。
 */
export function harnessTracker(): {
  make(options?: TestHarnessOptions): Promise<TestHarness>
  closeAll(): void
} {
  const open: TestHarness[] = []
  return {
    async make(options: TestHarnessOptions = {}): Promise<TestHarness> {
      const created = await makeHarness(options)
      open.push(created)
      return created
    },
    closeAll(): void {
      for (const harness of open.splice(0)) harness.close()
    },
  }
}

export const ACCESS_COOKIE = 'yfe_session'
export const CSRF_COOKIE = 'yfe_csrf'

/** 登录一次，返回可直接交给 `app.inject()` 的认证头。 */
export async function loginAs(
  app: FastifyInstance,
  username: string = TEST_USERNAME,
  password: string = TEST_PASSWORD,
): Promise<Record<string, string>> {
  const response = await app.inject({ method: 'POST', url: LOGIN_URL, payload: { username, password } })
  if (response.statusCode !== 200) {
    throw new Error(`登录失败（${response.statusCode}）：${response.body}`)
  }
  const access = cookieValue(response, ACCESS_COOKIE)
  const csrf = cookieValue(response, CSRF_COOKIE)
  if (access === undefined || csrf === undefined) {
    throw new Error('登录响应没有下发会话或 CSRF Cookie')
  }
  return {
    cookie: cookieHeader({ [ACCESS_COOKIE]: access, [CSRF_COOKIE]: csrf }),
    'x-csrf-token': csrf,
  }
}

/** 去掉 `x-csrf-token`，用来断言"缺 CSRF 头必须 403"。 */
export function withoutCsrf(headers: Readonly<Record<string, string>>): Record<string, string> {
  const { ['x-csrf-token']: _dropped, ...rest } = headers
  return rest
}

/** 落一台属于该主体（可选绑定工作区）的设备，返回 deviceId。 */
export function seedDevice(
  db: ServerDb,
  at: UtcTimestamp,
  userId: UserId,
  workspaceId: WorkspaceId | null,
  overrides: { readonly name?: string } = {},
): DeviceId {
  const id = newIds.device() as DeviceId
  insertDevice(db, {
    id,
    userId,
    workspaceId,
    name: overrides.name ?? '测试设备',
    platform: 'web',
    tokenHash: `hash_${id}`,
    pairingCodeId: null,
    at,
  })
  return id
}

/** 行数断言用（"整批零写入"必须用行数证明，不能用响应体反推）。 */
export function countRows(db: ServerDb, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { readonly n?: number } | undefined
  if (typeof row?.n !== 'number') {
    throw new Error(`无法统计表 ${table} 的行数`)
  }
  return row.n
}

/** 契约里的 revision 是不透明字符串；测试用官方的编码函数生成，绝不手写。 */
export function rev(seq: number): Revision {
  return encodeRevision(seq)
}

export interface BatchOpInput {
  readonly opId: string
  readonly entityType: string
  readonly entityId: string
  readonly newRevision: string
  readonly projectId?: string | null
  readonly baseRevision?: string | null
  readonly action?: 'upsert' | 'delete'
  readonly payload?: Readonly<Record<string, unknown>>
  readonly assetIds?: readonly string[]
}

export interface BatchBodyShape {
  readonly protocolVersion: number
  readonly batchId: string
  readonly deviceId: string
  readonly workspaceId: string
  readonly operations: readonly Record<string, unknown>[]
  readonly idempotencyKey?: string
}

/**
 * 造一个批次请求体。
 *
 * 默认补齐 `projectId: null` / `baseRevision: null` / `assetIds: []`：契约里
 * 这些字段是可空的，显式写 null 比省略更容易看出测试想表达什么。
 */
export function makeBatchBody(
  workspaceId: string,
  deviceId: string,
  operations: readonly BatchOpInput[],
  overrides: { readonly batchId?: string; readonly protocolVersion?: number } = {},
): BatchBodyShape {
  return {
    protocolVersion: overrides.protocolVersion ?? 1,
    batchId: overrides.batchId ?? newIds.request(),
    deviceId,
    workspaceId,
    operations: operations.map((op) => ({
      opId: op.opId,
      entityType: op.entityType,
      entityId: op.entityId,
      projectId: op.projectId ?? null,
      baseRevision: op.baseRevision ?? null,
      newRevision: op.newRevision,
      action: op.action ?? 'upsert',
      payload: op.payload ?? { title: op.entityId },
      assetIds: op.assetIds ?? [],
    })),
  }
}

export function newOpId(): string {
  return newIds.request()
}
