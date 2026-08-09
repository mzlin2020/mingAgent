import { describe, expect, it } from 'vitest';
import { newSessionId } from '@xm/contracts';
import { classifyIpcError, IpcError } from '../src/renderer/ipc-error.js';

/**
 * 错误分类（M1-e 错误态呈现）。刻意不从 `bridge.ts` 导入任何东西——那个文件
 * 顶层引用 `window`，只能在有 DOM lib 的编译配置下过关，这里跑在 Node 环境的
 * `tsconfig.tests.json` 下。`IpcError` 定义在 `ipc-error.ts`，理由见那个文件的
 * 顶部注释。
 */
describe('classifyIpcError（M1-e 错误态呈现）', () => {
  it('WriteLeaseError + 有 sessionId → 分类到 sessionConflict', () => {
    const id = newSessionId();
    const e = new IpcError('WriteLeaseError', '会话已被本进程的另一个写句柄持有');
    const classified = classifyIpcError(e, id);
    expect(classified).toEqual({
      field: 'sessionConflict',
      value: { sessionId: id, message: '会话已被本进程的另一个写句柄持有' },
    });
  });

  it('WriteLeaseError 但没有 sessionId → 落进通用 error（没有单一会话作用域可归因）', () => {
    const e = new IpcError('WriteLeaseError', 'x');
    const classified = classifyIpcError(e);
    expect(classified).toEqual({ field: 'error', value: 'x' });
  });

  it('其他已知错误码（比如 policy_denied）不被分类，走通用 error——未分类错误的最后防线', () => {
    const id = newSessionId();
    const e = new IpcError('policy_denied', '这个操作被策略拒绝了');
    const classified = classifyIpcError(e, id);
    expect(classified).toEqual({ field: 'error', value: '这个操作被策略拒绝了' });
  });

  it('非 IpcError 的普通异常 → 走通用 error，取 .message', () => {
    const classified = classifyIpcError(new Error('boom'), newSessionId());
    expect(classified).toEqual({ field: 'error', value: 'boom' });
  });

  it('非 Error 的任意抛出值 → String() 兜底', () => {
    const classified = classifyIpcError('just a string');
    expect(classified).toEqual({ field: 'error', value: 'just a string' });
  });
});
