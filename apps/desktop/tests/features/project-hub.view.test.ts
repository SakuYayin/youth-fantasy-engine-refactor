// @vitest-environment happy-dom
/// <reference path="../../src/renderer/vue-shims.d.ts" />
/**
 * 作品中心视图测试 —— W8-A。
 *
 * 断言只用**可见文本**、**调用记录**和 `data-testid`，不断言 CSS 类名与实现细节：
 * 版式随时可以改，文案与「到底调没调端口」才是契约。
 *
 * 端口是自造的完整 `ProjectHubStore` 假实现（`createHubStub()`），
 * 每个方法的返回值都能被逐条覆盖，用来验证失败路径确实把 message 摆到了界面上。
 */
import { flushPromises, mount } from '@vue/test-utils'
import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import ProjectHub from '../../src/renderer/features/project-hub.vue'
import { deleteConfirmMessage } from '../../src/renderer/features/project-hub-model.js'
import type {
  FeatureResult,
  ProjectCreateRequest,
  ProjectHubSnapshot,
  ProjectHubStore,
  ProjectSummaryView,
} from '../../src/renderer/features/types.js'

// —— 假端口 ——

interface HubStubCalls {
  refresh: number
  list: number
  create: ProjectCreateRequest[]
  rename: { readonly id: string; readonly name: string }[]
  remove: string[]
  open: string[]
  close: number
  dispose: number
}

interface HubStubOverrides {
  refresh?: FeatureResult<readonly ProjectSummaryView[]>
  create?: FeatureResult<{ readonly projectId: string }>
  rename?: FeatureResult<null>
  remove?: FeatureResult<null>
  open?: FeatureResult<null>
}

interface HubStub {
  readonly store: ProjectHubStore
  readonly calls: HubStubCalls
  readonly overrides: HubStubOverrides
  /** 改快照并通知订阅者（等一拍让 DOM 跟上）。 */
  publish(patch: Partial<ProjectHubSnapshot>): Promise<void>
  /** 当前订阅者数量（用来验证卸载时确实取消了订阅）。 */
  listenerCount(): number
}

function createHubStub(initial: Partial<ProjectHubSnapshot> = {}): HubStub {
  let snapshot: ProjectHubSnapshot = {
    projects: [],
    loading: false,
    lastError: null,
    currentProjectId: null,
    ...initial,
  }
  const listeners = new Set<(next: ProjectHubSnapshot) => void>()
  const calls: HubStubCalls = {
    refresh: 0,
    list: 0,
    create: [],
    rename: [],
    remove: [],
    open: [],
    close: 0,
    dispose: 0,
  }
  const overrides: HubStubOverrides = {}

  const store: ProjectHubStore = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh: async () => {
      calls.refresh += 1
      return overrides.refresh ?? { ok: true, value: snapshot.projects }
    },
    list: async () => {
      calls.list += 1
      return { ok: true, value: snapshot.projects }
    },
    create: async (request) => {
      calls.create.push(request)
      return overrides.create ?? { ok: true, value: { projectId: 'project-new' } }
    },
    rename: async (projectId, name) => {
      calls.rename.push({ id: projectId, name })
      return overrides.rename ?? { ok: true, value: null }
    },
    remove: async (projectId) => {
      calls.remove.push(projectId)
      return overrides.remove ?? { ok: true, value: null }
    },
    open: async (projectId) => {
      calls.open.push(projectId)
      return overrides.open ?? { ok: true, value: null }
    },
    close: async () => {
      calls.close += 1
      return { ok: true, value: null }
    },
    dispose: () => {
      calls.dispose += 1
    },
  }

  return {
    store,
    calls,
    overrides,
    async publish(patch) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener(snapshot)
      await nextTick()
    },
    listenerCount: () => listeners.size,
  }
}

function project(overrides: Partial<ProjectSummaryView> & { readonly id: string }): ProjectSummaryView {
  return {
    name: `作品-${overrides.id}`,
    summary: '',
    projectType: 'full',
    createdAt: null,
    updatedAt: null,
    revision: 'rev-1',
    ...overrides,
  }
}

/** 只按可见文案找按钮：不依赖类名，也不依赖按钮在 DOM 里的位置。 */
function buttonWithText(
  root: { findAll(selector: string): DOMWrapper<Element>[] },
  label: string,
): DOMWrapper<Element> {
  const button = root.findAll('button').find((item) => item.text() === label)
  if (button === undefined) throw new Error(`界面上没有文案为「${label}」的按钮`)
  return button
}

async function mountHub(hub: HubStub): Promise<VueWrapper<InstanceType<typeof ProjectHub>>> {
  const wrapper = mount(ProjectHub, { props: { hub: hub.store } })
  await flushPromises()
  return wrapper
}

// —— 用例 ——

describe('作品中心 / 加载与空态', () => {
  it('加载中显示「加载中…」，且不同时显示空态', async () => {
    const hub = createHubStub({ loading: true })
    const wrapper = await mountHub(hub)

    expect(wrapper.text()).toContain('加载中…')
    expect(wrapper.text()).not.toContain('还没有作品')

    await hub.publish({ loading: false })
    expect(wrapper.text()).toContain('还没有作品，点击右上角「新建小说项目」开启第一本书')
    expect(wrapper.text()).toContain('第一次使用？试试「创建示范项目」，一键体验全部功能。')
    expect(wrapper.text()).not.toContain('加载中…')
  })

  it('挂载时先取一次快照，再刷新一次并订阅', async () => {
    const hub = createHubStub()
    const wrapper = await mountHub(hub)

    expect(hub.calls.refresh).toBe(1)
    expect(hub.listenerCount()).toBe(1)

    wrapper.unmount()
    expect(hub.listenerCount()).toBe(0)
  })
})

describe('作品中心 / 分组列表', () => {
  it('按形态显示两组标题与计数胶囊', async () => {
    const hub = createHubStub({
      projects: [
        project({ id: 'p-full', projectType: 'full', name: '甲' }),
        project({ id: 'p-custom', projectType: 'custom', name: '乙' }),
        project({ id: 'p-custom-2', projectType: 'custom', name: '丙' }),
      ],
    })
    const wrapper = await mountHub(hub)

    const full = wrapper.get('[data-testid="project-hub-group-full"]')
    expect(full.text()).toContain('完整项目')
    expect(wrapper.get('[data-testid="project-hub-group-count-full"]').text()).toBe('1')
    expect(full.text()).toContain('甲')

    const custom = wrapper.get('[data-testid="project-hub-group-custom"]')
    expect(custom.text()).toContain('自定义项目')
    expect(wrapper.get('[data-testid="project-hub-group-count-custom"]').text()).toBe('2')
    expect(custom.text()).toContain('乙')
    expect(custom.text()).toContain('丙')
  })

  it('卡片显示简介与时间行，时间缺失时显示「时间未知」', async () => {
    const hub = createHubStub({
      projects: [
        project({
          id: 'p1',
          name: '长夜将至',
          summary: '灯塔与守夜人',
          createdAt: new Date(2024, 0, 2, 12, 0, 0).toISOString(),
          updatedAt: null,
        }),
      ],
    })
    const wrapper = await mountHub(hub)
    const card = wrapper.get('[data-testid="project-hub-card-p1"]')

    expect(card.text()).toContain('长夜将至')
    expect(card.text()).toContain('灯塔与守夜人')
    expect(card.text()).toContain('创建于 2024-01-02 · 最近活动 时间未知')
  })
})

describe('作品中心 / 卡片操作', () => {
  it('点「打开」会调 hub.open 并 emit open', async () => {
    const hub = createHubStub({ projects: [project({ id: 'p1' })] })
    const wrapper = await mountHub(hub)

    await wrapper.get('[data-testid="project-hub-open"]').trigger('click')
    await flushPromises()

    expect(hub.calls.open).toEqual(['p1'])
    expect(wrapper.emitted('open')).toHaveLength(1)
  })

  it('打开失败时不 emit open，转而把失败文案显示出来', async () => {
    const hub = createHubStub({ projects: [project({ id: 'p1' })] })
    hub.overrides.open = {
      ok: false,
      code: 'NOT_FOUND_PROJECT',
      message: '项目已不存在，可能已在其他窗口被删除',
    }
    const wrapper = await mountHub(hub)

    await wrapper.get('[data-testid="project-hub-open"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('open')).toBeUndefined()
    expect(wrapper.text()).toContain('项目已不存在，可能已在其他窗口被删除')
  })

  it('点「备份与恢复」会 emit backups', async () => {
    const hub = createHubStub({ projects: [project({ id: 'p1' })] })
    const wrapper = await mountHub(hub)

    await wrapper.get('[data-testid="project-hub-backups"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('backups')).toHaveLength(1)
  })

  it('行内改名：空名报「请输入书名」且不发请求，正常名走 hub.rename', async () => {
    const hub = createHubStub({ projects: [project({ id: 'p1', name: '旧名' })] })
    const wrapper = await mountHub(hub)

    await wrapper.get('[data-testid="project-hub-edit"]').trigger('click')
    const input = wrapper.get<HTMLInputElement>('[data-testid="project-hub-edit-input"]')
    expect(input.element.value).toBe('旧名')

    await input.setValue('   ')
    await buttonWithText(wrapper, '保存').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('请输入书名')
    expect(hub.calls.rename).toHaveLength(0)

    await input.setValue('  新名  ')
    await buttonWithText(wrapper, '保存').trigger('click')
    await flushPromises()
    expect(hub.calls.rename).toEqual([{ id: 'p1', name: '新名' }])
    expect(hub.calls.refresh).toBe(2)
    expect(wrapper.find('[data-testid="project-hub-edit-input"]').exists()).toBe(false)
  })

  it('删除：先弹确认，文案点名书名；确认后才调 hub.remove', async () => {
    const hub = createHubStub({ projects: [project({ id: 'p1', name: '长夜将至' })] })
    const wrapper = await mountHub(hub)

    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(false)

    await wrapper.get('[data-testid="project-hub-remove"]').trigger('click')
    const overlay = wrapper.get('[data-role="overlay"]')
    expect(overlay.text()).toContain(deleteConfirmMessage('长夜将至'))
    expect(overlay.text()).toContain('不可恢复')
    expect(hub.calls.remove).toHaveLength(0)

    await buttonWithText(overlay, '取消').trigger('click')
    await flushPromises()
    expect(hub.calls.remove).toHaveLength(0)
    expect(wrapper.find('[data-role="overlay"]').exists()).toBe(false)

    await wrapper.get('[data-testid="project-hub-remove"]').trigger('click')
    await buttonWithText(wrapper.get('[data-role="overlay"]'), '删除').trigger('click')
    await flushPromises()
    expect(hub.calls.remove).toEqual(['p1'])
    expect(hub.calls.refresh).toBe(2)
  })
})

describe('作品中心 / 新建表单', () => {
  it('空名提交显示「请输入书名」，且不调 hub.create', async () => {
    const hub = createHubStub()
    const wrapper = await mountHub(hub)

    await wrapper.get('[data-testid="project-hub-new"]').trigger('click')
    expect(wrapper.text()).toContain('新建小说项目')

    await wrapper.get('[data-testid="project-hub-create-submit"]').trigger('click')
    await flushPromises()

    expect(hub.calls.create).toHaveLength(0)
    expect(wrapper.get('[data-testid="project-hub-name-error"]').text()).toBe('请输入书名')
  })

  it('填好名称后按形态创建，空简介不传', async () => {
    const hub = createHubStub()
    const wrapper = await mountHub(hub)

    await wrapper.get('[data-testid="project-hub-new"]').trigger('click')
    await wrapper.get<HTMLInputElement>('[data-testid="project-hub-name-input"]').setValue('  长夜将至 ')
    await wrapper.get('[data-testid="project-hub-type-custom"]').setValue()
    await wrapper.get('[data-testid="project-hub-create-submit"]').trigger('click')
    await flushPromises()

    const request:
      | (ProjectCreateRequest & { readonly projectType?: string })
      | undefined = hub.calls.create[0]
    expect(request?.name).toBe('长夜将至')
    expect(request?.projectType).toBe('custom')
    expect(request?.summary).toBeUndefined()
    expect(wrapper.find('[data-testid="project-hub-create-form"]').exists()).toBe(false)
    expect(hub.calls.refresh).toBe(2)
  })

  it('创建失败时把失败文案显示出来，表单保持打开', async () => {
    const hub = createHubStub()
    hub.overrides.create = {
      ok: false,
      code: 'DISK_FULL',
      message: '项目创建失败：磁盘空间不足',
    }
    const wrapper = await mountHub(hub)

    await wrapper.get('[data-testid="project-hub-new"]').trigger('click')
    await wrapper.get<HTMLInputElement>('[data-testid="project-hub-name-input"]').setValue('长夜将至')
    await wrapper.get('[data-testid="project-hub-create-submit"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('项目创建失败：磁盘空间不足')
    expect(wrapper.find('[data-testid="project-hub-create-form"]').exists()).toBe(true)
  })
})

describe('作品中心 / 失败与重试', () => {
  it('lastError 显示 message，点「重试」调 hub.refresh', async () => {
    const hub = createHubStub({
      lastError: { code: 'LIST_FAILED', message: '作品列表读取失败：索引损坏' },
    })
    const wrapper = await mountHub(hub)

    expect(wrapper.get('[data-testid="project-hub-error-message"]').text()).toBe(
      '作品列表读取失败：索引损坏',
    )
    expect(wrapper.get('[data-testid="project-hub-error-message"]').attributes('title')).toBe(
      'LIST_FAILED',
    )

    const before = hub.calls.refresh
    await wrapper.get('[data-testid="project-hub-retry"]').trigger('click')
    await flushPromises()
    expect(hub.calls.refresh).toBe(before + 1)
  })

  it('刷新失败但仍有列表时，列表照常显示，错误条在上面', async () => {
    const hub = createHubStub({ projects: [project({ id: 'p1', name: '长夜将至' })] })
    const wrapper = await mountHub(hub)

    await hub.publish({ lastError: { code: 'REFRESH_FAILED', message: '刷新失败：连接已断开' } })

    expect(wrapper.text()).toContain('刷新失败：连接已断开')
    expect(wrapper.text()).toContain('长夜将至')
  })
})
