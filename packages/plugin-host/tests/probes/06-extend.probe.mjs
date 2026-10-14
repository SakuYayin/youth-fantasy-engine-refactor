// 探针 6：ctx.extend() 是就地修改还是返回新对象；extend 的隔离与属性语义
import { Context } from 'cordis'
import { section, expect, record, summary } from './_probe-lib.mjs'

const root = new Context()

section('A. extend() 返回值与原对象的关系')
const meta = { foo: 42 }
const child = root.extend(meta)
record('extend() 返回新对象 (child !== root)', child !== root)
record('child.foo', child.foo)
record('root.foo（原对象是否被就地修改）', root.foo)
record('root 上是否有 own property foo', Object.hasOwn(root, 'foo'))
expect('extend() 返回新对象，不就地修改原对象', root.foo, undefined)
expect('新对象能看到 meta 属性', child.foo, 42)

section('B. 原型链关系')
record('Object.getPrototypeOf(child) === root(裸对象)?', Object.getPrototypeOf(child) === root)
record('root 在 child 的原型链上', root.isPrototypeOf(child))
record('child 能看到 root 上后加的服务', (root.provide('late', { v: 1 }), child.get('late')?.v))

section('C. meta 属性的 getter/setter 描述符是否被原样搬运')
let backing = 0
const withAccessor = {
  get counter() {
    return backing
  },
  set counter(v) {
    backing = v
  },
}
const accChild = root.extend(withAccessor)
accChild.counter = 7
record('通过子对象 set 触发原 getter/setter', backing)
record('通过子对象 get 读到', accChild.counter)
record('原 meta 对象上的 counter 描述符仍有 get', typeof Object.getOwnPropertyDescriptor(withAccessor, 'counter')?.get)

section('D. 对子对象直接赋值新属性：是否影响父')
const plainChild = root.extend({})
plainChild.added = 'x'
record('child.added', plainChild.added)
record('root.added（父是否受影响）', root.added)
expect('子对象新增属性不污染父', root.added, undefined)

section('E. 嵌套 extend 链的层级')
const c1 = root.extend({ lvl: 1 })
const c2 = c1.extend({ lvl2: 2 })
record('c2.lvl（继承自 c1）', c2.lvl)
record('c2.lvl2', c2.lvl2)
record('c2 !== c1', c2 !== c1)
record('c1.lvl2（子属性不回流父）', c1.lvl2)
expect('嵌套 extend 单向继承', c1.lvl2, undefined)

section('F. extend 是否复制 Symbol 属性')
const sym = Symbol('mine')
const symChild = root.extend({ [sym]: 'sym-value' })
record('Symbol 属性可读', symChild[sym])
expect('extend 保留 Symbol 属性', symChild[sym], 'sym-value')

section('G. 非 Context 对象 extend 的结果是否仍是 Context')
record('Context.is(child)', Context.is(child))
record('child instanceof Context', child instanceof Context)
record('child.fiber 是否存在（extend 不新建 fiber）', child.fiber === root.fiber)

section('H. 与 isolate/extend 的交互：extend 之后 isolate 的链')
const iso1 = root.isolate('ns', Symbol('l1'))
const thenExtend = iso1.extend({ note: 'after-isolate' })
record('extend 之后仍保留 isolate 槽位（同 label 可见同一服务）', (() => {
  iso1.provide('ns', { from: 'iso1' })
  return thenExtend.get('ns')?.from
})())
expect('extend 保留 isolate 继承', thenExtend.get('ns')?.from, 'iso1')

summary('probe-06-extend')
