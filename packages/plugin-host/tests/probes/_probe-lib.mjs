// 共享探针工具：只做断言与打印，不依赖 vitest。
// 用法：node packages/plugin-host/tests/probes/<name>.probe.mjs
let failures = 0
let checks = 0

export function record(label, actual) {
  checks += 1
  console.log(`  OBSERVE  ${label} => ${format(actual)}`)
  return actual
}

export function expect(label, actual, expected) {
  checks += 1
  const pass = Object.is(actual, expected)
  if (!pass) failures += 1
  console.log(`  ${pass ? 'PASS' : 'FAIL'}     ${label} => ${format(actual)}${pass ? '' : ` (expected ${format(expected)})`}`)
  return pass
}

export function expectDeep(label, actual, expected) {
  checks += 1
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const pass = a === e
  if (!pass) failures += 1
  console.log(`  ${pass ? 'PASS' : 'FAIL'}     ${label} => ${a}${pass ? '' : ` (expected ${e})`}`)
  return pass
}

export function section(title) {
  console.log(`\n--- ${title} ---`)
}

export function format(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

export function summary(name) {
  console.log(`\n=== ${name}: ${checks} checks, ${failures} failed ===`)
  if (failures > 0) process.exitCode = 1
}

/** 带超时的等待，避免永久挂起把探针进程拖死。 */
export function withTimeout(promise, ms, tag) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(`<<TIMEOUT after ${ms}ms: ${tag}>>`), ms)
  })
  return Promise.race([promise.then(() => 'resolved'), timeout]).finally(() => clearTimeout(timer))
}
