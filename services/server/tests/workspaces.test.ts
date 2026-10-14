/**
 * `/api/v1/workspaces` —— 按主体列举与创建工作区。
 *
 * 这里最要紧的两条：
 * 1. **角色由服务器决定。** 客户端在创建请求里塞 `role` 必须被拒（而不是被忽略），
 *    否则"忽略"和"接受"从响应上分不出来，客户端会以为自己升级成功了。
 * 2. **列表不能漏工作区。** `seedOwner` 只写成员表、不写 `workspaces` 元数据行，
 *    正是历史上最容易"我明明是成员、列表却是空的"的场景；断言名字退化成 ID 而不是消失。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { newIds } from '@yfe/contracts'
import type { WorkspaceId } from '@yfe/contracts'

import { insertWorkspace } from '../src/db/workspaces.js'
import { upsertMember } from '../src/db/members.js'
import { MAX_WORKSPACES_PER_USER } from '../src/routes/workspaces.js'
import { seedOwner, TEST_PASSWORD } from './helpers.js'
import { harnessTracker, loginAs, withoutCsrf } from './syncHelpers.js'

const WORKSPACES_URL = '/api/v1/workspaces'

interface WorkspaceItem {
  readonly workspaceId: string
  readonly name: string
  readonly role: string
  readonly createdAt: string
}

const tracker = harnessTracker()

afterEach(() => {
  tracker.closeAll()
})

describe('GET /api/v1/workspaces', () => {
  it('未认证返回 401 AUTH_REQUIRED', async () => {
    const harness = await tracker.make()
    const response = await harness.app.inject({ method: 'GET', url: WORKSPACES_URL })
    expect(response.statusCode).toBe(401)
    expect(response.json<{ code: string }>().code).toBe('AUTH_REQUIRED')
  })

  it('只列出主体的成员工作区，且元数据缺失时名字退化为工作区 ID', async () => {
    const harness = await tracker.make()
    const at = harness.clock.now()
    const alice = await seedOwner(harness.db, at, { username: 'alice', password: TEST_PASSWORD })
    const bob = await seedOwner(harness.db, at, { username: 'bob', password: TEST_PASSWORD })

    const headers = await loginAs(harness.app, 'alice', TEST_PASSWORD)
    const response = await harness.app.inject({ method: 'GET', url: WORKSPACES_URL, headers })
    expect(response.statusCode).toBe(200)

    const body = response.json<{ workspaces: readonly WorkspaceItem[] }>()
    expect(body.workspaces).toHaveLength(1)
    const only = body.workspaces[0]
    expect(only?.workspaceId).toBe(alice.workspaceId)
    // 没有 workspaces 元数据行：名字必须回退成 ID，而不是整条消失或变成空串。
    expect(only?.name).toBe(alice.workspaceId)
    expect(only?.role).toBe('owner')
    expect(body.workspaces.some((item) => item.workspaceId === bob.workspaceId)).toBe(false)
  })
})

describe('POST /api/v1/workspaces', () => {
  it('未认证返回 401 AUTH_REQUIRED', async () => {
    const harness = await tracker.make()
    const response = await harness.app.inject({
      method: 'POST',
      url: WORKSPACES_URL,
      payload: { name: '新工作区' },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json<{ code: string }>().code).toBe('AUTH_REQUIRED')
  })

  it('缺 CSRF 头返回 403（Cookie 会话的写请求必须校验 CSRF）', async () => {
    const harness = await tracker.make()
    await seedOwner(harness.db, harness.clock.now())
    const headers = await loginAs(harness.app)

    const response = await harness.app.inject({
      method: 'POST',
      url: WORKSPACES_URL,
      headers: withoutCsrf(headers),
      payload: { name: '没有 CSRF 的工作区' },
    })
    expect(response.statusCode).toBe(403)
    const body = response.json<{ code: string; detail?: { reason?: string } }>()
    expect(body.code).toBe('PERMISSION_DENIED')
    expect(body.detail?.reason).toBe('csrf_token_invalid')
  })

  it('创建成功：201、角色为 owner，并立刻出现在列表里', async () => {
    const harness = await tracker.make()
    await seedOwner(harness.db, harness.clock.now())
    const headers = await loginAs(harness.app)

    const created = await harness.app.inject({
      method: 'POST',
      url: WORKSPACES_URL,
      headers,
      payload: { name: '  我的长篇  ' },
    })
    expect(created.statusCode).toBe(201)
    const body = created.json<WorkspaceItem>()
    expect(body.name).toBe('我的长篇')
    expect(body.role).toBe('owner')

    const listed = await harness.app.inject({ method: 'GET', url: WORKSPACES_URL, headers })
    const items = listed.json<{ workspaces: readonly WorkspaceItem[] }>().workspaces
    const found = items.find((item) => item.workspaceId === body.workspaceId)
    expect(found?.role).toBe('owner')
    expect(found?.name).toBe('我的长篇')
  })

  it('客户端自报 role 直接 400：角色只能由服务器决定', async () => {
    const harness = await tracker.make()
    await seedOwner(harness.db, harness.clock.now())
    const headers = await loginAs(harness.app)

    const response = await harness.app.inject({
      method: 'POST',
      url: WORKSPACES_URL,
      headers,
      payload: { name: '伪装成管理员的工作区', role: 'admin' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('VALIDATION_FAILED')
  })

  it('纯空白名称返回 400（schema 的 minLength 拦不住空白串）', async () => {
    const harness = await tracker.make()
    await seedOwner(harness.db, harness.clock.now())
    const headers = await loginAs(harness.app)

    const response = await harness.app.inject({
      method: 'POST',
      url: WORKSPACES_URL,
      headers,
      payload: { name: '    ' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<{ code: string }>().code).toBe('VALIDATION_FAILED')
  })

  it(`超过每主体 ${MAX_WORKSPACES_PER_USER} 个工作区上限返回 409 RESOURCE_LOCKED`, async () => {
    const harness = await tracker.make()
    const at = harness.clock.now()
    const owner = await seedOwner(harness.db, at)
    const headers = await loginAs(harness.app)

    // 已经 1 个（seedOwner 建的），补到上限。
    for (let index = 1; index < MAX_WORKSPACES_PER_USER; index += 1) {
      const workspaceId = newIds.workspace() as WorkspaceId
      insertWorkspace(harness.db, { id: workspaceId, name: `批量 ${String(index)}`, createdByUserId: owner.userId, at })
      upsertMember(harness.db, workspaceId, owner.userId, 'owner', at)
    }

    const response = await harness.app.inject({
      method: 'POST',
      url: WORKSPACES_URL,
      headers,
      payload: { name: '第 51 个' },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json<{ code: string }>().code).toBe('RESOURCE_LOCKED')
  })

  it('响应体不含 cause 或堆栈', async () => {
    const harness = await tracker.make()
    await seedOwner(harness.db, harness.clock.now())
    const headers = await loginAs(harness.app)

    const response = await harness.app.inject({
      method: 'POST',
      url: WORKSPACES_URL,
      headers,
      payload: { name: 'sneaky', cause: 'boom' },
    })
    expect(response.statusCode).toBe(400)
    const keys = Object.keys(response.json<Record<string, unknown>>())
    expect(keys).not.toContain('cause')
    expect(keys).not.toContain('stack')
    expect(response.body).not.toContain('at Object.')
  })
})
