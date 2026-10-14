// 探针 5：disposer 抛错 / 永久挂起时的行为差异。
//   关键区别（源码位置均已核对）：
//     - 直接同步调用 off()：走 Fiber.effect 内部的 dispose()，dispose2() 抛错会
//       从 index.js:486 直接逃逸，并中断同一 effect 内剩余 disposer；
//     - fiber 级 _unload()（index.js:626-636）：每个 dispose 各自 try/catch，
//       抛错被 logger.error 吞掉，不阻断其他 effect。
import { Context } from 'cordis'
import { section, expect, record, summary, withTimeout } from './_probe-lib.mjs'

const root = new Context()

section('A. 同步调用 off()：中间 disposer 抛错时兄弟 disposer 还执行吗')
const orderA = []
const offA = root.effect(function* () {
  yield () => orderA.push('s1')
  yield () => {
    orderA.push('s2:throw')
    throw new Error('boom-s2')
  }
  yield () => orderA.push('s3')
}, 'throw-probe')
let syncErr = null
try {
  offA()
} catch (error) {
  syncErr = `${error.name}: ${error.message}`
}
record('同步调用 offA() 是否抛出', syncErr)
record('orderA（LIFO：s3 先跑，s2 抛错，s1 是否还执行）', [...orderA])
expect('同步 dispose 时抛错直接逃逸（不被吞掉）', syncErr, 'Error: boom-s2')
expect('抛错中断同一 effect 内剩余 disposer（s1 未执行）', orderA.includes('s1'), false)

section('B. 通过 thenable 协议 await off()：disposer 会被执行吗')
// 源码：Fiber.effect 的 wrapper.then = async (onFulfilled, onRejected) =>
//   Promise.resolve(task).then(() => disposeAsync).then(onFulfilled, onRejected)
// 注意 `.then(() => disposeAsync)` 是把 disposeAsync 当作返回值，而不是调用它。
const orderB = []
const offB = root.effect(function* () {
  yield () => orderB.push('t1')
  yield () => {
    orderB.push('t2:throw')
    throw new Error('boom-t2')
  }
  yield () => orderB.push('t3')
}, 'throw-probe-2')
let asyncErr = null
let awaitedValue = null
try {
  awaitedValue = await withTimeout(Promise.resolve(offB), 2000, 'B')
} catch (error) {
  asyncErr = `${error.name}: ${error.message}`
}
record('await offB 的结果', asyncErr ?? typeof awaitedValue)
record('await offB 是否触发 disposer（orderB）', [...orderB])
expect(
  'await wrapper 不会触发 disposer（上游 then 实现缺陷：只把 disposeAsync 当值返回，未调用）',
  orderB.length,
  0,
)
record('🛑 影响：适配层绝不能依赖 await effectWrapper 来释放资源，必须显式调用 wrapper()', true)
// 显式调用才是可靠路径，并且此时抛错是同步逃逸的
const orderB2 = []
const offB2 = root.effect(function* () {
  yield () => orderB2.push('x1')
  yield () => {
    orderB2.push('x2:throw')
    throw new Error('boom-x2')
  }
  yield () => orderB2.push('x3')
}, 'throw-probe-3')
let syncErr2 = null
try {
  offB2()
} catch (error) {
  syncErr2 = `${error.name}: ${error.message}`
}
record('显式调用 offB2() 的抛错', syncErr2)
record('显式调用的 orderB2', [...orderB2])
expect('显式调用能把 disposer 抛错暴露给调用方', syncErr2, 'Error: boom-x2')

section('C. fiber 级：一个 effect 的 disposer 抛错，其他 effect 是否继续释放')
const orderC = []
const logsC = []
root.logger.error = (...args) => {
  logsC.push(args.map((a) => (a instanceof Error ? `${a.name}:${a.message}` : String(a))).join(' '))
}
const fiberC = await root.plugin((ctx) => {
  ctx.effect(() => () => orderC.push('c1-ok'), 'c1')
  ctx.effect(
    () => () => {
      orderC.push('c2-throw')
      throw new Error('boom-c2')
    },
    'c2',
  )
  ctx.effect(() => () => orderC.push('c3-ok'), 'c3')
})
const resultC = await withTimeout(Promise.resolve(fiberC.dispose()), 3000, 'C')
record('fiberC.dispose() await 结果', resultC)
record('orderC', [...orderC])
expect('抛错的 disposer 不阻断其他 effect（c1/c3 都执行）', orderC.includes('c1-ok') && orderC.includes('c3-ok'), true)
expect('fiber.dispose() 不 reject（错误被 logger.error 吞掉）', resultC, 'resolved')
record('被吞掉的错误日志', logsC.slice(0, 3))
expect('错误确实进了 logger.error', logsC.some((l) => l.includes('boom-c2')), true)

section('D. 永久挂起的 disposer：是否使 fiber.dispose() 永不 settle')
const orderD = []
const fiberD = await root.plugin((ctx) => {
  ctx.effect(() => () => orderD.push('d1-ok'), 'd1')
  ctx.effect(() => () => new Promise(() => {}), 'd2-hang')
  ctx.effect(() => () => orderD.push('d3-ok'), 'd3')
})
const resultD = await withTimeout(Promise.resolve(fiberD.dispose()), 800, 'D')
record('含永久挂起 disposer 时 fiber.dispose() 的结果（800ms 超时观察）', resultD)
record('orderD（挂起前已执行的部分）', [...orderD])
expect('永久挂起的 disposer 使 fiber.dispose() 永不 settle', resultD, '<<TIMEOUT after 800ms: D>>')
expect('永久挂起只卡住它自己那条链，兄弟 effect 仍完成（并发释放）', orderD.includes('d1-ok') && orderD.includes('d3-ok'), true)
record('fiberD.state（dispose 未完成时：UNLOADING=5）', fiberD.state)

section('E. 永久挂起 vs 抛错后 fiber.state 对比')
record('fiberC.state（抛错、dispose 完成后）', fiberC.state)
record('fiberD.state（挂起、dispose 未完成）', fiberD.state)

section('F. 单个 effect 内永久挂起：会卡住它后面的兄弟吗')
const orderF = []
const fiberF = await root.plugin((ctx) => {
  ctx.effect(function* () {
    yield () => orderF.push('f1')
    yield () => new Promise(() => {})
    yield () => orderF.push('f3')
  }, 'f-chain')
})
const resultF = await withTimeout(Promise.resolve(fiberF.dispose()), 800, 'F')
record('offF 的结果', resultF)
record('orderF（LIFO：f3 先跑，然后挂在中间，f1 是否执行）', [...orderF])
expect('同一 effect 内挂起会卡住后续兄弟（f1 未执行）', resultF, '<<TIMEOUT after 800ms: F>>')

summary('probe-05-dispose-failure')
