# ADR 0002：Cordis 生命周期语义与插件内核适配层

- 状态：**已接受**
- 日期：2026-10-15
- 决策者：T4（`docs/项目台账.md` 任务 P0-4）
- 相关风险：设计文档 `12-开发计划.md` 风险表把「**Cordis API 未稳定**」列为 **P0 阻断项**；
  上游 README 自述 "The API is not yet stable and may change without notice."（见 `13-决策与资料.md` ADR 004）
- 相关 ADR：`0001-sqlite-native-driver.md`（该 ADR 记录当时 P0 阻断项从 2 个减为 1 个，**剩余的就是本 ADR 处理项**）

## 背景

设计文档要求：插件体系建立在上游 Cordis 之上，但 **Cordis 不承诺 API 稳定**，且它本身
不提供完整权限、插件市场、移动运行时、同步与安全沙箱（`13-决策与资料.md` ADR 004）。
因此生命周期语义**不能凭文档印象假设**，必须用可复现的探针实验把真实行为钉死，再由
适配层（`@yfe/plugin-host`）把上游语义收敛成我方稳定的产品契约。

本 ADR 记录：**做了什么实验、观察到了什么、因此决定适配层怎么写、哪些结论是回归门禁**。

## 验证环境（可复现）

| 项 | 值 |
| --- | --- |
| OS | Windows（NT 10.0，Session 1） |
| Node | v24.19.0 |
| npm | 11.17.0 |
| cordis | **4.0.0-rc.11**（精确锁定，非 `^`、非主分支） |
| cordis 来源 | `https://registry.npmjs.org/cordis/-/cordis-4.0.0-rc.11.tgz` |
| cordis integrity | `sha512-03PHbcYJzp84XRKnW7jd17g26bPvG5UvSyhyjxGIu/1VQs3bweNMACo3t1W0ikzoZ7q+wytHyk8jJsaIQOkPkA==` |
| cordis 许可 | MIT |
| cordis 上游仓库 | `git+https://github.com/cordiverse/cordis.git`（`directory: packages/core`） |
| 传递依赖 | `cosmokit@1.8.1`（MIT）、`@standard-schema/spec@1.1.0`（MIT） |
| 探针运行物 | `node_modules/cordis/lib/index.js`，sha256 `2b5009648dfb64a2b904315e3a577179f6d378507cbbb3965897d94994d78fe9` |

**来源唯一性**：按 `13-决策与资料.md`「Cordis 上游与 DSH fork 只能选一个明确来源」，
本版本**只采用 npm registry 的上游 `cordis@4.0.0-rc.11`**，不引入 DSH fork，
不追随上游主分支自动更新（升级必须另开 ADR 并重跑全部探针）。

## 验证方法

9 个独立探针脚本（`.mjs`，`node` 直接运行，不依赖 vitest），位于
`packages/plugin-host/tests/probes/`。每个探针用 `PASS`/`OBSERVE` 打印真实观测值，
末尾输出 `=== probe-XX: N checks, M failed ===`，有失败则退出码为 1。

完整原始输出已捕获到 `packages/plugin-host/tests/probes/PROBE-OUTPUT.txt`（20 KB）。
本次 9 个探针合计 **214 checks，0 failed**：

| 探针 | 验证主题 | 结果 |
| --- | --- | --- |
| `01-isolate.probe.mjs` | `ctx.isolate()` 的可见性与槽位冲突 | 13 checks, 0 failed |
| `02-events.probe.mjs` | 事件是否受 isolate 过滤、`{global:true}` 的真实语义、监听器 `this` | 21 checks, 0 failed |
| `03-get.probe.mjs` | `ctx.get()` 未注册时的行为、同名服务冲突、跨分支可见性 | 23 checks, 0 failed |
| `04-effect-order.probe.mjs` | `ctx.effect()` 的释放顺序（LIFO）、异步是否逐个 await | 18 checks, 0 failed |
| `05-dispose-failure.probe.mjs` | disposer 抛错 / 永久挂起时的差异行为 | 27 checks, 0 failed |
| `06-extend.probe.mjs` | `ctx.extend()` 是否就地修改、原型链、Symbol 属性搬运 | 27 checks, 0 failed |
| `07-plugin-lifecycle.probe.mjs` | `ctx.plugin()` 返回值形状、激活失败、依赖缺失、重复 dispose | 37 checks, 0 failed |
| `08-wrapper-hazards.probe.mjs` | wrapper 与真实 fiber 的区别、dispose 的 `this` 绑定 | 25 checks, 0 failed |
| `09-state-machine.probe.mjs` | `state` 字段与 `_getState()` 何时分歧、判定激活成功的权威信号 | 23 checks, 0 failed |

## 六条关键结论（每条都附真实观测）

### 结论 1：`ctx.isolate()` 只隔离**服务槽位**，**完全不隔离事件**

`isolate()` 返回新对象（不就地修改），同名服务可在不同 isolate 分支各自 `provide` 而不冲突；
但**普通事件的监听器是全局的**：在分支 A 注册的监听器，被 root 或兄弟分支 B `emit` 时同样触发。

```
--- A. isolate 返回的是新对象还是就地修改 ---
  PASS     isolate() 返回新对象 (branchA !== root) => true
--- C. 未显式 isolate 的 root 能否看到任一分支的服务 ---
  OBSERVE  root.get("svc") => undefined
--- D. 同一 label 重复 isolate：是否共用同一个槽位（冲突/覆盖） ---
  PASS     同 label 再 provide 报错（槽位已占用） => "string"
  OBSERVE  同 label 二次 provide 的错误原文 => "service \"svc\" has been registered at <root>"
```

```
--- A. 在 isolate 分支 A 注册普通监听，从 root / B / A 分别 emit ---
  OBSERVE  root.emit 后 seen => ["A-listener<-from-root"]
  OBSERVE  B.emit 后 seen => ["A-listener<-from-root","A-listener<-from-B"]
  OBSERVE  A.emit 后 seen => ["A-listener<-from-root","A-listener<-from-B","A-listener<-from-A"]
--- B. 结论判定：普通事件是否被 isolate 隔离 ---
  OBSERVE  普通事件跨分支泄漏（B/root emit 能触发 A 的监听） => true
  PASS     isolate 不隔离普通事件（本版本真实语义） => true
```

`{global: true}` **只在 `emit` 的第一个参数是带 `Context.filter` 的对象/函数时才有差别**；
`ctx.emit('name')`（`args[0]` 是字符串）时 `thisArg` 为 `null`，所有监听器一律触发：

```
--- D. {global:true} 何时才有真实差别：带 Context.filter 的 thisArg ---
  OBSERVE  filter 函数是否会被读取 => "function"
  OBSERVE  带 filter(A) 的 emit 后 filteredSeen => ["A"]
  PASS     带 filter 时只有 A 的监听触发 => "[\"A\"]"
  OBSERVE  global:true 的 B 监听 + filter(A) 后 filteredSeen2 => ["A","B"]
  PASS     global:true 突破 filter 过滤 => true
--- E. 监听器 this 的身份（由 emit 的 thisArg 决定，不是注册它的 ctx） ---
  OBSERVE  监听器 this === 注册它的 ctx(A) => false
  OBSERVE  不传 thisArg 时监听器 this 的值 => "null"
```

**对适配层的约束**：**不得用 isolate 做插件间事件隔离**。插件事件必须由宿主
按 `pluginId` 显式路由，不能把「这个监听器只属于我这个插件」的假设建立在上游语义上。

### 结论 2：`ctx.get()` 未注册时返回 `undefined` 且**不抛错**

```
--- A. 在 root 上 provide 后，root / 子 ctx 各自能否取到 ---
  PASS     root.get("demo") 取到实现 => true
  OBSERVE  root.get("demo") === root.demo => false
--- 未注册服务的 get 行为 ---
  OBSERVE  root.get("nope") => undefined
  PASS     未注册服务 get() 返回 undefined 而不是抛错 => true
```

**对适配层的约束**：服务解析必须**显式判空**并给出可诊断的产品错误；
`typeof root.logger === "function"`（logger 本身是函数，不是普通对象）也是探针实测事实。

### 结论 3：释放语义分两层——**fiber 级并发**、**单 effect 内严格 LIFO 串行**

`ctx.effect()` 的 wrapper 释放时：**同一个 effect 内**的多条 disposer 严格 LIFO 且
逐个 `await`（不是并发）；而 **fiber 级**的多个 effect 之间是 `Promise.all` 并发释放。

```
--- A. 生成器形式：一次 effect 注册多个 disposer 的释放顺序 ---
  OBSERVE  释放顺序（生成器 yield 顺序 1,2,3） => ["sync-3","sync-2","sync-1"]
  PASS     释放是 LIFO（3,2,1）
--- B. 同步与异步混用：异步 disposer 是否被逐个 await ---
  OBSERVE  offB() 同步返回后立刻的 orderB => ["sync-C","async-B:start"]
  OBSERVE  await 之后 orderB => ["sync-C","async-B:start","async-B:end","sync-A:start"]
  PASS     释放严格 LIFO 且逐个 await（C 在 async-B 完成后才执行）
--- D. 同一 fiber 上三个异步 effect：并发还是串行释放 ---
  OBSERVE  fiber.dispose() 耗时 ms（3×20ms：≈20 说明并发，≈60 说明串行） => 28
  OBSERVE  orderD => ["e3:start","e2:start","e1:start","e3:end","e2:end","e1:end"]
```

**单 effect 内**抛错会**中断该链**（后续兄弟不执行）；**fiber 级**抛错被吞掉、不阻断其它 effect：

```
--- A. 同步调用 off()：中间 disposer 抛错时兄弟 disposer 还执行吗 ---
  OBSERVE  orderA（LIFO：s3 先跑，s2 抛错，s1 是否还执行） => ["s3","s2:throw"]
  PASS     抛错中断同一 effect 内剩余 disposer（s1 未执行） => false
--- C. fiber 级：一个 effect 的 disposer 抛错，其他 effect 是否继续释放 ---
  OBSERVE  fiberC.dispose() await 结果 => "resolved"
  OBSERVE  orderC => ["c3-ok","c2-throw","c1-ok"]
  PASS     抛错的 disposer 不阻断其他 effect（c1/c3 都执行） => true
  PASS     fiber.dispose() 不 reject（错误被 logger.error 吞掉） => "resolved"
  OBSERVE  被吞掉的错误日志 => ["Error:boom-c2"]
```

**永久挂起**的 disposer 会让 `fiber.dispose()` **永不 settle**（`state` 停在 `UNLOADING=5`）：

```
--- D. 永久挂起的 disposer：是否使 fiber.dispose() 永不 settle ---
  OBSERVE  含永久挂起 disposer 时 fiber.dispose() 的结果（800ms 超时观察） => "<<TIMEOUT after 800ms: D>>"
  OBSERVE  orderD（挂起前已执行的部分） => ["d3-ok","d1-ok"]
  PASS     永久挂起使 fiber.dispose() 永不 settle
  OBSERVE  fiberD.state（dispose 未完成时：UNLOADING=5） => 5
--- F. 单个 effect 内永久挂起：会卡住它后面的兄弟吗 ---
  OBSERVE  orderF（LIFO：f3 先跑，然后挂在中间，f1 是否执行） => ["f3"]
  PASS     同一 effect 内挂起会卡住后续兄弟（f1 未执行）
```

**对适配层的约束（本条是内核设计的硬依据）**：宿主**不能裸 await `fiber.dispose()`**，
必须加**清理超时**；超时后把插件标记为 `quarantined`（设计文档 `05-插件内核与SDK.md`
的「清理超时或异常进入 failed/quarantined 状态」），因为上游既不 reject 也永不返回。
同时**同一 effect 内不要串多个不可信 disposer**——用 `ctx.effect()` 注册**单个** disposer，
把所有清理动作放进**自适应层自己管理的列表**里逐个 try/catch，才能保证兄弟清理不被吞。

### 结论 4：`ctx.plugin()` 返回的是 wrapper，`await` 只能判断「激活抛错」，**判断不出「依赖未满足」**

`ctx.plugin()` 返回 `Object.create(fiber)` 的包装对象，**自身只有 `then`**，
`await` 它才得到真实 `Fiber`（`wrapper === await wrapper` 为 `false`）。

```
--- A. ctx.plugin() 的返回值形状 ---
  OBSERVE  wrapper 自身 own keys => ["then"]
  OBSERVE  wrapper.state（经原型链透传） => 1
  OBSERVE  await wrapper 得到的类型 => "Fiber"
  OBSERVE  wrapper === await wrapper => false
  PASS     awaited 是真实 Fiber、与 wrapper 不同一 => false
```

激活抛错时 `await` **会 reject**（这点与「错误被吞掉」的常见印象相反，已实测）：

```
--- B. 插件回调抛错：await ctx.plugin() 是否 reject ---
  OBSERVE  wrapperB.state（抛错后，FAILED=3） => 3
  OBSERVE  await wrapperB 的结果 => "Error: activate-boom"
  PASS     🛑 激活抛错时 await ctx.plugin() 会 reject（适配层可据此判定失败）
  OBSERVE  logger.error 是否也收到该错误 => true
--- C. 异步 activate 抛错 ---
  OBSERVE  异步 activate 抛错时 await 的结果 => "Error: async-activate-boom"
  PASS     异步激活失败同样 reject
```

**但依赖缺失时 `await` 也 resolve**，与成功激活的 `await` 结果**无法区分**：

```
--- E. 成功插件 + 依赖缺失插件的 await 行为对照 ---
  OBSERVE  成功插件 await 结果 => "resolved"
  OBSERVE  依赖缺失插件 await 结果 => "resolved"
  OBSERVE  🛑 两者都 resolve ⇒ await 无法区分「已激活」与「依赖未满足」 => true
  OBSERVE  依赖缺失插件 real.state（PENDING=0） => 0
  OBSERVE  fiber.inject 键（用于显式依赖检查） => ["missing"]
```

**对适配层的约束**：依赖必须由**宿主自行解析依赖图并前置校验**（`PLUGIN_MANIFEST_INVALID`
/ `PLUGIN_ACTIVATION_FAILED` 携带 `detail.reason`），不能把判定外包给 Cordis 的 inject，
否则「依赖缺失」会被静默降级成「激活成功但什么都不做」。

### 结论 5：`fiber.state` 字段与 `_getState()` 会**分歧**，判定必须用 `_getState()`

```
--- A. 抛错插件：await 前 / await 后 / dispose 后的 state 序列 ---
  OBSERVE  构造后立刻 wrapper.state => 1
  OBSERVE  构造后立刻 real._getState() => 2
  OBSERVE  await reject 后 wrapper.state => 3
  OBSERVE  await reject 后 real._getState() => 3
  OBSERVE  dispose 后 wrapper.state => 3
  OBSERVE  dispose 后 real._getState() => 4
  OBSERVE  dispose 后 real.uid => null
--- C. 结论：state 字段与 _getState() 何时分歧 ---
  OBSERVE  分歧案例 => ["await 后 dispose: state=3 vs _getState=4"]
--- F. 因此适配层必须同时检查：await reject + _getState() === ACTIVE ---
  OBSERVE  最终判定规则 => "await reject → PLUGIN_ACTIVATION_FAILED；resolve 且 state===2 → 已激活；resolve 且 state===0 → 依赖未满足/拒绝激活"
```

**对适配层的约束**：宿主读状态**一律通过 `_getState()`**（适配层内部封装为
`readFiberState(fiber)`），不读 `state` 字段；`state` 只用于调试日志。

### 结论 6：`await effectWrapper` **不会**触发 disposer（上游 `then` 实现缺陷）

上游 `Fiber.effect` 的包装对象上：

```js
wrapper.then = async (onFulfilled, onRejected) => {
  return Promise.resolve(task).then(() => disposeAsync).then(onFulfilled, onRejected);
};
```

`.then(() => disposeAsync)` 把 `disposeAsync` 当作**返回值**传递，**没有调用它**。
实测 `await` 一个 effect wrapper 后 disposer 一次都没执行：

```
--- B. 通过 thenable 协议 await off()：disposer 会被执行吗 ---
  OBSERVE  await offB 的结果 => "string"
  OBSERVE  await offB 是否触发 disposer（orderB） => []
  PASS     await wrapper 不会触发 disposer（上游 then 实现缺陷：只把 disposeAsync 当值返回，未调用） => 0
  OBSERVE  🛑 影响：适配层绝不能依赖 await effectWrapper 来释放资源，必须显式调用 wrapper() => true
  OBSERVE  显式调用 offB2() 的抛错 => "Error: boom-x2"
  OBSERVE  显式调用的 orderB2 => ["x3","x2:throw"]
  PASS     显式调用能把 disposer 抛错暴露给调用方 => "Error: boom-x2"
```

**对适配层的约束**：释放**只能**靠显式调用 `wrapper()`；且要捕获同步抛错
（显式调用时 disposer 抛错是**同步逃逸**的，见结论 3 的 A 段）。

### 补充结论（同样已实测，写入回归门禁）

- **一个插件激活失败后，宿主仍能继续加载其它插件**（task-4 明确要求验证）：
  ```
  --- F. 一个插件激活失败后，宿主能否继续加载其它插件 ---
    OBSERVE  失败插件之后的新插件是否执行 => ["ok-plugin-activated"]
    PASS     🛑 单个插件激活失败不阻断宿主加载其它插件 => 1
    OBSERVE  okWrapper.state（ACTIVE=2） => 2
  ```
- **重复 dispose 安全**（幂等，不抛错）；**对激活失败的插件也可正常 dispose**：
  ```
    OBSERVE  dispose 一个激活失败的插件的结果 => "resolved"
    OBSERVE  第二次 dispose 的结果 => "resolved"
  ```
- **`ctx.extend()` 返回新对象、不就地修改原对象**，原型链单向继承，Symbol 属性原样搬运
  （`06-extend.probe.mjs`，27 checks 全绿）。
- **陷阱**：`root.extend()` **不新建 fiber**，root fiber 的 `runtime` 是 `null`，
  其 `dispose` 实为 `restart()`。**测 fiber 释放必须用 `await ctx.plugin(callback)`**
  —— 我最初的探针 04/05 就错在这里（用 `root.extend()` 测「fiber 释放」，实际测的是重启），
  已修正。这条教训留给后续维护者。

## 决策

1. **固定来源：`cordis@4.0.0-rc.11`（npm registry 上游），MIT 许可**，integrity 与文件
   sha256 记入本 ADR。**不追随上游主分支自动更新**；升级必须另开 ADR 并重跑全部 9 个探针
   （`13-决策与资料.md` 的版本锁定要求）。
2. **适配层隔离**：`cordis` 只允许被 `packages/plugin-host/src/adapter/**` 引用；
   `@yfe/plugin-sdk` **不依赖 cordis**（`packages/plugin-sdk/package.json` 的 dependencies
   只有 `@yfe/contracts`），因此第三方插件作者在类型层面**拿不到任何 Cordis 类型**。
   上层（应用层、其他包）不得直接 `import 'cordis'`。
3. **生命周期收敛为宿主自有状态机**，不暴露 Cordis 的 `FiberState` 数值：
   宿主对外只表达 `registered` / `active` / `failed` / `disabled` / `quarantined` 等
   产品语义状态，映射规则由适配层独占。
4. **激活判定 = `await plugin()` 的 reject + `_getState()` 读值**（结论 4/5），
   二者缺一不可；依赖图由宿主自校验，不依赖上游 inject 的静默降级。
5. **禁用/卸载必须带清理超时**（结论 3）：超时或清理异常 → `quarantined`，
   并记录 `PLUGIN_ACTIVATION_FAILED`（`detail.reason = 'cleanup-timeout'`），
   绝不让宿主无限等待。
6. **插件事件不依赖 isolate 隔离**（结论 1）：插件可见的事件由宿主显式路由与过滤。
7. **每个 effect 只注册一个 disposer**，多清理项由适配层自己的列表管理并逐个
   try/catch + 超时（结论 3 的「单链中断」风险）。

## 能力与安全边界（🔴 必须如实声明，不得含糊）

依据 `13-决策与资料.md` **ADR 008**：

- **本版本的插件宿主不提供安全沙箱。**
  「**不能将 Node vm、进程、Worker 当作自动沙箱**；签名也不代表安全认证」是 ADR 008 的原话。
  因此本版本**只加载可信内置插件**（`kind: 'trusted-builtin'`，且必须由宿主发行清单与
  来源验证共同确认），**不加载任意第三方代码**。
- **`PERMISSION_PLUGIN_CAPABILITY` 是「能力声明校验」，不是「安全隔离」。**
  它保证「未在 manifest 里声明的能力调用被拒绝」，属于**降级拒写**与**误用防护**；
  它**不能阻止**一个恶意插件绕过 SDK 直接使用 Node API。这一点在文档与代码注释里
  都必须写明，避免把它当成沙箱使用。
- `kind` 是**格式声明**，不是信任授予；权限列表只是**申请**，实际授权来自宿主记录
  （设计文档 `05-插件内核与SDK.md`）。
- 不向插件暴露 DSH 的会话与 Agent 结构（ADR 004）。

## 影响

- **P0 阻断项「Cordis API 未稳定」在本轮解除**：风险从「未知」变为「已知且被回归测试钉死」。
  上游若变更，9 个探针会立刻失败，而不是让产品在上线后静默出错。
- 宿主与 SDK 之间形成稳定契约，第三方插件作者只依赖 `@yfe/plugin-sdk`（零 Cordis 依赖）。
- 代价：适配层需要自己承担状态机、依赖图、超时与清理编排，**不能少写也不能透传**。
- 遗留风险见文末「未覆盖与遗留风险」。

## 复现命令

```powershell
# 1) 逐个运行探针（9 个，纯 Node，不依赖 vitest）
node packages/plugin-host/tests/probes/01-isolate.probe.mjs
node packages/plugin-host/tests/probes/02-events.probe.mjs
node packages/plugin-host/tests/probes/03-get.probe.mjs
node packages/plugin-host/tests/probes/04-effect-order.probe.mjs
node packages/plugin-host/tests/probes/05-dispose-failure.probe.mjs
node packages/plugin-host/tests/probes/06-extend.probe.mjs
node packages/plugin-host/tests/probes/07-plugin-lifecycle.probe.mjs
node packages/plugin-host/tests/probes/08-wrapper-hazards.probe.mjs
node packages/plugin-host/tests/probes/09-state-machine.probe.mjs
# 期望：每个脚本末尾 `=== probe-XX: N checks, 0 failed ===`，退出码 0

# 2) 把真实行为钉成回归门禁（宿主/SDK 的契约测试）
npx vitest run --project plugin-host
npx vitest run --project plugin-sdk

# 3) 类型门禁
npx tsc --noEmit -p packages/plugin-host/tsconfig.json
npx tsc --noEmit -p packages/plugin-sdk/tsconfig.json
```

## 未覆盖与遗留风险

1. **上游 API 可能再次变更**：本 ADR 的 9 个探针是**变更探测器**，不是兼容性保证。
   升级 cordis 必须重跑并复核本 ADR 的六条结论。
2. **未验证真实 Electron `utilityProcess` 下的行为**：与 ADR 0001 同样的环境限制
   （本机无法启动 Electron GUI），探针全部在纯 Node 下运行。
3. **`_getState()` 是上游私有方法**（下划线前缀）：适配层已把它收敛到单点
   `readFiberState()`，若上游删除它，只需改这一处；探针会直接失败报警。
4. **永久挂起的 disposer 无法被上游强杀**：Cordis 不提供强杀；宿主只能超时后
   标记 `quarantined` 并**继续服务其它插件**（不重启整个宿主）。真正的强隔离
   需要独立进程，属于 ADR 008 里「第三方代码需要真实能力隔离」的后续工作。
5. **本版本不覆盖**：插件市场、第三方代码签名校验、移动端插件运行时、
   插件间通信（这些均超出 P0-4 范围，且 ADR 004/008 已明确不在本版本承诺内）。
