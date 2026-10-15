/**
 * 回执正文损坏时的行为（`sync_receipts.response_json`）。
 *
 * 为什么值得单独一组用例：`response_json` 是"提交已经成功"的**唯一**证据。
 * 如果读不回来时被当成"没有回执"（返回 200 空结果、或退化成重新提交），
 * 客户端就会认为提交从未发生 → 重新提交同一份载荷 → 可能造成第二次写入。
 * 因此正确行为是**明确报 `STORAGE_CORRUPT`（503）**：客户端保留本地稿，
 * 等运维从备份恢复后再重试（`retryable: false`——自动重试没有意义）。
 *
 * 同时钉死两件"不能发生"的事：
 * 1. 损坏回执**不能**变成 500 `INTERNAL_ERROR`（运维会误判成代码 bug 而不是存储问题）；
 * 2. 响应体里**不能**出现回执正文片段（回执里含文档正文）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { DeviceId, UserId, WorkspaceId } from '@yfe/contracts'

import { seedOwner } from './helpers.js'
import type { TestHarness, TestHarnessOptions } from './helpers.js'
import {
  countRows,
  harnessTracker,
  loginAs,
  makeBatchBody,
  newOpId,
  rev,
  seedDevice,
} from './syncHelpers.js'
import type { BatchBodyShape } from './syncHelpers.js'

interface BatchSuccessBody {
  readonly ok: true
  readonly batchId: string
  readonly cursor: string
  readonly revisions: readonly { readonly opId: string; readonly entityId: string; readonly revision: string }[]
}

interface ErrorBody {
  readonly code: string
  readonly message: string
  readonly requestId: string
  readonly retryable: boolean
  readonly detail?: Readonly<Record<string, unknown>>
  readonly cause?: unknown
  readonly stack?: unknown
}

interface Ctx {
  readonly harness: TestHarness
  readonly headers: Record<string, string>
  readonly workspaceId: WorkspaceId
  readonly deviceId: DeviceId
  readonly userId: UserId
}

const tracker = harnessTracker()

afterEach(() => {
  tracker.closeAll()
})

async function setup(options: TestHarnessOptions = {}): Promise<Ctx> {
  const harness = await tracker.make(options)
  const at = harness.clock.now()
  const seeded = await seedOwner(harness.db, at)
  const deviceId = seedDevice(harness.db, at, seeded.userId, seeded.workspaceId)
  const headers = await loginAs(harness.app)
  return { harness, headers, workspaceId: seeded.workspaceId, deviceId, userId: seeded.userId }
}

function batchesUrl(workspaceId: string): string {
  return `/api/v1/workspaces/${workspaceId}/batches`
}

function receiptsUrl(workspaceId: string, batchId: string): string {
  return `/api/v1/workspaces/${workspaceId}/receipts/${encodeURIComponent(batchId)}`
}

const DOCUMENT_BODY = '这一段正文只应该出现在回执里，绝不该出现在错误响应中。'

/** 造一个只含一次文档 upsert 的批次体（调用方保留它，重放必须逐字复用）。 */
function makeOneOpBatch(ctx: Ctx): BatchBodyShape {
  return makeBatchBody(ctx.workspaceId, ctx.deviceId, [
    {
      opId: newOpId(),
      entityType: 'document',
      entityId: `doc_${newOpId()}`,
      newRevision: rev(2),
      baseRevision: null,
      payload: { title: '第一章', body: DOCUMENT_BODY },
    },
  ])
}

async function submitOneOpBatch(ctx: Ctx): Promise<{ batch: BatchBodyShape; accepted: BatchSuccessBody }> {
  const body = makeOneOpBatch(ctx)
  const response = await ctx.harness.app.inject({
    method: 'POST',
    url: batchesUrl(ctx.workspaceId),
    headers: ctx.headers,
    payload: body,
  })
  expect(response.statusCode).toBe(200)
  const accepted = response.json<BatchSuccessBody>()
  expect(accepted.ok).toBe(true)
  return { batch: body, accepted }
}

/** 直接改服务端自己的回执行，模拟磁盘损坏 / 外部改写。 */
function corruptReceipt(db: TestHarness['db'], batchId: string, raw: string): void {
  const info = db.prepare('UPDATE sync_receipts SET response_json = ? WHERE batch_id = ?').run(raw, batchId)
  expect(info.changes).toBe(1)
}

describe('回执正文损坏：重放与读取都必须明确报 STORAGE_CORRUPT', () => {
  it('重放同一份载荷时回执读不回来 → 503 STORAGE_CORRUPT，且不发生第二次写入', async () => {
    const ctx = await setup()
    const { batch, accepted } = await submitOneOpBatch(ctx)

    const receiptsBefore = countRows(ctx.harness.db, 'sync_receipts')
    const changesBefore = countRows(ctx.harness.db, 'change_feed')
    corruptReceipt(ctx.harness.db, accepted.batchId, '{"ok":true,')

    // 逐字重放原批次：同 batchId + 同规范化摘要 → 走"回放原响应"分支。
    const replay = await ctx.harness.app.inject({
      method: 'POST',
      url: batchesUrl(ctx.workspaceId),
      headers: ctx.headers,
      payload: batch,
    })
    expect(replay.statusCode).toBe(503)
    const body = replay.json<ErrorBody>()
    expect(body.code).toBe('STORAGE_CORRUPT')
    // 关键地量：坏回执**不能**被当成"没有回执"而重新提交一遍。
    expect(countRows(ctx.harness.db, 'sync_receipts')).toBe(receiptsBefore)
    expect(countRows(ctx.harness.db, 'change_feed')).toBe(changesBefore)
    expect(replay.body).not.toContain(DOCUMENT_BODY)
  })

  it('同 batchId 换载荷仍然是 IDEMPOTENCY_KEY_REUSED（回执损坏不改这个判定）', async () => {
    const ctx = await setup()
    const { batch, accepted } = await submitOneOpBatch(ctx)

    const receiptsBefore = countRows(ctx.harness.db, 'sync_receipts')
    const changesBefore = countRows(ctx.harness.db, 'change_feed')
    corruptReceipt(ctx.harness.db, accepted.batchId, '{"ok":true,')

    const different = makeOneOpBatch(ctx)
    const reused = await ctx.harness.app.inject({
      method: 'POST',
      url: batchesUrl(ctx.workspaceId),
      headers: ctx.headers,
      payload: { ...different, batchId: batch.batchId },
    })
    expect(reused.statusCode).toBe(409)
    expect(reused.json<ErrorBody>().code).toBe('IDEMPOTENCY_KEY_REUSED')
    expect(countRows(ctx.harness.db, 'sync_receipts')).toBe(receiptsBefore)
    expect(countRows(ctx.harness.db, 'change_feed')).toBe(changesBefore)
  })

  it('读取回执时损坏 → 503 STORAGE_CORRUPT，响应体不含正文/堆栈/cause', async () => {
    const ctx = await setup()
    const { accepted } = await submitOneOpBatch(ctx)
    corruptReceipt(ctx.harness.db, accepted.batchId, 'not-json-at-all')

    const response = await ctx.harness.app.inject({
      method: 'GET',
      url: receiptsUrl(ctx.workspaceId, accepted.batchId),
      headers: ctx.headers,
    })
    expect(response.statusCode).toBe(503)
    const body = response.json<ErrorBody>()
    expect(body.code).toBe('STORAGE_CORRUPT')
    // 存储损坏属于 critical：自动重试没有意义，必须等运维处置。
    expect(body.retryable).toBe(false)
    expect(body.detail?.batchId).toBe(accepted.batchId)
    // 原始 JSON.parse 消息会把回执片段带出来，所以只允许放错误名字。
    expect(String(body.detail?.reason)).not.toContain('Unexpected')
    expect(body).not.toHaveProperty('cause')
    expect(body).not.toHaveProperty('stack')
    expect(response.body).not.toContain(DOCUMENT_BODY)
    expect(response.body).not.toContain('at Object.')
  })

  it('回执正常时读取回执仍然可用（不是把整条路径改成报错）', async () => {
    const ctx = await setup()
    const { accepted } = await submitOneOpBatch(ctx)
    const response = await ctx.harness.app.inject({
      method: 'GET',
      url: receiptsUrl(ctx.workspaceId, accepted.batchId),
      headers: ctx.headers,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json<{ readonly batchId: string; readonly result: unknown }>()
    expect(body.batchId).toBe(accepted.batchId)
    expect(body.result).toMatchObject({ ok: true, batchId: accepted.batchId })
  })
})
