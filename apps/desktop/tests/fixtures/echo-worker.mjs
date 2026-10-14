/**
 * 测试替身 worker：不碰数据库，只按 payload 指令表演各种坏行为。
 *
 * 存在的意义：service-host 的**超时 / 崩溃 / 迟到回包 / 并发串号**四条路径无法用
 * 真实 db-worker 稳定复现，必须有一个可控的替身。契约与真实 worker 相同：
 * 收 `{kind:'request', requestId, method, payload}`，回
 * `{kind:'response', requestId, ok, method, value|error}`。
 *
 * 指令（放在 payload 里）：
 * - `hang: true`      永不响应（测超时）
 * - `crash: true`     直接 process.exit(7)，不回包（测崩溃重启与在途请求中止）
 * - `delayMs: number` 延迟后才响应（测并发串号）
 * - `replyRequestId`  强制回一个指定的 requestId（测迟到/无主响应）
 */
const parentPort = process.parentPort;
const send = parentPort ? (message) => parentPort.postMessage(message) : (message) => process.send?.(message);
const onMessage = parentPort
  ? (handler) => parentPort.on('message', (event) => handler(event?.data))
  : (handler) => process.on('message', handler);

let served = 0;

onMessage((message) => {
  if (message?.kind === 'shutdown') {
    process.exit(0);
    return;
  }
  if (message?.kind !== 'request') return;

  const { requestId, method, payload } = message;

  if (payload?.crash === true) {
    process.exit(7);
    return;
  }
  if (payload?.hang === true) {
    // 永不响应：用来验证宿主超时后不会永久挂起
    return;
  }

  const respond = () => {
    served += 1;
    send({
      kind: 'response',
      requestId: typeof payload?.replyRequestId === 'string' ? payload.replyRequestId : requestId,
      ok: true,
      method,
      value: { method, echo: payload ?? null, served },
    });
  };

  if (typeof payload?.delayMs === 'number' && payload.delayMs > 0) {
    setTimeout(respond, payload.delayMs);
  } else {
    respond();
  }
});

send({ kind: 'ready', channel: parentPort ? 'utilityProcess' : 'childProcess' });
