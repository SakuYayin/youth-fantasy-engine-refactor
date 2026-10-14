// 探针 4：ctx.effect() 的释放顺序（同步/异步混用是否 LIFO、是否逐个 await）
//         关键：必须用 ctx.plugin() 拿到真实子 fiber；root.extend() 与 root 共用 fiber，
//         其 fiber.dispose 实际是 restart()，不能当作插件卸载来测。
import { Context } from 'cordis'
import { section, expect, record, summary, withTimeout } from './_probe-lib.mjs'

const root = new Context()

section('A. 生成器形式：一次 effect 注册多个 disposer 的释放顺序')
const orderA = []
const offA = root.effect(function* () {
  yield () => orderA.push('sync-1')
  yield () => orderA.push('sync-2')
  yield () => orderA.push('sync-3')
}, 'probe-a')
record('effect 返回类型', typeof offA)
offA()
record('释放顺序（生成器 yield 顺序 1,2,3）', orderA)
expect('释放是 LIFO（3,2,1）', JSON.stringify(orderA), JSON.stringify(['sync-3', 'sync-2', 'sync-1']))

section('B. 同步与异步混用：异步 disposer 是否被逐个 await')
const orderB = []
const offB = root.effect(function* () {
  yield () => orderB.push('sync-A:start')
  yield async () => {
    orderB.push('async-B:start')
    await new Promise((resolve) => setTimeout(resolve, 30))
    orderB.push('async-B:end')
  }
  yield () => orderB.push('sync-C')
}, 'probe-b')
const returned = offB()
record('offB() 返回值是 thenable', returned !== undefined && typeof returned.then === 'function')
record('offB() 同步返回后立刻的 orderB（说明是否逐个 await）', [...orderB])
await withTimeout(Promise.resolve(returned), 2000, 'probe-b')
record('await 之后 orderB', [...orderB])
expect(
  '释放严格 LIFO 且逐个 await（C 在 async-B 完成后才执行）',
  JSON.stringify(orderB),
  JSON.stringify(['sync-C', 'async-B:start', 'async-B:end', 'sync-A:start']),
)

section('C. 真实插件 fiber 上的 effect 数量与 dispose 后的释放顺序')
const orderC = []
const fiberC = await root.plugin((ctx) => {
  ctx.effect(() => () => orderC.push('effect-1'), 'c1')
  ctx.effect(() => () => orderC.push('effect-2'), 'c2')
  ctx.effect(() => () => orderC.push('effect-3'), 'c3')
})
record('fiberC.state（ACTIVE=2）', fiberC.state)
record('fiberC.getEffects() 的 label 列表', fiberC.getEffects().map((e) => e.label))
record('fiberC._disposables 数量', [...fiberC._disposables].length)
await withTimeout(Promise.resolve(fiberC.dispose()), 3000, 'C')
record('fiber.dispose() 后 orderC', [...orderC])
record('fiber.dispose() 后 fiberC.state（DISPOSED=4）', fiberC.state)

section('D. 同一 fiber 上三个异步 effect：并发还是串行释放')
const orderD = []
const fiberD = await root.plugin((ctx) => {
  for (const n of [1, 2, 3]) {
    ctx.effect(
      () => async () => {
        orderD.push(`e${n}:start`)
        await new Promise((resolve) => setTimeout(resolve, 20))
        orderD.push(`e${n}:end`)
      },
      `d${n}`,
    )
  }
})
const t0 = Date.now()
await withTimeout(Promise.resolve(fiberD.dispose()), 3000, 'D')
record('fiber.dispose() 耗时 ms（3×20ms：≈20 说明并发，≈60 说明串行）', Date.now() - t0)
record('orderD', [...orderD])

section('E. 已 dispose 的插件 fiber 上再建 effect 的行为')
const fiberE = await root.plugin((ctx) => {
  ctx.effect(() => () => {}, 'e-placeholder')
})
await fiberE.dispose()
let inactiveErr = null
try {
  fiberE.ctx.effect(() => () => {}, 'too-late')
} catch (error) {
  inactiveErr = `${error.name}: ${error.message} (code=${error.code})`
}
record('已 dispose 的 fiber 上 effect() 抛错', inactiveErr)
expect(
  '抛 CordisError.INACTIVE_EFFECT',
  inactiveErr !== null && inactiveErr.includes('cannot create effect on inactive context'),
  true,
)

section('F. 同一 off 重复调用的幂等性')
const orderF = []
const fiberF = await root.plugin((ctx) => {
  const off = ctx.effect(() => () => orderF.push('f'), 'f1')
  off()
  off()
  off()
})
record('同一个 off 调用 3 次后的执行次数', orderF.length)
expect('disposer 只执行一次（epoch 幂等）', orderF.length, 1)

summary('probe-04-effect-order')
