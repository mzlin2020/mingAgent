import type { CallId } from '@xm/contracts';
import type { ExecutionReceipt } from './turn-events.js';

const authentic = new WeakSet<object>();

export const issueExecutionReceipt = (
  callId: CallId,
  issuedAt: number,
  toolName: string,
): ExecutionReceipt => {
  const receipt = Object.freeze({ callId, issuedAt, toolName });
  authentic.add(receipt);
  return receipt;
};

/**
 * 收据必须**同时**满足两条：出自驱动器，且就是这一次调用的那一枚（ADR-0062 §三）。
 *
 * 只查 WeakSet 会留下一个真实的短路缺口：一个 `tool/execute` 环绕插件把上一次真实执行拿到的
 * 收据缓存下来，下一次跳过 `next()` 直接把它挂在伪造结果上——收据是真的，执行没发生，而 ⑫
 * 会照常落成功分支。`callId` / `toolName` 两个字段正是为绑定而存在的，不比对等于没写。
 */
export const isExecutionReceipt = (
  value: ExecutionReceipt | undefined,
  callId: CallId,
  toolName: string,
): boolean =>
  value !== undefined &&
  authentic.has(value) &&
  value.callId === callId &&
  value.toolName === toolName;
