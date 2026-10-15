/**
 * 本地工作区标识（桌面端单机模式的唯一工作区）。
 *
 * 为什么需要它：`WriteContext.workspaceId` 是**必填**的，而 `SystemStatusOutput`
 * 里没有工作区 ID。桌面端是单机单工作区应用，所以这里用一个固定 ID，
 * 由 `apps/desktop/src/main/application-adapter.mjs` 的 `ensureWorkspaceRow`
 * 在建作品时按需补建那一行。
 *
 * 🔴 绝不在这里用 `randomUUID()`：那样每次启动都会落到**新工作区**，
 * 用户会看到自己写的东西全没了（数据其实还在库里，只是换了归属）。
 * 契约的 `ID_PATTERN` 是 `/^[0-9a-zA-Z][0-9a-zA-Z_-]{0,127}$/`，`ws_local` 合法。
 */

/** 桌面端本地工作区 ID（稳定值，不得随意更改）。 */
export const LOCAL_WORKSPACE_ID = 'ws_local'

/** 补建工作区行时使用的名称（与适配器里的默认值保持一致）。 */
export const LOCAL_WORKSPACE_NAME = '本地工作区'
