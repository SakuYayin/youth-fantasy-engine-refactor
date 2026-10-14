// 探针 2：事件是否跨 isolate 分支泄漏；{global:true} 的实际效果
import { Context } from 'cordis'
import { section, expect, record, summary, format } from './_probe-lib.mjs'

function formatThis(value) {
  if (value === null) return 'null'
  if (Context.is(value)) return `Context<${value.fiber?.name ?? '?'}>`
  return format(value)
}

const root = new Context()
const A = root.isolate('branch', Symbol('A'))
const B = root.isolate('branch', Symbol('B'))

const seen = []
section('A. 在 isolate 分支 A 注册普通监听，从 root / B / A 分别 emit')
A.on('ping', (payload) => seen.push(`A-listener<-${payload}`))
root.emit({}, 'ping', 'from-root')
record('root.emit 后 seen', [...seen])
B.emit({}, 'ping', 'from-B')
record('B.emit 后 seen', [...seen])
A.emit({}, 'ping', 'from-A')
record('A.emit 后 seen', [...seen])

section('B. 结论判定：普通事件是否被 isolate 隔离')
const leaked = seen.some((x) => x.endsWith('from-B') || x.endsWith('from-root'))
record('普通事件跨分支泄漏（B/root emit 能触发 A 的监听）', leaked)
expect('isolate 不隔离普通事件（本版本真实语义）', leaked, true)

section('C. {global:true} 的效果：root.emit 时是否触发')
const globalSeen = []
B.on('gping', () => globalSeen.push('B-global'), { global: true })
A.on('gping', () => globalSeen.push('A-local'))
root.emit({}, 'gping')
record('root.emit 后 globalSeen', [...globalSeen])
expect('global:true 的监听在 root.emit 时触发', globalSeen.includes('B-global'), true)
expect('非 global 的监听在 root.emit 时也触发（普通 emit 不按 isolate 过滤）', globalSeen.includes('A-local'), true)

section('D. {global:true} 何时才有真实差别：带 Context.filter 的 thisArg')
// EventsService._resolve: args[0] 是对象/函数时被当作 thisArg 取出，
// 再用 thisArg[Context.filter] 过滤 hook。注意：直接 x.emit('name') 时
// args[0] 是字符串，thisArg 为 null，filter 根本不会被应用。
const filteredSeen = []
A.on('fping', () => filteredSeen.push('A'))
B.on('fping', () => filteredSeen.push('B'))
const filteredThisArg = Object.create(root)
filteredThisArg[Context.filter] = (hookCtx) => hookCtx === A
record('filter 函数是否会被读取', typeof filteredThisArg[Context.filter])
root.emit(filteredThisArg, 'fping')
record('带 filter(A) 的 emit 后 filteredSeen', [...filteredSeen])
expect('带 filter 时只有 A 的监听触发', JSON.stringify(filteredSeen), JSON.stringify(['A']))
const filteredSeen2 = []
A.on('fping2', () => filteredSeen2.push('A'))
B.on('fping2', () => filteredSeen2.push('B'), { global: true })
const filteredThisArg2 = Object.create(root)
filteredThisArg2[Context.filter] = (hookCtx) => hookCtx === A
root.emit(filteredThisArg2, 'fping2')
record('global:true 的 B 监听 + filter(A) 后 filteredSeen2', [...filteredSeen2])
expect('global:true 突破 filter 过滤（仍触发）', filteredSeen2.includes('B'), true)
const noFilterSeen = []
A.on('fping3', () => noFilterSeen.push('A'))
B.on('fping3', () => noFilterSeen.push('B'))
root.emit('fping3')
record('无 filter 时 A/B 都触发', [...noFilterSeen])

section('E. 监听器 this 的身份（由 emit 的 thisArg 决定，不是注册它的 ctx）')
let ctxWhenExplicitArg = null
let ctxWhenNoArg = null
A.on('ctxcheck', function () {
  ctxWhenExplicitArg = this
})
A.on('ctxcheck2', function () {
  ctxWhenNoArg = this
})
const explicitThisArg = { tag: 'explicit-thisArg' }
A.emit(explicitThisArg, 'ctxcheck')
record('传入 thisArg 时，监听器 this === 该 thisArg', ctxWhenExplicitArg === explicitThisArg)
record('监听器 this === 注册它的 ctx(A)', ctxWhenExplicitArg === A)
A.emit('ctxcheck2')
record('不传 thisArg 时监听器 this 的值', ctxWhenNoArg === undefined ? 'undefined' : formatThis(ctxWhenNoArg))
record('结论：Cordis 4.0.0-rc.11 不把 ctx 作为监听器 this 自动注入', true)

section('F. 监听 dispose 后是否立刻停止触发')
const disposeSeen = []
const off = A.on('dping', () => disposeSeen.push('x'))
A.emit({}, 'dping')
const afterFirst = disposeSeen.length
off()
A.emit({}, 'dping')
record('off() 前触发次数', afterFirst)
record('off() 后触发次数', disposeSeen.length)
expect('off() 之后不再触发', disposeSeen.length, afterFirst)

summary('probe-02-events')
