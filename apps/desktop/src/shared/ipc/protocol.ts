import type { IpcMethod, IpcRequestMap, IpcResponseMap } from './channels.ts';

/**
 * 渲染进程 ↔ main ↔ db-worker 共用的消息信封。
 * 三层（renderer / main / db-worker）用同一套形状，杜绝每一层自造 DTO。
 */

/** 请求信封。requestId 由 main（service-host）生成，用于关联响应与去重。 */
export interface IpcRequest<M extends IpcMethod = IpcMethod> {
  kind: 'request';
  requestId: string;
  method: M;
  payload: IpcRequestMap[M];
}

/** 成功响应信封。value 形状由 IpcResponseMap[M] 决定。 */
export interface IpcSuccess<M extends IpcMethod = IpcMethod> {
  kind: 'response';
  requestId: string;
  ok: true;
  method: M;
  value: IpcResponseMap[M];
}

/** 失败响应信封。error 必须来自 toErrorPayload()，绝不携带堆栈。 */
export interface IpcFailure {
  kind: 'response';
  requestId: string;
  ok: false;
  method: IpcMethod;
  error: { code: string; message: string; severity?: string; retryable?: boolean; detail?: unknown };
}

export type IpcResponse<M extends IpcMethod = IpcMethod> = IpcSuccess<M> | IpcFailure;

export type IpcMessage = IpcRequest | IpcResponse;

export function isRequestMessage(msg: unknown): msg is IpcRequest {
  return (
    typeof msg === 'object' && msg !== null &&
    (msg as { kind?: unknown }).kind === 'request' &&
    typeof (msg as { requestId?: unknown }).requestId === 'string' &&
    typeof (msg as { method?: unknown }).method === 'string'
  );
}

export function isResponseMessage(msg: unknown): msg is IpcResponse {
  return (
    typeof msg === 'object' && msg !== null &&
    (msg as { kind?: unknown }).kind === 'response' &&
    typeof (msg as { requestId?: unknown }).requestId === 'string' &&
    typeof (msg as { ok?: unknown }).ok === 'boolean'
  );
}
