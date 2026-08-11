import { describe, expect, it } from 'vitest';
import { newCallId, newMessageId, newPtySessionId, newSessionId } from '@xm/contracts';
import { emptySessionState, serializeSessionState } from '@xm/kernel';
import { CH } from '../src/shared/channels.js';
import {
  CreateSessionRequest,
  IpcEnvelope,
  ListSessionsResult,
  MAX_IMAGES_PER_MESSAGE,
  PushedEvent,
  ReadBlobRequest,
  ReadBlobResult,
  ReadSessionRequest,
  ReadSessionResult,
  SendUserMessageRequest,
  SessionListStatus,
} from '../src/shared/ipc.js';

/**
 * IPC 契约的可执行部分（ADR-0015）。
 *
 * 这里跑不了 Electron（需要 GUI），但**契约本身是纯数据**，与 Electron 无关——
 * 而 ADR-0015 的几条主张恰恰全都落在契约上：主进程不信任渲染层、
 * 渲染层用 loose 信封容忍未知事件、失败是返回值而不是异常。
 * 这些不该只靠"启动一次看看"来验。
 */

describe('主进程不信任渲染层送上来的东西', () => {
  it('🔴 幻觉字段被拒绝 —— strictObject 不是装饰', () => {
    expect(CreateSessionRequest.safeParse({ title: 'x', isAdmin: true }).success).toBe(false);
    expect(
      SendUserMessageRequest.safeParse({
        sessionId: newSessionId(),
        text: 'hi',
        skipPermissionChecks: true,
      }).success,
    ).toBe(false);
  });

  it('🔴 sessionId 必须是合法 ID，不是任意字符串', () => {
    expect(SendUserMessageRequest.safeParse({ sessionId: '../../etc/passwd', text: 'x' }).success)
      .toBe(false);
    expect(ReadSessionRequest.safeParse({ sessionId: 'not-a-uuid' }).success).toBe(false);
  });

  it('🔴 文本长度有上限 —— 无界字符串进来就是一次无界落库', () => {
    const sessionId = newSessionId();
    expect(SendUserMessageRequest.safeParse({ sessionId, text: '' }).success).toBe(false);
    expect(
      SendUserMessageRequest.safeParse({ sessionId, text: 'x'.repeat(100_001) }).success,
    ).toBe(false);
    expect(SendUserMessageRequest.safeParse({ sessionId, text: 'x'.repeat(100_000) }).success)
      .toBe(true);
  });

  /*
   * `fromSeq` 在 ADR-0032 之前是这个请求的字段——`readSession` 那时还是"给我
   * 从某条 seq 起的原始事件"。现在它直接返回主进程已经 reduce 过的状态（修
   * G4/G5：不再要求渲染层自己重放全部历史），这个字段就没有消费者了，干脆删掉
   * 而不是留一个没人读的参数——那正是这个项目反复栽过的"写了但没有执行点"
   * 的形状。这条测试改成确认它现在会被 `strictObject` 当幻觉字段拒绝。
   */
  it('🔴 readSession 不再接受 fromSeq —— 它已经不返回原始事件，这个字段没有消费者', () => {
    const sessionId = newSessionId();
    expect(ReadSessionRequest.safeParse({ sessionId }).success).toBe(true);
    expect(ReadSessionRequest.safeParse({ sessionId, fromSeq: 1 }).success).toBe(false);
  });
});

describe('readSession 的返回值：SerializedSessionState（ADR-0032，修 G4/G5）', () => {
  it('空会话的序列化状态能通过渲染层这一侧的校验', () => {
    const sessionId = newSessionId();
    const serialized = serializeSessionState(emptySessionState(sessionId));
    expect(ReadSessionResult.safeParse(serialized).success).toBe(true);
  });

  it('带着未清空 Map（runningCalls/ptySessions）的状态也能通过——这正是快照要处理的形状', () => {
    const sessionId = newSessionId();
    const state = {
      ...emptySessionState(sessionId),
      runningCalls: new Map([
        [
          newCallId(),
          { callId: newCallId(), name: 'fs.read', startedAt: 1, messageId: newMessageId(), input: { path: '/w' } },
        ],
      ]),
      ptySessions: new Map([
        [newPtySessionId(), { ptySessionId: newPtySessionId(), cwd: '/w', startedAt: 1 }],
      ]),
    };
    const result = ReadSessionResult.safeParse(serializeSessionState(state));
    expect(result.success).toBe(true);
  });

  it('🔴 过一趟 IPC 会用到的 structuredClone 之后仍能通过校验（不是只测 JSON 序列化）', () => {
    const sessionId = newSessionId();
    const serialized = serializeSessionState(emptySessionState(sessionId));
    // Electron 的 IPC 走结构化克隆，不是 JSON；Node 的 structuredClone 是同一族算法，
    // 用它模拟"数据真的跨了一次进程边界"比只 JSON.stringify/parse 更接近真实路径。
    const cloned: unknown = structuredClone(serialized);
    expect(ReadSessionResult.safeParse(cloned).success).toBe(true);
  });
});

describe('多模态：图片附件', () => {
  const img = (data = 'aGVsbG8=') => ({ data, mime: 'image/png' });

  it('文字和图片是或的关系 —— 只发图片、不带文字应该通过', () => {
    const sessionId = newSessionId();
    expect(
      SendUserMessageRequest.safeParse({ sessionId, text: '', images: [img()] }).success,
    ).toBe(true);
  });

  it('🔴 文字和图片都是空 —— 两道闸门都不满足，拒绝', () => {
    const sessionId = newSessionId();
    expect(SendUserMessageRequest.safeParse({ sessionId, text: '' }).success).toBe(false);
    expect(SendUserMessageRequest.safeParse({ sessionId, text: '', images: [] }).success).toBe(
      false,
    );
  });

  it(`🔴 超过 ${String(MAX_IMAGES_PER_MESSAGE)} 张图被拒绝`, () => {
    const sessionId = newSessionId();
    const images = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => img());
    expect(SendUserMessageRequest.safeParse({ sessionId, text: 'hi', images }).success).toBe(
      false,
    );
    expect(
      SendUserMessageRequest.safeParse({
        sessionId,
        text: 'hi',
        images: images.slice(0, MAX_IMAGES_PER_MESSAGE),
      }).success,
    ).toBe(true);
  });

  it('🔴 单图 base64 超过上限被拒绝 —— 精确字节数在 main 侧解码后再查一次', () => {
    const sessionId = newSessionId();
    const huge = img('a'.repeat(14 * 1024 * 1024 + 1));
    expect(SendUserMessageRequest.safeParse({ sessionId, text: 'hi', images: [huge] }).success)
      .toBe(false);
  });

  it('ReadBlobRequest 需要一个完整的 BlobRef，不是裸 hash', () => {
    expect(ReadBlobRequest.safeParse({ ref: { hash: 'a'.repeat(64) } }).success).toBe(false);
    expect(
      ReadBlobRequest.safeParse({ ref: { hash: 'a'.repeat(64), mime: 'image/png', size: 3 } })
        .success,
    ).toBe(true);
  });

  it('ReadBlobResult 就是一个 data URL 字符串', () => {
    expect(ReadBlobResult.safeParse({ dataUrl: 'data:image/png;base64,aGVsbG8=' }).success).toBe(
      true,
    );
  });
});

describe('失败是返回值，不是异常', () => {
  it('信封能表达失败，且带得住 code', () => {
    const parsed = IpcEnvelope.safeParse({
      ok: false,
      code: 'policy_denied',
      message: '红线拒绝',
    });
    expect(parsed.success).toBe(true);
    // UI 要靠 code 说出"改策略 / 重新审批 / 改系统权限"这三句不同的话
    expect(parsed.success && !parsed.data.ok && parsed.data.code).toBe('policy_denied');
  });

  it('成功信封的 data 不预设形状 —— 载荷单独解一次', () => {
    expect(IpcEnvelope.safeParse({ ok: true, data: { anything: 1 } }).success).toBe(true);
  });

  it('不是信封的东西一律拒绝', () => {
    expect(IpcEnvelope.safeParse({ oops: 1 }).success).toBe(false);
    expect(IpcEnvelope.safeParse(null).success).toBe(false);
  });
});

describe('渲染层对未知事件的容忍', () => {
  /**
   * 用 loose 的 `EventEnvelope` 而不是判别联合：渲染层拿到未知类型的事件应该原样
   * 忽略并继续，不该整条流断掉——那是版本漂移的正常形态，不是错误。
   */
  it('未来版本的事件类型仍能通过信封解析', () => {
    const parsed = PushedEvent.safeParse({
      id: newSessionId(),
      sessionId: newSessionId(),
      seq: 7,
      ts: 1,
      type: 'something.fromTheFuture',
      v: 3,
      payload: { whatever: true },
    });
    expect(parsed.success).toBe(true);
  });

  it('信封本身的必填字段还是必填的', () => {
    expect(PushedEvent.safeParse({ type: 'x', payload: {} }).success).toBe(false);
  });
});

describe('会话列表投影的形状', () => {
  it('lastSeq = 0 是合法的（会话已建但一条事件都没有）', () => {
    const r = ListSessionsResult.safeParse([
      { sessionId: newSessionId(), createdAt: 0, updatedAt: 0, lastSeq: 0, status: 'idle' },
    ]);
    expect(r.success).toBe(true);
  });

  it('status 缺失时不通过——M1-e 起这是必填字段，不是新加的可选口子', () => {
    const r = ListSessionsResult.safeParse([{ sessionId: newSessionId(), createdAt: 0, updatedAt: 0, lastSeq: 0 }]);
    expect(r.success).toBe(false);
  });

  it.each(['idle', 'running', 'interrupted'] as const)('status=%s 三态都能通过 schema', (status) => {
    const r = ListSessionsResult.safeParse([
      { sessionId: newSessionId(), createdAt: 0, updatedAt: 0, lastSeq: 0, status },
    ]);
    expect(r.success).toBe(true);
  });

  it('status 只认这三个值，不是任意字符串', () => {
    expect(SessionListStatus.safeParse('busy').success).toBe(false);
  });
});

describe('通道名', () => {
  it('全部带 xm: 前缀，不与别的 IPC 撞名', () => {
    for (const name of Object.values(CH)) expect(name.startsWith('xm:')).toBe(true);
    expect(new Set(Object.values(CH)).size).toBe(Object.values(CH).length);
  });
});
