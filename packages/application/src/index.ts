/**
 * `@yfe/application` —— 应用用例层（用例编排 + 端口定义）。
 *
 * ## 它在架构里的位置
 *
 * ```
 * 后端 HTTP 路由 ┐
 * 桌面 IPC handler ├─► @yfe/application（本包）─► ports ─► 适配器 ─► @yfe/persistence-sqlite / 远端 API
 * CLI            ┘
 * ```
 *
 * 业务规则只实现一次：路由/handler 只做「解析请求 → 调用例 → 序列化结果」。
 *
 * ## 硬边界（`01-总体架构.md` / `10-开发规范与环境.md`）
 *
 * - 🔴 **不 import 具体驱动**：没有 better-sqlite3、没有 Electron、没有 Fastify、没有 DOM。
 *   持久化只能通过 `src/ports.ts` 声明的端口。
 * - 🔴 **不产出时间与随机数**：时间取注入的 `clock`，ID 取注入的 `ids`；
 *   包内不存在 `new Date()` / `crypto.randomUUID()`。
 * - 🔴 **不吞失败**：端口返回 `Err` 或抛异常，一律归一后原样向上返回，绝不返回 `ok`。
 * - 🔴 **不外发堆栈**：错误载荷经 `sanitizeErrorPayload` 剥离 `cause`、截断堆栈文本。
 *
 * ## 用法
 *
 * ```ts
 * import { createApplicationDeps, saveDraft, systemStatus } from '@yfe/application'
 * import { fixedClock } from '@yfe/contracts'
 *
 * const deps = createApplicationDeps(ports, { clock: fixedClock('2026-01-01T00:00:00.000Z') })
 * const result = await saveDraft(deps, input)
 * if (!result.ok) return toHttpStatus(result.error.code) // 错误载荷可直接外发
 * ```
 */

export * from './ports.js'
export * from './errors.js'
export * from './validate.js'
export * from './idempotency.js'
export * from './useCases/index.js'
