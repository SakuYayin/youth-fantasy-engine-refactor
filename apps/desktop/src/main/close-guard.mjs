/** 同一次关窗只冲刷一次；超时/失败时必须由用户决定是否放弃草稿。 */
export function createCloseGuard({ flush, confirmDiscard, close, timeoutMs = 16_000 }) {
  let allowed = false;
  let pending = null;
  return {
    get allowed() { return allowed; },
    request() {
      if (allowed) return Promise.resolve(true);
      if (pending) return pending;
      pending = (async () => {
        let timer;
        let saved = false;
        try {
          saved = await Promise.race([
            Promise.resolve().then(flush),
            new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
          ]) === true;
        } catch { /* 冲刷异常按保存失败处理。 */ }
        finally { clearTimeout(timer); }
        if (!saved) {
          try { if (!await confirmDiscard()) return false; }
          catch { return false; }
        }
        allowed = true;
        close();
        return true;
      })().finally(() => { pending = null; });
      return pending;
    },
  };
}
