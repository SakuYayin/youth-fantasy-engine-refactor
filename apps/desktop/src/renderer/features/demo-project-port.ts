/**
 * 示范项目《吞天神脉》的创建编排。
 *
 * 用途：作为 `features/ports.ts` 里 `WelcomePort.createDemoProject()` 的实现
 * （注入 `FeaturePortDeps.createDemoProject`，接线由 Lead 负责）。
 *
 * 设计要点：
 * 1. **串行**：SQLite 与应用层幂等都不喜欢并发写，所有 `invoke` 调用按
 *    「作品 → 卷 → 章 → 正文」的顺序逐条 await，不做 `Promise.all`。
 * 2. `seedFirstChapter: false`：卷章由我们自己播种。存储层若再塞一遍
 *    「第一卷 / 第 1 章」，作品里就会多出重复的卷和章。
 * 3. **幂等键**：卷/章/正文分别用 `demo_<projectId>_vol<i>`、
 *    `demo_<projectId>_ch<i>`、`demo_<projectId>_body<i>`。键必须匹配
 *    `ID_PATTERN = /^[0-9a-zA-Z][0-9a-zA-Z_-]{0,127}$/` 且不含 `..`
 *    （`packages/contracts/src/ids.ts:56`），所以键里不能出现冒号。
 *    `createProject` **不传**幂等键：对「创建示范项目」来说固定键等于
 *    「第二次点击复用旧作品」，而需求正好相反——再点一次要建出一个新作品。
 * 4. **绝不删旧作品**：不做上游 `_upstream_tmp/youth-fantasy-engine-main/src/lib/app/seedData.ts`
 *    那种「先按名字删掉旧示范项目再重建」——用户可能已经往里写了东西。
 *    允许存在多个同名作品。
 * 5. **失败即回滚**：任一步失败就 `deleteProject` 掉这次建出的作品；回滚本身
 *    失败也不覆盖原始错误，只在文案后面追加一句提示。
 * 6. **永不 throw**：`invoke` 抛出的异常都折算成 `INTERNAL_ERROR`，
 *    返回值永远是 `FeatureResult`。
 */

import type {
  DocumentCreateInput,
  DocumentCreateOutput,
  ErrorPayload,
  ProjectCreateInput,
  ProjectCreateOutput,
  ProjectDeleteInput,
  ProjectDeleteOutput,
  Result,
  SaveDraftInput,
  SaveDraftOutput,
  WriteContext,
} from '@yfe/contracts'

import { buildDemoProjectSeed, type DemoProjectSeed } from './demo-project.js'
import type { FeatureResult } from './types.js'

/** 注入点：示范项目编排需要的四个用例调用（可逐字对齐 `@yfe/client-sdk` 的客户端）。 */
export interface DemoProjectInvoke {
  readonly createProject: (input: ProjectCreateInput) => Promise<Result<ProjectCreateOutput>>
  readonly createDocument: (input: DocumentCreateInput) => Promise<Result<DocumentCreateOutput>>
  readonly saveDraft: (input: SaveDraftInput) => Promise<Result<SaveDraftOutput>>
  readonly deleteProject: (input: ProjectDeleteInput) => Promise<Result<ProjectDeleteOutput>>
}

/** 示范项目编排的依赖。 */
export interface DemoProjectDeps {
  readonly invoke: DemoProjectInvoke
  /** 工作区 id（桌面单机固定 `ws_local`，由调用方传 `LOCAL_WORKSPACE_ID`）。 */
  readonly workspaceId: string
  /** 请求号工厂（主用 `crypto.randomUUID`）。 */
  readonly newRequestId: () => string
  /** 章节正文草稿的会话 id 工厂（缺省 `() => 'demo_' + ...`）。 */
  readonly newSessionId?: () => string
}

/** 建示范项目；失败时**回滚**已建的作品。 */
export function createDemoProject(
  deps: DemoProjectDeps,
): () => Promise<FeatureResult<{ readonly projectId: string }>> {
  // 种子每次现取现用：`buildDemoProjectSeed()` 返回的是新对象，不会共享可变状态。
  return () => createDemoProjectWith(buildDemoProjectSeed(), deps)
}

/** 同样的编排，但注入种子（测试用 `maxChapters` 缩小规模）。 */
export async function createDemoProjectWith(
  seed: DemoProjectSeed,
  deps: DemoProjectDeps,
): Promise<FeatureResult<{ readonly projectId: string }>> {
  const state: DemoRunState = { projectId: null }
  let failure: DemoFailure
  try {
    const seeded = await seedProjectContent(seed, deps, state)
    if (seeded === null) {
      const created = state.projectId
      if (created !== null) return { ok: true, value: { projectId: created } }
      // 理论上不可达：没有失败却也没拿到作品 id，只能按返回结果不完整处理。
      failure = missingFieldFailure(STEP_CREATE_PROJECT, 'projectId')
    } else {
      failure = seeded
    }
  } catch (cause) {
    // 兜底：`callStep` 已经吞掉 invoke 的异常，这里只防编排自身的意外。
    failure = internalFailure(STEP_ORCHESTRATION, cause)
  }

  const projectId = state.projectId
  // 作品还没建出来（`createProject` 就失败了）就没有东西可清理。
  if (projectId === null) return failure
  return await rollback(projectId, deps, failure)
}

/** 编排内部的失败态：就是 `FeatureResult` 的失败分支。 */
interface DemoFailure {
  readonly ok: false
  readonly code: string
  readonly message: string
}

/** 单步调用的结果：成功带值，失败带可直接返回的失败态。 */
type StepResult<T> = { readonly ok: true; readonly value: T } | DemoFailure

/** 编排内部的可变状态：回滚要知道已建出的作品 id。 */
interface DemoRunState {
  projectId: string | null
}

const STEP_ORCHESTRATION = '创建示范项目'
const STEP_CREATE_PROJECT = '创建示范作品'
const STEP_ROLLBACK = '回滚删除未完成的示范作品'
const ROLLBACK_INCOMPLETE_NOTE = '（清理未完成，作品中心里可能留下一个空作品）'
/** 契约里 `templateId` 表示完整模板；示范项目要全套卷章骨架。 */
const TEMPLATE_ID = 'full'
/** 新建文档的首次正文写入。 */
const DRAFT_SEQUENCE = 1

/**
 * 串行播种：作品 → 每卷 → 卷内每章 → 该章正文。
 *
 * 返回 `null` 表示全部成功，否则返回第一个失败（此时已经 `state.projectId` 可回滚）。
 */
async function seedProjectContent(
  seed: DemoProjectSeed,
  deps: DemoProjectDeps,
  state: DemoRunState,
): Promise<DemoFailure | null> {
  const created = await callStep(STEP_CREATE_PROJECT, () =>
    deps.invoke.createProject({
      context: writeContext(deps, null, null),
      name: seed.name,
      summary: seed.summary,
      templateId: TEMPLATE_ID,
      // 卷章自己播种，避免存储层再补一套「第一卷 / 第 1 章」。
      seedFirstChapter: false,
    }),
  )
  if (!created.ok) return created

  const projectId = created.value.projectId
  if (!isNonEmptyString(projectId)) return missingFieldFailure(STEP_CREATE_PROJECT, 'projectId')
  state.projectId = projectId

  // 一次编排算一个草稿会话：每章都是新文档，`saveDraft` 的 (documentId, sessionId)
  // 水位互不干扰，共用一个会话 id 更省事。
  const sessionId = (deps.newSessionId ?? defaultSessionId)()

  // 步骤 2：先把所有卷建出来，拿到各自的 documentId（章节要挂到卷下面）。
  const volumeDocumentIds: DocumentCreateInput['parentId'][] = []
  for (const [volumeIndex, volume] of seed.volumes.entries()) {
    const volumeStep = volumeStepLabel(volumeIndex)
    const createdVolume = await callStep(volumeStep, () =>
      deps.invoke.createDocument({
        context: writeContext(deps, projectId, null, `demo_${projectId}_vol${volumeIndex + 1}`),
        projectId: projectId as DocumentCreateInput['projectId'],
        kind: 'volume',
        parentId: null,
        title: volume.title,
        placement: { mode: 'end' },
      }),
    )
    if (!createdVolume.ok) return createdVolume

    const volumeDocumentId = createdVolume.value.documentId
    if (!isNonEmptyString(volumeDocumentId)) return missingFieldFailure(volumeStep, 'documentId')
    volumeDocumentIds.push(volumeDocumentId as DocumentCreateInput['parentId'])
  }

  // 章在整批里连续编号（跨卷不重置），保证 `_ch<i>` / `_body<i>` 全局唯一。
  let chapterOrdinal = 0

  // 步骤 3-4：逐卷逐章创建，并**立即**把该章正文写进去。
  for (const [volumeIndex, volume] of seed.volumes.entries()) {
    const volumeDocumentId = volumeDocumentIds[volumeIndex]
    if (!isNonEmptyString(volumeDocumentId)) {
      return missingFieldFailure(volumeStepLabel(volumeIndex), 'documentId')
    }

    for (const [chapterIndex, chapter] of volume.chapters.entries()) {
      chapterOrdinal += 1
      const chapterStep = chapterStepLabel(volumeIndex, chapterIndex)
      const createdChapter = await callStep(chapterStep, () =>
        deps.invoke.createDocument({
          context: writeContext(deps, projectId, null, `demo_${projectId}_ch${chapterOrdinal}`),
          projectId: projectId as DocumentCreateInput['projectId'],
          kind: 'chapter',
          parentId: volumeDocumentId as DocumentCreateInput['parentId'],
          title: chapter.title,
          placement: { mode: 'end' },
        }),
      )
      if (!createdChapter.ok) return createdChapter

      const chapterDocumentId = createdChapter.value.documentId
      const chapterRevision = createdChapter.value.revision
      if (!isNonEmptyString(chapterDocumentId) || !isNonEmptyString(chapterRevision)) {
        return missingFieldFailure(chapterStep, 'documentId 或 revision')
      }

      const savedDraft = await callStep(draftStepLabel(volumeIndex, chapterIndex), () =>
        deps.invoke.saveDraft({
          // 🔴 这里必须是新建文档返回的 revision，不是 null
          // （null 只用于「新建实体」；写成 null 会静默丢掉乐观锁，正文也可能白写）。
          context: writeContext(
            deps,
            projectId,
            chapterRevision,
            `demo_${projectId}_body${chapterOrdinal}`,
          ),
          documentId: chapterDocumentId,
          draftSequence: DRAFT_SEQUENCE,
          body: chapter.body,
          sessionId,
        }),
      )
      if (!savedDraft.ok) return savedDraft
    }
  }

  return null
}

/** 失败后清理：删掉这次建出的作品，但不覆盖原始错误。 */
async function rollback(
  projectId: string,
  deps: DemoProjectDeps,
  failure: DemoFailure,
): Promise<DemoFailure> {
  const cleaned = await callStep(STEP_ROLLBACK, () =>
    deps.invoke.deleteProject({
      // 新上下文 + expectedRevision null：刚建出来的作品本来就没有「已知版本」。
      context: writeContext(deps, projectId, null),
      projectId: projectId as ProjectDeleteInput['projectId'],
    }),
  )
  if (cleaned.ok) return failure
  return {
    ok: false,
    code: failure.code,
    message: `${failure.message}${ROLLBACK_INCOMPLETE_NOTE}`,
  }
}

/** 跑一步 invoke：成功返回值，失败/抛异常都折算成失败态，永不 throw。 */
async function callStep<T>(step: string, run: () => Promise<Result<T>>): Promise<StepResult<T>> {
  try {
    const result = await run()
    if (result.ok) return { ok: true, value: result.value }
    return failureOf(step, result.error)
  } catch (cause) {
    return internalFailure(step, cause)
  }
}

/** 契约错误 → 中文失败文案：`<哪一步>失败：<错误码> — <原始说明>`。 */
function failureOf(step: string, error: ErrorPayload): DemoFailure {
  const code = isNonEmptyString(error.code) ? error.code : 'INTERNAL_ERROR'
  const detail = isNonEmptyString(error.message) ? error.message.trim() : ''
  return {
    ok: false,
    code,
    message: detail === '' ? `${step}失败：${code}` : `${step}失败：${code} — ${detail}`,
  }
}

/** invoke 抛异常时折算成 INTERNAL_ERROR（同样带上是哪一步）。 */
function internalFailure(step: string, cause: unknown): DemoFailure {
  return {
    ok: false,
    code: 'INTERNAL_ERROR',
    message: `${step}失败：INTERNAL_ERROR — ${describeThrown(cause)}`,
  }
}

/** 存储层返回的结果缺字段：按 INTERNAL_ERROR 处理，不静默降级。 */
function missingFieldFailure(step: string, field: string): DemoFailure {
  return {
    ok: false,
    code: 'INTERNAL_ERROR',
    message: `${step}失败：INTERNAL_ERROR — 返回结果缺少 ${field}`,
  }
}

function describeThrown(cause: unknown): string {
  if (cause instanceof Error) return cause.message === '' ? cause.name : cause.message
  if (typeof cause === 'string' && cause !== '') return cause
  return '未知错误'
}

/**
 * 构造 `WriteContext`。
 *
 * `projectId` 传真实作品 id（`createDocument` / `saveDraft` 都要求它与
 * `context` 一致），`expectedRevision` 只在改已有实体时给值。
 */
function writeContext(
  deps: DemoProjectDeps,
  projectId: string | null,
  expectedRevision: string | null,
  idempotencyKey?: string,
): WriteContext {
  const context = {
    requestId: deps.newRequestId() as WriteContext['requestId'],
    workspaceId: deps.workspaceId as WriteContext['workspaceId'],
    projectId: projectId === null ? null : (projectId as WriteContext['projectId']),
    expectedRevision:
      expectedRevision === null ? null : (expectedRevision as WriteContext['expectedRevision']),
  }
  return idempotencyKey === undefined
    ? context
    : { ...context, idempotencyKey: idempotencyKey as WriteContext['idempotencyKey'] }
}

/** 缺省会话 id 工厂：与渲染层 `ui_${crypto.randomUUID()}` 同款，前缀区分来源。 */
function defaultSessionId(): string {
  return `demo_${crypto.randomUUID()}`
}

function volumeStepLabel(volumeIndex: number): string {
  return `创建第 ${volumeIndex + 1} 卷`
}

function chapterStepLabel(volumeIndex: number, chapterIndex: number): string {
  return `创建第 ${volumeIndex + 1} 卷第 ${chapterIndex + 1} 章`
}

function draftStepLabel(volumeIndex: number, chapterIndex: number): string {
  return `保存第 ${volumeIndex + 1} 卷第 ${chapterIndex + 1} 章正文`
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}
