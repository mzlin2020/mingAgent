import type { LiveMessage } from '@xm/kernel';

/** 面向用户的主回合瞬态状态，不会进入最终消息或事件历史。 */
export function liveWaitingPhase(message: LiveMessage): string | undefined {
  if (message.text !== '') return undefined;
  const retry = message.providerStatus;
  if (retry !== undefined) {
    return (
      `连接暂时失败，${String(Math.ceil(retry.delayMs / 1000))} 秒后重试` +
      `（第 ${String(retry.attempt)}/${String(retry.maxAttempts)} 次）`
    );
  }
  return message.thinking === '' ? '正在连接' : '思考中';
}

export function liveWaitingText(message: LiveMessage, elapsedSeconds: number): string | undefined {
  const phase = liveWaitingPhase(message);
  if (phase === undefined) return undefined;
  return `${phase}，已等待 ${String(elapsedSeconds)} 秒`;
}
