import type { EventOf } from '@xm/contracts';
import type { Compaction } from './session-state.js';

/** 历史 v1 事件没有预算字段；只复制实际存在的可选值。 */
export function compactionOf(payload: EventOf<'context.compacted'>['payload']): Compaction {
  return {
    fromSeq: payload.fromSeq,
    toSeq: payload.toSeq,
    summaryRef: payload.summaryRef,
    tokensBefore: payload.tokensBefore,
    tokensAfter: payload.tokensAfter,
    ...(payload.strategy === undefined ? {} : { strategy: payload.strategy }),
    ...(payload.provider === undefined ? {} : { provider: payload.provider }),
    ...(payload.model === undefined ? {} : { model: payload.model }),
    ...(payload.maxContextTokens === undefined
      ? {}
      : { maxContextTokens: payload.maxContextTokens }),
    ...(payload.thresholdTokens === undefined
      ? {}
      : { thresholdTokens: payload.thresholdTokens }),
    ...(payload.reservedTokens === undefined ? {} : { reservedTokens: payload.reservedTokens }),
    ...(payload.recentFromSeq === undefined ? {} : { recentFromSeq: payload.recentFromSeq }),
  };
}
