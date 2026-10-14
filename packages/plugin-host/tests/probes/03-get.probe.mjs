// 探针 3：ctx.get() 对未注册服务的返回值；父子链可见性；严格/非严格模式
import { Context, Service } from 'cordis'
import { section, expect, record, summary } from './_probe-lib.mjs'

const root = new Context()

section('A. 未注册服务的 get() 返回值')
record('root.get("nope")', root.get('nope'))
record('root.get("nope", true)（strict）', root.get('nope', true))
record('root.get("nope", false)（非 strict）', root.get('nope', false))
expect('未注册返回 undefined', root.get('nope'), undefined)
record('访问不存在的属性 root.nope', root.nope)
expect('属性访问同样返回 undefined', root.nope, undefined)

section('B. 父注册、子可见（子 ctx 从父 extend 出来）')
root.provide('svc', { tag: 'root-svc' })
const child = root.extend({})
expect('child.get("svc") 看到父的实现', child.get('svc')?.tag, 'root-svc')
record('child.provide 之前 child.get 结果', child.get('svc')?.tag)

section('C. 子注册同名服务 -> 遮蔽父（shadowing），父不受影响')
let childErr = null
try {
  child.provide('svc', { tag: 'child-svc' })
} catch (error) {
  childErr = error.message
}
record('子 provide 同名服务的错误', childErr)
if (childErr === null) {
  expect('child.get("svc") 看到子的实现', child.get('svc')?.tag, 'child-svc')
  expect('root.get("svc") 仍是父的实现（未被覆盖）', root.get('svc')?.tag, 'root-svc')
} else {
  record('说明：同一 isolate 槽位下子不能再 provide 同名服务', 'no-shadow')
}

section('C2. 子注册同名服务但用独立 isolate：能否共存')
const childIso = root.isolate('svc', Symbol('child'))
let childIsoErr = null
try {
  childIso.provide('svc', { tag: 'child-iso-svc' })
} catch (error) {
  childIsoErr = error.message
}
record('子 isolate 分支 provide 同名服务的错误', childIsoErr)
expect('子 isolate 分支可以注册同名服务', childIsoErr, null)
expect('childIso.get 看到自己的实现', childIso.get('svc')?.tag, 'child-iso-svc')
expect('root.get 仍是父的实现', root.get('svc')?.tag, 'root-svc')

section('D. 兄弟分支之间的可见性（互不可见）')
const s1 = root.isolate('svc', Symbol('s1'))
const s2 = root.isolate('svc', Symbol('s2'))
s1.provide('svc', { tag: 's1' })
record('s2.get("svc")（未注册）', s2.get('svc'))
expect('兄弟分支看不到对方的服务', s2.get('svc'), undefined)

section('E. node_modules 里的服务（Context 自带）')
record('typeof root.events', typeof root.events)
record('typeof root.registry', typeof root.registry)
record('typeof root.reflect', typeof root.reflect)
record('typeof root.logger', typeof root.logger)

section('F. Service 子类注册后的可见性（Cordis 推荐写法）')
class Demo extends Service {
  constructor(ctx) {
    super(ctx, 'demo')
  }
  hello() {
    return 'demo-hello'
  }
}
root.plugin(Demo)
await new Promise((resolve) => setTimeout(resolve, 10))
record('root.demo 是否可见', typeof root.demo)
record('root.demo?.hello()', typeof root.demo?.hello === 'function' ? root.demo.hello() : '<<not-a-service>>')
record('root.get("demo") 是同一个对象', root.get('demo') === root.demo)

summary('probe-03-get')
