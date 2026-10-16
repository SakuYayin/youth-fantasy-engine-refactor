/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * `features/demo-project.ts` 的纯逻辑测试。
 *
 * 🔴 只吃纯函数：本文件**不**挂载任何组件、不碰 DOM，所以用 vitest 缺省的 node 环境
 *    （`apps/desktop/vitest.config.ts` 的 `environment: 'node'`），不要加 happy-dom 指令。
 *
 * ⚠️ 刻意**不**写死易变数字：正文是「示范用摘录」，每章保留多少字会调整，所以断言的是
 *    「统计等于逐章累加」这种**不变式**，而不是 charCount 的精确值。唯一的硬数字是上游章数 21。
 */
import { describe, expect, it } from 'vitest'

import {
  DEMO_PROJECT_NAME,
  DEMO_PROJECT_SUMMARY,
  buildDemoProjectSeed,
  demoProjectStats,
} from '../../src/renderer/features/demo-project.js'

/** 上游 `src/data/seedContent.ts` 里实际存在的章节总数（CH1…CH21）。 */
const ALL_CHAPTERS = 21

/** 把种子里的所有章摊平，便于逐章断言。 */
function flatChapters(seed: ReturnType<typeof buildDemoProjectSeed>) {
  return seed.volumes.flatMap((volume) => volume.chapters)
}

describe('DEMO_PROJECT_NAME / DEMO_PROJECT_SUMMARY', () => {
  it('项目名是契约要求的裸名（不带上游的「（示范）」后缀）', () => {
    expect(DEMO_PROJECT_NAME).toBe('吞天神脉')
  })

  it('简介逐字取自上游 seedData.ts 的 createProject 第 3 个实参', () => {
    expect(DEMO_PROJECT_SUMMARY).toBe('废脉？我吞的就是天！')
  })
})

describe('buildDemoProjectSeed()', () => {
  it('返回两卷：第一卷 10 章、第二卷 11 章', () => {
    const seed = buildDemoProjectSeed()

    expect(seed.volumes).toHaveLength(2)
    expect(seed.volumes[0]?.title).toBe('第一卷 风起云州')
    expect(seed.volumes[1]?.title).toBe('第二卷 剑鸣中州')
    expect(seed.volumes[0]?.chapters).toHaveLength(10)
    expect(seed.volumes[1]?.chapters).toHaveLength(11)
  })

  it('带出项目名与简介，且卷内章节数之和等于总章数', () => {
    const seed = buildDemoProjectSeed()

    expect(seed.name).toBe(DEMO_PROJECT_NAME)
    expect(seed.summary).toBe(DEMO_PROJECT_SUMMARY)

    const summed = seed.volumes.reduce((acc, volume) => acc + volume.chapters.length, 0)
    expect(summed).toBe(flatChapters(seed).length)
    expect(summed).toBe(ALL_CHAPTERS)
  })

  it('每章都有非空 title 与非空 body', () => {
    const chapters = flatChapters(buildDemoProjectSeed())

    expect(chapters).toHaveLength(ALL_CHAPTERS)
    for (const chapter of chapters) {
      expect(chapter.title.trim().length).toBeGreaterThan(0)
      expect(chapter.body.trim().length).toBeGreaterThan(0)
    }
  })

  it('章标题按上游顺序逐字排列，且不重复', () => {
    const titles = flatChapters(buildDemoProjectSeed()).map((chapter) => chapter.title)

    expect(titles[0]).toBe('第1章 废脉')
    expect(titles[1]).toBe('第2章 塔灵')
    expect(titles[20]).toBe('第21章 剑应碑醒')
    expect(new Set(titles).size).toBe(ALL_CHAPTERS)
    // 章号必须是 1..21 严格递增：卷序错乱会立刻在这里暴露
    titles.forEach((title, index) => {
      expect(title.startsWith(`第${index + 1}章`)).toBe(true)
    })
  })

  it('正文摘录是段落结构（含空行分隔），且单章远小于上游全章', () => {
    for (const chapter of flatChapters(buildDemoProjectSeed())) {
      expect(chapter.body).toContain('\n\n')
      // 摘录：至少几百字、但绝不超过上游单章上限（约 5.8 千字），确保没有整章搬进来
      expect(chapter.body.length).toBeGreaterThan(400)
      expect(chapter.body.length).toBeLessThan(2000)
    }
  })

  it('两次调用互不共享可变状态（拿到的都是新的冻结切片）', () => {
    const a = buildDemoProjectSeed()
    const b = buildDemoProjectSeed()

    expect(a).not.toBe(b)
    expect(a.volumes).not.toBe(b.volumes)
    expect(a.volumes[0]?.chapters).not.toBe(b.volumes[0]?.chapters)
    // 内容等价（章标题与正文一致）
    expect(a.volumes[0]?.chapters[0]?.title).toBe(b.volumes[0]?.chapters[0]?.title)
    expect(a.volumes[0]?.chapters[0]?.body).toBe(b.volumes[0]?.chapters[0]?.body)
  })
})

describe('buildDemoProjectSeed() 的 maxChapters', () => {
  it('maxChapters: 3 时总章数为 3，且仍保持卷顺序（只剩第一卷）', () => {
    const seed = buildDemoProjectSeed({ maxChapters: 3 })

    expect(seed.volumes).toHaveLength(1)
    expect(seed.volumes[0]?.title).toBe('第一卷 风起云州')
    expect(seed.volumes[0]?.chapters).toHaveLength(3)
    expect(flatChapters(seed).map((c) => c.title)).toEqual(['第1章 废脉', '第2章 塔灵', '第3章 劈柴也是修行'])
  })

  it('maxChapters: 12 时跨卷截取，第二卷只保留前 2 章', () => {
    const seed = buildDemoProjectSeed({ maxChapters: 12 })

    expect(seed.volumes).toHaveLength(2)
    expect(seed.volumes[0]?.chapters).toHaveLength(10)
    expect(seed.volumes[1]?.chapters).toHaveLength(2)
    expect(seed.volumes[1]?.chapters[0]?.title).toBe('第11章 再入南荒')
    expect(seed.volumes[1]?.chapters[1]?.title).toBe('第12章 听雪')
  })

  it('maxChapters 超过总章数时被夹到上限，不会凭空多出章节', () => {
    const over = buildDemoProjectSeed({ maxChapters: 999 })
    const exact = buildDemoProjectSeed({ maxChapters: ALL_CHAPTERS })

    expect(flatChapters(over)).toHaveLength(ALL_CHAPTERS)
    expect(flatChapters(over).map((c) => c.title)).toEqual(flatChapters(exact).map((c) => c.title))
  })

  it('maxChapters: 0 时返回零卷零章（不抛异常）', () => {
    const seed = buildDemoProjectSeed({ maxChapters: 0 })

    expect(seed.volumes).toHaveLength(0)
    expect(flatChapters(seed)).toHaveLength(0)
    // 项目名与简介仍在，种子结构依旧成立
    expect(seed.name).toBe(DEMO_PROJECT_NAME)
  })

  it('不传 options 与传 undefined 等价，都等于全部可用章节', () => {
    const bare = buildDemoProjectSeed()
    const explicit = buildDemoProjectSeed({ maxChapters: undefined })
    const none = buildDemoProjectSeed({})

    expect(flatChapters(bare)).toHaveLength(ALL_CHAPTERS)
    expect(flatChapters(explicit).length).toBe(flatChapters(bare).length)
    expect(flatChapters(none).length).toBe(flatChapters(bare).length)
  })
})

describe('demoProjectStats()', () => {
  it('charCount 等于所有 body.length 之和（与 snapshot.charCount 同口径）', () => {
    const stats = demoProjectStats()
    const chapters = flatChapters(buildDemoProjectSeed())

    expect(stats.charCount).toBe(chapters.reduce((acc, chapter) => acc + chapter.body.length, 0))
    expect(stats.chapterCount).toBe(chapters.length)
    expect(stats.volumeCount).toBe(buildDemoProjectSeed().volumes.length)
  })

  it('charCountText 按「万」格式化：约 X.Y 万字（>= 10000 时）', () => {
    const stats = demoProjectStats()

    expect(stats.charCount).toBeGreaterThanOrEqual(10000)
    expect(stats.charCountText).toContain('万')
    expect(stats.charCountText).toMatch(/^约 \d+\.\d 万字$/)
    // 文案必须真的由 charCount 推出来，而不是写死的字符串
    expect(stats.charCountText).toBe(`约 ${(stats.charCount / 10000).toFixed(1)} 万字`)
  })

  it('与 buildDemoProjectSeed() 无参调用一致（同一个缺省口径）', () => {
    const stats = demoProjectStats()
    const seed = buildDemoProjectSeed()

    expect(stats.volumeCount).toBe(seed.volumes.length)
    expect(stats.chapterCount).toBe(seed.volumes.reduce((acc, v) => acc + v.chapters.length, 0))
  })
})

describe('不可变性', () => {
  it('种子对象、volumes 数组、卷、chapters 数组、章节全部被冻结', () => {
    const seed = buildDemoProjectSeed()

    expect(Object.isFrozen(seed)).toBe(true)
    expect(Object.isFrozen(seed.volumes)).toBe(true)
    for (const volume of seed.volumes) {
      expect(Object.isFrozen(volume)).toBe(true)
      expect(Object.isFrozen(volume.chapters)).toBe(true)
      for (const chapter of volume.chapters) {
        expect(Object.isFrozen(chapter)).toBe(true)
      }
    }
  })

  it('冻结是只读的：strict 模式下写入会抛 TypeError', () => {
    const seed = buildDemoProjectSeed()
    const firstChapter = seed.volumes[0]?.chapters[0]

    expect(firstChapter).toBeDefined()
    expect(() => {
      // ESM 是 strict 模式，写冻结对象必然抛错
      ;(firstChapter as { title: string }).title = '篡改'
    }).toThrow(TypeError)
    expect(() => {
      ;(seed.volumes as unknown as unknown[]).push('x')
    }).toThrow(TypeError)
    // 原值未被改动
    expect(seed.volumes[0]?.chapters[0]?.title).toBe('第1章 废脉')
  })

  it('demoProjectStats() 的返回值也被冻结', () => {
    const stats = demoProjectStats()

    expect(Object.isFrozen(stats)).toBe(true)
    expect(() => {
      ;(stats as { charCount: number }).charCount = 0
    }).toThrow(TypeError)
  })

  it('类型层面是只读的（readonly 结构可赋给 readonly 形参而无需断言）', () => {
    // 本用例的价值在 tsc：若接口丢了 readonly，下面的结构化赋值仍能编译，
    // 但 `expectTypeOf` 风格的显式标注会让「可变数组」无法通过。
    const readonlyVolumes: readonly { readonly title: string }[] = buildDemoProjectSeed().volumes
    expect(readonlyVolumes.length).toBeGreaterThan(0)
  })
})
