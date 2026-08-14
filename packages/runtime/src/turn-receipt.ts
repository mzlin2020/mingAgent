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

export const isExecutionReceipt = (value: ExecutionReceipt | undefined): boolean =>
  value !== undefined && authentic.has(value);
