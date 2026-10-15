/**
 * ============================================================================
 * 桌面宿主适配器：把 `@yfe/application` 的端口接到 `@yfe/persistence-sqlite`
 * ============================================================================
 *
 * ## 它在架构里的位置
 *
 * ```
 * renderer → preload → main（service-host）→ db-worker.mjs（本目录）
 *                                                 │  用例调用
 *                                                 ▼
 *                                       @yfe/application（用例 + 端口定义）
 *                                                 │  ApplicationPorts
 *                                                 ▼
 *                                        本文件（适配器 / 组装点）
 *                                                 │  具体驱动调用
 *                                                 ▼
 *                        @yfe/persistence-sqlite（schema / repositories / saveDraft）
 * ```
 *
 * 三条不变量：
 * 1. `@yfe/application` **不 import 任何驱动**，只认 `packages/application/src/ports.ts`
 *    里的端口形状；
 * 2. 端口一律 `async`，而 persistence 是**同步**的：本文件负责把同步调用包成
 *    `Promise`，并把 `Result` **原样透传**（`Err` 绝不被改写成 `ok`，也绝不被吞掉）；
 * 3. 🔴 **本文件是唯一允许 import 具体驱动（better-sqlite3 / SQL）的边界**。
 *    UI、路由、用例层都不许再出现 better-sqlite3 或裸 SQL。这里出现的每一行 SQL
 *    都是「包出口还没提供公开函数」的权宜之计，逐条附 TODO。
 *
 * ## 两处契约缺口与各自的权宜之计（ID 分叉一条已修）
 *
 * 1. ~~**实体 ID 分叉**~~ **已修（R-18）**：`repositories/projects.ts` 的
 *    `createProject(input & { projectId? })` 与 `repositories/documents.ts` 的
 *    `createDocument(input & { documentId? })` 现在**优先使用调用方传入的 ID**，
 *    只有不传时才 `newIds.x(deps.rng)` 自生成（供迁移脚本 / 直连测试使用）。
 *    本文件因此把用例层生成的 `request.projectId` / `request.documentId` 原样透传，
 *    落库 ID 与返回给客户端的 ID 必然同源——原先的「钉住随机源」已删除。
 *
 * 2. **工作区行**：`projects.workspace_id REFERENCES workspaces(id)`，且 repository
 *    在事务内额外调 `loadAliveWorkspace`（`repositories/projects.ts:139-154`）
 *    复核，所以**建作品前工作区行必须已存在**；但 persistence 包没有导出任何
 *    建/确保工作区的函数。权宜之计：{@link ensureWorkspaceRow}。
 *    TODO(P1-A3)：由 repository 层正式导出 `ensureWorkspace` / `createWorkspace`。
 *
 * 3. **归属读函数**：按 `documentId` 读权威归属行（workspaceId/projectId/revision/deleted）
 *    在 repository 里是 `internal.ts` 的 `loadOwnership`，**刻意未从包出口导出**。
 *    权宜之计：{@link loadOwnershipRow} 直接写一条参数化 SELECT。
 *    TODO(P1-A3)：请正式导出公开的 ownership 读函数（如 `loadDocumentOwnership`），
 *    避免归属查询在仓内存在两份定义——包外这一份就在本文件，只有这一处。
 */

import { createHash } from 'node:crypto';
import { APP_VERSION, cryptoRandomSource, errOf, ok, toErrorPayload } from '@yfe/contracts';
import { saveDraft as saveDraftTransaction } from '@yfe/persistence-sqlite';
import {
  createDocument as insertDocument,
  createProject as insertProject,
  createSettingsEntity as insertSettingsEntity,
  getDocument as readDocument,
  getSettingsEntity as readSettingsEntity,
  listDocumentTree as readDocumentTree,
  listSettingsEntities as readSettingsEntities,
  listSettingsEntitiesInWorkspace as readSettingsEntitiesInWorkspace,
  updateSettingsEntity,
} from '@yfe/persistence-sqlite/repositories';

// ---------------------------------------------------------------------------
// 权宜之计 2：确保工作区行存在（TODO 归 P1-A3）
// ---------------------------------------------------------------------------

/**
 * 幂等地写入本地权限上下文行。
 *
 * 只补「这一行不存在」，不覆盖已有行——「已存在但已软删」的情况必须让
 * repository 的 `loadAliveWorkspace` 照常报 `NOT_FOUND`，不在这里偷偷复活。
 */
function ensureWorkspaceRow(db, workspaceId, occurredAt, revisions) {
  db.prepare(
    `INSERT INTO workspaces
       (id, name, schema_version, revision, revision_seq, deleted, created_at, updated_at)
     VALUES (?, ?, 1, ?, 0, 0, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(workspaceId, '本地工作区', revisions.next(1), occurredAt, occurredAt);
}

// ---------------------------------------------------------------------------
// 权宜之计 3：读文档权威归属行（TODO 归 P1-A3）
// ---------------------------------------------------------------------------

/**
 * 参数化读取归属事实（不含正文）。
 *
 * 返回 `null` **只表示「文档不存在」**：工作区不匹配绝不在这里返回 `null`，
 * 否则跨工作区写入会伪装成 404（见 `ports.ts:177-184` 的硬性要求）。
 */
function loadOwnershipRow(db, documentId) {
  const row = db
    .prepare('SELECT id, workspace_id, project_id, revision, deleted FROM documents WHERE id = ?')
    .get(documentId);
  if (row === undefined || row === null) return null;
  return {
    documentId: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    revision: row.revision,
    deleted: Number(row.deleted),
  };
}

// ---------------------------------------------------------------------------
// 错误归一：跨进程载荷必须脱敏
// ---------------------------------------------------------------------------

/** `readSystemStatus()` 端口没有 requestId 入参，用与用例层一致的稳定占位符。 */
const UNKNOWN_REQUEST_ID = 'req-unknown';

/**
 * 把抛出物归一成契约 `Err`，并**剥掉 `cause`**。
 *
 * `toErrorPayload()` 会把原始 `Error.message`（better-sqlite3 驱动原文、绝对路径）
 * 放进 `cause`，那条字段只允许本地调试；本函数产出的载荷可能被 `respond()` 原样
 * 外发，所以在这里就摘掉。
 */
function errorResult(thrown, requestId, fallbackMessage) {
  const payload = toErrorPayload(thrown, requestId ?? UNKNOWN_REQUEST_ID, fallbackMessage);
  const { cause: _cause, ...rest } = payload;
  return { ok: false, error: rest };
}

/** 端口统一的时间戳来源：把用例的 `occurredAt` **原样**当作写入时间戳。 */
function clockAt(occurredAt) {
  return { now: () => occurredAt };
}

// ---------------------------------------------------------------------------
// 端口实现
// ---------------------------------------------------------------------------

/**
 * 用一条已迁移的 SQLite 连接装配 `ApplicationPorts`。
 *
 * @param {object} options
 * @param {any} options.db                      已迁移的 better-sqlite3 连接（worker 独占）
 * @param {any} options.ids                     与用例层**同一个** ApplicationIdGenerator
 * @param {any} options.revisions               与用例层**同一个** RevisionGenerator
 * @param {() => ({path: string, schemaVersion: number} | null)} options.describeDatabase
 *        读运行时事实；库已关闭时返回 `null`
 * @returns {any} ApplicationPorts
 */
export function createSqliteApplicationPorts({ db, ids, revisions, describeDatabase }) {
  const receiptId = (key) => `receipt_${createHash('sha256').update(key).digest('hex')}`;
  return {
    // 本地命令回执复用 operations 的已开放实体类型空间；不创建 outbox，绝不同步。
    // db-worker 将整条用例与回执放入同一事务，并串行执行，崩溃后不会重复创建实体。
    idempotency: {
      async find(key) {
        const row = db.prepare(
          "SELECT payload_json FROM operations WHERE op_id = ? AND entity_type = 'application-receipt'",
        ).get(receiptId(key));
        if (!row) return null;
        const record = JSON.parse(row.payload_json);
        if (record?.key !== key || typeof record.scope !== 'string' || typeof record.value !== 'string') {
          throw new Error('本地命令回执损坏');
        }
        return record;
      },
      async save(record) {
        const identity = JSON.parse(record.requestIdentity ?? '[]');
        const workspaceId = identity[0];
        if (typeof workspaceId !== 'string') throw new Error('本地命令回执缺少工作区');
        const id = receiptId(record.key);
        db.prepare(`INSERT INTO operations
          (op_id, batch_id, workspace_id, entity_type, entity_id, project_id,
           base_revision, new_revision, action, payload_json, actor, created_at)
          VALUES (?, ?, ?, 'application-receipt', ?, NULL, NULL, 'local-receipt-v1', 'upsert', ?, NULL, ?)`)
          .run(id, id, workspaceId, id, JSON.stringify(record), new Date().toISOString());
      },
    },
    // -- 草稿 --------------------------------------------------------------
    draft: {
      /** 读归属快照。null 仅表示不存在（工作区不匹配由用例层比对后报 PERMISSION_*）。 */
      async loadDocument(documentId) {
        return loadOwnershipRow(db, documentId);
      },

      /**
       * 提交草稿。
       *
       * `@yfe/persistence-sqlite` 的 `saveDraft(db, input, deps)` 内部就在**同一事务**里
       * 按 `06-数据与本地存储.md` 的顺序完成：重读归属行 → 复核 workspace/deleted/
       * projectId → 比对 `expectedRevision` 做 CAS → 写正文与新 revision → 写版本记录
       * → 写 operation 与 outbox；失败整体回滚。所以它天然满足
       * `DraftPersistencePort.commitDraft` 的 TOCTOU 与原子性要求，本文件不再自己开事务。
       *
       * `charCount` 也由 persistence 用 `@yfe/domain` 的 `countChars(body)` 算出，
       * 不使用 `body.length`。
       */
      async commitDraft(request) {
        const requestId = request?.input?.context?.requestId;
        try {
          return saveDraftTransaction(db, request.input, {
            // occurredAt 原样作为写入时间戳（savedAt 回传同一个值）
            clock: clockAt(request.occurredAt),
            ids,
            revisionGenerator: revisions,
          });
        } catch (thrown) {
          return errorResult(thrown, requestId, '保存草稿失败');
        }
      },
    },

    // -- 作品 --------------------------------------------------------------
    projects: {
      async createProject(request) {
        const requestId = request?.context?.requestId;
        try {
          // 契约里 templateId 可为 undefined，端口归一是 null；repository 只接受 string|undefined。
          // 工作区行必须先在：provider 的 loadAliveWorkspace 会复核它（见文件头权宜之计 2）。
          ensureWorkspaceRow(db, request.context.workspaceId, request.occurredAt, revisions);
          const written = insertProject(
            db,
            {
              context: request.context,
              name: request.name,
              summary: request.summary,
              seedFirstChapter: request.seedFirstChapter,
              templateId: request.templateId ?? undefined,
              // R-18：用例层先生成 projectId（幂等重放必须回同一个 ID），
              // repository 现在原样采用它；不传时才自生成。
              projectId: request.projectId,
            },
            {
              clock: clockAt(request.occurredAt),
              // rng 只服务 repository 自己播的种子文档（「第一卷」「第 1 章」）等内部 ID
              rng: cryptoRandomSource,
              revisionGenerator: revisions,
            },
          );
          if (!written.ok) return written;
          // 端口只承诺 { revision }；projectId 由用例层自己持有并返回
          return ok({ revision: written.value.revision });
        } catch (thrown) {
          return errorResult(thrown, requestId, '新建作品失败');
        }
      },
    },

    // -- 文档 --------------------------------------------------------------
    documents: {
      async createDocument(request) {
        const requestId = request?.context?.requestId;
        try {
          const written = insertDocument(
            db,
            {
              context: request.context,
              projectId: request.projectId,
              kind: request.kind,
              parentId: request.parentId,
              title: request.title,
              placement: request.placement,
              // R-18：documentId 同理，用例层生成的 ID 必须原样落库
              documentId: request.documentId,
            },
            {
              clock: clockAt(request.occurredAt),
              rng: cryptoRandomSource,
              revisionGenerator: revisions,
            },
          );
          if (!written.ok) return written;
          return ok({ revision: written.value.revision, orderKey: written.value.orderKey });
        } catch (thrown) {
          return errorResult(thrown, requestId, '新建文档失败');
        }
      },

      /** 返回契约的 `DocumentGetOutput`（摘要 + 正文）；repository 已按 workspaceId 过滤。 */
      async getDocument(request) {
        const requestId = request?.context?.requestId;
        try {
          return readDocument(db, { context: request.context, documentId: request.documentId });
        } catch (thrown) {
          return errorResult(thrown, requestId, '读取文档失败');
        }
      },

      /**
       * 平铺文档树（不含正文）。
       *
       * 形状翻译：repository 回 `{ documents: [...] }`，而端口承诺的是
       * `readonly DocumentSummary[]`（用例层再包回 `{ documents }`）。
       */
      async listDocumentTree(request) {
        const requestId = request?.context?.requestId;
        try {
          const listed = readDocumentTree(db, {
            context: request.context,
            projectId: request.projectId,
            includeDeleted: request.includeDeleted,
          });
          if (!listed.ok) return listed;
          return ok(listed.value.documents);
        } catch (thrown) {
          return errorResult(thrown, requestId, '读取文档树失败');
        }
      },
    },

    // -- 设定实体 ----------------------------------------------------------
    settingsEntities: {
      /**
       * 列设定实体。
       *
       * 形状翻译：repository 回 `Result<readonly SettingsEntity[]>`，端口也承诺数组
       * （用例层再包成 `{ entities }`），所以直接透传。
       *
       * `projectId === null` 表示「跨作品列出该工作区全部设定实体」：存储层没有
       * 「projectId 可选」的读函数，走 {@link readSettingsEntitiesInWorkspace}。
       * 反过来，**给了非法 projectId 绝不在本层降级**成全工作区查询——那是把
       * 「读错范围」伪装成「读到了」，用例层已先行拦下。
       */
      async listSettingsEntities(request) {
        const requestId = request?.context?.requestId;
        try {
          if (request.projectId === null) {
            return readSettingsEntitiesInWorkspace(db, {
              context: request.context,
              schemaTemplateId: request.schemaTemplateId ?? undefined,
              includeDeleted: request.includeDeleted,
            });
          }
          return readSettingsEntities(db, {
            context: request.context,
            projectId: request.projectId,
            schemaTemplateId: request.schemaTemplateId ?? undefined,
            includeDeleted: request.includeDeleted,
          });
        } catch (thrown) {
          return errorResult(thrown, requestId, '列出设定实体失败');
        }
      },

      /**
       * 读单个设定实体。
       *
       * 形状：端口承诺 `Result<SettingsEntity>`（**裸实体**），`{ entity }` 由用例层
       * 组成 IPC 的 `SettingsEntityGetOutput`。这里多包一层会让用例的形状门禁
       * 把 payload 判成非法（`id`/`projectId` 都在 `entity` 里面）——别包。
       * repository 已按 workspaceId 过滤（跨工作区 → PERMISSION_WORKSPACE_MISMATCH）。
       */
      async getSettingsEntity(request) {
        const requestId = request?.context?.requestId;
        try {
          return readSettingsEntity(db, request.context, request.entityId);
        } catch (thrown) {
          return errorResult(thrown, requestId, '读取设定实体失败');
        }
      },

      /**
       * 新建或更新设定实体。
       *
       * `orderKey === null` 的含义按新建/更新而不同，映射到存储层两个不同能力：
       * - 新建：`null` → `placement: { mode: 'end' }`（追加到末尾）；
       *      非 null → `placement: { mode: 'explicit', orderKey }`。
       * - 更新：`null` → patch **不带** orderKey（保持原位置，不重排）；
       *      非 null → patch 带 `orderKey` 重排。
       *
       * 更新路径的 orderKey 用回读拿权威值：调用方没给重排时不重排，此时当前值
       * 只在库里，端口却承诺回 `orderKey`，所以读一次比猜一个更诚实。
       */
      async saveSettingsEntity(request) {
        const requestId = request?.context?.requestId;
        try {
          const repositoryDeps = {
            clock: clockAt(request.occurredAt),
            rng: cryptoRandomSource,
            revisionGenerator: revisions,
          };
          if (request.isCreate) {
            const written = insertSettingsEntity(
              db,
              {
                context: request.context,
                projectId: request.projectId,
                schemaTemplateId: request.schemaTemplateId,
                name: request.name,
                values: request.values,
                placement:
                  request.orderKey === null
                    ? { mode: 'end' }
                    : { mode: 'explicit', orderKey: request.orderKey },
                // 用例层已生成 ID（幂等重放必须落同一个 ID），repository 原样采用
                entityId: request.entityId,
              },
              repositoryDeps,
            );
            if (!written.ok) return written;
            return ok({
              entityId: written.value.entityId,
              revision: written.value.revision,
              orderKey: written.value.orderKey,
            });
          }
          const written = updateSettingsEntity(
            db,
            request.context,
            request.entityId,
            {
              name: request.name,
              // values 是整体替换：契约必填，端口不透传「只改一部分」的语义
              values: request.values,
              ...(request.orderKey === null ? {} : { orderKey: request.orderKey }),
            },
            repositoryDeps,
          );
          if (!written.ok) return written;
          const read = readSettingsEntity(db, request.context, request.entityId);
          if (!read.ok) return read;
          return ok({
            entityId: read.value.id,
            revision: written.value.revision,
            orderKey: read.value.orderKey,
          });
        } catch (thrown) {
          return errorResult(thrown, requestId, '保存设定实体失败');
        }
      },
    },

    // -- 系统状态 ----------------------------------------------------------
    system: {
      /**
       * 读运行时事实。这里只给「宿主/运行时才知道」的那部分；
       * `syncProtocolVersion` / `pluginApiVersion` 由用例层直接取契约常量。
       *
       * 库不可用时返回 `Err`，**不伪造一份空状态**（`ports.ts:307-310`）。
       */
      async readSystemStatus() {
        try {
          const facts = describeDatabase();
          if (facts === null) {
            return errOf('STATE_INVALID_TRANSITION', '数据库尚未打开，无法读取系统状态', UNKNOWN_REQUEST_ID);
          }
          const savedRow = db.prepare('SELECT MAX(updated_at) AS t FROM documents').get();
          const outboxRow = db.prepare('SELECT COUNT(*) AS n FROM outbox').get();
          return ok({
            appVersion: APP_VERSION,
            databaseSchemaVersion: facts.schemaVersion,
            databasePath: facts.path,
            readOnly: false,
            lastSavedAt: typeof savedRow?.t === 'string' ? savedRow.t : null,
            pendingOutboxCount: Number(outboxRow?.n ?? 0),
            // 资源模板包尚未装载：契约要求用 null（不是 undefined）
            resourceTemplateVersion: null,
          });
        } catch (thrown) {
          return errorResult(thrown, UNKNOWN_REQUEST_ID, '读取系统状态失败');
        }
      },
    },
  };
}
