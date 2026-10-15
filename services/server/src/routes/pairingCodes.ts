/**
 * `/api/v1/workspaces/:workspaceId/pairing-codes` —— 一次性配对码的签发与列举。
 *
 * ## 明文码只出现一次
 *
 * `code` 只在 **签发响应** 里出现；库里只存 `code_hash`
 * （`scrypt-pairing:<hex>`，见 `auth/secrets.ts` 的 `hashPairingCode`），
 * 而且哈希是**加 pepper** 的：`pairing_codes` 表若被读走，没有主密钥就无法
 * 用字典反查这 8 位码（8 位 Base32 只有 2^40 种取值，无盐哈希几小时就能穷举）。
 *
 * ## pepper 从哪来（装配契约）
 *
 * 🔴 `pepper` **不**是钉在配置里的常量，而要在装配时由主密钥派生：
 * `readMasterKey(config.masterKeyFile)` → `derivePairingPepper(key)`
 * （`http/config.ts`，已由 `src/index.ts` 导出）。`routes/index.ts` 目前传给路由的
 * `RouteDeps` **没有** `masterKeyFile` / `pepper` 字段，所以：
 *
 * - 装配方传了 `pepper`（推荐）或 `masterKeyFile`（本文件代为读取并派生）→ 正常工作；
 * - 都没传 → 本文件的每个配对码接口返回 `SERVICE_UNAVAILABLE`（**fail closed**）。
 *
 * 这里**故意不**从 `bootstrapSecretFile` 之类的东西"再派生一个"：引导秘密是
 * 一次性凭据，用途不同、生命周期不同，混用会让"轮换主密钥"变成"静默让所有
 * 配对码失效"，而且掩盖了装配遗漏。缺配置就大声失败。
 */

import { ContractError } from '@yfe/contracts'
import type { RequestId, UtcTimestamp, WorkspaceId } from '@yfe/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { cancelPairingCode, createPairingCode } from '../auth/pairing.js'
import { listPairingCodesForUser } from '../db/pairing.js'
import type { ServerDb } from '../db/open.js'
import { derivePairingPepper, readMasterKey } from '../http/config.js'
import { authorizeWorkspaceAccess, currentPrincipal } from '../permission/index.js'
import type { PermissionDeps, PermissionGuards } from '../permission/index.js'
import { requireWellFormedId } from '../sync/protocol.js'

/** 主密钥文件 → pepper 的派生结果缓存（按文件路径）。配对码签发不是热路径，但省掉每次请求的读文件。 */
const masterKeyPeppers = new Map<string, Buffer>()

/**
 * 配对码秘密来源。
 *
 * 三个字段都可选：装配方给哪个都行，优先级 `pepper` > `masterKeyFile`。
 */
export interface PairingSecretSource {
  /** 已经派生好的 pepper（≥16 字节）。测试与嵌入方最方便的注入点。 */
  readonly pepper?: Buffer | Uint8Array
  /** 主密钥文件路径（32 字节 Base64）。本文件读它并派生 pepper。 */
  readonly masterKeyFile?: string | null
}

/**
 * 解析 pepper；拿不到就抛 `SERVICE_UNAVAILABLE`（503，**不是** 500：
 * 这是"服务未配置好"，运维看得懂，客户端也知道不是自己的错）。
 */
export function resolvePairingPepper(source: PairingSecretSource, requestId: RequestId): Buffer {
  if (source.pepper !== undefined) {
    const pepper = Buffer.from(source.pepper)
    if (pepper.length < 16) {
      throw new ContractError({
        code: 'SERVICE_UNAVAILABLE',
        message: '配对码 pepper 不足 16 字节：拒绝退化为无盐哈希，请检查装配。',
        requestId,
        detail: { reason: 'pairing_pepper_too_short' },
      })
    }
    return pepper
  }

  const file = source.masterKeyFile
  if (typeof file === 'string' && file.length > 0) {
    const cached = masterKeyPeppers.get(file)
    if (cached !== undefined) return cached
    let derived: Buffer
    try {
      derived = derivePairingPepper(readMasterKey(file))
    } catch {
      // 原始错误（可能含绝对路径、文件系统细节）只进日志，绝不回传。
      throw new ContractError({
        code: 'SERVICE_UNAVAILABLE',
        message: '主密钥文件不可用，无法签发配对码。请检查服务端密钥配置。',
        requestId,
        detail: { reason: 'master_key_unavailable' },
      })
    }
    masterKeyPeppers.set(file, derived)
    return derived
  }

  throw new ContractError({
    code: 'SERVICE_UNAVAILABLE',
    message: '服务端未配置配对码秘密（pepper / masterKeyFile），无法签发或兑换配对码。',
    requestId,
    detail: { reason: 'pairing_pepper_missing' },
  })
}

export interface PairingCodeRouteDeps extends PairingSecretSource {
  readonly db: ServerDb
  readonly policy: PermissionDeps['policy']
  readonly now: () => UtcTimestamp
  readonly guards: PermissionGuards
  readonly log?: (line: Record<string, unknown>) => void
}

// `type: ['object','null']` 而不是 `'object'`：Fastify 5 对**没有请求体**的请求
// 会把 body 校验器喂一个 `null`（`validateParam`：`value === undefined ? null : value`），
// 只写 `'object'` 会把"不带 body 的 POST"误杀成 400。`null` 放行、`{...}` 里
// 只允许空对象（`additionalProperties: false`），其余仍然是 400。
const EMPTY_BODY_SCHEMA = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {},
} as const

const WORKSPACE_PARAMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workspaceId'],
  properties: {
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

const CODE_ID_PARAMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workspaceId', 'pairingCodeId'],
  properties: {
    workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
    pairingCodeId: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const

function workspaceIdOf(request: FastifyRequest, requestId: RequestId): WorkspaceId {
  const raw = (request.params as { workspaceId?: string }).workspaceId
  return requireWellFormedId(raw, 'workspaceId', requestId) as WorkspaceId
}

export function registerPairingCodeRoutes(app: FastifyInstance, deps: PairingCodeRouteDeps): void {
  // 签发配对码需要"管理成员"级别的权限：配对码等于**把工作区的入口交给一台新设备**，
  // 和邀请成员同级。`write` 太宽（editor 也能发），`read` 更不用说。
  // `policy` 是必填的：`PermissionDeps` 需要它，`RouteDeps` 也一定有它，
  // 用 `as` 断言或给空壳只会在装配出错时把问题推到运行时。
  const permissionDeps: PermissionDeps = { db: deps.db, policy: deps.policy }

  // ------------------------------------------------------------ 签发
  app.post(
    '/api/v1/workspaces/:workspaceId/pairing-codes',
    {
      preHandler: deps.guards.requireWorkspaceAccess({ action: 'manageMembers' }),
      schema: { body: EMPTY_BODY_SCHEMA, params: WORKSPACE_PARAMS_SCHEMA },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      // 守卫里已经判过一次；这里再判是为了**取到** access（并防止将来有人改守卫参数）。
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'manageMembers')

      const pepper = resolvePairingPepper(deps, requestId)
      const principal = currentPrincipal(request)
      const now = deps.now()

      const created = await createPairingCode(deps.db, {
        userId: principal.userId,
        workspaceId,
        at: now,
        pepper,
        requestId,
      })

      deps.log?.({
        level: 'info',
        event: 'pairing_code.created',
        requestId,
        workspaceId,
        pairingCodeId: created.id,
        userId: principal.userId,
      })

      // 🔴 明文码只在这里出现一次。库里只有 code_hash。
      return reply
        .status(201)
        .header('cache-control', 'no-store')
        .send({
          pairingCodeId: created.id,
          code: created.code,
          workspaceId: created.workspaceId,
          expiresAt: created.expiresAt,
          maxAttempts: created.maxAttempts,
        })
    },
  )

  // ------------------------------------------------------------ 列举
  app.get(
    '/api/v1/workspaces/:workspaceId/pairing-codes',
    {
      preHandler: deps.guards.requireWorkspaceAccess({ action: 'manageMembers' }),
      schema: { params: WORKSPACE_PARAMS_SCHEMA },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'manageMembers')

      const principal = currentPrincipal(request)
      const nowMs = Date.parse(deps.now())

      // ⚠️ 已知缺口：`db/pairing.ts` 只有 `listPairingCodesForUser`，没有
      // `listPairingCodesForWorkspace`，所以这里只能列出**调用者自己签发**的码。
      // 同工作区其它成员的码不可见（不影响安全性：码本身依然只能换出设备，
      // 而设备管理仍受 `assertCanManageDevice` 约束）。
      const items = listPairingCodesForUser(deps.db, principal.userId)
        .filter((row) => row.workspaceId === workspaceId)
        .filter((row) => row.consumedAt === null && row.revokedAt === null)
        .map((row) => ({
          pairingCodeId: row.id,
          workspaceId: row.workspaceId,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          attempts: row.attempts,
          maxAttempts: row.maxAttempts,
          expired: Date.parse(row.expiresAt) <= nowMs,
          exhausted: row.attempts >= row.maxAttempts,
        }))

      // 绝不回传 code_hash，也绝没有 code 明文字段。
      return reply.status(200).header('cache-control', 'no-store').send({ items })
    },
  )

  // ------------------------------------------------------------ 撤销
  app.delete(
    '/api/v1/workspaces/:workspaceId/pairing-codes/:pairingCodeId',
    {
      preHandler: deps.guards.requireWorkspaceAccess({ action: 'manageMembers' }),
      schema: { params: CODE_ID_PARAMS_SCHEMA },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id as RequestId
      const workspaceId = workspaceIdOf(request, requestId)
      authorizeWorkspaceAccess(permissionDeps, request, workspaceId, 'manageMembers')

      const principal = currentPrincipal(request)
      const pairingCodeId = requireWellFormedId(
        (request.params as { pairingCodeId?: string }).pairingCodeId,
        'pairingCodeId',
        requestId,
      )

      // 先确认这个码确实属于本工作区且是本主体签发的：否则一个 admin 可以拿
      // 别人的 code id 去撤销其它工作区的码。撤销是**幂等**的（写 revoked_at），
      // 已经撤销/消费过的码保持原状并返回 200。
      const owned = listPairingCodesForUser(deps.db, principal.userId).find(
        (row) => row.id === pairingCodeId && row.workspaceId === workspaceId,
      )
      if (owned === undefined) {
        throw new ContractError({
          code: 'NOT_FOUND',
          message: '配对码不存在。',
          requestId,
          detail: { pairingCodeId },
        })
      }

      const cancelled = cancelPairingCode(deps.db, pairingCodeId, deps.now())
      if (!cancelled && owned.consumedAt === null && owned.revokedAt === null) {
        // 读到了却没改掉：并发下被消费/撤销了。对调用方来说结果等价（码不可用）。
        deps.log?.({ level: 'info', event: 'pairing_code.cancel_raced', requestId, pairingCodeId })
      }

      return reply.status(200).header('cache-control', 'no-store').send({ pairingCodeId, revoked: true })
    },
  )

}
