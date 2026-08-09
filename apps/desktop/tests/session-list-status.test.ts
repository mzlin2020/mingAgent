import { describe, expect, it } from 'vitest';
import { newSessionId } from '@xm/contracts';
import { sessionListStatus } from '../src/main/session-list-status.js';

/**
 * 会话列表状态徽标的判定（M1-e 会话列表状态整合）。
 *
 * 只测判定逻辑本身，不经 `startServices()`——那需要真实 Electron
 * （`app.getAppPath()`/`safeStorage`），只能在 CI 的 `desktop` job 里跑。
 * `running`/`orphanedSessions` 用普通 `Map` 模拟，形状与 `services.ts` 里
 * 实际维护的两张表一致。
 */
describe('sessionListStatus（M1-e 会话列表状态整合）', () => {
  it('在 running 里 → running，即便同时也在 orphaned 里（running 优先级更高）', () => {
    const id = newSessionId();
    const status = sessionListStatus(id, {
      running: new Map([[id, {}]]),
      orphaned: new Map([[id, {}]]),
    });
    expect(status).toBe('running');
  });

  it('只在 orphaned 里 → interrupted', () => {
    const id = newSessionId();
    const status = sessionListStatus(id, {
      running: new Map(),
      orphaned: new Map([[id, {}]]),
    });
    expect(status).toBe('interrupted');
  });

  it('两张表都不命中 → idle', () => {
    const id = newSessionId();
    const status = sessionListStatus(id, { running: new Map(), orphaned: new Map() });
    expect(status).toBe('idle');
  });

  it('只看这个 sessionId 自己是否命中，不受其他会话的状态影响', () => {
    const id = newSessionId();
    const other = newSessionId();
    const status = sessionListStatus(id, {
      running: new Map([[other, {}]]),
      orphaned: new Map([[other, {}]]),
    });
    expect(status).toBe('idle');
  });
});
