/**
 * W1 验收测试：`@yfe/schema-tabs` 的页签清单 / 分组 / 类型分布 / getTab / tabVisible / 题材包可切换。
 *
 * ## 🔴 首先纠正一个流传的数字：「52 个页签」是**过时的**
 *
 * 计划书（`docs/开发计划-全功能预览版.md`）与包注释里写着「50 个 TABS + editor + geomaps = 52」，
 * 但那是**制度四页签（2.7.1）落地之前**的数法。实测（`TABS.length`，本文件断言）：
 *
 * - `TABS` 运行期长度 = **54** = 50 个手写字面量 + 4 个由 `part1.ts` 的
 *   `...INSTITUTION_TABS.map(institutionTab)` **展开**出来的制度页签
 *   （`politics` / `economy` / `belief` / `justice` —— 静态 grep `TABS` 数不到，必须运行期断言）。
 * - 页签 id 总数 = **56** = 54（TABS）+ `editor`（`EDITOR_TAB`，不在 TABS）+ `geomaps`
 *   （`GEO_MAPS_TAB`，**是数据表不是页签**，故意不在 TABS）。
 * - 类型分布：`form 9` / `card 6` / `table 18` / 其余 21。计划书写的「form 5」是**手写字面量**口径
 *   （5 个手写 form + 4 个制度 form = 9）；「其余 23」= 21（TABS 内其它 type）+ `editor` + `geomaps`，
 *   与 52 那套口径配套。本文件按**运行期真相**断言，并把两个口径都写清。
 *
 * ## 覆盖点（对应 W1 验收）
 * 1. 56 个页签 id 齐全、顺序正确；50 字面量 vs 4 展开的区分。
 * 2. `GROUPS` 顺序＝侧栏顺序。
 * 3. `type` 分布。
 * 4. `getTab` 对 `geomaps` 与 `chapter-vol-<id>` 的解析。
 * 5. `tabVisible` 的 full / custom / LOCKED 三条分支（含卷台账跟随 `chapter-master`）。
 * 6. 切题材包后 `modules` 结果随之变化（getter，**未被缓存**）。
 * 7. 旧版陷阱：`cH()` 隐藏列、`SABC*` 逐字文案、制度页签真的是 getter。
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  CARD_TABLE_REF_FIELDS, CHAPTER_LEDGER_COLUMNS, DEFAULT_PACK, EDITOR_TAB, EDITOR_ID,
  GEO_MAPS_TAB, GROUPS, INSTITUTION_TABS, LOCKED_IDS, SABC, SABC_DESC, SABC_LABELS,
  TABS, getActivePack, getTab, getVolumeIdFromLedgerTab, getVolumeLedgerTabId, getVolumeTabs,
  isVolumeLedgerTab, normalizeGenrePack, refreshVolumeTabs, setActivePack, setVolumeLoader,
  setVolumeTabs, tabVisible,
} from '../src/index.js'
import type { TabDef } from '../src/index.js'

/** `TABS` 的完整 id 顺序（运行期实测；顺序即侧栏顺序，**改顺序＝改界面**，不是格式问题） */
const EXPECTED_TAB_IDS = [
  // 开书定位（3 手写 + 4 制度展开）
  'positioning', 'worldbase', 'power', 'politics', 'economy', 'belief', 'justice',
  // 大纲规划 / 运营维护
  'master', 'style',
  // 角色管理（3 卡片 + 1 表格）
  'char-main', 'char-secondary', 'char-npc', 'relations',
  // 世界构建
  'nations', 'faction-rels', 'geography', 'geography-map', 'races', 'items', 'history',
  'terms', 'misc-settings', 'worlds',
  // 大纲规划
  'chapter-master',
  // 创作管理
  'foreshadow', 'timeline', 'plot-canvas', 'hookpoints', 'progress', 'subplots', 'secrets',
  'trajectory',
  // 运营维护
  'changelog', 'ideas', 'feedback', 'about',
  // 大纲规划（卡片）
  'volume-outline', 'chapter-outline',
  // 工作面板
  'dashboard', 'model-settings', 'guide',
  // 灵感工具
  'inspire-tools', 'bookbreak', 'creative-writing', 'check-tools', 'material-library',
  // 酒馆模式（8 个）
  'tavern-control', 'tavern-world', 'tavern-plot', 'tavern-report', 'tavern-free', 'tavern-run',
  'tavern-script', 'tavern-card',
] as const

afterEach(() => {
  setActivePack(DEFAULT_PACK)
  setVolumeTabs([])
  setVolumeLoader(null)
})

describe('页签清单（TABS / EDITOR_TAB / GEO_MAPS_TAB）', () => {
  it('TABS 共 54 项，id 与顺序逐位正确，无重复', () => {
    expect(TABS.length).toBe(54)
    expect(TABS.map(t => t.id)).toEqual([...EXPECTED_TAB_IDS])
    expect(new Set(TABS.map(t => t.id)).size).toBe(TABS.length)
  })

  it('54 = 50 个手写字面量 + 4 个由 INSTITUTION_TABS.map 展开的制度页签', () => {
    // 制度四页签不在任何 `id: '...'` 字面量里（静态 grep 数不到）—— 只能这样运行期证明它们真的在 TABS 里
    expect(TABS.length - INSTITUTION_TABS.length).toBe(50)
    for (const id of INSTITUTION_TABS) {
      expect(TABS.some(t => t.id === id)).toBe(true)
    }
    // 且它们占据 power 之后、master 之前的连续四位（part1.ts 的展开位置）
    const start = TABS.findIndex(t => t.id === 'power') + 1
    expect(TABS.slice(start, start + 4).map(t => t.id)).toEqual([...INSTITUTION_TABS])
  })

  it('editor 与 geomaps 都**不在** TABS 里（一个走 EDITOR_TAB，一个是隐藏数据表）', () => {
    expect(TABS.some(t => t.id === EDITOR_ID)).toBe(false)
    expect(TABS.some(t => t.id === GEO_MAPS_TAB.id)).toBe(false)
    // 因此页签 id 总数 56 = 54 + editor + geomaps
    const allIds = new Set<string>([...TABS.map(t => t.id), EDITOR_TAB.id, GEO_MAPS_TAB.id])
    expect(allIds.size).toBe(56)
    expect(EDITOR_TAB).toMatchObject({ id: 'editor', group: '正文写作', type: 'editor' })
    expect(EDITOR_TAB).not.toBe(TABS.find(t => t.id === 'editor'))
  })

  it('GEO_MAPS_TAB 的隐藏列语义保留（底图模式 / 底图 两列 cH）', () => {
    expect(GEO_MAPS_TAB.type).toBe('table')
    expect(GEO_MAPS_TAB.columns?.filter(c => c.hidden).map(c => c.name)).toEqual(['底图模式', '底图'])
    // 封闭枚举：只允许这两个值
    expect(GEO_MAPS_TAB.columns?.find(c => c.name === '底图模式')?.options).toEqual(['格子', '图片'])
  })
})

describe('GROUPS（侧栏分组顺序）', () => {
  it('顺序＝侧栏顺序，10 项一字不差', () => {
    expect(GROUPS).toEqual([
      '工作面板', '正文写作', '灵感工具', '开书定位', '角色管理',
      '世界构建', '大纲规划', '酒馆模式', '创作管理', '运营维护',
    ])
  })

  it('每个页签的 group 都在 GROUPS 里；正文写作只归 editor', () => {
    for (const t of TABS) expect(GROUPS).toContain(t.group)
    expect(TABS.filter(t => t.group === '正文写作')).toEqual([])
    expect(EDITOR_TAB.group).toBe('正文写作')
  })
})

describe('type 分布', () => {
  it('form 9 / card 6 / table 18 / 其余 21（合计 54）', () => {
    const count = (type: string) => TABS.filter(t => t.type === type).length
    expect(count('form')).toBe(9)   // 5 个手写 + 4 个制度展开（计划书的「form 5」是手写口径）
    expect(count('card')).toBe(6)
    expect(count('table')).toBe(18)
    expect(count('editor')).toBe(0) // editor 不在 TABS
    const others = TABS.filter(t => !['form', 'card', 'table'].includes(t.type))
    expect(others.length).toBe(21)
    expect(9 + 6 + 18 + 21).toBe(54)
    // 计划书口径的「其余 23」= 21 + editor + geomaps
    expect(others.length + 2).toBe(23)
  })

  it('酒馆模式 8 个页签的 type 都是各自的专属面板类型', () => {
    const tavern = TABS.filter(t => t.group === '酒馆模式')
    expect(tavern.map(t => t.id)).toEqual([
      'tavern-control', 'tavern-world', 'tavern-plot', 'tavern-report',
      'tavern-free', 'tavern-run', 'tavern-script', 'tavern-card',
    ])
    for (const t of tavern) expect(t.type).toBe(t.id)
  })
})

describe('getTab', () => {
  it('解析 geomaps（不在 TABS 的隐藏数据表）', () => {
    expect(getTab(GEO_MAPS_TAB.id)).toBe(GEO_MAPS_TAB)
  })

  it('editor 不经 getTab（取 `undefined`，调用方直接用 EDITOR_TAB）—— 与 upstream 语义一致', () => {
    expect(getTab(EDITOR_ID)).toBeUndefined()
  })

  it('未知 id 返回 undefined，且 TABS 里的 id 都能取到', () => {
    expect(getTab('nope')).toBeUndefined()
    for (const t of TABS) expect(getTab(t.id)).toBe(t)
  })

  it('解析运行期合成的卷台账 chapter-vol-<卷id>', () => {
    expect(getTab('chapter-vol-v1')).toBeUndefined() // 未合成前不存在
    setVolumeTabs([{ id: 'v1', title: '第一卷' }, { id: 'v2', title: '' }])
    const vt = getTab(getVolumeLedgerTabId('v1'))
    expect(vt).toMatchObject({
      id: 'chapter-vol-v1', name: '第一卷', group: '大纲规划', type: 'table',
      displayCol: '章节标题', subtitleCol: '细纲状态', newestFirst: true,
    })
    expect(vt?.columns).toBe(CHAPTER_LEDGER_COLUMNS) // 共用同一套列定义
    expect(getTab('chapter-vol-v2')?.name).toBe('未命名卷') // 空标题兜底
  })

  it('卷台账 id 工具：前缀约定与反解', () => {
    expect(getVolumeLedgerTabId('v1')).toBe('chapter-vol-v1')
    expect(isVolumeLedgerTab('chapter-vol-v1')).toBe(true)
    expect(isVolumeLedgerTab('chapter-master')).toBe(false)
    expect(getVolumeIdFromLedgerTab('chapter-vol-v1')).toBe('v1')
    expect(getVolumeIdFromLedgerTab('chapter-master')).toBe('chapter-master') // 非台账 id 原样返回
    // 注意：getVolumeTabs() 给的是**合成后的 TabDef 列表**（id 已带 chapter-vol- 前缀），不是原始 vols
    expect(getVolumeTabs()).toEqual([])
    setVolumeTabs([{ id: 'v1', title: '第一卷' }, { id: 'v2', title: '第二卷' }])
    expect(getVolumeTabs().map(t => t.id)).toEqual(['chapter-vol-v1', 'chapter-vol-v2'])
    expect(getVolumeTabs().map(t => getVolumeIdFromLedgerTab(t.id))).toEqual(['v1', 'v2']) // 前缀往返一致
  })

  it('refreshVolumeTabs 走注入的加载器；未注入时是安全空操作', async () => {
    setVolumeTabs([{ id: 'stale', title: '旧卷' }])
    await refreshVolumeTabs() // 未注入 → 不抛错、也不清空
    expect(getVolumeTabs().map(v => v.id)).toEqual(['chapter-vol-stale'])
    setVolumeLoader(async () => [{ id: 'v9', title: '第九卷' }])
    await refreshVolumeTabs()
    expect(getVolumeTabs().map(v => v.id)).toEqual(['chapter-vol-v9'])
    // 刷新后新卷可被 getTab 解析（宿主打开项目时就是这么接的）
    expect(getTab('chapter-vol-v9')?.name).toBe('第九卷')
    // 加载器抛错时静默吞掉，保留上一次的缓存（upstream 语义）
    setVolumeLoader(async () => { throw new Error('db not ready') })
    await refreshVolumeTabs()
    expect(getVolumeTabs().map(v => v.id)).toEqual(['chapter-vol-v9'])
  })
})

describe('tabVisible', () => {
  it('type === "full"：全部可见（含 editor / geomaps / 卷台账）', () => {
    const full = { type: 'full' as const, features: [] as string[] }
    for (const t of TABS) expect(tabVisible(t.id, full)).toBe(true)
    expect(tabVisible(EDITOR_ID, full)).toBe(true)
    expect(tabVisible(GEO_MAPS_TAB.id, full)).toBe(true)
    expect(tabVisible('chapter-vol-v1', full)).toBe(true)
  })

  it('custom：LOCKED_IDS 的 8 项恒可见，其余未勾选一律隐藏', () => {
    const custom = { type: 'custom' as const, features: [] as string[] }
    expect(LOCKED_IDS).toEqual([
      'editor', 'dashboard', 'model-settings', 'guide', 'inspire-tools',
      'material-library', 'check-tools', 'about',
    ])
    for (const id of LOCKED_IDS) expect(tabVisible(id, custom)).toBe(true)
    expect(tabVisible('tavern-run', custom)).toBe(false)
    expect(tabVisible('bookbreak', custom)).toBe(false)
    expect(tabVisible('politics', custom)).toBe(false)
  })

  it('custom：features 里勾了的才显示', () => {
    const ctx = { type: 'custom' as const, features: ['char-main', 'politics'] }
    expect(tabVisible('char-main', ctx)).toBe(true)
    expect(tabVisible('politics', ctx)).toBe(true)
    expect(tabVisible('char-secondary', ctx)).toBe(false)
  })

  it('卷台账跟随 chapter-master 的可见性', () => {
    expect(tabVisible('chapter-vol-v1', { type: 'custom', features: [] })).toBe(false)
    expect(tabVisible('chapter-vol-v1', { type: 'custom', features: ['chapter-master'] })).toBe(true)
  })
})

describe('题材包：modules 是 getter，切包即时生效且不缓存', () => {
  const packDriven = ['worldbase', 'power', ...INSTITUTION_TABS]

  it('六个题材驱动页签的 modules（worldbase 另有 name）是 getter，不是启动时求值的数组', () => {
    for (const id of packDriven) {
      const tab = getTab(id) as TabDef
      expect(tab).toBeDefined()
      const desc = Object.getOwnPropertyDescriptor(tab, 'modules')
      expect(typeof desc?.get).toBe('function')
      expect(desc?.value).toBeUndefined() // 没有数据属性副本
    }
    expect(typeof Object.getOwnPropertyDescriptor(getTab('worldbase'), 'name')?.get).toBe('function')
  })

  it('切到「西方奇幻」后同一对象读到的模块随题材变化，切回即还原（未被缓存）', () => {
    const wb = getTab('worldbase') as TabDef
    const pw = getTab('power') as TabDef
    expect(getActivePack()).toBe('东方修真')
    const dfWb = wb.modules?.map(m => m.name)
    const dfPw = pw.modules?.map(m => m.name)
    expect(dfWb).toContain('二、底层法则（定了不改）')
    expect(dfPw).toContain('二、修炼路径与资源')

    setActivePack('西方奇幻')
    expect(getActivePack()).toBe('西方奇幻')
    // 🔴 同一个 tab 对象，模块名已经变了 —— 证明是 getter 读当前包，而不是构造时快照
    expect(wb.modules?.map(m => m.name)).toContain('二、魔力本源与神系')
    expect(pw.modules?.map(m => m.name)).toContain('二、魔法体系')
    // 制度页签的**示例**也随题材走（字段名与 desc 不变）
    const politics = getTab('politics') as TabDef
    expect(politics.modules?.[0]?.fields[0]?.name).toBe('政体形式')
    expect(politics.modules?.[0]?.fields[0]?.example).toContain('神权王国')

    setActivePack('东方修真')
    expect(wb.modules?.map(m => m.name)).toEqual(dfWb)
    expect(pw.modules?.map(m => m.name)).toEqual(dfPw)
  })

  it('未知 / 别名 / 复合题材一律归一（normalizeGenrePack 语义），活动包始终合法', () => {
    expect(DEFAULT_PACK).toBe('东方修真')
    const wb = getTab('worldbase') as TabDef
    const before = wb.modules?.map(m => m.name)
    expect(normalizeGenrePack('西方奇幻')).toBe('西方奇幻')       // 精确包名
    expect(normalizeGenrePack('仙侠')).toBe('东方修真')           // 别名表
    expect(normalizeGenrePack('都市修仙')).toBe('都市异能')       // 别名表（历史脏值不许丢题材）
    expect(normalizeGenrePack('东方玄幻·升级流')).toBe('东方修真') // 模糊包含
    expect(normalizeGenrePack('不存在的题材')).toBe(DEFAULT_PACK) // 兜底
    expect(normalizeGenrePack('')).toBe(DEFAULT_PACK)
    expect(normalizeGenrePack(undefined)).toBe(DEFAULT_PACK)
    setActivePack(normalizeGenrePack('武侠'))
    expect(getActivePack()).toBe('武侠江湖')
    setActivePack(DEFAULT_PACK)
    expect(wb.modules?.map(m => m.name)).toEqual(before)
  })
})

describe('旧版逐字文案（防改写抽查）', () => {
  it('保密等级五档与说明逐字一致', () => {
    expect(SABC).toEqual(['S', 'A', 'B', 'C', 'D'])
    expect(SABC_DESC).toBe('信息档位：决定「谁看得到」与「谁先占上下文预算」。S=绝密（角色视角看不到）／D=终结（弃用）：已用完或不再使用的数据，任何情况下都不提供给 AI')
    expect(SABC_LABELS).toEqual({
      S: 'S · 绝密（剧透）', A: 'A · 重要（主线）', B: 'B · 次要（支线）',
      C: 'C · 琐碎（日常）', D: 'D · 终结（弃用）',
    })
  })

  it('角色卡的跨表引用字段与卷台账列逐字一致', () => {
    expect(CARD_TABLE_REF_FIELDS).toEqual({
      '所属势力': { tabId: 'nations', col: '名称', multi: true },
      '种族': { tabId: 'races', col: '名称' },
      '地理位置': { tabId: 'geography', col: '名称' },
    })
    expect(CHAPTER_LEDGER_COLUMNS.map(c => c.name)).toEqual([
      '章节号', '章节标题', '一句话事件', '出场人物', '埋设伏笔编号', '回收伏笔编号',
      '细纲状态', '字数', '发布日期', '备注',
    ])
  })

  it('页签名抽查（中文文案不许改写）', () => {
    const nameOf = (id: string) => getTab(id)?.name
    expect(nameOf('positioning')).toBe('作品信息')
    expect(nameOf('char-npc')).toBe('NPC角色')
    expect(nameOf('geography-map')).toBe('地图编辑')
    expect(nameOf('tavern-script')).toBe('故事剧本')
    expect(nameOf('material-library')).toBe('素材资料')
    expect(GEO_MAPS_TAB.name).toBe('地图')
  })
})
