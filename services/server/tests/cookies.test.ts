/**
 * Cookie 属性。
 *
 * 这些属性是 Web 端会话安全的**全部**依据：HttpOnly 挡住 XSS 偷令牌，
 * Secure 挡住明文信道泄露，SameSite=Strict 挡住 CSRF，Path 限制刷新凭据
 * 只出现在刷新端点上。任何一条写错都不会让别的测试失败，所以必须显式断言。
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_SESSION_POLICY,
  REFRESH_COOKIE_PATH,
  buildSessionCookies,
  clearSessionCookies,
  cookieNames,
  issueSession,
} from '../src/auth/session.js'
import type { SessionPolicy } from '../src/auth/session.js'

import {
  LOGIN_URL,
  LOGOUT_URL,
  ME_URL,
  REFRESH_URL,
  TEST_PASSWORD,
  TEST_USERNAME,
  cleanupTempDirs,
  cookieHeader,
  cookieValue,
  makeHarness,
  seedOwner,
  setCookieHeader,
  setCookiesOf,
} from './helpers.js'
import type { TestHarness } from './helpers.js'

const SECURE_POLICY: SessionPolicy = { ...DEFAULT_SESSION_POLICY, cookieSecure: true }

const harnesses: TestHarness[] = []

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close()
  cleanupTempDirs()
})

async function harnessWith(cookieSecure: boolean): Promise<TestHarness> {
  const harness = await makeHarness({
    config: { sessionPolicy: { ...DEFAULT_SESSION_POLICY, cookieSecure } },
  })
  harnesses.push(harness)
  await seedOwner(harness.db, harness.clock.now())
  return harness
}

/** 从 `Set-Cookie` 头里取属性清单（小写，便于比较）。 */
function attributesOf(header: string): readonly string[] {
  return header
    .split(';')
    .slice(1)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
}

describe('buildSessionCookies（纯函数）', () => {
  it('三条 Cookie 的属性固定：access/refresh 是 HttpOnly，CSRF 必须可被前端读出', async () => {
    const harness = await harnessWith(true)
    const issued = issueSession(harness.db, {
      userId: (await seedOwner(harness.db, harness.clock.now(), { username: 'cookieuser' })).userId,
      at: harness.clock.now(),
      userAgent: null,
      clientIp: null,
      policy: SECURE_POLICY,
    })

    const specs = buildSessionCookies(issued, SECURE_POLICY)
    expect(specs.map((spec) => spec.name)).toEqual([
      'yfe_session',
      'yfe_refresh',
      'yfe_csrf',
    ])

    const access = specs.find((spec) => spec.name === 'yfe_session')
    const refresh = specs.find((spec) => spec.name === 'yfe_refresh')
    const csrf = specs.find((spec) => spec.name === 'yfe_csrf')

    expect(access?.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
    })
    expect(refresh?.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
    })
    // 🔴 CSRF 令牌**必须**可被 JS 读取，否则前端无法把它放进 `X-CSRF-Token`。
    expect(csrf?.options).toMatchObject({
      httpOnly: false,
      secure: true,
      sameSite: 'strict',
      path: '/',
    })
  })

  it('清除会话时三条 Cookie 都立即过期', async () => {
    const cleared = clearSessionCookies(SECURE_POLICY)
    expect(cleared).toHaveLength(3)
    for (const spec of cleared) {
      expect(spec.options.maxAge).toBe(0)
      expect(spec.value).toBe('')
    }
    expect(cleared.find((spec) => spec.name === 'yfe_refresh')?.options.path).toBe(
      REFRESH_COOKIE_PATH,
    )
  })

  it('cookiePrefix 可配置，且 cookieNames 与之一致', () => {
    const policy: SessionPolicy = { ...SECURE_POLICY, cookiePrefix: 'custom' }
    expect(cookieNames(policy)).toEqual({
      access: 'custom_session',
      refresh: 'custom_refresh',
      csrf: 'custom_csrf',
    })
  })
})

describe('登录响应里的 Set-Cookie', () => {
  it('下发 HttpOnly + Secure + SameSite=Strict 的三条 Cookie', async () => {
    const harness = await harnessWith(true)
    const response = await harness.app.inject({
      method: 'POST',
      url: LOGIN_URL,
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    })
    expect(response.statusCode).toBe(200)

    const headers = setCookiesOf(response)
    expect(headers).toHaveLength(3)

    const accessHeader = setCookieHeader(response, 'yfe_session')
    const refreshHeader = setCookieHeader(response, 'yfe_refresh')
    const csrfHeader = setCookieHeader(response, 'yfe_csrf')
    expect(accessHeader).toBeDefined()
    expect(refreshHeader).toBeDefined()
    expect(csrfHeader).toBeDefined()
    if (accessHeader === undefined || refreshHeader === undefined || csrfHeader === undefined) return

    expect(attributesOf(accessHeader)).toContain('httponly')
    expect(attributesOf(accessHeader)).toContain('secure')
    expect(attributesOf(accessHeader)).toContain('samesite=strict')
    expect(attributesOf(accessHeader)).toContain('path=/')

    expect(attributesOf(refreshHeader)).toContain('httponly')
    expect(attributesOf(refreshHeader)).toContain(`path=${REFRESH_COOKIE_PATH}`)

    // CSRF 不是 HttpOnly，且它自己必须有值（前端要读出来）。
    expect(attributesOf(csrfHeader)).not.toContain('httponly')
    const csrfValue = cookieValue(response, 'yfe_csrf')
    expect(csrfValue).toBeTruthy()
  })

  it('cookieSecure=false 时不加 Secure（仅用于本机开发）', async () => {
    const harness = await harnessWith(false)
    const response = await harness.app.inject({
      method: 'POST',
      url: LOGIN_URL,
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    })
    expect(response.statusCode).toBe(200)

    const accessHeader = setCookieHeader(response, 'yfe_session')
    expect(accessHeader).toBeDefined()
    if (accessHeader === undefined) return
    expect(attributesOf(accessHeader)).not.toContain('secure')
    // 但 HttpOnly 与 SameSite 不随环境放宽。
    expect(attributesOf(accessHeader)).toContain('httponly')
    expect(attributesOf(accessHeader)).toContain('samesite=strict')
  })

  it('响应体里不含任何令牌（令牌只走 HttpOnly Cookie）', async () => {
    const harness = await harnessWith(true)
    const login = await harness.app.inject({
      method: 'POST',
      url: LOGIN_URL,
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    })
    const accessToken = cookieValue(login, 'yfe_session')
    const refreshToken = cookieValue(login, 'yfe_refresh')
    expect(accessToken).toBeTruthy()
    expect(refreshToken).toBeTruthy()
    expect(login.body).not.toContain(accessToken ?? 'x')
    expect(login.body).not.toContain(refreshToken ?? 'x')
  })

  it('刷新时重设三条 Cookie（轮换后旧值不可复用）', async () => {
    const harness = await harnessWith(true)
    const login = await harness.app.inject({
      method: 'POST',
      url: LOGIN_URL,
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    })
    const oldRefresh = cookieValue(login, 'yfe_refresh')
    expect(oldRefresh).toBeTruthy()

    const refreshed = await harness.app.inject({
      method: 'POST',
      url: REFRESH_URL,
      headers: { cookie: cookieHeader({ yfe_refresh: oldRefresh }) },
    })
    expect(refreshed.statusCode).toBe(200)
    const newRefresh = cookieValue(refreshed, 'yfe_refresh')
    expect(newRefresh).toBeTruthy()
    expect(newRefresh).not.toBe(oldRefresh)
    expect(setCookiesOf(refreshed)).toHaveLength(3)
  })

  it('登出清空三条 Cookie', async () => {
    const harness = await harnessWith(true)
    const login = await harness.app.inject({
      method: 'POST',
      url: LOGIN_URL,
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    })
    const access = cookieValue(login, 'yfe_session')
    const csrf = cookieValue(login, 'yfe_csrf')

    const logout = await harness.app.inject({
      method: 'POST',
      url: LOGOUT_URL,
      headers: { cookie: cookieHeader({ yfe_session: access }), 'x-csrf-token': csrf ?? '' },
    })
    expect(logout.statusCode).toBe(204)
    const headers = setCookiesOf(logout)
    expect(headers).toHaveLength(3)
    for (const header of headers) {
      expect(attributesOf(header)).toContain('max-age=0')
    }
  })
})

/**
 * 🔴 登出是**写操作**且可以走 Cookie 凭据，所以它必须过 CSRF。
 *
 * 背景：`permission/index.ts` 的 `makeRequireSession` 里那段 CSRF 判定只在
 * 路由挂了该钩子时才执行。登出原先没挂钩子，于是「第三方站点可以让受害者
 * 静默登出」——单看状态码 204 永远发现不了，必须显式断言。
 * 同时要保住幂等：没有有效会话时（过期/已撤销/根本没 Cookie）清 Cookie 即可，
 * 不能因为缺 CSRF 头把用户卡在登不出去的状态。
 */
describe('登出的 CSRF 防护', () => {
  it('会话有效但缺 X-CSRF-Token → 403，且会话绝不被撤销（无副作用）', async () => {
    const harness = await harnessWith(true)
    const login = await harness.app.inject({
      method: 'POST',
      url: LOGIN_URL,
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    })
    const access = cookieValue(login, 'yfe_session') ?? ''

    const rejected = await harness.app.inject({
      method: 'POST',
      url: LOGOUT_URL,
      headers: { cookie: cookieHeader({ yfe_session: access }) },
    })
    expect(rejected.statusCode).toBe(403)
    expect(rejected.json()).toMatchObject({
      code: 'PERMISSION_DENIED',
      detail: { reason: 'csrf_token_invalid' },
    })

    // 关键：CSRF 被拒时不能有任何副作用，否则等于「拒绝的同时把事办了」。
    const stillLoggedIn = await harness.app.inject({
      method: 'GET',
      url: ME_URL,
      headers: { cookie: cookieHeader({ yfe_session: access }) },
    })
    expect(stillLoggedIn.statusCode).toBe(200)
  })

  it('CSRF 值不对 → 403', async () => {
    const harness = await harnessWith(true)
    const login = await harness.app.inject({
      method: 'POST',
      url: LOGIN_URL,
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    })
    const access = cookieValue(login, 'yfe_session') ?? ''

    const rejected = await harness.app.inject({
      method: 'POST',
      url: LOGOUT_URL,
      headers: { cookie: cookieHeader({ yfe_session: access }), 'x-csrf-token': 'not-the-token' },
    })
    expect(rejected.statusCode).toBe(403)
    expect(rejected.json()).toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('带正确 X-CSRF-Token → 204 且会话真的失效', async () => {
    const harness = await harnessWith(true)
    const login = await harness.app.inject({
      method: 'POST',
      url: LOGIN_URL,
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    })
    const access = cookieValue(login, 'yfe_session') ?? ''
    const csrf = cookieValue(login, 'yfe_csrf') ?? ''

    const logout = await harness.app.inject({
      method: 'POST',
      url: LOGOUT_URL,
      headers: { cookie: cookieHeader({ yfe_session: access }), 'x-csrf-token': csrf },
    })
    expect(logout.statusCode).toBe(204)

    const after = await harness.app.inject({
      method: 'GET',
      url: ME_URL,
      headers: { cookie: cookieHeader({ yfe_session: access }) },
    })
    expect(after.statusCode).toBe(401)
  })

  it('没有任何会话 Cookie 时仍 204（幂等登出，不因缺 CSRF 卡死）', async () => {
    const harness = await harnessWith(true)
    const logout = await harness.app.inject({ method: 'POST', url: LOGOUT_URL })
    expect(logout.statusCode).toBe(204)
    expect(setCookiesOf(logout)).toHaveLength(3)
  })
})

describe('会话链在数据库里的形态', () => {
  it('登录只落摘要与 CSRF 秘密，不落明文令牌', async () => {
    const harness = await harnessWith(true)
    const login = await harness.app.inject({
      method: 'POST',
      url: LOGIN_URL,
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    })
    const access = cookieValue(login, 'yfe_session') ?? ''
    const refresh = cookieValue(login, 'yfe_refresh') ?? ''

    const rows = harness.db.prepare('SELECT * FROM sessions').all() as readonly Record<
      string,
      unknown
    >[]
    expect(rows).toHaveLength(1)
    const row = rows[0] ?? {}
    for (const value of Object.values(row)) {
      if (typeof value !== 'string') continue
      expect(value).not.toBe(access)
      expect(value).not.toBe(refresh)
    }

    const refreshRows = harness.db.prepare('SELECT * FROM refresh_tokens').all() as readonly Record<
      string,
      unknown
    >[]
    expect(refreshRows).toHaveLength(1)
    const refreshRow = refreshRows[0] ?? {}
    for (const value of Object.values(refreshRow)) {
      if (typeof value !== 'string') continue
      expect(value).not.toBe(refresh)
    }
  })
})
