/**
 * 【移植说明】本文件移植自上游 `src/lib/app/date.ts`（上游 17 行；本文件**只抄 `formatDate`**，
 * 上游同文件的 `todayKey` 未抄入 —— 见「行为差异」）。
 *
 * · 真源纪律 🔴：真源为上游 `src/lib/app/date.ts`，本包 `packages/tavern/src/date.ts` 是它的
 *   **副本**。上游改动必须**双向同步**（改上游 ⇒ 同步回本文件；改本文件 ⇒ 回改上游），
 *   否则「日期 → `YYYY-MM-DD`」的口径会出现**双份实现漂移** —— 上游 2026-09-17 审计合并之前，
 *   `syncCore.ts:155` 与 `tavern/summarize.ts:27` 正是各存了一份逐字符相同的拷贝，
 *   而注释里写的「确保口径一致」其实没人管。
 * · 解决什么问题：把 `Date | number` 按**本地时区**格式化成 `YYYY-MM-DD`（月 / 日补零）——
 *   每日码字统计、每日自动备份、云端同步的「每日备份」、酒馆日记共用的唯一口径。
 * · 行为差异：只有一个 —— 本文件**未移植 `todayKey`**。上游 `todayKey(d: Date = new Date())`
 *   只是 `return formatDate(d)` 的别名（语义完全等同，保留旧名只为避免大范围改名）；
 *   本包需要「今日 key」时直接调用 `formatDate()`，不保留这层别名。
 *   `formatDate` 本身**逐字照搬**，含缺省参数 `d: Date | number = new Date()`。
 * · 机械改写清单：无。
 * · 临时实现：无。
 */
/**
 * 日期 → `YYYY-MM-DD`（本地时区，补零）。
 *
 * 🔴 **全项目唯一实现**（2026-09-17 审计合并）：每日码字统计、每日自动备份、
 * 云端同步的「每日备份」、酒馆日记都走这里 —— 口径要改只改这一处。
 * 原先 `syncCore.ts:155` 与 `tavern/summarize.ts:27` 各有一份逐字符相同的拷贝，
 * 而本文件的注释却写着「确保口径一致」—— 那份「一致」其实没人管。
 */
export function formatDate(d: Date | number = new Date()): string {
  const t = d instanceof Date ? d : new Date(d)
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}