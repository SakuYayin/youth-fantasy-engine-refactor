// 探针 9：失败插件的 state 机精确行为（适配层必须知道何时读 state、何时读 await）
import { Context } from 'cordis'
import { section, expect, record, summary, withTimeout } from './_probe-lib.mjs'

const root = new Context()
root.logger.error = () => {}

section('A. 抛错插件：await 前 / await 后 / dispose 后的 state 序列')
const w1 = root.plugin(() => {
  throw new Error('boom-a')
})
const real1 = Object.getPrototypeOf(w1)
record('构造后立刻 wrapper.state', w1.state)
record('构造后立刻 real._getState()', real1._getState())
record('构造后立刻 real._error', real1._error?.message)
await withTimeout(Promise.resolve(w1), 2000, 'A').catch(() => 'rejected')
record('await reject 后 wrapper.state', w1.state)
record('await reject 后 real._getState()', real1._getState())
record('await reject 后 real.uid', real1.uid)
await withTimeout(Promise.resolve(w1.dispose()), 2000, 'A2')
record('dispose 后 wrapper.state', w1.state)
record('dispose 后 real._getState()', real1._getState())
record('dispose 后 real.uid', real1.uid)

section('B. 抛错插件但不 await，直接 dispose')
const w2 = root.plugin(() => {
  throw new Error('boom-b')
})
const real2 = Object.getPrototypeOf(w2)
record('dispose 前 real2.state', real2.state)
await withTimeout(Promise.resolve(w2.dispose()), 2000, 'B')
record('dispose 后 real2.state', real2.state)
record('dispose 后 real2._getState()', real2._getState())

section('C. 结论：state 字段与 _getState() 何时分歧')
const divergeCases = []
    ;[['未 await 直接 dispose', w2], ['await 后 dispose', w1]].forEach(([label, w]) => {
      const real = Object.getPrototypeOf(w)
      if (real.state !== real._getState()) divergeCases.push(`${label}: state=${real.state} vs _getState=${real._getState()}`)
    })
record('分歧案例', divergeCases)

section('D. 可靠判定：await wrapper 的 reject 是权威信号吗')
const w3 = root.plugin(() => {
  throw new Error('boom-d')
})
let verdict = 'unknown'
try {
  await withTimeout(Promise.resolve(w3), 2000, 'D')
  verdict = 'resolved（会被误判为成功）'
} catch (error) {
  verdict = `rejected: ${error.message}`
}
record('await 判定结果', verdict)
expect('await wrapper 是可靠的激活失败信号', verdict, 'rejected: boom-d')

section('E. 成功插件 + 依赖缺失插件的 await 行为对照')
const wOk = root.plugin(() => {})
const wPending = root.plugin({ inject: ['missing'], apply() {} })
const okVerdict = await withTimeout(Promise.resolve(wOk), 1000, 'E-ok')
const pendingVerdict = await withTimeout(Promise.resolve(wPending), 1000, 'E-pending')
record('成功插件 await 结果', okVerdict)
record('依赖缺失插件 await 结果', pendingVerdict)
record('🛑 两者都 resolve ⇒ await 无法区分「已激活」与「依赖未满足」', okVerdict === 'resolved' && pendingVerdict === 'resolved')
expect('依赖缺失插件 await 也 resolve', pendingVerdict, 'resolved')
const realPending = Object.getPrototypeOf(wPending)
record('依赖缺失插件 real.state（PENDING=0）', realPending.state)
record('依赖缺失插件 real._getState()', realPending._getState())
record('fiber.inject 键（用于显式依赖检查）', Object.keys(realPending.inject ?? {}))

section('F. 因此适配层必须同时检查：await reject + _getState() === ACTIVE')
record('最终判定规则', 'await reject → PLUGIN_ACTIVATION_FAILED；resolve 且 state===2 → 已激活；resolve 且 state===0 → 依赖未满足/拒绝激活')

summary('probe-09-state-machine')
