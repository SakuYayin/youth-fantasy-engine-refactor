/**
 * service-host 监督器测试。
 *
 * 这里全部用 `tests/fixtures/echo-worker.mjs` 替身，因为「超时 / 崩溃 / 迟到回包」
 * 三条路径无法用真实 db-worker 稳定复现。真实 worker 的链路在 `db-worker.test.ts`。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServiceHost, type ServiceHost, type ServiceHostOptions } from '../src/main/service-host.mjs';

// 用 fileURLToPath 而不是 import.meta.dirname：后者在 Vite/Vitest 的转换下不保证存在。
const HERE = fileURLToPath(new URL('.', import.meta.url));
const WORKER_PATH = join(HERE, 'fixtures', 'echo-worker.mjs');

const started: ServiceHost[] = [];

function makeHost(overrides: Partial<ServiceHostOptions> = {}): ServiceHost {
  const host = createServiceHost({
    workerPath: WORKER_PATH,
    restartCooldownMs: 50,
    requestTimeoutMs: 2_000,
    ...overrides,
  });
  started.push(host);
  return host;
}

afterEach(async () => {
  for (const host of started.splice(0)) {
    await host.shutdown();
  }
});

describe('service-host 请求-响应关联', () => {
  it('并发 10 个乱序返回的请求不会串号', async () => {
    const host = makeHost();
    await host.start();

    const calls = Array.from({ length: 10 }, (_, index) =>
      host.call('echo', {
        marker: `m${index}`,
        // 打乱返回顺序：延迟与下标相反，后发的先回
        delayMs: (10 - index) * 5,
      }),
    );
    const results = await Promise.all(calls);

    results.forEach((result, index) => {
      expect(result.ok, `第 ${index} 个请求应当成功`).toBe(true);
      if (result.ok) {
        const value = result.value as { echo: { marker: string } };
        expect(value.echo.marker).toBe(`m${index}`);
      }
    });
    expect(host.stats().orphanResponses).toBe(0);
  });

  it('requestId 由宿主生成且每个请求互不相同', async () => {
    const host = makeHost({ requestTimeoutMs: 500 });
    await host.start();

    // 用虚假 requestId 回包，让真实请求挂到超时；被丢弃的响应计入 orphanResponses
    const result = await host.call('echo', { replyRequestId: 'forged-request-id' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NETWORK_TIMEOUT');
      expect(result.error.requestId).not.toBe('forged-request-id');
    }
    expect(host.stats().orphanResponses).toBeGreaterThanOrEqual(1);
  });
});

describe('service-host 超时', () => {
  it('worker 不响应时按超时返回错误，而不是永久挂起', async () => {
    const host = makeHost({ requestTimeoutMs: 300 });
    await host.start();

    const startedAt = Date.now();
    const result = await host.call('echo', { hang: true });
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NETWORK_TIMEOUT');
      expect(result.error.retryable).toBe(true);
    }
    // 必须在超时阈值附近返回（给足调度余量），而不是挂死
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(5_000);
    expect(host.stats().timeouts).toBe(1);
    expect(host.stats().pending).toBe(0);
  });
});

describe('service-host 崩溃与重启', () => {
  it('worker 崩溃时，进行中的请求收到 SERVICE_RESTARTED', async () => {
    const host = makeHost();
    await host.start();

    const result = await host.call('echo', { crash: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SERVICE_RESTARTED');
      expect(result.error.retryable).toBe(true);
    }
    expect(host.stats().pending).toBe(0);
  });

  it('崩溃后自动重启，后续请求能重新工作', async () => {
    const host = makeHost();
    await host.start();

    const crashed = await host.call('echo', { crash: true });
    expect(crashed.ok).toBe(false);

    await host.waitForReady(3_000);
    const after = await host.call('echo', { marker: 'after-restart' });

    expect(after.ok).toBe(true);
    if (after.ok) {
      expect((after.value as { echo: { marker: string } }).echo.marker).toBe('after-restart');
    }
    expect(host.stats().restarts).toBe(1);
    expect(host.stats().state).toBe('ready');
  });

  it('连续崩溃超过上限后进入 failed，不再重启，且请求快速失败', async () => {
    const host = makeHost({ maxRestarts: 1 });
    await host.start();

    await host.call('echo', { crash: true });
    // 等第一次也是唯一一次重启完成后再次打崩
    await new Promise((resolve) => setTimeout(resolve, 300));
    await host.call('echo', { crash: true });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const result = await host.call('echo', { marker: 'never' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SERVICE_UNAVAILABLE');
    }
  });
});

describe('service-host 生命周期', () => {
  it('open() 是把 path 包成 call("open") 的便捷方法', async () => {
    const host = makeHost();
    await host.start();

    const result = await host.open('C:/tmp/example.db');

    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { method: string; echo: { path: string } };
      expect(value.method).toBe('open');
      expect(value.echo.path).toBe('C:/tmp/example.db');
    }
  });

  it('shutdown 后再调用返回 SERVICE_SHUTTING_DOWN 而不是抛异常', async () => {
    const host = makeHost();
    await host.start();
    await host.shutdown();

    const result = await host.call('echo', { marker: 'after-shutdown' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('SERVICE_SHUTTING_DOWN');
    }
    expect(host.stats().state).toBe('stopped');
  });

  it('shutdown 可重复调用且幂等', async () => {
    const host = makeHost();
    await host.start();
    await host.shutdown();
    await host.shutdown();
    expect(host.stats().state).toBe('stopped');
  });

  it('缺少 workerPath 时立刻抛错（配置错误不应等到首个请求才暴露）', () => {
    expect(() => createServiceHost({ workerPath: '' })).toThrow(/workerPath/);
  });
});
