// 探针 8：两个高危适配陷阱的精确验证
//   1) wrapper = Object.create(fiber) 之后调用 wrapper.dispose()，
//      `this` 绑定到的是 wrapper 还是真实 fiber？（disposer 内部写 this.uid = null）
//   2) FAILED 的 fiber 调 dispose() 后，state 是否从 3(FAILED) 变成 4(DISPOSED)？
import { Context } from 'cordis'
import { section, expect, record, summary, withTimeout } from './_probe-lib.mjs'

const root = new Context()
const logs = []
root.logger.error = (...args) => {
  logs.push(args.map((a) => (a instanceof Error ? `${a.name}:${a.message}` : String(a))).join(' '))
}

section('A. wrapper.dispose() 的 this 绑定')
const wrapper = root.plugin(() => {
  throw new Error('boom')
})
const realFiber = Object.getPrototypeOf(wrapper)
record('wrapper.dispose 与真实 fiber 的 dispose 是同一个函数', wrapper.dispose === realFiber.dispose)
record('dispose 前 realFiber.uid', realFiber.uid)
record('dispose 前 wrapper 自身是否有 uid（hasOwn）', Object.hasOwn(wrapper, 'uid'))
let disposeErr = null
try {
  await withTimeout(Promise.resolve(wrapper.dispose()), 2000, 'A')
} catch (error) {
  disposeErr = `${error.name}: ${error.message}`
}
record('wrapper.dispose() 结果', disposeErr ?? 'resolved')
record('dispose 后 realFiber.uid（null 才是真释放）', realFiber.uid)
record('dispose 后 wrapper.uid（undefined 即未写入 wrapper）', wrapper.uid)
record('dispose 后 wrapper 自身是否有 uid（hasOwn）', Object.hasOwn(wrapper, 'uid'))
record('dispose 后 realFiber.state', realFiber.state)
record('realFiber._getState() 的真值', realFiber._getState())
record('realFiber 是否仍在 parent 的 runtime.fibers 里', [...root.registry._internal.values()].some((rt) => [...rt.fibers].includes(realFiber)))
record('🛑 结论：wrapper.dispose() 的 this 是 wrapper 还是真实 fiber', wrapper.uid === undefined ? 'wrapper（未真正释放！）' : '真实 fiber')

section('B. 真实 fiber 上的 dispose 是否正确释放')
// 重新建一个失败插件，这次拿到真实 fiber 引用再 dispose
const wrapper2 = root.plugin(() => {
  throw new Error('boom2')
})
const real2 = Object.getPrototypeOf(wrapper2)
record('dispose 前 real2.uid 非 null', real2.uid !== null)
await withTimeout(Promise.resolve(real2.dispose.call(real2)), 2000, 'B')
record('real2.dispose.call(real2) 后 real2.uid', real2.uid)
record('real2.state（4=DISPOSED）', real2.state)
record('real2._getState()（4）', real2._getState())
expect('FAILED fiber 被正确 dispose 后 state 变为 DISPOSED', real2.state, 4)
expect('_getState() 与 state 一致', real2._getState(), 4)
record('⚠️ 例外：若先 await 到 reject 再 dispose，state 字段会停在 3（见探针 09 C 段）', 'await reject 后 dispose：state=3 vs _getState=4')

section('C. 成功插件的 fiber 在 dispose 后 state 是否正确')
const wrapper3 = root.plugin(() => {})
const real3 = Object.getPrototypeOf(wrapper3)
record('dispose 前 real3.state（ACTIVE=2）', real3.state)
await withTimeout(Promise.resolve(real3.dispose.call(real3)), 2000, 'C')
record('dispose 后 real3.state（期望 4）', real3.state)
record('dispose 后 real3._getState()', real3._getState())
expect('成功插件的 fiber dispose 后 state 正确变为 DISPOSED', real3.state, 4)

section('D. ctx.plugin() 返回的 wrapper 上可安全调用的 API 清单')
const wrapper4 = root.plugin(() => {})
const real4 = Object.getPrototypeOf(wrapper4)
record('wrapper.update 是否可用（从原型继承，但 this 绑定错误）', typeof wrapper4.update)
record('Object.keys(wrapper4)', Object.keys(wrapper4))
record('可用且安全的方式：对真实 fiber 调用', Object.getOwnPropertyNames(Object.getPrototypeOf(real4)).filter((n) => typeof real4[n] === 'function'))
await withTimeout(Promise.resolve(real4.dispose.call(real4)), 2000, 'D')

summary('probe-08-wrapper-hazards')
