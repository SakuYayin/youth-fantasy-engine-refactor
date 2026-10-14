/**
 * IPC 白名单一致性测试。
 *
 * 🔴 这条测试是整个 preload 安全模型的地基：白名单在 TypeScript 侧（权威）与
 * CommonJS 侧（沙箱化 preload 的运行时副本）各有一份。两份一旦漂移，就会出现
 * 「renderer 以为能调，main 拒绝」或更糟的「TS 里已删除，preload 仍暴露」。
 * 因此这里逐项比较**且比较顺序**——顺序也被 `window.yfe.methods` 直接暴露给 renderer。
 */
import { describe, expect, it } from 'vitest';
import { IPC_METHODS as TS_METHODS } from '../src/shared/ipc/channels.js';
import ipcMethodsModule from '../src/preload/ipc-methods.cjs';

const JS_METHODS = ipcMethodsModule.IPC_METHODS;

describe('IPC 白名单双份一致性', () => {
  it('TS 权威表与 CJS 运行副本逐项、按顺序相等', () => {
    expect(Array.from(JS_METHODS)).toEqual(Array.from(TS_METHODS));
  });

  it('CJS 副本是冻结的（防止运行时被 preload 之外的代码改写）', () => {
    expect(Object.isFrozen(JS_METHODS)).toBe(true);
  });

  it('没有重复项（重复会让白名单长度与去重后长度不一致）', () => {
    expect(new Set(TS_METHODS).size).toBe(TS_METHODS.length);
  });

  it('白名单只包含细粒度用例方法，不含任何通配/管理类入口', () => {
    for (const method of TS_METHODS) {
      expect(method).toMatch(/^[a-z][A-Za-z]+$/);
      // 明确禁止的高危名字：一旦有人加进来就必须在这里显式讨论
      expect(['invoke', 'require', 'eval', 'exec', 'readFile', 'writeFile', 'shell']).not.toContain(method);
    }
  });
});
