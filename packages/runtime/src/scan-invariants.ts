import type { SessionId } from '@xm/contracts';
import type { EventStore, InvariantRegistry, InvariantViolation } from '@xm/kernel';
import { emptySessionState, reduce } from '@xm/kernel';

/**
 * 运行时不变量的**离线扫描**（ADR-0060 的遗留项）。
 *
 * `SessionRuntime` 只在写入路径上核不变量，`open()` 的回放刻意不核——老会话可能带着
 * 历史缺陷，开机即报会让人当场把这道闸门关掉。代价是历史库里已经存在的违例查不出来，
 * 这里补那一格。CLI 在 `scripts/scan-invariants.mjs`。
 *
 * **它自己不写任何判断逻辑**：回放一遍，把每一步的 `{ event, before, after }` 原样交给
 * 同一个注册表、同一批检查函数。扫描器要是自己写一份，两边迟早分叉，
 * 而分叉之后"线上绿、离线红"根本没法判断谁对。
 *
 * 与写入路径唯一的差别是**不抛**：`InvariantError` 在这里没有意义，
 * 扫一个历史库的目的就是把所有违例一次列全，而不是停在第一条。
 */
export interface SessionScanResult {
  readonly sessionId: SessionId;
  readonly events: number;
  readonly violations: readonly InvariantViolation[];
}

export async function scanSessionInvariants(options: {
  readonly events: EventStore;
  readonly registry: InvariantRegistry;
  readonly sessionId: SessionId;
}): Promise<SessionScanResult> {
  let state = emptySessionState(options.sessionId);
  let count = 0;
  const violations: InvariantViolation[] = [];
  for await (const event of options.events.read(options.sessionId)) {
    const before = state;
    state = reduce(before, event);
    count += 1;
    violations.push(...options.registry.check({ event, before, after: state }));
  }
  return { sessionId: options.sessionId, events: count, violations };
}

/** 扫一个库里的全部会话（或指定的一个）。 */
export async function scanAllSessions(options: {
  readonly events: EventStore;
  readonly registry: InvariantRegistry;
  readonly sessionId?: SessionId;
}): Promise<readonly SessionScanResult[]> {
  const summaries = await options.events.listSessions();
  const targets = summaries
    .map((summary) => summary.sessionId)
    .filter((id) => options.sessionId === undefined || id === options.sessionId);
  const results: SessionScanResult[] = [];
  for (const sessionId of targets) {
    results.push(await scanSessionInvariants({ ...options, sessionId }));
  }
  return results;
}
