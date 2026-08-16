import type { CheckpointId } from '@xm/contracts';
import type { Checkpoint, SessionState } from './session-state.js';

/**
 * 还原过程三条事件（started / failed / restored）共用的字段更新。
 *
 * 合成一个入口不是为了少写几行：这三条改的是**同一个还原点的同一组字段**，
 * 而它们互相排斥（在还原中 ⇒ 没有失败记录；还原成功 ⇒ 不在还原中）。写在三处时，
 * "这次要不要顺手清掉另外两个字段"每次都要重新判断一遍，漏一次就是 UI 上一个
 * 永远转着的进度条。放在一处之后，三个调用点的 patch 并排可读，遗漏是看得见的。
 */
export type RestorePatch = Partial<
  Pick<Checkpoint, 'restoreStartedAt' | 'restoreFailure' | 'restoredAt'>
>;

export const applyRestorePatch = (
  state: SessionState,
  checkpointId: CheckpointId,
  seq: number,
  patch: RestorePatch,
): SessionState => ({
  ...state,
  checkpoints: state.checkpoints.map((c) =>
    c.checkpointId === checkpointId ? { ...c, ...patch } : c,
  ),
  lastSeq: seq,
});

/**
 * 新建一个还原点。三个还原过程字段一律显式写 `undefined`——
 * 让"这条记录有哪些字段"在建的那一刻就是完整的，读的人不用去别处确认。
 */
export const appendCheckpoint = (
  checkpoints: readonly Checkpoint[],
  created: {
    readonly checkpointId: Checkpoint['checkpointId'];
    readonly kind: Checkpoint['kind'];
    readonly ref: string;
    readonly label: string;
    /** 事件 payload 里这两个是 optional，状态里是"必有、可为 undefined"，所以逐字段抄 */
    readonly manifestRef?: Checkpoint['manifestRef'];
    readonly callId?: Checkpoint['callId'];
  },
): readonly Checkpoint[] => [
  ...checkpoints,
  {
    checkpointId: created.checkpointId,
    kind: created.kind,
    ref: created.ref,
    label: created.label,
    manifestRef: created.manifestRef,
    callId: created.callId,
    restoreStartedAt: undefined,
    restoreFailure: undefined,
    restoredAt: undefined,
  },
];
