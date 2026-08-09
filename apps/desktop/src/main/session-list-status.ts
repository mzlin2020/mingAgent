import type { SessionId } from '@xm/contracts';
import type { SessionListStatus } from '../shared/ipc.js';

/**
 * 会话列表状态徽标的判定（M1-e 会话列表状态整合）。
 *
 * 拆成一个独立的纯函数——纯粹是为了能在不启动 Electron（`startServices()` 需要
 * `app.getAppPath()`/`safeStorage`，只能在真实 Electron 主进程或
 * `XM_SMOKE=1 electron .`（CI 的 `desktop` job）里跑）的情况下单独测试这条判定
 * 逻辑本身。`services.ts` 的 `listSessions()` 只是拿 `running`/`orphanedSessions`
 * 两张既有 Map 调用它，不重复这条判断。
 */
export function sessionListStatus(
  sessionId: SessionId,
  maps: { readonly running: ReadonlyMap<SessionId, unknown>; readonly orphaned: ReadonlyMap<SessionId, unknown> },
): SessionListStatus {
  if (maps.running.has(sessionId)) return 'running';
  if (maps.orphaned.has(sessionId)) return 'interrupted';
  return 'idle';
}
