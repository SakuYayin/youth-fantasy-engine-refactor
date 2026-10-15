/**
 * 真实读取器（Node 专用适配层）——`@yfe/legacy-import/readers`。
 *
 * 🔴 **为什么不从主入口 `@yfe/legacy-import` 导出**：这里每个读取器都要 `node:fs`，
 *    而主入口必须保持「零 IO 依赖」——移动端（`services/**`、`apps/**`）要复用同一套
 *    mapping / pipeline / report 纯逻辑，它们的环境里没有 Electron、没有桌面文件系统。
 *    所以真实 IO 只活在这个**独立子路径导出**里（`package.json` 的 `"./readers"`）。
 *
 * 共同契约（每个工厂都返回 `LegacySourceReader`）：
 * · `listStores()` 只列**实际存在**的 store；读不到（文件/目录不存在、权限、目录不可读）
 *   **抛** `LegacyReadError` —— `scanLegacySource` 会把它折算成**来源级** refused；
 * · `readRecords(store)` 原样返回该 store 的**全部原始记录**（不裁剪字段、不补默认值、不换算
 *   `vecB64`）；store 不在源里 ⇒ 抛 `store-missing`（**不是**空数组）；
 * · 任何失败都抛 {@link LegacyReadError}，**绝不当空**（`R-01` / `R-11`）——「读不出来」与
 *   「里面没有数据」是两件事；
 * · 只读：不创建/修改/删除任何文件，不写临时文件；
 * · 确定性：store 名按 `localeCompare` 排序，记录顺序 = 源文件顺序或按主键稳定排序。
 *
 * 工厂一览：
 * · {@link createJsonDatabaseReader} —— 整库 JSON（`youth-fantasy-engine-data.json`，PortableData v2）；
 * · {@link createLocalStorageDumpReader} —— localStorage 键值转储（合成 `{key,value}` 记录）;
 * · {@link createSidecarDirectoryReader} —— `blobs/<store>/<id>.json` 外置存储目录；
 * · {@link createStoreFilesReader} / {@link createKnowledgeBaseReader} /
 *   {@link createVectorIndexReader} —— 一个 store 一个 JSON 文件；
 * · {@link createSyncFileReader} —— `.yfe` 同步文件：**只识别不导入**（M-21），仅 `inspect()`。
 */

export {
  createJsonDatabaseReader,
  type JsonDatabaseReaderOptions,
} from './jsonDatabase.js'
export {
  createLocalStorageDumpReader,
  type LocalStorageDumpReaderOptions,
} from './localStorage.js'
export {
  createSidecarDirectoryReader,
  SIDECAR_WHOLE_KEY,
  type SidecarDirectoryReaderOptions,
} from './sidecar.js'
export {
  createKnowledgeBaseReader,
  createStoreFilesReader,
  createVectorIndexReader,
  type KnowledgeBaseReaderOptions,
  type StoreFilesReaderOptions,
  type VectorIndexReaderOptions,
} from './storeFiles.js'
export {
  createSyncFileReader,
  DEFAULT_CLOUD_KEY,
  type SyncFileInspection,
  type SyncFileReader,
  type SyncFileReaderOptions,
  type SyncPayloadFormat,
} from './syncFile.js'
export {
  LEGACY_KB_STORE_KEY_FIELDS,
  LEGACY_MAIN_STORE_KEY_FIELDS,
  LEGACY_SIDECAR_STORE_KEY_FIELDS,
  LEGACY_VEC_STORE_KEY_FIELDS,
} from './storeNames.js'
