import { describe, expect, it } from 'vitest';
import { liveWaitingText } from '../src/renderer/live-status.js';

const message = {
  messageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' as never,
  text: '',
  thinking: '',
  providerStatus: undefined,
};

describe('主回合等待状态', () => {
  it('message.start 后尚无首字节时立即显示连接计时', () => {
    expect(liveWaitingText(message, 0)).toBe('正在连接，已等待 0 秒');
  });

  it('收到思考增量后显示思考计时', () => {
    expect(liveWaitingText({ ...message, thinking: '分析中' }, 12)).toBe('思考中，已等待 12 秒');
  });

  it('自动重试时显示下一次尝试和退避时间', () => {
    expect(
      liveWaitingText(
        {
          ...message,
          providerStatus: {
            phase: 'retrying',
            attempt: 2,
            maxAttempts: 4,
            delayMs: 1_500,
            reason: '限流',
          },
        },
        31,
      ),
    ).toBe('连接暂时失败，2 秒后重试（第 2/4 次），已等待 31 秒');
  });

  it('正文开始后不再显示等待状态', () => {
    expect(liveWaitingText({ ...message, text: '开始回答' }, 3)).toBeUndefined();
  });
});
