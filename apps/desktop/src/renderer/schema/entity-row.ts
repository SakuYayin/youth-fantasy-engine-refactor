/**
 * 渲染层对「设定实体行」的最小要求。
 *
 * ## 为什么不用契约的 `SettingsEntity`
 *
 * `packages/contracts` 的 `SettingsEntity` 继承 `WorkspaceEntity`，要求
 * `workspaceId` / `createdAt` / `updatedAt`；而外壳（`App.vue`）拿到的是
 * `app-state` 的 `SettingsEntityView`——它只有 id / projectId / schemaTemplateId /
 * name / values / orderKey / revision / deleted。两个类型互不兼容，直接把 snapshot
 * 传进组件 props 会编译失败。
 *
 * 渲染器**实际只读** id / name / values / orderKey / createdAt（排序与新建命名用），
 * 所以这里声明一个结构化最小面：契约的 `SettingsEntity` 与 app-state 的
 * `SettingsEntityView` 都是它的超集，两边都能直接传。
 *
 * 这同时让 `packages/ui` / 渲染器**不 import `@yfe/contracts`**（ADR 0006 的取向：
 * 渲染层只认外壳递进来的数据形状，不认传输契约）。
 */
export interface EntityRow {
  readonly id: string
  readonly name: string
  readonly values: Readonly<Record<string, unknown>>
  /** 底层排序键；缺省时渲染器退回按名称排序（见 `sortRows`）。 */
  readonly orderKey?: string
  /**
   * 新建时间：`newestFirst` 页签按它倒序；缺省视为空串。
   *
   * 注意**不声明 `deleted`**：契约里它是 `DeletedFlag`（`number`），`app-state` 的视图里是
   * `boolean`，声明任何一种都会让另一边传不进来；渲染器当前也不用它（墓碑过滤在数据层做）。
   */
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly revision?: string
}
