/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * 启动失败兜底页的纯逻辑测试（`boot-error-model.ts` · A-04）。
 *
 * 这里只吃纯函数与常量表 —— 不挂载组件、不碰 DOM：
 * 「任意抛出物 → 视图模型」是规则，六种输入本该是六行断言，而不是六次挂载。
 * 可见文本与回调调用次数归 `boot-error.view.test.ts`。
 *
 * 覆盖的输入形态刻意比上游宽：上游 `App.tsx:281` 只处理 `Error` 与「其余 `String(e)`」，
 * 而兜底页必须对跨进程反序列化后的裸对象（`{message:'x'}`，`instanceof Error` 为假）、
 * `null`、甚至抛错的 getter 都给出可读文案 —— 它自己抛异常就真只剩黑屏。
 */
import { describe, expect, it } from 'vitest'

import {
  BOOT_BACKUP_HINT,
  BOOT_ERROR_TITLE,
  BOOT_RECOVERY_STEPS,
  BOOT_RELOAD_LABEL,
  BOOT_TECHNICAL_SUMMARY,
  BOOT_UNKNOWN_DETAIL,
  MAX_MESSAGE_LENGTH,
  MAX_NAME_LENGTH,
  MESSAGE_TRUNCATED_SUFFIX,
  NAME_TRUNCATED_SUFFIX,
  bootErrorDetail,
  toBootErrorView,
  truncateMessage,
  truncateText,
} from '../../src/renderer/features/boot-error-model.js'

/** 造一个带 name / message / stack 的真 `Error`（`name` 手工改写，模拟 TypeError 之类）。 */
function namedError(name: string, message: string, stack = 'Error: 演示堆栈'): Error {
  const error = new Error(message)
  error.name = name
  error.stack = stack
  return error
}

// ==================== 上游真源：文案逐字 ====================

describe('兜底页文案与上游逐字一致', () => {
  it('标题、按钮、备份提醒逐字来自 App.tsx:467/469/471', () => {
    // 这三条是「还原」的核心证据：一个字都不许改，改了就不再是同一页。
    expect(BOOT_ERROR_TITLE).toBe('启动失败')
    expect(BOOT_RELOAD_LABEL).toBe('重新加载')
    expect(BOOT_BACKUP_HINT).toBe(
      '若反复失败，请先备份数据文件（左下角「数据坞」），再重新加载。',
    )
  })

  it('中文文案全部非空：标题 / 提醒 / 兜底正文 / 折叠块标题', () => {
    for (const text of [
      BOOT_ERROR_TITLE,
      BOOT_BACKUP_HINT,
      BOOT_UNKNOWN_DETAIL,
      BOOT_TECHNICAL_SUMMARY,
    ]) {
      expect(typeof text).toBe('string')
      expect(text.trim().length).toBeGreaterThan(0)
    }
  })

  it('视图模型把标题与提醒原样带出来（组件不许自己写文案）', () => {
    const view = toBootErrorView(new Error('任意'))

    expect(view.title).toBe(BOOT_ERROR_TITLE)
    expect(view.hint).toBe(BOOT_BACKUP_HINT)
  })
})

// ==================== 恢复步骤 ====================

describe('恢复步骤', () => {
  it('非空，且每条都非空、都是给用户看的中文', () => {
    expect(BOOT_RECOVERY_STEPS.length).toBeGreaterThan(0)

    for (const step of BOOT_RECOVERY_STEPS) {
      expect(typeof step).toBe('string')
      expect(step.trim().length).toBeGreaterThan(0)
    }

    // 步骤是「用户能做的事」：至少两条，一条不够叫分步指引。
    expect(BOOT_RECOVERY_STEPS.length).toBeGreaterThanOrEqual(2)
  })

  it('视图模型带出同一份步骤（只读共享，不需要每次拷贝）', () => {
    const view = toBootErrorView(null)

    expect(view.steps).toBe(BOOT_RECOVERY_STEPS)
  })
})

// ==================== Error 实例 ====================

describe('Error 实例', () => {
  it('name 与 message 分开取出，正文是「名称：消息」', () => {
    const view = toBootErrorView(namedError('TypeError', '数据库文件被占用，无法写入'))

    expect(view.name).toBe('TypeError')
    expect(view.message).toBe('数据库文件被占用，无法写入')
    expect(view.detail).toBe('TypeError：数据库文件被占用，无法写入')
    expect(view.hasError).toBe(true)
  })

  it('只有 message、name 为空的 Error：正文退化成纯消息，不出现裸「：」', () => {
    const error = new Error('迁移脚本失败')
    error.name = ''

    const view = toBootErrorView(error)

    expect(view.name).toBe('')
    expect(view.message).toBe('迁移脚本失败')
    expect(view.detail).toBe('迁移脚本失败')
    expect(view.detail).not.toContain('：')
  })

  it('message 为空串的 Error：正文用 name 顶上，绝不留空', () => {
    const view = toBootErrorView(namedError('Error', ''))

    expect(view.message).toBe('')
    expect(view.detail).toBe('Error')
    expect(view.detail.trim().length).toBeGreaterThan(0)
  })

  it('自定义 name 不被改写（上游只存 message，这里把 name 也带上是增强而非编造）', () => {
    const view = toBootErrorView(namedError('BootFailure', '无'))

    expect(view.name).toBe('BootFailure')
    expect(view.message).toBe('无')
  })
})

// ==================== 非 Error 抛出物 ====================

describe('非 Error 抛出物', () => {
  it('抛字符串：message 就是字符串本身，name 为空（对齐上游 String(e)）', () => {
    const view = toBootErrorView('数据库连接失败')

    expect(view.name).toBe('')
    expect(view.message).toBe('数据库连接失败')
    expect(view.detail).toBe('数据库连接失败')
    expect(view.hasError).toBe(true)
  })

  it('抛数字：整体 String() 成正文（`throw 42` 也要看得懂）', () => {
    const view = toBootErrorView(42)

    expect(view.message).toBe('42')
    expect(view.name).toBe('')
    expect(view.detail).toBe('42')
  })

  it('抛 Symbol 不炸：读到 `Symbol(x)` 形态的文本而不是抛异常', () => {
    const view = toBootErrorView(Symbol('boom'))

    expect(view.message).toBe('Symbol(boom)')
    expect(view.hasError).toBe(true)
  })
})

// ==================== null / undefined：兜底文案 ====================

describe('没有错误信息时的兜底', () => {
  it('null：hasError 为假、正文是兜底文案、没有堆栈', () => {
    const view = toBootErrorView(null)

    expect(view.hasError).toBe(false)
    expect(view.detail).toBe(BOOT_UNKNOWN_DETAIL)
    expect(view.detail.trim().length).toBeGreaterThan(0)
    expect(view.hasStack).toBe(false)
    expect(view.stack).toBe('')
    expect(view.name).toBe('')
    expect(view.message).toBe('')
  })

  it('undefined：与 null 同一条兜底路径（外壳漏传也不会白屏）', () => {
    const view = toBootErrorView(undefined)

    expect(view.hasError).toBe(false)
    expect(view.detail).toBe(BOOT_UNKNOWN_DETAIL)
    expect(view.hasStack).toBe(false)
  })
})

// ==================== 截断 ====================

describe('超长文本截断', () => {
  it('超长 message 截到上限并追加说明后缀，开头仍然可读', () => {
    const long = `${'x'.repeat(2000)}结尾`

    const view = toBootErrorView(new Error(long))

    expect(view.message.length).toBe(MAX_MESSAGE_LENGTH + MESSAGE_TRUNCATED_SUFFIX.length)
    expect(view.message.startsWith('x')).toBe(true)
    expect(view.message.endsWith(MESSAGE_TRUNCATED_SUFFIX)).toBe(true)
    expect(view.message).not.toContain('结尾')
    expect(view.detail).toContain(MESSAGE_TRUNCATED_SUFFIX)
  })

  it('正好等于上限的消息不截断、不加后缀（边界不许多砍一个字符）', () => {
    const exact = 'y'.repeat(MAX_MESSAGE_LENGTH)

    expect(truncateMessage(exact)).toBe(exact)
    expect(truncateMessage(exact)).not.toContain(MESSAGE_TRUNCATED_SUFFIX)
  })

  it('超长 name 也截断，且截断说明用的是省略号不是 message 那句', () => {
    const view = toBootErrorView(namedError('N'.repeat(MAX_NAME_LENGTH + 50), '短消息'))

    expect(view.name.length).toBe(MAX_NAME_LENGTH + NAME_TRUNCATED_SUFFIX.length)
    expect(view.name.endsWith(NAME_TRUNCATED_SUFFIX)).toBe(true)
    expect(view.detail.startsWith('N'.repeat(MAX_NAME_LENGTH))).toBe(true)
  })

  it('truncateText 是纯函数：空串与未超限原样返回，不引入后缀', () => {
    expect(truncateText('', 10, '…')).toBe('')
    expect(truncateText('短', 10, '…')).toBe('短')
    expect(truncateText('abcdef', 3, '…')).toBe('abc…')
  })
})

// ==================== stack ====================

describe('堆栈', () => {
  it('stack 缺失时 hasStack 为假、stack 是空串（不自己拼一个假堆栈）', () => {
    const error = new Error('没有堆栈')
    error.stack = undefined

    const view = toBootErrorView(error)

    expect(view.stack).toBe('')
    expect(view.hasStack).toBe(false)
    // 但错误本身还在：没有堆栈不等于没有错误。
    expect(view.hasError).toBe(true)
    expect(view.detail).toBe('Error：没有堆栈')
  })

  it('stack 存在时逐字保留在视图里（只显示，组件负责折进 <details>）', () => {
    const stack = 'TypeError: 炸了\n    at boot (App.tsx:281:7)'

    const view = toBootErrorView(namedError('TypeError', '炸了', stack))

    expect(view.stack).toBe(stack)
    expect(view.hasStack).toBe(true)
  })
})

// ==================== 不可信输入 ====================

describe('不可信输入不抛异常', () => {
  it('裸对象 {message:"x"}（跨进程反序列化后 instanceof Error 为假）仍取出消息', () => {
    const view = toBootErrorView({ message: 'IPC 返回了畸形错误' })

    expect(view.message).toBe('IPC 返回了畸形错误')
    expect(view.name).toBe('')
    expect(view.detail).toBe('IPC 返回了畸形错误')
    expect(view.hasError).toBe(true)
  })

  it('对象带 name / stack 字符串字段时一并取出', () => {
    const view = toBootErrorView({ name: 'IpcError', message: '通道断开', stack: 'at ipc' })

    expect(view.name).toBe('IpcError')
    expect(view.message).toBe('通道断开')
    expect(view.stack).toBe('at ipc')
    expect(view.hasStack).toBe(true)
    expect(view.detail).toBe('IpcError：通道断开')
  })

  it('字段类型不对（{message:42} / 空对象）不猜语义：回落兜底正文', () => {
    for (const bad of [{ message: 42 }, {}, []]) {
      const view = toBootErrorView(bad)

      expect(view.hasError).toBe(false)
      expect(view.detail).toBe(BOOT_UNKNOWN_DETAIL)
    }
  })

  it('抛布尔：与上游 String(e) 同义地得到 "true"，不回落兜底（有信息就不该说没信息）', () => {
    const view = toBootErrorView(true)

    expect(view.message).toBe('true')
    expect(view.detail).toBe('true')
    expect(view.hasError).toBe(true)
  })

  it('字段是抛错的 getter 时也被兜住（兜底页自己不许抛异常）', () => {
    const hostile = Object.defineProperty({}, 'message', {
      get(): string {
        throw new Error('getter 故意炸')
      },
    })

    const view = toBootErrorView(hostile)

    expect(view.hasError).toBe(false)
    expect(view.detail).toBe(BOOT_UNKNOWN_DETAIL)
  })
})

// ==================== 能力开关 ====================

describe('能力开关', () => {
  it('默认允许重新加载、也默认显示备份提醒（= 上游行为）', () => {
    const view = toBootErrorView(new Error('炸了'))

    expect(view.canReload).toBe(true)
    expect(view.canOpenBackupDir).toBe(true)
    expect(view.hint).toBe(BOOT_BACKUP_HINT)
  })

  it('外壳说没有备份入口 / 不允许重载时，两个开关分别为假', () => {
    const view = toBootErrorView(new Error('炸了'), {
      backupEntryAvailable: false,
      reloadAvailable: false,
    })

    expect(view.canReload).toBe(false)
    expect(view.canOpenBackupDir).toBe(false)
  })

  it('显式给 true 与缺省同义（不因为传了对象就漂）', () => {
    const view = toBootErrorView(new Error('炸了'), {
      backupEntryAvailable: true,
      reloadAvailable: true,
    })

    expect(view.canReload).toBe(true)
    expect(view.canOpenBackupDir).toBe(true)
  })
})

// ==================== 正文拼装 ====================

describe('bootErrorDetail 拼装规则', () => {
  it('名称与消息都有 → 「名称：消息」；只有名称 → 名称；都没有 → 兜底', () => {
    expect(bootErrorDetail('TypeError', 'msg')).toBe('TypeError：msg')
    expect(bootErrorDetail('TypeError', '')).toBe('TypeError')
    expect(bootErrorDetail('', 'msg')).toBe('msg')
    expect(bootErrorDetail('', '')).toBe(BOOT_UNKNOWN_DETAIL)
  })
})

// ==================== 无副作用 ====================

describe('视图模型无副作用', () => {
  it('同一输入连续两次得到相同内容（不缓存、不改写输入对象）', () => {
    const error = namedError('TypeError', '同样的错误')

    const first = toBootErrorView(error)
    const second = toBootErrorView(error)

    expect(second).toEqual(first)
    // 不许把截断/加工写回原 Error。
    expect(error.message).toBe('同样的错误')
  })
})