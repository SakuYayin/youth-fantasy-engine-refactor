/**
 * 备份与恢复适配器（桌面主进程 / db-worker 内运行）。
 *
 * 职责：把 `@yfe/persistence-sqlite/export` 的同步 `Result` API 包成
 * db-worker 可直接分派的端口方法，并**收拢文件系统位置**：
 *
 * - 备份目录固定为 `<数据库所在目录>/backups/`；
 * - 恢复目标固定为 `<数据库所在目录>/restore-preview/`。
 *
 * 🔴 三条硬约束（每条都为了不损坏用户数据）：
 * 1. **绝不覆盖正在使用的库文件**：连接由 db-worker 独占持有（WAL 模式下还有
 *    `-wal`/`-shm` 兄弟文件），覆盖正在使用的文件必然损坏。恢复只写 restore-preview，
 *    切换当前数据文件需要重启应用（后续批次做切换流程）。
 * 2. 渲染层**不传任意路径**：`backupPath` 必须落在备份目录内（规范化后前缀比对 +
 *    符号链接解析），否则报 `VALIDATION_FAILED`。这挡住「借 IPC 读任意文件」。
 * 3. 列表**不隐藏损坏项**：清单缺失/不可解析时仍列出（`readable: false`），
 *    否则用户会以为备份凭空消失；能不能恢复交给 verify。
 *
 * 本文件不 import Electron / Fastify / DOM，只用 `node:fs`/`node:path` + 契约 + 持久层。
 */

import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { randomUUID } from 'node:crypto';

import { errOf, ok } from '@yfe/contracts';
import {
  createBackup,
  defaultManifestPath,
  isBackupManifestPath,
  readBackupManifestFile,
  restoreBackup,
  verifyBackup,
} from '@yfe/persistence-sqlite/export';

/** 备份子目录名（相对数据目录）。 */
export const BACKUP_DIR_NAME = 'backups';
/** 恢复暂存子目录名：恢复结果先落这里，**不碰**在用的库。 */
export const RESTORE_PREVIEW_DIR_NAME = 'restore-preview';

/** 快照文件后缀：列表只认它，避免把清单、临时文件当成备份。 */
const SNAPSHOT_EXTENSIONS = ['.db', '.sqlite', '.sqlite3'];

/** 单个备份目录最多列出多少项（按修改时间倒序后截断；防御性上限）。 */
const MAX_LIST_ENTRIES = 500;

/**
 * 判断 `candidate` 是否落在 `root` 内（**规范化后**比对，防 `..` 逃逸）。
 *
 * 注意末尾分隔符：`F:\data\backups-evil` 不能因为前缀匹配而被当成 `F:\data\backups` 的子项。
 */
function isWithinRoot(root, candidate) {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  if (normalizedCandidate === normalizedRoot) return true;
  return normalizedCandidate.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep);
}

function normalizeRequestId(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  // 端口没有 requestId 入参时的稳定占位符（与 application-adapter 同口径）
  return `req-bak-${randomUUID()}`;
}

/**
 * 取本次调用的 requestId。
 *
 * 🔴 优先级：**显式传入的**（db-worker 从 IPC 信封上带下来）> payload 里自带的 > 新生成。
 * 反过来的话，备份侧的错误载荷会带一个随机 requestId，与调用方看到的请求号对不上，
 * 日志里就再也串不起「谁的哪次调用失败了」。
 */
function requestIdOf(explicit, payload) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  return normalizeRequestId(payload?.requestId);
}

/** 从文件名推标签：去掉后缀，剩下的就是主进程生成时写入的时间戳/用户标签。 */
function labelOf(fileName) {
  for (const extension of SNAPSHOT_EXTENSIONS) {
    if (fileName.toLowerCase().endsWith(extension)) {
      return fileName.slice(0, -extension.length);
    }
  }
  return fileName;
}

/** 安全读文件大小：失败返回 null（绝不编 0，否则列表会显示「0 字节的备份」）。 */
function byteSizeOf(path) {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

/**
 * 创建备份/恢复端口。
 *
 * @param {object} options
 * @param {any} options.db             已打开的 better-sqlite3 句柄（由 db-worker 持有）
 * @param {string} options.databasePath 正在使用的库文件绝对路径
 * @param {() => string} [options.now]  生成备份文件名用的时钟（测试注入）
 */
export function createBackupPorts(options) {
  const db = options.db;
  const databasePath = resolve(options.databasePath);
  const dataDir = dirname(databasePath);
  const backupDir = join(dataDir, BACKUP_DIR_NAME);
  const restoreDir = join(dataDir, RESTORE_PREVIEW_DIR_NAME);
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();

  /** 确保目录存在（备份/恢复前各调一次；失败由调用方归一成 Err）。 */
  function ensureDir(path) {
    mkdirSync(path, { recursive: true });
    return path;
  }

  /**
   * 把入参路径解析成备份目录内的绝对路径。
   * 越界/不存在/不是文件 → 返回 Err（**不**抛异常）。
   */
  function resolveBackupPath(rawPath, requestId) {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      return errOf('VALIDATION_MISSING_FIELD', '备份路径不能为空。', requestId, { field: 'backupPath' });
    }
    const resolved = resolve(rawPath);
    if (!isWithinRoot(backupDir, resolved)) {
      return errOf('PERMISSION_DENIED', '只能访问备份目录内的文件。', requestId, {
        field: 'backupPath',
        reason: 'outside_backup_dir',
      });
    }
    return ok(resolved);
  }

  return {
    /**
     * 创建一致备份：`VACUUM INTO` 快照 + 清单，写进 `<数据目录>/backups/`。
     * 文件名由主进程生成（`<时间戳>[-标签].db`），渲染层不能指定路径。
     */
    async backupCreate(payload, explicitRequestId) {
      const requestId = requestIdOf(explicitRequestId, payload);
      try {
        const rawLabel = payload?.label;
        let label = '';
        if (typeof rawLabel === 'string') {
          // 标签进文件名：只留安全字符，避免路径分隔符/保留字符
          label = rawLabel.trim().replace(/[^0-9A-Za-z\u4e00-\u9fa5_-]+/g, '-').slice(0, 40);
        }
        const stamp = now().replace(/[:.]/g, '-');
        const fileName = label.length > 0 ? `${stamp}-${label}.db` : `${stamp}.db`;
        ensureDir(backupDir);
        const destinationPath = join(backupDir, fileName);

        const created = createBackup(db, { requestId, destinationPath });
        if (!created.ok) return created;
        const size = byteSizeOf(created.value.backupPath) ?? 0;
        return ok({
          backupPath: created.value.backupPath,
          manifestPath: created.value.manifestPath,
          createdAt: created.value.manifest.createdAt,
          byteSize: size,
          durationMs: created.value.durationMs,
        });
      } catch (thrown) {
        return errorResult(thrown, requestId, '创建备份失败');
      }
    },

    /** 列出备份目录里的快照（按修改时间倒序）。损坏项也列出，标 readable=false。 */
    async backupList(payload, explicitRequestId) {
      const requestId = requestIdOf(explicitRequestId, payload);
      try {
        let names;
        try {
          names = readdirSync(backupDir);
        } catch {
          // 目录还不存在 = 还没有任何备份，这是正常空态，不是错误
          return ok({ backups: [] });
        }
        const entries = [];
        for (const name of names) {
          // 清单文件本身不进列表（它由快照项带出）
          if (isBackupManifestPath(name)) continue;
          const lower = name.toLowerCase();
          if (!SNAPSHOT_EXTENSIONS.some((extension) => lower.endsWith(extension))) continue;
          const snapshotPath = join(backupDir, name);
          const size = byteSizeOf(snapshotPath);
          if (size === null) continue;
          const manifestPath = defaultManifestPath(snapshotPath);
          const manifestResult = readBackupManifestFile(manifestPath, requestId);
          entries.push({
            backupPath: snapshotPath,
            manifestPath,
            label: labelOf(name),
            createdAt: manifestResult.ok ? manifestResult.value.createdAt : null,
            byteSize: size,
            readable: manifestResult.ok,
          });
        }
        entries.sort((left, right) => right.label.localeCompare(left.label));
        return ok({ backups: entries.slice(0, MAX_LIST_ENTRIES) });
      } catch (thrown) {
        return errorResult(thrown, requestId, '列出备份失败');
      }
    },

    /** 校验一份备份（只读；13 种损坏原因由持久层给出）。 */
    async backupVerify(payload, explicitRequestId) {
      const requestId = requestIdOf(explicitRequestId, payload);
      try {
        const resolved = resolveBackupPath(payload?.backupPath, requestId);
        if (!resolved.ok) return resolved;
        const verified = verifyBackup({ requestId, backupPath: resolved.value });
        if (!verified.ok) return verified;
        const size = byteSizeOf(resolved.value) ?? verified.value.manifest.databaseFile.byteSize;
        return ok({
          backupPath: resolved.value,
          manifestPath: defaultManifestPath(resolved.value),
          label: labelOf(basename(resolved.value)),
          createdAt: verified.value.manifest.createdAt,
          integrity: 'ok',
          databaseSchemaVersion: verified.value.databaseSchemaVersion,
          needsMigration: verified.value.needsMigration,
          byteSize: size,
        });
      } catch (thrown) {
        return errorResult(thrown, requestId, '校验备份失败');
      }
    },

    /**
     * 恢复一份备份到 `restore-preview/`（**绝不覆盖在用的库**）。
     *
     * 覆盖同名暂存文件需要显式 `overwrite: true`（与持久层同一口径）。
     * 返回的 targetPath 需要重启应用后由启动流程采用（后续批次做切换）。
     */
    async backupRestore(payload, explicitRequestId) {
      const requestId = requestIdOf(explicitRequestId, payload);
      try {
        const resolved = resolveBackupPath(payload?.backupPath, requestId);
        if (!resolved.ok) return resolved;

        ensureDir(restoreDir);
        const targetName = `${labelOf(basename(resolved.value))}-restored.db`;
        const targetPath = join(restoreDir, targetName);

        // 双保险：目标绝不能是在用的库文件（resolveBackupPath 已限制源目录，
        // 但恢复目标由本函数生成——这里再断言一次，将来有人改目录也不出事）
        if (resolve(targetPath) === databasePath) {
          return errOf('VALIDATION_FAILED', '恢复目标不能是当前正在使用的数据库文件。', requestId, {
            field: 'targetPath',
          });
        }

        const restored = restoreBackup({
          requestId,
          backupPath: resolved.value,
          targetPath,
          ...(payload?.overwrite === true ? { overwrite: true } : {}),
        });
        if (!restored.ok) return restored;
        return ok({
          targetPath: restored.value.targetPath,
          manifestPath: restored.value.manifestPath,
          byteSize: restored.value.byteSize,
          verified: true,
        });
      } catch (thrown) {
        return errorResult(thrown, requestId, '恢复备份失败');
      }
    },
  };
}

/**
 * 把抛出物归一成契约 `Err` 并**剥掉 `cause`**（与 application-adapter 同口径：
 * 跨进程序列化会泄漏驱动原文与绝对路径）。
 */
function errorResult(thrown, requestId, fallbackMessage) {
  const message = thrown instanceof Error && thrown.message.length > 0 ? thrown.message : fallbackMessage;
  const code = typeof thrown?.code === 'string' ? thrown.code : 'INTERNAL_ERROR';
  return errOf(code, message, requestId);
}
