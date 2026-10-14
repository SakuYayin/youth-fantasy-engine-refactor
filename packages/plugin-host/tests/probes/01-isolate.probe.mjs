// 探针 1：ctx.isolate() 的服务隔离语义；同名服务跨分支是否冲突
import { readFileSync } from 'node:fs'
import { Context } from 'cordis'
import { section, expect, record, summary } from './_probe-lib.mjs'

const cordisPkg = JSON.parse(
  readFileSync(new URL('../../../../node_modules/cordis/package.json', import.meta.url), 'utf8'),
)
console.log(`cordis 版本: ${cordisPkg.version}`)

section('A. isolate 返回的是新对象还是就地修改')
const root = new Context()
const labelA = Symbol('branch-A')
const labelB = Symbol('branch-B')
const branchA = root.isolate('demo', labelA)
const branchB = root.isolate('demo', labelB)
expect('isolate() 返回新对象 (branchA !== root)', branchA !== root, true)
expect('两个不同 label 的分支互不相同', branchA !== branchB, true)
record('root 上是否出现 demo 属性（未 provide 前）', 'demo' in root)

section('B. 同一个 name 在两个分支各自 provide：是否冲突')
const a = root.isolate('svc', labelA)
const b = root.isolate('svc', labelB)
const aImpl = { who: 'A' }
const bImpl = { who: 'B' }
let aErr = null
let bErr = null
try {
  a.provide('svc', aImpl)
} catch (error) {
  aErr = error.message
}
try {
  b.provide('svc', bImpl)
} catch (error) {
  bErr = error.message
}
expect('分支 A provide 无异常', aErr, null)
expect('分支 B provide 同名服务也无异常（不冲突）', bErr, null)
expect('分支 A 看到自己的实现', a.get('svc')?.who, 'A')
expect('分支 B 看到自己的实现', b.get('svc')?.who, 'B')

section('C. 未显式 isolate 的 root 能否看到任一分支的服务')
record('root.get("svc")', root.get('svc'))

section('D. 同一 label 重复 isolate：是否共用同一个槽位（冲突/覆盖）')
const a2 = root.isolate('svc', labelA)
record('a2.get("svc") 复用同 label 后可见', a2.get('svc')?.who)
let dupErr = null
try {
  a2.provide('svc', { who: 'A2' })
} catch (error) {
  dupErr = error.message
}
expect('同 label 再 provide 报错（槽位已占用）', typeof dupErr, 'string')
record('同 label 二次 provide 的错误原文', dupErr)

section('E. isolate 是否跨 extend 继承（链式传播）')
const nested = a.isolate('other', Symbol('nested'))
expect('嵌套 isolate 仍能看到外层分支的服务', nested.get('svc')?.who, 'A')
expect('嵌套 isolate 是第三个新对象', nested !== a, true)

summary('probe-01-isolate')
