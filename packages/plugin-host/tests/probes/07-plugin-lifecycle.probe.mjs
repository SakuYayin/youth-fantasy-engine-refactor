// 探针 7：插件生命周期语义（适配层设计的关键依据）
//   已确认的调用约定：ctx.plugin() 返回的不是 fiber 本身，而是
//   Object.create(fiber) 的 wrapper（自身仅有 then）；await wrapper 得到真实 fiber；
//   wrapper === 真实 fiber 为 false。属性读取经由原型链可透传。
import { Context } from 'cordis'
import { section, expect, record, summary, withTimeout } from './_probe-lib.mjs'

const root = new Context()
const logs = []
root.logger.error = (...args) => {
  logs.push(args.map((a) => (a instanceof Error ? `${a.name}:${a.message}` : String(a))).join(' '))
}

section('A. ctx.plugin() 的返回值形状')
const wrapperProbe = root.plugin(() => {})
record('wrapper 自身 own keys', Object.keys(wrapperProbe))
record('wrapper.state（经原型链透传）', wrapperProbe.state)
const unwrapped = await wrapperProbe
record('await wrapper 得到的类型', unwrapped?.constructor?.name)
record('wrapper === await wrapper', unwrapped === wrapperProbe)
expect('awaited 是真实 Fiber、与 wrapper 不同一', unwrapped === wrapperProbe, false)

section('B. 插件回调抛错：await ctx.plugin() 是否 reject')
let fiberB = null
let directErr = null
const wrapperB = root.plugin(() => {
  throw new Error('activate-boom')
})
record('wrapperB.state（抛错后，FAILED=3）', wrapperB.state)
try {
  fiberB = await wrapperB
} catch (error) {
  directErr = `${error.name}: ${error.message}`
}
record('await wrapperB 的结果', directErr)
expect('🛑 激活抛错时 await ctx.plugin() 会 reject（适配层可据此判定失败）', directErr, 'Error: activate-boom')
record('reject 时无法取得真实 fiber（fiberB 仍为 null）', fiberB === null)
record('但 wrapper 上仍可读到 state', wrapperB.state)
expect('wrapper.state 反映 FAILED', wrapperB.state, 3)
record('logger.error 是否也收到该错误', logs.some((l) => l.includes('activate-boom')))

section('C. 异步 activate 抛错')
logs.length = 0
const wrapperC = root.plugin(async () => {
  await new Promise((resolve) => setTimeout(resolve, 5))
  throw new Error('async-activate-boom')
})
let asyncErr = null
try {
  await withTimeout(wrapperC, 2000, 'C')
} catch (error) {
  asyncErr = `${error.name}: ${error.message}`
}
record('异步 activate 抛错时 await 的结果', asyncErr)
expect('异步激活失败同样 reject', asyncErr, 'Error: async-activate-boom')

section('D. inject 依赖未满足时插件是否执行、await 是否阻塞')
let ranD = false
const wrapperD = root.plugin({
  inject: ['lateService'],
  apply() {
    ranD = true
  },
})
record('插件体是否执行', ranD)
record('wrapperD.state（PENDING=0）', wrapperD.state)
record('wrapperD.inject 的键', Object.keys(wrapperD.inject ?? {}))
let settledFast = null
const awaited = await withTimeout(Promise.resolve(wrapperD), 500, 'D')
if (awaited !== '<<TIMEOUT after 500ms: D>>') settledFast = '立即 settle'
record('await 一个 PENDING 插件是否立即 settle（而非等待依赖）', settledFast)
expect('🛑 await ctx.plugin() 对依赖未满足的插件立即 settle（不会等依赖）', settledFast, '立即 settle')
record('settle 后是否执行', ranD)
record('settle 后的 state', awaited === '<<TIMEOUT after 500ms: D>>' ? 'timeout' : awaited.state)
record('fiberD.inject', Object.keys((awaited === '<<TIMEOUT after 500ms: D>>' ? {} : awaited).inject ?? {}))

section('E. 依赖补齐后是否自动激活')
record('补齐前 ranD', ranD)
root.provide('lateService', { ok: true })
await new Promise((resolve) => setTimeout(resolve, 30))
record('补齐后 ranD', ranD)
expect('依赖补齐后自动激活（适配层必须显式探测，不能只 await）', ranD, true)

section('F. 一个插件激活失败后，宿主能否继续加载其它插件')
logs.length = 0
const orderF = []
const okWrapper = root.plugin(() => {
  orderF.push('ok-plugin-activated')
})
await withTimeout(Promise.resolve(okWrapper), 2000, 'F')
record('失败插件之后的新插件是否执行', orderF)
expect('🛑 单个插件激活失败不阻断宿主加载其它插件', orderF.length, 1)
record('okWrapper.state（ACTIVE=2）', okWrapper.state)

section('G. 对 FAILED 的插件执行 dispose 是否可用')
let disposeErr = null
try {
  await withTimeout(Promise.resolve(wrapperB.dispose()), 2000, 'G')
} catch (error) {
  disposeErr = `${error.name}: ${error.message}`
}
record('dispose 一个激活失败的插件的结果', disposeErr ?? 'resolved')
record('dispose 后 wrapperB.state（DISPOSED=4）', wrapperB.state)
expect('激活失败的插件可以被正常 dispose（清理入口可用）', disposeErr, null)

section('H. 重复 dispose 同一个 fiber 是否安全')
let disposeErr2 = null
try {
  await withTimeout(Promise.resolve(wrapperB.dispose()), 2000, 'H')
} catch (error) {
  disposeErr2 = `${error.name}: ${error.message}`
}
record('第二次 dispose 的结果', disposeErr2 ?? 'resolved')
record('第二次 dispose 后 state', wrapperB.state)
expect('重复 dispose 安全（幂等，不抛错）', disposeErr2, null)

section('I. 插件 deactivate（disposer）抛错是否影响 fiber 状态')
logs.length = 0
const wrapperI = root.plugin((ctx) => {
  ctx.effect(() => () => {
    throw new Error('deactivate-boom')
  }, 'i1')
})
await withTimeout(Promise.resolve(wrapperI), 2000, 'I')
await withTimeout(Promise.resolve(wrapperI.dispose()), 2000, 'I-dispose')
record('dispose 后 state（DISPOSED=4）', wrapperI.state)
record('抛错日志', logs.slice(0, 2))
expect('deactivate 抛错被吞掉，fiber 仍进入 DISPOSED', wrapperI.state, 4)

summary('probe-07-plugin-lifecycle')
